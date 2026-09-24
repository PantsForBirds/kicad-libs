#!/usr/bin/env python3
"""Render the sticky PR comment (markdown) from a component-review site dir.

Inputs are OUT/manifest.json and (optional) OUT/review.json, see CONTRACT.md. All text from
them is escaped (no raw HTML, @-mentions or remote images); image URLs are only built for
files that actually exist in the (sanitized) site dir.

Usage:
  make_comment.py --site cr-out --repo owner/repo --pr 8 --head-sha SHA \
      [--pages-url https://owner.github.io/repo/] [--pages-sha SHA_OF_GH_PAGES_COMMIT] \
      [--artifact-url URL] [--run-url URL] [--note TEXT] > comment.md
"""
from __future__ import annotations

import argparse
import hashlib
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (MARKER, SEVERITY_RANK, check_repo, check_sha, finding_line_no, findings_of, generator_of, item_review, load_site,  # noqa: E402
                    md_block, md_code, md_inline, overall_verdict, parse_pr_number, safe_http_url,
                    safe_repo_path, safe_site_file, safe_slug, verdict_of)

MAX_COMMENT = 60000          # GitHub's hard limit is 65536 characters
IMG_WIDTH = 240
VERDICT_ICON = {"pass": "✅", "warn": "⚠️", "fail": "❌", None: "⚪"}
VERDICT_TEXT = {"pass": "pass", "warn": "warn", "fail": "fail", None: "—"}
SEVERITY_ICON = {"error": "🔴", "warning": "🟠", "info": "🔵"}
STATUS_TEXT = {"added": "🆕 added", "modified": "✏️ modified", "deleted": "🗑️ deleted"}


def finding_key(f: dict) -> str:
    """Stable id of a finding, used to avoid re-posting the same inline comment."""
    raw = "\n".join(str(f.get(k, "")) for k in ("path", "line", "severity", "category", "message"))
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def default_pages_url(repo: str) -> str:
    owner, name = repo.split("/", 1)
    if name.lower() == f"{owner.lower()}.github.io":
        return f"https://{owner.lower()}.github.io/"
    return f"https://{owner.lower()}.github.io/{name}/"


class Ctx:
    def __init__(self, site: Path, repo: str, pr: int, head_sha: str, pages_url: str,
                 pages_sha: str | None, server_url: str = "https://github.com"):
        self.site, self.repo, self.pr, self.head_sha = site, repo, pr, head_sha
        self.server = server_url.rstrip("/")
        self.viewer = pages_url.rstrip("/") + f"/pr/{pr}/"
        if pages_sha:
            # pinned to the gh-pages commit -> never goes stale, survives the PR-closed cleanup
            self.img_base = f"https://raw.githubusercontent.com/{repo}/{pages_sha}/pr/{pr}/"
            self.img_suffix = ""
        else:
            self.img_base = self.viewer
            self.img_suffix = f"?v={head_sha[:12]}"

    def img(self, rel: str | None, alt: str) -> str:
        if not rel:
            return "<sub>—</sub>"
        url = self.img_base + urllib.parse.quote(rel) + self.img_suffix
        return f'<a href="{url}"><img src="{url}" width="{IMG_WIDTH}" alt="{alt}"></a>'

    def blob(self, path: str, line) -> str:
        url = f"{self.server}/{self.repo}/blob/{self.head_sha}/{urllib.parse.quote(path)}"
        if isinstance(line, int) and not isinstance(line, bool) and line > 0:
            url += f"#L{line}"
        return url


def item_label(item: dict) -> str:
    lib, name = item.get("library") or "?", item.get("name") or "?"
    return f"{lib}:{name}"


def render_png(ctx: Ctx, item: dict, side: str, slug: str) -> str | None:
    r = (item.get("renders") or {}).get(side)
    if not isinstance(r, dict):
        return None
    return safe_site_file(ctx.site, r.get("png"), slug)


def top_findings_cell(fs: list[dict]) -> str:
    serious = [f for f in fs if f.get("severity") in ("error", "warning")]
    if not fs:
        return ""
    counts = []
    for sev, word in (("error", "error"), ("warning", "warning"), ("info", "note")):
        n = sum(1 for f in fs if f.get("severity") == sev)
        if n:
            counts.append(f"{n} {word}{'s' if n > 1 else ''}")
    tops = [f"{SEVERITY_ICON.get(f.get('severity'), '')} {md_inline(f.get('message'), 90)}" for f in serious[:2]]
    return "<br>".join([", ".join(counts)] + tops)


