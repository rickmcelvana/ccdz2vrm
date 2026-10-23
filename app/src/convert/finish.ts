// The VRM finisher: an adapted contract -> a VRM 1.0 file. A port of src/blender/vrm_export.py
// (desktop, web and max tiers) plus what the VRM add-on and
// Blender's glTF exporter do on the way out. Step numbers are vrm_export.py's.
//
// Deliberate differences from the Blender file (ENVIRONMENT.md s33):
//  - bones are written with identity rotations (head positions only; the twist split's limb
//    bones get one limb-aligned frame); runtimes normalise bones anyway;
//  - no KHR_materials_specular textures and no empty vertex-colour sets (Blender's exporter
//    adds both; nothing of ours reads them);
//  - morph targets carry no normals (three-vrm lights expressions with the base normals,
//    as the web tier already did);
//  - unchanged source images are embedded as they are; re-encoded ones are JPEG unless they
//    need alpha (PNG); normal maps keep their source's format (generated ones PNG).

import { MAXW, type Contract, type Material, type Mesh, type Pbr } from './contract.ts';
import { GlbBuilder, type Json } from './glb.ts';
import { heightToNormal, mimeOf, palettePng, resize, stripPng, type ImageCodec, type Pixels } from './images.ts';
import { decimateMesh, sourceCount, type DecimateReport } from './decimate.ts';
import { Pose, type Vec3 } from './pose.ts';
import { vrmTPose } from './vrmTPose.ts';
import { prepareSprings, springExtension, type SpringReport } from './springBones.ts';
import { qconj, qmul, qrot, qunit, restructureTwist, twistConstraints, twistFrames, type Quat } from './twistSplit.ts';
import { ADDON_PRESETS, ARKIT_SHAPE_KEYS, BONE_TABLES, detectBoneTable, EYES, OVERRIDE_BLINK, PRESETS } from './vrmTables.ts';

export type FinishOptions = {
  name: string;
  author?: string;
  /** Longest texture side; null keeps the source size (vrm_export.py --max-texture). */
  maxTexture?: number | null;
  jpegQuality?: number;
  /**
   * The web tier (glb_web.py, done while writing): normal maps 512 px, JPEG 85 or a 32-colour
   * palette PNG for alpha, per-mesh skins with 8-bit joints, 8-bit weights, 16-bit UVs, morph
   * deltas under 0.1 mm zeroed.
   */
  web?: boolean;
  /** vrm_export.py --max-mesh-verts: reduce meshes with more source vertices (decimate.ts). */
  maxMeshVerts?: number | null;
  /** Max tier, vrm_export.py --spring-bones: item bones swing (springBones.ts). */
  springBones?: boolean;
  /** Max tier, vrm_export.py --twist-split: Daz arm twist over bend + twist bones (twistSplit.ts). */
  twistSplit?: boolean;
};

const WEB_NORMAL_PX = 512;
const WEB_JPEG = 0.85;
const WEB_PNG_COLORS = 32; // glb_web.py BPY_PNG_COLORS: the palette Blender's own pass writes
const MORPH_EPS = 1e-4;

export type FinishReport = {
  bone_table: string | null;
  humanoid_missing: string[];
  shape_keys_pruned: number;
  preset_binds: Record<string, number>;
  look_at_offset: number[] | null;
  t_pose_deg: Record<string, number>;
  influences: Record<string, { max_before: number; unweighted: number; skinned: boolean }>;
  materials: Record<string, { mode: string; clear_texels: number; soft_share: number; merged_opacity?: boolean }>;
  textures: { count: number; reencoded: number; bytes: number };
  decimated: Record<string, DecimateReport>;
  spring_bones?: SpringReport;
  twist_split?: Record<string, string>;
  spring_export?: { springs: number; joints: number; colliders: number };
};

const SOFT_SHARE = 0.15;
const CORE_CUTOFF = 0.5;
const RANGE_MAPS: [string, number, number][] = [
  ['rangeMapHorizontalInner', 60, 25], ['rangeMapHorizontalOuter', 60, 25],
  ['rangeMapVerticalUp', 45, 15], ['rangeMapVerticalDown', 45, 15],
];

type Bind = { mesh: number; key: string; weight: number };

