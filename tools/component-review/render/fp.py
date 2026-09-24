"""Footprint (.kicad_mod) model, statistics and pure-Python SVG rendering."""

from __future__ import annotations

import math
import re

from geom import BBox, arc_mid_from_center, arc_path, arc_points, f, rot, text_el, text_extent
from sexpr import Atom, Node

# KiCad 10 default ("KiCad Default") PCB colour theme, approximately.
LAYER_COLORS = {
    "F.Cu": "#C83434", "B.Cu": "#4D7FC4",
    "In1.Cu": "#7FC87F", "In2.Cu": "#CEA7D0",
    "F.Adhes": "#840084", "B.Adhes": "#000084",
    "F.Paste": "#B4A09E", "B.Paste": "#00C2C2",
    "F.SilkS": "#F2EDA1", "B.SilkS": "#E8B2A7",
    "F.Mask": "#D864FF", "B.Mask": "#02FFEE",
    "Dwgs.User": "#C2C2C2", "Cmts.User": "#5994DC",
    "Eco1.User": "#B4DBD2", "Eco2.User": "#D8C852",
    "Edge.Cuts": "#D0D2CD", "Margin": "#FF26E2",
    "F.CrtYd": "#FF26E2", "B.CrtYd": "#26E9FF",
    "F.Fab": "#AFAFAF", "B.Fab": "#585D84",
}
USER_COLORS = ["#C2C2C2", "#59D6DC", "#D8C852", "#B4DBD2", "#5994DC", "#D4A0FF", "#FFB070", "#8CE08C", "#E0E0A0"]
LAYER_OPACITY = {"F.Mask": 0.4, "B.Mask": 0.4, "F.Paste": 0.9, "B.Paste": 0.9}
BACKGROUND = "#001023"
HOLE_FILL = "#101820"
PTH_RING = "#E3B72E"
NPTH_RING = "#1AC4D2"

# Back-to-front drawing order for the combined view.
LAYER_ORDER = [
    "B.Fab", "B.CrtYd", "B.Adhes", "B.SilkS", "B.Paste", "B.Mask", "B.Cu",
    "In1.Cu", "In2.Cu",
    "F.Adhes", "F.Paste", "F.Mask", "F.Cu", "F.SilkS", "F.Fab", "F.CrtYd",
    "Edge.Cuts", "Margin", "Dwgs.User", "Cmts.User", "Eco1.User", "Eco2.User",
] + [f"User.{i}" for i in range(1, 10)]


def layer_color(layer: str) -> str:
    if layer in LAYER_COLORS:
        return LAYER_COLORS[layer]
    m = re.match(r"User\.(\d+)", layer)
    if m:
        return USER_COLORS[(int(m.group(1)) - 1) % len(USER_COLORS)]
    if layer.startswith("In") and layer.endswith(".Cu"):
        return "#7FC87F"
    return "#C2C2C2"


def layer_sort_key(layer: str):
    try:
        return LAYER_ORDER.index(layer)
    except ValueError:
        return len(LAYER_ORDER)


def expand_layers(names) -> list[str]:
    out = []
    for n in names:
        n = str(n)
        if n.startswith("*.") or n.startswith("F&B."):
            suffix = n.split(".", 1)[1]
            out += [f"F.{suffix}", f"B.{suffix}"]
        else:
            out.append(n)
    return list(dict.fromkeys(out))


def _xy(node: Node | None, default=(0.0, 0.0)):
    if node is None:
        return default
    v = node.nums()
    return (v[0], v[1]) if len(v) >= 2 else default


def _at(node: Node):
    at = node.child("at")
    if at is None:
        return 0.0, 0.0, 0.0
    v = at.nums()
    return (v[0] if v else 0.0), (v[1] if len(v) > 1 else 0.0), (v[2] if len(v) > 2 else 0.0)


def _stroke_width(node: Node, default=0.12):
    st = node.child("stroke")
    if st is not None:
        w = st.num("width", default)
        return w if w > 0 else default
    w = node.num("width", default)
    return w if w > 0 else default


def _filled(node: Node) -> bool:
    fill = node.child("fill")
    if fill is None:
        return False
    v = str(fill.arg(0, "") or fill.value("type", ""))
    return v in ("yes", "solid", "true")


def _layer(node: Node) -> str:
    return str(node.value("layer", "F.SilkS"))


# ---------------------------------------------------------------------------
# model
# ---------------------------------------------------------------------------

