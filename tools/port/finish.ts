// Phase 3 harness: ufbx raw import -> cleanImport -> adaptCc -> finish -> a VRM to set beside
// Blender's (vrm_export.py on the adapter's .blend):
//   node tools/port/finish.ts out/spike/ira cc ira [--max-texture 1024]   (writes ira.ts.vrm)
import { readFileSync, writeFileSync } from 'node:fs';
import { readContract } from '../../app/src/convert/contract.ts';
import { cleanImport } from '../../app/src/convert/cleanup.ts';
import { adaptCc } from '../../app/src/convert/adaptCc.ts';
import { finish } from '../../app/src/convert/finish.ts';
import { nodeCodec } from './codec.ts';

const args = process.argv.slice(2);
const [stem, kind, name] = args;
const maxTexture = args.includes('--max-texture') ? Number(args[args.indexOf('--max-texture') + 1]) : null;
if (!stem || kind !== 'cc' || !name) throw new Error('usage: node tools/port/finish.ts out/spike/<file> cc <name> [--max-texture N]');
const t = [performance.now()];
const raw = readContract(readFileSync(`${stem}.ufbx.json`, 'utf8'), new Uint8Array(readFileSync(`${stem}.ufbx.bin`)));
const { contract: clean } = await cleanImport(raw, nodeCodec);
t.push(performance.now());
const { contract: adapted } = await adaptCc(clean, name, nodeCodec);
t.push(performance.now());
const { vrm, report } = await finish(adapted, nodeCodec, { name, maxTexture });
t.push(performance.now());
writeFileSync(`${stem}.ts.vrm`, vrm);
const ms = (a: number, b: number) => Math.round(t[b]! - t[a]!);
console.log(JSON.stringify({ clean_ms: ms(0, 1), adapt_ms: ms(1, 2), finish_ms: ms(2, 3), bytes: vrm.byteLength, ...report }));