export async function finish(adapted: Contract, codec: ImageCodec, opts: FinishOptions): Promise<{ vrm: Uint8Array; report: FinishReport }> {
  const report: FinishReport = {
    bone_table: null, humanoid_missing: [], shape_keys_pruned: 0, preset_binds: {}, look_at_offset: null, t_pose_deg: {}, influences: {}, materials: {},
    textures: { count: 0, reencoded: 0, bytes: 0 },
    decimated: {},
  };
  const bones = adapted.bones.map((b) => ({ ...b, matrix: b.matrix.slice() }));
  let boneIndex = new Map(bones.map((b, i) => [b.name, i]));
  const head = (name: string): Vec3 => {
    const m = bones[boneIndex.get(name)!]!.matrix;
    return [m[12]!, m[13]!, m[14]!];
  };

  // --- 1. humanoid ---------------------------------------------------------------------------------
  const tableName = detectBoneTable(new Set(boneIndex.keys()));
  report.bone_table = tableName;
  const table = tableName ? BONE_TABLES[tableName]! : {};
  // max tier: spring bones before the export T-pose, as in vrm_export.py (tips ride the pose)
  const springs = opts.springBones && tableName ? prepareSprings(bones, adapted.meshes, table) : null;
  if (springs) report.spring_bones = springs.report;
  boneIndex = new Map(bones.map((b, i) => [b.name, i]));
  const humanBones: Record<string, { node: number }> = {};
  for (const [vrm, bone] of Object.entries(table)) {
    const i = boneIndex.get(bone);
    if (i === undefined) report.humanoid_missing.push(`${vrm}<-${bone}`);
    else humanBones[vrm] = { node: i };
  }

  // --- 6 (early). skin weights: <= 4 influences, normalised. Blender limits them before it
  // exports, and the export poses the figure (below) with these weights.
  // a mesh with no faces left (Daz's tear film once its overlay triangles are gone) is not
  // exported: Blender's glTF exporter skips it, with its keys and expression binds
  const solid = adapted.meshes.filter((m) => m.triangle_count > 0);
  // --- 2c. web tier: reduce heavy meshes (Daz hair; keyed strand brows keep their keys) --------
  if (opts.maxMeshVerts) {
    for (const [i, m] of solid.entries()) {
      if (sourceCount(m) <= opts.maxMeshVerts) continue;
      const copy: Mesh = { ...m, morphs: m.morphs.map((k) => ({ ...k })) };
      report.decimated[m.name] = await decimateMesh(copy, opts.maxMeshVerts);
      solid[i] = copy;
    }
  }
  const skin = solid.map((m) => limitWeights(m));
  const meshes: Mesh[] = solid.map((m, mi) => {
    const joints = new Uint16Array(m.vertex_count * MAXW), weights = new Float32Array(m.vertex_count * MAXW);
    for (let v = 0; v < m.vertex_count; v++)
      for (let k = 0; k < 4; k++) {
        joints[v * MAXW + k] = skin[mi]!.joints[v * 4 + k]!;
        weights[v * MAXW + k] = skin[mi]!.weights[v * 4 + k]!;
      }
    return { ...m, joints, weights, morphs: m.morphs.map((k) => ({ ...k })) };
  });
  meshes.forEach((m, mi) => (report.influences[m.name] = skin[mi]!.report));

  // --- the add-on's automatic T-pose (on export), baked as the rest pose -------------------------
  report.t_pose_deg = vrmTPose(new Pose(bones), humanBones, meshes);

  // --- max tier: the twist split, on the T-posed skeleton. vrm_export.py splits first and lets
  // the export T-pose run over the new bones: the bend bones (off the driver chain) then miss
  // the pose, its _realign pins their skin where it was, and the zero-length _pre -> _drv step
  // turns _pre by float noise (94 deg on Alice's right forearm, then turned back but for the
  // roll) -- up to 1.45 mm off its own plain export (ENVIRONMENT s36). Split after the pose,
  // the rest mesh is the plain export's, as the split intends.
  const twist = opts.twistSplit ? restructureTwist(bones, tableName) : null;
  if (opts.twistSplit && !twist) throw new Error(`twist split: no limb chains for bone table ${tableName}`);
  if (twist) {
    boneIndex = new Map(bones.map((b, i) => [b.name, i]));
    for (const [vrm, bone] of Object.entries(twist.remap)) humanBones[vrm] = { node: boneIndex.get(bone)! };
    report.twist_split = twist.remap;
  }

  // --- 2. expressions ------------------------------------------------------------------------------
  const hasKey = new Map<string, number[]>();
  meshes.forEach((m, mi) => m.morphs.forEach((k) => hasKey.set(k.name, [...(hasKey.get(k.name) ?? []), mi])));
  const bindsOf = (mix: Record<string, number>): Bind[] =>
    Object.entries(mix).flatMap(([key, weight]) => (hasKey.get(key) ?? []).map((mesh) => ({ mesh, key, weight })));
  const custom = new Map(ARKIT_SHAPE_KEYS.map((k) => [k, bindsOf({ [k]: 1 })]));
  const presets = new Map<string, Bind[]>([...ADDON_PRESETS.map(([n, mix]) => [n, bindsOf(mix)] as [string, Bind[]]), ['neutral', []]]);
  for (const [n, mix] of PRESETS) {
    presets.set(n, bindsOf(mix));
    report.preset_binds[n] = presets.get(n)!.length;
  }

  // --- 2b. drop shape keys no expression uses (look* binds only ARKit keys, already custom) ------
  const bound = new Set<string>();
  for (const list of [...custom.values(), ...PRESETS.map(([n]) => presets.get(n)!)]) for (const b of list) bound.add(`${b.mesh}\u0000${b.key}`);
  const kept = meshes.map((m, mi) => m.morphs.filter((k) => bound.has(`${mi}\u0000${k.name}`)));
  meshes.forEach((m, mi) => (report.shape_keys_pruned += m.morphs.length - kept[mi]!.length));
  const morphIndex = (mi: number, key: string) => kept[mi]!.findIndex((k) => k.name === key);

  // --- 3. lookAt: bone type, offset = eye midpoint relative to head ----------------------------------
  const eyes = EYES.find(([a, b]) => boneIndex.has(a) && boneIndex.has(b));
  let lookAt: Json | null = null;
  if (eyes) {
    const l = head(eyes[0]), r = head(eyes[1]), h = head(table.head ?? 'head');
    const off = [0, 1, 2].map((c) => (l[c]! + r[c]!) / 2 - h[c]!);
    report.look_at_offset = off.map((x) => Math.round(x * 1e4) / 1e4);
    lookAt = { type: 'bone', offsetFromHeadBone: off };
    for (const [n, inp, out] of RANGE_MAPS) lookAt[n] = { inputMaxValue: inp, outputScale: out };
  }

  // --- 7. materials (+ 7a fringe, 7b texture budget) -------------------------------------------------
  const out = new GlbBuilder('ccdz2vrm');
  const g = out.gltf;
  g.samplers.push({ magFilter: 9729, minFilter: 9987 });
  const textures = new TextureCache(adapted, codec, out, opts, report);
  const matByName = new Map(adapted.materials.map((m) => [m.name, m]));
  const used = [...new Set(meshes.flatMap((m) => m.materials))];
  const gltfMat = new Map<string, { core: number; fringe: number | null }>();
  for (const name of used) {
    const mat = matByName.get(name) ?? { name, textures: [] };
    const { core, fringe, info } = await convertMaterial(mat, textures);
    report.materials[name] = info;
    g.materials.push(core);
    const coreIdx = g.materials.length - 1;
    let fringeIdx: number | null = null;
    if (fringe) {
      g.materials.push(fringe);
      fringeIdx = g.materials.length - 1;
    }
    gltfMat.set(name, { core: coreIdx, fringe: fringeIdx });
  }

  // --- 8. write: bones, meshes, skin, VRMC_vrm -----------------------------------------------------------
  // world frames: identity, but the twist split's limb-aligned bones (from the final heads)
  const frames = twist ? twistFrames(twist.chains, head) : new Map<string, Quat>();
  const frame = (i: number): Quat => frames.get(bones[i]!.name) ?? [0, 0, 0, 1];
  bones.forEach((b, i) => {
    const p = b.parent === null ? undefined : boneIndex.get(b.parent);
    const h = head(b.name), ph = p === undefined ? [0, 0, 0] : head(bones[p]!.name);
    const pq = p === undefined ? ([0, 0, 0, 1] as Quat) : frame(p), q = frame(i);
    const node: Json = { name: b.name, translation: qrot(qconj(pq), [h[0]! - ph[0]!, h[1]! - ph[1]!, h[2]! - ph[2]!]) };
    const lq = qunit(qmul(qconj(pq), q));
    if (Math.abs(lq[3]) < 1 - 1e-9) node.rotation = lq;
    g.nodes.push(node);
    if (p === undefined) (g.scenes[0]!.nodes as number[]).push(i);
  });
  /** inverse(T(head) R(frame)), column-major */
  const inverseBind = (i: number): number[] => {
    const iq = qconj(frame(i)), t = qrot(iq, head(bones[i]!.name));
    const cols = ([[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const).map((e) => qrot(iq, [e[0], e[1], e[2]]));
    return [...cols[0]!, 0, ...cols[1]!, 0, ...cols[2]!, 0, -t[0], -t[1], -t[2], 1];
  };
  if (twist) {
    for (const [node, ext] of twistConstraints(twist.chains, (n) => boneIndex.get(n)!)) g.nodes[node]!.extensions = { VRMC_node_constraint: ext };
    g.extensionsUsed.push('VRMC_node_constraint');
  }
  bones.forEach((b, i) => {
    const p = b.parent === null ? undefined : boneIndex.get(b.parent);
    if (p !== undefined) ((g.nodes[p]!.children ??= []) as number[]).push(i);
  });
  const anySkinned = skin.some((s) => s.report.skinned);
  if (anySkinned && !opts.web) {
    const ibm = new Float32Array(bones.length * 16);
    bones.forEach((_, i) => ibm.set(inverseBind(i), i * 16));
    g.skins.push({ name: opts.name, joints: bones.map((_, i) => i), inverseBindMatrices: out.accessor(ibm, 'MAT4') });
  }
  const meshNode: number[] = [];
  meshes.forEach((m, mi) => {
    // mesh-wide attribute data first; written below per material slot
    const uv = new Float32Array(m.uv.length);
    for (let v = 0; v < m.vertex_count; v++) {
      uv[v * 2] = m.uv[v * 2]!;
      uv[v * 2 + 1] = 1 - m.uv[v * 2 + 1]!; // FBX/Blender v runs up, glTF's down
    }
    const s = skin[mi]!;
    let skinIndex = 0;
    let joints: Uint8Array | Uint16Array | null = null, weights: Uint8Array | Float32Array | null = null;
    if (s.report.skinned && opts.web) {
      // a skin of only the joints this mesh uses: 8-bit joints (glb_web.py compact_skins), and
      // joint 0 wherever the 8-bit weight is 0 -- rounding zeroes some, and the Khronos validator
      // flags a joint on a zero weight (ACCESSOR_JOINTS_USED_ZERO_WEIGHT)
      const w8 = weightsU8(s.weights);
      const usedJoints = [...new Set(Array.from(s.joints).filter((_, k) => w8[k]! > 0))].toSorted((a, b) => a - b);
      const remap = new Map(usedJoints.map((j, k) => [j, k]));
      const ibm = new Float32Array(usedJoints.length * 16);
      usedJoints.forEach((j, k) => ibm.set(inverseBind(j), k * 16));
      g.skins.push({ name: m.name, joints: usedJoints, inverseBindMatrices: out.accessor(ibm, 'MAT4') });
      skinIndex = g.skins.length - 1;
      const local = Uint16Array.from(s.joints, (j, k) => (w8[k]! > 0 ? remap.get(j)! : 0));
      joints = usedJoints.length < 256 ? Uint8Array.from(local) : local;
      weights = w8;
    } else if (s.report.skinned) {
      joints = bones.length < 256 ? Uint8Array.from(s.joints) : s.joints;
      weights = s.weights;
    }
    const deltas = kept[mi]!.map((k) => {
      if (!opts.web) return k.delta;
      // glb_web.py: deltas under 0.1 mm zeroed (face targets nudge every vertex by micrometres)
      const d = new Float32Array(k.delta);
      for (let v = 0; v < m.vertex_count; v++) if (Math.hypot(d[v * 3]!, d[v * 3 + 1]!, d[v * 3 + 2]!) < MORPH_EPS) d.fill(0, v * 3, v * 3 + 3);
      return d;
    });
    // one vertex array per material slot, as Blender's glTF exporter writes them (the blended
    // fringe shares its core's): three.js sorts blended primitives by their geometry's bounding-
    // sphere centre, and one array for the whole mesh gave every primitive the same centre --
    // G8's scalp-cap fringe then drew over the strands' (ENVIRONMENT s35). It also keeps a big
    // mesh's indices 16-bit. Cores first, then the fringes, in slot order, as Blender lists them.
    const cores: Json[] = [], fringes: Json[] = [];
    const tris: number[][] = m.materials.map(() => []);
    for (let t = 0; t < m.triangle_count; t++) tris[m.triangle_material[t] ?? 0]!.push(t);
    const local = new Int32Array(m.vertex_count);
    m.materials.forEach((name, slot) => {
      const list = tris[slot]!;
      if (!list.length) return;
      local.fill(-1);
      const verts: number[] = [];
      const corners = new Uint32Array(list.length * 3);
      list.forEach((t, k) => {
        for (let c = 0; c < 3; c++) {
          const v = m.indices[t * 3 + c]!;
          if (local[v] === -1) local[v] = verts.push(v) - 1;
          corners[k * 3 + c] = local[v]!;
        }
      });
      const pick = <T extends Float32Array | Uint16Array | Uint8Array>(a: T, k: number): T => {
        const o = new (a.constructor as new (n: number) => T)(verts.length * k);
        verts.forEach((v, i) => o.set(a.subarray(v * k, v * k + k), i * k));
        return o;
      };
      const attributes: Json = { POSITION: out.accessor(pick(m.position, 3), 'VEC3', { minmax: true }) };
      if (m.normal) attributes.NORMAL = out.accessor(pick(m.normal, 3), 'VEC3');
      const st = pick(uv, 2);
      attributes.TEXCOORD_0 = opts.web && st.every((x) => x >= 0 && x <= 1)
        ? out.accessor(Uint16Array.from(st, (x) => Math.round(x * 65535)), 'VEC2', { normalized: true })
        : out.accessor(st, 'VEC2');
      if (joints && weights) {
        attributes.JOINTS_0 = out.accessor(pick(joints, 4), 'VEC4');
        attributes.WEIGHTS_0 = out.accessor(pick(weights, 4), 'VEC4', { normalized: weights instanceof Uint8Array });
      }
      const targets = deltas.map((d) => ({ POSITION: out.sparseVec3(pick(d, 3)) }));
      const indices = out.accessor(verts.length < 65536 ? Uint16Array.from(corners) : corners, 'SCALAR', { indices: true });
      const mat = gltfMat.get(name)!;
      const prim = (material: number): Json => ({ attributes, indices, material, ...(targets.length ? { targets } : {}) });
      cores.push(prim(mat.core));
      if (mat.fringe !== null) fringes.push(prim(mat.fringe)); // 7a: the same faces again, blended
    });
    const primitives = [...cores, ...fringes];
    g.meshes.push({ name: m.name, primitives, ...(deltas.length ? { extras: { targetNames: kept[mi]!.map((k) => k.name) } } : {}) });
    g.nodes.push({ name: m.name, mesh: g.meshes.length - 1, ...(s.report.skinned ? { skin: skinIndex } : {}) });
    meshNode.push(g.nodes.length - 1);
    (g.scenes[0]!.nodes as number[]).push(g.nodes.length - 1);
  });

  const expression = (binds: Bind[], name?: string): Json => ({
    morphTargetBinds: binds.map((b) => ({ node: meshNode[b.mesh]!, index: morphIndex(b.mesh, b.key), weight: b.weight })),
    isBinary: false,
    overrideBlink: (name && OVERRIDE_BLINK[name]) || 'none',
    overrideLookAt: 'none',
    overrideMouth: 'none',
  });
  if (springs) {
    const ext = springExtension(springs.spec, humanBones, (n) => boneIndex.get(n), (node, p) => {
      const h = head(bones[node]!.name);
      return qrot(qconj(frame(node)), [p[0] - h[0]!, p[1] - h[1]!, p[2] - h[2]!]);
    });
    if (ext) {
      g.extensionsUsed.push('VRMC_springBone');
      g.extensions.VRMC_springBone = ext;
      const list = ext.springs as { joints: unknown[] }[];
      report.spring_export = { springs: list.length, joints: list.reduce((a, s) => a + s.joints.length, 0), colliders: (ext.colliders as unknown[]).length };
    }
  }
  g.extensionsUsed.push('VRMC_vrm');
  g.extensions.VRMC_vrm = {
    specVersion: '1.0',
    meta: {
      name: opts.name,
      version: '1.0',
      authors: [opts.author ?? 'ccdz2vrm'],
      licenseUrl: 'https://vrm.dev/licenses/1.0/',
      // Daz/CC content under the user's own licence: the file grants nothing beyond it
      avatarPermission: 'onlyAuthor',
      commercialUsage: 'personalNonProfit',
      allowExcessivelyViolentUsage: false,
      allowExcessivelySexualUsage: false,
      allowPoliticalOrReligiousUsage: false,
      allowAntisocialOrHateUsage: false,
      allowRedistribution: false,
      modification: 'prohibited',
      creditNotation: 'required',
    },
    humanoid: { humanBones },
    // --- 4. first person: every mesh "auto" (the runtime drops head-weighted triangles)
    firstPerson: { meshAnnotations: meshNode.map((node) => ({ node, type: 'auto' })) },
    ...(lookAt ? { lookAt } : {}),
    expressions: {
      preset: Object.fromEntries([...presets].map(([n, b]) => [n, expression(b, n)])),
      custom: Object.fromEntries([...custom].map(([n, b]) => [n, expression(b)])),
    },
  };
  return { vrm: out.build(), report };
}

/** glb_web.py weights_u8: normalised 8-bit weights summing to exactly 255 (largest remainders up). */
function weightsU8(w: Float32Array): Uint8Array {
  const out = new Uint8Array(w.length);
  for (let v = 0; v < w.length / 4; v++) {
    const row = [0, 1, 2, 3].map((k) => w[v * 4 + k]!);
    const s = row.reduce((a, b) => a + b, 0);
    if (!s) continue;
    const scaled = row.map((x) => (x / s) * 255);
    const q = scaled.map(Math.floor);
    let short = 255 - q.reduce((a, b) => a + b, 0);
    const order = [0, 1, 2, 3].toSorted((a, b) => (scaled[b]! - q[b]!) - (scaled[a]! - q[a]!));
    for (const k of order) if (short-- > 0) q[k]!++;
    q.forEach((x, k) => (out[v * 4 + k] = x));
  }
  return out;
}

/** vertex_group_limit_total(limit=4) + vertex_group_normalize_all: the 4 heaviest, summing to 1. */
function limitWeights(m: Mesh) {
  const joints = new Uint16Array(m.vertex_count * 4);
  const weights = new Float32Array(m.vertex_count * 4);
  let maxBefore = 0, unweighted = 0, any = false;
  for (let v = 0; v < m.vertex_count; v++) {
    const pairs: [number, number][] = [];
    for (let k = 0; k < MAXW; k++) {
      const w = m.weights[v * MAXW + k]!;
      if (w > 0) pairs.push([m.joints[v * MAXW + k]!, w]);
    }
    maxBefore = Math.max(maxBefore, pairs.length);
    pairs.sort((a, b) => b[1] - a[1]);
    const top = pairs.slice(0, 4);
    const total = top.reduce((s, p) => s + p[1], 0);
    if (!total) {
      unweighted++;
      continue;
    }
    any = true;
    top.forEach(([j, w], k) => {
      joints[v * 4 + k] = j;
      weights[v * 4 + k] = w / total;
    });
  }
  if (any && unweighted) {
    // glTF needs every skinned vertex weighted; Blender leaves these on nothing (they stay at rest).
    // The mesh's most-used bone is the closest thing to "stays where the rest of it goes".
    const use = new Map<number, number>();
    for (let v = 0; v < m.vertex_count; v++) if (weights[v * 4]) use.set(joints[v * 4]!, (use.get(joints[v * 4]!) ?? 0) + 1);
    const top = [...use].toSorted((a, b) => b[1] - a[1])[0]![0];
    for (let v = 0; v < m.vertex_count; v++) if (!weights[v * 4]) {
      joints[v * 4] = top;
      weights[v * 4] = 1;
    }
  }
  return { joints, weights, report: { max_before: maxBefore, unweighted, skinned: any } };
}

/** Images, decoded once, merged / converted / budgeted, written once. */
class TextureCache {
  private decoded = new Map<string, Pixels>();
  private written = new Map<string, number>();
  private c: Contract;
  private codec: ImageCodec;
  private out: GlbBuilder;
  private opts: FinishOptions;
  private report: FinishReport;

  constructor(c: Contract, codec: ImageCodec, out: GlbBuilder, opts: FinishOptions, report: FinishReport) {
    this.c = c;
    this.codec = codec;
    this.out = out;
    this.opts = opts;
    this.report = report;
  }

  bytes(fnv: string): Uint8Array {
    const d = this.c.images.find((i) => i.fnv === fnv)?.data;
    if (!d?.length) throw new Error(`image ${fnv} has no data`);
    return d;
  }

  async pixels(fnv: string): Promise<Pixels> {
    if (!this.decoded.has(fnv)) this.decoded.set(fnv, await this.codec.decode(this.bytes(fnv)));
    return this.decoded.get(fnv)!;
  }

  private budget(px: Pixels, normal = false): Pixels {
    const max = this.opts.web && normal ? Math.min(this.opts.maxTexture ?? WEB_NORMAL_PX, WEB_NORMAL_PX) : this.opts.maxTexture;
    if (!max || Math.max(px.width, px.height) <= max) return px;
    const f = max / Math.max(px.width, px.height);
    return resize(px, Math.max(1, Math.trunc(px.width * f)), Math.max(1, Math.trunc(px.height * f)));
  }

  /** A texture from a source image; re-encoded only when the budget shrinks it. */
  async source(fnv: string, name: string, needAlpha: boolean, normal = false): Promise<number> {
    const key = `src:${fnv}:${needAlpha}`;
    if (this.written.has(key)) return this.written.get(key)!;
    const raw = this.bytes(fnv);
    const px = await this.pixels(fnv);
    const max = this.opts.maxTexture;
    let tex: number;
    if (this.opts.web) {
      tex = await this.webEncode(this.budget(px, normal), name, raw);
    } else if (!max || Math.max(px.width, px.height) <= max) {
      tex = this.add(stripPng(raw), mimeOf(raw) ?? 'image/png', name);
    } else {
      // a resized map keeps its source's format: a JPEG bump stays JPEG (it was lossy already;
      // as PNG it made g3's VRM 16 % bigger than Blender's), PNG and alpha stay PNG
      tex = await this.encode(this.budget(px), name, needAlpha || (normal && mimeOf(raw) !== 'image/jpeg'));
    }
    this.written.set(key, tex);
    return tex;
  }

  /** A texture made here (merged opacity, normal from height), budgeted. */
  async generated(key: string, px: Pixels, name: string, png: boolean, normal = false): Promise<number> {
    if (!this.written.has(key)) {
      const b = this.budget(px, normal);
      this.written.set(key, this.opts.web ? await this.webEncode(b, name, null) : await this.encode(b, name, png));
    }
    return this.written.get(key)!;
  }

  /**
   * glb_web.py shrink_textures: a 32-colour palette PNG when any texel is clearly transparent,
   * else JPEG 85; the source itself when that is smaller (it was already small).
   */
  private async webEncode(px: Pixels, name: string, raw: Uint8Array | null): Promise<number> {
    let alpha = false;
    for (let i = 3; i < px.data.length && !alpha; i += 4) alpha = px.data[i]! < 250;
    const bytes = alpha ? await palettePng(px, WEB_PNG_COLORS, this.codec) : await this.codec.encode(px, 'jpeg', WEB_JPEG);
    this.report.textures.reencoded++;
    if (raw && px === (await this.pixels(this.fnvOf(raw))) && raw.byteLength <= bytes.byteLength) {
      return this.add(stripPng(raw), mimeOf(raw) ?? 'image/png', name);
    }
    return this.add(bytes, alpha ? 'image/png' : 'image/jpeg', name);
  }

  private fnvOf(raw: Uint8Array): string {
    return this.c.images.find((i) => i.data === raw)?.fnv ?? '';
  }

  private async encode(px: Pixels, name: string, png: boolean): Promise<number> {
    const bytes = await this.codec.encode(px, png ? 'png' : 'jpeg', this.opts.jpegQuality ?? 0.9);
    this.report.textures.reencoded++;
    return this.add(bytes, png ? 'image/png' : 'image/jpeg', name);
  }

  private add(bytes: Uint8Array, mime: string, name: string): number {
    const g = this.out.gltf;
    g.textures.push({ sampler: 0, source: this.out.image(bytes, mime, name) });
    this.report.textures.count++;
    this.report.textures.bytes += bytes.byteLength;
    return g.textures.length - 1;
  }
}

/** vrm_export.py step 7 for one material: alpha mode, merged opacity, fringe copy. */
async function convertMaterial(mat: Material, tx: TextureCache) {
  const pbr: Pbr | null = mat.pbr ?? null;
  const core: Json = { name: mat.name, doubleSided: true };
  const info: FinishReport['materials'][string] = { mode: 'OPAQUE', clear_texels: 0, soft_share: 0 };
  if (!pbr) return { core, fringe: null as Json | null, info };

  let alphaPx: Pixels | null = null;
  let mergedPx: Pixels | null = null;
  const baseTex = pbr.base_tex;
  if (pbr.alpha_tex && pbr.alpha_tex !== baseTex) {
    // A separate opacity map: glTF takes alpha from the base colour texture only, so merge it in.
    const op = await tx.pixels(pbr.alpha_tex);
    const base = baseTex ? await tx.pixels(baseTex) : null;
    const w = base ? base.width : op.width, h = base ? base.height : op.height;
    const rgba = new Uint8Array(w * h * 4);
    if (base) rgba.set(base.data);
    else {
      let col = pbr.base_color;
      // Daz G8 lashes: white base factor + opacity map only -> dark lashes
      if (/lash|brow/.test(mat.name.toLowerCase()) && Math.min(...col) > 0.6) col = [0.05, 0.04, 0.035];
      for (let i = 0; i < w * h; i++) rgba.set([...col.map((c) => Math.round(c * 255)), 255], i * 4);
    }
    // nearest sampling with Blender's bottom-up row index (ys = arange(h) * oh // h)
    for (let t = 0; t < h; t++) {
      const r = h - 1 - t, sr = op.height - 1 - Math.floor((r * op.height) / h);
      for (let x = 0; x < w; x++) {
        const sx = Math.floor((x * op.width) / w), o = (sr * op.width + sx) * 4;
        rgba[(t * w + x) * 4 + 3] = pbr.alpha_channel === 'alpha'
          ? op.data[o + 3]!
          : Math.round((op.data[o]! + op.data[o + 1]! + op.data[o + 2]!) / 3);
      }
    }
    mergedPx = alphaPx = { width: w, height: h, data: rgba };
    info.merged_opacity = true;
  } else if (pbr.alpha_tex) {
    alphaPx = await tx.pixels(pbr.alpha_tex);
  }

  let clear = 0, visible = 0, soft = 0;
  if (alphaPx) {
    const d = alphaPx.data, n = d.length / 4;
    for (let i = 3; i < d.length; i += 4) {
      const a = d[i]! / 255;
      if (a < 0.5) clear++;
      if (a >= 0.05) {
        visible++;
        if (a < 0.95) soft++;
      }
    }
    info.clear_texels = Math.round((clear / n) * 1000) / 1000;
    info.soft_share = Math.round((soft / Math.max(1, visible)) * 100) / 100;
  }
  const cut = !!alphaPx && info.clear_texels > 0.01;
  const strands = cut && soft / Math.max(1, visible) > SOFT_SHARE;
  info.mode = strands ? 'MASK+BLEND' : cut ? 'MASK' : 'OPAQUE';

  const pmr: Json = { metallicFactor: pbr.metallic, roughnessFactor: pbr.roughness };
  if (mergedPx) pmr.baseColorTexture = { index: await tx.generated(`rgba:${mat.name}`, mergedPx, `${mat.name}_rgba`, true) };
  else if (baseTex) pmr.baseColorTexture = { index: await tx.source(baseTex, mat.name, cut) };
  else pmr.baseColorFactor = [...pbr.base_color, 1];
  core.pbrMetallicRoughness = pmr;
  if (pbr.normal_tex) {
    const index = pbr.normal_from_height
      ? await tx.generated(`nrm:${pbr.normal_tex}`, heightToNormal(await tx.pixels(pbr.normal_tex)), `${mat.name}_normal`, true, true)
      : await tx.source(pbr.normal_tex, `${mat.name}_normal`, false, true);
    core.normalTexture = pbr.normal_strength !== null && pbr.normal_strength !== 1 ? { index, scale: pbr.normal_strength } : { index };
  }
  if (cut) {
    core.alphaMode = 'MASK';
    if (CORE_CUTOFF !== 0.5) core.alphaCutoff = CORE_CUTOFF;
  }
  let fringe: Json | null = null;
  if (strands) {
    const { alphaCutoff: _cutoff, ...rest } = core;
    fringe = { ...rest, name: `${mat.name}.fringe`, alphaMode: 'BLEND' };
  }
  return { core, fringe, info };
}
