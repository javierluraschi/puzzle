import { alignTo, normalizeContour, contourDeviation } from './vision.js';

// Guided single-piece scanner: live camera, live outline + guidance, automatic burst capture when
// the piece is steady, on-device contour refinement, then hand the contour to `onScan`.
//
// Nothing but the final contour leaves the device; camera frames stay in memory.

const LIVE_SIZE = 360; // long side of frames analyzed live (guidance only; capture uses full frames)
const BURST_FRAMES = 5;
const BURST_INTERVAL_MS = 160;
const STEADY_MS = 700;

const MAX_TILT_DEG = 10;

class WorkerClient {
  constructor(url, onEvent = () => {}) {
    this.worker = new Worker(url, { type: 'module' });
    this.pending = new Map();
    this.nextId = 0;
    this.worker.onmessage = ({ data }) => {
      if (data.id === undefined) {
        onEvent(data);
        return;
      }
      const job = this.pending.get(data.id);
      this.pending.delete(data.id);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(data.result);
    };
    this.worker.onerror = (event) => {
      for (const job of this.pending.values()) job.reject(new Error(event.message || 'Worker failed'));
      this.pending.clear();
    };
  }

  call(message, transfer = []) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }

  terminate() {
    this.worker.terminate();
  }
}

export class Scanner {
  /**
   * @param {HTMLElement} root container (the scanner takes it over full screen)
   * @param {{ label: string, onScan: Function, onClose: Function, onLabel: Function }} options
   *   onScan({ label, contour, quality }) must save the piece and resolve with the server's summary
   */
  constructor(root, { label, onScan, onClose, onLabel, renderResult }) {
    this.root = root;
    this.label = label;
    this.onScan = onScan;
    this.onClose = onClose;
    this.onLabel = onLabel;
    this.renderResult = renderResult;
    this.state = 'idle';
    this.tilt = null;
    this.history = [];
    this.backgroundPoint = null;
    // 'auto': MobileSAM is downloaded only once the background turns out to be hard (low contrast
    // or a failed trace); 'on': from the start; 'off': never
    this.aiSetting = localStorage.getItem('ai-assist') || 'auto';
    this.samStatus = 'off';
    this.build();
  }

  build() {
    this.root.innerHTML = `
      <div class="scanner">
        <div class="scanner-stage">
          <video playsinline muted autoplay></video>
          <canvas class="scanner-overlay"></canvas>
          <div class="scanner-level" hidden><div class="bubble"></div></div>
        </div>
        <div class="scanner-top">
          <button class="scanner-label" title="Change the label of the next piece"><span class="muted">Piece</span> <strong></strong> ✎</button>
          <span class="scanner-count"></span>
          <button class="scanner-close" aria-label="Close scanner">×</button>
        </div>
        <div class="scanner-guide"><div class="guide-text">Starting camera…</div><div class="guide-sub"></div></div>
        <div class="scanner-bottom">
          <button class="scanner-torch" hidden>🔦</button>
          <button class="scanner-shutter" title="Capture now">
            <svg viewBox="0 0 80 80"><circle cx="40" cy="40" r="34" class="ring-bg"/><circle cx="40" cy="40" r="34" class="ring"/></svg>
          </button>
          <button class="scanner-ai" title="AI segmentation (MobileSAM) for busy backgrounds"></button>
        </div>
        <div class="scanner-result" hidden></div>
      </div>`;
    const $ = (s) => this.root.querySelector(s);
    this.video = $('video');
    this.overlay = $('.scanner-overlay');
    this.guideText = $('.guide-text');
    this.guideSub = $('.guide-sub');
    this.ring = $('.ring');
    this.resultPanel = $('.scanner-result');
    this.labelButton = $('.scanner-label');
    this.levelEl = $('.scanner-level');
    this.bubble = $('.bubble');
    this.countEl = $('.scanner-count');
    $('.scanner-close').addEventListener('click', () => this.close());
    $('.scanner-shutter').addEventListener('click', () => {
      if (this.state === 'searching' || this.state === 'waiting-removal') this.capture(true);
    });
    this.torchButton = $('.scanner-torch');
    this.torchButton.addEventListener('click', () => this.toggleTorch());
    this.aiButton = $('.scanner-ai');
    this.aiButton.addEventListener('click', () => this.toggleAi());
    this.labelButton.addEventListener('click', () => this.editLabel());
    // tapping the picture marks that spot as background (helps on unusual backgrounds)
    this.overlay.addEventListener('click', (event) => {
      if (this.state !== 'searching') return;
      const p = this.toVideoCoords(event.clientX, event.clientY);
      if (p) this.backgroundPoint = [p[0] / this.video.videoWidth, p[1] / this.video.videoHeight];
      this.flash('Background color set from where you tapped');
    });
    this.updateLabel();
    this.updateAiButton();
  }

