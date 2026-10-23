import { describe, expect, it } from 'vitest';
import { surfaceDistances } from './surface.ts';

describe('surfaceDistances', () => {
  // one triangle in the z = 0 plane: (0,0,0) (0.01,0,0) (0,0.01,0)
  const Q = new Float32Array([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0]);
  const idx = new Uint32Array([0, 1, 2]);

  it('measures to the face, an edge and a corner', () => {
    const P = new Float32Array([0.002, 0.002, 0.003, 0.005, -0.004, 0, -0.003, -0.004, 0, 0.01, 0.01, 0]);
    const d = surfaceDistances(P, 4, Q, idx);
    expect(d[0]).toBeCloseTo(0.003, 6); // above the face
    expect(d[1]).toBeCloseTo(0.004, 6); // beside edge ab
    expect(d[2]).toBeCloseTo(0.005, 6); // off corner a
    expect(d[3]).toBeCloseTo(Math.SQRT2 * 0.005, 6); // beyond the hypotenuse
  });

  it('caps far points, skips points on the surface, and stops early within a limit', () => {
    const P = new Float32Array([0.5, 0, 0, 0.003, 0.003, 0.004]);
    expect(surfaceDistances(P, 2, Q, idx)[0]).toBeCloseTo(0.1, 6);
    expect(surfaceDistances(P, 2, Q, idx, { on: new Uint8Array([1, 0]) })[0]).toBe(0);
    expect(surfaceDistances(P, 2, Q, idx, { within: 0.005 })[1]).toBeLessThanOrEqual(0.005);
  });
});
