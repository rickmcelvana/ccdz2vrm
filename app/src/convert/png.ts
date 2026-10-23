// PNG in and out, the same code in the browser and in the Node harness: only zlib differs
// (CompressionStream there, node:zlib here). Decoding covers what Daz and CC ship: every colour
// type and bit depth, palettes and tRNS, Adam7 interlacing; 16-bit samples are scaled to 8 as
// pngjs does. Encoding writes 8-bit RGBA with libpng's adaptive row filter.

import { pngChunk, type Pixels } from './images.ts';

export type Inflate = (b: Uint8Array) => Promise<Uint8Array>;
export type Deflate = (b: Uint8Array) => Promise<Uint8Array>;

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
// Adam7: x0, y0, dx, dy per pass
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;

export async function decodePng(b: Uint8Array, inflate: Inflate): Promise<Pixels> {
  if (!SIG.every((x, i) => b[i] === x)) throw new Error('not a PNG');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let width = 0, height = 0, depth = 8, type = 6, interlace = 0;
  let palette: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (let o = 8; o + 8 <= b.length; ) {
    const len = dv.getUint32(o), tag = String.fromCharCode(b[o + 4]!, b[o + 5]!, b[o + 6]!, b[o + 7]!);
    const body = b.subarray(o + 8, o + 8 + len);
    if (tag === 'IHDR') {
      width = dv.getUint32(o + 8);
      height = dv.getUint32(o + 12);
      [depth, type, interlace] = [body[8]!, body[9]!, body[12]!];
    } else if (tag === 'PLTE') palette = body;
    else if (tag === 'tRNS') trns = body;
    else if (tag === 'IDAT') idat.push(body);
    else if (tag === 'IEND') break;
    o += 12 + len;
  }
  const ch = CHANNELS[type];
  if (!ch || !width || !height) throw new Error(`unsupported PNG (colour type ${type})`);
  const raw = await inflate(concat(idat));
  const bits = ch * depth;
  const bpp = Math.max(1, bits >> 3); // filter distance in bytes
  const out = new Uint8Array(width * height * 4);
  const max = (1 << depth) - 1;
  const trnsKey = trns && (type === 0 || type === 2) ? [0, 1, 2].map((c) => (trns![c * 2]! << 8) | trns![c * 2 + 1]!) : null;
  let off = 0;
  // one pass (or one Adam7 sub-image): unfilter its rows in place, then write RGBA through `at`
  const pass = (pw: number, ph: number, at: (x: number, y: number) => number) => {
    const stride = Math.ceil((pw * bits) / 8);
    for (let y = 0; y < ph; y++) {
      const r = off + 1;
      unfilter(raw[off]!, raw, r, y ? r - stride - 1 : -1, stride, bpp);
      off += 1 + stride;
      for (let x = 0; x < pw; x++) toRgba(raw, r, x, out, at(x, y));
    }
  };
  const sample = (buf: Uint8Array, r: number, x: number, c: number) => {
    if (depth === 8) return buf[r + x * ch + c]!;
    if (depth === 16) return (buf[r + (x * ch + c) * 2]! << 8) | buf[r + (x * ch + c) * 2 + 1]!;
    const bit = (x * ch + c) * depth;
    return (buf[r + (bit >> 3)]! >> (8 - depth - (bit & 7))) & max;
  };
  const to8 = depth === 8 ? (v: number) => v : depth === 16 ? (v: number) => Math.round(v / 257) : (v: number) => Math.round((v * 255) / max);
  const toRgba = (buf: Uint8Array, r: number, x: number, o: Uint8Array, p: number) => {
    if (depth === 8 && type === 6 && !trnsKey) {
      const i = r + x * 4;
      o[p] = buf[i]!; o[p + 1] = buf[i + 1]!; o[p + 2] = buf[i + 2]!; o[p + 3] = buf[i + 3]!;
      return;
    }
    if (type === 3) {
      const i = sample(buf, r, x, 0);
      o[p] = palette![i * 3]!; o[p + 1] = palette![i * 3 + 1]!; o[p + 2] = palette![i * 3 + 2]!;
      o[p + 3] = trns && i < trns.length ? trns[i]! : 255;
      return;
    }
    const s0 = sample(buf, r, x, 0);
    if (type === 0 || type === 4) {
      const g = to8(s0);
      o[p] = g; o[p + 1] = g; o[p + 2] = g;
      o[p + 3] = type === 4 ? to8(sample(buf, r, x, 1)) : trnsKey && s0 === trnsKey[0] ? 0 : 255;
      return;
    }
    const s1 = sample(buf, r, x, 1), s2 = sample(buf, r, x, 2);
    o[p] = to8(s0); o[p + 1] = to8(s1); o[p + 2] = to8(s2);
    o[p + 3] = type === 6 ? to8(sample(buf, r, x, 3)) : trnsKey && s0 === trnsKey[0] && s1 === trnsKey[1] && s2 === trnsKey[2] ? 0 : 255;
  };
  if (interlace) {
    for (const [x0, y0, dx, dy] of ADAM7) {
      const pw = Math.ceil((width - x0) / dx), ph = Math.ceil((height - y0) / dy);
      if (pw > 0 && ph > 0) pass(pw, ph, (x, y) => ((y0 + y * dy) * width + x0 + x * dx) * 4);
    }
  } else pass(width, height, (x, y) => (y * width + x) * 4);
  return { width, height, data: out };
}

