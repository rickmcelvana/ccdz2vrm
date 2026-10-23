// Image rules the import cleanup needs, written to match Blender's results exactly
// (common.py `_is_greyscale`, `height_to_normal`; the FBX importer's `image.depth == 32`).
// Decoding is injected: the browser uses createImageBitmap, the Node harness pure-JS codecs.

/** RGBA, 8 bits per channel, rows top-down (as browsers and decoders give them). */
export type Pixels = { width: number; height: number; data: Uint8Array | Uint8ClampedArray };

export type ImageCodec = {
  decode(bytes: Uint8Array): Promise<Pixels>;
};

const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

/**
 * Blender's `image.depth == 32` -- the FBX importer then drives Alpha from the diffuse
 * image's alpha. Measured on Blender 5.2 (ENVIRONMENT.md s31): RGBA PNG 32, palette PNG
 * with tRNS 32, grey+alpha PNG 16, RGB 24, grey 8, every JPEG 8 or 24. 16-bit PNGs load
 * as float (64/128). TGA: 32 when the header says 32 bits per pixel.
 */
export function hasDepth32(b: Uint8Array): boolean {
  if (b.length > 33 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const bitDepth = b[24], colorType = b[25];
    if (bitDepth !== 8) return false;
    if (colorType === 6) return true;
    if (colorType !== 3) return false;
    // palette: transparent when a tRNS chunk comes before IDAT
    for (let o = 8; o + 8 <= b.length; ) {
      const len = u32(b, o), type = String.fromCharCode(b[o + 4]!, b[o + 5]!, b[o + 6]!, b[o + 7]!);
      if (type === 'tRNS') return true;
      if (type === 'IDAT' || type === 'IEND') return false;
      o += 12 + len;
    }
    return false;
  }
  const isTga = b.length > 18 && (b[2] === 2 || b[2] === 10);
  return isTga && b[16] === 32;
}

/**
 * common.py `_is_greyscale`: every 97th pixel of Blender's buffer (rows bottom-up, 4
 * channels), max |r-g| + max |g-b| below 0.02. Blender reports 4 channels for every
 * image it loads (s31), so its `channels < 3` guard never fires.
 */
export function isGreyscale(px: Pixels): boolean {
  const { width: w, height: h, data } = px;
  if (!w) return false;
  let rg = 0, gb = 0;
  for (let k = 0; k < w * h; k += 97) {
    const row = Math.floor(k / w), col = k % w;
    const o = ((h - 1 - row) * w + col) * 4; // Blender's row `row` is the image's row h-1-row
    rg = Math.max(rg, Math.abs(data[o]! - data[o + 1]!));
    gb = Math.max(gb, Math.abs(data[o + 1]! - data[o + 2]!));
  }
  return (rg + gb) / 255 < 0.02;
}

/** numpy.gradient along one axis: central inside, one-sided at the two ends. */
function grad(n: number, i: number, f: (j: number) => number): number {
  if (n < 2) return 0;
  if (i === 0) return f(1) - f(0);
  if (i === n - 1) return f(n - 1) - f(n - 2);
  return (f(i + 1) - f(i - 1)) / 2;
}

export const BUMP_SLOPE = 0.01; // height 0..1 rising over 1 % of the texture width = 45 deg

/**
 * common.py `height_to_normal`: tangent-space (OpenGL, +Y up) normal map from a greyscale
 * height image. numpy.gradient on Blender's bottom-up rows: central differences inside,
 * one-sided at the edges. Returns RGBA top-down, alpha 255.
 */
export function heightToNormal(px: Pixels): Pixels {
  const { width: w, height: h, data } = px;
  // height in Blender's orientation: hb[r][c], r = 0 at the bottom
  const hb = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) hb[r * w + c] = data[((h - 1 - r) * w + c) * 4]! / 255;
  const at = (r: number, c: number) => hb[r * w + c]!;
  const k = w * BUMP_SLOPE;
  const out = new Uint8Array(w * h * 4);
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      const dv = grad(h, r, (j) => at(j, c));
      const du = grad(w, c, (j) => at(r, j));
      let x = -du * k, y = -dv * k, z = 1;
      const l = Math.hypot(x, y, z);
      x /= l; y /= l; z /= l;
      const o = ((h - 1 - r) * w + c) * 4;
      // Blender stores floats and writes them rounded to 8 bits when it saves the PNG
      out[o] = Math.round((x * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round((y * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round((z * 0.5 + 0.5) * 255);
      out[o + 3] = 255;
    }
  return { width: w, height: h, data: out };
}
