// boarddd/gerber: moved from CoolNamesAllTaken/wasm-gerber-viewer packages/wasm-gerber-renderer/board.js at 92976b5
// (earlier history lives there).
/**
 * A realistic board face: laminate, copper, solder mask the right way round,
 * surface finish on exposed copper, silkscreen, and holes you can see through.
 *
 * Everything is composited on the GPU inside one renderer frame, in stack
 * (source-over) order:
 *
 *   1. substrate  -- the board shape (outline interior), laminate colored
 *   2. copper     -- bare copper
 *   3. mask       -- the mask Gerber draws the OPENINGS, so it is inverted:
 *                    mask color everywhere inside the outline except openings
 *   4. finish     -- copper under a mask opening, in the finish color (ENIG...)
 *   5. silk       -- clipped out of mask openings and to the outline, as a fab
 *                    house prints it
 *   6. paste      -- optional
 *   7. drills     -- with no frame background the renderer ERASES drill fills
 *                    (destination-out), so holes are transparent through every
 *                    layer, laminate included: whatever is behind the canvas
 *                    shows through. With an opaque background they show it.
 *
 * Outside the outline the canvas stays transparent. Without an outline the
 * substrate and mask are bounded by the frame's layer bounds (a rectangle).
 *
 * A layer source is anything `renderLayer()` takes (string, File, Blob,
 * ArrayBuffer, Uint8Array, or `{ source, name }`).
 */
import { calculateFitView, sourceToText } from "../../third_party/wasm-gerber-renderer/core/shared.js";
import { boardPalette, toHexColor } from "./palette.js";
import { flattenOnto } from "./raster.js";
import { hasGeometry, withoutProfile } from "./layers.js";
import { parseExcellon } from "./drills.js";

/** The layer roles of one face, in the order they are drawn. */
export const FACE_ROLES = Object.freeze(["copper", "mask", "silk", "paste"]);

function unwrap(entry) {
  if (entry == null) return null;
  if (typeof entry === "object" && "source" in entry && !isBlob(entry)) {
    return { source: entry.source, name: entry.name };
  }
  return { source: entry, name: undefined };
}

async function layerText(entry, strip) {
  const { source, name } = unwrap(entry);
  const text = await sourceToText(source);
  return { source: strip ? withoutProfile(text) : text, name };
}

/**
 * Pick the face to draw out of a `groupBoardLayers()`-style board description
 * or a flat one. Accepts either
 * `{ outline, copper, mask, silk, paste, drills }` or
 * `{ outline, top: {copper, mask, silk, paste}, bottom: {...}, drills }`
 * (with `side`).
 */
export function selectFace(board, side = "top") {
  const face = board[side] && typeof board[side] === "object" && !isSource(board[side])
    ? board[side]
    : board;
  return {
    outline: board.outline ?? null,
    copper: face.copper ?? null,
    mask: face.mask ?? null,
    silk: face.silk ?? null,
    paste: face.paste ?? null,
    drills: Array.isArray(board.drills) ? board.drills : board.drills ? [board.drills] : [],
  };
}

