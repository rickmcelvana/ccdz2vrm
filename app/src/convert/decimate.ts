// The web tier's mesh reduction (vrm_export.py step 2c: simplify_cards + _decimate_keyed),
// done with meshoptimizer's simplifier instead of Blender's topology operators.
//
// Why this keeps hair cards intact where Blender's collapse decimation spiked them: the
// simplifier only collapses a border vertex onto another vertex of the same border, so a card
// (whose vertices are nearly all on its border) gets shorter rows, never a narrower ribbon --
// what simplify_cards gets by dissolving whole rungs. It keeps a subset of the original
// vertices, so shape keys (Daz strand brows) carry over exactly; _decimate_keyed had to find
// each survivor's nearest original. Judged by surface deviation against Blender's result
// (tools/compare/vrm.ts --original), not vertex identity (ENVIRONMENT.md s35).
//
// The simplifier's own error is an area-weighted quadric estimate, not a distance: at a 2.5 mm
// limit it still dropped whole curved cards (9 % of G8 hair's vertices ended > 2.5 mm from the
// result, up to 28 mm) and left holes in the scalp cap at the hairline. So it runs in rounds:
// simplify; measure (1) every original vertex against its own slot's reduced triangles -- the
// strand layer over a vanished cap is otherwise "within reach" -- and (2) every reduced
// triangle's centre, by position and uv (uv 0.008 ~ 2.5 mm, as the simplifier weighs them),
// against its slot's original surface, which catches a triangle stretched over the wrong part
// of the texture; lock what strayed; simplify again until nothing does. On G8's hair: 363k ->
// 129k vertices (Blender 89k), every original vertex within 2.7 mm, no visible holes.

import { MeshoptSimplifier } from 'meshoptimizer';
import { MAXW, type Mesh } from './contract.ts';
import { surfaceDistances } from './surface.ts';

/** simplify_cards' limits: 2.5 mm off the surface; uv 0.008 is weighted to match it. */
export const DECIMATE_TOL = 0.0025;
const UV_WEIGHT = DECIMATE_TOL / 0.008; // metres per uv unit

export type DecimateReport = { before: number; after: number; error_mm: number; keys: number; rounds: number; locked: number };

/** Blender's vertex count: distinct source vertices. */
export const sourceCount = (m: Mesh) => (m.vertex ? new Set(m.vertex).size : m.vertex_count);

/** Keep the given triangles (with their slots) and only the vertices they use. */
export function rebuild(m: Mesh, tris: Uint32Array, triMat: Uint16Array): void {
  const used = new Int32Array(m.vertex_count).fill(-1);
  let n = 0;
  for (const v of tris) if (used[v] === -1) used[v] = n++;
  const pick = <T extends Float32Array | Uint16Array | Uint32Array>(a: T, k: number): T => {
    const o = new (a.constructor as new (n: number) => T)(n * k);
    for (let v = 0; v < m.vertex_count; v++) if (used[v]! >= 0) o.set(a.subarray(v * k, v * k + k), used[v]! * k);
    return o;
  };
  m.position = pick(m.position, 3);
  m.uv = pick(m.uv, 2);
  if (m.normal) m.normal = pick(m.normal, 3);
  if (m.vertex) m.vertex = pick(m.vertex, 1);
  m.joints = pick(m.joints, MAXW);
  m.weights = pick(m.weights, MAXW);
  m.morphs = m.morphs.map((k) => ({ ...k, delta: pick(k.delta, 3) }));
  m.indices = tris.map((v) => used[v]!);
  m.triangle_material = triMat;
  m.vertex_count = n;
  m.triangle_count = tris.length / 3;
}

