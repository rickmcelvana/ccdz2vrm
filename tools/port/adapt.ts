// Phase 2+ harness: ufbx raw import -> cleanImport -> an adapter -> a contract to set beside
// Blender's adapter output (dump_contract.py on its .blend):
//   node tools/port/adapt.ts out/spike/ira cc ira   (reads ira.ufbx.*, writes ira.ts-adapted.*)
import { readFileSync, writeFileSync } from 'node:fs';
import { readContract, writeContract } from '../../app/src/convert/contract.ts';
import { cleanImport } from '../../app/src/convert/cleanup.ts';
import { adaptCc } from '../../app/src/convert/adaptCc.ts';
import { adaptDaz } from '../../app/src/convert/adaptDaz.ts';
import { nodeCodec } from './codec.ts';

const [stem, kind, name] = process.argv.slice(2);
if (!stem || (kind !== 'cc' && kind !== 'daz') || !name) throw new Error('usage: node tools/port/adapt.ts out/spike/<file> cc|daz <name>');
const t0 = performance.now();
const raw = readContract(readFileSync(`${stem}.ufbx.json`, 'utf8'), new Uint8Array(readFileSync(`${stem}.ufbx.bin`)));
const { contract: clean } = await cleanImport(raw, nodeCodec);
const t1 = performance.now();
const { contract, report } = kind === 'cc' ? await adaptCc(clean, name, nodeCodec) : adaptDaz(clean, name);
const { json, bin } = writeContract(contract);
writeFileSync(`${stem}.ts-adapted.json`, json);
writeFileSync(`${stem}.ts-adapted.bin`, bin);
console.log(JSON.stringify({ clean_ms: Math.round(t1 - t0), adapt_ms: Math.round(performance.now() - t1), ...report }));
