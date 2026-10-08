// boarddd/gerber: moved from CoolNamesAllTaken/wasm-gerber-viewer packages/wasm-gerber-renderer/contour-worker.js at 92976b5
// (earlier history lives there).
/**
 * A module worker that traces rasters off the main thread.
 *
 *     const worker = new Worker(
 *       new URL("boarddd/gerber/contour-worker.js", import.meta.url),
 *       { type: "module" },
 *     );
 *     worker.postMessage({ id, buffer, width, height, bottomUp: true, fromBrightness: true },
 *                        [buffer]);
 *     worker.onmessage = ({ data: { id, shapes } }) => { ... };
 *
 * `buffer` is RGBA (transferred in). `bottomUp` flips rows first (what
 * `gl.readPixels` returns); `fromBrightness` copies brightness into alpha (for
 * a layer rendered white on an opaque black background). `minArea` is passed
 * to `traceLayer()`. Replies `{ id, shapes }` or `{ id, error }`.
 */
import { brightnessToAlpha, flipRows, traceLayer } from "./contour.js";

self.onmessage = (event) => {
  const { id, buffer, width, height, bottomUp, fromBrightness, minArea } = event.data;
  try {
    const pixels = new Uint8ClampedArray(buffer);
    if (bottomUp) flipRows(pixels, width, height);
    if (fromBrightness) brightnessToAlpha(pixels);
    self.postMessage({ id, shapes: traceLayer(pixels, width, height, minArea ?? 12) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
