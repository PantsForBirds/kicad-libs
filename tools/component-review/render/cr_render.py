#!/usr/bin/env python3
"""Component review renderer for a KiCad library repo.

Finds the footprints/symbols added, modified or deleted between two git refs and writes
OUT/manifest.json plus per-item assets (SVG/PNG renders, diff overlay, GLB, sources) as
described in cr-shared/CONTRACT.md.

    python3 tools/component-review/render/cr_render.py --repo . --base <ref> --head <ref> --out <dir> [--pr N]
"""

from __future__ import annotations

import argparse
import datetime as _dt
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fp as fpmod  # noqa: E402
import sym as symmod  # noqa: E402
from sexpr import dumps, parse  # noqa: E402

REPO_NAME_DEFAULT = "PantsForBirds/kicad-libs"
FP_RE = re.compile(r"^lib_fp/(?P<lib>[^/]+)\.pretty/(?:.*/)?(?P<name>[^/]+)\.kicad_mod$")
SYM_RE = re.compile(r"^lib_sch/(?P<lib>[^/]+)\.kicad_sym$")
MODEL_EXTS = (".step", ".stp", ".wrl", ".STEP", ".STP", ".WRL")
URL_RE = re.compile(r"https?://[^\s\"'<>)]+")
NOT_LOCAL_VARS = re.compile(r"^\$\{(KICAD\d*_3DMODEL_DIR|KISYS3DMOD|KICAD\d*_3RD_PARTY)\}")


def log(*a):
    print("[cr_render]", *a, file=sys.stderr, flush=True)


