# Component review: deterministic checks

`cr_checks.py` reads the render step's `OUT/manifest.json` plus per-item assets and writes
`OUT/review.json` and `OUT/review.md`. See `cr-shared/CONTRACT.md` for the formats. It checks
every added or modified footprint and symbol in the PR. It needs only the Python 3.11+ standard
library, no network access and no secrets.

```sh
python3 tools/component-review/checks/cr_checks.py --out cr-out
# plus KiCad's official KLC checkers
python3 tools/component-review/checks/cr_checks.py --out cr-out --klc-utils /path/to/kicad-library-utils
```

`OUT` is self-contained, so the tool never needs the repo. `--repo .` adds a 3D-model existence
fallback. Every manifest path is confined to `OUT`, and nothing from `OUT` is executed. The tool
exits 0 whenever `review.json` was written, including when there are findings. It exits 2 on a
tool failure, such as an unreadable manifest. `--no-llm` and `--no-download` from older callers
are accepted and ignored.

## What it checks

**KLC-style rules (category `klc`)** in `kicad_checks.py`. Findings cite the
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

## Output

Each item's verdict is `fail` if it has an error finding, `warn` if it has a warning, else
`pass`; its summary counts the findings. `datasheet_used` names the datasheet: the copy the render
step put in `OUT` (`datasheet.file`, matched from the repo's `datasheets/` dir) when there is
one, else the `Datasheet` URL. Datasheets are never downloaded. `review.json` `generator` is
`deterministic checks + KLC` when the KLC checker ran, else `deterministic checks` (files from
older runs have `model` instead; the viewer, report and PR comment fall back to it).

## Tests

```sh
python3 -m unittest discover -s tools/component-review/checks/tests -v
CR_KLC_UTILS=/path/to/kicad-library-utils python3 -m unittest discover -s tools/component-review/checks/tests
```

`tests/make_mock_out.py` builds a contract-shaped OUT from a git range when the render step's
output isn't available.
