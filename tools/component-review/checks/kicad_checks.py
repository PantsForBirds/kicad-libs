"""Deterministic (no-API) checks for KiCad footprints and symbols.

Every finding produced here has category "klc" and follows the review.json
finding shape. Line numbers are computed in *source* coordinates and mapped to
repo-file coordinates by the caller-supplied `LineMap`.
"""

from __future__ import annotations

import math
import re

from sexpr import Node

MM_PER_MIL = 0.0254
GRID_100MIL = 2.54
GRID_50MIL = 1.27
COURTYARD_CLEARANCE = 0.25
KICAD_LIBS_PREFIX = "${KICAD_LIBS_DIR}/"

_URL_RE = re.compile(r"https?://\S+", re.I)


class LineMap:
    """Maps a line in the item's standalone source to a line in the repo file.

    `root_line` is the source line where the item's own (footprint ...) /
    (symbol ...) list opens; `file_start` is manifest line_range.head[0].
    """

    def __init__(self, root_line: int, file_start: int | None, n_lines: int | None = None):
        self.root_line = root_line
        self.file_start = file_start
        self.n_lines = n_lines

    def __call__(self, src_line: int | None) -> int | None:
        if src_line is None or self.file_start is None:
            return None
        return self.file_start + (src_line - self.root_line)


def finding(severity, message, line=None, suggestion=None, category="klc"):
    f = {"severity": severity, "category": category, "message": message, "line": line}
    if suggestion:
        f["suggestion"] = suggestion
    return f


def check(name, result, detail=""):
    return {"name": name, "result": result, "detail": detail}


# ---------------------------------------------------------------------------
# Locating the item inside its standalone source
# ---------------------------------------------------------------------------

def find_item_node(root: Node, kind: str, name: str) -> Node | None:
    """Return the (footprint ...) or top-level (symbol ...) node for `name`."""
    if kind == "footprint":
        for n in root.walk():
            if n.name in ("footprint", "module"):
                return n
        return None
    candidates = [root] if root.name == "symbol" else root.children("symbol")
    for s in candidates:
        if s.atom() == name or (s.atom() or "").split(":")[-1] == name:
            return s
    return candidates[0] if len(candidates) == 1 else None


# ---------------------------------------------------------------------------
# Footprint model
# ---------------------------------------------------------------------------

def _props(node: Node) -> dict[str, tuple[str, Node]]:
    out = {}
    for p in node.children("property"):
        key, val = p.atom(0), p.atom(1, "")
        if key is not None:
            out[key] = (val or "", p)
    return out


def _layer_of(n: Node) -> str | None:
    return n.value("layer")


def parse_pads(fp: Node) -> list[dict]:
    pads = []
    for p in fp.children("pad"):
        at = p.child("at")
        size = p.child("size")
        xy = at.floats() if at else [0.0, 0.0]
        wh = size.floats() if size else [0.0, 0.0]
        layers_node = p.child("layers")
        layers = layers_node.atoms() if layers_node else []
        pads.append({
            "number": p.atom(0, ""),
            "type": p.atom(1, ""),
            "shape": p.atom(2, ""),
            "x": xy[0] if xy else 0.0,
            "y": xy[1] if len(xy) > 1 else 0.0,
            "rot": xy[2] if len(xy) > 2 else 0.0,
            "w": wh[0] if wh else 0.0,
            "h": wh[1] if len(wh) > 1 else (wh[0] if wh else 0.0),
            "layers": layers,
            "drill": (p.child("drill").floats() or [None])[0] if p.child("drill") else None,
            "line": p.line,
        })
    return pads


def _pad_corners(p):
    hw, hh = p["w"] / 2, p["h"] / 2
    a = math.radians(-p["rot"])  # KiCad y-down, angles CCW on screen
    ca, sa = math.cos(a), math.sin(a)
    pts = []
    for dx, dy in ((-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)):
        pts.append((p["x"] + dx * ca - dy * sa, p["y"] + dx * sa + dy * ca))
    return pts


