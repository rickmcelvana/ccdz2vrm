// Compare two contracts (docs/BROWSER-PORT.md s2), reference first:
//   node tools/compare/contract.mjs out/spike/ira.blender out/spike/ira.ufbx [--json report.json] [--exact]
// --exact: bones and skin weights by full name (`hip.003` is not `hip`) and bone parents
// compared, for cleaned contracts whose names follow Blender's; materials' `pbr` compared
// whenever both sides carry it.
// Vertices are matched by position (+ uv), never by index: importers split and order
// vertices differently. Bones by base name (Blender's `.001` duplicates folded) + nearest
// head. Exit code 1 when a tolerance from the plan is broken.
// --decimated '["mesh", ...]': these meshes are only reported (the web tier reduced them;
// tools/compare/vrm.ts --original judges them against the unreduced surface).
import { readFileSync, writeFileSync } from 'node:fs';

const [refPath, newPath, ...rest] = process.argv.slice(2);
const jsonOut = rest.includes('--json') ? rest[rest.indexOf('--json') + 1] : null;
const exact = rest.includes('--exact');
const decimated = new Set(rest.includes('--decimated') ? JSON.parse(rest[rest.indexOf('--decimated') + 1]) : []);
const morphMmArg = rest.includes('--morph-mm') ? Number(rest[rest.indexOf('--morph-mm') + 1]) : null;

const TOL = {
  position_mm: 0.1, // rest vertex position, max
  bone_head_mm: 0.1,
  dominant_bone: 0.995, // share of matched vertices whose strongest bone agrees
  morph_mm: 0.1, // or MORPH_REL of the key's largest delta (--morph-mm overrides)
  morph_rel: 0.01,
  normal_deg_p99: 5,
};

function load(p) {
  const doc = JSON.parse(readFileSync(`${p}.json`, 'utf8'));
  const bin = readFileSync(`${p}.bin`);
  const view = (T, off, n) => new T(bin.buffer, bin.byteOffset + off, n);
  return { doc, f32: (o, n) => view(Float32Array, o, n), u16: (o, n) => view(Uint16Array, o, n), u32: (o, n) => view(Uint32Array, o, n) };
}

const base = (n) => n.replace(/\.\d+$/, '');
const boneKey = exact ? (n) => n : base;
const pct = (a) => Math.round(a * 10000) / 100;
const mm = (m) => Math.round(m * 1e6) / 1e3;
// a loop, not Math.max(...arr): spreading 160k+ values overflows the call stack
function maxOf(arr) {
  let m = 0;
  for (const x of arr) if (x > m) m = x;
  return m;
}
function quantile(arr, q) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

if (morphMmArg) TOL.morph_mm = morphMmArg;
const A = load(refPath), B = load(newPath);
const report = { reference: A.doc.source, candidate: B.doc.source, bones: {}, meshes: [], images: {}, failures: [] };
const fail = (what) => report.failures.push(what);

