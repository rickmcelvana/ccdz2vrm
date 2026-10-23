// The FBX import cleanup: what Blender's importer plus common.py `import_fbx_clean` hand the
// adapters, rebuilt from ufbx's raw import (tools/fbx-spike). Judged against
// `dump_contract.py --clean` by tools/compare/contract.mjs (docs/BROWSER-PORT.md, Phase 1).
//
//  0. Blender's skeleton (import_fbx.py find_armatures / find_fake_bones): only LimbNodes
//     are bones; their nearest Null/Root parent becomes the armature (else a new
//     `Armature`); inside an armature any other node with bones below is a bone too (Daz
//     writes the figure and each item root as FBX `Root`: the figure is the armature, the
//     item roots parentless bones in it). Names unique per armature, a repeat numbered
//     `.001`, `.002`... in file order (ENVIRONMENT.md s31).
// Then import_fbx_clean's steps:
//  1. the biggest armature is the figure; other armatures' meshes are re-pointed at it by
//     bone name and their bones dropped;
//  2. bones hanging off a copy (`Fringe A` under `head.003`) move to the real bone (s28);
//  3. a mesh's skin groups on a copy (`lEyelidUpper.001`) fold onto the real bone when the
//     mesh has no group of that name yet;
//  4. a mesh with no weights on the figure binds rigidly to the bone it hangs from (s23);
//  5. materials named as Blender names them (a repeated name gets `.001` by file order) and
//     converted as its importer converts FBX Phong (blen_read_material), then
//     Metallic 0 unless named metal, roughness floored at 0.5 unless a map drives it (s27),
//     and a greyscale bump map marked for conversion to a normal map (`heightToNormal`).
// Animation, the 0.01 scale and parent inverses (import_fbx_clean 1-2) do not exist here:
// ufbx is read at the bind pose, in metres, in world space.

import { MAXW, type Bone, type Contract, type Material, type Mesh, type Pbr, type RawNode } from './contract.ts';
import { hasDepth32, isGreyscale, type ImageCodec } from './images.ts';

export const ROUGHNESS_FLOOR = 0.5;

export type CleanReport = {
  armatures: Record<string, number>;
  armatures_dropped: string[];
  reparented_off_twins: number;
  groups_folded: number;
  rigid: Record<string, string>;
  normals_from_height: number;
};

const f32 = (x: number) => Math.fround(x); // Principled sockets are float32
const suffixed = (name: string, k: number) => (k ? `${name}.${String(k).padStart(3, '0')}` : name);

/** Which Principled input an FBX texture link drives (the importer's connection loop). */
function slot(prop: string): 'base' | 'metallic' | 'alpha' | 'roughness' | 'normal' | null {
  if (['DiffuseColor', '3dsMax|maps|texmap_diffuse'].includes(prop)) return 'base';
  if (['ReflectionColor', 'ReflectionFactor', '3dsMax|maps|texmap_reflection'].includes(prop)) return 'metallic';
  if (['TransparentColor', 'TransparencyFactor'].includes(prop)) return 'alpha';
  if (prop === 'ShininessExponent') return 'roughness';
  if (['NormalMap', 'Bump', '3dsMax|maps|texmap_bump'].includes(prop)) return 'normal';
  return null;
}

const limb = (n: RawNode) => n.type === 'limb';

/** Blender's `name.rsplit(".", 1)[0]`. */
const rsplitBase = (n: string) => (n.includes('.') ? n.slice(0, n.lastIndexOf('.')) : n);

type Skeleton = {
  /** node id -> armature and Blender bone name, for every node Blender makes a bone */
  bone: Map<number, { armature: string; name: string }>;
  /** bones per armature, in node order */
  armatures: Map<string, RawNode[]>;
  /** the nearest bone above, in the same armature */
  parentBone: (n: RawNode) => RawNode | null;
};

