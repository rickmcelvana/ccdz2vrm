// Daz Genesis 3/8/8.1 adapter: the cleaned import (cleanup.ts) -> the finisher's contract.
// A port of src/blender/adapt_daz.py, step for step; judged against its .blend dumped by
// dump_contract.py (tools/port/run_adapt.sh daz). Step numbers are adapt_daz.py's.
//
// Two ways to a face: a Genesis 8.1 export with its FACS morphs mixes them into ARKit 52 +
// visemes (4b); otherwise the face bones are posed into each expression and frozen (4).

import { MAXW, type Contract, type Mesh } from './contract.ts';
import { dropTriangles, mixKey, sourceVertices, tposeArms } from './adaptCommon.ts';
import { deformMesh, identity, Pose, rotationAbout, type Vec3 } from './pose.ts';

export type DazReport = {
  family: string;
  overlay_triangles_removed: Record<string, number>;
  face_meshes: string[];
  face_source: 'facs_morphs' | 'face_bones';
  shape_keys_dropped: number;
  arm_drop_deg: Record<string, number>;
  shape_keys: Record<string, string[]>;
  noise_keys_dropped?: Record<string, number>;
  side_check_x?: Record<string, number | null>;
};

const OVERLAYS = ['cornea', 'eyemoisture', 'tear'];
const FACE_PARTS = ['lash', 'brow', 'beard', 'moustache', 'mustache', 'tear'];

// --- 4. bone-posed expressions: (op, bones, value), written for the LEFT side in Blender's frame
// (+x the character's left, -y forward, +z up; metres, degrees) and mirrored; `{s}` is l/r.
type Op = ['rot', string[], number] | ['move', string[], [number, number, number]];
const UPPER_LID = ['{s}EyelidUpper', '{s}EyelidUpperInner', '{s}EyelidUpperOuter'];
const LOWER_LID = ['{s}EyelidLower', '{s}EyelidLowerInner', '{s}EyelidLowerOuter'];
const LIPS_MID = ['LipUpperMiddle', 'LipLowerMiddle', 'lLipUpperInner', 'rLipUpperInner', 'lLipLowerInner', 'rLipLowerInner',
  'lLipUpperOuter', 'rLipUpperOuter', 'lLipLowerOuter', 'rLipLowerOuter'];
export const SIDED: [string, Op[]][] = [
  ['eyeBlink', [['rot', UPPER_LID, 34], ['rot', LOWER_LID, -8]]],
  ['eyeWide', [['rot', UPPER_LID, -10]]],
  ['eyeSquint', [['rot', LOWER_LID, -10], ['move', ['{s}SquintInner', '{s}SquintOuter'], [0, 0, 0.002]]]],
  ['mouthSmile', [['move', ['{s}LipCorner'], [0.005, 0.003, 0.006]], ['move', ['{s}NasolabialMouthCorner'], [0.003, 0.002, 0.004]],
    ['move', ['{s}CheekLower'], [0, 0, 0.003]]]],
  ['mouthFrown', [['move', ['{s}LipCorner'], [0.001, 0, -0.006]], ['move', ['{s}NasolabialMouthCorner'], [0, 0, -0.003]]]],
  ['mouthStretch', [['move', ['{s}LipCorner'], [0.006, 0.001, 0]]]],
  ['browDown', [['move', ['{s}BrowInner'], [-0.002, 0, -0.004]], ['move', ['{s}BrowMid', '{s}BrowOuter'], [0, 0, -0.003]]]],
  ['browOuterUp', [['move', ['{s}BrowOuter'], [0, 0, 0.005]], ['move', ['{s}BrowMid'], [0, 0, 0.003]]]],
  ['cheekSquint', [['move', ['{s}CheekUpper', '{s}SquintOuter'], [0, 0, 0.003]]]],
  ['noseSneer', [['move', ['{s}Nostril', '{s}NasolabialUpper'], [0, 0, 0.002]]]],
];
export const CENTRE: [string, Op[]][] = [
  ['jawOpen', [['rot', ['lowerJaw'], 18]]],
  ['browInnerUp', [['move', ['lBrowInner', 'rBrowInner'], [0, 0, 0.005]], ['move', ['CenterBrow'], [0, 0, 0.003]]]],
  ['mouthPucker', [['move', ['{s}LipCorner'], [-0.008, -0.003, 0]], ['move', LIPS_MID, [0, -0.004, 0]]]],
  ['mouthFunnel', [['move', ['{s}LipCorner'], [-0.005, -0.002, 0]], ['move', LIPS_MID, [0, -0.004, 0]], ['rot', ['lowerJaw'], 5]]],
  ['viseme_aa', [['rot', ['lowerJaw'], 16]]],
  ['viseme_E', [['rot', ['lowerJaw'], 8], ['move', ['{s}LipCorner'], [0.004, 0, 0]]]],
  ['viseme_I', [['rot', ['lowerJaw'], 6], ['move', ['{s}LipCorner'], [0.006, 0, 0.001]]]],
  ['viseme_O', [['rot', ['lowerJaw'], 12], ['move', ['{s}LipCorner'], [-0.005, -0.002, 0]], ['move', LIPS_MID, [0, -0.003, 0]]]],
  ['viseme_U', [['rot', ['lowerJaw'], 5], ['move', ['{s}LipCorner'], [-0.008, -0.003, 0]], ['move', LIPS_MID, [0, -0.005, 0]]]],
];

