"""Split a limb's twist across its bend and twist bones with VRM node constraints.

A VRM player rotates only humanoid bones. On a Daz arm (ShldrBend -> ShldrTwist
-> ForearmBend -> ForearmTwist -> Hand) the humanoid upper/lower arm is the
BEND bone, so a 90 deg forearm roll lands entirely at the elbow and the
linear-blend skin collapses there to 77 % of its radius. Daz means the twist to
run along the limb; split 45/45 between bend and twist bone the worst slice
keeps 92 % (measured, ENVIRONMENT s25). Putting all of it on the twist bone is
no better (71 % mid-limb).

Per limb, in Blender (`restructure`), all new bones and the bend bone share one
limb-aligned frame, so the constraints read the roll about one local axis:

    parent ── <bend>_pre ─┬─ <bend>_drv   humanoid bone; the animation lands here
                          │     └─ <twist>   (full roll, as before)
                          └─ <bend>_swing   aim at the limb's end -> swing, no roll
                                └─ <bend>    roll 0.5 from _drv

Then `add_constraints` fixes the exported frames (the exporter writes its own
for non-humanoid bones; `_realign`) and writes VRMC_node_constraint into the
file: aim on _swing, roll (weight 0.5) on the bend bone. A player WITHOUT node-constraint support leaves the bend bones
unposed (the shoulder and elbow regions stay put), so this is opt-in
(`vrm_export.py --twist-split`); three-vrm and UniVRM 1.x support it.
"""

from __future__ import annotations

import json
import math
import struct

GLB_MAGIC, JSON_CHUNK, BIN_CHUNK = 0x46546C67, 0x4E4F534A, 0x004E4942
ROLL_WEIGHT = 0.5

# family -> [(humanoid name, bend, twist, end bone (head = limb end), parent)]
CHAINS = {
    "daz_genesis3_8": [
        (f"{side}_{vrm}", f"{s}{bend}", f"{s}{twist}", f"{s}{end}", f"{s}{parent}")
        for side, s in (("left", "l"), ("right", "r"))
        for vrm, bend, twist, end, parent in (
            ("upper_arm", "ShldrBend", "ShldrTwist", "ForearmBend", "Collar"),
            ("lower_arm", "ForearmBend", "ForearmTwist", "Hand", "ShldrTwist"))
    ],
}


def restructure(armature, family):
    """Insert _pre/_drv/_swing bones; return {humanoid name: drv bone} or {} if unsupported."""
    import bpy
    chains = CHAINS.get(family)
    if not chains:
        return {}
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.mode_set(mode="EDIT")
    eb = armature.data.edit_bones
    remap = {}
    for vrm, bend, twist, end, parent in chains:
        b, t = eb[bend], eb[twist]
        head = b.head.copy()
        axis = (eb[end].head - head)
        tail = head + axis * 0.5

        def new(name, par):
            n = eb.new(name)
            n.head, n.tail, n.roll = head, tail, 0.0
            # deform=True: the exporter keeps only deform + humanoid bones; no
            # vertex group names these, so they move no vertex
            n.parent, n.use_connect, n.use_deform = par, False, True
            return n
        pre = new(f"{bend}_pre", eb[parent])
        drv = new(f"{bend}_drv", pre)
        swing = new(f"{bend}_swing", pre)
        b.use_connect = False
        b.tail, b.roll = tail, 0.0  # rest frame only; the skin is unchanged at rest
        b.parent = swing
        t.use_connect = False
        t.parent = drv
        remap[vrm] = drv.name
    bpy.ops.object.mode_set(mode="OBJECT")
    return remap


# --- glTF side (pure Python) ------------------------------------------------------
def _qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz)


def _qrot(q, v):
    x, y, z, w = q
    p = _qmul(_qmul(q, (v[0], v[1], v[2], 0.0)), (-x, -y, -z, w))
    return p[:3]


def _world(nodes, parent, i):
    """World (rotation, translation) of node i; scale is 1 on an exported rig."""
    chain = []
    while i is not None:
        chain.append(i)
        i = parent.get(i)
    q, t = (0.0, 0.0, 0.0, 1.0), (0.0, 0.0, 0.0)
    for k in reversed(chain):
        n = nodes[k]
        lt = n.get("translation", [0, 0, 0])
        lq = n.get("rotation", [0, 0, 0, 1])
        t = tuple(a + b for a, b in zip(t, _qrot(q, lt)))
        q = _qmul(q, lq)
    return q, t


def _conj(q):
    return (-q[0], -q[1], -q[2], q[3])


def _unit(q):
    """Renormalised: chained float32 parent rotations drift |q| by ~1e-6, and
    the Khronos validator rejects a written component above 1."""
    n = math.sqrt(sum(c * c for c in q))
    return [c / n for c in q]


