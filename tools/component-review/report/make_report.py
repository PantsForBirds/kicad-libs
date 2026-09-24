#!/usr/bin/env python3
"""Build ONE self-contained HTML report from a component-review output directory.

    python3 tools/component-review/report/make_report.py --out cr-out [--output FILE] [--max-mb 20]

Reads OUT/manifest.json, OUT/review.json (optional) and the per-item files under OUT/items/
and writes OUT/component-review.html (or --output). The page needs no JavaScript and loads
nothing from the network: CSS is inline and every image is a PNG `data:` URI. Layer SVGs are
never embedded as markup: they are rasterized with cairosvg (external references refused)
and only if they pass the same active-content check as ci/sanitize_site.py. All text from
the manifest/review is escaped. If the page would exceed --max-mb, the layer stacks are
dropped first, then images are downscaled, then 3D previews are dropped, and the report says
so at the top.

Needs Python 3.11+ stdlib; uses Pillow (downscaling/re-encoding) and cairosvg (layer stack)
from render/requirements.txt when installed, and degrades without them.
"""
from __future__ import annotations

import argparse
import base64
import datetime as _dt
import html
import io
import json
import re
import sys
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "ci"))
from common import (SEVERITY_RANK, VERDICT_RANK, check_repo, check_sha, finding_line_no, load_json,  # noqa: E402
                    safe_http_url, safe_repo_path, safe_site_file, safe_slug)
from sanitize_site import svg_is_safe  # noqa: E402

try:
    from PIL import Image
except ImportError:  # pragma: no cover - exercised only without Pillow
    Image = None
try:
    import cairosvg
except (ImportError, OSError):  # OSError: cairosvg installed but libcairo missing
    cairosvg = None

MB = 1024 * 1024
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
MAX_PNG_BYTES = 10 * MB
MAX_SVG_BYTES = 5 * MB
MAX_PATCH_CHARS = 200_000
MAX_TABLE_ROWS = 400
# (render width, layer width or 0 = no layer stack, 3D width or 0 = no 3D previews, note)
LEVELS = [
    (1200, 900, 900, None),
    (1200, 0, 900, "per-layer views left out"),
    (800, 0, 600, "per-layer views left out; images downscaled"),
    (500, 0, 360, "per-layer views left out; images downscaled"),
    (500, 0, 0, "per-layer views and 3D previews left out; images downscaled"),
    (320, 0, 0, "per-layer views and 3D previews left out; images heavily downscaled"),
    (0, 0, 0, "all images left out"),
]
SEV_ICON = {"error": "✖", "warning": "▲", "info": "ℹ"}
VERDICT_LABEL = {"pass": "pass", "warn": "warn", "fail": "fail", None: "not reviewed"}
STATUS_LABEL = {"added": "added", "modified": "modified", "deleted": "deleted"}
# Layer colours for the legend chips (the SVGs carry their own colours).
LAYER_ORDER = ["B.Fab", "B.CrtYd", "B.SilkS", "B.Paste", "B.Mask", "B.Cu", "F.Cu", "F.Mask", "F.Paste",
               "F.SilkS", "F.Fab", "F.CrtYd", "Edge.Cuts", "User.1"]


def esc(v) -> str:
    return html.escape("" if v is None else str(v), quote=True)


def fmt(v) -> str:
    """A scalar/list value from the manifest as short text."""
    if v is None:
        return "—"
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, float):
        return f"{v:g}"
    if isinstance(v, (list, tuple)):
        return "(" + ", ".join(fmt(x) for x in v) + ")" if all(not isinstance(x, (dict, list)) for x in v) \
            else json.dumps(v, ensure_ascii=False)[:300]
    if isinstance(v, dict):
        return json.dumps(v, ensure_ascii=False, sort_keys=True)[:300]
    return str(v)


def inline_md(text, maxlen: int = 4000) -> str:
    """Escaped text with `code` and **bold** (the only markdown our tools emit), links as text."""
    s = esc(str(text or "")[:maxlen])
    s = re.sub(r"`([^`\n]{1,300})`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*\n]{1,300})\*\*", r"<strong>\1</strong>", s)
    return s.replace("\n", "<br>")


def _clip(text, n: int) -> str:
    s = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(s) <= n:
        return s
    s = s[: n - 1]
    if s.count("`") % 2:          # don't leave a code span open
        s = s[: s.rindex("`")]
    return s.rstrip() + "…"


def slug_id(slug: str) -> str:
    return "c-" + re.sub(r"[^A-Za-z0-9_-]", "_", slug)


# --------------------------------------------------------------------------- images

