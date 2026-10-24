# ccdz2vrm — session loader

Daz 3D (Genesis 3/8/8.1) and Character Creator 3+ FBX exports → VRM 1.0 avatars, for
[latentPresence](../latentPresence) and anyone else who loads VRM 1.0. Split out of
`G:\_dev\image-to-vrm` on 2026-10-22 (copied, not moved; that repo still has the history of how
every rule here was found).

**Architecture: adapter → finisher**, twice: the built-in converter (TypeScript + WASM,
`app/src/convert/`, runs in the page -- the static site and the desktop app's default) and the
Blender reference pipeline it was ported from and is judged against (`src/blender/`, the desktop
app's "Blender (reference)" converter).

```
 adapt_daz.py / adapt_cc.py              vrm_export.py                  glb_web.py
 FBX -> armature + skinned meshes   ──▶  humanoid map · expressions ·  ──▶  web tier (3-8 MB)
 + ARKit-52 / viseme shape keys          lookAt · limit-4 · materials ·
 (.blend)                                twist split · spring bones
```

The finisher only assumes: one armature mappable to VRM humanoid bones, meshes skinned to it,
face shape keys named **ARKit-52** and/or **Meta visemes**. Getting there is each adapter's job.

## Status (update this block every session)

| Piece | State |
|---|---|
| Daz G3 / G8 / G8.1 → VRM, bone-posed face; G8.1 FACS morphs → ARKit 52 | ✅ verified in three-vrm (ENVIRONMENT §14, §23, §25–26) |
| CC3+ → VRM, ARKit 52 or Traditional profile | ✅ (§15, §24) |
| Max tier: `--twist-split`, `--spring-bones`, `--max-texture 2048` | ✅ (§25, §29) |
| Web tier + `vrm_check.py` / `check.html` validation | ✅ (§18) |
| Static site + desktop app with the built-in converter | ✅ 2026-10-23: `dist/` converts in the browser (worker, progress, cancel, download); the desktop app converts built-in by default, Blender as reference mode (ENVIRONMENT §37) |
| Desktop app (Tauri 2 + React) driving the user's Blender (now "reference mode") | ✅ 2026-10-22: finds Blender + VRM add-on (offers to install it), reads the FBX in <1 s (family, face source, advice), Web/Desktop/Max, progress + Cancel, three-vrm preview; runner converts Alice end to end (`converts_a_real_export`) |
| Browser-only (WASM) port | 📋 planned 2026-10-22 ([docs/BROWSER-PORT.md](docs/BROWSER-PORT.md)): TS core + ufbx WASM, accepted stage by stage against the Blender pipeline; Phase 0 ✅ (ufbx WASM = Blender's import, exact, on 6 exports; ENVIRONMENT §30), Phase 1 ✅ (TS import cleanup = Blender's, exact, 6 exports; §31), Phase 2 ✅ (TS CC adapter = Blender's within 0.04 mm, 2 exports; §32), Phase 3 ✅ (TS finisher: CC VRMs = Blender's as rendered, validators pass, 30 % smaller; §33), Phase 4 ✅ (TS Daz adapter = Blender's on G8.1 FACS / G8 / G3; whole chain = Blender's VRMs on 5 exports, one normal residual; §34), Phase 5 ✅ (TS web tier = Blender's web VRMs on 5 exports, hair reduction closer to the original surface; one vertex array per material fixed hair draw order; §35), Phase 6 ✅ (TS max tier = Blender's max VRMs; twist split moved after the T-pose in vrm_export.py too, rest mesh = plain export; §36), Phase 7 ✅ (shipped: worker + site + desktop default; the shipped path from each FBX = Blender's VRMs on 5 exports × 3 tiers; §37) |
| Releases | Windows app: `v*` tag → draft GitHub release (`.github/workflows/release.yml`, docs/release.md); website `ccdz2vrm.latentpresence.com`: checkout + `pnpm build` on Rick's server behind Caddy (docs/deploy.md); `gate` workflow on every push |
| Repo licence | ✅ GPL-3.0-or-later (`LICENSE`, 2026-10-23), compatible with Blender's GPL-2.0-or-later; every dependency GPLv3-compatible (docs/LICENSING.md) |

## Commands

```powershell
pnpm install
pnpm dev          # the page in a browser, converting; ?fake plays one back (fakeBackend.ts: ?engine=blender, ?blender=missing|noaddon|old, ?fail=1)
pnpm build        # the static site -> dist\ (also the desktop app's page)
pnpm app          # the real app (tauri dev)
pnpm app:build    # NSIS installer -> src-tauri\target\release\bundle\nsis\
pnpm gate         # tsc, oxlint, vitest (theme coverage), vite build, cargo fmt/clippy/test
# browser port harness (hard time limits throughout; results in out/spike, gitignored):
#   sh tools/port/run_adapt.sh cc "ira|G:/_exports/CharacterCreator/Ira_01-cc3.Fbx"   (Phase 2: TS CC adapter vs Blender's)
#   sh tools/port/run_finish.sh cc "ira|..."   (Phase 3: TS VRM vs Blender's VRM, tools/compare/vrm.ts)
#   sh tools/port/make_web_refs.sh "ira|cc" ... ; sh tools/port/run_web.sh "ira|cc" "g8|daz"   (Phase 5: web tier;
#     node tools/port/decimate_study.ts out/spike/g8 daz g8 measures the hair reduction alone)
#   sh tools/port/run_clean.sh "alice|G:/.../genesis8.1AliceTest_01.fbx" ...   (Phase 1: TS cleanup vs Blender)
#   sh tools/port/run_max.sh "alice|daz" ...   (Phase 6: max tier, refs from make_max_refs.sh)
#   sh tools/port/run_e2e.sh "ira|cc|G:/_exports/CharacterCreator/Ira_01-cc3.Fbx" ...   (Phase 7: the shipped path from the FBX, 3 tiers)
#   node tools/port/convert.ts <fbx> cc|daz <name> web|desktop|max   (one shipped conversion in Node)
#   cd tools\validate; node site_e2e.mjs <fbx> <out.vrm> Web --name x   (the built site in Chromium; SITE_URL= for the dev server)
#   cd tools\validate; node twist.mjs a.vrm ... ; node springs.mjs a.vrm ...   (twist roll radius, spring motion)
# the real pipeline through the app's runner (needs Blender + VRM add-on):
$env:CCDZ_TEST_FBX = "G:\_dev\image-to-vrm\imports\DAZ\genesis8.1AliceTest_01.fbx"; cargo test --manifest-path src-tauri\Cargo.toml -- --ignored --nocapture
cd tools\validate; node shots_page.mjs <dir>     # page screenshots against `pnpm dev` (fake backend)
```

```powershell
$bl = "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
& $bl --background --python-exit-code 1 --python src\blender\adapt_daz.py -- imports\DAZ\x.fbx out\x.blend --name x
& $bl --background --python-exit-code 1 --python src\blender\adapt_cc.py  -- imports\CC\y.Fbx out\y.blend --name y
& $bl --background --python-exit-code 1 out\x.blend --python src\blender\vrm_export.py -- out\x.vrm --name x --max-texture 1024
#   max tier: add --max-texture 2048 --twist-split --spring-bones ; web base: --max-mesh-verts 50000
python src\blender\glb_web.py out\x.vrm out\x.web.vrm
python src\blender\vrm_check.py out\*.vrm                       # exit 1 on error
#   probes: scripts\probe_cc_fbx.py (CC ready?), probe_fbx_shapes.py (what morphs/face bones exist)
#   headless: cd tools\validate; npm install; node validate.mjs ..\..\out\x.vrm
#   viewer: preview server "vrm-viewer" (.claude/launch.json), then
#   http://localhost:8765/tools/viewer/index.html?vrm=/out/x.vrm[&env=room]
#   http://localhost:8765/tools/viewer/check.html?vrm=/out/a.vrm,/out/b.vrm
```

The viewer exposes `window.__viewer`, `window.vrm`, `setExpr({aa:1})`, `frame("face"|"body", yaw, dist)`,
`frameBone(bone, yaw, pitch, dist)`; `tools/viewer/spring_test.js` measures spring sag/swing/settle.

## Rules

- **Commit after every meaningful unit of work. Never push.** Conventional subjects (`feat:`,
  `fix:`, `docs:`, `chore:`). **No AI co-author trailers.**
- **Never commit** Daz/CC content or anything made from it: `imports/`, `out/`, `.fbx`, `.blend`,
  `.vrm`, `.glb` are gitignored. Daz/CC content is the user's own licence; it is processed locally
  and never ships (docs/LICENSING.md).
- **Verify visually and numerically**; **load in three-vrm before calling a VRM done** (Blender
  renders hid export bugs three-vrm showed at once). A validator pass does not prove textures
  arrived, and reflection bugs only show with `&env=room`.
- Blender `--background --python` **exits 0 on a script error** unless `--python-exit-code 1`.
- Docs are deliverables: update them in the same commit. Mark provenance **[V]** verified /
  **[R]** reported / **[C]** contested. Findings go in `docs/ENVIRONMENT.md`, keeping the
  section numbers the code cites.
- UI work follows latentPresence's design system: its `theme.css` tokens (dark ground, one accent),
  every class styled in one stylesheet, no colour literals outside `:root`.

## Where things are

| Path | What |
|---|---|
| `app/` | The page (React 19 + three-vrm 3.5.5); `theme.css` is the only stylesheet; backends in `backend.ts` (Tauri), `browserBackend.ts`, `fakeBackend.ts`; `builtin.ts` runs the converter's worker |
| `app/src/convert/` | The built-in converter: `convert.ts` (the whole run), `worker.ts`, `ufbx.ts` + `ufbx_contract.wasm`, `cleanup` → `adaptCc`/`adaptDaz` → `finish` (+ `decimate`, `springBones`, `twistSplit`, `glb`, `png`, `codecs`) |
| `src-tauri/` | The Rust shell: file reads/writes for the built-in converter (`read_fbx`, `write_vrm`), `blender.rs` (find/check/install), `fbx.rs` (byte-scan inspection; `app/src/inspect.ts` is its browser port), `pipeline.rs` (the reference pipeline: plan + run + events) |
| `src/blender/` | Adapters, finisher, twist split, spring bones, web tier, checks (bundled as `pipeline/`) |
| `scripts/` | FBX probes for diagnosing an export before converting it |
| `tools/viewer/` | three-vrm viewer + pass/fail check page |
| `tools/fbx-spike/`, `tools/compare/` | Browser-port harness: ufbx→WASM build (Zig at `~/.toolchains`), Chromium runner, contract compare; `src/blender/dump_contract.py` is the reference side |
| `tools/validate/` | Headless gate: Khronos glTF validator + three-vrm via Playwright |
| `docs/ENVIRONMENT.md` | Measured findings and traps, numbered as the code cites them |
| `docs/LICENSING.md` | Tool licences and the Daz/CC content rule |
| `imports/`, `out/` | Your exports and the results (gitignored) |