def pad_bbox(pads):
    pts = [c for p in pads for c in _pad_corners(p)]
    if not pts:
        return None
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return (min(xs), min(ys), max(xs), max(ys))


def graphic_segments(fp: Node, layer_pred) -> list[tuple[tuple, tuple, float, int]]:
    """Return (p1, p2, stroke_width, line) segments for graphics on matching layers."""
    segs = []
    for g in fp.children():
        if not g.name.startswith("fp_") or g.name == "fp_text":
            continue
        layer = _layer_of(g)
        if not layer or not layer_pred(layer):
            continue
        stroke = g.child("stroke")
        width = (stroke.child("width").floats() or [0.0])[0] if stroke and stroke.child("width") else \
            ((g.child("width").floats() or [0.0])[0] if g.child("width") else 0.0)

        def pt(name):
            c = g.child(name)
            v = c.floats() if c else []
            return (v[0], v[1]) if len(v) >= 2 else None

        if g.name == "fp_line":
            a, b = pt("start"), pt("end")
            if a and b:
                segs.append((a, b, width, g.line))
        elif g.name == "fp_rect":
            a, b = pt("start"), pt("end")
            if a and b:
                c = [(a[0], a[1]), (b[0], a[1]), (b[0], b[1]), (a[0], b[1])]
                segs += [(c[i], c[(i + 1) % 4], width, g.line) for i in range(4)]
        elif g.name == "fp_poly":
            pts_node = g.child("pts")
            pts = [tuple(xy.floats()[:2]) for xy in pts_node.children("xy")] if pts_node else []
            segs += [(pts[i], pts[(i + 1) % len(pts)], width, g.line) for i in range(len(pts))] if len(pts) > 1 else []
        elif g.name == "fp_arc":
            a, m, b = pt("start"), pt("mid"), pt("end")
            if a and m and b:
                segs += [(a, m, width, g.line), (m, b, width, g.line)]
        elif g.name == "fp_circle":
            c, e = pt("center"), pt("end")
            if c and e:
                r = math.dist(c, e)
                n = 16
                ring = [(c[0] + r * math.cos(2 * math.pi * k / n), c[1] + r * math.sin(2 * math.pi * k / n)) for k in range(n)]
                segs += [(ring[k], ring[(k + 1) % n], width, g.line) for k in range(n)]
    return segs


def _seg_hits_pad(a, b, halfw, p) -> bool:
    """Does segment a-b (with half stroke width) overlap pad p (rotated rect / circle)?"""
    ang = math.radians(p["rot"])
    ca, sa = math.cos(ang), math.sin(ang)

    def local(q):
        dx, dy = q[0] - p["x"], q[1] - p["y"]
        return (dx * ca - dy * sa, dx * sa + dy * ca)

    la, lb = local(a), local(b)
    hw, hh = p["w"] / 2, p["h"] / 2
    if p["shape"] == "circle":
        return _seg_point_dist(la, lb, (0.0, 0.0)) < hw + halfw - 1e-6
    # distance from segment to axis-aligned rect, sampled finely (robust + simple)
    steps = max(2, int(math.dist(la, lb) / 0.02) + 1)
    for k in range(steps + 1):
        t = k / steps
        x = la[0] + (lb[0] - la[0]) * t
        y = la[1] + (lb[1] - la[1]) * t
        dx = max(abs(x) - hw, 0.0)
        dy = max(abs(y) - hh, 0.0)
        if math.hypot(dx, dy) < halfw - 1e-6:
            return True
    return False


def _seg_point_dist(a, b, q):
    ax, ay = a
    bx, by = b
    vx, vy = bx - ax, by - ay
    L2 = vx * vx + vy * vy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((q[0] - ax) * vx + (q[1] - ay) * vy) / L2))
    return math.hypot(ax + t * vx - q[0], ay + t * vy - q[1])


