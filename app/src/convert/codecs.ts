// The image codec the converter is given, put together from parts: PNG is our own (png.ts) on
// every platform; zlib and JPEG decoding are the platform's (browser: CompressionStream and
// createImageBitmap; Node: node:zlib and jpeg-js); JPEG encoding is mozjpeg (WASM) everywhere.

import { mimeOf, type ImageCodec, type Pixels } from './images.ts';
import { decodePng, encodePng, type Deflate, type Inflate } from './png.ts';

export type JpegCodec = {
  decode(bytes: Uint8Array): Promise<Pixels>;
  /** quality 0..1 */
  encode(px: Pixels, quality: number): Promise<Uint8Array>;
};

/**
 * mozjpeg with JPEG's standard quantisation tables (libjpeg's, as Blender writes): its own
 * default set lost more on noisy bump-made normal maps (ENVIRONMENT s35).
 */
export const JPEG_OPTIONS = { quant_table: 0 } as const;

export function makeCodec(zlib: { inflate: Inflate; deflate: Deflate }, jpeg: JpegCodec): ImageCodec {
  return {
    decode(bytes) {
      const mime = mimeOf(bytes);
      if (mime === 'image/png') return decodePng(bytes, zlib.inflate);
      if (mime === 'image/jpeg') return jpeg.decode(bytes);
      return Promise.reject(new Error('unsupported image format (PNG and JPEG only)'));
    },
    encode: (px, format, quality = 0.9) => (format === 'png' ? encodePng(px, zlib.deflate) : jpeg.encode(px, quality)),
    deflate: zlib.deflate,
  };
}
