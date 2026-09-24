"""Schematic symbol (.kicad_sym) model, statistics and pure-Python SVG rendering.

Symbol library coordinates are y-up (mm); everything is flipped to SVG's y-down here.
"""

from __future__ import annotations

import math
import re

from geom import BBox, arc_mid_from_center, arc_path, arc_points, f, text_el, text_extent
from sexpr import Node

# KiCad default schematic colours
C_BODY = "#840000"
C_BODY_BG = "#FFFFC2"
C_PIN = "#840000"
C_PIN_NAME = "#006464"
C_PIN_NUM = "#A90000"
C_TEXT = "#000084"
C_FIELD = "#006464"
C_REF = "#006464"
C_HIDDEN = "#949494"
BACKGROUND = "#F5F4EF"

PIN_TYPES = {
    "input", "output", "bidirectional", "tri_state", "passive", "free", "unspecified",
    "power_in", "power_out", "open_collector", "open_emitter", "no_connect",
}


def _xy(node, default=(0.0, 0.0)):
    if node is None:
        return default
    v = node.nums()
    return (v[0], v[1]) if len(v) >= 2 else default


def _at(node):
    at = node.child("at")
    if at is None:
        return 0.0, 0.0, 0.0
    v = at.nums() + [0, 0, 0]
    return v[0], v[1], v[2]


def _hidden(node: Node) -> bool:
    if node.flag("hide"):
        return True
    eff = node.child("effects")
    return bool(eff is not None and eff.flag("hide"))


def _font(node: Node):
    eff = node.child("effects")
    size = (1.27, 1.27)
    justify = []
    bold = italic = False
    if eff is not None:
        fn = eff.child("font")
        if fn is not None:
            s = fn.nums("size") or [1.27, 1.27]
            size = (s[0], s[1] if len(s) > 1 else s[0])
            bold, italic = fn.flag("bold"), fn.flag("italic")
        j = eff.child("justify")
        if j is not None:
            justify = [str(a) for a in j.atoms()]
    return size, justify, bold


def sub_unit(name: str, parent: str):
    """Parse 'PARENT_U_B' -> (unit, body_style)."""
    m = re.match(re.escape(parent) + r"_(\d+)_(\d+)$", name)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.match(r".*_(\d+)_(\d+)$", name)
    if m:
        return int(m.group(1)), int(m.group(2))
    return 0, 0


