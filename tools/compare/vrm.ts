// Compare two VRMs (docs/BROWSER-PORT.md s2, Level 2), reference first:
//   node tools/compare/vrm.ts out/spike/ira.blender.vrm out/spike/ira.ts.vrm
// 1. Each file is read back into a contract -- vertices skinned at rest exactly as a runtime
//    skins them (sum of w * joint world * inverse bind), morphs likewise, weights by bone
//    name -- and tools/compare/contract.mjs judges geometry, weights and morphs.
// 2. Here: humanoid map, expressions (mesh, key, weight per expression), lookAt, first
//    person, materials (alpha mode, factors, which textures) and texture pixels.
//    Max tier: node constraints (type, source, axis, weight per node, by name) and spring bones
//    (joints and parameters per spring; colliders by node, shape and radius, positions compared
//    in world space -- the two writers give bones different frames).
// 3. --original <unreduced.vrm> (web tier): a mesh the two files reduced differently is judged
//    against the unreduced one -- how far its vertices end up from the reduced surface, ours
//    against Blender's -- and ours must keep original vertices with their original morphs.
// Exit 1 when either part fails.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { writeContract, type Contract, type Mesh } from '../../app/src/convert/contract.ts';
import { resize, type Pixels } from '../../app/src/convert/images.ts';
import { mul, type Mat4 } from '../../app/src/convert/pose.ts';
import { nodeCodec } from '../port/codec.ts';
import { surfaceDistances } from '../../app/src/convert/surface.ts';
import { DECIMATE_TOL } from '../../app/src/convert/decimate.ts';

type Glb = { json: any; bin: Uint8Array };

function readGlb(path: string): Glb {
  const b = new Uint8Array(readFileSync(path));
  const dv = new DataView(b.buffer, b.byteOffset);
  const jl = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + jl)));
  const bl = dv.getUint32(20 + jl, true);
  return { json, bin: b.subarray(28 + jl, 28 + jl + bl) };
}

const COMPS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function read(g: Glb, i: number): Float64Array {
  const a = g.json.accessors[i], n = COMPS[a.type]! * a.count;
  const out = new Float64Array(n);
  const fill = (viewIdx: number, ctype: number, count: number, comps: number, set: (k: number, v: number) => void) => {
    const v = g.json.bufferViews[viewIdx];
    const dv = new DataView(g.bin.buffer, g.bin.byteOffset + (v.byteOffset ?? 0));
    const size = { 5126: 4, 5125: 4, 5123: 2, 5121: 1, 5122: 2, 5120: 1 }[ctype]!;
    const stride = v.byteStride ?? size * comps;
    for (let e = 0; e < count; e++)
      for (let c = 0; c < comps; c++) {
        const o = e * stride + c * size;
        const x = ctype === 5126 ? dv.getFloat32(o, true) : ctype === 5125 ? dv.getUint32(o, true) : ctype === 5123 ? dv.getUint16(o, true) : dv.getUint8(o);
        set(e * comps + c, x);
      }
  };
  if (a.bufferView !== undefined) fill(a.bufferView, a.componentType, a.count, COMPS[a.type]!, (k, x) => (out[k] = x));
  if (a.normalized && a.componentType === 5121) for (let k = 0; k < n; k++) out[k]! /= 255;
  if (a.normalized && a.componentType === 5123) for (let k = 0; k < n; k++) out[k]! /= 65535;
  if (a.sparse) {
    const idx = new Float64Array(a.sparse.count), val = new Float64Array(a.sparse.count * COMPS[a.type]!);
    fill(a.sparse.indices.bufferView, a.sparse.indices.componentType, a.sparse.count, 1, (k, x) => (idx[k] = x));
    fill(a.sparse.values.bufferView, a.componentType, a.sparse.count, COMPS[a.type]!, (k, x) => (val[k] = x));
    for (let s = 0; s < a.sparse.count; s++) for (let c = 0; c < COMPS[a.type]!; c++) out[idx[s]! * COMPS[a.type]! + c] = val[s * COMPS[a.type]! + c]!;
  }
  return out;
}

