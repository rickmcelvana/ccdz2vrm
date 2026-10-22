"""Character Creator 3 adapter: a CC3+ FBX export -> the finisher's contract.

    blender --background --python src/blender/adapt_cc.py -- in.Fbx out/cc.blend [--name ira]

CC3+ already ships what VRM needs as shape keys: the full ARKit 52 set named
`A01_Brow_Inner_Up` ... `A51_Mouth_Stretch_Right` (+ `A52_Tongue_Out` on the
tongue) and 8 lip-sync visemes (`Open`, `Wide`, `Tight-O`, ...). So this is
mostly renaming. A character on CC3's Traditional facial profile has no `A01_`
set, only the 60 older morphs (`Eye_Blink_L`, `Mouth_Smile_L`, ...); those are
mixed into the ARKit names instead (step 4b). Two things are not free:

1. **Teeth and tongue have no jaw morphs.** In CC the jaw BONE moves them; the
   skin morph alone opens the lips onto a closed set of teeth. For every face
   key that drops the chin, measure the drop as a rotation about the jaw pivot
   and bake that jaw rotation into the teeth/tongue under the same key name.
2. **A-pose.** CC3 rests with arms ~30 deg down; T-pose via common.tpose_arms,
   which keeps all ~120 morphs exact.

Overlay meshes (eye occlusion, tear line) and the cornea shell are removed:
they are blended transparency layers, which glTF MASK/OPAQUE would paint solid.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import import_fbx_clean, tpose_arms  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:]
ap = argparse.ArgumentParser()
ap.add_argument("fbx")
ap.add_argument("out")
ap.add_argument("--name", default="cc")
args = ap.parse_args(argv)
report = {}

# --- 1. import -----------------------------------------------------------------
rig, meshes, rigid = import_fbx_clean(args.fbx)
report["rigid_bound"] = rigid
bones = {b.name for b in rig.data.bones}
if "CC_Base_Hip" not in bones:
    raise SystemExit("not a CC3 rig (no CC_Base_Hip)")
body = next(o for o in meshes if o.name.startswith("CC_Base_Body"))

# --- 2. drop transparent overlays ------------------------------------------------
for o in [o for o in meshes if re.match(r"CC_Base_(EyeOcclusion|TearLine)", o.name)]:
    meshes.remove(o)
    bpy.data.objects.remove(o, do_unlink=True)
removed = 0
for o in meshes:
    idx = {i for i, s in enumerate(o.material_slots) if s.material and "cornea" in s.material.name.lower()}
    if idx:
        bm = bmesh.new()
        bm.from_mesh(o.data)
        dead = [f for f in bm.faces if f.material_index in idx]
        bmesh.ops.delete(bm, geom=dead, context="FACES")
        bm.to_mesh(o.data)
        bm.free()
        removed += len(dead)
report["cornea_faces_removed"] = removed

# --- 2b. opacity maps the importer left unwired ----------------------------------
# CC embeds `<material>_Opacity`, but Blender's FBX importer can wire Alpha from
# the diffuse's own (all-opaque) alpha instead: the lashes then export as solid
# strips (verified on a Traditional-profile export in three-vrm). If the wired
# alpha has no clear texels, wire the opacity map by its Color (grey level);
# the finisher merges it into the base colour.
rewired = []
for mat in {s.material for o in meshes for s in o.material_slots if s.material and s.material.node_tree}:
    op = bpy.data.images.get(f"{mat.name}_Opacity")
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if op is None or bsdf is None:
        continue
    a_in = bsdf.inputs["Alpha"]
    src = next((l.from_node for l in a_in.links if l.from_node.type == "TEX_IMAGE"), None)
    if src is not None and src.image is not None:
        if src.image == op:
            continue
        px = np.empty(len(src.image.pixels), dtype=np.float32)
        src.image.pixels.foreach_get(px)
        if src.image.channels == 4 and (px[3::4] < 0.5).mean() > 0.01:
            continue  # the wired alpha already cuts something out
    node = mat.node_tree.nodes.new("ShaderNodeTexImage")
    node.image = op
    for l in list(a_in.links):
        mat.node_tree.links.remove(l)
    mat.node_tree.links.new(node.outputs["Color"], a_in)
    rewired.append(mat.name)
report["opacity_rewired"] = sorted(rewired)

# --- 3. T-pose -------------------------------------------------------------------
report["arm_drop_deg"] = tpose_arms(rig, meshes, [
    ("CC_Base_L_Upperarm", "CC_Base_L_Forearm", "CC_Base_L_Hand", 1),
    ("CC_Base_R_Upperarm", "CC_Base_R_Forearm", "CC_Base_R_Hand", -1)])

# --- 4. rename ARKit keys: A25_Jaw_Open -> jawOpen ----------------------------------
def arkit_name(n):
    m = re.match(r"^A\d\d_(.+)$", n)
    if not m:
        return None
    parts = m.group(1).split("_")
    return parts[0].lower() + "".join(p.capitalize() for p in parts[1:])


renamed = 0
for o in meshes:
    if not o.data.shape_keys:
        continue
    for kb in o.data.shape_keys.key_blocks[1:]:
        new = arkit_name(kb.name)
        if new and new not in o.data.shape_keys.key_blocks:
            kb.name = new
            renamed += 1
report["arkit_renamed"] = renamed

# --- 4b. no ARKit set: build it from CC3's traditional 60 morphs ------------------
# A CC3 character on the Traditional facial profile exports only `Eye_Blink_L`,
# `Mouth_Smile_L`, ... (no `A01_`). Mix those into the ARKit names the finisher
# binds. CC `_L` is ARKit `Left` (measured on an export with both sets: cos 0.99
# blink, 0.93 brows, 0.95 eyes, 0.99 pucker). `Mouth_Open` is not ARKit's
# `jawOpen` corrective (cos 0.13): it moves the chin itself, so the jaw bake
# below measures it instead of adding the fixed JAW_DRIVEN angle.
LEGACY_ARKIT = {
    "browInnerUp": {"Brow_Raise_Inner_L": 1.0, "Brow_Raise_Inner_R": 1.0},
    "cheekPuff": {"Cheek_Blow_L": 1.0, "Cheek_Blow_R": 1.0},
    "mouthPucker": {"Mouth_Pucker": 1.0}, "mouthFunnel": {"Mouth_Pucker_Open": 1.0},
    "mouthRollUpper": {"Mouth_Top_Lip_Under": 1.0}, "mouthRollLower": {"Mouth_Bottom_Lip_Under": 1.0},
    "mouthLeft": {"Mouth_L": 1.0}, "mouthRight": {"Mouth_R": 1.0}, "jawOpen": {"Mouth_Open": 1.0},
}
for _arkit, _cc in (("browDown", "Brow_Drop"), ("browOuterUp", "Brow_Raise_Outer"),
                    ("eyeBlink", "Eye_Blink"), ("eyeWide", "Eye_Wide"), ("eyeSquint", "Eye_Squint"),
                    ("noseSneer", "Nose_Flank_Raise"), ("cheekSquint", "Cheek_Raise"),
                    ("mouthSmile", "Mouth_Smile"), ("mouthFrown", "Mouth_Frown"),
                    ("mouthDimple", "Mouth_Dimple"), ("mouthUpperUp", "Mouth_Snarl_Upper"),
                    ("mouthLowerDown", "Mouth_Snarl_Lower")):
    for _side, _s in (("Left", "L"), ("Right", "R")):
        LEGACY_ARKIT[_arkit + _side] = {f"{_cc}_{_s}": 1.0}

legacy = 0
for o in meshes:
    ks = o.data.shape_keys
    if not ks or "eyeBlinkLeft" in ks.key_blocks:
        continue
    for name, mix in LEGACY_ARKIT.items():
        if name in ks.key_blocks or not all(k in ks.key_blocks for k in mix):
            continue
        for kb in ks.key_blocks:
            kb.value = 0.0
        for k, w in mix.items():
            ks.key_blocks[k].value = w
        o.shape_key_add(name=name, from_mix=True).value = 0.0
        legacy += 1
    for kb in ks.key_blocks:
        kb.value = 0.0
report["arkit_from_legacy"] = legacy

# --- 5. visemes, named like MPFB's Meta visemes -----------------------------------
# From CC3+'s 8 lip-sync shapes. Chosen by rendering all 8 (ENVIRONMENT.md s15).
VISEMES = {"viseme_aa": {"Open": 1.0},
           "viseme_E": {"Wide": 1.0},
           "viseme_I": {"Wide": 0.6, "Lip_Open": 0.4},
           "viseme_O": {"Tight-O": 0.7, "Open": 0.3},
           "viseme_U": {"Tight-O": 1.0}}
for o in meshes:
    ks = o.data.shape_keys
    if not ks:
        continue
    for name, mix in VISEMES.items():
        if not all(k in ks.key_blocks for k in mix):
            continue
        for kb in ks.key_blocks:
            kb.value = 0.0
        for k, w in mix.items():
            ks.key_blocks[k].value = w
        o.shape_key_add(name=name, from_mix=True).value = 0.0
    for kb in ks.key_blocks:
        kb.value = 0.0

# --- 6. teeth + tongue follow the jaw --------------------------------------------
jaw = "CC_Base_JawRoot"
mw = rig.matrix_world
pivot = mw @ rig.data.bones[jaw].head_local
jg = body.vertex_groups[jaw].index
chin_idx = [v.index for v in body.data.vertices
            if any(g.group == jg and g.weight > 0.9 for g in v.groups)]
basis = body.data.shape_keys.key_blocks[0].data
chin0 = sum((basis[i].co for i in chin_idx), Vector()) / len(chin_idx)


def chin_angle(kb):
    """Rotation about the jaw pivot's X axis that the key applies to the chin."""
    c1 = sum((kb.data[i].co for i in chin_idx), Vector()) / len(chin_idx)
    a0 = math.atan2((chin0 - pivot).z, (chin0 - pivot).y)
    a1 = math.atan2((c1 - pivot).z, (c1 - pivot).y)
    return math.degrees(a1 - a0)


