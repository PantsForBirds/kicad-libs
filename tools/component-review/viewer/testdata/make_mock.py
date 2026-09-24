#!/usr/bin/env python3
"""Build a hand-made mock OUT directory for developing/testing the viewer.

This is NOT the render engine (that lives in tools/component-review/render/). It is a
small, approximate stand-in that follows CONTRACT.md closely enough to exercise every
viewer feature: added / modified / deleted footprints, a symbol, per-layer SVGs that
share one viewBox, PNGs, diff.png, geom.json + STEP copies for the 3D view (CONTRACT Addendum 2),
unified diffs and a review.json.

"Modified" base versions are synthesised by editing the head text (the demo PR only
adds files), so the diffs are fake but structurally realistic.

Usage:  python3 make_mock.py --repo <kicad-libs checkout> --out testdata/mock-out
Needs Pillow (for PNGs); everything else is stdlib.
"""
import argparse
import difflib
import json
import math
import os
import re
import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

# ----------------------------------------------------------------------------- s-expr


def parse_sexpr(text):
    tokens = re.findall(r'\(|\)|"(?:[^"\\]|\\.)*"|[^\s()"]+', text)
    stack = [[]]
    for t in tokens:
        if t == "(":
            stack.append([])
        elif t == ")":
            node = stack.pop()
            stack[-1].append(node)
        elif t.startswith('"'):
            stack[-1].append(bytes(t[1:-1], "utf-8").decode("unicode_escape"))
        else:
            stack[-1].append(t)
    return stack[0][0]


def kids(node, name):
    return [c for c in node[1:] if isinstance(c, list) and c and c[0] == name]


def kid(node, name):
    k = kids(node, name)
    return k[0] if k else None


def nums(node):
    return [float(x) for x in node[1:] if isinstance(x, str) and re.fullmatch(r"-?[\d.]+(e-?\d+)?", x)]


# ----------------------------------------------------------------------------- geometry
# Every primitive becomes one of:
#   ("poly", layer, [(x,y),...], width, filled)   closed if filled, else open polyline
#   ("circle", layer, cx, cy, r, width, filled)
#   ("text", layer, x, y, size, string)


def rot(px, py, deg):
    a = math.radians(deg)
    return px * math.cos(a) + py * math.sin(a), -px * math.sin(a) + py * math.cos(a)


def arc_points(s, m, e, n=24):
    (x1, y1), (x2, y2), (x3, y3) = s, m, e
    d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2))
    if abs(d) < 1e-9:
        return [s, e]
    ux = ((x1**2 + y1**2) * (y2 - y3) + (x2**2 + y2**2) * (y3 - y1) + (x3**2 + y3**2) * (y1 - y2)) / d
    uy = ((x1**2 + y1**2) * (x3 - x2) + (x2**2 + y2**2) * (x1 - x3) + (x3**2 + y3**2) * (x2 - x1)) / d
    r = math.hypot(x1 - ux, y1 - uy)
    a1, a2, a3 = (math.atan2(p[1] - uy, p[0] - ux) for p in (s, m, e))

    def ccw_between(a, b, c):  # is b on the ccw sweep from a to c
        return (b - a) % (2 * math.pi) < (c - a) % (2 * math.pi)

    sweep = (a3 - a1) % (2 * math.pi)
    if not ccw_between(a1, a2, a3):
        sweep -= 2 * math.pi
    return [(ux + r * math.cos(a1 + sweep * i / n), uy + r * math.sin(a1 + sweep * i / n)) for i in range(n + 1)]


def expand_layers(layers):
    out = []
    for l in layers:
        if l.startswith("*."):
            out += ["F." + l[2:], "B." + l[2:]]
        else:
            out.append(l)
    return out


def stroke_width(node, default=0.1):
    st = kid(node, "stroke")
    w = kid(st, "width") if st else kid(node, "width")
    return nums(w)[0] if w else default


def filled(node):
    f = kid(node, "fill")
    if not f or len(f) < 2:
        return False
    v = f[1] if isinstance(f[1], str) else (f[1][1] if len(f[1]) > 1 else "no")
    return v in ("yes", "solid", "outline", "background")


