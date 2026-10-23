// The image codec in a browser (or a worker): zlib from CompressionStream, JPEG decoding by the
// browser's own decoder, JPEG encoding by mozjpeg (WASM), PNG by png.ts (codecs.ts).

import encodeJpeg from '@jsquash/jpeg/encode.js';
import { JPEG_OPTIONS, makeCodec } from './codecs.ts';

const through = async (b: Uint8Array, stream: CompressionStream | DecompressionStream) =>
  new Uint8Array(await new Response(new Blob([b as BlobPart]).stream().pipeThrough(stream)).arrayBuffer());

export const browserCodec = makeCodec(
  {
    inflate: (b) => through(b, new DecompressionStream('deflate')),
    deflate: (b) => through(b, new CompressionStream('deflate')),
  },
  {
    async decode(bytes) {
      // no colour management: texels as stored, as Blender reads them
      const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/jpeg' }), { colorSpaceConversion: 'none' });
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const g = canvas.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(bmp, 0, 0);
      bmp.close();
      return { width: canvas.width, height: canvas.height, data: g.getImageData(0, 0, canvas.width, canvas.height).data };
    },
    async encode(px, quality) {
      const data = new Uint8ClampedArray(px.data.buffer, px.data.byteOffset, px.data.byteLength);
      return new Uint8Array(await encodeJpeg({ width: px.width, height: px.height, data, colorSpace: 'srgb' } as ImageData, { quality: Math.round(quality * 100), ...JPEG_OPTIONS }));
    },
  },
);
