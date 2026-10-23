// Compare two VRMs (docs/BROWSER-PORT.md s2, Level 2), reference first:
//   node tools/compare/vrm.ts out/spike/ira.blender.vrm out/spike/ira.ts.vrm
// 1. Each file is read back into a contract -- vertices skinned at rest exactly as a runtime
//    skins them (sum of w * joint world * inverse bind), morphs likewise, weights by bone
//    name -- and tools/compare/contract.mjs judges geometry, weights and morphs.
// 2. Here: humanoid map, expressions (mesh, key, weight per expression), lookAt, first
//    person, materials (alpha mode, factors, which textures) and texture pixels.
// Exit 1 when either part fails.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { writeContract, type Contract, type Mesh } from '../../app/src/convert/contract.ts';
import { resize, type Pixels } from '../../app/src/convert/images.ts';
import { mul, type Mat4 } from '../../app/src/convert/pose.ts';
import { nodeCodec } from '../port/codec.ts';

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
  const skin = g.json.skins?.[0];
  const joints: number[] = skin?.joints ?? [];
  const jointSet = new Set(joints);
  const ibm = skin ? read(g, skin.inverseBindMatrices) : new Float64Array();
  const skinMat = joints.map((j, k) => mul(worldOf(j), ibm.slice(k * 16, k * 16 + 16)));
  const bones = joints.map((j) => {
    let p = parent.get(j);
    while (p !== undefined && !jointSet.has(p)) p = parent.get(p);
    return { name: nodes[j].name, parent: p === undefined ? null : nodes[p].name, matrix: Array.from(worldOf(j)) };
  });
  const meshes: Mesh[] = [];
  nodes.forEach((n: any, ni: number) => {
    if (n.mesh === undefined) return;
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
            jn.push(J && k < 4 ? joints.indexOf(joints[J[v * 4 + k]!]!) : 0);
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
const [refPath, newPath] = process.argv.slice(2);
if (!refPath || !newPath) throw new Error('usage: node tools/compare/vrm.ts ref.vrm new.vrm');
const A = readGlb(refPath), B = readGlb(newPath);
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
    for (let c = 0; c < 3; c++) rgb += Math.abs(ra.data[i * 4 + c]! - rb.data[i * 4 + c]!);
    alpha += Math.abs(ra.data[i * 4 + 3]! - rb.data[i * 4 + 3]!);
  }
  return { rgb: rgb / (w * h * 3), alpha: alpha / (w * h) };
}
const matsB = new Map(B.json.materials.map((m: any) => [m.name, m]));
let matOk = 0, worstRgb = 0, worstAlpha = 0, worstName = '';
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
  for (const [ta, tb] of [[pa.baseColorTexture, pb.baseColorTexture], [ma.normalTexture, mb.normalTexture]]) {
    const xa = await texPixels(A, ta), xb = await texPixels(B, tb);
    if (!xa || !xb) continue;
    const d = pixelDiff(xa, xb);
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
if (worstRgb > 6 || worstAlpha > 6) fails.push(`texture pixels differ by up to ${worstRgb.toFixed(2)} / ${worstAlpha.toFixed(2)}`);

const sa = readFileSync(refPath).byteLength, sb = readFileSync(newPath).byteLength;
lines.push(`size ${(sa / 1e6).toFixed(1)} MB vs ${(sb / 1e6).toFixed(1)} MB`);
if (sb > sa * 1.15) fails.push('candidate more than 15 % larger');

// --- geometry through the contract comparison ----------------------------------------------------------
for (const [g, p, tag] of [[A, refPath, 'ref'], [B, newPath, 'new']] as const) {
  const { json, bin } = writeContract(toContract(g, tag));
  writeFileSync(`${p}.${tag}.json`, json);
  writeFileSync(`${p}.${tag}.bin`, bin);
}
let geometry = '';
let geometryOk = true;
try {
  geometry = execFileSync('node', ['tools/compare/contract.mjs', `${refPath}.ref`, `${newPath}.new`, '--exact'], { encoding: 'utf8' });
} catch (e: any) {
  geometry = e.stdout ?? String(e);
  geometryOk = false;
}

console.log(`${fails.length || !geometryOk ? 'FAIL' : 'PASS'} vrm ${newPath} vs ${refPath}`);
for (const l of lines) console.log(`  ${l}`);
console.log(geometry.trimEnd().split('\n').map((l) => `  ${l}`).join('\n'));
for (const f of fails.slice(0, 15)) console.log(`  x ${f}`);
process.exit(fails.length || !geometryOk ? 1 : 0);
