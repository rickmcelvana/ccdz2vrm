# Findings — measured, not assumed

Carried over from `image-to-vrm` (2026-10-22), where this converter was built. Only the
sections about FBX → VRM conversion are kept, **with their original numbers**, because the
code cites them (`ENVIRONMENT.md s14`). Missing numbers (1–3, 5–12, 16, 19–22) and the MPFB half of §13 were about
the image-to-3D pipeline and are not part of this repo. Provenance: **[V]** verified on the
author's machine, **[R]** reported, **[C]** contested.

Machine these were measured on: Windows 11 · RTX 5060 Ti 16 GB · Blender 5.2.2 LTS +
VRM add-on 4.7.1 · three-vrm 3.5.5 · Daz Studio + Character Creator 3.

---

## 4. Blender VRM add-on 4.7.1 — what it gives us for free

Verified operator inventory. These are the ones that make the pipeline automatable:

| Operator | Why it matters |
|---|---|
| `bpy.ops.export_scene.vrm` | Export VRM |
| `bpy.ops.import_scene.vrm` | Import existing VRM (retarget templates) |
| `bpy.ops.export_scene.vrma` / `import_scene.vrma` | **VRM Animation** — retarget motion clips |
| **`vrm.assign_vrm1_humanoid_human_bones_automatically`** | **Auto-maps a rig to VRM humanoid bones** — the key last-mile automation |
| `vrm.show_vrm1_bone_assignment_diagnostics` | Reports what failed to map |
| **`vrm.assign_vrm1_expressions_automatically`** | Auto-detects and binds shape keys to VRM expressions |
| **`vrm.assign_vrm1_expressions_from_arkit`** | **ARKit 52 blendshape set → VRM expressions (lipsync visemes)** |
| `vrm.assign_vrm1_expressions_from_mmd` / `_from_ready_player_me` / `_from_vrchat` / `_from_vrm0` | Other naming conventions → VRM expressions |
| `vrm.add_vrm1_expression_morph_target_bind` / `_material_color_bind` / `_texture_transform_bind` | Manual expression authoring |
| `vrm.add_vrm1_first_person_mesh_annotation` | First-person view (head hiding) |
| `vrm.assign_spring_bone1_from_vrm0` | Spring bone migration |
| `vrm.add_vrm1_meta_author` / `_meta_reference` | VRM metadata |

Also enabled: `io_scene_gltf2`, `io_scene_fbx`, `io_anim_bvh`, `rigify`, `pose_library`, `cycles`.

> **Implication:** the VRM authoring stage is scriptable via `bpy`. We do **not** need Unity/UniVRM
> for the local pipeline. Blender headless (`blender --background`) + a Python script can do
> rig → humanoid mapping → expressions → VPED export end to end.

---

## 13. MakeHuman asset packs + the first VRM [V] — 2026-09-26

### Installed (outside the repo)

