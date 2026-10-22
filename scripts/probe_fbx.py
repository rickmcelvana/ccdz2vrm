import bpy, sys, json, re
p = sys.argv[sys.argv.index("--")+1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=p)
out = {"file": p, "armatures": [], "meshes": []}
for o in bpy.data.objects:
    if o.type == "ARMATURE":
        names = [b.name for b in o.data.bones]
        face = [n for n in names if re.search(r"(?i)(lip|brow|cheek|eyelid|jaw|nose|tongue|mouth|lid|squint)", n)]
        out["armatures"].append({"name": o.name, "bones": len(names), "sample": names[:12], "face_bones": len(face), "face_sample": face[:10], "has_eyes": [n for n in names if re.search(r"(?i)eye", n)][:4]})
    elif o.type == "MESH":
        sk = [k.name for k in o.data.shape_keys.key_blocks[1:]] if o.data.shape_keys else []
        out["meshes"].append({"name": o.name, "verts": len(o.data.vertices), "shapekeys": len(sk), "sk_sample": sk[:15]})
print("PROBE " + json.dumps(out))
