# kicad-libs
Custom components (symbols, footprints, 3d models) aggregated for KiCAD EDA.

## Component review

Pull requests that touch `lib_fp/`, `lib_sch/` or `lib_3d/` are reviewed automatically by
[kipr](https://github.com/CoolNamesAllTaken/kipr) (`kipr library`): the changed footprints,
symbols and 3D models are rendered before/after, checked against KLC-style rules and the
official KLC checker, and published as a sticky PR comment with a Pages preview and a
**Component review** check. Each run also has the artifacts `component-review.html` (a
report that opens in the browser), `component-review-site` (the interactive viewer; unzip
and open `index.html`) and `component-review-data` (JSON).

The workflows in `.github/workflows/component-review*.yml` are thin callers of kipr's
reusable workflows, pinned to one kipr commit (update the `uses:` ref and `kipr-ref` together
in all three files). Setup, the security model, the optional `CR_*` repository variables
(`CR_PUBLISH`, `CR_KICAD_IMAGE`, `CR_FETCH_STOCK_MODELS`, `CR_KLC`, `CR_PAGES_URL`,
`CR_FAIL_CONCLUSION`) and how to run the review locally are in kipr's
[docs/library.md](https://github.com/CoolNamesAllTaken/kipr/blob/main/docs/library.md).