def pad_outline(shape, w, h, rratio=0.25):
    if shape in ("circle",):
        return None
    if shape in ("oval",):
        r = min(w, h) / 2
    elif shape == "roundrect":
        r = min(w, h) * rratio
    else:
        r = 0
    pts = []
    if r <= 0:
        return [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]
    for cx, cy, a0 in ((w / 2 - r, -h / 2 + r, -90), (w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90), (-w / 2 + r, -h / 2 + r, 180)):
        for i in range(7):
            a = math.radians(a0 + 90 * i / 6)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def footprint_prims(fp):
    prims = []
    for tag in ("fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly"):
        for n in kids(fp, tag):
            layer = kid(n, "layer")[1]
            w = stroke_width(n)
            if tag == "fp_line":
                s, e = nums(kid(n, "start")), nums(kid(n, "end"))
                prims.append(("poly", layer, [tuple(s), tuple(e)], w, False))
            elif tag == "fp_rect":
                (x1, y1), (x2, y2) = nums(kid(n, "start")), nums(kid(n, "end"))
                prims.append(("poly", layer, [(x1, y1), (x2, y1), (x2, y2), (x1, y2), (x1, y1)], w, filled(n)))
            elif tag == "fp_circle":
                c, e = nums(kid(n, "center")), nums(kid(n, "end"))
                prims.append(("circle", layer, c[0], c[1], math.hypot(e[0] - c[0], e[1] - c[1]), w, filled(n)))
            elif tag == "fp_arc":
                pts = arc_points(*(tuple(nums(kid(n, k))) for k in ("start", "mid", "end")))
                prims.append(("poly", layer, pts, w, False))
            elif tag == "fp_poly":
                pts = [tuple(nums(xy)) for xy in kids(kid(n, "pts"), "xy")]
                prims.append(("poly", layer, pts + [pts[0]], w, filled(n)))
    for tag in ("property", "fp_text"):
        for n in kids(fp, tag):
            if kid(n, "hide") and kid(n, "hide")[1] == "yes":
                continue
            at, layer = kid(n, "at"), kid(n, "layer")
            if not at or not layer:
                continue
            txt = n[2] if tag == "property" else n[2]
            txt = txt.replace("${REFERENCE}", "REF**")
            eff = kid(n, "effects")
            size = 1.0
            if eff and kid(eff, "font") and kid(kid(eff, "font"), "size"):
                size = nums(kid(kid(eff, "font"), "size"))[0]
            x, y = nums(at)[:2]
            prims.append(("text", layer[1], x, y, size, txt))
    pads = []
    for p in kids(fp, "pad"):
        number, ptype, shape = p[1], p[2], p[3]
        at = nums(kid(p, "at"))
        x, y, r = at[0], at[1], (at[2] if len(at) > 2 else 0)
        w, h = nums(kid(p, "size"))
        layers = expand_layers(kid(p, "layers")[1:])
        rr = kid(p, "roundrect_rratio")
        drill = kid(p, "drill")
        dnums = nums(drill) if drill else []
        pads.append({"number": number, "type": ptype, "shape": shape, "at": [x, y, r], "size": [w, h],
                     "drill": (dnums[0] if dnums else None), "layers": layers})
        outlines = []
        if shape == "custom":
            prim = kid(p, "primitives")
            for gp in kids(prim, "gr_poly") if prim else []:
                outlines.append([tuple(nums(xy)) for xy in kids(kid(gp, "pts"), "xy")])
            outlines.append(pad_outline("rect", w, h))
        elif shape != "circle":
            outlines.append(pad_outline(shape, w, h, nums(rr)[0] if rr else 0.25))
        for layer in layers:
            if not (layer.endswith(".Cu") or layer.endswith(".Mask") or layer.endswith(".Paste")):
                continue
            grow = 0.05 if layer.endswith(".Mask") else (-0.05 if layer.endswith(".Paste") else 0)
            if layer.endswith(".Paste") and ptype in ("thru_hole", "np_thru_hole"):
                continue
            if shape == "circle":
                prims.append(("circle", layer, x, y, w / 2 + grow, 0, True))
            else:
                for ol in outlines:
                    pts = []
                    for (px, py) in ol:
                        sx = px + math.copysign(grow, px) if px else px
                        sy = py + math.copysign(grow, py) if py else py
                        rx, ry = rot(sx, sy, r)
                        pts.append((x + rx, y + ry))
                    prims.append(("poly", layer, pts + [pts[0]], 0, True))
        if dnums:
            prims.append(("circle", "Drill", x, y, dnums[0] / 2, 0, True))
    return prims, pads


