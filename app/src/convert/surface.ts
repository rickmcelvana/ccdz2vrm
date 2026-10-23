// Point-to-surface distance, for judging a decimated mesh: how far each original vertex lies
// from the reduced surface (what a viewer sees go missing). A uniform grid over the triangles,
// searched in growing rings until no nearer cell is left.
//
// With `uv`, the texture coordinate counts too: a point's distance to a triangle is
// hypot(distance, weight * |uv at the closest point - the point's uv|). Without it, a hair
// card's scalp cap reduced away still measured "on the surface" -- the strand layer above it
// is within millimetres.

const CELL = 0.005; // 5 mm
const CAP = 0.1; // distances are capped here (the search stops 20 rings out)

export type SurfaceOptions = {
  /** points known to lie on the surface (a vertex the reduction kept): distance 0, not searched */
  on?: Uint8Array;
  /** stop at the first triangle this close: the answer is then "within", not the exact distance */
  within?: number;
  /** texture coordinates of the points and of Q's vertices; weight: metres per uv unit */
  uv?: { P: Float32Array; Q: Float32Array; weight: number };
  /** filled with the index (into idx / 3) of each point's nearest triangle, -1 if none in reach */
  nearest?: Int32Array;
};

// 17 bits per cell coordinate (5 mm cells: +-327 m), 51 bits in all: an exact integer key
const key = (x: number, y: number, z: number) => ((x + 65536) * 131072 + (y + 65536)) * 131072 + (z + 65536);

/** Distance from each of `n` points `P` to the nearest triangle of (`Q`, `idx`), metres. */
export function surfaceDistances(P: Float32Array, n: number, Q: Float32Array, idx: Uint32Array, opts: SurfaceOptions = {}): Float64Array {
  const cells = new Map<number, number[]>();
  const nt = idx.length / 3;
  for (let t = 0; t < nt; t++) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let c = 0; c < 3; c++) {
      const o = idx[t * 3 + c]! * 3, x = Q[o]!, y = Q[o + 1]!, z = Q[o + 2]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    for (let x = Math.floor(x0 / CELL); x <= Math.floor(x1 / CELL); x++)
      for (let y = Math.floor(y0 / CELL); y <= Math.floor(y1 / CELL); y++)
        for (let z = Math.floor(z0 / CELL); z <= Math.floor(z1 / CELL); z++) {
          const k = key(x, y, z);
          const l = cells.get(k);
          if (l) l.push(t);
          else cells.set(k, [t]);
        }
  }
  const out = new Float64Array(n);
  const seen = new Int32Array(nt).fill(-1); // the last point that tested each triangle
  const within = opts.within ?? 0, uv = opts.uv;
  for (let v = 0; v < n; v++) {
    if (opts.on?.[v]) continue;
    const px = P[v * 3]!, py = P[v * 3 + 1]!, pz = P[v * 3 + 2]!;
    const cx = Math.floor(px / CELL), cy = Math.floor(py / CELL), cz = Math.floor(pz / CELL);
    let best = CAP, bestT = -1;
    // ring r holds the cells at Chebyshev distance r; after it, anything unsearched is >= r cells away
    search: for (let r = 0; r <= CAP / CELL && best > (r - 1) * CELL; r++)
      for (let x = cx - r; x <= cx + r; x++)
        for (let y = cy - r; y <= cy + r; y++)
          for (let z = cz - r; z <= cz + r; z++) {
            if (Math.max(Math.abs(x - cx), Math.abs(y - cy), Math.abs(z - cz)) !== r) continue;
            const l = cells.get(key(x, y, z));
            if (!l) continue;
            for (const t of l) {
              if (seen[t] === v) continue;
              seen[t] = v;
              const a = idx[t * 3]!, b = idx[t * 3 + 1]!, c = idx[t * 3 + 2]!;
              let d = pointTriangle(px, py, pz, Q, a * 3, b * 3, c * 3);
              if (uv && d < best) {
                const U = uv.Q, s = lastS, w = lastT;
                const du = U[a * 2]! + s * (U[b * 2]! - U[a * 2]!) + w * (U[c * 2]! - U[a * 2]!) - uv.P[v * 2]!;
                const dv = U[a * 2 + 1]! + s * (U[b * 2 + 1]! - U[a * 2 + 1]!) + w * (U[c * 2 + 1]! - U[a * 2 + 1]!) - uv.P[v * 2 + 1]!;
                d = Math.hypot(d, uv.weight * Math.hypot(du, dv));
              }
              if (d < best) [best, bestT] = [d, t];
              if (best <= within) break search;
            }
          }
    out[v] = best;
    if (opts.nearest) opts.nearest[v] = bestT;
  }
  return out;
}

// the closest point of the last pointTriangle call: a + lastS * ab + lastT * ac
let lastS = 0, lastT = 0;

/** Ericson, Real-Time Collision Detection 5.1.5: distance from p to triangle (a, b, c) of Q. */
function pointTriangle(px: number, py: number, pz: number, Q: Float32Array, a: number, b: number, c: number): number {
  const ax = Q[a]!, ay = Q[a + 1]!, az = Q[a + 2]!;
  const abx = Q[b]! - ax, aby = Q[b + 1]! - ay, abz = Q[b + 2]! - az;
  const acx = Q[c]! - ax, acy = Q[c + 1]! - ay, acz = Q[c + 2]! - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  // the point a + s ab + t ac's distance to p
  const at = (s: number, t: number) => {
    lastS = s;
    lastT = t;
    return Math.hypot(apx - s * abx - t * acx, apy - s * aby - t * acy, apz - s * abz - t * acz);
  };
  if (d1 <= 0 && d2 <= 0) return at(0, 0);
  const abac = abx * acx + aby * acy + abz * acz;
  const d3 = d1 - (abx * abx + aby * aby + abz * abz), d4 = d2 - abac; // against p - b
  if (d3 >= 0 && d4 <= d3) return at(1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(d1 / (d1 - d3), 0);
  const d5 = d1 - abac, d6 = d2 - (acx * acx + acy * acy + acz * acz); // against p - c
  if (d6 >= 0 && d5 <= d6) return at(0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(0, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return at(1 - w, w);
  }
  const den = 1 / (va + vb + vc);
  return at(vb * den, vc * den);
}