function trs(n: any): Mat4 {
  if (n.matrix) return new Float64Array(n.matrix);
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return new Float64Array([
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ]);
}

function toContract(g: Glb, source: string): Contract {
  const nodes = g.json.nodes;
  const parent = new Map<number, number>();
  nodes.forEach((n: any, i: number) => (n.children ?? []).forEach((c: number) => parent.set(c, i)));
  const world = new Map<number, Mat4>();
  const worldOf = (i: number): Mat4 => {
    if (!world.has(i)) world.set(i, parent.has(i) ? mul(worldOf(parent.get(i)!), trs(nodes[i])) : trs(nodes[i]));
    return world.get(i)!;
  };
  // the skeleton: every skin's joints, and every other mesh-less node but one holding meshes
  // (Blender's armature object), an empty Blender wrote with its Daz properties (G8's necklace
  // chains) or a bare one (the tear film's node once its mesh is dropped) -- the web tier's
  // per-mesh skins list only the joints a mesh uses, so unskinned bones are in no skin
  const joints: number[] = [];
  for (const sk of g.json.skins ?? []) for (const j of sk.joints) if (!joints.includes(j)) joints.push(j);
  nodes.forEach((n: any, i: number) => {
    const holdsMesh = (n.children ?? []).some((c: number) => nodes[c].mesh !== undefined);
    const bare = !n.children?.length && !n.translation && !n.rotation && !n.matrix;
    if (n.mesh === undefined && !holdsMesh && !n.extras && !bare && !joints.includes(i)) joints.push(i);
  });
  const jointSet = new Set(joints);
  const boneOf = new Map(joints.map((j, k) => [j, k]));
  const skinMats: Mat4[][] = (g.json.skins ?? []).map((sk: any) => {
    const ibm = read(g, sk.inverseBindMatrices);
    return sk.joints.map((j: number, k: number) => mul(worldOf(j), ibm.slice(k * 16, k * 16 + 16)));
  });
  const bones = joints.map((j) => {
    let p = parent.get(j);
    while (p !== undefined && !jointSet.has(p)) p = parent.get(p);
    return { name: nodes[j].name, parent: p === undefined ? null : nodes[p].name, matrix: Array.from(worldOf(j)) };
  });
  const meshes: Mesh[] = [];
  nodes.forEach((n: any, ni: number) => {
    if (n.mesh === undefined) return;
    const skinMat: Mat4[] = n.skin !== undefined ? skinMats[n.skin]! : [];
    const skinJoints: number[] = n.skin !== undefined ? g.json.skins[n.skin].joints : [];
    const gm = g.json.meshes[n.mesh];
    const names: string[] = gm.extras?.targetNames ?? [];
    const pos: number[] = [], uv: number[] = [], nrm: number[] = [], jn: number[] = [], wt: number[] = [], idx: number[] = [], tm: number[] = [];
    const deltas: number[][] = names.map(() => []);
    const mats: string[] = [];
    const seen = new Map<number, number>(); // POSITION accessor -> first vertex
    for (const p of gm.primitives) {
      const mname = g.json.materials?.[p.material]?.name ?? '';
      if (mname.endsWith('.fringe')) continue; // 7a duplicate faces
      let slot = mats.indexOf(mname);
      if (slot < 0) slot = mats.push(mname) - 1;
      let base = seen.get(p.attributes.POSITION);
      if (base === undefined) {
        base = pos.length / 3;
        seen.set(p.attributes.POSITION, base);
        const P = read(g, p.attributes.POSITION), N = p.attributes.NORMAL !== undefined ? read(g, p.attributes.NORMAL) : null;
        const T = read(g, p.attributes.TEXCOORD_0);
        const J = p.attributes.JOINTS_0 !== undefined ? read(g, p.attributes.JOINTS_0) : null;
        const W = p.attributes.WEIGHTS_0 !== undefined ? read(g, p.attributes.WEIGHTS_0) : null;
        const D = (p.targets ?? []).map((t: any) => read(g, t.POSITION));
        const count = P.length / 3;
        for (let v = 0; v < count; v++) {
          // rest skinning: M = sum w * joint world * ibm (or the node's world when unskinned)
          let M: Float64Array;
          if (J && W && n.skin !== undefined) {
            M = new Float64Array(16);
            for (let k = 0; k < 4; k++) {
              const w = W[v * 4 + k]!;
              if (w) for (let e = 0; e < 16; e++) M[e]! += w * skinMat[J[v * 4 + k]!]![e]!;
            }
          } else M = worldOf(ni);
          const ap = (x: number, y: number, z: number, t: number) =>
            [0, 1, 2].map((r) => M[r]! * x + M[4 + r]! * y + M[8 + r]! * z + t * M[12 + r]!);
          pos.push(...ap(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!, 1));
          if (N) {
            const q = ap(N[v * 3]!, N[v * 3 + 1]!, N[v * 3 + 2]!, 0), l = Math.hypot(...q) || 1;
            nrm.push(...q.map((x) => x / l));
          }
          uv.push(T[v * 2]!, 1 - T[v * 2 + 1]!);
          for (let k = 0; k < 8; k++) {
            jn.push(J && k < 4 ? (boneOf.get(skinJoints[J[v * 4 + k]!]!) ?? 0) : 0);
            wt.push(W && k < 4 ? W[v * 4 + k]! : 0);
          }
          D.forEach((d: Float64Array, q: number) => deltas[q]!.push(...ap(d[v * 3]!, d[v * 3 + 1]!, d[v * 3 + 2]!, 0)));
        }
      }
      const I = read(g, p.indices);
      for (let k = 0; k < I.length; k++) idx.push(I[k]! + base);
      for (let k = 0; k < I.length / 3; k++) tm.push(slot);
    }
    meshes.push({
      name: n.name, mesh: gm.name, vertex_count: pos.length / 3, triangle_count: idx.length / 3,
      position: Float32Array.from(pos), uv: Float32Array.from(uv), normal: nrm.length ? Float32Array.from(nrm) : undefined,
      joints: Uint16Array.from(jn), weights: Float32Array.from(wt), indices: Uint32Array.from(idx), triangle_material: Uint16Array.from(tm),
      materials: mats, morphs: names.map((name, q) => ({ name, shape: name, inbetweens: 0, delta: Float32Array.from(deltas[q]!) })),
    });
  });
  return { source, bones, meshes, materials: [], images: [] };
}

