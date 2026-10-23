# Licensing

The converter turns *your* Daz 3D / Character Creator character into a VRM, on your own
machine. Two separate licence questions follow from that: what the **tools** it uses allow,
and what the **content** you feed it allows.

## Tools

| Component | Licence | Role |
|---|---|---|
| **Blender** | GPL-2.0-or-later | Runs the pipeline (`blender --background --python …`). Invoked as a separate program; not bundled. |
| **Blender VRM Add-on** | MIT | VRM 1.0 export (installed 4.7.1). |
| **numpy**, **Pillow** | BSD / MIT-CMU | Web tier post-pass (`glb_web.py`). |
| **three.js**, **@pixiv/three-vrm** | MIT | Viewer and runtime check (`tools/viewer`). |
| **Tauri 2** + `tauri-plugin-dialog` / `-opener` | MIT / Apache-2.0 | The desktop shell. |
| **React**, **Vite**, **Vitest**, **oxlint** / **TypeScript** | MIT / Apache-2.0 | The page and its build. |
| **memchr** (crate) | MIT / Unlicense | FBX byte scan (`fbx.rs`). |
| **ufbx** 0.23.1 | MIT or Unlicense | FBX parser for the browser port (`tools/fbx-spike`, fetched at build time). |
| **Zig** 0.17.0 (build tool only) | MIT | Compiles ufbx to WASM; nothing of it ships. |
| **jpeg-js** / **pngjs** (npm) | BSD-3-Clause / MIT | Image decoding in the Node port harness only (`tools/port`); the browser decodes with `createImageBitmap`. Dev dependencies. |
| **Khronos glTF validator** (`gltf-validator`, npm) | Apache-2.0 | `tools/validate`, dev dependency. |
| **Playwright** (npm) + Chromium | Apache-2.0 / BSD | Headless three-vrm check and the port harness, dev dependency. |

The app (`app/`, `src-tauri/`) contains no Blender code: it starts the user's own Blender as a
separate program, the way the CLI does. The scripts in `src/blender/` and `scripts/` import
`bpy`. The Blender Foundation's position is that scripts using its Python API are covered by
Blender's GPL when distributed, and the app's installer carries them (as `pipeline/`); pick this
repo's licence with that in mind (see the open question in `CLAUDE.md`).

Audit before adding a component: is the *weights/data* licence separate from the *code* licence?
Does it trace to SMPL / SMPL-X / MANO / FLAME? (reject). Add it to the table above **in the same
commit** as the code that uses it.

## Content: Daz and Character Creator

The adapters **process the user's own licensed content locally**. They add no code dependency on
either vendor. But their *content* licences govern the output:

| Source | Content licence summary | Consequence |
|---|---|---|
| Daz 3D (Genesis figures, store assets) | Standard licence covers renders; real-time/interactive use of the 3D asset needs Daz's **Interactive License** per product **[R — verify current EULA]** | Personal local use is fine; a Daz-derived VRM must **never** be committed, shipped as a default avatar, or redistributed |
| Reallusion Character Creator 3 | Export to other engines is governed by the CC EULA / Pipeline terms **[R — read `End User License Agreement.txt` in the install]** | Same rule: no CC-derived asset ships |

This is also why conversion should stay on the user's machine: a hosted service that received
people's Daz/CC exports would be redistributing licensed content to itself.

Tools we may use for those adapters: **Diffeomorphic DAZ Importer** (GPL — a separate Blender
add-on; using it does not make our code or outputs GPL, but we must not vendor it).
