// One window, left to right: set up and choose (steps 1-3, then Convert), and the stage --
// export instructions until there is a VRM, then the VRM itself.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getBackend, type Backend } from './backend';
import { BlenderCard } from './BlenderCard';
import { CharacterCard } from './CharacterCard';
import { ExportGuide } from './ExportGuide';
import { explain } from './failures';
import { defaultChoices, formatBytes, formatSeconds, request, type Choices } from './options';
import { OptionsCard } from './OptionsCard';
import { blenderReady, type BlenderStatus, type Engine, type FbxInfo, type JobEvent, type Summary } from './types';
import { Viewer } from './Viewer';

type Job =
  | { phase: 'idle' }
  | {
      phase: 'running' | 'done' | 'failed' | 'cancelled';
      labels: string[];
      states: ('waiting' | 'running' | 'done' | 'failed')[];
      seconds: number[];
      log: string[];
      started: number;
      output?: string;
      bytes?: number;
      summary?: Summary;
      failure?: { index: number; message: string; logTail: string[]; jobDir: string };
    };

const LOG_KEEP = 400;
/** The newest published release: the website offers the desktop app from here. */
const RELEASES = 'https://github.com/rickmcelvana/ccdz2vrm/releases/latest';
const ENGINE_KEY = 'ccdz2vrm.engine';

/** The converter last chosen here, if this backend offers it (a per-viewer convenience). */
function savedEngine(offered: readonly Engine[]): Engine {
  try {
    const e = localStorage.getItem(ENGINE_KEY) as Engine | null;
    if (e && offered.includes(e)) return e;
  } catch {
    // storage blocked: the default
  }
  return offered[0] ?? 'builtin';
}
const WAITING = 'waiting';

export function reduceJob(job: Job, ev: JobEvent): Job {
  if (ev.type === 'planned') {
    return {
      phase: 'running',
      labels: ev.labels,
      states: ev.labels.map(() => 'waiting'),
      seconds: ev.labels.map(() => 0),
      log: [],
      started: job.phase === 'idle' ? Date.now() : job.started,
    };
  }
  if (job.phase === 'idle') return job;
  switch (ev.type) {
    case 'stage': {
      const states = [...job.states];
      const seconds = [...job.seconds];
      states[ev.index] = ev.state;
      seconds[ev.index] = ev.seconds;
      return { ...job, states, seconds };
    }
    case 'log':
      return { ...job, log: [...job.log.slice(-LOG_KEEP + 1), ev.line] };
    case 'done':
      return { ...job, phase: 'done', output: ev.output, bytes: ev.bytes, summary: ev.summary };
    case 'failed': {
      const states = [...job.states];
      if (ev.index < states.length) states[ev.index] = 'failed';
      return { ...job, phase: 'failed', states, failure: ev };
    }
    case 'cancelled':
      return { ...job, phase: 'cancelled' };
  }
}

