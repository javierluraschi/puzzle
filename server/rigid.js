// 2D rigid motions { c, s, tx, ty }: p -> [c·x - s·y + tx, s·x + c·y + ty] (rotation by atan2(s, c)).

export const IDENTITY = { c: 1, s: 0, tx: 0, ty: 0 };

export function apply(T, [x, y]) {
  return [T.c * x - T.s * y + T.tx, T.s * x + T.c * y + T.ty];
}

/** first B, then A */
export function compose(A, B) {
  return { c: A.c * B.c - A.s * B.s, s: A.s * B.c + A.c * B.s, tx: A.c * B.tx - A.s * B.ty + A.tx, ty: A.s * B.tx + A.c * B.ty + A.ty };
}

export function invert(T) {
  return { c: T.c, s: -T.s, tx: -(T.c * T.tx + T.s * T.ty), ty: T.s * T.tx - T.c * T.ty };
}

export function rotation(angle, [tx, ty] = [0, 0]) {
  return { c: Math.cos(angle), s: Math.sin(angle), tx, ty };
}

export const angleOf = (T) => Math.atan2(T.s, T.c);

/** Least-squares rigid motion mapping points p onto q (index-wise correspondences). */
export function fit(p, q) {
  const n = p.length;
  let mx = 0, my = 0, nx = 0, ny = 0;
  for (let i = 0; i < n; i++) { mx += p[i][0]; my += p[i][1]; nx += q[i][0]; ny += q[i][1]; }
  mx /= n; my /= n; nx /= n; ny /= n;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) {
    const px = p[i][0] - mx, py = p[i][1] - my, qx = q[i][0] - nx, qy = q[i][1] - ny;
    sa += px * qx + py * qy;
    sb += px * qy - py * qx;
  }
  const norm = Math.hypot(sa, sb) || 1;
  const c = sa / norm;
  const s = sb / norm;
  return { c, s, tx: nx - (c * mx - s * my), ty: ny - (s * mx + c * my) };
}

/** piece coordinates -> the frame of `side` (start corner at the origin, chord along +x) */
export function sideFrame(side) {
  const inv = rotation(-side.angle);
  const [ox, oy] = apply(inv, side.origin);
  return { ...inv, tx: -ox, ty: -oy };
}
