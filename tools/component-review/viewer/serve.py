#!/usr/bin/env python3
"""Serve this component-review report on http://127.0.0.1:<random port>/ and open it in the browser.

    python3 serve.py [--port N] [--no-browser]

Needed for the full viewer (3D view without the file:// workarounds); double-clicking index.html
also works for everything else. Python 3 standard library only. Listens on 127.0.0.1 only, serves
only this folder, and stops with Ctrl-C.
"""
import argparse
import functools
import http.server
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
                      ".svg": "image/svg+xml", ".wasm": "application/wasm", ".step": "application/octet-stream",
                      ".stp": "application/octet-stream", ".patch": "text/plain; charset=utf-8",
                      ".kicad_mod": "text/plain; charset=utf-8", ".kicad_sym": "text/plain; charset=utf-8"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def list_directory(self, path):  # no directory listings
        self.send_error(404)
        return None

    def log_message(self, fmt, *args):
        pass


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # the browser cancelling a download (switching items) is normal; don't print tracebacks for it
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=0, help="port (default: a free one)")
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser")
    a = ap.parse_args()
    httpd = Server(("127.0.0.1", a.port), functools.partial(Handler, directory=str(ROOT)))
    url = f"http://127.0.0.1:{httpd.server_address[1]}/"
    print(f"Serving {ROOT} at {url}  (Ctrl-C to stop)", flush=True)
    if not a.no_browser:
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
