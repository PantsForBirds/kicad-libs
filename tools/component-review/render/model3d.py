"""GLB export: footprint on a small PCB with its STEP model(s), in KiCad's 3D convention.

Scene layout (all in millimetres, KiCad 3D frame: x right, y = -pcb_y, z up, board top at z=0):

    world
    └── kicad_zup            rotation -90° about X (glTF is Y-up); children are in KiCad coords
        ├── PCB               1.6 mm FR4/soldermask slab, courtyard + margin, drilled
        ├── F.Cu / B.Cu       35 µm copper pads (with holes), plated barrels in 'Holes'
        ├── F.SilkS / F.Fab / F.CrtYd (and B.*)   10 µm graphics layers
        └── model_<n>         each STEP model, transformed like KiCad's 3D viewer:
                              T(offset) · Rz(-rz) · Ry(-ry) · Rx(-rx) · S(scale)

Every layer is a separate named node so the viewer can toggle it.
STEP tessellation uses ``cascadio`` (OpenCASCADE, statically linked; no libGL needed).
"""

from __future__ import annotations

import math
import os
import tempfile

import numpy as np
import trimesh
from shapely import affinity
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, box
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

from geom import arc_points

BOARD_T = 1.6
CU_T = 0.035
GFX_T = 0.01
QS = 8  # quad segments for round shapes

COLORS = {
    "PCB": (0.13, 0.38, 0.20, 1.0),
    "Cu": (0.83, 0.68, 0.33, 1.0),        # ENIG gold
    "Holes": (0.80, 0.62, 0.30, 1.0),
    "SilkS": (0.95, 0.95, 0.95, 1.0),
    "Fab": (0.62, 0.62, 0.62, 1.0),
    "CrtYd": (1.0, 0.15, 0.89, 1.0),
    "Paste": (0.75, 0.75, 0.78, 1.0),
}


def _material(rgba, metallic=0.0, rough=0.7, name=None):
    return trimesh.visual.material.PBRMaterial(
        name=name, baseColorFactor=[int(c * 255) for c in rgba], metallicFactor=metallic, roughnessFactor=rough)


def _to3d(geom):
    """PCB (y down) -> KiCad 3D (y up)."""
    return affinity.scale(geom, xfact=1.0, yfact=-1.0, origin=(0, 0))


def _polys(geom):
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    return [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]


def _extrude(geom, z0, h):
    meshes = []
    for poly in _polys(geom):
        poly = orient(poly.buffer(0))
        if poly.is_empty or poly.area < 1e-8:
            continue
        for p in _polys(poly):
            try:
                m = trimesh.creation.extrude_polygon(p, h)
            except Exception:
                continue
            m.apply_translation((0, 0, z0))
            meshes.append(m)
    if not meshes:
        return None
    return trimesh.util.concatenate(meshes)


# ---------------------------------------------------------------------------
# 2D shapes (PCB coordinates) with shapely
# ---------------------------------------------------------------------------

def _place(g, p):
    a = math.radians(p["angle"])
    c, s = math.cos(a), math.sin(a)
    # KiCad rotation on screen (y down, CCW positive) == geom.rot()
    return affinity.affine_transform(g, [c, s, -s, c, p["x"], p["y"]])


def _gfx_geom(g, grow=0.0):
    w = max(g.get("width", 0.0), 0.0)
    r = w / 2 + grow
    if "center" in g:
        cx, cy = g["center"]
        circ = Point(cx, cy).buffer(g["r"], quad_segs=QS * 2)
        if g.get("filled"):
            return circ.buffer(r) if r > 0 else circ
        return circ.exterior.buffer(max(r, 0.005), quad_segs=QS)
    if "arc" in g:
        ls = LineString(arc_points(*g["arc"], n=32))
        return ls.buffer(max(r, 0.005), quad_segs=QS)
    pts = g.get("pts") or []
    if len(pts) < 2:
        return None
    if g.get("kind") == "poly" and len(pts) >= 3:
        poly = Polygon(pts).buffer(0)
        if g.get("filled"):
            return poly.buffer(r, quad_segs=QS) if r > 0 else poly
        return LineString(list(pts) + [pts[0]]).buffer(max(r, 0.005), quad_segs=QS)
    if g.get("kind") == "bezier" and len(pts) == 4:
        t = np.linspace(0, 1, 24)[:, None]
        P = np.array(pts)
        curve = ((1 - t) ** 3) * P[0] + 3 * ((1 - t) ** 2) * t * P[1] + 3 * (1 - t) * t ** 2 * P[2] + t ** 3 * P[3]
        return LineString(curve).buffer(max(r, 0.005), quad_segs=QS)
    return LineString(pts).buffer(max(r, 0.005), quad_segs=QS)


