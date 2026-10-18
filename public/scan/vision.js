// Image processing for the piece scanner. Pure functions on typed arrays (no DOM), shared by
// the live worker (fast, low resolution) and the refine worker (accurate, full resolution).
//
// Conventions: images are RGBA Uint8ClampedArray with width w and height h; masks are
// Uint8Array (0/1); fields are Float32Array; polygons are arrays of [x, y].

// --- foreground segmentation -------------------------------------------------------------------

/**
 * Separates a piece from a plain background by color distance to a background model.
 * @returns {{mask: Uint8Array, distance: Float32Array, threshold: number, contrast: number}}
 */
export function segmentForeground(data, w, h, { sensitivity = 1, backgroundPoint = null } = {}) {
  const sample = backgroundPoint ? sampleColor(data, w, h, backgroundPoint[0] * w, backgroundPoint[1] * h) : null;
  const background = estimateBackground(data, w, h, sample);
  const distance = colorDistance(data, background, w, h);
  const { threshold, separation } = otsu(distance);
  const t = threshold / sensitivity;

  let mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = distance[i] > t ? 1 : 0;
  const r = Math.max(1, Math.round(Math.max(w, h) / 400));
  mask = close(mask, w, h, r);
  fillHoles(mask, w, h);
  mask = open(mask, w, h, r);
  return { mask, distance, threshold: t, contrast: separation };
}

/**
 * Picks the connected component that most likely is "the piece": the largest one near the
 * image center.
 */
export function pickCenterComponent(mask, w, h) {
  const { labels, components } = connectedComponents(mask, w, h);
  const minArea = w * h * 0.004;
  let best = null;
  let bestScore = -Infinity;
  let others = 0;
  for (const c of components) {
    if (c.area < minArea) continue;
    others++;
    const dx = (c.centroid[0] - w / 2) / w;
    const dy = (c.centroid[1] - h / 2) / h;
    const score = Math.sqrt(c.area / (w * h)) - 2 * Math.hypot(dx, dy);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (!best) return null;
  const [x0, y0, x1, y1] = best.bbox;
  best.touchesBorder = x0 <= 1 || y0 <= 1 || x1 >= w - 2 || y1 >= h - 2;
  best.others = others - 1;
  const only = new Uint8Array(w * h);
  for (let i = 0; i < only.length; i++) only[i] = labels[i] === best.label ? 1 : 0;
  best.mask = only;
  return best;
}

export function estimateBackground(data, w, h, sample) {
  const border = [];
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  const step = Math.max(1, Math.round((w + h) / 1500));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (x >= band && x < w - band && y >= band && y < h - band) continue;
      const i = (y * w + x) * 4;
      border.push([data[i], data[i + 1], data[i + 2]]);
    }
  }
  const global = sample || medianColor(border);

  // Per-cell median of background-looking pixels handles uneven light and vignetting
  const cells = 8;
  const cw = Math.ceil(w / cells);
  const ch = Math.ceil(h / cells);
  const grid = [];
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const samples = [];
      const stepC = Math.max(1, Math.round(cw / 24));
      for (let y = cy * ch; y < Math.min(h, (cy + 1) * ch); y += stepC) {
        for (let x = cx * cw; x < Math.min(w, (cx + 1) * cw); x += stepC) {
          const i = (y * w + x) * 4;
          const c = [data[i], data[i + 1], data[i + 2]];
          if (dist3(c, global) < 55) samples.push(c);
        }
      }
      grid.push(samples.length > 20 ? medianColor(samples) : null);
    }
  }
  for (let pass = 0; pass < cells * 2 && grid.some((g) => g === null); pass++) {
    const copy = grid.slice();
    for (let i = 0; i < grid.length; i++) {
      if (grid[i]) continue;
      const cx = i % cells;
      const cy = Math.floor(i / cells);
      const n = [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]
        .filter(([x, y]) => x >= 0 && y >= 0 && x < cells && y < cells)
        .map(([x, y]) => copy[y * cells + x])
        .filter(Boolean);
      if (n.length) grid[i] = [0, 1, 2].map((k) => n.reduce((s, c) => s + c[k], 0) / n.length);
    }
  }
  for (let i = 0; i < grid.length; i++) if (!grid[i]) grid[i] = global;

  const bg = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(cells - 1, Math.max(0, (y + 0.5) / ch - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(cells - 1, y0 + 1);
    const fy = gy - y0;
    for (let x = 0; x < w; x++) {
      const gx = Math.min(cells - 1, Math.max(0, (x + 0.5) / cw - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(cells - 1, x0 + 1);
      const fx = gx - x0;
      const a = grid[y0 * cells + x0];
      const b = grid[y0 * cells + x1];
      const c = grid[y1 * cells + x0];
      const d = grid[y1 * cells + x1];
      const o = (y * w + x) * 3;
      for (let k = 0; k < 3; k++) {
        bg[o + k] = (a[k] * (1 - fx) + b[k] * fx) * (1 - fy) + (c[k] * (1 - fx) + d[k] * fx) * fy;
      }
    }
  }
  return bg;
}

function colorDistance(data, bg, w, h) {
  const out = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    const o = p * 3;
    const dr = data[i] - bg[o];
    const dg = data[i + 1] - bg[o + 1];
    const db = data[i + 2] - bg[o + 2];
    const dl = 0.3 * dr + 0.59 * dg + 0.11 * db;
    out[p] = Math.sqrt(dl * dl * 1.5 + (dr * dr + dg * dg + db * db) * 0.5);
  }
  return out;
}

/** Otsu threshold of a field; `separation` (0..1) says how bimodal it is (contrast quality). */
function otsu(values) {
  const bins = 256;
  let max = 1;
  for (let i = 0; i < values.length; i += 5) if (values[i] > max) max = values[i];
  const hist = new Float64Array(bins);
  for (let i = 0; i < values.length; i += 2) hist[Math.min(bins - 1, Math.floor((values[i] / max) * bins))]++;
  let total = 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < bins; i++) {
    total += hist[i];
    sum += i * hist[i];
    sumSq += i * i * hist[i];
  }
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 0;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) {
      best = between;
      threshold = i;
    }
  }
  const variance = sumSq / total - (sum / total) ** 2;
  return {
    threshold: Math.max(18, ((threshold + 0.5) / bins) * max),
    separation: variance > 0 ? best / (total * total) / variance : 0,
  };
}