Downloaded from `files.makehumancommunity.org`, extracted into MPFB's user data dir
`%APPDATA%\Blender Foundation\Blender\5.2\extensions\.user\blender_org\mpfb\data`
(what MPFB's own *Load pack* operator does). Zips kept in `%LOCALAPPDATA%\image-to-vrm-downloads`.

| Pack | Size | Licence (per-asset metadata) | Gives us |
|---|---|---|---|
| `makehuman_system_assets_cc0.zip` | 281 MB | CC0 | eyes, eyebrows, eyelashes, teeth, tongue, skins, proxies, hair, clothes |
| `faceunits01.zip` | 0.26 MB | CC0 (author Mika Suominen) | **ARKit-52** face targets |
| `visemes02.zip` | 0.13 MB | CC0 (author Mika Suominen) | **15 Meta visemes** |

MPFB also ships 34 legacy MakeHuman expression units built in (`data/targets/expression/units`).

### Traps hit building the character

| Trap | Fix |
|---|---|
| MPFB asset references are **file names** (`low-poly.mhclo`), not folder names; unknown names are skipped silently | `build_mpfb_character.py` uses `<name>.mhclo` |
| `RigService.apply_pose_as_rest_pose` bakes targets and applies the armature modifier | T-pose **before** loading face targets (they only touch the head, so indices/deltas are unaffected) |
| Targets are indexed by basemesh vertex | Load before `bake_modifiers_remove_helpers` (which preserves shape keys) |
| Proxies don't get face shapes automatically | `FaceService.interpolate_targets(body)` → brows 43, lashes 28, eyes 9, teeth 13, tongue 14 keys |
| `game_engine` rig has no eye bones | add `eye_l`/`eye_r` under `head` at each eyeball's bbox centre; weight eyeballs 100% |

Result: body 13,380 verts, 55 bones, 67 face shape keys. Contact sheet
`out/base_char_expr.png`: blink, jaw, 5 visemes, smile, frown all visibly correct.

### The VRM (`src/blender/vrm_export.py` → `out/base_char.vrm`)

| Check (three.js 0.186.1 + @pixiv/three-vrm 3.5.5) | Result |
|---|---|
| Load, console errors | ✅ 0 |
| Humanoid bones | 54 (incl. all fingers, eyes) |
| Expressions | 70 (13 presets + 52 ARKit customs + look/neutral) |
| Presets drive the face | ✅ aa, ee, ou, happy, blink, surprised checked visually |
| Gaze, 45° target left/right | 12.8° / 12.8° with a 90→25 map — exactly linear, symmetric; now 60→25 |
| File size | 34 MB (PNG textures + 67 dense morphs) |

**Two defects that Blender renders hid and three-vrm showed at once:**
1. **All six materials exported `alphaMode: BLEND`** because MakeSkin links texture alpha
   into every BSDF → three.js drew teeth and eyeballs *through* the face. Fix: unlink alpha
   unless >1% of texels are clear, then use a Greater-Than node → `MASK`.
2. **Default lookAt range map** (90° in → ~10° out) made the eyes barely move.

---

## 14. Daz Genesis → VRM [V] — 2026-09-26

### What the user's existing exports contain (`D:\_EXPORTS\DAZ`, probed with `scripts/probe_fbx.py`)

| Export | Rig | Face data in the FBX |
|---|---|---|
| Genesis 1 (`genesis/Alice`, `male2`) | 72 bones, `lEye`/`rEye` | **16 viseme morphs** as shape keys (`head__CTRLVSM*`), no blink |
| Genesis 3 female (`gen-3.fbx`) | 172 bones incl. **60 face bones** | **0 shape keys** |

This is why face animation "didn't transfer" in the earlier attempt: Genesis 3/8 faces are
bone-driven, and VRM expressions can only bind shape keys (AGENTS.md §3.12).

### The adapter (`src/blender/adapt_daz.py`)

Poses the Genesis face bones — `lowerJaw`, 8 eyelid bones per eye pivoting on the eye
centre, lip/cheek/brow/nose bones — into each expression and freezes the result as a shape
key. 26 ARKit expressions + 5 visemes (`viseme_aa/E/I/O/U`), all named so the finisher binds
them unchanged. Expressions are written in the character's frame (metres, degrees) and
mirrored for L/R, so the table serves any rig with Genesis 3/8 face-bone names.
Contact sheet: `out/daz_g3_expr.png` (blink, jaw, 5 visemes, smile, frown all correct).

### Four import traps, each producing a plausible-looking wrong result

| Symptom | Cause | Fix |
|---|---|---|
| Renders show a 1.8 cm speck; scripted checks all pass | FBX take imported as an **action** on the armature; renders re-evaluate it and restore the 0.01 bone scale | `animation_data_clear()` + delete actions right after import |
| World-space figure 100× too small, local coords correct | Applying the FBX's 0.01 scale with meshes parented leaves 0.01 in `matrix_parent_inverse` | unparent (keep transform) → apply → re-parent with identity inverse |
| Figure invisible against a grey background | **Every material imports with `Metallic = 1.0`** — skin is a mirror | reset Metallic to 0 unless the material name says metal (31 materials) |
| Shape-key deltas double each time (0.016 m → 1,950 km) | new keys can arrive at value 1.0; captured while active, each compounds the previous | zero all keys before each capture; set new keys to 0 |

### Finisher additions

- `daz_genesis3_8` bone table (twist/carpal/metatarsal bones sit between humanoid bones —
  allowed by VRM 1.0), auto-detected.
- **Separate opacity maps merged into base-colour alpha** (Daz hair and lashes use a grey
  transmap on Alpha, which glTF cannot express). 8 materials merged → `MASK`.
- `--max-texture`: Daz ships a 4K map per body part; G3 VRM 222 MB → 42 MB at 1K.

### Verified in three-vrm

`out/daz_g3.vrm`: 0 console errors, 54 humanoid bones, 70 expressions; `aa`, `blink`, `happy`
visibly correct. Known flaw: hairline is a hard edge (scalp fade becomes a MASK cutout).

### Not yet done

- ~~**Genesis 8 A-pose** rest → T-pose step (adapter stops with a clear message). Needs a G8 export.~~
  Done in §15: `common.tpose_arms` + `apply_pose_as_rest` (G8 arms 46.1° down → T-pose, keys exact).
- Genesis 1/2: already carry viseme morphs; needs a `CTRLVSM*` → viseme name map **and a richer
  Daz export** — measured in §23, those exports hold no blink or expression morph at all, so no
  adapter can supply them.
- Hair quality: consider `BLEND` for hair-only materials.
- **Licence:** Daz-derived VRMs are local-only (LICENSING.md). Never commit or ship them.

---

## 15. Genesis 8 and Character Creator 3 [V] — 2026-09-26

Exports supplied by the user in `G:\_exports` (local only — never committed or shipped).

| | Genesis 8 (`Alice_gen8_01.fbx`) | CC3+ (`Ira_01-cc3.Fbx`) |
|---|---|---|
| Rig | 399 bones, 152 face bones, G3 naming | 101 bones, `CC_Base_*` |
| Rest pose | A-pose, arms **46.1°** down | A-pose, arms **30.2°** down |
| Face data | 0 shape keys (bone-driven) | **ARKit 52** as `A01_…A52_` + 8 visemes + ~60 legacy morphs |
| Adapter | `adapt_daz.py` — same face table as G3, **unchanged** | `adapt_cc.py` — rename + viseme mixes + jaw bake |
| VRM (1K textures) | 54 MB | 57 MB |
| three-vrm | 0 errors, 54 bones, visemes/blink/gaze ✅ | 0 errors, 54 bones, visemes/blink/emotions ✅ |

### Shared: A-pose → T-pose keeping shape keys exact

`common.apply_pose_as_rest`: Blender will not apply an armature modifier to a mesh with shape
keys, but linear blend skinning is linear in the rest position, so evaluating the posed mesh
once per key (that key at 1, others 0) gives every key's exact posed coordinates. Used for
CC3's ~120 morphs.

### New traps

| Symptom | Cause | Fix |
|---|---|---|
| G8 lashes stay open through a blink | Daz "follower" figure: weights on duplicate `lEyelidUpper.001` bones (which exist, unposed), **no armature modifier** | `import_fbx_clean` folds `.001` groups onto real bones, adds the modifier |
| G8 VRM 202 MB | 363k-vert hair got brow-driven morphs (**174 MB**) | face shapes only on the figure + lash/brow/beard meshes → 54 MB |
| Eyes blank / rolled under the lids in three-vrm | lookAt offset written in Blender axes; add-on ≥ 2.20 stores **glTF axes** (Y up, Z fwd) → gaze origin 8 cm *below* the head bone | finisher writes `(x, z, −y)`; straight-ahead target now yaw 0.9°, pitch 0° |
| G8 lashes render white | base colour factor white, colour lives in Iray settings the FBX drops | finisher darkens lash/brow materials with no colour texture |
| CC3 mouth opens onto closed teeth | CC3+ opens the jaw with the **JawRoot bone**; `jawOpen`/`Open` morphs move the chin < 1°, `mouthClose` is −8.5° | jaw-driven keys bake a jaw rotation (ours: jawOpen 22°, aa 16°, O 10°, …) into skin + teeth + tongue |
| CC3 VRM 88 MB | ~70 legacy morphs nobody binds | finisher prunes unbound shape keys (205) → 57 MB |

### Clothing

Not the hard part it seemed: Daz and CC clothing arrive **already skinned to the same rig**,
so they deform with the body (G8 stress pose with skirt/top, CC3 arms-down with top/shorts).

### Known flaws

- ~~Hair on all Daz/CC characters is a hard alpha cutout (MASK): stringy, hard hairline, white
  flecks at CC brow tips.~~ Fixed in §17 (core + fringe passes).
- ~~Pale white rim on the G8 lower lid.~~ Fixed in §17: it was the lash figure's own
  `EyeMoisture` surface, exported opaque.
- Sizes are dominated by dense morph targets; web tier (M5) still to do.

---

## 17. Soft hair: opaque core + blended fringe [V] — 2026-09-26

Daz and CC hair is made for Iray as stacks of semi-transparent cards. Measured on the alpha
channel of each strand texture:

| Texture | texels < 0.5 alpha | visible texels that are partly transparent |
|---|---|---|
| G8 "Audrey" hair (braid, inside, outside, detail) | **94.7 %** | **100 %** — no texel is fully opaque |
| G3 Krayon hair | 40–72 % | 82–90 % |
| CC3 hair cards | 74–90 % | 42–62 % |
| lashes / brows (Daz, CC, MPFB) | 82–93 % | 35–100 % |
| G8 lace (clothing) | 46 % | 12 % |

So the old rule (MASK at 0.5) kept ~5 % of the G8 hair texture: stringy braid, hard hairline,
the scalp cap reading as a painted helmet (all seen in three-vrm).

### What the finisher does now (`vrm_export.py` step 7a)

A cut-out material whose visible texels are > 15 % partly transparent (G3 Krayon scalp is
18 %; at 25 % its hairline stayed hard; G8 lace at 12 % stays a plain cut-out) is "strands" and gets
**two passes over the same faces**:

1. **core** — the material itself, MASK at 0.5. Writes depth, so layers occlude correctly.
2. **fringe** — a copy named `<mat>.fringe`, alpha straight from the texture → glTF BLEND.
   three.js draws it after all opaque geometry with depth test on and depth write off, so it
   only adds the soft strand edges the core cut away, in front of whatever is behind.

The fringe faces are duplicated **inside the same mesh** (edit-mode duplicate), so they carry
the weights, shape keys and expression binds with no extra bookkeeping — G8 lashes, both
passes, follow a blink. The exporter writes them as a second primitive of that mesh.

Plain BLEND alone was not tried as the fix: with no depth write the inner hair layer
(`hair_inside`, darker) would paint over the outer one wherever draw order says so.

### The size cost, and `glb_dedupe.py`

The fringe copy is byte-identical to its core (verified: same POSITION hash per primitive), so
it doubled the hair data: G8 54 → 75 MB. `src/blender/glb_dedupe.py` (pure Python, runs at
the end of the finisher, or standalone) hashes bufferViews and accessors, points duplicates at
the first copy and repacks the binary chunk. GLTFLoader caches by accessor index, so the
copies share one GPU buffer too. It also caught duplicates that predate the fringe.

### Also fixed: G8 white lower-lid rim

The eyelash follower figure carries its own `EyeMoisture` surface; `adapt_daz.py` removed
eye overlays from the body only, so this one exported opaque — a white line along both lower
lids. Overlays are now removed from every mesh (100 faces on the lash figure).

### Also fixed: opacity read from the wrong channel

The finisher merged a separate opacity texture by its **grey level**. CC3's FBX wires some
materials by the texture's **Alpha output** instead (a `.001` copy of the diffuse): the
tongue's grey level cut 31 % of it away, invisible until the fringe made the rest translucent.
Now the socket decides: `Alpha` output → alpha channel, `Color` output → grey level. Tongue
→ OPAQUE; the CC brow base card keeps its real shape.

### Results (1K textures for Daz/CC; three-vrm: 0 errors, 54 bones, 70 expressions each)

| VRM | before | after | strand materials |
|---|---|---|---|
| G8 | 54 MB | **38 MB** | 5 hair + lashes |
| G3 | 42 MB | **29 MB** | 5 hair + scalp + lashes |
| CC3 | 57 MB | **49 MB** | 4 hair + scalp + 2 brow + lashes |
| char01 | 48 MB | 48 MB | MPFB brows + lashes |
| base_char | 30 MB | 30 MB | MPFB brows + lashes (full-res textures) |

Looked at in three-vrm: G8 braid/ponytail full instead of stringy, soft scalp; CC3 bangs and
bun soft; G3 hairline graded; lashes (both passes) follow blink on G8; CC3 `aa` shows tongue
inside the mouth with teeth at the sides.

### Remaining

- Blended fringe layers are not sorted against each other (by design: depth write off) —
  no visible artefact at avatar distances; watch for it on light hair over dark.
- G8 hair is 363k verts; the fringe costs no file size now but doubles its draw calls.

---

## 18. Web tier and automated validation [V] — 2026-09-26

### Where the bytes were (`src/blender/glb_stats.py`)

| VRM | biggest costs |
|---|---|
| base_char 30 MB | **morph targets 21 MB** — dense, not sparse: MPFB targets nudge every vertex by micrometres, so the exporter's sparse pass never fired; morph NORMALs are half of it |
| char01 48 MB | **PNG textures 37 MB** (generated 4K maps) |
| G8 38 MB | **hair geometry** — 363k-vert "Audrey" hair; 399-joint skin forces uint16 JOINTS |
| CC3 49 MB | PNG textures 23 MB, morphs 16 MB |

### The pipeline

1. **Finisher `--max-mesh-verts N`** (Blender, before export) — meshes *without* shape keys
   above N verts go through `simplify_cards.py`. Must run before the fringe pass so the
   fringe copies the reduced core.
2. **`glb_web.py`** (system Python: numpy + Pillow) on the exported VRM — textures to
   ≤ 1K (normal maps 512), JPEG when there is no transparency, 256-colour palette PNG when
   there is; morph NORMALs dropped; morph POSITIONs sparse with deltas < 0.1 mm zeroed;
   one skin per mesh with only the joints it uses (→ uint8 JOINTS); uint8 WEIGHTS (sums
   exactly 255); uint16 UVs when in [0, 1]; then `glb_dedupe` repacks.

Everything stays **core glTF 2.0** — no Draco, meshopt or KTX2, each of which needs the
consuming app to register a decoder. The 3–8 MB target was reachable without them.

### Hair reduction: two failures, then cross-sections

| Attempt | Result in three-vrm |
|---|---|
| Collapse decimate to 40k | ribbons crumpled into spikes: furry braid, shaggy hairline |
| Planar (dissolve) decimate, 5° | 49k verts but **the braid and ponytail vanished** — whole ribbons became single n-gons |
| **`simplify_cards`**: tris→quads, then dissolve every other *rung* of 2-wide strips where the vertex is within 2.5 mm / 0.008 UV of the straight line, then Un-Subdivide for quad grids | G8 hair 363k → 88k, braid and ponytail intact (slightly thinner); G3 Krayon grids 132k → 39k, looks unchanged |

Hair topology measured: G8 "Audrey" = 2,957 ribbons, 81 % boundary verts, 157k quads +
114k triangles; G3 Krayon = all-quad grids, 20 % boundary.

### Results — every file passes both checks

| | desktop | **web** | web tris | draw calls |
|---|---|---|---|---|
| base_char | 29.9 MB | **2.5 MB** | 36k | 10 |
| char01 | 48.0 MB | **4.7 MB** | 58k | 13 |
| G3 | 28.8 MB | **6.3 MB** | 187k | 44 |
| G8 | 38.3 MB | **8.2 MB** | 323k (desktop 1.33M) | 42 |
| CC3 | 49.2 MB | **7.7 MB** | 134k | 38 |

Looked at side by side: char01 web vs desktop with `aa`+`happy` — identical apart from texture
resolution; CC3 palette-PNG hair indistinguishable; G8 web hair posed with head turn and
arms down follows correctly.

### Validation

- **`src/blender/vrm_check.py`** — structural gate, exit 1 on error: GLB lengths, accessor
  bounds/alignment/sparse indices, POSITION min/max, equal attribute counts, index and
  joint ranges, weight sums, image magic vs mimeType, VRMC_vrm spec version, required
  humanoid bones, expression binds → real mesh node + morph index, first-person nodes.
  Negative-tested: a bind index of 999, a missing `leftHand`, a 3-joint skin, a wrong
  mimeType — each FAILs with the right message.
- **`tools/viewer/check.html?vrm=a,b`** — loads each file in three-vrm and checks: 0 console
  errors; each of 13 presets moves vertices > 0.5 mm (computed from morph influences);
  `blinkLeft` acts on the same side as the `leftEye` bone; a target 45° left/right turns
  the eyes > 3° and symmetrically (all files: 19.6–19.8°). Negative-tested: swapped blinks
  and an empty `aa` both FAIL. Results in `window.__check`.
- Not yet: the Khronos `gltf-validator` (npm download) and a headless runner for
  `check.html` (Playwright/Puppeteer download) — both need the user's go-ahead.

---

## 23. What a Daz/CC FBX export must contain, and two Daz-path bugs [V] — 2026-10-14

### The conversion is two commands, not one

Adapters are not a batch job: an adapter turns the FBX into the finisher's contract (one
armature, skinned meshes, face shape keys) as a `.blend`, then the finisher exports VRM. The
web tier is a third (system Python), and only Daz hair needs the finisher's vert cap first.