// --- structure ------------------------------------------------------------------------------------
const [refPath, newPath, ...flags] = process.argv.slice(2);
// web tier: both sides zero morph deltas under 0.1 mm, so a vertex at that edge can differ by it
const morphMm = flags.includes('--morph-mm') ? flags[flags.indexOf('--morph-mm') + 1]! : null;
const original = flags.includes('--original') ? flags[flags.indexOf('--original') + 1]! : null;
// max tier: the twist split must leave the rest mesh as the plain export has it -- geometry
// against the plain file, bones by name and head only (the split re-hangs the arm bones)
const geometryRef = flags.includes('--geometry') ? flags[flags.indexOf('--geometry') + 1]! : null;
if (!refPath || !newPath) throw new Error('usage: node tools/compare/vrm.ts ref.vrm new.vrm');
const A = readGlb(refPath), B = readGlb(newPath);
const O = original ? readGlb(original) : null;
const fails: string[] = [];
const lines: string[] = [];
const va = A.json.extensions.VRMC_vrm, vb = B.json.extensions.VRMC_vrm;
const nodeName = (g: Glb, i: number) => g.json.nodes[i]?.name;

const hbA = Object.fromEntries(Object.entries(va.humanoid.humanBones).map(([k, v]: any) => [k, nodeName(A, v.node)]));
const hbB = Object.fromEntries(Object.entries(vb.humanoid.humanBones).map(([k, v]: any) => [k, nodeName(B, v.node)]));
const hbDiff = [...new Set([...Object.keys(hbA), ...Object.keys(hbB)])].filter((k) => hbA[k] !== hbB[k]);
lines.push(`humanoid ${Object.keys(hbA).length}/${Object.keys(hbB).length} bones, ${hbDiff.length} differ`);
if (hbDiff.length) fails.push(`humanoid differs: ${hbDiff.slice(0, 5).join(', ')}`);