// --- 4b. FACS morphs -> ARKit 52 + visemes (bone-driven jnt_ + its own cbs_ corrective; div2 halves summed)
const FACS_SIDED: [string, string[]][] = [
  ['eyeBlink', ['jnt_EyeBlink{S}', 'cbs_EyeBlink{S}_div2']],
  ['eyeWide', ['jnt_EyeWide{S}', 'cbs_EyeWide{S}_div2']],
  ['eyeLookUp', ['jnt_EyeLookUp{S}', 'cbs_EyeLookUp{S}_div2']],
  ['eyeLookDown', ['jnt_EyeLookDown{S}', 'cbs_EyeLookDown{S}_div2']],
  ...['eyeSquint', 'eyeLookIn', 'eyeLookOut', 'browDown', 'browOuterUp', 'cheekSquint', 'noseSneer', 'mouthSmile', 'mouthFrown',
    'mouthDimple', 'mouthStretch', 'mouthPress', 'mouthUpperUp', 'mouthLowerDown']
    .map((stem): [string, string[]] => [stem, [`bs_${stem[0]!.toUpperCase()}${stem.slice(1)}{S}_div2`]]),
];
const FACS_CENTRE: [string, string[]][] = [
  ['browInnerUp', ['bs_BrowInnerUpLeft_div2', 'bs_BrowInnerUpRight_div2']],
  ['cheekPuff', ['bs_CheekPuffLeft_div2', 'bs_CheekPuffRight_div2']],
  ['jawOpen', ['jnt_JawOpen', 'cbs_JawOpen_div2']],
  ['jawLeft', ['jnt_JawLeft', 'cbs_JawLeft_div2']],
  ['jawRight', ['jnt_JawRight', 'cbs_JawRight_div2']],
  ['jawForward', ['jnt_JawForward', 'cbs_JawForward_div2']],
  ...['mouthPucker', 'mouthFunnel', 'mouthRollUpper', 'mouthRollLower', 'mouthShrugUpper', 'mouthShrugLower', 'mouthClose', 'mouthLeft',
    'mouthRight'].map((stem): [string, string[]] => [stem, [`bs_${stem[0]!.toUpperCase()}${stem.slice(1)}_div2`]]),
  ['tongueOut', ['bs_TongueOut']],
  ['viseme_aa', ['ctrl_vAA']], ['viseme_I', ['ctrl_vIY']], ['viseme_U', ['ctrl_vUW']], ['viseme_E', ['ctrl_vEH']], ['viseme_O', ['ctrl_vOW']],
];

/** `Genesis8_1Female__facs_bs_X` -> `facs_bs_X`. */
const facsName = (n: string) => (n.includes('__facs_') ? n.slice(n.indexOf('__') + 2) : n);
/** Blender frame -> glTF: (x, y, z) -> (x, z, -y). */
const gltf = (v: [number, number, number]): Vec3 => [v[0], v[2], -v[1]];