/** Undo one row's filter in place: the row at `r` in `b`, the previous row at `p` (-1: none). */
function unfilter(f: number, b: Uint8Array, r: number, p: number, stride: number, bpp: number): void {
  if (f === 0) return;
  for (let i = 0; i < stride; i++) {
    const a = i >= bpp ? b[r + i - bpp]! : 0, up = p >= 0 ? b[p + i]! : 0, c = i >= bpp && p >= 0 ? b[p + i - bpp]! : 0;
    const pr = f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : paeth(a, up, c);
    b[r + i] = (b[r + i]! + pr) & 255;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** 8-bit RGBA PNG; per row the filter with the smallest sum of |signed bytes| (libpng's heuristic). */
export async function encodePng(px: Pixels, deflate: Deflate): Promise<Uint8Array> {
  const stride = px.width * 4;
  const rows = new Uint8Array((stride + 1) * px.height);
  const cand = Array.from({ length: 5 }, () => new Uint8Array(stride));
  let prev: Uint8Array | Uint8ClampedArray = new Uint8Array(stride);
  for (let y = 0; y < px.height; y++) {
    const row = px.data.subarray(y * stride, y * stride + stride);
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const o = cand[f]!;
      if (f === 0) o.set(row);
      else if (f === 1) for (let i = 0; i < stride; i++) o[i] = row[i]! - (i >= 4 ? row[i - 4]! : 0);
      else if (f === 2) for (let i = 0; i < stride; i++) o[i] = row[i]! - prev[i]!;
      else if (f === 3) for (let i = 0; i < stride; i++) o[i] = row[i]! - (((i >= 4 ? row[i - 4]! : 0) + prev[i]!) >> 1);
      else for (let i = 0; i < stride; i++) o[i] = row[i]! - (i >= 4 ? paeth(row[i - 4]!, prev[i]!, prev[i - 4]!) : prev[i]!);
      let sum = 0;
      for (let i = 0; i < stride && sum < bestSum; i++) {
        const v = o[i]!;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) [best, bestSum] = [f, sum];
    }
    rows[y * (stride + 1)] = best;
    rows.set(cand[best]!, y * (stride + 1) + 1);
    prev = row;
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, px.width);
  dv.setUint32(4, px.height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return concat([Uint8Array.from(SIG), pngChunk('IHDR', ihdr), pngChunk('IDAT', await deflate(rows)), pngChunk('IEND', new Uint8Array())]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
