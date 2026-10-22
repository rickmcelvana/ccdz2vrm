"""Structural validator for VRM 1.0 files. Pure Python (numpy).

    python src/blender/vrm_check.py out/a.vrm [out/b.vrm ...]     # exit 1 on any error

The finisher and the web tier both rewrite buffers, accessors, skins and
materials after the VRM add-on has exported; AGENTS.md s3.6 warns that VRMC_*
extensions hold raw node/mesh/material indices. This checks what those rewrites
can break -- not the whole glTF spec (the Khronos validator is the reference;
see docs/ENVIRONMENT.md s18):

  container   GLB header/chunk lengths; bufferViews inside the buffer
  accessors   inside their view, aligned, sparse indices in range, POSITION min/max
  primitives  equal attribute counts, indices < vertex count, JOINTS < skin size,
              WEIGHTS sum to 1, same morph count across a mesh's primitives
  images      bytes match the declared mimeType
  VRMC_vrm    specVersion, required humanoid bones present, unique and valid;
              expression binds point at a real mesh node and morph index;
              first-person annotations and lookAt reference real nodes
"""

from __future__ import annotations

import glob
import json
import struct
import sys

import numpy as np

sys.path.insert(0, __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0])
from glb_web import COMP, NCOMP, Glb  # noqa: E402

REQUIRED_BONES = ["hips", "spine", "head", "leftUpperArm", "leftLowerArm", "leftHand",
                  "rightUpperArm", "rightLowerArm", "rightHand", "leftUpperLeg", "leftLowerLeg",
                  "leftFoot", "rightUpperLeg", "rightLowerLeg", "rightFoot"]
MAGIC = {"image/png": b"\x89PNG", "image/jpeg": b"\xff\xd8"}


