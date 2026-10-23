// Character Creator 3+ adapter: the cleaned import (cleanup.ts) -> the finisher's contract.
// A port of src/blender/adapt_cc.py, step for step; judged against its .blend dumped by
// dump_contract.py (tools/port/run_adapt.sh). Step numbers are adapt_cc.py's.

import { MAXW, type Contract, type Mesh, type Morph } from './contract.ts';
import { applyPoseAsRest, deformMesh, Pose, rotationAbout, type Vec3 } from './pose.ts';
import type { ImageCodec } from './images.ts';

export type CcReport = {
  cornea_triangles_removed: number;
  opacity_rewired: string[];
  arm_drop_deg: Record<string, number>;
  arkit_renamed: number;
  arkit_from_legacy: number;
  jaw_baked: Record<string, number>;
};

/** CC3 Traditional profile -> ARKit (adapt_cc.py LEGACY_ARKIT, same order). */
export const LEGACY_ARKIT: [string, Record<string, number>][] = [
  ['browInnerUp', { Brow_Raise_Inner_L: 1, Brow_Raise_Inner_R: 1 }],
  ['cheekPuff', { Cheek_Blow_L: 1, Cheek_Blow_R: 1 }],
  ['mouthPucker', { Mouth_Pucker: 1 }],
  ['mouthFunnel', { Mouth_Pucker_Open: 1 }],
  ['mouthRollUpper', { Mouth_Top_Lip_Under: 1 }],
  ['mouthRollLower', { Mouth_Bottom_Lip_Under: 1 }],
  ['mouthLeft', { Mouth_L: 1 }],
  ['mouthRight', { Mouth_R: 1 }],
  ['jawOpen', { Mouth_Open: 1 }],
];
for (const [arkit, cc] of [
  ['browDown', 'Brow_Drop'], ['browOuterUp', 'Brow_Raise_Outer'], ['eyeBlink', 'Eye_Blink'], ['eyeWide', 'Eye_Wide'],
  ['eyeSquint', 'Eye_Squint'], ['noseSneer', 'Nose_Flank_Raise'], ['cheekSquint', 'Cheek_Raise'], ['mouthSmile', 'Mouth_Smile'],
  ['mouthFrown', 'Mouth_Frown'], ['mouthDimple', 'Mouth_Dimple'], ['mouthUpperUp', 'Mouth_Snarl_Upper'], ['mouthLowerDown', 'Mouth_Snarl_Lower'],
] as const)
  for (const [side, s] of [['Left', 'L'], ['Right', 'R']] as const) LEGACY_ARKIT.push([arkit + side, { [`${cc}_${s}`]: 1 }]);

/** From CC3+'s 8 lip-sync shapes, chosen by render (ENVIRONMENT.md s15). */
export const VISEMES: [string, Record<string, number>][] = [
  ['viseme_aa', { Open: 1 }],
  ['viseme_E', { Wide: 1 }],
  ['viseme_I', { Wide: 0.6, Lip_Open: 0.4 }],
  ['viseme_O', { 'Tight-O': 0.7, Open: 0.3 }],
  ['viseme_U', { 'Tight-O': 1 }],
];

/** Jaw angles for keys CC drives with the jaw bone (adapt_cc.py JAW_DRIVEN, same order). */
const JAW_DRIVEN: [string, number][] = [
  ['jawOpen', 22], ['viseme_aa', 16], ['viseme_O', 10], ['viseme_U', 5], ['viseme_E', 5], ['viseme_I', 4],
];

/** `A25_Jaw_Open` -> `jawOpen` (Python str.lower / str.capitalize). */
export function arkitName(n: string): string | null {
  const m = /^A\d\d_(.+)$/.exec(n);
  if (!m) return null;
  const parts = m[1]!.split('_');
  return parts[0]!.toLowerCase() + parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('');
}

/** Python round(x, 1): half to even on the binary value. */
const round1 = (x: number) => {
  const y = x * 10, f = Math.floor(y), d = y - f;
  const r = d > 0.5 || (d === 0.5 && f % 2 !== 0) ? f + 1 : f;
  return r / 10;
};

/** A new key from a mix of existing ones (Blender shape_key_add from_mix). */
function mixKey(m: Mesh, name: string, mix: Record<string, number>): Morph {
  const d = new Float32Array(m.vertex_count * 3);
  for (const [k, w] of Object.entries(mix)) {
    const src = m.morphs.find((x) => x.name === k)!.delta;
    for (let i = 0; i < d.length; i++) d[i] = d[i]! + w * src[i]!;
  }
  return { name, shape: name, inbetweens: 0, delta: d };
}

