"""Datasheet acquisition: local copy in OUT, repo datasheets/ dir, or download.

Downloads are guarded because this may run in a privileged CI job on
PR-controlled URLs. Knobs (environment, read at call time):

  CR_DS_HTTPS_ONLY=1      reject http:// URLs and any redirect to http://
  CR_DS_MAX_BYTES         abort once the body passes this many bytes (default 20971520)
  CR_DS_TIMEOUT_S         TOTAL wall-clock deadline per download, not per read (default 20)
  CR_DS_MAX_DOWNLOADS     network downloads per run (default 20); later ones are
                          recorded as "datasheet not fetched (limit)"

Always: http(s) only; the host name is resolved and every address must be public
(no private/loopback/link-local/reserved), re-checked on every redirect; the
body must be a PDF (%PDF magic). Results are cached per URL on disk and in memory.
"""

from __future__ import annotations

import hashlib
import io
import ipaddress
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

# The Messages API caps a request at 32 MB; base64 inflates by 4/3.
MAX_INLINE_PDF_BYTES = 20 * 1024 * 1024
DEFAULT_MAX_PAGES = 40
UA = "kicad-libs-component-review/1 (+https://github.com/PantsForBirds/kicad-libs)"
# Content types that can never be a datasheet (or a landing page linking to one).
_NON_PDF_CTYPE = re.compile(r"^(image|video|audio|font)/|^application/(zip|x-|vnd\.|msword|json|xml)", re.I)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def https_only() -> bool:
    return os.environ.get("CR_DS_HTTPS_ONLY", "").strip().lower() in ("1", "true", "yes")


def max_bytes() -> int:
    return _env_int("CR_DS_MAX_BYTES", 20971520)


def timeout_s() -> float:
    return float(_env_int("CR_DS_TIMEOUT_S", 20))


def max_downloads() -> int:
    return _env_int("CR_DS_MAX_DOWNLOADS", 20)


# Pages mentioning these are kept first when a PDF has to be trimmed.
PAGE_KEYWORDS = (
    "land pattern", "recommended", "footprint", "pcb layout", "solder pad", "pad layout",
    "mounting pad", "package outline", "package dimension", "mechanical", "dimensions",
    "pin configuration", "pin description", "pin function", "pinout", "pin assignment",
    "ordering", "marking", "absolute maximum",
)


@dataclass
class Datasheet:
    pdf: bytes | None  # final bytes to send (possibly trimmed)
    source: str | None  # url or path we used
    note: str  # human-readable explanation of what happened
    pages_total: int | None = None
    pages_sent: list[int] | None = None  # 1-based page numbers sent (None = all)


class _Blocked(Exception):
    pass


