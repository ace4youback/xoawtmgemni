(function() {
    const _d = document;
    const _nodes = {
        area: _d.getElementById('uploadArea'),
        input: _d.getElementById('fileInput'),
        view: _d.getElementById('previewSection'),
        orig: _d.getElementById('originalImage'),
        proc: _d.getElementById('processedImage'),
        oInfo: _d.getElementById('originalInfo'),
        pInfo: _d.getElementById('processedInfo'),
        dl: _d.getElementById('downloadBtn'),
        rs: _d.getElementById('resetBtn'),
        res: _d.getElementById('resultPanel'),
        msg: _d.getElementById('statusMsg'),
        cv: _d.getElementById('canvas')
    };

    const _ctx = _nodes.cv.getContext('2d', { willReadFrequently: true });
    const _assets = { 48: null, 96: null };
    let _cache = { url: null, name: 'result' };

    const _init = async () => {
        const base = 'https://raw.githubusercontent.com/journey-ad/gemini-watermark-remover/main/src/assets/';
        try {
            await Promise.all([
                _fetchMap(base + 'bg_48.png', 48), 
                _fetchMap(base + 'bg_96.png', 96)
            ]);
        } catch(e) {
            console.error("Asset initialization failed:", e);
        }
    };

    async function _fetchMap(u, s) {
        const r = await fetch(u);
        if (!r.ok) return;
        const b = await r.blob();
        const img = await _load(new File([b], 'map', { type: 'image/png' }));
        const tc = _d.createElement('canvas');
        tc.width = tc.height = s;
        const tx = tc.getContext('2d');
        tx.drawImage(img, 0, 0);
        const d = tx.getImageData(0, 0, s, s).data;
        const m = new Float32Array(s * s);
        for (let i = 0; i < m.length; i++) {
            m[i] = Math.max(d[i*4], d[i*4+1], d[i*4+2]) / 255;
        }
        _assets[s] = m;
    }

    function _load(f) {
        return new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = e => {
                const i = new Image();
                i.decoding = 'sync';
                i.onload = () => res(i);
                i.onerror = rej;
                i.src = e.target.result;
            };
            r.readAsDataURL(f);
        });
    }

    function _state(m, t) {
        _nodes.msg.textContent = m;
        _nodes.msg.className = t || '';
    }

    async function _run(img) {
        _nodes.cv.width = img.width;
        _nodes.cv.height = img.height;
        _ctx.imageSmoothingEnabled = false;
        _ctx.drawImage(img, 0, 0);

        const isBig = img.width > 1024 && img.height > 1024;
        const s = isBig ? 96 : 48;
        const offset = isBig ? 64 : 32;
        const posX = img.width - s - offset;
        const posY = img.height - s - offset;
        const map = _assets[s];

        if (!map) throw new Error('Hệ thống đang khởi tạo, vui lòng thử lại.');

        const id = _ctx.getImageData(0, 0, img.width, img.height);
        const d = id.data;
        let ops = 0;

        for (let r = 0; r < s; r++) {
            for (let c = 0; c < s; c++) {
                const a = Math.min(map[r * s + c], 0.999);
                if (a < 0.01) continue;
                const px = posX + c, py = posY + r;
                if (px < 0 || px >= img.width || py < 0 || py >= img.height) continue;
                const i = (py * img.width + px) * 4;
                const den = 1 - a;
                if (den < 0.001) continue;
                for (let k = 0; k < 3; k++) {
                    d[i+k] = Math.max(0, Math.min(255, Math.round((d[i+k] - a * 255) / den)));
                }
                ops++;
            }
        }
        _ctx.putImageData(id, 0, 0);
        return { s, ops };
    }

    async function _handle(f) {
        if (!f.type.startsWith('image/')) return;
        _cache.name = f.name.replace(/\.[^.]+$/, '');
        _state('Đang xử lý...');
        try {
            const img = await _load(f);
            _nodes.orig.src = img.src;
            _nodes.oInfo.textContent = `${img.width} × ${img.height}`;
            _nodes.view.style.display = 'block';
            _nodes.res.style.display = 'none';
            _nodes.dl.style.display = 'none';

            const meta = await _run(img);
            _cache.url = _nodes.cv.toDataURL('image/png');
            _nodes.proc.src = _cache.url;
            _nodes.pInfo.textContent = `${img.width} × ${img.height} · ${meta.ops.toLocaleString()} px`;
            _nodes.res.style.display = 'block';
            _nodes.dl.style.display = 'inline-block';
            _state('Hoàn tất!', 'ok');
        } catch(e) {
            _state(e.message, 'err');
        }
    }

    // Event Listeners
    _nodes.area.addEventListener('click', () => _nodes.input.click());
    
    _nodes.input.addEventListener('change', e => {
        if (e.target.files[0]) _handle(e.target.files[0]);
    });

    _nodes.area.addEventListener('dragover', e => { 
        e.preventDefault(); 
        _nodes.area.classList.add('drag-over'); 
    });

    _nodes.area.addEventListener('dragleave', () => {
        _nodes.area.classList.remove('drag-over');
    });

    _nodes.area.addEventListener('drop', e => {
        e.preventDefault();
        _nodes.area.classList.remove('drag-over');
        if (e.dataTransfer.files[0]) _handle(e.dataTransfer.files[0]);
    });

    _nodes.rs.addEventListener('click', () => {
        _nodes.view.style.display = 'none';
        _nodes.input.value = '';
        _cache.url = null;
        _state('');
    });

    _nodes.dl.addEventListener('click', () => {
        if (!_cache.url) return;
        const l = _d.createElement('a');
        l.download = `${_cache.name}_no_watermark.png`;
        l.href = _cache.url;
        l.click();
    });

    // Khởi tạo hệ thống
    _init();
})();