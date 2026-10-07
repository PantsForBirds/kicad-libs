// boarddd/gerber: moved from CoolNamesAllTaken/wasm-gerber-viewer packages/wasm-gerber-renderer/diff.js at 92976b5
// (earlier history lives there).
/**
 * Layer diffs: what changed in one layer between two revisions.
 *
 * Both revisions are drawn in ONE renderer frame, so they share one view by
 * construction: fitted to the union of both revisions' extents, or an explicit
 * `view` (use `measureLayers()` + `sharedView()` to give every layer of a
 * board the same frame). The classification runs on the GPU with the
 * renderer's composite layers: every base and head source is loaded hidden,
 * and three composites select pixels covered by
 *
 *   - base only   -> removed   (red)
 *   - head only   -> added     (green)
 *   - both        -> unchanged (neutral, dim)
 *
 * `analyzeLayerDiff()` renders the same classification with pure colors,
 * reads it back once, and reports whether the layer changed, pixel counts,
 * and bounding boxes of changed regions in pixels and world units, so a UI
 * can list changes and jump to them.
 *
 * Drill (Excellon) sources are converted to Gerber first (`holesToGerber()`),
 * so drill layers diff like any other layer.
 */
import {
  calculateFitView,
  isDrillSource,
  getSourceName,
  looksLikeDrillContent,
  sourceToText,
} from "../../third_party/wasm-gerber-renderer/core/shared.js";
import { hasGeometry, withoutProfile } from "./layers.js";
import { holesToGerber, parseExcellon } from "./drills.js";
import { readRendererPixels } from "./raster.js";
import { pixelRectToWorld, pixelsPerUnit, withFrameSize } from "./view.js";

/** Default overlay colors (0..1 triples) and opacities. */
export const DIFF_STYLE = Object.freeze({
  removed: Object.freeze({ color: [0.93, 0.2, 0.2], alpha: 1 }),
  added: Object.freeze({ color: [0.2, 0.82, 0.3], alpha: 1 }),
  unchanged: Object.freeze({ color: [0.62, 0.64, 0.68], alpha: 0.3 }),
});

/** Most sources one side of a diff may have (patterns grow as 2^n). */
export const MAX_DIFF_SOURCES = 12;

/**
 * The composite `visibleAreas` patterns that classify `baseCount` base
 * sources followed by `headCount` head sources: `{ removed, added, unchanged }`.
 * A pixel is "covered" by a revision when any of its sources covers it.
 */
export function diffPatterns(baseCount, headCount) {
  const total = baseCount + headCount;
  if (baseCount < 1 || headCount < 1 || total > MAX_DIFF_SOURCES) {
    throw new RangeError(
      `A layer diff needs 1..${MAX_DIFF_SOURCES} sources in total with at least one per side.`,
    );
  }
  const removed = [];
  const added = [];
  const unchanged = [];
  for (let code = 1; code < 2 ** total; code += 1) {
    let pattern = "";
    let inBase = false;
    let inHead = false;
    for (let slot = 0; slot < total; slot += 1) {
      const on = (code >> slot) & 1;
      pattern += on ? "1" : "0";
      if (on && slot < baseCount) inBase = true;
      if (on && slot >= baseCount) inHead = true;
    }
    if (inBase && inHead) unchanged.push(pattern);
    else if (inBase) removed.push(pattern);
    else added.push(pattern);
  }
  return { removed, added, unchanged };
}

function toList(side) {
  if (side == null) return [];
  return Array.isArray(side) ? side.filter((entry) => entry != null) : [side];
}

function unwrap(entry) {
  if (entry && typeof entry === "object" && "source" in entry && !(typeof Blob !== "undefined" && entry instanceof Blob)) {
    return { source: entry.source, name: entry.name };
  }
  return { source: entry, name: undefined };
}

/**
 * Sources for one revision as ready-to-render `{ source: text, name }`, with
 * Excellon converted to Gerber and (optionally) profile strokes stripped.
 */