/** import_fbx.py find_armatures + find_fake_bones, then names unique per armature. */
function blenderSkeleton(nodes: RawNode[]): Skeleton {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map<number, RawNode[]>();
  for (const n of nodes) {
    if (!kids.has(n.parent)) kids.set(n.parent, []);
    kids.get(n.parent)!.push(n);
  }

  const below = new Map<number, boolean>();
  const limbBelow = (n: RawNode): boolean => {
    if (!below.has(n.id)) below.set(n.id, (kids.get(n.id) ?? []).some((c) => limb(c) || limbBelow(c)));
    return below.get(n.id)!;
  };
  const armOf = new Map<number, string>();
  const used = new Map<string, number>();
  const newArmature = (name: string) => {
    const k = used.get(name) ?? 0; // object names are unique too: Armature, Armature.001
    used.set(name, k + 1);
    return suffixed(name, k);
  };
  const walk = (id: number, node: RawNode | null, arm: string | null): void => {
    const ch = kids.get(id) ?? [];
    if (arm === null && ch.some(limb)) {
      if (node && (node.type === 'null' || node.type === 'root')) {
        const a = newArmature(node.name);
        for (const c of ch) visit(c, a);
      } else {
        const a = newArmature('Armature'); // inserted above the bones only
        for (const c of ch) {
          if (limb(c)) visit(c, a);
          else walk(c.id, c, null);
        }
      }
      return;
    }
    for (const c of ch) visit(c, arm);
  };
  const visit = (c: RawNode, arm: string | null) => {
    if (arm !== null && (limb(c) || limbBelow(c))) armOf.set(c.id, arm);
    walk(c.id, c, arm);
  };
  walk(-1, null, null);

  const armatures = new Map<string, RawNode[]>();
  const seen = new Map<string, number>();
  const bone = new Map<number, { armature: string; name: string }>();
  for (const n of nodes) {
    const a = armOf.get(n.id);
    if (a === undefined) continue;
    const key = `${a}\u0000${n.name}`;
    const k = seen.get(key) ?? 0;
    seen.set(key, k + 1);
    bone.set(n.id, { armature: a, name: suffixed(n.name, k) });
    if (!armatures.has(a)) armatures.set(a, []);
    armatures.get(a)!.push(n);
  }
  const parentBone = (n: RawNode) => {
    const a = bone.get(n.id)?.armature;
    const p = byId.get(n.parent);
    return p && bone.get(p.id)?.armature === a ? p : null;
  };
  return { bone, armatures, parentBone };
}

export async function cleanImport(raw: Contract, codec: ImageCodec): Promise<{ contract: Contract; report: CleanReport }> {
  const report: CleanReport = {
    armatures: {}, armatures_dropped: [], reparented_off_twins: 0, groups_folded: 0, rigid: {}, normals_from_height: 0,
  };
  const nodes = raw.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // --- 0. Blender's skeleton -----------------------------------------------------------------------
  const sk = blenderSkeleton(nodes);
  for (const [a, list] of sk.armatures) report.armatures[a] = list.length;

  // --- 1. the figure's armature: the one with the most bones ----------------------------------------
  const figure = [...sk.armatures].toSorted((a, b) => b[1].length - a[1].length)[0]?.[0] ?? '';
  report.armatures_dropped = [...sk.armatures.keys()].filter((a) => a !== figure);
  const figureNodes = sk.armatures.get(figure) ?? [];
  const byName = new Map<string, number>(); // figure bone name -> index in the cleaned bones
  figureNodes.forEach((n, i) => byName.set(sk.bone.get(n.id)!.name, i));

  // --- 2. bones under a twin go to the real bone --------------------------------------------------------
  const twinBase = (name: string) => {
    const dot = name.lastIndexOf('.');
    if (dot < 0 || !/^\d+$/.test(name.slice(dot + 1))) return null;
    const base = name.slice(0, dot);
    return byName.has(base) ? base : null;
  };
  const bones: Bone[] = figureNodes.map((n) => {
    const name = sk.bone.get(n.id)!.name;
    const pn = sk.parentBone(n);
    let parent = pn ? sk.bone.get(pn.id)!.name : null;
    if (parent !== null && twinBase(parent) !== null && twinBase(name) === null) {
      parent = twinBase(parent);
      report.reparented_off_twins++;
    }
    return { name, parent, armature: figure, matrix: n.matrix };
  });

  // A raw bone index as Blender names its vertex group: the bone's name, or the node's own
  // name when Blender made no bone of it (the group exists, nothing deforms it).
  const rawBoneNode = new Map<number, RawNode>();
  for (const n of nodes) if (n.bone >= 0) rawBoneNode.set(n.bone, n);
  const groupName = (bi: number) => {
    const n = rawBoneNode.get(bi);
    return n ? (sk.bone.get(n.id)?.name ?? n.name) : '';
  };
  const hangBone = (m: Mesh) => {
    for (let n = byId.get(byId.get(m.node ?? -1)?.parent ?? -1); n; n = byId.get(n.parent)) {
      const b = sk.bone.get(n.id);
      if (b) return b.name;
    }
    return null;
  };

  const matSeen = new Map<string, number>();
  const matNames = raw.materials.map((m) => {
    const k = matSeen.get(m.name) ?? 0;
    matSeen.set(m.name, k + 1);
    return k ? `${m.name}.${String(k).padStart(3, '0')}` : m.name;
  });

  // --- 3-4. skin: groups by Blender name, folded, re-pointed, or a rigid bind --------------------
  const meshes: Mesh[] = raw.meshes.map((m) => {
    // a group is a skin cluster: its bone's Blender name (re-pointed by name for extra armatures)
    const groups = (m.clusters ?? []).map(groupName);
    const current = new Set(groups);
    const groupBone = new Map<number, string>(); // raw bone index -> group name after folding
    (m.clusters ?? []).forEach((bi, g) => {
      let name = groups[g]!;
      const base = rsplitBase(name);
      if (base !== name && byName.has(base) && !current.has(base)) {
        current.delete(name);
        current.add(base);
        name = base;
        report.groups_folded++;
      }
      if (bi >= 0) groupBone.set(bi, name);
    });
    const joints = new Uint16Array(m.vertex_count * MAXW);
    const weights = new Float32Array(m.vertex_count * MAXW);
    const anyFigure = [...current].some((g) => byName.has(g));
    if (anyFigure) {
      for (let v = 0; v < m.vertex_count; v++) {
        let k = 0;
        for (let s = 0; s < MAXW; s++) {
          const w = m.weights[v * MAXW + s]!;
          if (!(w > 0)) continue;
          const target = byName.get(groupBone.get(m.joints[v * MAXW + s]!) ?? '');
          if (target === undefined) continue; // a group with no bone in the figure: Blender ignores it
          joints[v * MAXW + k] = target;
          weights[v * MAXW + k] = w;
          k++;
        }
      }
    } else if (hangBone(m) !== null) {
      const hb = hangBone(m)!;
      const base = rsplitBase(hb);
      const bone = byName.has(base) ? base : hb;
      const target = byName.get(bone);
      if (target !== undefined) {
        for (let v = 0; v < m.vertex_count; v++) {
          joints[v * MAXW] = target;
          weights[v * MAXW] = 1;
        }
        report.rigid[m.name] = bone;
      }
    }
    const { clusters: _c, hang_bone: _h, node: _n, material_index, ...rest } = m;
    const materials = material_index ? material_index.map((i) => matNames[i]!) : m.materials;
    return { ...rest, materials, joints, weights };
  });

  // --- 5. materials --------------------------------------------------------------------------------
  const imageByFnv = new Map(raw.images.map((im) => [im.fnv, im]));
  const greyCache = new Map<string, boolean>();
  const isGrey = async (fnv: string) => {
    if (!greyCache.has(fnv)) {
      const data = imageByFnv.get(fnv)?.data;
      greyCache.set(fnv, data && data.length ? isGreyscale(await codec.decode(data)) : false);
    }
    return greyCache.get(fnv)!;
  };
  const materials: Material[] = [];
  for (const [i, mat] of raw.materials.entries()) {
    const pbr = await materialPbr(mat, imageByFnv, isGrey);
    if (pbr.normal_from_height) report.normals_from_height++;
    materials.push({ name: matNames[i]!, textures: mat.textures.map(({ image: _i, ...t }) => t), pbr });
  }

  const { nodes: _nodes, ...rest } = raw;
  return { contract: { ...rest, source: 'ts-clean', bones, meshes, materials }, report };
}

