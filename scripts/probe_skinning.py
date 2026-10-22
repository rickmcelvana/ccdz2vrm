"""Per-mesh skinning inventory of an adapted .blend: vertex groups, deform
groups, armature modifier, parent. Written to find which mesh breaks
vrm_export's limit-4 step.

    blender --background in.blend --python scripts/probe_skinning.py
"""
import json

import bpy

rig = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
bones = {b.name for b in rig.data.bones} if rig else set()
out = {"armature": rig.name if rig else None, "meshes": {}}
for o in bpy.data.objects:
    if o.type != "MESH":
        continue
    vgs = list(o.vertex_groups)
    deform = [vg.name for vg in vgs if vg.name in bones]
    amods = [m.object.name if m.object else None for m in o.modifiers if m.type == "ARMATURE"]
    weighted = sum(1 for v in o.data.vertices if v.groups)
    out["meshes"][o.name] = {
        "verts": len(o.data.vertices),
        "vgroups": len(vgs),
        "vgroups_sample": [vg.name for vg in vgs[:4]],
        "deform_groups": len(deform),
        "verts_with_weights": weighted,
        "armature_mod": amods,
        "parent": o.parent.name if o.parent else None,
        "parent_type": o.parent_type,
        "parent_bone": o.parent_bone,
    }
print("SKIN " + json.dumps(out))
