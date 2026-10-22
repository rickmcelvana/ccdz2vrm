"""VRM spring bones (VRMC_springBone) for the bones a hair or clothing item brings.

Daz/CC items ship their own bones (a store hair's `Fringe A`..`J`, `Left Tail
A`..`C`, `Left Bun`); after `import_fbx_clean` they hang off the figure's real
bones and ride them rigidly. Here they become springs so they swing.

`prepare` (Blender, before export):
  * item bone = not humanoid, not a skeleton copy (`X.00N`), weighted (> 0.05)
    on some item mesh and on no figure vertex (figure = body + meshes with face
    shape keys: teeth, lashes, brows), below a humanoid bone, and not
    below a bone that skins the body (CC's teeth hang off the jaw: figure, not item);
  * chains follow single item-bone children; each chain end gets a `<bone>_tip`
    bone, because FBX keeps only pivots (Blender invents a 16.5 cm tail in a
    random direction) and three-vrm swings a joint toward its child. The tip
    sits at the far end of the hair the bone carries: pivot + 1.6 x (weighted
    centroid - pivot), capped at the farthest weighted vertex;
  * colliders fitted to the body mesh (head sphere; neck, upper chest,
    shoulders, upper arms, thighs as capsules), then shrunk where a joint tip
    starts inside one -- a strand that rests inside a collider jumps on load.
`add_springs` (pure Python, after export) writes the extension: colliders sit
on humanoid nodes (so they follow `--twist-split`'s driver bones too), offsets
in each node's exported frame.
"""

from __future__ import annotations

import json
import math
import struct

GLB_MAGIC, JSON_CHUNK, BIN_CHUNK = 0x46546C67, 0x4E4F534A, 0x004E4942
MIN_W = 0.05
TIP_REACH = 1.6
SHORT = 0.12  # metres of lever: fringe-length strands are stiffer
PARAMS = {  # three-vrm units: stiffness and gravity per second, drag 0..1
    "short": {"stiffness": 1.6, "gravityPower": 0.05, "dragForce": 0.55, "hitRadius": 0.012},
    "long": {"stiffness": 0.9, "gravityPower": 0.15, "dragForce": 0.45, "hitRadius": 0.02},
}


def _gltf(v):
    """Blender world (Z up, -Y forward) -> glTF world (Y up, +Z forward)."""
    return (v[0], v[2], -v[1])


