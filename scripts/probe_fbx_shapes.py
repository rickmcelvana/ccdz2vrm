"""List every shape key and every face-ish bone of an FBX, so we can tell what a
Daz/CC export actually carries before designing an adapter for it.

    blender --background --python scripts/probe_fbx_shapes.py -- in.fbx
"""
import json
import re
import sys

import bpy

p = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=p)
out = {"file": p, "meshes": {}, "bones": {}}
for o in bpy.data.objects:
    if o.type == "ARMATURE":
        names = [b.name for b in o.data.bones]
        out["bones"] = {
            "total": len(names),
            "face": sorted(n for n in names
                           if re.search(r"(?i)(lip|brow|cheek|eyelid|jaw|nose|tongue|mouth|lid|squint|eye|nasolabial)",
                                        n)),
        }
    elif o.type == "MESH" and o.data.shape_keys:
        out["meshes"][o.name] = sorted(k.name for k in o.data.shape_keys.key_blocks[1:])
print("SHAPES " + json.dumps(out))
