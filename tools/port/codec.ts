// Image coding for the Node harness: pure-JS decoding (the browser uses createImageBitmap);
// JPEG encoding by mozjpeg compiled to WASM, the encoder the browser build uses too -- jpeg-js
// encodes 4:4:4 without optimised tables, ~1.8x the bytes of Blender's libjpeg. Quantisation
// tables are JPEG's standard ones (libjpeg's, as Blender writes): mozjpeg's default set lost
// more on noisy bump-made normal maps (G3's Cups 6.0/255 off the lossless image vs Blender's
// 4.1; standard 4.6) for ~20 % fewer bytes (ENVIRONMENT s35).
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import encodeJpeg, { init as initJpeg } from '@jsquash/jpeg/encode.js';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import type { ImageCodec } from '../../app/src/convert/images.ts';

initJpeg(await WebAssembly.compile(readFileSync(new URL('../../node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm', import.meta.url))));

export const nodeCodec: ImageCodec = {
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
  async encode(px, format, quality = 0.9) {
    const data = Buffer.from(px.data.buffer, px.data.byteOffset, px.data.byteLength);
    if (format === 'jpeg') {
      const rgba = new Uint8ClampedArray(px.data.buffer, px.data.byteOffset, px.data.byteLength);
      return new Uint8Array(await encodeJpeg({ width: px.width, height: px.height, data: rgba, colorSpace: 'srgb' } as ImageData, { quality: Math.round(quality * 100), quant_table: 0 }));
    }
    const png = new PNG({ width: px.width, height: px.height });
    data.copy(png.data);
    return new Uint8Array(PNG.sync.write(png));
  },
  async deflate(bytes) {
    return new Uint8Array(deflateSync(bytes, { level: 9 }));
  },
};
