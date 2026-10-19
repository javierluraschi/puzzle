// Geometric side matching: how well does side B of one piece fill side A of another?
//
// In A's frame (A from (0,0) to (La,0), A's piece at +y) the neighbour lies at -y and runs along the
// shared edge in the opposite direction, so B's points (u, v) map to (Lb - u, -v), reversed.
//
// Photos show the top surface of a piece, whose cut edge is slightly rounded, so a traced outline
// lies a little inside the actual cut and two true neighbours are separated by a uniform gap along
// the whole edge (~0.1-0.3 mm on phone photos, ~0 on flatbed scans). The comparison therefore fits
// a rigid motion plus such a uniform offset; the score is the remaining shape mismatch (RMS, mm)
// over the middle of the side, plus a penalty for an offset far from the puzzle's typical one.
// That gap differs between scanning sessions (light), so each piece gets its own share of it
// (estimatePieceGaps). Sides next to a flat side only pair with sides that continue the border.
// The ends of the side are checked separately: true neighbours meet corner to corner, so ends that
// overshoot or bend away from the other side are penalized (see endMismatch).

import { SIDE_SAMPLES } from './piece.js';
import { compose, invert, fit, sideFrame } from './rigid.js';

const TRIM = Number(globalThis.process?.env?.MATCH_TRIM ?? 0.08);
const INNER_FROM = Math.round(SIDE_SAMPLES * TRIM);
const INNER_TO = Math.round(SIDE_SAMPLES * (1 - TRIM));
const OFFSET_WEIGHT = Number(globalThis.process?.env?.MATCH_OFFSET_WEIGHT ?? 0.5);
const MAX_OFFSET = 0.45; // mm
const env = (name, fallback) => Number(globalThis.process?.env?.[name] ?? fallback);
const CORNER_WEIGHT = env('MATCH_CORNER_WEIGHT', 0.3);
const CORNER_TOLERANCE = env('MATCH_CORNER_TOLERANCE', 0.6); // mm
const TAIL_WEIGHT = env('MATCH_TAIL_WEIGHT', 0.5);
const TAIL_TOLERANCE = env('MATCH_TAIL_TOLERANCE', 0.2); // mm
const BORDER_CHECK = env('MATCH_BORDER', 1) === 1;
const PIECE_GAPS = env('MATCH_PIECE_GAPS', 1) === 1;
const GAP_WINDOW = env('MATCH_GAP_WINDOW', 15); // pieces before and after in scanning order
const GAP_PRIOR = env('MATCH_GAP_PRIOR', 12); // weight of that neighbourhood, in fits

export function complementary(a, b) {
  return (a.type === 'out' && b.type === 'in') || (a.type === 'in' && b.type === 'out');
}

/** Cheap rejection before the real comparison. */
export function plausible(a, b) {
  if (!complementary(a, b)) return false;
  const L = Math.max(a.length, b.length);
  return Math.abs(a.length - b.length) < 0.08 * L && Math.abs(Math.abs(a.depth) - Math.abs(b.depth)) < 0.15 * L;
}

/**
 * Border consistency of mating side s of piece pa with side t of piece pb: when A's side before s
 * is flat the two pieces lie along the puzzle's border, so B's side after t must be flat too (and
 * the other way round); a flat next to only one of them cannot be.
 */
export function borderCompatible(pa, s, pb, t) {
  if (!BORDER_CHECK) return true;
  const flat = (piece, k) => piece.sides[(k + 4) % 4].type === 'flat';
  return flat(pa, s - 1) === flat(pb, t + 1) && flat(pa, s + 1) === flat(pb, t - 1);
}

/** B's curve as it lies when mated to A, in A's frame. */
function mate(a, b) {
  const dx = (a.length - b.length) / 2;
  const out = new Array(b.points.length);
  for (let k = 0; k < b.points.length; k++) {
    const [u, v] = b.points[b.points.length - 1 - k];
    out[k] = [b.length - u + dx, -v];
  }
  return out;
}

/** Quick score: RMS of index-wise distances (both curves are sampled evenly corner to corner). */
export function quickScore(a, b) {
  const m = mate(a, b);
  let s = 0;
  for (let k = INNER_FROM; k < INNER_TO; k++) s += (a.points[k][0] - m[k][0]) ** 2 + (a.points[k][1] - m[k][1]) ** 2;
  return Math.sqrt(s / (INNER_TO - INNER_FROM));
}

/**
 * Nearest point to p on A's polyline near index `hint`, with the signed distance: positive when p
 * lies outside A's piece (on the neighbour's side, -y in A's frame) – i.e. a gap.
 */
