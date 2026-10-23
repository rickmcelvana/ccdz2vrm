// Where do texture differences come from? Blender's image in its VRM against our resize of the
// same source, before and after our encoding:
//   node tools/port/texdiff.ts out/spike/g3 Cups normal     (material name, base|normal)
import { readFileSync } from 'node:fs';
import { readContract } from '../../app/src/convert/contract.ts';
import { resize, type Pixels } from '../../app/src/convert/images.ts';
import { nodeCodec } from './codec.ts';

const [stem, matName, which] = process.argv.slice(2);
if (!stem || !matName || !which) throw new Error('usage: node tools/port/texdiff.ts out/spike/<n> <material> base|normal');
const raw = readContract(readFileSync(`${stem}.ufbx.json`, 'utf8'), new Uint8Array(readFileSync(`${stem}.ufbx.bin`)));
const mat = raw.materials.find((m) => m.name === matName)!;
const props = which === 'normal' ? ['NormalMap', 'Bump'] : ['DiffuseColor'];
const fnv = mat.textures.find((t) => props.includes(t.prop))!.fnv;
const src = await nodeCodec.decode(raw.images.find((i) => i.fnv === fnv)!.data!);

const b = new Uint8Array(readFileSync(`${stem}.blender.vrm`));
const dv = new DataView(b.buffer);
const jl = dv.getUint32(12, true);
const j = JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + jl)));
const bin = b.subarray(28 + jl);
const gm = j.materials.find((m: { name: string }) => m.name === matName);
const ti = which === 'normal' ? gm.normalTexture.index : gm.pbrMetallicRoughness.baseColorTexture.index;
const img = j.images[j.textures[ti].source];
const v = j.bufferViews[img.bufferView];
const blender = await nodeCodec.decode(bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength));

const diff = (a: Pixels, c: Pixels) => {
  let s = 0;
  for (let i = 0; i < a.width * a.height; i++) for (let k = 0; k < 3; k++) s += Math.abs(a.data[i * 4 + k]! - c.data[i * 4 + k]!);
  return (s / (a.width * a.height * 3)).toFixed(2);
};
const ours = resize(src, blender.width, blender.height);
const nearest = (() => {
  const out = new Uint8Array(blender.width * blender.height * 4);
  for (let y = 0; y < blender.height; y++)
    for (let x = 0; x < blender.width; x++) {
      const sx = Math.floor(((x + 0.5) * src.width) / blender.width), sy = Math.floor(((y + 0.5) * src.height) / blender.height);
      out.set(src.data.subarray((sy * src.width + sx) * 4, (sy * src.width + sx) * 4 + 4), (y * blender.width + x) * 4);
    }
  return { width: blender.width, height: blender.height, data: out };
})();
const jpeg = await nodeCodec.decode(await nodeCodec.encode(ours, 'jpeg', 0.9));
console.log(JSON.stringify({
  source: `${src.width}x${src.height}`, blender: `${blender.width}x${blender.height} ${img.mimeType}`,
  box_vs_blender: diff(ours, blender), nearest_vs_blender: diff(nearest, blender), box_jpeg90_vs_blender: diff(jpeg, blender), jpeg90_vs_box: diff(jpeg, ours),
}));
