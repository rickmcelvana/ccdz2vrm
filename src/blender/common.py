"""Shared geometry helpers for the Blender pipeline scripts.

Import from a script run with `blender --python src/blender/<x>.py` via:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
"""

from __future__ import annotations

import bpy
from mathutils import Vector

TORSO_BAND = (0.45, 0.75)


def world_pts(obj):
    mw = obj.matrix_world
    return [mw @ v.co for v in obj.data.vertices]


def landmarks(pts):
    """Feet height, arm line and torso centre of a T-posed humanoid point set.

    The arm line is the lowest height whose cross-section width exceeds 1.6x
    the median -- a skeleton-free shoulder landmark (ENVIRONMENT.md s10a).
    """
    zs = [p.z for p in pts]
    lo, hi = min(zs), max(zs)
    h = hi - lo
    band = [p for p in pts if lo + TORSO_BAND[0] * h <= p.z <= lo + TORSO_BAND[1] * h] or pts
    widths = []
    for i in range(60):
        a = lo + i * h / 60
        sl = [p.x for p in pts if a <= p.z < a + h / 60]
        widths.append((a, (max(sl) - min(sl)) if sl else 0.0))
    med = sorted(w for _, w in widths)[len(widths) // 2] or 1.0
    arms = [z for z, w in widths if w > 1.6 * med]
    return {"lo_z": lo, "hi_z": hi,
            "cx": sum(p.x for p in band) / len(band), "cy": sum(p.y for p in band) / len(band),
            "shoulder": min(arms) if arms else lo + 0.82 * h}


def alignment(base_pts, gen_pts):
    """Uniform scale + translation taking the generated mesh onto the base,
    matching feet and arm line (not total height: generated heads are big)."""
    lb, lg = landmarks(base_pts), landmarks(gen_pts)
    s = (lb["shoulder"] - lb["lo_z"]) / (lg["shoulder"] - lg["lo_z"])

    def apply(p):
        return Vector((lb["cx"] + (p.x - lg["cx"]) * s, lb["cy"] + (p.y - lg["cy"]) * s,
                       lb["lo_z"] + (p.z - lg["lo_z"]) * s))
    return s, apply, lb


def wrist_x(pts, sign, arm_z, hand_len=0.19):
    """|x| where the forearm/sleeve ends and the hand begins, scanning outward.

    A hand is much thinner in Z than a sleeve or forearm: walk 5 mm slices
    from 60% of the half-span towards the tip and return the first slice whose
    Z extent drops below 65% of the median of the preceding 6 slices.
    Returns (x, tip_x, method).

    A cuff that leaves less than 60% of `hand_len` (pass the base's own hand
    length) to the fingertip is rejected: a hoodie's ribbed sleeve tapers into
    the wrist with no step, and the scan ran on into the fingers (char02:
    "wrist" 7 cm from the tip, arms fitted 14 cm too long). Then the wrist is
    `hand_len` in from the tip.
    """
    arm = [p for p in pts if p.x * sign > 0 and abs(p.z - arm_z) < 0.15]
    tip = max(p.x * sign for p in arm)
    x, step, hist = 0.6 * tip, 0.005, []
    while x < tip - 0.01:
        sl = [p.z for p in arm if x <= p.x * sign < x + step]
        if len(sl) >= 4:
            ext = max(sl) - min(sl)
            if len(hist) >= 6 and ext < 0.65 * sorted(hist[-6:])[3]:
                if tip - x >= 0.6 * hand_len:
                    return x, tip, "cuff"
                break
            hist.append(ext)
        x += step
    return tip - hand_len, tip, f"tip-hand_len({hand_len:.3f})"


def import_glb_largest(path):
    """Import a GLB and return its largest mesh; drop the importer's scratch objects."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    for coll in [c for c in bpy.data.collections if c.name == "glTF_not_exported"]:
        for obj in list(coll.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.collections.remove(coll)
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    if not meshes:
        raise SystemExit(f"no mesh imported from {path}")
    keep = max(meshes, key=lambda o: len(o.data.vertices))
    for o in new:
        if o is not keep:
            bpy.data.objects.remove(o, do_unlink=True)
    keep.parent = None
    return keep


def activate(obj):
    for o in bpy.context.selected_objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


# --- FBX import + rest-pose helpers (shared by the Daz and CC adapters) --------

ROUGHNESS_FLOOR = 0.5
BUMP_SLOPE = 0.01  # height 0..1 rising over 1 % of the texture width = 45 deg


def height_to_normal(img, cache={}):
    """Tangent-space (OpenGL, +Y up) normal map from a greyscale height image."""
    import numpy as np
    if img.name in cache:
        return cache[img.name]
    w, h = img.size
    px = np.empty(w * h * img.channels, np.float32)
    img.pixels.foreach_get(px)
    hgt = px.reshape(h, w, img.channels)[..., 0]
    dv, du = np.gradient(hgt)  # rows run bottom-up in Blender, so +v is up
    k = w * BUMP_SLOPE
    n = np.dstack([-du * k, -dv * k, np.ones_like(hgt)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    out = np.ones((h, w, 4), np.float32)
    out[..., :3] = n * 0.5 + 0.5
    nimg = bpy.data.images.new(f"{img.name}_normal", w, h, alpha=False)
    nimg.colorspace_settings.name = "Non-Color"
    nimg.pixels.foreach_set(out.ravel())
    nimg.pack()
    cache[img.name] = nimg
    return nimg


def _is_greyscale(img):
    import numpy as np
    if img.channels < 3 or not img.size[0]:
        return False
    px = np.empty(len(img.pixels), np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(-1, img.channels)[::97]
    return float(np.abs(px[:, 0] - px[:, 1]).max() + np.abs(px[:, 1] - px[:, 2]).max()) < 0.02


def import_fbx_clean(path):
    """Import an FBX and neutralise the importer's traps (ENVIRONMENT.md s14).

    1. The FBX take arrives as an action; renders re-evaluate it and restore
       the file's 0.01 bone scale -> drop all animation data.
    2. Applying the 0.01 scale with meshes parented leaves it in their parent
       inverse -> unparent keeping transforms, apply, re-parent with identity.
    3. Materials arrive with Metallic 1.0 (skin as a mirror) -> reset to 0
       unless the material is named as metal. Roughness comes from the FBX's
       Phong shininess: Daz writes its default (-> 0.553) for most surfaces but
       maximum shininess for some (G8 basic shorts -> 0.0), a perfect mirror
       that reads as chrome under an app's environment light -> floor at
       ROUGHNESS_FLOOR unless a roughness map drives it (ENVIRONMENT.md s27).
    6. A Daz/CC bump (height) map arrives wired into a Normal Map node. A
       grey height image read as a normal decodes to a zero vector -- smeared
       grey reflections -> converted to a real normal map (height_to_normal).
    4. A Daz prop that carries no skin weights at all (Alice's `Chain1` /
       `Chain2`) hangs off an empty that IS bone-parented; step 2 would drop
       that and leave the prop standing still while the figure moves -> rigid
       bind it to the bone the empty hung from (ENVIRONMENT.md s23).
    5. Item bones (hair fringe/tails) hang off the item's copy of the
       skeleton, which a VRM player never poses -> re-parented onto the real
       bone (ENVIRONMENT.md s28).
    Returns (armature, meshes, rigid) where `rigid` maps the props that got a
    rigid bind to their bone (plus `_reparented_off_twins`, a count).
    """
    import os
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=os.path.abspath(path))
    # A Daz item can arrive as its own armature: a partial copy of the figure's
    # skeleton under the same bone names (daz_alice_c: the 88-bone "Audrey Hair"
    # rig came first and was taken for the figure). The figure is the biggest
    # armature; re-point the others' meshes at it and drop them.
    rigs = sorted((o for o in bpy.data.objects if o.type == "ARMATURE"),
                  key=lambda o: len(o.data.bones), reverse=True)
    rig = rigs[0]
    for extra in rigs[1:]:
        for o in bpy.data.objects:
            if o.type != "MESH":
                continue
            for md in o.modifiers:
                if md.type == "ARMATURE" and md.object == extra:
                    md.object = rig
            if o.parent == extra:
                keep = o.matrix_world.copy()
                o.parent = None
                o.matrix_world = keep
        bpy.data.objects.remove(extra, do_unlink=True)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    bone_names = {b.name for b in rig.data.bones}
    # Item bones (a hair's `Fringe A`, `Left Tail`) hang off the item's own
    # copy of the skeleton (`head.003`), which nothing in a VRM player poses:
    # the head turned and 13k fringe/tail verts stayed put (ENVIRONMENT.md
    # s28). Re-parent every non-twin bone under a twin onto the real bone.
    twin_of = {n: n.rsplit(".", 1)[0] for n in bone_names
               if "." in n and n.rsplit(".", 1)[1].isdigit() and n.rsplit(".", 1)[0] in bone_names}
    moved = [b.name for b in rig.data.bones
             if b.parent and b.parent.name in twin_of and b.name not in twin_of]
    if moved:
        bpy.context.view_layer.objects.active = rig
        bpy.ops.object.mode_set(mode="EDIT")
        eb = rig.data.edit_bones
        for n in moved:
            eb[n].use_connect = False
            eb[n].parent = eb[twin_of[eb[n].parent.name]]
        bpy.ops.object.mode_set(mode="OBJECT")
    reparented = len(moved)

    def hang_bone(o):
        """The bone the mesh's ancestry is attached to, duplicates folded.

        Daz gives every figure and prop its own copy of the skeleton, so the
        empty over a necklace points at `chestUpper.004`; the VRM humanoid map
        names only `chestUpper`, so the twin is left unposed and the binding
        has to be folded onto the base name (same rule as the `.001` groups).
        """
        cur, seen = o.parent, set()
        while cur is not None and cur.as_pointer() not in seen:
            seen.add(cur.as_pointer())
            if cur.parent_type == "BONE" and cur.parent_bone:
                base = cur.parent_bone.rsplit(".", 1)[0]
                return base if base in bone_names else cur.parent_bone
            cur = cur.parent
        return None

    attach = {o.name: hang_bone(o) for o in meshes}

    for o in [rig] + meshes:
        o.animation_data_clear()
        if o.type == "MESH" and o.data.shape_keys:
            o.data.shape_keys.animation_data_clear()
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    for o in meshes:
        keep = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = keep
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in [rig] + meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    rigid = {"_reparented_off_twins": reparented} if reparented else {}
    for o in meshes:
        o.parent = rig
        o.matrix_parent_inverse.identity()
        # Daz "follower" figures (G8 eyelashes) carry their own copy of the
        # skeleton; the importer merges it as `lEyelidUpper.001` etc. and gives
        # the mesh no armature modifier, so it never moves (verified: lashes
        # stayed open through a blink). Fold the groups onto the real bones.
        for vg in list(o.vertex_groups):
            base = vg.name.rsplit(".", 1)[0]
            # (the duplicate `.001` bones DO exist in the armature, unposed)
            if base != vg.name and base in bone_names and base not in o.vertex_groups:
                vg.name = base
        if not any(vg.name in bone_names for vg in o.vertex_groups):
            # Nothing skinned it: a rigid prop (Daz necklace chains, parented
            # props). Bind every vertex to the bone it hung from, so it rides
            # the figure instead of standing still. Without a bone at all it
            # stays unskinned, and vrm_export leaves it out of the limits.
            bone = attach.get(o.name)
            if bone:
                vg = o.vertex_groups.new(name=bone)
                vg.add(range(len(o.data.vertices)), 1.0, "REPLACE")
                rigid[o.name] = bone
        if not any(m.type == "ARMATURE" for m in o.modifiers) and \
                any(vg.name in bone_names for vg in o.vertex_groups):
            o.modifiers.new("Armature", "ARMATURE")
        for m in o.modifiers:
            if m.type == "ARMATURE":
                m.object = rig
    for mat in {s.material for o in meshes for s in o.material_slots if s.material}:
        b = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if mat.node_tree else None
        if b is not None and not b.inputs["Metallic"].is_linked and "metal" not in mat.name.lower():
            b.inputs["Metallic"].default_value = 0.0
            b.inputs["Specular IOR Level"].default_value = 0.5
        if b is not None and not b.inputs["Roughness"].is_linked:
            b.inputs["Roughness"].default_value = max(b.inputs["Roughness"].default_value, ROUGHNESS_FLOOR)
        for nm in (n for n in (mat.node_tree.nodes if mat.node_tree else []) if n.type == "NORMAL_MAP"):
            src = next((l.from_node for l in nm.inputs["Color"].links if l.from_node.type == "TEX_IMAGE"), None)
            if src is not None and src.image is not None and _is_greyscale(src.image):
                src.image = height_to_normal(src.image)
                nm.inputs["Strength"].default_value = 1.0
    return rig, meshes, rigid


def aim_bone(rig, bone, child, direction):
    """Rotate a pose bone about its head so the world vector head->child's
    head points along `direction`. Works whatever the bone's roll/axes are."""
    from mathutils import Matrix
    mw = rig.matrix_world
    pb, pc = rig.pose.bones[bone], rig.pose.bones[child]
    h = mw @ pb.head
    cur = (mw @ pc.head) - h
    q = cur.rotation_difference(direction.normalized())
    r = Matrix.Translation(h) @ q.to_matrix().to_4x4() @ Matrix.Translation(-h)
    pb.matrix = mw.inverted() @ r @ mw @ pb.matrix
    bpy.context.view_layer.update()


def _skinned_corner_normals(rig, o):
    """Each corner normal turned by its vertex's blended bone matrix (current pose), renormalised:
    the normals a runtime gives a mesh it skins into this pose. None if o has no armature."""
    import numpy as np
    if not any(m.type == "ARMATURE" and m.object == rig for m in o.modifiers):
        return None
    me = o.data
    n = np.empty(len(me.loops) * 3)
    me.corner_normals.foreach_get("vector", n)
    n = n.reshape(-1, 3)
    lv = np.empty(len(me.loops), np.int64)
    me.loops.foreach_get("vertex_index", lv)
    to_rig = rig.matrix_world.inverted() @ o.matrix_world
    skin = {}
    for pb in rig.pose.bones:
        if pb.bone.use_deform:
            m = to_rig.inverted() @ pb.matrix @ pb.bone.matrix_local.inverted() @ to_rig
            skin[pb.name] = np.array(m.to_3x3())
    gname = {g.index: g.name for g in o.vertex_groups}
    lin = np.zeros((len(me.vertices), 3, 3))
    total = np.zeros(len(me.vertices))
    for v in me.vertices:
        for g in v.groups:
            s = skin.get(gname.get(g.group))
            if s is not None and g.weight > 0:
                lin[v.index] += g.weight * s
                total[v.index] += g.weight
    lin[total <= 0.0001] = np.eye(3)
    out = np.einsum("lij,lj->li", lin[lv], n)
    return out / np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-12)