const binds = (g: Glb, e: any) =>
  (e.morphTargetBinds ?? []).map((b: any) => {
    const n = g.json.nodes[b.node];
    return `${n.name}:${g.json.meshes[n.mesh].extras?.targetNames?.[b.index]}:${Math.round(b.weight * 1e4) / 1e4}`;
  }).sort().join(' ');
let exprOk = 0;
for (const kind of ['preset', 'custom'] as const) {
  const ea = va.expressions[kind] ?? {}, eb = vb.expressions[kind] ?? {};
  for (const n of new Set([...Object.keys(ea), ...Object.keys(eb)])) {
    const a = ea[n], b = eb[n];
    if (!a || !b) { fails.push(`expression ${kind}.${n} only in ${a ? 'reference' : 'candidate'}`); continue; }
    const same = binds(A, a) === binds(B, b) && ['overrideBlink', 'overrideMouth', 'overrideLookAt', 'isBinary'].every((k) => (a[k] ?? 'none') === (b[k] ?? 'none'));
    if (same) exprOk++;
    else fails.push(`expression ${kind}.${n}: ${binds(A, a).slice(0, 120)} | vs | ${binds(B, b).slice(0, 120)}`);
  }
}
lines.push(`expressions ${exprOk} identical`);

const la = va.lookAt, lb = vb.lookAt;
const offErr = Math.hypot(...la.offsetFromHeadBone.map((x: number, i: number) => x - lb.offsetFromHeadBone[i]));
const rangesSame = ['rangeMapHorizontalInner', 'rangeMapHorizontalOuter', 'rangeMapVerticalUp', 'rangeMapVerticalDown']
  .every((k) => JSON.stringify(la[k]) === JSON.stringify(lb[k])) && la.type === lb.type;
lines.push(`lookAt offset differs ${(offErr * 1000).toFixed(3)} mm, range maps ${rangesSame ? 'same' : 'DIFFER'}`);
if (offErr > 0.001 || !rangesSame) fails.push('lookAt differs');

const fp = (g: Glb, v: any) => v.firstPerson.meshAnnotations.map((m: any) => `${nodeName(g, m.node)}:${m.type}`).sort().join(' ');
if (fp(A, va) !== fp(B, vb)) fails.push('firstPerson differs');
lines.push(`firstPerson ${fp(A, va) === fp(B, vb) ? 'same' : 'DIFFERS'}`);

// --- max tier: node constraints and spring bones ------------------------------------------------
function nodeWorld(g: Glb): (i: number) => Mat4 {
  const parent = new Map<number, number>();
  g.json.nodes.forEach((n: any, i: number) => (n.children ?? []).forEach((c: number) => parent.set(c, i)));
  const memo = new Map<number, Mat4>();
  const world = (i: number): Mat4 => {
    if (!memo.has(i)) memo.set(i, parent.has(i) ? mul(world(parent.get(i)!), trs(g.json.nodes[i])) : trs(g.json.nodes[i]));
    return memo.get(i)!;
  };
  return world;
}
const constraints = (g: Glb) => new Map<string, string>(g.json.nodes.flatMap((n: any) => {
  const c = n.extensions?.VRMC_node_constraint?.constraint;
  if (!c) return [];
  const [kind, v] = Object.entries(c)[0] as [string, any];
  return [[n.name, `${kind} from ${nodeName(g, v.source)} ${v.aimAxis ?? v.rollAxis ?? v.rotation ?? ''} w${v.weight ?? 1}`]];
}));
const ca = constraints(A), cb = constraints(B);
const conDiff = [...new Set([...ca.keys(), ...cb.keys()])].filter((n) => ca.get(n) !== cb.get(n));
if (ca.size || cb.size) lines.push(`node constraints ${ca.size}/${cb.size}, ${conDiff.length} differ`);
for (const n of conDiff.slice(0, 5)) fails.push(`node constraint ${n}: ${ca.get(n) ?? '-'} | vs | ${cb.get(n) ?? '-'}`);

