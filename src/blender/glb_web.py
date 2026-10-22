"""Web tier: shrink a finished VRM without leaving core glTF 2.0.

    python src/blender/glb_web.py in.vrm out.web.vrm [--max-texture 1024]
        [--normal-max 512] [--jpeg-quality 85] [--morph-eps 0.0001] [--keep-morph-normals]

Runs with the system Python (needs numpy + Pillow), not inside Blender. Every
step is plain glTF that three.js/three-vrm and other VRM loaders read without
opt-in decoders (no Draco/meshopt/KTX2 -- those need the app to register a
decoder):

1. textures  -- downscale; images with no transparency -> JPEG; normal maps
                smaller still. Cut-out/strand textures stay PNG (alpha), as a
                256-colour palette.
2. morphs    -- drop morph NORMALs (three-vrm lights expressions with the base
                normals; the visual cost is small at avatar scale) and store
                POSITION deltas sparsely, zeroing deltas below `--morph-eps`
                (MPFB face targets nudge every vertex by micrometres, so the
                exporter's own sparse pass never triggered).
3. skinning  -- each mesh gets a skin of only the joints it uses (Genesis:
                399 joints -> dozens), so JOINTS become uint8; WEIGHTS ->
                normalised uint8 (sums kept at exactly 255).
4. indices   -- uint16 when a primitive has < 65536 vertices.
5. UVs       -- normalised uint16 when every coordinate lies in [0, 1].

Then glb_dedupe repacks the binary chunk and drops what is no longer used.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import struct
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glb_dedupe import BIN_CHUNK, GLB_MAGIC, JSON_CHUNK, dedupe  # noqa: E402

COMP = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
NORM_MAX = {5120: 127.0, 5121: 255.0, 5122: 32767.0, 5123: 65535.0}


class Glb:
    def __init__(self, data: bytes):
        jlen = struct.unpack_from("<I", data, 12)[0]
        self.j = json.loads(data[20:20 + jlen])
        blen = struct.unpack_from("<I", data, 20 + jlen)[0]
        self.bin = bytearray(data[28 + jlen:28 + jlen + blen])

    # -- raw access --------------------------------------------------------------
    def view_bytes(self, i):
        v = self.j["bufferViews"][i]
        o = v.get("byteOffset", 0)
        return bytes(self.bin[o:o + v["byteLength"]])

    def add_view(self, raw: bytes, target=None):
        self.bin += b"\0" * (-len(self.bin) % 4)
        v = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(raw)}
        if target:
            v["target"] = target
        self.bin += raw
        self.j["bufferViews"].append(v)
        return len(self.j["bufferViews"]) - 1

    def _read_dense(self, view, offset, ctype, ncomp, count):
        dt = np.dtype(COMP[ctype])
        v = self.j["bufferViews"][view]
        stride = v.get("byteStride") or dt.itemsize * ncomp
        base = v.get("byteOffset", 0) + offset
        if stride == dt.itemsize * ncomp:
            return np.frombuffer(self.bin, dt, count * ncomp, base).reshape(count, ncomp).copy()
        rows = [np.frombuffer(self.bin, dt, ncomp, base + k * stride) for k in range(count)]
        return np.array(rows, dtype=dt)

    def read(self, i, as_float=True):
        """Accessor -> (count, ncomp) array; normalised ints -> floats if as_float."""
        a = self.j["accessors"][i]
        n, ct = NCOMP[a["type"]], a["componentType"]
        if "bufferView" in a:
            out = self._read_dense(a["bufferView"], a.get("byteOffset", 0), ct, n, a["count"])
        else:
            out = np.zeros((a["count"], n), COMP[ct])
        if "sparse" in a:
            s = a["sparse"]
            idx = self._read_dense(s["indices"]["bufferView"], s["indices"].get("byteOffset", 0),
                                   s["indices"]["componentType"], 1, s["count"])[:, 0]
            val = self._read_dense(s["values"]["bufferView"], s["values"].get("byteOffset", 0), ct, n, s["count"])
            out[idx.astype(np.int64)] = val
        if as_float and a.get("normalized") and ct in NORM_MAX:
            return out.astype(np.float32) / NORM_MAX[ct]
        return out

    def add_accessor(self, arr, ctype, atype, target=None, normalized=False, minmax=False):
        raw = np.ascontiguousarray(arr.astype(COMP[ctype])).tobytes()
        a = {"bufferView": self.add_view(raw, target), "componentType": ctype,
             "count": int(arr.shape[0]), "type": atype}
        if normalized:
            a["normalized"] = True
        if minmax:
            a["min"] = [float(x) for x in arr.min(axis=0)]
            a["max"] = [float(x) for x in arr.max(axis=0)]
        self.j["accessors"].append(a)
        return len(self.j["accessors"]) - 1

    def to_bytes(self):
        self.bin += b"\0" * (-len(self.bin) % 4)
        self.j["buffers"][0]["byteLength"] = len(self.bin)
        js = json.dumps(self.j, separators=(",", ":")).encode()
        js += b" " * (-len(js) % 4)
        total = 28 + len(js) + len(self.bin)
        return (struct.pack("<III", GLB_MAGIC, 2, total) + struct.pack("<II", len(js), JSON_CHUNK) + js +
                struct.pack("<II", len(self.bin), BIN_CHUNK) + bytes(self.bin))


# --- 1. textures ------------------------------------------------------------------
def shrink_textures(g, max_px, normal_px, quality, png_colors, report):
    j = g.j
    tex_src = {i: t.get("source") for i, t in enumerate(j.get("textures", []))}
    normal_imgs = {tex_src.get(m["normalTexture"]["index"]) for m in j.get("materials", [])
                   if "normalTexture" in m}
    out = []
    for i, img in enumerate(j.get("images", [])):
        if "bufferView" not in img:
            continue
        before = j["bufferViews"][img["bufferView"]]["byteLength"]
        im = Image.open(io.BytesIO(g.view_bytes(img["bufferView"])))
        im.load()
        limit = normal_px if i in normal_imgs else max_px
        if max(im.size) > limit:
            f = limit / max(im.size)
            im = im.resize((max(1, round(im.size[0] * f)), max(1, round(im.size[1] * f))), Image.LANCZOS)
        has_alpha = "A" in im.getbands() and im.getchannel("A").getextrema()[0] < 250
        buf = io.BytesIO()
        if has_alpha:
            if png_colors:
                # palette PNG with alpha: strand textures are mostly one hue
                im = im.convert("RGBA").quantize(png_colors, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
            im.save(buf, "PNG", optimize=True)
            mime = "image/png"
        else:
            im.convert("RGB").save(buf, "JPEG", quality=quality, optimize=True)
            mime = "image/jpeg"
        raw = buf.getvalue()
        if len(raw) < before:
            img["bufferView"] = g.add_view(raw)
            img["mimeType"] = mime
        out.append((img.get("name"), im.size[0], mime, before, min(len(raw), before)))
    report["textures"] = {"count": len(out), "bytes_before": sum(o[3] for o in out),
                          "bytes_after": sum(o[4] for o in out),
                          "png_kept_for_alpha": sum(1 for o in out if o[2] == "image/png")}


# --- 2-5. geometry -------------------------------------------------------------------
def compact_skins(g, report):
    """Give each skinned mesh a skin listing only the joints it uses.

    Genesis rigs have 399 joints, so JOINTS must be uint16 against the shared
    skin; no single mesh uses anywhere near 256 of them (G8 hair: a few dozen),
    so a per-mesh skin makes JOINTS uint8. VRM references nodes, not skins.
    """
    j = g.j
    made = 0
    for node in j.get("nodes", []):
        if "skin" not in node or "mesh" not in node:
            continue
        skin = j["skins"][node["skin"]]
        if len(skin["joints"]) < 256:
            continue
        prims = j["meshes"][node["mesh"]]["primitives"]
        pairs = []  # (joints accessor, weights accessor) per primitive set
        for p in prims:
            for k in p["attributes"]:
                if k.startswith("JOINTS_"):
                    pairs.append((p, k, p["attributes"]["WEIGHTS_" + k.split("_")[1]]))
        used = set()
        data = {}
        for p, k, wk in pairs:
            key = (p["attributes"][k], wk)
            if key not in data:
                jt = g.read(p["attributes"][k], as_float=False).astype(np.int64)
                w = g.read(wk)
                data[key] = (jt, w)
                used |= set(np.unique(jt[w > 0]).tolist())
        if not used or len(used) >= 256:
            continue
        used = sorted(used)
        remap = np.zeros(len(skin["joints"]), np.int64)
        remap[used] = np.arange(len(used))
        new = {k: v for k, v in skin.items() if k not in ("joints", "inverseBindMatrices")}
        new["joints"] = [skin["joints"][i] for i in used]
        if "inverseBindMatrices" in skin:
            ibm = g.read(skin["inverseBindMatrices"])
            new["inverseBindMatrices"] = g.add_accessor(ibm[used], 5126, "MAT4")
        j["skins"].append(new)
        node["skin"] = len(j["skins"]) - 1
        done = {}
        for p, k, wk in pairs:
            key = (p["attributes"][k], wk)
            if key not in done:
                jt, w = data[key]
                done[key] = g.add_accessor(np.where(w > 0, remap[jt], 0), 5121, "VEC4", 34962)
            p["attributes"][k] = done[key]
        made += 1
    report["skins_compacted"] = made


def shrink_geometry(g, eps, keep_morph_normals, report):
    j = g.j
    done = {}  # (kind, old accessor) -> new accessor, so shared data stays shared
    counts = {"morph_normals_dropped": 0, "morph_nonzero": 0, "morph_total": 0,
              "weights_u8": 0, "joints_u8": 0, "indices_u16": 0, "uv_u16": 0}

    def once(kind, idx, fn):
        key = (kind, idx)
        if key not in done:
            done[key] = fn(idx)
        return done[key]

    def sparse_morph(idx):
        d = g.read(idx).astype(np.float32)
        d[np.linalg.norm(d, axis=1) < eps] = 0.0
        nz = np.flatnonzero(np.any(d != 0.0, axis=1))
        if len(nz) == 0:
            nz = np.array([0])  # spec: sparse.count >= 1
        counts["morph_nonzero"] += int(len(nz))
        counts["morph_total"] += int(d.shape[0])
        ict = 5123 if d.shape[0] < 65536 else 5125
        a = {"componentType": 5126, "count": int(d.shape[0]), "type": "VEC3",
             "min": [float(x) for x in d.min(axis=0)], "max": [float(x) for x in d.max(axis=0)],
             "sparse": {"count": int(len(nz)),
                        "indices": {"bufferView": g.add_view(nz.astype(COMP[ict]).tobytes()), "componentType": ict},
                        "values": {"bufferView": g.add_view(d[nz].tobytes())}}}
        j["accessors"].append(a)
        return len(j["accessors"]) - 1

    def weights_u8(idx):
        w = g.read(idx).astype(np.float64)
        s = w.sum(axis=1, keepdims=True)
        w = np.divide(w, s, out=np.zeros_like(w), where=s > 0)
        q = np.floor(w * 255).astype(np.int32)
        short = 255 - q.sum(axis=1)
        short[s[:, 0] == 0] = 0
        frac = w * 255 - q
        order = np.argsort(-frac, axis=1)
        for k in range(4):  # hand the rounding remainder to the largest fractions
            add = short > k
            rows = np.flatnonzero(add)
            q[rows, order[rows, k]] += 1
        counts["weights_u8"] += 1
        return g.add_accessor(q, 5121, "VEC4", 34962, normalized=True)

    def joints_u8(idx):
        jt = g.read(idx, as_float=False)
        counts["joints_u8"] += 1
        return g.add_accessor(jt, 5121, "VEC4", 34962)

    def indices_u16(idx):
        ix = g.read(idx, as_float=False)
        counts["indices_u16"] += 1
        return g.add_accessor(ix, 5123, "SCALAR", 34963)

    def uv_u16(idx):
        uv = g.read(idx)
        counts["uv_u16"] += 1
        return g.add_accessor(np.round(np.clip(uv, 0, 1) * 65535), 5123, "VEC2", 34962, normalized=True)

    for m in j.get("meshes", []):
        for p in m["primitives"]:
            at = p["attributes"]
            nverts = j["accessors"][at["POSITION"]]["count"]
            for t in p.get("targets", []):
                for k in [k for k in t if k in ("NORMAL", "TANGENT")]:
                    if not keep_morph_normals:
                        del t[k]
                        counts["morph_normals_dropped"] += 1
                if "POSITION" in t:
                    t["POSITION"] = once("morph", t["POSITION"], sparse_morph)
            for k in list(at):
                a = j["accessors"][at[k]]
                if k.startswith("WEIGHTS") and a["componentType"] != 5121:
                    at[k] = once("w", at[k], weights_u8)
                elif k.startswith("JOINTS") and a["componentType"] != 5121:
                    if int(g.read(at[k], as_float=False).max()) < 256:
                        at[k] = once("j", at[k], joints_u8)
                elif k.startswith("TEXCOORD") and a["componentType"] == 5126:
                    uv = g.read(at[k])
                    if uv.min() >= 0.0 and uv.max() <= 1.0:
                        at[k] = once("uv", at[k], uv_u16)
            if "indices" in p and nverts < 65536 and j["accessors"][p["indices"]]["componentType"] == 5125:
                p["indices"] = once("ix", p["indices"], indices_u16)
    # a joint index on a zero weight is harmless but flagged by the Khronos
    # validator (ACCESSOR_JOINTS_USED_ZERO_WEIGHT); uint8 rounding creates some
    fixed = {}
    for m in j.get("meshes", []):
        for p in m["primitives"]:
            at = p["attributes"]
            for k in [k for k in at if k.startswith("JOINTS_")]:
                wk = "WEIGHTS_" + k.split("_")[1]
                key = (at[k], at[wk])
                if key not in fixed:
                    jt, w = g.read(at[k], as_float=False), g.read(at[wk])
                    stray = (w == 0) & (jt != 0)
                    fixed[key] = at[k]
                    if stray.any():
                        a = j["accessors"][at[k]]
                        fixed[key] = g.add_accessor(np.where(w == 0, 0, jt), a["componentType"], "VEC4", 34962)
                        counts["joints_zeroed"] = counts.get("joints_zeroed", 0) + int(stray.sum())
                at[k] = fixed[key]
    if counts["morph_total"]:
        counts["morph_density"] = round(counts["morph_nonzero"] / counts["morph_total"], 3)
    report["geometry"] = counts


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--max-texture", type=int, default=1024)
    ap.add_argument("--normal-max", type=int, default=512)
    ap.add_argument("--jpeg-quality", type=int, default=85)
    ap.add_argument("--png-colors", type=int, default=256, help="palette size for textures with alpha (0 = truecolour)")
    ap.add_argument("--morph-eps", type=float, default=1e-4, help="metres; smaller morph deltas are zeroed")
    ap.add_argument("--keep-morph-normals", action="store_true")
    args = ap.parse_args(argv)
    data = open(args.src, "rb").read()
    g = Glb(data)
    report = {"src_bytes": len(data)}
    shrink_textures(g, args.max_texture, args.normal_max, args.jpeg_quality, args.png_colors, report)
    compact_skins(g, report)
    shrink_geometry(g, args.morph_eps, args.keep_morph_normals, report)
    out, dd = dedupe(g.to_bytes())  # also drops every view/accessor the steps above replaced
    with open(args.dst, "wb") as f:
        f.write(out)
    report["dst_bytes"] = len(out)
    print("RESULT " + json.dumps(report))
    return report


if __name__ == "__main__":
    main()