class Images:
    """PNG data: URIs from files inside the site, cached per (file, width)."""

    def __init__(self, site: Path):
        self.site = site
        self._cache: dict = {}
        self.failed: list[str] = []

    def _encode(self, data: bytes, width: int) -> str | None:
        if Image is not None:
            try:
                with Image.open(io.BytesIO(data)) as im:
                    im.load()
                    if im.format != "PNG":
                        return None
                    if im.mode not in ("RGB", "RGBA", "L", "LA", "P"):
                        im = im.convert("RGBA")
                    if width and im.width > width:
                        im = im.resize((width, max(1, round(im.height * width / im.width))), Image.LANCZOS)
                    out = io.BytesIO()
                    im.save(out, "PNG", optimize=True)
                    data = out.getvalue()
            except Exception:  # corrupt / hostile image
                return None
        elif not data.startswith(PNG_MAGIC):
            return None
        return "data:image/png;base64," + base64.b64encode(data).decode("ascii")

    def png(self, rel, slug: str, width: int) -> str | None:
        if not width:
            return None
        rel = safe_site_file(self.site, rel, slug)
        if not rel or not rel.lower().endswith(".png"):
            return None
        key = (rel, width)
        if key not in self._cache:
            p = self.site / rel
            data = p.read_bytes() if p.stat().st_size <= MAX_PNG_BYTES else b""
            self._cache[key] = self._encode(data, width) if data else None
            if self._cache[key] is None:
                self.failed.append(rel)
        return self._cache[key]

    def svg_layer(self, rel, slug: str, width: int) -> str | None:
        """A layer SVG rasterized to PNG, or None (unsafe, unavailable, too big)."""
        if not width or cairosvg is None:
            return None
        rel = safe_site_file(self.site, rel, slug)
        if not rel or not rel.lower().endswith(".svg"):
            return None
        key = (rel, width)
        if key not in self._cache:
            self._cache[key] = None
            p = self.site / rel
            if p.stat().st_size <= MAX_SVG_BYTES:
                data = p.read_bytes()
                if svg_is_safe(data):
                    try:
                        # svg_is_safe() already refused every external href/url(); unsafe=False
                        # also stops cairosvg resolving entities and local files.
                        png = cairosvg.svg2png(bytestring=data, output_width=width, unsafe=False, **_FETCH_KW)
                        self._cache[key] = self._encode(png, width)
                    except Exception:
                        pass
            if self._cache[key] is None:
                self.failed.append(rel)
        return self._cache[key]


def _refuse_fetch(url, *a, **kw):
    raise ValueError(f"external reference refused: {url[:80]}")


def _fetch_kw() -> dict:
    """Refuse all fetches where this cairosvg version lets us plug in a url_fetcher."""
    import inspect
    try:
        return {"url_fetcher": _refuse_fetch} if "url_fetcher" in inspect.signature(cairosvg.svg2png).parameters else {}
    except (TypeError, ValueError, AttributeError):
        return {}


_FETCH_KW = _fetch_kw() if cairosvg is not None else {}


def img_tag(uri: str | None, alt: str, cls: str = "") -> str:
    if not uri:
        return f'<div class="noimg">{esc(alt)}: not available</div>'
    return f'<img src="{uri}" alt="{esc(alt)}"{f" class={chr(34)}{cls}{chr(34)}" if cls else ""} loading="lazy">'


# --------------------------------------------------------------------------- context

class Ctx:
    def __init__(self, site: Path, manifest: dict, review: dict | None, server: str = "https://github.com"):
        self.site, self.manifest, self.review = site, manifest, review
        self.server = server.rstrip("/")
        try:
            self.repo = check_repo(manifest.get("repo"))
        except ValueError:
            self.repo = None
        self.head = _sha(manifest.get("head_sha"))
        self.base = _sha(manifest.get("base_sha"))
        pr = manifest.get("pr")
        self.pr = pr if isinstance(pr, int) and not isinstance(pr, bool) and pr > 0 else None

    def blob(self, path, line, sha) -> str | None:
        path = safe_repo_path(path)
        if not (self.repo and sha and path):
            return None
        url = f"{self.server}/{self.repo}/blob/{sha}/{urllib.parse.quote(path)}"
        if isinstance(line, int) and not isinstance(line, bool) and line > 0:
            url += f"#L{line}"
        return url

    def item_review(self, iid) -> dict:
        if not self.review or not isinstance(iid, str):
            return {}
        r = self.review.get("items", {}).get(iid)
        return r if isinstance(r, dict) else {}


def _sha(v):
    try:
        return check_sha(v)
    except ValueError:
        return None


def findings_of(entry: dict) -> list[dict]:
    fs = entry.get("findings")
    fs = [f for f in fs if isinstance(f, dict)] if isinstance(fs, list) else []
    return sorted(fs, key=lambda f: -SEVERITY_RANK.get(f.get("severity"), -1))


def verdict_of(entry: dict):
    v = entry.get("verdict")
    return v if v in VERDICT_RANK else None


# --------------------------------------------------------------------------- sections

def finding_html(ctx: Ctx, f: dict, sha, item: dict | None = None) -> str:
    sev = f.get("severity") if f.get("severity") in SEV_ICON else "info"
    where = ""
    path = safe_repo_path(f.get("path"))
    # No usable line (e.g. KLC checker findings): link the item's first line, never #L0.
    line, exact = finding_line_no(f, item)
    url = ctx.blob(path, line, sha)
    label = (f"{path}:{line}" if exact else path) if path else ""
    if url:
        where = f' <a class="loc" href="{esc(url)}">{esc(label)}</a>'
    elif label:
        where = f' <span class="loc">{esc(label)}</span>'
    out = [f'<li class="f sev-{sev}"><span class="sev">{SEV_ICON[sev]} {sev}</span>'
           f' <span class="cat">{esc(str(f.get("category") or "other")[:40])}</span>{where}'
           f'<div class="msg">{inline_md(f.get("message"), 3000)}</div>']
    if f.get("suggestion"):
        out.append(f'<div class="sug"><b>Suggestion:</b> {inline_md(f.get("suggestion"), 2000)}</div>')
    out.append("</li>")
    return "".join(out)


