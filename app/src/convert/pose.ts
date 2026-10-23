// Posing a contract the way Blender's armature modifier deforms it, and baking a pose into
// the rest pose with every shape key kept exact (common.py apply_pose_as_rest, aim_bone).
//
// Matrices are column-major 4x4 (glTF), affine. Skinning is Blender's: the offsets of every
// weighted bone, divided by the vertex's total weight; a vertex with no weight stays put.
// That is linear in the rest position, so a key's delta deforms by the matrices' linear part
// with the same weights -- exactly what capturing each key at 1 gives in Blender.

import { MAXW, type Bone, type Mesh } from './contract.ts';

export type Mat4 = Float64Array;
export type Vec3 = [number, number, number];

export const identity = (): Mat4 => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      o[c * 4 + r] = s;
    }
  return o;
}

/** Inverse of an affine matrix (general 3x3 part). */
export function invert(m: Mat4): Mat4 {
  const [a, b, c, d, e, f, g, h, i] = [m[0]!, m[4]!, m[8]!, m[1]!, m[5]!, m[9]!, m[2]!, m[6]!, m[10]!];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const inv = [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ]; // row-major 3x3
  const t = [m[12]!, m[13]!, m[14]!];
  const o = identity();
  for (let r = 0; r < 3; r++) {
    for (let col = 0; col < 3; col++) o[col * 4 + r] = inv[r * 3 + col]!;
    o[12 + r] = -(inv[r * 3]! * t[0]! + inv[r * 3 + 1]! * t[1]! + inv[r * 3 + 2]! * t[2]!);
  }
  return o;
}

export const translation = (m: Mat4 | number[]): Vec3 => [m[12]!, m[13]!, m[14]!];

/** Rotation by `angle` radians about unit `axis` through `pivot` (Rodrigues). */
export function rotationAbout(axis: Vec3, angle: number, pivot: Vec3): Mat4 {
  const [x, y, z] = axis, c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  const R = new Float64Array([
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ]);
  const T = identity(), Ti = identity();
  [T[12], T[13], T[14]] = pivot;
  [Ti[12], Ti[13], Ti[14]] = [-pivot[0], -pivot[1], -pivot[2]];
  return mul(T, mul(R, Ti));
}

