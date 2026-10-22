"""Does a rigid-bound prop actually follow the skeleton? Pose a spine bone and
measure how far each mesh's vertices move.

    blender --background in.blend --python scripts/verify_rigid.py -- chestUpper g8b.Chain1
"""
import json
import math
import sys

import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
bone = argv[0]
targets = argv[1:]

rig = next(o for o in bpy.data.objects if o.type == "ARMATURE")
meshes = [o for o in bpy.data.objects if o.type == "MESH" and o.parent == rig]
pb = rig.pose.bones[bone]
mw = rig.matrix_world
h = mw @ pb.bone.head_local
X = Vector((1, 0, 0))
r = Matrix.Translation(h) @ Matrix.Rotation(math.radians(25), 4, X) @ Matrix.Translation(-h)
pb.matrix = mw.inverted() @ r @ mw @ pb.matrix
bpy.context.view_layer.update()

dg = bpy.context.evaluated_depsgraph_get()
out = {}
for o in meshes:
    ev = o.evaluated_get(dg)
    me = ev.to_mesh()
    rest = o.data.shape_keys.key_blocks[0].data if o.data.shape_keys else o.data.vertices
    moved = [(me.vertices[i].co - rest[i].co).length for i in range(len(me.vertices))]
    ev.to_mesh_clear()
    out[o.name] = round(sum(moved) / max(len(moved), 1), 5)
print("MOVED " + json.dumps({"posed_bone": bone, "mean_moved_m": out,
                             "targets": {t: out.get(t) for t in targets}}))
