"""Daz adapter: a Genesis FBX export -> the finisher's contract (T-posed
armature, skinned meshes, ARKit/viseme-named face shape keys).

    blender --background --python src/blender/adapt_daz.py -- in.fbx out/daz.blend [--name ryjeane]

Why the face "didn't transfer" before: Genesis 3/8 faces are bone-driven. The
G3 export here has 60 face bones and ZERO shape keys, and VRM expressions can
only bind shape keys. So this adapter poses the face bones into each
expression and saves the result as a shape key -- the same thing Daz's own
expression presets do at runtime, frozen.

A Genesis 8.1 export WITH its FACS morphs (a `facs` rule in Daz's Edit Morph
Export Rules) is better: Daz bakes each FACS morph, bone-driven parts included,
to vertex deltas, and step 4b mixes them into ARKit 52 + visemes instead.

Bone-posed expressions are written in the character's frame, in metres and degrees
(+x = character's left, -y = forward, +z = up) and mirrored for L/R, so the
same table serves any rig that uses Genesis 3/8 face-bone names. Genesis 1/2
exports already carry viseme morphs (`CTRLVSM*`); they are not handled here yet.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import import_fbx_clean, tpose_arms  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:]
ap = argparse.ArgumentParser()
ap.add_argument("fbx")
ap.add_argument("out")
ap.add_argument("--name", default="daz")
args = ap.parse_args(argv)

report = {}

# --- 1. import (animation, parent-inverse and metallic traps handled) --------
rig, meshes, rigid = import_fbx_clean(args.fbx)
report["rigid_bound"] = rigid
bones = {b.name for b in rig.data.bones}
family = ("genesis3_8" if {"lShldrBend", "lEyelidUpper"} <= bones else
          "genesis1_2" if "lShldr" in bones else "unknown")
report["family"] = family
if family != "genesis3_8":
    raise SystemExit(f"unsupported Daz rig family: {family}")

# main figure = the mesh with the most face-bone weights
body = max(meshes, key=lambda o: len(o.data.vertices) if "lEyelidUpper" in o.vertex_groups else 0)
rig.name = args.name
body.name = body.data.name = f"{args.name}.body"
for o in meshes:
    if o is not body:
        # "Audrey Hair_363327.Shape" -> "Audrey Hair"; splitting on "_" cut
        # "Genesis8_1FemaleEyelashes" to "Genesis8", so 8.1 lashes were not
        # recognised as a face part and stayed open through a blink
        o.name = o.data.name = f"{args.name}.{re.sub(r'(_[0-9]+)?(\.Shape)?(\.[0-9]+)?$', '', o.name)}"
report["meshes"] = {o.name: len(o.data.vertices) for o in meshes}

# --- 2. drop transparent eye overlays -----------------------------------------
# Cornea and EyeMoisture are clear shells over the iris. glTF MASK/OPAQUE
# would paint them solid over the eye; BLEND brings back the sort problems
# ENVIRONMENT.md s13 hit. The iris texture is enough at avatar scale.
# Every mesh, not just the figure: the G8 eyelash follower carries its own
# EyeMoisture surface, which exported as an opaque white rim along both lower
# lids (verified in three-vrm).
OVERLAYS = ("cornea", "eyemoisture", "tear")
removed = {}
for o in meshes:
    drop_idx = {i for i, s in enumerate(o.material_slots)
                if s.material and any(k in s.material.name.lower() for k in OVERLAYS)}
    if not drop_idx:
        continue
    bm = bmesh.new()
    bm.from_mesh(o.data)
    dead = [f for f in bm.faces if f.material_index in drop_idx]
    bmesh.ops.delete(bm, geom=dead, context="FACES")
    bm.to_mesh(o.data)
    bm.free()
    removed[o.name] = len(dead)
report["overlay_faces_removed"] = removed

# --- 2b. FACS morphs (Genesis 8.1 exported with a `facs` morph export rule) --------
# Daz bakes each morph to vertex deltas, the bone-driven parts included
# (facs_jnt_EyeBlinkLeft closes the lid 1.24 cm; facs_jnt_JawOpen carries the
# teeth). Keys arrive as `<mesh>__facs_<family>_<Name>`. When the figure has
# them, they ARE the face: ARKit 52 + visemes are mixed from them (step 4b)
# instead of posing bones. Face shapes stay on the figure and facial add-ons
# only (see FACE_PARTS); hair and clothes drop theirs before the T-pose, which
# would otherwise re-bake 166 keys on a 177k-vert brow and 121k-vert hair.
FACE_PARTS = ("lash", "brow", "beard", "moustache", "mustache", "tear")
face_meshes = [o for o in meshes if o is body or any(k in o.name.lower() for k in FACE_PARTS)]
report["face_meshes"] = [o.name for o in face_meshes]


def facs_name(n):
    return n.split("__", 1)[1] if "__facs_" in n else n


has_facs = bool(body.data.shape_keys) and any(
    facs_name(k.name).startswith("facs_") for k in body.data.shape_keys.key_blocks)
report["face_source"] = "facs_morphs" if has_facs else "face_bones"
dropped = 0
for o in meshes:
    if o.data.shape_keys and (o not in face_meshes or not has_facs):
        dropped += len(o.data.shape_keys.key_blocks) - 1
        o.shape_key_clear()
    elif o.data.shape_keys:
        for kb in o.data.shape_keys.key_blocks[1:]:
            kb.name = facs_name(kb.name)
report["shape_keys_dropped"] = dropped

# --- 3. rest pose must be a T-pose -----------------------------------------------
# Genesis 8 rests in an A-pose (arms 46 deg down, measured); Genesis 3 in a
# T-pose. Face bones are untouched by this, so it runs before the face bake.
report["arm_drop_deg"] = tpose_arms(rig, meshes, [
    ("lShldrBend", "lForearmBend", "lHand", 1), ("rShldrBend", "rForearmBend", "rHand", -1)])
mw = rig.matrix_world

# --- 4. face expressions: pose bones, freeze as shape keys -----------------------
X = Vector((1, 0, 0))


def mirror(side, v):
    return Vector((v[0] if side == "l" else -v[0], v[1], v[2]))


def op_rotate(pb, deg):
    """Rotate a pose bone about the character's left-right axis through its head."""
    h = rig.matrix_world @ pb.bone.head_local
    r = Matrix.Translation(h) @ Matrix.Rotation(math.radians(deg), 4, X) @ Matrix.Translation(-h)
    pb.matrix = mw.inverted() @ r @ mw @ pb.matrix


