// Step 1: the person's Blender. Collapses to one line once it is ready.

import { useState } from 'react';
import type { Backend } from './backend';
import { blenderReady, type BlenderStatus } from './types';

type Props = {
  backend: Backend;
  status: BlenderStatus | null;
  onStatus: (s: BlenderStatus) => void;
};

export function BlenderCard({ backend, status, onStatus }: Props) {
  const [busy, setBusy] = useState<null | 'install' | 'pick'>(null);
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);

  const run = async (kind: 'install' | 'pick', fn: () => Promise<BlenderStatus | null>) => {
    setBusy(kind);
    setError(null);
    try {
      const s = await fn();
      if (s) onStatus(s);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  if (!status) {
    return (
      <section className="card">
        <h3 className="card-title">
          <span className="step">1</span> Blender
        </h3>
        <p className="muted">
          <span className="spinner" /> Looking for Blender…
        </p>
      </section>
    );
  }

  if (blenderReady(status)) {
    return (
      <section className="card card-compact">
        <h3 className="card-title">
          <span className="step step-done">✓</span> Blender {status.version}
          <span className="card-aside">VRM add-on {status.vrmAddon}</span>
        </h3>
        <p className="path" title={status.path ?? ''}>
          {status.path}
        </p>
        {status.found.length > 1 && (
          <select className="select" value={status.path ?? ''} onChange={(e) => void run('pick', () => backend.setBlender(e.target.value))}>
            {status.found.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
      </section>
    );
  }

  const needsAddon = !!status.path && status.versionOk && !status.vrmAddon;
  return (
    <section className="card card-attention">
      <h3 className="card-title">
        <span className="step">1</span> Blender
      </h3>
      <p>{status.problem}</p>
      {needsAddon ? (
        <>
          <p className="muted">
            Found Blender {status.version} at <span className="path-inline">{status.path}</span>. The conversion runs in it and needs
            its free VRM add-on.
          </p>
          <label className="check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>
              Download “VRM format” (MIT licence) from extensions.blender.org and enable it in this Blender.
            </span>
          </label>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!consent || busy !== null}
              onClick={() => void run('install', () => backend.installVrmAddon())}
            >
              {busy === 'install' ? (
                <>
                  <span className="spinner" /> Installing…
                </>
              ) : (
                'Install the VRM add-on'
              )}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void backend.openLink('vrm-addon')}>
              About the add-on
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">
            The conversion runs inside Blender 4.2 or newer (free). Install it, or show the app where it is.
          </p>
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={() => void backend.openLink('blender')}>
              Get Blender
            </button>
            <button type="button" className="btn" disabled={busy !== null} onClick={() => void run('pick', () => backend.pickBlender())}>
              Find blender.exe…
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => void run('pick', () => backend.blenderStatus())}>
              Check again
            </button>
          </div>
        </>
      )}
      {error && <pre className="error-text">{error}</pre>}
    </section>
  );
}