```powershell
$bl = "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
& $bl --background --python-exit-code 1 --python src\blender\adapt_daz.py -- in.fbx out\c.blend --name c   # Genesis 3/8
& $bl --background --python-exit-code 1 --python src\blender\adapt_cc.py  -- in.Fbx out\c.blend --name c   # Character Creator 3+
& $bl --background --python-exit-code 1 out\c.blend --python src\blender\vrm_export.py -- out\c.vrm --name c --max-texture 1024 --max-mesh-verts 50000
python src\blender\glb_web.py out\c.vrm out\c.web.vrm
```

`--max-mesh-verts` is a finisher flag and matters only for Daz (G8 hair is 363k verts);
`--max-texture 1024` is what keeps a Daz desktop VRM near 30–50 MB instead of 222 MB.

### What each family's export has to carry

Measured with `scripts/probe_fbx_shapes.py` (which lists every morph and face bone) on the
exports in `D:\_EXPORTS\DAZ` and `G:\_exports`:

| Export | Bones | Face bones | Morphs | Adapter |
|---|---|---|---|---|
| **Genesis 3** (`gen-3.fbx`, 140 MB) | 172 | 60 | 0 | `adapt_daz.py` — face **posed from bones**, frozen as 26 ARKit + 5 viseme keys |
| **Genesis 8** (`Alice_gen8_01` 399 / `_02` 511) | 399 / 511 | 152 / 154 | 0 | same table, **unchanged** |
| **Character Creator 3+** (`Ira_01-cc3.Fbx`) | 101 | 7 | ARKit 52 (`A01_…A51_`) + 8 visemes + ~60 legacy | `adapt_cc.py` — rename, mix visemes, bake the jaw into teeth/tongue |
| **Genesis 1/2** (`male2`, `zane`, `ZANETEST`, both `Alice` G1 exports) | 72 | **11** | **16, all `head__CTRLVSM*`** | **refused**: `unsupported Daz rig family: genesis1_2` |

