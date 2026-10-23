// Max tier: VRM spring bones (VRMC_springBone) for the bones a hair or clothing item brings
// (src/blender/spring_bones.py, ENVIRONMENT.md s29). Daz/CC items ship their own bones (a
// store hair's `Fringe A`..`J`, `Left Tail A`..`C`); they become springs so they swing.
//
// `prepareSprings` runs before the export T-pose, as spring_bones.prepare does inside
// vrm_export.py: it finds item-bone chains, adds a `<bone>_tip` bone to each chain end (FBX
// keeps only pivots), lifts chain roots off helper bones and fits body colliders. `springExtension`
// writes the extension with the exported nodes (colliders on humanoid nodes, offsets in each
// node's frame). Positions are glTF world (y up); spring_bones.py works in Blender's z-up world
// and converts at the end.
//
// Blender's vertex groups hold one weight per source vertex; the contract splits vertices at
// seams, so every per-vertex sum and median here counts each source vertex once.

import { MAXW, type Bone, type Mesh } from './contract.ts';
import type { Json } from './glb.ts';
import type { Vec3 } from './pose.ts';

const MIN_W = 0.05;
const TIP_REACH = 1.6;
const SHORT = 0.12; // metres of lever: fringe-length strands are stiffer
const PARAMS = { // three-vrm units: stiffness and gravity per second, drag 0..1
  short: { stiffness: 1.6, gravityPower: 0.05, dragForce: 0.55, hitRadius: 0.012 },
  long: { stiffness: 0.9, gravityPower: 0.15, dragForce: 0.45, hitRadius: 0.02 },
};

type Collider = { bone: string; r: number; sphere?: Vec3; capsule?: [Vec3, Vec3] };
export type SpringSpec = {
  springs: { name: string; joints: string[]; params: (typeof PARAMS)['short'] }[];
  colliders: Collider[];
};
export type SpringReport = {
  springs: Record<string, [number, number]>;
  colliders: Record<string, number>;
  colliders_shrunk: Record<string, number>;
  roots_lifted: number;
};

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const headOf = (b: Bone): Vec3 => [b.matrix[12]!, b.matrix[13]!, b.matrix[14]!];
const r3 = (x: number) => Math.round(x * 1000) / 1000;
/** Distance from p to the segment a-b. */
function segDist(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a), ap = sub(p, a);
  const t = Math.min(1, Math.max(0, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / Math.max(ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2, 1e-9)));
  return len(sub(p, [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]]));
}

/** Each source vertex once: [contract vertex, bone -> weight]. */
function* sourceVertices(m: Mesh, bones: Bone[]): Generator<[number, Map<string, number>]> {
  const seen = new Set<number>();
  for (let v = 0; v < m.vertex_count; v++) {
    const id = m.vertex ? m.vertex[v]! : v;
    if (seen.has(id)) continue;
    seen.add(id);
    const g = new Map<string, number>();
    for (let k = 0; k < MAXW; k++) {
      const w = m.weights[v * MAXW + k]!;
      if (w > 0) g.set(bones[m.joints[v * MAXW + k]!]!.name, (g.get(bones[m.joints[v * MAXW + k]!]!.name) ?? 0) + w);
    }
    yield [v, g];
  }
}

