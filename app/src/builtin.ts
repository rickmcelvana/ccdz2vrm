// The built-in converter, page side: runs app/src/convert/worker.ts and turns its messages into
// the job events the page already knows from the Blender pipeline (types.ts JobEvent). Both
// the browser site and the desktop app use it; they differ only in where the FBX comes from and
// where the VRM goes.

import { STAGES, type ConvertJob, type Summary } from './convert/convert';
import type { WorkerMessage, WorkerRequest } from './convert/worker';
import type { JobEvent } from './types';

const LOG_TAIL = 40;

export type BuiltinResult = { vrm: ArrayBuffer; summary: Summary };

export class BuiltinConverter {
  private worker: Worker | null = null;
  private finishRun: ((r: BuiltinResult | null) => void) | null = null;
  private readonly emit: (ev: JobEvent) => void;

  constructor(emit: (ev: JobEvent) => void) {
    this.emit = emit;
  }

  get busy(): boolean {
    return this.worker !== null;
  }

  /** Converts; resolves with the VRM, or null once a failure or cancel has been emitted. */
  run(fbx: Blob, job: ConvertJob): Promise<BuiltinResult | null> {
    if (this.worker) return Promise.reject(new Error('A conversion is already running.'));
    const worker = new Worker(new URL('./convert/worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    this.emit({ type: 'planned', labels: [...STAGES] });
    const log: string[] = [];
    let current = 0, t0 = performance.now();
    return new Promise((resolve) => {
      const end = (r: BuiltinResult | null) => {
        worker.terminate();
        this.worker = null;
        this.finishRun = null;
        resolve(r);
      };
      this.finishRun = end;
      worker.addEventListener('message', (e: MessageEvent<WorkerMessage>) => {
        const m = e.data;
        if (m.type === 'stage') {
          if (m.state === 'running') [current, t0] = [m.index, performance.now()];
          this.emit({ type: 'stage', index: m.index, state: m.state, seconds: (performance.now() - t0) / 1000 });
        } else if (m.type === 'log') {
          log.push(m.line);
          this.emit({ type: 'log', line: m.line });
        } else if (m.type === 'done') end({ vrm: m.vrm, summary: m.summary });
        else {
          this.emit({ type: 'failed', index: current, message: m.message, logTail: log.slice(-LOG_TAIL), jobDir: '' });
          end(null);
        }
      });
      worker.addEventListener('error', (e) => {
        // a worker that dies (out of memory) reports here, without a message of its own
        this.emit({ type: 'failed', index: current, message: e.message || 'The converter stopped (out of memory?).', logTail: log.slice(-LOG_TAIL), jobDir: '' });
        end(null);
      });
      // eslint-disable-next-line unicorn/require-post-message-target-origin -- a Worker, not a window
      worker.postMessage({ fbx, job } satisfies WorkerRequest);
    });
  }

  cancel(): void {
    if (!this.finishRun) return;
    this.emit({ type: 'cancelled' });
    this.finishRun(null);
  }
}