def pad_geom(p, grow=0.0):
    w, h = p["w"] + 2 * grow, p["h"] + 2 * grow
    shape = p["shape"]
    base = None
    if shape == "custom":
        shape = "circle" if p["anchor"] == "circle" else "rect"
    if shape == "circle":
        base = Point(0, 0).buffer(w / 2, quad_segs=QS * 2)
    elif shape == "oval":
        r = min(w, h) / 2
        dx, dy = max(0.0, w / 2 - r), max(0.0, h / 2 - r)
        base = LineString([(-dx, -dy), (dx, dy)]).buffer(r, quad_segs=QS * 2) if (dx or dy) else Point(0, 0).buffer(r, quad_segs=QS * 2)
    elif shape == "roundrect" and not p["chamfer"]:
        r = min(min(w, h) * p["rratio"], min(w, h) / 2)
        base = box(-w / 2 + r, -h / 2 + r, w / 2 - r, h / 2 - r).buffer(r, quad_segs=QS) if r > 0 else box(-w / 2, -h / 2, w / 2, h / 2)
    elif shape in ("chamfered_rect", "roundrect"):
        c = min(w, h) * p["chamfer_ratio"]
        x0, y0, x1, y1 = -w / 2, -h / 2, w / 2, h / 2
        ch = set(p["chamfer"])
        pts = []
        pts += [(x0, y0 + c), (x0 + c, y0)] if "top_left" in ch else [(x0, y0)]
        pts += [(x1 - c, y0), (x1, y0 + c)] if "top_right" in ch else [(x1, y0)]
        pts += [(x1, y1 - c), (x1 - c, y1)] if "bottom_right" in ch else [(x1, y1)]
        pts += [(x0 + c, y1), (x0, y1 - c)] if "bottom_left" in ch else [(x0, y1)]
        base = Polygon(pts)
    elif shape == "trapezoid":
        dx, dy = (p["delta"] + [0, 0])[:2]
        base = Polygon([(-w / 2 - dy / 2, -h / 2 + dx / 2), (w / 2 + dy / 2, -h / 2 - dx / 2),
                        (w / 2 - dy / 2, h / 2 + dx / 2), (-w / 2 + dy / 2, h / 2 - dx / 2)])
    else:
        base = box(-w / 2, -h / 2, w / 2, h / 2)
    parts = [base]
    for prim in p["primitives"]:
        g = dict(prim)
        if g.get("kind") == "poly":
            g["filled"] = True
        pg = _gfx_geom(g, grow)
        if pg is not None:
            parts.append(pg)
    return _place(unary_union(parts), p)


def drill_geom(p):
    d = p["drill"]
    if not d:
        return None
    ox, oy = d["offset"]
    w, h = d["w"], d["h"]
    r = min(w, h) / 2
    dx, dy = max(0.0, w / 2 - r), max(0.0, h / 2 - r)
    if dx or dy:
        g = LineString([(ox - dx, oy - dy), (ox + dx, oy + dy)]).buffer(r, quad_segs=QS * 2)
    else:
        g = Point(ox, oy).buffer(r, quad_segs=QS * 2)
    return _place(g, p)


# ---------------------------------------------------------------------------
# STEP models
# ---------------------------------------------------------------------------

def kicad_model_matrix(mdl) -> np.ndarray:
    ox, oy, oz = mdl["offset"]
    rx, ry, rz = mdl["rotate"]
    sx, sy, sz = mdl["scale"]
    T = trimesh.transformations.translation_matrix((ox, oy, oz))
    Rz = trimesh.transformations.rotation_matrix(math.radians(-rz), (0, 0, 1))
    Ry = trimesh.transformations.rotation_matrix(math.radians(-ry), (0, 1, 0))
    Rx = trimesh.transformations.rotation_matrix(math.radians(-rx), (1, 0, 0))
    S = np.diag([sx, sy, sz, 1.0])
    return T @ Rz @ Ry @ Rx @ S