The G1/2 result is worth keeping: their only face bones are `lEye`, `rEye`, `upperJaw`,
`lowerJaw` and 7 tongue bones, and the only morphs are the 16 Daz visemes
(`CTRLVSMAA/EH/ER/F/IH/IY/K/L/M/OW/S/SH/T/TH/UW/W`). **No blink, brow, smile or ARKit shape is in
the file at all** — a Genesis 1/2 eyelid and expression are morphs that were not in the export's
morph list. So an adapter cannot fix it; it is a **Daz re-export** (add the eyelid and expression
morphs to the FBX exporter's morph list). The 16 viseme names line up with the finisher's
`viseme_aa/E/I/O/U` once mapped; the rest of the contract would need the re-exported morphs.

### Bug 1 — one unskinned mesh aborted the whole export

`Alice_gen8_02` carries two Daz prop chains and `vrm_export.py` step 6 died on them:

```
RuntimeError: Operator bpy.ops.object.vertex_group_limit_total.poll() Object has no vertex groups
```

`vertex_group_limit_total` polls on the active object **having vertex groups at all**, so a mesh
nothing skinned kills the run. `--max-texture` and every earlier step had already succeeded, so
the failure looked like the export rather than the weights. Step 6 now records such a mesh as
`"skinned": false` and leaves it alone.

### Bug 2 — a prop the FBX attaches to a bone stood still

`Chain1.Shape` has **0 vertex groups** — Daz parented it, it was never skinned. In the raw import
it hangs off a bone through two empties:

```
Chain1.Shape (MESH) ← Chain1 (EMPTY) ← Chain (EMPTY, bone=chestUpper.004) ← armature
```

`import_fbx_clean` step 2 unparents every mesh (it has to — the FBX's 0.01 scale lands in the
parent inverse), so the chain lost that attachment and came out a static node: it would have hung
in mid-air while the figure walked away from it. The clean import now walks the mesh's ancestry
for a bone-parented object and **rigid-binds** it (one group, weight 1) before clearing the
parent. Daz gives every figure *and prop* its own copy of the skeleton, so the empty points at
`chestUpper.004`; those twins exist in the armature but are **unposed** — the VRM humanoid map
names only `chestUpper`, and each twin is a separate `chestLower.00N` chain — so the bind folds
onto the base name, the same rule the `.001` vertex groups already used (§15).

Proven by measurement rather than by eye (`scripts/verify_rigid.py`, a 25° rotation on
`chestUpper`, mean vertex displacement):

| mesh | mean move |
|---|---|
| `Chain1` / `Chain2` — **rigid bind** | **30 / 34 mm** (0 before) |
| `RnRNecklace2` / `RRNecklace1` — skinned | 63 / 81 mm |
| `RNRSkirt`, `RNRThong`, sandals, shoes — skinned to pelvis/feet | 0 |

### Result — `Alice_gen8_02` → `out/daz_g8b.vrm`

| | desktop | web |
|---|---|---|
| size | 45.9 MB | **12.6 MB** |
| verts / tris | 889,781 / 1,067,341 | 325,557 / 469,935 |
| meshes / materials | 13 / 74 | 13 / 74 |

54 humanoid bones, 70 expressions, 13/13 presets move, blink sides correct, gaze 19.8°/19.8°;
`node validate.mjs`: Khronos **0 errors** (30 warnings — 17 generated-tangent-space, 13
skinned-mesh-non-root) and three-vrm clean; `vrm_check.py` clean. It does **not** reach the 3–8 MB
web band because this export carries ~79k verts of jewellery that `_01` does not (2 chains, 2
necklaces, armbands, sandals, thong). That is the export's content, not a pipeline defect.

**Not yet looked at by eye:** the session that made this change had no image input, so the three
renders were not judged. `out/sheet_g8b_daz_g8b.web_{body,face,call}.png`.

### Diagnosis tooling added

`scripts/probe_fbx_shapes.py` (every morph + face bone of an FBX), `probe_skinning.py` (per-mesh
vertex groups, deform groups, armature modifier, parent, in an adapted `.blend`),
`probe_fbx_graph.py` (the object/bone ancestry a mesh hangs from), `probe_dup_bones.py` (whether
Daz's `.00N` bone twins are separate unposed chains, and who skins to each) and
`verify_rigid.py` (does a mesh actually move when a given bone is posed).

### CC textures are embedded in the FBX [V] — 2026-10-15 (corrects an earlier entry)

An entry written here on 2026-10-14 said fresh CC exports resolve **0** of their images and must be
re-exported with textures embedded. **That was wrong.** Its probe tested only
`os.path.exists(image.filepath)`. A CC FBX exported with *Embed Textures* carries every image inside
the file; Blender's importer unpacks them as **packed** images whose `filepath` still names CC's
deleted `%TEMP%\CharacterCreator3Temp\FbxWorkingDirectory` — so a path check calls them missing
while the pixels are all there. Measured with the fixed `scripts/probe_cc_fbx.py` (packed counts as
resolved): Liz 39/39 packed, Theo 57/57, and all four `imports/CC` characters convert textured
(§24). Those exports were already embedded; nothing needed re-exporting. The side
`textures/<name>/…` folder really is a partial PBR set (no `*_Diffuse`, no `*_Opacity`) — it is
CC's extra maps, not a fallback, and the pipeline does not read it. `Ira_01-cc3.Fbx` converted for
the same reason, not because a temp folder happened to exist.

## 24. CC Traditional facial profile, and unwired lash opacity [V] — 2026-10-15

Converted all five `imports/CC` exports (Alice A/B, Theo, Liz, Red) with the commands in the README.
Two of them exposed two adapter gaps; both fixed in `adapt_cc.py`.

**Traditional-profile characters have no ARKit set.** Liz and Red carry 68 body morphs — CC3's
older 60 (`Eye_Blink_L`, `Brow_Drop_L`, `Mouth_Smile_L`, `Cheek_Raise_L`, …) plus the 8 lip-sync
shapes — and no `A01_…`. The rename found nothing (`arkit_renamed: 0`), so the finisher's `blink`
preset had no binds and `vrm_check.py` failed it. Step 4b now mixes the old morphs into the ARKit
names the finisher binds (33 keys: blink/wide/squint, brows, sneer, cheek squint/puff,
smile/frown/dimple, upper-up/lower-down, pucker/funnel, roll, mouth L/R, jawOpen). Side and meaning
checked on Theo, which has **both** sets — cosine of the per-vertex deltas: `Eye_Blink_L` vs
`A14_Eye_Blink_Left` 0.99, `Brow_Drop_L`/`browDownLeft` 0.93, `Eye_Wide_L` 0.95, `Mouth_Pucker`
0.99, `Mouth_Smile_L` 0.90; CC `_L` = ARKit `Left`. `Mouth_Open` is **not** the ARKit `jawOpen`
corrective (cos 0.13, it moves the chin ~10° itself), so on a legacy export `jawOpen` skips the
fixed 22° `JAW_DRIVEN` bake and the teeth/tongue get its measured angle instead. Only ARKit sets
get the 52 PerfectSync customs in full; legacy gets the 33 above.

**Lashes rendered as solid red strips (Liz).** `Std_Eyelash` had a packed `Std_Eyelash_Opacity`,
but Blender's importer wired Alpha from `Std_Eyelash_Diffuse.001`'s alpha channel, which is all
opaque → OPAQUE lashes. Step 2b: if a material's wired alpha has < 1 % clear texels and an image
`<material>_Opacity` exists, wire that by its Color; the finisher's §17 merge does the rest. Fired
on Liz and Red's lashes only; the ARKit exports' wiring already cut out and is untouched.

| Export | face set | renamed / from legacy | desktop | web | three-vrm check |
|---|---|---|---|---|---|
| Alice A | ARKit 52 | 104 / 0 | 35.0 MB | 5.9 MB | PASS |
| Alice B | ARKit 52 | 104 / 0 | 37.5 MB | 7.1 MB | PASS |
| Theo | ARKit 52 | 52 / 0 | 45.1 MB | 7.7 MB | PASS |
| Liz | Traditional | 0 / 33 | 32.6 MB | 3.7 MB | PASS |
| Red | Traditional | 0 / 33 | 27.5 MB | 3.1 MB | PASS |

(104 on Alice: the hair mesh carries the ARKit set too.) All 13 presets move, blink sides and gaze
pass in `check.html`; looked at in the viewer: textured, lashes cut out, `aa` drops teeth and tongue
with the jaw. Legacy `happy` reads weaker than ARKit's (CC3's `Mouth_Smile` is smaller: max
0.78 vs 2.25 cm on Theo) — left as is.

### Daz: a hair with its own armature was taken for the figure [V] — 2026-10-15

`imports/DAZ/daz_alice/daz_alice_c.fbx` (Genesis 3, Audrey hair) imports **two** armatures: the
288-bone `Genesis3Female` and an 88-bone `Audrey Hair_363327` — a partial copy of the figure's
skeleton under the same bone names, which the hair is skinned to. `import_fbx_clean` took the
first armature, the hair's, and `adapt_daz.py` died in `tpose_arms` (`key "lHand" not found`). It
now takes the armature with the most bones, re-points every mesh's Armature modifier from the
others to it, and deletes them (a no-op on a one-armature export). Result: 7 meshes, 51.1 MB
desktop / 12.5 MB web, both PASS `vrm_check.py` and `check.html`; `verify_rigid.py -- head` moves
the hair 6.8 cm mean, so it rides the head. Alice A / B (one armature) also pass: 32.6 / 16.9 MB
desktop, 10.1 / 6.7 MB web. Alice A and C web files are above the 3–8 MB target (hair and 90
materials on C) — not chased.

## 25. Max-quality tier: arm twist split, 2K textures; Daz morphs not exported [V] — 2026-10-20

### Twelve Daz exports, all convert

`imports/DAZ` (Genesis 3: five Harley; Genesis 8: Candy, Zara; Genesis 8.1: Eliza ×2, Feng,
Kamara ×2) all adapt and export with the bone-posed face and pass `vrm_check.py`. Three carry a
second armature (Eliza 2, Kamara ×2 hair; Harley 5 pants) — the §24 fix handles them.

### "Include Morphs" exported no morphs

Every one of the twelve imports with **zero** shape keys, and the raw FBX bytes contain no
`BlendShape` node at all (skin `Deformer`/`Cluster` nodes are there, so the search works). Daz's
FBX exporter writes only the morphs a rule in *Edit Morph Export Rules* marks *Export*; ticking
*Morphs* alone writes none. So the Genesis 8.1 FACS face (a renaming job, like CC's ARKit set) is
still blocked on a re-export with a `facs` rule. **[R]** FACS controls partly drive face *bones*;
an FBX morph is vertex deltas only, so how much of each expression survives is to be measured on
the first such export.

### Arm twist: measured, then split with node constraints

A VRM player rotates only humanoid bones; on a Daz arm those are the **bend** bones, so a forearm
roll lands at the elbow. Measured on Feng (G8.1), 90° roll, mean limb radius per slice vs rest,
worst slice (Blender, then the same numbers in three-vrm):

| twist goes on | forearm | upper arm | thigh |
|---|---|---|---|
| bend bone (today) | 0.77 (at the elbow) | 0.77 (shoulder) | 0.92 |
| twist bone only (Daz's intent) | 0.71 (mid-limb) | 0.71 | 0.74 |
| **45° + 45° split** | **0.92** | **0.92** | 0.92 |
| 30° + 60° | 0.87 | 0.87 | 0.87 |

So moving the roll to Daz's twist bone is *worse* under three.js's linear-blend skinning; only
splitting it helps, and thighs need nothing. `vrm_export.py --twist-split` (module
`twist_split.py`) restructures each arm limb: `<bend>_pre` (limb-aligned) → `<bend>_drv` (the new
humanoid bone; the twist bone hangs under it) and `<bend>_swing` (aim at the limb end → swing
without roll) → the bend bone (roll 0.5 from `_drv`). Two exporter traps on the way: it drops
non-deform, non-humanoid bones (helpers are marked deform; no vertex group names them), and it
writes its own frame for non-humanoid bones (Feng's forearm `_pre` came out 31° off the limb),
so after export `_pre` is turned onto the limb, its children keep their world rest, and the bend
bone's inverse bind matrix is rewritten — all four limbs then land on `rollAxis`/`aimAxis` Y.

Verified in three-vrm 3.5.5: forearm and upper arm 0.92 / 0.92 (Harley G3: 0.91 / 0.92); pure
elbow bend identical to the plain export within the exporter's own rest noise (≤ 1.3 mm skinned —
the plain export already has 2–7 mm joint rest-vs-bind offsets, which the split's rewritten bind
matrices take to 0 on the bend bones); constraints survive `glb_web.py`; `check.html` passes.
Looked at: the elbow pinch under a 90° roll is gone. **Opt-in** because a player without node
constraints never poses the bend bones — elbow and shoulder regions would stay straight.

`--max-texture 2048` is the other max-tier lever: Harley 1 at 2048 = 52.9 MB vs 37.1 MB at 1024.

### Fixed 2026-10-22: max-tier VRM failed the Khronos validator [V]

`_realign` chains float32 parent rotations, so the quaternions it wrote for `_pre`/`_swing`/bend
nodes had |q| up to 1 + 1e-6 (`VALUE_NOT_IN_RANGE /nodes/165/rotation/3 1.0000014`). three-vrm
loaded it, `vrm_check.py` passed it, only `tools/validate` (gltf-validator) caught it.
Written rotations are now renormalised (`_unit`); Alice max: 0 errors.

## 26. Genesis 8.1 FACS morphs → ARKit 52 [V] — 2026-10-20

`imports/DAZ/8.1/kamara_03.fbx` was exported with a `facs` rule set to *Export* in Daz's Edit Morph
Export Rules: 445 MB, and **every** mesh (body, lashes, brows, hair, top, skirt) carries the same
166 keys, named `<mesh>__facs_<family>_<Name>`. On the body: 17 `facs_jnt_*`, 55 `facs_ctrl_*`,
47 `facs_bs_*`, 47 `facs_cbs_*` (33 of those empty at base resolution).

**Daz bakes bone-driven morphs to vertex deltas.** `facs_jnt_EyeBlinkLeft` closes the lid 1.24 cm
over 389 verts, `facs_jnt_JawOpen` moves 2,880 verts by 3.4 cm with the lower teeth, and the
`facs_ctrl_v*` viseme controls are whole shapes (vAA 3,272 verts). So the §25 caveat does not bite:
the FBX morphs are complete.

`adapt_daz.py` step 4b mixes them: per ARKit shape the `bs_` sculpt, or `jnt_` + its own `cbs_<same>_div2`
corrective (blink, wide, look up/down, jaw open/left/right/forward); browInnerUp and cheekPuff sum
both sides; visemes aa/ih/ou/ee/oh = `ctrl_vAA/vIY/vUW/vEH/vOW`. Pairwise correctives
(`cbs_EBL_NSL` = blink × sneer) need two inputs and are dropped. Result: 52 ARKit + 5 visemes,
`Left` on the character's left (+x, checked), every source `facs_` key removed. Without FACS keys
the adapter falls back to posing face bones, unchanged.

Two fixes found on the way: **mesh renaming split on `_`**, so `Genesis8_1FemaleEyelashes` became
`Genesis8`, missed the `lash` face-part match and stayed open through every blink on *all* 8.1
exports (bone path too; visible on Kamara 02); now only a trailing `_<digits>`/`.Shape` is cut. And
**baked keys carry float noise** on every conformed vertex — 35 of 57 keys moved the brows < 0.2 mm
yet were nonzero almost everywhere, which defeats sparse morphs; deltas under 0.05 mm are zeroed and
empty keys dropped (body 1, lashes 30, brows 27).

**Strand brows are the cost.** "Mio Brows" (177,468 verts) genuinely moves on 30 keys, 90k–177k
verts each: 179 MB of a 211 MB VRM before the noise pass, 156 MB after. The finisher's
`--max-mesh-verts` now also reduces meshes *with* shape keys: keys lifted off, `simplify_cards`,
keys put back from the nearest original vertex (exact: simplify only dissolves, worst match 0.000
mm). Brows 177k → 33k at the web cap.

| kamara_03 | desktop | max (2K, twist split, cap 100k) | web (cap 50k + glb_web) |
|---|---|---|---|
| size | 156.1 MB | 106.4 MB | **12.2 MB** |

All pass `vrm_check.py` and `check.html`. Looked at in three-vrm: happy, surprised (brows, wide
eyes, jaw with teeth), angry, and blink + aa — lids close fully, lashes and reduced brows follow;
against the bone-posed Kamara 02 (lashes open through the blink, `aa` a gape). Happy and angry read
milder than the sculpts allow: the finisher's preset weights were tuned on MPFB — left as is.

## 27. "Chrome" clothes: roughness 0 + a height map read as normals [V] — 2026-10-22

`genesis8.1AliceTest_01.fbx` (G8.1, Daz's free basic top and shorts, both solid black from the same
set): top black, shorts chrome. **Not metallic** — every material exports metallic 0. Two import
traps, both in Blender's FBX importer reading Daz's Phong-era FBX:

1. **Roughness 0.** Roughness comes from FBX shininess. Daz writes its default for most surfaces
   (→ 0.553) but maximum shininess for the shorts (→ **0.0**, a perfect mirror). Under plain
   lights it just looks black; under an environment map — what an app uses — it mirrors the room.
   `import_fbx_clean` now floors unmapped roughness at `ROUGHNESS_FLOOR` 0.5.
2. **Bump map wired as a normal map.** The shorts' `01_boyshorts_height` (2048², greyscale, mean
   0.501) is plugged into a Normal Map node. Grey decodes to a zero-length normal: smeared grey
   reflections even at roughness 0.5. Any greyscale image feeding a Normal Map node is now
   converted to a real tangent-space normal map from its slopes (`height_to_normal`, 45° for a
   0→1 rise over 1 % of the texture width, OpenGL +Y), strength 1.

Seen in three-vrm with the viewer's new `?env=room` (RoomEnvironment lighting; without it the bug
is invisible): roughness 0 → chrome; floor alone → glossy grey; floor + normal fix → black fabric
with a soft sheen, matching the top. User-made store clothes that came out chrome are likely the
same two traps. Applies to Daz and CC (shared import).

## 28. Hair pieces left behind: item bones under a skeleton copy [V] — 2026-10-22

Same test figure, store hair "aprilyshCadyHairG8F" (121k verts): in animation, pieces at the top
and sides came loose. The hair ships its own bones — `Fringe A`–`J`, `Left Tail` / `Right Tail` +
A–C — and in the FBX they hang under **`head.003`**, the hair's private copy of the figure's
skeleton (`head.003 <- neckUpper.003 <- …`). Daz poses those copies along with the figure; a VRM
player poses only the humanoid chain, so `head.003` never moves. Turning the head 30° in Blender,
13,197 hair verts (all weighted to fringe/tail bones) moved less than half as far as a rigid
head would. (§14's fold handles *vertex groups* named after copies; these groups are named after
real item bones, so it never fired.)

`import_fbx_clean` now re-parents every non-copy bone whose parent is a copy (`X.00N` with `X` a
real bone) onto `X` — 18 bones here. Lagging verts 13,197 → 275 (nape verts legitimately blended
with the neck). In three-vrm with the head turned: fringe on the forehead, tails follow; before,
the fringe stayed inside the head and the tails hung at rest. Any Daz hair or clothing with its
own bones hits this. Those fringe/tail chains are also exactly what VRM spring bones would swing —
not done yet.

## 29. Spring bones from item bones (`--spring-bones`) [V] — 2026-10-22

`vrm_export.py --spring-bones` (module `spring_bones.py`) turns the bones a hair or clothing item
brings into VRMC_springBone springs with body colliders.

**What an item bone looks like.** On the Alice test hair all 22 are *single* pivots, not chains:
10 `Fringe`, 2 `Bun`, 4 `Wisps`, and `Left/Right Tail` (unweighted helpers) each with three
sibling strands A–C hanging ~30 cm to shoulder height. No vertex is weighted > 0.9 to any of them —
they blend with `head`, so the weights themselves grade the swing along the strand. FBX keeps only
pivots (Blender gives every leaf bone a made-up 16.5 cm tail), so each spring gets a `<bone>_tip`
node at pivot + 1.6 × (weighted centroid − pivot), capped at the farthest weighted vertex
(levers: fringe 12–17 cm, buns 7 cm, tails 30–31 cm). Rule for an item bone: not humanoid, not a
skeleton copy, weighted on a non-body mesh and on no body vertex, and not below a bone that skins
the body — without that last clause CC Ira's `CC_Base_Teeth01/02` (under the jaw) became springs.

**Colliders**, fitted to the body mesh by each vertex's dominant bone's nearest humanoid owner
(owning toes by the thigh gave a 0.42 m thigh capsule): head sphere (r 7.8 cm), neck, upper chest,
shoulders, upper arms, thighs as capsules (r 3.3–6.4 cm), shrunk if any tip would start inside. They
sit on humanoid nodes, so they follow `--twist-split`'s driver bones.

**A three-vrm 3.5.5 loader trap.** The VRM 1.0 spring loader calls `setInitState()` without
updating world matrices first (the VRM 0 path does). A joint whose parent is a plain helper bone
(`Left Tail`) read the helper's stale identity matrix: Tail A's stored tail was 1.73 m off, and the
strand flipped 61 cm on the first frame, settling after ~1 s. Spring roots under such helpers are
now re-parented onto their humanoid ancestor (6 here; the helpers carry no weights). App-side,
`vrm.scene.updateMatrixWorld(); vrm.springBoneManager.reset()` after load also cures it.

Measured with `tools/viewer/spring_test.js` (60 fps fixed step): idle sag 1.8 cm, up to 8.0 cm
swing during a ±40° 1.25 Hz head shake, back to 1.8 cm after; no tip closer than 2.6 cm to the head
collider. Same numbers on the plain, max (2K + twist split) and web files; all pass `check.html`.
Looked at: head tipped 34°, fringe falls across the brow, buns and tails ride the head.
CC: Ira's hair brings no bones, so no springs (correct). Parameters are first guesses (fringe
stiffness 1.6 / drag 0.55; tails 0.9 / 0.45, gravity 0.15) — tune by eye per app.

