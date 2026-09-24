#!/usr/bin/env python3
"""Hostile-input check: the report is built from PR contents, so every string in manifest.json /
review.json must be rendered as text and every URL filtered.

    python3 xss_check.py --site <OUT with viewer + a manifest> [--mode http|file]   (needs playwright)

Rewrites manifest/review in a COPY of --site with injection payloads, opens every page and fails if
any script runs, any injected element/attribute shows up, or any javascript:/data: link is rendered.
--mode file rebuilds the file:// data (data.js, offline packs) from the poisoned copy with
build_site.py and opens it from disk; it also poisons a diff with a </script> breakout and points
manifest paths outside the site, which must not end up in data.js or the packs.
"""
import argparse
import functools
import http.server
import json
import shutil
import sys
import tempfile
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

P = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>'


def poison(site: Path):
    m = json.loads((site / "manifest.json").read_text())
    m["repo"] = 'x/y"><img src=x onerror=window.__pwned=1>'
    m["generated_at"] = P
    m["kicad_version"] = P
    for it in m["items"]:
        it["name"] = it["name"] + P
        it["library"] = P
        it["path"] = "../../" + P
        it["warnings"] = [P, "javascript:window.__pwned=1"]
        it["datasheet"] = {"url": "javascript:window.__pwned=1", "local": P, "file": "../../../etc/passwd"}
        for side in ("head", "base"):
            if (it.get("properties") or {}).get(side):
                it["properties"][side]["Datasheet"] = "javascript:window.__pwned=1"
                it["properties"][side]["Evil"] = P
        if it.get("renders", {}).get("head"):
            it["renders"]["head"]["svg"] = "javascript:window.__pwned=1"
    (site / "manifest.json").write_text(json.dumps(m))
    r = {"schema": 1, "generator": P, "summary_markdown": f"**hi** {P} [click](javascript:window.__pwned=1) [d](data:text/html,x)",
         "pr_findings": [{"severity": P, "category": P, "message": P, "path": "../" + P, "line": "1"}],
         "items": {it["id"]: {"verdict": P, "summary": P, "datasheet_used": "javascript:window.__pwned=1",
                               "findings": [{"severity": "error", "category": P, "message": f"`{P}` {P}", "path": P, "line": 3,
                                             "suggestion": "[x](javascript:window.__pwned=1)"}],
                               "checks": [{"name": P, "result": P, "detail": P}]} for it in m["items"]}}
    (site / "review.json").write_text(json.dumps(r))
    return m


def poison_offline(site: Path, m: dict) -> None:
    """Extra payloads for the file:// build: a diff that tries to break out of data.js, and manifest
    paths that point outside the site (must be refused by build_site.py)."""
    (site / "secret.txt").write_text("TOP-SECRET-OUTSIDE-ITEMS")
    for n, it in enumerate(m["items"]):
        d = site / "items" / it["slug"]
        d.mkdir(parents=True, exist_ok=True)
        (d / "evil.patch").write_text(f"+</script><script>window.__pwned=1</script>\n+{P}\n+\u2028\u2029 end\n")
        it["text_diff"] = f"items/{it['slug']}/evil.patch" if n % 2 == 0 else "../secret.txt"
        if it.get("kind") == "footprint":
            it["geom"] = {"head": "secret.txt", "base": f"items/{it['slug']}/../../secret.txt"}
            it["model3d_by_side"] = {"head": [{"file": "/etc/passwd", "path_raw": P}], "base": [{"file": "items/../secret.txt"}]}
    (site / "manifest.json").write_text(json.dumps(m))
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import build_site  # noqa: E402
    build_site.build(site)
    build_site.build_offline(site)
    blobs = [(site / "data.js").read_text()] + [p.read_text() for p in (site / "offline").glob("*.js")]
    leaks = [x for x in blobs if "TOP-SECRET" in x or "root:" in x or "</script" in x.lower() or "\u2028" in x]
    if leaks:
        raise SystemExit("xss_check: FAIL: data.js / offline packs contain out-of-site data or raw </script>")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True, type=Path)
    ap.add_argument("--mode", choices=("http", "file"), default="http")
    a = ap.parse_args()
    tmp = Path(tempfile.mkdtemp()) / "site"
    shutil.copytree(a.site, tmp)
    m = poison(tmp)
    if a.mode == "file":
        poison_offline(tmp, m)
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Quiet, directory=str(tmp))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}/" if a.mode == "http" else (tmp / "index.html").as_uri()
    bad = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page()
        page.on("dialog", lambda d: (bad.append(f"dialog: {d.message}"), d.dismiss()))
        page.on("pageerror", lambda e: bad.append(f"pageerror: {e}"))
        for url in [base] + [f"{base}#{it['slug']}" for it in m["items"]]:
            page.goto(url)
            if a.mode == "file":
                page.reload()  # hash-only navigation: re-run the page from disk
            page.wait_for_selector("#item-list")
            page.wait_for_timeout(500)
            res = page.evaluate("""() => ({
                pwned: !!window.__pwned,
                injected: document.querySelectorAll('img[src="x"], main script, header script, aside script, [onerror]').length,
                badLinks: [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href'))
                          .filter(h => /^(javascript|data|vbscript):/i.test(h) || h.includes('..')),
                badImgs: [...document.querySelectorAll('img[src]')].map(i => i.getAttribute('src'))
                          .filter(s => /^(javascript|data):/i.test(s) || s.includes('..')),
            })""")
            if res["pwned"] or res["injected"] or res["badLinks"] or res["badImgs"]:
                bad.append(f"{url}: {res}")
        b.close()
    httpd.shutdown()
    print("XSS check:", "FAIL" if bad else f"ok ({len(m['items']) + 1} pages)")
    for x in bad:
        print("  ", x)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