def load_step(path: str, lin_tol: float, ang_tol: float):
    """Tessellate a STEP file -> list of (mesh in mm, native model frame)."""
    import cascadio
    ext = os.path.splitext(path)[1].lower()
    if ext == ".wrl":
        raise ValueError("VRML (.wrl) models are not supported; provide a STEP model")
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, "m.glb")
        cascadio.step_to_glb(path, out, lin_tol, ang_tol)  # tolerances in model units (mm)
        scene = trimesh.load(out, force="scene")
    meshes = []
    for name in scene.graph.nodes_geometry:
        tf, gname = scene.graph[name]
        m = scene.geometry[gname].copy()
        m.apply_transform(tf)
        m.apply_scale(1000.0)  # glTF metres -> mm
        m.metadata["name"] = gname
        meshes.append(m)
    return meshes


# ---------------------------------------------------------------------------
# main entry
# ---------------------------------------------------------------------------

def build_glb(fp, model_files, out_path: str, max_bytes: float = 5e6, include_models=True) -> list[str]:
    """Write ``out_path`` (GLB). ``model_files`` = [(local STEP path, model dict)]. Returns warnings."""
    warnings: list[str] = []
    lin = 0.02  # mm chordal deviation
    ang = 0.5
    for attempt in range(4):
        scene, w = _build_scene(fp, model_files, lin, ang, include_models)
        data = scene.export(file_type="glb")
        if len(data) <= max_bytes or attempt == 3:
            break
        lin *= 3
        ang = min(ang * 1.5, 1.0)
        warnings.append(f"GLB {len(data) / 1e6:.1f} MB > limit; re-tessellating coarser (tol {lin:.2f} mm)")
    warnings = w + warnings
    if len(data) > max_bytes:
        warnings.append(f"GLB still {len(data) / 1e6:.1f} MB after coarsening")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "wb") as fh:
        fh.write(data)
    return warnings


