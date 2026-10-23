import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { palettePng, type ImageCodec } from './images.ts';
import { decodePng, encodePng } from './png.ts';

const inflate = async (b: Uint8Array) => new Uint8Array(inflateSync(b));
const deflate = async (b: Uint8Array) => new Uint8Array(deflateSync(b));

/** A 7 x 5 RGBA test card: gradients, a transparent corner, every filter worth choosing. */
function card() {
  const w = 7, h = 5, data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) data.set([x * 36, y * 60, (x * y * 13) & 255, x + y < 2 ? 0 : 255], (y * w + x) * 4);
  return { width: w, height: h, data };
}

describe('png', () => {
  it('round-trips RGBA exactly', async () => {
    const px = card();
    const back = await decodePng(await encodePng(px, deflate), inflate);
    expect([back.width, back.height]).toEqual([7, 5]);
    expect(Array.from(back.data)).toEqual(Array.from(px.data));
  });

  it('decodes a palette PNG with transparency (the web tier writes those)', async () => {
    // four colours, one of them clear: a 32-colour palette holds them exactly (where visible: the
    // palette is premultiplied, so a clear texel's colour is not kept)
    const colours = [[200, 30, 30, 255], [20, 180, 60, 255], [10, 10, 220, 128], [99, 99, 99, 0]];
    const px = { width: 8, height: 8, data: new Uint8Array(256) };
    for (let i = 0; i < 64; i++) px.data.set(colours[(i * 7) % 4]!, i * 4);
    const back = await decodePng(await palettePng(px, 32, { deflate } as unknown as ImageCodec), inflate);
    let err = 0;
    for (let i = 0; i < 256; i++) if (px.data[(i & ~3) + 3]) err = Math.max(err, Math.abs(back.data[i]! - px.data[i]!));
    expect(err).toBeLessThanOrEqual(1);
    for (let i = 0; i < 64; i++) if (!px.data[i * 4 + 3]) expect(back.data[i * 4 + 3]).toBe(0);
  });

  it('refuses what is not a PNG', async () => {
    await expect(decodePng(new Uint8Array([0xff, 0xd8, 0xff]), inflate)).rejects.toThrow('not a PNG');
  });
});