def _check_url(url: str) -> None:
    """Raise _Blocked unless url is http(s) to a host whose addresses are all public."""
    u = urllib.parse.urlsplit(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise _Blocked(f"unsupported URL scheme/host: {url}")
    if u.scheme == "http" and https_only():
        raise _Blocked(f"http:// not allowed (CR_DS_HTTPS_ONLY): {url}")
    try:
        infos = socket.getaddrinfo(u.hostname, u.port or (443 if u.scheme == "https" else 80), proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError) as e:
        raise _Blocked(f"DNS lookup failed for {u.hostname}: {e}") from e
    if not infos:
        raise _Blocked(f"no addresses for {u.hostname}")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%", 1)[0])
        if getattr(ip, "ipv4_mapped", None):
            ip = ip.ipv4_mapped
        if not ip.is_global or ip.is_multicast:
            raise _Blocked(f"refusing non-public address {ip} for {u.hostname}")


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _cache_path(cache_dir: str | None, url: str) -> str | None:
    if not cache_dir:
        return None
    return os.path.join(cache_dir, hashlib.sha256(url.encode()).hexdigest()[:32] + ".pdf")


_mem_cache: dict[str, tuple[bytes | None, str]] = {}
_lock = threading.Lock()
_downloads = 0


def reset() -> None:
    """Start a new run: clears the per-run download counter and memory cache."""
    global _downloads
    with _lock:
        _downloads = 0
        _mem_cache.clear()


def _take_download_slot() -> bool:
    global _downloads
    with _lock:
        if _downloads >= max_downloads():
            return False
        _downloads += 1
        return True


_PDF_LINK_RE = re.compile(rb"https://[A-Za-z0-9.-]+/[^\"'<>\s]*?\.pdf(?:\?[^\"'<>\s]*)?", re.I)


def _site(host: str) -> str:
    return ".".join((host or "").lower().rsplit(".", 2)[-2:])


def _embedded_pdf_link(html: bytes, page_url: str) -> str | None:
    """Distributor landing pages (e.g. LCSC) embed the real PDF link; pick one on the same site."""
    page_host = urllib.parse.urlsplit(page_url).hostname or ""
    for m in _PDF_LINK_RE.finditer(html[:2_000_000]):
        link = m.group(0).decode("ascii", "replace").replace("&amp;", "&")
        host = urllib.parse.urlsplit(link).hostname or ""
        if link != page_url and _site(host) == _site(page_host):
            return link
    return None


def _fetch(url: str, opener) -> tuple[bytes | None, str, str]:
    """One guarded GET. Returns (body or None, content_type, error_note)."""
    deadline = time.monotonic() + timeout_s()
    limit = max_bytes()
    _check_url(url)
    op = opener or urllib.request.build_opener(_SafeRedirect)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/pdf,*/*;q=0.5"})
    with op.open(req, timeout=timeout_s()) as resp:
        final = resp.geturl() if hasattr(resp, "geturl") else url
        if final and final != url:
            _check_url(final)  # belt and braces: the redirect handler already checked it
        ctype = resp.headers.get("Content-Type", "") or ""
        if _NON_PDF_CTYPE.search(ctype):
            return None, ctype, f"datasheet URL {url} returned {ctype}, not a PDF; not used"
        length = resp.headers.get("Content-Length")
        if length and length.isdigit() and int(length) > limit:
            return None, ctype, f"datasheet at {url} is {int(length)} bytes (> CR_DS_MAX_BYTES {limit}); not used"
        buf = io.BytesIO()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None, ctype, f"datasheet download from {url} exceeded {timeout_s():g}s total (CR_DS_TIMEOUT_S); not used"
            sock = getattr(getattr(getattr(resp, "fp", None), "raw", None), "_sock", None)
            if sock is not None:
                try:
                    sock.settimeout(max(0.1, remaining))
                except OSError:
                    pass
            chunk = resp.read(1 << 16)
            if not chunk:
                break
            buf.write(chunk)
            if buf.tell() > limit:
                return None, ctype, f"datasheet at {url} passed {limit} bytes (CR_DS_MAX_BYTES); aborted"
        if time.monotonic() > deadline:
            return None, ctype, f"datasheet download from {url} exceeded {timeout_s():g}s total (CR_DS_TIMEOUT_S); not used"
        return buf.getvalue(), ctype, ""


def download(url: str, cache_dir: str | None = None, opener=None, _follow_html: bool = True) -> tuple[bytes | None, str]:
    """Return (pdf_bytes_or_None, note). Never raises for network/content problems."""
    if url in _mem_cache:
        return _mem_cache[url]
    cp = _cache_path(cache_dir, url)
    if cp and os.path.isfile(cp):
        with open(cp, "rb") as f:
            data = f.read()
        if data.startswith(b"%PDF"):
            res = (data, f"downloaded (cached) from {url}")
            _mem_cache[url] = res
            return res
    if not _take_download_slot():
        res = (None, f"datasheet not fetched (limit): CR_DS_MAX_DOWNLOADS={max_downloads()} reached; {url}")
        _mem_cache[url] = res
        return res
    try:
        data, ctype, err = _fetch(url, opener)
    except _Blocked as e:
        res = (None, f"datasheet URL not fetched: {e}")
    except (urllib.error.URLError, OSError, ValueError, socket.timeout) as e:
        res = (None, f"datasheet download failed for {url}: {e}")
    else:
        if data is None:
            res = (None, err)
        elif data.startswith(b"%PDF"):
            res = (data, f"downloaded from {url}")
            if cp:
                try:
                    os.makedirs(os.path.dirname(cp), exist_ok=True)
                    with open(cp, "wb") as f:
                        f.write(data)
                except OSError:
                    pass
        else:
            link = _embedded_pdf_link(data, url) if _follow_html else None
            if link:
                pdf, note = download(link, cache_dir, opener, _follow_html=False)
                res = (pdf, f"{url} is an HTML page; {note}")
            else:
                res = (None, f"datasheet URL {url} did not return a PDF (Content-Type {ctype or '?'}); not used")
    _mem_cache[url] = res
    return res


def trim_pdf(data: bytes, max_pages: int, max_bytes: int = MAX_INLINE_PDF_BYTES):
    """Return (bytes, pages_total, pages_sent, note). Uses pypdf if available.

    If the PDF is within limits it is returned unchanged. Otherwise the most
    relevant pages (keyword hits, then the first pages) are kept.
    """
    try:
        import pypdf  # optional dependency
    except ImportError:
        pypdf = None
    if pypdf is None:
        if len(data) > max_bytes:
            return None, None, None, f"PDF is {len(data) // 1048576} MB and pypdf is not installed to trim it; not sent"
        return data, None, None, ""
    try:
        reader = pypdf.PdfReader(io.BytesIO(data))
        total = len(reader.pages)
    except Exception as e:  # pypdf raises many exception types on bad PDFs
        if len(data) > max_bytes:
            return None, None, None, f"PDF unreadable ({e}) and too large; not sent"
        return data, None, None, f"PDF could not be inspected ({e}); sent as-is"
    if total <= max_pages and len(data) <= max_bytes:
        return data, total, None, ""
    scores = []
    for i, page in enumerate(reader.pages):
        try:
            text = (page.extract_text() or "").lower()
        except Exception:
            text = ""
        hits = sum(text.count(k) for k in PAGE_KEYWORDS)
        scores.append((hits, i))
    keep = {0, 1} & set(range(total))  # title + features/pinout overview
    for hits, i in sorted(scores, key=lambda t: (-t[0], t[1])):
        if len(keep) >= max_pages:
            break
        if hits > 0:
            keep.add(i)
    for i in range(total):  # fill up with leading pages
        if len(keep) >= max_pages:
            break
        keep.add(i)
    pages = sorted(keep)
    while True:
        writer = pypdf.PdfWriter()
        for i in pages:
            writer.add_page(reader.pages[i])
        out = io.BytesIO()
        writer.write(out)
        blob = out.getvalue()
        if len(blob) <= max_bytes or len(pages) <= 4:
            break
        pages = pages[: max(4, len(pages) * 3 // 4)]
    if len(blob) > max_bytes:
        return None, total, None, "PDF still too large after trimming; not sent"
    sent = [i + 1 for i in pages]
    return blob, total, sent, f"trimmed to {len(sent)} of {total} pages (land-pattern/pinout pages prioritised): {sent}"


def resolve(item: dict, out_dir: str, repo: str | None, cache_dir: str | None,
            allow_download: bool, max_pages: int, safe_join, opener=None) -> Datasheet:
    ds = item.get("datasheet") or {}
    url = ds.get("url")
    candidates = []
    if ds.get("file"):
        candidates.append(("out", ds["file"]))
    if ds.get("local") and repo:
        candidates.append(("repo", ds["local"]))
    notes = []
    for where, rel in candidates:
        base = out_dir if where == "out" else repo
        path = safe_join(base, rel)
        if path and os.path.isfile(path):
            with open(path, "rb") as f:
                data = f.read()
            if not data.startswith(b"%PDF"):
                notes.append(f"{rel} is not a PDF")
                continue
            return _finish(data, rel if where == "repo" else (ds.get("local") or rel), max_pages, "local file")
        notes.append(f"{rel} not found in {'OUT' if where == 'out' else 'repo'}")
    if not url:
        return Datasheet(None, None, "; ".join(notes + ["no datasheet URL in the item's properties"]))
    if not allow_download:
        return Datasheet(None, url, "; ".join(notes + [f"download disabled; {url} not fetched"]))
    data, note = download(url, cache_dir, opener)
    if data is None:
        return Datasheet(None, url, "; ".join(notes + [note]))
    return _finish(data, url, max_pages, note)


def _finish(data: bytes, source: str, max_pages: int, how: str) -> Datasheet:
    blob, total, sent, note = trim_pdf(data, max_pages)
    if blob is None:
        return Datasheet(None, source, f"{how}; {note}", total, None)
    return Datasheet(blob, source, f"{how}" + (f"; {note}" if note else ""), total, sent)