// --- bones -----------------------------------------------------------------------------
const head = (b) => [b.matrix[12], b.matrix[13], b.matrix[14]];
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
function axes(m) {
  const col = (c) => { const v = [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]]; const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
  return [col(0), col(1), col(2)];
}
function angleDeg(ma, mb) {
  // rotation between two frames: trace of Ra^T Rb
  const a = axes(ma), b = axes(mb);
  let tr = 0;
  for (let i = 0; i < 3; i++) tr += a[i][0] * b[i][0] + a[i][1] * b[i][1] + a[i][2] * b[i][2];
  return (Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180) / Math.PI;
}
const byBase = new Map();
B.doc.bones.forEach((b, i) => {
  const k = boneKey(b.name);
  if (!byBase.has(k)) byBase.set(k, []);
  byBase.get(k).push(i);
});
const boneMap = new Map(); // ref bone index -> candidate bone index
const used = new Set();
const headErr = [], axisErr = [];
for (const [i, b] of A.doc.bones.entries()) {
  const cands = (byBase.get(boneKey(b.name)) ?? []).filter((j) => !used.has(j));
  if (!cands.length) continue;
  const j = cands.reduce((best, c) => (dist(head(B.doc.bones[c]), head(b)) < dist(head(B.doc.bones[best]), head(b)) ? c : best));
  used.add(j);
  boneMap.set(i, j);
  headErr.push(dist(head(B.doc.bones[j]), head(b)));
  axisErr.push(angleDeg(b.matrix, B.doc.bones[j].matrix));
}
report.bones = {
  reference: A.doc.bones.length, candidate: B.doc.bones.length, matched: boneMap.size,
  head_mm: { p50: mm(quantile(headErr, 0.5)), p99: mm(quantile(headErr, 0.99)), max: mm(maxOf(headErr)) },
  axis_deg: { p50: +quantile(axisErr, 0.5).toFixed(2), p99: +quantile(axisErr, 0.99).toFixed(2), max: +maxOf(axisErr).toFixed(2) },
  unmatched_reference: A.doc.bones.filter((_, i) => !boneMap.has(i)).map((b) => b.name).slice(0, 20),
};
if (boneMap.size < A.doc.bones.length) fail(`bones: ${A.doc.bones.length - boneMap.size} reference bones unmatched`);
if (maxOf(headErr) * 1000 > TOL.bone_head_mm) fail(`bones: head error ${report.bones.head_mm.max} mm`);
const refBoneName = (i) => boneKey(A.doc.bones[i]?.name ?? '?');
const newBoneName = (j) => boneKey(B.doc.bones[j]?.name ?? '?');
if (exact) {
  const parentOff = [];
  for (const [i, j] of boneMap) if ((A.doc.bones[i].parent ?? null) !== (B.doc.bones[j].parent ?? null)) parentOff.push(`${A.doc.bones[i].name}: ${A.doc.bones[i].parent} vs ${B.doc.bones[j].parent}`);
  report.bones.parents_differ = parentOff.length;
  if (parentOff.length) fail(`bones: ${parentOff.length} parents differ, e.g. ${parentOff.slice(0, 3).join('; ')}`);
}

// --- meshes ------------------------------------------------------------------------------
const meshName = (n) => base(n).replace(/\.Shape$/, '');
function pairMeshes() {
  const pairs = [];
  const free = new Set(B.doc.meshes.keys());
  for (const [i, m] of A.doc.meshes.entries()) {
    let j = [...free].find((k) => meshName(B.doc.meshes[k].name) === meshName(m.name));
    if (j === undefined) j = [...free].find((k) => B.doc.meshes[k].vertex_count === m.vertex_count);
    if (j !== undefined) { free.delete(j); pairs.push([i, j]); } else pairs.push([i, null]);
  }
  return { pairs, extra: [...free].map((k) => B.doc.meshes[k].name) };
}

const CELL = 0.0005; // 0.5 mm grid
function grid(P, n) {
  const g = new Map();
  for (let v = 0; v < n; v++) {
    const k = `${Math.floor(P[v * 3] / CELL)},${Math.floor(P[v * 3 + 1] / CELL)},${Math.floor(P[v * 3 + 2] / CELL)}`;
    let l = g.get(k);
    if (!l) g.set(k, (l = []));
    l.push(v);
  }
  return g;
}
function nearest(g, P, UV, p, uv, N = null, n = null) {
  const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL), cz = Math.floor(p[2] / CELL);
  let best = -1, bd = Infinity;
  for (let x = cx - 1; x <= cx + 1; x++)
    for (let y = cy - 1; y <= cy + 1; y++)
      for (let z = cz - 1; z <= cz + 1; z++)
        for (const v of g.get(`${x},${y},${z}`) ?? []) {
          const d = Math.hypot(P[v * 3] - p[0], P[v * 3 + 1] - p[1], P[v * 3 + 2] - p[2]);
          const du = Math.hypot(UV[v * 2] - uv[0], UV[v * 2 + 1] - uv[1]);
          // 1 mm == 0.1 uv units: same spot, then same uv, then (when both have them) the same
          // normal -- a seam or a two-layer cloth puts different normals on one position + uv
          const dn = N && n ? 1 - (N[v * 3] * n[0] + N[v * 3 + 1] * n[1] + N[v * 3 + 2] * n[2]) : 0;
          const score = d + du * 0.01 + dn * 0.0001;
          if (score < bd) { bd = score; best = v; }
        }
  return best;
}