def _from_to(a, b):
    """Shortest rotation taking unit vector a onto unit vector b."""
    c = (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
    w = 1.0 + sum(x * y for x, y in zip(a, b))
    n = math.sqrt(sum(x * x for x in c) + w * w)
    return (c[0] / n, c[1] / n, c[2] / n, w / n)


def _inverse_bind(q, t):
    """Column-major glTF mat4 = inverse(T(t) R(q))."""
    iq = _conj(q)
    it = [-c for c in _qrot(iq, t)]
    cols = [_qrot(iq, e) for e in ((1, 0, 0), (0, 1, 0), (0, 0, 1))]
    return [*cols[0], 0.0, *cols[1], 0.0, *cols[2], 0.0, *it, 1.0]


def _realign(j, binary, nodes, parent, idx, bend, end):
    """Turn <bend>_pre so its local +Y runs exactly along the limb.

    The exporter writes its own frame for non-humanoid bones (Feng's forearm
    _pre came out 31 deg off the limb), and VRM roll/aim axes must be a local
    X/Y/Z. _swing and the bend bone sit at identity under _pre and follow it;
    _drv keeps its world rest (its local is recomputed); the bend bone is a
    skin joint, so its inverse bind matrix is rewritten to its new frame --
    the skin is unchanged at rest.
    """
    pre, drv, sw, bd = idx[f"{bend}_pre"], idx[f"{bend}_drv"], idx[f"{bend}_swing"], idx[bend]
    q_pre, t_pre = _world(nodes, parent, pre)
    old = {k: _world(nodes, parent, k) for k in (drv, sw, bd)}
    _, t_end = _world(nodes, parent, idx[end])
    d = [a - b for a, b in zip(t_end, t_pre)]
    n = math.sqrt(sum(c * c for c in d))
    d = [c / n for c in d]
    q_new = _qmul(_from_to(_qrot(q_pre, (0, 1, 0)), d), q_pre)
    q_par, _ = _world(nodes, parent, parent[pre])
    nodes[pre]["rotation"] = _unit(_qmul(_conj(q_par), q_new))
    # children keep their world position; _drv its world rotation, _swing and
    # the bend bone take the new frame (identity under their parent)
    for k, q_world in ((drv, old[drv][0]), (sw, q_new), (bd, q_new)):
        pq, pt = _world(nodes, parent, parent[k])
        nodes[k]["rotation"] = _unit(_qmul(_conj(pq), q_world))
        nodes[k]["translation"] = list(_qrot(_conj(pq), [a - b for a, b in zip(old[k][1], pt)]))
    ibm = struct.pack("<16f", *_inverse_bind(q_new, old[bd][1]))
    for skin in j.get("skins", []):
        if bd in skin["joints"] and "inverseBindMatrices" in skin:
            acc = j["accessors"][skin["inverseBindMatrices"]]
            bv = j["bufferViews"][acc["bufferView"]]
            off = bv.get("byteOffset", 0) + acc.get("byteOffset", 0) + 64 * skin["joints"].index(bd)
            binary[off:off + 64] = ibm


def add_constraints(path, family):
    """Write aim + roll constraints for every restructured limb. Returns a report."""
    chains = CHAINS.get(family)
    data = open(path, "rb").read()
    magic, version, _ = struct.unpack_from("<III", data, 0)
    assert magic == GLB_MAGIC
    jlen, jtype = struct.unpack_from("<II", data, 12)
    j = json.loads(data[20:20 + jlen])
    blen, btype = struct.unpack_from("<II", data, 20 + jlen)
    assert btype == BIN_CHUNK
    binary = bytearray(data[28 + jlen:28 + jlen + blen])
    nodes = j["nodes"]
    idx = {n.get("name"): i for i, n in enumerate(nodes)}
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}
    report = {}
    for _v, bend, _t, end, _p in chains:  # parents first: the upper arm's realign moves the forearm's frames
        _realign(j, binary, nodes, parent, idx, bend, end)
    for vrm, bend, twist, end, _p in chains:
        sw, bd, dv, en = idx[f"{bend}_swing"], idx[bend], idx[f"{bend}_drv"], idx[end]
        q, t = _world(nodes, parent, sw)
        _, te = _world(nodes, parent, en)
        d = [a - b for a, b in zip(te, t)]
        n = math.sqrt(sum(c * c for c in d))
        inv = (-q[0], -q[1], -q[2], q[3])
        local = [c / n for c in _qrot(inv, d)]
        k = max(range(3), key=lambda c: abs(local[c]))
        if abs(local[k]) < 0.995:
            raise SystemExit(f"twist split: {bend} limb axis not on a local axis: {local}")
        axis = "XYZ"[k]
        sign = "Positive" if local[k] > 0 else "Negative"
        # the bend bone must sit at identity under _swing, or the roll axis differs
        rq = nodes[bd].get("rotation", [0, 0, 0, 1])
        if abs(abs(rq[3]) - 1) > 1e-4:
            raise SystemExit(f"twist split: {bend} is not at rest identity under _swing: {rq}")
        nodes[sw].setdefault("extensions", {})["VRMC_node_constraint"] = {
            "specVersion": "1.0", "constraint": {"aim": {"source": en, "aimAxis": sign + axis, "weight": 1.0}}}
        nodes[bd].setdefault("extensions", {})["VRMC_node_constraint"] = {
            "specVersion": "1.0", "constraint": {"roll": {"source": dv, "rollAxis": axis, "weight": ROLL_WEIGHT}}}
        report[vrm] = f"{sign}{axis}"
    used = j.setdefault("extensionsUsed", [])
    if "VRMC_node_constraint" not in used:
        used.append("VRMC_node_constraint")
    js = json.dumps(j, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    body = struct.pack("<II", len(js), JSON_CHUNK) + js + struct.pack("<II", len(binary), BIN_CHUNK) + bytes(binary)
    open(path, "wb").write(struct.pack("<III", GLB_MAGIC, version, 12 + len(body)) + body)
    return report