// --- morphology -----------------------------------------------------------------------------------

/** Sum of a field over a (2r+1)^2 window (clamped at the borders), separable running sums. */
export function boxSum(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) s += src[row + x];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s;
      const add = x + r + 1;
      const rem = x - r;
      if (add < w) s += src[row + add];
      if (rem >= 0) s -= src[row + rem];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) s += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s;
      const add = y + r + 1;
      const rem = y - r;
      if (add < h) s += tmp[add * w + x];
      if (rem >= 0) s -= tmp[rem * w + x];
    }
  }
  return out;
}

function windowCount(mask, w, h, r) {
  return boxSum(Float32Array.from(mask), w, h, r);
}

export function dilate(mask, w, h, r) {
  const c = windowCount(mask, w, h, r);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = c[i] > 0.5 ? 1 : 0;
  return out;
}

export function erode(mask, w, h, r) {
  const c = windowCount(mask, w, h, r);
  const full = windowSizes(w, h, r);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = c[i] > full[i] - 0.5 ? 1 : 0;
  return out;
}

/** Number of pixels in each pixel's (2r+1)^2 window, clipped at the image border. */
export function windowSizes(w, h, r) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ny = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1;
    for (let x = 0; x < w; x++) out[y * w + x] = ny * (Math.min(w - 1, x + r) - Math.max(0, x - r) + 1);
  }
  return out;
}

export function close(mask, w, h, r) {
  return erode(dilate(mask, w, h, r), w, h, r);
}

export function open(mask, w, h, r) {
  return dilate(erode(mask, w, h, r), w, h, r);
}

export function fillHoles(mask, w, h) {
  const reach = new Uint8Array(mask.length);
  const stack = [];
  const push = (i) => {
    if (!mask[i] && !reach[i]) {
      reach[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < mask.length - w) push(i + w);
  }
  for (let i = 0; i < mask.length; i++) if (!reach[i]) mask[i] = 1;
}

export function connectedComponents(mask, w, h) {
  const labels = new Int32Array(mask.length);
  const components = [];
  const stack = new Int32Array(mask.length);
  let next = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    next++;
    let top = 0;
    stack[top++] = start;
    labels[start] = next;
    let area = 0;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    let sx = 0;
    let sy = 0;
    while (top) {
      const i = stack[--top];
      const x = i % w;
      const y = (i - x) / w;
      area++;
      sx += x;
      sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && mask[i - 1] && !labels[i - 1]) { labels[i - 1] = next; stack[top++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !labels[i + 1]) { labels[i + 1] = next; stack[top++] = i + 1; }
      if (y > 0 && mask[i - w] && !labels[i - w]) { labels[i - w] = next; stack[top++] = i - w; }
      if (y < h - 1 && mask[i + w] && !labels[i + w]) { labels[i + w] = next; stack[top++] = i + w; }
    }
    components.push({ label: next, area, bbox: [x0, y0, x1, y1], centroid: [sx / area, sy / area] });
  }
  return { labels, components };
}

// --- sub-pixel contours ------------------------------------------------------------------------------

/**
 * Marching squares: closed iso-lines of `field` at `level`, with linear interpolation along the
 * cell edges (sub-pixel). Values outside the image count as below the level, so every loop is
 * closed. Returns the loops sorted by enclosed area, largest first.
 */
