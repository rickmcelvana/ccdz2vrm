// The FBX parser: ufbx 0.23.1 compiled to WebAssembly with our shim (tools/fbx-spike/
// ufbx_contract.c, built by tools/fbx-spike/build.sh into ufbx_contract.wasm next to this file).
// The shim writes the raw import as a contract -- JSON plus one binary blob -- which is all the
// rest of the converter reads (docs/BROWSER-PORT.md s2). It is a wasm32-wasi reactor that never
// touches a file, so WASI is a stub: writes are swallowed, everything else reports "not supported".

import { readContract, type Contract } from './contract.ts';

type Exports = {
  memory: WebAssembly.Memory;
  _initialize(): void;
  ccdz_alloc(n: number): number;
  ccdz_free(p: number): void;
  ccdz_load(p: number, n: number): number;
  ccdz_error(): number;
  ccdz_json(): number;
  ccdz_json_size(): number;
  ccdz_bin(): number;
  ccdz_bin_size(): number;
  ccdz_reset(): void;
};

/** A parser over one compiled module: each call gets a fresh instance (and its own memory). */
export function ufbxParser(module: WebAssembly.Module): (fbx: Uint8Array) => Promise<Contract> {
  return async (fbx) => {
    let memory: WebAssembly.Memory | null = null;
    const fdWrite = (_fd: number, iovs: number, n: number, written: number) => {
      const v = new DataView(memory!.buffer);
      let total = 0;
      for (let i = 0; i < n; i++) total += v.getUint32(iovs + i * 8 + 4, true);
      v.setUint32(written, total, true);
      return 0;
    };
    const wasi = new Proxy({}, { get: (_, k) => (k === 'fd_write' ? fdWrite : () => 52) });
    const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
    const x = instance.exports as unknown as Exports;
    memory = x.memory;
    x._initialize(); // eslint-disable-line no-underscore-dangle -- the WASI reactor's entry point
    const ptr = x.ccdz_alloc(fbx.byteLength);
    if (!ptr) throw new Error('Not enough memory to read this file.');
    new Uint8Array(memory.buffer, ptr, fbx.byteLength).set(fbx);
    const rc = x.ccdz_load(ptr, fbx.byteLength);
    x.ccdz_free(ptr);
    if (rc) {
      const msg = new TextDecoder().decode(new Uint8Array(memory.buffer, x.ccdz_error(), 1024)).split('\0')[0];
      throw new Error(`Could not read the FBX: ${msg}`);
    }
    const json = new TextDecoder().decode(new Uint8Array(memory.buffer, x.ccdz_json(), x.ccdz_json_size()));
    const bin = new Uint8Array(memory.buffer, x.ccdz_bin(), x.ccdz_bin_size()).slice();
    x.ccdz_reset();
    return readContract(json, bin);
  };
}