/** Delete triangles, then the split vertices nothing uses any more (bmesh delete FACES). */
function dropTriangles(m: Mesh, dead: (t: number) => boolean): number {
  const keepTri: number[] = [];
  for (let t = 0; t < m.triangle_count; t++) if (!dead(t)) keepTri.push(t);
  const removed = m.triangle_count - keepTri.length;
  if (!removed) return 0;
  const used = new Int32Array(m.vertex_count).fill(-1);
  let n = 0;
  for (const t of keepTri) for (let c = 0; c < 3; c++) {
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

export async function adaptCc(clean: Contract, name: string, codec: ImageCodec): Promise<{ contract: Contract; report: CcReport }> {
  const report: CcReport = { cornea_triangles_removed: 0, opacity_rewired: [], arm_drop_deg: {}, arkit_renamed: 0, arkit_from_legacy: 0, jaw_baked: {} };
  // deep enough a copy that the input stays as it was
  const bones = clean.bones.map((b) => ({ ...b, matrix: b.matrix.slice() }));
  let meshes: Mesh[] = clean.meshes.map((m) => ({ ...m, morphs: m.morphs.map((k) => ({ ...k })) }));
  const materials = clean.materials.map((m) => ({ ...m, ...(m.pbr ? { pbr: { ...m.pbr } } : {}) }));

  // --- 1. a CC rig ------------------------------------------------------------------------------
  if (!bones.some((b) => b.name === 'CC_Base_Hip')) throw new Error('not a CC3 rig (no CC_Base_Hip)');
  const body = meshes.find((m) => m.name.startsWith('CC_Base_Body'));
  if (!body) throw new Error('no CC_Base_Body mesh');

  // --- 2. drop transparent overlays ----------------------------------------------------------------
  meshes = meshes.filter((m) => !/^CC_Base_(EyeOcclusion|TearLine)/.test(m.name));
  for (const m of meshes) {
    const dead = new Set(m.materials.map((n, i) => (n.toLowerCase().includes('cornea') ? i : -1)).filter((i) => i >= 0));
    if (dead.size) report.cornea_triangles_removed += dropTriangles(m, (t) => dead.has(m.triangle_material[t]!));
  }

  // --- 2b. opacity maps the importer left unwired ------------------------------------------------
  // Blender names an image after its Texture element (basename, no extension on CC exports)
  const imageByName = new Map<string, string>();
  for (const t of (clean as Contract & { texture_elements?: { name: string; fnv: string }[] }).texture_elements ?? []) {
    const n = t.name.split(/[\\/]/).pop()!;
    if (!imageByName.has(n)) imageByName.set(n, t.fnv);
  }
  const imageData = new Map(clean.images.map((i) => [i.fnv, i.data]));
  const used = new Set(meshes.flatMap((m) => m.materials));
  for (const mat of materials.filter((x) => used.has(x.name) && x.pbr)) {
    const op = imageByName.get(`${mat.name}_Opacity`);
    if (!op) continue;
    const pbr = mat.pbr!;
    if (pbr.alpha_tex) {
      if (pbr.alpha_tex === op) continue;
      const data = imageData.get(pbr.alpha_tex);
      if (data?.length) {
        const px = await codec.decode(data);
        let clear = 0;
        for (let i = 3; i < px.data.length; i += 4) if (px.data[i]! / 255 < 0.5) clear++;
        if (clear / (px.data.length / 4) > 0.01) continue; // the wired alpha already cuts something out
      }
    }
    pbr.alpha_tex = op;
    pbr.alpha_channel = 'color';
    report.opacity_rewired.push(mat.name);
  }
  report.opacity_rewired.sort();

  // --- 3. T-pose ---------------------------------------------------------------------------------------
  const pose = new Pose(bones);
  const chains: [string, string, string, number][] = [
    ['CC_Base_L_Upperarm', 'CC_Base_L_Forearm', 'CC_Base_L_Hand', 1],
    ['CC_Base_R_Upperarm', 'CC_Base_R_Forearm', 'CC_Base_R_Hand', -1],
  ];
  for (const [up, , hand] of chains) {
    const a = pose.head(pose.bone(up)), h = pose.head(pose.bone(hand));
    // Blender: atan2(-v.z, |v.x|) with Z up; here Y is up
    report.arm_drop_deg[up] = round1((Math.atan2(-(h[1] - a[1]), Math.abs(h[0] - a[0])) * 180) / Math.PI);
  }
  if (Math.max(...Object.values(report.arm_drop_deg).map(Math.abs)) > 3) {
    for (const [up, low, hand, sign] of chains) {
      pose.aim(pose.bone(up), pose.bone(low), [sign, 0, 0]);
      pose.aim(pose.bone(low), pose.bone(hand), [sign, 0, 0]);
    }
    applyPoseAsRest(pose, meshes);
  }

  // --- 4. rename ARKit keys --------------------------------------------------------------------------
  for (const m of meshes) {
    const names = new Set(m.morphs.map((k) => k.name));
    for (const k of m.morphs) {
      const n = arkitName(k.name);
      if (n && !names.has(n)) {
        names.delete(k.name);
        names.add(n);
        k.name = k.shape = n;
        report.arkit_renamed++;
      }
    }
  }

  // --- 4b. no ARKit set: mix it from the Traditional morphs -----------------------------------------
  for (const m of meshes) {
    if (!m.morphs.length || m.morphs.some((k) => k.name === 'eyeBlinkLeft')) continue;
    for (const [n, mix] of LEGACY_ARKIT) {
      const have = new Set(m.morphs.map((k) => k.name));
      if (have.has(n) || !Object.keys(mix).every((k) => have.has(k))) continue;
      m.morphs.push(mixKey(m, n, mix));
      report.arkit_from_legacy++;
    }
  }

  // --- 5. visemes ----------------------------------------------------------------------------------------
  for (const m of meshes) {
    if (!m.morphs.length) continue;
    for (const [n, mix] of VISEMES) {
      const have = new Set(m.morphs.map((k) => k.name));
      if (Object.keys(mix).every((k) => have.has(k))) m.morphs.push(mixKey(m, n, mix));
    }
  }

  // --- 6. teeth + tongue follow the jaw ----------------------------------------------------------------
  const jaw = pose.bone('CC_Base_JawRoot');
  const pivot = pose.head(jaw);
  // chin = body vertices > 0.9 on the jaw, each source vertex once (Blender averages its vertices)
  const chin: number[] = [];
  const seenV = new Set<number>();
  for (let v = 0; v < body.vertex_count; v++) {
    let w = 0;
    for (let k = 0; k < MAXW; k++) if (body.joints[v * MAXW + k] === jaw) w += body.weights[v * MAXW + k]!;
    const id = body.vertex ? body.vertex[v]! : v;
    if (w > 0.9 && !seenV.has(id)) {
      seenV.add(id);
      chin.push(v);
    }
  }
  const centroid = (d: Float32Array | null): Vec3 => {
    const c: Vec3 = [0, 0, 0];
    for (const v of chin) for (let r = 0; r < 3; r++) c[r] = c[r]! + body.position[v * 3 + r]! + (d ? d[v * 3 + r]! : 0);
    return c.map((x) => x / chin.length) as Vec3;
  };
  // Blender: atan2(z, y) in its frame = atan2(y, -z) here
  const chinAt = (c: Vec3) => Math.atan2(c[1] - pivot[1], -(c[2] - pivot[2]));
  const a0 = chinAt(centroid(null));
  const jawKeys = new Map<string, number>();
  for (const k of body.morphs) {
    const ang = ((chinAt(centroid(k.delta)) - a0) * 180) / Math.PI;
    if (Math.abs(ang) > 1) jawKeys.set(k.name, round1(ang));
  }

  const jawPose = (deg: number) => {
    pose.reset();
    pose.transformSubtree(jaw, rotationAbout([1, 0, 0], (deg * Math.PI) / 180, pivot));
    return pose.skinning();
  };
  const driven = JAW_DRIVEN.filter(([n]) => n !== 'jawOpen' || report.arkit_renamed > 0);
  for (const [n, ang] of driven) {
    if (!body.morphs.some((k) => k.name === n)) continue;
    const S = jawPose(ang);
    for (const m of [body, ...meshes.filter((x) => x !== body && x.morphs.some((k) => k.name === n))]) {
      const key = m.morphs.find((k) => k.name === n)!;
      // capture with only this key at 1, posed; the key becomes that shape (relative to the unposed basis)
      const shifted = { ...m, position: m.position.map((p, i) => p + key.delta[i]!) };
      const posed = deformMesh(shifted, S).position;
      key.delta = posed.map((p, i) => p - m.position[i]!);
    }
    jawKeys.set(n, ang);
  }
  const followers = meshes.filter((m) => /^CC_Base_(Teeth|Tongue)/.test(m.name));
  for (const [n, ang] of jawKeys) {
    const S = jawPose(ang);
    for (const m of followers) {
      const posed = deformMesh(m, S).position;
      let key = m.morphs.find((k) => k.name === n);
      if (!key) {
        key = { name: n, shape: n, inbetweens: 0, delta: new Float32Array(m.vertex_count * 3) };
        m.morphs.push(key);
      }
      // existing keys (tongueOut) keep their own shape, plus the jaw
      const d = key.delta;
      key.delta = posed.map((p, i) => p - m.position[i]! + d[i]!);
    }
  }
  pose.reset();
  report.jaw_baked = Object.fromEntries(jawKeys);

  // --- 7. names ------------------------------------------------------------------------------------------
  for (const m of meshes) {
    const short = m === body ? 'body' : m.name.replaceAll('CC_Base_', '').split('.')[0]!;
    m.name = m.mesh = `${name}.${short}`;
  }

  return { contract: { ...clean, source: 'ts-adapt-cc', bones, meshes, materials }, report };
}
