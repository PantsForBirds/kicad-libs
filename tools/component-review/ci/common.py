"""Shared helpers for the component-review CI scripts (stdlib only).

Everything read from the review artifact (manifest.json, review.json, file names) is
UNTRUSTED: it was produced by code from a pull request. These helpers validate and escape
it before it goes into markdown, URLs, git or the GitHub API.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MARKER = "<!-- component-review -->"
FINDING_MARKER_RE = re.compile(r"<!-- cr-finding:([0-9a-f]{16}) -->")
SLUG_RE = re.compile(r"^[A-Za-z0-9._-]{1,200}$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
REPO_RE = re.compile(r"^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$")
# repo-relative paths as they appear in the manifest (lib_fp/..., lib_sch/...)
REPO_PATH_RE = re.compile(r"^(?!/)(?!.*(?:^|/)\.\.(?:/|$))[A-Za-z0-9 ._+,()@#=&'-][A-Za-z0-9 ._+,()@#=&'/-]{0,300}$")

VERDICT_RANK = {"pass": 0, "warn": 1, "fail": 2}
SEVERITY_RANK = {"info": 0, "warning": 1, "error": 2}


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


# --------------------------------------------------------------------------- validation

def parse_pr_number(value) -> int:
    """PR number from untrusted input: must be a positive int (not bool, not '12; rm')."""
    if isinstance(value, bool):
        raise ValueError("PR number must be an integer")
    if isinstance(value, int):
        n = value
    elif isinstance(value, str) and re.fullmatch(r"[0-9]{1,9}", value.strip()):
        n = int(value.strip())
    else:
        raise ValueError(f"invalid PR number: {value!r}")
    if n <= 0:
        raise ValueError(f"invalid PR number: {value!r}")
    return n


def check_sha(value) -> str:
    if not isinstance(value, str) or not SHA_RE.fullmatch(value):
        raise ValueError(f"invalid commit sha: {value!r}")
    return value


def check_repo(value) -> str:
    if not isinstance(value, str) or not REPO_RE.fullmatch(value) or ".." in value:
        raise ValueError(f"invalid owner/repo: {value!r}")
    return value


def safe_slug(value) -> str | None:
    if isinstance(value, str) and SLUG_RE.fullmatch(value) and value not in (".", ".."):
        return value
    return None


def safe_repo_path(value) -> str | None:
    if isinstance(value, str) and REPO_PATH_RE.fullmatch(value):
        return value
    return None


def safe_site_file(site: Path, rel, slug: str | None = None) -> str | None:
    """A manifest-referenced file inside the site dir, e.g. items/<slug>/head.png.

    Returns the normalized relative path if it exists inside `site` (and, when `slug` is
    given, under items/<slug>/), else None.
    """
    if not isinstance(rel, str) or not rel or rel.startswith("/") or "\\" in rel:
        return None
    parts = rel.split("/")
    if any(p in ("", ".", "..") or not SLUG_RE.fullmatch(p) for p in parts):
        return None
    if slug is not None and (len(parts) < 3 or parts[0] != "items" or parts[1] != slug):
        return None
    p = site / rel
    try:
        if p.is_symlink() or not p.is_file():
            return None
        p.resolve().relative_to(site.resolve())
    except (OSError, ValueError):
        return None
    return rel


def safe_http_url(value) -> str | None:
    if not isinstance(value, str) or len(value) > 500:
        return None
    try:
        u = urllib.parse.urlsplit(value.strip())
    except ValueError:
        return None
    if u.scheme not in ("http", "https") or not u.netloc:
        return None
    # percent-encode chars that would break markdown link syntax or HTML attributes
    return urllib.parse.quote(value.strip(), safe=":/?#[]@!$&'*+,;=%-._~").replace("(", "%28").replace(")", "%29")


# --------------------------------------------------------------------------- markdown escaping

_WS_RE = re.compile(r"\s+")
_MENTION_RE = re.compile(r"@(?=[A-Za-z0-9])")


def _escape_common(s: str) -> str:
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    s = _MENTION_RE.sub("&#64;", s)          # no @-mentions / team pings
    s = s.replace("![", "!&#91;")             # no remote images from untrusted text
    return s


def truncate(s: str, n: int) -> str:
    return s if len(s) <= n else s[: max(0, n - 1)].rstrip() + "…"


def md_inline(value, maxlen: int = 200) -> str:
    """One line of untrusted text, safe inside a markdown table cell."""
    if value is None:
        return ""
    s = _WS_RE.sub(" ", str(value)).strip()
    s = truncate(s, maxlen)
    s = _escape_common(s)
    return s.replace("|", "\\|")


def md_block(value, maxlen: int = 2000) -> str:
    """Multi-line untrusted markdown: keeps formatting, drops raw HTML, mentions and images."""
    if value is None:
        return ""
    s = str(value).replace("\r\n", "\n").replace("\r", "\n").strip()
    s = truncate(s, maxlen)
    return _escape_common(s)


def md_code(value, maxlen: int = 120) -> str:
    """Inline code span for identifiers (names, paths)."""
    s = truncate(_WS_RE.sub(" ", str(value or "")).strip(), maxlen).replace("`", "'")
    return f"`{s}`" if s else ""


# --------------------------------------------------------------------------- data loading

def load_json(path: Path, max_bytes: int = 20_000_000):
    try:
        if path.stat().st_size > max_bytes:
            log(f"warning: {path} too large, ignored")
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        log(f"warning: cannot read {path}: {e}")
        return None


def load_site(site: Path):
    """(manifest, review) from a site dir; manifest items normalized to a list of dicts."""
    manifest = load_json(site / "manifest.json")
    if not isinstance(manifest, dict):
        manifest = {"items": []}
    items = manifest.get("items")
    manifest["items"] = [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []
    review = load_json(site / "review.json")
    if not isinstance(review, dict):
        review = None
    elif not isinstance(review.get("items"), dict):
        review["items"] = {}
    return manifest, review


def item_review(review, item_id) -> dict:
    if not review or not isinstance(item_id, str):
        return {}
    r = review["items"].get(item_id)
    return r if isinstance(r, dict) else {}


def generator_of(review) -> str:
    """What produced review.json: `generator`, or `model` in files written before it existed."""
    for k in ("generator", "model"):
        v = review.get(k) if review else None
        if isinstance(v, str) and v.strip():
            return v
    return ""


def findings_of(ir: dict) -> list[dict]:
    fs = ir.get("findings")
    out = [f for f in fs if isinstance(f, dict)] if isinstance(fs, list) else []
    return sorted(out, key=lambda f: -SEVERITY_RANK.get(f.get("severity"), -1))


def verdict_of(ir: dict) -> str | None:
    v = ir.get("verdict")
    return v if v in VERDICT_RANK else None


def finding_line_no(f: dict, item: dict | None = None) -> tuple[int, bool]:
    """(line, exact) for linking/annotating a finding. Findings without a usable line (e.g.
    from the KLC checker) point at the item's first line in the file, or line 1, never 0."""
    line = f.get("line")
    if isinstance(line, int) and not isinstance(line, bool) and line > 0:
        return line, True
    lr = (item or {}).get("line_range")
    if isinstance(lr, dict):
        rng = lr.get("base" if (item or {}).get("status") == "deleted" else "head")
        if isinstance(rng, list) and rng and isinstance(rng[0], int) and not isinstance(rng[0], bool) and rng[0] > 0:
            return rng[0], False
    return 1, False


