# Vendored third-party code (both viewers)

Everything the library viewer (`web/library`) and the project viewer (`web/project`) load at runtime
for their 3D views, so they work offline and from `file://` with no CDN. One copy, shared through
symlinks: `web/library/vendor -> ../vendor`, `web/project/vendor/boarddd -> ../../vendor/boarddd`,
`web/project/vendor/three -> ../../vendor/three`. The sites (`kipr library site`, `kipr site`) copy the
files themselves, and the wheel ships them through the symlinked `web/` trees.

**Generated; do not edit.** `sync_vendor.bash` runs boarddd's `scripts/vendor.mjs` (from a local boarddd
checkout, `../boarddd` by default; `git -C ../boarddd fetch --tags` first) with the pins at its top: bump
one and run `bash web/vendor/sync_vendor.bash`; `--check` writes nothing and fails on any difference.
Every directory has a `VENDORED.json` (file -> sha256); boarddd's `COMMIT` records the tag, commit and
command.
After a boarddd or three.js change, rebuild the two committed file:// bundles:
`node web/library/build_view3d.mjs` and `node web/project/pcba3d/build_offline.mjs --no-packs`
(CI checks both with `--check`).

| | version | licence | what |
|---|---|---|---|
| `boarddd/` | the tag in `boarddd/COMMIT` (v0.2.1) | MIT | [CoolNamesAllTaken/boarddd](https://github.com/CoolNamesAllTaken/boarddd) `src/`: geom, board, footprint, models, scene, gerber; `third_party/wasm-gerber-renderer/core/`: the gerber renderer core and its wasm (wasm-gerber-viewer, MIT) |
| `three/` | 0.185.1 | MIT | `three.module.js`, `three.core.js` and the addons boarddd uses, in upstream's `examples/jsm` layout under `addons/` |
| `occt-import-js/` | 0.0.23 | LGPL-2.1 (OpenCascade: LGPL-2.1 + exception) | `dist/occt-import-js.js` + `.wasm`, unmodified; the library viewer's STEP kernel |

The only change to upstream files: `from 'three'` (and `from 'three/addons/...'`) in boarddd and in the
three.js addons is rewritten to a relative path, so no page needs an importmap (the viewers' CSPs forbid
inline scripts, and an importmap is one). occt-import-js is passed to boarddd's STEP loader by URL (or,
from `file://`, as a main-thread factory), never imported, so it stays a separate, replaceable LGPL file.
