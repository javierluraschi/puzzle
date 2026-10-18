// Assembles pieces into groups on a grid from geometric side matches.
//
// Every group is a grid of pieces, each with a rotation r: side k of a piece faces direction
// (k + r) % 4 with directions 0 up, 1 right, 2 down, 3 left (sides are clockwise). Candidate links
// are taken strongest first; a link merges two groups only if the merged layout is consistent:
// no two pieces in one cell, no flat edge facing a neighbour, and every pair of pieces that ends up
// side by side actually fits (not just the pair the link was about). This is what keeps a piece
// that fits one neighbour from being forced next to another it does not fit.

import { pairScore, confidence } from './match.js';

const D = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/** thresholds in mm for a typical piece (sqrt(area) ≈ 15 mm), scaled to the puzzle's pieces */
const STRICT = Number(globalThis.process?.env?.SOLVE_STRICT ?? 0.12);
const LOOSE = Number(globalThis.process?.env?.SOLVE_LOOSE ?? 0.16);
const NEIGHBOUR = Number(globalThis.process?.env?.SOLVE_NEIGHBOUR ?? 0.2);
const HALF_CONFIDENCE = 0.12;

const facing = (r, d) => (d - r + 8) % 4;
const rotate = ([x, y], q) => {
  for (let i = 0; i < q; i++) [x, y] = [-y, x];
  return [x, y];
};

/**
 * @param pieces Map(index -> analysis)
 * @param candidates { table: Map("index_side" -> [{ piece, side, score }]), typicalOffset } from candidateTable
 */
