// Everything the page asks of the outside world. Three of them:
//  - the desktop app (Tauri): Rust reads and writes files; it converts with the built-in
//    converter by default, or runs the person's Blender on the reference pipeline;
//  - a plain browser (the static site, browserBackend.ts): the built-in converter only, the
//    FBX picked or dropped, the VRM downloaded;
//  - a fake (`pnpm dev` with ?fake): plays a conversion back so the page can be checked without
//    converting anything.

import { BuiltinConverter } from './builtin';
import type { BlenderStatus, ConvertRequest, Engine, FbxInfo, JobEvent } from './types';

export type Backend = {
  readonly kind: 'tauri' | 'browser' | 'fake';
  /** The converters this backend offers, the default first. */
  readonly engines: readonly Engine[];
  /** What the result's button does with the VRM: open its folder, or download it. */
  readonly saveLabel: string;
  blenderStatus(): Promise<BlenderStatus>;
  setBlender(path: string): Promise<BlenderStatus>;
  pickBlender(): Promise<BlenderStatus | null>;
  installVrmAddon(): Promise<BlenderStatus>;
  pickFbx(): Promise<FbxInfo | null>;
  inspectFbx(path: string): Promise<FbxInfo>;
  /** '' where there is no folder to choose (a browser downloads). */
  outDir(): Promise<string>;
  pickOutDir(): Promise<string | null>;
  convert(req: ConvertRequest): Promise<void>;
  cancel(): Promise<void>;
  onJob(listener: (ev: JobEvent) => void): Promise<() => void>;
  /** Paths (handles, in a browser) of .fbx files dropped on the window. */
  onFileDrop(listener: (paths: string[]) => void): Promise<() => void>;
  readVrm(path: string): Promise<ArrayBuffer>;
  /** Show the VRM in its folder, or download it. */
  reveal(path: string): Promise<void>;
  openLink(which: 'blender' | 'vrm-addon' | 'latentpresence'): Promise<void>;
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const inTauri = typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined;

/** Job listeners for events raised in the page (the built-in converter). */
export function localJobs() {
  const listeners = new Set<(ev: JobEvent) => void>();
  return {
    emit: (ev: JobEvent) => listeners.forEach((l) => l(ev)),
    listen: (l: (ev: JobEvent) => void) => (listeners.add(l), () => void listeners.delete(l)),
  };
}

async function tauriBackend(): Promise<Backend> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  const local = localJobs();
  const builtin = new BuiltinConverter(local.emit);
  return {
    kind: 'tauri',
    engines: ['builtin', 'blender'],
    saveLabel: 'Show in folder',
    blenderStatus: () => invoke('blender_status'),
    setBlender: (path) => invoke('set_blender', { path }),
    pickBlender: () => invoke('pick_blender'),
    installVrmAddon: () => invoke('install_vrm_addon'),
    pickFbx: () => invoke('pick_fbx'),
    inspectFbx: (path) => invoke('inspect_fbx', { path }),
    outDir: () => invoke('out_dir'),
    pickOutDir: () => invoke('pick_out_dir'),
    async convert(req) {
      if (req.engine === 'blender') return invoke('start_convert', { req });
      if (req.kind === 'unknown') throw new Error('This file is not a Daz Genesis or Character Creator export.');
      const fbx = new Blob([await invoke<ArrayBuffer>('read_fbx', { path: req.fbx })]);
      const r = await builtin.run(fbx, { kind: req.kind, name: req.name, quality: req.quality, springBones: req.springBones, twistSplit: req.twistSplit });
      if (!r) return;
      const sep = req.outDir.includes('\\') ? '\\' : '/';
      const suffix = req.quality === 'web' ? '.web' : req.quality === 'max' ? '.max' : '';
      const output = `${req.outDir.replace(/[\\/]+$/, '')}${sep}${req.name}${suffix}.vrm`;
      try {
        await invoke('write_vrm', new Uint8Array(r.vrm), { headers: { path: encodeURIComponent(output) } });
      } catch (e) {
        local.emit({ type: 'failed', index: 3, message: `Could not save the VRM: ${String(e)}`, logTail: [], jobDir: '' });
        return;
      }
      local.emit({ type: 'done', output, bytes: r.vrm.byteLength, summary: r.summary });
    },
    async cancel() {
      if (builtin.busy) builtin.cancel();
      else await invoke('cancel_convert');
    },
    async onJob(listener) {
      const offRust = await listen<JobEvent>('job', (e) => listener(e.payload));
      const offLocal = local.listen(listener);
      return () => (offRust(), offLocal());
    },
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
  else if (import.meta.env.DEV && new URLSearchParams(location.search).has('fake')) backend = import('./fakeBackend').then((m) => m.fakeBackend());
  else backend = import('./browserBackend').then((m) => m.browserBackend());
  return backend;
}
