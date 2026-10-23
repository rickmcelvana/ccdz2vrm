# ccdz2vrm

Turn a **Daz 3D (Genesis 3 / 8 / 8.1)** or **Character Creator 3+** character into a **VRM 1.0
avatar**: rigged, with a face that blinks, talks (visemes) and makes ARKit-52 expressions, eyes
that follow, and optionally swinging hair. Built for
[latentPresence](https://latentpresence.com); useful anywhere VRM 1.0 loads (three-vrm, UniVRM).

Everything runs on your machine, in the browser or the desktop app. Your Daz/CC content never
leaves it, and no Daz/CC asset ships with this repo ([docs/LICENSING.md](docs/LICENSING.md)).

## In your browser

The converter runs in the page: drop the `.fbx`, pick a quality, press **Convert to VRM**, look
at the result, download it. Nothing is uploaded and nothing needs installing. Chrome, Edge or
another Chromium browser is what it is tested in; a Daz character takes 15 s to a minute, a CC
character about ten seconds.

It is a static site: `pnpm build` writes it to `dist/`, which any static host serves as it is
(any folder; `.wasm` with or without the right MIME type).

## The app (Windows)

The same page as a desktop app, which saves VRMs straight to a folder (`Documents\ccdz2vrm`
unless you choose another) and opens them from there.

1. Run the app. Drop your export on the window. It says at once what it is (Genesis 8.1 with
   FACS morphs, CC with the ARKit profile, ...) and what, if anything, to change in Daz or CC.
2. Choose **Web** (3–8 MB, for latentPresence and other web apps), **Desktop** or **Max**, and
   convert.

**Blender (reference)**, under Options → Converter, runs the original pipeline instead: the
Blender Python in `src/blender/` that the built-in converter was ported from and is checked
against. It needs **[Blender](https://www.blender.org/download/) 4.2 or newer** (verified on
5.2.2); the app finds it, and offers to install the **VRM add-on** if it is missing. Slower; for
comparing results.

Building from source (Node 22+, pnpm, Rust):

```powershell
pnpm install
pnpm dev          # the page in a browser, converting (http://localhost:5174; ?fake plays a conversion back)
pnpm build        # the static site in dist\
pnpm app          # the desktop app in development
pnpm app:build    # installer in src-tauri\target\release\bundle\nsis\
pnpm gate         # typecheck, lint, tests, build, cargo fmt/clippy/test
```

How the built-in converter came about -- ported stage by stage and accepted against the Blender
pipeline's output on five test exports -- is in [docs/BROWSER-PORT.md](docs/BROWSER-PORT.md).

## Command line (the Blender reference pipeline)

Everything the reference mode does is also a few Blender commands, for scripting or other platforms. You
need **Blender 4.2+** (verified on 5.2.2 LTS) with the **VRM add-on** (verified 4.7.1). No
separate Python: every step runs in Blender's own (`glb_web.py` and `vrm_check.py` also run with
a system Python that has numpy + Pillow).

## How it works

It is **two commands**, not one: an **adapter** builds the finisher's contract as a `.blend`,
then the **finisher** writes the VRM.

```powershell
$bl = "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"

# 1. adapter: FBX -> armature + skinned meshes + ARKit/viseme face shape keys (.blend)
& $bl --background --python-exit-code 1 --python src\blender\adapt_daz.py -- in.fbx out\c.blend --name c   # Genesis 3 / 8 / 8.1
& $bl --background --python-exit-code 1 --python src\blender\adapt_cc.py  -- in.Fbx out\c.blend --name c   # Character Creator 3+

# 2. finisher: humanoid map, expressions, lookAt, limit-4 weights, materials, export
& $bl --background --python-exit-code 1 out\c.blend --python src\blender\vrm_export.py -- out\c.vrm --name c --max-texture 1024

# 3. optional web tier (3-8 MB)
& $bl --background --factory-startup --python-exit-code 1 --python src\blender\glb_web.py -- out\c.vrm out\c.web.vrm
```

`--max-texture 1024` is what keeps a Daz desktop VRM near 30–50 MB instead of 222 MB. Daz hair is
reduced with `--max-mesh-verts 50000` on the finisher, which must come **before** the web pass;
CC goes straight to step 3.

### Converting your own character, step by step

Put each export in its own folder under `imports/` (gitignored), exactly as the exporter wrote it.
Run from the repo root in PowerShell.

