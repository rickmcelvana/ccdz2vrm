// The converter's PNG decoder (app/src/convert/png.ts) against pngjs on every PNG in the test
// exports' contracts, and an encode -> decode round trip:  node tools/port/pngcheck.ts out/spike/ira ...
import { readFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { readContract } from '../../app/src/convert/contract.ts';
import { mimeOf } from '../../app/src/convert/images.ts';
import { decodePng, encodePng } from '../../app/src/convert/png.ts';

const inflate = async (b: Uint8Array) => new Uint8Array(inflateSync(b));
const deflate = async (b: Uint8Array) => new Uint8Array(deflateSync(b, { level: 9 }));
let n = 0, bad = 0;
for (const stem of process.argv.slice(2)) {
  const c = readContract(readFileSync(`${stem}.ufbx.json`, 'utf8'), new Uint8Array(readFileSync(`${stem}.ufbx.bin`)));
  for (const img of c.images) {
    if (!img.data || mimeOf(img.data) !== 'image/png') continue;
    n++;
    const ours = await decodePng(img.data, inflate);
    const ref = PNG.sync.read(Buffer.from(img.data));
    let diff = 0;
    for (let i = 0; i < ref.data.length; i++) diff = Math.max(diff, Math.abs(ref.data[i]! - ours.data[i]!));
    const back = await decodePng(await encodePng(ours, deflate), inflate);
    const trip = back.data.every((x, i) => x === ours.data[i]);
    if (diff || !trip || ours.width !== ref.width) {
      bad++;
      console.log(`x ${stem} ${img.name} ${ref.width}x${ref.height} max diff ${diff} round trip ${trip}`);
    }
  }
}
console.log(`${n} PNGs, ${bad} differ`);
