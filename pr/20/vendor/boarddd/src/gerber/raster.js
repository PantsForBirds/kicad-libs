// boarddd/gerber: moved from CoolNamesAllTaken/wasm-gerber-viewer packages/wasm-gerber-renderer/raster.js at 92976b5
// (earlier history lives there).
/**
 * Reading rendered pixels back, and small canvas utilities around that.
 *
 * `readRendererPixels()` reads a renderer's WebGL canvas with `gl.readPixels`
 * (one copy, no 2D-canvas round trip). The renderer opens its context with
 * `preserveDrawingBuffer`, so a completed frame is still there to read.
 */
import { flipRows } from "./contour.js";

/**
 * The renderer canvas's pixels as RGBA bytes, rows top-down (image order)
 * unless `bottomUp: true`. Values are as stored in the drawing buffer, i.e.
 * premultiplied by alpha. Optionally a sub-rectangle `{x, y, width, height}`
 * in top-down pixel coordinates.
 */
export function readRendererPixels(renderer, { rect = null, bottomUp = false, into = null } = {}) {
  const gl = renderer.getContext();
  const canvas = renderer.canvas;
  const x = rect ? rect.x : 0;
  const width = rect ? rect.width : canvas.width;
  const height = rect ? rect.height : canvas.height;
  const y = rect ? canvas.height - rect.y - rect.height : 0;
  const pixels = into ?? new Uint8Array(width * height * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const previous = gl.getParameter(gl.PACK_ALIGNMENT);
  gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
  try {
    gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  } finally {
    gl.pixelStorei(gl.PACK_ALIGNMENT, previous);
  }
  if (!bottomUp) flipRows(pixels, width, height);
  return { pixels, width, height };
}

/**
 * Whether at least `minShare` of a 2D-readable canvas's pixels are drawn
 * (alpha above 8). `false` for an unreadable (tainted) canvas. Useful to avoid
 * capturing a frame in the gap between clearing a canvas and drawing on it.
 */
export function hasInk(canvas, minShare = 0.01) {
  try {
    const context = canvas.getContext("2d");
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 8) lit += 1;
    return lit >= canvas.width * canvas.height * minShare;
  } catch (_error) {
    return false;
  }
}

function makeCanvas(width, height) {
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  throw new Error("No canvas implementation is available.");
}

/**
 * A 2D copy of `source` (any drawable: a WebGL canvas, an image) no larger
 * than `maxPx` on its long side. `drawImage` from a WebGL canvas takes its
 * bitmap synchronously, which is the safe moment to capture it.
 */
export function copyScaled(source, maxPx = 560) {
  const width = source.width;
  const height = source.height;
  if (!width || !height) return null;
  const scale = Math.min(1, maxPx / Math.max(width, height));
  const copy = makeCanvas(
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale)),
  );
  const context = copy.getContext("2d");
  if (!context) return null;
  context.drawImage(source, 0, 0, copy.width, copy.height);
  return copy;
}

/**
 * An opaque 2D copy of `source` laid over a solid `color` (CSS color string).
 * For using a render as a texture: a material that does not blend samples a
 * transparent texel as black, so what the render leaves transparent (mask
 * pullbacks with no copper, holes) should show laminate instead.
 */
export function flattenOnto(source, color) {
  const flat = makeCanvas(source.width, source.height);
  const context = flat.getContext("2d");
  if (!context) return source;
  context.fillStyle = color;
  context.fillRect(0, 0, flat.width, flat.height);
  context.drawImage(source, 0, 0);
  return flat;
}