def symbol_prims(sym):
    """KiCad symbol coordinates are y-up; flip to y-down so SVG and PNG agree."""
    prims, pins = [], []
    for unit in kids(sym, "symbol"):
        for n in kids(unit, "rectangle"):
            (x1, y1), (x2, y2) = nums(kid(n, "start")), nums(kid(n, "end"))
            pts = [(x1, -y1), (x2, -y1), (x2, -y2), (x1, -y2), (x1, -y1)]
            if filled(n):
                prims.append(("poly", "BodyFill", pts, 0, True))
            prims.append(("poly", "Body", pts, stroke_width(n, 0.254), False))
        for n in kids(unit, "polyline"):
            pts = [(a, -b) for a, b in (nums(xy) for xy in kids(kid(n, "pts"), "xy"))]
            prims.append(("poly", "Body", pts, stroke_width(n, 0.254), filled(n)))
        for n in kids(unit, "circle"):
            c = nums(kid(n, "center"))
            prims.append(("circle", "Body", c[0], -c[1], nums(kid(n, "radius"))[0], stroke_width(n, 0.254), filled(n)))
        for n in kids(unit, "pin"):
            at = nums(kid(n, "at"))
            ln = nums(kid(n, "length"))[0]
            x, y, r = at[0], -at[1], at[2] if len(at) > 2 else 0
            dx, dy = math.cos(math.radians(r)), -math.sin(math.radians(r))
            ex, ey = x + dx * ln, y + dy * ln
            name, number = kid(n, "name")[1], kid(n, "number")[1]
            unit_no = int(unit[1].rsplit("_", 2)[-2]) if re.search(r"_\d+_\d+$", unit[1]) else 0
            pins.append({"number": number, "name": name, "type": n[1], "unit": unit_no, "at": [at[0], at[1], r], "length": ln})
            prims.append(("poly", "Pins", [(x, y), (ex, ey)], 0.254, False))
            prims.append(("text", "PinNum", (x + ex) / 2, (y + ey) / 2 - 0.4, 1.0, number))
            prims.append(("text", "PinName", ex + dx * 2.2, ey + dy * 2.2 + 0.4, 1.0, name))
    for prop in kids(sym, "property"):
        if prop[1] in ("Reference", "Value") and kid(prop, "at"):
            x, y = nums(kid(prop, "at"))[:2]
            prims.append(("text", "Fields", x, -y, 1.27, prop[2]))
    return prims, pins


def bbox(prims):
    xs, ys = [], []
    for p in prims:
        if p[0] == "poly":
            xs += [q[0] for q in p[2]]
            ys += [q[1] for q in p[2]]
        elif p[0] == "circle":
            xs += [p[2] - p[4], p[2] + p[4]]
            ys += [p[3] - p[4], p[3] + p[4]]
        else:
            xs += [p[2] - len(p[5]) * p[4] * 0.33, p[2] + len(p[5]) * p[4] * 0.33]
            ys += [p[3] - p[4], p[3] + p[4]]
    return min(xs), min(ys), max(xs), max(ys)


# ----------------------------------------------------------------------------- output

FP_COLORS = {"F.Cu": "#c83434", "B.Cu": "#4d7fc4", "F.SilkS": "#f2eda1", "B.SilkS": "#e8b2a7", "F.Fab": "#afafaf",
             "B.Fab": "#585d84", "F.CrtYd": "#ff26e2", "B.CrtYd": "#26e9ff", "F.Mask": "#d864ff", "B.Mask": "#02ffee",
             "F.Paste": "#b4a0a0", "B.Paste": "#00c2c2", "Edge.Cuts": "#d0d200", "Drill": "#dbdbdb"}
SYM_COLORS = {"BodyFill": "#ffffc2", "Body": "#840000", "Pins": "#840000", "PinNum": "#a90000", "PinName": "#006464", "Fields": "#006464"}


