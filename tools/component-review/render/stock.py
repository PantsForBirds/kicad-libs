"""Optional download of stock KiCad 3D models (``--fetch-stock-models``).

Resolves ``${KICAD<N>_3DMODEL_DIR}/<lib>.3dshapes/<file>`` against the official kicad-packages3D
repository at a pinned tag, over https only, with per-file and total size caps and a local cache
(``--stock-models-dir`` / ``$CR_STOCK_MODELS_DIR``, default ``~/.cache/cr-render/kicad-packages3D``;
layout ``<dir>/<tag>/<lib>.3dshapes/<file>``; files already present are reused, never re-downloaded).
Pinned tags live in ``stock_models_tag.txt`` next to this file.
"""

from __future__ import annotations

import os
import re
import urllib.parse
import urllib.request

HOST = "gitlab.com"
RAW = "https://gitlab.com/kicad/libraries/kicad-packages3D/-/raw/{tag}/{path}"
TAG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stock_models_tag.txt")


def load_pinned(path: str = TAG_FILE) -> dict[str, str]:
    """Pinned tags per KiCad major version, from stock_models_tag.txt (lines '<major>=<tag>')."""
    pins = {}
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.split("#", 1)[0].strip()
                if "=" in line:
                    k, v = (x.strip() for x in line.split("=", 1))
                    pins[k] = v
    except OSError:
        pass
    return pins or {"10": "10.0.6", "9": "9.0.9.1"}


PINNED = load_pinned()
DEFAULT_TAG = PINNED.get("10") or sorted(PINNED.values())[-1]
VAR_RE = re.compile(r"^\$\{(?:KICAD(\d+)_3DMODEL_DIR|KISYS3DMOD)\}/(.+)$")
SAFE_PATH = re.compile(r"^[A-Za-z0-9_.+\-]+\.3dshapes/[A-Za-z0-9_.,+\-() ]+\.(?:step|stp|wrl)$", re.I)


class StockFetcher:
    def __init__(self, tag: str | None = None, max_file_mb: float = 25, max_total_mb: float = 300,
                 cache_dir: str | None = None, timeout: float = 30):
        self.tag_override = tag
        self.max_file = int(max_file_mb * 1024 * 1024)
        self.max_total = int(max_total_mb * 1024 * 1024)
        self.downloaded = 0
        self.timeout = timeout
        base = cache_dir or os.environ.get("CR_STOCK_MODELS_DIR") or os.path.join(
            os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"), "cr-render", "kicad-packages3D")
        self.cache = base

    def parse(self, path_raw: str):
        """-> (tag, repo path) or None if not a stock-model reference."""
        m = VAR_RE.match(path_raw.replace("\\", "/"))
        if not m:
            return None
        major, rel = m.group(1), m.group(2)
        tag = self.tag_override or PINNED.get(major or "", DEFAULT_TAG)
        rel = os.path.normpath(rel).replace(os.sep, "/")
        return tag, rel

    def fetch(self, path_raw: str) -> tuple[str | None, dict]:
        """Download (or reuse cached) model. Returns (local path | None, info dict for the manifest)."""
        parsed = self.parse(path_raw)
        if parsed is None:
            return None, {"error": "not a stock model path"}
        tag, rel = parsed
        stem, ext = os.path.splitext(rel)
        # KiCad itself falls back between .wrl and .step; STEP is what the 3D viewers can load.
        cands = [stem + ".step", stem + ".stp", rel] if ext.lower() == ".wrl" else [rel]
        errors = []
        for cand in dict.fromkeys(cands):
            if not SAFE_PATH.match(cand) or ".." in cand.split("/"):
                errors.append(f"unsafe path {cand!r}")
                continue
            url = RAW.format(tag=urllib.parse.quote(tag), path=urllib.parse.quote(cand))
            info = {"tag": tag, "path": cand, "url": url}
            dst = os.path.join(self.cache, tag, *cand.split("/"))
            if os.path.isfile(dst) and os.path.getsize(dst) > 0:
                info["cached"] = True
                return dst, info
            try:
                data = self._get(url)
            except Exception as e:  # 404 etc: try the next candidate
                errors.append(f"{cand}: {e}")
                continue
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            tmp = dst + ".part"
            with open(tmp, "wb") as fh:
                fh.write(data)
            os.replace(tmp, dst)
            info["cached"] = False
            return dst, info
        return None, {"tag": tag, "path": rel, "error": "; ".join(errors)[:500]}

    def _get(self, url: str) -> bytes:
        u = urllib.parse.urlparse(url)
        if u.scheme != "https" or u.hostname != HOST:
            raise ValueError("refusing non-https / unexpected host")
        if self.downloaded >= self.max_total:
            raise RuntimeError("total download cap reached")
        req = urllib.request.Request(url, headers={"User-Agent": "kicad-libs-component-review/1"})
        with urllib.request.urlopen(req, timeout=self.timeout) as r:  # noqa: S310 (https + host checked)
            final = urllib.parse.urlparse(r.geturl())
            if final.scheme != "https":
                raise ValueError("redirected to non-https")
            n = r.headers.get("Content-Length")
            if n and int(n) > self.max_file:
                raise RuntimeError(f"file too large ({int(n) / 1e6:.1f} MB)")
            data = r.read(self.max_file + 1)
            if len(data) > self.max_file:
                raise RuntimeError("file too large")
            if data[:5] != b"ISO-1" and not url.lower().endswith(".wrl"):
                raise RuntimeError("response is not a STEP file")
        self.downloaded += len(data)
        return data