export function App() {
  const [backend, setBackend] = useState<Backend | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [blender, setBlender] = useState<BlenderStatus | null>(null);
  const [fbx, setFbx] = useState<FbxInfo | null>(null);
  const [fbxError, setFbxError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [outDir, setOutDir] = useState('');
  const [job, setJob] = useState<Job>({ phase: 'idle' });
  const [vrm, setVrm] = useState<ArrayBuffer | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [engine, setEngine] = useState<Engine>('builtin');

  const running = job.phase === 'running';
  const progress = useRef<HTMLElement>(null);

  const picked = useCallback((f: FbxInfo | null, error?: string) => {
    setFbx(f);
    setFbxError(error ?? null);
    if (f) setChoices(defaultChoices(f));
  }, []);

  useEffect(() => {
    let off: (() => void)[] = [];
    getBackend()
      .then(async (b) => {
        setBackend(b);
        setEngine(savedEngine(b.engines));
        void b.blenderStatus().then(setBlender);
        void b.outDir().then(setOutDir);
        off.push(await b.onJob((ev) => setJob((j) => reduceJob(j, ev))));
        off.push(
          await b.onFileDrop((paths) => {
            const path = paths.find((p) => p.toLowerCase().endsWith('.fbx'));
            if (!path) return picked(null, 'Drop an .fbx file exported from Daz Studio or Character Creator.');
            b.inspectFbx(path).then((f) => picked(f), (e: unknown) => picked(null, String(e)));
          }),
        );
      })
      .catch((e: unknown) => setFatal(String(e)));
    return () => {
      off.forEach((f) => f());
      off = [];
    };
  }, [picked]);

  // load the finished VRM into the viewer
  useEffect(() => {
    if (job.phase !== 'done' || !job.output || !backend) return;
    backend.readVrm(job.output).then(setVrm, (e: unknown) => setFatal(String(e)));
  }, [job, backend]);

  // bring the progress card into view when a run starts or ends
  useEffect(() => {
    if (job.phase !== 'idle') progress.current?.scrollIntoView({ block: 'nearest' });
  }, [job.phase]);

  // a ticking clock for the running stage
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);

  if (fatal) {
    return (
      <div className="fatal">
        <p>{fatal}</p>
      </div>
    );
  }
  if (!backend) return null;

  const useBlender = engine === 'blender';
  const ready = !useBlender || blenderReady(blender);
  const canConvert = ready && !!fbx?.supported && !!choices?.name && !running;
  const chooseEngine = (e: Engine) => {
    setEngine(e);
    try {
      localStorage.setItem(ENGINE_KEY, e);
    } catch {
      // not remembered
    }
  };
  const convert = () => {
    if (!fbx || !choices) return;
    setVrm(null);
    setJob({ phase: 'idle' });
    backend.convert(request(fbx, choices, outDir, engine)).catch((e: unknown) =>
      setJob({
        phase: 'failed',
        labels: [],
        states: [],
        seconds: [],
        log: [],
        started: Date.now(),
        failure: { index: 0, message: String(e), logTail: [], jobDir: '' },
      }),
    );
  };

  const elapsed = job.phase !== 'idle' ? (now - job.started) / 1000 : 0;
  const failedLabel = job.phase === 'failed' && job.failure ? job.labels[job.failure.index] : undefined;
  const advice = job.phase === 'failed' && job.failure ? explain(job.failure.message, failedLabel) : null;

  return (
    <div className="app">
      <header className="topbar">
        <img className="topbar-mark" src={`${import.meta.env.BASE_URL}icon.svg`} alt="" />
        <div className="topbar-text">
          <h1 className="topbar-title">Daz &amp; Character Creator → VRM</h1>
          <span className="muted small">Turn your character into an avatar for latentPresence and other VRM apps</span>
        </div>
        {backend.kind === 'browser' && (
          <a className="btn btn-ghost btn-small topbar-link" href={RELEASES} target="_blank" rel="noopener noreferrer">
            Windows app
          </a>
        )}
      </header>

      <main className="layout">
        <aside className="steps">
          {useBlender && <BlenderCard backend={backend} status={blender} onStatus={setBlender} />}
          <CharacterCard step={useBlender ? 2 : 1} backend={backend} fbx={fbx} error={fbxError} disabled={running} onPicked={picked} />
          {fbx?.supported && choices && (
            <OptionsCard
              step={useBlender ? 3 : 2}
              backend={backend}
              engine={engine}
              onEngine={chooseEngine}
              fbx={fbx}
              choices={choices}
              outDir={outDir}
              disabled={running}
              onChoices={setChoices}
              onOutDir={setOutDir}
            />
          )}

          {job.phase !== 'idle' && (
            <section className="card" ref={progress}>
              <h3 className="card-title">
                Progress
                {job.phase === 'running' && <span className="card-aside">{formatSeconds(elapsed)}</span>}
                {job.phase === 'done' && <span className="card-aside">{formatSeconds(job.seconds.reduce((a, b) => a + b, 0))}</span>}
              </h3>
              <ol className="stages">
                {job.labels.map((label, i) => {
                  const state = job.states[i] ?? WAITING;
                  return (
                  <li key={label} className={`stage stage-${state}`}>
                    <span className="stage-dot">
                      {job.states[i] === 'running' ? <span className="spinner" /> : job.states[i] === 'done' ? '✓' : job.states[i] === 'failed' ? '!' : ''}
                    </span>
                    <span className="stage-label">{label}</span>
                    {job.states[i] === 'done' && <span className="muted small">{formatSeconds(job.seconds[i] ?? 0)}</span>}
                  </li>
                  );
                })}
              </ol>
              {job.phase === 'running' && <p className="muted small">A Daz character takes {useBlender ? '1–3 minutes' : 'up to a minute or two'}.</p>}
              {job.phase === 'cancelled' && <p className="note note-tip">Cancelled.</p>}
              {advice && job.phase === 'failed' && (
                <div className="note note-stop">
                  <strong>{advice.title}</strong>
                  <p>{advice.body}</p>
                  <code className="block small">{job.failure?.message}</code>
                </div>
              )}
              {/* always present, so the card does not grow under the sticky bar after it scrolls into view */}
              {(
                <>
                  <button type="button" className="btn btn-ghost btn-small" disabled={job.log.length === 0} onClick={() => setShowLog(!showLog)}>
                    {showLog ? 'Hide details' : 'Show details'}
                  </button>
                  {showLog && (
                    <div className="log">
                      {(job.phase === 'failed' && job.failure?.logTail.length ? job.failure.logTail : job.log).map((l, i) => (
                        <div key={i}>{l}</div>
                      ))}
                      {/* a new callback each render: keeps the newest line in view */}
                      <div ref={(el) => el?.scrollIntoView({ block: 'end' })} />
                    </div>
                  )}
                </>
              )}
            </section>
          )}
          <div className="convert">
            {running ? (
              <button type="button" className="btn btn-danger btn-wide" onClick={() => void backend.cancel()}>
                Cancel
              </button>
            ) : (
              <button type="button" className="btn btn-primary btn-wide" disabled={!canConvert} onClick={convert}>
                {job.phase === 'done' ? 'Convert again' : 'Convert to VRM'}
              </button>
            )}
            {!running && !canConvert && (
              <p className="muted small center">
                {!ready ? 'Set up Blender first.' : !fbx ? 'Choose a character first.' : ''}
              </p>
            )}
          </div>

        </aside>

        <section className="showcase">
          {job.phase === 'done' && vrm && job.output ? (
            <>
              <div className="result">
                <div className="result-text">
                  <strong>Done.</strong>
                  <span className="muted">
                    {formatBytes(job.bytes ?? 0)}
                    {job.summary?.expressions ? ` · ${job.summary.expressions} expressions` : ''}
                    {job.summary?.springs ? ` · ${job.summary.springs} swinging strands` : ''}
                  </span>
                  <span className="path" title={job.output}>
                    {job.output}
                  </span>
                </div>
                <button type="button" className="btn" onClick={() => void backend.reveal(job.output ?? '')}>
                  {backend.saveLabel}
                </button>
              </div>
              <Viewer data={vrm} />
            </>
          ) : (
            <ExportGuide />
          )}
        </section>
      </main>
    </div>
  );
}
