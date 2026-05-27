(function () {
    const _d = document;
    const _nodes = {
        area:   _d.getElementById('uploadArea'),
        input:  _d.getElementById('fileInput'),
        view:   _d.getElementById('previewSection'),
        orig:   _d.getElementById('originalImage'),
        origV:  _d.getElementById('originalVideo'),
        proc:   _d.getElementById('processedImage'),
        procV:  _d.getElementById('processedVideo'),
        oInfo:  _d.getElementById('originalInfo'),
        pInfo:  _d.getElementById('processedInfo'),
        dl:     _d.getElementById('downloadBtn'),
        rs:     _d.getElementById('resetBtn'),
        res:    _d.getElementById('resultPanel'),
        msg:    _d.getElementById('statusMsg'),
        cv:     _d.getElementById('canvas'),
        vpWrap: _d.getElementById('videoProgressWrap'),
        vpFill: _d.getElementById('progressFill'),
        vpPct:  _d.getElementById('progressPercent'),
        vpTxt:  _d.getElementById('progressText'),
        vpHint: _d.getElementById('progressHint'),
    };

    const _ctx = _nodes.cv.getContext('2d', { willReadFrequently: true });
    const _assets = { 48: null, 96: null };
    let _cache = { url: null, name: 'result', isVideo: false };

    // ── Khởi tạo watermark mask assets ──────────────────────────────────────
    const _init = async () => {
        const base = 'https://raw.githubusercontent.com/journey-ad/gemini-watermark-remover/main/src/assets/';
        try {
            await Promise.all([
                _fetchMap(base + 'bg_48.png', 48),
                _fetchMap(base + 'bg_96.png', 96)
            ]);
        } catch (e) {
            console.error('Asset init failed:', e);
        }
    };

    async function _fetchMap(u, s) {
        const r = await fetch(u);
        if (!r.ok) return;
        const b = await r.blob();
        const img = await _loadFile(new File([b], 'map', { type: 'image/png' }));
        const tc = _d.createElement('canvas');
        tc.width = tc.height = s;
        const tx = tc.getContext('2d');
        tx.drawImage(img, 0, 0);
        const d = tx.getImageData(0, 0, s, s).data;
        const m = new Float32Array(s * s);
        for (let i = 0; i < m.length; i++) {
            m[i] = Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) / 255;
        }
        _assets[s] = m;
    }

    function _loadFile(f) {
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

    // ── Thuật toán xóa watermark (giữ nguyên) ────────────────────────────────
    // Áp dụng lên ImageData đã được vẽ trên canvas có kích thước w×h
    function _applyAlgo(w, h) {
        const isBig = w > 1024 && h > 1024;
        const s      = isBig ? 96 : 48;
        const offset = isBig ? 64 : 32;
        const posX   = w - s - offset;
        const posY   = h - s - offset;
        const map    = _assets[s];

        if (!map) throw new Error('Hệ thống đang khởi tạo, vui lòng thử lại.');

        const id = _ctx.getImageData(0, 0, w, h);
        const d  = id.data;
        let ops  = 0;

        for (let row = 0; row < s; row++) {
            for (let col = 0; col < s; col++) {
                const a = Math.min(map[row * s + col], 0.999);
                if (a < 0.01) continue;
                const px = posX + col, py = posY + row;
                if (px < 0 || px >= w || py < 0 || py >= h) continue;
                const i   = (py * w + px) * 4;
                const den = 1 - a;
                if (den < 0.001) continue;
                for (let k = 0; k < 3; k++) {
                    d[i + k] = Math.max(0, Math.min(255, Math.round((d[i + k] - a * 255) / den)));
                }
                ops++;
            }
        }
        _ctx.putImageData(id, 0, 0);
        return ops;
    }

    // ── Xử lý ảnh (giữ nguyên logic gốc) ────────────────────────────────────
    async function _runImage(img) {
        _nodes.cv.width  = img.width;
        _nodes.cv.height = img.height;
        _ctx.imageSmoothingEnabled = false;
        _ctx.drawImage(img, 0, 0);
        const ops = _applyAlgo(img.width, img.height);
        return { ops };
    }

    async function _handleImage(f) {
        _cache.name    = f.name.replace(/\.[^.]+$/, '');
        _cache.isVideo = false;
        _state('Đang xử lý...');

        _showImageUI();

        try {
            const img = await _loadFile(f);
            _nodes.orig.src = img.src;
            _nodes.orig.style.display = 'block';
            _nodes.oInfo.textContent = `${img.width} × ${img.height}`;

            _nodes.view.style.display = 'block';
            _nodes.res.style.display  = 'none';
            _nodes.dl.style.display   = 'none';

            const meta     = await _runImage(img);
            _cache.url     = _nodes.cv.toDataURL('image/png');
            _nodes.proc.src = _cache.url;
            _nodes.proc.style.display = 'block';
            _nodes.pInfo.textContent  = `${img.width} × ${img.height} · ${meta.ops.toLocaleString()} px`;
            _nodes.res.style.display  = 'block';
            _nodes.dl.style.display   = 'inline-block';
            _state('Hoàn tất!', 'ok');
        } catch (e) {
            _state(e.message, 'err');
        }
    }

    // ── Xử lý video ──────────────────────────────────────────────────────────
    // Chiến lược: seek từng frame qua HTMLVideoElement → vẽ canvas → xóa wm → 
    // capture stream → MediaRecorder → Blob → download
    // Chất lượng: dùng bitrate cao nhất codec trình duyệt hỗ trợ (VP9 hoặc H.264)

    function _bestVideoMime() {
        // Ưu tiên VP9 (chất lượng cao, webm), fallback H.264 mp4
        const candidates = [
            'video/webm;codecs=vp9',
            'video/webm;codecs=vp8',
            'video/mp4;codecs=avc1',
            'video/webm',
        ];
        for (const c of candidates) {
            if (MediaRecorder.isTypeSupported(c)) return c;
        }
        return 'video/webm';
    }

    async function _handleVideo(f) {
        _cache.name    = f.name.replace(/\.[^.]+$/, '');
        _cache.isVideo = true;
        _state('Đang tải video...');

        _showVideoUI();

        // Tạo object URL cho video gốc
        const origUrl = URL.createObjectURL(f);
        _nodes.origV.src = origUrl;
        _nodes.origV.style.display = 'block';
        _nodes.view.style.display  = 'block';
        _nodes.res.style.display   = 'none';
        _nodes.dl.style.display    = 'none';
        _nodes.vpWrap.style.display = 'block';

        // Đợi metadata video load
        await new Promise((res, rej) => {
            _nodes.origV.onloadedmetadata = res;
            _nodes.origV.onerror = rej;
        });

        const vw       = _nodes.origV.videoWidth;
        const vh       = _nodes.origV.videoHeight;
        const duration = _nodes.origV.duration;
        _nodes.oInfo.textContent = `${vw} × ${vh} · ${_fmtDur(duration)}`;

        // Thiết lập canvas đúng kích thước video gốc
        _nodes.cv.width  = vw;
        _nodes.cv.height = vh;
        _ctx.imageSmoothingEnabled = false;

        // Capture stream từ canvas với framerate cao nhất có thể
        const FPS     = 30;
        const stream  = _nodes.cv.captureStream(FPS);

        // Nếu video có audio, thêm audio track vào stream
        let audioCtx, audioSource, audioDest;
        try {
            audioCtx    = new AudioContext();
            audioSource = audioCtx.createMediaElementSource(_nodes.origV);
            audioDest   = audioCtx.createMediaStreamDestination();
            audioSource.connect(audioDest);
            audioDest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
            // Cũng kết nối tới output mặc định để có thể nghe khi preview
            audioSource.connect(audioCtx.destination);
        } catch (_) {
            // Video không có audio hoặc trình duyệt chặn → bỏ qua
        }

        const mime     = _bestVideoMime();
        // Tính bitrate: ~12 Mbps cho 1080p, scale theo diện tích
        const bitrateBase  = 12_000_000;
        const scaleFactor  = (vw * vh) / (1920 * 1080);
        const videoBitsPerSecond = Math.round(bitrateBase * Math.max(0.5, Math.min(scaleFactor, 4)));

        const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond });
        const chunks   = [];
        recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

        recorder.start(100); // flush mỗi 100ms để RAM không tràn

        _nodes.origV.muted  = true;   // tắt tiếng phát lại gốc (audio được lấy qua AudioContext)
        _nodes.origV.pause();

        _state('Đang xử lý video...');
        _setProgress(0);

        // Seek + render từng frame
        const FRAME_DUR = 1 / FPS;
        let   t         = 0;
        let   cancelled = false;

        // Nếu user nhấn reset trong lúc xử lý → hủy
        _nodes.rs._cancelVideo = () => { cancelled = true; };

        while (t <= duration && !cancelled) {
            await _seekTo(_nodes.origV, t);
            _ctx.drawImage(_nodes.origV, 0, 0, vw, vh);
            _applyAlgo(vw, vh);
            // Không cần putImageData vì _applyAlgo đã put, chỉ cần
            // đảm bảo canvas stream lấy frame mới nhất (đã tự động)

            const pct = Math.min(t / duration, 1);
            _setProgress(pct);

            t += FRAME_DUR;
            // Nhường event loop để trình duyệt không đóng băng
            await _tick();
        }

        if (cancelled) {
            recorder.stop();
            URL.revokeObjectURL(origUrl);
            if (audioCtx) audioCtx.close();
            return;
        }

        _setProgress(1);
        _nodes.vpTxt.textContent  = 'Đang hoàn thiện video...';
        _nodes.vpHint.textContent = 'Đợi một chút nữa...';

        // Dừng recorder và đợi finish
        await new Promise(res => {
            recorder.onstop = res;
            recorder.stop();
        });

        if (audioCtx) audioCtx.close();

        const ext      = mime.includes('mp4') ? 'mp4' : 'webm';
        const blob     = new Blob(chunks, { type: mime });
        _cache.url     = URL.createObjectURL(blob);
        _cache.ext     = ext;

        _nodes.procV.src = _cache.url;
        _nodes.procV.style.display = 'block';
        _nodes.pInfo.textContent   = `${vw} × ${vh} · ${_fmtDur(duration)} · ${_fmtSize(blob.size)}`;
        _nodes.res.style.display   = 'block';
        _nodes.dl.style.display    = 'inline-block';
        _nodes.vpWrap.style.display = 'none';

        // Khôi phục audio playback cho video gốc
        _nodes.origV.muted = false;

        _state('Hoàn tất!', 'ok');
    }

    // Seek video tới thời điểm t, trả Promise resolve khi seeked
    function _seekTo(video, t) {
        return new Promise(res => {
            const onSeeked = () => { video.removeEventListener('seeked', onSeeked); res(); };
            video.addEventListener('seeked', onSeeked);
            video.currentTime = t;
        });
    }

    // Nhường microtask để không block UI
    function _tick() {
        return new Promise(res => setTimeout(res, 0));
    }

    function _setProgress(ratio) {
        const pct = Math.round(ratio * 100);
        _nodes.vpFill.style.width  = pct + '%';
        _nodes.vpPct.textContent   = pct + '%';
    }

    function _fmtDur(s) {
        const m = Math.floor(s / 60), sec = Math.floor(s % 60);
        return `${m}:${String(sec).padStart(2, '0')}`;
    }

    function _fmtSize(bytes) {
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    // ── UI helpers ────────────────────────────────────────────────────────────
    function _showImageUI() {
        _nodes.orig.style.display  = 'block';
        _nodes.origV.style.display = 'none';
        _nodes.proc.style.display  = 'none';
        _nodes.procV.style.display = 'none';
        _nodes.vpWrap.style.display = 'none';
    }

    function _showVideoUI() {
        _nodes.orig.style.display  = 'none';
        _nodes.origV.style.display = 'none'; // sẽ hiện sau khi load
        _nodes.proc.style.display  = 'none';
        _nodes.procV.style.display = 'none';
    }

    // ── Dispatch theo loại file ───────────────────────────────────────────────
    async function _handle(f) {
        if (f.type.startsWith('image/')) {
            await _handleImage(f);
        } else if (f.type.startsWith('video/')) {
            await _handleVideo(f);
        } else {
            _state('Định dạng không được hỗ trợ.', 'err');
        }
    }

    // ── Event listeners ───────────────────────────────────────────────────────
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
        // Hủy video đang xử lý nếu có
        if (_nodes.rs._cancelVideo) {
            _nodes.rs._cancelVideo();
            _nodes.rs._cancelVideo = null;
        }
        // Giải phóng object URLs
        if (_cache.url && _cache.isVideo) URL.revokeObjectURL(_cache.url);
        if (_nodes.origV.src) { URL.revokeObjectURL(_nodes.origV.src); _nodes.origV.src = ''; }
        if (_nodes.procV.src) { URL.revokeObjectURL(_nodes.procV.src); _nodes.procV.src = ''; }

        _nodes.view.style.display = 'none';
        _nodes.vpWrap.style.display = 'none';
        _nodes.input.value = '';
        _cache = { url: null, name: 'result', isVideo: false };
        _state('');
    });

    _nodes.dl.addEventListener('click', () => {
        if (!_cache.url) return;
        const l = _d.createElement('a');
        if (_cache.isVideo) {
            l.download = `${_cache.name}_no_watermark.${_cache.ext || 'webm'}`;
        } else {
            l.download = `${_cache.name}_no_watermark.png`;
        }
        l.href = _cache.url;
        l.click();
    });

    // Khởi tạo
    _init();
})();
