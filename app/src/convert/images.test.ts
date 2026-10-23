import { describe, expect, it } from 'vitest';
import fixture from './fixtures/height_to_normal.json';
import { hasDepth32, heightToNormal, isGreyscale, type Pixels } from './images.ts';

function grey(w: number, h: number, values: number[]): Pixels {
  const data = new Uint8Array(w * h * 4);
  values.forEach((v, i) => data.set([v, v, v, 255], i * 4));
  return { width: w, height: h, data };
}

describe('heightToNormal', () => {
  it("matches Blender's common.height_to_normal (fixture written by Blender itself)", () => {
    const { width: w, height: h } = fixture;
    const out = heightToNormal(grey(w, h, fixture.height_top_down));
    let worst = 0;
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++)
        for (let ch = 0; ch < 3; ch++) {
          const blender = fixture.normal_bottom_up[(r * w + c) * 4 + ch]! * 255;
          const ours = out.data[((h - 1 - r) * w + c) * 4 + ch]!;
          worst = Math.max(worst, Math.abs(ours - blender));
        }
    expect(worst).toBeLessThanOrEqual(0.5); // 8-bit rounding of Blender's floats, nothing more
  });

  it('is flat (128, 128, 255) on a flat height map', () => {
    const out = heightToNormal(grey(4, 3, Array(12).fill(90)));
    expect(Array.from(out.data.subarray(0, 4))).toEqual([128, 128, 255, 255]);
  });
});

describe('isGreyscale', () => {
  it('accepts grey and refuses colour', () => {
    expect(isGreyscale(grey(200, 2, Array(400).fill(77)))).toBe(true);
    const colour = grey(200, 2, Array(400).fill(77));
    for (let i = 0; i < 400; i++) colour.data[i * 4] = 200;
    expect(isGreyscale(colour)).toBe(false);
  });
});

/** A PNG header with the given bit depth and colour type, then empty chunks. */
function png(bitDepth: number, colorType: number, chunks: string[] = []): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  b[24] = bitDepth;
  b[25] = colorType;
  let o = 33;
  for (const c of chunks) {
    b.set([0, 0, 0, 0, ...[...c].map((ch) => ch.charCodeAt(0))], o);
    o += 12;
  }
  return b;
}

describe('hasDepth32', () => {
  it("follows Blender's image.depth (measured, ENVIRONMENT.md s31)", () => {
    expect(hasDepth32(png(8, 6))).toBe(true); // RGBA
    expect(hasDepth32(png(8, 2))).toBe(false); // RGB
    expect(hasDepth32(png(8, 4))).toBe(false); // grey + alpha: depth 16
    expect(hasDepth32(png(16, 6))).toBe(false); // 16-bit: float buffer
    expect(hasDepth32(png(8, 3, ['tRNS']))).toBe(true); // palette with transparency
    expect(hasDepth32(png(8, 3, ['IDAT']))).toBe(false);
    expect(hasDepth32(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array(40).fill(0)]))).toBe(false); // JPEG
  });
});