class Symbol:
    def __init__(self, node: Node, library: dict[str, Node] | None = None):
        self.node = node
        self.name = str(node.arg(0, ""))
        self.extends = node.value("extends")
        self.properties: dict[str, str] = {}
        self.fields = []  # property dicts incl. position
        pn = node.child("pin_names")
        self.pin_name_offset = pn.num("offset", 0.508) if pn is not None else 0.508
        self.pin_names_hidden = bool(pn is not None and pn.flag("hide"))
        pnum = node.child("pin_numbers")
        self.pin_numbers_hidden = bool(pnum is not None and pnum.flag("hide"))
        self.power = node.child("power") is not None
        self.unit_names: dict[int, str] = {}
        for p in node.children("property"):
            key, val = str(p.arg(0, "")), str(p.arg(1, ""))
            self.properties[key] = val
            x, y, a = _at(p)
            size, justify, bold = _font(p)
            self.fields.append(dict(key=key, value=val, x=x, y=y, angle=a, size=size, justify=justify,
                                    hidden=_hidden(p) or key.startswith("ki_"), bold=bold))
        # graphics source: parent symbol for derived ('extends') symbols
        gsrc = node
        if self.extends and library and self.extends in library:
            gsrc = library[self.extends]
            parent = Symbol(gsrc)
            for k, v in parent.properties.items():
                self.properties.setdefault(k, v)
            if not any(fl["key"] in ("Reference", "Value") for fl in self.fields):
                self.fields = parent.fields
            self.pin_name_offset = parent.pin_name_offset
            self.pin_names_hidden = parent.pin_names_hidden
            self.pin_numbers_hidden = parent.pin_numbers_hidden
        self.gname = str(gsrc.arg(0, ""))
        self.shapes = []  # dicts with unit, body
        self.pins = []
        self._collect(gsrc, 0, 1)
        for sub in gsrc.children("symbol"):
            u, b = sub_unit(str(sub.arg(0, "")), self.gname)
            un = sub.value("unit_name")
            if un:
                self.unit_names[u] = str(un)
            self._collect(sub, u, b)

    # ------------------------------------------------------------------
    def _collect(self, node: Node, unit: int, body: int):
        for c in node.children():
            n = c.name
            if n == "pin":
                self.pins.append(self._pin(c, unit, body))
            elif n in ("rectangle", "circle", "arc", "polyline", "bezier", "text", "text_box"):
                s = self._shape(c)
                if s:
                    s["unit"], s["body"] = unit, body
                    self.shapes.append(s)

    def _shape(self, c: Node):
        st = c.child("stroke")
        width = st.num("width", 0) if st is not None else 0
        fill = c.child("fill")
        ftype = str(fill.value("type", "none")) if fill is not None else "none"
        fcolor = None
        if fill is not None and fill.child("color") is not None:
            v = fill.child("color").nums()
            if len(v) >= 3:
                fcolor = f"rgb({int(v[0])},{int(v[1])},{int(v[2])})"
        s = dict(kind=c.name, width=width, fill=ftype, fill_color=fcolor)
        if c.name == "rectangle":
            s["start"], s["end"] = _xy(c.child("start")), _xy(c.child("end"))
        elif c.name == "circle":
            s["center"], s["r"] = _xy(c.child("center")), c.num("radius", 0)
        elif c.name == "arc":
            if c.child("mid") is not None:
                s["arc"] = (_xy(c.child("start")), _xy(c.child("mid")), _xy(c.child("end")))
            else:
                rad = c.child("radius")
                if rad is not None:
                    ang = rad.nums("angles") or [0, 90]
                    s["arc"] = arc_mid_from_center(_xy(rad.child("at")), _xy(c.child("start")), ang[1] - ang[0])
                else:
                    return None
        elif c.name in ("polyline", "bezier"):
            s["pts"] = [tuple(p.nums()[:2]) for p in (c.child("pts") or Node()).children("xy")]
        elif c.name in ("text", "text_box"):
            s["text"] = str(c.arg(0, ""))
            x, y, a = _at(c)
            s.update(x=x, y=y, angle=a)
            s["size"], s["justify"], s["bold"] = _font(c)
            s["hidden"] = _hidden(c)
            if c.name == "text_box":
                s["box_size"] = c.nums("size") or [0, 0]
        return s

    def _pin(self, c: Node, unit: int, body: int):
        x, y, a = _at(c)
        name = c.child("name")
        number = c.child("number")
        alts = [str(al.arg(0, "")) for al in c.children("alternate")]
        return dict(
            type=str(c.arg(0, "")), shape=str(c.arg(1, "line")),
            x=x, y=y, angle=a, length=c.num("length", 2.54),
            name=str(name.arg(0, "")) if name is not None else "",
            number=str(number.arg(0, "")) if number is not None else "",
            name_size=_font(name)[0] if name is not None else (1.27, 1.27),
            num_size=_font(number)[0] if number is not None else (1.27, 1.27),
            hidden=c.flag("hide"), unit=unit, body=body, alternates=alts, line=c.line_start,
        )

    # ------------------------------------------------------------------
    @property
    def unit_count(self) -> int:
        units = {s["unit"] for s in self.shapes} | {p["unit"] for p in self.pins}
        units.discard(0)
        return max(units) if units else 1

    def has_demorgan(self) -> bool:
        return any(s["body"] == 2 for s in self.shapes) or any(p["body"] == 2 for p in self.pins)

    def stats(self) -> dict:
        pins = [p for p in self.pins if p["body"] in (0, 1)]
        numbers = [p["number"] for p in pins]
        dup = sorted({n for n in numbers if numbers.count(n) > 1})
        by_type: dict[str, int] = {}
        for p in pins:
            by_type[p["type"]] = by_type.get(p["type"], 0) + 1
        return {
            "pin_count": len(pins),
            "unique_pin_numbers": len(set(numbers)),
            "duplicate_pin_numbers": dup,
            "units": self.unit_count,
            "unit_names": {str(k): v for k, v in self.unit_names.items()},
            "has_demorgan": self.has_demorgan(),
            "power_symbol": self.power,
            "extends": self.extends,
            "pin_types": by_type,
            "hidden_pins": sum(1 for p in pins if p["hidden"]),
            "pins": [{"number": p["number"], "name": p["name"], "type": p["type"], "shape": p["shape"],
                      "unit": p["unit"], "hidden": p["hidden"], "pos": [p["x"], p["y"]], "angle": p["angle"],
                      "length": p["length"], "alternates": p["alternates"]}
                     for p in sorted(pins, key=lambda p: (p["unit"], _natkey(p["number"])))],
            "pin_names_hidden": self.pin_names_hidden,
            "pin_numbers_hidden": self.pin_numbers_hidden,
        }


