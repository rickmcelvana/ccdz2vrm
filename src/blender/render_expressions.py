"""Render a head close-up per expression, as one contact sheet, so a human (or
an agent with vision) can check that face shapes actually move the face.

    blender --background <char.blend> --python src/blender/render_expressions.py -- out/expr.png
        [--keys neutral,jawOpen,eyeBlinkLeft+eyeBlinkRight,viseme_aa]

Each entry is one frame; `+` sets several shape keys to 1.0 together. The same
key name is set on EVERY mesh that has it (body, lashes, teeth...), which is
what a VRM expression does too -- checking the body alone would hide lashes
that fail to follow a blink.
"""

from __future__ import annotations

import argparse
import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("out")
ap.add_argument("--keys", default="neutral,eyeBlinkLeft+eyeBlinkRight,jawOpen,"
                "viseme_aa,viseme_I,viseme_U,viseme_E,viseme_O,"
                "mouthSmileLeft+mouthSmileRight,browInnerUp+mouthFrownLeft+mouthFrownRight")
ap.add_argument("--size", type=int, default=360)
ap.add_argument("--angle", type=float, default=15.0, help="camera yaw in degrees")
args = ap.parse_args(argv)

meshes = [o for o in bpy.data.objects if o.type == "MESH" and not o.hide_render]
rig = next(o for o in bpy.data.objects if o.type == "ARMATURE")
head_bone = next(n for n in ("head", "CC_Base_Head") if n in rig.data.bones)
head = rig.matrix_world @ rig.data.bones[head_bone].head_local
eyes = [rig.matrix_world @ b.head_local for b in rig.data.bones
        if b.name in ("eye_l", "eye_r", "lEye", "rEye", "CC_Base_L_Eye", "CC_Base_R_Eye")]
focus = (sum(eyes, Vector()) / len(eyes)) if eyes else head + Vector((0, 0, 0.08))
focus = focus + Vector((0, 0, -0.03))

sc = bpy.context.scene
sc.render.engine = "BLENDER_EEVEE"
sc.render.resolution_x = sc.render.resolution_y = args.size
sc.render.film_transparent = False
world = bpy.data.worlds.new("W")
sc.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.35, 0.36, 0.38, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
for i, (dx, dz, e) in enumerate([(-0.6, 0.4, 60), (0.8, 0.1, 25)]):
    ld = bpy.data.lights.new(f"L{i}", "AREA")
    ld.energy, ld.size = e, 0.6
    lo = bpy.data.objects.new(f"L{i}", ld)
    sc.collection.objects.link(lo)
    lo.location = focus + Vector((dx, -1.0, dz))
    lo.rotation_euler = (focus - lo.location).to_track_quat("-Z", "Y").to_euler()

cam = bpy.data.objects.new("C", bpy.data.cameras.new("C"))
sc.collection.objects.link(cam)
sc.camera = cam
cam.data.lens = 85
a = math.radians(args.angle)
cam.location = focus + Vector((math.sin(a), -math.cos(a), 0.02)) * 0.75
cam.rotation_euler = (focus - cam.location).to_track_quat("-Z", "Y").to_euler()


def set_keys(names):
    for o in meshes:
        ks = o.data.shape_keys
        if not ks:
            continue
        for kb in ks.key_blocks[1:]:
            kb.value = 1.0 if kb.name in names else 0.0


frames = []
stem = os.path.splitext(os.path.abspath(args.out))[0]
for i, entry in enumerate(args.keys.split(",")):
    names = set() if entry == "neutral" else set(entry.split("+"))
    set_keys(names)
    sc.render.filepath = f"{stem}_{i:02d}.png"
    bpy.ops.render.render(write_still=True)
    frames.append((entry, sc.render.filepath))
    print(f"FRAME {i} {entry}")

# contact sheet: stitch frames with Blender's own image API (no PIL dependency)
cols = min(5, len(frames))
rows = math.ceil(len(frames) / cols)
W = H = args.size
sheet = [0.0] * (cols * W * rows * H * 4)
for n, (_, path) in enumerate(frames):
    img = bpy.data.images.load(path)
    px = list(img.pixels)
    cx, cy = n % cols, rows - 1 - n // cols
    for y in range(H):
        src = y * W * 4
        dst = ((cy * H + y) * cols * W + cx * W) * 4
        sheet[dst:dst + W * 4] = px[src:src + W * 4]
    bpy.data.images.remove(img)
    os.remove(path)
out = bpy.data.images.new("sheet", cols * W, rows * H)
out.pixels = sheet
out.filepath_raw = os.path.abspath(args.out)
out.file_format = "PNG"
out.save()
print("SHEET", args.out, "order:", [f for f, _ in frames])
