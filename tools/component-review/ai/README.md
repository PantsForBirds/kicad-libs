# Component review: AI + deterministic checks

`cr_ai_review.py` reads the render step's `OUT/manifest.json` plus per-item assets and writes
`OUT/review.json` and `OUT/review.md`. See `cr-shared/CONTRACT.md` for the formats. It reviews
every added or modified footprint and symbol in the PR.

```sh
# deterministic checks only (no secrets, no network)
python3 tools/component-review/ai/cr_ai_review.py --out cr-out --no-llm

# full review (needs ANTHROPIC_API_KEY)
pip install -r tools/component-review/ai/requirements.txt
python3 tools/component-review/ai/cr_ai_review.py --out cr-out --no-download

# build and save the exact API requests without calling the API
python3 tools/component-review/ai/cr_ai_review.py --out cr-out --dry-run
```

`OUT` is self-contained, so the tool never needs the repo. `--repo .` adds optional context:
sibling part names and a 3D-model existence fallback. Every manifest path is confined to
`OUT`, and nothing from `OUT` is executed. The tool exits 0 whenever `review.json` was
written, including when there are findings. It exits 2 on a tool failure, such as an
unreadable manifest, or with `--require-llm` when the LLM review could not run.

## What it checks

**Deterministic checks (always run, category `klc`)** in `kicad_checks.py`. Findings cite the
repo line (manifest `line_range` plus the position in the item's source).

- Footprints:
  - courtyard: missing, pads outside it, body (fab) outside it, clearance under 0.25 mm;
  - fab outline and `${REFERENCE}` on F.Fab;
  - silkscreen over copper pads (rotation-aware);
  - `descr` / datasheet URL / tags, and Reference/Value layers;
  - SMD pads without paste when no paste apertures exist;
  - duplicated pad numbers;
  - 3D model: missing, path not `${KICAD_LIBS_DIR}/lib_3d/...`, file missing, odd
    scale/offset/rotation. A model whose name doesn't match the footprint's package
    dimensions is flagged as category `3d-model`. Example: `..._EP2.29x3mm.step` on an
    `..._EP2.41x3.3mm` footprint.
- Symbols:
  - Datasheet, Description, keywords, and Footprint / `ki_fp_filters` properties;
  - pins off the 100/50 mil grid;
  - duplicate or empty pin numbers;
  - hidden power pins.
- Pairs: a symbol whose `Footprint` property names a footprint in the same PR. Pin numbers are
  checked against pad numbers. A near miss is also flagged, for example a `Footprint` pointing
  at `Package_SO:..._ThermalVias` when the PR adds `Custom_Package_SO:...`.
- PR level (`review.json` `pr_findings`, an additive field): changed 3D files that no
  footprint references (manifest `unreferenced_changed_3d_files`).
- Optionally, KiCad's official KLC checkers from
  [kicad-library-utils](https://gitlab.com/kicad/libraries/kicad-library-utils).
  - Pass `--klc-utils DIR` or set `CR_KLC_UTILS=DIR`. The checkers work on KiCad 10 files.
    They are not on PyPI, so clone the repo pinned to a commit. Tested at `90b0af91`.
  - Rules that conflict with this repo's layout are dropped (`<lib>.3dshapes` directories).
    Rules that vendor STEP models break legitimately (model offset/rotation/name) are
    downgraded to info.

**AI review (per item, one request each)**. The model receives:
- the item's source with repo line numbers;
- the pad or pin table and the properties;
- render warnings and the render scale;
- for modified items, the base→head diff;
- the head render, the base and diff renders for modified items, and the 3D preview, as images;
- the datasheet PDF(s);
- the paired symbol or footprint;
- the deterministic findings, so it doesn't repeat them.

The system prompt in `prompts.py` drives a checklist tailored to the item's kind:
- pin/pad count and numbering against the datasheet;
- pin names and electrical types;
- land-pattern dimensions;
- exposed pad, paste and thermal vias;
- pin-1 markers;
- courtyard, fab and silkscreen;
- properties;
- 3D model;
- naming, grid, hidden power pins and units.

The model must answer `unknown` rather than guess when the datasheet is missing or doesn't
show a value. Output is constrained with structured outputs (`output_config.format`,
`prompts.OUTPUT_SCHEMA`) and mapped onto `review.json`. A finding that cites a line outside the
item gets `line: null`. The final verdict is the worse of the AI verdict and the deterministic
verdict.

## Datasheets

The tool looks for a datasheet in this order:
1. manifest `datasheet.file` (relative to OUT);
2. `datasheet.local` in `--repo`;
3. a download of `datasheet.url`, unless `--no-download` is set.

Downloads are guarded:
- http(s) only;
- the host name is resolved and every address must be public (checked again on each redirect);
- the body must be a PDF.

Distributor landing pages such as LCSC's are followed one hop to a same-site `.pdf` link.
Downloads are cached per URL (`--cache-dir`, default `~/.cache/cr-ai`).

Environment knobs:

| Variable | Default | Effect |
|---|---|---|
| `CR_DS_HTTPS_ONLY=1` | off | reject `http://` URLs and redirects to http |
| `CR_DS_MAX_BYTES` | 20971520 | abort once the body passes this size |
| `CR_DS_TIMEOUT_S` | 20 | total wall-clock deadline per download |
| `CR_DS_MAX_DOWNLOADS` | 20 | per run; later ones are noted as "datasheet not fetched (limit)" |

PDFs over 40 pages (`--max-pdf-pages` / `CR_MAX_PDF_PAGES`) or 20 MB are trimmed with `pypdf`.
The pages kept are those matching land-pattern, pinout and package keywords, plus the first
pages.

A footprint also gets the paired symbol's datasheet, up to two PDFs. Generic package
footprints often link an unrelated example datasheet, while the part's own datasheet has the
real land pattern. A symbol gets the paired footprint's datasheet only when it has none of
its own.

## Model and API usage

- **Model:** the default is `claude-fable-5-1`, the most capable current model. Override
  with `--model` or `CR_MODEL`, and set effort with `--effort` / `CR_EFFORT` (default `high`).
- **Fallbacks:** for Fable 5.1 / Opus 5 the request sets server-side refusal fallbacks
  (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). Disable with
  `--no-fallbacks`.
- **Thinking:** thinking is always on for Fable 5.1, so the request doesn't set it.
- **Transport:** requests are streamed (`client.beta.messages.stream(...).get_final_message()`).
- **Prompt caching:** the system prompt, which is shared by every item, is cached.
- **Failure handling:** an item whose request fails gets an info finding. Refusals,
  `max_tokens`, invalid JSON and API errors are all handled this way, and the run continues.
  Missing credentials degrade to deterministic-only with a note in the summary.

Approximate cost:
- **Input:** from `--dry-run` on the demo PR, about 17-47k input tokens per component. Most
  of that is the datasheet (about 2k tokens per page).
- **Output:** about 4-8k tokens, thinking included. This is an assumption, not a measurement: no API key was available when this was written.
- **Per component:** about $0.40-0.90 on Fable 5.1 ($10/$50 per MTok). The demo PR's 5
  components come to about $3.
- **Cheaper runs:** `--model claude-opus-5` costs about half as much.

`review.json` gets a `usage` block with the real token counts and cost.

## Tests

```sh
python3 -m unittest discover -s tools/component-review/ai/tests -v
CR_KLC_UTILS=/path/to/kicad-library-utils python3 -m unittest discover -s tools/component-review/ai/tests
```

The API is mocked. Tests on the API-call path are skipped when `anthropic` isn't installed.
`tests/make_mock_out.py` builds a contract-shaped OUT from a git range when the render step's
output isn't available.