function isBlob(value) {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

function isSource(value) {
  return (
    typeof value === "string" ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    isBlob(value) ||
    (value && typeof value === "object" && "source" in value)
  );
}

/**
 * Add a realistic board face to the renderer's ACTIVE frame (call inside
 * `renderer.withFrame()`, ideally one with `compositeMode: "stack"` and
 * `background: null`; see `renderBoard()` which sets both).
 *
 * @param renderer a `GerberRenderer` with a frame open
 * @param board `{ outline?, copper?, mask?, silk?, paste?, drills? }` (or the
 *   grouped form with `top`/`bottom` and `options.side`)
 * @param options
 *   - `side`: `"top"` (default) or `"bottom"`: which face of a grouped board
 *   - `palette`: a `boardPalette()` result or its options (`{ mask: "red", ... }`)
 *   - `substrate` (true), `finish` (true), `clipSilk` (true), `paste` (false),
 *     `holes` (true: render drills; with no background they are see-through)
 *   - `stripProfile` (true): drop board-outline strokes KiCad plots onto
 *     copper/mask/silk/paste layers (Gerber X2 `.AperFunction,Profile`)
 * @returns the public layer IDs added, by role (`null` where nothing was drawn)
 */
export async function addBoardLayers(renderer, board, options = {}) {
  const face = selectFace(board, options.side ?? "top");
  const palette =
    options.palette && options.palette.mask && options.palette.mask.color
      ? options.palette
      : boardPalette(options.palette ?? {});
  const strip = options.stripProfile !== false;
  const ids = {
    outline: null,
    substrate: null,
    copper: null,
    mask: null,
    finish: null,
    silk: null,
    paste: null,
    drills: [],
  };

  const hidden = (layer) => renderer.renderLayer(layer, { visible: false });

  // Read every face layer once. A layer that draws nothing is treated as
  // absent -- except the mask: a mask with no openings covers the whole board.
  const load = async (entry, stripIt) => {
    if (!entry) return null;
    const text = await layerText(entry, stripIt);
    return hasGeometry(text.source) ? text : null;
  };
  const outline = await load(face.outline, false);
  const copper = await load(face.copper, strip);
  const maskText = face.mask ? await layerText(face.mask, strip) : null;
  const mask = maskText && hasGeometry(maskText.source) ? maskText : null;
  const maskEverywhere = maskText != null && mask == null;
  const silkText = palette.silk ? await load(face.silk, strip) : null;
  const pasteText = options.paste === true ? await load(face.paste, strip) : null;

  let outlineId = null;
  if (outline) {
    outlineId = await hidden(outline);
    ids.outline = outlineId;
  }

  // The board's interior: "00" (inside the outline, no stroke) plus "11" (the
  // stroke itself), from two copies of the outline -- a composite needs two
  // sources. Without an outline, the frame bounds (a rectangle) are used.
  const boardArea = async (name, color, alpha) => {
    if (outline) {
      const twin = await hidden(outline);
      return renderer.renderCompositeLayer([outlineId, twin], {
        name,
        visibleAreas: ["00", "11"],
        outlineLayerId: outlineId,
        color,
        alpha,
      });
    }
    const anchorText = mask ?? copper;
    if (!anchorText) return null;
    const anchor = await hidden(anchorText);
    const twin = await hidden(anchorText);
    return renderer.renderCompositeLayer([anchor, twin], {
      name,
      visibleAreas: ["00", "11"],
      color,
      alpha,
    });
  };

  if (options.substrate !== false) {
    ids.substrate = await boardArea("Substrate", palette.substrate, 1);
  }

  if (copper) {
    ids.copper = await renderer.renderLayer(copper, {
      color: palette.copper,
      alpha: 1,
    });
  }

  let maskSourceId = null;
  if (maskEverywhere) {
    ids.mask = await boardArea("Solder mask", palette.mask.color, palette.mask.alpha);
  } else if (mask) {
    const maskOptions = {
      name: "Solder mask",
      color: palette.mask.color,
      alpha: palette.mask.alpha,
    };
    if (outlineId != null) maskOptions.outlineLayerId = outlineId;
    ids.mask = await renderer.renderInvertedLayer(mask, maskOptions);
    maskSourceId = await hidden(mask);
  }

  if (options.finish !== false && ids.copper != null && maskSourceId != null) {
    ids.finish = await renderer.renderCompositeLayer([ids.copper, maskSourceId], {
      name: "Surface finish",
      visibleAreas: ["11"],
      color: palette.finish,
      alpha: 1,
    });
  }

  if (silkText) {
    const silk = silkText;
    const style = { color: palette.silk.color, alpha: palette.silk.alpha };
    if (options.clipSilk !== false && (maskSourceId != null || outlineId != null)) {
      // Silk is printed only on mask and only on the board. As a composite of
      // [silk, mask] that is "10"; with an outline it is drawn as the
      // inversion of every other code, because an inverted composite is
      // clipped to the outline. Without a mask the second source is a twin
      // of the silk, so "11" is the silk itself.
      const silkId = await hidden(silk);
      const second = maskSourceId ?? (await hidden(silk));
      const shown = maskSourceId != null ? "10" : "11";
      ids.silk = await renderer.renderCompositeLayer(
        [silkId, second],
        outlineId != null
          ? {
              name: "Silkscreen",
              inverted: true,
              visibleAreas: ["00", "01", "10", "11"].filter((code) => code !== shown),
              outlineLayerId: outlineId,
              ...style,
            }
          : { name: "Silkscreen", visibleAreas: [shown], ...style },
      );
    } else {
      ids.silk = await renderer.renderLayer(silk, style);
    }
  }

  if (pasteText) {
    ids.paste = await renderer.renderLayer(pasteText, {
      color: palette.paste.color,
      alpha: palette.paste.alpha,
    });
  }

  if (options.holes !== false) {
    for (const drill of face.drills) {
      const { source, name } = unwrap(drill);
      const text = await sourceToText(source);
      // KiCad writes a header-only NPTH file for a board without such holes;
      // the renderer rejects a drill file with no holes, so skip it. An ODB++
      // drill layer (loadOdbJob) is an envelope, not Excellon: it counts when it has features.
      if (text.startsWith("%ODB++LAYER%") ? !hasGeometry(text) : parseExcellon(text).length === 0) continue;
      const id = await renderer.renderLayer(
        { source: text, name: name ?? "drill.drl", kind: "drill" },
        { color: palette.plating },
      );
      if (id != null) ids.drills.push(id);
    }
  }

  return ids;
}

/**
 * Render a realistic board face to `renderer`'s canvas in one frame.
 *
 * `frameOptions` are `withFrame()` options; `compositeMode` is forced to
 * `"stack"` and `background` defaults to `null` (so holes and the area
 * outside the board are transparent). `side: "bottom"` mirrors the render
 * (`flipX`) as seen from below, unless `mirror: false` (e.g. for a texture on
 * a 3D board, which is mirrored by being turned over).
 *
 * @returns `{ frame: renderer.lastFrame, ids }`
 */
export async function renderBoard(renderer, board, options = {}) {
  const { side = "top", mirror = true, palette, substrate, finish, clipSilk, paste, holes, stripProfile, ...frameOptions } = options;
  let ids = null;
  await renderer.withFrame(
    {
      background: null,
      ...frameOptions,
      compositeMode: "stack",
      flipX: frameOptions.flipX ?? (side === "bottom" && mirror),
    },
    async () => {
      ids = await addBoardLayers(renderer, board, {
        side,
        palette,
        substrate,
        finish,
        clipSilk,
        paste,
        holes,
        stripProfile,
      });
    },
  );
  return { frame: renderer.lastFrame, ids };
}

// ── Face rasters for 3D boards ───────────────────────────────────────────────

/**
 * How many pixels to paint a board face at, for use as a texture.
 *
 * At least `minPx` across and at least `pxPerMm`, whichever is finer, then held
 * under `min(maxPx, maxTextureSize)` on both axes. Returns
 * `{ width, height, pxPerMm }`.
 */
export function faceRasterSize(
  bounds,
  { pxPerMm = 32, minPx = 2048, maxPx = 6144, maxTextureSize = Infinity } = {},
) {
  const spanX = Math.max(bounds.maxX - bounds.minX, 1e-6);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1e-6);
  const ceiling = Math.min(maxPx, maxTextureSize || maxPx);
  let scale = Math.max(pxPerMm, minPx / spanX);
  scale = Math.min(scale, ceiling / Math.max(spanX, spanY));
  return {
    width: Math.max(Math.round(spanX * scale), 1),
    height: Math.max(Math.round(spanY * scale), 1),
    pxPerMm: scale,
  };
}

