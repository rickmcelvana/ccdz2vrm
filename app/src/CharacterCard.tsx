// The export to convert -- dropped on the window or picked -- and what it is.

import { useState, type DragEvent } from 'react';
import type { Backend } from './backend';
import { formatBytes } from './options';
import type { FbxInfo } from './types';

type Props = {
  step: number;
  backend: Backend;
  fbx: FbxInfo | null;
  error: string | null;
  disabled: boolean;
  onPicked: (f: FbxInfo | null, error?: string) => void;
};

export function CharacterCard({ step, backend, fbx, error, disabled, onPicked }: Props) {
  const [hover, setHover] = useState(false);

  const pick = async () => {
    try {
      const f = await backend.pickFbx();
      if (f) onPicked(f);
    } catch (e) {
      onPicked(null, String(e));
    }
  };

  // In the app, Tauri hands dropped paths to App (onFileDrop); this only drives the highlight.
  const drag = (e: DragEvent, over: boolean) => {
    e.preventDefault();
    setHover(over);
  };

  return (
    <section className="card">
      <h3 className="card-title">
        <span className={`step ${fbx?.supported ? 'step-done' : ''}`}>{fbx?.supported ? '✓' : step}</span> Character
      </h3>
      {fbx ? (
        <div className="fbx">
          <div className="fbx-head">
            <span className={`badge badge-${fbx.kind}`}>{fbx.kind === 'cc' ? 'CC' : fbx.kind === 'daz' ? 'Daz' : '?'}</span>
            <div className="fbx-name">
              <strong title={fbx.path}>{fbx.fileName}</strong>
              <span className="muted">
                {fbx.family} · {formatBytes(fbx.sizeBytes)}
              </span>
            </div>
            <button type="button" className="btn btn-ghost btn-small" disabled={disabled} onClick={() => void pick()}>
              Change
            </button>
          </div>
          <dl className="facts">
            <dt>Face</dt>
            <dd>{fbx.face}</dd>
          </dl>
          {fbx.notes.map((n) => (
            <p key={n} className={`note ${fbx.supported ? 'note-tip' : 'note-stop'}`}>
              {n}
            </p>
          ))}
        </div>
      ) : (
        <button
          type="button"
          className={`drop ${hover ? 'drop-over' : ''}`}
          disabled={disabled}
          onClick={() => void pick()}
          onDragOver={(e) => drag(e, true)}
          onDragLeave={(e) => drag(e, false)}
          onDrop={(e) => drag(e, false)}
        >
          <span className="drop-title">Drop an .fbx here</span>
          <span className="muted">or click to choose one · Daz Studio (Genesis 3, 8, 8.1) or Character Creator 3+</span>
          {backend.kind === 'browser' && <span className="muted small">Converted on this computer: the file is not uploaded.</span>}
        </button>
      )}
      {error && <p className="note note-stop">{error}</p>}
    </section>
  );
}
