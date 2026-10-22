"""Reduce hair-card meshes without crumpling them (web tier).

Hair from Daz/CC is thousands of textured ribbons. Blender's collapse
decimation cannot keep a ribbon's width (spikes); planar dissolve turns each
ribbon into one n-gon that triangulates badly (the G8 braid vanished) -- both
verified in three-vrm. What works is removing whole cross-sections:

- quad STRIPS (2 verts wide, Genesis 8 "Audrey"): dissolve every other rung,
  keeping any vertex whose removal would bend the ribbon by more than `tol`
  metres (2.5 mm: G8 hair 363k -> 88k verts; 1 mm stalled at 112k) or shift
  its texture by more than `uv_tol`;
- quad GRIDS (Genesis 3 Krayon): one pass of Un-Subdivide halves both ways.

Triangulated ribbons are paired back into quads first.
"""

from __future__ import annotations

import bmesh
import bpy


def _activate(obj):
    for o in bpy.context.selected_objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def _seg_dist(v, p, q):
    d = q - p
    L = d.length_squared
    t = 0.0 if L == 0 else max(0.0, min(1.0, (v - p).dot(d) / L))
    return (v - (p + d * t)).length, t


def _uv(bm_vert, uv_layer, face):
    for loop in bm_vert.link_loops:
        if loop.face is face:
            return loop[uv_layer].uv
    return bm_vert.link_loops[0][uv_layer].uv


def remove_alternate_rungs(bm, tol, uv_tol):
    """One pass over quad strips; returns the number of rungs dissolved."""
    uv = bm.loops.layers.uv.active
    locked, rungs = set(), []
    for e in bm.edges:
        if len(e.link_faces) != 2 or e.is_boundary:
            continue
        a, b = e.verts
        if a in locked or b in locked or not (a.is_boundary and b.is_boundary):
            continue
        if any(len(f.verts) != 4 for f in e.link_faces):
            continue
        ok, near = True, []
        f0 = e.link_faces[0]
        for v in (a, b):
            be = [x for x in v.link_edges if x is not e]
            if len(v.link_edges) != 3 or not all(x.is_boundary for x in be):
                ok = False
                break
            p, q = be[0].other_vert(v), be[1].other_vert(v)
            d, t = _seg_dist(v.co, p.co, q.co)
            if d > tol:
                ok = False
                break
            if uv is not None:
                # p and q lie in different faces of the pair; take each from its own
                fp = next(f for f in be[0].link_faces)
                fq = next(f for f in be[1].link_faces)
                up, uq, uvv = _uv(p, uv, fp), _uv(q, uv, fq), _uv(v, uv, f0)
                if ((up + (uq - up) * t) - uvv).length > uv_tol:
                    ok = False
                    break
            near += [p, q]
        if not ok:
            continue
        rungs.append(e)
        locked.update((a, b, *near))
    if rungs:
        bmesh.ops.dissolve_edges(bm, edges=rungs, use_verts=True, use_face_split=False)
    return len(rungs)


def simplify_cards(obj, budget, tol=0.0025, uv_tol=0.008, max_passes=8):
    """Reduce `obj` (a mesh WITHOUT shape keys) towards `budget` verts.
    Returns a small report dict."""
    rep = {"before": len(obj.data.vertices), "steps": []}
    _activate(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.tris_convert_to_quads(uvs=True, seam=True, materials=True)
    bpy.ops.object.mode_set(mode="OBJECT")
    rep["steps"].append(("tris_to_quads", len(obj.data.vertices)))
    for _ in range(max_passes):
        if len(obj.data.vertices) <= budget:
            break
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        n = remove_alternate_rungs(bm, tol, uv_tol)
        bm.to_mesh(obj.data)
        bm.free()
        rep["steps"].append(("rungs", n, len(obj.data.vertices)))
        if n < 0.01 * len(obj.data.vertices):
            break
    for _ in range(2):  # grids: each Un-Subdivide pass halves both directions
        if len(obj.data.vertices) <= budget:
            break
        before = len(obj.data.vertices)
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.mesh.unsubdivide(iterations=1)
        bpy.ops.object.mode_set(mode="OBJECT")
        rep["steps"].append(("unsubdivide", len(obj.data.vertices)))
        if len(obj.data.vertices) > 0.9 * before:
            break
    obj.data.update()
    rep["after"] = len(obj.data.vertices)
    return rep
