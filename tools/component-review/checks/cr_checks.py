#!/usr/bin/env python3
"""Deterministic checks of KiCad footprints/symbols changed in a kicad-libs PR.

Reads OUT/manifest.json (written by the render step) plus per-item assets and
writes OUT/review.json and OUT/review.md (see cr-shared/CONTRACT.md).

  python3 tools/component-review/checks/cr_checks.py --out cr-out [--repo .]
        [--klc-utils DIR] [--site-url URL]

Runs the KLC-style rules in kicad_checks.py and, with --klc-utils, KiCad's
official KLC checkers. No network access and no secrets are needed.

OUT must be self-contained (the privileged CI job has no PR checkout), so
everything is read from OUT; --repo is optional extra context. Nothing from
OUT is ever executed, and every path taken from the manifest is confined to OUT.
Exit status is 0 whenever review.json was written, even with findings.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import kicad_checks as kc  # noqa: E402
import klc_utils  # noqa: E402
import sexpr  # noqa: E402

SEV_ORDER = {"error": 0, "warning": 1, "info": 2}
VERDICT_ORDER = {"fail": 0, "warn": 1, "pass": 2}
GENERATOR = "deterministic checks + KLC"


# ---------------------------------------------------------------------------
# paths & io
# ---------------------------------------------------------------------------

def safe_join(base: str | None, rel: str | None) -> str | None:
    """Join a manifest-provided relative path onto base, refusing escapes."""
    if not base or not rel or not isinstance(rel, str):
        return None
    if os.path.isabs(rel) or "\x00" in rel:
        return None
    base_real = os.path.realpath(base)
    path = os.path.realpath(os.path.join(base_real, rel))
    if path != base_real and not path.startswith(base_real + os.sep):
        return None
    return path


def read_text(path: str | None) -> str | None:
    if not path or not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def slugify(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", s)


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


# ---------------------------------------------------------------------------
# per-item analysis (deterministic)
# ---------------------------------------------------------------------------

class Item:
    """Everything we know about one manifest item."""

    def __init__(self, raw: dict, out_dir: str, repo: str | None):
        self.raw = raw
        self.id = raw.get("id") or f"{raw.get('kind')}:{raw.get('library')}:{raw.get('name')}"
        self.kind = raw.get("kind", "")
        self.name = raw.get("name", "")
        self.library = raw.get("library", "")
        self.status = raw.get("status", "")
        self.path = raw.get("path")
        self.slug = slugify(raw.get("slug") or f"{self.kind}__{self.library}__{self.name}")
        lr = (raw.get("line_range") or {}).get("head")
        self.file_start = lr[0] if isinstance(lr, list) and lr else None
        self.file_end = lr[1] if isinstance(lr, list) and len(lr) > 1 else None
        self.source_text, self.source_origin = self._load_source(out_dir, repo)
        self.node = None
        self.linemap = kc.LineMap(1, self.file_start)
        self.parse_error = None
        if self.source_text:
            try:
                root = sexpr.parse(self.source_text)
                self.node = kc.find_item_node(root, self.kind, self.name)
                if self.node is not None:
                    self.linemap = kc.LineMap(self.node.line, self.file_start)
                else:
                    self.parse_error = f"could not find {self.kind} `{self.name}` in its source"
            except sexpr.ParseError as e:
                self.parse_error = f"s-expression parse error: {e}"
        self.findings: list[dict] = []
        self.checks: list[dict] = []
        self.stats = {}
        self.pads: list[dict] = []
        self.pins: list[dict] = []
        self.paired: list[tuple[Item, bool]] = []  # (other item, exact match?)

    def _load_source(self, out_dir, repo):
        src = (self.raw.get("source") or {}).get("head")
        text = read_text(safe_join(out_dir, src))
        if text is not None:
            return text, "out"
        if repo and self.path and self.file_start:
            full = read_text(safe_join(repo, self.path))
            if full is not None:
                lines = full.splitlines(keepends=True)
                end = self.file_end or len(lines)
                # keep the file's own coordinates: root node will open at file_start
                return "\n" * (self.file_start - 1) + "".join(lines[self.file_start - 1:end]), "repo"
        return None, None

    @property
    def props_head(self) -> dict:
        return ((self.raw.get("properties") or {}).get("head")) or {}

    def add(self, fs, cs=()):
        for f in fs:
            f.setdefault("path", self.path)
        self.findings.extend(fs)
        self.checks.extend(cs)

    def analyse(self, repo: str | None, klu_dir: str | None = None):
        if self.status == "deleted":
            return
        if self.node is None:
            self.add([kc.finding("error", f"Could not analyse item: {self.parse_error or 'source not available in OUT'}.")])
            return
        repo_exists = None
        if repo:
            def repo_exists(rel):
                p = safe_join(repo, rel)
                return os.path.exists(p) if p else None
        if self.kind == "footprint":
            self.pads = kc.parse_pads(self.node)
            self.stats = kc.footprint_stats(self.node)
            models = ((self.raw.get("model3d_by_side") or {}).get("head")) or self.raw.get("model3d")
            fs, cs = kc.check_footprint(self.node, self.linemap, models, repo_exists)
        else:
            self.pins = kc.parse_pins(self.node)
            self.stats = kc.symbol_stats(self.node)
            fs, cs = kc.check_symbol(self.node, self.linemap)
        self.add(fs, cs)
        if klc_utils.available(klu_dir):
            kfs, err = klc_utils.run(klu_dir, self.kind, self.library, self.name, self.source_text)
            self.add(kfs, [kc.check("KiCad KLC checker (kicad-library-utils)",
                                    "unknown" if err else ("fail" if kfs else "pass"), err or f"{len(kfs)} violation(s)")])
        for w in self.raw.get("warnings") or []:
            self.add([kc.finding("info", f"Render: {w}")])

    def det_verdict(self) -> str:
        sev = {f["severity"] for f in self.findings}
        return "fail" if "error" in sev else "warn" if "warning" in sev else "pass"


def pair_items(items: list[Item]) -> None:
    """Link symbols to footprints in this PR via the symbol's Footprint property."""
    fps = {i.id: i for i in items if i.kind == "footprint" and i.status != "deleted"}
    by_name = {}
    for f in fps.values():
        by_name.setdefault(f.name, []).append(f)
    for s in items:
        if s.kind != "symbol" or s.status == "deleted":
            continue
        ref = (s.props_head.get("Footprint") or "").strip()
        if not ref and s.node is not None:
            ref = next((p.atom(1, "") for p in s.node.children("property") if p.atom(0) == "Footprint"), "")
        if not ref or ":" not in ref:
            continue
        lib, name = ref.split(":", 1)
        exact = fps.get(f"footprint:{lib}:{name}")
        if exact:
            s.paired.append((exact, True))
            exact.paired.append((s, True))
            continue
        # near misses: same name in a different library, or a variant of a PR footprint's name
        cands = list(by_name.get(name, []))
        if not cands:
            cands = [f for f in fps.values() if name.startswith(f.name) or f.name.startswith(name)]
        for f in cands:
            s.paired.append((f, False))
            f.paired.append((s, False))
            line = None
            if s.node is not None:
                pn = next((p for p in s.node.children("property") if p.atom(0) == "Footprint"), None)
                line = s.linemap(pn.line) if pn else None
            s.add([kc.finding(
                "warning",
                f"`Footprint` property is `{ref}`, but this PR adds `{f.library}:{f.name}`. "
                "The default footprint does not point at the footprint added alongside this symbol.",
                line, f"Set Footprint to `{f.library}:{f.name}` if that is the intended package.",
                category="klc")])


