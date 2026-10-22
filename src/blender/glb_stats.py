"""Where the bytes are in a GLB/VRM. Pure Python (no bpy).

    python src/blender/glb_stats.py out/a.vrm [out/b.vrm ...]

Counts each bufferView once (shared data is not double-counted) and
attributes it to the first thing that references it: an image, or a mesh's
attribute / indices / morph targets.
"""

from __future__ import annotations

import collections
import json
import struct
import sys


def read_glb(path):
    data = open(path, "rb").read()
    jlen = struct.unpack_from("<I", data, 12)[0]
    return json.loads(data[20:20 + jlen]), len(data)


def stats(path):
    j, total = read_glb(path)
    views = j.get("bufferViews", [])
    owner = {}

    def claim(view, label):
        if view is not None and view not in owner:
            owner[view] = label

    for img in j.get("images", []):
        claim(img.get("bufferView"), f"image {img.get('mimeType', '?')}")
    accs = j.get("accessors", [])

    def claim_acc(i, label):
        a = accs[i]
        claim(a.get("bufferView"), label)
        if "sparse" in a:
            claim(a["sparse"]["indices"]["bufferView"], label)
            claim(a["sparse"]["values"]["bufferView"], label)

    for m in j.get("meshes", []):
        for p in m["primitives"]:
            for k, i in p["attributes"].items():
                claim_acc(i, f"attr {k.split('_')[0]}")
            if "indices" in p:
                claim_acc(p["indices"], "indices")
            for t in p.get("targets", []):
                for k, i in t.items():
                    claim_acc(i, f"morph {k}")
    for s in j.get("skins", []):
        if "inverseBindMatrices" in s:
            claim_acc(s["inverseBindMatrices"], "skin")
    by = collections.Counter()
    for v, label in owner.items():
        by[label] += views[v]["byteLength"]
    by["(json+header)"] = total - sum(v["byteLength"] for v in views)
    per_mesh = {}
    for m in j.get("meshes", []):
        verts = sum(accs[p["attributes"]["POSITION"]]["count"] for p in m["primitives"])
        ntar = max((len(p.get("targets", [])) for p in m["primitives"]), default=0)
        per_mesh[m.get("name", "?")] = (len(m["primitives"]), verts, ntar)
    imgs = [(img.get("name"), img.get("mimeType"), views[img["bufferView"]]["byteLength"])
            for img in j.get("images", []) if "bufferView" in img]
    return total, by, per_mesh, imgs


if __name__ == "__main__":
    for path in sys.argv[1:]:
        total, by, per_mesh, imgs = stats(path)
        print(f"== {path}: {total / 1e6:.1f} MB")
        for k, v in by.most_common():
            print(f"   {k:<22} {v / 1e6:7.2f} MB")
        print("   meshes (primitives, verts, morphs):",
              ", ".join(f"{k} {v}" for k, v in sorted(per_mesh.items(), key=lambda kv: -kv[1][1])[:6]))
        print("   largest images:", ", ".join(f"{n} {m} {b / 1e6:.1f}" for n, m, b in sorted(imgs, key=lambda x: -x[2])[:6]))