def kv_diff_table(base: dict | None, head: dict | None, title: str, keys=None) -> str:
    """Key/value table. One side only (added/deleted item): plain values. Both sides: changed
    rows first, unchanged ones folded away."""
    base = base if isinstance(base, dict) else {}
    head = head if isinstance(head, dict) else {}
    keys = keys or sorted(set(base) | set(head), key=str)
    one = head or base
    changed, same = [], []
    for k in keys:
        b, h = base.get(k), head.get(k)
        if any(isinstance(x, (dict, list)) and len(json.dumps(x, default=str)) > 400 for x in (b, h)):
            continue
        if not (base and head):
            same.append(f"<tr><th>{esc(k)}</th><td>{esc(fmt(one.get(k)))}</td></tr>")
            continue
        cls = "same" if b == h else ("add" if k not in base else "del" if k not in head else "chg")
        row = (f'<tr class="{cls}"><th>{esc(k)}</th><td>{esc(fmt(b)) if k in base else "—"}</td>'
               f'<td>{esc(fmt(h)) if k in head else "—"}</td></tr>')
        (same if cls == "same" else changed).append(row)
    if not changed and not same:
        return ""
    if not (base and head):
        return (f'<h4>{esc(title)}</h4><div class="tw"><table class="kv"><tbody>{"".join(same[:MAX_TABLE_ROWS])}'
                "</tbody></table></div>")
    thead = "<thead><tr><th></th><th>before</th><th>after</th></tr></thead>"
    out = [f"<h4>{esc(title)}</h4>"]
    if changed:
        out.append(f'<div class="tw"><table class="kv">{thead}<tbody>{"".join(changed[:MAX_TABLE_ROWS])}</tbody></table></div>')
    else:
        out.append('<p class="muted">No changes.</p>')
    if same:
        out.append(f'<details><summary>{len(same)} unchanged</summary><div class="tw"><table class="kv">{thead}'
                   f'<tbody>{"".join(same[:MAX_TABLE_ROWS])}</tbody></table></div></details>')
    return "".join(out)


def _keyed(rows, keyf) -> dict:
    out, seen = {}, {}
    for r in rows if isinstance(rows, list) else []:
        if not isinstance(r, dict):
            continue
        k = keyf(r)
        seen[k] = seen.get(k, 0) + 1
        out[(k, seen[k])] = r
    return out


def rows_diff_table(base_rows, head_rows, keyf, cols, title: str, key_label: str) -> str:
    """Pad/pin table: one row per key (number + occurrence), before → after per column."""
    b, h = _keyed(base_rows, keyf), _keyed(head_rows, keyf)
    if not b and not h:
        return ""
    keys = sorted(set(b) | set(h), key=lambda k: (_natkey(k[0]), k[1]))
    if not (b and h):   # added or deleted item: a plain listing
        one = h or b
        trs = "".join(f'<tr><th>{esc(k[0] if k[0] != "" else "(none)")}</th>'
                      + "".join(f"<td>{esc(fmt(one[k].get(c)))}</td>" for c in cols) + "</tr>"
                      for k in keys[:MAX_TABLE_ROWS])
        more = f" (first {MAX_TABLE_ROWS} of {len(keys)} shown)" if len(keys) > MAX_TABLE_ROWS else ""
        return (f"<h4>{esc(title)} ({len(keys)}){esc(more)}</h4><div class=\"tw\"><table class=\"rows\"><thead><tr>"
                f"<th>{esc(key_label)}</th>" + "".join(f"<th>{esc(c)}</th>" for c in cols)
                + f"</tr></thead><tbody>{trs}</tbody></table></div>")
    changed, same = [], []
    for k in keys[:MAX_TABLE_ROWS]:
        br, hr = b.get(k), h.get(k)
        state = "add" if br is None else "del" if hr is None else None
        cells = []
        for c in cols:
            bv, hv = (br or {}).get(c), (hr or {}).get(c)
            if state == "add":
                cells.append(f"<td>{esc(fmt(hv))}</td>")
            elif state == "del":
                cells.append(f"<td>{esc(fmt(bv))}</td>")
            elif bv == hv:
                cells.append(f"<td>{esc(fmt(hv))}</td>")
            else:
                state = "chg"
                cells.append(f'<td class="cc"><del>{esc(fmt(bv))}</del> → <ins>{esc(fmt(hv))}</ins></td>')
        name = esc(k[0] if k[0] != "" else "(none)") + (f" <small>#{k[1]}</small>" if k[1] > 1 else "")
        tag = {"add": "added", "del": "removed", "chg": "changed"}.get(state, "")
        row = f'<tr class="{state or "same"}"><th>{name}</th><td>{tag}</td>{"".join(cells)}</tr>'
        (changed if state else same).append(row)
    head_row = f'<tr><th>{esc(key_label)}</th><th></th>' + "".join(f"<th>{esc(c)}</th>" for c in cols) + "</tr>"
    parts = [f"<h4>{esc(title)}</h4>"]
    summary = f"{len(changed)} changed / added / removed, {len(same)} unchanged"
    if len(keys) > MAX_TABLE_ROWS:
        summary += f" (first {MAX_TABLE_ROWS} of {len(keys)} shown)"
    parts.append(f'<p class="muted">{esc(summary)}</p>')
    if changed:
        parts.append(f'<div class="tw"><table class="rows"><thead>{head_row}</thead><tbody>{"".join(changed)}</tbody></table></div>')
    if same:
        parts.append(f'<details><summary>All {len(same)} unchanged row(s)</summary><div class="tw"><table class="rows">'
                     f'<thead>{head_row}</thead><tbody>{"".join(same)}</tbody></table></div></details>')
    return "".join(parts)