def op_move(pb, delta):
    pb.matrix = mw.inverted() @ Matrix.Translation(delta) @ mw @ pb.matrix


# Each entry: list of (op, bones, value). "{s}" expands to l/r; vectors are
# written for the LEFT side and mirrored. Rotations: + closes an upper lid /
# opens the jaw (verified by render, see ENVIRONMENT.md s14).
UPPER_LID = ["{s}EyelidUpper", "{s}EyelidUpperInner", "{s}EyelidUpperOuter"]
LOWER_LID = ["{s}EyelidLower", "{s}EyelidLowerInner", "{s}EyelidLowerOuter"]
LIPS_MID = ["LipUpperMiddle", "LipLowerMiddle", "lLipUpperInner", "rLipUpperInner",
            "lLipLowerInner", "rLipLowerInner", "lLipUpperOuter", "rLipUpperOuter",
            "lLipLowerOuter", "rLipLowerOuter"]
SIDED = {  # ARKit name stem -> ops (left side); produces <stem>Left / <stem>Right
    "eyeBlink": [("rot", UPPER_LID, 34), ("rot", LOWER_LID, -8)],
    "eyeWide": [("rot", UPPER_LID, -10)],
    "eyeSquint": [("rot", LOWER_LID, -10), ("move", ["{s}SquintInner", "{s}SquintOuter"], (0, 0, 0.002))],
    "mouthSmile": [("move", ["{s}LipCorner"], (0.005, 0.003, 0.006)),
                   ("move", ["{s}NasolabialMouthCorner"], (0.003, 0.002, 0.004)),
                   ("move", ["{s}CheekLower"], (0, 0, 0.003))],
    "mouthFrown": [("move", ["{s}LipCorner"], (0.001, 0, -0.006)),
                   ("move", ["{s}NasolabialMouthCorner"], (0, 0, -0.003))],
    "mouthStretch": [("move", ["{s}LipCorner"], (0.006, 0.001, 0))],
    "browDown": [("move", ["{s}BrowInner"], (-0.002, 0, -0.004)),
                 ("move", ["{s}BrowMid", "{s}BrowOuter"], (0, 0, -0.003))],
    "browOuterUp": [("move", ["{s}BrowOuter"], (0, 0, 0.005)), ("move", ["{s}BrowMid"], (0, 0, 0.003))],
    "cheekSquint": [("move", ["{s}CheekUpper", "{s}SquintOuter"], (0, 0, 0.003))],
    "noseSneer": [("move", ["{s}Nostril", "{s}NasolabialUpper"], (0, 0, 0.002))],
}
CENTRE = {
    "jawOpen": [("rot", ["lowerJaw"], 18)],
    "browInnerUp": [("move", ["lBrowInner", "rBrowInner"], (0, 0, 0.005)), ("move", ["CenterBrow"], (0, 0, 0.003))],
    "mouthPucker": [("move", ["{s}LipCorner"], (-0.008, -0.003, 0)), ("move", LIPS_MID, (0, -0.004, 0))],
    "mouthFunnel": [("move", ["{s}LipCorner"], (-0.005, -0.002, 0)), ("move", LIPS_MID, (0, -0.004, 0)),
                    ("rot", ["lowerJaw"], 5)],
    # Visemes: combinations, named like MPFB's Meta visemes so the finisher's
    # preset table (aa/ih/ou/ee/oh) binds them unchanged.
    "viseme_aa": [("rot", ["lowerJaw"], 16)],
    "viseme_E": [("rot", ["lowerJaw"], 8), ("move", ["{s}LipCorner"], (0.004, 0, 0))],
    "viseme_I": [("rot", ["lowerJaw"], 6), ("move", ["{s}LipCorner"], (0.006, 0, 0.001))],
    "viseme_O": [("rot", ["lowerJaw"], 12), ("move", ["{s}LipCorner"], (-0.005, -0.002, 0)),
                 ("move", LIPS_MID, (0, -0.003, 0))],
    "viseme_U": [("rot", ["lowerJaw"], 5), ("move", ["{s}LipCorner"], (-0.008, -0.003, 0)),
                 ("move", LIPS_MID, (0, -0.005, 0))],
}