/** Reduce `m` towards `budget` source vertices, in place. */
export async function decimateMesh(m: Mesh, budget: number, tol = DECIMATE_TOL): Promise<DecimateReport> {
  await MeshoptSimplifier.ready;
  const before = sourceCount(m);
  const slots = m.materials.length || 1;
  const bySlot: number[][] = Array.from({ length: slots }, () => []);
  for (let t = 0; t < m.triangle_count; t++) bySlot[m.triangle_material[t] ?? 0]!.push(t);
  // a vertex two material slots share stays put, so the slots still meet
  const slotOf = new Int32Array(m.vertex_count).fill(-1);
  const lock = new Uint8Array(m.vertex_count);
  bySlot.forEach((tris, s) => {
    for (const t of tris)
      for (let c = 0; c < 3; c++) {
        const v = m.indices[t * 3 + c]!;
        if (slotOf[v] === -1) slotOf[v] = s;
        else if (slotOf[v] !== s) lock[v] = 1;
      }
  });
  const uv = new Float32Array(m.uv);
  // split copies of one source vertex are locked together
  const copies = new Map<number, number[]>();
  for (let v = 0; v < m.vertex_count; v++) {
    const id = m.vertex ? m.vertex[v]! : v;
    (copies.get(id) ?? copies.set(id, []).get(id)!).push(v);
  }
  const simplify = (ratio: number) => {
    const tris: number[] = [], mat: number[] = [];
    let err = 0;
    bySlot.forEach((list, s) => {
      if (!list.length) return;
      const idx = new Uint32Array(list.length * 3);
      list.forEach((t, k) => idx.set(m.indices.subarray(t * 3, t * 3 + 3), k * 3));
      const target = Math.max(3, Math.floor((idx.length * ratio) / 3) * 3);
      const [out, e] = MeshoptSimplifier.simplifyWithAttributes(idx, m.position, 3, uv, 2, [UV_WEIGHT, UV_WEIGHT], lock, target, tol, ['ErrorAbsolute']);
      err = Math.max(err, e);
      for (const v of out) tris.push(v);
      for (let k = 0; k < out.length / 3; k++) mat.push(s);
    });
    return { tris: Uint32Array.from(tris), mat: Uint16Array.from(mat), err };
  };
  // towards the budget: short of it, ask for fewer; the error limit (and the locks) stop it
  // where the cards can't go further
  const toBudget = () => {
    let ratio = Math.min(1, budget / before);
    let r = simplify(ratio);
    for (let pass = 1; pass < 6; pass++) {
      const ids = new Set<number>();
      for (const v of r.tris) ids.add(m.vertex ? m.vertex[v]! : v);
      if (ids.size <= budget || ratio < 0.02) break;
      const next = ratio * (budget / ids.size) * 0.95;
      if (next >= ratio * 0.98) break;
      ratio = next;
      r = simplify(ratio);
    }
    return r;
  };
  let best = toBudget(), rounds = 1, locked = 0;
  for (; rounds < 12; rounds++) {
    // a kept vertex is on the result; the rest only need to be found within the limit
    const on = new Uint8Array(m.vertex_count);
    for (const v of best.tris) for (const c of copies.get(m.vertex ? m.vertex[v]! : v)!) on[c] = 1;
    // each vertex against the reduced triangles of its own material slot: a slot reduced away
    // under another (G8's scalp cap under the strands) is otherwise still "within reach"
    const d = new Float64Array(m.vertex_count);
    bySlot.forEach((list, s) => {
      if (!list.length) return;
      const tris: number[] = [];
      for (let k = 0; k < best.mat.length; k++) if (best.mat[k] === s) tris.push(best.tris[k * 3]!, best.tris[k * 3 + 1]!, best.tris[k * 3 + 2]!);
      const skip = Uint8Array.from(on, (x, v) => (x || slotOf[v] !== s ? 1 : 0));
      const ds = surfaceDistances(m.position, m.vertex_count, m.position, Uint32Array.from(tris), { on: skip, within: tol });
      for (let v = 0; v < m.vertex_count; v++) if (!skip[v]) d[v] = ds[v]!;
    });
    let strays = 0;
    const lockVertex = (v: number) => {
      if (lock[v]) return;
      for (const c of copies.get(m.vertex ? m.vertex[v]! : v)!) lock[c] = 1;
      strays++;
    };
    for (let v = 0; v < m.vertex_count; v++) if (d[v]! > tol) lockVertex(v);
    // and the other way: a reduced triangle must lie on its slot's original surface (a collapse
    // can stretch one across a gap or over another part of the texture); where its centre
    // doesn't, the original triangle nearest to it keeps its corners
    bySlot.forEach((list, s) => {
      const res: number[] = [];
      for (let k = 0; k < best.mat.length; k++) if (best.mat[k] === s) res.push(k);
      if (!res.length) return;
      const P = new Float32Array(res.length * 3), UV = new Float32Array(res.length * 2);
      res.forEach((k, i) => {
        for (let c = 0; c < 3; c++) {
          const v = best.tris[k * 3 + c]!;
          for (let e = 0; e < 3; e++) P[i * 3 + e]! += m.position[v * 3 + e]! / 3;
          for (let e = 0; e < 2; e++) UV[i * 2 + e]! += m.uv[v * 2 + e]! / 3;
        }
      });
      const orig = new Uint32Array(list.length * 3);
      list.forEach((t, k) => orig.set(m.indices.subarray(t * 3, t * 3 + 3), k * 3));
      const nearest = new Int32Array(res.length);
      const dc = surfaceDistances(P, res.length, m.position, orig, { within: tol, uv: { P: UV, Q: m.uv, weight: UV_WEIGHT }, nearest });
      res.forEach((_, i) => {
        if (dc[i]! <= tol || nearest[i]! < 0) return;
        for (let c = 0; c < 3; c++) lockVertex(orig[nearest[i]! * 3 + c]!);
      });
    });
    if (!strays) break;
    locked += strays;
    best = toBudget();
  }
  rebuild(m, best.tris, best.mat);
  return { before, after: sourceCount(m), error_mm: Math.round(best.err * 1e4) / 10, keys: m.morphs.length, rounds, locked };
}