const sprA = A.json.extensions?.VRMC_springBone, sprB = B.json.extensions?.VRMC_springBone;
if (sprA || sprB) {
  if (!sprA || !sprB) fails.push(`spring bones only in ${sprA ? 'reference' : 'candidate'}`);
  else {
    const joints = (g: Glb, sp: any) => sp.joints.map((j: any) => `${nodeName(g, j.node)}:${j.stiffness}/${j.gravityPower}/${j.dragForce}/${j.hitRadius}/${(j.gravityDir ?? []).join(',')}`).join(' ');
    const springsB = new Map(sprB.springs.map((sp: any) => [sp.name, sp]));
    let springOk = 0;
    for (const sp of sprA.springs) {
      const o: any = springsB.get(sp.name);
      if (!o) fails.push(`spring ${sp.name} missing`);
      else if (joints(A, sp) !== joints(B, o) || (sp.colliderGroups ?? []).length !== (o.colliderGroups ?? []).length) fails.push(`spring ${sp.name}: ${joints(A, sp)} | vs | ${joints(B, o)}`);
      else springOk++;
    }
    if (sprB.springs.length !== sprA.springs.length) fails.push(`springs ${sprA.springs.length} vs ${sprB.springs.length}`);
    // colliders: same node, shape and radius; offsets compared as world points
    const wa = nodeWorld(A), wb = nodeWorld(B);
    const at = (M: Mat4, p: number[]) => [0, 1, 2].map((r) => M[r]! * p[0]! + M[4 + r]! * p[1]! + M[8 + r]! * p[2]! + M[12 + r]!);
    const shape = (g: Glb, w: (i: number) => Mat4, c: any) => {
      const [kind, v] = Object.entries(c.shape)[0] as [string, any];
      return { node: nodeName(g, c.node), kind, r: v.radius, pts: [v.offset, v.tail].filter(Boolean).map((p: number[]) => at(w(c.node), p)) };
    };
    const colB = sprB.colliders.map((c: any) => shape(B, wb, c));
    let worst = 0, colOk = 0;
    for (const c of sprA.colliders.map((x: any) => shape(A, wa, x))) {
      const o = colB.find((x: any) => x.node === c.node && x.kind === c.kind);
      if (!o) { fails.push(`collider ${c.kind} on ${c.node} missing`); continue; }
      const d = Math.max(Math.abs(c.r - o.r), ...c.pts.map((p: number[], k: number) => Math.hypot(...p.map((x, e) => x - o.pts[k]![e]!))));
      worst = Math.max(worst, d);
      if (d > 1e-4) fails.push(`collider ${c.kind} on ${c.node} off by ${(d * 1000).toFixed(3)} mm`);
      else colOk++;
    }
    if (sprB.colliders.length !== sprA.colliders.length) fails.push(`colliders ${sprA.colliders.length} vs ${sprB.colliders.length}`);
    lines.push(`spring bones ${springOk}/${sprA.springs.length} springs same; colliders ${colOk}/${sprA.colliders.length} within 0.1 mm (worst ${(worst * 1000).toFixed(3)} mm)`);
  }
}

