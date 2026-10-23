// The choices on the Options card and what each one means for the conversion.
// The flags themselves are planned in Rust (src-tauri/src/pipeline.rs); this is the wording
// and the defaults.

import type { ConvertRequest, Engine, FbxInfo, Quality } from './types';

export type QualityInfo = {
  id: Quality;
  label: string;
  size: string;
  blurb: string;
};

export const QUALITIES: readonly QualityInfo[] = [
  {
    id: 'web',
    label: 'Web',
    size: '3–8 MB',
    blurb: 'For latentPresence and other web apps. Smaller textures and lighter hair; loads in a second.',
  },
  {
    id: 'desktop',
    label: 'Desktop',
    size: '15–60 MB',
    blurb: 'Full meshes and 1K textures, for desktop VRM apps and VTubing tools.',
  },
  {
    id: 'max',
    label: 'Max',
    size: '25–160 MB',
    blurb: 'Sharpest 2K textures. Heavy; for players on a strong machine.',
  },
];

export type Choices = {
  quality: Quality;
  name: string;
  springBones: boolean;
  twistSplit: boolean;
};

export function defaultChoices(fbx: FbxInfo): Choices {
  return { quality: 'web', name: fbx.suggestedName, springBones: true, twistSplit: false };
}

/** Letters, digits, `-` and `_`: the name becomes the file name. */
export function cleanName(raw: string): string {
  return raw.replaceAll(/[^A-Za-z0-9_-]/g, '_');
}

/** Twist split exists for Daz figures only (Genesis 3/8/8.1 bend + twist bones). */
export function twistAvailable(fbx: FbxInfo): boolean {
  return fbx.kind === 'daz';
}

export function outputFile(choices: Choices): string {
  const suffix = choices.quality === 'web' ? '.web' : choices.quality === 'max' ? '.max' : '';
  return `${choices.name}${suffix}.vrm`;
}

export function request(fbx: FbxInfo, choices: Choices, outDir: string, engine: Engine = 'builtin'): ConvertRequest {
  return {
    engine,
    fbx: fbx.path,
    kind: fbx.kind,
    name: choices.name || 'avatar',
    outDir,
    quality: choices.quality,
    springBones: choices.springBones,
    twistSplit: choices.twistSplit && twistAvailable(fbx),
  };
}

/** Where a VRM lands: the output folder plus outputFile, with the folder's own separator. */
export function outputPath(outDir: string, choices: Choices): string {
  if (!outDir) return outputFile(choices);
  const sep = outDir.includes('\\') ? '\\' : '/';
  return `${outDir.replace(/[\\/]+$/, '')}${sep}${outputFile(choices)}`;
}

export const ENGINES: readonly { id: Engine; label: string; blurb: string }[] = [
  { id: 'builtin', label: 'Built-in', blurb: 'Converts right here, nothing else to install.' },
  { id: 'blender', label: 'Blender (reference)', blurb: 'The original pipeline in your own Blender 4.2+ with the VRM add-on. Slower; for comparing results.' },
];

export function formatBytes(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

export function formatSeconds(s: number): string {
  if (s < 60) return `${Math.round(s)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}
