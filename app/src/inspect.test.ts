import { describe, expect, it } from 'vitest';
import { classify, scan, suggestName } from './inspect';

const look = async (s: string) => {
  const b = new TextEncoder().encode(s);
  const { has, oldShoulder } = await scan(async (a, e) => b.subarray(a, e), b.length);
  return classify(has, oldShoulder);
};

// the same cases as src-tauri/src/fbx.rs
describe('inspect', () => {
  it('tells the families apart', async () => {
    let r = await look('..CC_Base_Hip..A01_Brow_Inner_Up..Eye_Blink_L..');
    expect([r.kind, r.family, r.supported, r.notes.length]).toEqual(['cc', 'Character Creator', true, 0]);
    expect(r.face.startsWith('ARKit')).toBe(true);
    r = await look('CC_Base_Hip Eye_Blink_L');
    expect([r.face.startsWith('Traditional'), r.notes.length]).toEqual([true, 1]);
    r = await look('Genesis8_1Female lShldrBend lEyelidUpper facs_bs_EyeBlinkL');
    expect([r.kind, r.family, r.supported, r.notes.length, r.face.startsWith('FACS')]).toEqual(['daz', 'Genesis 8.1', true, 0, true]);
    r = await look('Genesis8_1Female lShldrBend lEyelidUpper');
    expect([r.face.startsWith('posed'), r.notes.length]).toEqual([true, 1]);
    expect((await look('Genesis3Female lShldrBend lEyelidUpper')).family).toBe('Genesis 3');
    r = await look('Genesis2 lShldr\u0000 lForeArm');
    expect([r.kind, r.supported]).toEqual(['daz', false]);
    r = await look('Mixamo:Hips');
    expect([r.kind, r.supported]).toEqual(['unknown', false]);
  });

  it('names are file safe', () => {
    expect(suggestName('genesis8.1AliceTest_01')).toBe('genesis8_1AliceTest_01');
    expect(suggestName('My Character (v2)')).toBe('My_Character__v2');
    expect(suggestName('***')).toBe('avatar');
  });
});