def _natkey(s: str):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", s)]


def parse_library(root: Node) -> dict[str, Node]:
    return {str(s.arg(0, "")): s for s in root.children("symbol")}


# ---------------------------------------------------------------------------
# rendering (per unit, symbol coordinates; y flipped on output)
# ---------------------------------------------------------------------------

def _fill_attr(s):
    if s["fill"] == "background":
        return C_BODY_BG
    if s["fill"] == "outline":
        return C_BODY
    if s["fill"] == "color" and s["fill_color"]:
        return s["fill_color"]
    return "none"


def _sw(w):
    return f(w if w and w > 0 else 0.1524)


def _unit_elements(sym: Symbol, unit: int, bb: BBox) -> list[str]:
    els = []
    shapes = [s for s in sym.shapes if s["unit"] in (0, unit) and s["body"] in (0, 1)]
    pins = [p for p in sym.pins if p["unit"] in (0, unit) and p["body"] in (0, 1)]
    # filled backgrounds first, like KiCad
    shapes.sort(key=lambda s: 0 if s["fill"] == "background" else 1)
    for s in shapes:
        k = s["kind"]
        fill = _fill_attr(s)
        st = f'stroke="{C_BODY}" stroke-width="{_sw(s["width"])}" stroke-linecap="round" stroke-linejoin="round"'
        w = (s["width"] or 0.15) / 2
        if k == "rectangle":
            (x0, y0), (x1, y1) = s["start"], s["end"]
            y0, y1 = -y0, -y1
            els.append(f'<rect x="{f(min(x0, x1))}" y="{f(min(y0, y1))}" width="{f(abs(x1 - x0))}" '
                       f'height="{f(abs(y1 - y0))}" fill="{fill}" {st}/>')
            bb.add(x0, y0, w)
            bb.add(x1, y1, w)
        elif k == "circle":
            cx, cy = s["center"]
            els.append(f'<circle cx="{f(cx)}" cy="{f(-cy)}" r="{f(s["r"])}" fill="{fill}" {st}/>')
            bb.add(cx - s["r"], -cy - s["r"], w)
            bb.add(cx + s["r"], -cy + s["r"], w)
        elif k == "arc":
            a, m, e = [(p[0], -p[1]) for p in s["arc"]]
            d = arc_path(a, m, e)
            if fill != "none":
                els.append(f'<path d="{d}Z" fill="{fill}" stroke="none"/>')
            els.append(f'<path d="{d}" fill="none" {st}/>')
            for p in arc_points(a, m, e):
                bb.add(p[0], p[1], w)
        elif k in ("polyline", "bezier"):
            pts = [(x, -y) for x, y in s["pts"]]
            if not pts:
                continue
            if k == "bezier" and len(pts) == 4:
                d = (f"M{f(pts[0][0])} {f(pts[0][1])}C" + " ".join(f"{f(x)} {f(y)}" for x, y in pts[1:]))
            else:
                d = "M" + "L".join(f"{f(x)} {f(y)}" for x, y in pts)
            if fill != "none":
                d += "Z"
            els.append(f'<path d="{d}" fill="{fill}" {st}/>')
            for x, y in pts:
                bb.add(x, y, w)
        elif k in ("text", "text_box"):
            if s["hidden"]:
                continue
            h, wd = s["size"]
            ang = s["angle"] / 10 if abs(s["angle"]) > 360 else s["angle"]
            j = s["justify"]
            anchor = "start" if "left" in j else "end" if "right" in j else "middle"
            valign = "top" if "top" in j else "bottom" if "bottom" in j else "center"
            x, y = s["x"], -s["y"]
            if k == "text_box":
                bw, bh = (s["box_size"] + [0, 0])[:2]
                els.append(f'<rect x="{f(x)}" y="{f(y)}" width="{f(bw)}" height="{f(bh)}" fill="{fill}" {st}/>')
                bb.add(x, y)
                bb.add(x + bw, y + bh)
                anchor, valign = "start", "top"
                x += 0.5
                y += 0.5
            els.append(text_el(s["text"], x, y, h, wd, ang, C_TEXT, anchor, valign, bold=s["bold"]))
            text_extent(s["text"], x, y, h, wd, ang, anchor, valign, bb)
    for p in pins:
        els += _pin_elements(sym, p, bb)
    return els


