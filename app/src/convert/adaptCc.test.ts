// The CC adapter is judged against Blender on real exports (tools/port/run_adapt.sh). The two
// test exports both use the ARKit profile, so the Traditional mapping is pinned here.
import { describe, expect, it } from 'vitest';
import { arkitName, LEGACY_ARKIT, VISEMES } from './adaptCc.ts';

describe('CC names', () => {
  it('renames A-numbered ARKit morphs as adapt_cc.py does (Python lower/capitalize)', () => {
    expect(arkitName('A25_Jaw_Open')).toBe('jawOpen');
    expect(arkitName('A01_Brow_Inner_Up')).toBe('browInnerUp');
    expect(arkitName('A38_Mouth_Smile_Left')).toBe('mouthSmileLeft');
    expect(arkitName('A52_Tongue_Out')).toBe('tongueOut');
    expect(arkitName('A10_EYE_LOOK_UP_LEFT')).toBe('eyeLookUpLeft');
    expect(arkitName('Eye_Blink_L')).toBeNull();
  });

  it('builds 33 ARKit shapes from the Traditional profile, sides kept', () => {
    expect(LEGACY_ARKIT).toHaveLength(33);
    const map = new Map(LEGACY_ARKIT);
    expect(map.get('eyeBlinkLeft')).toEqual({ Eye_Blink_L: 1 });
    expect(map.get('mouthSmileRight')).toEqual({ Mouth_Smile_R: 1 });
    expect(map.get('browInnerUp')).toEqual({ Brow_Raise_Inner_L: 1, Brow_Raise_Inner_R: 1 });
    expect(map.get('jawOpen')).toEqual({ Mouth_Open: 1 });
  });

  it('mixes the five visemes from CC lip-sync shapes', () => {
    expect(new Map(VISEMES).get('viseme_I')).toEqual({ Wide: 0.6, Lip_Open: 0.4 });
  });
});