class Footprint:
    def __init__(self, root: Node):
        self.root = root
        self.name = str(root.arg(0, ""))
        self.version = root.value("version")
        self.generator_version = root.value("generator_version")
        self.descr = str(root.value("descr", "") or "")
        self.tags = str(root.value("tags", "") or "")
        attr = root.child("attr")
        self.attr = [str(a) for a in attr.atoms()] if attr is not None else []
        self.properties: dict[str, str] = {}
        self.texts = []      # dicts: text, x, y, angle, layer, size, hidden, justify, mirror
        self.graphics = []   # dicts: kind, layer, width, filled, geometry
        self.pads = []
        self.zones = []
        self.models = []
        self.embedded: dict[str, dict] = {}
        self._parse()

    # -- parsing -------------------------------------------------------------
    def _text(self, node: Node, txt: str, hidden: bool):
        x, y, a = _at(node)
        eff = node.child("effects")
        size = (1.0, 1.0)
        thick = 0.15
        justify = []
        bold = False
        if eff is not None:
            font = eff.child("font")
            if font is not None:
                s = font.nums("size") or [1.0, 1.0]
                size = (s[0], s[1] if len(s) > 1 else s[0])
                thick = font.num("thickness", 0.15)
                bold = font.flag("bold")
            j = eff.child("justify")
            if j is not None:
                justify = [str(v) for v in j.atoms()]
            hidden = hidden or eff.flag("hide")
        hidden = hidden or node.flag("hide")
        self.texts.append(dict(text=txt, x=x, y=y, angle=a, layer=_layer(node), size=size,
                               thickness=thick, hidden=hidden, justify=justify, bold=bold,
                               unlocked=node.flag("unlocked")))

    def _parse(self):
        r = self.root
        for c in r.children():
            n = c.name
            if n == "property":
                key, val = str(c.arg(0, "")), str(c.arg(1, ""))
                self.properties[key] = val
                if c.child("layer") is not None:
                    self._text(c, val, hidden=c.flag("hide") or key not in ("Reference", "Value"))
            elif n == "fp_text":
                kind = str(c.arg(0, "user"))
                txt = str(c.arg(1, ""))
                if kind == "reference":
                    self.properties.setdefault("Reference", txt)
                elif kind == "value":
                    self.properties.setdefault("Value", txt)
                self._text(c, txt, hidden=c.flag("hide"))
            elif n in ("fp_line", "fp_arc", "fp_circle", "fp_rect", "fp_poly", "fp_curve"):
                g = self._graphic(c)
                if g:
                    self.graphics.append(g)
            elif n == "fp_text_box":
                txt = str(c.arg(0, ""))
                self._text(c, txt, hidden=False)
            elif n == "pad":
                self.pads.append(self._pad(c))
            elif n == "zone":
                self.zones.append(self._zone(c))
            elif n == "model":
                self.models.append(self._model(c))
            elif n == "embedded_files":
                for fl in c.children("file"):
                    self.embedded[str(fl.value("name", ""))] = {
                        "type": str(fl.value("type", "")), "data": str(fl.value("data", "") or ""),
                        "checksum": str(fl.value("checksum", "") or "")}
        if self.descr and "descr" not in self.properties:
            self.properties.setdefault("Description", self.properties.get("Description") or "")

    def _graphic(self, c: Node):
        n = c.name
        g = dict(kind=n[3:], layer=_layer(c), width=_stroke_width(c), filled=_filled(c))
        if n == "fp_line":
            g["pts"] = [_xy(c.child("start")), _xy(c.child("end"))]
        elif n == "fp_rect":
            (x0, y0), (x1, y1) = _xy(c.child("start")), _xy(c.child("end"))
            g["pts"] = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
            g["closed"] = True
            g["kind"] = "poly"
        elif n == "fp_circle":
            cx, cy = _xy(c.child("center"))
            ex, ey = _xy(c.child("end"))
            g["center"], g["r"] = (cx, cy), math.hypot(ex - cx, ey - cy)
        elif n == "fp_arc":
            if c.child("mid") is not None:
                g["arc"] = (_xy(c.child("start")), _xy(c.child("mid")), _xy(c.child("end")))
            else:  # legacy: start = centre, end = arc start, angle
                g["arc"] = arc_mid_from_center(_xy(c.child("start")), _xy(c.child("end")), c.num("angle", 90))
        elif n == "fp_poly":
            g["pts"] = [tuple(p.nums()[:2]) for p in (c.child("pts") or Node()).children("xy")]
            g["closed"] = True
            g["kind"] = "poly"
        elif n == "fp_curve":
            g["pts"] = [tuple(p.nums()[:2]) for p in (c.child("pts") or Node()).children("xy")]
            g["kind"] = "bezier"
        return g

    def _pad(self, c: Node):
        x, y, a = _at(c)
        size = c.nums("size") or [0.0, 0.0]
        if len(size) == 1:
            size = [size[0], size[0]]
        drill = None
        d = c.child("drill")
        if d is not None:
            oval = "oval" in [str(v) for v in d.atoms()]
            nums = [float(v) for v in d.atoms() if _isnum(v)]
            if nums:
                dx = nums[0]
                dy = nums[1] if (oval and len(nums) > 1) else dx
                off = _xy(d.child("offset"))
                drill = dict(w=dx, h=dy, oval=oval, offset=off)
        layers = expand_layers((c.child("layers") or Node()).atoms())
        prims = []
        pr = c.child("primitives")
        if pr is not None:
            for p in pr.children():
                g = dict(kind=p.name[3:], width=p.num("width", 0.0) or _stroke_width(p, 0.0), filled=_filled(p) or p.name == "gr_poly")
                if p.name == "gr_poly":
                    g["pts"] = [tuple(q.nums()[:2]) for q in (p.child("pts") or Node()).children("xy")]
                    g["kind"] = "poly"
                elif p.name == "gr_line":
                    g["pts"] = [_xy(p.child("start")), _xy(p.child("end"))]
                elif p.name == "gr_rect":
                    (x0, y0), (x1, y1) = _xy(p.child("start")), _xy(p.child("end"))
                    g["pts"] = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
                    g["kind"] = "poly"
                elif p.name == "gr_circle":
                    cx, cy = _xy(p.child("center"))
                    ex, ey = _xy(p.child("end"))
                    g["center"], g["r"] = (cx, cy), math.hypot(ex - cx, ey - cy)
                elif p.name == "gr_arc":
                    if p.child("mid") is not None:
                        g["arc"] = (_xy(p.child("start")), _xy(p.child("mid")), _xy(p.child("end")))
                    else:
                        g["arc"] = arc_mid_from_center(_xy(p.child("start")), _xy(p.child("end")), p.num("angle", 90))
                else:
                    continue
                prims.append(g)
        opts = c.child("options")
        anchor = str(opts.value("anchor", "circle")) if opts is not None else "circle"
        chamfer = c.child("chamfer")
        return dict(
            number=str(c.arg(0, "")), type=str(c.arg(1, "")), shape=str(c.arg(2, "")),
            x=x, y=y, angle=a, w=size[0], h=size[1], drill=drill, layers=layers,
            rratio=c.num("roundrect_rratio", 0.25), delta=c.nums("rect_delta") or [0.0, 0.0],
            chamfer_ratio=c.num("chamfer_ratio", 0.0),
            chamfer=[str(v) for v in chamfer.atoms()] if chamfer is not None else [],
            primitives=prims, anchor=anchor,
            mask_margin=c.num("solder_mask_margin", 0.0),
            paste_margin=c.num("solder_paste_margin", 0.0),
            paste_ratio=c.num("solder_paste_margin_ratio", 0.0),
            line=c.line_start,
        )

    def _zone(self, c: Node):
        layers = []
        if c.child("layer") is not None:
            layers = [str(c.value("layer"))]
        if c.child("layers") is not None:
            layers = [str(v) for v in c.child("layers").atoms()]
        polys = []
        for p in c.children("polygon"):
            polys.append([tuple(q.nums()[:2]) for q in (p.child("pts") or Node()).children("xy")])
        return dict(layers=expand_layers(layers), polys=polys, keepout=c.child("keepout") is not None,
                    name=str(c.value("name", "") or ""))

    def _model(self, c: Node):
        def vec(name, default):
            n = c.child(name)
            if n is None:
                return list(default)
            xyz = n.child("xyz")
            v = xyz.nums() if xyz is not None else []
            return (v + list(default))[:3] if len(v) < 3 else v[:3]
        off = vec("offset", (0, 0, 0))
        if c.child("offset") is None and c.child("at") is not None:  # KiCad 5: inches
            off = [v * 25.4 for v in vec("at", (0, 0, 0))]
        z = lambda v: [x + 0.0 for x in v]  # noqa: E731  (-0.0 -> 0.0)
        return dict(path=str(c.arg(0, "")), offset=z(off), scale=z(vec("scale", (1, 1, 1))),
                    rotate=z(vec("rotate", (0, 0, 0))), hidden=c.flag("hide"),
                    opacity=c.num("opacity", 1.0))

    # -- derived -------------------------------------------------------------
    def substitute(self, txt: str) -> str:
        def rep(m):
            key = m.group(1)
            if key == "REFERENCE":
                return self.properties.get("Reference", "REF**")
            if key == "VALUE":
                return self.properties.get("Value", "")
            if key == "FOOTPRINT_NAME":
                return self.name
            return self.properties.get(key, self.properties.get(key.title(), m.group(0)))
        return re.sub(r"\$\{([A-Za-z0-9_]+)\}", rep, txt)

    def layers_present(self) -> list[str]:
        s = set()
        for g in self.graphics:
            s.add(g["layer"])
        for t in self.texts:
            if not t["hidden"]:
                s.add(t["layer"])
        for p in self.pads:
            s.update(p["layers"])
        for z in self.zones:
            s.update(z["layers"])
        return sorted(s, key=layer_sort_key)

    def courtyard_bbox(self, side="F"):
        bb = BBox()
        for g in self.graphics:
            if g["layer"] == f"{side}.CrtYd":
                _graphic_bbox(g, bb)
        return bb.as_list()

    def stats(self) -> dict:
        pads = self.pads
        counts = {"smd": 0, "thru_hole": 0, "np_thru_hole": 0, "connect": 0}
        for p in pads:
            counts[p["type"]] = counts.get(p["type"], 0) + 1
        numbered = [p for p in pads if p["number"] and p["type"] != "np_thru_hole"]
        numbers = sorted({p["number"] for p in numbered}, key=_natkey)
        table = []
        for p in pads:
            table.append({
                "number": p["number"], "type": p["type"], "shape": p["shape"],
                "size": [round(p["w"], 4), round(p["h"], 4)],
                "at": [round(p["x"], 4), round(p["y"], 4), round(p["angle"], 3)],
                "pos": [round(p["x"], 4), round(p["y"], 4)],
                "angle": round(p["angle"], 3),
                "drill": ([round(p["drill"]["w"], 4), round(p["drill"]["h"], 4)] if p["drill"] else None),
                "layers": p["layers"],
                "roundrect_rratio": round(p["rratio"], 4) if p["shape"] == "roundrect" else None,
            })
        crt = self.courtyard_bbox("F") or self.courtyard_bbox("B")
        body = BBox()
        for p in pads:
            _pad_bbox(p, body)
        pad_ext = body.as_list()
        layers = self.layers_present()
        ref = self.properties.get("Reference", "REF**")
        visible_ref = [t for t in self.texts if not t["hidden"] and self.substitute(t["text"]) == ref]
        return {
            "pad_count": len(pads),
            "smd_count": counts.get("smd", 0),
            "tht_count": counts.get("thru_hole", 0),
            "npth_count": counts.get("np_thru_hole", 0),
            "unique_pad_numbers": numbers,
            "pad_number_count": len(numbers),
            "pads": table,
            "pad_extent": pad_ext,
            "courtyard_bbox": crt,
            "courtyard_size": [round(crt[2] - crt[0], 4), round(crt[3] - crt[1], 4)] if crt else None,
            "layers": layers,
            "has_courtyard": any(l.endswith(".CrtYd") for l in layers),
            "has_fab": any(l.endswith(".Fab") for l in layers),
            "has_silk": any(l.endswith(".SilkS") for l in layers),
            "reference_on_silk": any(t["layer"].endswith("SilkS") for t in visible_ref),
            "reference_on_fab": any(t["layer"].endswith("Fab") for t in visible_ref),
            "attr": self.attr,
            "pin1": self.pin1_markers(),
            "models": [m["path"] for m in self.models],
            "zones": len(self.zones),
            "texts": [{"text": t["text"], "layer": t["layer"], "hidden": t["hidden"]} for t in self.texts],
        }

    def pin1_markers(self) -> dict:
        """Heuristic: a silk/fab graphic whose closest pad is pad 1 (and is near it)."""
        p1 = [p for p in self.pads if p["number"] in ("1", "A1")]
        if not p1:
            return {"pad1_exists": False}
        pad1 = p1[0]
        others = [p for p in self.pads if p is not pad1 and p["type"] != "np_thru_hole"]
        res = {"pad1_exists": True, "pad1_pos": [pad1["x"], pad1["y"]]}
        shapes = {(p["shape"], round(p["w"], 3), round(p["h"], 3)) for p in others}
        res["pad1_shape_distinct"] = bool(others) and (pad1["shape"], round(pad1["w"], 3), round(pad1["h"], 3)) not in shapes
        for side in ("SilkS", "Fab"):
            found = False
            for g in self.graphics:
                if not g["layer"].endswith(side):
                    continue
                c = _graphic_centroid(g)
                if c is None:
                    continue
                d1 = math.hypot(c[0] - pad1["x"], c[1] - pad1["y"])
                dmin = min((math.hypot(c[0] - p["x"], c[1] - p["y"]) for p in others), default=math.inf)
                small = _graphic_size(g) < 2.5 * max(pad1["w"], pad1["h"], 0.5)
                if small and d1 < dmin and d1 < 3.0:
                    found = True
                    break
            res[("silk" if side == "SilkS" else "fab") + "_marker_near_pad1"] = found
        return res


