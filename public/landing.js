// Illustrations for the landing page. The pieces come from a seeded random cut, so every edge of a
// piece is the mirror of its neighbour's and the drawings stay the same on every visit.

const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== null && value !== undefined) node.setAttribute(key, value);
  for (const child of children) if (child) node.append(child);
  return node;
}

function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A rows × cols cut. h[r][c] is the edge above row r, v[r][c] the edge left of column c; border edges
 * are null (flat). `sign` +1 bulges up (horizontal) or right (vertical).
 */
function makeCut(rows, cols, rand) {
  const edge = () => ({ sign: rand() < 0.5 ? 1 : -1, shift: (rand() - 0.5) * 0.12, size: 0.88 + rand() * 0.22 });
  const h = Array.from({ length: rows + 1 }, (_, r) => Array.from({ length: cols }, () => (r === 0 || r === rows ? null : edge())));
  const v = Array.from({ length: rows }, () => Array.from({ length: cols + 1 }, (_, c) => (c === 0 || c === cols ? null : edge())));
  return { rows, cols, h, v };
}

/** The edge as cubic segments in (t along, s outwards), both as fractions of the edge length. */
function profile(e) {
  if (!e) return [[[0, 0], [0, 0], [1, 0], [1, 0]]];
  const c = 0.5 + e.shift;
  const k = e.size;
  const P = (dt, s) => [c + dt * k, s * k * e.sign];
  return [
    [[0, 0], [0, 0], P(-0.14, 0), P(-0.14, 0)],
    [P(-0.14, 0), P(-0.06, 0), P(-0.04, 0.03), P(-0.065, 0.08)],
    [P(-0.065, 0.08), P(-0.1, 0.13), P(-0.14, 0.26), P(0, 0.26)],
    [P(0, 0.26), P(0.14, 0.26), P(0.1, 0.13), P(0.065, 0.08)],
    [P(0.065, 0.08), P(0.04, 0.03), P(0.06, 0), P(0.14, 0)],
    [P(0.14, 0), P(0.14, 0), [1, 0], [1, 0]],
  ];
}

const reverse = (segs) => segs.slice().reverse().map(([a, b, c, d]) => [d, c, b, a]);

/** The four sides of piece (r, c), clockwise from the top, with their type and cubic segments. */
function pieceSides(cut, r, c, size) {
  const horizontal = (e, row, col) => profile(e).map((seg) => seg.map(([t, s]) => [(col + t) * size, row * size - s * size]));
  const vertical = (e, row, col) => profile(e).map((seg) => seg.map(([t, s]) => [col * size + s * size, (row + t) * size]));
  const type = (e, outwardSign) => (!e ? 'flat' : e.sign === outwardSign ? 'out' : 'in');
  const top = cut.h[r][c], right = cut.v[r][c + 1], bottom = cut.h[r + 1][c], left = cut.v[r][c];
  return [
    { type: type(top, 1), segs: horizontal(top, r, c) },
    { type: type(right, 1), segs: vertical(right, r, c + 1) },
    { type: type(bottom, -1), segs: reverse(horizontal(bottom, r + 1, c)) },
    { type: type(left, -1), segs: reverse(vertical(left, r, c)) },
  ];
}

const pt = ([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`;
const segsPath = (segs) => segs.map(([, b, c, d]) => `C${pt(b)} ${pt(c)} ${pt(d)}`).join('');
const piecePath = (sides) => `M${pt(sides[0].segs[0][0])}${sides.map((side) => segsPath(side.segs)).join('')}Z`;
const sidePath = (side) => `M${pt(side.segs[0][0])}${segsPath(side.segs)}`;

function shuffled(n, rand) {
  const list = Array.from({ length: n }, (_, i) => i + 1);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// --- hero: numbered pieces drift in from a pile and assemble a sunset ------------------------

function heroArt(svg) {
  const rand = random(11);
  const rows = 4, cols = 5, size = 84;
  const cut = makeCut(rows, cols, rand);
  const W = cols * size, H = rows * size;
  const ox = (640 - W) / 2, oy = (480 - H) / 2;
  const labels = shuffled(rows * cols, rand).map((n) => n * 3 + Math.floor(rand() * 3));

  const defs = el('defs', {},
    el('linearGradient', { id: 'hero-sky', x1: 0, y1: 0, x2: 0, y2: 1 },
      el('stop', { offset: 0, 'stop-color': '#151d40' }),
      el('stop', { offset: 0.42, 'stop-color': '#4b2f6e' }),
      el('stop', { offset: 0.68, 'stop-color': '#e2604a' }),
      el('stop', { offset: 0.84, 'stop-color': '#ffb020' })),
    el('radialGradient', { id: 'hero-sun' },
      el('stop', { offset: 0, 'stop-color': '#fff1c4' }),
      el('stop', { offset: 0.55, 'stop-color': '#ffd36b' }),
      el('stop', { offset: 1, 'stop-color': '#ffb020' })));
  const stars = Array.from({ length: 26 }, () => el('circle', { cx: (rand() * 380).toFixed(1), cy: (rand() * 115).toFixed(1), r: (0.6 + rand() * 1.2).toFixed(1), fill: '#fff', opacity: (0.35 + rand() * 0.5).toFixed(2) }));
  const scene = el('g', { id: 'hero-scene', transform: `scale(${W / 380} ${H / 304})` }, // drawn on a 380 × 304 canvas
    el('rect', { width: 380, height: 304, fill: 'url(#hero-sky)' }),
    ...stars,
    el('circle', { cx: 236, cy: 202, r: 50, fill: 'url(#hero-sun)' }),
    el('path', { d: 'M0 232L58 176L104 210L170 138L236 214L292 166L380 222V304H0Z', fill: '#3b2758' }),
    el('path', { d: 'M0 252L48 224L118 258L190 220L262 254L330 228L380 246V304H0Z', fill: '#21183a' }),
    el('rect', { y: 266, width: 380, height: 38, fill: '#131833' }),
    ...[[196, 274, 80], [208, 284, 56], [220, 294, 32]].map(([x, y, w]) => el('rect', { x, y, width: w, height: 3, rx: 1.5, fill: '#ffb020', opacity: 0.55 })));
  defs.append(scene);
  svg.append(defs);

  const board = el('g', { transform: `translate(${ox} ${oy})` });
  board.append(el('rect', { x: -6, y: -6, width: W + 12, height: H + 12, rx: 10, class: 'hero-slot' }));
  const order = shuffled(rows * cols, rand);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const d = piecePath(pieceSides(cut, r, c, size));
      const cx = (c + 0.5) * size, cy = (r + 0.5) * size;
      // scattered around the board, in the pile
      const angle = rand() * Math.PI * 2;
      const sx = 320 + Math.cos(angle) * (180 + rand() * 120) - ox, sy = 240 + Math.sin(angle) * (120 + rand() * 90) - oy;
      const last = order[i] === rows * cols;
      const style = `--dx:${(sx - cx).toFixed(0)}px;--dy:${(sy - cy).toFixed(0)}px;--r:${((rand() - 0.5) * 80).toFixed(0)}deg;--d:${((order[i] - 1) * 0.11).toFixed(2)}s;transform-origin:${cx}px ${cy}px`;
      board.append(el('g', { class: last ? 'hp hp-last' : 'hp', style },
        el('clipPath', { id: `hp${i}` }, el('path', { d })),
        el('use', { href: '#hero-scene', 'clip-path': `url(#hp${i})` }),
        el('path', { d, class: 'hp-edge' }),
        el('text', { x: cx, y: cy, class: 'hp-label' }, document.createTextNode(String(labels[i])))));
    }
  }
  svg.append(board);
}

