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

    const _ctx    = _nodes.cv.getContext('2d', { willReadFrequently: true });
    const _assets = { 48: null, 96: null };
    let _cache    = { url: null, name: 'result', isVideo: false, ext: 'webm' };

    // =========================================================================
    // Worker Pool — xử lý pixel đa luồng, không block UI
    // Code worker nhúng thẳng vào Blob URL → không cần file riêng
    // =========================================================================
    const WORKER_CODE = `
self.onmessage = function({ data: { buf, width, height, map48, map96 } }) {
    const isBig = width > 1024 && height > 1024;
    const s      = isBig ? 96 : 48;
    const map    = isBig ? map96 : map48;
    const offset = isBig ? 64 : 32;
    const posX   = width  - s - offset;
    const posY   = height - s - offset;
    const d      = new Uint8ClampedArray(buf);
    for (let row = 0; row < s; row++) {
        for (let col = 0; col < s; col++) {
            const a = Math.min(map[row * s + col], 0.999);
            if (a < 0.01) continue;
            const px = posX + col, py = posY + row;
            if (px < 0 || px >= width || py < 0 || py >= height) continue;
            const idx = (py * width + px) * 4;
            const den = 1 - a;
            if (den < 0.001) continue;
            for (let k = 0; k < 3; k++) {
                d[idx+k] = Math.max(0, Math.min(255, Math.round((d[idx+k] - a * 255) / den)));
            }
        }
    }
    self.postMessage(d.buffer, [d.buffer]);
};
`;

    const CONCURRENCY = Math.max(2, Math.min(navigator.hardwareConcurrency || 4, 8));
    let _workers = [];
    let _freeIdx = [];
    let _waitQ   = []; // { buf, width, height, resolve }

    function _initWorkers() {
        const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
        const wurl = URL.createObjectURL(blob);
        for (let i = 0; i < CONCURRENCY; i++) {
            const w = new Worker(wurl);
            w.onmessage = ({ data: outBuf }) => {
                // Lấy job tiếp từ queue hoặc đánh dấu rảnh
                const { resolve } = w._job;
                resolve(new Uint8ClampedArray(outBuf));
                if (_waitQ.length > 0) {
                    _runJob(i, _waitQ.shift());
                } else {
                    _freeIdx.push(i);
                }
            };
            _workers.push(w);
            _freeIdx.push(i);
        }
        URL.revokeObjectURL(wurl);
    }

    function _runJob(idx, job) {
        const w = _workers[idx];
        w._job  = job;
        w.postMessage(
            { buf: job.buf, width: job.width, height: job.height,
              map48: _assets[48], map96: _assets[96] },
            [job.buf]        // Transferable — zero-copy
        );
    }

    // Gửi buffer tới worker rảnh, trả Promise<Uint8ClampedArray>
    function _workerProcess(buf, width, height) {
        return new Promise(resolve => {
            const job = { buf, width, height, resolve };
            if (_freeIdx.length > 0) {
                _runJob(_freeIdx.pop(), job);
            } else {
                _waitQ.push(job);
            }
        });
    }

    // =========================================================================
    // Asset init
    // =========================================================================
    const _init = async () => {
        _initWorkers();
        const base = 'https://raw.githubusercontent.com/journey-ad/gemini-watermark-remover/main/src/assets/';
        await Promise.all([_fetchMap(base + 'bg_48.png', 48), _fetchMap(base + 'bg_96.png', 96)])
              .catch(e => console.error('Asset init:', e));
    };

    async function _fetchMap(u, s) {
        const r   = await fetch(u);
        if (!r.ok) return;
        const img = await _loadHTMLImage(await r.blob());
        const tc  = _d.createElement('canvas');
        tc.width  = tc.height = s;
        const tx  = tc.getContext('2d');
        tx.drawImage(img, 0, 0);
        const px  = tx.getImageData(0, 0, s, s).data;
        const m   = new Float32Array(s * s);
        for (let i = 0; i < m.length; i++)
            m[i] = Math.max(px[i*4], px[i*4+1], px[i*4+2]) / 255;
        _assets[s] = m;
    }

    function _loadHTMLImage(blobOrFile) {
        return new Promise((res, rej) => {
            const url = URL.createObjectURL(blobOrFile);
            const img = new Image();
            img.onload  = () => { URL.revokeObjectURL(url); res(img); };
            img.onerror = rej;
            img.src     = url;
        });
    }

    function _loadFileAsImage(f) { return _loadHTMLImage(f); }

    function _state(m, t) {
        _nodes.msg.textContent = m;
        _nodes.msg.className   = t || '';
    }

    // =========================================================================
    // Xử lý ảnh — single call, main thread đủ nhanh
    // =========================================================================
    async function _handleImage(f) {
        _cache.name    = f.name.replace(/\.[^.]+$/, '');
        _cache.isVideo = false;
        _showImageUI();
        _state('Đang xử lý...');
        try {
            const img = await _loadFileAsImage(f);
            _nodes.orig.src = img.src;
            _nodes.orig.style.display = 'block';
            _nodes.oInfo.textContent  = `${img.width} × ${img.height}`;
            _nodes.view.style.display = 'block';
            _nodes.res.style.display  = 'none';
            _nodes.dl.style.display   = 'none';

            _nodes.cv.width  = img.width;
            _nodes.cv.height = img.height;
            _ctx.imageSmoothingEnabled = false;
            _ctx.drawImage(img, 0, 0);

            const id  = _ctx.getImageData(0, 0, img.width, img.height);
            const out = await _workerProcess(id.data.buffer.slice(0), img.width, img.height);
            _ctx.putImageData(new ImageData(out, img.width, img.height), 0, 0);

            _cache.url = _nodes.cv.toDataURL('image/png');
            _nodes.proc.src = _cache.url;
            _nodes.proc.style.display = 'block';
            _nodes.pInfo.textContent  = `${img.width} × ${img.height}`;
            _nodes.res.style.display  = 'block';
            _nodes.dl.style.display   = 'inline-block';
            _state('Hoàn tất!', 'ok');
            if (window.trackAction) trackAction('remove_image', { file_type: f.type, file_size: f.size });
        } catch (e) {
            _state(e.message, 'err');
        }
    }

    // =========================================================================
    // Xử lý video — realtime playback + requestVideoFrameCallback
    // =========================================================================
    // Chiến lược:
    // 1. Phát video ở tốc độ thực (không seek từng frame → không giật)
    // 2. requestVideoFrameCallback (RVFC) callback mỗi khi decoder giải mã xong 1 frame
    // 3. Mỗi frame: drawImage → copy pixels → gửi worker (async, non-blocking)
    // 4. Worker trả về → putImageData lên visible canvas → MediaRecorder capture
    // 5. CONCURRENCY worker chạy song song: pipeline luôn đầy, không chờ nhau
    // 6. Fallback RAFloop khi RVFC không được hỗ trợ

    function _bestMime() {
        for (const m of ['video/webm;codecs=vp9','video/webm;codecs=vp8','video/mp4;codecs=avc1','video/webm'])
            if (MediaRecorder.isTypeSupported(m)) return m;
        return 'video/webm';
    }

    async function _handleVideo(f) {
        _cache.name    = f.name.replace(/\.[^.]+$/, '');
        _cache.isVideo = true;
        _showVideoUI();
        _state('Đang tải video...');

        const origUrl = URL.createObjectURL(f);
        _nodes.origV.src = origUrl;
        _nodes.origV.style.display = 'block';
        _nodes.view.style.display  = 'block';
        _nodes.res.style.display   = 'none';
        _nodes.dl.style.display    = 'none';
        _nodes.vpWrap.style.display = 'block';

        await new Promise((res, rej) => {
            _nodes.origV.onloadedmetadata = res;
            _nodes.origV.onerror = rej;
        });

        const vw  = _nodes.origV.videoWidth;
        const vh  = _nodes.origV.videoHeight;
        const dur = _nodes.origV.duration;
        _nodes.oInfo.textContent = `${vw} × ${vh} · ${_fmtDur(dur)}`;

        // OffscreenCanvas để readPixels không conflict main canvas
        const offCanvas = (typeof OffscreenCanvas !== 'undefined')
            ? new OffscreenCanvas(vw, vh)
            : Object.assign(_d.createElement('canvas'), { width: vw, height: vh });
        const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });
        offCtx.imageSmoothingEnabled = false;

        // Visible canvas → MediaRecorder
        _nodes.cv.width  = vw;
        _nodes.cv.height = vh;
        _ctx.imageSmoothingEnabled = false;

        const mime    = _bestMime();
        const bScale  = (vw * vh) / (1920 * 1080);
        const vbps    = Math.round(16_000_000 * Math.max(0.4, Math.min(bScale, 4)));
        const capStream = _nodes.cv.captureStream(0); // manual frame push

        const recorder = new MediaRecorder(capStream, { mimeType: mime, videoBitsPerSecond: vbps });
        const chunks   = [];
        recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
        recorder.start(200);

        // Audio routing
        let audioCtx;
        try {
            audioCtx = new AudioContext();
            const src  = audioCtx.createMediaElementSource(_nodes.origV);
            const dest = audioCtx.createMediaStreamDestination();
            src.connect(dest);
            dest.stream.getAudioTracks().forEach(t => capStream.addTrack(t));
            // Không connect tới destination để tránh echo khi preview
        } catch (_) {}
        _nodes.origV.muted = true;

        _state('Đang xử lý video...');
        _setProgress(0);

        let cancelled = false;
        _nodes.rs._cancelVideo = () => { cancelled = true; };

        // Lấy videoTrack để requestFrame (báo captureStream có frame mới)
        const vTrack = capStream.getVideoTracks()[0];

        // ── Pipeline frame processing ────────────────────────────────────────
        // Mỗi frame từ RVFC: copy pixel → worker async
        // Khi worker done: putImageData + requestFrame → recorder nhận frame
        // In-flight tracking: đảm bảo tất cả frame được xử lý trước khi stop

        let inFlight   = 0;
        let allQueued  = false;     // tất cả frame đã được gửi vào worker
        let finishRes  = null;      // resolve Promise chính

        function _onWorkerDone(processed) {
            _ctx.putImageData(new ImageData(processed, vw, vh), 0, 0);
            vTrack.requestFrame?.();
            inFlight--;
            if (allQueued && inFlight === 0 && finishRes) finishRes();
        }

        const useRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

        const processPromise = new Promise(resolve => { finishRes = resolve; });

        if (useRVFC) {
            function onRVFC(_, meta) {
                if (cancelled) { allQueued = true; if (inFlight === 0) finishRes(); return; }

                _setProgress(meta.mediaTime / dur);

                // Copy frame ngay trong callback (synchronous) trước khi decoder tiến
                offCtx.drawImage(_nodes.origV, 0, 0, vw, vh);
                const id  = offCtx.getImageData(0, 0, vw, vh);
                // slice để có ArrayBuffer riêng (transferable)
                const buf = id.data.buffer.slice(0);
                inFlight++;
                _workerProcess(buf, vw, vh).then(_onWorkerDone);

                const done = meta.mediaTime >= dur - 0.08 || _nodes.origV.ended;
                if (done) {
                    allQueued = true;
                    if (inFlight === 0) finishRes();
                } else {
                    _nodes.origV.requestVideoFrameCallback(onRVFC);
                }
            }
            _nodes.origV.requestVideoFrameCallback(onRVFC);
        } else {
            // RAF fallback: kiểm tra currentTime thay đổi → xử lý
            let lastT = -1;
            function rafLoop() {
                if (cancelled || _nodes.origV.ended || _nodes.origV.currentTime >= dur - 0.08) {
                    allQueued = true;
                    if (inFlight === 0) finishRes();
                    return;
                }
                const t = _nodes.origV.currentTime;
                _setProgress(t / dur);
                if (t !== lastT) {
                    lastT = t;
                    offCtx.drawImage(_nodes.origV, 0, 0, vw, vh);
                    const buf = offCtx.getImageData(0, 0, vw, vh).data.buffer.slice(0);
                    inFlight++;
                    _workerProcess(buf, vw, vh).then(_onWorkerDone);
                }
                requestAnimationFrame(rafLoop);
            }
            requestAnimationFrame(rafLoop);
        }

        // Bắt đầu phát (sau khi đăng ký callback)
        _nodes.origV.currentTime = 0;
        await _nodes.origV.play();

        // Đợi pipeline hoàn thành
        await processPromise;
        _nodes.origV.pause();

        if (cancelled) {
            recorder.stop();
            URL.revokeObjectURL(origUrl);
            if (audioCtx) audioCtx.close();
            return;
        }

        _setProgress(1);
        _nodes.vpTxt.textContent  = 'Đang hoàn thiện video...';
        _nodes.vpHint.textContent = 'Vài giây nữa...';

        await new Promise(res => { recorder.onstop = res; recorder.stop(); });
        if (audioCtx) audioCtx.close();

        const ext  = mime.includes('mp4') ? 'mp4' : 'webm';
        const blob = new Blob(chunks, { type: mime });
        _cache.url = URL.createObjectURL(blob);
        _cache.ext = ext;

        _nodes.procV.src = _cache.url;
        _nodes.procV.style.display  = 'block';
        _nodes.pInfo.textContent    = `${vw} × ${vh} · ${_fmtDur(dur)} · ${_fmtSize(blob.size)}`;
        _nodes.res.style.display    = 'block';
        _nodes.dl.style.display     = 'inline-block';
        _nodes.vpWrap.style.display = 'none';
        _nodes.origV.muted          = false;
        _state('Hoàn tất!', 'ok');
        if (window.trackAction) trackAction('remove_video', { file_type: f.type, file_size: f.size });
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    function _setProgress(ratio) {
        const pct = Math.min(100, Math.round(ratio * 100));
        _nodes.vpFill.style.width = pct + '%';
        _nodes.vpPct.textContent  = pct + '%';
    }

    function _fmtDur(s) {
        return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
    }

    function _fmtSize(b) {
        return b < 1048576 ? (b/1024).toFixed(1)+' KB' : (b/1048576).toFixed(1)+' MB';
    }

    function _showImageUI() {
        _nodes.orig.style.display   = 'block';
        _nodes.origV.style.display  = 'none';
        _nodes.proc.style.display   = 'none';
        _nodes.procV.style.display  = 'none';
        _nodes.vpWrap.style.display = 'none';
    }

    function _showVideoUI() {
        _nodes.orig.style.display   = 'none';
        _nodes.origV.style.display  = 'none';
        _nodes.proc.style.display   = 'none';
        _nodes.procV.style.display  = 'none';
    }

    async function _handle(f) {
        if (f.type.startsWith('image/'))      await _handleImage(f);
        else if (f.type.startsWith('video/')) await _handleVideo(f);
        else _state('Định dạng không được hỗ trợ.', 'err');
    }

    // ── Events ────────────────────────────────────────────────────────────────
    _nodes.area.addEventListener('click',    () => _nodes.input.click());
    _nodes.input.addEventListener('change',  e => { if (e.target.files[0]) _handle(e.target.files[0]); });
    _nodes.area.addEventListener('dragover', e => { e.preventDefault(); _nodes.area.classList.add('drag-over'); });
    _nodes.area.addEventListener('dragleave',() => _nodes.area.classList.remove('drag-over'));
    _nodes.area.addEventListener('drop',     e => {
        e.preventDefault(); _nodes.area.classList.remove('drag-over');
        if (e.dataTransfer.files[0]) _handle(e.dataTransfer.files[0]);
    });

    _nodes.rs.addEventListener('click', () => {
        if (_nodes.rs._cancelVideo) { _nodes.rs._cancelVideo(); _nodes.rs._cancelVideo = null; }
        if (_cache.url && _cache.isVideo) URL.revokeObjectURL(_cache.url);
        if (_nodes.origV.src) { _nodes.origV.pause(); URL.revokeObjectURL(_nodes.origV.src); _nodes.origV.src = ''; }
        if (_nodes.procV.src) { URL.revokeObjectURL(_nodes.procV.src); _nodes.procV.src = ''; }
        _nodes.view.style.display   = 'none';
        _nodes.vpWrap.style.display = 'none';
        _nodes.input.value          = '';
        _cache = { url: null, name: 'result', isVideo: false, ext: 'webm' };
        _state('');
    });

    _nodes.dl.addEventListener('click', () => {
        if (!_cache.url) return;
        const a  = _d.createElement('a');
        a.href     = _cache.url;
        a.download = _cache.isVideo
            ? `${_cache.name}_no_watermark.${_cache.ext}`
            : `${_cache.name}_no_watermark.png`;
        a.click();
    });

    _init();
})();