def decode_embedded(data: str) -> bytes:
    """KiCad 10 embedded file payload: |base64(zstd(content))|."""
    import base64
    raw = base64.b64decode(data.strip("|"))
    if raw[:4] == b"\x28\xb5\x2f\xfd":
        import zstandard
        return zstandard.ZstdDecompressor().decompressobj().decompress(raw)
    return raw


def _isnum(v) -> bool:
    try:
        float(v)
        return True
    except (TypeError, ValueError):
        return False


def _natkey(s: str):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", s)]


def _graphic_centroid(g):
    if "center" in g:
        return g["center"]
    pts = g.get("pts") or (list(g["arc"]) if "arc" in g else None)
    if not pts:
        return None
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)


def _graphic_size(g):
    bb = BBox()
    _graphic_bbox(g, bb)
    if not bb.valid:
        return math.inf
    return max(bb.x1 - bb.x0, bb.y1 - bb.y0)


def _graphic_bbox(g, bb: BBox):
    w = g.get("width", 0) / 2
    if "center" in g:
        cx, cy = g["center"]
        r = g["r"] + w
        bb.add(cx - r, cy - r)
        bb.add(cx + r, cy + r)
    elif "arc" in g:
        for p in arc_points(*g["arc"]):
            bb.add(p[0], p[1], w)
    else:
        for p in g.get("pts", []):
            bb.add(p[0], p[1], w)


