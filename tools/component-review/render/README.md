# component-review / render

Finds the footprints and symbols a PR adds, modifies or deletes in this KiCad library repo and writes
`OUT/manifest.json` plus per-item render assets. The layout is defined in `cr-shared/CONTRACT.md`
(manifest schema 1, Addenda 1 and 2).

```sh
pip install -r tools/component-review/render/requirements.txt
python3 tools/component-review/render/cr_render.py --repo . --base origin/main --head HEAD --out cr-out [--pr N]
```

Options: `--no-3d` (skip GLB/3D previews), `--no-preview`, `--png-size 1600`, `--glb-max-mb 5`,
`--fetch-stock-models` (download `${KICAD*_3DMODEL_DIR}` models from gitlab.com/kicad/libraries/kicad-packages3D at the
tag pinned in `stock_models_tag.txt`; https only; size-capped; cached in `--stock-models-dir` / `$CR_STOCK_MODELS_DIR`,
default `~/.cache/cr-render/kicad-packages3D`),
`--clean` (wipe `OUT/items` first), `--use-kicad-cli` (additionally export reference SVGs if `kicad-cli` is on PATH).
Exits 0 unless the tool itself fails. Per-item problems go into `items[].warnings`.

## What it does

* **Change detection.** Runs `git diff --no-renames <merge-base> <head>` over `lib_fp/`, `lib_sch/` and `lib_3d/`.
  * `.kicad_sym` files are parsed on both sides, and only symbols whose content changed produce items.
    Uuid-only, whitespace-only and number-formatting-only changes are ignored. A derived (`extends`) symbol counts as modified when its parent changes.
  * A changed file under `lib_3d/` marks every footprint that references it as modified (`model3d[].changed = true`).
    `manifest.unreferenced_changed_3d_files` lists changed models that no footprint uses.
* **Parser.** `sexpr.py` is a small s-expression parser with source spans (line and char offsets). It handles KiCad 5 through 10
  formats, including KiCad 10 `|base64|` embedded data. kiutils was not used because it does not know the KiCad 10
  formats (`version 20260206` / `20251024`).
* **Framing.** A footprint's viewBox is courtyard ∪ pads ∪ graphics ∪ all visible text, plus 1 mm; nothing is clipped.
  Layer SVGs have no background, so they can be stacked.
* **2D.** Pure-Python SVG renderers: `fp.py` for footprints and `sym.py` for symbols.
  * **Footprints.**
    * Pads: rect, roundrect, circle, oval, chamfered, trapezoid, custom primitives.
    * Drills: PTH and NPTH, including oval drills and drill offsets.
    * Graphics: lines, arcs (3-point and legacy), circles, rects, polys, beziers; zones.
    * Text: `${REFERENCE}`/`${VALUE}` substitution; KiCad's keep-upright behaviour.
    * Colours follow KiCad's default theme.
    * Outputs: `head.svg` (all layers, dark background, pad numbers), `head_<layer>.svg` (transparent, stackable).
  * **Symbols.**
    * Rectangles, circles, arcs, polylines, beziers, text boxes.
    * Pins: name/number placement, inverted, clock and no-connect shapes, `~{overbar}`.
    * Units are drawn side by side. De Morgan body style 2 is not drawn but is reported in stats.
  * **Shared frame.** Base and head always share one viewBox and pixel scale, so their SVG/PNG renders overlay exactly.
    For footprints the viewBox is the item bbox plus a 1 mm margin, and it is also the `bbox` in `<side>_geom.json`.
* **PNG / diff.** PNGs come from cairosvg. `diff.png` (modified items only) is a pixel diff, an RGBA PNG that is
  transparent wherever nothing changed so it can be laid over either render:
  * a symbol's body fill counts as background
  * green = only in head
  * red = only in base
  * amber = changed colour
* **3D (Addendum 2: the browser does STEP).**
  * `model3d_by_side.{base,head}`: model records with a copy of the STEP (`items/<slug>/model_<n>.step`),
    offset/scale/rotate and `hide`. Handles `${KICAD_LIBS_DIR}`, KiCad 10 `kicad-embed://` models (zstd-decoded),
    and the `.wrl`↔`.step` fallback. `${KICAD*_3DMODEL_DIR}` models are flagged `not_local`.
  * `<side>_geom.json`: pads, drills, courtyard and edge-cut polylines for building the board in the viewer.
  * Optional, when trimesh/shapely/cascadio are installed:
    * `<side>.glb`: PCB slab, copper, barrels, silk/fab/courtyard and the STEP model(s), each a separate named node.
      KiCad frame (z up, board top z=0) under a `kicad_zup` root that rotates it into glTF Y-up.
      The model transform is `T(offset)·Rz(-rz)·Ry(-ry)·Rx(-rx)·S`, as in KiCad's 3D viewer.
    * `<side>_3d.png`: a 2×2 sheet (iso/top/front/right) from a numpy z-buffer rasteriser (no OpenGL needed), handy for the AI reviewer.
* **Related symbols.** For footprints, `related_symbols` lists every head symbol whose Footprint property points at the item, with a standalone source copy in `items/<slug>/related/` and its pin list.
* **Metadata.**
  * `properties`; `datasheet` (Datasheet property or a URL in descr/Description, plus a fuzzy match in `datasheets/`,
    copied to `items/<slug>/datasheet.pdf`).
  * `stats`:
    * footprints: pad table, counts, courtyard bbox, layers, pin-1 heuristics
    * symbols: pins, units, duplicate numbers, pin types
  * `line_range`, `text_diff` (unified diff with real file line numbers), and standalone `source` copies
    (a `.kicad_sym` holding just that symbol, plus its parent if it is derived).

## Approximations

* Text uses DejaVu Sans rather than KiCad's stroke font, so widths are approximate (text extents are estimated with some slack). Knockout text and text boxes on PCB layers are simplified.
* Mask/paste expansion uses only pad-level margins; board-level defaults are unknown to a library.
* Symbol field placement is approximate for rotated fields. Pin-name placement for `pin_names (offset 0)` follows KiCad in spirit.
* `.wrl`-only models get no 3D (STEP only).

## CI needs

* Python 3.11+ and `pip install -r requirements.txt`.
* The system libcairo2 for cairosvg (present in most images, including kicad/kicad:10.0).
* DejaVu fonts for good PNG text (`fonts-dejavu-core`).
* Runtime for the 5-item demo PR: about 10 s with 3D, about 2 s with `--no-3d`. Each 3D preview sheet costs about 2 s.