/** mathutils Vector.rotation_difference: the shortest rotation taking `from` onto `to`, as axis + angle. */
export function rotationDifference(from: Vec3, to: Vec3): { axis: Vec3; angle: number } {
  const n = (v: Vec3) => Math.hypot(...v);
  const a = from.map((x) => x / n(from)) as Vec3, b = to.map((x) => x / n(to)) as Vec3;
  const cross: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const angle = Math.atan2(n(cross), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
  const l = n(cross);
  return { axis: l > 1e-12 ? (cross.map((x) => x / l) as Vec3) : [1, 0, 0], angle };
}

/** A pose over a contract's bones: world matrices, starting at rest. */
export class Pose {
  readonly bones: Bone[];
  readonly rest: Mat4[];
  world: Mat4[];
  readonly index: Map<string, number>;
  readonly children: number[][];

  constructor(bones: Bone[]) {
    this.bones = bones;
    this.rest = bones.map((b) => new Float64Array(b.matrix));
    // starts in the file's saved pose where there is one, as Blender's pose does after import
    this.world = bones.map((b, i) => new Float64Array(b.pose ?? this.rest[i]!));
    this.index = new Map(bones.map((b, i) => [b.name, i]));
    this.children = bones.map(() => []);
    bones.forEach((b, i) => {
      const p = b.parent === null ? undefined : this.index.get(b.parent);
      if (p !== undefined) this.children[p]!.push(i);
    });
  }

  bone(name: string): number {
    const i = this.index.get(name);
    if (i === undefined) throw new Error(`no bone ${name}`);
    return i;
  }

  head(i: number): Vec3 {
    return translation(this.world[i]!);
  }

  reset(): void {
    this.world = this.rest.map((m) => new Float64Array(m));
  }

  /** Apply world-space transform R to bone i and everything below it (a pose bone's matrix). */
  transformSubtree(i: number, R: Mat4): void {
    const stack = [i];
    while (stack.length) {
      const j = stack.pop()!;
      this.world[j] = mul(R, this.world[j]!);
      stack.push(...this.children[j]!);
    }
  }

  /** common.py aim_bone: turn bone i about its head so head -> child's head points along dir. */
  aim(i: number, child: number, dir: Vec3): void {
    const h = this.head(i), c = this.head(child);
    const { axis, angle } = rotationDifference([c[0] - h[0], c[1] - h[1], c[2] - h[2]], dir);
    this.transformSubtree(i, rotationAbout(axis, angle, h));
  }

  /** Skinning matrices: posed world x inverse rest world. */
  skinning(): Mat4[] {
    return this.world.map((w, i) => mul(w, invert(this.rest[i]!)));
  }
}

/**
 * Blender's armature deform of one mesh: returns new positions (and, given deltas, the new
 * deltas). Bones whose skinning matrix is the identity are skipped as a fast path.
 */
export function deformMesh(
  m: Mesh,
  S: Mat4[],
  deltas: Float32Array[] = [],
): { position: Float32Array; normal: Float32Array | undefined; deltas: Float32Array[] } {
  const moving = S.map((s) => s.some((x, k) => Math.abs(x - (k % 5 === 0 ? 1 : 0)) > 1e-15));
  const position = new Float32Array(m.position);
  const normal = m.normal ? new Float32Array(m.normal) : undefined;
  const out = deltas.map((d) => new Float32Array(d));
  for (let v = 0; v < m.vertex_count; v++) {
    let total = 0, any = false;
    for (let k = 0; k < MAXW; k++) {
      const w = m.weights[v * MAXW + k]!;
      if (w > 0) {
        total += w;
        if (moving[m.joints[v * MAXW + k]!]) any = true;
      }
    }
    if (!any || total <= 0.0001) continue;
    const px = m.position[v * 3]!, py = m.position[v * 3 + 1]!, pz = m.position[v * 3 + 2]!;
    let x = 0, y = 0, z = 0;
    const lin = new Float64Array(9);
    for (let k = 0; k < MAXW; k++) {
      const w = m.weights[v * MAXW + k]!;
      if (!(w > 0)) continue;
      const s = S[m.joints[v * MAXW + k]!]!;
      x += w * (s[0]! * px + s[4]! * py + s[8]! * pz + s[12]!);
      y += w * (s[1]! * px + s[5]! * py + s[9]! * pz + s[13]!);
      z += w * (s[2]! * px + s[6]! * py + s[10]! * pz + s[14]!);
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) lin[c * 3 + r] = lin[c * 3 + r]! + w * s[c * 4 + r]!;
    }
    position[v * 3] = x / total;
    position[v * 3 + 1] = y / total;
    position[v * 3 + 2] = z / total;
    if (normal && m.normal) {
      // the blended linear part, renormalised (rotations only here: no inverse-transpose needed)
      const nx = m.normal[v * 3]!, ny = m.normal[v * 3 + 1]!, nz = m.normal[v * 3 + 2]!;
      const ox = lin[0]! * nx + lin[3]! * ny + lin[6]! * nz;
      const oy = lin[1]! * nx + lin[4]! * ny + lin[7]! * nz;
      const oz = lin[2]! * nx + lin[5]! * ny + lin[8]! * nz;
      const l = Math.hypot(ox, oy, oz) || 1;
      normal[v * 3] = ox / l;
      normal[v * 3 + 1] = oy / l;
      normal[v * 3 + 2] = oz / l;
    }
    deltas.forEach((d, q) => {
      const dx = d[v * 3]!, dy = d[v * 3 + 1]!, dz = d[v * 3 + 2]!;
      if (!dx && !dy && !dz) return;
      const o = out[q]!;
      for (let r = 0; r < 3; r++) o[v * 3 + r] = (lin[r]! * dx + lin[3 + r]! * dy + lin[6 + r]! * dz) / total;
    });
  }
  return { position, normal, deltas: out };
}