export function isoContours(field, w, h, level = 0.5) {
  const W = w + 2;
  const H = h + 2;
  const f = new Float32Array(W * H).fill(level - 1);
  for (let y = 0; y < h; y++) f.set(field.subarray(y * w, y * w + w), (y + 1) * W + 1);

  // crossing ids: horizontal edge (x,y)-(x+1,y) -> 2*(y*W+x); vertical (x,y)-(x,y+1) -> 2*(y*W+x)+1
  const nb1 = new Int32Array(W * H * 2).fill(-1);
  const nb2 = new Int32Array(W * H * 2).fill(-1);
  const link = (a, b) => {
    if (nb1[a] < 0) nb1[a] = b; else nb2[a] = b;
    if (nb1[b] < 0) nb1[b] = a; else nb2[b] = a;
  };
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const a = f[y * W + x];
      const b = f[y * W + x + 1];
      const c = f[(y + 1) * W + x + 1];
      const d = f[(y + 1) * W + x];
      const code = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const top = 2 * (y * W + x);
      const bottom = 2 * ((y + 1) * W + x);
      const left = 2 * (y * W + x) + 1;
      const right = 2 * (y * W + x + 1) + 1;
      switch (code) {
        case 1: case 14: link(left, bottom); break;
        case 2: case 13: link(bottom, right); break;
        case 3: case 12: link(left, right); break;
        case 4: case 11: link(top, right); break;
        case 6: case 9: link(top, bottom); break;
        case 7: case 8: link(left, top); break;
        case 5: case 10: {
          const center = (a + b + c + d) / 4 > level;
          // saddle: keep the diagonal of the "inside" corners connected if the center is inside
          if ((code === 5) === center) {
            link(left, top);
            link(bottom, right);
          } else {
            link(left, bottom);
            link(top, right);
          }
          break;
        }
      }
    }
  }

  const point = (id) => {
    const cell = id >> 1;
    const x = cell % W;
    const y = (cell - x) / W;
    if ((id & 1) === 0) {
      const v0 = f[cell];
      const v1 = f[cell + 1];
      return [x + (level - v0) / (v1 - v0) - 1, y - 1];
    }
    const v0 = f[cell];
    const v1 = f[cell + W];
    return [x - 1, y + (level - v0) / (v1 - v0) - 1];
  };

  const visited = new Uint8Array(W * H * 2);
  const loops = [];
  for (let start = 0; start < nb1.length; start++) {
    if (nb1[start] < 0 || visited[start]) continue;
    const loop = [];
    let prev = -1;
    let cur = start;
    while (cur >= 0 && !visited[cur]) {
      visited[cur] = 1;
      loop.push(point(cur));
      const next = nb1[cur] !== prev ? nb1[cur] : nb2[cur];
      prev = cur;
      cur = next;
    }
    if (loop.length >= 8) loops.push(loop);
  }
  loops.sort((p, q) => Math.abs(polygonArea(q)) - Math.abs(polygonArea(p)));
  return loops;
}

export function maskToField(mask) {
  return Float32Array.from(mask);
}

export function polygonArea(poly) {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return s / 2;
}

export function polygonCentroid(poly) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const cross = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += cross;
    cx += (poly[j][0] + poly[i][0]) * cross;
    cy += (poly[j][1] + poly[i][1]) * cross;
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function perimeter(poly) {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += Math.hypot(poly[i][0] - poly[j][0], poly[i][1] - poly[j][1]);
  return s;
}

/** n points evenly spaced along a closed polygon. */
export function resampleClosed(poly, n) {
  const total = perimeter(poly);
  const step = total / n;
  const out = [];
  let i = 0;
  let segStart = poly[0];
  let segEnd = poly[1 % poly.length];
  let segLen = Math.hypot(segEnd[0] - segStart[0], segEnd[1] - segStart[1]);
  let along = 0;
  for (let k = 0; k < n; k++) {
    const target = k * step;
    while (along + segLen < target && i < poly.length) {
      along += segLen;
      i++;
      segStart = poly[i % poly.length];
      segEnd = poly[(i + 1) % poly.length];
      segLen = Math.hypot(segEnd[0] - segStart[0], segEnd[1] - segStart[1]);
    }
    const t = segLen > 0 ? (target - along) / segLen : 0;
    out.push([segStart[0] + (segEnd[0] - segStart[0]) * t, segStart[1] + (segEnd[1] - segStart[1]) * t]);
  }
  return out;
}

/** Counter-clockwise (in y-down image coordinates: positive shoelace) orientation. */
export function orient(poly) {
  return polygonArea(poly) < 0 ? poly.slice().reverse() : poly;
}

// --- edge refinement ---------------------------------------------------------------------------------

/**
 * Refines a coarse piece mask to a sub-pixel contour using the image itself.
 *
 * The coarse mask (from SAM or thresholding) defines a trimap: pixels well inside are piece,
 * pixels well outside are background, and a band of `band` pixels around the boundary is unknown.
 * In the band, each pixel is explained as a mix of the local piece color F and local background
 * color B (both averaged from the sure regions nearby): alpha = (I-B)·(F-B) / |F-B|². Where F and B
 * are too similar to tell apart, the coarse prior is used instead. The 0.5 iso-line of alpha is the
 * refined contour.
 *
 * @param prior Float32Array 0..1 (coarse probability of "piece")
 * @returns {{contour: number[][], contrast: number, sharpness: number}}
 */
