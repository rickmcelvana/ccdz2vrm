// How the VRM should come out, and (in the desktop app) which converter makes it.

import type { Backend } from './backend';
import { cleanName, ENGINES, outputFile, QUALITIES, twistAvailable, type Choices } from './options';
import type { Engine, FbxInfo } from './types';

type Props = {
  step: number;
  backend: Backend;
  engine: Engine;
  onEngine: (e: Engine) => void;
  fbx: FbxInfo;
  choices: Choices;
  outDir: string;
  disabled: boolean;
  onChoices: (c: Choices) => void;
  onOutDir: (d: string) => void;
};

export function OptionsCard({ step, backend, engine, onEngine, fbx, choices, outDir, disabled, onChoices, onOutDir }: Props) {
  const set = (patch: Partial<Choices>) => onChoices({ ...choices, ...patch });
  const daz = twistAvailable(fbx);

  return (
    <section className="card">
      <h3 className="card-title">
        <span className="step">{step}</span> Options
      </h3>

      <div className="field">
        <span className="field-label">Quality</span>
        <div className="quality">
          {QUALITIES.map((q) => (
            <button
              key={q.id}
              type="button"
              disabled={disabled}
              className={`quality-option ${choices.quality === q.id ? 'quality-on' : ''}`}
              onClick={() => set({ quality: q.id })}
            >
              <span className="quality-label">{q.label}</span>
              <span className="quality-size">{q.size}</span>
            </button>
          ))}
        </div>
        <p className="muted small">{QUALITIES.find((q) => q.id === choices.quality)?.blurb}</p>
      </div>

      <label className="field">
        <span className="field-label">Name</span>
        <input
          className="input"
          value={choices.name}
          disabled={disabled}
          spellCheck={false}
          onChange={(e) => set({ name: cleanName(e.target.value) })}
        />
      </label>

      <label className="check">
        <input type="checkbox" checked={choices.springBones} disabled={disabled} onChange={(e) => set({ springBones: e.target.checked })} />
        <span>
          Swinging hair and clothing
          <span className="muted small block">For hair and clothes that come with their own bones (ponytails, fringes, skirts).</span>
        </span>
      </label>

      {daz && (
        <label className="check">
          <input type="checkbox" checked={choices.twistSplit} disabled={disabled} onChange={(e) => set({ twistSplit: e.target.checked })} />
          <span>
            Better elbows and shoulders when the arm twists
            <span className="muted small block">
              Uses VRM node constraints. three-vrm and UniVRM run them; in an app that does not, the elbows stay stiff.
            </span>
          </span>
        </label>
      )}

      {backend.engines.length > 1 && (
        <div className="field">
          <span className="field-label">Converter</span>
          <div className="quality">
            {ENGINES.filter((e) => backend.engines.includes(e.id)).map((e) => (
              <button
                key={e.id}
                type="button"
                disabled={disabled}
                className={`quality-option ${engine === e.id ? 'quality-on' : ''}`}
                onClick={() => onEngine(e.id)}
              >
                <span className="quality-label">{e.label}</span>
              </button>
            ))}
          </div>
          <p className="muted small">{ENGINES.find((e) => e.id === engine)?.blurb}</p>
        </div>
      )}

      {outDir === '' ? (
        <p className="muted small">
          Saved as <code>{outputFile(choices)}</code> when you download it.
        </p>
      ) : (
      <div className="field">
        <span className="field-label">Save to</span>
        <div className="row row-nowrap">
          <span className="path path-grow" title={outDir}>
            {outDir}
          </span>
          <button
            type="button"
            className="btn btn-small"
            disabled={disabled}
            onClick={() => void backend.pickOutDir().then((d) => d && onOutDir(d))}
          >
            Change…
          </button>
        </div>
        <p className="muted small">
          As <code>{outputFile(choices)}</code>, replacing a file of that name.
        </p>
      </div>
      )}
    </section>
  );
}
