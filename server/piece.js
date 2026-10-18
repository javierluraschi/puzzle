// Analysis of one piece from its outline in millimetres: the four corners, the four sides, their
// type (flat edge, tab, blank) and a shape descriptor per side for matching.
//
// Conventions: points are [x, y] with y pointing down (image coordinates). Outlines are oriented
// with positive shoelace area, i.e. clockwise on screen, so consecutive sides of an upright piece
// are top, right, bottom, left. In a side's own frame the side runs from (0, 0) to (length, 0)
// and the piece's inside is at +y: a tab bulges to -y, a blank to +y.

export const SIDE_SAMPLES = 96;

export function area(poly) {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return s / 2;
}

export function perimeter(poly) {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += Math.hypot(poly[i][0] - poly[j][0], poly[i][1] - poly[j][1]);
  return s;
}

export function centroid(poly) {
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

/** n points evenly spaced along a closed polygon. */
export function resampleClosed(poly, n) {
  return resamplePath([...poly, poly[0]], n + 1).slice(0, n);
}

/** n points evenly spaced along an open polyline, including both ends. */
export function resamplePath(path, n) {
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  const total = cum[cum.length - 1];
  const out = [];
  let j = 1;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / (n - 1);
    while (j < path.length - 1 && cum[j] < target) j++;
    const seg = cum[j] - cum[j - 1];
    const t = seg > 0 ? (target - cum[j - 1]) / seg : 0;
    out.push([path[j - 1][0] + (path[j][0] - path[j - 1][0]) * t, path[j - 1][1] + (path[j][1] - path[j - 1][1]) * t]);
  }
  return out;
}

/**
 * @param contour outline in millimetres (any orientation, any number of points)
 * @returns analysis, or { ok: false, error }
 */
export function analyzePiece(contour) {
  let pts = area(contour) < 0 ? contour.slice().reverse() : contour.slice();
  const per = perimeter(pts);
  const n = Math.max(400, Math.min(1600, Math.round(per / 0.12)));
  pts = resampleClosed(pts, n);
  const spacing = per / n;

  const corners = findCorners(pts, spacing);
  if (!corners) return { ok: false, error: 'Could not find four corners – is the whole piece on the card and in focus?' };

  const sides = corners.map((from, k) => {
    const to = corners[(k + 1) % 4];
    const path = [];
    for (let i = from; ; i = (i + 1) % n) {
      path.push(pts[i]);
      if (i === to) break;
    }
    return describeSide(path);
  });

  const directions = sides.map((s) => s.type);
  const flat = directions.filter((d) => d === 'flat').length;
  const cornerPoints = corners.map((i) => pts[i]);
  const center = [cornerPoints.reduce((s, p) => s + p[0], 0) / 4, cornerPoints.reduce((s, p) => s + p[1], 0) / 4];

  // degrees (clockwise, as SVG/CSS rotate) that bring side `top` to the top: in an upright piece
  // the side chords run at 0°, 90°, 180°, 270°; average over all four sides
  const chordAngles = cornerPoints.map((p, k) => {
    const q = cornerPoints[(k + 1) % 4];
    return Math.atan2(q[1] - p[1], q[0] - p[0]);
  });
  const rotations = [0, 1, 2, 3].map((top) => {
    let sx = 0;
    let sy = 0;
    for (let m = 0; m < 4; m++) {
      const a = chordAngles[(top + m) % 4] - (m * Math.PI) / 2;
      sx += Math.cos(a);
      sy += Math.sin(a);
    }
    return round((-Math.atan2(sy, sx) * 180) / Math.PI, 2);
  });

  return {
    ok: true,
    sizeMm: round(Math.sqrt(area(pts)), 3),
    outline: resampleClosed(pts, 400).map(([x, y]) => [round(x, 3), round(y, 3)]),
    corners: cornerPoints.map(([x, y]) => [round(x, 3), round(y, 3)]),
    center: center.map((v) => round(v, 3)),
    sideLengths: sides.map((s) => round(s.length, 3)),
    directions,
    rotations,
    kind: flat >= 2 ? 'corner' : flat === 1 ? 'edge' : 'inner',
    sides: sides.map((s) => ({ type: s.type, length: round(s.length, 4), depth: round(s.depth, 4), points: s.points.map(([x, y]) => [round(x, 4), round(y, 4)]) })),
  };
}

/**
 * The four corners (indexes into the evenly resampled outline). Candidates are sharp convex
 * turns; the chosen four form the most rectangle-like quadrilateral whose sides start and end
 * straight – like jigsawlutioner's side finder, which rates candidate corners the same way.
 */
