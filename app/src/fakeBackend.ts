// Dev-only stand-in for the Rust shell (see backend.ts), at http://localhost:5174/?fake. It plays
// back the stages of a real conversion and serves a real VRM from out/, so the page is checked
// against real output without converting.
//
//   ?vrm=out/app_test/genesis8_1AliceTest_01.web.vrm   which VRM the "conversion" produces
//   ?blender=missing|noaddon|old                       setup states to look at
//   ?engine=blender                                    start on the Blender (reference) converter
//   ?fail=1                                            a conversion that fails in stage 1

import type { Backend } from './backend';
import type { BlenderStatus, FbxInfo, JobEvent } from './types';

declare const REPO_ROOT: string;

const params = new URLSearchParams(location.search);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function status(): BlenderStatus {
  const which = params.get('blender');
  const path = 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe';
  if (which === 'missing')
    return { path: null, version: null, versionOk: false, vrmAddon: null, found: [], problem: 'Blender was not found on this computer.' };
  if (which === 'old')
    return { path, version: '3.6.5', versionOk: false, vrmAddon: null, found: [path], problem: 'Blender 3.6 is too old: the VRM add-on needs 4.2 or newer.' };
  if (which === 'noaddon')
    return { path, version: '5.2.2', versionOk: true, vrmAddon: null, found: [path], problem: 'Blender needs the VRM add-on (free, from extensions.blender.org).' };
  return { path, version: '5.2.2', versionOk: true, vrmAddon: '4.7.1', found: [path], problem: null };
}

const alice: FbxInfo = {
  path: 'G:\\imports\\DAZ\\genesis8.1AliceTest_01.fbx',
  fileName: 'genesis8.1AliceTest_01.fbx',
  sizeBytes: 141_966_336,
  kind: 'daz',
  family: 'Genesis 8.1',
  face: 'FACS morphs: all 52 ARKit shapes (best)',
  supported: true,
  notes: [],
  suggestedName: 'genesis8_1AliceTest_01',
};

export function fakeBackend(): Backend {
  const listeners = new Set<(ev: JobEvent) => void>();
  const emit = (ev: JobEvent) => listeners.forEach((l) => l(ev));
  let cancelled = false;
  const vrm = params.get('vrm') ?? 'out/app_test/genesis8_1AliceTest_01.web.vrm';

  return {
    kind: 'fake',
    engines: params.get('engine') === 'blender' ? ['blender', 'builtin'] : ['builtin', 'blender'],
    saveLabel: 'Show in folder',
    blenderStatus: async () => (await sleep(500), status()),
    setBlender: async () => status(),
    pickBlender: async () => status(),
    installVrmAddon: async () => (await sleep(1500), { ...status(), vrmAddon: '4.10.2', problem: null }),
    pickFbx: async () => alice,
    inspectFbx: async () => alice,
    outDir: async () => 'C:\\Users\\you\\Documents\\ccdz2vrm',
    pickOutDir: async () => 'D:\\Avatars',
    convert: async (req) => {
      cancelled = false;
      const labels = ['Reading your character', 'Building the VRM', 'Shrinking it for the web', 'Checking the result'];
      if (req.quality !== 'web') labels.splice(2, 1);
      emit({ type: 'planned', labels });
      for (let i = 0; i < labels.length; i++) {
        emit({ type: 'stage', index: i, state: 'running', seconds: 0 });
        for (let k = 0; k < 6; k++) {
          await sleep(250);
          if (cancelled) return emit({ type: 'cancelled' });
          emit({ type: 'log', line: `${labels[i]}: step ${k + 1}` });
        }
        if (i === 0 && params.get('fail')) {
          return emit({
            type: 'failed',
            index: 0,
            message: 'unsupported Daz rig family: genesis1_2',
            logTail: ['Traceback (most recent call last):', 'unsupported Daz rig family: genesis1_2', 'Blender quit'],
            jobDir: 'C:\\Users\\you\\AppData\\Local\\com.latentpresence.ccdz2vrm\\job',
          });
        }
        emit({ type: 'stage', index: i, state: 'done', seconds: 1.5 });
      }
      emit({
        type: 'done',
        output: `${REPO_ROOT}/${vrm}`,
        bytes: 6_353_228,
        summary: { bytes: 6_353_228, verts: 138_787, tris: 192_744, human_bones: 54, expressions: 70, springs: 22, twistSplit: false, faceSource: 'facs_morphs' },
      });
    },
    cancel: async () => {
      cancelled = true;
    },
    onJob: async (l) => (listeners.add(l), () => listeners.delete(l)),
    onFileDrop: async () => () => {},
    readVrm: async (path) => {
      const res = await fetch(`/@fs/${path.replaceAll('\\', '/')}`);
      if (!res.ok) throw new Error(`${res.status} reading ${path}`);
      return res.arrayBuffer();
    },
    reveal: async () => {},
    openLink: async () => {},
  };
}
