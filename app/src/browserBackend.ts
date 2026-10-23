// The page in a plain browser: the built-in converter only. Files the person picks or drops are
// kept here under a handle ("path"), and the finished VRM stays in memory until it is
// downloaded. Nothing leaves the machine.

import { localJobs, type Backend } from './backend';
import { BuiltinConverter } from './builtin';
import { inspectFile } from './inspect';
import type { BlenderStatus } from './types';

const LINKS = {
  blender: 'https://www.blender.org/download/',
  'vrm-addon': 'https://extensions.blender.org/add-ons/vrm/',
  latentpresence: 'https://latentpresence.com',
};

const noBlender: BlenderStatus = { path: null, version: null, versionOk: false, vrmAddon: null, found: [], problem: 'Blender is used by the desktop app only.' };

/** The browser's file chooser, for one .fbx. */
function choose(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.fbx';
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

const allowDrop = (e: DragEvent) => e.preventDefault();

export function browserBackend(): Backend {
  const files = new Map<string, File>();
  const results = new Map<string, ArrayBuffer>();
  const local = localJobs();
  const builtin = new BuiltinConverter(local.emit);
  let n = 0;
  const keep = (f: File) => {
    const path = `file:${++n}/${f.name}`;
    files.set(path, f);
    return path;
  };

  return {
    kind: 'browser',
    engines: ['builtin'],
    saveLabel: 'Download',
    blenderStatus: async () => noBlender,
    setBlender: async () => noBlender,
    pickBlender: async () => null,
    installVrmAddon: async () => noBlender,
    async pickFbx() {
      const f = await choose();
      return f ? inspectFile(f, keep(f)) : null;
    },
    async inspectFbx(path) {
      const f = files.get(path);
      if (!f) throw new Error('That file is no longer open; choose it again.');
      return inspectFile(f, path);
    },
    outDir: async () => '',
    pickOutDir: async () => null,
    async convert(req) {
      const fbx = files.get(req.fbx);
      if (!fbx) throw new Error('Choose the character again.');
      if (req.kind === 'unknown') throw new Error('This file is not a Daz Genesis or Character Creator export.');
      const r = await builtin.run(fbx, { kind: req.kind, name: req.name, quality: req.quality, springBones: req.springBones, twistSplit: req.twistSplit });
      if (!r) return;
      const suffix = req.quality === 'web' ? '.web' : req.quality === 'max' ? '.max' : '';
      const output = `${req.name}${suffix}.vrm`;
      results.clear(); // one VRM at a time: they are tens of MB
      results.set(output, r.vrm);
      local.emit({ type: 'done', output, bytes: r.vrm.byteLength, summary: r.summary });
    },
    cancel: async () => builtin.cancel(),
    onJob: async (l) => local.listen(l),
    async onFileDrop(listener) {
      const drop = (e: DragEvent) => {
        e.preventDefault();
        const dropped = [...(e.dataTransfer?.files ?? [])];
        if (dropped.length) listener(dropped.map(keep));
      };
      window.addEventListener('dragover', allowDrop);
      window.addEventListener('drop', drop);
      return () => {
        window.removeEventListener('dragover', allowDrop);
        window.removeEventListener('drop', drop);
      };
    },
    async readVrm(path) {
      const r = results.get(path);
      if (!r) throw new Error('The VRM is gone; convert again.');
      return r;
    },
    async reveal(path) {
      const r = results.get(path);
      if (!r) return;
      const url = URL.createObjectURL(new Blob([r], { type: 'model/gltf-binary' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: path });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    openLink: async (which) => void window.open(LINKS[which], '_blank', 'noopener'),
  };
}
