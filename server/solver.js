// Assembles pieces into groups using where pieces actually lie, not just which edges match.
//
// Every piece in a group has a real pose (rotation + position in mm, from the side alignment) and a
// grid cell with a rotation r: side k faces direction (k + r) % 4, directions 0 up, 1 right,
// 2 down, 3 left (sides are numbered clockwise). Links between sides are taken strongest first, and
// two groups merge only if the merged layout holds up spatially:
//   - every pair of pieces that ends up side by side fits at their poses, without re-aligning
//     (so a piece whose size does not suit its row or column is rejected)
//   - no piece overlaps any nearby piece, diagonal neighbours included
//   - every piece's rotation agrees with the grid
//   - a piece hanging on a single contact needs a strict, unambiguous, mutual best match
// When two groups agree along many contacts but conflict in a few places, the weaker pieces are
// evicted and may find their place later (local backtracking).

import { sideFit, combine, confidence, nearestOnA, INNER } from './match.js';
import { apply, compose, invert, angleOf, sideFrame, IDENTITY, fit as fitRigid } from './rigid.js';

const D = [[0, -1], [1, 0], [0, 1], [-1, 0]];

// thresholds in mm for a typical piece (sqrt(area) ≈ 15 mm), scaled to the puzzle's pieces
const env = (name, fallback) => Number(globalThis.process?.env?.[name] ?? fallback);
const STRICT = env('SOLVE_STRICT', 0.11); // link score for single-contact attachments
const LOOSE = env('SOLVE_LOOSE', 0.16); // link score when more contacts confirm it
const POSED = env('SOLVE_POSED', 0.2); // fit of every contact at the actual poses
const OVERLAP = env('SOLVE_OVERLAP', 0.5); // allowed penetration between any two pieces (beyond the typical overlap)
const MARGIN = env('SOLVE_MARGIN', 1.25); // single contact: best must beat the runner-up by this factor
const ANGLE = (env('SOLVE_ANGLE', 8) * Math.PI) / 180; // grid alignment tolerance
const HALF_CONFIDENCE = 0.12;
const BIG_GROUP = env('SOLVE_BIG', 20); // groups at least this big are joined by topology
const PAIR = env('SOLVE_PAIR', 0.3); // every contact's own (re-aligned) match score
const BORDER = env('SOLVE_BORDER', 1) === 1; // pieces along a border must agree on its flat sides

