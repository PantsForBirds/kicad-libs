"""Optional: run KiCad's official KLC checkers (gitlab.com/kicad/libraries/kicad-library-utils).

kicad-library-utils is not on PyPI; CI clones it at a pinned commit and passes
`--klc-utils DIR` (or CR_KLC_UTILS=DIR). Its checkers parse KiCad 10 files fine.
The checkers derive the expected name from the file name/dir, so each item's
standalone source is copied into `<Library>.pretty/<name>.kicad_mod` /
`<Library>.kicad_sym` in a temp dir first. Output is read from the JUnit report.
They only parse the files (nothing from OUT is executed).
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

TIMEOUT_S = 120

# Rules that conflict with this repo's conventions or cannot be evaluated here.
_IGNORE = (
    # repo stores models in lib_3d/<Library>/ via ${KICAD_LIBS_DIR}, not <lib>.3dshapes
    re.compile(r"3D model directory is different from footprint directory"),
    re.compile(r"3D model path|\$\{KICAD\d*_3DMODEL_DIR\}", re.I),
    # needs the whole footprint library; pairing is checked by our own code
    re.compile(r"footprint existence is not going to be checked"),
    # duplicated by our own deterministic ${REFERENCE}-on-F.Fab check (which cites a line)
    re.compile(r"Second Reference Designator missing|Add RefDes to F.Fab"),
)
# Rules that are routinely (and legitimately) broken by vendor STEP models / connectors: info only.
_SOFT = re.compile(r"3D model (offset|rotation|name) is|More than one 3D model|anchor does not match", re.I)


def available(klu_dir: str | None) -> bool:
    return bool(klu_dir) and os.path.isfile(os.path.join(klu_dir, "klc-check", "check_footprint.py"))


def run(klu_dir: str, kind: str, library: str, name: str, source_text: str) -> tuple[list[dict], str | None]:
    """Return (findings, error_note). Findings use category "klc", line None."""
    script = "check_footprint.py" if kind == "footprint" else "check_symbol.py"
    with tempfile.TemporaryDirectory(prefix="cr-klc-") as tmp:
        safe_lib = re.sub(r"[^A-Za-z0-9._-]", "_", library) or "lib"
        safe_name = re.sub(r"[^A-Za-z0-9._+-]", "_", name) or "item"
        if kind == "footprint":
            d = os.path.join(tmp, f"{safe_lib}.pretty")
            os.makedirs(d)
            target = os.path.join(d, f"{safe_name}.kicad_mod")
        else:
            target = os.path.join(tmp, f"{safe_lib}.kicad_sym")
        with open(target, "w", encoding="utf-8") as f:
            f.write(source_text)
        junit = os.path.join(tmp, "out.xml")
        try:
            proc = subprocess.run(
                [sys.executable, script, "--nocolor", "-vv", "--junit", junit, target],
                cwd=os.path.join(klu_dir, "klc-check"), capture_output=True, text=True, timeout=TIMEOUT_S,
            )
        except (OSError, subprocess.TimeoutExpired) as e:
            return [], f"KLC checker failed to run: {e}"
        m = re.search(r"Could not parse [^\n]*", proc.stdout or "")
        if m or not os.path.isfile(junit):
            if m:
                return [], f"KLC checker could not parse the item: {m.group(0)[:200]}"
            tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-3:]
            return [], f"KLC checker produced no report (exit {proc.returncode}): {' / '.join(tail)}"
        try:
            root = ET.parse(junit).getroot()
        except ET.ParseError as e:
            return [], f"KLC report unreadable: {e}"
    return parse_junit(root), None


def parse_junit(root) -> list[dict]:
    out = []
    for fail in root.iter("failure"):
        text = (fail.text or fail.get("message") or "").strip()
        lines = [l.strip() for l in text.splitlines() if l.strip()]
        if not lines:
            continue
        rule = lines[0].split(":", 1)[0]
        url = next((l for l in lines if l.startswith("https://klc.kicad.org")), None)
        details = [l for l in lines[1:] if not l.startswith("https://")]
        details = [d for d in details if not any(p.search(d) for p in _IGNORE)]
        # drop "- 3D model path: ..." style sub-lines that belonged to an ignored detail
        if not [d for d in details if not d.startswith("-")]:
            continue
        # KLC is the upstream convention; a violation is not necessarily wrong for this custom
        # library, so KLC errors map to warnings and KLC warnings to info.
        soft = all(_SOFT.search(d) for d in details if not d.startswith("-"))
        sev = "info" if soft or (fail.get("type") or "").upper() == "WARNING" else "warning"
        msg = f"KLC {rule}: " + "; ".join(details)
        if url:
            msg += f" ([{rule}]({url}))"
        out.append({"severity": sev, "category": "klc", "message": msg, "line": None})
    return out