export function nearestOnA(points, p, hint, window = 10) {
  let best = Infinity;
  let res = null;
  const from = Math.max(0, hint - window);
  const to = Math.min(points.length - 1, hint + window);
  for (let k = from; k < to; k++) {
    const [x1, y1] = points[k];
    const [x2, y2] = points[k + 1];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - x1) * dx + (p[1] - y1) * dy) / len2)) : 0;
    const cx = x1 + dx * t;
    const cy = y1 + dy * t;
    const d = (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
    if (d < best) {
      best = d;
      const len = Math.sqrt(len2) || 1;
      // outward normal of A (A runs +x with its inside at +y, so outward is (dy, -dx) / len)
      const nx = dy / len;
      const ny = -dx / len;
      res = { q: [cx, cy], n: [nx, ny], signed: (p[0] - cx) * nx + (p[1] - cy) * ny };
    }
  }
  return res;
}

/**
 * Rigid ICP of the mated B onto A allowing a uniform offset along A's normal.
 * @returns {{ residual: number, offset: number, pose }} residual RMS (mm), the fitted offset (mm)
 *   and (when the sides carry frames) the pose of B's piece in A's piece coordinates
 */
export function sideFit(a, b) {
  const start = mate(a, b);
  let m = start;
  let offset = 0;
  let residual = Infinity;
  for (let iter = 0; iter < 10; iter++) {
    const near = [];
    for (let k = INNER_FROM; k < INNER_TO; k++) near.push([m[k], nearestOnA(a.points, m[k], k)]);
    offset = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, near.reduce((s, [, r]) => s + r.signed, 0) / near.length));
    let s = 0;
    for (const [, r] of near) s += (r.signed - offset) ** 2;
    const newResidual = Math.sqrt(s / near.length);
    if (residual - newResidual < 1e-4) {
      residual = Math.min(residual, newResidual);
      break;
    }
    residual = newResidual;
    // targets: A's curve pushed out by the offset; rigid least-squares step towards them
    const pairs = near.map(([p, r]) => [p, [r.q[0] + r.n[0] * offset, r.q[1] + r.n[1] * offset]]);
    let mx = 0, my = 0, nx = 0, ny = 0;
    for (const [p, q] of pairs) { mx += p[0]; my += p[1]; nx += q[0]; ny += q[1]; }
    mx /= pairs.length; my /= pairs.length; nx /= pairs.length; ny /= pairs.length;
    let sa = 0, sb = 0;
    for (const [p, q] of pairs) {
      const px = p[0] - mx, py = p[1] - my, qx = q[0] - nx, qy = q[1] - ny;
      sa += px * qx + py * qy;
      sb += px * qy - py * qx;
    }
    const norm = Math.hypot(sa, sb) || 1;
    const cos = sa / norm;
    const sin = sb / norm;
    m = m.map(([x, y]) => [cos * (x - mx) - sin * (y - my) + nx, sin * (x - mx) + cos * (y - my) + ny]);
  }
  return { residual, offset, ends: endMismatch(a, m, offset), pose: a.origin ? relativePose(a, b, start, m) : null };
}

/**
 * How well the ends of the fitted B meet A's ends, outside the middle the fit used: `corner` is how
 * far apart the corners lie along the edge, `tail` the mean distance (mm) of B's end stretches from
 * A's curve beyond the gap. True neighbours meet corner to corner; the worse end counts.
 */
function endMismatch(a, m, offset) {
  const n = a.points.length - 1;
  let corner = 0;
  let tail = 0;
  for (const [from, to, k] of [[0, INNER_FROM, 0], [INNER_TO, n + 1, n]]) {
    corner = Math.max(corner, Math.abs(m[k][0] - a.points[k][0]));
    let d = 0;
    for (let j = from; j < to; j++) d += Math.abs(nearestOnA(a.points, m[j], j, 6).signed - offset);
    tail = Math.max(tail, d / (to - from));
  }
  return { corner, tail };
}

/**
 * Pose of piece B in piece A's coordinates: B's piece -> B's side frame -> mated onto A's side
 * frame (a half turn about the chord's middle) -> the ICP refinement -> A's piece coordinates.
 */
function relativePose(a, b, start, final) {
  const mateMotion = { c: -1, s: 0, tx: b.length + (a.length - b.length) / 2, ty: 0 };
  const icp = fit(start, final);
  return compose(invert(sideFrame(a)), compose(icp, compose(mateMotion, sideFrame(b))));
}

/** Penalty (mm) for edge ends that do not meet, beyond what noise in corners and outlines explains. */
export function endPenalty(ends) {
  if (!ends) return 0;
  return CORNER_WEIGHT * Math.max(0, ends.corner - CORNER_TOLERANCE) + TAIL_WEIGHT * Math.max(0, ends.tail - TAIL_TOLERANCE);
}