def svg_doc(prims, vb, colors, bg=None):
    x0, y0, x1, y1 = vb
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0:.4f} {y0:.4f} {x1 - x0:.4f} {y1 - y0:.4f}" '
           f'width="{(x1 - x0):.3f}mm" height="{(y1 - y0):.3f}mm">']
    if bg:
        out.append(f'<rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" fill="{bg}"/>')
    for p in prims:
        c = colors.get(p[1], "#888")
        if p[0] == "poly":
            pts = " ".join(f"{x:.4f},{y:.4f}" for x, y in p[2])
            if p[4]:
                out.append(f'<polygon points="{pts}" fill="{c}" stroke="{c}" stroke-width="{p[3]:.4f}"/>')
            else:
                out.append(f'<polyline points="{pts}" fill="none" stroke="{c}" stroke-width="{max(p[3], 0.02):.4f}" stroke-linecap="round"/>')
        elif p[0] == "circle":
            fill = c if p[6] else "none"
            out.append(f'<circle cx="{p[2]:.4f}" cy="{p[3]:.4f}" r="{p[4]:.4f}" fill="{fill}" stroke="{c}" stroke-width="{p[5]:.4f}"/>')
        else:
            t = p[5].replace("&", "&amp;").replace("<", "&lt;")
            out.append(f'<text x="{p[2]:.4f}" y="{p[3]:.4f}" font-size="{p[4]:.3f}" fill="{c}" text-anchor="middle" '
                       f'dominant-baseline="middle" font-family="sans-serif">{t}</text>')
    out.append("</svg>")
    return "\n".join(out)


PX_PER_MM = 40


def raster(prims, vb, colors, bg=(20, 20, 24, 255), mask=False):
    x0, y0, x1, y1 = vb
    W, H = int((x1 - x0) * PX_PER_MM), int((y1 - y0) * PX_PER_MM)
    img = Image.new("L" if mask else "RGBA", (W, H), 0 if mask else bg)
    d = ImageDraw.Draw(img)
    tx = lambda x, y: ((x - x0) * PX_PER_MM, (y - y0) * PX_PER_MM)
    for p in prims:
        col = 255 if mask else colors.get(p[1], "#888")
        if p[0] == "poly":
            pts = [tx(*q) for q in p[2]]
            if p[4]:
                d.polygon(pts, fill=col)
            else:
                d.line(pts, fill=col, width=max(1, int(p[3] * PX_PER_MM)), joint="curve")
        elif p[0] == "circle":
            cx, cy = tx(p[2], p[3])
            r = p[4] * PX_PER_MM
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col if p[6] else None, outline=col,
                      width=max(1, int(p[5] * PX_PER_MM)))
        else:
            cx, cy = tx(p[2], p[3])
            d.text((cx, cy), p[5], fill=col, anchor="mm", font_size=max(8, int(p[4] * PX_PER_MM * 0.8)))
    return img


def diff_png(base_prims, head_prims, vb, path):
    a = raster(base_prims, vb, {}, mask=True)
    b = raster(head_prims, vb, {}, mask=True)
    out = Image.new("RGBA", a.size, (0, 0, 0, 0))
    pa, pb, po = a.load(), b.load(), out.load()
    for y in range(a.size[1]):
        for x in range(a.size[0]):
            ia, ib = pa[x, y] > 0, pb[x, y] > 0
            if ia and ib:
                po[x, y] = (150, 150, 150, 120)
            elif ia:
                po[x, y] = (230, 40, 40, 255)
            elif ib:
                po[x, y] = (40, 200, 70, 255)
    out.save(path)


# ----------------------------------------------------------------------------- items

def slugify(kind, lib, name):
    return re.sub(r"[^A-Za-z0-9._-]", "_", f"{kind}__{lib}__{name}")


