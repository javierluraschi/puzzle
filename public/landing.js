// Illustrations for the landing page, drawn from real pieces: the 54-piece demo set as this app scanned
// and solved it (/demo/landing.json, made by tools/make_landing_data.mjs). Outlines are in millimetres,
// placed where the solver put them. The picture on the pieces is Van Gogh's The Starry Night (public
// domain), laid over the solved board: one of the hardest images to do as a jigsaw by eye.

const NS = 'http://www.w3.org/2000/svg';
const SCENE = { url: '/starry-night.jpg', width: 1000, height: 792 };

function el(tag, attrs = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== null && value !== undefined) node.setAttribute(key, value);
  for (const child of children.flat()) if (child) node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  return node;
}

function div(className, style = {}, ...children) {
  const node = document.createElement('div');
  node.className = className;
  Object.assign(node.style, style);
  node.append(...children);
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

/** Smooth closed path through the points (Catmull-Rom as cubics), mapped by `f`. */
function smoothPath(points, f = (p) => p) {
  const q = points.map(f);
  const n = q.length;
  const fmt = ([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`;
  let d = `M${fmt(q[0])}`;
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [q[(i - 1 + n) % n], q[i], q[(i + 1) % n], q[(i + 2) % n]];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${fmt(c1)} ${fmt(c2)} ${fmt(p2)}`;
  }
  return d + 'Z';
}

function bounds(points) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/** Where the picture sits on the solved board (mm): scaled to cover it, centred. */
function pictureOn(data) {
  const s = Math.max(data.width / SCENE.width, data.height / SCENE.height);
  return { x: (data.width - SCENE.width * s) / 2, y: (data.height - SCENE.height * s) / 2, w: SCENE.width * s, h: SCENE.height * s };
}

let uid = 0;
/**
 * A piece with its part of the picture and a cardboard bevel, drawn at `k` px per mm with its centre at
 * (0, 0). With `back`, the back of the piece: mirrored and plain cardboard.
 */
function pieceArt(data, piece, k, { back = false } = {}) {
  const id = `pc${uid++}`;
  const [cx, cy] = piece.center;
  const d = smoothPath(piece.outline);
  const picture = pictureOn(data);
  const px = 1 / k; // one screen pixel, in mm
  return el('g', { transform: `scale(${back ? -k : k} ${k}) translate(${-cx} ${-cy})` },
    el('clipPath', { id }, el('path', { d })),
    back
      ? el('g', {}, el('path', { d, class: 'back-edge', transform: `translate(0 ${4 * px})` }), el('path', { d, class: 'back-fill' }))
      : el('g', { 'clip-path': `url(#${id})` },
        el('image', { href: SCENE.url, x: picture.x, y: picture.y, width: picture.w, height: picture.h, preserveAspectRatio: 'none' }),
        el('path', { d, class: 'bevel-light', transform: `translate(${1.2 * px} ${1.2 * px})`, 'vector-effect': 'non-scaling-stroke' }),
        el('path', { d, class: 'bevel-dark', transform: `translate(${-1.2 * px} ${-1.2 * px})`, 'vector-effect': 'non-scaling-stroke' })),
    el('path', { d, class: 'piece-seam', 'vector-effect': 'non-scaling-stroke' }));
}

const byLabel = (data, label) => data.pieces.find((p) => p.label === label);

// Pencilled digits, one stroke path each in a 30 × 44 box.
const DIGITS = {
  0: 'M15 2C5 2 2 14 2 23C2 35 7 43 15 43C24 43 28 33 28 22C28 11 24 2 15 2Z',
  1: 'M8 10L17 2V43',
  2: 'M3 11C5 4 11 1 17 2C26 4 27 14 22 21C17 28 9 35 2 43H28',
  3: 'M3 9C7 1 23 0 25 9C27 17 17 20 12 21C20 21 29 25 27 34C25 44 7 45 1 37',
  4: 'M21 43V2L2 30H29',
  5: 'M25 3H8L5 20C9 17 14 16 18 17C26 19 28 27 27 33C25 42 12 45 3 39',
  6: 'M24 4C18 1 8 3 4 14C1 24 2 36 8 41C14 45 24 43 26 34C28 25 21 20 14 21C8 22 4 27 3 31',
  7: 'M2 3H28L12 43',
  8: 'M15 21C5 18 4 4 15 3C26 2 26 18 15 21C2 24 2 42 15 43C29 43 28 24 15 21',
  9: 'M26 15C25 6 18 2 12 3C5 4 2 11 4 17C6 23 14 25 20 21C24 18 26 14 26 15C27 28 24 40 12 43',
};
/** The label written by hand, centred on (0, 0). */
function handwriting(label) {
  const digits = [...String(label)].filter((c) => DIGITS[c]);
  const width = digits.length * 30 + (digits.length - 1) * 8;
  return el('g', { class: 'pencil-mark', transform: `translate(${-width / 2} -22) rotate(-5 ${width / 2} 22)` },
    digits.map((c, i) => el('path', { d: DIGITS[c], transform: `translate(${i * 38} ${i % 2 ? 1.5 : 0})` })));
}

const OPPOSITE = { above: 'right below', below: 'right above', left: 'just right of', right: 'just left of' };
/** The focus piece's most certain neighbour. */
const bestNeighbour = (data) => data.focus.neighbours.slice().sort((a, b) => b.probability - a.probability)[0];

// --- hero: the numbered pile assembles into the solved board ----------------------------------

// Each piece is an HTML layer clipped to its outline, so the animation only moves cached layers
// instead of repainting fifty copies of the picture every frame.
function heroArt(stage, data) {
  const rand = random(4);
  const k = 500 / data.width; // px per mm
  const W = data.width * k, H = data.height * k;
  const ox = (640 - W) / 2, oy = (480 - H) / 2;
  const picture = pictureOn(data);
  const n = data.pieces.length;
  const order = data.pieces.map((_, i) => i).sort(() => rand() - 0.5);
  const focus = data.focus.label;
  const scale = div('hero-scale');
  scale.append(div('hero-slot', { left: `${ox}px`, top: `${oy}px`, width: `${W}px`, height: `${H}px` }));
  // the focus piece arrives last
  order.splice(order.findIndex((i) => data.pieces[i].label === focus), 1);
  order.push(data.pieces.findIndex((p) => p.label === focus));

  order.forEach((i, rank) => {
    const piece = data.pieces[i];
    const last = rank === n - 1;
    const b = bounds(piece.outline);
    const pad = 3; // px, for the bevel
    const left = ox + b.x * k - pad, top = oy + b.y * k - pad;
    const w = b.w * k + 2 * pad, h = b.h * k + 2 * pad;
    const d = smoothPath(piece.outline, ([x, y]) => [x * k + ox - left, y * k + oy - top]);
    const clip = `path('${d}')`;
    const [cx, cy] = [ox + piece.center[0] * k, oy + piece.center[1] * k];
    // in the pile: around the board, a little rotated
    const angle = rand() * Math.PI * 2;
    const sx = 320 + Math.cos(angle) * (170 + rand() * 130), sy = 240 + Math.sin(angle) * (120 + rand() * 110);
    const delay = rank * 0.045 + (last ? 1.1 : 0);
    const bevel = el('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, class: 'hp-bevel' },
      el('path', { d, class: 'bevel-light', transform: 'translate(1.1 1.1)' }),
      el('path', { d, class: 'bevel-dark', transform: 'translate(-1.1 -1.1)' }),
      el('path', { d, class: 'piece-seam' }));
    const tag = document.createElement('span');
    tag.className = 'hp-tag';
    tag.textContent = piece.label;
    tag.style.left = `${cx - left}px`;
    tag.style.top = `${cy - top}px`;
    tag.style.setProperty('--tr', `${Math.round((rand() - 0.5) * 30)}deg`);
    const node = div(last ? 'hp hp-last' : 'hp', { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px`, transformOrigin: `${cx - left}px ${cy - top}px` },
      div('hp-lift', {}, div('hp-lift-shape', { clipPath: clip })),
      div('hp-face', {
        clipPath: clip,
        backgroundImage: `url(${SCENE.url})`,
        backgroundSize: `${picture.w * k}px ${picture.h * k}px`,
        backgroundPosition: `${ox + picture.x * k - left}px ${oy + picture.y * k - top}px`,
        backgroundRepeat: 'no-repeat',
      }, bevel),
      tag);
    node.style.setProperty('--dx', `${Math.round(sx - cx)}px`);
    node.style.setProperty('--dy', `${Math.round(sy - cy)}px`);
    node.style.setProperty('--r', `${Math.round((rand() - 0.5) * 120)}deg`);
    node.style.setProperty('--d', `${delay.toFixed(2)}s`);
    scale.append(node);
    if (last) {
      const ring = div('hero-ring', { left: `${cx}px`, top: `${cy}px` });
      ring.style.setProperty('--d', `${delay.toFixed(2)}s`);
      scale.append(ring);
    }
  });
  stage.append(scale);
  const fit = () => scale.style.setProperty('--s', stage.clientWidth / 640);
  new ResizeObserver(fit).observe(stage);
  fit();
}

// --- step 1: the printed sheet of scan cards --------------------------------------------------

function scanCard(x, y, size, dark) {
  const u = size / 70; // the card is 70 mm: 6 mm black ring, 2 mm white gap
  return el('g', { transform: `translate(${x} ${y})` },
    el('rect', { x: -6, y: -6, width: size + 12, height: size + 12, class: 'cut-line' }),
    el('rect', { width: size, height: size, fill: '#111' }),
    el('rect', { x: 6 * u, y: 6 * u, width: size - 12 * u, height: size - 12 * u, fill: '#fff' }),
    el('rect', { x: 8 * u, y: 8 * u, width: size - 16 * u, height: size - 16 * u, fill: dark ? '#3b3f47' : '#fff' }));
}

function printArt(svg, data) {
  const size = 104;
  const u = size / 70; // px per mm: the cards are drawn to scale, and so are the pieces on them
  svg.append(
    el('defs', {},
      el('filter', { id: 'paper-shadow', x: '-20%', y: '-20%', width: '140%', height: '140%' },
        el('feDropShadow', { dx: 0, dy: 6, stdDeviation: 7, 'flood-color': '#5a4a2a', 'flood-opacity': 0.18 })),
      el('clipPath', { id: 'print-view' }, el('rect', { width: 320, height: 310 }))),
    el('g', { 'clip-path': 'url(#print-view)' },
      el('g', { transform: 'rotate(-3 160 160)' },
        el('rect', { x: 26, y: 16, width: 290, height: 410, rx: 3, fill: '#fff', filter: 'url(#paper-shadow)' }),
        el('text', { x: 48, y: 46, class: 'sheet-title' }, 'Scan card'),
        el('text', { x: 48, y: 60, class: 'sheet-text' }, 'Print at 100% / actual size. Print check: this line is 50 mm'),
        el('path', { d: `M48 72H${48 + 50 * u}M48 67V77M${48 + 50 * u} 67V77`, class: 'check-line' }),
        scanCard(54, 100, size, true), scanCard(182, 100, size, true),
        scanCard(54, 228, size, false), scanCard(182, 228, size, false),
        el('text', { x: 36, y: 97, class: 'scissors' }, '✂'),
        el('g', { transform: `translate(${54 + size / 2} ${100 + size / 2}) rotate(-8)` }, pieceArt(data, byLabel(data, '12'), u)),
        el('g', { transform: `translate(${182 + size / 2} ${228 + size / 2}) rotate(14)` }, pieceArt(data, byLabel(data, '31'), u)))));
}

// --- step 2: a phone over the scan card, tracing the piece -----------------------------------

function scanArt(svg, data) {
  // the card, seen in slight perspective: bilinear map from the unit square onto a quad
  const quad = [[90, 150], [230, 144], [238, 290], [84, 296]];
  const at = (u, v) => [0, 1].map((k) => (1 - u) * (1 - v) * quad[0][k] + u * (1 - v) * quad[1][k] + u * v * quad[2][k] + (1 - u) * v * quad[3][k]);
  const poly = (a, b) => [at(a, a), at(b, a), at(b, b), at(a, b)].map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ');
  const bracket = (u, v, du, dv) => {
    const p = at(u, v), p1 = at(u + du * 0.18, v), p2 = at(u, v + dv * 0.18);
    return el('path', { d: `M${p1.join(' ')}L${p.join(' ')}L${p2.join(' ')}`, class: 'scan-bracket' });
  };
  const piece = byLabel(data, data.focus.label);
  const k = 145 / 70; // the card spans ~145 px for 70 mm
  const [cx, cy] = piece.center;
  const trace = smoothPath(piece.outline, ([x, y]) => [(x - cx) * k, (y - cy) * k]);
  const grain = Array.from({ length: 9 }, (_, i) => el('path', { d: `M60 ${40 + i * 44}C120 ${30 + i * 44} 200 ${52 + i * 44} 260 ${38 + i * 44}`, class: 'table-grain' }));
  svg.append(
    el('defs', {},
      el('linearGradient', { id: 'table', x1: 0, y1: 0, x2: 1, y2: 1 }, el('stop', { offset: 0, 'stop-color': '#d8ccb6' }), el('stop', { offset: 1, 'stop-color': '#bfae93' })),
      el('clipPath', { id: 'screen' }, el('rect', { x: 60, y: 20, width: 200, height: 400, rx: 31 }))),
    el('rect', { x: 46, y: 118, width: 6, height: 36, rx: 2, class: 'phone-button' }),
    el('rect', { x: 268, y: 150, width: 6, height: 60, rx: 2, class: 'phone-button' }),
    el('rect', { x: 50, y: 10, width: 220, height: 420, rx: 40, class: 'phone' }),
    el('g', { 'clip-path': 'url(#screen)' },
      el('rect', { x: 60, y: 20, width: 200, height: 400, fill: 'url(#table)' }),
      ...grain,
      el('polygon', { points: poly(0, 1), fill: '#111' }),
      el('polygon', { points: poly(6 / 70, 64 / 70), fill: '#fff' }),
      el('polygon', { points: poly(8 / 70, 62 / 70), fill: '#3b3f47' }),
      el('polygon', { points: poly(0, 1), class: 'scan-frame' }),
      bracket(0, 0, 1, 1), bracket(1, 0, -1, 1), bracket(1, 1, -1, -1), bracket(0, 1, 1, -1),
      el('g', { transform: 'translate(160 220) rotate(-6)' },
        pieceArt(data, piece, k),
        el('path', { d: trace, class: 'scan-trace', pathLength: 1 })),
      el('rect', { x: 128, y: 30, width: 64, height: 19, rx: 9.5, fill: '#0b0b0d' }),
      el('rect', { x: 72, y: 62, width: 86, height: 26, rx: 13, class: 'phone-pill' }),
      el('text', { x: 115, y: 79.5, class: 'phone-text' }, 'Piece ', el('tspan', { 'font-weight': 800 }, piece.label)),
      el('circle', { cx: 236, cy: 75, r: 13, class: 'phone-pill' }),
      el('path', { d: 'M231 70l10 10M241 70l-10 10', class: 'phone-x' }),
      el('circle', { cx: 230, cy: 120, r: 17, class: 'level' }),
      el('circle', { cx: 230, cy: 120, r: 5, class: 'level-target' }),
      el('circle', { cx: 231, cy: 119, r: 3.4, class: 'level-dot' }),
      el('rect', { x: 112, y: 318, width: 96, height: 26, rx: 13, class: 'phone-pill' }),
      el('text', { x: 160, y: 335.5, class: 'phone-text' }, 'Hold still…'),
      el('circle', { cx: 104, cy: 382, r: 16, class: 'phone-pill' }),
      el('path', { d: 'M106 372l-8 12h7l-3 9 9-13h-7z', fill: '#ffd25e' }),
      el('circle', { cx: 216, cy: 382, r: 16, class: 'phone-pill' }),
      el('rect', { x: 207, y: 375, width: 18, height: 14, rx: 2.5, class: 'phone-icon' }),
      el('path', { d: 'M209 387l5-6 4 4 2-2 4 4', class: 'phone-icon' }),
      el('circle', { cx: 160, cy: 382, r: 24, class: 'shutter' }),
      el('circle', { cx: 160, cy: 382, r: 24, class: 'shutter-ring', pathLength: 1 })),
    el('rect', { x: 50, y: 10, width: 220, height: 420, rx: 40, class: 'phone-rim' }));
}

// --- step 3: the back of the piece with its number pencilled on -------------------------------

function labelArt(svg, data) {
  const piece = byLabel(data, data.focus.label);
  const k = 6.4;
  const rand = random(9);
  const speckles = Array.from({ length: 220 }, () => el('circle', { cx: (rand() * 150 - 75).toFixed(1), cy: (rand() * 150 - 75).toFixed(1), r: (0.4 + rand() * 0.8).toFixed(1), fill: rand() < 0.5 ? '#a8977a' : '#e4d7bd', opacity: 0.7 }));
  const [cx, cy] = piece.center;
  const back = smoothPath(piece.outline, ([x, y]) => [-(x - cx) * k, (y - cy) * k]);
  svg.append(
    el('defs', {}, el('clipPath', { id: 'back-clip' }, el('path', { d: back }))),
    el('g', { transform: 'translate(150 128) rotate(-7)' },
      el('path', { d: back, class: 'back-edge', transform: 'translate(0 5)' }),
      el('path', { d: back, class: 'back-fill' }),
      el('g', { 'clip-path': 'url(#back-clip)' }, ...speckles),
      handwriting(piece.label)),
    el('g', { transform: 'translate(236 222) rotate(-38)' },
      el('path', { d: 'M0 0L-20 7L0 14Z', fill: '#f1d2a0' }),
      el('path', { d: 'M-13.5 4.7L-20 7L-13.5 9.3Z', fill: '#3b3b40' }),
      el('rect', { width: 88, height: 14, fill: '#f5b52e' }),
      el('rect', { y: 4.6, width: 88, height: 4.8, fill: '#e09a14' }),
      el('rect', { x: 88, width: 12, height: 14, fill: '#c9cfd8' }),
      el('path', { d: 'M91 0V14M95 0V14', stroke: '#9aa2ad', 'stroke-width': 1 }),
      el('rect', { x: 100, width: 10, height: 14, rx: 3, fill: '#f08a8a' })),
    el('g', { transform: 'translate(18 232)' },
      el('rect', { width: 150, height: 40, rx: 12, class: 'chip' }),
      el('circle', { cx: 22, cy: 20, r: 10, class: 'chip-check' }),
      el('path', { d: 'M17 20.5l3.5 3.5 6.5-7', stroke: '#fff', 'stroke-width': 2.4, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
      el('text', { x: 40, y: 25, class: 'chip-text' }, `Piece ${piece.label} saved`)));
}

// --- step 4: the app's solution map around the piece, which drops into its place --------------

function solveArt(svg, data) {
  const focus = byLabel(data, data.focus.label);
  const [fx, fy] = focus.cell;
  const block = data.pieces.filter((p) => p.cell[0] >= fx - 1 && p.cell[0] <= fx + 2 && p.cell[1] >= fy - 1 && p.cell[1] <= fy + 1);
  const b = bounds(block.flatMap((p) => p.outline));
  const k = Math.min(270 / b.w, 160 / b.h);
  const tx = (340 - b.w * k) / 2 - b.x * k, ty = 96 - b.y * k;
  const map = ([x, y]) => [x * k + tx, y * k + ty];
  const board = el('g', {});
  for (const piece of block) {
    const d = smoothPath(piece.outline, map);
    const [x, y] = map(piece.center);
    const label = el('text', { x, y, class: 'piece-label', 'font-size': 12 }, piece.label);
    if (piece === focus) {
      board.append(el('path', { d, class: 'solve-slot' }));
      board.append(el('g', { class: 'solve-drop' }, el('path', { d, class: 'piece-fill other' }), label));
    } else {
      board.append(el('g', {}, el('path', { d, class: 'piece-fill' }), label));
    }
  }
  const best = bestNeighbour(data);
  const tab = (x, w, text, active) => el('g', {},
    el('rect', { x, y: 34, width: w, height: 24, rx: 12, class: active ? 'ui-tab active' : 'ui-tab' }),
    el('text', { x: x + w / 2, y: 50, class: active ? 'ui-tab-text active' : 'ui-tab-text' }, text));
  svg.append(
    el('rect', { x: 14, y: 14, width: 312, height: 282, rx: 18, class: 'ui-window' }),
    tab(30, 62, '1 · Scan', false), tab(98, 86, '2 · Catalog', false), tab(190, 66, '3 · Solve', true),
    el('text', { x: 32, y: 84, class: 'ui-title' }, `Group 1 · ${data.pieces.length} pieces`),
    board,
    el('rect', { x: 32, y: 264, width: 228, height: 22, rx: 11, class: 'ui-match' }),
    el('text', { x: 146, y: 279, class: 'ui-match-text' }, `${focus.label} ↔ ${best.label} · best fit · ${Math.round(best.probability * 100)}% sure`));
}

// --- under the hood: one real edge piece, its corners found and its sides named ---------------

function sidesArt(svg, data) {
  const piece = byLabel(data, '16');
  const k = 6.3;
  const [cx, cy] = piece.center;
  const map = ([x, y]) => [150 + (x - cx) * k, 130 + (y - cy) * k];
  const outline = piece.outline;
  const nearest = ([x, y]) => outline.reduce((best, p, i) => (Math.hypot(p[0] - x, p[1] - y) < Math.hypot(outline[best][0] - x, outline[best][1] - y) ? i : best), 0);
  const at = piece.corners.map(nearest);
  const names = { flat: 'flat edge', out: 'tab', in: 'blank' };
  const parts = [];
  for (let s = 0; s < 4; s++) {
    const pts = [];
    for (let i = at[s]; ; i = (i + 1) % outline.length) {
      pts.push(map(outline[i]));
      if (i === at[(s + 1) % 4]) break;
    }
    const type = piece.directions[s];
    parts.push(el('polyline', { points: pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' '), class: `side-stroke side-${type}` }));
    // the name, just beyond the outermost point of the side
    const [a0, a1] = [map(piece.corners[s]), map(piece.corners[(s + 1) % 4])];
    const mid = [(a0[0] + a1[0]) / 2, (a0[1] + a1[1]) / 2];
    let n = [mid[0] - 150, mid[1] - 130];
    const len = Math.hypot(...n) || 1;
    n = [n[0] / len, n[1] / len];
    const reach = Math.max(0, ...pts.map(([x, y]) => (x - mid[0]) * n[0] + (y - mid[1]) * n[1]));
    const [lx, ly] = [mid[0] + n[0] * (reach + 16), mid[1] + n[1] * (reach + 16) + 4];
    const text = type === 'flat' ? `${names[type]} · ${piece.sideLengths[s].toFixed(1)} mm` : names[type];
    const anchor = Math.abs(n[0]) > Math.abs(n[1]) ? (n[0] > 0 ? 'start' : 'end') : 'middle';
    parts.push(el('text', { x: lx.toFixed(1), y: ly.toFixed(1), class: 'note', 'text-anchor': anchor }, text));
  }
  svg.append(
    el('path', { d: smoothPath(outline, map), class: 'hood-piece' }),
    ...parts,
    ...piece.corners.map((c) => { const [x, y] = map(c); return el('circle', { cx: x, cy: y, r: 4.5, class: 'corner-dot' }); }));
}

const arts = { hero: heroArt, print: printArt, scan: scanArt, label: labelArt, solve: solveArt, sides: sidesArt };
fetch('/demo/landing.json').then((r) => r.json()).then((data) => {
  for (const node of document.querySelectorAll('[data-art]')) arts[node.dataset.art]?.(node, data);
  // the copy follows the same piece as the pictures
  const best = bestNeighbour(data);
  for (const node of document.querySelectorAll('[data-focus]')) node.textContent = data.focus.label;
  for (const node of document.querySelectorAll('[data-focus-sentence]')) node.textContent = `${data.focus.label} goes ${OPPOSITE[best.dir]} ${best.label}`;
});
