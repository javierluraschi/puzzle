// Accurate contour of one piece from a burst of camera frames.
//
// 1. Coarse mask per frame: color-distance segmentation; MobileSAM (ONNX Runtime Web, WebGPU or
//    WASM) acts as referee on the first frame and takes over when the background is too busy for
//    thresholding.
// 2. Sub-pixel refinement of each frame's boundary against the image (vision.refineContour).
// 3. Blurry frames are dropped; the rest are aligned and fused into one contour.
import {
  segmentForeground, pickCenterComponent, refineContour, fuseContours, normalizeContour, alignTo,
  polygonArea, boxSum, resampleClosed, isoContours, orient, similarityBetween, warpField, resizeField,
  detectCard, keepInside, applyHomography,
} from './vision.js';

const PROCESS_SIZE = 1024; // long side of the region processed per frame (also MobileSAM's input size)
const MODEL_CACHE = 'jigsaw-models-v1';
const MODELS = {
  encoder: '/models/mobile_sam_image_encoder.onnx',
  decoder: '/models/sam_mask_decoder_multi.onnx',
};

let ort = null;
let sam = null; // { encoder, decoder, device }
let samLoading = null;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load-sam') {
      await loadSam();
      self.postMessage({ id: data.id, result: { device: sam.device } });
    } else if (data.type === 'refine') {
      self.postMessage({ id: data.id, result: await refine(data) });
    } else if (data.type === 'warmup') {
      await warmup();
      self.postMessage({ id: data.id, result: true });
    }
  } catch (error) {
    console.error(error);
    self.postMessage({ id: data.id, error: error.message || String(error) });
  }
};

function progress(stage, value) {
  self.postMessage({ type: 'progress', stage, value });
}

// --- MobileSAM ------------------------------------------------------------------------------------

async function loadSam() {
  if (sam) return sam;
  if (!samLoading) {
    samLoading = (async () => {
      ort = await import('/vendor/ort/ort.webgpu.min.mjs');
      ort.env.wasm.wasmPaths = '/vendor/ort/';
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      const encoderBytes = await fetchCached(MODELS.encoder, (p) => progress('download', p * 0.63));
      const decoderBytes = await fetchCached(MODELS.decoder, (p) => progress('download', 0.63 + p * 0.37));
      progress('download', 1);
      for (const device of navigator.gpu ? ['webgpu', 'wasm'] : ['wasm']) {
        try {
          const options = { executionProviders: [device], graphOptimizationLevel: 'all' };
          const encoder = await ort.InferenceSession.create(encoderBytes, options);
          const decoder = await ort.InferenceSession.create(decoderBytes, { executionProviders: ['wasm'] });
          sam = { encoder, decoder, device };
          return sam;
        } catch (error) {
          console.warn(`MobileSAM on ${device} failed`, error);
        }
      }
      throw new Error('MobileSAM could not be started on this device');
    })();
    samLoading.catch(() => { samLoading = null; });
  }
  return samLoading;
}

