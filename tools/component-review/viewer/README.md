# Component review viewer

Static web app that shows the new/changed KiCad footprints and symbols of a PR. No build step: plain ES modules, HTML and CSS.
The CI publishes it to GitHub Pages next to the render and AI output:

    OUT/manifest.json          (render step)   required
    OUT/review.json            (ai step)       optional
    OUT/items/<slug>/...       (render step)
    OUT/index.html, viewer.css, js/            (this directory, copied by build_site.py)

```sh
python3 tools/component-review/viewer/build_site.py --out cr-out
cd cr-out && python3 -m http.server 8000     # open http://localhost:8000/  (file:// does not work)
```

## Features

- **Sidebar:** items grouped by kind, with status badge (added/modified/deleted), AI verdict badge and a filter box
  (`/` focuses it, `j`/`k` move between items). Each item has a deep link, `#<slug>`, for PR comments.
- **Header:** repo / PR link, base → head commits, generation time, KiCad version, a PR-level findings chip and the AI model.
  The overview (`#`) shows the AI summary, usage, PR-level findings and a table of all items.
- **2D view:**
  - Modes: side by side (base | head), overlay (opacity slider), blink (auto / step), swipe, and diff (`diff.png`).
  - Pan (drag) and zoom (wheel, pinch) are synced across panes. `f` or double-click fits the view; `m` cycles modes.
  - Footprints get per-layer toggles built by stacking the per-layer SVGs (All / Front / Back / Copper presets).
    Mask/paste layers start hidden.
  - The cursor readout is in mm (footprint coordinates, y down). It uses `view.viewbox` if present, otherwise the SVG `viewBox`.
- **3D view (footprints):** the part on its footprint, built in the browser (CONTRACT.md Addendum 2).
  - A 1.6 mm board over `geom.bbox` (or the Edge.Cuts outline) with the drill holes cut through. The top and bottom
    faces are painted from the F/B layer SVGs: mask, copper under mask, mask openings.
  - Copper pads and plated barrels as geometry. Silkscreen and fab/courtyard are decal planes.
  - STEP models (`model3d_by_side[side][].file`) are tessellated by occt-import-js in a Web Worker and placed with KiCad's
    model transform: `T(offset) · Rz(-rz) · Ry(-ry) · Rx(-rx) · S(scale)` in KiCad's 3D frame.
  - Toggles for board / pads / silk / fab / model. Modes: head, base, side by side, translucent overlay
    (head cyan, base magenta). Top / bottom / side / iso / reset cameras.
- **Details:**
  - Source links to GitHub at head/base SHA with line ranges, plus downloads of the standalone item source.
  - Datasheet: the PDF copy in the report (`datasheet.file`), then the URL.
  - Tables: properties diff (changed rows highlighted), pad / pin diff (added/removed/changed rows, "only changes"
    filter), statistics diff, and 3D model files with offset/rotate/scale.
  - Render warnings, and a syntax-highlighted unified diff.
- **AI review panel:** verdict, summary, datasheet used, findings sorted by severity (each links to the file line on
  GitHub), and a checks table.
- Degrades when data is missing: no review.json, added items (no base), deleted items (no head), symbols
  (no layers/3D), missing model files, and no network (3D shows a message; everything else still works).
- Light/dark theme follows `prefers-color-scheme`.

## Security

Everything in the report is derived from a pull request, and all PR reports share one GitHub Pages origin. So:

- Data is only ever inserted with `textContent` / `createElement` (see `js/util.js` `el()`); nothing goes through `innerHTML`.
  Markdown is a small subset parsed straight to DOM.
- URLs are filtered: absolute `http(s)` only for external links. Asset paths must be relative, with no `..`, no scheme
  and no backslashes. GitHub links are built from a validated `owner/repo`, hex SHA and path.
- Render images (SVG/PNG) are loaded with `<img>`, so SVG scripts never run. The viewer never links to a raw SVG.
- CSP in `index.html`: scripts from self and `cdn.jsdelivr.net` only (plus `wasm-unsafe-eval` for the STEP kernel),
  no inline script, `object-src 'none'`, `base-uri 'none'`.
- `testdata/xss_check.py` injects HTML, `javascript:` URLs and path traversal into every manifest/review field and
  checks that nothing executes or leaks into links.

## Third-party code

Loaded at runtime from jsDelivr, pinned in `js/config.js`, unmodified:

- [three.js](https://github.com/mrdoob/three.js) 0.185.1, MIT
- [occt-import-js](https://github.com/kovacsv/occt-import-js) 0.0.23, LGPL-2.1 (OpenCascade, LGPL-2.1 with exception)

To self-host, put the same files under `viewer/vendor/` together with their licence files, point `js/config.js` at
them and add `vendor` to `DIRS` in `build_site.py`.

## Development / tests

`requirements.txt` lists the dev-only dependencies. The viewer itself needs none.

```sh
# realistic mock OUT from this repo (renders real footprints, synthesises "modified" bases)
python3 testdata/make_mock.py --repo . --out /tmp/mock-out [--stock-3d DIR_WITH_KICAD_STOCK_STEPS]
python3 build_site.py --out /tmp/mock-out
# headless smoke test: every mode of every item, fails on JS errors / failed requests, writes screenshots
# and 3D placement boxes (placement.json)
python3 testdata/screenshot.py --site /tmp/mock-out --shots /tmp/shots [--dark]
python3 testdata/xss_check.py --site /tmp/mock-out
node --test testdata/unit.test.mjs      # transform maths, URL filters, pad/pin row diff
```

`testdata/review.mock.json` is a hand-written review in the contract's format.