def slugify(kind: str, library: str, name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", f"{kind}__{library}__{name}")


# ---------------------------------------------------------------------------
# git access
# ---------------------------------------------------------------------------

class Git:
    def __init__(self, repo: str):
        self.repo = repo
        self._cache: dict[tuple[str, str], bytes | None] = {}

    def run(self, *args, check=True) -> str:
        r = subprocess.run(["git", "-C", self.repo, *args], capture_output=True, text=True)
        if check and r.returncode != 0:
            raise RuntimeError(f"git {' '.join(args)} failed: {r.stderr.strip()}")
        return r.stdout

    def rev(self, ref: str) -> str:
        return self.run("rev-parse", "--verify", f"{ref}^{{commit}}").strip()

    def show(self, sha: str, path: str) -> bytes | None:
        key = (sha, path)
        if key not in self._cache:
            r = subprocess.run(["git", "-C", self.repo, "show", f"{sha}:{path}"], capture_output=True)
            self._cache[key] = r.stdout if r.returncode == 0 else None
        return self._cache[key]

    def text(self, sha: str, path: str) -> str | None:
        b = self.show(sha, path)
        return b.decode("utf-8", errors="replace") if b is not None else None

    def exists(self, sha: str, path: str) -> bool:
        r = subprocess.run(["git", "-C", self.repo, "cat-file", "-e", f"{sha}:{path}"], capture_output=True)
        return r.returncode == 0

    def ls(self, sha: str, prefix: str) -> list[str]:
        out = self.run("ls-tree", "-r", "--name-only", sha, "--", prefix, check=False)
        return [l for l in out.splitlines() if l]

    def changed(self, base: str, head: str) -> list[tuple[str, str]]:
        out = self.run("diff", "--name-status", "--no-renames", base, head, "--", "lib_fp", "lib_sch", "lib_3d")
        res = []
        for line in out.splitlines():
            parts = line.split("\t")
            if len(parts) >= 2:
                res.append((parts[0][0], parts[-1]))
        return res


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def unified_diff(a: str, b: str, path: str, a_off: int = 0, b_off: int = 0, a_exists=True, b_exists=True) -> str:
    """Unified diff of two text fragments; hunk line numbers are shifted to file positions."""
    al = a.splitlines(keepends=True) if a else []
    bl = b.splitlines(keepends=True) if b else []
    for lst in (al, bl):
        if lst and not lst[-1].endswith("\n"):
            lst[-1] += "\n"
    out = []
    fa = f"a/{path}" if a_exists else "/dev/null"
    fb = f"b/{path}" if b_exists else "/dev/null"
    for line in difflib.unified_diff(al, bl, fa, fb, n=3):
        m = re.match(r"^@@ -(\d+)(,\d+)? \+(\d+)(,\d+)? @@(.*)$", line.rstrip("\n"))
        if m:
            s1 = int(m.group(1)) + (a_off if int(m.group(1)) else 0)
            s2 = int(m.group(3)) + (b_off if int(m.group(3)) else 0)
            line = f"@@ -{s1}{m.group(2) or ''} +{s2}{m.group(4) or ''} @@{m.group(5)}\n"
        out.append(line)
    return "".join(out)


def first_url(*texts) -> str | None:
    for t in texts:
        if t:
            m = URL_RE.search(t)
            if m:
                return m.group(0).rstrip(".,;")
    return None


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def match_datasheet(candidates: list[str], names: list[str], url: str | None) -> str | None:
    """Pick a datasheets/*.pdf whose stem matches the part name / value / url basename."""
    keys = [_norm(n) for n in names if n and len(_norm(n)) >= 4]
    if url:
        base = os.path.splitext(os.path.basename(url.split("?")[0]))[0]
        if len(_norm(base)) >= 4:
            keys.append(_norm(base))
    best, best_len = None, 0
    for c in candidates:
        if not c.lower().endswith(".pdf"):
            continue
        stem = _norm(os.path.splitext(os.path.basename(c))[0])
        if len(stem) < 4:
            continue
        for k in keys:
            if stem == k or stem in k or k in stem:
                score = min(len(stem), len(k))
                if score > best_len:
                    best, best_len = c, score
    return best


def resolve_model(path_raw: str) -> tuple[str | None, str | None]:
    """Return (repo-relative path or None, reason-if-not-local)."""
    p = path_raw.replace("\\", "/")
    m = re.match(r"^\$\{KICAD_LIBS_DIR\}/?(.*)$", p)
    if m:
        return os.path.normpath(m.group(1)), None
    if NOT_LOCAL_VARS.match(p) or p.startswith("${"):
        return None, "not-local (KiCad stock library variable)"
    if os.path.isabs(p):
        return None, "absolute path"
    return os.path.normpath(p), None


def model_candidates(rel: str) -> list[str]:
    """KiCad falls back between .wrl and .step with the same stem."""
    stem, ext = os.path.splitext(rel)
    alts = [rel]
    for e in (".step", ".STEP", ".stp", ".wrl"):
        if stem + e not in alts:
            alts.append(stem + e)
    return alts


def write(path: str, data, mode="w"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if isinstance(data, bytes):
        mode = "wb"
    with open(path, mode, **({} if "b" in mode else {"encoding": "utf-8"})) as fh:
        fh.write(data)


# ---------------------------------------------------------------------------
# item discovery
# ---------------------------------------------------------------------------

class Item:
    def __init__(self, kind, library, name, path, status):
        self.kind, self.library, self.name, self.path, self.status = kind, library, name, path, status
        self.base_text = self.head_text = None     # whole file texts
        self.base_node = self.head_node = None     # item nodes
        self.base_lib = self.head_lib = None       # symbol libraries {name: node}
        self.base_root = self.head_root = None
        self.model_changed_paths: set[str] = set()
        self.warnings: list[str] = []
        self.reasons: list[str] = []

    @property
    def id(self):
        return f"{self.kind}:{self.library}:{self.name}"

    @property
    def slug(self):
        return slugify(self.kind, self.library, self.name)


def discover(git: Git, base: str, head: str) -> tuple[list[Item], set[str]]:
    changes = git.changed(base, head)
    items: dict[str, Item] = {}
    changed_models = {p for st, p in changes if p.startswith("lib_3d/")}
    for st, path in changes:
        m = FP_RE.match(path)
        if m:
            status = {"A": "added", "D": "deleted"}.get(st, "modified")
            it = Item("footprint", m.group("lib"), m.group("name"), path, status)
            it.base_text = git.text(base, path) if status != "added" else None
            it.head_text = git.text(head, path) if status != "deleted" else None
            try:
                it.base_node = parse(it.base_text) if it.base_text else None
                it.head_node = parse(it.head_text) if it.head_text else None
            except Exception as e:  # keep going, report
                it.warnings.append(f"parse: {e}")
            if status == "modified" and it.base_node is not None and it.head_node is not None \
                    and dumps(it.base_node) == dumps(it.head_node):
                log(f"skip {path}: only uuid/whitespace changes")
                continue
            if it.head_node is not None:
                it.name = str(it.head_node.arg(0, it.name)) or it.name
            items[it.id] = it
            continue
        m = SYM_RE.match(path)
        if m:
            lib = m.group("lib")
            bt = git.text(base, path) if st != "A" else None
            ht = git.text(head, path) if st != "D" else None
            try:
                broot = parse(bt) if bt else None
                hroot = parse(ht) if ht else None
            except Exception as e:
                log(f"parse error in {path}: {e}")
                it = Item("symbol", lib, "(library)", path, "modified")
                it.warnings.append(f"parse: {e}")
                items[it.id] = it
                continue
            blib = symmod.parse_library(broot) if broot is not None else {}
            hlib = symmod.parse_library(hroot) if hroot is not None else {}
            changed_names = set()
            for name in sorted(set(blib) | set(hlib)):
                b, h = blib.get(name), hlib.get(name)
                if b is not None and h is not None and dumps(b) == dumps(h):
                    continue
                changed_names.add(name)
            # derived symbols whose parent changed are visually changed too
            for name, h in hlib.items():
                ext = h.value("extends")
                if name not in changed_names and ext and ext in changed_names and name in blib:
                    changed_names.add(name)
            for name in sorted(changed_names):
                b, h = blib.get(name), hlib.get(name)
                status = "added" if b is None else "deleted" if h is None else "modified"
                it = Item("symbol", lib, name, path, status)
                it.base_text, it.head_text = bt, ht
                it.base_node, it.head_node = b, h
                it.base_lib, it.head_lib = blib, hlib
                it.base_root, it.head_root = broot, hroot
                if b is not None and h is not None and dumps(b) == dumps(h):
                    it.reasons.append(f"parent symbol '{h.value('extends')}' changed")
                items[it.id] = it
    # footprints whose 3D model file changed (even if the .kicad_mod did not)
    if changed_models:
        for path in git.ls(head, "lib_fp"):
            m = FP_RE.match(path)
            if not m:
                continue
            txt = git.text(head, path) or ""
            if "(model" not in txt:
                continue
            hits = set()
            for raw in re.findall(r'\(model\s+"([^"]+)"', txt):
                rel, _ = resolve_model(raw)
                if rel is None:
                    continue
                for cand in model_candidates(rel):
                    if cand in changed_models:
                        hits.add(cand)
            if not hits:
                continue
            key = f"footprint:{m.group('lib')}:{m.group('name')}"
            node = parse(txt)
            key = f"footprint:{m.group('lib')}:{node.arg(0, m.group('name'))}"
            if key in items:
                items[key].model_changed_paths |= hits
                continue
            it = Item("footprint", m.group("lib"), str(node.arg(0, m.group("name"))), path, "modified")
            it.head_text, it.head_node = txt, node
            it.base_text = git.text(base, path)
            it.base_node = parse(it.base_text) if it.base_text else None
            if it.base_node is None:
                it.status = "added"
            it.model_changed_paths |= hits
            it.reasons.append("3D model file changed: " + ", ".join(sorted(hits)))
            items[it.id] = it
    order = {"footprint": 0, "symbol": 1}
    return sorted(items.values(), key=lambda i: (order[i.kind], i.library, i.name)), changed_models


def referenced_models(git: Git, head: str) -> set[str]:
    refs = set()
    for path in git.ls(head, "lib_fp"):
        if not path.endswith(".kicad_mod"):
            continue
        for raw in re.findall(r'\(model\s+"([^"]+)"', git.text(head, path) or ""):
            rel, _ = resolve_model(raw)
            if rel:
                refs.update(model_candidates(rel))
    return refs


# ---------------------------------------------------------------------------
# per-item processing
# ---------------------------------------------------------------------------

def symbol_source(root, lib: dict, node, text: str) -> str:
    """Standalone .kicad_sym containing just this symbol (plus its parent if derived)."""
    head_parts = []
    for key in ("version", "generator", "generator_version"):
        c = root.child(key)
        if c is not None:
            head_parts.append(text[c.start:c.end])
    body = []
    ext = node.value("extends")
    if ext and ext in lib:
        p = lib[ext]
        body.append("\t" + text[p.start:p.end])
    body.append("\t" + text[node.start:node.end])
    return "(kicad_symbol_lib\n\t" + "\n\t".join(head_parts) + "\n" + "\n".join(body) + "\n)\n"


class Renderer:
    def __init__(self, args, git: Git, base_sha: str, head_sha: str, out: str):
        self.args, self.git, self.base_sha, self.head_sha, self.out = args, git, base_sha, head_sha, out
        self.datasheets = git.ls(head_sha, "datasheets")
        self.png_ok = True
        self._model_files: dict[str, dict] = {}
        self.stock = None
        if args.fetch_stock_models:
            import stock
            self.stock = stock.StockFetcher(tag=args.stock_models_tag, max_file_mb=args.stock_max_file_mb,
                                            max_total_mb=args.stock_max_total_mb,
                                            cache_dir=args.stock_models_dir)
        self._model_n = 0
        self.tmpdir = tempfile.mkdtemp(prefix="cr_render_")
        try:
            import cairosvg  # noqa: F401
        except Exception:
            self.png_ok = False
        try:
            import model3d  # noqa: F401
            self.model3d = model3d
        except Exception as e:
            self.model3d = None
            self.model3d_err = str(e)

    # -- rasterisation ----------------------------------------------------------
    def png(self, svg: str, path: str, warnings: list[str]) -> str | None:
        if not self.png_ok:
            return None
        try:
            import cairosvg
            cairosvg.svg2png(bytestring=svg.encode("utf-8"), write_to=path)
            return path
        except Exception as e:
            warnings.append(f"render: PNG conversion failed: {e}")
            return None

    def diff_png(self, base_png: str, head_png: str, out_path: str, background: str, warnings,
                 paper=()) -> dict | None:
        try:
            import numpy as np
            from PIL import Image
        except Exception as e:
            warnings.append(f"render: diff.png skipped ({e})")
            return None
        a = np.asarray(Image.open(base_png).convert("RGB")).astype(np.int16)
        b = np.asarray(Image.open(head_png).convert("RGB")).astype(np.int16)
        if a.shape != b.shape:
            h, w = min(a.shape[0], b.shape[0]), min(a.shape[1], b.shape[1])
            a, b = a[:h, :w], b[:h, :w]
            warnings.append("render: base/head PNG size mismatch; diff cropped")
        bg = np.array([int(background[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.int16)
        def ink(img):
            m = np.abs(img - bg).max(axis=2) > 24
            for pc in paper:  # e.g. symbol body fill: treat as background, not ink
                col = np.array([int(pc[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.int16)
                m &= np.abs(img - col).max(axis=2) > 24
            return m
        ink_a, ink_b = ink(a), ink(b)
        changed = np.abs(a - b).max(axis=2) > 40
        # RGBA: fully transparent wherever nothing changed, so it can be laid over either render
        out = np.zeros(a.shape[:2] + (4,), dtype=np.uint8)
        added = changed & ink_b & ~ink_a
        removed = changed & ink_a & ~ink_b
        both = changed & ink_a & ink_b
        out[added] = [0, 200, 60, 255]
        out[removed] = [230, 40, 40, 255]
        out[both] = [240, 170, 0, 255]
        Image.fromarray(out, "RGBA").save(out_path, optimize=True)
        return {"added_px": int(added.sum()), "removed_px": int(removed.sum()), "changed_px": int(both.sum())}

    # -- common -----------------------------------------------------------------
    def process(self, it: Item) -> dict:
        d = os.path.join(self.out, "items", it.slug)
        os.makedirs(d, exist_ok=True)
        rel = lambda p: os.path.relpath(p, self.out).replace(os.sep, "/") if p else None  # noqa: E731
        entry = {
            "id": it.id, "slug": it.slug, "kind": it.kind, "library": it.library, "name": it.name,
            "status": it.status, "path": it.path,
            "line_range": {"head": None, "base": None},
            "properties": {"head": None, "base": None},
            "datasheet": {"url": None, "local": None, "file": None},
            "model3d": [],
            "stats": {"head": None, "base": None},
            "renders": {"head": None, "base": None},
            "diff_png": None,
            "glb": {"head": None, "base": None},
            "text_diff": None,
            "source": {"head": None, "base": None},
            "warnings": it.warnings,
        }
        if it.reasons:
            entry["change_reasons"] = it.reasons
        for side, node in (("head", it.head_node), ("base", it.base_node)):
            if node is not None:
                entry["line_range"][side] = [node.line_start, node.line_end]
        if it.kind == "footprint":
            self._footprint(it, entry, d, rel)
        else:
            self._symbol(it, entry, d, rel)
        # datasheet
        props = entry["properties"]["head"] or entry["properties"]["base"] or {}
        ds = props.get("Datasheet", "")
        url = ds if URL_RE.match(ds or "") else first_url(props.get("Description"), props.get("__descr"))
        if props.get("__descr") is not None:
            for side in ("head", "base"):
                if entry["properties"][side]:
                    entry["properties"][side].pop("__descr", None)
        local = match_datasheet(self.datasheets, [it.name, props.get("Value", "")], url)
        if ds and not URL_RE.match(ds) and ds not in ("~", "") and ds.startswith("datasheets/"):
            local = ds if ds in self.datasheets else local
        entry["datasheet"]["url"] = url
        if local:
            entry["datasheet"]["local"] = local
            blob = self.git.show(self.head_sha, local)
            if blob:
                p = os.path.join(d, "datasheet.pdf")
                write(p, blob)
                entry["datasheet"]["file"] = rel(p)
        return entry

    # -- footprints ---------------------------------------------------------------
    def _footprint(self, it: Item, entry, d, rel):
        fps = {}
        for side, node in (("head", it.head_node), ("base", it.base_node)):
            if node is None:
                continue
            m = fpmod.Footprint(node)
            fps[side] = m
            props = dict(m.properties)
            props.setdefault("Reference", "REF**")
            props["__descr"] = m.descr
            props["Footprint"] = f"{it.library}:{m.name}"
            if m.descr:
                props["descr"] = m.descr
            if m.tags:
                props["tags"] = m.tags
            entry["properties"][side] = props
            entry["stats"][side] = m.stats()
        # shared view box
        from geom import BBox
        bb = BBox()
        for m in fps.values():
            bb.add_box(fpmod.footprint_bbox(m))
        vb = fpmod.viewbox(bb)
        scale = fpmod.px_scale(vb, target=self.args.png_size)
        entry["view"] = {"viewbox": [round(v, 4) for v in vb], "px_per_mm": round(scale, 4), "units": "mm",
                         "y_axis": "down"}
        pngs = {}
        for side, m in fps.items():
            svg, layers = fpmod.render_footprint(m, vb, scale)
            svg_p = os.path.join(d, f"{side}.svg")
            write(svg_p, svg)
            png_p = self.png(svg, os.path.join(d, f"{side}.png"), it.warnings)
            pngs[side] = png_p
            lay = {}
            for layer, lsvg in layers.items():
                p = os.path.join(d, f"{side}_{layer}.svg")
                write(p, lsvg)
                lay[layer] = rel(p)
            entry["renders"][side] = {"svg": rel(svg_p), "png": rel(png_p), "layers": lay}
            gp = os.path.join(d, f"{side}_geom.json")
            write(gp, json.dumps(fpmod.geom_json(m, vb), indent=1))
            entry.setdefault("geom", {"head": None, "base": None})[side] = rel(gp)
        if it.status == "modified" and pngs.get("head") and pngs.get("base"):
            p = os.path.join(d, "diff.png")
            st = self.diff_png(pngs["base"], pngs["head"], p, fpmod.BACKGROUND, it.warnings)
            if st is not None:
                entry["diff_png"] = rel(p)
                entry["diff_stats"] = st
        # sources + text diff
        ext = ".kicad_mod"
        if it.head_text is not None:
            write(os.path.join(d, "head" + ext), it.head_text)
            entry["source"]["head"] = f"items/{it.slug}/head{ext}"
        if it.base_text is not None:
            write(os.path.join(d, "base" + ext), it.base_text)
            entry["source"]["base"] = f"items/{it.slug}/base{ext}"
        if it.base_text != it.head_text:
            patch = unified_diff(it.base_text or "", it.head_text or "", it.path,
                                 a_exists=it.base_text is not None, b_exists=it.head_text is not None)
            write(os.path.join(d, "diff.patch"), patch)
            entry["text_diff"] = f"items/{it.slug}/diff.patch"
        # symbols (anywhere in the head libraries) that use this footprint -> pinout cross-check
        if it.head_node is not None:
            self._related_symbols(it, entry, d, rel)
        # 3D models
        self._models(it, entry, fps, d, rel)

    def _sym_index(self):
        """{footprint 'Lib:Name': [(lib, symbol name, root, libdict, node, text)]} over head lib_sch."""
        if getattr(self, "_symidx", None) is None:
            self._symidx = {}
            for path in self.git.ls(self.head_sha, "lib_sch"):
                m = SYM_RE.match(path)
                if not m:
                    continue
                text = self.git.text(self.head_sha, path) or ""
                try:
                    root = parse(text)
                except Exception:
                    continue
                lib = symmod.parse_library(root)
                for name, node in lib.items():
                    for p in node.children("property"):
                        if str(p.arg(0, "")) == "Footprint" and p.arg(1):
                            self._symidx.setdefault(str(p.arg(1)), []).append(
                                (m.group("lib"), name, root, lib, node, text, path))
        return self._symidx

    def _related_symbols(self, it: Item, entry, d, rel):
        key = f"{it.library}:{it.name}"
        out = []
        for lib, name, root, libd, node, text, path in self._sym_index().get(key, []):
            p = os.path.join(d, "related", f"{re.sub(r'[^A-Za-z0-9._-]', '_', lib + '__' + name)}.kicad_sym")
            write(p, symbol_source(root, libd, node, text))
            st = symmod.Symbol(node, libd).stats()
            out.append({"id": f"symbol:{lib}:{name}", "path": path, "source": rel(p),
                        "pin_count": st["pin_count"],
                        "pins": [{"number": q["number"], "name": q["name"], "type": q["type"]} for q in st["pins"]]})
        entry["related_symbols"] = out

    def _model_file(self, sha: str, rel_path: str) -> tuple[str | None, str | None]:
        """Materialise a model blob from a git revision; returns (tmp file, repo path used)."""
        for cand in model_candidates(rel_path):
            blob = self.git.show(sha, cand)
            if blob is not None:
                p = os.path.join(self.tmpdir, sha[:12], cand)
                if not os.path.exists(p):
                    write(p, blob)
                return p, cand
        return None, None

    def _embedded_file(self, m, name: str, side: str) -> str | None:
        e = m.embedded.get(name)
        if not e or not e["data"]:
            return None
        p = os.path.join(self.tmpdir, "embedded", side, re.sub(r"[^A-Za-z0-9._-]", "_", m.name), name)
        if not os.path.exists(p):
            try:
                write(p, fpmod.decode_embedded(e["data"]))
            except Exception as ex:
                log(f"embedded decode failed for {name}: {ex}")
                return None
        return p

    def _models(self, it: Item, entry, fps, d, rel):
        head = fps.get("head")
        base = fps.get("base")
        sha_of = {"head": self.head_sha, "base": self.base_sha}
        self._model_n = 0
        by_side = {"head": None, "base": None}
        for side in ("head", "base"):
            if fps.get(side) is not None:
                by_side[side] = self._model_records(it, fps, side, d, rel, sha_of)
        entry["model3d_by_side"] = by_side
        entry["model3d"] = by_side["head"] if by_side["head"] is not None else by_side["base"]
        self._glb(it, entry, fps, d, rel, sha_of)

    def _model_records(self, it: Item, fps, side, d, rel, sha_of):
        head = fps.get("head")
        base = fps.get("base")
        src = fps[side]
        other = base if side == "head" else head
        recs = []
        warn = side == "head" or head is None  # only warn once per item
        for i, mdl in enumerate(src.models):
            resolved, reason = resolve_model(mdl["path"])
            rec = {"path_raw": mdl["path"], "resolved": None, "exists": False, "changed": False,
                   "offset": mdl["offset"], "scale": mdl["scale"], "rotate": mdl["rotate"],
                   "hide": mdl["hidden"], "file": None, "side": side}
            if mdl["path"].startswith("kicad-embed://"):
                ename = mdl["path"][len("kicad-embed://"):]
                rec["embedded"] = ename
                local = self._embedded_file(src, ename, side)
                rec["exists"] = local is not None
                if local is None and warn:
                    it.warnings.append(f"3d: embedded model '{ename}' missing from embedded_files")
                else:
                    rec["file"] = self._copy_model(local, os.path.splitext(ename)[1].lower(), d, rel)
                if other is not None:
                    rec["changed"] = (other.embedded.get(ename, {}).get("data") != src.embedded.get(ename, {}).get("data"))
                else:
                    rec["changed"] = it.status in ("added", "deleted")
            elif resolved is None and self.stock is not None and self.stock.parse(mdl["path"]):
                rec["not_local"] = True
                local, info = self.stock.fetch(mdl["path"])
                rec["stock"] = info
                rec["exists"] = local is not None
                if local is None:
                    it.warnings.append(f"3d: stock model download failed: {info.get('error')}")
                else:
                    rec["resolved"] = f"kicad-packages3D@{info['tag']}/{info['path']}"
                    rec["file"] = self._copy_model(local, os.path.splitext(info["path"])[1].lower(), d, rel)
                if other is not None:
                    om = other.models[i] if i < len(other.models) else None
                    rec["changed"] = om is None or any(om[k] != mdl[k] for k in ("path", "offset", "rotate", "scale"))
                else:
                    rec["changed"] = it.status in ("added", "deleted")
            elif resolved is None:
                rec["not_local"] = True
                if warn:
                    hint = " (use --fetch-stock-models)" if "stock" in (reason or "") else ""
                    it.warnings.append(f"3d: model '{mdl['path']}' is {reason}; not rendered{hint}")
            else:
                local, used = self._model_file(sha_of[side], resolved)
                rec["resolved"] = used or resolved
                rec["exists"] = local is not None
                if used and used != resolved and warn:
                    it.warnings.append(f"3d: '{resolved}' not found, using '{used}' (KiCad wrl/step fallback)")
                if local is None:
                    it.warnings.append(f"3d: model file not found in {side}: {resolved}")
                else:
                    rec["file"] = self._copy_model(local, os.path.splitext(used)[1].lower(), d, rel)
                changed = bool({resolved, used} & (it.model_changed_paths | self.changed_models))
                if other is not None:
                    # model transform or path changed between base and head?
                    om = other.models[i] if i < len(other.models) else None
                    if om is None or om["path"] != mdl["path"] or om["offset"] != mdl["offset"] \
                            or om["rotate"] != mdl["rotate"] or om["scale"] != mdl["scale"]:
                        changed = True
                rec["changed"] = changed
            recs.append(rec)
        return recs

    def _copy_model(self, local, ext, d, rel):
        """Copy a model file into the item dir once (identical base/head blobs share one file)."""
        import hashlib
        h = hashlib.sha1(open(local, "rb").read()).hexdigest()
        seen = self._model_files.setdefault(d, {})
        if h in seen:
            return seen[h]
        self._model_n += 1
        dst = os.path.join(d, f"model_{self._model_n}{ext or '.step'}")
        shutil.copyfile(local, dst)
        seen[h] = rel(dst)
        return seen[h]

    def _glb(self, it: Item, entry, fps, d, rel, sha_of):
        if self.args.no_3d:
            return
        if self.model3d is None:
            it.warnings.append(f"3d: GLB export unavailable ({self.model3d_err})")
            return
        for side, m in fps.items():
            files = []
            for mdl in m.models:
                if mdl["hidden"]:
                    continue
                if mdl["path"].startswith("kicad-embed://"):
                    local = self._embedded_file(m, mdl["path"][len("kicad-embed://"):], side)
                else:
                    resolved, _ = resolve_model(mdl["path"])
                    if resolved is None:
                        if self.stock is None or not self.stock.parse(mdl["path"]):
                            continue
                        local, _info = self.stock.fetch(mdl["path"])
                    else:
                        local, _used = self._model_file(sha_of[side], resolved)
                if local:
                    files.append((local, mdl))
            p = os.path.join(d, f"{side}.glb")
            try:
                warns = self.model3d.build_glb(m, files, p, max_bytes=self.args.glb_max_mb * 1024 * 1024)
                it.warnings.extend(f"3d ({side}): {w}" for w in warns)
                entry["glb"][side] = rel(p)
                if not self.args.no_preview:
                    pp = os.path.join(d, f"{side}_3d.png")
                    self.model3d.render_preview(p, pp, size=900)
                    entry.setdefault("preview_3d", {"head": None, "base": None})[side] = rel(pp)
            except Exception as e:
                it.warnings.append(f"3d ({side}): GLB export failed: {e}")
                log(traceback.format_exc())

    # -- symbols -------------------------------------------------------------------
    def _symbol(self, it: Item, entry, d, rel):
        syms = {}
        layouts = {}
        for side, node, lib in (("head", it.head_node, it.head_lib), ("base", it.base_node, it.base_lib)):
            if node is None:
                continue
            s = symmod.Symbol(node, lib)
            syms[side] = s
            props = {k: v for k, v in s.properties.items()}
            entry["properties"][side] = props
            entry["stats"][side] = s.stats()
            layouts[side] = symmod.unit_layout(s)
        slots, vb = symmod.shared_layout(list(layouts.values()))
        w, h = vb[2] - vb[0], vb[3] - vb[1]
        scale = min(80.0, self.args.png_size / max(w, h, 1e-3))
        entry["view"] = {"viewbox": [round(v, 4) for v in vb], "px_per_mm": round(scale, 4), "units": "mm",
                         "y_axis": "down", "unit_offsets": {str(k): round(v, 4) for k, v in slots.items()}}
        pngs = {}
        for side, s in syms.items():
            svg = symmod.render_symbol(layouts[side], slots, vb, scale, s)
            svg_p = os.path.join(d, f"{side}.svg")
            write(svg_p, svg)
            pngs[side] = self.png(svg, os.path.join(d, f"{side}.png"), it.warnings)
            entry["renders"][side] = {"svg": rel(svg_p), "png": rel(pngs[side]), "layers": {}}
        if it.status == "modified" and pngs.get("head") and pngs.get("base"):
            p = os.path.join(d, "diff.png")
            st = self.diff_png(pngs["base"], pngs["head"], p, symmod.BACKGROUND, it.warnings,
                               paper=(symmod.C_BODY_BG,))
            if st is not None:
                entry["diff_png"] = rel(p)
                entry["diff_stats"] = st
        # sources: standalone libraries with just this symbol
        bt = ht = ""
        if it.head_node is not None:
            src = symbol_source(it.head_root, it.head_lib, it.head_node, it.head_text)
            write(os.path.join(d, "head.kicad_sym"), src)
            entry["source"]["head"] = f"items/{it.slug}/head.kicad_sym"
            ht = it.head_text[it.head_node.start:it.head_node.end]
        if it.base_node is not None:
            src = symbol_source(it.base_root, it.base_lib, it.base_node, it.base_text)
            write(os.path.join(d, "base.kicad_sym"), src)
            entry["source"]["base"] = f"items/{it.slug}/base.kicad_sym"
            bt = it.base_text[it.base_node.start:it.base_node.end]
        if bt != ht:
            # include the leading indentation so the fragment lines up with the file
            def frag(text, node):
                if node is None:
                    return "", 0
                ls = text.rfind("\n", 0, node.start) + 1
                return text[ls:node.end] + "\n", node.line_start - 1
            (fa, oa), (fb, ob) = frag(it.base_text, it.base_node), frag(it.head_text, it.head_node)
            patch = unified_diff(fa, fb, it.path, oa, ob, a_exists=it.base_text is not None,
                                 b_exists=it.head_text is not None)
            write(os.path.join(d, "diff.patch"), patch)
            entry["text_diff"] = f"items/{it.slug}/diff.patch"
        # linked footprints in the same PR are handled by the manifest consumer; record the link
        fpref = (entry["properties"]["head"] or entry["properties"]["base"] or {}).get("Footprint", "")
        if fpref:
            entry["footprint_ref"] = fpref


def kicad_version(items: list[Item]) -> str:
    for it in items:
        for node in (it.head_root, it.head_node):
            if node is not None and node.value("generator_version"):
                return str(node.value("generator_version"))
    return "10.0"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", default=".", help="path to the kicad-libs git repo")
    ap.add_argument("--base", required=True, help="base ref (diff is base...head, i.e. from the merge base)")
    ap.add_argument("--head", required=True, help="head ref")
    ap.add_argument("--out", required=True, help="output directory (static site root)")
    ap.add_argument("--pr", type=int, default=None, help="PR number for the manifest")
    ap.add_argument("--repo-name", default=os.environ.get("GITHUB_REPOSITORY", REPO_NAME_DEFAULT))
    ap.add_argument("--no-3d", action="store_true", help="skip GLB generation")
    ap.add_argument("--fetch-stock-models", action="store_true",
                    help="download ${KICAD*_3DMODEL_DIR} models from gitlab.com/kicad/libraries/kicad-packages3D "
                         "at a pinned tag (https only, cached in ~/.cache/cr-render)")
    ap.add_argument("--stock-models-tag", default=None, help="override the pinned kicad-packages3D tag "
                    "(default: per KiCad major from render/stock_models_tag.txt)")
    ap.add_argument("--stock-models-dir", default=os.environ.get("CR_STOCK_MODELS_DIR"),
                    help="download/cache dir (env CR_STOCK_MODELS_DIR; default ~/.cache/cr-render/kicad-packages3D)")
    ap.add_argument("--stock-max-file-mb", type=float, default=25.0)
    ap.add_argument("--stock-max-total-mb", type=float, default=300.0)
    ap.add_argument("--no-preview", action="store_true", help="skip the software-rendered 3D preview PNGs")
    ap.add_argument("--png-size", type=int, default=1600, help="longest PNG side in px (default 1600)")
    ap.add_argument("--glb-max-mb", type=float, default=5.0, help="re-tessellate coarser above this size")
    ap.add_argument("--use-kicad-cli", action="store_true",
                    help="(optional) also export reference SVGs with kicad-cli if it is on PATH")
    ap.add_argument("--clean", action="store_true", help="delete OUT/items before writing")
    args = ap.parse_args(argv)

    t0 = time.time()
    git = Git(os.path.abspath(args.repo))
    base_sha, head_sha = git.rev(args.base), git.rev(args.head)
    merge_base = git.run("merge-base", base_sha, head_sha, check=False).strip() or base_sha
    out = os.path.abspath(args.out)
    if args.clean and os.path.isdir(os.path.join(out, "items")):
        shutil.rmtree(os.path.join(out, "items"))
    os.makedirs(out, exist_ok=True)

    items, changed_models = discover(git, merge_base, head_sha)
    log(f"{len(items)} changed items between {merge_base[:10]} and {head_sha[:10]}")
    r = Renderer(args, git, merge_base, head_sha, out)
    r.changed_models = changed_models
    entries = []
    for it in items:
        t = time.time()
        try:
            entries.append(r.process(it))
        except Exception as e:
            log(traceback.format_exc())
            entries.append({"id": it.id, "slug": it.slug, "kind": it.kind, "library": it.library, "name": it.name,
                            "status": it.status, "path": it.path, "warnings": it.warnings + [f"render failed: {e}"]})
        log(f"  {it.status:8s} {it.id}  ({time.time() - t:.1f}s)")

    if args.use_kicad_cli:
        kc = shutil.which("kicad-cli")
        if not kc:
            log("--use-kicad-cli: kicad-cli not found; built-in renderer only")
        else:
            import kicad_cli  # noqa: E402
            kicad_cli.export(kc, git, head_sha, merge_base, items, entries, out)

    manifest = {
        "schema": 1,
        "repo": args.repo_name,
        "pr": args.pr,
        "base_sha": merge_base,
        "base_ref_sha": base_sha,
        "head_sha": head_sha,
        "generated_at": _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat(),
        "kicad_version": kicad_version(items),
        "generator": "cr_render.py (built-in SVG renderer)",
        "changed_3d_files": sorted(changed_models),
        "unreferenced_changed_3d_files": sorted(changed_models - referenced_models(git, head_sha)),
        "items": entries,
    }
    write(os.path.join(out, "manifest.json"), json.dumps(manifest, indent=2, ensure_ascii=False))
    shutil.rmtree(r.tmpdir, ignore_errors=True)
    log(f"wrote {os.path.join(out, 'manifest.json')} ({len(entries)} items) in {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
