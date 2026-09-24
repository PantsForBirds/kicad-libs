#!/usr/bin/env python3
"""Headless smoke test + screenshots of the viewer (dev tool, needs `playwright`).

    python3 screenshot.py --site <OUT with viewer copied in> --shots <dir> [--dark] [--mode http|file|serve]

Opens --site (http: served on a local port; file: straight from disk as file://, like an unzipped
CI artifact; serve: through the site's own serve.py), opens every view mode, fails (exit 1) on any
page error, console error or failed request, and writes PNG screenshots to --shots.
"""
import argparse
import functools
import http.server
import json
import subprocess
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright


def serve(root):
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Quiet, directory=str(root))
    class Server(http.server.ThreadingHTTPServer):
        def handle_error(self, request, client_address):  # cancelled downloads when switching items
            if not isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
                super().handle_error(request, client_address)

    httpd = Server(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}/"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True, type=Path)
    ap.add_argument("--shots", required=True, type=Path)
    ap.add_argument("--dark", action="store_true")
    ap.add_argument("--prefix", default="")
    ap.add_argument("--mode", choices=("http", "file", "serve"), default="http")
    ap.add_argument("--no-3d", action="store_true", help="skip the 3D tab")
    a = ap.parse_args()
    a.shots.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((a.site / "manifest.json").read_text())
    httpd = proc = None
    if a.mode == "http":
        httpd, base = serve(a.site)
    elif a.mode == "file":
        base = (a.site.resolve() / "index.html").as_uri()
    else:
        proc = subprocess.Popen([sys.executable, str(a.site / "serve.py"), "--no-browser"], stdout=subprocess.PIPE, text=True)
        base = proc.stdout.readline().split(" at ")[1].split()[0]
        print("serve.py:", base)
    problems = []
    shots = []
    placement = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark" if a.dark else "light")
        page = ctx.new_page()
        no_review_ok = not (a.site / "review.json").exists()  # the viewer probes for it; a 404 is expected then
        page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))
        page.on("console", lambda m: m.type == "error" and not (no_review_ok and "404" in m.text)
                and problems.append(f"console: {m.text}"))
        # file:// has no review.json probe (data.js carries it), so nothing may fail there either
        page.on("requestfailed", lambda r: problems.append(f"requestfailed: {r.url} {r.failure}"))
        page.on("response", lambda r: r.status >= 400 and not (no_review_ok and r.url.endswith("/review.json"))
                and problems.append(f"HTTP {r.status}: {r.url}"))

        def shot(name, full=False):
            path = a.shots / f"{a.prefix}{name}.png"
            page.screenshot(path=str(path), full_page=full)
            shots.append(path.name)

        page.goto(base)
        page.wait_for_selector("#item-list .item-link")
        shot("00-overview")

        for item in manifest["items"]:
            slug = item["slug"]
            page.goto(f"{base}#{slug}")
            page.reload()  # a hash-only goto doesn't re-run the page; start each item fresh
            page.wait_for_selector(".item-title h1")
            page.wait_for_timeout(400)
            modes = page.eval_on_selector_all(".view-box .seg-btn", "els => els.map(e => e.dataset.mode)")
            for m in modes:
                page.click(f".view-box .seg-btn[data-mode='{m}']")
                page.wait_for_timeout(350)
                if m == "overlay":
                    page.fill(".view-box .slider input", "0.35")
                if m == "swipe":
                    page.fill(".view-box .slider input", "0.4")
                page.wait_for_timeout(150)
                shot(f"{slug}--2d-{m}")
            if item["kind"] == "footprint" and item.get("renders", {}).get("head") and item["renders"]["head"].get("layers"):
                # zoom in with the wheel and hover to exercise pan/zoom + mm readout
                box = page.locator(".pane").first.bounding_box()
                page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                page.mouse.wheel(0, -600)
                page.mouse.move(box["x"] + box["width"] / 2 + 20, box["y"] + box["height"] / 2 + 10)
                page.wait_for_timeout(200)
                readout = page.inner_text(".readout")
                if "mm" not in readout:
                    problems.append(f"{slug}: no mm readout ({readout!r})")
                page.click(".view-box .seg-btn >> nth=0")
                shot(f"{slug}--2d-zoomed")
            if page.locator(".tab[data-tab='3d']").count() and not a.no_3d:
                page.click(".tab[data-tab='3d']")
                try:
                    page.wait_for_selector(".stage3d[data-ready='1']", timeout=120000)
                except Exception as e:  # noqa: BLE001
                    problems.append(f"{slug}: 3D not ready: {e}")
                page.wait_for_timeout(1200)
                status = page.inner_text(".status3d") if page.locator(".status3d").count() else ""
                boxes = page.evaluate("() => window.__cr3d && window.__cr3d.debugBoxes()")
                placement[slug] = {"status": status, "boxes": boxes}
                shot(f"{slug}--3d-default")
                for m in page.eval_on_selector_all(".view-box .seg-btn", "els => els.map(e => e.dataset.mode)"):
                    page.click(f".view-box .seg-btn[data-mode='{m}']")
                    page.wait_for_timeout(600)
                    shot(f"{slug}--3d-{m}")
                page.click(".view-box .seg-btn >> nth=0")
                for v in ("top", "bottom", "side", "iso"):
                    page.click(f".view-box button[data-view='{v}']")
                    page.wait_for_timeout(500)
                    shot(f"{slug}--3d-view-{v}")
                for g in ("model", "board"):
                    if page.locator(f"#g3-{g}").count():
                        page.uncheck(f"#g3-{g}")
                        page.wait_for_timeout(400)
                        shot(f"{slug}--3d-no-{g}")
                        page.check(f"#g3-{g}")
                page.click(".tab[data-tab='2d']")
            # #main scrolls internally, so "full page" = a tall viewport
            page.set_viewport_size({"width": 1440, "height": 3400})
            page.wait_for_timeout(500)
            shot(f"{slug}--full")
            page.set_viewport_size({"width": 1440, "height": 900})
        browser.close()
    if httpd:
        httpd.shutdown()
    if proc:
        proc.terminate()
    print(f"{len(shots)} screenshots in {a.shots}")
    (a.shots / f"{a.prefix}placement.json").write_text(json.dumps(placement, indent=1))
    for slug, pl in placement.items():
        print("3D", slug, "|", " ".join(pl["status"].split()))
        for side, groups in (pl["boxes"] or {}).items():
            for g, bx in groups.items():
                print(f"   {side:4} {g:6} min {[round(v, 2) for v in bx['min']]} max {[round(v, 2) for v in bx['max']]}")
    for pr in problems:
        print("PROBLEM:", pr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
