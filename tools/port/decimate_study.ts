// How far does the web tier's reduction move each heavy mesh's surface? For every mesh over the
// budget: source vertices before/after and the distance of each original vertex to the reduced
// surface (tools/compare/surface.ts), the measure tools/compare/vrm.ts --original judges by.
//   node tools/port/decimate_study.ts out/spike/g8 daz g8 [budget]
import { readFileSync } from 'node:fs';
import { readContract, type Mesh } from '../../app/src/convert/contract.ts';
import { cleanImport } from '../../app/src/convert/cleanup.ts';
import { adaptCc } from '../../app/src/convert/adaptCc.ts';
import { adaptDaz } from '../../app/src/convert/adaptDaz.ts';
import { decimateMesh, sourceCount } from '../../app/src/convert/decimate.ts';
import { surfaceDistances } from '../../app/src/convert/surface.ts';
import { nodeCodec } from './codec.ts';

const [stem, kind, name, budgetArg] = process.argv.slice(2);
if (!stem || !kind || !name) throw new Error('usage: node tools/port/decimate_study.ts out/spike/<file> cc|daz <name> [budget]');
const budget = Number(budgetArg ?? 50000);
const tols = (process.env.TOLS ?? '0.0025').split(',').map(Number);
const raw = readContract(readFileSync(`${stem}.ufbx.json`, 'utf8'), new Uint8Array(readFileSync(`${stem}.ufbx.bin`)));
const { contract: clean } = await cleanImport(raw, nodeCodec);
const { contract: adapted } = kind === 'cc' ? await adaptCc(clean, name, nodeCodec) : adaptDaz(clean, name);
const q = (d: Float64Array, f: number) => +(Float64Array.from(d).sort()[Math.floor(f * (d.length - 1))]! * 1000).toFixed(2);
for (const m of adapted.meshes) {
  if (sourceCount(m) <= budget) continue;
  for (const tol of tols) {
  const copy: Mesh = { ...m, morphs: m.morphs.map((k) => ({ ...k })) };
  const t = performance.now();
  const r = await decimateMesh(copy, budget, tol);
  const ms = Math.round(performance.now() - t);
  const d = surfaceDistances(m.position, m.vertex_count, copy.position, copy.indices);
  const far = d.filter((x) => x > 0.0025).length;
  console.log(JSON.stringify({ mesh: m.name, tol_mm: tol * 1000, ...r, triangles: [m.triangle_count, copy.triangle_count], ms, dev_mm: { p50: q(d, 0.5), p99: q(d, 0.99), max: q(d, 1) }, beyond_tol_pct: +((100 * far) / d.length).toFixed(2) }));
}
}