**Character Creator 3 / 3+ / 4**

1. In CC: *File → Export → FBX (Clothed Character)*, tick **Embed Textures**. CC still writes a
   `textures/` folder, a `.fbxkey` and a `.json` beside the FBX — leave them, the pipeline uses
   none of them; every texture it needs is inside the `.Fbx`.
   - For the best face, give the character the ARKit expression set (CC3+ facial profile;
     CC exports it as `A01_…A51_`). A Traditional-profile character also converts — the adapter
     builds the ARKit shapes from CC3's older 60 morphs — but has fewer face-tracking shapes
     (33 of 52) and a subtler smile.
2. Optional — check it before a multi-minute conversion:
   ```powershell
   & $bl --background --python scripts\probe_cc_fbx.py -- imports\CC\Theo\cc_theo_A.Fbx
   ```
   In the `CCPROBE` line, want `"adapter_would_accept": true`, `"face_set": "arkit52"` (or
   `"traditional"`), and `"images": {"missing": 0, ...}`.
3. Convert (desktop VRM, then web VRM), and validate:
   ```powershell
   & $bl --background --python-exit-code 1 --python src\blender\adapt_cc.py -- imports\CC\Theo\cc_theo_A.Fbx out\theo.blend --name theo
   & $bl --background --python-exit-code 1 out\theo.blend --python src\blender\vrm_export.py -- out\theo.vrm --name theo --max-texture 1024
   python src\blender\glb_web.py out\theo.vrm out\theo.web.vrm
   python src\blender\vrm_check.py out\theo.vrm out\theo.web.vrm
   ```

**Daz Genesis 3 / 8**

1. In Daz: *File → Export → FBX* with the figure's **face rig** (face bones) included; Genesis 1/2
   is refused (see below).
2. Convert — the web VRM needs the hair reduced by the finisher first:
   ```powershell
   & $bl --background --python-exit-code 1 --python src\blender\adapt_daz.py -- imports\DAZ\daz_alice\daz_alice_a.fbx out\alice.blend --name alice
   & $bl --background --python-exit-code 1 out\alice.blend --python src\blender\vrm_export.py -- out\alice.vrm --name alice --max-texture 1024
   & $bl --background --python-exit-code 1 out\alice.blend --python src\blender\vrm_export.py -- out\alice.webbase.vrm --name alice --max-texture 1024 --max-mesh-verts 50000
   python src\blender\glb_web.py out\alice.webbase.vrm out\alice.web.vrm
   python src\blender\vrm_check.py out\alice.vrm out\alice.web.vrm
   ```

**Max quality (Daz, opt-in)** — heavier, for players that support it:

```powershell
& $bl --background --python-exit-code 1 out\alice.blend --python src\blender\vrm_export.py -- out\alice.max.vrm --name alice --max-texture 2048 --twist-split --spring-bones
```

- `--max-texture 2048` keeps 2K maps (a Genesis 3 figure: 37 MB at 1024 → 53 MB at 2048). Leaving
  the flag off keeps Daz's 4K maps (one G3 was 222 MB).
- `--spring-bones` makes the bones a hair or clothing item brings (fringe, ponytails, buns,
  skirt bones) swing as VRM spring bones, with head/neck/shoulder/arm/thigh colliders fitted to
  the body. Items without their own bones (most CC hair) get none. Works on the web tier too.
- `--twist-split` spreads an arm's twist over Daz's bend **and** twist bones, so a turned wrist or
  shoulder no longer pinches the elbow or shoulder (a 90° forearm twist keeps 92 % of the arm's
  thickness instead of 77 %). It uses VRM node constraints (`VRMC_node_constraint`): **three-vrm
  and UniVRM 1.x run them; a player that ignores them leaves the elbow and shoulder regions
  unbent**, so only use it where you know the player. Genesis 3/8/8.1 only.

**Best Daz face: export the Genesis 8.1 FACS morphs.** Without morphs the adapter poses the face
bones (26 of 52 ARKit shapes, approximate). With them it builds all **52 ARKit shapes + 5 visemes**
from Daz's own sculpts — real blink, mouth and brow shapes, lashes and brows following. Ticking
*Morphs* in the FBX exporter is not enough (it exported zero); open **Edit Morph Export Rules**
and add a rule matching `facs` with action *Export*. The adapter detects them by itself
(`"face_source": "facs_morphs"` in its RESULT line). Genesis 8 / 3 have no FACS set and keep the
bone-posed face.

