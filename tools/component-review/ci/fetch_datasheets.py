#!/usr/bin/env python3
"""Fetch datasheets for the AI review under strict limits (runs in the privileged job).

Datasheet URLs come from the pull request, so the privileged job must not fetch them
blindly. This script builds a private work copy of the site for the AI step and downloads
each item's datasheet into it:

  * https only (redirects too), default port only, hosts must resolve to public IPs only;
    an http:// URL is retried as https:// and refused only if that fails;
  * at most --max-bytes per file (default 20 MB), --timeout seconds wall-clock per download
    (default 20 s), --max-downloads per run (default 20), --budget seconds overall (120 s);
  * the body must be a PDF (%PDF magic), otherwise it is discarded;
  * the PDFs go to WORK/items/<slug>/datasheet_dl.pdf and WORK/manifest.json gets
    datasheet.file pointing at them. They're kept out of the Pages site, because
    vendor datasheets shouldn't be republished there.

Afterwards run `cr_ai_review.py --out WORK --no-download` and copy WORK/review.json and
review.md back into the site. Files in WORK are hard links to the site where possible, so
the copy is cheap. Only new files are written in WORK: nothing is modified in place.

Usage: fetch_datasheets.py --site SITE --work WORK [--no-fetch]
"""
from __future__ import annotations

import argparse
import http.client
import ipaddress
import json
import os
import re
import shutil
import socket
import ssl
import sys
import time
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import load_json, log, safe_site_file, safe_slug  # noqa: E402

MB = 1024 * 1024
UA = "kicad-libs-component-review (+https://github.com/PantsForBirds/kicad-libs)"
MAX_REDIRECTS = 3


PDF_LINK_RE = re.compile(rb"https://[A-Za-z0-9.-]+/[^\"'<>\s]*?\.pdf(?:\?[^\"'<>\s]*)?", re.IGNORECASE)


class Refused(Exception):
    pass


def _site(host: str) -> str:
    return ".".join(host.lower().split(".")[-2:])


def embedded_pdf_link(html: bytes, page_url: str) -> str | None:
    """Distributor landing pages (e.g. LCSC) embed the real PDF link: take one on the same site."""
    page_host = urllib.parse.urlsplit(page_url).hostname or ""
    for m in PDF_LINK_RE.finditer(html[:2_000_000]):
        link = m.group(0).decode("ascii", "replace").replace("&amp;", "&")
        if link != page_url and _site(urllib.parse.urlsplit(link).hostname or "") == _site(page_host):
            return link
    return None


def _public_ip(host: str) -> str:
    """Resolve once, require every address to be public, return one to connect to (no rebinding)."""
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise Refused(f"DNS lookup failed for {host}: {e}") from None
    ips = [info[4][0] for info in infos]
    for ip in ips:
        if not ipaddress.ip_address(ip).is_global:
            raise Refused(f"{host} resolves to non-public address {ip}")
    if not ips:
        raise Refused(f"no address for {host}")
    return ips[0]


def check_url(url: str) -> urllib.parse.SplitResult:
    u = urllib.parse.urlsplit(url)
    if u.scheme != "https":
        raise Refused(f"not https: {url}")
    if not u.hostname or u.username or u.password:
        raise Refused(f"bad host in {url}")
    if u.port not in (None, 443):
        raise Refused(f"non-default port in {url}")
    return u


