// The shapes the Rust shell sends and takes (src-tauri/src/*.rs, serde camelCase).

export type BlenderStatus = {
  path: string | null;
  version: string | null;
  versionOk: boolean;
  vrmAddon: string | null;
  found: string[];
  problem: string | null;
};

export type Kind = 'daz' | 'cc' | 'unknown';

export type FbxInfo = {
  path: string;
  fileName: string;
  sizeBytes: number;
  kind: Kind;
  family: string;
  face: string;
  supported: boolean;
  notes: string[];
  suggestedName: string;
};

export type Quality = 'web' | 'desktop' | 'max';

/**
 * Who converts: the built-in converter (TypeScript + WebAssembly, in the page) or the person's
 * Blender running the reference pipeline (src/blender/).
 */
export type Engine = 'builtin' | 'blender';

export type ConvertRequest = {
  engine: Engine;
  fbx: string;
  kind: Kind;
  name: string;
  outDir: string;
  quality: Quality;
  springBones: boolean;
  twistSplit: boolean;
};

export type Summary = {
  bytes?: number;
  verts?: number;
  tris?: number;
  human_bones?: number;
  expressions?: number;
  springs: number;
  twistSplit: boolean;
  faceSource: string | null;
};

export type JobEvent =
  | { type: 'planned'; labels: string[] }
  | { type: 'stage'; index: number; state: 'running' | 'done'; seconds: number }
  | { type: 'log'; line: string }
  | { type: 'done'; output: string; bytes: number; summary: Summary }
  | { type: 'failed'; index: number; message: string; logTail: string[]; jobDir: string }
  | { type: 'cancelled' };

export function blenderReady(s: BlenderStatus | null): boolean {
  return !!s && !!s.path && s.versionOk && !!s.vrmAddon;
}