def cross_check_pairs(items: list[Item]) -> None:
    for s in items:
        if s.kind != "symbol":
            continue
        for f, _exact in s.paired:
            if not f.pads and f.node is None:
                continue
            fs, cs = kc.check_pairing(s.pins, f.pads, s.id, f.id, None)
            s.add(fs, cs)
            f.checks.extend(c for c in cs)


def datasheet_ref(item: Item, out_dir: str) -> str | None:
    """The item's datasheet: the local copy the render step put in OUT, else its URL."""
    ds = item.raw.get("datasheet") or {}
    rel = ds.get("file")
    if isinstance(rel, str) and (p := safe_join(out_dir, rel)) and os.path.isfile(p):
        return rel
    url = ds.get("url")
    return url if isinstance(url, str) and url else None


# ---------------------------------------------------------------------------
# outputs
# ---------------------------------------------------------------------------

def det_summary(item: Item) -> str:
    n = {s: sum(f["severity"] == s for f in item.findings) for s in SEV_ORDER}
    if item.status == "deleted":
        return "Deleted in this PR; nothing to review."
    return (f"Deterministic checks: {n['error']} error(s), {n['warning']} warning(s), {n['info']} info. "
            + ("" if not item.paired else "Cross-checked against " + ", ".join(f"`{o.id}`" for o, _ in item.paired) + "."))


def item_entry(item: Item, verdict: str, summary: str, datasheet_used: str | None) -> dict:
    # severity first; within a severity, line-cited findings (actionable) before uncited ones
    findings = sorted(item.findings, key=lambda f: (SEV_ORDER.get(f["severity"], 3), f.get("line") is None, f.get("line") or 0))
    return {"verdict": verdict, "summary": summary, "datasheet_used": datasheet_used,
            "findings": findings, "checks": item.checks}


def _md_cell(s: str, limit: int = 160) -> str:
    s = re.sub(r" \(\[[A-Z]\d+\.\d+\]\(https://klc\.kicad\.org/[^)]*\)\)", "", s or "")  # KLC rule links
    s = re.sub(r"\s+", " ", s).replace("|", "\\|")
    return s if len(s) <= limit else s[: limit - 1] + "…"