export function refineContour(data, w, h, prior, band) {
  const n = w * h;
  const coarse = new Uint8Array(n);
  for (let i = 0; i < n; i++) coarse[i] = prior[i] > 0.5 ? 1 : 0;
  const near = windowCount(coarse, w, h, band);
  const full = windowSizes(w, h, band);
  const sureFg = new Float32Array(n);
  const sureBg = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (near[i] > full[i] - 0.5) sureFg[i] = 1;
    else if (near[i] < 0.5) sureBg[i] = 1;
  }

  // Local piece / background color for every band pixel: the color of the nearest sure pixel
  // (slightly smoothed), spread outward breadth-first. Nearest colors follow the print right up to
  // the edge, where window averages would mix in other print regions.
  const smooth = smoothColors(data, w, h);
  const F = propagateColors(smooth, sureFg, w, h, band * 2 + 2);
  const B = propagateColors(smooth, sureBg, w, h, band * 2 + 2);
  const fgCount = F.known;
  const bgCount = B.known;
  // Background texture / noise level: how much sure-background pixels deviate from their
  // neighbourhood. Distances below it are not evidence of the piece.
  const noise = backgroundNoise(smooth, sureBg, w, h);

  // alpha = |I - B| / |F - B|: for an edge pixel mixing piece and background this is exactly the
  // mix ratio, and unlike a projection onto F-B it also counts third colors (the white cardboard
  // rim many pieces have, print details) as piece. Shadows still read as piece, so diffuse light
  // matters.
  const alpha = new Float32Array(n);
  let contrastSum = 0;
  let contrastCount = 0;
  for (let i = 0; i < n; i++) {
    if (sureFg[i]) { alpha[i] = 1; continue; }
    if (sureBg[i]) { alpha[i] = 0; continue; }
    if (!fgCount[i] || !bgCount[i]) { alpha[i] = prior[i]; continue; }
    let dd = 0;
    let di = 0;
    for (let k = 0; k < 3; k++) {
      const b = B.color[i * 3 + k];
      dd += (F.color[i * 3 + k] - b) ** 2;
      di += (smooth[i * 3 + k] - b) ** 2;
    }
    const contrast = Math.sqrt(dd);
    const a = contrast > noise ? Math.min(1, Math.max(0, (Math.sqrt(di) - noise) / (contrast - noise))) : prior[i];
    // trust the colors only where piece and background differ clearly
    const trust = Math.min(1, Math.max(0, (contrast - 2 * noise - 8) / 25));
    alpha[i] = trust * a + (1 - trust) * prior[i];
    contrastSum += contrast;
    contrastCount++;
  }

  // light smoothing against sensor noise and print texture
  const smoothed = boxSum(alpha, w, h, 1);
  const counts = windowSizes(w, h, 1);
  for (let i = 0; i < n; i++) smoothed[i] /= counts[i];

  const loops = isoContours(smoothed, w, h, 0.5);
  const contour = loops.length ? orient(loops[0]) : null;
  return {
    contour,
    contrast: contrastCount ? contrastSum / contrastCount : 0,
    sharpness: contour ? edgeSharpness(data, w, h, contour) : 0,
  };
}

/** Mean deviation of sure-background pixels from their local mean (texture + sensor noise). */
function backgroundNoise(colors, sureBg, w, h) {
  const n = w * h;
  const r = 3;
  const cnt = boxSum(sureBg, w, h, r);
  const means = [0, 1, 2].map((k) => {
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = colors[i * 3 + k] * sureBg[i];
    return boxSum(v, w, h, r);
  });
  let sum = 0;
  let count = 0;
  const step = Math.max(1, Math.floor(n / 200000));
  for (let i = 0; i < n; i += step) {
    if (!sureBg[i] || cnt[i] < 10) continue;
    let d = 0;
    for (let k = 0; k < 3; k++) d += (colors[i * 3 + k] - means[k][i] / cnt[i]) ** 2;
    sum += Math.sqrt(d);
    count++;
  }
  return count ? (sum / count) * 1.5 : 6;
}

/** 3x3 box-smoothed RGB as Float32Array (3 per pixel), against halftone dots and sensor noise. */
function smoothColors(data, w, h) {
  const out = new Float32Array(w * h * 3);
  const cnt = windowSizes(w, h, 1);
  for (let k = 0; k < 3; k++) {
    const v = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) v[i] = data[i * 4 + k];
    const sum = boxSum(v, w, h, 1);
    for (let i = 0; i < w * h; i++) out[i * 3 + k] = sum[i] / cnt[i];
  }
  return out;
}

/**
 * Multi-source BFS from the `seed` pixels: every reached pixel gets the mean color of its
 * already-colored neighbours, i.e. approximately the color of the nearest seed pixel.
 */
function propagateColors(colors, seed, w, h, maxDistance) {
  const n = w * h;
  const color = new Float32Array(n * 3);
  const known = new Uint8Array(n);
  const dist = new Uint16Array(n);
  let frontier = [];
  for (let i = 0; i < n; i++) {
    if (!seed[i]) continue;
    known[i] = 1;
    color[i * 3] = colors[i * 3];
    color[i * 3 + 1] = colors[i * 3 + 1];
    color[i * 3 + 2] = colors[i * 3 + 2];
    const x = i % w;
    // only seeds at the seed region's border can reach unknown pixels
    if ((x > 0 && !seed[i - 1]) || (x < w - 1 && !seed[i + 1]) || (i >= w && !seed[i - w]) || (i < n - w && !seed[i + w])) frontier.push(i);
  }
  for (let d = 1; d <= maxDistance && frontier.length; d++) {
    const next = [];
    for (const i of frontier) {
      const x = i % w;
      const neighbours = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1];
      for (const j of neighbours) {
        if (j < 0 || known[j] || dist[j] === d) continue;
        dist[j] = d;
        next.push(j);
      }
    }
    for (const j of next) {
      const x = j % w;
      let r = 0, g = 0, b = 0, c = 0;
      for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j >= w ? j - w : -1, j < n - w ? j + w : -1]) {
        if (k < 0 || !known[k]) continue;
        r += color[k * 3]; g += color[k * 3 + 1]; b += color[k * 3 + 2]; c++;
      }
      color[j * 3] = r / c;
      color[j * 3 + 1] = g / c;
      color[j * 3 + 2] = b / c;
    }
    for (const j of next) known[j] = 1;
    frontier = next;
  }
  return { color, known };
}