def details_block(ctx: Ctx, item: dict, review, inlined: set[str]) -> str:
    slug = safe_slug(item.get("slug")) or ""
    ir = item_review(review, item.get("id"))
    v = verdict_of(ir)
    status = item.get("status")
    kind = md_inline(item.get("kind"), 20)
    summary = (f"{VERDICT_ICON[v]} <b>{md_inline(item_label(item), 120)}</b> "
               f"<sub>{kind} · {md_inline(status, 20)}</sub>")
    lines = [f"<details><summary>{summary}</summary>", ""]

    links = []
    if slug:
        links.append(f"[Open in viewer]({ctx.viewer}#{slug})")
    path = safe_repo_path(item.get("path"))
    if path and status != "deleted":
        rng = ((item.get("line_range") or {}).get("head") or [None])
        links.append(f"[{md_code(path)}]({ctx.blob(path, rng[0] if isinstance(rng, list) and rng else None)})")
    ds = item.get("datasheet") or {}
    ds_url = safe_http_url(ds.get("url")) if isinstance(ds, dict) else None
    if ds_url:
        links.append(f"[datasheet]({ds_url})")
    if links:
        lines += [" · ".join(links), ""]

    base_png = render_png(ctx, item, "base", slug) if slug else None
    head_png = render_png(ctx, item, "head", slug) if slug else None
    diff_png = safe_site_file(ctx.site, item.get("diff_png"), slug) if slug else None
    cols = []
    if status != "added":
        cols.append(("Before (base)", ctx.img(base_png, "base render")))
    if status != "deleted":
        cols.append(("After (head)", ctx.img(head_png, "head render")))
    if diff_png:
        cols.append(("Diff <sub>(red removed / green added)</sub>", ctx.img(diff_png, "diff overlay")))
    if cols and any(p for p in (base_png, head_png, diff_png)):
        lines += ["| " + " | ".join(c[0] for c in cols) + " |",
                  "|" + "|".join(":-:" for _ in cols) + "|",
                  "| " + " | ".join(c[1] for c in cols) + " |", ""]
    else:
        lines += ["_No rendered images for this item._", ""]

    if ir.get("summary"):
        lines += [f"**Review ({VERDICT_TEXT[v]}):** {md_block(ir.get('summary'), 800)}", ""]
    fs = findings_of(ir)
    for f in fs[:25]:
        lines += finding_line(ctx, f, " 💬" if finding_key(f) in inlined else "", item)
    if len(fs) > 25:
        lines.append(f"- … {len(fs) - 25} more in the viewer")
    checks = ir.get("checks") if isinstance(ir.get("checks"), list) else []
    failed = [c for c in checks if isinstance(c, dict) and c.get("result") == "fail"]
    if failed:
        lines.append("")
        lines.append("Failed checks: " + "; ".join(md_inline(c.get("name"), 80) for c in failed[:10]))
    warns = item.get("warnings") if isinstance(item.get("warnings"), list) else []
    if warns:
        lines += ["", "<sub>Render warnings: " + "; ".join(md_inline(w, 150) for w in warns[:5]) + "</sub>"]
    lines += ["", "</details>", ""]
    return "\n".join(lines)


def pr_findings_of(review) -> list[dict]:
    fs = review.get("pr_findings") if review else None
    out = [f for f in fs if isinstance(f, dict) and isinstance(f.get("message"), str) and f["message"].strip()] \
        if isinstance(fs, list) else []
    return sorted(out, key=lambda f: -SEVERITY_RANK.get(f.get("severity"), -1))


def finding_line(ctx: "Ctx", f: dict, tag: str = "", item: dict | None = None) -> list[str]:
    sev = f.get("severity") if f.get("severity") in SEVERITY_ICON else "info"
    where = ""
    fpath = safe_repo_path(f.get("path"))
    fline, exact = finding_line_no(f, item)
    if fpath and exact:
        where = f" ([L{fline}]({ctx.blob(fpath, fline)}))"
    elif fpath and item and item.get("status") != "deleted":   # no line: link the item's start
        where = f" ([{md_code(fpath.rsplit('/', 1)[-1], 100)}]({ctx.blob(fpath, fline)}))"
    elif fpath:
        where = f" ({md_code(fpath, 100)})"
    msg = md_block(f.get("message"), 600).replace("\n", " ")
    out = [f"- {SEVERITY_ICON[sev]} **{sev}** · {md_inline(f.get('category'), 30)}{where}{tag} — {msg}"]
    if f.get("suggestion"):
        out.append(f"  - _Suggestion:_ {md_block(f.get('suggestion'), 400).replace(chr(10), ' ')}")
    return out


def pr_level_section(ctx: "Ctx", review) -> list[str]:
    fs = pr_findings_of(review)
    if not fs:
        return []
    lines = ["", "### PR-level findings", ""]
    for f in fs[:20]:
        lines += finding_line(ctx, f)
    if len(fs) > 20:
        lines.append(f"- … {len(fs) - 20} more in the viewer")
    return lines