def render_markdown(review: dict, items: list[Item], site_url: str | None) -> str:
    icon = {"pass": "✅ pass", "warn": "⚠️ warn", "fail": "❌ fail"}
    sev_icon = {"error": "❌", "warning": "⚠️", "info": "ℹ️"}
    lines = ["## Component review", "", review["summary_markdown"], "",
             "| Component | Status | Verdict | Top findings |", "|---|---|---|---|"]
    order = sorted(items, key=lambda i: (VERDICT_ORDER[review["items"][i.id]["verdict"]], i.id))
    for it in order:
        e = review["items"][it.id]
        top = [f for f in e["findings"] if f["severity"] != "info"][:3] or e["findings"][:1]
        cells = "<br>".join(f"{sev_icon[f['severity']]} {_md_cell(f['message'])}"
                            + (f" (L{f['line']})" if f.get("line") else "") for f in top) or "—"
        more = len(e["findings"]) - len(top)
        if more > 0:
            cells += f"<br>… +{more} more"
        name = f"`{it.library}:{it.name}` ({it.kind})"
        if site_url:
            name = f"[{name}]({site_url.rstrip('/')}/#{it.slug})"
        lines.append(f"| {name} | {it.status} | {icon[e['verdict']]} | {cells} |")
    if review.get("pr_findings"):
        lines += ["", "**PR-level findings**", ""]
        lines += [f"- {sev_icon[f['severity']]} {_md_cell(f['message'], 300)}" for f in review["pr_findings"]]
    lines += ["", f"<sub>Checks: {review['generator']}. Line numbers refer to the PR head.</sub>"]
    md = "\n".join(lines) + "\n"
    return md if len(md) < 60000 else md[:59000] + "\n\n… (truncated; see review.json)\n"


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", required=True, help="render output dir containing manifest.json")
    ap.add_argument("--repo", default=None, help="optional repo checkout (3D model existence fallback; never required)")
    ap.add_argument("--site-url", default=os.environ.get("CR_SITE_URL"), help="viewer URL to link from review.md")
    ap.add_argument("--klc-utils", default=os.environ.get("CR_KLC_UTILS"),
                    help="path to a kicad-library-utils checkout; runs its KLC checkers too (optional)")
    ap.add_argument("--only", action="append", help="only check item ids matching this substring (repeatable)")
    # accepted and ignored so older callers keep working
    ap.add_argument("--no-llm", "--no-download", action="store_true", help=argparse.SUPPRESS)
    return ap.parse_args(argv)


def run(args) -> int:
    out_dir = os.path.abspath(args.out)
    manifest_path = os.path.join(out_dir, "manifest.json")
    try:
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"cr-checks: cannot read {manifest_path}: {e}", file=sys.stderr)
        return 2
    if manifest.get("schema") != 1:
        print(f"cr-checks: warning: manifest schema {manifest.get('schema')!r}, expected 1", file=sys.stderr)
    repo = os.path.abspath(args.repo) if args.repo else None

    items = [Item(r, out_dir, repo) for r in manifest.get("items") or [] if isinstance(r, dict)]
    if args.only:
        items = [i for i in items if any(s in i.id for s in args.only)]
    klu_dir = args.klc_utils if klc_utils.available(args.klc_utils) else None
    if args.klc_utils and not klu_dir:
        print(f"cr-checks: warning: --klc-utils {args.klc_utils} is not a kicad-library-utils checkout; skipping KLC checker",
              file=sys.stderr)
    for it in items:
        it.analyse(repo, klu_dir)
    pr_findings = [
        {"severity": "warning", "category": "3d-model", "path": p, "line": None,
         "message": f"3D model file `{p}` is added/changed in this PR but no footprint references it.",
         "suggestion": "Reference it from the footprint it belongs to, or drop it from the PR."}
        for p in manifest.get("unreferenced_changed_3d_files") or [] if isinstance(p, str)]
    pair_items(items)
    cross_check_pairs(items)

    review_items = {it.id: item_entry(it, it.det_verdict(), det_summary(it), datasheet_ref(it, out_dir))
                    for it in items}
    n = {v: sum(e["verdict"] == v for e in review_items.values()) for v in VERDICT_ORDER}
    summary = [f"Reviewed **{len(items)}** item(s): {n['fail']} fail, {n['warn']} warn, {n['pass']} pass."]
    if not klu_dir:
        summary.append("The KiCad KLC checker (kicad-library-utils) was not run.")
    if pr_findings:
        summary.append(f"{len(pr_findings)} PR-level finding(s) (unreferenced 3D model files).")
    review = {"schema": 1, "generator": GENERATOR if klu_dir else "deterministic checks", "generated_at": _now(),
              "summary_markdown": " ".join(summary), "items": review_items,
              # additive to the contract: findings not tied to one item
              "pr_findings": pr_findings}

    with open(os.path.join(out_dir, "review.json"), "w", encoding="utf-8") as f:
        json.dump(review, f, indent=1, ensure_ascii=False)
    with open(os.path.join(out_dir, "review.md"), "w", encoding="utf-8") as f:
        f.write(render_markdown(review, items, args.site_url))
    print(f"cr-checks: wrote {os.path.join(out_dir, 'review.json')} ({len(items)} items; {review['summary_markdown']})")
    return 0


def main(argv=None) -> int:
    return run(parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