def apply_pose_as_rest(rig, meshes, normals="surface"):
    """Make the current pose the rest pose, keeping every shape key exact.

    Blender refuses to apply an armature modifier on a mesh with shape keys.
    Linear blend skinning is linear in the rest position, so evaluating the
    posed mesh once per key (that key at 1, all others at 0) gives the exact
    posed position of every key; write those back, then apply the armature.

    `normals`: "surface" keeps Blender's custom normals, which follow the deformed surface (the
    adapters' A -> T bake); "skinned" turns each with its vertex's bones, as the VRM add-on's
    export T-pose leaves them -- baking that pose with surface normals put two-layer clothes
    32-69 deg off the plain export (ENVIRONMENT s36).
    """
    dg_update = bpy.context.view_layer.update
    skinned = {o.name: _skinned_corner_normals(rig, o) for o in meshes} if normals == "skinned" else {}
    for o in meshes:
        arm_mods = [m for m in o.modifiers if m.type == "ARMATURE" and m.object == rig]
        if not arm_mods:
            continue
        others = [m for m in o.modifiers if m not in arm_mods and m.show_viewport]
        for m in others:
            m.show_viewport = False
        keys = o.data.shape_keys.key_blocks if o.data.shape_keys else None
        saved = [k.value for k in keys] if keys else []
        captured = []
        for idx in range(len(keys) if keys else 1):
            if keys:
                for k in keys:
                    k.value = 0.0
                if idx:
                    keys[idx].value = 1.0
            dg_update()
            dg = bpy.context.evaluated_depsgraph_get()
            ev = o.evaluated_get(dg)
            me = ev.to_mesh()
            captured.append([v.co.copy() for v in me.vertices])
            ev.to_mesh_clear()
        for i, co in enumerate(captured[0]):
            o.data.vertices[i].co = co
        if keys:
            for idx, k in enumerate(keys):
                for i, co in enumerate(captured[idx]):
                    k.data[i].co = co
            for k, v in zip(keys, saved):
                k.value = v
        for m in others:
            m.show_viewport = True
        for m in arm_mods:
            m.show_viewport = False  # re-enabled after the rest pose moves
    activate(rig)
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    for o in meshes:
        for m in o.modifiers:
            if m.type == "ARMATURE" and m.object == rig:
                m.show_viewport = True
        if skinned.get(o.name) is not None:
            o.data.normals_split_custom_set([tuple(x) for x in skinned[o.name]])
    bpy.context.view_layer.update()