/** spring_bones.prepare. Mutates `bones` (tip bones added, chain roots lifted). */
export function prepareSprings(bones: Bone[], meshes: Mesh[], table: Record<string, string>): { spec: SpringSpec; report: SpringReport } {
  const byName = new Map(bones.map((b) => [b.name, b]));
  const parentOf = (n: string) => byName.get(n)?.parent ?? null;
  const humanoid = new Set(Object.values(table).filter((n) => byName.has(n)));
  const groups = meshes.map((m) => [...sourceVertices(m, bones)]);
  const has = (mi: number, n: string | undefined) => n !== undefined && groups[mi]!.some(([, g]) => g.has(n));
  let bodyIdx = 0, bodyScore = -1;
  meshes.forEach((_, mi) => {
    const s = [table.leftHand, table.leftFoot, table.head].filter((n) => has(mi, n)).length;
    if (s > bodyScore) [bodyIdx, bodyScore] = [mi, s];
  });
  // the figure: the body and every mesh with face shape keys (CC teeth, lashes, strand brows)
  const figure = new Set(meshes.map((m, mi) => (mi === bodyIdx || m.morphs.length ? mi : -1)).filter((mi) => mi >= 0));
  const usedBody = new Set<string>(), usedItems = new Set<string>();
  groups.forEach((list, mi) => {
    for (const [, g] of list) for (const [n, w] of g) if (w > MIN_W) (figure.has(mi) ? usedBody : usedItems).add(n);
  });
  const isCopy = (n: string) => {
    const m = /^(.*)\.(\d+)$/.exec(n);
    return !!m && byName.has(m[1]!);
  };
  const humanoidAbove = (n: string) => {
    let p = parentOf(n);
    while (p !== null && !humanoid.has(p)) p = parentOf(p);
    return p;
  };
  // a non-humanoid bone that skins the body between n and its humanoid ancestor: n belongs to
  // the figure's own rig (CC's teeth hang off CC_Base_JawRoot), not to an item
  const viaFigure = (n: string) => {
    let p = parentOf(n);
    while (p !== null && !humanoid.has(p)) {
      if (usedBody.has(p)) return true;
      p = parentOf(p);
    }
    return false;
  };
  const item = new Set([...usedItems].filter((n) => byName.has(n) && !humanoid.has(n) && !usedBody.has(n) && !isCopy(n) && humanoidAbove(n) !== null && !viaFigure(n)));
  const children = new Map<string, string[]>();
  for (const b of bones) if (b.parent !== null) children.set(b.parent, [...(children.get(b.parent) ?? []), b.name]);
  const chains: string[][] = [];
  for (const r of [...item].filter((n) => !item.has(parentOf(n) ?? '')).toSorted(byCodepoint)) {
    const stack = [[r]];
    while (stack.length) {
      const ch = stack.pop()!;
      const kids = (children.get(ch[ch.length - 1]!) ?? []).filter((c) => item.has(c)).toSorted(byCodepoint);
      if (kids.length === 1) stack.push([...ch, kids[0]!]);
      else {
        chains.push(ch);
        stack.push(...kids.map((k) => [k]));
      }
    }
  }

  // tip of each chain end: where the hair it carries ends
  const tips = new Map<string, Vec3>();
  for (const ch of chains) {
    const end = ch[ch.length - 1]!, pivot = headOf(byName.get(end)!);
    const acc: Vec3 = [0, 0, 0];
    let wsum = 0, far = 0;
    meshes.forEach((m, mi) => {
      if (mi === bodyIdx) return;
      for (const [v, g] of groups[mi]!) {
        const w = g.get(end) ?? 0;
        if (w <= MIN_W) continue;
        const p: Vec3 = [m.position[v * 3]!, m.position[v * 3 + 1]!, m.position[v * 3 + 2]!];
        for (let c = 0; c < 3; c++) acc[c] = acc[c]! + p[c]! * w;
        wsum += w;
        far = Math.max(far, len(sub(p, pivot)));
      }
    });
    if (!wsum) continue;
    const d = sub(acc.map((x) => x / wsum) as Vec3, pivot);
    const L = Math.min(len(d) * TIP_REACH, far);
    if (L < 0.01) continue;
    tips.set(end, pivot.map((x, c) => x + (d[c]! / len(d)) * L) as Vec3);
  }

  // A chain root under a helper bone (`Left Tail`: unweighted, neither humanoid nor a spring)
  // moves onto its humanoid ancestor: three-vrm 3.5.5's VRM 1.0 loader reads such a helper's
  // stale identity matrix and flings the strand on the first frame (s29).
  let lifted = 0;
  for (const ch of chains) {
    const p = parentOf(ch[0]!);
    if (p === null || humanoid.has(p)) continue;
    const up = humanoidAbove(ch[0]!);
    if (up === null) continue;
    const b = byName.get(ch[0]!)!;
    b.parent = up;
    delete b.parent_index;
    lifted++;
  }
  for (const [end, p] of tips) {
    const b: Bone = { name: `${end}_tip`, parent: end, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p[0], p[1], p[2], 1] };
    bones.push(b);
    byName.set(b.name, b);
  }

  // colliders from the body mesh: vertices grouped by their dominant bone
  const body = meshes[bodyIdx]!;
  const co: Vec3[] = [], dom: (string | null)[] = [];
  for (const [v, g] of groups[bodyIdx]!) {
    co.push([body.position[v * 3]!, body.position[v * 3 + 1]!, body.position[v * 3 + 2]!]);
    let best: string | null = null, bw = -1;
    for (const [n, w] of g) if (w > bw) [best, bw] = [n, w];
    dom.push(best);
  }
  const under = (n: string | null, top: string) => {
    for (let p = n; p !== null; p = parentOf(p)) if (p === top) return true;
    return false;
  };
  // nearest humanoid bone at or above n (toes belong to the foot, not the thigh)
  const owner = (n: string | null) => {
    let p = n;
    while (p !== null && !humanoid.has(p)) p = parentOf(p);
    return p;
  };
  const pos = (vrm: string): Vec3 | null => {
    const b = byName.get(table[vrm] ?? '');
    return b ? headOf(b) : null;
  };
  const colliders: Collider[] = [];
  const headBone = table.head, headPos = pos('head');
  if (headBone && headPos) {
    const hv = co.filter((p, i) => under(dom[i]!, headBone) && p[1] > headPos[1]);
    const lo = [0, 1, 2].map((c) => Math.min(...hv.map((p) => p[c]!))), hi = [0, 1, 2].map((c) => Math.max(...hv.map((p) => p[c]!)));
    // Blender's x and y extents (its y is glTF's -z)
    colliders.push({ bone: 'head', sphere: [0, 1, 2].map((c) => (lo[c]! + hi[c]!) / 2) as Vec3, r: (0.9 * Math.min(hi[0]! - lo[0]!, hi[2]! - lo[2]!)) / 2 });
  }
  const own = new Map(dom.map((d) => [d, owner(d)]));
  for (const [vrm, a, b] of [
    ['neck', 'neck', 'head'], ['upperChest', 'upperChest', 'neck'],
    ['leftShoulder', 'leftShoulder', 'leftUpperArm'], ['rightShoulder', 'rightShoulder', 'rightUpperArm'],
    ['leftUpperArm', 'leftUpperArm', 'leftLowerArm'], ['rightUpperArm', 'rightUpperArm', 'rightLowerArm'],
    ['leftUpperLeg', 'leftUpperLeg', 'leftLowerLeg'], ['rightUpperLeg', 'rightUpperLeg', 'rightLowerLeg'],
  ] as const) {
    const pa = pos(a), pb = pos(b), name = table[vrm];
    if (!pa || !pb || !name) continue;
    const ds = co.filter((_, i) => own.get(dom[i]!) === name).map((p) => segDist(p, pa, pb));
    if (ds.length < 20) continue;
    colliders.push({ bone: vrm, capsule: [pa, pb], r: 0.85 * median(ds) });
  }

  // no joint tip may start inside a collider
  const tipPts: Vec3[] = [];
  for (const ch of chains) {
    for (const n of ch.slice(1)) tipPts.push(headOf(byName.get(n)!));
    const t = tips.get(ch[ch.length - 1]!);
    if (t) tipPts.push(t);
  }
  const hitMax = Math.max(PARAMS.short.hitRadius, PARAMS.long.hitRadius);
  const shrunk: Record<string, number> = {};
  for (const c of colliders)
    for (const p of tipPts) {
      const d = c.sphere ? len(sub(p, c.sphere)) : segDist(p, c.capsule![0], c.capsule![1]);
      const room = d - hitMax - 0.005;
      if (room < c.r) {
        c.r = Math.max(room, 0);
        shrunk[c.bone] = r3(c.r);
      }
    }
  const kept = colliders.filter((c) => c.r > 0.01);

  const springs: SpringSpec['springs'] = [];
  const report: SpringReport = { springs: {}, colliders: {}, colliders_shrunk: shrunk, roots_lifted: lifted };
  for (const ch of chains) {
    const t = tips.get(ch[ch.length - 1]!);
    if (!t) continue;
    const lever = len(sub(t, headOf(byName.get(ch[0]!)!)));
    springs.push({ name: ch[0]!, joints: [...ch, `${ch[ch.length - 1]}_tip`], params: PARAMS[lever < SHORT ? 'short' : 'long'] });
    report.springs[ch[0]!] = [ch.length, r3(lever)];
  }
  for (const c of kept) report.colliders[c.bone] = r3(c.r);
  return { spec: { springs, colliders: kept }, report };
}

