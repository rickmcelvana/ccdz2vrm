// Phase 1 harness: ufbx's raw import (tools/fbx-spike) -> cleanImport -> a contract to set
// beside Blender's `dump_contract.py --clean`:
//   node tools/port/clean.ts out/spike/alice      (reads alice.ufbx.*, writes alice.ts-clean.*)
// Images decode with pure-JS codecs here; the browser build uses createImageBitmap.
import { readFileSync, writeFileSync } from 'node:fs';
import { readContract, writeContract } from '../../app/src/convert/contract.ts';
import { cleanImport } from '../../app/src/convert/cleanup.ts';
import { nodeCodec as codec } from './codec.ts';

const stem = process.argv[2];
if (!stem) throw new Error('usage: node tools/port/clean.ts out/spike/<name>');
const t0 = performance.now();
const raw = readContract(readFileSync(`${stem}.ufbx.json`, 'utf8'), new Uint8Array(readFileSync(`${stem}.ufbx.bin`)));
const { contract, report } = await cleanImport(raw, codec);
const { json, bin } = writeContract(contract);
writeFileSync(`${stem}.ts-clean.json`, json);
writeFileSync(`${stem}.ts-clean.bin`, bin);
console.log(JSON.stringify({ ms: Math.round(performance.now() - t0), ...report }));
