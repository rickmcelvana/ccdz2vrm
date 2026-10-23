import { describe, expect, it } from 'vitest';
import type { Bone } from './contract.ts';
import { fromTo, qrot, restructureTwist, twistConstraints, twistFrames } from './twistSplit.ts';

const at = (name: string, parent: string | null, x: number, y = 1.4): Bone => ({ name, parent, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1] });

/** A Daz-style arm pair: collar -> shoulder bend/twist -> forearm bend/twist -> hand, along +-x. */
function arms(): Bone[] {
  return (['l', 'r'] as const).flatMap((s) => {
    const x = s === 'l' ? 1 : -1;
    return [
      at(`${s}Collar`, null, 0.05 * x), at(`${s}ShldrBend`, `${s}Collar`, 0.15 * x), at(`${s}ShldrTwist`, `${s}ShldrBend`, 0.25 * x),
      at(`${s}ForearmBend`, `${s}ShldrTwist`, 0.42 * x), at(`${s}ForearmTwist`, `${s}ForearmBend`, 0.52 * x), at(`${s}Hand`, `${s}ForearmTwist`, 0.68 * x),
    ];
  });
}

describe('restructureTwist', () => {
  it('hangs the bend bone under _swing and the twist bone under _drv, the humanoid bone', () => {
    const bones = arms();
    const r = restructureTwist(bones, 'daz_genesis3_8')!;
    expect(r.remap).toEqual({ leftUpperArm: 'lShldrBend_drv', leftLowerArm: 'lForearmBend_drv', rightUpperArm: 'rShldrBend_drv', rightLowerArm: 'rForearmBend_drv' });
    const by = new Map(bones.map((b) => [b.name, b]));
    expect(by.get('lShldrBend_pre')!.parent).toBe('lCollar');
    expect(by.get('lShldrBend')!.parent).toBe('lShldrBend_swing');
    expect(by.get('lShldrTwist')!.parent).toBe('lShldrBend_drv');
    expect(by.get('lForearmBend_pre')!.parent).toBe('lShldrTwist');
    // the new bones sit at the bend bone's head: the skin is unchanged at rest
    expect(by.get('rForearmBend_drv')!.matrix.slice(12, 15)).toEqual(by.get('rForearmBend')!.matrix.slice(12, 15));
  });

  it('refuses a family without chains', () => {
    expect(restructureTwist(arms(), 'cc3')).toBeNull();
    expect(restructureTwist(arms(), null)).toBeNull();
  });

  it('frames the limb bones +Y along the limb and constrains on that axis', () => {
    const bones = arms();
    const { chains } = restructureTwist(bones, 'daz_genesis3_8')!;
    const head = (n: string) => bones.find((b) => b.name === n)!.matrix.slice(12, 15) as [number, number, number];
    const frames = twistFrames(chains, head);
    for (const n of ['rShldrBend_pre', 'rShldrBend_swing', 'rShldrBend']) {
      const y = qrot(frames.get(n)!, [0, 1, 0]);
      expect(y[0]).toBeCloseTo(-1, 9); // the right arm runs along -x
    }
    const idx = new Map(bones.map((b, i) => [b.name, i]));
    const c = twistConstraints(chains, (n) => idx.get(n)!);
    expect(c.get(idx.get('lForearmBend_swing')!)).toMatchObject({ constraint: { aim: { source: idx.get('lHand'), aimAxis: 'PositiveY', weight: 1 } } });
    expect(c.get(idx.get('lForearmBend')!)).toMatchObject({ constraint: { roll: { source: idx.get('lForearmBend_drv'), rollAxis: 'Y', weight: 0.5 } } });
  });

  it('fromTo is the shortest rotation, unit length', () => {
    const q = fromTo([0, 1, 0], [0, 0, 2]);
    expect(Math.hypot(...q)).toBeCloseTo(1, 12);
    const v = qrot(q, [0, 1, 0]);
    expect(v[2]).toBeCloseTo(1, 12);
    expect(qrot(q, [1, 0, 0])[0]).toBeCloseTo(1, 12); // the perpendicular axis stays put
  });
});