def _natkey(s):
    return [(0, int(t), "") if t.isdigit() else (1, 0, t) for t in re.split(r"(\d+)", str(s)) if t]


def images_section(ctx: Ctx, imgs: Images, item: dict, slug: str, lv) -> str:
    rw, lw, tw, _ = lv
    if not rw:
        return ""
    renders = item.get("renders") if isinstance(item.get("renders"), dict) else {}
    side = {s: (renders.get(s) if isinstance(renders.get(s), dict) else None) for s in ("base", "head")}
    base_uri = imgs.png(side["base"].get("png"), slug, rw) if side["base"] else None
    head_uri = imgs.png(side["head"].get("png"), slug, rw) if side["head"] else None
    diff_uri = imgs.png(item.get("diff_png"), slug, rw)
    figs = []
    if side["base"] or item.get("status") != "added":
        figs.append(f'<figure><figcaption>Before (base)</figcaption>{img_tag(base_uri, "before")}</figure>')
    if side["head"] or item.get("status") != "deleted":
        figs.append(f'<figure><figcaption>After (head)</figcaption>{img_tag(head_uri, "after")}</figure>')
    if diff_uri and base_uri:
        figs.append('<figure><figcaption>Diff over before <span class="legend"><i class="lg-add"></i>added '
                    '<i class="lg-del"></i>removed</span></figcaption><div class="stack">'
                    f'{img_tag(base_uri, "before")}<img class="over" src="{diff_uri}" alt="diff"></div></figure>')
    out = [f'<div class="figs">{"".join(figs)}</div>']
    # Layer stack with pure-CSS toggles (checkbox + sibling selectors, no JS).
    if lw:
        for s in ("head", "base"):
            layers = side[s].get("layers") if side[s] and isinstance(side[s].get("layers"), dict) else {}
            names = sorted((k for k in layers if isinstance(k, str)),
                           key=lambda n: (LAYER_ORDER.index(n) if n in LAYER_ORDER else 99, n))
            rendered = [(n, imgs.svg_layer(layers[n], slug, lw)) for n in names[:16]]
            rendered = [(n, u) for n, u in rendered if u]
            if not rendered:
                continue
            gid = f"{slug_id(slug)}-{s}"
            boxes = "".join(f'<input type="checkbox" id="{gid}-{i}" class="lt lt{i}" checked>' for i in range(len(rendered)))
            labels = "".join(f'<label for="{gid}-{i}">{esc(n)}</label>' for i, (n, _) in enumerate(rendered))
            layers_html = "".join(f'<img class="ly ly{i}" src="{u}" alt="{esc(n)}">' for i, (n, u) in enumerate(rendered))
            out.append(f'<details class="layers"><summary>Layers ({"after" if s == "head" else "before"}): '
                       f'{len(rendered)}, click the names to toggle</summary>{boxes}<div class="lbar">{labels}</div>'
                       f'<div class="lstack">{layers_html}</div></details>')
    if tw:
        p3 = item.get("preview_3d") if isinstance(item.get("preview_3d"), dict) else {}
        figs3 = []
        for s, cap in (("base", "Before"), ("head", "After")):
            if p3.get(s):
                figs3.append(f"<figure><figcaption>3D {cap} (iso / top / front / right)</figcaption>"
                             f"{img_tag(imgs.png(p3.get(s), slug, tw), '3D ' + cap)}</figure>")
        if figs3:
            out.append(f'<details class="p3" open><summary>3D preview</summary><div class="figs">{"".join(figs3)}</div></details>')
    return "".join(out)


def models_section(item: dict) -> str:
    by = item.get("model3d_by_side") if isinstance(item.get("model3d_by_side"), dict) else None
    rows = []
    if by:
        for s in ("base", "head"):
            for m in by.get(s) or []:
                if isinstance(m, dict):
                    rows.append((s, m))
    else:
        rows = [(m.get("side") or "head", m) for m in item.get("model3d") or [] if isinstance(m, dict)]
    if not rows:
        return ""
    trs = []
    base_rows = [m for s, m in rows if s == "base"]
    head_i = 0
    for s, m in rows[:50]:
        stock = m.get("stock") if isinstance(m.get("stock"), dict) else None
        exists = m.get("exists")
        other = None
        if by and s == "head" and base_rows:   # compare with the same model slot before the change
            other = base_rows[head_i] if head_i < len(base_rows) else {}
            head_i += 1

        def cell(key, val):
            hit = other is not None and other.get(key) != m.get(key)
            return f'<td class="cc">{val}</td>' if hit else f"<td>{val}</td>"
        trs.append(
            f'<tr class="{"" if exists else "bad"}"><td>{"after" if s == "head" else "before"}</td>'
            + cell("path_raw", f'<code>{esc(m.get("path_raw"))}</code>'
                   + (f'<br><small>resolved: {esc(m.get("resolved"))}</small>' if m.get("resolved") else "")
                   + (f'<br><small>KiCad stock model, tag {esc(stock.get("tag"))}</small>' if stock else ""))
            + f'<td>{esc(fmt(exists))}</td><td>{esc(fmt(m.get("changed")))}</td>'
            + "".join(cell(k, esc(fmt(m.get(k)))) for k in ("offset", "rotate", "scale", "hide")) + "</tr>")
    return ('<h4>3D models</h4><div class="tw"><table class="rows"><thead><tr><th>side</th><th>path</th><th>exists</th>'
            '<th>file changed</th><th>offset (mm)</th><th>rotate (°)</th><th>scale</th><th>hidden</th></tr></thead>'
            f'<tbody>{"".join(trs)}</tbody></table></div>')


