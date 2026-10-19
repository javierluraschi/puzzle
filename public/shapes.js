// SVG drawings of scanned pieces from their outlines (no images are stored).
//
// A piece summary from the server carries, in millimetres: `outline`, `corners`, `center` (middle of
// the corners), `sideLengths`, plus `directions` (flat / out = tab / in = blank per side) and
// `rotations[top]` (degrees that bring side `top` up). Sides are numbered clockwise, so with side
// `top` facing up, side top+1 faces right, top+2 down and top+3 left. Zoom is in pixels per mm.

const NS = 'http://www.w3.org/2000/svg';
export const SIDE_COLORS = { flat: '#8f97a6', out: '#e89300', in: '#2f6fde', unknown: '#9b51e0' };

export function svgEl(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== null && value !== undefined) el.setAttribute(key, value);
  for (const child of children) if (child) el.append(child);
  return el;
}

export function pathData(points) {
  return 'M' + points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L') + 'Z';
}

/** Width/height (mm) of the piece body when side `top` faces up (average of opposite sides). */
export function bodySize(piece, top) {
  const L = piece.sideLengths;
  return [(L[top % 4] + L[(top + 2) % 4]) / 2, (L[(top + 1) % 4] + L[(top + 3) % 4]) / 2];
}

/** The side index that faces direction `dir` (0 up, 1 right, 2 down, 3 left) when `top` is up. */
export const sideFacing = (top, dir) => (top + dir) % 4;
/** The `top` that makes side `side` face direction `dir`. */
export const topFor = (side, dir) => (side - dir + 8) % 4;

/** SVG transform that draws the piece's outline with side `top` up, centered at (x, y) pixels. */
export function placement(piece, top, zoom, x, y) {
  const [cx, cy] = piece.center;
  return `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${piece.rotations[top % 4]}) scale(${zoom}) translate(${-cx} ${-cy})`;
}

/** The four sides as polylines along the outline (between consecutive corners). */
export function sidePolylines(piece) {
  const outline = piece.outline;
  const nearest = (p) => {
    let best = 0;
    let bestD = Infinity;
    outline.forEach((q, i) => {
      const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  };
  const idx = piece.corners.map(nearest);
  const n = outline.length;
  const walk = (from, to, step) => {
    const pts = [];
    for (let i = from; ; i = (i + step + n) % n) {
      pts.push(outline[i]);
      if (i === to || pts.length > n) break;
    }
    return pts;
  };
  return idx.map((from, k) => {
    const to = idx[(k + 1) % 4];
    const others = idx.filter((_, j) => j !== k && j !== (k + 1) % 4);
    const forward = walk(from, to, 1);
    // the side is the way around that does not pass the other two corners
    const passes = (pts) => others.some((o) => pts.some((p) => p === outline[o]));
    return passes(forward) ? walk(from, to, -1) : forward;
  });
}

/**
 * A standalone <svg> of one piece with side `top` up, sized to its body (+ margin for tabs).
 * Options: highlight (side drawn as a thick accent), sides (color sides by type), corners (dots),
 * label.
 */
export function pieceSvg(piece, { top = 0, zoom = 3, highlight = null, sides = false, corners = false, label = null, className = '' } = {}) {
  if (!piece.ok || !piece.outline) return failedSvg(piece, zoom, className);
  const [bw, bh] = bodySize(piece, top);
  const margin = 0.36;
  const w = bw * zoom * (1 + 2 * margin);
  const h = bh * zoom * (1 + 2 * margin);
  const svg = svgEl('svg', { class: 'piece-svg ' + className, width: w.toFixed(1), height: h.toFixed(1), viewBox: `0 0 ${w.toFixed(1)} ${h.toFixed(1)}` });
  const g = svgEl('g', { transform: placement(piece, top, zoom, w / 2, h / 2) });
  g.append(svgEl('path', { class: 'piece-fill', d: pathData(piece.outline), 'vector-effect': 'non-scaling-stroke' }));
  if (sides || highlight !== null) {
    sidePolylines(piece).forEach((pts, k) => {
      if (!sides && k !== highlight) return;
      const color = k === highlight ? '#d6336c' : SIDE_COLORS[piece.directions[k]] || SIDE_COLORS.unknown;
      g.append(svgEl('polyline', {
        points: pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' '),
        fill: 'none', stroke: color, 'stroke-width': k === highlight ? 5 : 3.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke',
      }));
    });
  }
  if (corners) {
    for (const [x, y] of piece.corners) g.append(svgEl('circle', { cx: x.toFixed(2), cy: y.toFixed(2), r: (4 / zoom).toFixed(3), class: 'corner-dot' }));
  }
  svg.append(g);
  if (label !== null) {
    svg.append(svgEl('text', { x: (w / 2).toFixed(1), y: (h / 2).toFixed(1), class: 'piece-label', 'font-size': Math.max(9, Math.min(22, bw * zoom * 0.28)).toFixed(1) }, document.createTextNode(label)));
  }
  return svg;
}

function failedSvg(piece, zoom, className) {
  const s = 22 * zoom * 1.4;
  const svg = svgEl('svg', { class: 'piece-svg failed ' + className, width: s.toFixed(1), height: s.toFixed(1), viewBox: `0 0 ${s.toFixed(1)} ${s.toFixed(1)}` });
  if (piece.outline) {
    const xs = piece.outline.map((p) => p[0]);
    const ys = piece.outline.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    svg.append(svgEl('path', { class: 'piece-fill', d: pathData(piece.outline), transform: `translate(${s / 2} ${s / 2}) scale(${zoom}) translate(${-cx} ${-cy})` }));
  }
  return svg;
}

/** Piece A with side `sideA` facing right, joined to piece B with side `sideB` facing left. */
export function pairSvg(a, sideA, b, sideB, zoom) {
  const topA = topFor(sideA, 1);
  const topB = topFor(sideB, 3);
  const [aw, ah] = bodySize(a, topA);
  const [bw, bh] = bodySize(b, topB);
  const margin = 0.36 * Math.max(aw, bw, ah, bh) * zoom;
  const w = (aw + bw) * zoom + margin * 2;
  const h = Math.max(ah, bh) * zoom + margin * 2;
  const svg = svgEl('svg', { class: 'piece-svg pair', width: w.toFixed(1), height: h.toFixed(1), viewBox: `0 0 ${w.toFixed(1)} ${h.toFixed(1)}` });
  svg.append(svgEl('g', { transform: placement(a, topA, zoom, margin + (aw * zoom) / 2, h / 2) }, svgEl('path', { class: 'piece-fill', d: pathData(a.outline) })));
  svg.append(svgEl('g', { transform: placement(b, topB, zoom, margin + aw * zoom + (bw * zoom) / 2, h / 2) }, svgEl('path', { class: 'piece-fill other', d: pathData(b.outline) })));
  return svg;
}
