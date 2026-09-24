#!/usr/bin/env python3
"""AI-assisted review of KiCad footprints/symbols changed in a kicad-libs PR.

Reads OUT/manifest.json (written by the render step) plus per-item assets and
writes OUT/review.json and OUT/review.md (see cr-shared/CONTRACT.md).

  python3 tools/component-review/ai/cr_ai_review.py --out cr-out [--repo .]
        [--no-llm] [--dry-run] [--model M]

--no-llm   deterministic KLC-style checks only (no API key needed)
--dry-run  also build the exact API request per item and save it to
           OUT/ai-requests/<slug>.json (binaries elided) without calling the API

OUT must be self-contained (the privileged CI job has no PR checkout), so
everything is read from OUT; --repo is optional extra context. Nothing from
OUT is ever executed, and every path taken from the manifest is confined to OUT.
Exit status is 0 whenever review.json was written, even with findings.
"""

from __future__ import annotations

import argparse
import base64
import datetime as _dt
import hashlib
import json
import os
import re
import struct
import sys
import traceback
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import datasheet as ds_mod  # noqa: E402
import kicad_checks as kc  # noqa: E402
import klc_utils  # noqa: E402
import prompts  # noqa: E402
import sexpr  # noqa: E402

DEFAULT_MODEL = "claude-fable-5-1"
DEFAULT_EFFORT = "high"
MAX_TOKENS = 32000
# Models that accept the server-side `fallbacks: "default"` parameter.
FALLBACK_MODELS = {"claude-fable-5-1", "claude-mythos-5-1", "claude-opus-5"}
FALLBACK_BETA = "server-side-fallback-2026-07-01"
# USD per 1M tokens: input, output, cache write (5 min), cache read.
PRICES = {
    "claude-fable-5-1": (10.0, 50.0, 12.5, 0.25),
    "claude-opus-5-5": (4.0, 20.0, 5.0, 0.20),
    "claude-opus-5": (5.0, 25.0, 6.25, 0.50),
    "claude-sonnet-5": (2.0, 10.0, 2.5, 0.20),
    "claude-haiku-4-5": (1.0, 5.0, 1.25, 0.10),
}
MAX_IMAGE_BYTES = 5 * 1024 * 1024  # API per-image limit
MAX_IMAGE_DIM = 8000
MAX_DIFF_CHARS = 60_000
SEV_ORDER = {"error": 0, "warning": 1, "info": 2}
VERDICT_ORDER = {"fail": 0, "warn": 1, "pass": 2}


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


def png_size(data: bytes) -> tuple[int, int] | None:
    if data[:8] != b"\x89PNG\r\n\x1a\n" or len(data) < 24:
        return None
    return struct.unpack(">II", data[16:24])


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


# ---------------------------------------------------------------------------
# request building
# ---------------------------------------------------------------------------

def numbered_source(item: Item) -> str:
    if not item.source_text:
        return "(source not available)"
    lines = item.source_text.splitlines()
    root = item.linemap.root_line
    out = []
    for i, line in enumerate(lines, start=1):
        if item.source_origin == "repo" and i < root:
            continue
        fl = item.linemap(i) if item.file_start else i
        out.append(f"{fl}| {line}")
    return "\n".join(out)


def pad_table(pads) -> str:
    rows = ["num | type | shape | x | y | rot | w | h | drill | layers"]
    for p in pads:
        rows.append(f"{p['number'] or '-'} | {p['type']} | {p['shape']} | {p['x']:g} | {p['y']:g} | {p['rot']:g} | "
                    f"{p['w']:g} | {p['h']:g} | {'' if p['drill'] is None else format(p['drill'], 'g')} | {' '.join(p['layers'])}")
    return "\n".join(rows)


def pin_table(pins) -> str:
    rows = ["num | name | type | unit | x | y | length | hidden"]
    for p in pins:
        rows.append(f"{p['number']} | {p['name']} | {p['type']} | {p['unit']} | {p['x']:g} | {p['y']:g} | "
                    f"{p['length']:g} | {'yes' if p['hidden'] else ''}")
    return "\n".join(rows)


