"""The VRM finisher: take a rigged humanoid in Blender and export a VRM 1.0.

This is the open-source layer. It assumes only:
  - one armature whose bones can be mapped to the VRM humanoid set,
  - meshes skinned to it,
  - face shape keys named with ARKit-52 and/or Meta viseme names.
Input adapters (MPFB, fitted generated mesh, Daz, CC) are responsible for
producing that; this script does not care where it came from.

    blender --background <char.blend> --python src/blender/vrm_export.py -- out/char.vrm
        [--name "Base"] [--bones mpfb_game_engine]

Steps: humanoid map -> expressions -> lookAt -> first person -> meta ->
limit 4 influences + normalise -> export -> report the add-on's own
validation messages.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import addon_utils
import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import upstream_image  # noqa: E402
from simplify_cards import simplify_cards  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("out")
ap.add_argument("--name", default="image-to-vrm base")
ap.add_argument("--author", default="image-to-vrm")
ap.add_argument("--max-texture", type=int, default=0, help="downscale textures larger than this (0 = keep)")
ap.add_argument("--bones", default="auto", help="bone table name, 'auto' to detect, 'none' for the add-on's mapper")
ap.add_argument("--max-mesh-verts", type=int, default=0,
                help="web tier: decimate meshes WITHOUT shape keys (hair, clothes) above this many verts")
ap.add_argument("--twist-split", action="store_true",
                help="max tier: split arm twist over bend + twist bones via VRMC_node_constraint "
                     "(Daz only; needs a player with node constraints, e.g. three-vrm, UniVRM 1.x)")
ap.add_argument("--spring-bones", action="store_true",
                help="max tier: bones a hair/clothing item brings swing (VRMC_springBone), body colliders")
args = ap.parse_args(argv)

# Installed from extensions.blender.org (Blender 4.2+) or, older, as a legacy add-on.
if not any(addon_utils.enable(m, default_set=True) for m in ("bl_ext.blender_org.vrm", "io_scene_vrm")):
    sys.exit("VRM add-on not found: install 'VRM format' from extensions.blender.org "
             "(blender --command extension install -s -e vrm)")

# VRM humanoid name -> source bone name. The add-on's automatic mapper is used
# only when no table is given; an explicit table is deterministic and
# reviewable, which matters more than convenience in a pipeline.
BONE_TABLES = {
    "mpfb_game_engine": {
        "hips": "pelvis", "spine": "spine_01", "chest": "spine_02",
        "upper_chest": "spine_03", "neck": "neck_01", "head": "head",
        "left_eye": "eye_l", "right_eye": "eye_r",
        "left_shoulder": "clavicle_l", "left_upper_arm": "upperarm_l",
        "left_lower_arm": "lowerarm_l", "left_hand": "hand_l",
        "right_shoulder": "clavicle_r", "right_upper_arm": "upperarm_r",
        "right_lower_arm": "lowerarm_r", "right_hand": "hand_r",
        "left_upper_leg": "thigh_l", "left_lower_leg": "calf_l",
        "left_foot": "foot_l", "left_toes": "ball_l",
        "right_upper_leg": "thigh_r", "right_lower_leg": "calf_r",
        "right_foot": "foot_r", "right_toes": "ball_r",
    },
}


def _mpfb_fingers():
    # VRM thumbs are metacarpal/proximal/distal; other fingers are
    # proximal/intermediate/distal. MPFB numbers every finger 01..03.
    out = {}
    for side, s in (("left", "l"), ("right", "r")):
        for vrm_f, mpfb_f in (("thumb", "thumb"), ("index", "index"), ("middle", "middle"),
                              ("ring", "ring"), ("little", "pinky")):
            segs = (("metacarpal", "proximal", "distal") if vrm_f == "thumb"
                    else ("proximal", "intermediate", "distal"))
            for seg, n in zip(segs, ("01", "02", "03")):
                out[f"{side}_{vrm_f}_{seg}"] = f"{mpfb_f}_{n}_{s}"
    return out


BONE_TABLES["mpfb_game_engine"].update(_mpfb_fingers())

# Daz Genesis 3 and 8 share this naming. Twist bones (lShldrTwist,
# lForearmTwist, lThighTwist), abdomenUpper, neckUpper, lMetatarsals and the
# lCarpal bones sit between humanoid bones, which VRM 1.0 allows.
BONE_TABLES["daz_genesis3_8"] = {
    "hips": "hip", "spine": "abdomenLower", "chest": "chestLower", "upper_chest": "chestUpper",
    "neck": "neckLower", "head": "head", "left_eye": "lEye", "right_eye": "rEye",
    **{f"{side}_{vrm}": f"{s}{daz}" for side, s in (("left", "l"), ("right", "r"))
       for vrm, daz in (("shoulder", "Collar"), ("upper_arm", "ShldrBend"), ("lower_arm", "ForearmBend"),
                        ("hand", "Hand"), ("upper_leg", "ThighBend"), ("lower_leg", "Shin"),
                        ("foot", "Foot"), ("toes", "Toe"))},
}


def _daz_fingers():
    out = {}
    for side, s in (("left", "l"), ("right", "r")):
        for vrm_f, daz_f in (("thumb", "Thumb"), ("index", "Index"), ("middle", "Mid"),
                             ("ring", "Ring"), ("little", "Pinky")):
            segs = (("metacarpal", "proximal", "distal") if vrm_f == "thumb"
                    else ("proximal", "intermediate", "distal"))
            for seg, n in zip(segs, "123"):
                out[f"{side}_{vrm_f}_{seg}"] = f"{s}{daz_f}{n}"
    return out


BONE_TABLES["daz_genesis3_8"].update(_daz_fingers())

# Character Creator 3/3+ (CC_Base_*). Twist/ShareBone/RibsTwist bones sit
# between humanoid bones; NeckTwist01 is the neck proper.
BONE_TABLES["cc3"] = {
    "hips": "CC_Base_Hip", "spine": "CC_Base_Waist", "chest": "CC_Base_Spine01",
    "upper_chest": "CC_Base_Spine02", "neck": "CC_Base_NeckTwist01", "head": "CC_Base_Head",
    "left_eye": "CC_Base_L_Eye", "right_eye": "CC_Base_R_Eye",
}
for _side, _s in (("left", "L"), ("right", "R")):
    for _vrm, _cc in (("shoulder", "Clavicle"), ("upper_arm", "Upperarm"), ("lower_arm", "Forearm"),
                      ("hand", "Hand"), ("upper_leg", "Thigh"), ("lower_leg", "Calf"),
                      ("foot", "Foot"), ("toes", "ToeBase")):
        BONE_TABLES["cc3"][f"{_side}_{_vrm}"] = f"CC_Base_{_s}_{_cc}"
    for _vf, _cf in (("thumb", "Thumb"), ("index", "Index"), ("middle", "Mid"), ("ring", "Ring"), ("little", "Pinky")):
        _segs = (("metacarpal", "proximal", "distal") if _vf == "thumb"
                 else ("proximal", "intermediate", "distal"))
        for _seg, _n in zip(_segs, "123"):
            BONE_TABLES["cc3"][f"{_side}_{_vf}_{_seg}"] = f"CC_Base_{_s}_{_cf}{_n}"


def detect_bone_table(bone_names):
    if "CC_Base_Hip" in bone_names:
        return "cc3"
    if "lShldrBend" in bone_names and "lEyelidUpper" in bone_names:
        return "daz_genesis3_8"
    if "upperarm_l" in bone_names and "pelvis" in bone_names:
        return "mpfb_game_engine"
    return None

# VRM preset -> {shape key: weight}. Visemes use the Meta viseme shapes when
# present: the add-on's ARKit fallback makes `aa` a bare 50% jaw drop, which
# reads as a gape rather than a vowel. Emotions are deliberately stronger than
# the add-on's defaults (happy = smile 0.5 alone is barely visible).
PRESETS = {
    "aa": {"viseme_aa": 1.0},
    "ih": {"viseme_I": 1.0},
    "ou": {"viseme_U": 1.0},
    "ee": {"viseme_E": 1.0},
    "oh": {"viseme_O": 1.0},
    "blink": {"eyeBlinkLeft": 1.0, "eyeBlinkRight": 1.0},
    "blink_left": {"eyeBlinkLeft": 1.0},
    "blink_right": {"eyeBlinkRight": 1.0},
    "happy": {"mouthSmileLeft": 0.8, "mouthSmileRight": 0.8, "cheekSquintLeft": 0.5,
              "cheekSquintRight": 0.5, "eyeSquintLeft": 0.3, "eyeSquintRight": 0.3},
    "angry": {"browDownLeft": 0.9, "browDownRight": 0.9, "mouthFrownLeft": 0.4,
              "mouthFrownRight": 0.4, "noseSneerLeft": 0.4, "noseSneerRight": 0.4},
    "sad": {"browInnerUp": 0.8, "mouthFrownLeft": 0.6, "mouthFrownRight": 0.6},
    "relaxed": {"mouthSmileLeft": 0.3, "mouthSmileRight": 0.3,
                "eyeSquintLeft": 0.2, "eyeSquintRight": 0.2},
    "surprised": {"browInnerUp": 0.8, "browOuterUpLeft": 0.8, "browOuterUpRight": 0.8,
                  "eyeWideLeft": 0.6, "eyeWideRight": 0.6, "jawOpen": 0.35},
}
# Emotions that should suppress blinking / mouth shapes while active.
OVERRIDES = {"happy": ("blend", "none"), "surprised": ("block", "none")}

armature = next(o for o in bpy.data.objects if o.type == "ARMATURE")
ext = armature.data.vrm_addon_extension
ext.spec_version = "1.0"
vrm1 = ext.vrm1
meshes = [o for o in bpy.data.objects if o.type == "MESH" and o.parent == armature]
report = {"armature": armature.name, "meshes": [m.name for m in meshes]}

# --- 1. humanoid -------------------------------------------------------------
table_name = detect_bone_table({b.name for b in armature.data.bones}) if args.bones == "auto" else args.bones
report["bone_table"] = table_name
table = BONE_TABLES.get(table_name)
spring_spec = None
if args.spring_bones and table:
    from spring_bones import prepare  # noqa: E402
    spring_spec, report["spring_bones"] = prepare(armature, meshes, table)
if args.twist_split:
    from twist_split import restructure  # noqa: E402
    twist_remap = restructure(armature, table_name)
    if not twist_remap:
        raise SystemExit(f"--twist-split: no limb chains for bone table {table_name}")
    table = {**table, **twist_remap}
    report["twist_split"] = twist_remap
if table:
    hb = vrm1.humanoid.human_bones
    missing = []
    for vrm_name, bone in table.items():
        if bone in armature.data.bones:
            getattr(hb, vrm_name).node.bone_name = bone
        else:
            missing.append(f"{vrm_name}<-{bone}")
    report["humanoid_missing"] = missing
else:
    bpy.ops.vrm.assign_vrm1_humanoid_human_bones_automatically(armature_object_name=armature.name)
    report["humanoid_missing"] = "auto"

# --- 2. expressions ----------------------------------------------------------
# ARKit customs first (52 PerfectSync expressions for face-tracking apps), then
# replace the presets with ours.
bpy.ops.vrm.assign_vrm1_expressions_from_arkit(armature_object_name=armature.name)
has_key = {}
for m in meshes:
    if m.data.shape_keys:
        for kb in m.data.shape_keys.key_blocks[1:]:
            has_key.setdefault(kb.name, []).append(m.name)

preset_report = {}
for preset, weights in PRESETS.items():
    expr = getattr(vrm1.expressions.preset, preset)
    expr.morph_target_binds.clear()
    n = 0
    for key, w in weights.items():
        for mesh_name in has_key.get(key, []):
            b = expr.morph_target_binds.add()
            b.node.mesh_object_name = mesh_name
            b.index = key
            b.weight = w
            n += 1
    if preset in OVERRIDES:
        expr.override_blink, expr.override_mouth = OVERRIDES[preset]
    preset_report[preset] = n
report["preset_binds"] = preset_report
report["custom_expressions"] = len(vrm1.expressions.custom)

# --- 2b. drop shape keys no expression uses ------------------------------------
# glTF stores morphs densely; CC3 carries ~70 legacy morphs on top of ARKit 52
# and they cost more than the whole mesh (CC3 VRM: 88 MB before pruning).
bound = set()
for expr in list(vrm1.expressions.custom) + [getattr(vrm1.expressions.preset, p) for p in PRESETS]:
    for b in expr.morph_target_binds:
        bound.add((b.node.mesh_object_name, b.index))
pruned = 0
for m in meshes:
    ks = m.data.shape_keys
    if not ks:
        continue
    for kb in list(ks.key_blocks[1:]):
        if (m.name, kb.name) not in bound:
            m.shape_key_remove(kb)
            pruned += 1
    if len(m.data.shape_keys.key_blocks) == 1:
        m.shape_key_clear()
report["shape_keys_pruned"] = pruned

# --- 2c. web tier: decimate heavy meshes ------------------------------------------
# Daz hair is the biggest mesh on a figure (G8 "Audrey": 363k verts, 18 MB of a
# 28 MB web file). Runs before step 7a so the fringe pass copies the DECIMATED
# core and stays byte-identical to it.
#
# A mesh WITH shape keys above the cap (Daz strand brows: 177k verts carrying
# 22 dense face keys = 179 MB) is reduced the same way with its keys lifted off
# first and put back from the nearest original vertex. simplify_cards only
# dissolves vertices, so every survivor maps onto itself exactly.
def _decimate_keyed(m, budget):
    import numpy as np
    from mathutils.kdtree import KDTree
    ks = m.data.shape_keys
    n = len(m.data.vertices)
    base = np.empty(n * 3, np.float32)
    ks.key_blocks[0].data.foreach_get("co", base)
    base = base.reshape(-1, 3)
    keys = []
    for kb in ks.key_blocks[1:]:
        co = np.empty(n * 3, np.float32)
        kb.data.foreach_get("co", co)
        keys.append((kb.name, co.reshape(-1, 3) - base))
    m.shape_key_clear()
    out = simplify_cards(m, budget)
    tree = KDTree(n)
    for i, p in enumerate(base):
        tree.insert(p, i)
    tree.balance()
    new = np.empty(len(m.data.vertices) * 3, np.float32)
    m.data.vertices.foreach_get("co", new)
    new = new.reshape(-1, 3)
    near = np.array([tree.find(p)[1] for p in new])
    worst = float(np.linalg.norm(base[near] - new, axis=1).max())
    m.shape_key_add(name="Basis", from_mix=False)
    for name, d in keys:
        kb = m.shape_key_add(name=name, from_mix=False)
        kb.value = 0.0
        kb.data.foreach_set("co", (new + d[near]).ravel())
    return {**(out if isinstance(out, dict) else {"result": out}), "keys": len(keys),
            "worst_match_mm": round(worst * 1000, 3)}


if args.max_mesh_verts:
    dec = {}
    for m in meshes:
        n = len(m.data.vertices)
        if n <= args.max_mesh_verts:
            continue
        bpy.ops.object.select_all(action="DESELECT")
        m.select_set(True)
        bpy.context.view_layer.objects.active = m
        # Hair is thousands of textured ribbons: collapse decimation crumpled
        # them into spikes, planar dissolve made the G8 braid vanish (both
        # verified in three-vrm). simplify_cards removes whole cross-sections.
        dec[m.name] = (_decimate_keyed(m, args.max_mesh_verts) if m.data.shape_keys
                       else simplify_cards(m, args.max_mesh_verts))
    report["decimated"] = dec

# --- 3. lookAt: bone type, offset = eye midpoint relative to head ------------
bones = armature.data.bones
eye_names = next(((a, b) for a, b in (("eye_l", "eye_r"), ("lEye", "rEye"), ("CC_Base_L_Eye", "CC_Base_R_Eye"))
                  if a in bones and b in bones), None)
head_name = table.get("head", "head") if table else "head"
if eye_names:
    mid = (bones[eye_names[0]].head_local + bones[eye_names[1]].head_local) / 2
    off = mid - bones[head_name].head_local
    vrm1.look_at.type = "bone"
    # The add-on (>= 2.20) stores this in glTF axes (Y up, Z forward) and
    # exports it raw. Writing Blender axes put the gaze origin 8 cm BELOW the
    # head bone on Genesis 8, so every target read as far above: the eyes rolled
    # down under the lids and looked blank in three-vrm (verified).
    vrm1.look_at.offset_from_head_bone = (off.x, off.z, -off.y)
    report["look_at_offset_gltf"] = [round(c, 4) for c in (off.x, off.z, -off.y)]
    # The default range map outputs at most ~10 deg, so a target 45 deg to
    # the side turned the eyes only ~5 deg in three-vrm (measured). Real eyes
    # reach ~30-35 deg horizontally; stay a little inside that so the iris
    # never slides under the lids.
    # three-vrm maps linearly and clamps: a 45 deg target with (90 -> 25)
    # gave exactly 12.8 deg, left and right alike. Saturate earlier instead.
    for name, inp, scale in (("range_map_horizontal_inner", 60.0, 25.0),
                             ("range_map_horizontal_outer", 60.0, 25.0),
                             ("range_map_vertical_up", 45.0, 15.0),
                             ("range_map_vertical_down", 45.0, 15.0)):
        rm = getattr(vrm1.look_at, name)
        rm.input_max_value = inp
        rm.output_scale = scale

# --- 4. first person ---------------------------------------------------------
vrm1.first_person.mesh_annotations.clear()
for m in meshes:
    a = vrm1.first_person.mesh_annotations.add()
    a.node.mesh_object_name = m.name
    # "auto": the runtime drops head-weighted triangles for the first-person
    # camera. Name-based rules broke once meshes were mixed (a transplanted head,
    # grafted hands): anything not called *.body would have vanished.
    a.type = "auto"

# --- 5. meta -----------------------------------------------------------------
meta = vrm1.meta
meta.vrm_name = args.name
meta.authors.clear()
meta.authors.add().value = args.author
meta.license_url = "https://vrm.dev/licenses/1.0/"
meta.avatar_permission = "everyone"
meta.commercial_usage = "corporation"
meta.allow_redistribution = True
meta.modification = "allowModificationRedistribution"
meta.credit_notation = "unnecessary"

# --- 6. skin weights: <=4 influences, normalised ------------------------------
for m in meshes:
    bpy.ops.object.select_all(action="DESELECT")
    m.select_set(True)
    bpy.context.view_layer.objects.active = m
    deform = {vg.index for vg in m.vertex_groups if vg.name in bones}
    if not deform:
        # A prop nothing skinned (not even a rigid bind) has no vertex groups,
        # and `vertex_group_limit_total.poll()` fails on such an object:
        # "Object has no vertex groups". Leave it alone and record it; the
        # glTF exporter writes it as a static node.
        report.setdefault("influences", {})[m.name] = {
            "max_before": 0, "max_after": 0, "unweighted": len(m.data.vertices), "skinned": False}
        continue
    before = max((sum(1 for g in v.groups if g.group in deform) for v in m.data.vertices), default=0)
    bpy.ops.object.vertex_group_limit_total(group_select_mode="BONE_DEFORM", limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode="BONE_DEFORM", lock_active=False)
    after = max((sum(1 for g in v.groups if g.group in deform) for v in m.data.vertices), default=0)
    unweighted = sum(1 for v in m.data.vertices if not any(g.group in deform and g.weight > 0 for g in v.groups))
    report.setdefault("influences", {})[m.name] = {"max_before": before, "max_after": after,
                                                   "unweighted": unweighted}

# --- 7. materials: OPAQUE unless the texture really has cut-outs ------------
# MakeSkin wires texture alpha into the BSDF on EVERY material, so the glTF
# exporter marks all of them alphaMode BLEND. three.js then depth-sorts the
# body as transparent and the teeth and eyeballs draw straight through the
# face (verified: holes around eyes and lips in three-vrm, fine in Blender).
# Rule: sample the base-colour alpha; real cut-outs (lashes, brows, hair
# cards) become MASK via a Greater-Than node, which the exporter maps to
# alphaCutoff; everything else loses its alpha link and exports OPAQUE.
import bmesh  # noqa: E402
import numpy as np  # noqa: E402

# A cut-out texture counts as "strands" when more than this share of its
# visible texels is partly transparent. Measured: hair 0.42-1.0, lashes and
# brows 0.35-1.0, Krayon scalp 0.18 (at 0.25 its hairline stayed a hard edge);
# lace 0.12 stays a plain cut-out.
SOFT_SHARE = 0.15
CORE_CUTOFF = 0.5
fringe_of = {}
mat_report = {}
for mat in {s.material for m in meshes for s in m.material_slots if s.material}:
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None) if nt else None
    if bsdf is None:
        continue
    alpha_in = bsdf.inputs["Alpha"]
    tex = next((l.from_node for l in alpha_in.links if l.from_node.type == "TEX_IMAGE"), None)
    base_in = bsdf.inputs["Base Color"]
    # Search THROUGH intermediate nodes: MakeSkin feeds base colour via mix
    # nodes, and a direct-link-only check read that as "no colour texture",
    # flattened the MPFB skin to one colour and cut it with its alpha (verified:
    # a transplanted head exported as a flat teal mask with the teeth showing).
    base_tex = upstream_image(base_in)
    merged = False
    # Which output drives Alpha decides what opacity IS: an opacity map's grey
    # level (Color) or the image's own alpha channel (Alpha). CC3 wires a `.001`
    # copy of the tongue/brow-base diffuse by its Alpha output; reading its
    # grey level cut 31% of the tongue away.
    from_alpha = any(l.from_socket.name == "Alpha" for l in alpha_in.links)
    if tex and tex.image and (base_tex is None or base_tex.image != tex.image):
        # Separate opacity map (Daz hair and lashes): glTF can only take alpha
        # from the base-colour texture, so merge it in. For a map wired by its
        # Color output, opacity is its grey level (its alpha channel is all 1.0).
        op = tex.image
        w, h = (base_tex.image.size if base_tex and base_tex.image else op.size)
        opx = np.empty(op.size[0] * op.size[1] * 4, dtype=np.float32)
        op.pixels.foreach_get(opx)
        opx = opx.reshape(op.size[1], op.size[0], 4)
        if (op.size[0], op.size[1]) != (w, h):
            ys = (np.arange(h) * op.size[1] // h)
            xs = (np.arange(w) * op.size[0] // w)
            opx = opx[ys][:, xs]
        if base_tex and base_tex.image:
            rgba = np.empty(w * h * 4, dtype=np.float32)
            base_tex.image.pixels.foreach_get(rgba)
            rgba = rgba.reshape(h, w, 4)
        else:
            rgba = np.ones((h, w, 4), dtype=np.float32)
            rgba[..., :3] = base_in.default_value[:3]
            # Daz G8 lashes: white base factor + opacity map only (their colour
            # lives in Iray settings the FBX drops) -> rendered as white lashes.
            if any(k in mat.name.lower() for k in ("lash", "brow")) and min(base_in.default_value[:3]) > 0.6:
                rgba[..., :3] = (0.05, 0.04, 0.035)
        rgba[..., 3] = opx[..., 3] if from_alpha else opx[..., :3].mean(axis=2)
        img = bpy.data.images.new(f"{mat.name}_rgba", w, h, alpha=True)
        img.pixels.foreach_set(rgba.ravel())
        img.pack()
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = img
        uv_src = next((l.from_socket for l in (base_tex or tex).inputs["Vector"].links), None)
        if uv_src is not None:
            nt.links.new(uv_src, node.inputs["Vector"])
        nt.links.new(node.outputs["Color"], base_in)
        tex = node
        merged = True
    frac_clear = soft = 0.0
    if tex and tex.image and tex.image.channels == 4:
        px = np.empty(len(tex.image.pixels), dtype=np.float32)
        tex.image.pixels.foreach_get(px)
        a = px[3::4]
        frac_clear = float((a < 0.5).mean())
        # share of the visible texels that are partly transparent
        vis = a >= 0.05
        soft = float(((a < 0.95) & vis).sum() / max(1, vis.sum()))
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = 0.0  # MakeSkin's clearcoat reads as plastic
    for l in list(alpha_in.links):
        nt.links.remove(l)
    alpha_in.default_value = 1.0
    fringe = None
    if tex and frac_clear > 0.01 and soft > SOFT_SHARE:
        # Strand textures: hair cards, lashes, brows. See step 7a.
        fringe = mat.copy()
        fringe.name = f"{mat.name}.fringe"
        fnt = fringe.node_tree
        fb = next(n for n in fnt.nodes if n.type == "BSDF_PRINCIPLED")
        ftex = fnt.nodes[tex.name]
        fnt.links.new(ftex.outputs["Alpha"], fb.inputs["Alpha"])
        fringe.surface_render_method = "BLENDED"
        fringe_of[mat.name] = fringe
    if tex and frac_clear > 0.01:
        gt = nt.nodes.new("ShaderNodeMath")
        gt.operation = "GREATER_THAN"
        gt.inputs[1].default_value = CORE_CUTOFF if fringe else 0.5
        nt.links.new(tex.outputs["Alpha"], gt.inputs[0])
        nt.links.new(gt.outputs[0], alpha_in)
        mode = "MASK+BLEND" if fringe else "MASK"
    else:
        mode = "OPAQUE"
    mat.surface_render_method = "DITHERED"
    mat_report[mat.name] = {"mode": mode, "clear_texels": round(frac_clear, 3), "soft_share": round(soft, 2),
                            **({"merged_opacity": True} if merged else {})}
report["materials"] = mat_report

# --- 7a. soft strands: opaque core + blended fringe ---------------------------
# Daz/CC hair is drawn for Iray as layers of semi-transparent cards: on Genesis
# 8 "Audrey" hair NO texel is fully opaque (measured). A 0.5 cutoff kept only
# the densest strand centres -- stringy braids, a hard hairline, a helmet-like
# scalp cap (verified in three-vrm). Plain BLEND alone has no depth, so inner
# layers paint over outer ones. Standard real-time fix, two passes over the
# same faces: the core (MASK, writes depth) gives the shape and correct
# occlusion; a BLEND copy (three.js draws it after all opaque geometry, depth
# test on, depth write off) adds the soft strand edges below the cutoff.
# The copy lives in the SAME mesh, so it inherits weights, shape keys and
# expression binds; it exports as a second primitive of that mesh.
fringe_report = {}
for m in meshes:
    slots = {i: fringe_of[s.material.name] for i, s in enumerate(m.material_slots)
             if s.material and s.material.name in fringe_of}
    if not slots:
        continue
    remap = {}
    for i, fm in slots.items():
        m.data.materials.append(fm)
        remap[i] = len(m.data.materials) - 1
    bpy.ops.object.select_all(action="DESELECT")
    m.select_set(True)
    bpy.context.view_layer.objects.active = m
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_mode(type="FACE")
    bm = bmesh.from_edit_mesh(m.data)
    for f in bm.faces:
        f.select_set(f.material_index in slots)
    bm.select_flush_mode()
    bmesh.update_edit_mesh(m.data)
    bpy.ops.mesh.duplicate()
    bm = bmesh.from_edit_mesh(m.data)
    n = 0
    for f in bm.faces:
        if f.select:
            f.material_index = remap[f.material_index]
            n += 1
    bmesh.update_edit_mesh(m.data)
    bpy.ops.object.mode_set(mode="OBJECT")
    fringe_report[m.name] = n
report["fringe_faces"] = fringe_report

# --- 7b. texture budget ---------------------------------------------------------
# Daz ships a 4K map per body part; with the exporter writing PNG that was
# 222 MB for one Genesis 3 figure. Tier budgets are 2K (web) / 4K (desktop).
if args.max_texture:
    shrunk = 0
    for mat in {s.material for m in meshes for s in m.material_slots if s.material}:
        for n in (mat.node_tree.nodes if mat.node_tree else []):
            img = getattr(n, "image", None)
            if img and max(img.size) > args.max_texture:
                f = args.max_texture / max(img.size)
                img.scale(max(1, int(img.size[0] * f)), max(1, int(img.size[1] * f)))
                shrunk += 1
    report["textures_downscaled"] = shrunk

# --- 8. export ---------------------------------------------------------------
out = os.path.abspath(args.out)
os.makedirs(os.path.dirname(out), exist_ok=True)
# Sparse morph targets: a face shape moves a few hundred of a mesh's verts, and
# dense glTF morphs store every vertex for every key.
res = bpy.ops.export_scene.vrm(filepath=out, armature_object_name=armature.name,
                               ignore_warning=True, check_existing=False,
                               export_try_sparse_sk=True)
report["export"] = sorted(res)
if os.path.exists(out):
    # the fringe pass (7a) is a byte-identical copy of its core: store it once
    from glb_dedupe import dedupe_file  # noqa: E402
    report["dedupe"] = dedupe_file(out)
    if args.twist_split:
        from twist_split import add_constraints  # noqa: E402
        report["twist_constraints"] = add_constraints(out, table_name)
    if spring_spec and spring_spec["springs"]:
        from spring_bones import add_springs  # noqa: E402
        report["spring_export"] = add_springs(out, spring_spec)
report["bytes"] = os.path.getsize(out) if os.path.exists(out) else 0
print("RESULT " + json.dumps(report))  # one line: the app reads it
if not report["bytes"]:
    raise SystemExit("export produced no file")