// --- materials and texture pixels -------------------------------------------------------------------------
async function texPixels(g: Glb, info: any): Promise<Pixels | null> {
  if (!info) return null;
  const img = g.json.images[g.json.textures[info.index].source];
  const v = g.json.bufferViews[img.bufferView];
  return nodeCodec.decode(g.bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength));
}
function pixelDiff(a: Pixels, b: Pixels): { rgb: number; alpha: number } {
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  const ra = resize(a, w, h), rb = resize(b, w, h);
  let rgb = 0, alpha = 0;
  for (let i = 0; i < w * h; i++) {
    // premultiplied: colour under a transparent texel is never seen (a palette PNG keeps any)
    const aa = ra.data[i * 4 + 3]! / 255, ab = rb.data[i * 4 + 3]! / 255;
    for (let c = 0; c < 3; c++) rgb += Math.abs(ra.data[i * 4 + c]! * aa - rb.data[i * 4 + c]! * ab);
    alpha += Math.abs(ra.data[i * 4 + 3]! - rb.data[i * 4 + 3]!);
  }
  return { rgb: rgb / (w * h * 3), alpha: alpha / (w * h) };
}
const matsB = new Map(B.json.materials.map((m: any) => [m.name, m]));
const matsO = new Map((O?.json.materials ?? []).map((m: any) => [m.name, m]));
let matOk = 0, worstRgb = 0, worstAlpha = 0, worstName = '';
const lossy: string[] = []; // --original: textures further from the unreduced one than Blender's
for (const ma of A.json.materials) {
  const mb: any = matsB.get(ma.name);
  if (!mb) { fails.push(`material ${ma.name} missing`); continue; }
  const pa = ma.pbrMetallicRoughness ?? {}, pb = mb.pbrMetallicRoughness ?? {};
  const diffs: string[] = [];
  if ((ma.alphaMode ?? 'OPAQUE') !== (mb.alphaMode ?? 'OPAQUE')) diffs.push(`alphaMode ${ma.alphaMode} vs ${mb.alphaMode}`);
  if ((ma.alphaCutoff ?? 0.5) !== (mb.alphaCutoff ?? 0.5)) diffs.push('alphaCutoff');
  if (!!ma.doubleSided !== !!mb.doubleSided) diffs.push('doubleSided');
  for (const k of ['metallicFactor', 'roughnessFactor'])
    if (Math.abs((pa[k] ?? 1) - (pb[k] ?? 1)) > 1e-5) diffs.push(`${k} ${pa[k]} vs ${pb[k]}`);
  if (JSON.stringify((pa.baseColorFactor ?? [1, 1, 1, 1]).map((x: number) => x.toFixed(4))) !== JSON.stringify((pb.baseColorFactor ?? [1, 1, 1, 1]).map((x: number) => x.toFixed(4))))
    diffs.push('baseColorFactor');
  if (!!pa.baseColorTexture !== !!pb.baseColorTexture) diffs.push('baseColorTexture presence');
  if (!!ma.normalTexture !== !!mb.normalTexture) diffs.push('normalTexture presence');
  if ((ma.normalTexture?.scale ?? 1) !== (mb.normalTexture?.scale ?? 1)) diffs.push('normal scale');
  const mo: any = matsO.get(ma.name);
  for (const [ta, tb, to] of [[pa.baseColorTexture, pb.baseColorTexture, mo?.pbrMetallicRoughness?.baseColorTexture], [ma.normalTexture, mb.normalTexture, mo?.normalTexture]]) {
    const xa = await texPixels(A, ta), xb = await texPixels(B, tb);
    if (!xa || !xb) continue;
    const d = pixelDiff(xa, xb);
    const xo = O ? await texPixels(O, to) : null;
    if (xo) {
      const ea = pixelDiff(xo, xa), eb = pixelDiff(xo, xb);
      if (eb.rgb > Math.max(ea.rgb + 1, 6) || eb.alpha > Math.max(ea.alpha + 1, 6))
        lossy.push(`${ma.name} rgb ${eb.rgb.toFixed(2)} alpha ${eb.alpha.toFixed(2)} vs Blender's ${ea.rgb.toFixed(2)} / ${ea.alpha.toFixed(2)}`);
    }
    if (d.rgb > worstRgb || d.alpha > worstAlpha) worstName = ma.name;
    worstRgb = Math.max(worstRgb, d.rgb);
    worstAlpha = Math.max(worstAlpha, d.alpha);
  }
  if (diffs.length) fails.push(`material ${ma.name}: ${diffs.join(', ')}`);
  else matOk++;
}
lines.push(`materials ${matOk}/${A.json.materials.length} same; texture pixels worst mean |diff| rgb ${worstRgb.toFixed(2)} alpha ${worstAlpha.toFixed(2)} (of 255; ${worstName})`);
// 6/255 mean: Blender's own JPEG re-encode alone differs ~2.5 from a lossless resize, and on a
// noisy 4000 px bump map taken to 1024 (a non-integer factor) its scale filter and our box
// filter differ by 4.7 before any encoding (tools/port/texdiff.ts, ENVIRONMENT.md s34)
// web tier (--original): two lossy encodings of a noisy map differ from each other by more
// than either does from the source (G3's bump-made normal map: Blender's JPEG 23/255 off the
// lossless 512 px, ours 21, the two 14 apart), so each is judged against the unreduced texture:
// no further from it than Blender's result (+1), or within 6
if (O) {
  lines.push(`textures against the unreduced file: ${lossy.length ? lossy.length + ' further than Blender' : 'none further than Blender'}`);
  for (const l of lossy) fails.push(`texture ${l}`);
} else if (worstRgb > 6 || worstAlpha > 6) fails.push(`texture pixels differ by up to ${worstRgb.toFixed(2)} / ${worstAlpha.toFixed(2)}`);

