// What both adapters share (common.py's helpers and Blender operations they lean on).

import { MAXW, type Mesh, type Morph } from './contract.ts';
import { applyPoseAsRest, type Pose } from './pose.ts';

/** Python round(x, 1): half to even on the binary value. */
export const round1 = (x: number) => {
  const y = x * 10, f = Math.floor(y), d = y - f;
  const r = d > 0.5 || (d === 0.5 && f % 2 !== 0) ? f + 1 : f;
  return r / 10;
};

/** A new key from a mix of existing ones (Blender shape_key_add from_mix). */
export function mixKey(m: Mesh, name: string, mix: Record<string, number>): Morph {
  const d = new Float32Array(m.vertex_count * 3);
  for (const [k, w] of Object.entries(mix)) {
    const src = m.morphs.find((x) => x.name === k)!.delta;
    for (let i = 0; i < d.length; i++) d[i] = d[i]! + w * src[i]!;
  }
  return { name, shape: name, inbetweens: 0, delta: d };
}

/** Delete triangles, then the split vertices nothing uses any more (bmesh delete FACES). */
export function dropTriangles(m: Mesh, dead: (t: number) => boolean): number {
  const keepTri: number[] = [];
  for (let t = 0; t < m.triangle_count; t++) if (!dead(t)) keepTri.push(t);
  const removed = m.triangle_count - keepTri.length;
  if (!removed) return 0;
  const used = new Int32Array(m.vertex_count).fill(-1);
  let n = 0;
  for (const t of keepTri)
    for (let c = 0; c < 3; c++) {
      const v = m.indices[t * 3 + c]!;
      if (used[v] === -1) used[v] = n++;
    }
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
  const idx = new Uint32Array(keepTri.length * 3), tm = new Uint16Array(keepTri.length);
  keepTri.forEach((t, i) => {
    for (let c = 0; c < 3; c++) idx[i * 3 + c] = used[m.indices[t * 3 + c]!]!;
    tm[i] = m.triangle_material[t]!;
  });
  m.indices = idx;
  m.triangle_material = tm;
  m.vertex_count = n;
  m.triangle_count = keepTri.length;
  return removed;
}

/**
 * common.py tpose_arms: measure each arm's drop below horizontal; past 3 deg aim the upper
 * and lower arm along +-X and bake the pose as rest. Returns the drops (degrees, 0.1).
 */
export function tposeArms(pose: Pose, meshes: Mesh[], chains: [string, string, string, number][]): Record<string, number> {
  const drops: Record<string, number> = {};
  const restHead = (i: number): [number, number, number] => [pose.rest[i]![12]!, pose.rest[i]![13]!, pose.rest[i]![14]!];
  for (const [up, , hand] of chains) {
    // measured on the rest pose (bone.head_local), as tpose_arms does
    const a = restHead(pose.bone(up)), h = restHead(pose.bone(hand));
    // Blender: atan2(-v.z, |v.x|) with Z up; here Y is up
    drops[up] = round1((Math.atan2(-(h[1] - a[1]), Math.abs(h[0] - a[0])) * 180) / Math.PI);
  }
  if (Math.max(...Object.values(drops).map(Math.abs)) <= 3) return drops;
  for (const [up, low, hand, sign] of chains) {
    pose.aim(pose.bone(up), pose.bone(low), [sign, 0, 0]);
    pose.aim(pose.bone(low), pose.bone(hand), [sign, 0, 0]);
  }
  applyPoseAsRest(pose, meshes);
  return drops;
}

/** Distinct source vertices (Blender's vertices): the first split of each. */
export function sourceVertices(m: Mesh): number[] {
  const seen = new Set<number>(), out: number[] = [];
  for (let v = 0; v < m.vertex_count; v++) {
    const id = m.vertex ? m.vertex[v]! : v;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(v);
    }
  }
  return out;
}