def library_context(item: Item, all_items: list[Item], repo: str | None) -> list[str]:
    names = {i.name for i in all_items if i.library == item.library and i.kind == item.kind and i is not item}
    if repo:
        if item.kind == "footprint":
            d = safe_join(repo, f"lib_fp/{item.library}.pretty")
            if d and os.path.isdir(d):
                names |= {f[:-10] for f in os.listdir(d) if f.endswith(".kicad_mod")}
        else:
            text = read_text(safe_join(repo, f"lib_sch/{item.library}.kicad_sym"))
            if text:
                names |= set(re.findall(r'^\t\(symbol "([^"]+)"', text, re.M))
    names.discard(item.name)
    return sorted(names)[:80]


def image_block(out_dir: str, rel: str | None, label: str, notes: list[str]):
    path = safe_join(out_dir, rel)
    if not path or not os.path.isfile(path):
        if rel:
            notes.append(f"{label} image `{rel}` missing")
        return []
    with open(path, "rb") as f:
        data = f.read()
    size = png_size(data)
    if size is None:
        notes.append(f"{label} image is not a PNG; skipped")
        return []
    if len(data) > MAX_IMAGE_BYTES or max(size) > MAX_IMAGE_DIM:
        notes.append(f"{label} image too large ({len(data)} bytes, {size[0]}x{size[1]}); skipped")
        return []
    return [
        {"type": "text", "text": f"Image: {label} ({size[0]}x{size[1]} px)"},
        {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                     "data": base64.standard_b64encode(data).decode("ascii")}},
    ]