def check(path):
    data = open(path, "rb").read()
    errs, warns, info = [], [], {"bytes": len(data)}
    if struct.unpack_from("<I", data, 0)[0] != 0x46546C67:
        return ["not a GLB"], warns, info
    if struct.unpack_from("<I", data, 8)[0] != len(data):
        errs.append("GLB header length != file size")
    g = Glb(data)
    j = g.j
    blen = len(g.bin)
    views, accs = j.get("bufferViews", []), j.get("accessors", [])

    for i, v in enumerate(views):
        if v.get("byteOffset", 0) + v["byteLength"] > blen:
            errs.append(f"bufferView {i} past end of buffer")
    for i, a in enumerate(accs):
        esize = np.dtype(COMP[a["componentType"]]).itemsize
        n = NCOMP[a["type"]]
        if "bufferView" in a:
            v = views[a["bufferView"]]
            stride = v.get("byteStride") or esize * n
            end = a.get("byteOffset", 0) + stride * (a["count"] - 1) + esize * n
            if end > v["byteLength"]:
                errs.append(f"accessor {i} overruns bufferView {a['bufferView']}")
            if (v.get("byteOffset", 0) + a.get("byteOffset", 0)) % esize:
                errs.append(f"accessor {i} misaligned")
        if "sparse" in a:
            idx = g._read_dense(a["sparse"]["indices"]["bufferView"], a["sparse"]["indices"].get("byteOffset", 0),
                                a["sparse"]["indices"]["componentType"], 1, a["sparse"]["count"])[:, 0]
            if len(idx) and int(idx.max()) >= a["count"]:
                errs.append(f"accessor {i} sparse index out of range")
            if len(idx) > 1 and np.any(np.diff(idx.astype(np.int64)) <= 0):
                errs.append(f"accessor {i} sparse indices not strictly increasing")

    nodes = j.get("nodes", [])
    mesh_skin = {n["mesh"]: n.get("skin") for n in nodes if "mesh" in n}
    verts = tris = 0
    for mi, m in enumerate(j.get("meshes", [])):
        ntargets = {len(p.get("targets", [])) for p in m["primitives"]}
        if len(ntargets) > 1:
            errs.append(f"mesh {mi} primitives disagree on morph target count {ntargets}")
        skin = j["skins"][mesh_skin[mi]] if mesh_skin.get(mi) is not None else None
        for pi, p in enumerate(m["primitives"]):
            at = p["attributes"]
            count = accs[at["POSITION"]]["count"]
            verts += count
            pa = accs[at["POSITION"]]
            if "min" not in pa or "max" not in pa:
                errs.append(f"mesh {mi}/{pi} POSITION without min/max")
            for k, ai in at.items():
                if accs[ai]["count"] != count:
                    errs.append(f"mesh {mi}/{pi} {k} count {accs[ai]['count']} != {count}")
            if "indices" in p:
                ix = g.read(p["indices"], as_float=False)
                tris += len(ix) // 3
                if len(ix) and int(ix.max()) >= count:
                    errs.append(f"mesh {mi}/{pi} index {int(ix.max())} >= vertex count {count}")
            for k in [k for k in at if k.startswith("JOINTS_")]:
                jt = g.read(at[k], as_float=False)
                w = g.read(at["WEIGHTS_" + k.split("_")[1]])
                if skin is None:
                    errs.append(f"mesh {mi} has JOINTS but its node has no skin")
                elif int(jt[w > 0].max(initial=0)) >= len(skin["joints"]):
                    errs.append(f"mesh {mi}/{pi} joint index beyond skin ({len(skin['joints'])} joints)")
            if "WEIGHTS_0" in at:
                s = sum(g.read(at[k]).sum(axis=1) for k in at if k.startswith("WEIGHTS_"))
                bad = int(np.sum(np.abs(s - 1.0) > 0.01))
                if bad:
                    errs.append(f"mesh {mi}/{pi} {bad} vertices with weights not summing to 1")
            for t in p.get("targets", []):
                for k, ai in t.items():
                    if accs[ai]["count"] != count:
                        errs.append(f"mesh {mi}/{pi} morph {k} count mismatch")
                    if k == "POSITION" and ("min" not in accs[ai] or "max" not in accs[ai]):
                        errs.append(f"mesh {mi}/{pi} morph POSITION without min/max")
    info.update(verts=verts, tris=tris, meshes=len(j.get("meshes", [])), materials=len(j.get("materials", [])))

    for i, img in enumerate(j.get("images", [])):
        if "bufferView" in img:
            head = g.view_bytes(img["bufferView"])[:4]
            want = MAGIC.get(img.get("mimeType"))
            if want is None or not head.startswith(want):
                errs.append(f"image {i} bytes do not match {img.get('mimeType')}")

    ext = j.get("extensions", {}).get("VRMC_vrm")
    if not ext:
        errs.append("no VRMC_vrm extension")
        return errs, warns, info
    if ext.get("specVersion") != "1.0":
        errs.append(f"VRMC_vrm specVersion {ext.get('specVersion')}")
    hb = ext.get("humanoid", {}).get("humanBones", {})
    for b in REQUIRED_BONES:
        if b not in hb:
            errs.append(f"humanoid missing required bone {b}")
    used = [v["node"] for v in hb.values()]
    if len(used) != len(set(used)):
        errs.append("humanoid: a node is used by two bones")
    if any(not (0 <= n < len(nodes)) for n in used):
        errs.append("humanoid: bone node index out of range")
    info["human_bones"] = len(hb)

    exprs = ext.get("expressions", {})
    all_expr = list(exprs.get("preset", {}).items()) + list(exprs.get("custom", {}).items())
    info["expressions"] = len(all_expr)
    empty = []
    for name, e in all_expr:
        binds = e.get("morphTargetBinds", [])
        for b in binds:
            n = b["node"]
            if not (0 <= n < len(nodes)) or "mesh" not in nodes[n]:
                errs.append(f"expression {name}: bind node {n} is not a mesh node")
                continue
            nt = len(j["meshes"][nodes[n]["mesh"]]["primitives"][0].get("targets", []))
            if not (0 <= b["index"] < nt):
                errs.append(f"expression {name}: morph index {b['index']} >= {nt} targets")
        for b in e.get("materialColorBinds", []) + e.get("textureTransformBinds", []):
            if not (0 <= b["material"] < len(j.get("materials", []))):
                errs.append(f"expression {name}: material bind out of range")
        if not binds and name in ("aa", "ih", "ou", "ee", "oh", "blink"):
            empty.append(name)
    if empty:
        errs.append(f"presets with no binds: {empty}")
    for a in ext.get("firstPerson", {}).get("meshAnnotations", []):
        if not (0 <= a["node"] < len(nodes)) or "mesh" not in nodes[a["node"]]:
            errs.append(f"firstPerson annotation node {a['node']} is not a mesh node")
    if ext.get("lookAt", {}).get("type") == "bone" and not {"leftEye", "rightEye"} <= set(hb):
        warns.append("lookAt type bone without eye bones")
    return errs, warns, info


def main(paths):
    # PowerShell passes `out\*.vrm` through unexpanded
    paths = [q for p in paths for q in (sorted(glob.glob(p)) if any(c in p for c in "*?[") else [p])]
    failed = False
    for p in paths:
        errs, warns, info = check(p)
        status = "FAIL" if errs else "ok"
        failed |= bool(errs)
        print(f"{status:4} {p}  {json.dumps(info)}")
        for e in errs[:20]:
            print(f"     ERROR {e}")
        if len(errs) > 20:
            print(f"     ... {len(errs) - 20} more")
        for w in warns:
            print(f"     warn  {w}")
    return 1 if failed else 0


if __name__ == "__main__":
    # also runs inside Blender (`blender --background --python vrm_check.py -- a.vrm`),
    # whose bundled Python has numpy, so the app needs no system Python
    sys.exit(main(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]))