def _pad_bbox(p, bb: BBox):
    r = math.hypot(p["w"], p["h"]) / 2
    pts = []
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        pts.append(rot(sx * p["w"] / 2, sy * p["h"] / 2, p["angle"]))
    for prim in p["primitives"]:
        sub = BBox()
        _graphic_bbox(prim, sub)
        if sub.valid:
            pts += [rot(sub.x0, sub.y0, p["angle"]), rot(sub.x1, sub.y1, p["angle"]),
                    rot(sub.x0, sub.y1, p["angle"]), rot(sub.x1, sub.y0, p["angle"])]
    if not pts:
        bb.add(p["x"], p["y"], r)
    for dx, dy in pts:
        bb.add(p["x"] + dx, p["y"] + dy)


# ---------------------------------------------------------------------------
# SVG rendering
# ---------------------------------------------------------------------------

def _pad_shape_d(p, grow: float = 0.0) -> str:
    """Path of the pad outline in pad-local coordinates (unrotated)."""
    w, h = p["w"] + 2 * grow, p["h"] + 2 * grow
    shape = p["shape"]
    if shape == "custom":
        shape = "circle" if p["anchor"] == "circle" else "rect"
    if shape == "circle":
        r = w / 2
        return f"M{f(-r)} 0A{f(r)} {f(r)} 0 1 0 {f(r)} 0A{f(r)} {f(r)} 0 1 0 {f(-r)} 0Z"
    if shape == "oval":
        r = min(w, h) / 2
        return _rrect_d(w, h, r)
    if shape == "roundrect" and not p["chamfer"]:
        r = min(w, h) * p["rratio"] + (grow if grow > 0 else 0)
        return _rrect_d(w, h, min(r, min(w, h) / 2))
    if shape in ("chamfered_rect", "roundrect"):
        c = min(w, h) * p["chamfer_ratio"]
        x0, y0, x1, y1 = -w / 2, -h / 2, w / 2, h / 2
        ch = set(p["chamfer"])
        pts = []
        pts += [(x0, y0 + c), (x0 + c, y0)] if "top_left" in ch else [(x0, y0)]
        pts += [(x1 - c, y0), (x1, y0 + c)] if "top_right" in ch else [(x1, y0)]
        pts += [(x1, y1 - c), (x1 - c, y1)] if "bottom_right" in ch else [(x1, y1)]
        pts += [(x0 + c, y1), (x0, y1 - c)] if "bottom_left" in ch else [(x0, y1)]
        return "M" + "L".join(f"{f(x)} {f(y)}" for x, y in pts) + "Z"
    if shape == "trapezoid":
        dx, dy = (p["delta"] + [0, 0])[:2]
        # KiCad: rect_delta dx widens the bottom side vs top (for dy: left vs right)
        pts = [(-w / 2 - dy / 2, -h / 2 + dx / 2), (w / 2 + dy / 2, -h / 2 - dx / 2),
               (w / 2 - dy / 2, h / 2 + dx / 2), (-w / 2 + dy / 2, h / 2 - dx / 2)]
        return "M" + "L".join(f"{f(x)} {f(y)}" for x, y in pts) + "Z"
    # rect and fallback
    return f"M{f(-w/2)} {f(-h/2)}H{f(w/2)}V{f(h/2)}H{f(-w/2)}Z"