  async start() {
    this.running = true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
    } catch (error) {
      this.guide('Camera not available', error.name === 'NotAllowedError' ? 'Allow camera access for this site and try again.' : error.message);
      return;
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    await new Promise((resolve) => (this.video.videoWidth ? resolve() : this.video.addEventListener('loadedmetadata', resolve, { once: true })));
    this.track = this.stream.getVideoTracks()[0];
    const caps = this.track.getCapabilities?.() || {};
    if (caps.torch) this.torchButton.hidden = false;
    if (caps.focusMode?.includes('continuous')) this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});

    this.live = new WorkerClient(new URL('./live-worker.js', import.meta.url));
    this.refiner = new WorkerClient(new URL('./refine-worker.js', import.meta.url), (event) => this.onRefineEvent(event));
    this.refiner.call({ type: 'warmup' }).catch(() => {});
    // the 45 MB model download and compilation would compete with the live view at start
    if (this.aiSetting === 'on' && !navigator.connection?.saveData) setTimeout(() => this.running && this.loadAi(), 4000);
    this.listenTilt();
    this.wakeLock = await navigator.wakeLock?.request('screen').catch(() => null);
    this.state = 'searching';
    this.loop();
  }

  close() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.live?.terminate();
    this.refiner?.terminate();
    window.removeEventListener('devicemotion', this.motionHandler);
    this.wakeLock?.release?.().catch(() => {});
    this.onClose?.();
  }

  // --- sensors and settings ---------------------------------------------------------------------

  /** Must be called from a user gesture on iOS (motion permission prompt). */
  static async requestMotionPermission() {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        await DeviceMotionEvent.requestPermission();
      } catch {
        // no level indicator then
      }
    }
  }

  listenTilt() {
    this.motionHandler = (event) => {
      const g = event.accelerationIncludingGravity;
      if (!g || g.x === null) return;
      const norm = Math.hypot(g.x, g.y, g.z);
      if (!norm) return;
      // angle between the phone's z-axis and gravity: 0° when held flat above the table
      const tilt = (Math.acos(Math.min(1, Math.abs(g.z) / norm)) * 180) / Math.PI;
      this.tilt = this.tilt === null ? tilt : this.tilt * 0.7 + tilt * 0.3;
      this.levelEl.hidden = false;
      const k = Math.min(1, this.tilt / 20) * 34;
      const angle = Math.atan2(g.y, -g.x);
      this.bubble.style.transform = `translate(${Math.cos(angle) * k}px, ${Math.sin(angle) * k}px)`;
      this.levelEl.classList.toggle('ok', this.tilt <= MAX_TILT_DEG);
    };
    window.addEventListener('devicemotion', this.motionHandler);
  }

  async toggleTorch() {
    this.torch = !this.torch;
    await this.track.applyConstraints({ advanced: [{ torch: this.torch }] }).catch(() => {});
    this.torchButton.classList.toggle('active', this.torch);
  }

  toggleAi() {
    this.aiSetting = { auto: 'on', on: 'off', off: 'auto' }[this.aiSetting] || 'auto';
    localStorage.setItem('ai-assist', this.aiSetting);
    if (this.aiSetting === 'on') this.loadAi();
    this.updateAiButton();
    this.flash({ auto: 'AI assist: automatic (downloads when the background is hard)', on: 'AI assist: on', off: 'AI assist: off' }[this.aiSetting]);
  }

  /** In 'auto' mode, start loading MobileSAM when plain color segmentation struggles. */
  needAi(reason) {
    if (this.aiSetting !== 'auto' || this.samStatus === 'loading' || this.samStatus === 'ready' || this.samStatus === 'failed') return;
    console.info('loading MobileSAM:', reason);
    this.loadAi();
  }

  loadAi() {
    if (this.samStatus === 'ready' || this.samStatus === 'loading') return;
    this.samStatus = 'loading';
    this.samProgress = 0;
    this.updateAiButton();
    this.refiner.call({ type: 'load-sam' }).then(
      ({ device }) => { this.samStatus = 'ready'; this.samDevice = device; this.updateAiButton(); },
      (error) => { console.warn(error); this.samStatus = 'failed'; this.updateAiButton(); },
    );
  }

  onRefineEvent(event) {
    if (event.type !== 'progress') return;
    if (event.stage === 'download') {
      this.samProgress = event.value;
      this.updateAiButton();
    } else if (event.stage === 'refine' && this.state === 'processing') {
      this.setRing(0.2 + event.value * 0.75);
    }
  }

  updateAiButton() {
    const b = this.aiButton;
    if (this.aiSetting === 'off') b.textContent = 'AI off';
    else if (this.samStatus === 'loading') b.textContent = `AI ${Math.round((this.samProgress || 0) * 100)}%`;
    else if (this.samStatus === 'ready') b.textContent = 'AI on';
    else if (this.samStatus === 'failed') b.textContent = 'AI n/a';
    else b.textContent = this.aiSetting === 'auto' ? 'AI auto' : 'AI';
    b.classList.toggle('active', this.aiSetting !== 'off' && this.samStatus === 'ready');
  }

  useSam() {
    return this.aiSetting !== 'off' && this.samStatus === 'ready';
  }

  editLabel() {
    const value = prompt('Label for the next piece (numbers are recommended, e.g. 1, 2, 3…):', this.label);
    if (value === null || !value.trim()) return;
    this.setLabel(value.trim());
  }

  setLabel(label) {
    this.label = label;
    this.updateLabel();
    this.onLabel?.(label);
  }

  updateLabel() {
    this.labelButton.querySelector('strong').textContent = this.label;
  }

  setCount(n) {
    this.countEl.textContent = `${n} scanned`;
  }

  // --- live loop --------------------------------------------------------------------------------

  async loop() {
    const grab = document.createElement('canvas');
    const gctx = grab.getContext('2d', { willReadFrequently: false });
    while (this.running) {
      await new Promise((r) => (this.video.requestVideoFrameCallback ? this.video.requestVideoFrameCallback(() => r()) : requestAnimationFrame(r)));
      if (!this.running || this.liveBusy || !this.video.videoWidth) continue;
      if (this.state !== 'searching' && this.state !== 'capturing' && this.state !== 'waiting-removal') continue;
      this.liveBusy = true;
      try {
        const vw = this.video.videoWidth;
        const vh = this.video.videoHeight;
        const s = LIVE_SIZE / Math.max(vw, vh);
        grab.width = Math.round(vw * s);
        grab.height = Math.round(vh * s);
        gctx.drawImage(this.video, 0, 0, grab.width, grab.height);
        const bitmap = await createImageBitmap(grab);
        const result = await this.live.call({ bitmap, options: { backgroundPoint: this.backgroundPoint } }, [bitmap]);
        result.scale = 1 / s;
        this.onLive(result);
      } catch (error) {
        console.warn(error);
      } finally {
        this.liveBusy = false;
      }
    }
  }

  onLive(r) {
    const now = performance.now();
    this.lastLive = r;
    const assessment = this.assess(r);
    this.drawOverlay(r, assessment);

    if (this.state === 'waiting-removal') {
      // the next scan starts once the scanned piece is taken away or a different piece shows up
      const different = r.found && assessment.ok && this.differentPiece(r);
      if (!r.found || different) this.goneSince ??= now;
      else this.goneSince = null;
      if (this.goneSince && now - this.goneSince > 400) {
        this.state = 'searching';
        this.hideResult();
      }
      return;
    }
    if (this.state === 'capturing') {
      // frames are aligned before fusion, so small motion is fine; only losing the piece is not
      if (!r.found || r.touchesBorder) this.captureBroken = assessment.message;
      return;
    }
    if (this.state !== 'searching') return;

    this.guide(assessment.message, assessment.sub);
    if (r.found && r.contrast < 0.55) {
      this.lowContrastSince ??= now;
      if (now - this.lowContrastSince > 2000) this.needAi('low contrast');
    } else {
      this.lowContrastSince = null;
    }
    if (assessment.ok) {
      this.steadySince ??= now;
      const t = Math.min(1, (now - this.steadySince) / STEADY_MS);
      this.setRing(t * 0.2);
      if (t >= 1) this.capture(false);
    } else {
      this.steadySince = null;
      this.setRing(0);
    }
  }

  /** Is the live view good enough to capture? Returns guidance for the user otherwise. */
  assess(r) {
    const previous = this.previousLive;
    this.previousLive = r.found ? r : null;
    if (!r.found) return { ok: false, message: r.card ? 'Place a piece in the middle of the card' : 'Place one piece in the middle' };
    const frameArea = r.w * r.h;
    const fraction = r.area / frameArea;
    const size = Math.sqrt(r.area);
    if (r.touchesBorder) return { ok: false, message: 'Move back – the whole piece must be in view' };
    let off;
    if (r.card) {
      // the card must fill the view: its frame is the ruler
      if (r.card.side < Math.min(r.w, r.h) * 0.55) return { ok: false, message: 'Move closer – let the card fill the view' };
      const cx = r.card.corners.reduce((s, p) => s + p[0], 0) / 4;
      const cy = r.card.corners.reduce((s, p) => s + p[1], 0) / 4;
      off = Math.hypot(cx - r.w / 2, cy - r.h / 2) / Math.min(r.w, r.h);
      if (off > 0.2) return { ok: false, message: 'Center the card' };
    } else {
      if (fraction < 0.025) return { ok: false, message: 'Move closer' };
      if (fraction > 0.4) return { ok: false, message: 'Move back a little' };
      off = Math.hypot(r.centroid[0] - r.w / 2, r.centroid[1] - r.h / 2) / Math.min(r.w, r.h);
      if (off > 0.2) return { ok: false, message: 'Center the piece' };
    }
    if (this.tilt !== null && this.tilt > MAX_TILT_DEG) return { ok: false, message: 'Hold the phone flat above the piece', sub: `tilted ${Math.round(this.tilt)}°` };
    if (previous) {
      const moved = Math.hypot(r.centroid[0] - previous.centroid[0], r.centroid[1] - previous.centroid[1]) / size;
      const grew = Math.abs(r.area - previous.area) / previous.area;
      this.root.dataset.metrics = `moved ${(moved * 100).toFixed(1)}% grew ${(grew * 100).toFixed(1)}% area ${(fraction * 100).toFixed(1)}% off ${(off * 100).toFixed(0)}% contrast ${r.contrast.toFixed(2)} dt ${Math.round(performance.now() - (this.lastLiveAt || 0))}ms`;
      this.lastLiveAt = performance.now();
      if (moved > 0.03 || grew > 0.05) return { ok: false, message: 'Hold steady' };
    } else {
      return { ok: false, message: 'Hold steady' };
    }
    const sub = r.card ? 'Scan card found – measuring in millimetres' : r.contrast < 0.55 ? 'Low contrast – a plainer background helps' : r.others > 2 ? 'Other objects in view' : '';
    return { ok: true, message: 'Hold steady…', sub };
  }

  /** Is the live outline a different piece than the one just scanned? (checked a few times a second) */
  differentPiece(r) {
    if (!this.scannedShape || r.contour.length < 20) return false;
    if (performance.now() - (this.lastShapeCheck || 0) < 300) return this.lastDifferent;
    this.lastShapeCheck = performance.now();
    const shape = normalizeContour(r.contour).points;
    const angles = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => (k * Math.PI) / 4);
    const aligned = alignTo(shape, this.scannedShape, { initialAngles: angles }).points;
    // the same piece re-detected deviates ~1%; another piece several %
    this.lastDifferent = contourDeviation(aligned, this.scannedShape) > 0.03;
    return this.lastDifferent;
  }

  // --- capture ----------------------------------------------------------------------------------

  async capture(manual) {
    if (this.state !== 'searching' && this.state !== 'waiting-removal') return;
    this.hideResult();
    this.state = 'capturing';
    this.captureBroken = null;
    this.scannedShape = this.lastLive?.found && this.lastLive.contour.length >= 20 ? normalizeContour(this.lastLive.contour).points : null;
    this.lastDifferent = false;
    this.steadySince = null;
    this.guide('Hold still…', 'Capturing');
    const frames = [];
    const previews = [];
    for (let i = 0; i < BURST_FRAMES; i++) {
      const bitmap = await createImageBitmap(this.video);
      frames.push({ bitmap });
      previews.push(await halfSize(bitmap));
      this.setRing(0.2 * (i + 1) / BURST_FRAMES);
      if (i < BURST_FRAMES - 1) await new Promise((r) => setTimeout(r, BURST_INTERVAL_MS));
      if (this.captureBroken && !manual) break;
    }
    if (this.captureBroken && !manual) {
      frames.forEach((f) => f.bitmap.close());
      previews.forEach((p) => p.close());
      this.state = 'searching';
      return;
    }
    navigator.vibrate?.(20);

    this.state = 'processing';
    this.guide('Tracing the edges…', this.useSam() ? 'with AI assist' : '');
    let result;
    try {
      result = await this.refiner.call(
        { type: 'refine', frames, useSam: this.useSam(), options: { backgroundPoint: this.backgroundPoint } },
        frames.map((f) => f.bitmap),
      );
    } catch (error) {
      previews.forEach((p) => p.close());
      this.needAi('trace failed');
      this.showError(error.message);
      return;
    }

    this.state = 'saving';
    this.setRing(1);
    this.guide('Finding corners and sides…', '');
    const preview = previews[result.preview.frame];
    previews.forEach((p) => p !== preview && p.close());
    let summary;
    try {
      summary = await this.onScan({ label: this.label, contour: result.contour, quality: result.quality, sizeMm: result.sizeMm });
    } catch (error) {
      preview.close();
      this.showError(error.message, error.status === 409 ? 'label' : null);
      return;
    }
    this.history.push(summary);
    this.showResult(summary, result, preview);
  }

  // --- result -----------------------------------------------------------------------------------

  showResult(summary, result, preview) {
    this.state = 'waiting-removal';
    this.goneSince = null;
    this.setRing(0);
    const panel = this.resultPanel;
    panel.hidden = false;
    this.root.querySelector('.scanner').classList.add('has-result');
    panel.replaceChildren();

    const still = document.createElement('canvas');
    still.className = 'scanner-still';
    const crop = this.cropAround(result.preview.contour.map(([x, y]) => [x / 2, y / 2]), preview);
    still.width = crop.w;
    still.height = crop.h;
    const ctx = still.getContext('2d');
    ctx.drawImage(preview, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
    ctx.strokeStyle = '#3ddc84';
    ctx.lineWidth = Math.max(1.5, crop.w / 250);
    ctx.beginPath();
    result.preview.contour.forEach(([x, y], i) => (i ? ctx.lineTo(x / 2 - crop.x, y / 2 - crop.y) : ctx.moveTo(x / 2 - crop.x, y / 2 - crop.y)));
    ctx.closePath();
    ctx.stroke();
    preview.close();

    const q = result.quality;
    const warnings = [];
    if (q.deviation > 0.6) warnings.push('The outline varied between frames – a plainer background or steadier hand gives better edges.');
    if (q.engine === 'sam') warnings.push('Busy background: AI segmentation was used.');
    if (q.pixelsPerPiece < 180) warnings.push('The piece was small in the picture – move closer next time.');

    panel.append(
      this.renderResult(summary, still),
      ...warnings.map((w) => Object.assign(document.createElement('p'), { className: 'warn small', textContent: w })),
    );
    const actions = document.createElement('div');
    actions.className = 'scanner-actions';
    const retake = Object.assign(document.createElement('button'), { textContent: '↺ Retake' });
    retake.addEventListener('click', async () => {
      await this.onRetake?.(summary);
      this.setLabel(summary.label);
      this.hideResult();
      this.state = 'searching';
    });
    const next = Object.assign(document.createElement('button'), { className: 'primary', textContent: 'Next piece →' });
    next.addEventListener('click', () => {
      this.hideResult();
      this.state = 'searching';
    });
    actions.append(retake, next);
    panel.append(actions);

    if (summary.ok) {
      this.setLabel(nextLabelAfter(summary.label, summary.nextLabel));
      this.guide('Saved ✓', 'Swap in the next piece – scanning continues automatically');
    } else {
      this.guide('Could not find four sides', 'Retake this piece');
    }
  }

  showError(message, kind = null) {
    this.state = 'searching';
    this.setRing(0);
    this.guide(kind === 'label' ? 'Label already used' : 'Scan failed', message);
    if (kind === 'label') this.editLabel();
    this.flash(message);
  }

  hideResult() {
    this.resultPanel.hidden = true;
    this.root.querySelector('.scanner').classList.remove('has-result');
  }

  cropAround(contour, image) {
    const xs = contour.map((p) => p[0]);
    const ys = contour.map((p) => p[1]);
    const pad = (Math.max(...xs) - Math.min(...xs)) * 0.15;
    const x = Math.max(0, Math.floor(Math.min(...xs) - pad));
    const y = Math.max(0, Math.floor(Math.min(...ys) - pad));
    return { x, y, w: Math.min(image.width - x, Math.ceil(Math.max(...xs) - Math.min(...xs) + 2 * pad)), h: Math.min(image.height - y, Math.ceil(Math.max(...ys) - Math.min(...ys) + 2 * pad)) };
  }

  // --- drawing ----------------------------------------------------------------------------------

  guide(text, sub = '') {
    if (this.guideText.textContent !== text) this.guideText.textContent = text;
    if (this.guideSub.textContent !== sub) this.guideSub.textContent = sub || '';
  }

  flash(message) {
    this.guideSub.textContent = message;
  }

  setRing(fraction) {
    const c = 2 * Math.PI * 34;
    this.ring.style.strokeDasharray = `${c}`;
    this.ring.style.strokeDashoffset = `${c * (1 - fraction)}`;
  }

  /** Video pixel coordinates -> overlay CSS pixels, honoring object-fit: contain. */
  videoToScreen() {
    const rect = this.overlay.getBoundingClientRect();
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const s = Math.min(rect.width / vw, rect.height / vh);
    return { s, ox: (rect.width - vw * s) / 2, oy: (rect.height - vh * s) / 2, rect };
  }

  toVideoCoords(clientX, clientY) {
    if (!this.video.videoWidth) return null;
    const { s, ox, oy, rect } = this.videoToScreen();
    return [(clientX - rect.left - ox) / s, (clientY - rect.top - oy) / s];
  }

  drawOverlay(r, assessment) {
    const { s, ox, oy, rect } = this.videoToScreen();
    const dpr = window.devicePixelRatio || 1;
    if (this.overlay.width !== Math.round(rect.width * dpr)) {
      this.overlay.width = Math.round(rect.width * dpr);
      this.overlay.height = Math.round(rect.height * dpr);
    }
    const ctx = this.overlay.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    // centering target
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    const vw = this.video.videoWidth * s;
    const vh = this.video.videoHeight * s;
    ctx.arc(ox + vw / 2, oy + vh / 2, Math.min(vw, vh) * 0.28, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    const k = r.scale * s;
    if (r.card) {
      ctx.beginPath();
      r.card.corners.forEach(([x, y], i) => (i ? ctx.lineTo(x * k + ox, y * k + oy) : ctx.moveTo(x * k + ox, y * k + oy)));
      ctx.closePath();
      ctx.strokeStyle = '#4fa3ff';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    if (!r.found || !r.contour.length) return;
    ctx.beginPath();
    r.contour.forEach(([x, y], i) => (i ? ctx.lineTo(x * k + ox, y * k + oy) : ctx.moveTo(x * k + ox, y * k + oy)));
    ctx.closePath();
    const color = this.state === 'waiting-removal' ? '#9aa1b0' : assessment.ok ? '#3ddc84' : '#ffb020';
    ctx.fillStyle = color + '33';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
}

/** A half-resolution copy (for the review screen) via a canvas, which works on every browser. */
async function halfSize(bitmap) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width / 2);
  canvas.height = Math.round(bitmap.height / 2);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return createImageBitmap(canvas);
}

/** Numbers continue from the highest number; custom labels like "A7" continue as "A8". */
export function nextLabelAfter(label, serverNext) {
  if (/^\d+$/.test(label)) return serverNext || String(Number(label) + 1);
  const m = label.match(/^(.*?)(\d+)$/);
  if (m) return m[1] + String(Number(m[2]) + 1).padStart(m[2].length, '0');
  return serverNext || label + '-2';
}