/** Combined score (mm, lower is better) given the puzzle's typical gap. */
export function combine({ residual, offset, ends }, typicalOffset) {
  return residual + OFFSET_WEIGHT * Math.abs(offset - typicalOffset) + endPenalty(ends);
}

/**
 * Best candidates for every side of every piece.
 * @param pieces Map(index -> analysis with .sides)
 * @returns {{ table: Map("piece_side" -> [{ piece, side, score, residual, offset }]), typicalOffset }}
 */
export function candidateTable(pieces, { keep = 12, refine = 16 } = {}) {
  const sides = [];
  for (const [index, piece] of pieces) {
    if (!piece.ok) continue;
    piece.sides.forEach((side, s) => sides.push({ index, s, side, piece }));
  }
  const raw = new Map();
  for (const A of sides) {
    const quick = [];
    for (const B of sides) {
      if (B.index === A.index || !plausible(A.side, B.side) || !borderCompatible(A.piece, A.s, B.piece, B.s)) continue;
      quick.push({ B, q: quickScore(A.side, B.side) });
    }
    quick.sort((x, y) => x.q - y.q);
    raw.set(`${A.index}_${A.s}`, quick.slice(0, refine).map(({ B }) => ({ piece: B.index, side: B.s, ...sideFit(A.side, B.side) })));
  }
  const typicalOffset = estimateTypicalOffset(raw);
  const gaps = PIECE_GAPS ? estimatePieceGaps(raw, typicalOffset) : null;
  const expected = (i, j) => (gaps ? (gaps.get(i) ?? typicalOffset / 2) + (gaps.get(j) ?? typicalOffset / 2) : typicalOffset);
  const table = new Map();
  for (const [key, list] of raw) {
    const i = Number(key.split('_')[0]);
    const scored = list.map((c) => ({ piece: c.piece, side: c.side, score: round(combine(c, expected(i, c.piece))), residual: round(c.residual), offset: round(c.offset) }));
    scored.sort((x, y) => x.score - y.score);
    table.set(key, scored.slice(0, keep));
  }
  return { table, typicalOffset, gaps: gaps ? Object.fromEntries([...gaps].map(([i, g]) => [i, round(g)])) : null };
}

/**
 * Each piece's own share of the gap: how far inside the cut its traced outline lies depends on the
 * light when it was scanned, so pieces from one scanning session share a gap that another session
 * does not. The gap of a pair is the sum of both shares; the shares are fitted to the offsets of
 * clear mutual-best fits, each pulled towards the shares of the pieces scanned around the same time
 * (and half the typical gap), so pieces with little evidence of their own follow their session.
 */
export function estimatePieceGaps(raw, typicalOffset, { margin = 1.5, prior = GAP_PRIOR, window = GAP_WINDOW, sweeps = 20 } = {}) {
  const best = new Map();
  for (const [key, list] of raw) {
    const scored = list.map((c) => ({ c, s: combine(c, typicalOffset) })).sort((x, y) => x.s - y.s);
    if (scored.length) best.set(key, { ...scored[0], second: scored[1]?.s ?? Infinity });
  }
  const pairs = [];
  for (const [key, b] of best) {
    const [i] = key.split('_').map(Number);
    const back = best.get(`${b.c.piece}_${b.c.side}`);
    if (!back || back.c.piece !== i || `${back.c.piece}_${back.c.side}` !== key || i > b.c.piece) continue;
    if (b.second / b.s < margin || back.second / back.s < margin) continue;
    pairs.push([i, b.c.piece, (b.c.offset + back.c.offset) / 2]);
  }
  const gaps = new Map();
  const half = typicalOffset / 2;
  for (const key of raw.keys()) gaps.set(Number(key.split('_')[0]), half);
  // pieces scanned one after the other (consecutive indexes) were lit alike: their prior is the
  // mean share of their neighbours in scanning order
  const order = [...gaps.keys()].sort((x, y) => x - y);
  const position = new Map(order.map((i, k) => [i, k]));
  const near = (i) => order.slice(Math.max(0, position.get(i) - window), position.get(i) + window + 1).filter((j) => j !== i);
  for (let sweep = 0; sweep < sweeps; sweep++) {
    const sum = new Map();
    const count = new Map();
    for (const [i, j, o] of pairs) {
      sum.set(i, (sum.get(i) || 0) + o - gaps.get(j));
      count.set(i, (count.get(i) || 0) + 1);
      sum.set(j, (sum.get(j) || 0) + o - gaps.get(i));
      count.set(j, (count.get(j) || 0) + 1);
    }
    const previous = new Map(gaps);
    for (const i of gaps.keys()) {
      const around = window ? near(i).map((j) => previous.get(j)) : [];
      const base = around.length ? (around.reduce((x, y) => x + y, 0) + half) / (around.length + 1) : half;
      gaps.set(i, (prior * base + (sum.get(i) || 0)) / (prior + (count.get(i) || 0)));
    }
  }
  return gaps;
}

