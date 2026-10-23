"""Write what Blender has as a contract (docs/BROWSER-PORT.md s2): the reference the
browser port is compared against.

    # the FBX as Blender's importer gives it, nothing cleaned (parser comparison)
    blender --background --factory-startup --python src/blender/dump_contract.py -- in.fbx out/x.raw --raw
    # after common.import_fbx_clean: the first step of both adapters (port Phase 1)
    blender --background --factory-startup --python src/blender/dump_contract.py -- in.fbx out/x.clean --clean
    # an adapter's .blend (what the finisher receives)
    blender --background out/x.blend --python src/blender/dump_contract.py -- out/x.adapted

Writes <out>.json + <out>.bin. Same format as tools/fbx-spike/ufbx_contract.c: glTF frame
(Y up, +Z front, metres); bones with world rest matrices; meshes with vertices split per
(vertex, uv) like a glTF export, top-8 skin weights, triangles, per-triangle material and
every shape key as per-vertex deltas; images identified by FNV-1a over length + first and
last 64 KB; materials as the Principled BSDF the finisher reads (base colour, alpha and
which image output drives it, roughness, metallic, normal map and whether it was made from
a height map).
"""

from __future__ import annotations

import json
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix

argv = sys.argv[sys.argv.index("--") + 1:]
raw = "--raw" in argv
clean = "--clean" in argv
args = [a for a in argv if not a.startswith("--")]
if raw:
    fbx, out = args
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=os.path.abspath(fbx))
elif clean:
    fbx, out = args
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from common import import_fbx_clean
    import_fbx_clean(fbx)
else:
    (out,) = args

MAXW = 8
# Blender world (Z up, -Y front) -> glTF world (Y up, +Z front)
C = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))
C3 = np.array(C.to_3x3())

blob = bytearray()


def put(arr):
    while len(blob) % 4:
        blob.append(0)
    off = len(blob)
    blob.extend(np.ascontiguousarray(arr).tobytes())
    return off


def fnv(data):
    h = 1469598103934665603
    n = len(data)
    head = data[:65536]
    tail = data[len(head):][-65536:] if n > 65536 else b""
    for byte in n.to_bytes(8, "little") + bytes(head) + bytes(tail):
        h = ((h ^ byte) * 1099511628211) & 0xFFFFFFFFFFFFFFFF
    return f"{h:016x}"


def column_major(m):
    return [m[r][c] for c in range(4) for r in range(4)]


bones, bone_index = [], {}
for arm in (o for o in bpy.data.objects if o.type == "ARMATURE"):
    for b in arm.data.bones:
        bone_index[(arm.name, b.name)] = len(bones)
        bones.append({"name": b.name, "parent": b.parent.name if b.parent else None,
                      "armature": arm.name, "rest_from": "blender",
                      "matrix": column_major(C @ arm.matrix_world @ b.matrix_local)})

meshes = []
for o in (o for o in bpy.data.objects if o.type == "MESH"):
    me = o.data
    me.calc_loop_triangles()
    nl = len(me.loops)
    lv = np.empty(nl, np.int64)
    me.loops.foreach_get("vertex_index", lv)
    uv = np.zeros((nl, 2), np.float32)
    if me.uv_layers.active:
        me.uv_layers.active.data.foreach_get("uv", uv.ravel())
    key = np.column_stack([lv, np.round(uv * 1e6).astype(np.int64)])
    uniq, first, split_of_loop = np.unique(key, axis=0, return_index=True, return_inverse=True)
    split_of_loop = split_of_loop.ravel()
    vi = lv[first]
    n = len(vi)

    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    mw = np.array(C @ o.matrix_world)
    pos = (co[vi] @ mw[:3, :3].T + mw[:3, 3]).astype(np.float32)

    arm = next((m.object for m in o.modifiers if m.type == "ARMATURE" and m.object), None)
    if arm is None and o.parent and o.parent.type == "ARMATURE":
        arm = o.parent
    joints = np.zeros((n, MAXW), np.uint16)
    weights = np.zeros((n, MAXW), np.float32)
    if arm is not None:
        group_bone = {g.index: bone_index.get((arm.name, g.name)) for g in o.vertex_groups}
        per_vertex = []
        for v in me.vertices:
            ws = sorted(((g.weight, group_bone.get(g.group)) for g in v.groups
                         if group_bone.get(g.group) is not None and g.weight > 0), reverse=True)[:MAXW]
            per_vertex.append(ws)
        for s, v in enumerate(vi):
            for k, (w, b) in enumerate(per_vertex[v]):
                weights[s, k] = w
                joints[s, k] = b

    nt = len(me.loop_triangles)
    tl = np.empty(nt * 3, np.int64)
    me.loop_triangles.foreach_get("loops", tl)
    tris = split_of_loop[tl].astype(np.uint32)
    tmat = np.empty(nt, np.int64)
    me.loop_triangles.foreach_get("material_index", tmat)

    morphs = []
    if me.shape_keys:
        kb = me.shape_keys.key_blocks
        base = np.empty(len(me.vertices) * 3, np.float32)
        kb[0].data.foreach_get("co", base)
        for k in kb[1:]:
            kc = np.empty(len(me.vertices) * 3, np.float32)
            k.data.foreach_get("co", kc)
            d = (kc - base).reshape(-1, 3)[vi] @ mw[:3, :3].T
            morphs.append({"name": k.name, "shape": k.name, "inbetweens": 0, "delta": put(d.astype(np.float32))})

    meshes.append({
        "name": o.name, "mesh": me.name, "vertex_count": n, "triangle_count": nt,
        "position": put(pos), "uv": put(uv[first].astype(np.float32)),
        "joints": put(joints), "weights": put(weights),
        "indices": put(tris), "triangle_material": put(tmat.astype(np.uint16)),
        "materials": [s.material.name if s.material else "" for s in o.material_slots],
        "morphs": morphs,
    })