export async function prepareDiffSources(side, { stripProfile = false, onWarning } = {}) {
  const prepared = [];
  for (const entry of toList(side)) {
    const { source, name } = unwrap(entry);
    let text = await sourceToText(source);
    const drill = isDrillSource(source, name ?? "", text) || looksLikeDrillContent(text);
    if (drill) {
      // Zero-diameter tools (KiCad 10's `T1C0.000`) are dropped with a warning.
      const label = name ?? getSourceName(source);
      const warn = (message) => {
        const text = label ? `${label}: ${message}` : message;
        if (typeof onWarning === "function") onWarning(text);
        else console.warn(`boarddd/gerber: ${text}`);
      };
      text = holesToGerber(
        parseExcellon(text, { plated: /npth/i.test(name ?? "") ? false : undefined, onWarning: warn }),
      );
    } else if (stripProfile) {
      text = withoutProfile(text);
    }
    // `kind` is fixed: a converted drill file is Gerber now, whatever its name says.
    prepared.push({
      source: text,
      name,
      kind: "gerber",
      // A file that draws nothing (a header-only drill or Gerber) is an
      // absent side: the renderer would reject it.
      empty: !hasGeometry(text),
    });
  }
  return prepared;
}

/**
 * The text of a Gerber (or converted drill) with lines that cannot change
 * what is drawn removed: `G04` comments and whole-line X2 attribute commands
 * (`%TF…*%`, `%TA…*%`, `%TO…*%`, `%TD…*%`). Two revisions whose texts agree
 * after this draw identical pixels, so a diff can skip rendering them --
 * KiCad re-exports differ in `%TF.CreationDate` alone.
 */
export function geometryText(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed !== "" &&
        !/^G04[^*]*\*$/.test(trimmed) &&
        !/^%T[FAOD][^%]*\*%$/.test(trimmed)
      );
    })
    .join("\n");
}

function sameGeometry(base, head) {
  return (
    base.length === head.length &&
    base.every((entry, index) => geometryText(entry.source) === geometryText(head[index].source))
  );
}

function styleOf(options, key) {
  const base = DIFF_STYLE[key];
  const custom = options.style?.[key] ?? {};
  return {
    color: custom.color ?? options.colors?.[key] ?? base.color,
    alpha: custom.alpha ?? base.alpha,
  };
}

/**
 * Add a diff overlay for one layer to the renderer's ACTIVE frame (inside
 * `withFrame()`, `compositeMode: "stack"` recommended). Returns the public
 * layer IDs `{ removed, added, unchanged }` (`null` where nothing was drawn).
 *
 * `pair` is `{ base, head }`; each side is a source, `{ source, name }`, an
 * array of them (drawn as their union), or `null` (layer absent in that
 * revision -- everything is then added or removed).
 *
 * Options: `style: { removed, added, unchanged: {color, alpha} }`,
 * `showUnchanged` (true), `stripProfile` (false).
 */
export async function addLayerDiff(renderer, pair, options = {}) {
  const base = options.prepared ? pair.base : await prepareDiffSources(pair.base, options);
  const head = options.prepared ? pair.head : await prepareDiffSources(pair.head, options);
  const ids = { removed: null, added: null, unchanged: null };
  const baseLive = base.filter((entry) => !entry.empty);
  const headLive = head.filter((entry) => !entry.empty);
  const removedStyle = styleOf(options, "removed");
  const addedStyle = styleOf(options, "added");
  const unchangedStyle = styleOf(options, "unchanged");
  const showUnchanged = options.showUnchanged !== false;

  if (baseLive.length === 0 || headLive.length === 0) {
    // One side is absent: its counterpart is entirely added or removed.
    const present = baseLive.length ? baseLive : headLive;
    const style = baseLive.length ? removedStyle : addedStyle;
    let first = null;
    for (const entry of present) {
      const id = await renderer.renderLayer(entry, style);
      first ??= id;
    }
    ids[baseLive.length ? "removed" : "added"] = first;
    return ids;
  }

  const patterns = diffPatterns(baseLive.length, headLive.length);
  const sourceIds = [];
  for (const entry of [...baseLive, ...headLive]) {
    sourceIds.push(await renderer.renderLayer(entry, { visible: false }));
  }
  ids.unchanged = await renderer.renderCompositeLayer(sourceIds, {
    name: "Unchanged",
    visibleAreas: patterns.unchanged,
    color: unchangedStyle.color,
    alpha: unchangedStyle.alpha,
    visible: showUnchanged,
  });
  ids.removed = await renderer.renderCompositeLayer(sourceIds, {
    name: "Removed",
    visibleAreas: patterns.removed,
    color: removedStyle.color,
    alpha: removedStyle.alpha,
  });
  ids.added = await renderer.renderCompositeLayer(sourceIds, {
    name: "Added",
    visibleAreas: patterns.added,
    color: addedStyle.color,
    alpha: addedStyle.alpha,
  });
  return ids;
}