/**
 * Normals after a pose is baked. Blender keeps FBX custom normals in a per-corner space built
 * from the vertex's angle-weighted surface normal and an edge (its "lnor space"), so they
 * follow the deformed surface, twist included; blending them with the bone matrices was 6 deg
 * off at the shoulders after the A -> T pose (ENVIRONMENT.md s33). Here each source vertex gets
 * that frame -- angle-weighted normal + its first edge -- at rest and posed, and its normals
 * are carried from one frame to the other.
 */
function transportNormals(m: Mesh, rest: Float32Array, posed: Float32Array, skinned: Float32Array | undefined): Float32Array | undefined {
  if (!m.normal) return undefined;
  const weight = new Map<number, number>(); // sum of corner angles: |normal sum| / this = how coherent
  // Blender's spaces are per smooth fan (the corners of a vertex between hard edges); corners in
  // one fan share their custom normal, so source vertex + normal value stands in for the fan
  const nrm = m.normal;
  const fans = new Map<string, number>();
  const fanOf = new Int32Array(m.vertex_count);
  for (let v = 0; v < m.vertex_count; v++) {
    const k = `${m.vertex ? m.vertex[v]! : v}:${nrm[v * 3]},${nrm[v * 3 + 1]},${nrm[v * 3 + 2]}`;
    if (!fans.has(k)) fans.set(k, fans.size);
    fanOf[v] = fans.get(k)!;
  }
  const id = (v: number) => fanOf[v]!;
  const nRest = new Map<number, Vec3>(), nPosed = new Map<number, Vec3>(), ref = new Map<number, [number, number]>();
  const add = (map: Map<number, Vec3>, k: number, x: number, y: number, z: number, w: number) => {
    const s = map.get(k) ?? [0, 0, 0];
    map.set(k, [s[0] + x * w, s[1] + y * w, s[2] + z * w]);
  };
  for (let t = 0; t < m.triangle_count; t++) {
    const c = [m.indices[t * 3]!, m.indices[t * 3 + 1]!, m.indices[t * 3 + 2]!];
    for (const [pos, map] of [[rest, nRest], [posed, nPosed]] as const) {
      const p = c.map((v) => [pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!]);
      const e1 = [0, 1, 2].map((r) => p[1]![r]! - p[0]![r]!), e2 = [0, 1, 2].map((r) => p[2]![r]! - p[0]![r]!);
      const fn = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const fl = Math.hypot(...fn);
      if (fl < 1e-30) continue;
      for (let k = 0; k < 3; k++) {
        const a = p[(k + 1) % 3]!.map((x, r) => x - p[k]![r]!), b = p[(k + 2) % 3]!.map((x, r) => x - p[k]![r]!);
        const ang = Math.acos(Math.max(-1, Math.min(1, (a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) / ((Math.hypot(...a) * Math.hypot(...b)) || 1))));
        add(map, id(c[k]!), fn[0]! / fl, fn[1]! / fl, fn[2]! / fl, ang);
        if (map === nRest) weight.set(id(c[k]!), (weight.get(id(c[k]!)) ?? 0) + ang);
      }
    }
  }
  // each vertex's reference edge: the one most perpendicular to its rest normal (an edge nearly
  // along the normal leaves the frame's twist to float-rounding noise)
  const best = new Map<number, number>();
  for (let t = 0; t < m.triangle_count; t++)
    for (let k = 0; k < 3; k++) {
      const a = m.indices[t * 3 + k]!, b = m.indices[t * 3 + ((k + 1) % 3)]!, n = nRest.get(id(a));
      if (!n) continue;
      const e = [0, 1, 2].map((r) => rest[b * 3 + r]! - rest[a * 3 + r]!), el = Math.hypot(...e), nl = Math.hypot(...n);
      if (el < 1e-12 || nl < 1e-20) continue;
      const along = Math.abs(e[0]! * n[0] + e[1]! * n[1] + e[2]! * n[2]) / (el * nl);
      if (along < (best.get(id(a)) ?? Infinity)) {
        best.set(id(a), along);
        ref.set(id(a), [a, b]);
      }
    }
  // an orthonormal frame (tangent, bitangent, normal) from a normal and an edge
  const frame = (n: Vec3, from: number, to: number, pos: Float32Array): number[] | null => {
    const nl = Math.hypot(...n);
    if (nl < 1e-20) return null;
    const N = n.map((x) => x / nl);
    const e = [0, 1, 2].map((r) => pos[to * 3 + r]! - pos[from * 3 + r]!);
    const d = e[0]! * N[0]! + e[1]! * N[1]! + e[2]! * N[2]!;
    const T = e.map((x, r) => x - d * N[r]!), tl = Math.hypot(...T);
    if (tl < 1e-20) return null;
    T.forEach((x, r) => (T[r] = x / tl));
    const B = [N[1]! * T[2]! - N[2]! * T[1]!, N[2]! * T[0]! - N[0]! * T[2]!, N[0]! * T[1]! - N[1]! * T[0]!];
    return [...T, ...B, ...N];
  };
  const out = new Float32Array(m.normal);
  const R = new Map<number, number[] | null>();
  for (let v = 0; v < m.vertex_count; v++) {
    const k = id(v);
    // a vertex the pose did not move keeps its normal (frames rebuilt from float32 positions
    // would add a few hundredths of a degree of noise)
    if (posed[v * 3] === rest[v * 3] && posed[v * 3 + 1] === rest[v * 3 + 1] && posed[v * 3 + 2] === rest[v * 3 + 2]) continue;
    // where the faces around a vertex point opposite ways (a two-layer cloth sharing its
    // vertices) the summed normal is no frame at all: blend with the bones instead
    const nr = nRest.get(k);
    if (!nr || Math.hypot(...nr) < 0.5 * (weight.get(k) ?? 0)) {
      if (skinned) out.set(skinned.subarray(v * 3, v * 3 + 3), v * 3);
      continue;
    }
    if (!R.has(k)) {
      const r = ref.get(k);
      const f0 = r && nRest.get(k) ? frame(nRest.get(k)!, r[0], r[1], rest) : null;
      const f1 = r && nPosed.get(k) ? frame(nPosed.get(k)!, r[0], r[1], posed) : null;
      R.set(k, f0 && f1 ? [f0, f1].flat() : null);
    }
    const f = R.get(k);
    if (!f) continue;
    const nx = m.normal[v * 3]!, ny = m.normal[v * 3 + 1]!, nz = m.normal[v * 3 + 2]!;
    // coordinates in the rest frame, rebuilt in the posed frame
    const ct = nx * f[0]! + ny * f[1]! + nz * f[2]!, cb = nx * f[3]! + ny * f[4]! + nz * f[5]!, cn = nx * f[6]! + ny * f[7]! + nz * f[8]!;
    for (let r = 0; r < 3; r++) out[v * 3 + r] = ct * f[9 + r]! + cb * f[12 + r]! + cn * f[15 + r]!;
  }
  return out;
}

/**
 * common.py apply_pose_as_rest: the pose becomes the rest pose, every key kept exact.
 * `normals`: 'surface' where Blender bakes the pose into the mesh (the adapters' A -> T: its
 * custom normals follow the surface); 'skinned' where Blender leaves the mesh at bind and only
 * poses the bones (the add-on's export T-pose: a runtime blends normals with the bones).
 */
export function applyPoseAsRest(pose: Pose, meshes: Mesh[], normals: 'surface' | 'skinned' = 'surface'): void {
  const S = pose.skinning();
  for (const m of meshes) {
    const r = deformMesh(m, S, m.morphs.map((k) => k.delta));
    m.normal = normals === 'surface' ? transportNormals(m, m.position, r.position, r.normal) : r.normal;
    m.position = r.position;
    m.morphs.forEach((k, q) => (k.delta = r.deltas[q]!));
  }
  pose.bones.forEach((b, i) => {
    b.matrix = Array.from(pose.world[i]!);
    delete b.pose; // baked
  });
  pose.rest.forEach((_, i) => (pose.rest[i] = new Float64Array(pose.world[i]!)));
}