def _rrect_d(w, h, r):
    x0, y0, x1, y1 = -w / 2, -h / 2, w / 2, h / 2
    if r <= 0:
        return f"M{f(x0)} {f(y0)}H{f(x1)}V{f(y1)}H{f(x0)}Z"
    return (f"M{f(x0 + r)} {f(y0)}H{f(x1 - r)}A{f(r)} {f(r)} 0 0 1 {f(x1)} {f(y0 + r)}"
            f"V{f(y1 - r)}A{f(r)} {f(r)} 0 0 1 {f(x1 - r)} {f(y1)}H{f(x0 + r)}"
            f"A{f(r)} {f(r)} 0 0 1 {f(x0)} {f(y1 - r)}V{f(y0 + r)}A{f(r)} {f(r)} 0 0 1 {f(x0 + r)} {f(y0)}Z")


def _graphic_svg(g, color, stroke_only=False, width=None) -> str:
    w = width if width is not None else g.get("width", 0.1)
    filled = g.get("filled") and not stroke_only
    fill = color if filled else "none"
    st = f'stroke="{color}" stroke-width="{f(max(w, 0.001))}" stroke-linecap="round" stroke-linejoin="round"'
    if "center" in g:
        cx, cy = g["center"]
        return f'<circle cx="{f(cx)}" cy="{f(cy)}" r="{f(g["r"])}" fill="{fill}" {st}/>'
    if "arc" in g:
        return f'<path d="{arc_path(*g["arc"])}" fill="none" {st}/>'
    pts = g.get("pts", [])
    if not pts:
        return ""
    if g["kind"] == "bezier" and len(pts) == 4:
        (a, b, c, d) = pts
        return (f'<path d="M{f(a[0])} {f(a[1])}C{f(b[0])} {f(b[1])} {f(c[0])} {f(c[1])} {f(d[0])} {f(d[1])}" '
                f'fill="none" {st}/>')
    d = "M" + "L".join(f"{f(x)} {f(y)}" for x, y in pts) + ("Z" if g.get("closed") else "")
    return f'<path d="{d}" fill="{fill}" {st}/>'