def expand(ops, sides):
    """Yield (op, pose bone, value). `{s}` bones are expanded per side with the
    vector mirrored; literal bone names are applied once, as written (keep
    their x component 0 unless they are genuinely one-sided)."""
    for op, names, val in ops:
        for n in names:
            for side in (sides if "{s}" in n else sides[:1]):
                name = n.format(s=side)
                pb = rig.pose.bones.get(name)
                if pb is None:
                    raise SystemExit(f"missing face bone {name}")
                if op == "rot":
                    yield op, pb, val
                else:
                    yield op, pb, mirror(side, val) if "{s}" in n else Vector(val)


def reset_pose():
    for pb in rig.pose.bones:
        pb.matrix_basis = Matrix.Identity(4)


def freeze(key_name, ops):
    # Zero every existing key first: some new keys come in at value 1.0, and
    # an active key is baked into the next capture -- the deltas then double
    # with every expression (measured: 0.016 m -> 1,950 km by the 29th key).
    for o in meshes:
        if o.data.shape_keys:
            for kb in o.data.shape_keys.key_blocks[1:]:
                kb.value = 0.0
    reset_pose()
    bpy.context.view_layer.update()
    for op, pb, v in ops:
        (op_rotate if op == "rot" else op_move)(pb, v)
        bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    touched = []
    for o in face_meshes:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        if len(me.vertices) != len(o.data.vertices):
            ev.to_mesh_clear()
            raise SystemExit(f"{o.name}: evaluated vertex count differs")
        rest = o.data.shape_keys.key_blocks[0].data if o.data.shape_keys else o.data.vertices
        moved = max(((me.vertices[i].co - rest[i].co).length for i in range(len(me.vertices))), default=0)
        if moved > 1e-5:
            if not o.data.shape_keys:
                o.shape_key_add(name="Basis", from_mix=False)
            kb = o.shape_key_add(name=key_name, from_mix=False)
            kb.value = 0.0
            for i, v in enumerate(me.vertices):
                kb.data[i].co = v.co
            touched.append(o.name)
        ev.to_mesh_clear()
    return touched


