// A board built from fab outputs: the Edge.Cuts outline extruded, drilled and plated from the Excellon
// files, both faces painted with the Gerbers as the board comes back from the fab (mask colour, finish
// on exposed copper, silkscreen, see-through holes), and on demand a copper-diff picture of each face
// (removed copper red, added green, unchanged dim) in the same frame, so it maps onto the same UVs.
//
// Ported from kipr's web/project/pcba3d/gerberboard.js (buildGerberBoards), itself after gentoo's
// viewer3d.js (paintBoard, renderFace, onSubstrate). All Gerber work is done by boarddd/gerber unless the caller
// injects another implementation as `gerber` (an object with the same functions; null = boarddd/gerber).
// Used: groupBoardLayers, boardOutline, parseExcellon, holesToGerber, renderFaceRaster, faceRasterSize,
// renderLayerDiff, copyScaled, withoutEmptyTools. `renderer` is a GerberRenderer from createGerberRenderer;
// null = one shared renderer made on first use (needs a DOM canvas).

import * as builtin from '../gerber/index.js';
import { loopBounds, padBounds, rectOutline, outlinesDiffer, BOARD_THICKNESS } from '../geom/index.js';
import { buildBoard, canvasTexture, outlineGhost } from './solid.js';

export const FACE_PX_PER_MM = 24;      // ~0.04 mm per texel: 0.1 mm tracks and silk stay legible
export const MAX_FACE_PX = 4096;       // what every WebGL2 implementation must support
const DIFF_BACKGROUND = '#2d333b';     // the board behind the diff: neutral, dark enough for dim copper
// Unchanged copper has to read as copper at board scale; changes stay the fork's red and green.
const DIFF_STYLE = { unchanged: { color: [0.72, 0.64, 0.5], alpha: 0.7 } };

let shared = null;
/** The shared default renderer: boarddd/gerber's, on its own canvas, drawing buffer kept for copies. */
export function defaultRenderer() {
  shared = shared || builtin.createGerberRenderer(document.createElement('canvas'), { contextAttributes: { preserveDrawingBuffer: true } });
  return shared;
}

const NEEDS = ['groupBoardLayers', 'boardOutline', 'parseExcellon', 'renderFaceRaster', 'faceRasterSize', 'copyScaled'];
function check(gerber, extra = []) {
  gerber = gerber || builtin;
  const missing = [...NEEDS, ...extra].filter((k) => typeof gerber?.[k] !== 'function');
  if (missing.length) throw new TypeError(`boarddd/board: the injected gerber implementation is missing ${missing.join(', ')} (pass null for boarddd/gerber)`);
  return gerber;
}

/**
 * Sort a board's fab files and read what the solid needs, without touching the GPU.
 *   files  [{name, text, plated?}]: Gerbers (copper/mask/silk/paste/outline) and Excellon drill files;
 *          roles come from the fork's layerRole (file names, X2 attributes); `plated` overrides a drill file's
 *   board  {size_mm?: [w, h]} helps pick the outline among several contours; {origin_mm, size_mm} is the
 *          rectangle fallback when there is no usable Edge.Cuts (KiCad mm, y down)
 * Returns {grouped, outline: {board, cutouts, approximate} | null, holes, drills: [{name, text, plated, holes}], edge}.
 */
export function readFabFiles(gerber, files, board = {}) {
  gerber = gerber || builtin;
  const drop = gerber.withoutEmptyTools || builtin.withoutEmptyTools;
  const list = files.map((f) => {
    const text = /\.(drl|xln|exc|drd|txt)$/i.test(f.name) || /^M48\b/m.test(f.text.slice(0, 400)) ? drop(f.text) : f.text;
    return { name: f.name, source: text, content: text, plated: f.plated };
  });
  const grouped = gerber.groupBoardLayers(list);
  const drills = (grouped.drills || []).map((d) => {
    const file = list.find((f) => f.name === d.name);
    const plated = file?.plated ?? d.plated ?? !/NPTH/i.test(d.name);
    return { name: d.name, text: file?.content ?? d.source, plated, holes: gerber.parseExcellon(file?.content ?? d.source, { plated }) };
  }).filter((d) => d.holes.length);
  const edge = grouped.outline ? (list.find((f) => f.name === grouped.outline.name)?.content ?? grouped.outline.source) : null;
  let outline = null;
  if (edge) {
    const size = board.size_mm;
    const o = gerber.boardOutline(edge, size ? { width: size[0], height: size[1] } : {});
    if (o?.outer?.length >= 3) outline = { board: o.outer, cutouts: o.holes || [], approximate: false };
  }
  if (!outline && board.origin_mm && board.size_mm) outline = rectOutline(board);
  const holes = drills.flatMap((d) => d.holes.map((h) => ({ ...h, plated: d.plated })));
  return { grouped, outline, holes, drills, edge };
}

