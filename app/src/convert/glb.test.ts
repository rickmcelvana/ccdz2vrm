import { describe, expect, it } from 'vitest';
import { GlbBuilder } from './glb.ts';

function parse(glb: Uint8Array) {
  const dv = new DataView(glb.buffer, glb.byteOffset);
  const jl = dv.getUint32(12, true);
  return { magic: dv.getUint32(0, true), total: dv.getUint32(8, true), json: JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jl))) };
}

describe('GlbBuilder', () => {
  it('writes a well-formed GLB with 4-byte aligned chunks', () => {
    const b = new GlbBuilder('test');
    b.accessor(new Float32Array([0, 0, 0, 1, 2, 3]), 'VEC3', { minmax: true });
    b.accessor(new Uint16Array([0, 1, 1]), 'SCALAR', { indices: true });
    const glb = b.build();
    const { magic, total, json } = parse(glb);
    expect(magic).toBe(0x46546c67);
    expect(total).toBe(glb.byteLength);
    expect(glb.byteLength % 4).toBe(0);
    expect(json.accessors[0]).toMatchObject({ count: 2, type: 'VEC3', min: [0, 0, 0], max: [1, 2, 3] });
    expect(json.bufferViews[1].byteOffset % 4).toBe(0);
    expect(json.bufferViews[1].target).toBe(34963);
  });

  it('stores mostly-zero morph deltas sparsely, with min/max over the whole array', () => {
    const b = new GlbBuilder('test');
    const d = new Float32Array(300 * 3);
    d.set([0.1, -0.2, 0.3], 42 * 3);
    b.sparseVec3(d);
    const acc = parse(b.build()).json.accessors[0];
    expect(acc.bufferView).toBeUndefined();
    expect(acc.sparse.count).toBe(1);
    expect(acc.count).toBe(300);
    expect(acc.min).toEqual([0, Math.fround(-0.2), 0]);
  });
});
