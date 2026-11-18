// boarddd/gerber: moved from CoolNamesAllTaken/wasm-gerber-viewer packages/wasm-gerber-renderer/view.js at 92976b5
// (earlier history lives there).
/**
 * World (board millimeter) <-> canvas pixel math, in exactly the space the
 * renderer draws in, plus the conveniences a viewer wants around it: the frame
 * size a view was made for, a horizontal mirror for the underside, a backing
 * store scale (devicePixelRatio), and shared frames for comparing revisions.
 *
 * Every function here goes through the package's own `calculateFitView`,
 * `projectToCanvas` and `unprojectFromCanvas`, so overlays cannot drift from
 * the renderer. DOM-free.
 */
import {
  calculateFitView,
  mergeBounds,
  projectToCanvas,
  unprojectFromCanvas,
  viewExtent,
} from "../../third_party/wasm-gerber-renderer/core/shared.js";

export { calculateFitView, projectToCanvas, unprojectFromCanvas, viewExtent };

/**
 * A view framing `bounds` (world units) on a `width` x `height` canvas with
 * `padding` pixels on every side, carrying its frame size so `project()` and
 * `unproject()` need nothing else. Pass it to `withFrame({ view })` as is.
 */
export function fitView(bounds, width, height, padding = 0) {
  const view = calculateFitView(bounds, width, height, padding);
  const { viewWidth, viewHeight } = viewExtent(width, height);
  return { ...view, viewWidth, viewHeight, W: width, H: height };
}

/** Attach frame size to a bare `{zoomX, zoomY, offsetX, offsetY}` (e.g. `lastFrame.view`). */
export function withFrameSize(view, width, height) {
  const { viewWidth, viewHeight } = viewExtent(width, height);
  return {
    zoomX: view.zoomX,
    zoomY: view.zoomY,
    offsetX: view.offsetX,
    offsetY: view.offsetY,
    viewWidth,
    viewHeight,
    W: width,
    H: height,
  };
}

/** Only the four numbers `withFrame({ view })` accepts. */
export function frameView(view) {
  return {
    zoomX: view.zoomX,
    zoomY: view.zoomY,
    offsetX: view.offsetX,
    offsetY: view.offsetY,
  };
}

/**
 * A world point as `[x, y]` in CSS pixels over the canvas.
 *
 * `flip` mirrors horizontally, for an underside rendered with `flipX: true`
 * from an unflipped view (the renderer mirrors about the frame center, so the
 * overlay does the same). `scale` is the canvas backing-store multiplier: the
 * view is in backing pixels, the result in CSS pixels.
 */
export function project(view, x, y, { flip = false, scale = 1 } = {}) {
  let { x: px, y: py } = projectToCanvas(view, x, y, view.W, view.H);
  if (flip) px = view.W - px;
  return [px / scale, py / scale];
}

/** The inverse of `project()`, undoing `flip` and `scale` in the opposite order. */
export function unproject(view, px, py, { flip = false, scale = 1 } = {}) {
  let cx = px * scale;
  if (flip) cx = view.W - cx;
  const { x, y } = unprojectFromCanvas(view, cx, py * scale, view.W, view.H);
  return [x, y];
}

/** Canvas (backing) pixels per world unit along x under `view`. */
export function pixelsPerUnit(view) {
  const { viewWidth } = viewExtent(view.W, view.H);
  return (Math.abs(view.zoomX) / viewWidth) * view.W;
}

/** The bounding box of `[x, y]` points, or `null` when there are none. */
export function boundsOf(points) {
  if (!points || points.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

/** The union of any number of bounds; `null` entries are ignored. */
export function unionBounds(...boundsList) {
  let result = null;
  for (const bounds of boundsList.flat()) {
    result = mergeBounds(result, bounds ?? null);
  }
  return result;
}

/** `bounds` grown by `margin` world units on every side. */
export function padBounds(bounds, margin) {
  if (!bounds) return null;
  return {
    minX: bounds.minX - margin,
    maxX: bounds.maxX + margin,
    minY: bounds.minY - margin,
    maxY: bounds.maxY + margin,
  };
}

/**
 * One view for several things that must line up exactly -- two revisions of a
 * layer, every layer of a board -- fitted to the union of their bounds.
 */
export function sharedView(boundsList, width, height, padding = 0) {
  const bounds = unionBounds(boundsList);
  if (!bounds) throw new Error("sharedView needs at least one finite bounds.");
  return fitView(bounds, width, height, padding);
}

/**
 * Map a pixel of a raster rendered with `fitView(bounds, width, height, 0)`
 * where `bounds` has the raster's aspect (see `faceRaster()` in face.js) back
 * to world coordinates. Row 0 is the top of the image.
 */
export function rasterToWorld(bounds, width, height, px, py) {
  return [
    bounds.minX + (px / width) * (bounds.maxX - bounds.minX),
    bounds.maxY - (py / height) * (bounds.maxY - bounds.minY),
  ];
}

/**
 * Pixel rectangle `{x, y, width, height}` (y down) to world bounds under a
 * view -- flips included, so min/max are sorted.
 */
export function pixelRectToWorld(view, rect) {
  const a = unprojectFromCanvas(view, rect.x, rect.y, view.W, view.H);
  const b = unprojectFromCanvas(
    view,
    rect.x + rect.width,
    rect.y + rect.height,
    view.W,
    view.H,
  );
  return {
    minX: Math.min(a.x, b.x),
    maxX: Math.max(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxY: Math.max(a.y, b.y),
  };
}

/** World bounds to a pixel rectangle `{x, y, width, height}` under a view. */
export function worldToPixelRect(view, bounds) {
  const a = projectToCanvas(view, bounds.minX, bounds.minY, view.W, view.H);
  const b = projectToCanvas(view, bounds.maxX, bounds.maxY, view.W, view.H);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}
