import { describe, expect, it } from 'vitest';
import { MAXW, type Mesh } from './contract.ts';
import { decimateMesh } from './decimate.ts';
import { surfaceDistances } from './surface.ts';

/** An n x n grid on a gently curved sheet (10 cm), uv over the unit square, two material slots. */
function sheet(n: number): Mesh {
  const position = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const v = y * n + x, u = x / (n - 1), w = y / (n - 1);
      position.set([u * 0.1, w * 0.1, 0.01 * Math.sin(u * Math.PI)], v * 3);
      uv.set([u, w], v * 2);
    }
  const indices: number[] = [], mats: number[] = [];
  for (let y = 0; y < n - 1; y++)
    for (let x = 0; x < n - 1; x++) {
      const v = y * n + x;
      indices.push(v, v + 1, v + n, v + 1, v + n + 1, v + n);
      mats.push(+(x >= (n - 1) / 2), +(x >= (n - 1) / 2));
    }
  const vc = n * n, morph = new Float32Array(vc * 3).map((_, i) => (i % 3 === 2 ? i * 1e-6 : 0));
  return {
    name: 'sheet', vertex_count: vc, triangle_count: mats.length, position, uv,
    joints: new Uint16Array(vc * MAXW), weights: new Float32Array(vc * MAXW).map((_, i) => (i % MAXW ? 0 : 1)),
    indices: Uint32Array.from(indices), triangle_material: Uint16Array.from(mats), materials: ['a', 'b'],
    morphs: [{ name: 'k', shape: 'k', inbetweens: 0, delta: morph }],
  } as Mesh;
}

describe('decimateMesh', () => {
  it('reduces within 2.5 mm, keeping original vertices with their keys and the slot seam', async () => {
    const orig = sheet(41), m = sheet(41);
    const r = await decimateMesh(m, 400);
    expect(r.after).toBeLessThan(orig.vertex_count / 2);
    const d = surfaceDistances(orig.position, orig.vertex_count, m.position, m.indices);
    expect(Math.max(...d)).toBeLessThanOrEqual(0.0025 + 1e-6);
    // every survivor is an original vertex, with that vertex's morph delta
    for (let v = 0; v < m.vertex_count; v++) {
      const x = Math.round(m.position[v * 3]! * 400), y = Math.round(m.position[v * 3 + 1]! * 400);
      const o = y * 41 + x;
      expect(m.position[v * 3 + 2]).toBeCloseTo(orig.position[o * 3 + 2]!, 6);
      expect(m.morphs[0]!.delta[v * 3 + 2]).toBeCloseTo(orig.morphs[0]!.delta[o * 3 + 2]!, 9);
    }
    // the column both slots share stays whole: all 41 of its vertices survive
    const seam = new Set<number>();
    for (let v = 0; v < m.vertex_count; v++) if (Math.abs(m.position[v * 3]! - 0.05) < 1e-6) seam.add(Math.round(m.position[v * 3 + 1]! * 400));
    expect(seam.size).toBe(41);
  });
});