Strand brows (e.g. 177k-vert "Mio Brows") carry every brow and eye shape densely: Kamara 8.1 was
156 MB desktop / 12 MB web. `--max-mesh-verts` reduces such meshes with their face shapes kept
(the web command above already does).

**Look at it** — start the `vrm-viewer` preview server (`.claude/launch.json`, serves the repo on
port 8765), then open `http://localhost:8765/tools/viewer/index.html?vrm=/out/theo.web.vrm`
(sliders for every expression, eyes follow the mouse), or
`http://localhost:8765/tools/viewer/check.html?vrm=/out/a.vrm,/out/b.vrm` for a pass/fail table.
A validator pass does **not** prove the textures arrived — look at it. Add `&env=room` to light it with an environment map, as most apps do —
reflection problems (a cloth coming out chrome) only show then.

### Why there are two steps for one job

The finisher only assumes three things: one armature mappable to VRM humanoid bones, meshes
skinned to it, and face shape keys named **ARKit-52** and/or **Meta visemes**. Every source
reaches that contract differently, and the face is where they genuinely differ:

| Source | The face problem | What the adapter does |
|---|---|---|
| **Daz Genesis 3 / 8** | the face is **bone-driven** (60–154 face bones, **zero** shape keys) — and a VRM expression can only bind a *shape key*, not a bone | poses the face bones into each of 26 ARKit + 5 viseme expressions and freezes each as a shape key; also A-pose → T-pose with every key kept exact |
| **Character Creator 3+** | already ships ARKit 52 + 8 lip-sync shapes as morphs, so this is mostly renaming — but **teeth and tongue carry no jaw morph** | renames `A01_…A51_` to ARKit names (or, on a Traditional-profile character, mixes CC3's 60 older morphs into them), mixes the 8 shapes into 5 visemes, and bakes the jaw's rotation into teeth + tongue |

Both also delete the clear eye shells (cornea / eye-moisture / tear line), which glTF would paint
solid over the iris, and reset every material's Metallic from the importer's 1.0 (skin otherwise
exports as a mirror).

### What your export has to contain

Measured on real exports; the full detail and the traps are in
[ENVIRONMENT.md §23](docs/ENVIRONMENT.md).

| Source | Needs |
|---|---|
| **Genesis 3** | the full face rig (60 face bones). It carries no morphs at all, so nothing else is asked of it. |
| **Genesis 8** | the full face rig (152–154 face bones). Same adapter, unchanged. |
| **Genesis 8.1** | as Genesis 8; for the best face, the FACS morphs too (a `facs` *Export* rule in Edit Morph Export Rules). |
| **Character Creator 3+** | the standard `CC_Base_*` rig, the `CC_Base_Teeth*` / `CC_Base_Tongue*` meshes (the jaw is baked into them), and face morphs on the body: **ARKit 52** (`A01_…A51_`, best) or CC3's **Traditional 60** (`Eye_Blink_L`, `Mouth_Smile_L`, …). Textures embedded. |
| **Genesis 1 / 2** | ❌ **not supported, and not fixable by an adapter.** Those exports carry 11 face bones and 16 morphs that are *all* visemes — no blink, brow or smile shape exists in the file at all. It needs a **re-export from Daz** with the eyelid and expression morphs added to the exporter's morph list, not a code change. |

### CC textures: embedded is all it needs

With **Embed Textures** on, the `.Fbx` itself carries every diffuse, opacity and normal map, and
Blender unpacks them on import. The FBX's texture *paths* still name CC's temp folder, which CC
deletes after exporting — that is harmless, because the embedded copies are used. (An earlier
probe counted only files on disk, called these "missing", and concluded CC exports were
unconvertible; they are not — all four test characters convert textured.) The side `textures/`
folder holds extra PBR maps (roughness, AO, SSS…) the VRM does not use. A VRM with no textures
still passes every validator, which is why the probe reports `images.missing`.

### Licence

Daz and CC *content* is your own licence, and the adapters may process it locally, but **no Daz or
CC asset ever ships** and nothing here is redistributed. `imports/` and every `.vrm` / `.glb` /
`.fbx` are gitignored — keep source exports in `imports/`.

