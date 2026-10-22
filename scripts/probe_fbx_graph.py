"""Full object graph + any bone whose name matches a prop, for one FBX.

    blender --background --python scripts/probe_fbx_graph.py -- in.fbx [substr]
"""
import json
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
p = argv[0]
sub = argv[1] if len(argv) > 1 else "chain"
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=p)
out = {"objects": {}, "matching_bones": {}, "parents_of_matches": {}}
for o in bpy.data.objects:
    chain, cur, seen = [], o, set()
    while cur is not None and cur.as_pointer() not in seen:
        seen.add(cur.as_pointer())
        chain.append(f"{cur.name}({cur.type}"
                     + (f",bone={cur.parent_bone}" if cur.parent_type == "BONE" else "")
                     + (f",pt={cur.parent_type})" if cur.parent_type != "BONE" else ")"))
        cur = cur.parent
    out["objects"][o.name] = {"type": o.type, "vgroups": len(o.vertex_groups),
                              "modifiers": [m.type for m in o.modifiers],
                              "chain": chain}
for o in bpy.data.objects:
    if o.type == "ARMATURE":
        hit = [b.name for b in o.data.bones if sub.lower() in b.name.lower()]
        if hit:
            out["matching_bones"][o.name] = hit
            out["parents_of_matches"] = {
                b: o.data.bones[b].parent.name if o.data.bones[b].parent else None for b in hit}
print("GRAPH " + json.dumps(out))