def _build_scene(fp, model_files, lin, ang, include_models):
    warnings = []
    scene = trimesh.Scene()
    root = "kicad_zup"
    scene.graph.update(frame_from=scene.graph.base_frame, frame_to=root,
                       matrix=trimesh.transformations.rotation_matrix(-math.pi / 2, (1, 0, 0)))

    def add(mesh, node, color, parent=root, metallic=0.0, rough=0.7):
        if mesh is None or len(mesh.faces) == 0:
            return
        mesh.visual = trimesh.visual.TextureVisuals(material=_material(color, metallic, rough, name=node))
        scene.add_geometry(mesh, node_name=node, geom_name=node, parent_node_name=parent)

    pads = fp.pads
    drills = [g for g in (drill_geom(p) for p in pads) if g is not None]
    drill_union = unary_union(drills) if drills else None

    # board outline: courtyard bbox (fallback: everything) + margin
    crt = fp.courtyard_bbox("F") or fp.courtyard_bbox("B")
    if crt is None:
        from fp import footprint_bbox
        bb = footprint_bbox(fp)
        crt = bb.as_list() or [-5, -5, 5, 5]
        warnings.append("no courtyard; PCB sized from footprint extents")
    m = 1.0
    board = box(crt[0] - m, crt[1] - m, crt[2] + m, crt[3] + m)
    if drill_union is not None:
        board = board.difference(drill_union)
    add(_extrude(_to3d(board), -BOARD_T, BOARD_T), "PCB", COLORS["PCB"], rough=0.6)

    # copper
    for side, z0 in (("F", 0.0), ("B", -BOARD_T - CU_T)):
        geoms = []
        for p in pads:
            if f"{side}.Cu" not in p["layers"]:
                continue
            if p["type"] == "np_thru_hole" and p["drill"] and max(p["w"], p["h"]) <= p["drill"]["w"] + 1e-6:
                continue
            g = pad_geom(p)
            dg = drill_geom(p)
            if dg is not None:
                g = g.difference(dg)
            geoms.append(g)
        if geoms:
            add(_extrude(_to3d(unary_union(geoms)), z0, CU_T), f"{side}.Cu", COLORS["Cu"], metallic=0.9, rough=0.35)
        # paste (thin, slightly above copper) — off by default in most viewers, but toggleable
        pg = [pad_geom(p) for p in pads if f"{side}.Paste" in p["layers"]]
        if pg:
            zp = CU_T if side == "F" else -BOARD_T - CU_T - 0.02
            add(_extrude(_to3d(unary_union(pg)), zp, 0.02), f"{side}.Paste", COLORS["Paste"], metallic=0.6, rough=0.5)

    # plated barrels
    barrels = []
    for p in pads:
        if p["type"] != "thru_hole" or not p["drill"]:
            continue
        dg = drill_geom(p)
        ring = dg.buffer(0.025).difference(dg)
        mm = _extrude(_to3d(ring), -BOARD_T - CU_T, BOARD_T + 2 * CU_T)
        if mm is not None:
            barrels.append(mm)
    if barrels:
        add(trimesh.util.concatenate(barrels), "Holes", COLORS["Holes"], metallic=0.9, rough=0.35)

    # graphics layers
    by_layer: dict[str, list] = {}
    for g in fp.graphics:
        layer = g["layer"]
        if not any(layer.endswith(s) for s in (".SilkS", ".Fab", ".CrtYd")):
            continue
        geo = _gfx_geom(g)
        if geo is not None:
            by_layer.setdefault(layer, []).append(geo)
    for layer, geos in by_layer.items():
        side, kind = layer.split(".", 1)
        top = side == "F"
        # stack a little above copper so layers don't z-fight
        dz = {"SilkS": 0.0, "Fab": 0.012, "CrtYd": 0.024}[kind]
        z0 = (CU_T + 0.001 + dz) if top else (-BOARD_T - CU_T - 0.001 - dz - GFX_T)
        geo = unary_union(geos)
        if kind == "SilkS" and drill_union is not None:
            geo = geo.difference(drill_union)
        add(_extrude(_to3d(geo), z0, GFX_T), layer, COLORS[kind])

    # STEP models
    if include_models:
        for i, (path, mdl) in enumerate(model_files, 1):
            node = f"model_{i}"
            try:
                meshes = load_step(path, lin, ang)
            except Exception as e:
                warnings.append(f"model {os.path.basename(path)}: tessellation failed: {e}")
                continue
            M = kicad_model_matrix(mdl)
            scene.graph.update(frame_from=root, frame_to=node, matrix=M)
            for j, mesh in enumerate(meshes):
                gname = f"{node}_{j}_{mesh.metadata.get('name', '')}"[:64]
                scene.add_geometry(mesh, node_name=gname, geom_name=gname, parent_node_name=node)
            if mdl.get("opacity", 1.0) < 1.0:
                warnings.append(f"model {os.path.basename(path)}: opacity {mdl['opacity']} not applied")
    return scene, warnings


# ---------------------------------------------------------------------------
# software preview (no OpenGL needed): painter's algorithm with PIL
# ---------------------------------------------------------------------------

def _mesh_rgba(mesh):
    mat = getattr(mesh.visual, "material", None)
    if mat is not None:
        f = getattr(mat, "baseColorFactor", None)
        if f is not None:
            f = np.asarray(f, dtype=float)
            return f / 255.0 if f.max() > 1.0 else f
        try:
            return np.asarray(mat.main_color, dtype=float) / 255.0
        except Exception:
            pass
    try:
        return np.asarray(mesh.visual.main_color, dtype=float) / 255.0
    except Exception:
        return np.array([0.7, 0.7, 0.7, 1.0])


