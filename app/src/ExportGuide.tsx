// What to do in Daz Studio or Character Creator before converting (README.md, in short).

import { useState } from 'react';

const ON = 'segmented-on';

export function ExportGuide() {
  const [tab, setTab] = useState<'daz' | 'cc'>('daz');
  const dazOn = tab === 'daz' ? ON : '';
  const ccOn = tab === 'cc' ? ON : '';
  return (
    <div className="guide">
      <h2>Exporting your character</h2>
      <p className="muted">
        Export once from Daz Studio or Character Creator, then drop the <code>.fbx</code> on the left. Everything stays on this
        computer.
      </p>
      <div className="segmented">
        <button type="button" className={`segmented-item ${dazOn}`} onClick={() => setTab('daz')}>
          Daz Studio
        </button>
        <button type="button" className={`segmented-item ${ccOn}`} onClick={() => setTab('cc')}>
          Character Creator
        </button>
      </div>
      {tab === 'daz' ? (
        <ol className="guide-steps">
          <li>
            Use a <strong>Genesis 3, 8 or 8.1</strong> figure. Genesis 1 and 2 have no face expressions to convert.
          </li>
          <li>
            <strong>File → Export</strong>, choose <strong>FBX</strong>.
          </li>
          <li>
            Keep the figure’s <strong>face rig</strong> (its face bones) in the export.
          </li>
          <li>
            <strong>Genesis 8.1, for the best face:</strong> tick <em>Morphs</em>, open <strong>Edit Morph Export Rules</strong>, and
            add a rule matching <code>facs</code> set to <strong>Export</strong>. Ticking Morphs alone exports none. With it, the
            avatar gets all 52 face-tracking shapes from Daz’s own sculpts; without it, 26 shapes posed from the face bones.
          </li>
          <li>Hair and clothes come along. Hair that has its own bones (ponytails, fringes) can swing in the VRM.</li>
        </ol>
      ) : (
        <ol className="guide-steps">
          <li>
            <strong>File → Export → FBX (Clothed Character)</strong>.
          </li>
          <li>
            Tick <strong>Embed Textures</strong>. CC still writes a <code>textures</code> folder beside the file; the converter
            needs only the <code>.Fbx</code>.
          </li>
          <li>
            For the best face, give the character the <strong>ARKit expression profile</strong> (CC3+ facial profile). The older
            Traditional profile converts too, with 33 of the 52 face-tracking shapes.
          </li>
          <li>Keep the teeth and tongue: the jaw is baked into them so the mouth opens properly.</li>
        </ol>
      )}
      <p className="muted small">
        Your Daz and Character Creator content keeps its own licence. Before you share or sell a converted avatar, check what
        that licence allows.
      </p>
    </div>
  );
}