### Fixed 2026-10-22: CC's upper teeth became a spring [V]

The §29 teeth exclusion (`via_figure`) caught only the lower teeth, which hang off the
jaw. `CC_Base_Teeth01` hangs straight off the head, skins only the teeth mesh, and
qualified as an item bone: Ira got one spring, and her upper teeth would have swung.
Found when the desktop app's runner converted Ira. The rule now treats every mesh
carrying face shape keys as part of the figure (body, teeth with the baked jaw, lashes,
strand brows); bones that skin it are never springs. Ira: 0 springs; Alice: still 22.

## 30. Browser port, Phase 0: ufbx (WASM) reproduces Blender's FBX import exactly [V] — 2026-10-22

The reference harness from docs/BROWSER-PORT.md s2, Level 1, on raw imports: Blender's own
FBX import (`dump_contract.py --raw`) against ufbx 0.23.1 compiled to WASM
(`tools/fbx-spike`, Zig 0.17.0 `zig cc -target wasm32-wasi`) and three.js r185 `FBXLoader`,
both run in headless Chromium. Vertices matched by position + UV, bones by base name.

| Export | Size | ufbx vs Blender | FBXLoader vs Blender |
|---|---|---|---|
| Ira, CC3+ ARKit | 60 MB | **pass**: 101 bones, 56k verts, 443 morphs, 62 images, all exact | pass on geometry; 4 weights per vertex max |
| ALICE-00001a, CC | 63 MB | **pass**, exact | pass |
| Alice G8.1, FACS morphs | 142 MB | **pass**: 365 bones, 169k verts, 1,004 morphs, 16 images, exact | **renderer past 5 GB in 25 s, tab dies** |
| Genesis 3 + Krayon hair | 147 MB | **pass**, exact (135k-vert hair) | pass on geometry; weights differ (4 max) |
| Alice_gen8_02, G8 + Audrey hair + props | 126 MB | **pass**: 511 bones, 512k verts, bone-less chains, exact | **fail**: 363k-vert hair missing, a bone head 107 mm off |
| male2, Genesis 2 | 33 MB | **pass**, exact | pass |

