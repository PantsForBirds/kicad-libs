#!/usr/bin/env python3
"""Job summary and inline annotations for the component-review run (no token needed).

    job_summary.py --out cr-out [--annotate] [--summary FILE] [--link NAME=URL ...]

--annotate prints `::error file=…,line=…::` / `::warning …::` workflow commands for the
findings that have a file (GitHub shows them in the PR's "Files changed" view and on the
run, without any write permission; it keeps at most 10 errors and 10 warnings per step,
so the most severe come first). --summary appends markdown to FILE (normally
$GITHUB_STEP_SUMMARY): counts, links to the artifacts, and the findings table
(OUT/review.md when present).
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (SEVERITY_RANK, finding_line_no, findings_of, item_review, load_site,  # noqa: E402
                    md_inline, overall_verdict, safe_http_url, safe_repo_path, verdict_of)

MAX_ANNOTATIONS = 50        # GitHub's per-job cap
MAX_SUMMARY = 900_000       # the step summary limit is 1 MiB


def _data(s: str) -> str:
    return s.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def _prop(s: str) -> str:
    return _data(s).replace(":", "%3A").replace(",", "%2C")


def annotations(manifest, review) -> list[str]:
    out = []
    rows = []
    for item in manifest["items"]:
        for f in findings_of(item_review(review, item.get("id"))):
            rows.append((item, f))
    for f in (review or {}).get("pr_findings") or []:
        if isinstance(f, dict):
            rows.append(({}, f))
    rows.sort(key=lambda r: -SEVERITY_RANK.get(r[1].get("severity"), -1))
    for item, f in rows:
        level = {"error": "error", "warning": "warning"}.get(f.get("severity"))
        if not level:
            continue
        path = safe_repo_path(f.get("path")) or safe_repo_path(item.get("path"))
        if not path:
            continue
        props = [f"file={_prop(path)}"]
        # Always a line: GitHub records a file-level annotation as line 0 (a dead "#L0" link).
        # Unlocated findings go on the item's first line; deleted items' lines don't exist
        # at head, so those go on line 1.
        line, _exact = finding_line_no(f, item if item.get("status") != "deleted" else None)
        props.append(f"line={line}")
        name = f"{item.get('library')}:{item.get('name')}" if item else "PR"
        props.append("title=" + _prop(f"{str(f.get('category') or 'check')[:30]}: {name}"[:120]))
        msg = re.sub(r"\s+", " ", str(f.get("message") or "")).strip()[:900]
        if f.get("suggestion"):
            msg += " Suggestion: " + re.sub(r"\s+", " ", str(f["suggestion"])).strip()[:400]
        out.append(f"::{level} {','.join(props)}::{_data(msg)}")
        if len(out) >= MAX_ANNOTATIONS:
            break
    return out


def summary(site: Path, manifest, review, links: list[tuple[str, str]]) -> str:
    ov = overall_verdict(manifest, review)
    items = manifest["items"]
    counts = {s: sum(i.get("status") == s for i in items) for s in ("added", "modified", "deleted")}
    sev = {"error": 0, "warning": 0, "info": 0}
    for i in items:
        for f in findings_of(item_review(review, i.get("id"))):
            if f.get("severity") in sev:
                sev[f["severity"]] += 1
    verdicts = [verdict_of(item_review(review, i.get("id"))) for i in items]
    icon = {"pass": "✅", "warn": "⚠️", "fail": "❌", None: "⚪"}[ov]
    lines = [f"## {icon} Component review: {ov or 'not reviewed'}", "",
             f"**{len(items)}** changed component(s): " + ", ".join(f"{v} {k}" for k, v in counts.items() if v)
             + (f" · verdicts: {verdicts.count('fail')} fail, {verdicts.count('warn')} warn, "
                f"{verdicts.count('pass')} pass" if review else "")
             + f" · findings: {sev['error']} error(s), {sev['warning']} warning(s), {sev['info']} info", ""]
    good = [(n, safe_http_url(u)) for n, u in links]
    good = [(n, u) for n, u in good if u]
    if good:
        lines += ["**Artifacts:** " + " · ".join(f"[{md_inline(n, 80)}]({u})" for n, u in good), ""]
        lines += ["Open `component-review.html` straight in the browser (no JavaScript, everything embedded). "
                  "The viewer zip holds the interactive 3D viewer: unzip it and open `index.html`.", ""]
    md = site / "review.md"
    if md.is_file() and md.stat().st_size < MAX_SUMMARY:
        text = md.read_text(encoding="utf-8", errors="replace")
        lines += [re.sub(r"^## Component review\n", "### Findings\n", text, count=1)]
    elif not review:
        lines += ["_No review.json: the deterministic checks did not run._"]
    out = "\n".join(lines) + "\n"
    return out[:MAX_SUMMARY]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--annotate", action="store_true")
    ap.add_argument("--summary", type=Path)
    ap.add_argument("--link", action="append", default=[], help="NAME=URL (repeatable; empty URLs skipped)")
    a = ap.parse_args(argv)
    manifest, review = load_site(a.out)
    if a.annotate:
        for line in annotations(manifest, review):
            print(line)
    if a.summary:
        links = [tuple(x.split("=", 1)) for x in a.link if "=" in x and x.split("=", 1)[1]]
        with open(a.summary, "a", encoding="utf-8") as f:
            f.write(summary(a.out, manifest, review, links))
    return 0


if __name__ == "__main__":
    sys.exit(main())