def prepare(armature, meshes, table):
    """Find item-bone chains, add tip bones, fit colliders. Returns the spec."""
    import bpy
    import numpy as np
    from mathutils import Vector

    bones = armature.data.bones
    humanoid = {b for b in table.values() if b in bones}
    body = max(meshes, key=lambda m: sum(n in m.vertex_groups for n in
                                          (table.get("left_hand"), table.get("left_foot"), table.get("head"))))
    # The figure is the body plus every mesh that carries face shape keys: CC teeth
    # (the jaw is baked into them), lashes, strand brows. Their bones are the
    # figure's -- CC's upper teeth hang straight off the head and swung as a spring.
    # Item meshes have none: adapt_daz drops non-face keys; CC hair and clothes
    # in the five test exports carried none.
    figure = {body} | {m for m in meshes if m.data.shape_keys and len(m.data.shape_keys.key_blocks) > 1}
    used_body, used_items = set(), {}
    for m in meshes:
        gname = {g.index: g.name for g in m.vertex_groups}
        for v in m.data.vertices:
            for g in v.groups:
                if g.weight > MIN_W:
                    n = gname[g.group]
                    if m in figure:
                        used_body.add(n)
                    else:
                        used_items.setdefault(n, set()).add(m.name)

    def is_copy(n):
        base, _, tail = n.rpartition(".")
        return tail.isdigit() and base in bones

    def under_humanoid(b):
        b = b.parent
        while b is not None:
            if b.name in humanoid:
                return True
            b = b.parent
        return False

    def via_figure(b):
        """True if a non-humanoid bone that skins the body sits between b and its
        humanoid ancestor: b belongs to the figure's own rig (CC teeth hang off
        CC_Base_JawRoot, which skins the chin), not to an item."""
        b = b.parent
        while b is not None and b.name not in humanoid:
            if b.name in used_body:
                return True
            b = b.parent
        return False

    item = {n for n in used_items if n in bones and n not in humanoid and n not in used_body
            and not is_copy(n) and under_humanoid(bones[n]) and not via_figure(bones[n])}
    roots = [n for n in item if not (bones[n].parent and bones[n].parent.name in item)]
    chains = []
    for r in sorted(roots):
        stack = [[r]]
        while stack:
            ch = stack.pop()
            kids = sorted(c.name for c in bones[ch[-1]].children if c.name in item)
            if len(kids) == 1:
                stack.append(ch + kids)
            else:
                chains.append(ch)
                stack.extend([[k] for k in kids])

    # tip of each chain end: where the hair it carries ends
    mw = armature.matrix_world
    tips = {}
    for ch in chains:
        end = ch[-1]
        pivot = np.array((mw @ bones[end].head_local)[:])
        acc, wsum, far = np.zeros(3), 0.0, 0.0
        for m in meshes:
            vg = m.vertex_groups.get(end)
            if vg is None or m is body:
                continue
            for v in m.data.vertices:
                for g in v.groups:
                    if g.group == vg.index and g.weight > MIN_W:
                        p = np.array((m.matrix_world @ v.co)[:])
                        acc += p * g.weight
                        wsum += g.weight
                        far = max(far, float(np.linalg.norm(p - pivot)))
        if wsum == 0:
            continue
        d = acc / wsum - pivot
        L = min(float(np.linalg.norm(d)) * TIP_REACH, far)
        if L < 0.01:
            continue
        tips[end] = pivot + d / np.linalg.norm(d) * L

    # A chain root under a helper bone (`Left Tail`: unweighted, neither
    # humanoid nor a spring) is re-parented onto its humanoid ancestor.
    # three-vrm 3.5.5's VRM 1.0 loader initialises springs without updating
    # world matrices first; a joint whose parent is such a helper read the
    # helper's stale identity matrix and flung its strand on the first frame
    # (Alice's Tail A: 61 cm, settling after ~1 s). Humanoid parents are fine.
    def humanoid_above(b):
        b = b.parent
        while b is not None and b.name not in humanoid:
            b = b.parent
        return b.name if b is not None else None
    lift = {ch[0]: humanoid_above(bones[ch[0]]) for ch in chains
            if bones[ch[0]].parent is not None and bones[ch[0]].parent.name not in humanoid}

    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.mode_set(mode="EDIT")
    eb = armature.data.edit_bones
    for n, up in lift.items():
        if up:
            eb[n].use_connect = False
            eb[n].parent = eb[up]
    inv = mw.inverted()
    for end, p in tips.items():
        t = eb.new(f"{end}_tip")
        t.head = inv @ Vector(p)
        t.tail = t.head + (t.head - eb[end].head).normalized() * 0.02
        t.parent, t.use_connect = eb[end], False
        t.use_deform = True  # the exporter keeps only deform + humanoid bones; no group names it
    bpy.ops.object.mode_set(mode="OBJECT")

    # colliders from the body mesh: verts grouped by their dominant bone
    co = np.array([(body.matrix_world @ v.co)[:] for v in body.data.vertices])
    gname = {g.index: g.name for g in body.vertex_groups}
    dom = np.array([gname[max(v.groups, key=lambda g: g.weight).group] if v.groups else "" for v in body.data.vertices])

    def under(n, top):
        b = bones.get(n)
        while b is not None:
            if b.name == top:
                return True
            b = b.parent
        return False

    def owner(n):
        """Nearest humanoid bone at or above n (toes belong to the foot, not the thigh)."""
        b = bones.get(n)
        while b is not None and b.name not in humanoid:
            b = b.parent
        return b.name if b is not None else None

    def pos(vrm_bone):
        n = table.get(vrm_bone)
        return np.array((mw @ bones[n].head_local)[:]) if n in bones else None

    def seg_dist(p, a, b):
        ab = b - a
        t = np.clip(((p - a) @ ab) / max(ab @ ab, 1e-9), 0, 1)
        return np.linalg.norm(p - (a + t[:, None] * ab), axis=1)

    colliders = []
    head_n = table.get("head")
    if head_n in bones:
        hv = co[np.array([under(n, head_n) for n in dom])]
        hv = hv[hv[:, 2] > pos("head")[2]]
        lo, hi = hv.min(0), hv.max(0)
        c = (lo + hi) / 2
        colliders.append({"bone": "head", "sphere": c, "r": 0.9 * min(hi[0] - lo[0], hi[1] - lo[1]) / 2})
    for vrm_bone, a_b, b_b, bone_set in (
            ("neck", "neck", "head", ("neck",)),
            ("upperChest", "upper_chest", "neck", ("upper_chest",)),
            ("leftShoulder", "left_shoulder", "left_upper_arm", ("left_shoulder",)),
            ("rightShoulder", "right_shoulder", "right_upper_arm", ("right_shoulder",)),
            ("leftUpperArm", "left_upper_arm", "left_lower_arm", ("left_upper_arm",)),
            ("rightUpperArm", "right_upper_arm", "right_lower_arm", ("right_upper_arm",)),
            ("leftUpperLeg", "left_upper_leg", "left_lower_leg", ("left_upper_leg",)),
            ("rightUpperLeg", "right_upper_leg", "right_lower_leg", ("right_upper_leg",))):
        a, b = pos(a_b), pos(b_b)
        names = {table[x] for x in bone_set if x in table}
        if a is None or b is None or not names:
            continue
        own = {d: owner(d) for d in set(dom)}
        sel = np.array([own[d] in names for d in dom])
        if sel.sum() < 20:
            continue
        r = 0.85 * float(np.median(seg_dist(co[sel], a, b)))
        colliders.append({"bone": vrm_bone, "capsule": (a, b), "r": r})

    # no joint tip may start inside a collider
    tip_pts = []
    for ch in chains:
        for n in ch[1:]:
            tip_pts.append((np.array((mw @ bones[n].head_local)[:]), n))
        if ch[-1] in tips:
            tip_pts.append((tips[ch[-1]], ch[-1] + "_tip"))
    hit_max = max(p["hitRadius"] for p in PARAMS.values())
    shrunk = {}
    for c in colliders:
        for p, n in tip_pts:
            d = (float(np.linalg.norm(p - c["sphere"])) if "sphere" in c
                 else float(seg_dist(p[None], *c["capsule"])[0]))
            room = d - hit_max - 0.005
            if room < c["r"]:
                shrunk[c["bone"]] = round(max(room, 0.0), 3)
                c["r"] = max(room, 0.0)
    colliders = [c for c in colliders if c["r"] > 0.01]

    springs = []
    for ch in chains:
        if ch[-1] not in tips:
            continue
        lever = float(np.linalg.norm(tips[ch[-1]] - np.array((mw @ bones[ch[0]].head_local)[:])))
        springs.append({"name": ch[0], "joints": ch + [ch[-1] + "_tip"],
                        "params": PARAMS["short" if lever < SHORT else "long"], "lever": round(lever, 3)})
    spec = {"springs": springs,
            "colliders": [{"bone": c["bone"], "r": c["r"],
                           **({"sphere": _gltf(c["sphere"])} if "sphere" in c else
                              {"capsule": (_gltf(c["capsule"][0]), _gltf(c["capsule"][1]))})} for c in colliders]}
    report = {"springs": {s["name"]: [len(s["joints"]) - 1, s["lever"]] for s in springs},
              "colliders": {c["bone"]: round(c["r"], 3) for c in colliders}, "colliders_shrunk": shrunk,
              "roots_lifted": len([u for u in lift.values() if u])}
    return spec, report


