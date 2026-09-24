"""Small geometry + SVG helpers shared by the footprint and symbol renderers."""

from __future__ import annotations

import math
from html import escape


def f(v: float) -> str:
    """Compact float formatting for SVG output."""
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def rot(x: float, y: float, deg: float) -> tuple[float, float]:
    """Rotate a point by ``deg`` as KiCad does on screen (y down, positive = CCW)."""
    if not deg:
        return x, y
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return x * c + y * s, -x * s + y * c


def circle_from_3(p1, p2, p3):
    """Centre and radius of the circle through three points (None if collinear)."""
    (ax, ay), (bx, by), (cx, cy) = p1, p2, p3
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-12:
        return None
    ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
    uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
    return (ux, uy), math.hypot(ax - ux, ay - uy)


def arc_path(start, mid, end) -> str:
    """SVG path for an arc through start/mid/end (screen coordinates)."""
    c = circle_from_3(start, mid, end)
    if c is None:
        return f"M{f(start[0])} {f(start[1])}L{f(end[0])} {f(end[1])}"
    (cx, cy), r = c
    # sweep: sign of cross product (start->mid) x (mid->end)
    cross = (mid[0] - start[0]) * (end[1] - mid[1]) - (mid[1] - start[1]) * (end[0] - mid[0])
    sweep = 1 if cross > 0 else 0
    a0 = math.atan2(start[1] - cy, start[0] - cx)
    a1 = math.atan2(end[1] - cy, end[0] - cx)
    span = (a1 - a0) % (2 * math.pi)
    if not sweep:
        span = 2 * math.pi - span
    large = 1 if span > math.pi else 0
    return f"M{f(start[0])} {f(start[1])}A{f(r)} {f(r)} 0 {large} {sweep} {f(end[0])} {f(end[1])}"


def arc_points(start, mid, end, n: int = 24):
    """Polyline approximation of a 3-point arc (for bounding boxes / 3D)."""
    c = circle_from_3(start, mid, end)
    if c is None:
        return [start, end]
    (cx, cy), r = c
    a0 = math.atan2(start[1] - cy, start[0] - cx)
    am = math.atan2(mid[1] - cy, mid[0] - cx)
    a1 = math.atan2(end[1] - cy, end[0] - cx)
    ccw = (am - a0) % (2 * math.pi) < (a1 - a0) % (2 * math.pi)
    span = (a1 - a0) % (2 * math.pi) if ccw else -((a0 - a1) % (2 * math.pi))
    return [(cx + r * math.cos(a0 + span * i / n), cy + r * math.sin(a0 + span * i / n)) for i in range(n + 1)]


def arc_mid_from_center(center, start, angle_deg):
    """Old-format arcs are centre + start + angle; return (start, mid, end)."""
    cx, cy = center
    sx, sy = start
    r = math.hypot(sx - cx, sy - cy)
    a0 = math.atan2(sy - cy, sx - cx)
    a = math.radians(angle_deg)
    mid = (cx + r * math.cos(a0 + a / 2), cy + r * math.sin(a0 + a / 2))
    end = (cx + r * math.cos(a0 + a), cy + r * math.sin(a0 + a))
    return (sx, sy), mid, end


class BBox:
    def __init__(self):
        self.x0 = self.y0 = math.inf
        self.x1 = self.y1 = -math.inf

    def add(self, x, y, pad: float = 0.0):
        self.x0 = min(self.x0, x - pad)
        self.y0 = min(self.y0, y - pad)
        self.x1 = max(self.x1, x + pad)
        self.y1 = max(self.y1, y + pad)

    def add_box(self, other: "BBox"):
        if other.valid:
            self.add(other.x0, other.y0)
            self.add(other.x1, other.y1)

    @property
    def valid(self):
        return self.x0 <= self.x1 and self.y0 <= self.y1

    def as_list(self):
        return [round(self.x0, 4), round(self.y0, 4), round(self.x1, 4), round(self.y1, 4)] if self.valid else None


def text_el(txt: str, x: float, y: float, size_h: float, size_w: float, angle: float, color: str,
            anchor: str = "middle", valign: str = "center", mirror: bool = False, bold: bool = False,
            family: str = "DejaVu Sans, Arial, sans-serif", extra: str = "") -> str:
    """SVG <text> positioned the way KiCad justifies text.

    KiCad sizes are glyph heights; DejaVu cap height is ~0.73 em, so scale the font size up.
    Baseline offsets are computed by hand (renderers disagree on dominant-baseline).
    """
    fs = size_h / 0.73
    lines = txt.split("\n")
    line_h = size_h * 1.6
    total = line_h * (len(lines) - 1)
    if valign == "center":
        y0 = size_h / 2 - total / 2
    elif valign == "top":
        y0 = size_h
    else:  # bottom
        y0 = -total
    scale_x = size_w / size_h if size_h else 1.0
    tr = f"translate({f(x)} {f(y)})"
    if angle:
        tr += f" rotate({f(-angle)})"
    if mirror:
        tr += " scale(-1 1)"
    if abs(scale_x - 1) > 0.05:
        tr += f" scale({f(scale_x)} 1)"
    spans = "".join(
        f'<tspan x="0" y="{f(y0 + i * line_h)}">{escape(l)}</tspan>' for i, l in enumerate(lines)
    )
    weight = ' font-weight="bold"' if bold else ""
    return (f'<text transform="{tr}" font-family="{family}" font-size="{f(fs)}" fill="{color}" '
            f'text-anchor="{anchor}"{weight}{extra}>{spans}</text>')


def text_extent(txt: str, x, y, size_h, size_w, angle, anchor, valign, bbox: BBox):
    """Approximate bbox contribution of a text element."""
    lines = txt.split("\n") or [""]
    w = max(len(l) for l in lines) * size_w * 1.0  # DejaVu ~0.6-0.7 em per glyph at font-size h/0.73: slack so nothing clips
    h = size_h * 1.6 * len(lines)
    dx0 = {"start": 0, "middle": -w / 2, "end": -w}[anchor]
    dy0 = {"center": -h / 2, "top": 0, "bottom": -h}[valign]
    for cx, cy in ((dx0, dy0), (dx0 + w, dy0), (dx0, dy0 + h), (dx0 + w, dy0 + h)):
        rx, ry = rot(cx, cy, angle)
        bbox.add(x + rx, y + ry)