export function adaptDaz(clean: Contract, name: string): { contract: Contract; report: DazReport } {
  const bones = clean.bones.map((b) => ({ ...b, matrix: b.matrix.slice() }));
  const meshes: Mesh[] = clean.meshes.map((m) => ({ ...m, morphs: m.morphs.map((k) => ({ ...k })) }));
  const boneIndex = new Map(bones.map((b, i) => [b.name, i]));

  // --- 1. a Genesis 3/8 rig; the figure is the biggest mesh skinned to a face bone ----------------
  const family = boneIndex.has('lShldrBend') && boneIndex.has('lEyelidUpper') ? 'genesis3_8' : boneIndex.has('lShldr') ? 'genesis1_2' : 'unknown';
  if (family !== 'genesis3_8') throw new Error(`unsupported Daz rig family: ${family}`);
  const lid = boneIndex.get('lEyelidUpper')!;
  const usesLid = (m: Mesh) => {
    for (let v = 0; v < m.vertex_count; v++) for (let k = 0; k < MAXW; k++) if (m.joints[v * MAXW + k] === lid && m.weights[v * MAXW + k]! > 0) return true;
    return false;
  };
  const body = meshes.reduce((best, m) => (usesLid(m) && sourceVertices(m).length > (best ? sourceVertices(best).length : -1) ? m : best), null as Mesh | null);
  if (!body) throw new Error('no mesh skinned to the face bones');
  for (const m of meshes) {
    // "Audrey Hair_363327.Shape" -> "Audrey Hair"; "Genesis8_1FemaleEyelashes" kept whole
    m.name = m.mesh = m === body ? `${name}.body` : `${name}.${m.name.replace(/(_[0-9]+)?(\.Shape)?(\.[0-9]+)?$/, '')}`;
  }
  const report: DazReport = {
    family, overlay_triangles_removed: {}, face_meshes: [], face_source: 'face_bones', shape_keys_dropped: 0, arm_drop_deg: {}, shape_keys: {},
  };

  // --- 2. drop transparent eye overlays (every mesh: G8 lashes carry their own EyeMoisture) --------
  for (const m of meshes) {
    const dead = new Set(m.materials.map((n, i) => (OVERLAYS.some((k) => n.toLowerCase().includes(k)) ? i : -1)).filter((i) => i >= 0));
    if (dead.size) report.overlay_triangles_removed[m.name] = dropTriangles(m, (t) => dead.has(m.triangle_material[t]!));
  }

  // --- 2b. FACS morphs: face meshes keep theirs, renamed; everything else drops its keys --------------
  const faceMeshes = meshes.filter((m) => m === body || FACE_PARTS.some((k) => m.name.toLowerCase().includes(k)));
  report.face_meshes = faceMeshes.map((m) => m.name);
  const hasFacs = body.morphs.some((k) => facsName(k.name).startsWith('facs_'));
  report.face_source = hasFacs ? 'facs_morphs' : 'face_bones';
  for (const m of meshes) {
    if (!m.morphs.length) continue;
    if (!faceMeshes.includes(m) || !hasFacs) {
      report.shape_keys_dropped += m.morphs.length;
      m.morphs = [];
    } else for (const k of m.morphs) k.name = k.shape = facsName(k.name);
  }

  // --- 3. rest pose must be a T-pose (Genesis 8 rests in an A-pose; G3 in a T already) --------------
  const pose = new Pose(bones);
  report.arm_drop_deg = tposeArms(pose, meshes, [
    ['lShldrBend', 'lForearmBend', 'lHand', 1],
    ['rShldrBend', 'rForearmBend', 'rHand', -1],
  ]);

  if (hasFacs) {
    // --- 4b. FACS -> ARKit 52 + visemes ------------------------------------------------------------
    const table: [string, string[]][] = [
      ...FACS_SIDED.flatMap(([stem, srcs]) => (['Left', 'Right'] as const).map((side): [string, string[]] => [`${stem}${side}`, srcs.map((s) => s.replace('{S}', side))])),
      ...FACS_CENTRE,
    ];
    const missing = new Set<string>();
    for (const m of faceMeshes) {
      if (!m.morphs.length) continue;
      for (const [n, srcs] of table) {
        const have = new Set(m.morphs.map((k) => k.name));
        const present = srcs.filter((s) => have.has(`facs_${s}`));
        if (m === body) for (const s of srcs) if (!have.has(`facs_${s}`)) missing.add(s);
        if (!present.length) continue;
        m.morphs.push(mixKey(m, n, Object.fromEntries(present.map((s) => [`facs_${s}`, 1]))));
        (report.shape_keys[n] ??= []).push(m.name);
      }
      m.morphs = m.morphs.filter((k) => !k.name.startsWith('facs_'));
    }
    if (missing.size) throw new Error(`FACS export lacks ${[...missing].toSorted().join(', ')}`);
    report.noise_keys_dropped = dropNoise(faceMeshes);
    report.side_check_x = Object.fromEntries(['eyeBlinkLeft', 'mouthSmileLeft', 'browDownLeft'].map((k) => [k, sideCheck(body, k)]));
    if (Object.values(report.side_check_x).some((x) => x === null || x <= 0))
      throw new Error(`FACS Left keys are not on the character's left: ${JSON.stringify(report.side_check_x)}`);
  } else {
    // --- 4. pose the face bones into each expression and freeze it ------------------------------------
    const restHead = (i: number): Vec3 => [pose.rest[i]![12]!, pose.rest[i]![13]!, pose.rest[i]![14]!];
    const freeze = (key: string, ops: [Op[0], number, number | Vec3][]) => {
      pose.reset();
      for (const [op, i, v] of ops) {
        if (op === 'rot') pose.transformSubtree(i, rotationAbout([1, 0, 0], ((v as number) * Math.PI) / 180, restHead(i)));
        else {
          const T = identity();
          [T[12], T[13], T[14]] = v as Vec3;
          pose.transformSubtree(i, T);
        }
      }
      const S = pose.skinning();
      const touched: string[] = [];
      for (const m of faceMeshes) {
        const posed = deformMesh(m, S).position;
        let moved = 0;
        for (const v of sourceVertices(m))
          moved = Math.max(moved, Math.hypot(posed[v * 3]! - m.position[v * 3]!, posed[v * 3 + 1]! - m.position[v * 3 + 1]!, posed[v * 3 + 2]! - m.position[v * 3 + 2]!));
        if (moved <= 1e-5) continue;
        m.morphs.push({ name: key, shape: key, inbetweens: 0, delta: posed.map((p, i) => p - m.position[i]!) });
        touched.push(m.name);
      }
      return touched;
    };
    const expand = (ops: Op[], sides: ('l' | 'r')[]): [Op[0], number, number | Vec3][] =>
      ops.flatMap(([op, names, val]) =>
        names.flatMap((n) =>
          (n.includes('{s}') ? sides : sides.slice(0, 1)).map((side): [Op[0], number, number | Vec3] => {
            const bone = n.replace('{s}', side);
            const i = boneIndex.get(bone);
            if (i === undefined) throw new Error(`missing face bone ${bone}`);
            if (op === 'rot') return [op, i, val];
            const v = n.includes('{s}') && side === 'r' ? ([-val[0], val[1], val[2]] as [number, number, number]) : val;
            return [op, i, gltf(v)];
          }),
        ),
      );
    for (const [stem, ops] of SIDED)
      for (const [side, suffix] of [['l', 'Left'], ['r', 'Right']] as const) report.shape_keys[stem + suffix] = freeze(stem + suffix, expand(ops, [side]));
    for (const [n, ops] of CENTRE) report.shape_keys[n] = freeze(n, expand(ops, ['l', 'r']));
    pose.reset();
  }

  return { contract: { ...clean, source: 'ts-adapt-daz', bones, meshes }, report };
}