const DIFF_OPTION_KEYS = new Set([
  "style",
  "colors",
  "onWarning",
  "showUnchanged",
  "stripProfile",
  "underlay",
  "prepared",
  "cellSize",
  "mergeDistance",
  "minRegionPixels",
  "maxRegions",
  "skipIdentical",
]);

function splitOptions(options) {
  const frame = {};
  const diff = {};
  for (const [key, value] of Object.entries(options)) {
    (DIFF_OPTION_KEYS.has(key) ? diff : frame)[key] = value;
  }
  return { frame, diff };
}

async function addUnderlay(renderer, underlay, alphaOverride) {
  for (const entry of underlay ?? []) {
    const { source, name } = unwrap(entry);
    await renderer.renderLayer(
      { source, name },
      {
        color: entry.color ?? [0.5, 0.5, 0.5],
        alpha: alphaOverride ?? entry.alpha ?? 0.35,
      },
    );
  }
}

/**
 * Render a layer diff to the renderer's canvas in its own frame.
 *
 * Options are `withFrame()` options (`width`, `height`, `view`, `padding`,
 * `flipX`, `background` (default `null`), ...) plus the `addLayerDiff()`
 * options and `underlay`: layers drawn first as context (e.g. the board
 * outline), each `{ source, name?, color?, alpha? }`.
 *
 * @returns `{ frame, view, ids }` -- `view` is `frame.view` with the frame
 *   size attached (`W`, `H`), ready for view.js `project()`.
 */
export async function renderLayerDiff(renderer, pair, options = {}) {
  const { frame: frameOptions, diff } = splitOptions(options);
  const base = await prepareDiffSources(pair.base, diff);
  const head = await prepareDiffSources(pair.head, diff);
  let ids = null;
  await renderer.withFrame(
    { background: null, ...frameOptions, compositeMode: "stack" },
    async () => {
      await addUnderlay(renderer, diff.underlay);
      ids = await addLayerDiff(renderer, { base, head }, { ...diff, prepared: true });
    },
  );
  const frame = renderer.lastFrame;
  return {
    frame,
    view: frame.view ? withFrameSize(frame.view, frame.width, frame.height) : null,
    ids,
  };
}

const CLASS_STYLE = {
  removed: { color: [1, 0, 0], alpha: 1 },
  added: { color: [0, 1, 0], alpha: 1 },
  unchanged: { color: [0, 0, 1], alpha: 1 },
};

/**
 * Classify a layer diff and report what changed.
 *
 * Renders the diff in its own frame with pure classification colors (same
 * view as `renderLayerDiff()` with the same frame options), reads the pixels
 * back once and summarizes them (see `summarizeDiffPixels()`).
 *
 * Extra options: `cellSize` (8 px), `mergeDistance` (16 px: changes closer
 * than this merge into one region), `minRegionPixels` (1), `maxRegions` (500),
 * `skipIdentical` (true: revisions whose `geometryText()` is identical --
 * byte-identical up to comments and X2 attributes -- are reported unchanged
 * without rendering).
 *
 * @returns `{ changed, identical, addedPixels, removedPixels, unchangedPixels,
 *   regions, truncated, width, height, view, pixelSizeMm }` where each region
 *   is `{ kind: "added"|"removed"|"mixed", addedPixels, removedPixels,
 *   pixels: {x, y, width, height}, world: {minX, maxX, minY, maxY} }`, sorted
 *   largest first. `view` carries `W`/`H`.
 */