# CC3+ opens the mouth with the jaw BONE; `jawOpen` and the `Open` viseme are
# correctives that barely move the chin (measured: < 1 deg), and `mouthClose`
# (-8.5 deg) exists to close the lips against an open jaw. For these keys the
# jaw rotation is part of the expression, so it is baked into the skin too.
# Angles are ours (CC's runtime values are not in the FBX); tune by render.
JAW_DRIVEN = {"jawOpen": 22.0, "viseme_aa": 16.0, "viseme_O": 10.0, "viseme_U": 5.0,
              "viseme_E": 5.0, "viseme_I": 4.0}
if not renamed:
    del JAW_DRIVEN["jawOpen"]  # legacy jawOpen is Mouth_Open: drops the chin itself (4b)

followers = [o for o in meshes if re.match(r"CC_Base_(Teeth|Tongue)", o.name)]
jaw_keys = {}
for kb in body.data.shape_keys.key_blocks[1:]:
    ang = chin_angle(kb)
    if abs(ang) > 1.0:
        jaw_keys[kb.name] = round(ang, 1)


def capture(o, key_name):
    """Evaluate `o` with only `key_name` active (if it has it) under the current pose."""
    ks = o.data.shape_keys
    if ks:
        for k in ks.key_blocks:
            k.value = 0.0
        if key_name in ks.key_blocks:
            ks.key_blocks[key_name].value = 1.0
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    me = o.evaluated_get(dg).to_mesh()
    coords = [v.co.copy() for v in me.vertices]
    o.evaluated_get(dg).to_mesh_clear()
    if ks:
        for k in ks.key_blocks:
            k.value = 0.0
    return coords