# Face shapes go on the figure and facial add-ons only (face_meshes, step 2b).
# Hair is conformed with brow/forehead weights, so it twitches with brow
# expressions; keeping that gave a 363k-vert hair mesh dense morph targets
# worth 174 MB of a 202 MB VRM.

# --- 4b. FACS morphs -> ARKit 52 + visemes ----------------------------------------
# Bone-driven shapes (facs_jnt_) get their own corrective (facs_cbs_<same>_div2),
# which Daz drives from the same value. Pairwise correctives (facs_cbs_EBL_NSL:
# blink x sneer) need two inputs at once and have no VRM equivalent -- dropped.
# Visemes come from Daz's own viseme controls: aa=AA, ih=IY, ou=UW, ee=EH, oh=OW.
FACS_SIDED = {
    "eyeBlink": ["jnt_EyeBlink{S}", "cbs_EyeBlink{S}_div2"],
    "eyeWide": ["jnt_EyeWide{S}", "cbs_EyeWide{S}_div2"],
    "eyeLookUp": ["jnt_EyeLookUp{S}", "cbs_EyeLookUp{S}_div2"],
    "eyeLookDown": ["jnt_EyeLookDown{S}", "cbs_EyeLookDown{S}_div2"],
    **{stem: [f"bs_{stem[0].upper()}{stem[1:]}{{S}}_div2"] for stem in (
        "eyeSquint", "eyeLookIn", "eyeLookOut", "browDown", "browOuterUp", "cheekSquint", "noseSneer",
        "mouthSmile", "mouthFrown", "mouthDimple", "mouthStretch", "mouthPress", "mouthUpperUp",
        "mouthLowerDown")},
}
FACS_CENTRE = {
    "browInnerUp": ["bs_BrowInnerUpLeft_div2", "bs_BrowInnerUpRight_div2"],
    "cheekPuff": ["bs_CheekPuffLeft_div2", "bs_CheekPuffRight_div2"],
    "jawOpen": ["jnt_JawOpen", "cbs_JawOpen_div2"],
    "jawLeft": ["jnt_JawLeft", "cbs_JawLeft_div2"],
    "jawRight": ["jnt_JawRight", "cbs_JawRight_div2"],
    "jawForward": ["jnt_JawForward", "cbs_JawForward_div2"],
    **{stem: [f"bs_{stem[0].upper()}{stem[1:]}_div2"] for stem in (
        "mouthPucker", "mouthFunnel", "mouthRollUpper", "mouthRollLower", "mouthShrugUpper",
        "mouthShrugLower", "mouthClose", "mouthLeft", "mouthRight")},
    "tongueOut": ["bs_TongueOut"],
    "viseme_aa": ["ctrl_vAA"], "viseme_I": ["ctrl_vIY"], "viseme_U": ["ctrl_vUW"],
    "viseme_E": ["ctrl_vEH"], "viseme_O": ["ctrl_vOW"],
}