/** Downloads a model once and keeps it in the Cache Storage for offline / next visits. */
async function fetchCached(url, onProgress) {
  const cache = await caches.open(MODEL_CACHE).catch(() => null);
  const cached = cache && (await cache.match(url));
  if (cached) {
    onProgress(1);
    return new Uint8Array(await cached.arrayBuffer());
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Model download failed (${response.status})`);
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) onProgress(received / total);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (cache) await cache.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })).catch(() => {});
  return bytes;
}

/**
 * MobileSAM mask (as probabilities) for the piece. Prompt: { box: [x0, y0, x1, y1] } or
 * { point: [x, y] } (the piece the user aims at).
 */
async function samMask(pixels, w, h, prompt) {
  const input = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    input[i * 3] = pixels[i * 4];
    input[i * 3 + 1] = pixels[i * 4 + 1];
    input[i * 3 + 2] = pixels[i * 4 + 2];
  }
  // This export resizes/normalizes inside the graph; it expects the image already scaled so its
  // long side is 1024, with prompt coordinates in that frame.
  const { image_embeddings: embeddings } = await sam.encoder.run({ input_image: new ort.Tensor('float32', input, [h, w, 3]) });
  // a box is two points labelled 2 and 3 (optionally after a positive point, label 1); a lone
  // point needs a padding point (label -1)
  const coords = prompt.box ? [...(prompt.point ?? []), ...prompt.box] : [...prompt.point, 0, 0];
  const labels = prompt.box ? [...(prompt.point ? [1] : []), 2, 3] : [1, -1];
  const out = await sam.decoder.run({
    image_embeddings: embeddings,
    point_coords: new ort.Tensor('float32', Float32Array.from(coords), [1, labels.length, 2]),
    point_labels: new ort.Tensor('float32', Float32Array.from(labels), [1, labels.length]),
    mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask_input: new ort.Tensor('float32', Float32Array.from([0]), [1]),
    orig_im_size: new ort.Tensor('float32', Float32Array.from([h, w]), [2]),
  });
  const [, count] = out.masks.dims;
  const scores = out.iou_predictions.data;
  const logits = out.masks.data;
  embeddings.dispose?.();

  // Output 0 is SAM's single best guess (right for box prompts). A single point is ambiguous
  // (a print detail, the piece, or the piece plus table), so pick the multi-mask candidate SAM is
  // most confident about among those of sensible size that do not touch the border.
  let pick = 0;
  if (!prompt.box) {
    let bestScore = 0.6;
    for (let m = 1; m < count; m++) {
      let area = 0;
      let border = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (logits[m * w * h + y * w + x] <= 0) continue;
          area++;
          if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border++;
        }
      }
      const fraction = area / (w * h);
      if (border > (w + h) * 0.01 || fraction < 0.02 || fraction > 0.6) continue;
      if (scores[m] > bestScore) {
        bestScore = scores[m];
        pick = m;
      }
    }
  }
  const prob = new Float32Array(w * h);
  const base = pick * w * h;
  for (let i = 0; i < prob.length; i++) prob[i] = 1 / (1 + Math.exp(-logits[base + i]));
  return { prob, score: scores[pick] };
}

// --- refinement pipeline -------------------------------------------------------------------------

/**
 * Runs the pipeline once on a synthetic piece while the user is still aiming the camera, so the
 * JavaScript engine has optimized the hot loops before the first real scan.
 */
async function warmup() {
  const frames = [];
  for (let k = 0; k < 2; k++) {
    const canvas = new OffscreenCanvas(640, 480);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2d3138';
    ctx.fillRect(0, 0, 640, 480);
    ctx.fillStyle = '#d8a040';
    ctx.beginPath();
    ctx.ellipse(320 + k, 240, 110, 90, 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(220, 200, 230, 100);
    frames.push({ bitmap: canvas.transferToImageBitmap() });
  }
  try {
    await refine({ frames, useSam: false, options: {} });
  } catch {
    // only for warming up
  }
}

async function refine({ frames, useSam, options }) {
  const frameSize = [frames[0].bitmap.width, frames[0].bitmap.height];
  const started = performance.now();
  if (useSam) {
    try {
      await loadSam();
    } catch (error) {
      console.warn('continuing without MobileSAM', error);
    }
  }

  const prepared = [];
  const classics = [];
  for (const { bitmap } of frames) {
    let frame = framePixels(bitmap, options);
    let classic = classicPrior(frame.pixels, frame.w, frame.h, options);
    // the preview can see only part of a low-contrast piece; then use the whole frame
    if (!classic && frame.cropped) {
      frame = framePixels(bitmap, options, false);
      classic = classicPrior(frame.pixels, frame.w, frame.h, options);
    }
    bitmap.close();
    prepared.push(frame);
    classics.push(classic);
  }
  const results = [];
  let mode = 'classic';
  let samScore = null;
  let samPrior0 = null;
  let debugInfo = null;

  if (sam) {
    // MobileSAM, prompted with the point the user aims at (the frame center), does not depend on
    // the background being plain. If it agrees with thresholding, thresholding + refinement is the
    // most precise; otherwise the background is too busy and every frame is segmented with SAM.
    const { pixels, w, h, offset, scale } = prepared[0];
    const aim = [(frameSize[0] / 2 - offset[0]) * scale, (frameSize[1] / 2 - offset[1]) * scale];
    const prompt = classics[0] ? { box: expandBox(classics[0].bbox, w, h, 0.06) } : { point: aim };
    const { prob, score } = await samMask(pixels, w, h, prompt);
    samScore = score;
    samPrior0 = prob;
    if (options.debug) debugInfo = { prompt, classicBox: classics[0]?.bbox ?? null, w, h, offset, scale, sam0: contourOfField(prob, w, h).map(([x, y]) => [x / scale + offset[0], y / scale + offset[1]]) };
    const agreement = classics[0] ? iou(classics[0].prior, prob) : 0;
    if (agreement < 0.9 && score > 0.6) mode = 'sam';
    else if (options.priorMix === 'sam' || options.priorMix === 'average') mode = 'sam-prior';
  }

  for (let f = 0; f < prepared.length; f++) {
    progress('refine', f / prepared.length);
    const { pixels, w, h, scale, offset } = prepared[f];
    const classic = classics[f];
    let prior = classic?.prior ?? null;

    if (mode === 'sam') {
      if (f === 0) {
        prior = samPrior0;
      } else {
        // track the piece: prompt with the previous frame's SAM outline, mapped into this frame
        const prev = results[results.length - 1];
        const box = prev ? boxOf(prev.contour, prepared[f]) : null;
        const inside = prev ? insidePoint(prev.contour, prepared[f]) : null;
        prior = (await samMask(pixels, w, h, box ? { box: expandBox(box, w, h, 0.05), point: inside } : { point: [w / 2, h / 2] })).prob;
      }
    } else if (mode === 'sam-prior' && classic && classics[0]) {
      // carry frame 0's SAM mask into this frame through the alignment of the two outlines
      const samPrior = f === 0 ? samPrior0 : warpField(samPrior0, prepared[0].w, prepared[0].h, similarityBetween(classics[0].contour, classic.contour), w, h);
      prior = options.priorMix === 'average' ? average(classic.prior, samPrior) : samPrior;
    }
    if (!prior) continue;

    const area = countAbove(prior, 0.5);
    if (area < 500) continue;
    const band = Math.max(3, Math.round(Math.sqrt(area) * 0.03));
    const { contour, contrast, sharpness } = refineAround(pixels, w, h, prior, band);
    if (!contour || contour.length < 50) continue;
    results.push({
      frame: f,
      // back to the coordinates of the bitmap that was sent
      contour: contour.map(([x, y]) => [(x + 0.5) / scale + offset[0], (y + 0.5) / scale + offset[1]]),
      // on the card: perspective-corrected, in millimetres
      contourMm: prepared[f].card ? contour.map(([x, y]) => applyHomography(prepared[f].card.H, [x + 0.5, y + 0.5])) : null,
      contrast,
      sharpness,
    });
  }
  progress('refine', 1);
  if (!results.length) throw new Error('No clear outline found – try a plainer, more contrasting background.');

  // Motion-blurred frames have soft edges: keep the sharper ones
  const maxSharp = Math.max(...results.map((r) => r.sharpness));
  let sharp = results.filter((r) => r.sharpness >= maxSharp * 0.6);
  sharp.sort((a, b) => b.sharpness - a.sharpness);
  // with the card in (most) frames, fuse the perspective-corrected millimetre outlines
  const onCard = sharp.filter((r) => r.contourMm);
  const cardMode = onCard.length >= Math.max(1, Math.ceil(sharp.length / 2));
  if (cardMode) sharp = onCard;
  const shapes = sharp.map((r) => (cardMode ? r.contourMm : r.contour));

  const fused = sharp.length > 1 ? fuseContours(shapes) : { contour: normalizeContour(shapes[0]).points, deviations: [0], kept: [0], reference: 0 };
  const keptFrames = fused.kept.map((i) => sharp[i]);
  const meanDeviation = fused.kept.reduce((s, i) => s + fused.deviations[i], 0) / fused.kept.length;

  // the fused outline drawn over the reference frame, for the confirmation screen
  const ref = sharp[fused.reference];
  const refNorm = normalizeContour(ref.contour);
  const onRef = alignTo(fused.contour, refNorm.points).points.map(([x, y]) => [x * refNorm.scale + refNorm.center[0], y * refNorm.scale + refNorm.center[1]]);

  const debug = options.debug ? {
    classic: classics.map((c, i) => c && c.contour.map(([x, y]) => [(x + 0.5) / prepared[i].scale + prepared[i].offset[0], (y + 0.5) / prepared[i].scale + prepared[i].offset[1]])),
    refined: results.map((r) => ({ frame: r.frame, contour: r.contour, sharpness: r.sharpness, contrast: r.contrast })),
    ...debugInfo,
  } : undefined;

  // true size: sqrt(area) in millimetres, the median over the fused frames
  const sizes = fused.kept.map((i) => Math.sqrt(Math.abs(polygonArea(shapes[i])))).sort((a, b) => a - b);
  const sizeMm = cardMode ? sizes[Math.floor(sizes.length / 2)] : null;

  return {
    debug,
    sizeMm: sizeMm === null ? null : round(sizeMm, 3),
    contour: resampleClosed(fused.contour, 1000).map(([x, y]) => [round(x * 1000, 1), round(y * 1000, 1)]),
    preview: { frame: ref.frame, contour: resampleClosed(onRef, 400) },
    quality: {
      frames: frames.length,
      used: keptFrames.length,
      // average disagreement between frames, in % of the piece size: lower is better
      deviation: round(meanDeviation * 100, 3),
      contrast: round(keptFrames.reduce((s, r) => s + r.contrast, 0) / keptFrames.length, 1),
      sharpness: round(keptFrames.reduce((s, r) => s + r.sharpness, 0) / keptFrames.length, 1),
      pixelsPerPiece: round(Math.sqrt(Math.abs(polygonArea(ref.contour)))),
      engine: mode,
      card: cardMode,
      samDevice: sam?.device ?? null,
      samScore: samScore === null ? null : round(samScore, 3),
      ms: Math.round(performance.now() - started),
    },
  };
}

/**
 * Pixels of the region around the piece, scaled so its long side is PROCESS_SIZE. The piece is
 * located on a small preview first so that full-resolution work is spent on the piece only.
 */
function framePixels(bitmap, options, crop = true) {
  const previewScale = 320 / Math.max(bitmap.width, bitmap.height);
  const pw = Math.round(bitmap.width * previewScale);
  const ph = Math.round(bitmap.height * previewScale);
  const preview = new OffscreenCanvas(pw, ph);
  const pctx = preview.getContext('2d', { willReadFrequently: true });
  pctx.drawImage(bitmap, 0, 0, pw, ph);
  const previewPixels = pctx.getImageData(0, 0, pw, ph).data;
  const previewCard = detectCard(previewPixels, pw, ph);
  const found = previewCard ? null : pickCenterComponent(segmentForeground(previewPixels, pw, ph, options).mask, pw, ph);

  let [sx, sy, sw, sh] = [0, 0, bitmap.width, bitmap.height];
  if (crop && previewCard) {
    // the whole card (its corners give scale and perspective), with a small margin
    const xs = previewCard.corners.map((p) => p[0] / previewScale);
    const ys = previewCard.corners.map((p) => p[1] / previewScale);
    const m = (Math.max(...xs) - Math.min(...xs)) * 0.04;
    sx = Math.max(0, Math.round(Math.min(...xs) - m));
    sy = Math.max(0, Math.round(Math.min(...ys) - m));
    sw = Math.min(bitmap.width - sx, Math.round(Math.max(...xs) - Math.min(...xs) + 2 * m));
    sh = Math.min(bitmap.height - sy, Math.round(Math.max(...ys) - Math.min(...ys) + 2 * m));
  } else if (crop && found && !found.touchesBorder) {
    const [x0, y0, x1, y1] = found.bbox.map((v) => v / previewScale);
    const side = Math.max(x1 - x0, y1 - y0) * 2.2;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    sx = Math.max(0, Math.round(cx - side / 2));
    sy = Math.max(0, Math.round(cy - side / 2));
    sw = Math.min(bitmap.width - sx, Math.round(side));
    sh = Math.min(bitmap.height - sy, Math.round(side));
  }
  const scale = PROCESS_SIZE / Math.max(sw, sh);
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
  const pixels = ctx.getImageData(0, 0, w, h).data;
  // On the card, only its interior matters: blank out the black ring and everything outside so
  // that neither thresholding nor SAM can pick them up
  const card = previewCard ? detectCard(pixels, w, h) : null;
  if (card) keepInside(pixels, w, h, card.interior);
  return { pixels, w, h, scale, offset: [sx, sy], cropped: sw < bitmap.width || sh < bitmap.height, card };
}

/**
 * Coarse piece mask by color thresholding, computed at half resolution: it only has to be within
 * the refinement band of the true edge.
 */
function classicPrior(pixels, w, h, options) {
  const hw = Math.round(w / 2);
  const hh = Math.round(h / 2);
  const half = new Uint8ClampedArray(hw * hh * 4);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      const o = (y * hw + x) * 4;
      for (let k = 0; k < 3; k++) {
        let v = 0;
        let c = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const sx = Math.min(w - 1, x * 2 + dx);
            const sy = Math.min(h - 1, y * 2 + dy);
            v += pixels[(sy * w + sx) * 4 + k];
            c++;
          }
        }
        half[o + k] = v / c;
      }
      half[o + 3] = 255;
    }
  }
  const { mask } = segmentForeground(half, hw, hh, options);
  const piece = pickCenterComponent(mask, hw, hh);
  if (!piece || piece.touchesBorder) return null;
  const soft = resizeField(Float32Array.from(piece.mask), hw, hh, w, h);
  const loops = isoContours(soft, w, h, 0.5);
  if (!loops.length) return null;
  return { prior: soft, bbox: piece.bbox.map((v) => v * 2), contour: orient(loops[0]) };
}

/** refineContour on the sub-image around the prior's boundary only. */
function refineAround(pixels, w, h, prior, band) {
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (prior[y * w + x] <= 0.5) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const m = band * 4 + 4;
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m);
  x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
  const sw = x1 - x0 + 1;
  const sh = y1 - y0 + 1;
  const subPixels = new Uint8ClampedArray(sw * sh * 4);
  const subPrior = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    subPixels.set(pixels.subarray(((y + y0) * w + x0) * 4, ((y + y0) * w + x0 + sw) * 4), y * sw * 4);
    subPrior.set(prior.subarray((y + y0) * w + x0, (y + y0) * w + x0 + sw), y * sw);
  }
  const result = refineContour(subPixels, sw, sh, subPrior, band);
  if (result.contour) result.contour = result.contour.map(([x, y]) => [x + x0, y + y0]);
  return result;
}

function contourOfField(field, w, h) {
  const loops = isoContours(field, w, h, 0.5);
  return loops.length ? loops[0] : [];
}

function average(a, b) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) / 2;
  return out;
}

function expandBox([x0, y0, x1, y1], w, h, margin) {
  const mx = (x1 - x0) * margin;
  const my = (y1 - y0) * margin;
  return [Math.max(0, x0 - mx), Math.max(0, y0 - my), Math.min(w - 1, x1 + mx), Math.min(h - 1, y1 + my)];
}

/** Bounding box of a contour given in bitmap coordinates, in the processed frame's pixels. */
function boxOf(contour, { scale, offset }) {
  const xs = contour.map(([x]) => (x - offset[0]) * scale);
  const ys = contour.map(([, y]) => (y - offset[1]) * scale);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** A point well inside the contour (its centroid, or the deepest point if the centroid is outside). */
function insidePoint(contour, { scale, offset }) {
  const pts = contour.map(([x, y]) => [(x - offset[0]) * scale, (y - offset[1]) * scale]);
  let cx = 0;
  let cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  return [cx / pts.length, cy / pts.length];
}

function iou(a, b) {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i] > 0.5;
    const q = b[i] > 0.5;
    if (p && q) inter++;
    if (p || q) union++;
  }
  return union ? inter / union : 0;
}

function countAbove(field, level) {
  let n = 0;
  for (let i = 0; i < field.length; i++) if (field[i] > level) n++;
  return n;
}

function round(v, digits = 2) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
