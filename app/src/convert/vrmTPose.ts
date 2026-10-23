// The VRM add-on's automatic T-pose (vrm/editor/t_pose.py set_estimated_humanoid_t_pose,
// add-on 4.7.1, after the VRM 1.0 T-pose spec), which Blender's export applies: arms and
// fingers along +-X, thumbs 45 deg forward, hands levelled on their fingers, legs straight
// down. The add-on writes that pose over the original bind matrices; here it is baked as the
// rest pose instead (same rendered result, bind stays the identity -- ENVIRONMENT.md s33).
// Directions are the add-on's, turned from Blender's frame into glTF's: (x, y, z) -> (x, z, -y).

import type { Mesh } from './contract.ts';
import { applyPoseAsRest, rotationAbout, rotationDifference, type Pose, type Vec3 } from './pose.ts';

type Chain =
  | { kind: 'single'; dir: Vec3; bones: string[] }
  | { kind: 'level'; dir: Vec3; parent: string; children: string[] };

const S = Math.SQRT1_2;
const fingers = (side: 'left' | 'right', f: string) => [`${side}${f}Proximal`, `${side}${f}Intermediate`, `${side}${f}Distal`];

function chains(side: 'left' | 'right'): Chain[] {
  const x = side === 'left' ? 1 : -1;
  return [
    { kind: 'single', dir: [x, 0, 0], bones: [`${side}UpperArm`, `${side}LowerArm`, `${side}Hand`] },
    { kind: 'level', dir: [x, 0, 0], parent: `${side}Hand`, children: ['Index', 'Middle', 'Ring', 'Little'].map((f) => `${side}${f}Proximal`) },
    { kind: 'single', dir: [x * S, 0, S], bones: [`${side}ThumbMetacarpal`, `${side}ThumbProximal`, `${side}ThumbDistal`] },
    ...['Index', 'Middle', 'Ring', 'Little'].map((f): Chain => ({ kind: 'single', dir: [x, 0, 0], bones: fingers(side, f) })),
    { kind: 'single', dir: [0, -1, 0], bones: [`${side}UpperLeg`, `${side}LowerLeg`, `${side}Foot`] },
  ];
}

/** humanBones: VRM name -> bone index. Returns the bones it turned and by how much (degrees). */
export function vrmTPose(pose: Pose, humanBones: Record<string, { node: number }>, meshes: Mesh[]): Record<string, number> {
  const turned: Record<string, number> = {};
  pose.reset(); // set_estimated_humanoid_t_pose clears every pose bone first (a file's saved pose too)
  const parentOf = pose.bones.map((b) => (b.parent === null ? -1 : (pose.index.get(b.parent) ?? -1)));
  const turn = (i: number, from: Vec3, to: Vec3) => {
    if (Math.hypot(...from) < 1e-12 || Math.hypot(...to) < 1e-12) return;
    const { axis, angle } = rotationDifference(from, to);
    if (angle < 1e-9) return;
    pose.transformSubtree(i, rotationAbout(axis, angle, pose.head(i)));
    const name = pose.bones[i]!.name;
    turned[name] = (turned[name] ?? 0) + (angle * 180) / Math.PI;
  };
  for (const chain of [...chains('right'), ...chains('left')]) {
    if (chain.kind === 'single') {
      const ids = chain.bones.map((n) => humanBones[n]?.node).filter((i): i is number => i !== undefined);
      if (ids.length < 2) continue;
      // root .. tip through the parents, intermediate (non-humanoid) bones included
      const path: number[] = [];
      let b = ids[ids.length - 1]!;
      for (;;) {
        path.unshift(b);
        if (b === ids[0]) break;
        b = parentOf[b]!;
        if (b < 0) {
          path.length = 0;
          break;
        }
      }
      for (let k = 0; k + 1 < path.length; k++) {
        const h = pose.head(path[k]!), c = pose.head(path[k + 1]!);
        turn(path[k]!, [c[0] - h[0], c[1] - h[1], c[2] - h[2]], chain.dir);
      }
    } else {
      const parent = humanBones[chain.parent]?.node;
      const kids = chain.children.map((n) => humanBones[n]?.node).filter((i): i is number => i !== undefined);
      if (parent === undefined || !kids.length) continue;
      const avg: Vec3 = [0, 0, 0];
      for (const k of kids) pose.head(k).forEach((v, c) => (avg[c] = avg[c]! + v / kids.length));
      const h = pose.head(parent);
      // the fingers' average, moved onto the hand's front-back plane (Blender's y is glTF's -z)
      turn(parent, [avg[0] - h[0], avg[1] - h[1], 0], chain.dir);
    }
  }
  applyPoseAsRest(pose, meshes, 'skinned');
  for (const k of Object.keys(turned)) turned[k] = Math.round(turned[k]! * 100) / 100;
  return turned;
}