def _segs_bbox(segs):
    pts = [p for s in segs for p in (s[0], s[1])]
    if not pts:
        return None
    return (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts))


def _union(a, b):
    if a is None:
        return b
    if b is None:
        return a
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def footprint_stats(fp: Node) -> dict:
    pads = parse_pads(fp)
    numbered = [p for p in pads if p["number"]]
    return {
        "pad_count": len(pads),
        "numbered_pads": sorted({p["number"] for p in numbered}, key=_natkey),
        "smd": sum(p["type"] == "smd" for p in pads),
        "tht": sum(p["type"] == "thru_hole" for p in pads),
        "npth": sum(p["type"] == "np_thru_hole" for p in pads),
        "attr": (fp.child("attr").atoms() if fp.child("attr") else []),
        "pads": [{k: p[k] for k in ("number", "type", "shape", "x", "y", "rot", "w", "h", "layers", "drill")} for p in pads],
    }


_DIM_RE = re.compile(r"(?<![A-Za-z])(?:EP|P|L|W|H|D)?\d+(?:\.\d+)?(?:x\d+(?:\.\d+)?)*mm", re.I)


def model_name_mismatch(fp_name: str, model_path: str) -> str | None:
    """Flag a model whose file name looks like a package name but not *this* package.

    Vendor part-number models (e.g. `TS32-7-35-BK.STEP`) are not flagged; only models
    whose name shares the footprint's family prefix (`SOIC-8-1EP_...`) yet differs.
    """
    stem = re.sub(r"\.(step|stp|wrl|wrz|stpz|iges|igs)$", "", model_path.rsplit("/", 1)[-1], flags=re.I)
    if not fp_name or not stem or stem == fp_name:
        return None
    if stem.split("_")[0].lower() != fp_name.split("_")[0].lower():
        return None
    fd, md = _DIM_RE.findall(fp_name), _DIM_RE.findall(stem)
    only_fp = [d for d in fd if d not in md]
    only_model = [d for d in md if d not in fd]
    if only_fp or only_model:
        return (f"3D model `{stem}` has different package dimensions from footprint `{fp_name}` "
                f"(footprint: {', '.join(only_fp) or '-'}; model: {', '.join(only_model) or '-'}).")
    if stem.startswith(fp_name) or fp_name.startswith(stem):
        return None  # variant suffixes like _ThermalVias share the same body
    return f"3D model name `{stem}` does not match footprint name `{fp_name}`."


def _natkey(s: str):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", s)]