def text_diff_section(site: Path, item: dict, slug: str) -> str:
    rel = safe_site_file(site, item.get("text_diff"), slug)
    if not rel:
        return ""
    raw = (site / rel).read_bytes()[: MAX_PATCH_CHARS * 4].decode("utf-8", "replace")
    cut = len(raw) > MAX_PATCH_CHARS
    raw = raw[:MAX_PATCH_CHARS]
    lines = []
    for ln in raw.splitlines():
        cls = ("hunk" if ln.startswith("@@") else "meta" if ln.startswith(("+++", "---", "diff ", "index "))
               else "add" if ln.startswith("+") else "del" if ln.startswith("-") else "")
        lines.append(f'<span class="{cls}">{esc(ln)}</span>' if cls else esc(ln))
    n_add = sum(1 for ln in raw.splitlines() if ln.startswith("+") and not ln.startswith("+++"))
    n_del = sum(1 for ln in raw.splitlines() if ln.startswith("-") and not ln.startswith("---"))
    return (f'<details class="patch"><summary>Text diff (+{n_add} / −{n_del} lines)'
            f'{" (truncated)" if cut else ""}</summary><pre>{chr(10).join(lines)}</pre></details>')


def component_section(ctx: Ctx, imgs: Images, item: dict, lv) -> str:
    slug = safe_slug(item.get("slug")) or "invalid"
    iid = item.get("id") if isinstance(item.get("id"), str) else ""
    status = item.get("status") if item.get("status") in STATUS_LABEL else "?"
    kind = item.get("kind") if item.get("kind") in ("footprint", "symbol") else "?"
    entry = ctx.item_review(iid)
    v = verdict_of(entry)
    sha = ctx.base if status == "deleted" else ctx.head
    path = safe_repo_path(item.get("path"))
    lr = item.get("line_range") if isinstance(item.get("line_range"), dict) else {}
    rng = lr.get("base" if status == "deleted" else "head")
    first = rng[0] if isinstance(rng, list) and rng and isinstance(rng[0], int) else None
    src_url = ctx.blob(path, first, sha)
    out = [f'<section class="comp v-{v or "none"}" id="{slug_id(slug)}">',
           f'<h2><span class="badge v-{v or "none"}">{esc(VERDICT_LABEL[v])}</span> '
           f'{esc(item.get("library"))}:<wbr>{esc(item.get("name"))}</h2>',
           f'<p class="meta"><span class="pill">{esc(kind)}</span> <span class="pill st-{esc(status)}">{esc(status)}</span> ']
    if path:
        out.append(f'<a href="{esc(src_url)}"><code>{esc(path)}</code></a>' if src_url else f"<code>{esc(path)}</code>")
        if isinstance(rng, list) and len(rng) == 2:
            out.append(f' <small>lines {esc(rng[0])}–{esc(rng[1])}</small>')
    ds = item.get("datasheet") if isinstance(item.get("datasheet"), dict) else {}
    ds_url = safe_http_url(ds.get("url"))
    if ds_url:
        out.append(f' · <a href="{esc(ds_url)}" rel="noreferrer noopener">datasheet</a>')
    elif ds.get("url"):
        out.append(f' · datasheet: <code>{esc(str(ds.get("url"))[:200])}</code>')
    if ds.get("local"):
        out.append(f' · local datasheet <code>{esc(str(ds.get("local"))[:200])}</code>')
    out.append(' · <a href="#top">top</a></p>')
    if entry.get("summary"):
        out.append(f'<p class="summary">{inline_md(entry.get("summary"), 2000)}</p>')
    reasons = [r for r in item.get("change_reasons") or [] if isinstance(r, str)]
    if reasons:
        out.append('<ul class="reasons">' + "".join(f"<li>{esc(r[:300])}</li>" for r in reasons[:20]) + "</ul>")

    fs = findings_of(entry)
    if fs:
        out.append(f'<h4>Findings ({len(fs)})</h4><ul class="findings">'
                   + "".join(finding_html(ctx, f, sha, item) for f in fs[:200]) + "</ul>")
    warnings = [w for w in item.get("warnings") or [] if isinstance(w, str)]
    if warnings:
        out.append('<h4>Render warnings</h4><ul class="warns">' + "".join(f"<li>{esc(w[:500])}</li>" for w in warnings[:50]) + "</ul>")

    out.append(images_section(ctx, imgs, item, slug, lv))

    props = item.get("properties") if isinstance(item.get("properties"), dict) else {}
    out.append(kv_diff_table(props.get("base"), props.get("head"), "Properties"))
    stats = item.get("stats") if isinstance(item.get("stats"), dict) else {}
    sb, sh = stats.get("base"), stats.get("head")
    scalar = sorted({k for d in (sb, sh) if isinstance(d, dict) for k, x in d.items()
                     if k not in ("pads", "pins", "texts") and not (isinstance(x, (list, dict)) and len(json.dumps(x, default=str)) > 200)})
    out.append(kv_diff_table(sb, sh, "Statistics", scalar))
    if kind == "footprint":
        out.append(rows_diff_table((sb or {}).get("pads") if isinstance(sb, dict) else None,
                                   (sh or {}).get("pads") if isinstance(sh, dict) else None,
                                   lambda p: str(p.get("number", "")),
                                   ["type", "shape", "at", "size", "drill", "layers", "roundrect_rratio"], "Pads", "pad"))
    elif kind == "symbol":
        out.append(rows_diff_table((sb or {}).get("pins") if isinstance(sb, dict) else None,
                                   (sh or {}).get("pins") if isinstance(sh, dict) else None,
                                   lambda p: f'{p.get("number", "")}' + (f' (unit {p.get("unit")})' if p.get("unit") not in (None, 1) else ""),
                                   ["name", "type", "shape", "unit", "hidden", "pos", "angle", "length"], "Pins", "pin"))
    out.append(models_section(item))
    checks = [c for c in entry.get("checks") or [] if isinstance(c, dict)]
    if checks:
        trs = "".join(f'<tr class="ck-{esc(c.get("result"))}"><td>{esc(c.get("result"))}</td><td>{esc(c.get("name"))}</td>'
                      f'<td>{inline_md(c.get("detail"), 500)}</td></tr>' for c in checks[:100])
        out.append(f'<details><summary>Checks ({len(checks)})</summary><div class="tw"><table class="rows">'
                   f'<thead><tr><th>result</th><th>check</th><th>detail</th></tr></thead><tbody>{trs}</tbody></table></div></details>')
    out.append(text_diff_section(ctx.site, item, slug))
    out.append("</section>")
    return "".join(out)


