#!/usr/bin/env python3
"""Build a contract-shaped mock OUT dir from a git range, for tests and local runs.

Stand-in for the render step (tools/component-review/render/) when its output is
not available: renders are placeholder PNGs, stats are minimal.

  python3 tests/make_mock_out.py --repo . --base origin/main --head HEAD --out /tmp/mock-out
"""

from __future__ import annotations

import argparse
import json
import os
import re
import struct
import subprocess
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import sexpr  # noqa: E402


def tiny_png(w=64, h=48, rgb=(40, 40, 40)) -> bytes:
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def git(repo, *a):
    return subprocess.run(["git", "-C", repo, *a], check=True, capture_output=True, text=True).stdout


def slugify(s):
    return re.sub(r"[^A-Za-z0-9._-]", "_", s)


def props_of(node):
    return {p.atom(0): p.atom(1, "") for p in node.children("property")}


def symbol_blocks(text):
    """Yield (name, start_line, end_line, block_text) for top-level symbols."""
    root = sexpr.parse(text)
    lines = text.splitlines()
    syms = root.children("symbol")
    for i, s in enumerate(syms):
        start = s.line
        # end = line before next symbol, or before the closing paren of the lib
        end = (syms[i + 1].line - 1) if i + 1 < len(syms) else len(lines) - 1
        while end > start and not lines[end - 1].strip().startswith(")"):
            end -= 1
        yield s.atom(0), start, end, "\n".join(lines[start - 1:end]) + "\n", s


def build(repo, base, head, out, pr=None):
    os.makedirs(out, exist_ok=True)
    changed = [l.split("\t") for l in git(repo, "diff", "--name-status", f"{base}..{head}").splitlines()]
    items = []
    for st, path in ((c[0], c[-1]) for c in changed):
        status = {"A": "added", "M": "modified", "D": "deleted"}.get(st[0], "modified")
        if path.endswith(".kicad_mod"):
            text = git(repo, "show", f"{head}:{path}") if status != "deleted" else None
            library = os.path.basename(os.path.dirname(path))[:-len(".pretty")]
            name = os.path.basename(path)[:-len(".kicad_mod")]
            entries = [("footprint", library, name, text, (1, len(text.splitlines())) if text else None,
                        sexpr.parse(text) if text else None)]
        elif path.endswith(".kicad_sym"):
            text = git(repo, "show", f"{head}:{path}")
            library = os.path.basename(path)[:-len(".kicad_sym")]
            entries = []
            header = "(kicad_symbol_lib\n\t(version 20251024)\n\t(generator \"kicad_symbol_editor\")\n"
            for name, s, e, block, node in symbol_blocks(text):
                entries.append(("symbol", library, name, header + block + ")\n", (s, e), node))
        else:
            continue
        for kind, library, name, src, lr, node in entries:
            iid = f"{kind}:{library}:{name}"
            slug = slugify(f"{kind}__{library}__{name}")
            d = os.path.join(out, "items", slug)
            os.makedirs(d, exist_ok=True)
            ext = "kicad_mod" if kind == "footprint" else "kicad_sym"
            with open(os.path.join(d, f"head.{ext}"), "w") as f:
                f.write(src)
            with open(os.path.join(d, "head.png"), "wb") as f:
                f.write(tiny_png())
            props = props_of(node) if node else {}
            url = props.get("Datasheet") or ""
            if kind == "footprint" and node is not None:
                m = re.search(r"https?://\S+?(?=[)\s]|$)", node.value("descr", default="") or "")
                url = url or (m.group(0) if m else "")
            models = []
            for mnode in (node.children("model") if kind == "footprint" and node else []):
                raw = mnode.atom(0)
                resolved = raw.replace("${KICAD_LIBS_DIR}/", "", 1) if raw.startswith("${KICAD_LIBS_DIR}/") else None
                models.append({"path_raw": raw, "resolved": resolved,
                               "exists": os.path.exists(os.path.join(repo, resolved)) if resolved else False,
                               "changed": True})
            items.append({
                "id": iid, "slug": slug, "kind": kind, "library": library, "name": name, "status": status,
                "path": path, "line_range": {"head": list(lr) if lr else None, "base": None},
                "properties": {"head": props, "base": None},
                "datasheet": {"url": url or None, "local": None, "file": None},
                "model3d": models, "stats": {"head": {}, "base": None},
                "renders": {"head": {"svg": None, "png": f"items/{slug}/head.png", "layers": {}}, "base": None},
                "diff_png": None, "glb": {"head": None, "base": None}, "text_diff": None,
                "source": {"head": f"items/{slug}/head.{ext}", "base": None},
                "warnings": ["mock: renders are placeholders"],
            })
    manifest = {"schema": 1, "repo": "PantsForBirds/kicad-libs", "pr": pr,
                "base_sha": git(repo, "rev-parse", base).strip(), "head_sha": git(repo, "rev-parse", head).strip(),
                "generated_at": "1970-01-01T00:00:00Z", "kicad_version": "mock", "items": items}
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    return manifest


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    ap.add_argument("--base", default="origin/main")
    ap.add_argument("--head", default="HEAD")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    m = build(a.repo, a.base, a.head, a.out)
    print(f"mock OUT with {len(m['items'])} items at {a.out}")