export async function analyzeLayerDiff(renderer, pair, options = {}) {
  const { frame: frameOptions, diff } = splitOptions(options);
  const base = await prepareDiffSources(pair.base, diff);
  const head = await prepareDiffSources(pair.head, diff);
  if (diff.skipIdentical !== false && sameGeometry(base, head)) {
    return {
      changed: false,
      identical: true,
      addedPixels: 0,
      removedPixels: 0,
      unchangedPixels: null,
      regions: [],
      truncated: false,
      width: frameOptions.width ?? null,
      height: frameOptions.height ?? null,
      view: frameOptions.view && frameOptions.width && frameOptions.height
        ? withFrameSize(frameOptions.view, frameOptions.width, frameOptions.height)
        : null,
      pixelSizeMm: null,
    };
  }
  await renderer.withFrame(
    {
      ...frameOptions,
      background: null,
      compositeMode: "stack",
      // Coverage is what is being measured; no feature may be widened differently.
    },
    async () => {
      // Underlays are drawn invisibly (alpha 0) so they frame exactly as in
      // renderLayerDiff() without touching the classification colors.
      await addUnderlay(renderer, diff.underlay, 0);
      await addLayerDiff(renderer, { base, head }, {
        prepared: true,
        style: CLASS_STYLE,
        showUnchanged: true,
      });
    },
  );
  const frame = renderer.lastFrame;
  const { pixels, width, height } = readRendererPixels(renderer, { bottomUp: true });
  const summary = summarizeDiffPixels(pixels, width, height, { ...diff, bottomUp: true });
  const view = frame.view ? withFrameSize(frame.view, width, height) : null;
  for (const region of summary.regions) {
    region.world = view ? pixelRectToWorld(view, region.pixels) : null;
  }
  return {
    ...summary,
    identical: false,
    width,
    height,
    view,
    pixelSizeMm: view ? 1 / pixelsPerUnit(view) : null,
  };
}

/**
 * Summarize classification pixels (RGBA; red = removed, green = added,
 * blue = unchanged) into counts and changed regions. Pure; exported for
 * hosts that render the classification themselves.
 *
 * Changed pixels are binned into `cellSize` squares; cells within
 * `mergeDistance` pixels of each other join one region, whose box is the exact
 * pixel extent of its changed pixels. `bottomUp: true` when rows run from the
 * bottom (raw `gl.readPixels`); region boxes are always y-down.
 */
export function summarizeDiffPixels(pixels, width, height, options = {}) {
  const cellSize = Math.max(1, Math.round(options.cellSize ?? 8));
  const mergeDistance = Math.max(0, options.mergeDistance ?? 16);
  const minRegionPixels = Math.max(1, options.minRegionPixels ?? 1);
  const maxRegions = Math.max(1, options.maxRegions ?? 500);
  const bottomUp = options.bottomUp === true;
  const cols = Math.ceil(width / cellSize);
  const rows = Math.ceil(height / cellSize);
  const cellCount = cols * rows;
  const cellAdded = new Uint32Array(cellCount);
  const cellRemoved = new Uint32Array(cellCount);
  const cellMinX = new Int32Array(cellCount).fill(2147483647);
  const cellMinY = new Int32Array(cellCount).fill(2147483647);
  const cellMaxX = new Int32Array(cellCount).fill(-1);
  const cellMaxY = new Int32Array(cellCount).fill(-1);

  let addedPixels = 0;
  let removedPixels = 0;
  let unchangedPixels = 0;
  const stride = width * 4;
  for (let row = 0; row < height; row += 1) {
    const y = bottomUp ? height - 1 - row : row;
    const cellRow = ((y / cellSize) | 0) * cols;
    let at = row * stride;
    for (let x = 0; x < width; x += 1, at += 4) {
      const alpha = pixels[at + 3];
      if (alpha < 128) continue;
      const red = pixels[at];
      const green = pixels[at + 1];
      let kind = 0;
      if (red >= 128 && red > green) kind = 1;
      else if (green >= 128) kind = 2;
      else {
        if (pixels[at + 2] >= 128) unchangedPixels += 1;
        continue;
      }
      const cell = cellRow + ((x / cellSize) | 0);
      if (kind === 1) {
        removedPixels += 1;
        cellRemoved[cell] += 1;
      } else {
        addedPixels += 1;
        cellAdded[cell] += 1;
      }
      if (x < cellMinX[cell]) cellMinX[cell] = x;
      if (x > cellMaxX[cell]) cellMaxX[cell] = x;
      if (y < cellMinY[cell]) cellMinY[cell] = y;
      if (y > cellMaxY[cell]) cellMaxY[cell] = y;
    }
  }

  const reach = Math.ceil(mergeDistance / cellSize);
  const visited = new Uint8Array(cellCount);
  const regions = [];
  const stack = [];
  for (let start = 0; start < cellCount; start += 1) {
    if (visited[start] || (cellAdded[start] === 0 && cellRemoved[start] === 0)) continue;
    visited[start] = 1;
    stack.push(start);
    let added = 0;
    let removed = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    while (stack.length) {
      const cell = stack.pop();
      added += cellAdded[cell];
      removed += cellRemoved[cell];
      if (cellMinX[cell] < minX) minX = cellMinX[cell];
      if (cellMinY[cell] < minY) minY = cellMinY[cell];
      if (cellMaxX[cell] > maxX) maxX = cellMaxX[cell];
      if (cellMaxY[cell] > maxY) maxY = cellMaxY[cell];
      const cx = cell % cols;
      const cy = (cell - cx) / cols;
      for (let ny = Math.max(0, cy - reach); ny <= Math.min(rows - 1, cy + reach); ny += 1) {
        for (let nx = Math.max(0, cx - reach); nx <= Math.min(cols - 1, cx + reach); nx += 1) {
          const next = ny * cols + nx;
          if (visited[next] || (cellAdded[next] === 0 && cellRemoved[next] === 0)) continue;
          visited[next] = 1;
          stack.push(next);
        }
      }
    }
    if (added + removed < minRegionPixels) continue;
    regions.push({
      kind: added && removed ? "mixed" : added ? "added" : "removed",
      addedPixels: added,
      removedPixels: removed,
      pixels: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    });
  }
  regions.sort(
    (a, b) => b.addedPixels + b.removedPixels - (a.addedPixels + a.removedPixels),
  );
  const truncated = regions.length > maxRegions;
  if (truncated) regions.length = maxRegions;
  return {
    changed: regions.length > 0,
    addedPixels,
    removedPixels,
    unchangedPixels,
    regions,
    truncated,
  };
}