/** One frame for the face pictures of several boards (e.g. base and head), so any texture fits any face. */
export function faceBounds(outlines, pad = 0.5) {
  return padBounds(loopBounds(...outlines.filter(Boolean).map((o) => o.board)), pad);
}

/**
 * Paint both faces of a board. `fab` from readFabFiles. Options: bounds (default: the outline's + 0.5 mm),
 * pxPerMm, maxTextureSize, palette ({mask, silk, finish}: names or colours, the fork's boardPalette).
 * Returns {top, bottom (canvases), bounds, size: {width, height}, view}. Faces are painted one after the
 * other: the renderer holds a full-size buffer per layer while compositing (gentoo lost WebGL contexts
 * painting two at once).
 */
export async function paintFaces(gerber, renderer, fab, { bounds = null, pxPerMm = FACE_PX_PER_MM, maxTextureSize = MAX_FACE_PX, palette = {} } = {}) {
  gerber = check(gerber);
  renderer = renderer || await defaultRenderer();
  bounds = bounds || faceBounds([fab.outline]);
  const size = gerber.faceRasterSize(bounds, { pxPerMm, maxPx: maxTextureSize, maxTextureSize });
  const out = { bounds, size, view: null };
  for (const face of ['top', 'bottom']) {
    const options = { bounds, side: face, width: size.width, height: size.height, palette };
    let r;
    try { r = await gerber.renderFaceRaster(renderer, fab.grouped, options); } catch (e) {
      // An unknown colour name must not cost the whole board.
      if (!palette || !Object.keys(palette).length) throw e;
      r = await gerber.renderFaceRaster(renderer, fab.grouped, { ...options, palette: {} });
    }
    out.view = out.view || r.view;
    out[face] = gerber.copyScaled(r.canvas, maxTextureSize);
  }
  return out;
}

/**
 * The copper-diff pictures of both faces between two boards' fab files (readFabFiles results; either may
 * be null for an added/removed board), in `painted`'s frame so they fit the same UVs. Outline and holes
 * are drawn into the picture so outline changes and re-drilled holes show too.
 * Returns {top, bottom} canvases.
 */
export async function paintCopperDiff(gerber, renderer, { base, head }, painted, { maxTextureSize = MAX_FACE_PX } = {}) {
  gerber = check(gerber, ['renderLayerDiff', 'holesToGerber']);
  renderer = renderer || await defaultRenderer();
  const pick = (fab, face) => {
    if (!fab) return null;
    const list = [fab.grouped[face]?.copper?.source, fab.edge].filter(Boolean);
    for (const d of fab.drills) list.push(gerber.holesToGerber(d.holes));
    return list.length ? list : null;
  };
  const out = {};
  for (const face of ['top', 'bottom']) {
    await gerber.renderLayerDiff(renderer, { base: pick(base, face), head: pick(head, face) }, {
      width: painted.size.width, height: painted.size.height, view: painted.view,
      background: DIFF_BACKGROUND, showUnchanged: true, style: DIFF_STYLE,
    });
    out[face] = gerber.copyScaled(renderer.canvas || renderer.gl?.canvas, maxTextureSize);
  }
  return out;
}

/**
 * Everything at once: read the files, paint the faces, build the solid.
 *   files      [{name, text, plated?}]
 *   options    {thickness (default 1.6), board: {size_mm?, origin_mm?}, palette, bounds (shared frame),
 *               pxPerMm, maxTextureSize, budget (hole budget)}
 * Returns buildBoard()'s result plus {fab, painted, textures: {top, bottom}}; dispose() frees the textures.
 */
export async function buildGerberBoard(gerber, renderer, files, options = {}) {
  gerber = check(gerber);
  const fab = readFabFiles(gerber, files, options.board || {});
  if (!fab.outline) throw new Error('buildGerberBoard: no board outline (no Edge.Cuts and no board box)');
  const painted = await paintFaces(gerber, renderer, fab, options);
  const textures = { top: canvasTexture(painted.top), bottom: canvasTexture(painted.bottom) };
  const solid = buildBoard({
    outline: fab.outline, holes: fab.holes, thickness: options.thickness ?? BOARD_THICKNESS,
    uvBounds: painted.bounds, faces: textures, budget: options.budget, name: options.name || 'gerber-board',
  });
  const dispose = solid.dispose;
  return {
    ...solid, fab, painted, textures,
    dispose() { dispose(); textures.top.dispose(); textures.bottom.dispose(); },
  };
}

export { outlinesDiffer, outlineGhost };
/** Kept for 0.1 callers; the implementation is boarddd/gerber's (drills.js). */
export const withoutEmptyTools = builtin.withoutEmptyTools;
