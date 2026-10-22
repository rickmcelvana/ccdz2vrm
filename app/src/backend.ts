// Everything the page asks of the outside world. In the app that is the Rust shell; in a plain
// browser (`pnpm dev`) a fake plays a conversion back so the page can be built and checked
// without Tauri. The fake never ships: a production build outside Tauri says so instead.

import type { BlenderStatus, ConvertRequest, FbxInfo, JobEvent } from './types';

export type Backend = {
  readonly kind: 'tauri' | 'fake';
  blenderStatus(): Promise<BlenderStatus>;
  setBlender(path: string): Promise<BlenderStatus>;
  pickBlender(): Promise<BlenderStatus | null>;
  installVrmAddon(): Promise<BlenderStatus>;
  pickFbx(): Promise<FbxInfo | null>;
  inspectFbx(path: string): Promise<FbxInfo>;
  outDir(): Promise<string>;
  pickOutDir(): Promise<string | null>;
  convert(req: ConvertRequest): Promise<void>;
  cancel(): Promise<void>;
  onJob(listener: (ev: JobEvent) => void): Promise<() => void>;
  /** Paths of .fbx files dropped on the window. */
  onFileDrop(listener: (paths: string[]) => void): Promise<() => void>;
  readVrm(path: string): Promise<ArrayBuffer>;
  reveal(path: string): Promise<void>;
  openLink(which: 'blender' | 'vrm-addon' | 'latentpresence'): Promise<void>;
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const inTauri = typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined;

async function tauriBackend(): Promise<Backend> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  return {
    kind: 'tauri',
    blenderStatus: () => invoke('blender_status'),
    setBlender: (path) => invoke('set_blender', { path }),
    pickBlender: () => invoke('pick_blender'),
    installVrmAddon: () => invoke('install_vrm_addon'),
    pickFbx: () => invoke('pick_fbx'),
    inspectFbx: (path) => invoke('inspect_fbx', { path }),
    outDir: () => invoke('out_dir'),
    pickOutDir: () => invoke('pick_out_dir'),
    convert: (req) => invoke('start_convert', { req }),
    cancel: () => invoke('cancel_convert'),
    onJob: (listener) => listen<JobEvent>('job', (e) => listener(e.payload)),
    onFileDrop: (listener) =>
      getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === 'drop') listener(e.payload.paths);
      }),
    readVrm: (path) => invoke<ArrayBuffer>('read_vrm', { path }),
    reveal: (path) => invoke('reveal', { path }),
    openLink: (which) => invoke('open_link', { which }),
  };
}

let backend: Promise<Backend> | null = null;

export function getBackend(): Promise<Backend> {
  if (backend) return backend;
  if (inTauri) backend = tauriBackend();
  else if (import.meta.env.DEV) backend = import('./fakeBackend').then((m) => m.fakeBackend());
  else backend = Promise.reject(new Error('Open this page in the ccdz2vrm app.'));
  return backend;
}
