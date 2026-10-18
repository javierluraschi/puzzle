// Guided single-piece scanner on the printed scan card.
//
// The live view only looks for the card (a few times per second on a small frame) and shows the
// phone's tilt – the piece is segmented once, after capture, at full resolution. The camera is
// switched off while a scan is processed and reviewed. Phones overheated with continuous
// segmentation.
//
// Nothing but the final contour leaves the device; photos stay in memory.

const CHECK_INTERVAL_MS = 350;
const CHECK_SIZE = 320; // long side of the frames checked for the card
const STEADY_CHECKS = 3; // consecutive stable card detections before capturing
const VIDEO_FRAMES = 3; // frames per placement when grabbing from the video stream
const PHOTO_SHOTS = 2; // photos per placement with ImageCapture.takePhoto()
const MAX_TILT_DEG = 3; // flatter photos give truer outlines
const CARD_FILL = 0.72; // the card's side as a fraction of the shorter side of the view
const HINT_AFTER_MS = 5000;
const LEVEL_PX_PER_DEG = 2.6; // bubble travel in the level indicator

const STRONG_HINTS = {
  size: 'Move the phone closer until the card fills the dashed square',
  tilt: 'Hold the phone flatter – the dot must stay inside the small circle',
};

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
   * onScan({ label, contour, quality, sizeMm }) saves the piece and resolves with the server's summary
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
    // the light reduces shadows a lot: always on where the browser can switch it
    this.flash = true;
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
          <label class="scanner-photo" title="Take the photo with your camera app (full resolution, flash)">
            <input type="file" accept="image/*" capture="environment" hidden>🖼
          </label>
          <button class="scanner-shutter" title="Capture now">
            <svg viewBox="0 0 80 80"><circle cx="40" cy="40" r="34" class="ring-bg"/><circle cx="40" cy="40" r="34" class="ring"/></svg>
          </button>
        </div>
        <div class="scanner-result" hidden></div>
      </div>`;
    const $ = (s) => this.root.querySelector(s);
    this.scannerEl = $('.scanner');
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
    $('.scanner-shutter').addEventListener('click', () => this.onShutter());
    this.labelButton.addEventListener('click', () => this.editLabel());
    $('.scanner-photo input').addEventListener('change', (event) => {
      const file = event.target.files[0];
      event.target.value = '';
      if (file) this.processPhotoFile(file);
    });
    this.updateLabel();
  }

  async start() {
    this.running = true;
    this.cardWorker = new WorkerClient(new URL('./live-worker.js', import.meta.url));
    this.refiner = new WorkerClient(new URL('./refine-worker.js', import.meta.url), (event) => this.onRefineEvent(event));
    this.listenTilt();
    await this.startCamera();
    // optimize the refinement code while the user is still aiming
    setTimeout(() => this.running && this.refiner.call({ type: 'warmup' }).catch(() => {}), 1500);
  }

  async startCamera() {
    this.placements = [];
    this.stableChecks = 0;
    this.lastCorners = null;
    this.setRing(0);
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        // the highest resolution the camera offers, at a low frame rate (less heat)
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 }, frameRate: { ideal: 15, max: 30 } },
      });
    } catch (error) {
      this.guide('Camera not available', error.name === 'NotAllowedError' ? 'Allow camera access, or use 🖼 to take the photo with your camera app.' : error.message);
      this.state = 'no-camera';
      return;
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    await new Promise((resolve) => (this.video.videoWidth ? resolve() : this.video.addEventListener('loadedmetadata', resolve, { once: true })));
    this.track = this.stream.getVideoTracks()[0];
    const caps = this.track.getCapabilities?.() || {};
    this.hasLight = Boolean(caps.torch);
    if (caps.torch) this.track.applyConstraints({ advanced: [{ torch: true }] }).catch(() => {});
    // a little optical/digital zoom lets the phone stay farther away (and in focus) while the card fills the view
    if (caps.zoom && caps.zoom.max >= 1.5 && caps.zoom.min <= 1.5) this.track.applyConstraints({ advanced: [{ zoom: 1.5 }] }).catch(() => {});
    if (caps.focusMode?.includes('continuous')) this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    this.imageCapture = typeof ImageCapture !== 'undefined' ? new ImageCapture(this.track) : null;
    this.wakeLock = await navigator.wakeLock?.request('screen').catch(() => null);
    this.state = 'aiming';
    this.aimingSince = performance.now();
    this.guide('Point at the scan card', this.hasLight ? '' : 'Tip: 🖼 takes the photo with your camera app – turn its flash on');
    this.checkLoop();
  }

  stopCamera() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.wakeLock?.release?.().catch(() => {});
    this.wakeLock = null;
    this.clearOverlay();
  }

  close() {
    this.running = false;
    this.stopCamera();
    this.cardWorker?.terminate();
    this.refiner?.terminate();
    window.removeEventListener('devicemotion', this.motionHandler);
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
      const k = Math.min(34, this.tilt * LEVEL_PX_PER_DEG);
      const angle = Math.atan2(g.y, -g.x);
      this.bubble.style.transform = `translate(${Math.cos(angle) * k}px, ${Math.sin(angle) * k}px)`;
      this.levelEl.classList.toggle('ok', this.tilt <= MAX_TILT_DEG);
    };
    window.addEventListener('devicemotion', this.motionHandler);
  }

  onRefineEvent(event) {
    if (event.type === 'progress' && event.stage === 'refine' && this.state === 'processing') this.setRing(0.3 + event.value * 0.6);
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

  // --- live: card check a few times per second -------------------------------------------------

  async checkLoop() {
    const grab = document.createElement('canvas');
    const gctx = grab.getContext('2d');
    while (this.running && this.stream) {
      await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS));
      if (!this.stream || !this.video.videoWidth || this.state !== 'aiming') continue;
      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;
      const s = CHECK_SIZE / Math.max(vw, vh);
      grab.width = Math.round(vw * s);
      grab.height = Math.round(vh * s);
      gctx.drawImage(this.video, 0, 0, grab.width, grab.height);
      let result;
      try {
        const bitmap = await createImageBitmap(grab);
        result = await this.cardWorker.call({ bitmap }, [bitmap]);
      } catch (error) {
        console.warn(error);
        continue;
      }
      const corners = result.corners ? result.corners.map(([x, y]) => [x / s, y / s]) : null;
      this.onCardCheck(corners);
    }
  }

  onCardCheck(corners) {
    const a = this.assess(corners);
    this.drawCard(corners, a.reason === 'size');
    if (this.state !== 'aiming') return;
    this.lastCorners = corners;
    // still not there after a few seconds: say what is missing more clearly
    const late = performance.now() - this.aimingSince > HINT_AFTER_MS;
    const strong = late && (a.reason === 'size' || a.reason === 'tilt') ? STRONG_HINTS[a.reason] : '';
    this.guide(a.message, strong || a.sub || '');
    this.guideSub.classList.toggle('strong', Boolean(strong));
    this.stableChecks = a.ok ? this.stableChecks + 1 : 0;
    this.setRing(Math.min(1, this.stableChecks / STEADY_CHECKS) * 0.25);
    if (this.stableChecks >= STEADY_CHECKS) this.capture();
  }

  /** Is the card well framed for a capture? */
  assess(corners) {
    const previous = this.lastCorners;
    if (!corners) {
      this.missing = (this.missing || 0) + 1;
      return { ok: false, message: 'Point at the scan card', sub: this.missing > 8 ? 'Print it from the Scan tab · the whole black frame must be visible' : '' };
    }
    this.missing = 0;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const side = corners.reduce((s, p, i) => s + Math.hypot(p[0] - corners[(i + 1) % 4][0], p[1] - corners[(i + 1) % 4][1]), 0) / 4;
    if (side < Math.min(vw, vh) * CARD_FILL) return { ok: false, reason: 'size', message: 'Move closer – let the card fill the view' };
    const cx = corners.reduce((s, p) => s + p[0], 0) / 4;
    const cy = corners.reduce((s, p) => s + p[1], 0) / 4;
    if (Math.hypot(cx - vw / 2, cy - vh / 2) / Math.min(vw, vh) > 0.15) return { ok: false, message: 'Center the card' };
    if (this.tilt !== null && this.tilt > MAX_TILT_DEG) return { ok: false, reason: 'tilt', message: 'Hold the phone flatter', sub: `tilted ${this.tilt.toFixed(1)}° – keep the dot in the small circle` };
    if (!previous) return { ok: false, message: 'Hold steady' };
    // corners can come back in a different order: compare each with the nearest previous one;
    // at the small check resolution a corner jitters by ~0.6% of the card side
    const moved = Math.max(...corners.map((p) => Math.min(...previous.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1]))))) / side;
    if (moved > 0.025) return { ok: false, message: 'Hold steady' };
    return { ok: true, message: 'Hold steady…', sub: '' };
  }

  // --- capture ----------------------------------------------------------------------------------

  onShutter() {
    if (this.state === 'aiming') this.capture();
  }

  /** Full-resolution frames: native photos where the browser can take them, else video frames. */
  async grabFrames() {
    const frames = [];
    if (this.imageCapture) {
      try {
        for (let i = 0; i < PHOTO_SHOTS; i++) {
          const blob = await this.imageCapture.takePhoto(await this.photoSettings());
          frames.push(await createImageBitmap(blob, { imageOrientation: 'from-image' }));
        }
        return frames;
      } catch (error) {
        console.warn('takePhoto failed, using video frames', error);
        frames.forEach((f) => f.close());
        frames.length = 0;
      }
    }
    for (let i = 0; i < VIDEO_FRAMES; i++) {
      frames.push(await createImageBitmap(this.video));
      if (i < VIDEO_FRAMES - 1) await new Promise((r) => setTimeout(r, 120));
    }
    return frames;
  }

  /** Flash for native photos when the camera offers it. */
  async photoSettings() {
    if (this.photoFlash === undefined) {
      const caps = await this.imageCapture.getPhotoCapabilities().catch(() => null);
      this.photoFlash = Boolean(caps?.fillLightMode?.includes('flash'));
    }
    return this.photoFlash ? { fillLightMode: 'flash' } : {};
  }

  async capture() {
    if (this.state !== 'aiming') return;
    this.state = 'capturing';
    this.guide('Hold still…', '');
    this.setRing(0.25);
    const frames = await this.grabFrames();
    navigator.vibrate?.(20);
    const preview = await halfSize(frames[0]);
    this.placements = [{ frames, preview }];
    await this.process(this.placements);
  }

  /** A photo from the camera app (full resolution, flash, no live view at all). */
  async processPhotoFile(file) {
    if (['capturing', 'processing', 'saving'].includes(this.state)) return;
    this.hideResult();
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      this.showError('Could not read this photo.');
      return;
    }
    await this.process([{ frames: [bitmap], preview: await halfSize(bitmap) }]);
  }

  async process(placements) {
    this.state = 'processing';
    // the camera is not needed while tracing and reviewing: switch it off (heat, battery)
    this.stopCamera();
    this.guide('Tracing the edges…', '');
    this.setRing(0.3);
    const frames = placements.flatMap((p) => p.frames.map((bitmap) => ({ bitmap })));
    let result;
    try {
      result = await this.refiner.call({ type: 'refine', frames }, frames.map((f) => f.bitmap));
    } catch (error) {
      placements.forEach((p) => p.preview.close());
      this.showError(error.message);
      return;
    }

    this.state = 'saving';
    this.setRing(0.95);
    this.guide('Finding corners and sides…', '');
    const preview = placements[0].preview;
    placements.slice(1).forEach((p) => p.preview.close());
    let summary;
    try {
      summary = await this.onScan({ label: this.label, contour: result.contour, quality: result.quality, sizeMm: result.sizeMm });
    } catch (error) {
      preview.close();
      this.showError(error.message, error.status === 409 ? 'label' : null);
      return;
    }
    this.showResult(summary, result, preview);
  }

  // --- result -----------------------------------------------------------------------------------

  showResult(summary, result, preview) {
    this.state = 'review';
    this.setRing(0);
    this.scannerEl.classList.add('has-result');
    const panel = this.resultPanel;
    panel.hidden = false;
    panel.replaceChildren();

    // the outline on the captured photo (preview is at half resolution)
    const still = document.createElement('canvas');
    still.className = 'scanner-still';
    const outline = result.preview.contour.map(([x, y]) => [x / 2, y / 2]);
    const crop = cropAround(outline, preview);
    still.width = crop.w;
    still.height = crop.h;
    const ctx = still.getContext('2d');
    ctx.drawImage(preview, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
    ctx.strokeStyle = '#3ddc84';
    ctx.lineWidth = Math.max(1.5, crop.w / 250);
    ctx.beginPath();
    outline.forEach(([x, y], i) => (i ? ctx.lineTo(x - crop.x, y - crop.y) : ctx.moveTo(x - crop.x, y - crop.y)));
    ctx.closePath();
    ctx.stroke();
    preview.close();

    const q = result.quality;
    const warnings = [];
    if (q.pixelsPerPiece < 250) warnings.push(`The piece was only ${Math.round(q.pixelsPerPiece)} px across – move closer or use 🖼 (camera app) for sharper edges.`);

    panel.append(
      this.renderResult(summary, still),
      ...warnings.map((w) => Object.assign(document.createElement('p'), { className: 'warn small', textContent: w })),
    );
    const actions = document.createElement('div');
    actions.className = 'scanner-actions';
    const retake = Object.assign(document.createElement('button'), { textContent: '↺ Retake' });
    retake.addEventListener('click', async () => {
      retake.disabled = true;
      await this.onRetake?.(summary);
      this.setLabel(summary.label);
      this.next();
    });
    const next = Object.assign(document.createElement('button'), { className: 'primary', textContent: 'Next piece →' });
    next.addEventListener('click', () => this.next());
    actions.append(retake, next);
    panel.append(actions);

    if (summary.ok) this.setLabel(nextLabelAfter(summary.label, summary.nextLabel));
    this.guide(summary.ok ? 'Saved ✓' : 'Could not find four sides', '');
  }

  /** Back to the camera for the next piece (or a retake). */
  next() {
    this.hideResult();
    this.startCamera();
  }

  showError(message, kind = null) {
    this.setRing(0);
    this.placements?.forEach((p) => { p.frames?.forEach((f) => { try { f.close(); } catch {} }); });
    this.placements = [];
    this.scannerEl.classList.add('has-result');
    const panel = this.resultPanel;
    panel.hidden = false;
    const retry = Object.assign(document.createElement('button'), { className: 'primary', textContent: 'Try again' });
    retry.addEventListener('click', () => this.next());
    panel.replaceChildren(
      Object.assign(document.createElement('h3'), { className: 'error', textContent: kind === 'label' ? 'Label already used' : 'Scan failed' }),
      Object.assign(document.createElement('p'), { textContent: message }),
      Object.assign(document.createElement('div'), { className: 'scanner-actions' }),
    );
    panel.lastChild.append(retry);
    this.state = 'review';
    if (kind === 'label') this.editLabel();
  }

  hideResult() {
    this.resultPanel.hidden = true;
    this.scannerEl.classList.remove('has-result');
  }

  // --- drawing ----------------------------------------------------------------------------------

  guide(text, sub = '') {
    if (this.guideText.textContent !== text) this.guideText.textContent = text;
    if (this.guideSub.textContent !== sub) this.guideSub.textContent = sub || '';
  }

  setRing(fraction) {
    const c = 2 * Math.PI * 34;
    this.ring.style.strokeDasharray = `${c}`;
    this.ring.style.strokeDashoffset = `${c * (1 - fraction)}`;
  }

  /** Video pixel coordinates -> overlay CSS pixels, honoring object-fit: contain. */
  videoToScreen() {
    const rect = this.overlay.getBoundingClientRect();
    const vw = this.video.videoWidth || 1;
    const vh = this.video.videoHeight || 1;
    const s = Math.min(rect.width / vw, rect.height / vh);
    return { s, ox: (rect.width - vw * s) / 2, oy: (rect.height - vh * s) / 2, rect };
  }

  clearOverlay() {
    const ctx = this.overlay.getContext('2d');
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }

  drawCard(corners, tooSmall = false) {
    const { s, ox, oy, rect } = this.videoToScreen();
    const dpr = window.devicePixelRatio || 1;
    if (this.overlay.width !== Math.round(rect.width * dpr)) {
      this.overlay.width = Math.round(rect.width * dpr);
      this.overlay.height = Math.round(rect.height * dpr);
    }
    const ctx = this.overlay.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!corners || tooSmall) {
      // where the card should be: centered, filling the view
      const vw = this.video.videoWidth * s;
      const vh = this.video.videoHeight * s;
      const side = Math.min(vw, vh) * (CARD_FILL + 0.06);
      ctx.setLineDash([10, 8]);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 2;
      ctx.strokeRect(ox + (vw - side) / 2, oy + (vh - side) / 2, side, side);
      ctx.setLineDash([]);
    }
    if (!corners) return;
    ctx.beginPath();
    corners.forEach(([x, y], i) => (i ? ctx.lineTo(x * s + ox, y * s + oy) : ctx.moveTo(x * s + ox, y * s + oy)));
    ctx.closePath();
    ctx.strokeStyle = this.stableChecks > 0 ? '#3ddc84' : '#4fa3ff';
    ctx.lineWidth = 3;
    ctx.stroke();
  }
}

function cropAround(contour, image) {
  const xs = contour.map((p) => p[0]);
  const ys = contour.map((p) => p[1]);
  const pad = (Math.max(...xs) - Math.min(...xs)) * 0.15;
  const x = Math.max(0, Math.floor(Math.min(...xs) - pad));
  const y = Math.max(0, Math.floor(Math.min(...ys) - pad));
  return { x, y, w: Math.max(1, Math.min(image.width - x, Math.ceil(Math.max(...xs) - Math.min(...xs) + 2 * pad))), h: Math.max(1, Math.min(image.height - y, Math.ceil(Math.max(...ys) - Math.min(...ys) + 2 * pad))) };
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
