// A minimal glTF 2.0 binary writer: the finisher builds the JSON, this packs the binary
// chunk. Written rather than taken from a library because the VRM extensions reference nodes
// and meshes by index, and owning the indices is simpler than teaching a library VRMC_vrm.

/* eslint-disable @typescript-eslint/no-explicit-any -- glTF JSON is open-ended by design */

export type Json = Record<string, unknown>;
type TypedArray = Float32Array | Uint32Array | Uint16Array | Uint8Array;

const COMPONENT: Record<string, number> = {
  Float32Array: 5126, Uint32Array: 5125, Uint16Array: 5123, Uint8Array: 5121,
};
const ARRAY_BUFFER = 34962, ELEMENT_ARRAY_BUFFER = 34963;

export class GlbBuilder {
  readonly gltf: {
    asset: Json;
    extensionsUsed: string[];
    scene: number;
    scenes: Json[];
    nodes: Json[];
    meshes: Json[];
    skins: Json[];
    materials: Json[];
    textures: Json[];
    images: Json[];
    samplers: Json[];
    accessors: Json[];
    bufferViews: Json[];
    buffers: Json[];
    extensions: Json;
  };
  private chunks: Uint8Array[] = [];
  private size = 0;
  private imageViews = new Map<string, number>(); // content -> view: identical images stored once

  constructor(generator: string) {
    this.gltf = {
      asset: { version: '2.0', generator }, extensionsUsed: [], scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], skins: [],
      materials: [], textures: [], images: [], samplers: [], accessors: [], bufferViews: [], buffers: [], extensions: {},
    };
  }

  private view(bytes: Uint8Array, target?: number): number {
    const pad = (4 - (this.size % 4)) % 4;
    if (pad) {
      this.chunks.push(new Uint8Array(pad));
      this.size += pad;
    }
    const v: Json = { buffer: 0, byteOffset: this.size, byteLength: bytes.byteLength };
    if (target) v.target = target;
    this.chunks.push(bytes);
    this.size += bytes.byteLength;
    this.gltf.bufferViews.push(v);
    return this.gltf.bufferViews.length - 1;
  }

  private bytes(a: TypedArray): Uint8Array {
    return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  }

  /** An accessor over `data`; min/max written for VEC3 positions (the spec requires them). */
  accessor(
    data: TypedArray,
    type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT4',
    opts: { indices?: boolean; minmax?: boolean; normalized?: boolean } = {},
  ): number {
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    const acc: Json = {
      bufferView: this.view(this.bytes(data), type === 'MAT4' ? undefined : opts.indices ? ELEMENT_ARRAY_BUFFER : ARRAY_BUFFER),
      componentType: COMPONENT[data.constructor.name],
      count: data.length / comps,
      type,
    };
    if (opts.minmax) Object.assign(acc, minMax(data, comps));
    if (opts.normalized) acc.normalized = true;
    this.gltf.accessors.push(acc);
    return this.gltf.accessors.length - 1;
  }

  /**
   * A VEC3 accessor stored sparsely when most elements are zero (morph deltas: a face key
   * moves a few hundred of a mesh's vertices). min/max over the full array.
   */
  sparseVec3(data: Float32Array): number {
    const n = data.length / 3;
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (data[i * 3] || data[i * 3 + 1] || data[i * 3 + 2]) idx.push(i);
    // dense costs 12n bytes; sparse 12k + 4k (or 2k)
    if (idx.length * 16 >= n * 12) return this.accessor(data, 'VEC3', { minmax: true });
    const indices = n < 65536 ? new Uint16Array(idx) : new Uint32Array(idx);
    const values = new Float32Array(idx.length * 3);
    idx.forEach((v, k) => values.set(data.subarray(v * 3, v * 3 + 3), k * 3));
    const acc: Json = { componentType: 5126, count: n, type: 'VEC3', ...minMax(data, 3) };
    if (idx.length) {
      acc.sparse = {
        count: idx.length,
        indices: { bufferView: this.view(this.bytes(indices)), componentType: COMPONENT[indices.constructor.name] },
        values: { bufferView: this.view(this.bytes(values)) },
      };
    }
    this.gltf.accessors.push(acc);
    return this.gltf.accessors.length - 1;
  }

  image(bytes: Uint8Array, mimeType: string, name: string): number {
    const key = `${bytes.byteLength}:${fnv1a(bytes)}`;
    let view = this.imageViews.get(key);
    if (view === undefined) this.imageViews.set(key, (view = this.view(bytes)));
    this.gltf.images.push({ bufferView: view, mimeType, name });
    return this.gltf.images.length - 1;
  }

  /** The .glb / .vrm file. */
  build(): Uint8Array {
    const g: any = { ...this.gltf, buffers: [{ byteLength: this.size }] };
    for (const k of Object.keys(g)) if (Array.isArray(g[k]) && g[k].length === 0) delete g[k];
    if (!Object.keys(g.extensions ?? {}).length) delete g.extensions;
    let json = new TextEncoder().encode(JSON.stringify(g));
    const jpad = (4 - (json.byteLength % 4)) % 4;
    if (jpad) {
      const j = new Uint8Array(json.byteLength + jpad).fill(0x20);
      j.set(json);
      json = j;
    }
    const bpad = (4 - (this.size % 4)) % 4;
    const total = 12 + 8 + json.byteLength + 8 + this.size + bpad;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, json.byteLength, true);
    dv.setUint32(16, 0x4e4f534a, true);
    out.set(json, 20);
    let o = 20 + json.byteLength;
    dv.setUint32(o, this.size + bpad, true);
    dv.setUint32(o + 4, 0x004e4942, true);
    o += 8;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    return out;
  }
}

function fnv1a(b: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 0x01000193);
  return h >>> 0;
}

function minMax(data: TypedArray, comps: number): { min: number[]; max: number[] } {
  const min = Array<number>(comps).fill(Infinity), max = Array<number>(comps).fill(-Infinity);
  for (let i = 0; i < data.length; i++) {
    const c = i % comps, v = data[i]!;
    if (v < min[c]!) min[c] = v;
    if (v > max[c]!) max[c] = v;
  }
  return { min: min.map((v) => (Number.isFinite(v) ? Math.fround(v) : 0)), max: max.map((v) => (Number.isFinite(v) ? Math.fround(v) : 0)) };
}