/** Mean gradient magnitude along the contour, a blur detector. */
export function edgeSharpness(data, w, h, contour) {
  let s = 0;
  let count = 0;
  const lum = (x, y) => {
    const i = (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4;
    return 0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2];
  };
  const step = Math.max(1, Math.floor(contour.length / 400));
  for (let k = 0; k < contour.length; k += step) {
    const x = Math.round(contour[k][0]);
    const y = Math.round(contour[k][1]);
    const gx = lum(x + 1, y) - lum(x - 1, y);
    const gy = lum(x, y + 1) - lum(x, y - 1);
    s += Math.hypot(gx, gy);
    count++;
  }
  return count ? s / count : 0;
}

// --- alignment and fusion ------------------------------------------------------------------------------

/** Translates to the centroid and scales to unit sqrt(area). */
export function normalizeContour(poly) {
  const c = polygonCentroid(poly);
  const s = Math.sqrt(Math.abs(polygonArea(poly)));
  return { points: poly.map(([x, y]) => [(x - c[0]) / s, (y - c[1]) / s]), center: c, scale: s };
}

function rotatePoints(points, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return points.map(([x, y]) => [x * cos - y * sin, x * sin + y * cos]);
}

/**
 * Similarity ICP of normalized `src` onto normalized `dst` (both centered, unit area).
 * @returns {{points, error, transform: {a, b, tx, ty}}} transformed src points, RMS distance and
 *   the transform p' = [a -b; b a] p + [tx, ty]
 */
export function alignTo(src, dst, { initialAngles = [0] } = {}) {
  const target = resampleClosed(dst, 300);
  const grid = new NearestGrid(target, 0.05);
  const sample = resampleClosed(src, 300);
  let best = null;
  for (const angle of initialAngles) {
    let T = { a: Math.cos(angle), b: Math.sin(angle), tx: 0, ty: 0 };
    let pts = applySimilarity(sample, T);
    let error = Infinity;
    for (let iter = 0; iter < 40; iter++) {
      const step = umeyama(pts, pts.map((p) => grid.nearest(p)));
      T = composeSimilarity(step, T);
      pts = applySimilarity(sample, T);
      let e = 0;
      for (const p of pts) {
        const q = grid.nearest(p);
        e += (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
      }
      const newError = Math.sqrt(e / pts.length);
      const done = Math.abs(error - newError) < 1e-7;
      error = newError;
      if (done) break;
    }
    if (!best || error < best.error) best = { error, transform: T };
  }
  return { points: applySimilarity(src, best.transform), error: best.error, transform: best.transform };
}

export function applySimilarity(points, { a, b, tx, ty }) {
  return points.map(([x, y]) => [a * x - b * y + tx, b * x + a * y + ty]);
}

/** second ∘ first */
function composeSimilarity(second, first) {
  return {
    a: second.a * first.a - second.b * first.b,
    b: second.a * first.b + second.b * first.a,
    tx: second.a * first.tx - second.b * first.ty + second.tx,
    ty: second.b * first.tx + second.a * first.ty + second.ty,
  };
}

/** Least-squares 2D similarity mapping points p to q (Umeyama). */
function umeyama(p, q) {
  const n = p.length;
  let mx = 0, my = 0, nx = 0, ny = 0;
  for (let i = 0; i < n; i++) { mx += p[i][0]; my += p[i][1]; nx += q[i][0]; ny += q[i][1]; }
  mx /= n; my /= n; nx /= n; ny /= n;
  let sa = 0, sb = 0, varP = 0;
  for (let i = 0; i < n; i++) {
    const px = p[i][0] - mx, py = p[i][1] - my, qx = q[i][0] - nx, qy = q[i][1] - ny;
    sa += px * qx + py * qy;
    sb += px * qy - py * qx;
    varP += px * px + py * py;
  }
  const a = sa / varP;
  const b = sb / varP;
  return { a, b, tx: nx - (a * mx - b * my), ty: ny - (b * mx + a * my) };
}

/**
 * Pixel-space similarity mapping polygon `from` onto polygon `to` (e.g. the same piece in two
 * frames), found by ICP on the normalized shapes.
 */
export function similarityBetween(from, to) {
  const A = normalizeContour(from);
  const B = normalizeContour(to);
  const { transform: T, error } = alignTo(A.points, B.points, { initialAngles: [-0.2, 0, 0.2] });
  // p_to = sB * T((p_from - cA) / sA) + cB
  const k = B.scale / A.scale;
  const a = T.a * k;
  const b = T.b * k;
  return {
    a,
    b,
    tx: B.scale * T.tx + B.center[0] - (a * A.center[0] - b * A.center[1]),
    ty: B.scale * T.ty + B.center[1] - (b * A.center[0] + a * A.center[1]),
    error,
  };
}

/** Bilinear resize of a field. */
export function resizeField(field, w, h, outW, outH) {
  return warpField(field, w, h, { a: outW / w, b: 0, tx: (outW / w - 1) / 2, ty: (outH / h - 1) / 2 }, outW, outH);
}

/** Resamples a field into another frame: out(q) = field(inverse(T)(q)), bilinear. */
export function warpField(field, w, h, T, outW, outH) {
  const det = T.a * T.a + T.b * T.b;
  // the inverse of [a -b; b a] is [a b; -b a] / det
  const out = new Float32Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const dx = x - T.tx;
      const dy = y - T.ty;
      const sx = (T.a * dx + T.b * dy) / det;
      const sy = (-T.b * dx + T.a * dy) / det;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue;
      const fx = sx - x0;
      const fy = sy - y0;
      const i = y0 * w + x0;
      out[y * outW + x] = (field[i] * (1 - fx) + field[i + 1] * fx) * (1 - fy) + (field[i + w] * (1 - fx) + field[i + w + 1] * fx) * fy;
    }
  }
  return out;
}