/** blen_read_material + the texture links + import_fbx_clean's fixes. */
async function materialPbr(
  mat: Material,
  images: Map<string, { data?: Uint8Array | undefined }>,
  isGrey: (fnv: string) => Promise<boolean>,
): Promise<Pbr> {
  const own = mat.props ?? {}, tmpl = mat.template ?? {};
  // elem_props_get_*: the element's own Properties70, then its template, then the default
  const num = (k: string, d: number) => own[k]?.[0] ?? tmpl[k]?.[0] ?? d;
  const rgb = (k: string, d: number[]) => (own[k] ?? tmpl[k] ?? d).slice(0, 3);

  let alpha = 1 - num('TransparencyFactor', 0);
  if (alpha === 1 || alpha === 0) {
    const op = own['Opacity']?.[0]; // no template here (blen_read_material: fbx_props_no_template)
    alpha = op ?? 1 - rgb('TransparentColor', [0, 0, 0])[0]!;
  }
  const shin = Math.max(num('Shininess', 20), 0);

  // texture links, later links win as Blender's connection loop overwrites
  const link: Record<string, string | null> = {};
  for (const t of mat.textures) {
    const s = slot(t.prop);
    if (s) link[s] = t.fnv && t.bytes ? t.fnv : null;
  }
  let alphaTex = link['alpha'] ?? null;
  let alphaChannel: Pbr['alpha_channel'] = alphaTex ? 'color' : null;
  const base = link['base'] ?? null;
  if (base && hasDepth32(images.get(base)?.data ?? new Uint8Array())) {
    alphaTex = base;
    alphaChannel = 'alpha';
  }

  const roughTex = link['roughness'] ?? null;
  const metalTex = link['metallic'] ?? null;
  let roughness = f32(1 - Math.sqrt(shin) / 10);
  if (!roughTex) roughness = Math.max(roughness, ROUGHNESS_FLOOR);
  let metallic = f32(num('ReflectionFactor', 0));
  if (!metalTex && !mat.name.toLowerCase().includes('metal')) metallic = 0;

  const normal = link['normal'] ?? null;
  let strength = f32(num('BumpFactor', 1));
  const fromHeight = normal ? await isGrey(normal) : false;
  if (fromHeight) strength = 1;

  return {
    base_color: rgb('DiffuseColor', [1, 1, 1]).map(f32),
    base_tex: base,
    alpha: f32(alpha),
    alpha_tex: alphaTex,
    alpha_channel: alphaChannel,
    roughness,
    roughness_tex: roughTex,
    metallic,
    metallic_tex: metalTex,
    normal_tex: normal,
    normal_from_height: fromHeight,
    normal_strength: strength,
  };
}
