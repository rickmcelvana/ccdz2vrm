// The contract (docs/BROWSER-PORT.md s2): one character as the pipeline passes it between
// stages, and as the reference harness compares it with Blender's. JSON for structure, one
// binary blob for arrays; the JSON holds byte offsets into it.
//
// Frame: glTF (Y up, +Z front, metres), bind pose. Vertices are split per (position, uv)
// like a glTF export. Skin: 8 joints + 8 weights per vertex, joints index `bones`.

export const MAXW = 8;

export type Bone = {
  name: string;
  parent: string | null;
  /** Index into bones; names repeat in a raw Daz import (skeleton copies). */
  parent_index?: number;
  /** The armature (non-bone node) this bone hangs under; null at the scene root. */
  armature?: string | null;
  rest_from?: string;
  /** World rest matrix, column-major 4x4. */
  matrix: number[];
};

/** Raw import only: every FBX node, for Blender's bone/armature rule (cleanup.ts step 0). */
export type RawNode = {
  name: string;
  id: number;
  /** Parent node id, -1 under the scene root. */
  parent: number;
  /** FBX node type as Blender reads it: LimbNode/Limb = 'limb', 'root', 'null', 'mesh', 'other'. */
  type: 'limb' | 'root' | 'null' | 'mesh' | 'other';
  /** Index into the raw `bones` when the node is a limb or a skin cluster's target, else -1. */
  bone: number;
  matrix: number[];
};

export type Morph = { name: string; shape: string; inbetweens: number; delta: Float32Array };

export type Mesh = {
  name: string;
  mesh: string;
  vertex_count: number;
  triangle_count: number;
  position: Float32Array;
  uv: Float32Array;
  /** Unit normals (raw import from ufbx; dump_contract.py writes none). */
  normal?: Float32Array | undefined;
  /** The source vertex each split vertex comes from (Blender's vertex / ufbx's logical vertex). */
  vertex?: Uint32Array | undefined;
  joints: Uint16Array;
  weights: Float32Array;
  indices: Uint32Array;
  triangle_material: Uint16Array;
  materials: string[];
  morphs: Morph[];
  /** Raw import only: the mesh's node id. */
  node?: number;
  /** Raw import only: index into `materials` of each slot (names repeat). */
  material_index?: number[];
  /** Raw import only: bone index of each skin cluster, in the file's order. */
  clusters?: number[];
  /** Raw import only: the nearest bone above the mesh node, -1 if none. */
  hang_bone?: number;
};

export type TextureLink = { prop: string; file: string; bytes: number; fnv: string; image?: number };

/** The Principled BSDF as the finisher reads it (dump_contract.py `pbr`). */
export type Pbr = {
  base_color: number[];
  base_tex: string | null;
  alpha: number;
  alpha_tex: string | null;
  alpha_channel: 'alpha' | 'color' | null;
  roughness: number;
  roughness_tex: string | null;
  metallic: number;
  metallic_tex: string | null;
  normal_tex: string | null;
  normal_from_height: boolean;
  normal_strength: number | null;
};

export type Material = {
  name: string;
  textures: TextureLink[];
  /** Raw import only: FBX Properties70 values Blender's importer reads, own and template. */
  props?: Record<string, number[]>;
  template?: Record<string, number[]>;
  pbr?: Pbr | null;
};

export type Image = { name: string; bytes: number; fnv: string; data?: Uint8Array | undefined };

export type Contract = {
  source: string;
  bones: Bone[];
  meshes: Mesh[];
  materials: Material[];
  images: Image[];
  nodes?: RawNode[];
  // writers add their own version fields (ufbx_version, blender); they pass through untyped
};

type JsonMesh = Omit<Mesh, 'position' | 'uv' | 'normal' | 'vertex' | 'joints' | 'weights' | 'indices' | 'triangle_material' | 'morphs'> & {
  position: number;
  uv: number;
  normal?: number;
  vertex?: number;
  joints: number;
  weights: number;
  indices: number;
  triangle_material: number;
  morphs: (Omit<Morph, 'delta'> & { delta: number })[];
};
type JsonContract = Omit<Contract, 'meshes' | 'images'> & {
  meshes: JsonMesh[];
  images: (Omit<Image, 'data'> & { data?: number })[];
};

/** Views into `bin`; nothing is copied. */
export function readContract(json: string, bin: Uint8Array): Contract {
  const doc = JSON.parse(json) as JsonContract;
  const view = <T>(C: new (b: ArrayBufferLike, o: number, n: number) => T, off: number, n: number): T =>
    new C(bin.buffer, bin.byteOffset + off, n);
  return {
    ...doc,
    meshes: doc.meshes.map((m) => {
      const n = m.vertex_count, t = m.triangle_count;
      return {
        ...m,
        position: view(Float32Array, m.position, n * 3),
        uv: view(Float32Array, m.uv, n * 2),
        normal: m.normal === undefined ? undefined : view(Float32Array, m.normal, n * 3),
        vertex: m.vertex === undefined ? undefined : view(Uint32Array, m.vertex, n),
        joints: view(Uint16Array, m.joints, n * MAXW),
        weights: view(Float32Array, m.weights, n * MAXW),
        indices: view(Uint32Array, m.indices, t * 3),
        triangle_material: view(Uint16Array, m.triangle_material, t),
        morphs: m.morphs.map((k) => ({ ...k, delta: view(Float32Array, k.delta, n * 3) })),
      };
    }),
    images: doc.images.map((i) => (i.data !== undefined ? { ...i, data: view(Uint8Array, i.data, i.bytes) } : { ...i, data: undefined })),
  };
}

/** Back to JSON + one blob (arrays 4-byte aligned, as the C and Python writers do). */
export function writeContract(c: Contract): { json: string; bin: Uint8Array } {
  const parts: Uint8Array[] = [];
  let size = 0;
  const put = (a: ArrayBufferView): number => {
    const pad = (4 - (size % 4)) % 4;
    if (pad) {
      parts.push(new Uint8Array(pad));
      size += pad;
    }
    const off = size;
    parts.push(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    size += a.byteLength;
    return off;
  };
  const doc: JsonContract = {
    ...c,
    meshes: c.meshes.map(({ vertex, normal, ...m }) => ({
      ...m,
      position: put(m.position),
      uv: put(m.uv),
      ...(normal ? { normal: put(normal) } : {}),
      ...(vertex ? { vertex: put(vertex) } : {}),
      joints: put(m.joints),
      weights: put(m.weights),
      indices: put(m.indices),
      triangle_material: put(m.triangle_material),
      morphs: m.morphs.map((k) => ({ ...k, delta: put(k.delta) })),
    })),
    images: c.images.map(({ data, ...i }) => (data ? { ...i, data: put(data) } : i)),
  };
  const bin = new Uint8Array(size);
  let off = 0;
  for (const p of parts) {
    bin.set(p, off);
    off += p.byteLength;
  }
  return { json: JSON.stringify(doc), bin };
}