def check_footprint(fp: Node, lm: LineMap, model3d_manifest: list | None, repo_path_exists=None):
    """Returns (findings, checks). `repo_path_exists(relpath)->bool|None` optional."""
    F, C = [], []
    props = _props(fp)
    pads = parse_pads(fp)
    attrs = fp.child("attr").atoms() if fp.child("attr") else []
    virtual = "virtual" in attrs or "board_only" in attrs

    # --- properties / descr ---
    descr = fp.value("descr", default="") or ""
    ds = props.get("Datasheet", ("", None))[0]
    if not descr.strip():
        F.append(finding("warning", "Footprint has no `descr` (description).", lm(fp.line),
                         "Add a description including the datasheet URL (KLC F9.1)."))
    has_url = bool(_URL_RE.search(descr)) or ds.strip() not in ("", "~")
    C.append(check("Datasheet reference present", "pass" if has_url else "fail",
                   "URL found in descr/Datasheet" if has_url else "no URL in descr and Datasheet property empty"))
    if not has_url:
        F.append(finding("warning", "No datasheet URL in `descr` and the `Datasheet` property is empty.",
                         lm(props["Datasheet"][1].line) if "Datasheet" in props else lm(fp.line),
                         "Put the manufacturer datasheet URL in `descr` (and/or the Datasheet property)."))
    if not (fp.value("tags", default="") or "").strip():
        F.append(finding("info", "Footprint has no `tags` (keywords).", lm(fp.line)))

    # --- reference / value placement (KLC F5.2) ---
    ref = props.get("Reference")
    if ref and _layer_of(ref[1]) not in ("F.SilkS", "B.SilkS"):
        F.append(finding("info", f"Reference property is on `{_layer_of(ref[1])}`, KLC expects F.SilkS.", lm(ref[1].line)))
    val = props.get("Value")
    if val and _layer_of(val[1]) not in ("F.Fab", "B.Fab"):
        F.append(finding("info", f"Value property is on `{_layer_of(val[1])}`, KLC expects F.Fab.", lm(val[1].line)))

    # --- fab layer + ${REFERENCE} on fab ---
    fab_segs = graphic_segments(fp, lambda l: l.endswith(".Fab"))
    C.append(check("Fab outline present", "pass" if fab_segs else "fail", f"{len(fab_segs)} fab segments"))
    if not fab_segs and not virtual:
        F.append(finding("warning", "No fabrication-layer outline (F.Fab) graphics.", lm(fp.line),
                         "Draw the component body outline on F.Fab with a pin-1 chamfer/marker (KLC F5.2)."))
    fab_ref = [t for t in fp.children("fp_text") if t.atom(0) == "user" and t.atom(1) == "${REFERENCE}"
               and (_layer_of(t) or "").endswith(".Fab")]
    C.append(check("${REFERENCE} text on F.Fab", "pass" if fab_ref else "fail"))
    if not fab_ref and not virtual:
        F.append(finding("warning", "No `${REFERENCE}` user text on F.Fab.", lm(fp.line),
                         "Add a `${REFERENCE}` fp_text on F.Fab inside the body outline (KLC F5.2)."))

    # --- courtyard ---
    crt = graphic_segments(fp, lambda l: l.endswith(".CrtYd"))
    C.append(check("Courtyard present", "pass" if crt else "fail", f"{len(crt)} courtyard segments"))
    if not crt and not virtual:
        F.append(finding("error", "Footprint has no courtyard (F.CrtYd).", lm(fp.line),
                         "Add a courtyard 0.25 mm around body and pads (KLC F5.3)."))
    elif crt:
        cbb = _segs_bbox(crt)
        pbb, fbb = pad_bbox(pads), _segs_bbox(fab_segs)

        def margin(bb):
            return min(bb[0] - cbb[0], bb[1] - cbb[1], cbb[2] - bb[2], cbb[3] - bb[3]) if bb else None

        mp, mf = margin(pbb), margin(fbb)
        where = lm(crt[0][3])
        if mp is not None and mp < -0.005:
            C.append(check("Courtyard encloses all pads", "fail", f"pads extend {abs(mp):.3f} mm outside (bounding boxes)"))
            F.append(finding("error", f"Pads extend {abs(mp):.3f} mm outside the courtyard bounding box.", where,
                             "Enlarge the courtyard to enclose all pads with 0.25 mm clearance (KLC F5.3)."))
        elif mf is not None and mf < -0.005:
            C.append(check("Courtyard encloses body (fab outline)", "fail", f"fab extends {abs(mf):.3f} mm outside (bounding boxes)"))
            F.append(finding("warning", f"Fab-layer graphics extend {abs(mf):.3f} mm beyond the courtyard bounding box; "
                             "the courtyard may not cover the component body.", where,
                             "Enclose the body in the courtyard, unless the fab graphic is an intentional overhang "
                             "(e.g. an inserted card or board-edge part). If so, say so in the description."))
        else:
            m = min(v for v in (mp, mf) if v is not None) if (mp is not None or mf is not None) else None
            if m is not None:
                detail = f"min margin {m:.3f} mm (pads and fab vs courtyard, bounding boxes)"
                ok = m >= COURTYARD_CLEARANCE - 0.01
                C.append(check("Courtyard clearance >= 0.25 mm", "pass" if ok else "fail", detail))
                if not ok:
                    F.append(finding("warning", f"Courtyard clearance is only {m:.3f} mm on at least one side "
                                     f"(KLC typical {COURTYARD_CLEARANCE} mm; bounding-box approximation).", where))

    # --- silkscreen over pads ---
    silk = graphic_segments(fp, lambda l: l.endswith(".SilkS"))
    copper_pads = [p for p in pads if any(l.endswith(".Cu") or l == "*.Cu" for l in p["layers"])]
    hits = {}
    for a, b, w, line in silk:
        for p in copper_pads:
            if _seg_hits_pad(a, b, max(w, 0.0) / 2, p):
                hits.setdefault(line, set()).add(p["number"] or "(unnamed)")
    C.append(check("Silkscreen does not overlap pads", "fail" if hits else "pass",
                   f"{len(hits)} silk items overlap copper pads" if hits else ""))
    for line, nums in sorted(hits.items()):
        F.append(finding("warning", f"Silkscreen graphic overlaps copper pad(s) {', '.join(sorted(nums, key=_natkey))}.",
                         lm(line), "Keep silk >= 0.2 mm from pads (it is clipped by the soldermask at fab)."))

    # --- paste on SMD pads / exposed pad ---
    paste_only = [p for p in pads if p["layers"] and all(l.endswith(".Paste") for l in p["layers"])]
    for p in pads:
        if p["type"] != "smd" or not p["number"]:
            continue
        on_cu = any(l.endswith(".Cu") for l in p["layers"])
        has_paste = any(l.endswith(".Paste") for l in p["layers"])
        if on_cu and not has_paste and not paste_only:
            F.append(finding("info", f"SMD pad {p['number']} has no paste layer and there are no separate paste apertures.",
                             lm(p["line"]), "Intended? Exposed pads usually get a reduced paste pattern (e.g. 50-80% coverage)."))

    # --- pads: duplicates ---
    counts = {}
    for p in pads:
        if p["number"]:
            counts[p["number"]] = counts.get(p["number"], 0) + 1
    dups = {k: v for k, v in counts.items() if v > 1}
    if dups:
        F.append(finding("info", "Pad numbers used more than once: " + ", ".join(f"{k}×{v}" for k, v in sorted(dups.items())) +
                         " (fine for split exposed pads / shields; check it is intended).", lm(fp.line)))

    # --- 3D model ---
    models = fp.children("model")
    C.append(check("3D model present", "pass" if models else ("unknown" if virtual else "fail")))
    if not models and not virtual:
        F.append(finding("warning", "Footprint has no 3D model.", lm(fp.line),
                         "Add a STEP model under lib_3d/<library>/ referenced via ${KICAD_LIBS_DIR}."))
    man = {m.get("path_raw"): m for m in (model3d_manifest or [])}
    for m in models:
        path = m.atom(0, "") or ""
        if not path.startswith(KICAD_LIBS_PREFIX):
            F.append(finding("warning", f"3D model path `{path}` does not use `${{KICAD_LIBS_DIR}}/lib_3d/...`.",
                             lm(m.line), "Vendor the model into lib_3d/ and reference it via ${KICAD_LIBS_DIR} so it resolves for everyone."))
        # Only models inside this repo can be verified; stock ${KICADn_3DMODEL_DIR} paths
        # are covered by the path warning above.
        exists = None
        if path.startswith(KICAD_LIBS_PREFIX):
            exists = man.get(path, {}).get("exists")
            if exists is None and repo_path_exists:
                exists = repo_path_exists(path[len(KICAD_LIBS_PREFIX):])
        if exists is False:
            F.append(finding("error", f"3D model file `{path}` does not exist.", lm(m.line)))
        name_finding = model_name_mismatch(fp.atom(0, "") or "", path)
        if name_finding:
            F.append(finding("warning", name_finding, lm(m.line),
                             "Use the 3D model made for this exact package (or rename/regenerate it) so the 3D view "
                             "and MCAD export match the land pattern.", category="3d-model"))
        if m.has_flag("hide"):
            F.append(finding("info", f"3D model `{path.rsplit('/', 1)[-1]}` is hidden.", lm(m.line)))
        for key in ("offset", "rotate"):
            node = m.child(key)
            xyz = node.child("xyz").floats() if node and node.child("xyz") else []
            if key == "offset" and xyz and max(abs(v) for v in xyz) > 25:
                F.append(finding("warning", f"3D model offset {xyz} mm looks implausibly large.", lm(node.line)))
            if key == "rotate" and xyz and any(abs(v) % 90 > 0.01 for v in xyz):
                F.append(finding("info", f"3D model rotation {xyz} is not a multiple of 90°.", lm(node.line)))
        scale = m.child("scale")
        sxyz = scale.child("xyz").floats() if scale and scale.child("xyz") else []
        if sxyz and any(abs(v - 1) > 1e-6 for v in sxyz):
            F.append(finding("warning", f"3D model scale is {sxyz}, expected 1 1 1.", lm(scale.line)))

    return F, C