# --- glTF side -------------------------------------------------------------------
def add_springs(path, spec):
    from twist_split import _conj, _qrot, _world

    data = open(path, "rb").read()
    magic, version, _ = struct.unpack_from("<III", data, 0)
    assert magic == GLB_MAGIC
    jlen, _ = struct.unpack_from("<II", data, 12)
    j = json.loads(data[20:20 + jlen])
    rest = data[20 + jlen:]
    nodes = j["nodes"]
    idx = {n.get("name"): i for i, n in enumerate(nodes)}
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}
    human = j["extensions"]["VRMC_vrm"]["humanoid"]["humanBones"]

    def local(node, p):
        q, t = _world(nodes, parent, node)
        return [round(c, 6) for c in _qrot(_conj(q), [a - b for a, b in zip(p, t)])]

    colliders = []
    for c in spec["colliders"]:
        hb = human.get(c["bone"])
        if hb is None:
            continue
        node = hb["node"]
        shape = ({"sphere": {"offset": local(node, c["sphere"]), "radius": round(c["r"], 4)}} if "sphere" in c else
                 {"capsule": {"offset": local(node, c["capsule"][0]), "tail": local(node, c["capsule"][1]),
                              "radius": round(c["r"], 4)}})
        colliders.append({"node": node, "shape": shape})
    springs = []
    for s in spec["springs"]:
        if not all(n in idx for n in s["joints"]):
            continue
        springs.append({"name": s["name"], "colliderGroups": [0] if colliders else [],
                        "joints": [{"node": idx[n], "gravityDir": [0, -1, 0], **s["params"]} for n in s["joints"]]})
    j.setdefault("extensions", {})["VRMC_springBone"] = {
        "specVersion": "1.0", "colliders": colliders,
        "colliderGroups": [{"name": "body", "colliders": list(range(len(colliders)))}] if colliders else [],
        "springs": springs}
    used = j.setdefault("extensionsUsed", [])
    if "VRMC_springBone" not in used:
        used.append("VRMC_springBone")
    js = json.dumps(j, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    body = struct.pack("<II", len(js), JSON_CHUNK) + js + rest
    open(path, "wb").write(struct.pack("<III", GLB_MAGIC, version, 12 + len(body)) + body)
    return {"springs": len(springs), "joints": sum(len(s["joints"]) for s in springs), "colliders": len(colliders)}
