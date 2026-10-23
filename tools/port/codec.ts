// Image coding for the Node harness: the converter's own PNG code (app/src/convert/png.ts) with
// node:zlib, jpeg-js for JPEG decoding (the browser uses createImageBitmap), and mozjpeg (WASM)
// for JPEG encoding, as the browser build -- jpeg-js encodes 4:4:4 without optimised tables,
// ~1.8x the bytes of Blender's libjpeg (ENVIRONMENT s35).
import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import encodeJpeg, { init as initJpeg } from '@jsquash/jpeg/encode.js';
import jpeg from 'jpeg-js';
import { JPEG_OPTIONS, makeCodec } from '../../app/src/convert/codecs.ts';

initJpeg(await WebAssembly.compile(readFileSync(new URL('../../node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm', import.meta.url))));

const buf = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength);

export const nodeCodec = makeCodec(
  {
    inflate: async (b) => new Uint8Array(inflateSync(buf(b))),
    // zlib's defaults, as the browser's CompressionStream: the same bytes on both
    deflate: async (b) => new Uint8Array(deflateSync(buf(b))),
  },
  {
    async decode(bytes) {
      const img = jpeg.decode(buf(bytes), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });
      return { width: img.width, height: img.height, data: img.data };
    },
    async encode(px, quality) {
      const data = new Uint8ClampedArray(px.data.buffer, px.data.byteOffset, px.data.byteLength);
      return new Uint8Array(await encodeJpeg({ width: px.width, height: px.height, data, colorSpace: 'srgb' } as ImageData, { quality: Math.round(quality * 100), ...JPEG_OPTIONS }));
    },
  },
);
