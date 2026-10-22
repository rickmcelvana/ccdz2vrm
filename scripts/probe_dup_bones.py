"""Are Daz's duplicate bones (`chestUpper.004`) real, posed bones or unposed twins?

    blender --background --python scripts/probe_dup_bones.py -- in.fbx chestUpper
"""
import json
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
p, stem = argv[0], argv[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=p)
rig = next(o for o in bpy.data.objects if o.type == "ARMATURE")
out = {}
for b in rig.data.bones:
    if stem.lower() not in b.name.lower():
        continue
    out[b.name] = {
        "parent": b.parent.name if b.parent else None,
        "head_local": [round(c, 4) for c in b.head_local],
        "use_deform": b.use_deform,
        "roots": len(rig.data.bones),
    }
# who skins to each of them?
users = {}
for o in bpy.data.objects:
    if o.type != "MESH":
        continue
    for vg in o.vertex_groups:
        if stem.lower() in vg.name.lower():
            users.setdefault(vg.name, []).append(o.name)
print("DUPS " + json.dumps({"bones": out, "weight_users": users}))