/** spring_bones.add_springs: the extension, given the written nodes' names and world frames. */
export function springExtension(
  spec: SpringSpec, humanBones: Record<string, { node: number }>, nodeIndex: (name: string) => number | undefined,
  toLocal: (node: number, p: Vec3) => Vec3,
): Json | null {
  if (!spec.springs.length) return null;
  const local = (node: number, p: Vec3) => toLocal(node, p).map((x) => Math.round(x * 1e6) / 1e6);
  const colliders: Json[] = [];
  for (const c of spec.colliders) {
    const node = humanBones[c.bone]?.node;
    if (node === undefined) continue;
    const radius = Math.round(c.r * 1e4) / 1e4;
    const shape = c.sphere
      ? { sphere: { offset: local(node, c.sphere), radius } }
      : { capsule: { offset: local(node, c.capsule![0]), tail: local(node, c.capsule![1]), radius } };
    colliders.push({ node, shape });
  }
  const springs = spec.springs
    .filter((s) => s.joints.every((n) => nodeIndex(n) !== undefined))
    .map((s) => ({
      name: s.name, colliderGroups: colliders.length ? [0] : [],
      joints: s.joints.map((n) => ({ node: nodeIndex(n)!, gravityDir: [0, -1, 0], ...s.params })),
    }));
  return {
    specVersion: '1.0', colliders,
    colliderGroups: colliders.length ? [{ name: 'body', colliders: colliders.map((_, i) => i) }] : [],
    springs,
  };
}

/** numpy's median: the mean of the two middle values for an even count. */
function median(xs: number[]): number {
  const s = xs.toSorted((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Python's sorted() on str: by code point, not locale. */
function byCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