def summary_table(ctx: Ctx, items: list[dict]) -> str:
    rows = []
    for it in items:
        slug = safe_slug(it.get("slug")) or "invalid"
        entry = ctx.item_review(it.get("id"))
        v = verdict_of(entry)
        fs = findings_of(entry)
        n = {s: sum(f.get("severity") == s for f in fs) for s in SEV_ICON}
        top = next((f for f in fs if f.get("severity") != "info"), fs[0] if fs else None)
        rows.append(
            f'<tr><td><span class="badge v-{v or "none"}">{esc(VERDICT_LABEL[v])}</span></td>'
            f'<td><a href="#{slug_id(slug)}">{esc(it.get("library"))}:<wbr>{esc(it.get("name"))}</a></td>'
            f'<td>{esc(it.get("kind"))}</td><td>{esc(it.get("status"))}</td>'
            f'<td class="num">{n["error"] or ""}</td><td class="num">{n["warning"] or ""}</td><td class="num">{n["info"] or ""}</td>'
            f'<td>{inline_md(_clip(top.get("message"), 160)) if top else ""}</td></tr>')
    return ('<div class="tw"><table class="summary"><thead><tr><th>verdict</th><th>component</th><th>kind</th>'
            f'<th>status</th><th>{SEV_ICON["error"]}</th><th>{SEV_ICON["warning"]}</th><th>{SEV_ICON["info"]}</th>'
            f'<th>top finding</th></tr></thead><tbody>{"".join(rows)}</tbody></table></div>')


def sort_key(ctx: Ctx, it: dict):
    v = verdict_of(ctx.item_review(it.get("id")))
    return (-VERDICT_RANK.get(v, -1), str(it.get("kind")), str(it.get("library")), str(it.get("name")))