/** The usual gap between true neighbours: the median offset of mutual best, clean fits. */
export function estimateTypicalOffset(raw) {
  const best = new Map();
  for (const [key, list] of raw) {
    if (!list.length) continue;
    best.set(key, list.reduce((x, y) => (x.residual <= y.residual ? x : y)));
  }
  const offsets = [];
  for (const [key, top] of best) {
    const back = best.get(`${top.piece}_${top.side}`);
    const [i, s] = key.split('_').map(Number);
    if (back && back.piece === i && back.side === s) offsets.push(top.offset);
  }
  if (offsets.length < 3) return 0;
  offsets.sort((x, y) => x - y);
  return round(offsets[Math.floor(offsets.length / 2)]);
}

/** Score of a specific pair, symmetric (both directions averaged). */
export function pairScore(pieces, i, s, j, t, typicalOffset = 0) {
  const a = pieces.get(i)?.sides?.[s];
  const b = pieces.get(j)?.sides?.[t];
  if (!a || !b || !complementary(a, b)) return Infinity;
  return (combine(sideFit(a, b), typicalOffset) + combine(sideFit(b, a), typicalOffset)) / 2;
}

/** Match quality 0..1 for display: ~1 for a perfect fit, 0.5 at `half` mm. */
export function confidence(score, half) {
  return Math.round(Math.exp(-((score / half) ** 2) * Math.LN2) * 1000) / 1000;
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}

/**
 * Was this piece scanned before? Compares the four sides of `a` with those of `b` in all four
 * rotations (same orientation, not mated). Returns the mean RMS difference (mm) of the best
 * rotation, or Infinity when the side types do not line up.
 */
export function shapeDifference(a, b) {
  let best = Infinity;
  for (let r = 0; r < 4; r++) {
    let total = 0;
    let ok = true;
    for (let k = 0; k < 4 && ok; k++) {
      const sa = a.sides[k];
      const sb = b.sides[(k + r) % 4];
      if (sa.type !== sb.type || Math.abs(sa.length - sb.length) > 0.06 * sa.length) {
        ok = false;
        break;
      }
      let s = 0;
      for (let i = INNER_FROM; i < INNER_TO; i++) s += (sa.points[i][0] - sb.points[i][0]) ** 2 + (sa.points[i][1] - sb.points[i][1]) ** 2;
      total += Math.sqrt(s / (INNER_TO - INNER_FROM));
    }
    if (ok) best = Math.min(best, total / 4);
  }
  return best;
}

/**
 * Candidates for the sides of one piece only (the "what fits here?" view before a full solve).
 * Without a known typical gap it is estimated from this piece's own clean best fits.
 */
export function candidatesFor(pieces, index, { typicalOffset = null, keep = 8, refine = 16 } = {}) {
  const piece = pieces.get(index);
  if (!piece?.ok) return [];
  const others = [];
  for (const [j, p] of pieces) if (j !== index && p.ok) p.sides.forEach((side, t) => others.push({ j, t, side, p }));
  const raw = piece.sides.map((side, s) => {
    const quick = others.filter((o) => plausible(side, o.side) && borderCompatible(piece, s, o.p, o.t)).map((o) => ({ o, q: quickScore(side, o.side) }));
    quick.sort((x, y) => x.q - y.q);
    return quick.slice(0, refine).map(({ o }) => ({ piece: o.j, side: o.t, ...sideFit(side, o.side) }));
  });
  if (typicalOffset === null) {
    const clean = raw.map((list) => list.reduce((x, y) => (!x || y.residual < x.residual ? y : x), null)).filter((c) => c && c.residual < 0.12);
    const offsets = clean.map((c) => c.offset).sort((x, y) => x - y);
    typicalOffset = offsets.length ? offsets[Math.floor(offsets.length / 2)] : 0;
  }
  return raw.map((list) => list
    .map((c) => ({ piece: c.piece, side: c.side, score: round(combine(c, typicalOffset)) }))
    .sort((x, y) => x.score - y.score)
    .slice(0, keep));
}

/** Middle range of side samples used for comparisons. */
export const INNER = [INNER_FROM, INNER_TO];
