"""Is a Character Creator FBX export ready for adapt_cc.py, and will its textures
actually reach the VRM?

    blender --background --python scripts/probe_cc_fbx.py -- in.Fbx

Checks the contract `adapt_cc.py` assumes (CC_Base_Hip, a CC_Base_Body* mesh, the
teeth/tongue meshes, the ARKit 52 morphs) and every image the importer resolved:
CC embeds them in the FBX, and Blender unpacks them as PACKED images whose
filepath still names CC's deleted temp folder -- so a packed image counts as
resolved. An image neither packed nor on disk would export untextured and still
pass every validator. Also reports which face set the export carries: ARKit 52
(`A01_...`) or only CC3's Traditional 60 (`Eye_Blink_L`, ...), which adapt_cc.py
mixes into ARKit names.
"""
import json
import os
import re
import sys

import bpy

p = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=p)
out = {"file": p, "size_mb": round(os.path.getsize(p) / 1048576, 1)}

rig = next(o for o in bpy.data.objects if o.type == "ARMATURE")
bones = {b.name for b in rig.data.bones}
out["rig"] = {
    "name": rig.name,
    "bones": len(bones),
    "CC_Base_Hip": "CC_Base_Hip" in bones,
    "CC_Base_JawRoot": "CC_Base_JawRoot" in bones,
    "eyes": sorted(n for n in bones if re.search(r"CC_Base_[LR]_Eye$", n)),
    "adapter_would_accept": "CC_Base_Hip" in bones,
}

meshes = [o for o in bpy.data.objects if o.type == "MESH"]
out["body_mesh"] = next((o.name for o in meshes if o.name.startswith("CC_Base_Body")), None)
out["adapter_stops_on"] = [] if out["body_mesh"] else ["no mesh named CC_Base_Body*"]
out["meshes"] = {}
arkit = set()
for o in meshes:
    ks = o.data.shape_keys
    keys = sorted(k.name for k in ks.key_blocks[1:]) if ks else []
    arkit |= {k for k in keys if re.match(r"^A\d\d_", k)}
    out["meshes"][o.name] = {
        "verts": len(o.data.vertices),
        "vgroups": len(o.vertex_groups),
        "shapekeys": len(keys),
        "legacy_visemes_present": {v: v in keys for v in ("Open", "Wide", "Tight-O", "Lip_Open")},
        "keys": keys,
    }
out["arkit_morphs_on_body"] = len({k for k in arkit if k.startswith("A")})
out["arkit_range"] = [min(arkit), max(arkit)] if arkit else None
out["teeth_tongue"] = sorted(o.name for o in meshes
                             if re.match(r"CC_Base_(Teeth|Tongue)", o.name))

imgs = {}
missing = []
for im in bpy.data.images:
    if im.source != "FILE" or not im.filepath:
        continue
    path = bpy.path.abspath(im.filepath)
    ok = bool(im.packed_file) or os.path.exists(path)
    imgs[im.name] = {"exists": ok, "packed": bool(im.packed_file), "path": path}
    if not ok:
        missing.append(im.name)
out["face_set"] = ("arkit52" if out["arkit_morphs_on_body"] >= 50 else
                   "traditional" if "Eye_Blink_L" in out["meshes"].get(out["body_mesh"] or "", {}).get("keys", ()) else
                   "none")
out["images"] = {"resolved": len(imgs) - len(missing), "packed": sum(v["packed"] for v in imgs.values()),
                 "missing": len(missing),
                 "missing_sample": sorted(missing)[:6],
                 "missing_dir_example": sorted({os.path.dirname(imgs[m]["path"]) for m in missing})[:2]}
for m in out["meshes"].values():
    m.pop("keys")
print("CCPROBE " + json.dumps(out))