class NearestGrid {
  constructor(points, cell) {
    this.points = points;
    this.cell = cell;
    this.map = new Map();
    for (const p of points) {
      const key = this.key(Math.floor(p[0] / cell), Math.floor(p[1] / cell));
      if (!this.map.has(key)) this.map.set(key, []);
      this.map.get(key).push(p);
    }
  }

  key(i, j) {
    return i * 100003 + j;
  }

  nearest(p) {
    const ci = Math.floor(p[0] / this.cell);
    const cj = Math.floor(p[1] / this.cell);
    let best = null;
    let bestD = Infinity;
    for (let r = 0; r < 40; r++) {
      for (let i = ci - r; i <= ci + r; i++) {
        for (let j = cj - r; j <= cj + r; j++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
          const bucket = this.map.get(this.key(i, j));
          if (!bucket) continue;
          for (const q of bucket) {
            const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
            if (d < bestD) { bestD = d; best = q; }
          }
        }
      }
      if (best && Math.sqrt(bestD) < r * this.cell) break;
    }
    return best || this.points[0];
  }
}

/**
 * Anti-aliased coverage of a polygon on a grid: exact horizontal coverage on 4 sub-rows per pixel.
 * Adds into `acc` (Float32Array size*size); the grid spans [-extent, extent]^2.
 */
export function addCoverage(acc, size, extent, poly) {
  const toGrid = (v) => ((v + extent) / (2 * extent)) * size;
  const pts = poly.map(([x, y]) => [toGrid(x), toGrid(y)]);
  const SUB = 4;
  const xs = [];
  for (let row = 0; row < size; row++) {
    for (let s = 0; s < SUB; s++) {
      const y = row + (s + 0.5) / SUB;
      xs.length = 0;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [x1, y1] = pts[j];
        const [x2, y2] = pts[i];
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a = Math.max(0, xs[k]);
        const b = Math.min(size, xs[k + 1]);
        if (b <= a) continue;
        const ia = Math.floor(a);
        const ib = Math.floor(b);
        const base = row * size;
        if (ia === ib) {
          acc[base + ia] += (b - a) / SUB;
          continue;
        }
        acc[base + ia] += (ia + 1 - a) / SUB;
        for (let x = ia + 1; x < ib && x < size; x++) acc[base + x] += 1 / SUB;
        if (ib < size) acc[base + ib] += (b - ib) / SUB;
      }
    }
  }
}

/**
 * Fuses several contours of the same piece (different frames) into one: normalize, align every
 * contour to the reference, average their anti-aliased coverage and take the 0.5 iso-line, i.e. a
 * per-location majority vote that suppresses noise, glare and shadows seen in only some frames.
 * @returns {{contour, deviations: number[], kept: number[]}} contour in normalized units
 */
export function fuseContours(contours, { size = 720, extent = 1.05 } = {}) {
  const normalized = contours.map((c) => normalizeContour(c).points);
  const angles = [-0.15, 0, 0.15];

  // Reference = medoid: the frame that agrees best with all others. A frame that went wrong (a
  // shadow, a finger, a grabbed background edge) disagrees with most and is never the reference.
  let reference = 0;
  if (normalized.length > 2) {
    let bestSum = Infinity;
    for (let i = 0; i < normalized.length; i++) {
      let sum = 0;
      for (let j = 0; j < normalized.length; j++) {
        if (i !== j) sum += contourDeviation(alignTo(normalized[j], normalized[i], { initialAngles: angles }).points, normalized[i]);
      }
      if (sum < bestSum) {
        bestSum = sum;
        reference = i;
      }
    }
  }
  const aligned = normalized.map((c, i) => (i === reference ? { points: c } : alignTo(c, normalized[reference], { initialAngles: angles })));

  const fuseOnce = (indexes) => {
    const acc = new Float32Array(size * size);
    for (const i of indexes) addCoverage(acc, size, extent, resampleClosed(aligned[i].points, 800));
    for (let i = 0; i < acc.length; i++) acc[i] /= indexes.length;
    const loops = isoContours(acc, size, size, 0.5);
    const toUnits = (v) => (v / size) * 2 * extent - extent;
    return orient(loops[0].map(([x, y]) => [toUnits(x), toUnits(y)]));
  };

  // keep the frames consistent with the reference
  const toReference = aligned.map((a, i) => (i === reference ? 0 : contourDeviation(a.points, normalized[reference])));
  const sorted = toReference.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let kept = aligned.map((_, i) => i).filter((i) => toReference[i] <= Math.max(median * 2, 0.006));
  if (kept.length < 2) kept = [reference];
  const fused = fuseOnce(kept);
  const deviations = aligned.map((a) => contourDeviation(a.points, fused));
  return { contour: normalizeContour(fused).points, deviations, kept, reference };
}

