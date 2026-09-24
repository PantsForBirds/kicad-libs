#!/usr/bin/env python3
"""Copy the static component-review viewer into an OUT directory (the site root).

    python3 tools/component-review/viewer/build_site.py --out cr-out

Copies index.html, viewer.css and js/ next to manifest.json / review.json / items/ that the
render and ai steps wrote. Never touches those data files. Stdlib only; exits non-zero only
if the copy itself fails (a missing manifest.json is reported as a warning, not an error).
"""
import argparse
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FILES = ["index.html", "viewer.css"]
DIRS = ["js"]
DATA_NAMES = {"manifest.json", "review.json", "review.md", "items"}


def build(out: Path) -> list[str]:
    out.mkdir(parents=True, exist_ok=True)
    copied = []
    for name in FILES:
        shutil.copy2(HERE / name, out / name)
        copied.append(name)
    for d in DIRS:
        dst = out / d
        if dst.name in DATA_NAMES:
            raise RuntimeError(f"refusing to overwrite data dir {dst}")
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(HERE / d, dst, ignore=shutil.ignore_patterns("*.map", ".*"))
        copied += [str(p.relative_to(out)) for p in sorted(dst.rglob("*")) if p.is_file()]
    # GitHub Pages: serve files starting with "_" etc. as-is.
    (out / ".nojekyll").touch()
    return copied


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", required=True, type=Path, help="site root (the render step's OUT dir)")
    args = ap.parse_args(argv)
    try:
        copied = build(args.out)
    except OSError as e:
        print(f"build_site: copy failed: {e}", file=sys.stderr)
        return 1
    print(f"build_site: copied {len(copied)} viewer files into {args.out}")
    if not (args.out / "manifest.json").exists():
        print(f"build_site: warning: {args.out}/manifest.json not found; the viewer will show an error page", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