class _PinnedHTTPS(http.client.HTTPSConnection):
    """HTTPS connection to a pre-resolved IP, with SNI and certificate check for the hostname."""

    def __init__(self, host: str, ip: str, timeout: float):
        super().__init__(host, 443, timeout=timeout, context=ssl.create_default_context())
        self._ip = ip

    def connect(self):
        sock = socket.create_connection((self._ip, 443), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def fetch_pdf(url: str, max_bytes: int, timeout: float, _follow_html: bool = True) -> bytes:
    deadline = time.monotonic() + timeout
    for _ in range(MAX_REDIRECTS + 1):
        u = check_url(url)
        ip = _public_ip(u.hostname)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise Refused("timed out")
        conn = _PinnedHTTPS(u.hostname, ip, timeout=min(remaining, 10))
        try:
            path = urllib.parse.urlunsplit(("", "", u.path or "/", u.query, ""))
            conn.request("GET", path, headers={"User-Agent": UA, "Accept": "application/pdf"})
            resp = conn.getresponse()
            if resp.status in (301, 302, 303, 307, 308):
                loc = resp.getheader("Location")
                if not loc:
                    raise Refused(f"redirect without Location from {url}")
                url = urllib.parse.urljoin(url, loc)
                continue
            if resp.status != 200:
                raise Refused(f"HTTP {resp.status} from {url}")
            length = resp.getheader("Content-Length")
            if length and length.isdigit() and int(length) > max_bytes:
                raise Refused(f"{int(length) // MB} MB > {max_bytes // MB} MB cap")
            buf = bytearray()
            while True:
                if time.monotonic() > deadline:
                    raise Refused(f"timed out after {timeout:.0f} s")
                chunk = resp.read(65536)
                if not chunk:
                    break
                buf += chunk
                if len(buf) > max_bytes:
                    raise Refused(f"larger than {max_bytes // MB} MB cap")
            if not bytes(buf[:1024]).lstrip().startswith(b"%PDF"):
                link = embedded_pdf_link(bytes(buf), url) if _follow_html else None
                if not link:
                    raise Refused("response is not a PDF")
                conn.close()
                return fetch_pdf(link, max_bytes, max(1.0, deadline - time.monotonic()), _follow_html=False)
            return bytes(buf)
        except (OSError, http.client.HTTPException) as e:
            raise Refused(f"download failed: {e}") from None
        finally:
            conn.close()
    raise Refused("too many redirects")


def https_variant(url: str) -> str | None:
    """The URL to actually fetch: https as-is, http:// upgraded to https://, else None."""
    u = urllib.parse.urlsplit(url)
    if u.scheme == "https":
        return url
    if u.scheme == "http" and u.port in (None, 80):
        return urllib.parse.urlunsplit(("https", u.hostname or "", u.path, u.query, u.fragment))
    return None


def link_tree(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    for p in src.rglob("*"):
        if p.is_symlink() or not p.is_file():
            continue
        out = dst / p.relative_to(src)
        out.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(p, out)
        except OSError:
            shutil.copy2(p, out)


def prepare(site: Path, work: Path, *, fetch: bool = True, max_bytes: int = 20 * MB,
            timeout: float = 20, max_downloads: int = 20, budget: float = 120, fetcher=fetch_pdf) -> dict:
    link_tree(site, work)
    manifest = load_json(work / "manifest.json")
    if not isinstance(manifest, dict) or not isinstance(manifest.get("items"), list):
        raise SystemExit("fetch_datasheets: no usable manifest.json")
    stats = {"fetched": 0, "skipped": [], "upgraded": []}
    by_url: dict[str, str | None] = {}
    started = time.monotonic()
    for item in manifest["items"]:
        if not isinstance(item, dict):
            continue
        ds = item.get("datasheet")
        slug = safe_slug(item.get("slug"))
        if not isinstance(ds, dict) or not slug:
            continue
        if ds.get("file") and safe_site_file(work, ds.get("file"), slug):
            continue                                   # render already copied a local PDF
        url = ds.get("url")
        if not isinstance(url, str) or not url.strip():
            continue
        url = url.strip()
        if url in by_url:
            rel = by_url[url]
        elif not fetch:
            stats["skipped"].append(f"{url}: fetching disabled")
            rel = by_url[url] = None
        elif len(by_url) >= max_downloads or time.monotonic() - started > budget:
            stats["skipped"].append(f"{url}: download budget exhausted")
            rel = by_url[url] = None
        else:
            target = https_variant(url)
            try:
                if target is None:
                    raise Refused("not https")
                data = fetcher(target, max_bytes, timeout)
            except Refused as e:
                why = f"http:// not allowed and {target} failed: {e}" if target and target != url else str(e)
                stats["skipped"].append(f"{url}: {why}")
                rel = by_url[url] = None
            else:
                if target != url:
                    stats["upgraded"].append(f"{url} -> {target}")
                rel = f"items/{slug}/datasheet_dl.pdf"
                (work / rel).write_bytes(data)
                stats["fetched"] += 1
                by_url[url] = rel
        if rel:
            ds["file"] = rel
    mpath = work / "manifest.json"
    mpath.unlink()                                     # hard link to the site copy: replace, don't modify
    mpath.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    return stats


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", required=True, type=Path)
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--no-fetch", action="store_true", help="only build the work copy")
    ap.add_argument("--max-bytes", type=int, default=int(os.environ.get("CR_DS_MAX_BYTES", 20 * MB)))
    ap.add_argument("--timeout", type=float, default=float(os.environ.get("CR_DS_TIMEOUT_S", 20)))
    ap.add_argument("--max-downloads", type=int, default=int(os.environ.get("CR_DS_MAX_DOWNLOADS", 20)))
    ap.add_argument("--budget", type=float, default=float(os.environ.get("CR_DS_BUDGET_S", 120)))
    a = ap.parse_args(argv)
    stats = prepare(a.site, a.work, fetch=not a.no_fetch, max_bytes=a.max_bytes, timeout=a.timeout,
                    max_downloads=a.max_downloads, budget=a.budget)
    log(f"fetch_datasheets: fetched {stats['fetched']} (upgraded to https: {len(stats['upgraded'])}), "
        f"skipped {len(stats['skipped'])}")
    for u in stats["upgraded"]:
        log(f"  upgraded {u}")
    for s in stats["skipped"]:
        log(f"  skipped {s}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