# ---------------------------------------------------------------------------
# Symbols
# ---------------------------------------------------------------------------

def parse_pins(sym: Node) -> list[dict]:
    pins = []
    base = sym.atom(0, "")
    for sub in sym.children("symbol"):
        m = re.match(re.escape(base) + r"_(\d+)_(\d+)$", sub.atom(0, "") or "")
        unit = int(m.group(1)) if m else 0
        style = int(m.group(2)) if m else 0
        for p in sub.children("pin"):
            at = p.child("at")
            xy = at.floats() if at else []
            num = p.child("number")
            name = p.child("name")
            pins.append({
                "number": num.atom(0, "") if num else "",
                "name": name.atom(0, "") if name else "",
                "type": p.atom(0, ""),
                "shape": p.atom(1, ""),
                "unit": unit,
                "style": style,
                "x": xy[0] if xy else 0.0,
                "y": xy[1] if len(xy) > 1 else 0.0,
                "length": (p.child("length").floats() or [0.0])[0] if p.child("length") else 0.0,
                "hidden": p.has_flag("hide"),
                "line": p.line,
            })
    return pins


def symbol_stats(sym: Node) -> dict:
    pins = parse_pins(sym)
    units = sorted({p["unit"] for p in pins if p["unit"]}) or [1]
    return {
        "pin_count": len(pins),
        "units": len(units),
        "extends": sym.value("extends"),
        "pins": [{k: p[k] for k in ("number", "name", "type", "unit", "x", "y", "length", "hidden")} for p in pins],
    }


