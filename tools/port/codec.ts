// Pure-JS image decoding for the Node harness (the browser uses createImageBitmap).
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import type { ImageCodec } from '../../app/src/convert/images.ts';

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
};