def _pin_elements(sym: Symbol, p, bb: BBox) -> list[str]:
    if p["hidden"]:
        return []
    x, y = p["x"], -p["y"]
    a = math.radians(p["angle"])
    dx, dy = math.cos(a), -math.sin(a)   # screen direction from connection point to body
    L = p["length"]
    ex, ey = x + dx * L, y + dy * L
    els = []
    shape = p["shape"]
    line_start = (x, y)
    line_end = (ex, ey)
    if shape in ("inverted", "inverted_clock"):
        # bubble sits against the body
        r = 0.3175 * 2
        cxb, cyb = ex - dx * r, ey - dy * r
        els.append(f'<circle cx="{f(cxb)}" cy="{f(cyb)}" r="{f(r)}" fill="none" stroke="{C_PIN}" stroke-width="0.1524"/>')
        line_end = (ex - dx * 2 * r, ey - dy * 2 * r)
    els.append(f'<path d="M{f(line_start[0])} {f(line_start[1])}L{f(line_end[0])} {f(line_end[1])}" '
               f'stroke="{C_PIN}" stroke-width="0.1524" stroke-linecap="round"/>')
    if shape in ("clock", "inverted_clock", "clock_low", "edge_clock_high"):
        s = 0.635
        nx, ny = -dy, dx
        pts = [(ex + nx * s, ey + ny * s), (ex + dx * s, ey + dy * s), (ex - nx * s, ey - ny * s)]
        els.append('<path d="M' + "L".join(f"{f(px)} {f(py)}" for px, py in pts) +
                   f'" fill="none" stroke="{C_PIN}" stroke-width="0.1524"/>')
    if shape in ("input_low", "clock_low", "output_low"):
        s = 1.27
        nx, ny = -dy, dx
        pts = [(ex, ey), (ex - dx * s, ey - dy * s), (ex - dx * s + nx * s * 0.5, ey - dy * s + ny * s * 0.5)]
        els.append('<path d="M' + "L".join(f"{f(px)} {f(py)}" for px, py in pts) +
                   f'" fill="none" stroke="{C_PIN}" stroke-width="0.1524"/>')
    if p["type"] == "no_connect" or shape == "non_logic":
        s = 0.4
        els.append(f'<path d="M{f(x - s)} {f(y - s)}L{f(x + s)} {f(y + s)}M{f(x + s)} {f(y - s)}L{f(x - s)} {f(y + s)}" '
                   f'stroke="{C_PIN}" stroke-width="0.1524"/>')
    # connection point marker (small circle like KiCad's pin end)
    els.append(f'<circle cx="{f(x)}" cy="{f(y)}" r="0.25" fill="none" stroke="{C_PIN}" stroke-width="0.05" opacity="0.6"/>')
    bb.add(x, y, 0.3)
    bb.add(ex, ey)
    horizontal = abs(dx) > 0.5
    angle = 0 if horizontal else 90
    off = sym.pin_name_offset
    name = p["name"] if p["name"] not in ("~", "") else ""
    name_h = p["name_size"][0]
    num_h = p["num_size"][0]
    # Names: inside the body when offset > 0, else above the pin line (and numbers below)
    if name and not sym.pin_names_hidden:
        disp = _overbar(name)
        if off > 0:
            nx, ny = ex + dx * off, ey + dy * off
            if horizontal:
                anchor = "start" if dx > 0 else "end"
            else:
                # rotated 90 (text reads bottom->top); "start" is towards the top of the screen
                anchor = "start" if dy < 0 else "end"
            els.append(text_el(disp, nx, ny, name_h, p["name_size"][1], angle, C_PIN_NAME, anchor, "center"))
            text_extent(disp, nx, ny, name_h, p["name_size"][1], angle, anchor, "center", bb)
        else:
            mx, my = (x + ex) / 2, (y + ey) / 2
            if horizontal:
                els.append(text_el(disp, mx, my - 0.3, name_h, p["name_size"][1], 0, C_PIN_NAME, "middle", "bottom"))
                text_extent(disp, mx, my - 0.3, name_h, p["name_size"][1], 0, "middle", "bottom", bb)
            else:
                els.append(text_el(disp, mx - 0.3, my, name_h, p["name_size"][1], 90, C_PIN_NAME, "middle", "bottom"))
                text_extent(disp, mx - 0.3, my, name_h, p["name_size"][1], 90, "middle", "bottom", bb)
    if p["number"] and not sym.pin_numbers_hidden:
        mx, my = (x + ex) / 2, (y + ey) / 2
        below = off == 0 and name and not sym.pin_names_hidden
        if horizontal:
            ny = my + 0.3 if below else my - 0.3
            va = "top" if below else "bottom"
            els.append(text_el(p["number"], mx, ny, num_h, p["num_size"][1], 0, C_PIN_NUM, "middle", va))
            text_extent(p["number"], mx, ny, num_h, p["num_size"][1], 0, "middle", va, bb)
        else:
            nx = mx + 0.3 if below else mx - 0.3
            va = "top" if below else "bottom"
            els.append(text_el(p["number"], nx, my, num_h, p["num_size"][1], 90, C_PIN_NUM, "middle", va))
            text_extent(p["number"], nx, my, num_h, p["num_size"][1], 90, "middle", va, bb)
    return els