def sort_key(item: dict, review):
    v = verdict_of(item_review(review, item.get("id")))
    return (-(("pass", "warn", "fail").index(v) if v else -1), str(item.get("kind")), item_label(item))


def build_comment(ctx: Ctx, manifest: dict, review, *, artifact_url: str | None = None,
                  report_url: str | None = None,
                  run_url: str | None = None, note: str | None = None,
                  inlined: set[str] | None = None, n_inline: int = 0) -> str:
    inlined = inlined or set()
    items = sorted(manifest["items"], key=lambda i: sort_key(i, review))
    ov = overall_verdict(manifest, review)
    head = [MARKER, f"## {VERDICT_ICON[ov]} Component review", ""]
    n = len(items)
    kinds = {}
    for i in items:
        kinds[i.get("kind")] = kinds.get(i.get("kind"), 0) + 1
    what = ", ".join(f"{c} {md_inline(k, 20)}{'s' if c > 1 else ''}" for k, c in sorted(kinds.items(), key=str))
    links = [f"**[🔎 Open the interactive viewer]({ctx.viewer})**"]
    if report_url:
        links.append(f"[📄 HTML report (single file, no JS)]({report_url})")
    if artifact_url:
        links.append(f"[⬇️ offline viewer (zip)]({artifact_url})")
    if run_url:
        links.append(f"[workflow run]({run_url})")
    head += [" · ".join(links), "",
             f"{n} changed component{'s' if n != 1 else ''} ({what or 'none'}) at {md_code(ctx.head_sha[:10])}. "
             f"Overall verdict: **{VERDICT_TEXT[ov] if ov else 'not reviewed'}**."
             + (f" {n_inline} finding{'s' if n_inline != 1 else ''} posted as inline review comments." if n_inline else ""),
             ""]
    if note:
        head += [f"> {md_inline(note, 300)}", ""]
    if review and review.get("summary_markdown"):
        head += [md_block(review.get("summary_markdown"), 3000), ""]

    table = ["| | Component | Kind | Change | Verdict | Findings |", "|---|---|---|---|---|---|"]
    table_len = 0
    for n_rows, i in enumerate(items):
        if table_len > MAX_COMMENT // 2:
            table.append(f"| | _… {len(items) - n_rows} more: see the viewer_ | | | | |")
            break
        slug = safe_slug(i.get("slug"))
        ir = item_review(review, i.get("id"))
        v = verdict_of(ir)
        name = md_inline(item_label(i), 100)
        comp = f"[{name}]({ctx.viewer}#{slug})" if slug else name
        table.append(f"| {VERDICT_ICON[v]} | {comp} | {md_inline(i.get('kind'), 20)} | "
                     f"{STATUS_TEXT.get(i.get('status'), md_inline(i.get('status'), 20))} | "
                     f"{VERDICT_TEXT[v]} | {top_findings_cell(findings_of(ir))} |")
        table_len += len(table[-1])
    if not items:
        table = ["_No footprint or symbol changes were found in this PR._"]

    generator = md_inline(generator_of(review), 60)
    foot = [""]
    foot.append("<sub>Generated by the component-review workflow"
                + (f" ({generator})" if generator else "")
                + ". Findings come from deterministic checks (KLC-style rules and the official KLC checker); "
                  "check them against the datasheet. The viewer may take a minute to update after each push. "
                  "This comment is updated in place.</sub>")

    parts = head + table + pr_level_section(ctx, review) + ["", "### Details", ""]
    body = "\n".join(parts)
    footer = "\n".join(foot)
    omitted = 0
    for i in items:
        block = details_block(ctx, i, review, inlined)
        if len(body) + len(block) + len(footer) + 200 > MAX_COMMENT:
            omitted += 1
            continue
        body += block
    if omitted:
        body += f"\n_{omitted} more component(s) omitted to fit GitHub's comment size limit: see the viewer._\n"
    return body + footer + "\n"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", required=True, type=Path)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--pr", required=True)
    ap.add_argument("--head-sha", required=True)
    ap.add_argument("--pages-url")
    ap.add_argument("--pages-sha")
    ap.add_argument("--artifact-url", help="the component-review-site artifact (zipped viewer)")
    ap.add_argument("--report-url", help="the component-review.html artifact (single HTML file)")
    ap.add_argument("--run-url")
    ap.add_argument("--note")
    a = ap.parse_args(argv)
    repo = check_repo(a.repo)
    ctx = Ctx(a.site, repo, parse_pr_number(a.pr), check_sha(a.head_sha),
              a.pages_url or default_pages_url(repo), check_sha(a.pages_sha) if a.pages_sha else None)
    manifest, review = load_site(a.site)
    sys.stdout.write(build_comment(ctx, manifest, review, artifact_url=a.artifact_url,
                                   report_url=a.report_url, run_url=a.run_url, note=a.note))
    return 0


if __name__ == "__main__":
    sys.exit(main())