function findCorners(pts, spacing) {
  const n = pts.length;
  const lag = Math.max(2, Math.round(0.9 / spacing)); // ~0.9 mm on either side
  const turn = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[(i - lag + n) % n];
    const b = pts[i];
    const c = pts[(i + lag) % n];
    const v1 = [b[0] - a[0], b[1] - a[1]];
    const v2 = [c[0] - b[0], c[1] - b[1]];
    turn[i] = Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1]);
  }
  // candidates: local maxima of convex turning above 40°
  const window = lag * 2;
  let candidates = [];
  for (let i = 0; i < n; i++) {
    if (turn[i] < (40 * Math.PI) / 180) continue;
    let isMax = true;
    for (let d = -window; d <= window && isMax; d++) if (d && turn[(i + d + n) % n] > turn[i]) isMax = false;
    if (isMax) candidates.push(i);
  }
  if (candidates.length < 4) return null;
  if (candidates.length > 24) candidates = candidates.sort((a, b) => turn[b] - turn[a]).slice(0, 24).sort((a, b) => a - b);

  let best = null;
  let bestScore = Infinity;
  const m = candidates.length;
  for (let a = 0; a < m - 3; a++) {
    for (let b = a + 1; b < m - 2; b++) {
      for (let c = b + 1; c < m - 1; c++) {
        for (let d = c + 1; d < m; d++) {
          const idx = [candidates[a], candidates[b], candidates[c], candidates[d]];
          const score = rateCorners(pts, idx, turn);
          if (score < bestScore) {
            bestScore = score;
            best = idx;
          }
        }
      }
    }
  }
  return bestScore < Infinity ? best : null;
}

function rateCorners(pts, idx, turn) {
  const n = pts.length;
  const c = idx.map((i) => pts[i]);
  const len = c.map((p, k) => Math.hypot(c[(k + 1) % 4][0] - p[0], c[(k + 1) % 4][1] - p[1]));
  const minLen = Math.min(...len);
  const maxLen = Math.max(...len);
  if (minLen < maxLen * 0.45) return Infinity;
  // opposite sides of the body have about the same length
  const opposite = Math.abs(len[0] - len[2]) / Math.max(len[0], len[2]) + Math.abs(len[1] - len[3]) / Math.max(len[1], len[3]);
  if (opposite > 0.5) return Infinity;
  // interior angles near 90°
  let angleError = 0;
  for (let k = 0; k < 4; k++) {
    const p = c[(k + 3) % 4];
    const q = c[k];
    const r = c[(k + 1) % 4];
    const v1 = [p[0] - q[0], p[1] - q[1]];
    const v2 = [r[0] - q[0], r[1] - q[1]];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2));
    const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
    const dev = Math.abs(angle - Math.PI / 2);
    if (dev > (35 * Math.PI) / 180) return Infinity;
    angleError += dev;
  }
  // the first and last ~12% of each side lie on its chord (tabs and blanks sit in the middle)
  let straightness = 0;
  for (let k = 0; k < 4; k++) {
    const from = idx[k];
    const to = idx[(k + 1) % 4];
    const count = (to - from + n) % n;
    const p = c[k];
    const q = c[(k + 1) % 4];
    const L = len[k];
    const ux = (q[0] - p[0]) / L;
    const uy = (q[1] - p[1]) / L;
    const edge = Math.max(2, Math.round(count * 0.12));
    let worst = 0;
    for (let j = 1; j <= edge; j++) {
      for (const i of [(from + j) % n, (to - j + n) % n]) {
        const dist = Math.abs((pts[i][0] - p[0]) * uy - (pts[i][1] - p[1]) * ux);
        if (dist > worst) worst = dist;
      }
    }
    if (worst > L * 0.09) return Infinity;
    straightness += worst / L;
  }
  const sharpness = idx.reduce((s, i) => s + Math.max(0, Math.PI / 2 - turn[i]), 0);
  return angleError * 1.0 + opposite * 2 + straightness * 8 + sharpness * 0.3 - (Math.abs(area(c)) / (maxLen * maxLen)) * 0.5;
}

/** Side in its own frame (corner to corner along +x, piece inside at +y), type and depth. */
function describeSide(path) {
  const p = path[0];
  const q = path[path.length - 1];
  const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
  const ux = (q[0] - p[0]) / length;
  const uy = (q[1] - p[1]) / length;
  // rotate so the chord is +x; with clockwise outlines the inside is at +y
  const local = path.map(([x, y]) => [(x - p[0]) * ux + (y - p[1]) * uy, -(x - p[0]) * uy + (y - p[1]) * ux]);
  const points = resamplePath(local, SIDE_SAMPLES);
  let extreme = 0;
  for (const [, y] of local) if (Math.abs(y) > Math.abs(extreme)) extreme = y;
  const type = Math.abs(extreme) < length * 0.1 ? 'flat' : extreme < 0 ? 'out' : 'in';
  return { type, length, depth: extreme, points };
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