CSS = """
:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--card:#f6f8fa;--link:#0969da;
--pass:#1a7f37;--warn:#9a6700;--fail:#cf222e;--none:#6e7781;--add:#dafbe1;--del:#ffebe9;--chg:#fff8c5;
--addfg:#116329;--delfg:#82071e;--code:#eff1f3;--img:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;
--card:#161b22;--link:#4493f8;--pass:#3fb950;--warn:#d29922;--fail:#f85149;--none:#8d96a0;--add:#12261e;
--del:#2d1215;--chg:#2e2a14;--addfg:#56d364;--delfg:#ff7b72;--code:#1f242c;--img:#0d1117}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:1400px;margin:0 auto;padding:16px}a{color:var(--link)}code,pre{font-family:ui-monospace,
SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}code{background:var(--code);padding:1px 4px;border-radius:4px;
overflow-wrap:anywhere}h1{font-size:24px;margin:8px 0}h2{font-size:18px;margin:0 0 6px;overflow-wrap:anywhere}
h3{font-size:16px}h4{margin:18px 0 6px;font-size:14px}.muted,.meta{color:var(--muted)}
.badge{display:inline-block;padding:1px 8px;border-radius:12px;color:#fff;font-size:12px;font-weight:600;
text-transform:uppercase;vertical-align:middle}.badge.v-pass{background:var(--pass)}.badge.v-warn{background:var(--warn)}
.badge.v-fail{background:var(--fail)}.badge.v-none{background:var(--none)}
.pill{border:1px solid var(--line);border-radius:10px;padding:0 6px;font-size:12px}
.st-added{color:var(--addfg)}.st-deleted{color:var(--delfg)}
header.top{border-bottom:1px solid var(--line);margin-bottom:12px}
.cards{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}.card{background:var(--card);border:1px solid var(--line);
border-radius:8px;padding:6px 12px}.card b{font-size:18px;display:block}
.note{background:var(--chg);border:1px solid var(--line);border-radius:6px;padding:6px 10px;margin:8px 0}
.tw{overflow-x:auto}table{border-collapse:collapse;margin:4px 0}th,td{border:1px solid var(--line);padding:3px 8px;
text-align:left;vertical-align:top}thead th{background:var(--card)}td.num{text-align:right}
table.summary{width:100%}
tr.add td,tr.add th{background:var(--add)}tr.del td,tr.del th{background:var(--del)}tr.chg td,tr.chg th{background:var(--chg)}
td.cc{background:var(--chg);font-weight:600}td.cc del{color:var(--delfg)}td.cc ins{color:var(--addfg);text-decoration:none;font-weight:600}
section.comp{border:1px solid var(--line);border-left:6px solid var(--none);border-radius:8px;padding:12px 16px;
margin:20px 0;background:var(--bg)}section.v-pass{border-left-color:var(--pass)}section.v-warn{border-left-color:var(--warn)}
section.v-fail{border-left-color:var(--fail)}
ul.findings{list-style:none;padding:0;margin:0}li.f{border:1px solid var(--line);border-radius:6px;padding:6px 10px;margin:6px 0}
li.sev-error{border-left:4px solid var(--fail)}li.sev-warning{border-left:4px solid var(--warn)}li.sev-info{border-left:4px solid var(--none)}
.sev{font-weight:600;text-transform:uppercase;font-size:12px}.sev-error .sev{color:var(--fail)}.sev-warning .sev{color:var(--warn)}
.cat{font-size:12px;border:1px solid var(--line);border-radius:10px;padding:0 6px}.loc{font-size:12px}
.sug{color:var(--muted);margin-top:2px}.msg{overflow-wrap:anywhere}
.figs{display:flex;flex-wrap:wrap;gap:12px;margin:8px 0}figure{margin:0;flex:1 1 320px;min-width:0;max-width:640px}
figcaption{font-size:12px;color:var(--muted)}figure img,.stack img,.lstack img{width:100%;height:auto;display:block;
background:#101418;border:1px solid var(--line);border-radius:4px}
.stack,.lstack{position:relative}.stack img.over,.lstack img.ly{position:absolute;inset:0;background:transparent;border-color:transparent}
.lstack{background:#101418;border-radius:4px;max-width:900px}
.p3 figure{max-width:440px}.lstack img.ly0{position:relative}
.noimg{border:1px dashed var(--line);border-radius:4px;padding:30px;text-align:center;color:var(--muted)}
.legend i{display:inline-block;width:10px;height:10px;margin:0 2px 0 8px;vertical-align:middle}
.lg-add{background:#2ea043}.lg-del{background:#f85149}
details{margin:8px 0}summary{cursor:pointer;font-weight:600}
details.layers input.lt{position:absolute;opacity:0;pointer-events:none}
.lbar{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0}.lbar label{border:1px solid var(--line);border-radius:12px;
padding:0 8px;cursor:pointer;user-select:none;opacity:.45;text-decoration:line-through}
LAYER_RULES
pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px;overflow:auto;max-height:600px}
pre .add{color:var(--addfg);background:var(--add);display:inline-block;min-width:100%}
pre .del{color:var(--delfg);background:var(--del);display:inline-block;min-width:100%}
pre .hunk{color:var(--link)}pre .meta{color:var(--muted)}
tr.bad td{background:var(--del)}tr.ck-fail td{color:var(--fail)}
footer{color:var(--muted);font-size:12px;border-top:1px solid var(--line);margin-top:24px;padding-top:8px}
"""


def css() -> str:
    # checkbox i ↔ label i ↔ layer image i (no JS): unchecked hides the layer and dims the label.
    rules = []
    for i in range(16):
        rules.append(f"input.lt{i}:checked~.lbar label:nth-child({i + 1}){{opacity:1;text-decoration:none}}"
                     f"input.lt{i}:not(:checked)~.lstack img.ly{i}{{visibility:hidden}}")
    return CSS.replace("LAYER_RULES", "\n".join(rules))