const facing = (r, d) => (d - r + 8) % 4;
const rotateCell = ([x, y], q) => {
  for (let i = 0; i < q; i++) [x, y] = [-y, x];
  return [x, y];
};
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function solve(pieces, { table, typicalOffset = 0, gaps = null }, { onProgress = () => {}, onReject = null } = {}) {
  // the gap expected between two pieces: the sum of their shares when known (see estimatePieceGaps)
  const gap = (i, j) => (gaps ? (gaps[i] ?? typicalOffset / 2) + (gaps[j] ?? typicalOffset / 2) : typicalOffset);
  const ok = [...pieces].filter(([, p]) => p.ok);
  const sizes = ok.map(([, p]) => p.sizeMm).sort((a, b) => a - b);
  const k = sizes.length ? sizes[Math.floor(sizes.length / 2)] / 15 : 1;
  // backlit/flatbed outlines of neighbours overlap a little (negative typical gap): allow that too
  const T = { strict: STRICT * k, loose: LOOSE * k, posed: POSED * k, pair: PAIR * k, overlap: OVERLAP * k + Math.max(0, -typicalOffset) };

  // geometry per piece: outline samples for overlap tests, side frames
  const geo = new Map();
  for (const [index, p] of ok) {
    const step = Math.max(1, Math.floor(p.outline.length / 120));
    geo.set(index, {
      polygon: p.outline.filter((_, i) => i % step === 0),
      probes: p.outline.filter((_, i) => i % Math.max(1, Math.floor(p.outline.length / 48)) === 0),
      center: p.center,
      box: [Math.min(...p.outline.map((q) => q[0])), Math.min(...p.outline.map((q) => q[1])), Math.max(...p.outline.map((q) => q[0])), Math.max(...p.outline.map((q) => q[1]))],
      radius: Math.max(...p.outline.map(([x, y]) => Math.hypot(x - p.center[0], y - p.center[1]))),
      frames: p.sides.map((s) => ({ toSide: sideFrame(s), fromSide: invert(sideFrame(s)) })),
      // orientation with side t on top, from all four side chords (pieces are not perfect
      // rectangles: single chords are off by a few degrees, their circular mean much less)
      orient: [0, 1, 2, 3].map((t) => {
        let sx = 0;
        let sy = 0;
        for (let m = 0; m < 4; m++) {
          const a = p.sides[(t + m) % 4].angle - (m * Math.PI) / 2;
          sx += Math.cos(a);
          sy += Math.sin(a);
        }
        return Math.atan2(sy, sx);
      }),
    });
  }

  // side fits with poses, cached
  const fits = new Map();
  const fitOf = (i, s, j, t) => {
    const key = `${i}_${s}|${j}_${t}`;
    if (!fits.has(key)) {
      const a = pieces.get(i).sides[s];
      const b = pieces.get(j).sides[t];
      const ab = sideFit(a, b);
      const ba = sideFit(b, a);
      fits.set(key, { score: (combine(ab, gap(i, j)) + combine(ba, gap(i, j))) / 2, pose: ab.pose });
    }
    return fits.get(key);
  };

  // candidate links: each pair of sides once, with how clearly it wins for both sides
  const second = (key, exclude) => (table.get(key) || []).find((c) => !(c.piece === exclude[0] && c.side === exclude[1]))?.score ?? Infinity;
  const links = new Map();
  for (const [key, cands] of table) {
    const [i, s] = key.split('_').map(Number);
    if (!geo.has(i)) continue;
    for (const c of cands) {
      if (c.score > T.loose * 1.5) break;
      if (!geo.has(c.piece)) continue;
      const id = i < c.piece ? `${i}_${s}|${c.piece}_${c.side}` : `${c.piece}_${c.side}|${i}_${s}`;
      if (links.has(id)) continue;
      const { score } = fitOf(i, s, c.piece, c.side);
      if (score > T.loose) continue;
      const back = table.get(`${c.piece}_${c.side}`) || [];
      const mutual = cands[0] === c && back[0]?.piece === i && back[0]?.side === s;
      const margin = Math.min(second(key, [c.piece, c.side]), second(`${c.piece}_${c.side}`, [i, s])) / Math.max(score, 1e-3);
      links.set(id, { i, s, j: c.piece, t: c.side, score, clear: mutual && margin >= MARGIN, key: (score * (mutual ? 0.7 : 1)) / Math.min(2, Math.max(1, margin)) });
    }
  }
  const ordered = [...links.values()].sort((a, b) => a.key - b.key);

  // --- groups ----------------------------------------------------------------------------------
  const groupOf = new Map();
  const groups = new Map();
  let nextGroup = 0;
  const single = (m) => {
    const id = nextGroup++;
    // the group frame is the piece's own frame; its grid "right" is the direction of side 0
    groups.set(id, { cells: new Map([['0,0', m]]), members: new Map([[m, { x: 0, y: 0, r: 0, pose: IDENTITY }]]), axis: geo.get(m).orient[0], version: 0 });
    groupOf.set(m, id);
  };
  for (const [index] of ok) single(index);

  const worldCenter = (m, pose) => apply(pose, geo.get(m).center);

  /** How well side sm of m (pose pm) and side so of o (pose po) fit where they are (mm). */
  const posedFit = (m, sm, pm, o, so, po) => {
    const a = pieces.get(o).sides[so];
    const b = pieces.get(m).sides[sm];
    // m's side curve -> m's piece -> group -> o's piece -> o's side frame
    const toA = compose(geo.get(o).frames[so].toSide, compose(invert(po), compose(pm, geo.get(m).frames[sm].fromSide)));
    const n = b.points.length;
    const g = gap(m, o);
    let sum = 0;
    let count = 0;
    for (let q = INNER[0]; q < INNER[1]; q += 2) {
      const p = apply(toA, b.points[n - 1 - q]);
      const near = nearestOnA(a.points, p, q, 6);
      sum += (near.signed - g) ** 2;
      count++;
    }
    return Math.sqrt(sum / count);
  };

  /** Pieces stacked along the border both have its flat side facing out (and others neither). */
  const borderAgrees = (m, rm, o, ro, dir) => [(dir + 1) % 4, (dir + 3) % 4].every((d) =>
    (pieces.get(m).sides[facing(rm, d)].type === 'flat') === (pieces.get(o).sides[facing(ro, d)].type === 'flat'));

  /** Does m (pose pm) penetrate o (pose po) deeper than the tolerance, or vice versa? */
  const overlaps = (m, pm, o, po) => {
    const gm = geo.get(m);
    const go = geo.get(o);
    const [cx, cy] = worldCenter(m, pm);
    const [dx, dy] = worldCenter(o, po);
    if (Math.hypot(cx - dx, cy - dy) > gm.radius + go.radius) return false;
    const deep = (probes, fromPose, polygon, toPose, [bx0, by0, bx1, by1]) => {
      const M = compose(invert(toPose), fromPose);
      let hits = 0;
      for (const q of probes) {
        const p = apply(M, q);
        if (p[0] < bx0 || p[1] < by0 || p[0] > bx1 || p[1] > by1 || !inside(polygon, p)) continue;
        const depth = distanceTo(polygon, p);
        if (depth <= T.overlap) continue;
        if (++hits >= 3) return true;
      }
      return false;
    };
    return deep(gm.probes, pm, go.polygon, po, go.box) || deep(go.probes, po, gm.polygon, pm, gm.box);
  };

  /** Grid orientation of a placed piece: the angle its upright direction has in the group. */
  const heading = (m, r, pose) => angleOf(pose) + geo.get(m).orient[facing(r, 0)];
  /**
   * Piece m agrees with the grid around it: same heading as the neighbour it touches. Compared
   * locally because big groups bend by a few degrees over their length.
   */
  const aligned = (m, p, o, po) => Math.abs(wrap(heading(m, p.r, p.pose) - heading(o, po.r, po.pose))) < ANGLE;

  /** How firmly a piece sits in its group: contacts that fit at the current poses. */
  let supportCache = new Map();
  const support = (g, m) => {
    const key = `${groupOf.get(m)}:${g.version}:${m}`;
    if (supportCache.has(key)) return supportCache.get(key);
    const n = supportOf(g, m);
    supportCache.set(key, n);
    return n;
  };
  const supportOf = (g, m) => {
    const p = g.members.get(m);
    let n = 0;
    for (let dir = 0; dir < 4; dir++) {
      const o = g.cells.get(`${p.x + D[dir][0]},${p.y + D[dir][1]}`);
      if (o === undefined) continue;
      const po = g.members.get(o);
      if (posedFit(m, facing(p.r, dir), p.pose, o, facing(po.r, (dir + 2) % 4), po.pose) <= T.posed) n++;
    }
    return n;
  };

  /**
   * Least-squares rigid correction of a group being placed (`moved`) against all its contacts with
   * group `gi`: each touching side's points should lie on the neighbour's side curve, pushed out by
   * the typical gap. Applied to every moved piece. Contacts that are far off are left out.
   */
  const refinePlacement = (moved, gi) => {
    for (let iter = 0; iter < 3; iter++) {
      const from = [];
      const to = [];
      for (const [m, p] of moved) {
        for (let dir = 0; dir < 4; dir++) {
          const o = gi.cells.get(`${p.x + D[dir][0]},${p.y + D[dir][1]}`);
          if (o === undefined) continue;
          const po = gi.members.get(o);
          const sm = facing(p.r, dir);
          const so = facing(po.r, (dir + 2) % 4);
          const a = pieces.get(o).sides[so];
          const b = pieces.get(m).sides[sm];
          if (a.type === 'flat' || b.type === 'flat') continue;
          const toA = compose(geo.get(o).frames[so].toSide, compose(invert(po.pose), compose(p.pose, geo.get(m).frames[sm].fromSide)));
          const fromA = compose(po.pose, geo.get(o).frames[so].fromSide);
          const n = b.points.length;
          const local = [];
          const g = gap(m, o);
          let sum = 0;
          for (let q = INNER[0]; q < INNER[1]; q += 3) {
            const pt = apply(toA, b.points[n - 1 - q]);
            const near = nearestOnA(a.points, pt, q);
            sum += (near.signed - g) ** 2;
            local.push([apply(fromA, pt), apply(fromA, [near.q[0] + near.n[0] * g, near.q[1] + near.n[1] * g])]);
          }
          if (Math.sqrt(sum / local.length) > T.posed * 2.5) continue; // probably a wrong contact
          for (const [x, y] of local) { from.push(x); to.push(y); }
        }
      }
      if (from.length < 20) return;
      const C = fitRigid(from, to);
      for (const p of moved.values()) p.pose = compose(C, p.pose);
    }
  };

  const evict = (m) => {
    const g = groups.get(groupOf.get(m));
    const p = g.members.get(m);
    g.members.delete(m);
    g.cells.delete(`${p.x},${p.y}`);
    g.version++;
    single(m);
  };

  const failed = new Set();
  const tryMerge = (link, limit) => {
    const ok = tryMergeInner(link, limit);
    if (ok !== true && ok !== false && onReject) onReject(link, ok);
    return ok === true;
  };

  // returns true when merged, false when not applicable, or a string: why it was rejected
  const tryMergeInner = (link, limit) => {
    if (link.score > limit) return false;
    if (groupOf.get(link.i) === groupOf.get(link.j)) return false;
    // keep the bigger group in place
    let [a, sa, b, sb] = [link.i, link.s, link.j, link.t];
    if (groups.get(groupOf.get(b)).members.size > groups.get(groupOf.get(a)).members.size) [a, sa, b, sb] = [b, sb, a, sa];
    const idI = groupOf.get(a);
    const idJ = groupOf.get(b);
    const gi = groups.get(idI);
    const gj = groups.get(idJ);

    // grid placement of the other group
    const pa = gi.members.get(a);
    const d = (sa + pa.r) % 4;
    const target = [pa.x + D[d][0], pa.y + D[d][1]];
    const pb = gj.members.get(b);
    const delta = ((d + 2 - sb - pb.r) % 4 + 8) % 4;
    // the same two groups in the same grid arrangement were already tried in this pass (another
    // link along the same boundary): retried in the next pass, when the groups have grown
    const [rx, ry] = rotateCell([pb.x, pb.y], delta);
    const signature = `${idI}|${idJ}|${target[0] - rx},${target[1] - ry},${delta}|${Math.min(gi.members.size, gj.members.size) > 1 ? 'g' : gi.version + ':' + gj.version}`;
    if (failed.has(signature)) return false;
    failed.add(signature);
    // spatial placement: J's frame -> I's frame through the side alignment of a and b
    const W = compose(pa.pose, compose(fitOf(a, sa, b, sb).pose, invert(pb.pose)));
    const moved = new Map();
    for (const [m, p] of gj.members) {
      const [ox, oy] = rotateCell([p.x - pb.x, p.y - pb.y], delta);
      moved.set(m, { x: target[0] + ox, y: target[1] + oy, r: (p.r + delta) % 4, pose: compose(W, p.pose) });
    }
    // loop closure: refine the placement against all new contacts at once, so small errors that
    // accumulate along chains of pieces do not make true contacts look misplaced
    refinePlacement(moved, gi);

    // Two big groups: their poses are only as good as the long chains of pieces behind them (they
    // bend a little), but their grid topology is solid. Judge the seam by re-aligned fits and
    // grid consistency; poses are relaxed afterwards.
    const big = Math.min(gi.members.size, gj.members.size) >= BIG_GROUP;
    if (big) {
      let ok = 0;
      const clashes = [];
      for (const [m, p] of moved) {
        const there = gi.cells.get(`${p.x},${p.y}`);
        if (there !== undefined) clashes.push([m, there]);
        for (let dir = 0; dir < 4; dir++) {
          const o = gi.cells.get(`${p.x + D[dir][0]},${p.y + D[dir][1]}`);
          if (o === undefined) continue;
          const po = gi.members.get(o);
          const sm = facing(p.r, dir);
          const so = facing(po.r, (dir + 2) % 4);
          const flat = pieces.get(m).sides[sm].type === 'flat' || pieces.get(o).sides[so].type === 'flat';
          if (!flat && fitOf(o, so, m, sm).score <= T.loose) ok++;
          else clashes.push([m, o]);
        }
      }
      if (ok < 4 || clashes.length > ok / 4) return `big-seam:${ok}/${clashes.length}/sizes:${gi.members.size}+${gj.members.size}`;
      // the few clashing pieces with the weaker support give way
      const losers = new Map();
      for (const [m, o] of clashes) {
        if (support(gj, m) >= support(gi, o)) losers.set(o, 'i');
        else losers.set(m, 'j');
      }
      if (losers.has(a) || losers.has(b)) return 'big-seam:link-piece';
      for (const [m, side] of losers) {
        if (side === 'j') moved.delete(m);
        evict(m);
      }
      for (const [m, p] of moved) {
        if (gi.cells.has(`${p.x},${p.y}`)) return 'big-seam:collision';
        gi.members.set(m, p);
        gi.cells.set(`${p.x},${p.y}`, m);
        groupOf.set(m, idI);
      }
      gi.version++;
      groups.delete(idJ);
      relax(gi, 6, seamOf(gi, moved));
      return true;
    }

    // check the combined layout
    let good = 0;
    let soft = 0;
    const conflicts = [];
    let bent = 0;
    for (const [m, p] of moved) {
      for (let dir = 0; dir < 4; dir++) {
        const o = gi.cells.get(`${p.x + D[dir][0]},${p.y + D[dir][1]}`);
        if (o === undefined) continue;
        const off = Math.abs(wrap(heading(m, p.r, p.pose) - heading(o, gi.members.get(o).r, gi.members.get(o).pose)));
        if (off < ANGLE) continue;
        // two big groups meeting along a long seam are both bent a little by accumulated
        // measurement error: tolerated (and relaxed away) when backed by enough good contacts
        if (off < 2 * ANGLE && moved.size > 1) bent++;
        else return `angle/sizes:${gi.members.size}+${gj.members.size}/off:${((off * 180) / Math.PI).toFixed(1)}/near-link:${Math.abs(p.x - target[0]) + Math.abs(p.y - target[1])}`;
      }
      const there = gi.cells.get(`${p.x},${p.y}`);
      if (there !== undefined) conflicts.push([m, there, 'cell']);
      for (let dir = 0; dir < 4; dir++) {
        const o = gi.cells.get(`${p.x + D[dir][0]},${p.y + D[dir][1]}`);
        if (o === undefined) continue;
        const po = gi.members.get(o);
        const sm = facing(p.r, dir);
        const so = facing(po.r, (dir + 2) % 4);
        const flat = pieces.get(m).sides[sm].type === 'flat' || pieces.get(o).sides[so].type === 'flat';
        if (!flat && BORDER && !borderAgrees(m, p.r, o, po.r, dir)) {
          conflicts.push([m, o, 'border']);
          continue;
        }
        const fitHere = flat ? Infinity : posedFit(m, sm, p.pose, o, so, po.pose);
        // a contact must also be a fair match on its own (re-aligned, so pose drift does not matter;
        // the score includes edge ends that do not meet)
        if (!flat && fitOf(o, so, m, sm).score > T.pair) {
          conflicts.push([m, o, 'pair']);
          continue;
        }
        if (fitHere <= T.posed) good++;
        // slightly off at the current poses (drift in big groups) but a good fit when re-aligned:
        // fine once the poses are relaxed
        else if (fitHere <= T.posed * 2.5 && moved.size > 1 && fitOf(o, so, m, sm).score <= T.loose) { good++; soft++; }
        else conflicts.push([m, o, flat ? 'flat' : 'fit']);
      }
      // nor may diagonal neighbours overlap (direct ones that fit at their poses cannot)
      for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const o = gi.cells.get(`${p.x + dx},${p.y + dy}`);
        if (o !== undefined && overlaps(m, p.pose, o, gi.members.get(o).pose)) conflicts.push([m, o, 'overlap']);
      }
      // too many conflicts to ever be accepted
      if (conflicts.length > 8) return `conflicts:${conflicts.length}+/good:${good}/early`;
    }

    if (bent && good < 3) return `angle/sizes:${gi.members.size}+${gj.members.size}`;
    if (!conflicts.length) {
      // a lone contact is the weakest evidence: only unambiguous, strict links
      if (good <= 1 && !(link.clear && link.score <= T.strict)) return 'single-contact';
    } else {
      // undo earlier placements only for a clear majority of good contacts
      const losers = new Set();
      for (const [m, o] of conflicts) losers.add(support(gj, m) >= support(gi, o) ? `i${o}` : `j${m}`);
      if (good < 3 || good < 3 * losers.size || losers.has(`i${a}`) || losers.has(`j${b}`)) return `conflicts:${conflicts.length}/good:${good}/${[...new Set(conflicts.map((c) => c[2]))].join('+')}/sizes:${gi.members.size}+${gj.members.size}`;
      for (const l of losers) {
        const m = Number(l.slice(1));
        if (l[0] === 'j') moved.delete(m);
        evict(m);
      }
      // what is left must be fully consistent
      for (const [m, p] of moved) {
        if (gi.cells.has(`${p.x},${p.y}`)) return `after-evict/sizes:${gi.members.size}+${gj.members.size}`;
        for (let dir = 0; dir < 4; dir++) {
          const o = gi.cells.get(`${p.x + D[dir][0]},${p.y + D[dir][1]}`);
          if (o === undefined) continue;
          const po = gi.members.get(o);
          if (BORDER && !borderAgrees(m, p.r, o, po.r, dir)) return `after-evict/sizes:${gi.members.size}+${gj.members.size}`;
          if (posedFit(m, facing(p.r, dir), p.pose, o, facing(po.r, (dir + 2) % 4), po.pose) > T.posed) return `after-evict/sizes:${gi.members.size}+${gj.members.size}`;
        }
        for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const o = gi.cells.get(`${p.x + dx},${p.y + dy}`);
          if (o !== undefined && overlaps(m, p.pose, o, gi.members.get(o).pose)) return `after-evict/sizes:${gi.members.size}+${gj.members.size}`;
        }
      }
    }

    for (const [m, p] of moved) {
      gi.members.set(m, p);
      gi.cells.set(`${p.x},${p.y}`, m);
      groupOf.set(m, idI);
    }
    gi.version++;
    groups.delete(idJ);
    if (soft || bent || moved.size > 1) relax(gi, soft || bent ? 4 : 1, seamOf(gi, moved));
    return true;
  };

  /** The pieces around the seam where `moved` joined group g (two grid rings). */
  const seamOf = (g, moved) => {
    const focus = new Set();
    for (const [, p] of moved) {
      let touches = false;
      for (let dir = 0; dir < 4 && !touches; dir++) {
        const o = g.cells.get(`${p.x + D[dir][0]},${p.y + D[dir][1]}`);
        touches = o !== undefined && !moved.has(o);
      }
      if (!touches) continue;
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
        const o = g.cells.get(`${p.x + dx},${p.y + dy}`);
        if (o !== undefined) focus.add(o);
      }
    }
    return focus;
  };

  /**
   * Pose relaxation: every piece with two or more contacts is re-fitted to its neighbours (a few
   * Gauss-Seidel sweeps), so small errors spread over a big group instead of piling up at seams.
   */
  const relax = (g, sweeps, focus = null) => {
    for (let sweep = 0; sweep < sweeps; sweep++) {
      for (const [m, p] of g.members) {
        if (focus && !focus.has(m)) continue;
        const from = [];
        const to = [];
        let contacts = 0;
        for (let dir = 0; dir < 4; dir++) {
          const o = g.cells.get(`${p.x + D[dir][0]},${p.y + D[dir][1]}`);
          if (o === undefined) continue;
          const po = g.members.get(o);
          const sm = facing(p.r, dir);
          const so = facing(po.r, (dir + 2) % 4);
          const a = pieces.get(o).sides[so];
          const b = pieces.get(m).sides[sm];
          if (a.type === 'flat' || b.type === 'flat') continue;
          const toA = compose(geo.get(o).frames[so].toSide, compose(invert(po.pose), compose(p.pose, geo.get(m).frames[sm].fromSide)));
          const fromA = compose(po.pose, geo.get(o).frames[so].fromSide);
          const n = b.points.length;
          const go = gap(m, o);
          for (let q = INNER[0]; q < INNER[1]; q += 4) {
            const pt = apply(toA, b.points[n - 1 - q]);
            const near = nearestOnA(a.points, pt, q);
            from.push(apply(fromA, pt));
            to.push(apply(fromA, [near.q[0] + near.n[0] * go, near.q[1] + near.n[1] * go]));
          }
          contacts++;
        }
        if (contacts >= 2) p.pose = compose(fitRigid(from, to), p.pose);
      }
    }
  };

  const relaxAll = () => {
    for (const g of groups.values()) if (g.members.size > 2) relax(g, 2);
  };
  let merged = 0;
  for (const limit of [T.strict, T.loose]) {
    failed.clear();
    for (const link of ordered) if (tryMerge(link, limit)) merged++;
    relaxAll();
    onProgress({ groups: groups.size, merged });
  }
  for (let round = 0; round < 4; round++) {
    const before = merged;
    failed.clear();
    for (const link of ordered) if (tryMerge(link, T.loose)) merged++;
    relaxAll();
    onProgress({ groups: groups.size, merged });
    if (merged === before) break;
  }
  for (const [id, g] of groups) if (!g.members.size) groups.delete(id);

  // output: grid placement, fit towards each direction, and the pose (grid axis horizontal)
  const out = [...groups.values()].map((g) => {
    // level the group by the mean heading of its pieces
    let hx = 0;
    let hy = 0;
    for (const [m, p] of g.members) {
      const h = heading(m, p.r, p.pose);
      hx += Math.cos(h);
      hy += Math.sin(h);
    }
    const axis = Math.atan2(hy, hx);
    const level = { c: Math.cos(-axis), s: Math.sin(-axis), tx: 0, ty: 0 };
    const xs = [...g.members.values()].map((p) => p.x);
    const ys = [...g.members.values()].map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
      placements: [...g.members].map(([index, p]) => {
        const pose = compose(level, p.pose);
        return {
          piece: index,
          x: p.x - minX,
          y: p.y - minY,
          top: facing(p.r, 0),
          // piece outline coordinates (mm) -> group coordinates (mm), grid axis horizontal
          pose: { angle: round((angleOf(pose) * 180) / Math.PI, 3), tx: round(pose.tx, 3), ty: round(pose.ty, 3) },
          // fit at the actual poses with the neighbour in direction 0 up, 1 right, 2 down, 3 left
          links: [0, 1, 2, 3].map((dir) => {
            const o = g.cells.get(`${p.x + D[dir][0]},${p.y + D[dir][1]}`);
            if (o === undefined) return null;
            const po = g.members.get(o);
            return confidence(posedFit(index, facing(p.r, dir), p.pose, o, facing(po.r, (dir + 2) % 4), po.pose), HALF_CONFIDENCE * k);
          }),
        };
      }),
    };
  });
  out.sort((a, b) => b.placements.length - a.placements.length);
  return { groups: out, thresholds: T, typicalOffset };
}

function inside(polygon, [x, y]) {
  let isIn = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) isIn = !isIn;
  }
  return isIn;
}

function distanceTo(polygon, [x, y]) {
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [x1, y1] = polygon[j];
    const [x2, y2] = polygon[i];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2)) : 0;
    best = Math.min(best, (x - x1 - dx * t) ** 2 + (y - y1 - dy * t) ** 2);
  }
  return Math.sqrt(best);
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