def tpose_arms(rig, meshes, chains, tol_deg=3.0):
    """Aim each (upper, lower, hand, sign) chain along +/-X, then bake as rest.

    `chains` e.g. [("lShldrBend", "lForearmBend", "lHand", 1), ...]. Returns the
    arm drop angles (degrees below horizontal) measured before posing.
    """
    import math
    from mathutils import Vector
    mw = rig.matrix_world
    drops = {}
    for up, low, hand, sign in chains:
        v = (mw @ rig.data.bones[hand].head_local) - (mw @ rig.data.bones[up].head_local)
        drops[up] = round(math.degrees(math.atan2(-v.z, abs(v.x))), 1)
    if max(abs(d) for d in drops.values()) <= tol_deg:
        return drops
    for up, low, hand, sign in chains:
        aim_bone(rig, up, low, Vector((sign, 0, 0)))
        aim_bone(rig, low, hand, Vector((sign, 0, 0)))
    apply_pose_as_rest(rig, meshes)
    return drops


def upstream_image(socket):
    """First image-texture node feeding `socket`, through any intermediate
    nodes (MakeSkin routes base colour via mix nodes). None if there is none."""
    stack, seen = [l.from_node for l in socket.links], set()
    while stack:
        n = stack.pop(0)
        if n.as_pointer() in seen:
            continue
        seen.add(n.as_pointer())
        if n.type == "TEX_IMAGE" and n.image:
            return n
        stack += [l.from_node for i in n.inputs for l in i.links]
    return None
