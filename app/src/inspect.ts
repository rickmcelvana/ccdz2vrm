// What an FBX is, read in well under a second, before the conversion: a port of
// src-tauri/src/fbx.rs for the browser. FBX keeps node and bone names as plain strings, so a
// byte scan tells the families apart with the markers the adapters check after a full import
// (ENVIRONMENT.md s23, s24, s26).

import type { FbxInfo, Kind } from './types';

const NEEDLES = ['CC_Base_Hip', 'A01_Brow_Inner_Up', 'Eye_Blink_L', 'lShldrBend', 'lEyelidUpper', 'Genesis8_1', 'Genesis8', 'Genesis3', 'facs_bs_'] as const;
type Needle = (typeof NEEDLES)[number];
const CHUNK = 32 << 20, OVERLAP = 64;

/** Which markers occur in the file, and whether a Genesis 1/2 shoulder (`lShldr` not followed by `B`) does. */
export async function scan(read: (start: number, end: number) => Promise<Uint8Array>, size: number): Promise<{ has: Set<Needle>; oldShoulder: boolean }> {
  const has = new Set<Needle>();
  let oldShoulder = false;
  const latin1 = new TextDecoder('latin1');
  for (let start = 0; start < size; start += CHUNK) {
    const s = latin1.decode(await read(start, Math.min(size, start + CHUNK + OVERLAP)));
    for (const n of NEEDLES) if (!has.has(n) && s.includes(n)) has.add(n);
    if (!oldShoulder && /lShldr[^B]/.test(s)) oldShoulder = true;
  }
  return { has, oldShoulder };
}

export function classify(has: Set<string>, oldShoulder: boolean): Pick<FbxInfo, 'kind' | 'family' | 'face' | 'supported' | 'notes'> {
  const notes: string[] = [];
  const out = (kind: Kind, family: string, face: string, supported: boolean) => ({ kind, family, face, supported, notes });
  if (has.has('CC_Base_Hip')) {
    let face = 'none found';
    if (has.has('A01_Brow_Inner_Up')) face = 'ARKit 52 expressions (best)';
    else if (has.has('Eye_Blink_L')) {
      notes.push("This character uses CC's Traditional facial profile: it converts, with 33 of the 52 face-tracking shapes. Switching it to the ARKit profile in CC gives all 52.");
      face = 'Traditional profile (33 of 52 shapes)';
    } else notes.push('No face morphs found. Re-export from CC with facial expressions included, or the avatar will not blink or talk.');
    return out('cc', 'Character Creator', face, true);
  }
  if (has.has('lShldrBend') && has.has('lEyelidUpper')) {
    const family = has.has('Genesis8_1') ? 'Genesis 8.1' : has.has('Genesis8') ? 'Genesis 8' : has.has('Genesis3') ? 'Genesis 3' : 'Genesis 3 / 8';
    let face = 'FACS morphs: all 52 ARKit shapes (best)';
    if (!has.has('facs_bs_')) {
      if (family === 'Genesis 8.1')
        notes.push('For the best face, re-export with the FACS morphs: in Daz\'s FBX export, open Edit Morph Export Rules and add a rule matching "facs" set to Export.');
      face = 'posed from the face bones (26 of 52 shapes)';
    }
    return out('daz', family, face, true);
  }
  if (oldShoulder) {
    notes.push('Genesis 1 and 2 exports carry no blink or expression morphs, so no converter can make this face move. Use a Genesis 3, 8 or 8.1 figure.');
    return out('daz', 'Genesis 1 / 2', 'no expressions in the file', false);
  }
  notes.push('This does not look like a Daz Genesis or Character Creator export (no Genesis or CC_Base skeleton inside).');
  return out('unknown', 'Unknown', '-', false);
}

/** A VRM name from a file name: letters, digits, `-` and `_` only. */
export function suggestName(stem: string): string {
  const s = stem.replaceAll(/[^A-Za-z0-9_-]/g, '_').replaceAll(/^_+|_+$/g, '');
  return s || 'avatar';
}

/** fbx.rs `inspect` for a File the person picked or dropped; `path` is the page's handle for it. */
export async function inspectFile(file: Blob & { name: string }, path: string): Promise<FbxInfo> {
  if (!file.name.toLowerCase().endsWith('.fbx')) throw new Error('Choose an .fbx file exported from Daz Studio or Character Creator.');
  const { has, oldShoulder } = await scan(async (a, b) => new Uint8Array(await file.slice(a, b).arrayBuffer()), file.size);
  return { path, fileName: file.name, sizeBytes: file.size, ...classify(has, oldShoulder), suggestedName: suggestName(file.name.replace(/\.[^.]*$/, '')) };
}