"Exact" means bone heads and vertices at 0.000 mm (worst 0.001 mm), every morph within
0.1 mm, skin weights agreeing (L1 p99 0), embedded images byte-identical. **Bone axes match
Blender's at 0°**: with default settings Blender's importer keeps the FBX bone frames, so
the adapters' face-pose rotation tables port as they are (the plan's first risk, closed).

ufbx parse alone, in Chromium: Alice 578 ms / 794 MB WASM memory (including the copied
file), Alice_gen8_02 211 ms / 512 MB, the G3 108 ms / 565 MB, Ira 85 ms / 243 MB.
FBXLoader took 1–2.6 s on the files it could load and 250 MB–1.4 GB of JS heap.

**Decision: ufbx.** FBXLoader drops data on real exports and cannot hold a FACS export.

Measured constraints for the port:
- **Never densify all morphs.** The harness writes every morph per vertex (350 MB for
  Alice); with the parse that pushed one tab over its limit. The converter keeps ufbx's
  sparse offsets and drops what no expression uses before anything dense is built.
- ufbx splits some vertices more than Blender (RnRNecklace2: 35,767 vs 31,221) with every
  Blender vertex still matched at 0 mm: harmless, but vertex counts are not a check.
- **A dead tab is not reported.** When the renderer died, Playwright's `crash` event and
  `waitForFunction` timeout both stayed silent and the run hung for hours, twice. Every
  harness run sits under a hard `timeout` (`tools/fbx-spike/run_all.sh`).
