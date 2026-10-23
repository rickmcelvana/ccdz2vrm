// Image rules the import cleanup needs, written to match Blender's results exactly
// (common.py `_is_greyscale`, `height_to_normal`; the FBX importer's `image.depth == 32`).
// Decoding is injected: the browser uses createImageBitmap, the Node harness pure-JS codecs.

/** RGBA, 8 bits per channel, rows top-down (as browsers and decoders give them). */
export type Pixels = { width: number; height: number; data: Uint8Array | Uint8ClampedArray };

export type ImageCodec = {
  decode(bytes: Uint8Array): Promise<Pixels>;
  /** PNG keeps alpha; JPEG drops it. quality 0..1, JPEG only. */
  encode(px: Pixels, format: 'png' | 'jpeg', quality?: number): Promise<Uint8Array>;
  /** zlib-wrapped deflate (PNG IDAT); the browser's CompressionStream('deflate') is this. */
  deflate(bytes: Uint8Array): Promise<Uint8Array>;
};

/** A small deterministic PRNG (mulberry32): the same palette every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * glb_web.py `_quantize`: up to n palette entries, k-means on a 60k-pixel sample in
 * premultiplied colour (a strand texture's invisible pixels must not take palette entries),
 * then every pixel to its nearest entry; each entry is its pixels' mean straight RGBA.
 */
export function quantize(px: Pixels, n: number): { palette: Uint8Array; index: Uint8Array } {
  const N = px.width * px.height, d = px.data;
  const feat = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const a = d[i * 4 + 3]! / 255;
    feat.set([d[i * 4]! * a, d[i * 4 + 1]! * a, d[i * 4 + 2]! * a, d[i * 4 + 3]!], i * 4);
  }
  const nearest = (cen: Float32Array, k: number, i: number) => {
    let best = 0, bd = Infinity;
    for (let c = 0; c < k; c++) {
      let s = 0;
      for (let q = 0; q < 4; q++) {
        const x = feat[i * 4 + q]! - cen[c * 4 + q]!;
        s += x * x;
      }
      if (s < bd) {
        bd = s;
        best = c;
      }
    }
    return best;
  };
  const r = rng(0);
  const sample = Array.from({ length: Math.min(N, 60000) }, () => Math.floor(r() * N));
  const k = Math.min(n, sample.length);
  const cen = new Float32Array(k * 4);
  for (let c = 0; c < k; c++) cen.set(feat.subarray(sample[c]! * 4, sample[c]! * 4 + 4), c * 4);
  for (let iter = 0; iter < 10; iter++) {
    const sums = new Float64Array(k * 4), cnt = new Uint32Array(k);
    for (const i of sample) {
      const c = nearest(cen, k, i);
      cnt[c]!++;
      for (let q = 0; q < 4; q++) sums[c * 4 + q]! += feat[i * 4 + q]!;
    }
    for (let c = 0; c < k; c++) if (cnt[c]) for (let q = 0; q < 4; q++) cen[c * 4 + q] = sums[c * 4 + q]! / cnt[c]!;
  }
  const index = new Uint8Array(N);
  const sums = new Float64Array(k * 4), cnt = new Uint32Array(k);
  for (let i = 0; i < N; i++) {
    const c = nearest(cen, k, i);
    index[i] = c;
    cnt[c]!++;
    for (let q = 0; q < 4; q++) sums[c * 4 + q]! += d[i * 4 + q]!;
  }
  const palette = new Uint8Array(k * 4);
  for (let c = 0; c < k; c++) for (let q = 0; q < 4; q++) palette[c * 4 + q] = cnt[c] ? Math.round(sums[c * 4 + q]! / cnt[c]!) : 0;
  return { palette, index };
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  out.set([...type].map((c) => c.charCodeAt(0)), 4);
  out.set(body, 8);
  dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** A palette PNG with transparency (glb_web.py `_png`): filter 0 on every row. */
export async function palettePng(px: Pixels, n: number, codec: ImageCodec): Promise<Uint8Array> {
  const { palette, index } = quantize(px, n);
  const w = px.width, h = px.height, k = palette.length / 4;
  const rows = new Uint8Array(h * (w + 1));
  for (let y = 0; y < h; y++) rows.set(index.subarray(y * w, y * w + w), y * (w + 1) + 1);
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr.set([8, 3, 0, 0, 0], 8);
  const plte = new Uint8Array(k * 3), trns = new Uint8Array(k);
  for (let c = 0; c < k; c++) {
    plte.set(palette.subarray(c * 4, c * 4 + 3), c * 3);
    trns[c] = palette[c * 4 + 3]!;
  }
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('PLTE', plte), pngChunk('tRNS', trns),
    pngChunk('IDAT', await codec.deflate(rows)), pngChunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * A PNG with only the chunks that draw it (IHDR, PLTE, tRNS, IDAT, IEND). glTF images are
 * sRGB and colour-space chunks (iCCP, gAMA, cHRM, sRGB) are to be ignored; the Khronos
 * validator flags them (IMAGE_FEATURES_UNSUPPORTED) on CC's source maps. No re-encode.
 */
export function stripPng(b: Uint8Array): Uint8Array {
  if (mimeOf(b) !== 'image/png') return b;
  const keep = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  for (let o = 8; o + 12 <= b.length; ) {
    const len = u32(b, o), type = String.fromCharCode(b[o + 4]!, b[o + 5]!, b[o + 6]!, b[o + 7]!);
    if (keep.has(type)) parts.push(b.subarray(o, o + 12 + len));
    o += 12 + len;
    if (type === 'IEND') break;
  }
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** What an image is, read from its first bytes. */
export function mimeOf(b: Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  return null;
}

/**
 * Downscale to w x h by averaging each target pixel's source footprint (a box filter, exact
 * for the integer factors Daz/CC maps hit, 4096 -> 1024). Blender's `Image.scale` filters
 * too; the two agree to a few levels per channel (ENVIRONMENT.md s33).
 */
export function resize(px: Pixels, w: number, h: number): Pixels {
  const { width: sw, height: sh, data } = px;
  if (sw === w && sh === h) return px;
  const out = new Uint8Array(w * h * 4);
  const fx = sw / w, fy = sh / h;
  const acc = new Float64Array(4);
  for (let y = 0; y < h; y++) {
    const y0 = y * fy, y1 = y0 + fy;
    for (let x = 0; x < w; x++) {
      const x0 = x * fx, x1 = x0 + fx;
      acc.fill(0);
      let area = 0;
      for (let sy = Math.floor(y0); sy < Math.min(sh, Math.ceil(y1)); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.floor(x0); sx < Math.min(sw, Math.ceil(x1)); sx++) {
          const wgt = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx));
          const o = (sy * sw + sx) * 4;
          for (let c = 0; c < 4; c++) acc[c] = acc[c]! + wgt * data[o + c]!;
          area += wgt;
        }
      }
      for (let c = 0; c < 4; c++) out[(y * w + x) * 4 + c] = Math.round(acc[c]! / area);
    }
  }
  return { width: w, height: h, data: out };
}

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