def build_request(item: Item, all_items: list[Item], out_dir: str, repo: str | None, args, sheets) -> dict:
    """`sheets` is a list of (label, Datasheet); the first is the item's own."""
    notes: list[str] = []
    content: list[dict] = []
    for label, sheet in sheets:
        if sheet.pdf:
            content.append({
                "type": "document",
                "source": {"type": "base64", "media_type": "application/pdf",
                           "data": base64.standard_b64encode(sheet.pdf).decode("ascii")},
                "title": f"Datasheet ({label}): {sheet.source}",
            })
    # No cache breakpoint on the documents: a cache hit needs an identical prefix (same PDFs in
    # the same order), which symbol/footprint pairs rarely share, so it would only add the
    # 25% cache-write premium. The system prompt (shared by every request) is cached instead.
    renders = item.raw.get("renders") or {}
    content += image_block(out_dir, (renders.get("head") or {}).get("png"), "head (PR version) render", notes)
    content += image_block(out_dir, (item.raw.get("preview_3d") or {}).get("head"), "head 3D preview (footprint + 3D model)", notes)
    if item.status == "modified":
        content += image_block(out_dir, (renders.get("base") or {}).get("png"), "base (before PR) render", notes)
        content += image_block(out_dir, item.raw.get("diff_png"), "diff overlay (red = removed, green = added)", notes)

    meta = {
        "id": item.id, "kind": item.kind, "library": item.library, "name": item.name, "status": item.status,
        "path": item.path, "file_line_range": [item.file_start, item.file_end],
        "properties": item.raw.get("properties"), "datasheet": item.raw.get("datasheet"),
        "model3d": ((item.raw.get("model3d_by_side") or {}).get("head")) or item.raw.get("model3d"), "render_warnings": item.raw.get("warnings") or [],
        "render_view": item.raw.get("view"),  # viewbox (mm) and px_per_mm of the 2D renders
        "input_notes": notes,
    }
    parts = [f"<item_metadata>\n{json.dumps(meta, indent=1, sort_keys=True)}\n</item_metadata>"]
    if item.kind == "footprint":
        parts.append(f"<pad_table>\n{pad_table(item.pads)}\n</pad_table>")
    else:
        parts.append(f"<pin_table>\n{pin_table(item.pins)}\n</pin_table>")
    parts.append(f'<source file="{item.path}">\n{numbered_source(item)}\n</source>')
    if item.status == "modified":
        diff = read_text(safe_join(out_dir, item.raw.get("text_diff"))) or "(diff not available)"
        if len(diff) > MAX_DIFF_CHARS:
            diff = diff[:MAX_DIFF_CHARS] + "\n... (diff truncated)"
        parts.append(f"<diff>\n{diff}\n</diff>")
    ds_lines = [f"- {label}: {'ATTACHED' if sh.pdf else 'not available'}; {sh.note}"
                + (f" (pages sent: {sh.pages_sent} of {sh.pages_total})" if sh.pages_sent else "")
                for label, sh in sheets]
    if not any(sh.pdf for _, sh in sheets):
        ds_lines.insert(0, "NO DATASHEET AVAILABLE: every datasheet-dependent check must be `unknown`.")
    parts.append("<datasheet_note>\n" + "\n".join(ds_lines) + "\n</datasheet_note>")
    if item.paired:
        pp = []
        for other, exact in item.paired:
            tbl = pad_table(other.pads) if other.kind == "footprint" else pin_table(other.pins)
            pp.append(f'<paired_item id="{other.id}" path="{other.path}" '
                      f'link="{"exact Footprint property match" if exact else "near match (Footprint property differs)"}">\n'
                      f"properties: {json.dumps(other.props_head, sort_keys=True)}\n{tbl}\n</paired_item>")
        parts.append("<paired_items>\n" + "\n".join(pp) + "\n</paired_items>")
    det = [{k: f.get(k) for k in ("severity", "message", "line")} for f in item.findings]
    parts.append(f"<deterministic_findings>\n{json.dumps(det, indent=1)}\n</deterministic_findings>")
    parts.append(f"<library_context library=\"{item.library}\">\n{', '.join(library_context(item, all_items, repo)) or '(none)'}\n</library_context>")
    parts.append(prompts.TASK_INSTRUCTION.format(kind=item.kind, id=item.id, status=item.status))
    content.append({"type": "text", "text": "\n\n".join(parts)})

    params = {
        "model": args.model,
        "max_tokens": MAX_TOKENS,
        "system": [{"type": "text", "text": prompts.SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
        "messages": [{"role": "user", "content": content}],
        "output_config": {"format": {"type": "json_schema", "schema": prompts.OUTPUT_SCHEMA}},
    }
    if not args.model.startswith("claude-haiku"):
        params["output_config"]["effort"] = args.effort
    if args.model in FALLBACK_MODELS and not args.no_fallbacks:
        params["betas"] = [FALLBACK_BETA]
        params["fallbacks"] = "default"
    return params


def elide_binaries(params: dict) -> dict:
    """Deep copy of params with base64 payloads replaced by a short description."""
    def walk(o):
        if isinstance(o, dict):
            if o.get("type") == "base64" and isinstance(o.get("data"), str):
                raw_len = len(o["data"]) * 3 // 4
                return {**o, "data": f"<elided {o.get('media_type')} ~{raw_len} bytes "
                                     f"sha256:{hashlib.sha256(o['data'].encode()).hexdigest()[:16]}>"}
            return {k: walk(v) for k, v in o.items()}
        if isinstance(o, list):
            return [walk(v) for v in o]
        return o
    return walk(params)


def estimate_tokens(params: dict, pdf_pages: list) -> int:
    """Rough input-token estimate (no API key available for count_tokens)."""
    total = len(json.dumps(params["system"])) // 4
    pages = iter(pdf_pages or [])
    for block in params["messages"][0]["content"]:
        t = block.get("type")
        if t == "text":
            total += len(block["text"]) // 3  # s-expressions tokenize densely
        elif t == "image":
            data = base64.standard_b64decode(block["source"]["data"])
            w, h = png_size(data) or (1000, 1000)
            scale = min(1.0, (1_150_000 / (w * h)) ** 0.5, 1568 / max(w, h))
            total += int((w * scale) * (h * scale) / 750)
        elif t == "document":
            total += (next(pages, None) or 10) * 2000  # text + page image
    return total


# ---------------------------------------------------------------------------
# LLM call
# ---------------------------------------------------------------------------

def call_model(client, params: dict):
    """Returns (parsed_json or None, usage dict, error string or None, served_model)."""
    import anthropic

    try:
        with client.beta.messages.stream(**params) as stream:
            msg = stream.get_final_message()
    except anthropic.BadRequestError as e:
        return None, {}, f"API rejected the request (400): {e.message}", None
    except (anthropic.AuthenticationError, anthropic.PermissionDeniedError) as e:
        raise  # fatal for every item; handled by caller
    except anthropic.RateLimitError as e:
        return None, {}, f"rate limited after retries: {e.message}", None
    except anthropic.APIStatusError as e:
        return None, {}, f"API error {e.status_code}: {e.message}", None
    except anthropic.APIConnectionError as e:
        return None, {}, f"connection error: {e}", None
    u = msg.usage
    usage = {
        "input_tokens": getattr(u, "input_tokens", 0) or 0,
        "output_tokens": getattr(u, "output_tokens", 0) or 0,
        "cache_creation_input_tokens": getattr(u, "cache_creation_input_tokens", 0) or 0,
        "cache_read_input_tokens": getattr(u, "cache_read_input_tokens", 0) or 0,
        "request_id": getattr(msg, "_request_id", None),
    }
    if msg.stop_reason == "refusal":
        cat = getattr(getattr(msg, "stop_details", None), "category", None)
        return None, usage, f"model declined to review (refusal, category {cat})", msg.model
    if msg.stop_reason == "max_tokens":
        return None, usage, "model output hit max_tokens before finishing", msg.model
    text = next((b.text for b in msg.content if getattr(b, "type", None) == "text"), None)
    if not text:
        return None, usage, f"no text in response (stop_reason {msg.stop_reason})", msg.model
    try:
        return json.loads(text), usage, None, msg.model
    except json.JSONDecodeError as e:
        return None, usage, f"response was not valid JSON: {e}", msg.model


def cost_usd(model: str, usage: dict) -> float:
    key = next((k for k in PRICES if model and model.startswith(k)), None)
    if not key:
        return 0.0
    i, o, cw, cr = PRICES[key]
    return (usage.get("input_tokens", 0) * i + usage.get("output_tokens", 0) * o +
            usage.get("cache_creation_input_tokens", 0) * cw + usage.get("cache_read_input_tokens", 0) * cr) / 1e6


def merge_ai(item: Item, ai: dict) -> tuple[str, str]:
    """Merge a validated AI result into the item's findings/checks. Returns (verdict, summary)."""
    paired = item.paired[0][0] if item.paired else None
    for f in ai.get("findings") or []:
        target = paired if (f.get("target") == "paired_item" and paired) else item
        line = f.get("line")
        if isinstance(line, int) and target.file_start and target.file_end and not (target.file_start <= line <= target.file_end):
            line = None  # cited a line outside the item: don't point at the wrong place
        out = {"severity": f.get("severity") if f.get("severity") in SEV_ORDER else "info",
               "category": f.get("category") if f.get("category") in prompts.FINDING_CATEGORIES else "other",
               "message": str(f.get("message", "")).strip(), "path": target.path,
               "line": line if isinstance(line, int) else None}
        if f.get("suggestion"):
            out["suggestion"] = str(f["suggestion"])
        if out["message"]:
            item.findings.append(out)
    for c in ai.get("checks") or []:
        if c.get("result") in ("pass", "fail", "unknown") and c.get("name"):
            item.checks.append({"name": str(c["name"]), "result": c["result"], "detail": str(c.get("detail", ""))})
    ai_verdict = ai.get("verdict") if ai.get("verdict") in VERDICT_ORDER else "warn"
    verdict = min(ai_verdict, item.det_verdict(), key=lambda v: VERDICT_ORDER[v])
    return verdict, str(ai.get("summary", "")).strip()


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
    lines += ["", f"<sub>Model: {review['model']}. AI findings can be wrong; check them against the datasheet. "
              "`klc` findings come from deterministic checks.</sub>"]
    md = "\n".join(lines) + "\n"
    return md if len(md) < 60000 else md[:59000] + "\n\n… (truncated; see review.json)\n"


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", required=True, help="render output dir containing manifest.json")
    ap.add_argument("--repo", default=None, help="optional repo checkout for extra context (never required)")
    ap.add_argument("--model", default=os.environ.get("CR_MODEL") or DEFAULT_MODEL)
    ap.add_argument("--effort", default=os.environ.get("CR_EFFORT") or DEFAULT_EFFORT,
                    choices=["low", "medium", "high", "xhigh", "max"])
    ap.add_argument("--no-llm", action="store_true", help="deterministic checks only")
    ap.add_argument("--dry-run", action="store_true", help="build and save API requests but do not call the API")
    ap.add_argument("--require-llm", action="store_true", help="fail (exit 2) if the LLM review cannot run")
    ap.add_argument("--no-download", action="store_true", help="never download datasheets from URLs")
    ap.add_argument("--no-fallbacks", action="store_true", help="do not send server-side refusal fallbacks")
    ap.add_argument("--max-pdf-pages", type=int, default=int(os.environ.get("CR_MAX_PDF_PAGES", ds_mod.DEFAULT_MAX_PAGES)))
    ap.add_argument("--cache-dir", default=os.environ.get("CR_CACHE_DIR") or os.path.join(
        os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"), "cr-ai"))
    ap.add_argument("--jobs", type=int, default=3, help="parallel API requests")
    ap.add_argument("--site-url", default=os.environ.get("CR_SITE_URL"), help="viewer URL to link from review.md")
    ap.add_argument("--klc-utils", default=os.environ.get("CR_KLC_UTILS"),
                    help="path to a kicad-library-utils checkout; runs its KLC checkers too (optional)")
    ap.add_argument("--only", action="append", help="only review item ids matching this substring (repeatable)")
    return ap.parse_args(argv)


def run(args, client_factory=None) -> int:
    out_dir = os.path.abspath(args.out)
    manifest_path = os.path.join(out_dir, "manifest.json")
    try:
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"cr-ai: cannot read {manifest_path}: {e}", file=sys.stderr)
        return 2
    if manifest.get("schema") != 1:
        print(f"cr-ai: warning: manifest schema {manifest.get('schema')!r}, expected 1", file=sys.stderr)
    repo = os.path.abspath(args.repo) if args.repo else None
    ds_mod.reset()

    items = [Item(r, out_dir, repo) for r in manifest.get("items") or [] if isinstance(r, dict)]
    if args.only:
        items = [i for i in items if any(s in i.id for s in args.only)]
    klu_dir = args.klc_utils if klc_utils.available(args.klc_utils) else None
    if args.klc_utils and not klu_dir:
        print(f"cr-ai: warning: --klc-utils {args.klc_utils} is not a kicad-library-utils checkout; skipping KLC checker",
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

    use_llm = not args.no_llm
    llm_note = None
    client = None
    if use_llm and not args.dry_run:
        if client_factory is None and not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
            llm_note = "AI review skipped: ANTHROPIC_API_KEY is not set."
        else:
            try:
                client = client_factory() if client_factory else _make_client()
            except ImportError:
                llm_note = "AI review skipped: the `anthropic` package is not installed (pip install -r requirements.txt)."
        if llm_note:
            print(f"cr-ai: {llm_note}", file=sys.stderr)
            if args.require_llm:
                return 2
            use_llm = False

    results: dict[str, dict] = {}
    totals = {"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "cost": 0.0}
    served_models = set()
    est_total = 0
    reviewable = [i for i in items if i.status != "deleted" and i.node is not None]

    def resolve(raw):
        return ds_mod.resolve(raw, out_dir, repo, args.cache_dir, not args.no_download, args.max_pdf_pages, safe_join)

    def prepare(it: Item):
        sheets = [("this item", resolve(it.raw))]
        # A generic package footprint often links an unrelated example datasheet; the paired
        # part's datasheet has the real land pattern / pinout. Send at most two PDFs.
        for other, _exact in it.paired:
            if len(sheets) >= 2 or (it.kind == "symbol" and sheets[0][1].pdf):
                break
            d = other.raw.get("datasheet") or {}
            if (d.get("url") or d.get("file")) and d != (it.raw.get("datasheet") or {}):
                sh = resolve(other.raw)
                if sh.pdf and all(sh.pdf != s.pdf for _, s in sheets):
                    sheets.append((f"paired {other.kind} {other.id}", sh))
        return sheets, build_request(it, items, out_dir, repo, args, sheets)

    if use_llm:
        req_dir = os.path.join(out_dir, "ai-requests")
        if args.dry_run:
            os.makedirs(req_dir, exist_ok=True)

        def work(it: Item):
            try:
                sheets, params = prepare(it)
            except Exception as e:  # never let one item kill the run
                traceback.print_exc()
                return it, None, None, {}, f"failed to build request: {e}", None
            if args.dry_run:
                pages = [len(s.pages_sent) if s.pages_sent else s.pages_total for _, s in sheets if s.pdf]
                est = estimate_tokens(params, pages)
                dump = {"endpoint": "client.beta.messages.stream" if "betas" in params else "client.messages.stream",
                        "estimated_input_tokens": est,
                        "datasheets": [{"for": label, "source": s.source, "attached": bool(s.pdf), "note": s.note,
                                        "pages_total": s.pages_total, "pages_sent": s.pages_sent} for label, s in sheets],
                        "params": elide_binaries(params)}
                with open(os.path.join(req_dir, f"{it.slug}.json"), "w", encoding="utf-8") as f:
                    json.dump(dump, f, indent=1)
                return it, sheets, None, {"estimated_input_tokens": est}, None, None
            ai, usage, err, served = call_model(client, params)
            return it, sheets, ai, usage, err, served

        import_errors = ()
        try:
            import anthropic
            import_errors = (anthropic.AuthenticationError, anthropic.PermissionDeniedError)
        except ImportError:
            pass
        with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as ex:
            futures = [ex.submit(work, it) for it in reviewable]
            fatal = None
            for fut in futures:
                try:
                    it, sheets, ai, usage, err, served = fut.result()
                except import_errors as e:
                    fatal = f"AI review aborted: authentication/permission error: {e}"
                    continue
                if served:
                    served_models.add(served)
                if args.dry_run:
                    est_total += usage.get("estimated_input_tokens", 0)
                    results[it.id] = {"sheets": sheets, "summary": det_summary(it) + " (dry run: AI request built, not sent)"}
                    continue
                for k in ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"):
                    totals[k] += usage.get(k, 0)
                totals["cost"] += cost_usd(served or args.model, usage)
                if err or ai is None:
                    it.findings.append(kc.finding("info", f"AI review unavailable for this item: {err}", category="other")
                                       | {"path": it.path})
                    results[it.id] = {"sheets": sheets, "summary": det_summary(it) + " AI review failed; see findings."}
                else:
                    v, s = merge_ai(it, ai)
                    results[it.id] = {"sheets": sheets, "verdict": v, "summary": s or det_summary(it)}
            if fatal:
                print(f"cr-ai: {fatal}", file=sys.stderr)
                llm_note = fatal
                if args.require_llm:
                    return 2

    review_items = {}
    for it in items:
        r = results.get(it.id, {})
        used = [s.source for _, s in (r.get("sheets") or []) if s.pdf] if not args.dry_run else []
        ds_used = ", ".join(used) or None
        verdict = r.get("verdict") or it.det_verdict()
        review_items[it.id] = item_entry(it, verdict, r.get("summary") or det_summary(it), ds_used)

    n = {v: sum(e["verdict"] == v for e in review_items.values()) for v in VERDICT_ORDER}
    ran_llm = use_llm and not args.dry_run and client is not None
    model_label = (args.model if ran_llm else f"deterministic checks only{' (dry run)' if args.dry_run else ''}")
    summary = [f"Reviewed **{len(items)}** item(s): {n['fail']} fail, {n['warn']} warn, {n['pass']} pass."]
    if ran_llm:
        extra = f" (served by {', '.join(sorted(served_models))})" if served_models - {args.model} else ""
        summary.append(f"AI review by `{args.model}`{extra} at effort `{args.effort}`: "
                       f"{totals['input_tokens'] + totals['cache_creation_input_tokens'] + totals['cache_read_input_tokens']:,} input / "
                       f"{totals['output_tokens']:,} output tokens, about ${totals['cost']:.2f}.")
    elif args.dry_run and use_llm:
        summary.append(f"Dry run: requests saved to `ai-requests/`, estimated about {est_total:,} input tokens in total "
                       f"for `{args.model}`.")
    if pr_findings:
        summary.append(f"{len(pr_findings)} PR-level finding(s) (unreferenced 3D model files).")
    if llm_note:
        summary.append(llm_note)
    review = {"schema": 1, "model": model_label, "generated_at": _now(),
              "summary_markdown": " ".join(summary), "items": review_items,
              # additive to the contract: findings not tied to one item
              "pr_findings": pr_findings}
    if ran_llm:
        review["usage"] = {k: (round(v, 4) if k == "cost" else v) for k, v in totals.items()}

    with open(os.path.join(out_dir, "review.json"), "w", encoding="utf-8") as f:
        json.dump(review, f, indent=1, ensure_ascii=False)
    with open(os.path.join(out_dir, "review.md"), "w", encoding="utf-8") as f:
        f.write(render_markdown(review, items, args.site_url))
    print(f"cr-ai: wrote {os.path.join(out_dir, 'review.json')} ({len(items)} items; {review['summary_markdown']})")
    return 0


def _make_client():
    import anthropic
    return anthropic.Anthropic(max_retries=4, timeout=900.0)


def main(argv=None) -> int:
    return run(parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
