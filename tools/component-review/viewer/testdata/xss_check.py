#!/usr/bin/env python3
"""Hostile-input check: the report is built from PR contents, so every string in manifest.json /
review.json must be rendered as text and every URL filtered.

    python3 xss_check.py --site <OUT with viewer + a manifest>   (needs playwright)

Rewrites manifest/review in a COPY of --site with injection payloads, opens every page and fails if
any script runs, any injected element/attribute shows up, or any javascript:/data: link is rendered.
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
    r = {"schema": 1, "model": P, "summary_markdown": f"**hi** {P} [click](javascript:window.__pwned=1) [d](data:text/html,x)",
         "usage": {"input_tokens": P}, "pr_findings": [{"severity": P, "category": P, "message": P, "path": "../" + P, "line": "1"}],
         "items": {it["id"]: {"verdict": P, "summary": P, "datasheet_used": "javascript:window.__pwned=1",
                               "findings": [{"severity": "error", "category": P, "message": f"`{P}` {P}", "path": P, "line": 3,
                                             "suggestion": "[x](javascript:window.__pwned=1)"}],
                               "checks": [{"name": P, "result": P, "detail": P}]} for it in m["items"]}}
    (site / "review.json").write_text(json.dumps(r))
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True, type=Path)
    a = ap.parse_args()
    tmp = Path(tempfile.mkdtemp()) / "site"
    shutil.copytree(a.site, tmp)
    m = poison(tmp)
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Quiet, directory=str(tmp))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}/"
    bad = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page()
        page.on("dialog", lambda d: (bad.append(f"dialog: {d.message}"), d.dismiss()))
        page.on("pageerror", lambda e: bad.append(f"pageerror: {e}"))
        for url in [base] + [f"{base}#{it['slug']}" for it in m["items"]]:
            page.goto(url)
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