const sa = readFileSync(refPath).byteLength, sb = readFileSync(newPath).byteLength;
lines.push(`size ${(sa / 1e6).toFixed(1)} MB vs ${(sb / 1e6).toFixed(1)} MB`);
if (sb > sa * 1.15) fails.push('candidate more than 15 % larger');

// --- geometry through the contract comparison ----------------------------------------------------------
const contracts = { ref: toContract(geometryRef ? readGlb(geometryRef) : A, 'ref'), new: toContract(B, 'new') };
for (const [p, tag] of [[refPath, 'ref'], [newPath, 'new']] as const) {
  const { json, bin } = writeContract(contracts[tag]);
  writeFileSync(`${p}.${tag}.json`, json);
  writeFileSync(`${p}.${tag}.bin`, bin);
}
// a mesh is "reduced" when either file kept under 90 % of the unreduced one's vertices (seam
// splits and unused vertices move counts by a few per cent without any reduction)
const reduced: string[] = [];
if (original) {
  const Oc = toContract(O!, 'original');
  for (const mb of contracts.new.meshes) {
    const ma = contracts.ref.meshes.find((m) => m.name === mb.name), mo = Oc.meshes.find((m) => m.name === mb.name);
    if (!ma || !mo || Math.min(ma.vertex_count, mb.vertex_count) >= mo.vertex_count * 0.9) continue;
    reduced.push(mb.name);
    const q = (d: Float64Array, f: number) => +(Float64Array.from(d).sort()[Math.floor(f * (d.length - 1))]! * 1000).toFixed(2);
    const da = surfaceDistances(mo.position, mo.vertex_count, ma.position, ma.indices);
    const db = surfaceDistances(mo.position, mo.vertex_count, mb.position, mb.indices);
    const sub = onOriginal(mb, mo);
    lines.push(`reduced ${mb.name}: verts ${mo.vertex_count} -> Blender ${ma.vertex_count}, ours ${mb.vertex_count}; ` +
      `original to surface mm p99/max Blender ${q(da, 0.99)}/${q(da, 1)}, ours ${q(db, 0.99)}/${q(db, 1)}; ` +
      `ours on original vertices ${sub.on}/${mb.vertex_count}, morphs worst ${sub.worst}`);
    // the reduction's own limit, or Blender's deviation where its result is coarser than that;
    // vertex counts are not judged -- the budget is, and the file size above
    if (q(db, 0.99) > Math.max(q(da, 0.99), DECIMATE_TOL * 1000)) fails.push(`${mb.name}: reduced surface strays ${q(db, 0.99)} mm (p99)`);
    if (sub.on < mb.vertex_count) fails.push(`${mb.name}: ${mb.vertex_count - sub.on} vertices not on an original one`);
    if (!sub.ok) fails.push(`${mb.name}: morphs differ from the original: ${sub.worst}`);
  }
}