// --- step 2: a phone over the scan card, tracing the piece -----------------------------------

function middlePiece(seed, size, tabs = null) {
  const cut = makeCut(3, 3, random(seed));
  // tabs: [top, right, bottom, left], true for a tab
  if (tabs) [cut.h[1][1].sign, cut.v[1][2].sign, cut.h[2][1].sign, cut.v[1][1].sign] = tabs.map((tab, i) => (tab === (i < 2) ? 1 : -1));
  const sides = pieceSides(cut, 1, 1, size);
  return { d: piecePath(sides), sides, offset: -1.5 * size };
}

function scanArt(svg) {
  const piece = middlePiece(5, 62, [true, false, true, false]);
  const g = svg.querySelector('#scan-piece');
  g.setAttribute('transform', `translate(${150 + piece.offset} ${212 + piece.offset})`);
  g.append(
    el('path', { d: piece.d, class: 'scan-piece-fill' }),
    el('path', { d: piece.d, class: 'scan-trace', pathLength: 1 }));
}

// --- step 3: the back of a piece with its number pencilled on ---------------------------------

function labelArt(svg) {
  const piece = middlePiece(23, 92, [true, true, false, true]);
  const g = svg.querySelector('#label-piece');
  g.setAttribute('transform', `translate(${140 + piece.offset} ${136 + piece.offset}) rotate(-8 138 138)`);
  g.prepend(el('path', { d: piece.d, class: 'back-fill' }));
}

// --- step 4: the solver's map of numbered outlines, one piece about to drop in ----------------

function solveArt(svg) {
  const rand = random(3);
  const rows = 3, cols = 4, size = 64;
  const cut = makeCut(rows, cols, rand);
  const labels = shuffled(60, rand).slice(0, rows * cols);
  const board = el('g', { transform: `translate(${(320 - cols * size) / 2} 46)` });
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const d = piecePath(pieceSides(cut, r, c, size));
      const x = (c + 0.5) * size, y = (r + 0.5) * size;
      const label = el('text', { x, y, class: 'piece-label', 'font-size': 15 }, document.createTextNode(String(labels[r * cols + c])));
      if (r === 1 && c === 2) {
        board.append(el('path', { d, class: 'solve-slot' }));
        board.append(el('g', { class: 'solve-drop' }, el('path', { d, class: 'piece-fill other' }), label));
      } else {
        board.append(el('g', {}, el('path', { d, class: 'piece-fill' }), label));
      }
    }
  }
  svg.append(board);
}

// --- under the hood: one piece with its sides coloured by type --------------------------------

function sidesArt(svg) {
  const cut = makeCut(3, 3, random(8));
  cut.v[0][1].sign = 1; // left: blank
  cut.v[0][2].sign = 1; // right: tab
  cut.h[1][1].sign = -1; // bottom: tab
  const size = 100;
  const sides = pieceSides(cut, 0, 1, size);
  const g = el('g', { transform: `translate(${110 - 1.5 * size} 46)` },
    el('path', { d: piecePath(sides), class: 'piece-fill' }),
    ...sides.map((side) => el('path', { d: sidePath(side), class: `side-stroke side-${side.type}` })));
  svg.append(g);
}

const arts = { hero: heroArt, scan: scanArt, label: labelArt, solve: solveArt, sides: sidesArt };
for (const svg of document.querySelectorAll('svg[data-art]')) arts[svg.dataset.art]?.(svg);
