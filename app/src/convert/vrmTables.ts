// The finisher's tables, as src/blender/vrm_export.py has them, plus the VRM add-on's own
// ARKit preset mapping (vrm/common/shape_key_mapper/arkit_mapping.py, add-on 4.7.1) for the
// presets ours leave alone (look*). Humanoid names in VRM 1.0 JSON spelling (camelCase).

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function fingers(side: 'left' | 'right', bone: (finger: string, n: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  const names: [string, string][] = [['thumb', 'Thumb'], ['index', 'Index'], ['middle', 'Mid'], ['ring', 'Ring'], ['little', 'Pinky']];
  for (const [vrm, src] of names) {
    const segs = vrm === 'thumb' ? ['metacarpal', 'proximal', 'distal'] : ['proximal', 'intermediate', 'distal'];
    segs.forEach((seg, i) => (out[camel(`${side}_${vrm}_${seg}`)] = bone(src, String(i + 1))));
  }
  return out;
}

const CC3: Record<string, string> = {
  hips: 'CC_Base_Hip', spine: 'CC_Base_Waist', chest: 'CC_Base_Spine01', upperChest: 'CC_Base_Spine02',
  neck: 'CC_Base_NeckTwist01', head: 'CC_Base_Head', leftEye: 'CC_Base_L_Eye', rightEye: 'CC_Base_R_Eye',
};
const DAZ: Record<string, string> = {
  hips: 'hip', spine: 'abdomenLower', chest: 'chestLower', upperChest: 'chestUpper', neck: 'neckLower', head: 'head',
  leftEye: 'lEye', rightEye: 'rEye',
};
const LIMBS_CC: [string, string][] = [['shoulder', 'Clavicle'], ['upper_arm', 'Upperarm'], ['lower_arm', 'Forearm'], ['hand', 'Hand'],
  ['upper_leg', 'Thigh'], ['lower_leg', 'Calf'], ['foot', 'Foot'], ['toes', 'ToeBase']];
const LIMBS_DAZ: [string, string][] = [['shoulder', 'Collar'], ['upper_arm', 'ShldrBend'], ['lower_arm', 'ForearmBend'], ['hand', 'Hand'],
  ['upper_leg', 'ThighBend'], ['lower_leg', 'Shin'], ['foot', 'Foot'], ['toes', 'Toe']];
for (const [side, s] of [['left', 'L'], ['right', 'R']] as const) {
  for (const [vrm, cc] of LIMBS_CC) CC3[camel(`${side}_${vrm}`)] = `CC_Base_${s}_${cc}`;
  Object.assign(CC3, fingers(side, (f, n) => `CC_Base_${s}_${f}${n}`));
  const d = s.toLowerCase();
  for (const [vrm, daz] of LIMBS_DAZ) DAZ[camel(`${side}_${vrm}`)] = `${d}${daz}`;
  Object.assign(DAZ, fingers(side, (f, n) => `${d}${f}${n}`));
}

export const BONE_TABLES: Record<string, Record<string, string>> = { cc3: CC3, daz_genesis3_8: DAZ };

export function detectBoneTable(names: Set<string>): string | null {
  if (names.has('CC_Base_Hip')) return 'cc3';
  if (names.has('lShldrBend') && names.has('lEyelidUpper')) return 'daz_genesis3_8';
  return null;
}

/** Our presets (vrm_export.py PRESETS), in VRM 1.0 names. */
export const PRESETS: [string, Record<string, number>][] = [
  ['aa', { viseme_aa: 1 }], ['ih', { viseme_I: 1 }], ['ou', { viseme_U: 1 }], ['ee', { viseme_E: 1 }], ['oh', { viseme_O: 1 }],
  ['blink', { eyeBlinkLeft: 1, eyeBlinkRight: 1 }], ['blinkLeft', { eyeBlinkLeft: 1 }], ['blinkRight', { eyeBlinkRight: 1 }],
  ['happy', { mouthSmileLeft: 0.8, mouthSmileRight: 0.8, cheekSquintLeft: 0.5, cheekSquintRight: 0.5, eyeSquintLeft: 0.3, eyeSquintRight: 0.3 }],
  ['angry', { browDownLeft: 0.9, browDownRight: 0.9, mouthFrownLeft: 0.4, mouthFrownRight: 0.4, noseSneerLeft: 0.4, noseSneerRight: 0.4 }],
  ['sad', { browInnerUp: 0.8, mouthFrownLeft: 0.6, mouthFrownRight: 0.6 }],
  ['relaxed', { mouthSmileLeft: 0.3, mouthSmileRight: 0.3, eyeSquintLeft: 0.2, eyeSquintRight: 0.2 }],
  ['surprised', { browInnerUp: 0.8, browOuterUpLeft: 0.8, browOuterUpRight: 0.8, eyeWideLeft: 0.6, eyeWideRight: 0.6, jawOpen: 0.35 }],
];
export const OVERRIDE_BLINK: Record<string, 'blend' | 'block'> = { happy: 'blend', surprised: 'block' };

/** The add-on's presets that ours do not replace (neutral stays empty). */
export const ADDON_PRESETS: [string, Record<string, number>][] = [
  ['lookUp', { eyeLookUpLeft: 1, eyeLookUpRight: 1 }], ['lookDown', { eyeLookDownLeft: 1, eyeLookDownRight: 1 }],
  ['lookLeft', { eyeLookOutLeft: 1, eyeLookInRight: 1 }], ['lookRight', { eyeLookInLeft: 1, eyeLookOutRight: 1 }],
];

/** The 52 ARKit names the add-on makes custom expressions for, bound wherever a mesh has them. */
export const ARKIT_SHAPE_KEYS = [
  'eyeBlinkLeft', 'eyeLookDownLeft', 'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookUpLeft', 'eyeSquintLeft', 'eyeWideLeft',
  'eyeBlinkRight', 'eyeLookDownRight', 'eyeLookInRight', 'eyeLookOutRight', 'eyeLookUpRight', 'eyeSquintRight', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawRight', 'jawOpen', 'mouthClose', 'mouthFunnel', 'mouthPucker', 'mouthLeft', 'mouthRight',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthDimpleLeft', 'mouthDimpleRight',
  'mouthStretchLeft', 'mouthStretchRight', 'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
  'mouthPressLeft', 'mouthPressRight', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthUpperUpLeft', 'mouthUpperUpRight',
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'cheekPuff', 'cheekSquintLeft',
  'cheekSquintRight', 'noseSneerLeft', 'noseSneerRight', 'tongueOut',
];

export const EYES: [string, string][] = [['eye_l', 'eye_r'], ['lEye', 'rEye'], ['CC_Base_L_Eye', 'CC_Base_R_Eye']];
