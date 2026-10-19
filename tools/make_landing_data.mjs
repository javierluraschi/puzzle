// Builds public/demo/landing.json, the real pieces the landing page draws: the 54-piece demo set,
// solved by the app itself. Each piece's outline is moved to where the solver placed it (mm), then
// simplified. Needs the server running:
//   PORT=8090 DATA_DIR=/tmp/x node server/index.js &
//   node tools/make_landing_data.mjs [http://localhost:8090]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] || 'http://localhost:8090';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'demo', 'landing.json');

async function api(route, json) {
  const response = await fetch(base + '/api' + route, json === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return response.json();
}

/** Ramer–Douglas–Peucker on a closed outline, tolerance in mm. */
function simplify(points, tolerance) {
  const keep = new Uint8Array(points.length);
  const stack = [[0, Math.floor(points.length / 2)], [Math.floor(points.length / 2), points.length - 1]];
  keep[0] = keep[points.length - 1] = keep[Math.floor(points.length / 2)] = 1;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a], [bx, by] = points[b];
    const len = Math.hypot(bx - ax, by - ay) || 1e-9;
    let worst = -1, index = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - points[i][1]) - (ax - points[i][0]) * (by - ay)) / len;
      if (d > worst) [worst, index] = [d, i];
    }
    if (worst > tolerance) {
      keep[index] = 1;
      stack.push([a, index], [index, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const demo = JSON.parse(fs.readFileSync(path.join(root, 'public', 'demo', 'cats.json'), 'utf8'));
const puzzle = await api('/puzzles', { name: 'landing data' });
for (const piece of demo.pieces) {
  await api(`/puzzles/${puzzle.id}/pieces`, { label: piece.label, contour: piece.contour, sizeMm: piece.sizeMm, quality: { engine: 'demo' } });
}
await api(`/puzzles/${puzzle.id}/solve`, {});
let result;
for (;;) {
  result = await api(`/puzzles/${puzzle.id}/solution`);
  if (result.status.state === 'done' || result.status.state === 'failed') break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (result.status.state !== 'done') throw new Error('solve failed: ' + result.status.message);
const { solution } = result;
const pieces = new Map((await api(`/puzzles/${puzzle.id}`)).pieces.map((p) => [p.index, p]));
const group = solution.groups[0];

// a landscape board: turn the group a quarter if the solver laid it out portrait
const xs = group.placements.map((p) => p.x), ys = group.placements.map((p) => p.y);
const portrait = Math.max(...ys) - Math.min(...ys) > Math.max(...xs) - Math.min(...xs);
const transform = (p) => {
  const a = (p.pose.angle * Math.PI) / 180, [c, s] = [Math.cos(a), Math.sin(a)];
  return ([x, y]) => {
    const [gx, gy] = [c * x - s * y + p.pose.tx, s * x + c * y + p.pose.ty];
    return portrait ? [-gy, gx] : [gx, gy];
  };
};
const cellOf = (p) => (portrait ? [-p.y, p.x] : [p.x, p.y]);

let placed = group.placements.map((p) => {
  const piece = pieces.get(p.piece);
  const map = transform(p);
  return { piece, p, outline: piece.outline.map(map), corners: piece.corners.map(map), center: map(piece.center), cell: cellOf(p) };
});
const all = placed.flatMap((q) => q.outline);
const minX = Math.min(...all.map((v) => v[0])), minY = Math.min(...all.map((v) => v[1]));
const maxX = Math.max(...all.map((v) => v[0])), maxY = Math.max(...all.map((v) => v[1]));
const minCX = Math.min(...placed.map((q) => q.cell[0])), minCY = Math.min(...placed.map((q) => q.cell[1]));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const shift = ([x, y], round = r2) => [round(x - minX), round(y - minY)];

// the piece the illustrations follow: one with all four neighbours and a complete 4 × 3 block around
// it (the solve illustration shows that block), then its neighbours and where each ranked among the
// app's candidates for that side
const byCell = new Map(placed.map((q) => [q.cell.join(','), q]));
const has = (x, y) => byCell.has(`${x},${y}`);
const complete = (q) => {
  const [x0, y0] = q.cell;
  for (let x = x0 - 1; x <= x0 + 2; x++) for (let y = y0 - 1; y <= y0 + 1; y++) if (!has(x, y)) return false;
  return true;
};
const candidates = placed.filter(complete).sort((a, b) => a.cell[1] - b.cell[1] || a.cell[0] - b.cell[0]);
const hero = candidates.find((q) => q.piece.label === '42') || candidates[0]; // 42: two digits, a blank and three tabs
const matches = await api(`/puzzles/${puzzle.id}/pieces/${hero.piece.index}/matches`);
const neighbours = [];
for (const [dir, [dx, dy]] of [['above', [0, -1]], ['right', [1, 0]], ['below', [0, 1]], ['left', [-1, 0]]]) {
  const other = byCell.get([hero.cell[0] + dx, hero.cell[1] + dy].join(','));
  if (!other) continue;
  // the side facing that neighbour is the one where it ranks best
  const found = matches.sides.map((side) => [side.candidates.findIndex((c) => c.piece === other.piece.index), side])
    .filter(([rank]) => rank >= 0).sort((a, b) => a[0] - b[0])[0];
  if (!found) continue;
  const [rank, side] = found;
  const c = side.candidates[rank];
  neighbours.push({ dir, label: other.piece.label, rank: rank + 1, scoreMm: c.scoreMm, probability: c.probability });
}

const data = {
  source: 'jigsawlutioner-cli demo set (54 pieces), solved by this app',
  width: r2(maxX - minX),
  height: r2(maxY - minY),
  cols: Math.max(...placed.map((q) => q.cell[0])) - minCX + 1,
  rows: Math.max(...placed.map((q) => q.cell[1])) - minCY + 1,
  focus: { label: hero.piece.label, cell: [hero.cell[0] - minCX, hero.cell[1] - minCY], neighbours },
  pieces: placed.map((q) => ({
    label: q.piece.label,
    cell: [q.cell[0] - minCX, q.cell[1] - minCY],
    // sides in outline order, so directions[k] runs from corners[k] to corners[k + 1]
    directions: q.piece.directions,
    sideLengths: q.piece.sideLengths.map(r2),
    corners: q.corners.map((v) => shift(v)),
    center: shift(q.center),
    outline: simplify(q.outline, 0.08).map((v) => shift(v, r1)),
  })),
};
fs.writeFileSync(out, JSON.stringify(data));
console.log(`wrote ${out}: ${data.pieces.length} pieces, ${data.cols} × ${data.rows}, ${data.width} × ${data.height} mm, ${(fs.statSync(out).size / 1024).toFixed(0)} KB, ` +
  `${Math.round(data.pieces.reduce((n, p) => n + p.outline.length, 0) / data.pieces.length)} points per piece`);
console.log('focus', JSON.stringify(data.focus));
