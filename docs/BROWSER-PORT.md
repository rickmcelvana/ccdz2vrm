# Browser port: plan

Goal: the converter runs **in the browser, client-side**, as a static website and inside the
desktop app, with **no Blender**. The Blender pipeline (`src/blender/`) stays in the repo as the
**reference**: every stage of the port is accepted only when its output matches Blender's on the
same FBX, measured, within the tolerances below.

Written 2026-10-22. Facts marked **[V]** were measured here that day; **[R]** are read from a
project page and must be confirmed in Phase 0.

---

## 1. What has to be replaced

The pipeline is ~3,100 lines of Python. Almost none of it needs Blender for anything but
plumbing: it is linear-blend skinning, shape-key arithmetic, image work and glTF JSON. The hard
parts are the FBX importer and three mesh operations.

| Blender does today | Where | Browser replacement |
|---|---|---|
| FBX import (bones, skin weights, shape keys, embedded textures, materials) | `common.import_fbx_clean` | **ufbx** 0.23.1 (single C file, MIT or Unlicense) compiled to WASM with Zig behind a small C shim that hands flat arrays to JS. Chosen in Phase 0 **[V]**: identical to Blender's import on all six test exports; three.js `FBXLoader` died or dropped meshes on the Daz ones (ENVIRONMENT §30). |
| Import traps: 0.01 scale, animation take, extra armatures, skeleton copies (`X.00N`), bone-less props on empties, Metallic 1.0, Phong→roughness 0, bump read as normal | `import_fbx_clean`, `height_to_normal` | Plain TS over the parsed scene. Several traps are Blender-importer artefacts and may not exist with ufbx (leaf-bone tails, Metallic 1.0); each is re-checked, not assumed. |
| Pose → rest with every shape key exact (A-pose → T-pose) | `apply_pose_as_rest`, `tpose_arms`, `aim_bone` | LBS in TS: skin the base and each key with the posed matrices, write back, re-bind. Pure math (already how the Python does it, one key at a time). |
| Daz face without FACS: pose face bones, freeze as shape keys | `adapt_daz` §4 | FK pose evaluation + LBS capture. The rotation tables (`op_rotate`, axes in Blender's bone frames) must be re-expressed in the parser's bone frames: measured in Phase 0. |
| FACS / CC ARKit renames and mixes, visemes, noise drop, side check | `adapt_daz` §2b/4b, `adapt_cc` §4–5 | Typed-array arithmetic, ported line for line. |
| CC jaw baked into teeth and tongue | `adapt_cc` §6 | LBS capture, as above. |
| Humanoid map, expressions, presets, prune unused keys, lookAt, first person, meta | `vrm_export` §1–5 | Our own tables (`BONE_TABLES`, `PRESETS`) + a VRM writer. The add-on's ARKit → custom-expression step is a fixed 52-entry list. |
| ≤4 weights, normalised | `vrm_export` §6 | Trivial. |
| Material rules: OPAQUE / MASK / soft-strand core + BLEND fringe | `vrm_export` §7–7a | Texture alpha statistics on decoded pixels; the fringe is a second primitive sharing the vertex data. |
| Texture budget, JPEG/PNG re-encode, palette PNG | `vrm_export` §7b, `glb_web` | `createImageBitmap` + `OffscreenCanvas` (resize, `convertToBlob` JPEG) in a worker; palette PNG from `glb_web._quantize` (already numpy-only, ports directly). TIFF/TGA embedded by some Daz products: `utif2` (MIT) + a small TGA reader. |
| Hair-card reduction without crumpling ribbons | `simplify_cards.py` (bmesh) | **The biggest single port.** Collapse decimation spikes ribbons (measured, ENVIRONMENT §18), so meshoptimizer's simplifier is tried first with attribute weights and judged by the harness; if it spikes, port the rung-dissolve algorithm onto a half-edge structure. Keyed-mesh decimation (strand brows) restores keys from the nearest source vertex, as now. |
| glTF/VRM export, sparse morphs, dedupe | `export_scene.vrm`, `glb_dedupe` | **glTF-Transform** 4.5 (MIT) to build and write the document; `VRMC_vrm` / `VRMC_springBone` / `VRMC_node_constraint` written as JSON extensions. Our VRMs use plain glTF PBR (no MToon) **[V]**, which keeps the writer small. |
| Web tier (skins compacted, uint8 joints/weights, uint16 UVs/indices, sparse morphs) | `glb_web.py` | Already pure glTF arithmetic: direct port. |
| Twist split, spring bones | `twist_split.py`, `spring_bones.py` | Already mostly post-export glTF math: direct port. One simplification: our writer chooses the node frames, so `_realign` and the inverse-bind rewrite disappear. |
| Validation | `vrm_check.py`, `tools/validate` | Unchanged: they judge files, whoever wrote them. |

Inputs measured on the test exports **[V]**: every one embeds its textures in the FBX
(Alice G8.1: 16 images, Ira CC: 73, a Genesis 3: 24), so a single dropped file is enough. An
export without embedded textures needs its texture folder too: the page then asks for the folder
(directory drop / picker) and resolves paths by file name.

**Language.** The core is TypeScript in a Web Worker, plus ufbx as WASM. The page already talks
to the converter through `Backend` (`app/src/backend.ts`), so the browser converter is a third
implementation of it beside `tauri` and `fake`; the desktop app can use it too and keep Blender
as an optional "reference mode". (A Rust core compiled both natively and to WASM was considered:
faster, and the shell is Rust, but C-in-WASM builds and slower iteration cost more than the
speed is worth for 1–3-minute jobs. Revisit if Phase 0 measures the TS core as too slow.)

---

## 2. The reference harness

Built before any converter code, in Phase 0, and run on every change after that.

### Three levels of comparison

**Level 1: the contract** (adapter output: what the finisher receives). A new
`src/blender/dump_contract.py` writes Blender's `.blend` contract as `contract.json` + `.bin`:

- bones: name, parent, world head and rest matrix;
- meshes: vertex positions, per-vertex weights (bone → weight), every shape key's deltas,
  per-face material, UVs;
- materials: base / normal / opacity image hashes and sizes, alpha mode decided, roughness,
  metallic.

The TS adapter dumps the same format. `tools/compare/contract.mjs` compares them. FBX importers
split vertices at UV seams differently, so vertices are **matched by position** (k-d tree) per
mesh, not by index. Reported per mesh: unmatched vertices, position error (max / p99), weight
agreement (same dominant bone; L1 of the weight vectors), shape-key delta error at matched
vertices; per bone: head error and axis angle.

**Level 2: the VRM file.** `tools/compare/vrm.mjs` on the two `.vrm`s: same humanoid bone set;
same expression names and the same (mesh, key) binds per preset; lookAt offset; material alpha
mode per material; spring count, joint names, collider positions; file size; plus `vrm_check.py`
and `tools/validate` (Khronos validator + three-vrm load) on the new file.

**Level 3: behaviour in three-vrm** (headless Chromium, as `tools/validate` already does). Load
both VRMs, apply the same script: each preset expression at 1, arms raised, a 90° forearm twist,
a head turn, a 2 s head shake for springs. Read CPU-skinned vertex positions
(`SkinnedMesh.applyBoneTransform`) and compare them by matched vertex; render the same camera
shots of both and write a side-by-side contact sheet for a person to look at, with a per-shot
image difference.

### Tolerances (port accepted when all hold)

| Measure | Tolerance |
|---|---|
| Rest vertex position (L1) | ≤ 0.1 mm max |
| T-posed vertex position (L1) | ≤ 0.5 mm p99 |
| Shape-key delta at matched vertex (L1) | ≤ 0.1 mm or 1 % of that key's largest delta |
| Bone head (L1) | ≤ 0.1 mm |
| Dominant skin bone agreement (L1) | ≥ 99.5 % of vertices |
| Humanoid set, expression names, preset binds (L2) | identical |
| Material alpha modes (L2) | identical |
| File size (L2) | within ±15 % per tier |
| Posed / expression vertex positions in three-vrm (L3) | ≤ 1 mm p99 |
| Spring sag / swing / settle (L3, `spring_test.js`) | within 20 % |
| Contact sheet (L3) | looked at; no visible difference |
| Validators | pass, as now |

### Test set (all local, never committed)

| Export | Exercises |
|---|---|
| Alice G8.1, FACS morphs, store hair with bones | FACS mix, strand brows, springs, chrome fix |
| A Genesis 8 without FACS | bone-posed face |
| Genesis 3 (`D:\_EXPORTS\DAZ\gen-3`) | G3 family, quad-grid hair |
| Kamara G8.1 (strand brows, 177k verts) | keyed decimation, memory |
| Ira CC3+, ARKit profile | renames, jaw bake |
| A CC Traditional-profile export | legacy mix, opacity rewiring |
| A Genesis 1/2 export | refusal with the right advice |

Golden outputs come from the Blender pipeline at a recorded commit; they and the harness reports
stay in `out/` (gitignored) because they are made from licensed content. Only the harness code and
the tolerance table are committed.

---

## 3. Phases

Each phase ends with the harness green for its level on the whole test set, a commit, and an
ENVIRONMENT.md section for anything measured.

0. ✅ **Harness and parser spike** (2026-10-22, ENVIRONMENT §30): ufbx reproduces Blender's
   import exactly on all six test exports (bones, vertices, 1,004 FACS morphs, weights,
   images; bone axes at 0°); FBXLoader dies on the FACS export and drops a 363k-vert hair.
   **Parser: ufbx.** Tools: `src/blender/dump_contract.py`, `tools/compare/contract.mjs`,
   `tools/fbx-spike/`. Original plan for this phase:
   **Harness and parser spike.** Write `dump_contract.py` (raw-import and adapter modes) and
   `tools/compare/`. Build ufbx to WASM (Emscripten) with a shim; dump the raw import of every
   test file and compare to Blender's raw import (Level 1, before any adapter logic). Measure parse
   time and peak memory on the largest file. Same for `FBXLoader`. **Decide the parser**, and
   record how bone frames differ from Blender's (that sets how the face-pose tables are ported).
1. ✅ **Import cleanup** (2026-10-22, ENVIRONMENT §31): `app/src/convert/cleanup.ts` equals
   Blender's cleaned import on all six exports, exact names. Original plan:
   **Import cleanup.** Port `import_fbx_clean`'s traps that still apply, the material rules
   (metallic, roughness floor, height → normal, opacity wiring). Level 1 on raw contracts.
2. ✅ **CC adapter** (2026-10-23, ENVIRONMENT §32): `adaptCc.ts` equals Blender's to 0.04 mm on
   both CC exports. Original plan:
   **CC adapter** (smallest): renames, Traditional mix, visemes, T-pose, jaw bake. Level 1 on Ira
   + the Traditional export.
3. ✅ **Finisher and VRM writer** (2026-10-23, ENVIRONMENT §33): `finish.ts` VRMs match Blender's
   on both CC exports (geometry ≤ 0.04 mm as rendered, all expressions, materials, textures),
   pass the validators, and are 30 % smaller. The writer is our own (`glb.ts`), not glTF-Transform:
   VRMC_vrm references nodes and meshes by index, simpler to own. Original plan:
   **Finisher and VRM writer**: humanoid, expressions, prune, lookAt, first person, ≤4 weights,
   materials and soft strands, texture budget. Level 2 + 3 on the CC exports (Desktop tier).
4. ✅ **Daz adapter** (2026-10-23, ENVIRONMENT §34): `adaptDaz.ts` equals Blender's on Alice G8.1
   (FACS), G8 and G3 (bone-posed); the whole chain matches Blender's VRMs on all five exports
   except one documented normal residual (G8's top at the armpits). Original plan:
   **Daz adapter**: family check, overlays, FACS mix, bone-posed face, T-pose, noise drop.
   Level 1–3 on Alice, G8, G3.
5. ✅ **Web tier** (2026-10-23, ENVIRONMENT §35): web VRMs match Blender's on all five exports
   (G8's §34 normal residual aside); hair reduced by meshoptimizer in measured rounds, closer to the
   original surface than Blender's; no rung-dissolve port needed. Original plan:
   **Web tier**: `glb_web` port, hair-card reduction (meshoptimizer first, rung-dissolve port if
   it spikes), keyed decimation. Level 2 sizes + Level 3 visuals on every file.
6. ✅ **Max tier** (2026-10-23, ENVIRONMENT §36): springs, constraints and geometry = Blender's; the twist split now runs after the export T-pose on both sides, so the rest mesh = the plain export. Original plan:
   **Max tier**: spring bones, twist split. Level 3 spring and twist measures.
7. ✅ **Ship it** (2026-10-23, ENVIRONMENT §37): `convert.ts` in a module worker; the static site
   (`dist/`) converts in the browser; the desktop app converts built-in by default with Blender as
   reference mode; the shipped path from each FBX = Blender's VRMs on 5 exports × 3 tiers (G8's
   §34 residual aside). Original plan:
   **Ship it**: the page's third `Backend` (worker + progress events), a static site build,
   the desktop app switched to the browser converter with Blender kept as "reference mode", and
   README/CLAUDE.md updated.

Phase 0 is the decision point. If neither parser gets the raw contract within tolerance, or a
200 MB export does not fit in a browser tab, this plan changes before any porting starts.

## 4. Risks

- **Bone frames.** Blender's importer re-expresses FBX bone orientations; the adapters' face-pose
  rotations are written in Blender's frames. Measured in Phase 0, not guessed.
- **What Blender silently fixed.** Some cleanup only exists because of Blender's importer, and
  ufbx may have different quirks of its own (pre/post-rotation, geometric transforms, in-between
  blend shapes). Level 1 on raw imports catches both kinds.
- **Hair cards.** The one algorithm without a library equivalent; Phase 5 may need the full port.
  (Resolved in Phase 5: meshoptimizer plus surface-measured locking, §35.)
- **Memory.** A 200 MB FBX, its parse, and dense morphs share one tab (WASM 4 GB address space).
  Measured in Phase 0. Phones are out of scope.
- **Image formats.** Anything the browser cannot decode needs a decoder; Phase 1 lists what the
  test files actually embed.
- **Licence.** The port contains no `bpy` code, so it can take latentPresence's Apache-2.0 even
  if the Python reference keeps a GPL-compatible licence (docs/LICENSING.md).