def _overbar(name: str) -> str:
    # ~{RESET} -> RESET with a combining overline (U+0305) on each char; cheap but readable
    return re.sub(r"~\{([^}]*)\}", lambda m: "".join(ch + "̅" for ch in m.group(1)), name)


def _field_elements(sym: Symbol, bb: BBox) -> list[str]:
    els = []
    for fl in sym.fields:
        if fl["hidden"] or fl["key"] not in ("Reference", "Value") and fl["hidden"]:
            continue
        if not fl["value"]:
            continue
        h, w = fl["size"]
        j = fl["justify"]
        anchor = "start" if "left" in j else "end" if "right" in j else "middle"
        valign = "top" if "top" in j else "bottom" if "bottom" in j else "center"
        ang = fl["angle"] / 10 if abs(fl["angle"]) > 360 else fl["angle"]
        x, y = fl["x"], -fl["y"]
        txt = fl["value"]
        if fl["key"] == "Reference":
            txt = txt + ("?" if not txt.endswith("?") else "")
        color = C_REF if fl["key"] == "Reference" else C_FIELD
        els.append(text_el(txt, x, y, h, w, ang, color, anchor, valign, bold=fl["bold"]))
        text_extent(txt, x, y, h, w, ang, anchor, valign, bb)
    return els


def unit_layout(sym: Symbol):
    """Per-unit (elements, bbox) — bbox in screen coords relative to the symbol origin."""
    out = {}
    for u in range(1, sym.unit_count + 1):
        bb = BBox()
        els = _unit_elements(sym, u, bb)
        if u == 1:
            els += _field_elements(sym, bb)
        out[u] = (els, bb)
    return out


def shared_layout(layouts: list[dict]):
    """Compute unit slot positions shared by base/head so both renders overlay.

    Returns ({unit: x_offset}, viewbox).
    """
    units = sorted({u for lay in layouts if lay for u in lay})
    slots = {}
    x = 0.0
    gap = 5.08
    vb_y0, vb_y1 = math.inf, -math.inf
    for i, u in enumerate(units):
        ub = BBox()
        for lay in layouts:
            if lay and u in lay:
                ub.add_box(lay[u][1])
        if not ub.valid:
            ub.add(-2.54, -2.54)
            ub.add(2.54, 2.54)
        off = x - ub.x0 if i else 0.0
        slots[u] = off
        vb_y0, vb_y1 = min(vb_y0, ub.y0), max(vb_y1, ub.y1)
        x = off + ub.x1 + gap
        if i == 0:
            vb_x0 = ub.x0
    vb_x1 = x - gap
    m = max(1.27, max(vb_x1 - vb_x0, vb_y1 - vb_y0) * 0.05)
    return slots, (vb_x0 - m, vb_y0 - m, vb_x1 + m, vb_y1 + m)


def render_symbol(layout: dict, slots: dict, vb, px_per_mm: float, sym: Symbol) -> str:
    parts = []
    for u, (els, _) in layout.items():
        off = slots.get(u, 0.0)
        label = ""
        if len(slots) > 1:
            uname = sym.unit_names.get(u) or f"Unit {chr(64 + u) if u <= 26 else u}"
            label = text_el(uname, 0, vb[1] + 1.2, 1.0, 1.0, 0, "#666666", "middle", "center")
        parts.append(f'<g transform="translate({f(off)} 0)" class="unit" data-unit="{u}">{label}{"".join(els)}</g>')
    x0, y0, x1, y1 = vb
    w, h = x1 - x0, y1 - y0
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{f(x0)} {f(y0)} {f(w)} {f(h)}" '
            f'width="{f(w * px_per_mm)}" height="{f(h * px_per_mm)}">'
            f'<rect x="{f(x0)}" y="{f(y0)}" width="{f(w)}" height="{f(h)}" fill="{BACKGROUND}"/>'
            + "".join(parts) + "</svg>")
