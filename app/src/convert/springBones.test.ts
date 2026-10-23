import { describe, expect, it } from 'vitest';
import { MAXW, type Bone, type Mesh } from './contract.ts';
import { prepareSprings, springExtension } from './springBones.ts';

const bone = (name: string, parent: string | null, p: [number, number, number]): Bone => ({ name, parent, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...p, 1] });

/** Points with one or two weighted bones each: [position, [[bone index, weight], ...]]. */
function mesh(name: string, pts: [[number, number, number], [number, number][]][], morphs = 0): Mesh {
  const n = pts.length, joints = new Uint16Array(n * MAXW), weights = new Float32Array(n * MAXW);
  pts.forEach(([, w], v) => w.forEach(([j, x], k) => { joints[v * MAXW + k] = j; weights[v * MAXW + k] = x; }));
  return {
    name, mesh: name, vertex_count: n, triangle_count: 0, position: Float32Array.from(pts.flatMap(([p]) => p)), uv: new Float32Array(n * 2),
    joints, weights, indices: new Uint32Array(0), triangle_material: new Uint16Array(0), materials: [],
    morphs: Array.from({ length: morphs }, (_, i) => ({ name: `k${i}`, shape: `k${i}`, inbetweens: 0, delta: new Float32Array(n * 3) })),
  } as Mesh;
}

describe('prepareSprings', () => {
  // hip 0 -> spine 1 -> neck 2 -> head 3; hands/feet so the body is recognised; Helper 6 (an
  // unweighted helper under the head) -> Tail 7 (an item strand); Teeth 8 under Jaw 9 (which
  // skins the body): figure, not item
  const bones = [
    bone('hip', null, [0, 1, 0]), bone('spine', 'hip', [0, 1.2, 0]), bone('neck', 'spine', [0, 1.5, 0]), bone('head', 'neck', [0, 1.6, 0]),
    bone('lHand', 'spine', [0.7, 1.4, 0]), bone('lFoot', 'hip', [0.1, 0.1, 0]),
    bone('Helper', 'head', [0, 1.65, -0.05]), bone('Tail', 'Helper', [0, 1.62, -0.1]),
    bone('Teeth', 'Jaw', [0, 1.6, 0.05]), bone('Jaw', 'head', [0, 1.6, 0.03]),
  ];
  const table = { hips: 'hip', spine: 'spine', neck: 'neck', head: 'head', leftHand: 'lHand', leftFoot: 'lFoot' };
  const head: [[number, number, number], [number, number][]][] = [];
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * 2 * Math.PI;
    head.push([[0.08 * Math.cos(a), 1.7, 0.08 * Math.sin(a)], [[3, 1]]]);
  }
  const body = mesh('body', [...head, [[0.7, 1.4, 0], [[4, 1]]], [[0.1, 0.1, 0], [[5, 1]]], [[0, 1.58, 0.06], [[9, 1]]]]);
  // the strand: weighted 0.6 to Tail, falling to y 1.3
  const hair = mesh('hair', [[[0, 1.5, -0.12], [[7, 0.6], [3, 0.4]]], [[0, 1.3, -0.12], [[7, 0.6], [3, 0.4]]]]);
  const teeth = mesh('teeth', [[[0, 1.6, 0.05], [[8, 1]]]], 1);

  it('turns item bones into springs with a tip where their hair ends, and lifts them off helpers', () => {
    const bs = bones.map((b) => ({ ...b }));
    const { spec, report } = prepareSprings(bs, [body, hair, teeth], table);
    expect(spec.springs.map((s) => s.joints)).toEqual([['Tail', 'Tail_tip']]);
    expect(report.roots_lifted).toBe(1);
    expect(bs.find((b) => b.name === 'Tail')!.parent).toBe('head');
    const tip = bs.find((b) => b.name === 'Tail_tip')!;
    // pivot + 1.6 x (centroid - pivot), capped at the farthest weighted vertex (32 cm away)
    const pivot = [0, 1.62, -0.1], centroid = [0, 1.4, -0.12];
    const d = centroid.map((c, i) => c - pivot[i]!), L = Math.hypot(...d);
    const want = pivot.map((p, i) => p + (d[i]! / L) * Math.min(L * 1.6, Math.hypot(0, 1.3 - 1.62, -0.02)));
    tip.matrix.slice(12, 15).forEach((x, i) => expect(x).toBeCloseTo(want[i]!, 6));
    expect(spec.springs[0]!.params.stiffness).toBe(0.9); // a long strand (lever > 12 cm)
    // the head collider: centred on the head's ring, 0.9 of its half-width
    const hc = spec.colliders.find((c) => c.bone === 'head')!;
    expect(hc.sphere![1]).toBeCloseTo(1.7, 6);
    expect(hc.r).toBeCloseTo(0.9 * 0.08, 3);
  });

  it('writes the extension with colliders in their node frames', () => {
    const bs = bones.map((b) => ({ ...b }));
    const { spec } = prepareSprings(bs, [body, hair, teeth], table);
    const idx = new Map(bs.map((b, i) => [b.name, i]));
    const ext = springExtension(spec, { head: { node: 3 } }, (n) => idx.get(n), (node, p) => {
      const h = bs[node]!.matrix.slice(12, 15);
      return [p[0] - h[0]!, p[1] - h[1]!, p[2] - h[2]!];
    })!;
    expect(ext.springs).toEqual([{ name: 'Tail', colliderGroups: [0], joints: [
      { node: 7, gravityDir: [0, -1, 0], stiffness: 0.9, gravityPower: 0.15, dragForce: 0.45, hitRadius: 0.02 },
      { node: idx.get('Tail_tip'), gravityDir: [0, -1, 0], stiffness: 0.9, gravityPower: 0.15, dragForce: 0.45, hitRadius: 0.02 },
    ] }]);
    const c = (ext.colliders as { node: number; shape: { sphere: { offset: number[] } } }[])[0]!;
    expect(c.node).toBe(3);
    expect(c.shape.sphere.offset[1]).toBeCloseTo(0.1, 6); // 1.7 - head 1.6
  });
});