- `size_t` is 32-bit in wasm32: shifting it by 32 is undefined (it broke the image hash).

## 31. Browser port, Phase 1: the import cleanup in TypeScript equals Blender's [V] — 2026-10-22

`app/src/convert/cleanup.ts` rebuilds what Blender's FBX importer + `common.import_fbx_clean`
hand the adapters, from ufbx's raw import. Judged against `dump_contract.py --clean` with exact
bone names (`tools/port/run_clean.sh`, `contract.mjs --exact`): **all six test exports pass** —
bone names and parents, every vertex, skin weights by full bone name, rigid binds, 217
materials' Principled values (base colour + map, alpha + map + which channel, roughness,
metallic, normal map, strength, made-from-height), every embedded image.

| Export | Armature (bones) | Twins re-parented | Groups folded | Rigid props | Bump → normal | Cleanup |
|---|---|---|---|---|---|---|
| Ira, CC | Armature (101) | 0 | 0 | 0 | 0 | 1.7 s |
| Alice G8.1 | Genesis8_1Female (365) | 18 | 83 | 0 | 2 | 2.8 s |
| Alice_gen8_02, G8 | Genesis8Female (511) | 0 | 192 | Chain1/2 → chestUpper | 16 | 8.0 s |
| Genesis 3 | Genesis3Female (172) | 0 | 0 | 0 | 8 | 3.9 s |
| ALICE-00001a, CC | Armature (101) | 0 | 0 | 0 | 0 | 1.5 s |
| male2, G2 | Genesis (72) | 0 | 0 | 0 | 8 | 1.5 s |