def _pad_svg(p, color, grow=0.0, opacity=None) -> str:
    tr = f"translate({f(p['x'])} {f(p['y'])})" + (f" rotate({f(-p['angle'])})" if p["angle"] else "")
    op = f' opacity="{f(opacity)}"' if opacity is not None else ""
    parts = [f'<path d="{_pad_shape_d(p, grow)}" fill="{color}"/>']
    for prim in p["primitives"]:
        g = dict(prim)
        if g.get("kind") == "poly":
            g["filled"] = True
            g["closed"] = True
        w = g.get("width", 0) + 2 * grow
        parts.append(_graphic_svg(g, color, width=w))
    return f'<g transform="{tr}"{op} class="pad" data-pad="{p["number"]}">' + "".join(parts) + "</g>"


def _hole_svg(p) -> str:
    d = p["drill"]
    if not d:
        return ""
    ox, oy = d["offset"]
    tr = f"translate({f(p['x'])} {f(p['y'])})" + (f" rotate({f(-p['angle'])})" if p["angle"] else "")
    ring = NPTH_RING if p["type"] == "np_thru_hole" else PTH_RING
    w, h = d["w"], d["h"]
    shape = _rrect_d(w, h, min(w, h) / 2)
    return (f'<g transform="{tr}"><path transform="translate({f(ox)} {f(oy)})" d="{shape}" fill="{HOLE_FILL}" '
            f'stroke="{ring}" stroke-width="{f(max(0.02, min(w, h) * 0.06))}"/></g>')


def _text_svg(fp: Footprint, t, color) -> tuple[str, BBox]:
    txt = fp.substitute(t["text"])
    bb = BBox()
    if t["hidden"] or not txt:
        return "", bb
    angle = t["angle"] % 360
    # KiCad keeps footprint text upright (readable from bottom or right)
    if 90 < angle <= 270:
        angle -= 180
    j = t["justify"]
    anchor = "start" if "left" in j else "end" if "right" in j else "middle"
    valign = "top" if "top" in j else "bottom" if "bottom" in j else "center"
    mirror = "mirror" in j or t["layer"].startswith("B.")
    # KiCad files store (size HEIGHT WIDTH)
    h, w = t["size"][0], t["size"][1]
    el = text_el(txt, t["x"], t["y"], h, w, angle, color, anchor, valign, mirror, t["bold"])
    text_extent(txt, t["x"], t["y"], h, w, angle, anchor, valign, bb)
    return el, bb


def layer_elements(fp: Footprint) -> tuple[dict[str, list[str]], BBox]:
    """SVG elements per layer (plus pseudo layer 'Holes') and overall bbox."""
    out: dict[str, list[str]] = {}
    bb = BBox()

    def add(layer, el):
        if el:
            out.setdefault(layer, []).append(el)

    for z in fp.zones:
        for layer in z["layers"]:
            col = layer_color(layer)
            for poly in z["polys"]:
                if not poly:
                    continue
                d = "M" + "L".join(f"{f(x)} {f(y)}" for x, y in poly) + "Z"
                fill = "none" if z["keepout"] else col
                add(layer, f'<path d="{d}" fill="{fill}" fill-opacity="0.25" stroke="{col}" '
                           f'stroke-width="0.05" stroke-dasharray="0.3 0.2"/>')
                for x, y in poly:
                    bb.add(x, y)
    for g in fp.graphics:
        add(g["layer"], _graphic_svg(g, layer_color(g["layer"])))
        _graphic_bbox(g, bb)
    for p in fp.pads:
        _pad_bbox(p, bb)
        for layer in p["layers"]:
            if layer not in ("F.Cu", "B.Cu", "F.Mask", "B.Mask", "F.Paste", "B.Paste") and not layer.endswith(".Cu"):
                # pads may live on silk/adhesive/user layers (e.g. NPTH in F.SilkS): draw as shape
                add(layer, _pad_svg(p, layer_color(layer)))
                continue
            if layer.endswith(".Cu") and p["type"] == "np_thru_hole" and max(p["w"], p["h"]) <= (p["drill"] or {"w": 0})["w"] + 1e-6:
                continue  # NPTH without copper annulus
            grow = 0.0
            if layer.endswith(".Mask"):
                grow = p["mask_margin"]
            elif layer.endswith(".Paste"):
                grow = p["paste_margin"] + p["paste_ratio"] * min(p["w"], p["h"])
            add(layer, _pad_svg(p, layer_color(layer), grow))
        if p["drill"]:
            add("Holes", _hole_svg(p))
    for t in fp.texts:
        el, tb = _text_svg(fp, t, layer_color(t["layer"]))
        add(t["layer"], el)
        # every visible text grows the frame, so nothing is ever clipped
        bb.add_box(tb)
    return out, bb


