# boarddd

3D PCB rendering for the browser, shared by [kipr](https://github.com/CoolNamesAllTaken/kipr) (KiCad
PR review) and gentoo (a PCB fab shop site). Framework-free ES modules, no build step, `.d.ts` typings.

- **`boarddd/geom`**: pure geometry, no three.js: coordinate frames, outlines and winding, round
  holes and stadium slots, hole budget, KiCad pad shapes (shape offset, rotation, roundrect, ...).
- **`boarddd/board`**: the board solid from an outline and drills (plated barrels, caps, UVs), face
  textures from Gerbers via [wasm-gerber-renderer](https://github.com/CoolNamesAllTaken/wasm-gerber-viewer),
  copper-diff textures.
- **`boarddd/footprint`**: one KiCad footprint on a small board: pads, copper, silk, courtyard.
- **`boarddd/models`**: GLB and STEP loading (occt in a Worker), units/up-axis detection, colour
  space, matching meshes to reference designators.
- **`boarddd/scene`**: `createViewer`: renderer, camera, controls, KiCad-like lighting, render on
  demand, view cube, view presets, capture.

Status: phase 1.

## API

### `boarddd/geom` (pure, no three.js)

| | |
|---|---|
| `kicadToBoard(x, y)`, `boardToKicad(x, y)` | KiCad mm (y down) ⇄ board frame (y up) |
| `kicadModelMatrix({offset, rotate, scale})` | a footprint `(model ...)` placement as KiCad's 3D viewer does it (column-major 4×4) |
| `slotPoints(x1, y1, x2, y2, r)`, `ringPoints(cx, cy, r)`, `loopAt(ends, r)` | hole outlines: stadium slots (never ellipses), circles |
| `usableHoles(holes, outline, budget = 400)` | which drills can be punched (clear of the edge and cutouts, not filled; largest first past the budget) |
| `padOutline(pad)`, `padCopperLoops(pad)`, `padDrillSlot(pad)`, `padDrillLoop(pad)`, `padToKicad(pad, p)`, `padCopperSides(pad)`, `padHasCopper(pad)` | KiCad pad semantics: shape offset moves the copper not the hole, rotation, roundrect, chamfers, trapezoid, custom primitives, oval drills along their long axis. Checked against pcbnew. |
| `clearance`, `loopBounds`, `counterClockwise`, `strokeLoops`, `rectOutline`, `outlinesDiffer`, ... | loops |

### `boarddd/board`

```js
import { buildBoard, buildGerberBoard, readFabFiles, paintFaces, paintCopperDiff } from 'boarddd/board';

// a bare board from an outline and drills (board mm, y up): body (top/bottom/walls) + plated barrels
const board = buildBoard({ outline: { board: [[0, 0], [50, 0], [50, 30], [0, 30]] },
                           holes: [{ x: 10, y: 10, diameter: 1, plated: true }, { x: 20, y: 10, x2: 23, y2: 10, diameter: 1 }] });
scene.add(board.group);

// a board painted from its Gerbers + Excellon files, through our wasm-gerber-renderer fork (injected)
const gerber = Object.assign({}, ...await Promise.all(['board', 'diff', 'drills', 'layers', 'outline', 'raster']
  .map((m) => import(`wasm-gerber-renderer/${m}.js`))));
const renderer = await createGerberRenderer(document.createElement('canvas'), { /* wasm init */ });
const head = await buildGerberBoard(gerber, renderer, files /* [{name, text}] */, { thickness: 1.6 });

// copper diff against another revision, in the same frame (same UVs): swap it onto the faces
const diff = await paintCopperDiff(gerber, renderer, { base: readFabFiles(gerber, baseFiles), head: head.fab }, head.painted);
head.setFaces({ top: diff.top, bottom: diff.bottom });
```

The solid spans z = 0 (bottom face) to z = thickness (top face). Meshes carry `userData.group`
(`board`, `barrels`) for visibility toggles. `dispose()` frees what boarddd created.

### `boarddd/footprint`

```js
import { parseKicadFootprint, buildFootprint } from 'boarddd/footprint';
const fp = parseKicadFootprint(await (await fetch('USB_C_Receptacle.kicad_mod')).text());
const built = buildFootprint(fp, { thickness: 1.6, margin: 1 });   // board = courtyard + 1 mm (or Edge.Cuts)
scene.add(built.group);                     // userData.group: board, copper, barrels, silk, fab, courtyard
const m = new THREE.Matrix4().fromArray(built.modelMatrix(fp.models[0]));   // where its STEP goes
```

`faces: {top, bottom}` paints the board faces with pictures over `uvBounds` (e.g. kipr's per-layer
renders composited), and `decals: {silk, fab, courtyard}` (each `{top, bottom}` pictures over the same
bounds) adds them as transparent sheets in those groups: the way to show text, which the graphics
sheets leave out.

`parseKicadFootprint` reads pads, graphics (flattened to polylines) and models from a `.kicad_mod`
(KiCad 6 to 10, and the old `module` form). Pad objects are also kipr's `geom.json` pads.
Text is not drawn.

### `boarddd/models`

```js
import { loadGLB, loadSTEP, prepareModel } from 'boarddd/models';

// a kicad-cli GLB: oriented (z up, mm), board bodies told apart, components named
const s = prepareModel(await loadGLB('board.glb'), components /* [{ref, x, y, side}], KiCad mm (y down) */,
                       { boardSize: [w, h], boardOrigin: [x0, y0] /* optional */ });
viewer.add(s.root);
s.comps.get('U1');            // {objects, meshes, box, bottom}
s.parts.substrate;            // also mask, copper, silk: hide them under a Gerber-built board
s.report;                     // {method: 'name'|'position'|'mixed', matched, ambiguous, unmatched, up, scale, ...}

// STEP through occt-import-js (LGPL-2.1, not bundled: pass its URLs; it runs in a Worker)
const part = await loadSTEP('part.step', { occt: { js: '.../occt-import-js.js', wasm: '.../occt-import-js.wasm' } });
```

- Matching: names first (`R5`, `R5_1`, `R5 (2)`; never `R11` → `R1`), then positions: the export origin
  is fitted (from the named nodes, else a Hough vote), and a node goes to a part only if it is clearly
  nearer that part than any other node and than any other part; mutual-nearest pairs settle the rest.
  A part with `assembly: true` and a `box` claims the solids inside it (a module).
- Placements already in the model's own frame (y up, e.g. measured by a server from the same STEP):
  `mapNodesToRefs(nodes, comps, { frame: 'board', offset: {x: 0, y: 0}, byName: false, joinExtras: false })`
  skips the flip, the origin fit, name matching and extra-piece joining; module `box` may be 3D
  `[x0, y0, z0, x1, y1, z1]` (nodes carry `cz`).
- Units and up axis are measured (thinnest axis is up; the size that fits `boardSize`, else metres
  below 2 units) unless `units` / `up` are given. The substrate's bottom is seated on z = 0.
- STEP colours are used the way KiCad's viewer uses them (occt returns linear RGB; boarddd re-encodes
  to the file's values), with a polygon offset against coplanar footprint copper.
- Meshes carry `userData.group` (`model`, `board`, `mask`, `copper`, `silk`) and `userData.ref`.
- `readStep(src, { fallback: false })` rejects (`err.workerCrashed`) instead of retrying on the main thread
  when the Worker dies; `stepToObject(data, { center: false })` keeps occt's absolute vertices with each
  group at the origin. STEP materials are shared per colour: clone before changing one mesh's.
- Classic-script bundles: `import.meta.url` is gone, so pass `workerUrl` (e.g. a blob URL of
  `src/models/step_worker.js`) or `occtFactory` to run occt on the main thread.
- Pure helpers (`mapNodesToRefs`, `matchByPosition`, `splitBoardBodies`, `measureBoard`, `detectUp`,
  `detectScale`, `stepColorToLinear`, ...) run under node.

### `boarddd/scene`

```js
import { createViewer } from 'boarddd/scene';
const v = createViewer(el, { controls: 'trackball' /* or 'orbit' */, theme: 'light', onPick: (hit) => {} });
v.add(board.group, s.root);   // board frame, z up
v.setView('top');             // bottom, front (side), back, left, right, iso, isoBottom; fits the content
v.fit();                      // refit from the current direction
v.setTheme('dark');
const png = v.capture({ width: 1200, height: 800, transparent: true });
v.setPanes([[baseGroup], [headGroup]]);   // side by side with ONE camera (null: one view again)
v.requestRender();            // after changing objects yourself
v.dispose();                  // frees GL (content included) and removes the canvas
```

- Renders on demand: no animation loop; frames are drawn while the controls move and then stop.
- KiCad-like look: neutral tone mapping, a generated room environment (no network), ambient + key +
  camera headlight, light/dark gradient backgrounds. Near/far are fitted to the content every frame.
- Panes: each listed object shows only in its own pane; the rest shows in all. `fit()` uses a pane's
  aspect and `pick()` reports the pane under the point and only hits what that pane shows.
- The view cube (top right) shows the orientation; click a face to look from it (`on('cube', face => ...)`
  hears which); `cubeAt(clientX, clientY)` says whether a point is on the cube (for hosts with their own
  pointer handling). Bottom is mirrored
  left-right, like KiCad. Importmaps must map `three/addons/` too.

## Peers

`three` is a peer dependency, imported by the bare specifier `"three"`: map it with an importmap,
or let your bundler resolve it. `wasm-gerber-renderer` (for Gerber face textures) and occt-import-js
(for STEP) are passed in by the caller, never imported by boarddd itself, so bundling boarddd into
a classic script (e.g. esbuild IIFE) works.

```html
<script type="importmap">
{ "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.185.0/build/three.module.js",
               "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.185.0/examples/jsm/",
               "boarddd/": "https://cdn.jsdelivr.net/gh/CoolNamesAllTaken/boarddd@main/src/" } }
</script>
```

## Frames

All geometry is in the **board frame**: millimetres, x right, y up (KiCad's y negated; Gerber
coordinates), z up out of the top copper, board bottom face at z = 0 and top face at z = thickness.
`kicadToBoard(x, y)` and `boardToKicad(x, y)` convert points; the viewer uses camera.up = +z.

## Tests

- `npm test`: node tests: geometry (stadium slots, hole budget, every KiCad pad shape against pcbnew's
  own polygons, kipr's pad-placement golden data), the board solid, the footprint reader/builder.
- `npm run test:browser`: headless Chromium (SwiftShader WebGL2): slotted holes must show through as
  stadiums in a straight-down render of a footprint and of a Gerber-built board; copper diff colours;
  a blue STEP board reads blue from top and bottom; no frames while idle; view cube clicks; dispose.
  `PW_PORT` changes the server port (several checkouts at once).
- Fixtures: `test/fixtures/` (see the READMEs there for sources); `examples/data/` is KiCad demo data
  (KiCad's `demos/royalblue54L_feather`), exported with `scripts/export-demo.sh`.
- `vendor/wasm-gerber-renderer/` is a dev/test copy of the fork (`scripts/sync-gerber-renderer.sh`), not
  part of the package.

## Development

```sh
npm install
npm test                      # node --test: test/**/*.test.mjs
npm run test:browser          # playwright, headless Chromium (WebGL2 via SwiftShader)
npm run serve                 # examples at http://127.0.0.1:8417/examples/
```

## Credits

Ported from gentoo's `viewer3d.js` (PantsForBirds), kipr's `web/project/pcba3d` and
`web/library/js` (CoolNamesAllTaken/kipr). Each module names its sources.