(Node, pure-JS image decoders; most of the time is decoding bump maps for the greyscale test.)

What had to be learned from Blender rather than assumed:
- **Which nodes are bones.** Blender's importer (`find_armatures` / `find_fake_bones`): only
  FBX LimbNodes are bones; their nearest Null/Root parent becomes the armature object (else a
  new `Armature` is inserted — every CC export); inside an armature any other node with bones
  below becomes a bone too. Daz writes the figure and each item root as FBX `Root` nodes, so
  `Genesis8_1Female` is the armature and `Genesis8_1FemaleEyelashes`, the hair root, etc. are
  parentless bones in it. ufbx's "bone" (LimbNode, Root, or any skin-cluster target) is not
  Blender's: the shim now lists every node with its FBX type and the cleanup applies the rule.
- **Copy names.** Blender's `hip.001`, `hip.002`... number a bone's copies in file order within
  the armature (checked on every mesh of both Daz G8/8.1 exports); the figure's own skeleton is
  always the first copy and the body skins only to it. Repeated material names (CC's two
  `Hair_Transparency`) are numbered the same way, so meshes reference materials by index.
- **Images Blender reports.** `channels` is 4 for every image it loads (so `_is_greyscale`'s
  `channels < 3` guard never fires); `depth` is 32 only for 8-bit RGBA PNG and palette PNG with
  tRNS (grey+alpha PNG 16, RGB 24, grey 8, JPEG 8/24). `depth == 32` is when the importer drives
  Alpha from the diffuse image, so the cleanup reads it from the PNG header, no decode.
- **Height → normal** is ported (`images.ts`); a Blender-written fixture pins it to 8-bit
  rounding (vitest). The cleanup marks which bump maps convert; the pixels are produced when
  textures are written (a later phase).
- **Harness**: image bytes made the Alice dump a 400 MB POST, which broke Playwright's
  connection; saves now go in 32 MB pieces. Blender's generated `_normal` images are marked in
  the reference dump and not compared as bytes.

Not covered by any test export: a second armature (an item with its own rig, s24's
`daz_alice_c`). `cleanup.test.ts` builds one by hand and pins the rule, but a real export with
one should be run through `run_clean.sh` when there is one.

## 32. Browser port, Phase 2: the CC adapter in TypeScript equals Blender's [V] — 2026-10-23

`app/src/convert/adaptCc.ts` (+ `pose.ts`) ports `adapt_cc.py` step for step, on top of the
Phase 1 cleanup. Judged against Blender's adapter `.blend` (dumped by `dump_contract.py`) with
exact names (`tools/port/run_adapt.sh cc ...`): **both CC exports pass.**

| Export | Bone heads (T-posed) | Vertices, worst | Keys | Jaw angles | Materials / images | TS adapter | Blender adapter |
|---|---|---|---|---|---|---|---|
| Ira | ≤ 0.041 mm | ≤ 0.036 mm | 126 body, 28 teeth, 47 tongue: all within 0.1 mm | 28 measured + 6 driven, identical to Blender's report | 29 / 61 same | 0.65 s | ~13 s |
| ALICE-00001a | ≤ 0.035 mm | ≤ 0.036 mm | the same | identical | 26 / 50 same | 0.58 s | ~13 s |

The residue is float32 rounding: Blender stores posed coordinates in single precision, the port
computes in double.

Ported as Blender computes it:
- **Skinning** is Blender's armature modifier: weighted bone offsets divided by the vertex's
  total weight; a key's delta deforms by the matrices' linear part with the same weights, which
  equals capturing the key posed (`apply_pose_as_rest`). T-pose: `aim_bone` as shortest-arc
  rotations about each bone's head, applied to the bone and everything below it.
- **Jaw bake**: the chin centroid is over Blender's vertices, not UV-split ones, so the contract
  now carries each split vertex's source vertex (`vertex`). Measured angles are rounded to 0.1°
  like Python's `round` (half to even); that rounded angle drives the teeth/tongue.
- **Opacity rule (2b)** looks images up by Blender's image name, which is the FBX *Texture
  element's* name (`Std_Eyelash_Opacity`, no extension), not the file; the shim lists every
  Texture element for it. Neither test export triggers the rewire, as in Blender.
- Report difference only: `cornea_triangles_removed` (640) counts triangles where Blender's
  `cornea_faces_removed` (320) counts quads.

Not exercised by a real export here: the **Traditional profile** mix (both test exports have
the ARKit set; the earlier Traditional export is no longer in `imports/`) and the **opacity
rewire**. The mapping tables are pinned by `adaptCc.test.ts`; run a Traditional export through
`run_adapt.sh` when one is available.