def pad_number_labels(fp: Footprint) -> list[str]:
    """Pad number labels (like KiCad's 'pad numbers' overlay) for the combined view."""
    out = []
    for p in fp.pads:
        if not p["number"]:
            continue
        s = min(p["w"], p["h"])
        if s <= 0:
            continue
        size = min(s * 0.5, 1.0) / max(1, len(p["number"]) * 0.6)
        out.append(text_el(p["number"], p["x"], p["y"], size, size, 0, "#FFFFFF", "middle", "center",
                           extra=' opacity="0.9"'))
    return out


def svg_doc(inner: str, vb, px_per_mm: float, background: str | None) -> str:
    x0, y0, x1, y1 = vb
    w, h = x1 - x0, y1 - y0
    bg = f'<rect x="{f(x0)}" y="{f(y0)}" width="{f(w)}" height="{f(h)}" fill="{background}"/>' if background else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{f(x0)} {f(y0)} {f(w)} {f(h)}" '
            f'width="{f(w * px_per_mm)}" height="{f(h * px_per_mm)}">{bg}{inner}</svg>')


def viewbox(bb: BBox, margin=1.0):
    """bbox + fixed 1 mm margin (contract Addendum 2: geom.json bbox == SVG viewBox)."""
    if not bb.valid:
        return (-5.0, -5.0, 5.0, 5.0)
    m = margin
    return (bb.x0 - m, bb.y0 - m, bb.x1 + m, bb.y1 + m)


def px_scale(vb, target=1600, max_scale=200.0) -> float:
    w, h = vb[2] - vb[0], vb[3] - vb[1]
    return min(max_scale, target / max(w, h, 1e-3))


def origin_marker(vb) -> str:
    s = max(vb[2] - vb[0], vb[3] - vb[1]) * 0.015
    return (f'<g stroke="#FFFFFF" stroke-width="{f(s * 0.15)}" opacity="0.6"><path d="M{f(-s)} 0H{f(s)}M0 {f(-s)}V{f(s)}"/>'
            f'<circle r="{f(s * 0.5)}" fill="none"/></g>')


def render_footprint(fp: Footprint, vb, px_per_mm) -> tuple[str, dict[str, str]]:
    """Return (combined svg, {layer: svg}) in the given (shared) viewBox."""
    els, _ = layer_elements(fp)
    layers = sorted([l for l in els if l != "Holes"], key=layer_sort_key)
    combined = []
    holes_drawn = False
    for layer in layers:
        if not holes_drawn and layer_sort_key(layer) > layer_sort_key("F.SilkS") and "Holes" in els:
            combined.append('<g class="layer" data-layer="Holes">' + "".join(els["Holes"]) + "</g>")
            holes_drawn = True
        op = LAYER_OPACITY.get(layer)
        opa = f' opacity="{op}"' if op else ""
        combined.append(f'<g class="layer" data-layer="{layer}"{opa}>' + "".join(els[layer]) + "</g>")
    if not holes_drawn and "Holes" in els:
        combined.append('<g class="layer" data-layer="Holes">' + "".join(els["Holes"]) + "</g>")
    combined.append('<g class="layer" data-layer="PadNumbers">' + "".join(pad_number_labels(fp)) + "</g>")
    combined.append(origin_marker(vb))
    per_layer = {}
    for layer in layers:
        inner = "".join(els[layer])
        if layer.endswith(".Cu") and "Holes" in els:
            inner += "".join(els["Holes"])
        op = LAYER_OPACITY.get(layer)
        opa = f' opacity="{op}"' if op else ""
        per_layer[layer] = svg_doc(f'<g data-layer="{layer}"{opa}>{inner}</g>', vb, px_per_mm, None)
    return svg_doc("".join(combined), vb, px_per_mm, BACKGROUND), per_layer