def overall_verdict(manifest, review) -> str | None:
    if not review:
        return None
    vs = [verdict_of(item_review(review, i.get("id"))) for i in manifest["items"]]
    vs = [v for v in vs if v]
    if not vs:
        return None
    return max(vs, key=VERDICT_RANK.__getitem__)


# --------------------------------------------------------------------------- GitHub API

class GitHub:
    """Minimal REST client. `read_only=True` refuses anything but GET (used by --dry-run)."""

    def __init__(self, token: str | None, api_url: str | None = None, read_only: bool = False):
        self.token = token
        self.api = (api_url or os.environ.get("GITHUB_API_URL") or "https://api.github.com").rstrip("/")
        self.read_only = read_only

    @classmethod
    def from_env(cls, read_only: bool = False) -> "GitHub":
        token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
        if not token:
            try:  # local convenience: reuse the gh CLI login
                token = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True,
                                       timeout=20).stdout.strip() or None
            except (OSError, subprocess.SubprocessError):
                token = None
        return cls(token, read_only=read_only)

    def request(self, method: str, path: str, body=None, accept: str = "application/vnd.github+json"):
        if self.read_only and method != "GET":
            raise RuntimeError(f"read-only client refused {method} {path}")
        url = path if path.startswith("https://") else self.api + path
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Accept", accept)
        req.add_header("X-GitHub-Api-Version", "2022-11-28")
        req.add_header("User-Agent", "kicad-libs-component-review")
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
                link = resp.headers.get("Link", "")
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:500]
            raise RuntimeError(f"GitHub API {method} {path} -> {e.code}: {detail}") from None
        return (json.loads(raw) if raw else None), link

    def get(self, path: str):
        return self.request("GET", path)[0]

    def paginate(self, path: str, limit_pages: int = 30) -> list:
        sep = "&" if "?" in path else "?"
        url = f"{path}{sep}per_page=100"
        out: list = []
        for _ in range(limit_pages):
            data, link = self.request("GET", url)
            out.extend(data or [])
            m = re.search(r'<([^>]+)>;\s*rel="next"', link or "")
            if not m:
                break
            url = m.group(1)
        return out


def write_outputs(**kv) -> None:
    """Write step outputs to $GITHUB_OUTPUT (values are validated scalars, no newlines)."""
    target = os.environ.get("GITHUB_OUTPUT")
    lines = []
    for k, v in kv.items():
        v = "" if v is None else str(v)
        if "\n" in v:
            raise ValueError(f"output {k} contains a newline")
        lines.append(f"{k}={v}")
    if target:
        with open(target, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    else:
        log("outputs: " + " ".join(lines))