pb = rig.pose.bones[jaw]
for name, ang in JAW_DRIVEN.items():
    if name not in body.data.shape_keys.key_blocks:
        continue
    for pbx in rig.pose.bones:
        pbx.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()
    r = Matrix.Translation(pivot) @ Matrix.Rotation(math.radians(ang), 4, Vector((1, 0, 0))) @ Matrix.Translation(-pivot)
    pb.matrix = mw.inverted() @ r @ mw @ pb.matrix
    for o in [body] + [m for m in meshes if m is not body and m.data.shape_keys and name in m.data.shape_keys.key_blocks]:
        coords = capture(o, name)
        kb = o.data.shape_keys.key_blocks[name]
        for i, co in enumerate(coords):
            kb.data[i].co = co
    jaw_keys[name] = ang  # followers below get the same rotation
for name, ang in jaw_keys.items():
    for pbx in rig.pose.bones:
        pbx.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()
    r = Matrix.Translation(pivot) @ Matrix.Rotation(math.radians(ang), 4, Vector((1, 0, 0))) @ Matrix.Translation(-pivot)
    pb.matrix = mw.inverted() @ r @ mw @ pb.matrix
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    for o in followers:
        if o.data.shape_keys:
            for k in o.data.shape_keys.key_blocks:
                k.value = 0.0
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        me = o.evaluated_get(dg).to_mesh()
        coords = [v.co.copy() for v in me.vertices]
        o.evaluated_get(dg).to_mesh_clear()
        if not o.data.shape_keys:
            o.shape_key_add(name="Basis", from_mix=False)
        kb = o.data.shape_keys.key_blocks.get(name) or o.shape_key_add(name=name, from_mix=False)
        kb.value = 0.0
        # existing tongue keys (e.g. tongueOut) keep their own shape, plus the jaw
        base = o.data.shape_keys.key_blocks[0].data
        for i, co in enumerate(coords):
            kb.data[i].co = co + (kb.data[i].co - base[i].co)
for pbx in rig.pose.bones:
    pbx.matrix_basis = Matrix.Identity(4)
bpy.context.view_layer.update()
report["jaw_baked"] = jaw_keys

# --- 7. names --------------------------------------------------------------------
rig.name = args.name
body.name = body.data.name = f"{args.name}.body"
for o in meshes:
    if o is not body:
        o.name = o.data.name = f"{args.name}.{o.name.replace('CC_Base_', '').split('.')[0]}"
report["meshes"] = {o.name: (len(o.data.vertices), len(o.data.shape_keys.key_blocks) - 1 if o.data.shape_keys else 0)
                    for o in meshes}
bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.out))
print("RESULT " + json.dumps(report))