def image_bytes(img):
    if img.packed_file:
        return bytes(img.packed_file.data)
    path = bpy.path.abspath(img.filepath)
    return open(path, "rb").read() if os.path.isfile(path) else b""


def pbr(mat):
    """The Principled BSDF as the finisher reads it."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from common import upstream_image
    nt = mat.node_tree
    b = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None) if nt else None
    if b is None:
        return None

    def img_fnv(node):
        return fnv(image_bytes(node.image)) if node is not None and node.image else None

    a = b.inputs["Alpha"]
    alink = next((l for l in a.links if l.from_node.type == "TEX_IMAGE"), None)
    nm = next((l.from_node for l in b.inputs["Normal"].links if l.from_node.type == "NORMAL_MAP"), None)
    ntex = next((l.from_node for l in nm.inputs["Color"].links if l.from_node.type == "TEX_IMAGE"), None) if nm else None
    from_height = bool(ntex and ntex.image and ntex.image.name.endswith("_normal")
                       and ntex.image.name[:-7] in bpy.data.images)
    src = bpy.data.images[ntex.image.name[:-7]] if from_height else (ntex.image if ntex else None)
    return {
        "base_color": list(b.inputs["Base Color"].default_value)[:3],
        "base_tex": img_fnv(upstream_image(b.inputs["Base Color"])),
        "alpha": a.default_value,
        "alpha_tex": img_fnv(alink.from_node) if alink else None,
        "alpha_channel": ("alpha" if alink.from_socket.name == "Alpha" else "color") if alink else None,
        "roughness": b.inputs["Roughness"].default_value,
        "roughness_tex": img_fnv(upstream_image(b.inputs["Roughness"])),
        "metallic": b.inputs["Metallic"].default_value,
        "metallic_tex": img_fnv(upstream_image(b.inputs["Metallic"])),
        "normal_tex": fnv(image_bytes(src)) if src else None,
        "normal_from_height": from_height,
        "normal_strength": nm.inputs["Strength"].default_value if nm else None,
    }


materials = []
for mat in bpy.data.materials:
    tex = []
    for node in (mat.node_tree.nodes if mat.node_tree else []):
        if node.type == "TEX_IMAGE" and node.image:
            data = image_bytes(node.image)
            dest = next((l.to_socket.name for l in node.outputs["Color"].links), "") or \
                next((l.to_socket.name for l in node.outputs["Alpha"].links), "")
            tex.append({"prop": dest, "file": os.path.basename(node.image.filepath), "bytes": len(data),
                        "fnv": fnv(data)})
    materials.append({"name": mat.name, "textures": tex, "pbr": pbr(mat)})

images = []
for img in bpy.data.images:
    if img.type != "IMAGE":
        continue
    data = image_bytes(img)
    # made by common.height_to_normal, not read from the FBX: compared as pixels, not bytes
    generated = img.name.endswith("_normal") and img.name[:-7] in bpy.data.images
    images.append({"name": os.path.basename(img.filepath) or img.name, "bytes": len(data), "fnv": fnv(data),
                   "generated": generated})

doc = {"source": "blender-raw" if raw else "blender-clean" if clean else "blender", "blender": bpy.app.version_string,
       "bones": bones, "meshes": meshes, "materials": materials, "images": images}
os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
with open(out + ".json", "w", encoding="utf-8") as f:
    json.dump(doc, f)
with open(out + ".bin", "wb") as f:
    f.write(blob)
print("CONTRACT " + json.dumps({"bones": len(bones), "meshes": len(meshes),
                                "vertices": sum(m["vertex_count"] for m in meshes),
                                "morphs": sum(len(m["morphs"]) for m in meshes), "bin": len(blob)}))