def build(site: Path, level: int = 0, server: str = "https://github.com", now: str | None = None) -> str:
    manifest = load_json(site / "manifest.json")
    if not isinstance(manifest, dict):
        manifest = {}
    items = [i for i in manifest.get("items") or [] if isinstance(i, dict)] if isinstance(manifest.get("items"), list) else []
    review = load_json(site / "review.json")
    if not isinstance(review, dict):
        review = None
    elif not isinstance(review.get("items"), dict):
        review["items"] = {}
    ctx = Ctx(site, manifest, review, server)
    lv = LEVELS[level]
    imgs = Images(site)
    items = sorted(items, key=lambda it: sort_key(ctx, it))

    verdicts = [verdict_of(ctx.item_review(i.get("id"))) for i in items]
    overall = max((v for v in verdicts if v), key=VERDICT_RANK.__getitem__, default=None)
    sev = {s: 0 for s in SEV_ICON}
    for i in items:
        for f in findings_of(ctx.item_review(i.get("id"))):
            if f.get("severity") in sev:
                sev[f["severity"]] += 1
    status = {s: sum(i.get("status") == s for i in items) for s in STATUS_LABEL}

    title = f"Component review{f' · PR #{ctx.pr}' if ctx.pr else ''}{f' · {ctx.repo}' if ctx.repo else ''}"
    h = ['<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">',
         '<meta name="viewport" content="width=device-width,initial-scale=1">',
         # no scripts, no network: only inline styles and data: images
         "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; "
         "style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\">",
         '<meta name="color-scheme" content="light dark">',
         f"<title>{esc(title)}</title><style>{css()}</style></head><body><main>",
         f'<header class="top" id="top"><h1><span class="badge v-{overall or "none"}">{esc(VERDICT_LABEL[overall])}</span> '
         f"{esc(title)}</h1><p class=\"muted\">"]
    meta = []
    if ctx.repo:
        meta.append(f'<a href="{esc(ctx.server)}/{esc(ctx.repo)}">{esc(ctx.repo)}</a>')
    if ctx.pr and ctx.repo:
        meta.append(f'<a href="{esc(ctx.server)}/{esc(ctx.repo)}/pull/{ctx.pr}">PR #{ctx.pr}</a>')
    if ctx.base or ctx.head:
        def c(sha):
            return (f'<a href="{esc(ctx.server)}/{esc(ctx.repo)}/commit/{sha}"><code>{sha[:10]}</code></a>'
                    if sha and ctx.repo else f"<code>{esc((sha or '?')[:10])}</code>")
        meta.append(f"{c(ctx.base)} … {c(ctx.head)}")
    if manifest.get("generated_at"):
        meta.append(f"rendered {esc(str(manifest.get('generated_at'))[:40])}")
    if manifest.get("kicad_version"):
        meta.append(f"KiCad {esc(str(manifest.get('kicad_version'))[:20])}")
    generator = review and (review.get("generator") or review.get("model"))  # `model`: files from older runs
    if generator:
        meta.append(f"checks: {esc(str(generator)[:80])}")
    h.append(" · ".join(meta) + "</p>")
    cards = [("components", len(items))] + [(k, v) for k, v in status.items() if v] + \
            [(f"{k} verdict", verdicts.count(k)) for k in ("fail", "warn", "pass") if verdicts.count(k)] + \
            [(f"{k}s", v) for k, v in sev.items() if v]
    h.append('<div class="cards">' + "".join(f'<div class="card"><b>{v}</b>{esc(k)}</div>' for k, v in cards) + "</div>")
    if lv[3]:
        h.append(f'<p class="note">To stay under the size limit: {esc(lv[3])}. Open the interactive viewer '
                 f'(<code>component-review-site</code> artifact) for everything.</p>')
    if review is None:
        h.append('<p class="note">No review.json: showing renders only, without checks.</p>')
    elif review.get("summary_markdown"):
        h.append(f'<p>{inline_md(review.get("summary_markdown"), 4000)}</p>')
    h.append("</header>")

    prf = [f for f in (review or {}).get("pr_findings") or [] if isinstance(f, dict)] \
        if isinstance((review or {}).get("pr_findings"), list) else []
    if prf:
        h.append(f'<h3>PR-level findings ({len(prf)})</h3><ul class="findings">'
                 + "".join(finding_html(ctx, f, ctx.head) for f in sorted(prf, key=lambda f: -SEVERITY_RANK.get(f.get("severity"), -1))[:100])
                 + "</ul>")
    unref = [p for p in manifest.get("unreferenced_changed_3d_files") or [] if isinstance(p, str)]
    if unref and not prf:
        h.append("<h3>3D model files changed but not referenced</h3><ul>" + "".join(f"<li><code>{esc(p)}</code></li>" for p in unref[:50]) + "</ul>")

    h.append(f"<h3>Components ({len(items)})</h3>")
    h.append(summary_table(ctx, items) if items else '<p class="muted">No footprints or symbols changed.</p>')
    for it in items:
        h.append(component_section(ctx, imgs, it, lv))
    stamp = now or _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    failed = sorted(set(imgs.failed))
    h.append("<footer>")
    if failed:
        h.append(f"{len(failed)} image(s) could not be embedded (missing, not PNG, unsafe SVG or too big). ")
    if cairosvg is None and lv[1]:
        h.append("Per-layer views need cairosvg (not installed). ")
    h.append(f"Generated by tools/component-review/report/make_report.py at {esc(stamp)}. "
             "Checks are deterministic (KLC-style rules and, if enabled, the official KLC checker). "
             "This page contains no scripts and loads nothing from the network.</footer></main></body></html>")
    return "".join(x for x in h if x)


def make_report(site: Path, max_bytes: int, server: str = "https://github.com") -> tuple[str, int]:
    """(html, level used). Walks LEVELS until the page fits in max_bytes."""
    page = ""
    for level in range(len(LEVELS)):
        page = build(site, level, server)
        if len(page.encode("utf-8")) <= max_bytes:
            return page, level
    return page, len(LEVELS) - 1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", required=True, type=Path, help="component-review output dir (manifest.json, items/)")
    ap.add_argument("--output", type=Path, help="HTML file to write (default OUT/component-review.html)")
    ap.add_argument("--max-mb", type=float, default=20.0, help="size cap for the page (default 20)")
    ap.add_argument("--server-url", default="https://github.com")
    a = ap.parse_args(argv)
    if not (a.out / "manifest.json").is_file():
        print(f"make_report: no manifest.json in {a.out}", file=sys.stderr)
        return 2
    page, level = make_report(a.out, int(a.max_mb * MB), a.server_url)
    target = a.output or (a.out / "component-review.html")
    target.write_text(page, encoding="utf-8")
    print(f"make_report: wrote {target} ({len(page.encode()) / MB:.1f} MB"
          + (f"; {LEVELS[level][3]}" if LEVELS[level][3] else "") + ")")
    return 0


if __name__ == "__main__":
    sys.exit(main())