/**
 * Each vertex of `m` against the original vertex at its spot (position + uv): how many sit on
 * one, and whether their morph deltas match it as contract.mjs judges (0.1 mm or --morph-mm, or
 * 1 % of the key's largest delta).
 */
function onOriginal(m: Mesh, o: Mesh): { on: number; ok: boolean; worst: string } {
  const CELL = 0.0005, cells = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
  for (let v = 0; v < o.vertex_count; v++) {
    const k = key(o.position[v * 3]!, o.position[v * 3 + 1]!, o.position[v * 3 + 2]!);
    (cells.get(k) ?? cells.set(k, []).get(k)!).push(v);
  }
  const limit = Number(morphMm ?? 0.1) / 1000;
  const keys = m.morphs.map((k) => {
    const ko = o.morphs.find((x) => x.name === k.name);
    let big = 0;
    if (ko) for (let v = 0; v < o.vertex_count; v++) big = Math.max(big, Math.hypot(ko.delta[v * 3]!, ko.delta[v * 3 + 1]!, ko.delta[v * 3 + 2]!));
    return { k, ko, tol: Math.max(limit, big * 0.01) };
  });
  let on = 0, ok = true, worst = 0, worstKey = '';
  for (let v = 0; v < m.vertex_count; v++) {
    const [x, y, z] = [m.position[v * 3]!, m.position[v * 3 + 1]!, m.position[v * 3 + 2]!];
    let best = -1, bd = Infinity;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const w of cells.get(key(x + dx * CELL, y + dy * CELL, z + dz * CELL)) ?? []) {
            const d = Math.hypot(o.position[w * 3]! - x, o.position[w * 3 + 1]! - y, o.position[w * 3 + 2]! - z) +
              Math.hypot(o.uv[w * 2]! - m.uv[v * 2]!, o.uv[w * 2 + 1]! - m.uv[v * 2 + 1]!) * 0.01;
            if (d < bd) { bd = d; best = w; }
          }
    if (best < 0 || bd > 0.0001) continue;
    on++;
    for (const { k, ko, tol } of keys) {
      if (!ko) continue;
      const e = Math.hypot(...[0, 1, 2].map((c) => k.delta[v * 3 + c]! - ko.delta[best * 3 + c]!));
      if (e > tol) ok = false;
      if (e > worst) [worst, worstKey] = [e, k.name];
    }
  }
  return { on, ok, worst: worst ? `${worstKey} ${(worst * 1000).toFixed(3)} mm` : '0 mm' };
}
let geometry = '';
let geometryOk = true;
try {
  geometry = execFileSync('node', ['tools/compare/contract.mjs', `${refPath}.ref`, `${newPath}.new`, ...(geometryRef ? [] : ['--exact']), ...(reduced.length ? ['--decimated', JSON.stringify(reduced)] : []), ...(morphMm ? ['--morph-mm', morphMm] : [])], { encoding: 'utf8' });
} catch (e: any) {
  geometry = e.stdout ?? String(e);
  geometryOk = false;
}

console.log(`${fails.length || !geometryOk ? 'FAIL' : 'PASS'} vrm ${newPath} vs ${refPath}`);
for (const l of lines) console.log(`  ${l}`);
console.log(geometry.trimEnd().split('\n').map((l) => `  ${l}`).join('\n'));
for (const f of fails.slice(0, 15)) console.log(`  x ${f}`);
process.exit(fails.length || !geometryOk ? 1 : 0);
