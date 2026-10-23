// The converter's Web Worker: one conversion per message, progress posted back as it goes. The
// page cancels by terminating the worker.

import { convertFbx, type ConvertJob } from './convert.ts';
import { browserCodec } from './browserCodec.ts';
import { ufbxParser } from './ufbx.ts';
import ufbxUrl from './ufbx_contract.wasm?url';

export type WorkerRequest = { fbx: Blob; job: ConvertJob };
export type WorkerMessage =
  | { type: 'stage'; index: number; state: 'running' | 'done' }
  | { type: 'log'; line: string }
  | { type: 'done'; vrm: ArrayBuffer; summary: Awaited<ReturnType<typeof convertFbx>>['summary'] }
  | { type: 'failed'; message: string };

const post = (m: WorkerMessage, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

/** compileStreaming needs the server to say application/wasm; plenty of static hosts don't. */
async function compile(url: string): Promise<WebAssembly.Module> {
  try {
    return await WebAssembly.compileStreaming(fetch(url));
  } catch {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load the FBX reader (${res.status}).`);
    return WebAssembly.compile(await res.arrayBuffer());
  }
}

self.addEventListener('message', async (e: MessageEvent<WorkerRequest>) => {
  try {
    const parse = ufbxParser(await compile(ufbxUrl));
    const fbx = new Uint8Array(await e.data.fbx.arrayBuffer());
    const { vrm, summary } = await convertFbx(fbx, e.data.job, parse, browserCodec, {
      stage: (index, state) => post({ type: 'stage', index, state }),
      log: (line) => post({ type: 'log', line }),
    });
    const buf = vrm.buffer.slice(vrm.byteOffset, vrm.byteOffset + vrm.byteLength) as ArrayBuffer;
    post({ type: 'done', vrm: buf, summary }, [buf]);
  } catch (err) {
    post({ type: 'failed', message: err instanceof Error ? err.message : String(err) });
  }
});
