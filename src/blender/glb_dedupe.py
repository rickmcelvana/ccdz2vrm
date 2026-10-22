"""Store identical GLB buffer data once. Pure Python (no bpy), so it runs inside
Blender after export or standalone:

    python src/blender/glb_dedupe.py in.vrm [out.vrm]

Exporters write every primitive's data separately, even when two primitives
are the same geometry (the finisher's hair fringe pass is a byte-identical copy
of the core pass). This hashes bufferViews and accessors, points duplicates at
the first copy and rebuilds the binary chunk. Shared accessors also let
three.js's GLTFLoader reuse one BufferAttribute (it caches by accessor index),
so the saving carries over to GPU memory.
"""

from __future__ import annotations

import hashlib
import json
import struct
import sys

GLB_MAGIC, JSON_CHUNK, BIN_CHUNK = 0x46546C67, 0x4E4F534A, 0x004E4942


def _remap_key(node, key, mapping):
    """Rewrite every `key: int` anywhere in the JSON tree through `mapping`."""
    if isinstance(node, dict):
        for k, v in node.items():
            if k == key and isinstance(v, int):
                node[k] = mapping[v]
            else:
                _remap_key(v, key, mapping)
    elif isinstance(node, list):
        for v in node:
            _remap_key(v, key, mapping)


def _accessor_refs(j):
    """Yield (container, key) for every place glTF 2.0 references an accessor."""
    for mesh in j.get("meshes", []):
        for p in mesh["primitives"]:
            for k in p.get("attributes", {}):
                yield p["attributes"], k
            if "indices" in p:
                yield p, "indices"
            for t in p.get("targets", []):
                for k in t:
                    yield t, k
    for s in j.get("skins", []):
        if "inverseBindMatrices" in s:
            yield s, "inverseBindMatrices"
    for a in j.get("animations", []):
        for s in a.get("samplers", []):
            yield s, "input"
            yield s, "output"


def dedupe(data: bytes) -> tuple[bytes, dict]:
    magic, _version, _length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC:
        raise ValueError("not a GLB")
    jlen, jtype = struct.unpack_from("<II", data, 12)
    assert jtype == JSON_CHUNK
    j = json.loads(data[20:20 + jlen])
    blen, btype = struct.unpack_from("<II", data, 20 + jlen)
    assert btype == BIN_CHUNK
    bin_ = data[28 + jlen:28 + jlen + blen]

    # 1. bufferViews: same bytes + same stride/target -> one view
    views = j["bufferViews"]
    first, view_map = {}, {}
    for i, v in enumerate(views):
        o = v.get("byteOffset", 0)
        key = (hashlib.sha1(bin_[o:o + v["byteLength"]]).digest(), v.get("byteStride"), v.get("target"))
        view_map[i] = first.setdefault(key, i)
    _remap_key(j, "bufferView", view_map)

    # 2. accessors: identical after step 1 -> one accessor
    accs = j.get("accessors", [])
    first, acc_map = {}, {}
    for i, a in enumerate(accs):
        acc_map[i] = first.setdefault(json.dumps(a, sort_keys=True), i)
    for container, k in _accessor_refs(j):
        container[k] = acc_map[container[k]]

    # 3. drop unreferenced accessors and views, repack the binary chunk
    # (glb_web replaces accessors; the originals are left unreferenced)
    used_acc = sorted({c[k] for c, k in _accessor_refs(j)})
    new_acc = {old: new for new, old in enumerate(used_acc)}
    j["accessors"] = [accs[i] for i in used_acc]
    for container, k in _accessor_refs(j):
        container[k] = new_acc[container[k]]
    used_views = set()

    def collect(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if k == "bufferView" and isinstance(v, int):
                    used_views.add(v)
                else:
                    collect(v)
        elif isinstance(node, list):
            for v in node:
                collect(v)
    collect({k: v for k, v in j.items() if k != "bufferViews"})
    order = sorted(used_views)
    new_view = {old: new for new, old in enumerate(order)}
    out_bin = bytearray()
    new_views = []
    for old in order:
        v = dict(views[old])
        o = v.get("byteOffset", 0)
        chunk = bin_[o:o + v["byteLength"]]
        out_bin += b"\0" * (-len(out_bin) % 4)
        v["byteOffset"] = len(out_bin)
        out_bin += chunk
        new_views.append(v)
    out_bin += b"\0" * (-len(out_bin) % 4)
    j["bufferViews"] = new_views
    _remap_key({k: v for k, v in j.items() if k != "bufferViews"}, "bufferView", new_view)
    j["buffers"][0]["byteLength"] = len(out_bin)

    js = json.dumps(j, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    total = 12 + 8 + len(js) + 8 + len(out_bin)
    out = struct.pack("<III", GLB_MAGIC, 2, total) + struct.pack("<II", len(js), JSON_CHUNK) + js + \
        struct.pack("<II", len(out_bin), BIN_CHUNK) + bytes(out_bin)
    stats = {"bytes_before": len(data), "bytes_after": len(out),
             "views": [len(views), len(new_views)], "accessors": [len(accs), len(used_acc)]}
    return out, stats


def dedupe_file(src: str, dst: str | None = None) -> dict:
    with open(src, "rb") as f:
        out, stats = dedupe(f.read())
    with open(dst or src, "wb") as f:
        f.write(out)
    return stats


if __name__ == "__main__":
    print(json.dumps(dedupe_file(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)))
