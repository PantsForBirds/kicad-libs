"""Optional: reference SVGs exported with kicad-cli (only when --use-kicad-cli and kicad-cli is on PATH).

These are *extra* files (items/<slug>/kicad_cli_<side>.svg); kicad-cli picks its own page frame,
so they do not share the built-in renders' viewBox and are not used for the overlay/diff.
"""

from __future__ import annotations

import glob
import os
import shutil
import subprocess
import tempfile


def _run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode == 0, (r.stderr or r.stdout).strip()


def export(kc, git, head_sha, base_sha, items, entries, out):
    by_id = {e["id"]: e for e in entries}
    for it in items:
        e = by_id.get(it.id)
        if e is None:
            continue
        for side, text in (("head", it.head_text), ("base", it.base_text)):
            if text is None:
                continue
            with tempfile.TemporaryDirectory() as td:
                if it.kind == "footprint":
                    lib = os.path.join(td, f"{it.library}.pretty")
                    os.makedirs(lib)
                    with open(os.path.join(lib, f"{it.name}.kicad_mod"), "w", encoding="utf-8") as fh:
                        fh.write(text)
                    ok, msg = _run([kc, "fp", "export", "svg", "--fp", it.name, "--output", td, lib])
                else:
                    src = os.path.join(out, e["source"][side]) if e.get("source", {}).get(side) else None
                    if not src:
                        continue
                    ok, msg = _run([kc, "sym", "export", "svg", "--symbol", it.name, "--output", td, src])
                svgs = sorted(glob.glob(os.path.join(td, "*.svg")))
                if not ok or not svgs:
                    e.setdefault("warnings", []).append(f"kicad-cli ({side}): {msg[:300]}")
                    continue
                dst = os.path.join(out, "items", e["slug"], f"kicad_cli_{side}.svg")
                shutil.copyfile(svgs[0], dst)
                e.setdefault("renders_kicad_cli", {})[side] = os.path.relpath(dst, out).replace(os.sep, "/")