def fp_info(text):
    fp = parse_sexpr(text)
    prims, pads = footprint_prims(fp)
    props = {p[1]: p[2] for p in kids(fp, "property")}
    if kid(fp, "descr"):
        props.setdefault("Description", "") or props.update(Description=kid(fp, "descr")[1])
        if not props["Description"]:
            props["Description"] = kid(fp, "descr")[1]
    if kid(fp, "tags"):
        props["ki_keywords"] = kid(fp, "tags")[1]
    crt = [p for p in prims if p[1] == "F.CrtYd"]
    cb = bbox(crt) if crt else None
    attr = kid(fp, "attr")
    stats = {"pad_count": len(pads), "smd_count": sum(p["type"] == "smd" for p in pads),
             "tht_count": sum(p["type"] in ("thru_hole", "np_thru_hole") for p in pads),
             "courtyard_bbox": [round(v, 4) for v in cb] if cb else None,
             "has_fab": any(p[1] == "F.Fab" for p in prims), "has_silk_pin1": any(p[1] == "F.SilkS" and p[0] == "circle" and p[4] < 0.3 for p in prims),
             "attributes": attr[1:] if attr else [], "pads": pads}
    models = []
    for m in kids(fp, "model"):
        def xyz(tag, default):
            n = kid(m, tag)
            return nums(kid(n, "xyz")) if n and kid(n, "xyz") else default
        hide = kid(m, "hide")
        models.append({"path_raw": m[1], "offset": xyz("offset", [0, 0, 0]), "scale": xyz("scale", [1, 1, 1]),
                       "rotate": xyz("rotate", [0, 0, 0]), "hide": bool(hide and hide[1:] == ["yes"]) or "hide" in m[2:]})
    return fp, prims, props, stats, models


def sym_info(text):
    sym = parse_sexpr(text)
    prims, pins = symbol_prims(sym)
    props = {p[1]: p[2] for p in kids(sym, "property")}
    stats = {"pin_count": len(pins), "units": len({p["unit"] for p in pins if p["unit"]}) or 1, "pins": pins}
    return sym, prims, props, stats


def line_range(file_text, needle):
    lines = file_text.splitlines()
    for i, l in enumerate(lines):
        if needle in l:
            depth, j = 0, i
            while j < len(lines):
                depth += lines[j].count("(") - lines[j].count(")")
                if depth <= 0:
                    return [i + 1, j + 1]
                j += 1
    return [1, len(lines)]


def union(*bbs):
    bbs = [b for b in bbs if b]
    return (min(b[0] for b in bbs) - 1, min(b[1] for b in bbs) - 1, max(b[2] for b in bbs) + 1, max(b[3] for b in bbs) + 1)


def write_renders(out, slug, side, prims, vb, colors, layered):
    d = out / "items" / slug
    r = {"svg": f"items/{slug}/{side}.svg", "png": f"items/{slug}/{side}.png", "layers": None}
    (d / f"{side}.svg").write_text(svg_doc(prims, vb, colors))
    raster(prims, vb, colors, bg=(20, 20, 24, 255) if layered else (245, 244, 239, 255)).save(d / f"{side}.png")
    if layered:
        r["layers"] = {}
        for layer in sorted({p[1] for p in prims}):
            fn = f"{side}_{layer}.svg"
            (d / fn).write_text(svg_doc([p for p in prims if p[1] == layer], vb, colors))
            r["layers"][layer] = f"items/{slug}/{fn}"
    return r


