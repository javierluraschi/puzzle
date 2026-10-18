// Accurate contour of one piece lying on the scan card, from one or more full-resolution photos.
//
// Per photo:
//   1. find the card (its frame gives the perspective-correcting homography and the scale)
//   2. coarse piece mask on the card interior with a shadow-free color distance
//   3. sub-pixel refinement at the photo's native resolution in a crop around the piece
//   4. contour -> card millimetres
// Then the frames are aligned and averaged (blurred frames are dropped first).
import {
  detectCard, keepInside, applyHomography, segmentOnCard, refineOnCard, pickCenterComponent,
  isoContours, orient, resampleClosed, polygonArea, polygonCentroid, normalizeContour, alignTo,
  addCoverage, contourDeviation, smoothClosed, warpField,
} from './vision.js';

const COARSE_SIZE = 1024; // long side for finding the card
const INTERIOR_SIZE = 900; // long side of the card interior for the coarse mask
const FINE_MAX = 1400; // cap for the native-resolution crop around the piece
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'refine') {
      self.postMessage({ id: data.id, result: await refine(data) });
    } else if (data.type === 'card') {
      self.postMessage({ id: data.id, result: findCard(data.bitmap) });
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

// --- live: is the card in view? ---------------------------------------------------------------------

/** Cheap check for the live view: card corners in the coordinates of the (small) bitmap. */
function findCard(bitmap) {
  const { pixels, w, h } = draw(bitmap, 1, [0, 0, bitmap.width, bitmap.height]);
  bitmap.close();
  const card = detectCard(pixels, w, h);
  return { corners: card ? card.corners : null, w, h };
}

// --- one photo -> contour in millimetres -------------------------------------------------------

function draw(bitmap, scale, [sx, sy, sw, sh]) {
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
  return { pixels: ctx.getImageData(0, 0, w, h).data, w, h };
}

function bbox(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

async function photoContour(bitmap) {
  // 1. the card, found on a downscaled copy; mm <-> photo pixels through its homography
  const cs = COARSE_SIZE / Math.max(bitmap.width, bitmap.height);
  const coarse = draw(bitmap, cs, [0, 0, bitmap.width, bitmap.height]);
  const card = detectCard(coarse.pixels, coarse.w, coarse.h);
  if (!card) throw new Error('Scan card not found – the whole black frame must be in the picture.');
  const interiorPhoto = card.interior.map(([x, y]) => [x / cs, y / cs]);

  // 2. coarse mask on the card interior
  const [ix0, iy0, ix1, iy1] = bbox(interiorPhoto);
  const iRect = [Math.floor(ix0), Math.floor(iy0), Math.ceil(ix1 - ix0), Math.ceil(iy1 - iy0)];
  const is = Math.min(1, INTERIOR_SIZE / Math.max(iRect[2], iRect[3]));
  const interior = draw(bitmap, is, iRect);
  keepInside(interior.pixels, interior.w, interior.h, interiorPhoto.map(([x, y]) => [(x - iRect[0]) * is, (y - iRect[1]) * is]));
  const { mask } = segmentOnCard(interior.pixels, interior.w, interior.h);
  const piece = pickCenterComponent(mask, interior.w, interior.h);
  if (!piece) throw new Error('No piece found on the card – try the other card color for this piece.');
  if (piece.touchesBorder) throw new Error('The piece touches the card frame – place it in the middle.');

  // 3. native-resolution crop around the piece, the coarse mask as prior
  const [px0, py0, px1, py1] = piece.bbox.map((v) => v / is);
  const margin = Math.max(px1 - px0, py1 - py0) * 0.12 + 8;
  const fx = Math.max(0, Math.floor(iRect[0] + px0 - margin));
  const fy = Math.max(0, Math.floor(iRect[1] + py0 - margin));
  const fRect = [fx, fy, Math.min(bitmap.width - fx, Math.ceil(px1 - px0 + 2 * margin)), Math.min(bitmap.height - fy, Math.ceil(py1 - py0 + 2 * margin))];
  const fs = Math.min(1, FINE_MAX / Math.max(fRect[2], fRect[3]));
  const fine = draw(bitmap, fs, fRect);
  keepInside(fine.pixels, fine.w, fine.h, interiorPhoto.map(([x, y]) => [(x - fRect[0]) * fs, (y - fRect[1]) * fs]));
  // interior pixel u -> photo (iRect + (u + 0.5) / is) -> fine pixel ((photo - fRect) * fs - 0.5)
  const k = fs / is;
  const prior = warpField(Float32Array.from(piece.mask), interior.w, interior.h,
    { a: k, b: 0, tx: (iRect[0] - fRect[0]) * fs + (k - 1) / 2, ty: (iRect[1] - fRect[1]) * fs + (k - 1) / 2 }, fine.w, fine.h);
  let area = 0;
  for (const v of prior) if (v > 0.5) area++;
  const band = Math.max(4, Math.round(Math.sqrt(area) * 0.03));
  const refined = refineOnCard(fine.pixels, fine.w, fine.h, prior, band);
  if (!refined.contour) throw new Error('No clear outline found.');

  // 4. fine pixels -> photo pixels -> card millimetres
  const photo = refined.contour.map(([x, y]) => [(x + 0.5) / fs + fRect[0], (y + 0.5) / fs + fRect[1]]);
  const mm = photo.map(([x, y]) => applyHomography(card.H, [x * cs, y * cs]));
  return {
    mm,
    toPhoto: (p) => applyHomography(card.Hinv, p).map((v) => v / cs),
    photoSize: [bitmap.width, bitmap.height],
    photo,
    pxPerMm: (card.pixelsPerMm / cs) * fs,
    sharpness: refined.sharpness,
    contrast: refined.contrast,
    noise: refined.noise,
  };
}

// --- combining photos ------------------------------------------------------------------------------

/**
 * Outlines (millimetres) aligned rigidly to the first and combined on a common grid: by mean
 * (frames of one placement) or by min (placements with the piece turned in between). The result
 * is in the coordinates of the first outline.
 */
function combine(outlines, mode, angles) {
  const center = polygonCentroid(outlines[0]);
  const scale = Math.sqrt(Math.abs(polygonArea(outlines[0])));
  const toUnit = (poly) => poly.map(([x, y]) => [(x - center[0]) / scale, (y - center[1]) / scale]);
  const reference = toUnit(outlines[0]);
  const aligned = outlines.map((poly, i) => {
    if (i === 0) return reference;
    const own = toUnit(poly);
    const c = polygonCentroid(own);
    // the size is known on the card, so the alignment is rigid (no rescaling)
    return alignTo(own.map(([x, y]) => [x - c[0], y - c[1]]), reference, { initialAngles: angles, scale: false }).points;
  });
  const size = 720;
  const extent = 1.05;
  const grids = aligned.map((poly) => {
    const acc = new Float32Array(size * size);
    addCoverage(acc, size, extent, resampleClosed(poly, 900));
    return acc;
  });
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) {
    let v = mode === 'min' ? Infinity : 0;
    for (const g of grids) v = mode === 'min' ? Math.min(v, g[i]) : v + g[i];
    out[i] = mode === 'min' ? v : v / grids.length;
  }
  const loops = isoContours(out, size, size, 0.5);
  const toMm = (v) => (v / size) * 2 * extent - extent;
  const contour = orient(loops[0].map(([x, y]) => [toMm(x) * scale + center[0], toMm(y) * scale + center[1]]));
  const unit = toUnit(contour);
  return { contour, deviations: aligned.map((poly) => contourDeviation(poly, unit)) };
}

async function refine({ frames, options = {} }) {
  const started = performance.now();
  const results = [];
  const errors = [];
  for (let f = 0; f < frames.length; f++) {
    progress('refine', f / frames.length);
    try {
      results.push({ ...(await photoContour(frames[f].bitmap)), placement: 0, frame: f });
    } catch (error) {
      errors.push(error.message);
    } finally {
      frames[f].bitmap.close();
    }
  }
  progress('refine', 1);
  if (!results.length) throw new Error(errors[0] || 'No outline found.');

  // per placement: drop blurred frames, average the rest
  const placements = [];
  for (const p of [...new Set(results.map((r) => r.placement))].sort()) {
    const group = results.filter((r) => r.placement === p);
    const maxSharp = Math.max(...group.map((r) => r.sharpness));
    const sharp = group.filter((r) => r.sharpness >= maxSharp * 0.6);
    const fused = sharp.length > 1 ? combine(sharp.map((r) => r.mm), 'mean', [-0.1, 0, 0.1]) : { contour: sharp[0].mm, deviations: [0] };
    placements.push({ contour: fused.contour, frames: sharp, deviation: mean(fused.deviations.slice(1)) });
  }
  let final = placements[0].contour;

  // a touch of smoothing along the outline (0.08 mm) removes pixel jitter but keeps the corners
  final = resampleClosed(final, 1600);
  const mmPerPoint = perimeterOf(final) / final.length;
  final = smoothClosed(final, 0.08 / mmPerPoint);

  const sizeMm = Math.sqrt(Math.abs(polygonArea(final)));
  const reference = placements[0].frames[0];
  return {
    sizeMm: round(sizeMm, 3),
    contour: resampleClosed(normalizeContour(final).points, 1000).map(([x, y]) => [round(x * 1000, 1), round(y * 1000, 1)]),
    // the outline on the reference photo, for the confirmation screen
    preview: { frame: reference.frame, contour: resampleClosed(final, 500).map(reference.toPhoto) },
    debug: options.debug ? { photos: results.map((r) => ({ frame: r.frame, placement: r.placement, photo: r.photo })), final: final.map(reference.toPhoto), errors } : undefined,
    quality: {
      frames: frames.length,
      used: placements.reduce((s, p) => s + p.frames.length, 0),
      // disagreement between the frames, % of the piece size
      deviation: round(mean(placements.map((p) => p.deviation)) * 100, 3),
      contrast: round(mean(results.map((r) => r.contrast)), 1),
      sharpness: round(mean(results.map((r) => r.sharpness)), 1),
      pixelsPerMm: round(mean(results.map((r) => r.pxPerMm)), 1),
      pixelsPerPiece: round(sizeMm * mean(results.map((r) => r.pxPerMm))),
      photo: results[0].photoSize,
      engine: 'shadow-free',
      card: true,
      ms: Math.round(performance.now() - started),
    },
  };
}

function perimeterOf(poly) {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += Math.hypot(poly[i][0] - poly[j][0], poly[i][1] - poly[j][1]);
  return s;
}

function mean(values) {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
}

function round(v, digits = 2) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Runs the pipeline once on a synthetic card so the first real scan is not slowed by JIT warm-up. */
async function warmup() {
  const canvas = new OffscreenCanvas(900, 900);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#eeeee8';
  ctx.fillRect(0, 0, 900, 900);
  ctx.fillStyle = '#121214';
  ctx.fillRect(100, 100, 700, 700);
  ctx.fillStyle = '#eeeee8';
  ctx.fillRect(160, 160, 580, 580);
  ctx.fillStyle = '#343840';
  ctx.fillRect(180, 180, 540, 540);
  ctx.fillStyle = '#6a8ad0';
  ctx.beginPath();
  ctx.ellipse(450, 450, 110, 90, 0.3, 0, Math.PI * 2);
  ctx.fill();
  try {
    await refine({ frames: [{ bitmap: canvas.transferToImageBitmap() }] });
  } catch {
    // only for warming up
  }
}
