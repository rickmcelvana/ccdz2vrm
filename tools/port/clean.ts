// Phase 1 harness: ufbx's raw import (tools/fbx-spike) -> cleanImport -> a contract to set
// beside Blender's `dump_contract.py --clean`:
//   node tools/port/clean.ts out/spike/alice      (reads alice.ufbx.*, writes alice.ts-clean.*)
// Images decode with pure-JS codecs here; the browser build uses createImageBitmap.
import { readFileSync, writeFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { readContract, writeContract } from '../../app/src/convert/contract.ts';
import { cleanImport } from '../../app/src/convert/cleanup.ts';
import type { ImageCodec } from '../../app/src/convert/images.ts';

const codec: ImageCodec = {
  async decode(bytes) {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      const png = PNG.sync.read(buf);
      return { width: png.width, height: png.height, data: png.data };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });
      return { width: img.width, height: img.height, data: img.data };
    }
    throw new Error('unsupported image format');
  },
};

const stem = process.argv[2];
if (!stem) throw new Error('usage: node tools/port/clean.ts out/spike/<name>');
const t0 = performance.now();
const raw = readContract(readFileSync(`${stem}.ufbx.json`, 'utf8'), new Uint8Array(readFileSync(`${stem}.ufbx.bin`)));
const { contract, report } = await cleanImport(raw, codec);
const { json, bin } = writeContract(contract);
writeFileSync(`${stem}.ts-clean.json`, json);
writeFileSync(`${stem}.ts-clean.bin`, bin);
console.log(JSON.stringify({ ms: Math.round(performance.now() - t0), ...report }));