def footprint_bbox(fp: Footprint) -> BBox:
    return layer_elements(fp)[1]


def _polyline(g, n_arc=24):
    """Graphic -> list of [x, y] points (closed shapes repeat the first point)."""
    if "center" in g:
        cx, cy = g["center"]
        r = g["r"]
        return [[round(cx + r * math.cos(2 * math.pi * i / 48), 5), round(cy + r * math.sin(2 * math.pi * i / 48), 5)]
                for i in range(49)]
    if "arc" in g:
        return [[round(x, 5), round(y, 5)] for x, y in arc_points(*g["arc"], n=n_arc)]
    pts = [[round(x, 5), round(y, 5)] for x, y in g.get("pts", [])]
    if g.get("closed") and pts:
        pts.append(pts[0])
    return pts


def geom_json(fp: Footprint, vb) -> dict:
    """Board-less geometry for the browser 3D viewer (Addendum 2). KiCad footprint coords, mm, y down."""
    pads = []
    for p in fp.pads:
        d = p["drill"]
        pads.append({
            "number": p["number"], "type": p["type"], "shape": p["shape"],
            "at": [round(p["x"], 4), round(p["y"], 4), round(p["angle"], 3)],
            "pos": [round(p["x"], 4), round(p["y"], 4)], "angle": round(p["angle"], 3),
            "size": [round(p["w"], 4), round(p["h"], 4)],
            "drill": ({"shape": "oval" if d["oval"] else "circle", "size": [d["w"], d["h"]],
                       "offset": list(d["offset"])} if d else None),
            "layers": p["layers"],
            "roundrect_rratio": p["rratio"] if p["shape"] == "roundrect" else None,
            "chamfer_ratio": p["chamfer_ratio"] or None, "chamfer": p["chamfer"] or None,
            "rect_delta": p["delta"] if p["shape"] == "trapezoid" else None,
            "anchor": p["anchor"] if p["shape"] == "custom" else None,
            "primitives": [q for g in p["primitives"] for q in _prim_json(g)],
            "solder_mask_margin": p["mask_margin"] or None,
        })
    court = {"F": [], "B": []}
    edge = []
    for g in fp.graphics:
        if g["layer"] in ("F.CrtYd", "B.CrtYd"):
            court[g["layer"][0]].append(_polyline(g))
        elif g["layer"] == "Edge.Cuts":
            edge.append(_polyline(g))
    return {"units": "mm", "y_axis": "down", "bbox": [round(v, 4) for v in vb],
            "pads": pads, "courtyard": court, "edge_cuts": edge}


def _prim_polys(g) -> list[list[list[float]]]:
    """Custom-pad primitive -> filled polygons in pad-local mm (strokes become quads per segment)."""
    w = g.get("width", 0) or 0
    r5 = lambda p: [round(p[0], 5), round(p[1], 5)]  # noqa: E731
    if "center" in g:
        cx, cy = g["center"]
        rr = g["r"] + (w / 2 if g.get("filled") else 0)
        circ = [r5((cx + rr * math.cos(2 * math.pi * i / 32), cy + rr * math.sin(2 * math.pi * i / 32)))
                for i in range(32)]
        if g.get("filled") or w <= 0:
            return [circ]
        pts, closed = circ + [circ[0]], True
    elif "arc" in g:
        pts, closed = [list(p) for p in arc_points(*g["arc"], n=16)], False
    else:
        pts = [list(p) for p in g.get("pts", [])]
        closed = g.get("kind") == "poly"
        if closed and (g.get("filled") or g.get("kind") == "poly") and len(pts) >= 3:
            return [[r5(p) for p in pts]]
    out = []
    hw = max(w, 0.001) / 2
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        L = math.hypot(x1 - x0, y1 - y0)
        if L < 1e-9:
            continue
        nx, ny = -(y1 - y0) / L * hw, (x1 - x0) / L * hw
        out.append([r5((x0 + nx, y0 + ny)), r5((x1 + nx, y1 + ny)), r5((x1 - nx, y1 - ny)), r5((x0 - nx, y0 - ny))])
    return out


def _prim_json(g) -> list[dict]:
    """Contract: {"type": "poly", "pts": [[x, y], ...]} in pad-local mm (unrotated, relative to pad 'at').

    Also keeps the original description ("kind", "width", "filled" and circle/arc params) for reference.
    """
    src = {"kind": g.get("kind"), "width": g.get("width", 0), "filled": bool(g.get("filled"))}
    if "center" in g:
        src.update(kind="circle", center=list(g["center"]), radius=g["r"])
    elif "arc" in g:
        src.update(kind="arc", start=list(g["arc"][0]), mid=list(g["arc"][1]), end=list(g["arc"][2]))
    return [dict(type="poly", pts=poly, source=src) for poly in _prim_polys(g)]