def make_item(out, repo_root, kind, lib, name, path, status, head_text, base_text, file_head, file_base, needle):
    slug = slugify(kind, lib, name)
    d = out / "items" / slug
    d.mkdir(parents=True, exist_ok=True)
    ext = "kicad_mod" if kind == "footprint" else "kicad_sym"
    info = {}
    for side, text in (("head", head_text), ("base", base_text)):
        if text is None:
            info[side] = None
            continue
        (d / f"{side}.{ext}").write_text(text)
        info[side] = fp_info(text) if kind == "footprint" else sym_info(text)
    vb = union(*(bbox(info[s][1]) for s in ("head", "base") if info[s]))
    colors = FP_COLORS if kind == "footprint" else SYM_COLORS
    renders = {s: (write_renders(out, slug, s, info[s][1], vb, colors, kind == "footprint") if info[s] else None) for s in ("head", "base")}
    diff = None
    if info["head"] and info["base"]:
        diff_png(info["base"][1], info["head"][1], vb, d / "diff.png")
        diff = f"items/{slug}/diff.png"
    geoms = {"head": None, "base": None}
    model3d_by_side = {"head": None, "base": None}
    warnings = []
    if kind == "footprint":
        for side in ("head", "base"):
            if not info[side]:
                continue
            fpnode, prims, _, stats, models = info[side]
            geom = {"bbox": [round(v, 4) for v in vb], "pads": [],
                    "courtyard": {"F": [], "B": []}, "edge_cuts": []}
            for pad in stats["pads"]:
                g = dict(pad)
                g["drill"] = {"shape": "circle", "size": [pad["drill"], pad["drill"]], "offset": [0, 0]} if pad["drill"] else None
                geom["pads"].append(g)
            for pr in prims:
                if pr[0] == "poly" and pr[1] in ("F.CrtYd", "B.CrtYd"):
                    geom["courtyard"][pr[1][0]].append([list(q) for q in pr[2]])
            (d / f"{side}_geom.json").write_text(json.dumps(geom))
            geoms[side] = f"items/{slug}/{side}_geom.json"
            lst = []
            for n, m in enumerate(models):
                raw = m["path_raw"]
                resolved = raw.replace("${KICAD_LIBS_DIR}/", "") if raw.startswith("${KICAD_LIBS_DIR}/") else None
                src = (repo_root / resolved) if resolved else None
                if not resolved and STOCK_3D:
                    cand = Path(STOCK_3D) / raw.split("/")[-1]
                    src = cand if cand.exists() else None
                exists = bool(src and src.exists())
                entry = dict(m, resolved=resolved, exists=exists, changed=True, file=None)
                if exists:
                    fn = f"{side}_model_{n}{src.suffix.lower()}"
                    shutil.copy(src, d / fn)
                    entry["file"] = f"items/{slug}/{fn}"
                elif side == "head" or status == "deleted":
                    warnings.append(f"render: model file not found: {resolved}" if resolved else
                                    f"model path uses a KiCad stock library variable, not part of this repo: {raw}")
                lst.append(entry)
            model3d_by_side[side] = lst
        heads = [m["path_raw"] for m in (model3d_by_side["head"] or [])]
        bases = [m["path_raw"] for m in (model3d_by_side["base"] or [])]
        for side in ("head", "base"):
            for m in model3d_by_side[side] or []:
                m["changed"] = (m["path_raw"] not in bases) if side == "head" else (m["path_raw"] not in heads)
    model3d = [ {k: m[k] for k in ("path_raw", "resolved", "exists", "changed")}
                for m in (model3d_by_side["head"] if model3d_by_side["head"] is not None else model3d_by_side["base"] or []) ]
    patch = "".join(difflib.unified_diff((base_text or "").splitlines(True), (head_text or "").splitlines(True),
                                         f"a/{path}" if base_text else "/dev/null", f"b/{path}" if head_text else "/dev/null"))
    (d / "diff.patch").write_text(patch)
    props = {s: (info[s][2] if info[s] else None) for s in ("head", "base")}
    ds_url = (props["head"] or props["base"] or {}).get("Datasheet") or None
    if ds_url and not ds_url.startswith("http"):
        ds_url = None
    if not ds_url:
        m = re.search(r"https?://\S+\.pdf", (props["head"] or props["base"] or {}).get("Description", ""))
        ds_url = m.group(0) if m else None
    return {
        "id": f"{kind}:{lib}:{name}", "slug": slug, "kind": kind, "library": lib, "name": name, "status": status, "path": path,
        "line_range": {"head": line_range(file_head, needle) if file_head else None, "base": line_range(file_base, needle) if file_base else None},
        "properties": props,
        "datasheet": {"url": ds_url, "local": None, "file": None},
        "model3d": model3d,
        "stats": {s: (info[s][3] if info[s] else None) for s in ("head", "base")},
        "model3d_by_side": model3d_by_side if kind == "footprint" else None,
        "geom": geoms if kind == "footprint" else None,
        "renders": renders, "diff_png": diff, "glb": None,
        "text_diff": f"items/{slug}/diff.patch",
        "source": {s: (f"items/{slug}/{s}.{ext}" if info[s] else None) for s in ("head", "base")},
        "warnings": warnings,
    }