export function solve(pieces, { table, typicalOffset = 0 }, { onProgress = () => {} } = {}) {
  const ok = [...pieces].filter(([, p]) => p.ok);
  const sizes = ok.map(([, p]) => p.sizeMm).sort((a, b) => a - b);
  const k = sizes.length ? sizes[Math.floor(sizes.length / 2)] / 15 : 1;
  const strict = STRICT * k;
  const loose = LOOSE * k;
  const neighbour = NEIGHBOUR * k;

  // exact pair scores, symmetric, cached
  const cache = new Map();
  const score = (i, s, j, t) => {
    const key = i < j || (i === j && s < t) ? `${i}_${s}|${j}_${t}` : `${j}_${t}|${i}_${s}`;
    if (!cache.has(key)) cache.set(key, pairScore(pieces, i, s, j, t, typicalOffset));
    return cache.get(key);
  };

  // candidate links, each once, ordered by score and by how clearly they beat the alternatives
  const links = new Map();
  const second = (key) => table.get(key)?.[1]?.score ?? Infinity;
  for (const [key, cands] of table) {
    const [i, s] = key.split('_').map(Number);
    for (const c of cands) {
      if (c.score > loose * 1.5) break;
      const id = i < c.piece ? `${i}_${s}|${c.piece}_${c.side}` : `${c.piece}_${c.side}|${i}_${s}`;
      if (links.has(id)) continue;
      const exact = score(i, s, c.piece, c.side);
      if (exact > loose) continue;
      const rankA = cands.indexOf(c);
      const rankB = (table.get(`${c.piece}_${c.side}`) || []).findIndex((x) => x.piece === i && x.side === s);
      const margin = Math.min(second(key), second(`${c.piece}_${c.side}`)) / Math.max(exact, 1e-3);
      const mutual = rankA === 0 && rankB === 0;
      links.set(id, { i, s, j: c.piece, t: c.side, score: exact, key: exact * (mutual ? 0.7 : 1) / Math.min(2, Math.max(1, margin)) });
    }
  }
  const ordered = [...links.values()].sort((a, b) => a.key - b.key);

  // groups
  const groupOf = new Map();
  const groups = new Map();
  let nextGroup = 0;
  const single = (m) => {
    const id = nextGroup++;
    groups.set(id, { cells: new Map([['0,0', m]]), pos: new Map([[m, { x: 0, y: 0, r: 0 }]]) });
    groupOf.set(m, id);
  };
  for (const [index] of ok) single(index);

  const contactScore = (m, pm, dir, other, po) => {
    const sm = facing(pm.r, dir);
    const so = facing(po.r, (dir + 2) % 4);
    if (pieces.get(m).sides[sm].type === 'flat' || pieces.get(other).sides[so].type === 'flat') return Infinity;
    return score(m, sm, other, so);
  };

  /** How firmly a piece sits in its group: its good contacts with neighbours there. */
  const support = (g, m) => {
    const p = g.pos.get(m);
    let n = 0;
    for (let dir = 0; dir < 4; dir++) {
      const other = g.cells.get(`${p.x + D[dir][0]},${p.y + D[dir][1]}`);
      if (other !== undefined && contactScore(m, p, dir, other, g.pos.get(other)) <= neighbour) n++;
    }
    return n;
  };

  /** Takes a piece out of its group (it becomes a group of its own and may re-attach later). */
  const evict = (m) => {
    const g = groups.get(groupOf.get(m));
    const p = g.pos.get(m);
    g.pos.delete(m);
    g.cells.delete(`${p.x},${p.y}`);
    single(m);
    evictions++;
  };
  let evictions = 0;

  /**
   * Merges the groups of a link if the combined layout is consistent. When the two groups agree
   * along many good contacts but conflict in a few places (a piece placed earlier in a spot that
   * belongs to another), the weaker of each conflicting pair is evicted – a local backtrack.
   */
  const tryMerge = (link, limit) => {
    const { i, s, j, t } = link;
    if (link.score > limit) return false;
    if (groupOf.get(i) === groupOf.get(j)) return false;
    // keep the bigger group in place
    let [a, sa, b, sb] = [i, s, j, t];
    if (groups.get(groupOf.get(j)).pos.size > groups.get(groupOf.get(i)).pos.size) [a, sa, b, sb] = [j, t, i, s];
    const idI = groupOf.get(a);
    const idJ = groupOf.get(b);
    const gi = groups.get(idI);
    const gj = groups.get(idJ);
    const pa = gi.pos.get(a);
    const d = (sa + pa.r) % 4;
    const target = [pa.x + D[d][0], pa.y + D[d][1]];
    const pb = gj.pos.get(b);
    const delta = ((d + 2 - sb - pb.r) % 4 + 8) % 4;
    const moved = new Map();
    for (const [m, p] of gj.pos) {
      const [ox, oy] = rotate([p.x - pb.x, p.y - pb.y], delta);
      moved.set(m, { x: target[0] + ox, y: target[1] + oy, r: (p.r + delta) % 4 });
    }
    // contacts and conflicts of the combined layout
    let good = 0;
    const conflicts = [];
    for (const [m, p] of moved) {
      const there = gi.cells.get(`${p.x},${p.y}`);
      if (there !== undefined) {
        conflicts.push([m, there]);
        continue;
      }
      for (let dir = 0; dir < 4; dir++) {
        const other = gi.cells.get(`${p.x + D[dir][0]},${p.y + D[dir][1]}`);
        if (other === undefined) continue;
        if (contactScore(m, p, dir, other, gi.pos.get(other)) <= neighbour) good++;
        else conflicts.push([m, other]);
      }
    }
    if (conflicts.length) {
      // only a clear majority of good contacts justifies undoing earlier placements
      const losers = new Set();
      for (const [m, other] of conflicts) losers.add(support(gj, m) >= support(gi, other) ? `i${other}` : `j${m}`);
      if (good < 3 || good < 3 * losers.size || losers.has(`i${a}`) || losers.has(`j${b}`)) return false;
      for (const l of losers) {
        const m = Number(l.slice(1));
        if (l[0] === 'j') moved.delete(m);
        evict(m);
      }
      // the evictions may have left other conflicts: check again without evicting more
      for (const [m, p] of moved) {
        if (gi.cells.has(`${p.x},${p.y}`)) return false;
        for (let dir = 0; dir < 4; dir++) {
          const other = gi.cells.get(`${p.x + D[dir][0]},${p.y + D[dir][1]}`);
          if (other !== undefined && contactScore(m, p, dir, other, gi.pos.get(other)) > neighbour) return false;
        }
      }
    }
    for (const [m, p] of moved) {
      gi.pos.set(m, p);
      gi.cells.set(`${p.x},${p.y}`, m);
      groupOf.set(m, idI);
    }
    // everything of the other group was moved over or evicted
    groups.delete(idJ);
    return true;
  };

  let merged = 0;
  for (const limit of [strict, loose]) {
    for (const link of ordered) if (tryMerge(link, limit)) merged++;
    onProgress({ groups: groups.size, merged });
  }
  // evicted pieces and remaining groups get further chances until nothing changes
  for (let round = 0; round < 4; round++) {
    const before = merged;
    for (const link of ordered) if (tryMerge(link, loose)) merged++;
    onProgress({ groups: groups.size, merged });
    if (merged === before) break;
  }
  // groups emptied by evictions
  for (const [gid, g] of groups) if (!g.pos.size) groups.delete(gid);

  // output: placements with the side facing up and the fit quality towards each direction
  const out = [...groups.values()].map((g) => {
    const xs = [...g.pos.values()].map((p) => p.x);
    const ys = [...g.pos.values()].map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
      placements: [...g.pos].map(([index, p]) => ({
        piece: index,
        x: p.x - minX,
        y: p.y - minY,
        top: facing(p.r, 0),
        // fit with the neighbour in direction 0 up, 1 right, 2 down, 3 left (null: none)
        links: [0, 1, 2, 3].map((dir) => {
          const other = g.cells.get(`${p.x + D[dir][0]},${p.y + D[dir][1]}`);
          if (other === undefined) return null;
          return confidence(score(index, facing(p.r, dir), other, facing(g.pos.get(other).r, (dir + 2) % 4)), HALF_CONFIDENCE * k);
        }),
      })),
    };
  });
  out.sort((a, b) => b.placements.length - a.placements.length);
  return { groups: out, thresholds: { strict, loose, neighbour }, typicalOffset };
}
