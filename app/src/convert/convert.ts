// One conversion, start to end, as the Blender pipeline plans it (src-tauri/src/pipeline.rs):
// FBX -> contract (ufbx) -> import cleanup -> Daz/CC adapter -> finisher -> a check of the file.
// Platform-free: the worker (worker.ts) gives it the parser and the image codec, and the Node
// harness can give it its own.

import type { Contract } from './contract.ts';
import { cleanImport } from './cleanup.ts';
import { adaptCc } from './adaptCc.ts';
import { adaptDaz } from './adaptDaz.ts';
import { finish, type FinishOptions } from './finish.ts';
import type { ImageCodec } from './images.ts';

export type Quality = 'web' | 'desktop' | 'max';

export type ConvertJob = {
  kind: 'daz' | 'cc';
  name: string;
  quality: Quality;
  springBones: boolean;
  twistSplit: boolean;
  /** Overrides the tier's texture size (the harness compares the max tier at Blender's 1024). */
  maxTexture?: number;
};

export type Summary = {
  bytes: number;
  verts: number;
  tris: number;
  human_bones: number;
  expressions: number;
  springs: number;
  twistSplit: boolean;
  faceSource: string | null;
};

export type Progress = {
  stage(index: number, state: 'running' | 'done'): void;
  log(line: string): void;
};

export const STAGES = ['Reading your character', 'Setting up the face and pose', 'Building the VRM', 'Checking the result'] as const;

/** The finisher's options for a tier, as pipeline.rs plans vrm_export.py's flags. */
export function finishOptions(job: ConvertJob): FinishOptions {
  return {
    name: job.name,
    maxTexture: job.maxTexture ?? (job.quality === 'max' ? 2048 : 1024),
    web: job.quality === 'web',
    // Daz hair is the bulk of a web file (s35)
    maxMeshVerts: job.quality === 'web' && job.kind === 'daz' ? 50000 : null,
    springBones: job.springBones,
    twistSplit: job.twistSplit && job.kind === 'daz',
  };
}

export async function convertFbx(
  fbx: Uint8Array, job: ConvertJob, parse: (fbx: Uint8Array) => Promise<Contract>, codec: ImageCodec, progress: Progress,
): Promise<{ vrm: Uint8Array; summary: Summary }> {
  const timed = async <T>(index: number, f: () => Promise<T>): Promise<T> => {
    progress.stage(index, 'running');
    const r = await f();
    progress.stage(index, 'done');
    return r;
  };
  const raw = await timed(0, async () => {
    const c = await parse(fbx);
    progress.log(`read ${c.bones.length} bones, ${c.meshes.length} meshes, ${c.images.length} images`);
    return c;
  });
  let faceSource: string | null = null;
  const adapted = await timed(1, async () => {
    const { contract: clean } = await cleanImport(raw, codec);
    progress.log(`cleaned: ${clean.meshes.length} meshes on ${clean.bones.length} bones`);
    if (job.kind === 'cc') {
      const { contract, report } = await adaptCc(clean, job.name, codec);
      faceSource = report.arkit_from_legacy ? 'cc_traditional' : 'arkit';
      progress.log(`Character Creator: ${JSON.stringify(report).slice(0, 300)}`);
      return contract;
    }
    const { contract, report } = adaptDaz(clean, job.name);
    faceSource = report.face_source;
    progress.log(`${report.family}: face from ${report.face_source}`);
    return contract;
  });
  const { vrm, report } = await timed(2, () => finish(adapted, codec, { ...finishOptions(job), log: progress.log }));
  const summary = await timed(3, async () => {
    const s = checkVrm(vrm);
    progress.log(`ok ${JSON.stringify(s)}`);
    return { ...s, springs: report.spring_export?.springs ?? 0, twistSplit: !!report.twist_split, faceSource };
  });
  return { vrm, summary };
}

const REQUIRED = ['hips', 'spine', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];

/** vrm_check.py's counts, and its refusal of a file a runtime would not load as an avatar. */
export function checkVrm(vrm: Uint8Array): Omit<Summary, 'springs' | 'twistSplit' | 'faceSource'> {
  const dv = new DataView(vrm.buffer, vrm.byteOffset, vrm.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('the VRM is not a GLB file');
  const jl = dv.getUint32(12, true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- glTF JSON
  const g: any = JSON.parse(new TextDecoder().decode(vrm.subarray(20, 20 + jl)));
  const ext = g.extensions?.VRMC_vrm;
  if (!ext) throw new Error('the file has no VRMC_vrm extension');
  const bones = ext.humanoid?.humanBones ?? {};
  const missing = REQUIRED.filter((b) => !bones[b]);
  if (missing.length) throw new Error(`humanoid bones missing: ${missing.join(', ')}`);
  const positions = new Set<number>();
  let tris = 0;
  for (const m of g.meshes ?? [])
    for (const p of m.primitives) {
      positions.add(p.attributes.POSITION);
      if (p.indices !== undefined && !g.materials?.[p.material]?.name?.endsWith('.fringe')) tris += g.accessors[p.indices].count / 3;
    }
  let verts = 0;
  for (const a of positions) verts += g.accessors[a].count;
  const expressions = Object.keys(ext.expressions?.preset ?? {}).length + Object.keys(ext.expressions?.custom ?? {}).length;
  return { bytes: vrm.byteLength, verts, tris, human_bones: Object.keys(bones).length, expressions };
}