/**
 * World bounds of every source, in one hidden frame: `{ bounds, layers }`
 * where `layers[i]` is `{ name, bounds }` for `sources[i]` (after drill
 * conversion). Use the union with `sharedView()` so every layer of a board,
 * in both revisions, is drawn in the same frame.
 *
 * Note: this uses (and resizes to 1x1) the renderer's canvas and replaces
 * `renderer.lastFrame`; measure before rendering what is shown.
 */
export async function measureLayers(renderer, sources, options = {}) {
  const prepared = await prepareDiffSources(sources, options);
  const live = prepared.filter((entry) => !entry.empty);
  await renderer.withFrame(
    { width: 1, height: 1, fit: false, background: null, compositeMode: "stack" },
    async () => {
      for (const entry of live) {
        await renderer.renderLayer(entry, { visible: false });
      }
    },
  );
  const layers = [];
  let bounds = null;
  let index = 0;
  for (const entry of prepared) {
    if (entry.empty) {
      layers.push({ name: entry.name ?? null, bounds: null });
      continue;
    }
    const record = renderer.lastFrame.layers[index];
    index += 1;
    layers.push({ name: entry.name ?? record?.name ?? null, bounds: record?.bounds ?? null });
    if (record?.bounds) {
      bounds = bounds
        ? {
            minX: Math.min(bounds.minX, record.bounds.minX),
            maxX: Math.max(bounds.maxX, record.bounds.maxX),
            minY: Math.min(bounds.minY, record.bounds.minY),
            maxY: Math.max(bounds.maxY, record.bounds.maxY),
          }
        : { ...record.bounds };
    }
  }
  return { bounds, layers };
}

/**
 * Analyze every layer of a two-revision board in one shared frame.
 *
 * `layers` is `[{ name, base, head }]`. Measures all sources of both
 * revisions, fits one view to their union (or uses `options.view`), then runs
 * `analyzeLayerDiff()` per layer with that view.
 *
 * @returns `{ view, bounds, width, height, changed, layers: [{ name, ...report }] }`
 */
export async function analyzeBoardDiff(renderer, layers, options = {}) {
  const { width = 2048, height = 2048, padding = 0 } = options;
  let view = options.view;
  let bounds = null;
  if (!view) {
    const all = layers.flatMap((layer) => [...toList(layer.base), ...toList(layer.head)]);
    const measured = await measureLayers(renderer, all, options);
    bounds = measured.bounds;
    if (!bounds) throw new Error("No layer of either revision has any geometry.");
    view = calculateFitView(bounds, width, height, padding);
  }
  const frameView = {
    zoomX: view.zoomX,
    zoomY: view.zoomY,
    offsetX: view.offsetX,
    offsetY: view.offsetY,
  };
  const reports = [];
  for (const layer of layers) {
    const report = await analyzeLayerDiff(
      renderer,
      { base: layer.base, head: layer.head },
      { ...options, width, height, view: frameView },
    );
    reports.push({ name: layer.name, ...report });
  }
  return {
    view: withFrameSize(frameView, width, height),
    bounds,
    width,
    height,
    changed: reports.some((report) => report.changed),
    layers: reports,
  };
}