def mix_facs():
    table = {f"{stem}{side}": [s.format(S=side) for s in srcs]
             for stem, srcs in FACS_SIDED.items() for side in ("Left", "Right")}
    table.update(FACS_CENTRE)
    made, missing = {}, set()
    for o in face_meshes:
        ks = o.data.shape_keys
        if not ks:
            continue
        for name, srcs in table.items():
            have = [f"facs_{s}" for s in srcs if f"facs_{s}" in ks.key_blocks]
            if o is body:
                missing |= {s for s in srcs if f"facs_{s}" not in ks.key_blocks}
            if not have:
                continue
            for kb in ks.key_blocks:
                kb.value = 0.0
            for s in have:
                ks.key_blocks[s].value = 1.0
            o.shape_key_add(name=name, from_mix=True).value = 0.0
            made.setdefault(name, []).append(o.name)
        for kb in list(ks.key_blocks[1:]):
            kb.value = 0.0
            if kb.name.startswith("facs_"):
                o.shape_key_remove(kb)
    if missing:
        raise SystemExit(f"FACS export lacks {sorted(missing)}")
    return made


def side_check(key):
    """Mean x of the verts a key moves: ARKit `Left` is the character's left (+x)."""
    kb = body.data.shape_keys.key_blocks[key]
    base = body.data.shape_keys.key_blocks[0].data
    xs = [base[i].co.x for i in range(len(base)) if (kb.data[i].co - base[i].co).length > 1e-4]
    return round(sum(xs) / len(xs), 4) if xs else None


def drop_noise(eps=5e-5):
    """Zero per-vertex deltas under eps (0.05 mm) and drop keys left empty.

    Baked FACS keys carry float noise on every vertex a face bone or conformer
    touches (Kamara's 177k-vert strand brows: 35 of 57 keys under 0.2 mm, yet
    nonzero almost everywhere), and noise defeats sparse glTF morphs.
    """
    import numpy as np
    dropped = {}
    for o in face_meshes:
        ks = o.data.shape_keys
        n = len(o.data.vertices)
        if not ks or n == 0:
            continue
        base = np.empty(n * 3, np.float32)
        ks.key_blocks[0].data.foreach_get("co", base)
        base = base.reshape(-1, 3)
        for kb in list(ks.key_blocks[1:]):
            co = np.empty(n * 3, np.float32)
            kb.data.foreach_get("co", co)
            d = co.reshape(-1, 3) - base
            small = np.linalg.norm(d, axis=1) < eps
            if small.all():
                dropped.setdefault(o.name, []).append(kb.name)
                o.shape_key_remove(kb)
                continue
            d[small] = 0
            kb.data.foreach_set("co", (base + d).ravel())
    return {k: len(v) for k, v in dropped.items()}


if has_facs:
    report["shape_keys"] = mix_facs()
    report["noise_keys_dropped"] = drop_noise()
    report["side_check_x"] = {k: side_check(k) for k in ("eyeBlinkLeft", "mouthSmileLeft", "browDownLeft")}
    if any(v is None or v <= 0 for v in report["side_check_x"].values()):
        raise SystemExit(f"FACS Left keys are not on the character's left: {report['side_check_x']}")
else:
    made = {}
    for stem, ops in SIDED.items():
        for side, suffix in (("l", "Left"), ("r", "Right")):
            made[stem + suffix] = freeze(stem + suffix, list(expand(ops, [side])))
    for name, ops in CENTRE.items():
        made[name] = freeze(name, list(expand(ops, ["l", "r"])))
    reset_pose()
    report["shape_keys"] = {k: v for k, v in made.items()}

# --- 5. save --------------------------------------------------------------------
bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.out))
print("RESULT " + json.dumps(report))