/** adapt_daz.py drop_noise: zero per-vertex deltas under 0.05 mm, drop keys left empty. */
function dropNoise(faceMeshes: Mesh[], eps = 5e-5): Record<string, number> {
  const dropped: Record<string, number> = {};
  for (const m of faceMeshes) {
    if (!m.morphs.length || !m.vertex_count) continue;
    m.morphs = m.morphs.filter((k) => {
      const d = k.delta;
      let any = false;
      for (let v = 0; v < m.vertex_count; v++) {
        if (Math.hypot(d[v * 3]!, d[v * 3 + 1]!, d[v * 3 + 2]!) < eps) d.fill(0, v * 3, v * 3 + 3);
        else any = true;
      }
      if (!any) dropped[m.name] = (dropped[m.name] ?? 0) + 1;
      return any;
    });
  }
  return dropped;
}

/** Mean x of the body vertices a key moves: ARKit `Left` is the character's left (+x). */
function sideCheck(body: Mesh, key: string): number | null {
  const k = body.morphs.find((x) => x.name === key);
  if (!k) return null;
  let sum = 0, n = 0;
  for (const v of sourceVertices(body))
    if (Math.hypot(k.delta[v * 3]!, k.delta[v * 3 + 1]!, k.delta[v * 3 + 2]!) > 1e-4) {
      sum += body.position[v * 3]!;
      n++;
    }
  return n ? Math.round((sum / n) * 1e4) / 1e4 : null;
}