/** Mean distance from the points of `a` to the polygon `b` (in the units of the polygons). */
export function contourDeviation(a, b) {
  const grid = new NearestGrid(resampleClosed(b, 1500), 0.02);
  const pts = resampleClosed(a, 400);
  let s = 0;
  for (const p of pts) {
    const q = grid.nearest(p);
    s += Math.hypot(p[0] - q[0], p[1] - q[1]);
  }
  return s / pts.length;
}

// --- scan card: absolute scale and perspective correction ------------------------------------------

// The printable card (card.html): a black square ring on paper; the piece lies in the middle.
export const CARD = { outer: 70, ring: 6, gap: 2 }; // millimetres

/**
 * Finds the scan card: a dark square ring that encloses the image center. Returns its outer
 * corners refined by line fitting, the homography image -> card millimetres, and the interior
 * (inside the ring) as an image-space polygon.
 */
export function detectCard(data, w, h) {
  const n = w * h;
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) gray[i] = 0.3 * data[i * 4] + 0.59 * data[i * 4 + 1] + 0.11 * data[i * 4 + 2];
  const R = Math.max(4, Math.round(Math.min(w, h) / 10));
  const mean = boxSum(gray, w, h, R);
  const sizes = windowSizes(w, h, R);
  const dark = new Uint8Array(n);
  for (let i = 0; i < n; i++) dark[i] = gray[i] < mean[i] / sizes[i] - 30 && gray[i] < 120 ? 1 : 0;

  const { labels, components } = connectedComponents(dark, w, h);
  const candidates = components
    .filter((c) => c.area > n * 0.01 && c.bbox[2] - c.bbox[0] > w * 0.25 && c.bbox[3] - c.bbox[1] > h * 0.25)
    .filter((c) => c.bbox[0] > 1 && c.bbox[1] > 1 && c.bbox[2] < w - 2 && c.bbox[3] < h - 2)
    .sort((a, b) => (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]) - (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]))
    .slice(0, 4);
  let best = null;
  for (const c of candidates) {
    const filled = new Uint8Array(n);
    for (let i = 0; i < n; i++) filled[i] = labels[i] === c.label ? 1 : 0;
    fillHoles(filled, w, h);
    let filledArea = 0;
    for (let i = 0; i < n; i++) filledArea += filled[i];
    // a ring: thin compared with what it encloses, and it encloses the image center
    if (c.area / filledArea > 0.6 || !filled[Math.round(h / 2) * w + Math.round(w / 2)]) continue;
    const loops = isoContours(Float32Array.from(filled), w, h, 0.5);
    if (!loops.length) continue;
    const corners = quadCorners(loops[0]);
    if (!corners) continue;
    const H = homography(corners, [[0, 0], [CARD.outer, 0], [CARD.outer, CARD.outer], [0, CARD.outer]]);
    const Hinv = homography([[0, 0], [CARD.outer, 0], [CARD.outer, CARD.outer], [0, CARD.outer]], corners);
    const a = CARD.ring + CARD.gap;
    const b = CARD.outer - a;
    const interior = [[a, a], [b, a], [b, b], [a, b]].map((p) => applyHomography(Hinv, p));
    // sanity: a plausible square under mild perspective
    const sides = corners.map((p, i) => Math.hypot(p[0] - corners[(i + 1) % 4][0], p[1] - corners[(i + 1) % 4][1]));
    if (Math.min(...sides) / Math.max(...sides) < 0.75) continue;
    // the card's geometry: the ring covers 1 - (58/70)^2 ≈ 31% of the square it encloses, and
    // just inside it lies the white paper gap (a band of dark table around a white card does not)
    const ringShare = 1 - ((CARD.outer - 2 * CARD.ring) / CARD.outer) ** 2;
    if (Math.abs(c.area / filledArea - ringShare) > 0.12) continue;
    const brightness = (mmPoints) => {
      let sum = 0;
      for (const p of mmPoints) {
        const [x, y] = applyHomography(Hinv, p).map(Math.round);
        sum += gray[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
      }
      return sum / mmPoints.length;
    };
    const along = (offset) => {
      const pts = [];
      for (let t = 0.2; t <= 0.8; t += 0.1) {
        const v = CARD.outer * t;
        pts.push([v, offset], [CARD.outer - offset, v], [v, CARD.outer - offset], [offset, v]);
      }
      return pts;
    };
    if (brightness(along(CARD.ring + CARD.gap / 2)) < brightness(along(CARD.ring / 2)) + 50) continue;
    const found = { corners, H, Hinv, interior, pixelsPerMm: sides.reduce((s, v) => s + v, 0) / 4 / CARD.outer, filledArea };
    // a dark table around the white paper can look like a ring too; the card's frame is inside it
    if (!best || filledArea < best.filledArea) best = found;
  }
  return best;
}

/** Four corners of a quadrilateral outline: extreme points along the diagonals, then refined by
 * fitting a line to each side and intersecting neighbouring lines (sub-pixel). */