STOCK_3D = None


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True).stdout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--stock-3d", help="dir holding KiCad stock-library STEP files (matched by file name); testing only")
    a = ap.parse_args()
    global STOCK_3D
    STOCK_3D = a.stock_3d
    repo, out = Path(a.repo).resolve(), Path(a.out).resolve()
    if out.exists():
        shutil.rmtree(out)
    (out / "items").mkdir(parents=True)
    head_sha = git(repo, "rev-parse", "HEAD").strip()
    base_sha = git(repo, "rev-parse", "origin/main").strip()
    items = []

    def fp(lib, name, status, mutate=None, from_base=False):
        path = f"lib_fp/{lib}.pretty/{name}.kicad_mod"
        if from_base:
            base = git(repo, "show", f"origin/main:{path}")
            head = None
        else:
            head = (repo / path).read_text()
            base = mutate(head) if mutate else None
        items.append(make_item(out, repo, "footprint", lib, name, path, status, head, base, head, base, "(footprint"))

    # Modified: exposed pad was 2.29x3.0 in "base", now 2.41x3.3; pin-1 pad was plain rect; Value changed.
    def soic_base(t):
        t = t.replace("(size 2.41 3.3)", "(size 2.29 3)")
        t = re.sub(r'\(property "Value" "[^"]*"', '(property "Value" "SOIC-8-1EP_3.9x4.9mm_P1.27mm_EP2.29x3mm"', t, count=1)
        t = t.replace('(pad "1" smd roundrect', '(pad "1" smd rect', 1)
        return t

    # Modified: silkscreen body outline shifted / one pad moved by 0.2 mm, 3D model path differs.
    def switch_base(t):
        t = re.sub(r'(\(pad "2" smd \w+\s*\(at )(-?[\d.]+)', lambda m: f"{m.group(1)}{float(m.group(2)) - 0.2:g}", t, count=1)
        t = t.replace("TS32-7-35-BK-B-260-RA-SMT-TR.STEP", "TS32-7-35-BK-B-260-RA-SMT-TR_old.STEP")
        return t

    fp("Custom_Package_SO", "SOIC-8-1EP_3.9x4.9mm_P1.27mm_EP2.41x3.3mm", "modified", soic_base)
    fp("Custom_Button_Switch_SMD", "SW_SPST_Same-Sky_TS32_with-boss", "modified", switch_base)
    fp("Custom_Buzzer_Beeper", "MagneticBuzzer_9.6mm_5mm_right-angle", "added")
    fp("Custom_Connector_Card", "microSD_SHOU-HAN_TF-PUSH", "added")
    fp("Custom_Package_SO", "SOP-8_3.76x4.96mm_P1.27mm", "deleted", from_base=True)

    # Symbol: the whole library is new in the PR; the mock pretends it existed with an older pinout (modified).
    sym_path = "lib_sch/Custom_Audio.kicad_sym"
    file_head = (repo / sym_path).read_text()
    lr = line_range(file_head, '(symbol "NS4168"')
    head_block = "\n".join(file_head.splitlines()[lr[0] - 1:lr[1]])
    base_block = head_block.replace('"LRCLK"', '"WS"').replace('"Datasheet" "', '"Datasheet" "~', 1)
    file_base = file_head.replace(head_block, base_block)
    items.append(make_item(out, repo, "symbol", "Custom_Audio", "NS4168", sym_path, "modified", head_block, base_block,
                           file_head, file_base, '(symbol "NS4168"'))
    for it in items:
        if it["id"] == "symbol:Custom_Audio:NS4168":
            it["datasheet"]["local"] = "datasheets/NS4168.pdf"
            it["datasheet"]["file"] = f"items/{it['slug']}/datasheet.pdf"
            (out / it["datasheet"]["file"]).write_bytes(MINI_PDF)

    manifest = {"schema": 1, "repo": "PantsForBirds/kicad-libs", "pr": 12, "base_sha": base_sha, "head_sha": head_sha,
                "generated_at": "2026-09-24T07:30:00Z", "kicad_version": "10.0.1 (mock)", "items": items}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    review = Path(__file__).with_name("review.mock.json")
    if review.exists():
        shutil.copy(review, out / "review.json")
    print(f"wrote {len(items)} items to {out}")


MINI_PDF = (b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj "
            b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj "
            b"4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 20 50 Td (Mock datasheet) Tj ET\nendstream endobj "
            b"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n")

if __name__ == "__main__":
    main()