def _on_grid(v: float, grid: float) -> bool:
    q = v / grid
    return abs(q - round(q)) < 1e-3


def check_symbol(sym: Node, lm: LineMap):
    F, C = [], []
    props = _props(sym)

    def prop(k):
        return (props.get(k, ("", None))[0] or "").strip()

    def pline(k):
        return lm(props[k][1].line) if k in props else lm(sym.line)

    ds = prop("Datasheet")
    ok = ds not in ("", "~")
    C.append(check("Datasheet property filled", "pass" if ok else "fail", ds))
    if not ok:
        F.append(finding("warning", "Symbol `Datasheet` property is empty.", pline("Datasheet"),
                         "Link the manufacturer datasheet (KLC S6.2)."))
    if not prop("Description"):
        F.append(finding("warning", "Symbol `Description` property is empty.", pline("Description")))
    if not prop("ki_keywords"):
        F.append(finding("info", "Symbol has no keywords (`ki_keywords`).", lm(sym.line)))
    fp_prop = prop("Footprint")
    if not fp_prop and not prop("ki_fp_filters"):
        F.append(finding("warning", "Symbol has neither a default `Footprint` nor `ki_fp_filters`.", lm(sym.line)))
    C.append(check("Default footprint / footprint filter set", "pass" if (fp_prop or prop("ki_fp_filters")) else "fail",
                   fp_prop or prop("ki_fp_filters")))

    if sym.value("extends"):
        F.append(finding("info", f"Symbol extends `{sym.value('extends')}`; pins are inherited and not checked here.", lm(sym.line)))
        return F, C

    pins = parse_pins(sym)
    C.append(check("Symbol has pins", "pass" if pins else "fail", f"{len(pins)} pins"))
    off100 = [p for p in pins if not (_on_grid(p["x"], GRID_100MIL) and _on_grid(p["y"], GRID_100MIL))]
    off50 = [p for p in off100 if not (_on_grid(p["x"], GRID_50MIL) and _on_grid(p["y"], GRID_50MIL))]
    C.append(check("Pins on 100 mil grid", "pass" if not off100 else "fail",
                   ", ".join(p["number"] for p in off100)))
    for p in off50:
        F.append(finding("error", f"Pin {p['number']} ({p['name']}) at ({p['x']}, {p['y']}) is off the 50 mil grid.",
                         lm(p["line"]), "Move pin connection points onto the 100 mil (2.54 mm) grid (KLC S4.1)."))
    for p in off100:
        if p not in off50:
            F.append(finding("warning", f"Pin {p['number']} ({p['name']}) at ({p['x']}, {p['y']}) is on 50 mil but not 100 mil grid.",
                             lm(p["line"]), "KLC S4.1 requires a 100 mil grid for pin connection points."))
    for p in pins:
        if p["length"] and not _on_grid(p["length"], GRID_50MIL):
            F.append(finding("info", f"Pin {p['number']} length {p['length']} mm is not a multiple of 50 mil.", lm(p["line"])))

    # duplicate numbers within the same body style (unit 0 is shared by all units)
    seen = {}
    for p in pins:
        if not p["number"]:
            continue
        seen.setdefault((p["style"], p["number"]), []).append(p)
    for (style, num), ps in sorted(seen.items(), key=lambda kv: _natkey(kv[0][1])):
        if len(ps) > 1:
            F.append(finding("error", f"Pin number {num} is used by {len(ps)} pins ({', '.join(q['name'] for q in ps)}).",
                             lm(ps[1]["line"])))
    for p in pins:
        if p["hidden"] and p["type"] in ("power_in", "power_out"):
            F.append(finding("warning", f"Power pin {p['number']} ({p['name']}) is hidden.", lm(p["line"]),
                             "Avoid hidden power pins (KLC S4.4); make it visible or use stacked visible pins."))
        if not p["number"]:
            F.append(finding("error", f"Pin `{p['name']}` has no number.", lm(p["line"])))
    return F, C


def check_pairing(sym_pins: list[dict], fp_pads: list[dict], sym_id: str, fp_id: str, sym_lm: LineMap | None):
    """Cross-check symbol pin numbers vs footprint pad numbers."""
    F, C = [], []
    pin_nums = {p["number"] for p in sym_pins if p["number"]}
    pad_nums = {p["number"] for p in fp_pads if p["number"]}
    missing_pads = sorted(pin_nums - pad_nums, key=_natkey)
    unused_pads = sorted(pad_nums - pin_nums, key=_natkey)
    ok = not missing_pads and not unused_pads
    C.append(check(f"Symbol pins match footprint pads ({fp_id})", "pass" if ok else "fail",
                   f"pins without pad: {missing_pads or '-'}; pads without pin: {unused_pads or '-'}"))
    if missing_pads:
        F.append(finding("error", f"Symbol pins {', '.join(missing_pads)} have no matching pad in `{fp_id}`.",
                         sym_lm(None) if sym_lm else None))
    if unused_pads:
        F.append(finding("warning", f"Pads {', '.join(unused_pads)} of `{fp_id}` have no matching pin in `{sym_id}`.",
                         None, "Unconnected pads (e.g. mounting/shield) are fine if intended; otherwise add pins."))
    return F, C