function quadCorners(loop) {
  // rotation invariant: a diagonal (farthest point pair), then the farthest points on each side of it
  const n = loop.length;
  const c = polygonCentroid(loop);
  const farthestFrom = (q) => {
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.hypot(loop[i][0] - q[0], loop[i][1] - q[1]) > Math.hypot(loop[best][0] - q[0], loop[best][1] - q[1])) best = i;
    return best;
  };
  const i1 = farthestFrom(loop[farthestFrom(c)]);
  const i3 = farthestFrom(loop[i1]);
  const [ax, ay] = loop[i1];
  const [bx, by] = loop[i3];
  let i2 = -1, i4 = -1, d2 = 0, d4 = 0;
  for (let i = 0; i < n; i++) {
    const d = ((bx - ax) * (loop[i][1] - ay) - (by - ay) * (loop[i][0] - ax)) / Math.hypot(bx - ax, by - ay);
    if (d > d2) { d2 = d; i2 = i; }
    if (-d > d4) { d4 = -d; i4 = i; }
  }
  if (i2 < 0 || i4 < 0) return null;
  // in loop order, so consecutive corners share a side
  const ext = [i1, i2, i3, i4].sort((x, y) => x - y);
  if (new Set(ext).size < 4) return null;
  // chains between consecutive corners along the loop, matched back to TL, TR, BR, BL order
  const lines = [];
  for (let k = 0; k < 4; k++) {
    const from = ext[k];
    const to = ext[(k + 1) % 4];
    const forward = (to - from + n) % n;
    const backward = (from - to + n) % n;
    const step = forward <= backward ? 1 : -1;
    const len = Math.min(forward, backward);
    const pts = [];
    for (let j = Math.round(len * 0.12); j <= Math.round(len * 0.88); j++) pts.push(loop[(from + step * j + n) % n]);
    if (pts.length < 5) return null;
    lines.push(fitLine(pts));
  }
  const corners = [];
  for (let k = 0; k < 4; k++) {
    const p = intersect(lines[(k + 3) % 4], lines[k]);
    if (!p) return null;
    corners.push(p);
  }
  // same orientation as the card's millimetre square, otherwise the mapping would mirror pieces
  return polygonArea(corners) < 0 ? [corners[0], corners[3], corners[2], corners[1]] : corners;
}

function fitLine(pts) {
  let mx = 0, my = 0;
  for (const [x, y] of pts) { mx += x; my += y; }
  mx /= pts.length; my /= pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2; }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: [mx, my], d: [Math.cos(angle), Math.sin(angle)] };
}

function intersect(l1, l2) {
  const det = l1.d[0] * l2.d[1] - l1.d[1] * l2.d[0];
  if (Math.abs(det) < 1e-6) return null;
  const t = ((l2.p[0] - l1.p[0]) * l2.d[1] - (l2.p[1] - l1.p[1]) * l2.d[0]) / det;
  return [l1.p[0] + t * l1.d[0], l1.p[1] + t * l1.d[1]];
}

/** Homography mapping 4 source points onto 4 destination points (DLT, h33 = 1). */
export function homography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // Gaussian elimination with partial pivoting
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c < 8; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const hv = b.map((v, i) => v / A[i][i]);
  return [...hv, 1];
}

export function applyHomography(H, [x, y]) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** Replaces everything outside `polygon` by a uniform color (the card interior's), in place. */
export function keepInside(data, w, h, polygon) {
  const inside = new Uint8Array(w * h);
  const acc = new Float32Array(w * h);
  addCoverageImage(acc, w, h, polygon);
  const samples = [];
  for (let i = 0; i < w * h; i++) {
    inside[i] = acc[i] > 0.5 ? 1 : 0;
    if (acc[i] > 0.5 && i % 7 === 0) samples.push(i);
  }
  // the interior's typical color, sampled near its border (where the piece is not)
  const ring = dilate(inside, w, h, 3);
  const inner = erode(inside, w, h, 6);
  const border = [];
  for (let i = 0; i < w * h; i += 3) if (inside[i] && !inner[i] && ring[i]) border.push([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
  const fill = medianColor(border.length ? border : samples.map((i) => [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]));
  for (let i = 0; i < w * h; i++) {
    if (inside[i]) continue;
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
  }
  return inside;
}

/** Coverage of a polygon given in pixel coordinates (helper for keepInside). */
function addCoverageImage(acc, w, h, poly) {
  const xs = [];
  for (let row = 0; row < h; row++) {
    const y = row + 0.5;
    xs.length = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [x1, y1] = poly[j];
      const [x2, y2] = poly[i];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x < Math.min(w, Math.ceil(xs[k + 1] - 0.5)); x++) acc[row * w + x] = 1;
    }
  }
}

// --- small helpers -------------------------------------------------------------------------------------

export function sampleColor(data, w, h, cx, cy) {
  const r = Math.max(2, Math.round(Math.min(w, h) / 200));
  const colors = [];
  for (let y = Math.max(0, Math.round(cy) - r); y <= Math.min(h - 1, Math.round(cy) + r); y++) {
    for (let x = Math.max(0, Math.round(cx) - r); x <= Math.min(w - 1, Math.round(cx) + r); x++) {
      const i = (y * w + x) * 4;
      colors.push([data[i], data[i + 1], data[i + 2]]);
    }
  }
  return medianColor(colors);
}

function medianColor(colors) {
  if (!colors.length) return [128, 128, 128];
  return [0, 1, 2].map((k) => {
    const v = colors.map((c) => c[k]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  });
}

function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
