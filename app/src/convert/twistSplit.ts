// Max tier: split a limb's twist across its bend and twist bones with VRM node constraints
// (src/blender/twist_split.py, ENVIRONMENT.md s25). A VRM player rotates only humanoid bones;
// on a Daz arm those are the BEND bones, so a 90 deg forearm roll lands at the elbow and the
// skin collapses there to 77 % of its radius. Split 45/45 between bend and twist bone the worst
// slice keeps 92 %.
//
//     parent -- <bend>_pre -+- <bend>_drv     humanoid bone; the animation lands here
//                           |     '- <twist>    (full roll, as before)
//                           '- <bend>_swing   aim at the limb's end -> swing, no roll
//                                 '- <bend>    roll 0.5 from _drv
//
// Blender's exporter writes its own frame for every bone, so twist_split.py turns _pre onto the
// limb after export and rewrites the bend bone's inverse bind matrix. Our writer gives bones
// identity frames, so it only has to give _pre, _swing and the bend bone one limb-aligned frame
// (+Y along the limb) -- `twistFrames` -- and the constraints read the roll about local Y.

import type { Bone } from './contract.ts';
import type { Vec3 } from './pose.ts';
import type { Json } from './glb.ts';

export const ROLL_WEIGHT = 0.5;

/** One limb: humanoid name, bend and twist bones, the bone whose head ends the limb, the parent. */
export type TwistChain = { vrm: string; bend: string; twist: string; end: string; parent: string };

export const TWIST_CHAINS: Record<string, TwistChain[]> = {
  daz_genesis3_8: (['left', 'right'] as const).flatMap((side) => {
    const s = side[0];
    return [
      { vrm: `${side}UpperArm`, bend: `${s}ShldrBend`, twist: `${s}ShldrTwist`, end: `${s}ForearmBend`, parent: `${s}Collar` },
      { vrm: `${side}LowerArm`, bend: `${s}ForearmBend`, twist: `${s}ForearmTwist`, end: `${s}Hand`, parent: `${s}ShldrTwist` },
    ];
  }),
};

/** A quaternion, glTF order [x, y, z, w]. */
export type Quat = [number, number, number, number];

/**
 * twist_split.restructure: insert _pre/_drv/_swing bones at each bend bone's head and re-hang
 * the bend and twist bones. Returns {humanoid name: _drv bone} for the humanoid map, or null
 * when the family has no chains (twist_split.py refuses those).
 */
export function restructureTwist(bones: Bone[], family: string | null): { remap: Record<string, string>; chains: TwistChain[] } | null {
  const chains = family ? TWIST_CHAINS[family] : undefined;
  if (!chains) return null;
  const byName = new Map(bones.map((b) => [b.name, b]));
  if (!chains.every((c) => [c.bend, c.twist, c.end, c.parent].every((n) => byName.has(n)))) return null;
  const remap: Record<string, string> = {};
  for (const c of chains) {
    const m = byName.get(c.bend)!.matrix;
    const at = (name: string, parent: string) => {
      const b: Bone = { name, parent, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, m[12]!, m[13]!, m[14]!, 1] };
      bones.push(b);
      byName.set(name, b);
    };
    at(`${c.bend}_pre`, c.parent);
    at(`${c.bend}_drv`, `${c.bend}_pre`);
    at(`${c.bend}_swing`, `${c.bend}_pre`);
    hang(byName.get(c.bend)!, `${c.bend}_swing`);
    hang(byName.get(c.twist)!, `${c.bend}_drv`);
    remap[c.vrm] = `${c.bend}_drv`;
  }
  return { remap, chains };
}

function hang(b: Bone, parent: string) {
  b.parent = parent;
  delete b.parent_index;
}

/** World frames of _pre, _swing and the bend bone: +Y from the bend bone's head to the limb's end. */
export function twistFrames(chains: TwistChain[], head: (name: string) => Vec3): Map<string, Quat> {
  const frames = new Map<string, Quat>();
  for (const c of chains) {
    const a = head(c.bend), b = head(c.end);
    const q = fromTo([0, 1, 0], [b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    for (const n of [`${c.bend}_pre`, `${c.bend}_swing`, c.bend]) frames.set(n, q);
  }
  return frames;
}

/** twist_split.add_constraints: aim on _swing (at the limb's end), roll 0.5 from _drv on the bend bone. */
export function twistConstraints(chains: TwistChain[], node: (name: string) => number): Map<number, Json> {
  const out = new Map<number, Json>();
  for (const c of chains) {
    out.set(node(`${c.bend}_swing`), { specVersion: '1.0', constraint: { aim: { source: node(c.end), aimAxis: 'PositiveY', weight: 1 } } });
    out.set(node(c.bend), { specVersion: '1.0', constraint: { roll: { source: node(`${c.bend}_drv`), rollAxis: 'Y', weight: ROLL_WEIGHT } } });
  }
  return out;
}

/** Shortest rotation taking direction a onto direction b. */
export function fromTo(a: Vec3, b: Vec3): Quat {
  const la = Math.hypot(...a), lb = Math.hypot(...b);
  const u = a.map((x) => x / la) as Vec3, v = b.map((x) => x / lb) as Vec3;
  const c: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const w = 1 + u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const n = Math.hypot(c[0], c[1], c[2], w);
  return [c[0] / n, c[1] / n, c[2] / n, w / n];
}

export const qmul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
export const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
export function qrot(q: Quat, v: Vec3): Vec3 {
  const p = qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q));
  return [p[0], p[1], p[2]];
}
/** Renormalised (twist_split._unit): the Khronos validator rejects a component above 1. */
export function qunit(q: Quat): Quat {
  const n = Math.hypot(...q);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}