/**
 * Render one board face as a texture-ready raster whose pixels map linearly
 * onto `bounds` (world mm): pixel (0,0) is (minX, maxY), the far corner
 * (maxX, minY) -- use `rasterToWorld()` from view.js, or planar UVs
 * u = (x - minX) / spanX, v = (y - minY) / spanY.
 *
 * The bottom face is NOT mirrored: painted in board coordinates on a solid you
 * turn over, it reads correctly from below.
 *
 * @param renderer a GerberRenderer (its canvas is resized)
 * @param board as for `renderBoard()`
 * @param options `{ bounds, width?, height?, side?, palette?, flatten? , ...addBoardLayers options }`
 *   `flatten`: a CSS color to lay the render on (default: the palette
 *   substrate) so the texture is opaque; `false` keeps transparency.
 * @returns `{ canvas, width, height, bounds, view }`; `canvas` is the flattened
 *   2D copy, or the renderer canvas itself when `flatten: false`.
 */
export async function renderFaceRaster(renderer, board, options = {}) {
  const { bounds, side = "top", flatten, ...rest } = options;
  if (!bounds) throw new TypeError("renderFaceRaster needs world bounds.");
  const size =
    options.width && options.height
      ? { width: options.width, height: options.height }
      : faceRasterSize(bounds, rest);
  const view = calculateFitView(bounds, size.width, size.height, 0);
  const palette = rest.palette && rest.palette.mask?.color ? rest.palette : boardPalette(rest.palette ?? {});
  await renderBoard(renderer, board, {
    ...pick(rest, ["substrate", "finish", "clipSilk", "paste", "holes", "stripProfile"]),
    palette,
    side,
    mirror: false,
    width: size.width,
    height: size.height,
    view,
  });
  let canvas = renderer.canvas;
  if (flatten !== false) {
    canvas = flattenOnto(renderer.canvas, typeof flatten === "string" ? flatten : toHexColor(palette.substrate));
  }
  return { canvas, width: size.width, height: size.height, bounds, view };
}

function pick(object, keys) {
  const result = {};
  for (const key of keys) if (object[key] !== undefined) result[key] = object[key];
  return result;
}