def _zbuffer(T, C, d, up, size, ss=2, bg=(238, 240, 244)):
    """Orthographic z-buffer raster of triangles T (n,3,3) with colours C (n,3) seen from direction d."""
    d = np.asarray(d, float)
    d /= np.linalg.norm(d)
    up = np.asarray(up, float)
    r = np.cross(up, d)
    if np.linalg.norm(r) < 1e-9:
        r = np.cross(np.array([0.0, 0.0, -1.0]), d)
    r /= np.linalg.norm(r)
    u = np.cross(d, r)
    X = T @ r
    Y = -(T @ u)
    Z = T @ d                      # larger = closer to the camera
    n = np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0])
    ln = np.linalg.norm(n, axis=1)
    ok = ln > 1e-12
    n[ok] /= ln[ok, None]
    light = d + 0.6 * u + 0.3 * r
    light /= np.linalg.norm(light)
    shade = 0.30 + 0.70 * np.abs(n @ light)
    W = size * ss
    x0, x1, y0, y1 = X.min(), X.max(), Y.min(), Y.max()
    scale = (W * 0.92) / max(x1 - x0, y1 - y0, 1e-6)
    X = (X - (x0 + x1) / 2) * scale + W / 2
    Y = (Y - (y0 + y1) / 2) * scale + W / 2
    zbuf = np.full((W, W), -np.inf)
    img = np.empty((W, W, 3), dtype=np.float32)
    img[:] = np.asarray(bg, np.float32) / 255.0
    cols = np.clip(C[:, :3] * shade[:, None], 0, 1).astype(np.float32)
    for i in range(len(T)):
        xs, ys, zs = X[i], Y[i], Z[i]
        bx0, bx1 = max(int(np.floor(xs.min())), 0), min(int(np.ceil(xs.max())), W - 1)
        by0, by1 = max(int(np.floor(ys.min())), 0), min(int(np.ceil(ys.max())), W - 1)
        if bx1 < bx0 or by1 < by0:
            continue
        den = (ys[1] - ys[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (ys[0] - ys[2])
        if abs(den) < 1e-12:
            continue
        px, py = np.meshgrid(np.arange(bx0, bx1 + 1) + 0.5, np.arange(by0, by1 + 1) + 0.5)
        w0 = ((ys[1] - ys[2]) * (px - xs[2]) + (xs[2] - xs[1]) * (py - ys[2])) / den
        w1 = ((ys[2] - ys[0]) * (px - xs[2]) + (xs[0] - xs[2]) * (py - ys[2])) / den
        w2 = 1 - w0 - w1
        inside = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        if not inside.any():
            continue
        z = w0 * zs[0] + w1 * zs[1] + w2 * zs[2]
        sub = zbuf[by0:by1 + 1, bx0:bx1 + 1]
        upd = inside & (z > sub)
        sub[upd] = z[upd]
        img[by0:by1 + 1, bx0:bx1 + 1][upd] = cols[i]
    img = (img * 255).astype(np.uint8)
    from PIL import Image
    im = Image.fromarray(img)
    return im.resize((size, size), Image.LANCZOS) if ss > 1 else im


def render_preview(glb_path: str, png_path: str, size: int = 900, hide=()) -> None:
    """2x2 sheet of shaded orthographic views (iso / top / front / right) using a numpy z-buffer.

    The GLB is glTF Y-up (board top = +Y, KiCad front edge = +Z). No OpenGL required.
    """
    from PIL import Image, ImageDraw

    scene = trimesh.load(glb_path, force="scene")
    tris, cols = [], []
    for node in scene.graph.nodes_geometry:
        tf, gname = scene.graph[node]
        if any(h in node for h in hide):
            continue
        m = scene.geometry[gname]
        v = trimesh.transform_points(m.vertices, tf)
        tris.append(v[m.faces])
        rgba = _mesh_rgba(m)
        cols.append(np.repeat(rgba[None, :3], len(m.faces), axis=0))
    if not tris:
        return
    T = np.concatenate(tris)
    C = np.concatenate(cols)
    half = size // 2
    views = [("iso", (1.0, 1.1, 1.4), (0, 1, 0)), ("top", (0, 1, 0), (0, 0, -1)),
             ("front", (0, 0, 1), (0, 1, 0)), ("right", (1, 0, 0), (0, 1, 0))]
    sheet = Image.new("RGB", (half * 2, half * 2), (238, 240, 244))
    for k, (label, d, up) in enumerate(views):
        im = _zbuffer(T, C, d, up, half)
        ImageDraw.Draw(im).text((8, 6), label, fill=(60, 60, 60))
        sheet.paste(im, ((k % 2) * half, (k // 2) * half))
    dr = ImageDraw.Draw(sheet)
    dr.line([(half, 0), (half, 2 * half)], fill=(200, 200, 205))
    dr.line([(0, half), (2 * half, half)], fill=(200, 200, 205))
    sheet.save(png_path, optimize=True)