const { pairs, extra } = pairMeshes();
if (extra.length) report.extra_candidate_meshes = extra;
for (const [i, j] of pairs) {
  const ma = A.doc.meshes[i];
  const r = { name: ma.name, vertices: ma.vertex_count, triangles: ma.triangle_count, morphs: ma.morphs.length };
  report.meshes.push(r);
  if (j === null) { r.missing = true; fail(`mesh ${ma.name}: no counterpart`); continue; }
  const mb = B.doc.meshes[j];
  r.candidate = { name: mb.name, vertices: mb.vertex_count, triangles: mb.triangle_count, morphs: mb.morphs.length };
  if (decimated.has(ma.name)) { r.decimated = true; continue; }
  const PA = A.f32(ma.position, ma.vertex_count * 3), PB = B.f32(mb.position, mb.vertex_count * 3);
  const UA = A.f32(ma.uv, ma.vertex_count * 2), UB = B.f32(mb.uv, mb.vertex_count * 2);
  const g = grid(PB, mb.vertex_count);
  const match = new Int32Array(ma.vertex_count).fill(-1);
  const perr = [];
  let uvBad = 0;
  const NAm = ma.normal !== undefined && mb.normal !== undefined ? A.f32(ma.normal, ma.vertex_count * 3) : null;
  const NBm = NAm ? B.f32(mb.normal, mb.vertex_count * 3) : null;
  for (let v = 0; v < ma.vertex_count; v++) {
    const p = [PA[v * 3], PA[v * 3 + 1], PA[v * 3 + 2]];
    const w = nearest(g, PB, UB, p, [UA[v * 2], UA[v * 2 + 1]], NBm, NAm ? [NAm[v * 3], NAm[v * 3 + 1], NAm[v * 3 + 2]] : null);
    if (w < 0) continue;
    match[v] = w;
    perr.push(Math.hypot(PB[w * 3] - p[0], PB[w * 3 + 1] - p[1], PB[w * 3 + 2] - p[2]));
    if (Math.hypot(UB[w * 2] - UA[v * 2], UB[w * 2 + 1] - UA[v * 2 + 1]) > 1e-4) uvBad++;
  }
  const matched = perr.length;
  r.matched = pct(matched / ma.vertex_count);
  r.position_mm = { p99: mm(quantile(perr, 0.99)), max: mm(maxOf(perr)) };
  r.uv_mismatch = pct(uvBad / Math.max(1, matched));
  if (matched < ma.vertex_count) fail(`mesh ${ma.name}: ${ma.vertex_count - matched} vertices with no counterpart within 0.5 mm`);
  else if (maxOf(perr) * 1000 > TOL.position_mm) fail(`mesh ${ma.name}: position error ${r.position_mm.max} mm`);

  // normals, when both sides carry them (VRM read-backs): angle between matched vertices'
  if (ma.normal !== undefined && mb.normal !== undefined) {
    const NA = A.f32(ma.normal, ma.vertex_count * 3), NB = B.f32(mb.normal, mb.vertex_count * 3);
    const ang = [];
    for (let v = 0; v < ma.vertex_count; v++) {
      const w = match[v];
      if (w < 0) continue;
      const d = NA[v * 3] * NB[w * 3] + NA[v * 3 + 1] * NB[w * 3 + 1] + NA[v * 3 + 2] * NB[w * 3 + 2];
      ang.push((Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI);
    }
    r.normal_deg = { p50: +quantile(ang, 0.5).toFixed(2), p99: +quantile(ang, 0.99).toFixed(2), max: +maxOf(ang).toFixed(2) };
    if (quantile(ang, 0.99) > TOL.normal_deg_p99) fail(`mesh ${ma.name}: normals differ, p99 ${r.normal_deg.p99} deg`);
  }

  // skin weights, compared by bone base name
  const JA = A.u16(ma.joints, ma.vertex_count * 8), WA = A.f32(ma.weights, ma.vertex_count * 8);
  const JB = B.u16(mb.joints, mb.vertex_count * 8), WB = B.f32(mb.weights, mb.vertex_count * 8);
  let skinned = 0, agree = 0;
  const l1 = [];
  for (let v = 0; v < ma.vertex_count; v++) {
    const w = match[v];
    if (w < 0) continue;
    const wa = new Map(), wb = new Map();
    let sa = 0, sb = 0;
    for (let k = 0; k < 8; k++) {
      if (WA[v * 8 + k] > 0) { const n = refBoneName(JA[v * 8 + k]); wa.set(n, (wa.get(n) ?? 0) + WA[v * 8 + k]); sa += WA[v * 8 + k]; }
      if (WB[w * 8 + k] > 0) { const n = newBoneName(JB[w * 8 + k]); wb.set(n, (wb.get(n) ?? 0) + WB[w * 8 + k]); sb += WB[w * 8 + k]; }
    }
    if (!sa && !sb) continue;
    skinned++;
    // agree when the reference's strongest bone is also (one of) the candidate's strongest:
    // a 50/50 vertex may list its two bones in either order
    const top = (m) => [...m].sort((x, y) => y[1] - x[1])[0]?.[0];
    const maxB = Math.max(0, ...wb.values());
    if ((wb.get(top(wa)) ?? -1) >= maxB - 1e-4) agree++;
    let d = 0;
    for (const n of new Set([...wa.keys(), ...wb.keys()])) d += Math.abs((wa.get(n) ?? 0) / (sa || 1) - (wb.get(n) ?? 0) / (sb || 1));
    l1.push(d);
  }
  if (skinned) {
    r.skin = { vertices: skinned, dominant_agree: pct(agree / skinned), l1_p99: +quantile(l1, 0.99).toFixed(4), l1_max: +maxOf(l1).toFixed(4) };
    if (agree / skinned < TOL.dominant_bone) fail(`mesh ${ma.name}: dominant bone agrees on ${r.skin.dominant_agree} %`);
  }

  // morphs, by name (Daz/CC name channels `<mesh>__<key>`; Blender drops the prefix)
  const strip = (n) => n.replace(/^.*__/, '');
  const mbByName = new Map(mb.morphs.map((m) => [strip(m.name), m]));
  for (const m of mb.morphs) if (!mbByName.has(strip(m.shape))) mbByName.set(strip(m.shape), m);
  let mOk = 0, mMissing = 0, mBad = 0, worst = { key: '', mm: 0 };
  for (const ka of ma.morphs) {
    const kb = mbByName.get(strip(ka.name));
    if (!kb) { mMissing++; continue; }
    const DA = A.f32(ka.delta, ma.vertex_count * 3), DB = B.f32(kb.delta, mb.vertex_count * 3);
    let big = 0, err = 0;
    for (let v = 0; v < ma.vertex_count; v++) {
      const w = match[v];
      big = Math.max(big, Math.hypot(DA[v * 3], DA[v * 3 + 1], DA[v * 3 + 2]));
      if (w < 0) continue;
      err = Math.max(err, Math.hypot(DB[w * 3] - DA[v * 3], DB[w * 3 + 1] - DA[v * 3 + 1], DB[w * 3 + 2] - DA[v * 3 + 2]));
    }
    if (err * 1000 <= TOL.morph_mm || err <= big * TOL.morph_rel) mOk++;
    else mBad++;
    if (err > worst.mm / 1000) worst = { key: ka.name, mm: mm(err), largest_delta_mm: mm(big) };
  }
  r.morph_result = { ok: mOk, off: mBad, missing: mMissing, worst };
  if (mBad) fail(`mesh ${ma.name}: ${mBad} morphs outside tolerance (worst ${worst.key} ${worst.mm} mm)`);
  if (mMissing) fail(`mesh ${ma.name}: ${mMissing} morphs missing`);
  const matsA = new Set(ma.materials), matsB = new Set(mb.materials);
  const lostMats = [...matsA].filter((x) => !matsB.has(x) && !matsB.has(base(x)));
  if (lostMats.length) r.materials_missing = lostMats;
}

// --- materials (pbr) ----------------------------------------------------------------------------
const pbrB = new Map(B.doc.materials.filter((m) => m.pbr).map((m) => [exact ? m.name : base(m.name), m.pbr]));
let pbrChecked = 0;
const pbrOff = [];
for (const m of A.doc.materials) {
  if (!m.pbr) continue;
  const pb = pbrB.get(exact ? m.name : base(m.name));
  if (!pb) { if (pbrB.size) pbrOff.push(`${m.name}: missing`); continue; }
  pbrChecked++;
  for (const [k, va] of Object.entries(m.pbr)) {
    const vb = pb[k];
    // a reference normal made from a height map after a .blend reload names its source instead
    // of hashing it (dump_contract.py generated_normal); the flag beside it is still compared
    if (k === 'normal_tex' && typeof va === 'string' && va.startsWith('height:') && m.pbr.normal_from_height && pb.normal_from_height) continue;
    const same = Array.isArray(va) ? va.every((x, q) => Math.abs(x - vb?.[q]) < 1e-5)
      : typeof va === 'number' ? Math.abs(va - vb) < 1e-5 : va === vb;
    if (!same) pbrOff.push(`${m.name}.${k}: ${JSON.stringify(va)} vs ${JSON.stringify(vb)}`);
  }
}
if (pbrB.size) {
  report.materials = { checked: pbrChecked, differ: pbrOff.length, examples: pbrOff.slice(0, 12) };
  if (pbrOff.length) fail(`materials: ${pbrOff.length} pbr fields differ, e.g. ${pbrOff.slice(0, 3).join('; ')}`);
}

// --- images ----------------------------------------------------------------------------------
const fa = new Set(A.doc.images.filter((i) => !i.generated).map((i) => i.fnv).filter((h) => h && h !== '0000000000000000'));
const fb = new Set(B.doc.images.map((i) => i.fnv));
report.images = { reference: fa.size, candidate: fb.size, same: [...fa].filter((h) => fb.has(h)).length };
if (B.doc.images.length && report.images.same < fa.size) fail(`images: ${fa.size - report.images.same} reference images not found byte-identical`);

report.pass = report.failures.length === 0;
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 1));
console.log(`${report.pass ? 'PASS' : 'FAIL'} ${report.candidate} vs ${report.reference}`);
console.log(`  bones ${report.bones.matched}/${report.bones.reference} (candidate ${report.bones.candidate}); head mm ${JSON.stringify(report.bones.head_mm)}; axis deg ${JSON.stringify(report.bones.axis_deg)}`);
for (const m of report.meshes) {
  if (m.missing) { console.log(`  ${m.name}: MISSING`); continue; }
  if (m.decimated) { console.log(`  ${m.name}: decimated, verts ${m.vertices} vs ${m.candidate.vertices} (judged against the original)`); continue; }
  console.log(`  ${m.name}: verts ${m.vertices}/${m.candidate.vertices} matched ${m.matched}% pos ${JSON.stringify(m.position_mm)} uv-off ${m.uv_mismatch}%` +
    (m.normal_deg ? ` normal deg p99 ${m.normal_deg.p99} max ${m.normal_deg.max}` : '') +
    (m.skin ? ` skin-agree ${m.skin.dominant_agree}% l1p99 ${m.skin.l1_p99}` : '') +
    ` morphs ok ${m.morph_result.ok} off ${m.morph_result.off} missing ${m.morph_result.missing}` +
    (m.morph_result.off ? ` worst ${m.morph_result.worst.key} ${m.morph_result.worst.mm}/${m.morph_result.worst.largest_delta_mm} mm` : ''));
}
console.log(`  images same ${report.images.same}/${report.images.reference}` + (report.materials ? `; materials pbr ${report.materials.checked} checked, ${report.materials.differ} fields differ` : ''));
for (const f of report.failures.slice(0, 12)) console.log(`  x ${f}`);
process.exit(report.pass ? 0 : 1);
