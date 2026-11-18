// What a stage pane shows: content descriptors, and how each is rasterised over a world rect at a
// given px/mm into a plain 2D canvas (a tile) that the stage places with a CSS transform.
//
// Gerber content (face, layers, diff) goes through ONE hidden WebGL renderer, one frame at a time
// per renderer, each frame framing an explicit rect so every render of any layer set lands on the
// same pixels (kipr web/project/js/gerber.js; gentoo fab/static/fab/guide/stage.js RENDER_LOCK).
// Image and ink-diff content (SVG sheets, PNGs) is 2D canvas only. No fetch, no workers, no
// import.meta.url: everything arrives as text / images, so it works from a file:// bundle.

import { addBoardLayers } from '../gerber/board.js';
import { renderLayerDiff, analyzeLayerDiff } from '../gerber/diff.js';
import { holesToGerber, parseExcellon } from '../gerber/drills.js';
import { hasGeometry } from '../gerber/layers.js';
import { ringsToGerber } from '../gerber/outline.js';
import { boardPalette } from '../gerber/palette.js';
import { fitView, frameView } from '../gerber/view.js';
import { inkDiff, DIFF_COLORS } from './inkdiff.js';
import { rasterRect } from './math.js';

/** A realistic board face: substrate, copper, finish, mask, silk, see-through holes (addBoardLayers). */
export function face(board, { side = 'top', palette = {}, ...options } = {}) {
  return { type: 'face', board, side, palette, options };
}

/**
 * A stack of single-colour layers ({ source, color: [r, g, b] 0..1, alpha, kind?, name?, inverted? })
 * in paint order; a layerStack() works as is (invisible entries are skipped). One entry: a single-layer view.
 *
 * Options make it a board drawn from those layers (the flat views of an app that colours layers
 * itself, e.g. by its own palette):
 * - `outline`: the board's rings in world mm, `[board, ...cutouts]` or `{ board, cutouts }`. An
 *   `inverted: true` layer (a solder mask: the file marks the openings) then fills exactly the
 *   board, not only as far as the layers drawn before it reach; and the layers are clipped to it
 *   (even-odd, so a cutout is a hole), unless `clip: false`.
 * - `substrate`: a CSS colour painted inside the outline under the layers (laminate shows wherever
 *   the mask is pulled back over no copper); without an outline, under the whole content.
 * - `holes`: drills ({ x, y, d | diameter, x2?, y2?, filled? }) cut out of the drawing, so what shows
 *   through them is whatever is under the stage. A slot is a stadium; a filled hole is not cut.
 */
export function layers(list, { outline = null, clip = true, substrate = null, holes = null } = {}) {
  return { type: 'layers', layers: list, options: { outline: outlineRings(outline), clip, substrate, holes } };
}

/**
 * Content drawn once and placed at several spots: the copies of a board in a panel. Each placement
 * { x, y, rotation } turns the content by `rotation` degrees (counter-clockwise) about the world
 * origin, then moves it by (x, y). `rect` is the world area of the content to place (required unless
 * the content has its own, e.g. an image).
 */
export function repeat(content, placements, rect = null) {
  return { type: 'repeat', content, placements: placements || [], rect: rect || contentRect(content) };
}

/** The GPU layer diff (boarddd/gerber renderLayerDiff) of one layer: each side a source, several, or null. */
export function diff(base, head, { style, colors, showUnchanged = true, underlay, regions = false } = {}) {
  return { type: 'diff', base, head, options: { style, colors, showUnchanged, underlay }, regions };
}

/**
 * An image (SVG text, a Blob, an <img>, a canvas, an ImageBitmap, or a same-origin URL) placed over
 * world `rect` ({ minX, maxX, minY, maxY } mm). SVG is re-rasterised at each resolution, so it stays sharp.
 */
export function image(src, rect) {
  return { type: 'image', src, rect };
}

/**
 * Ink diff of two images over one rect (kipr inkdiff.js): ink only in base red, only in head green,
 * in both dimmed. A side drawn over its own world rect is `{ src, rect }` (e.g. sheets of different
 * viewBoxes); `rect` is the diff's frame. `mode`: 'ink' (paper ignored) or 'alpha'; `tol` in pixels.
 */
export function inkdiff(base, head, rect, { mode = 'ink', tol = 1, colors = DIFF_COLORS, regionGapMm = 1.5 } = {}) {
  return { type: 'inkdiff', base, head, rect, options: { mode, tol, colors, regionGapMm } };
}

/** App drawing in world mm: draw(ctx, { rect, r, width, height }) on a 2D context already mapped to mm, y up. */
export function draw(fn, rect = null) {
  return { type: 'draw', draw: fn, rect };
}

/** The world rect a content covers on its own, or null when it spans the stage bounds. */
export function contentRect(c) {
  if (c?.type === 'repeat') return placedRect(c);
  return c && (c.type === 'image' || c.type === 'inkdiff' || c.type === 'draw') ? c.rect || null : null;
}

/** Whether a content needs the gerber renderer. */
export function needsRenderer(c) {
  if (c?.type === 'layers') return drawable(c.layers).length > 0;
  if (c?.type === 'repeat') return needsRenderer(c.content);
  return !!c && (c.type === 'face' || c.type === 'diff');
}

/** Rings as [[x, y], ...][] (board first), from either form; null when there is no usable board ring. */
export function outlineRings(outline) {
  if (!outline) return null;
  const rings = Array.isArray(outline) ? outline : [outline.board, ...(outline.cutouts || [])];
  const ok = rings.filter((r) => Array.isArray(r) && r.length >= 3);
  return ok.length && ok[0] === rings[0] ? ok : null;
}

const turn = (deg) => {
  const a = ((deg || 0) * Math.PI) / 180;
  return { c: Math.cos(a), s: Math.sin(a) };
};

/** The world box a repeat covers: its rect carried to every placement. */
function placedRect(c) {
  const r = c.rect;
  if (!r || !c.placements.length) return null;
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (const p of c.placements) {
    const { c: cos, s: sin } = turn(p.rotation);
    for (const [x, y] of [[r.minX, r.minY], [r.maxX, r.minY], [r.maxX, r.maxY], [r.minX, r.maxY]]) {
      const X = cos * x - sin * y + (p.x || 0);
      const Y = sin * x + cos * y + (p.y || 0);
      minX = Math.min(minX, X); maxX = Math.max(maxX, X); minY = Math.min(minY, Y); maxY = Math.max(maxY, Y);
    }
  }
  return { minX, maxX, minY, maxY };
}

// --- frame lock: one frame per renderer at a time, across every stage on the page
const locks = new WeakMap();
export function inTurn(renderer, work) {
  const prev = locks.get(renderer) || Promise.resolve();
  const mine = prev.then(work, work);
  locks.set(renderer, mine.then(() => {}, () => {}));
  return mine;
}

function newCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

function copyOf(src, w, h) {
  const c = newCanvas(w, h);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

const isDrill = (l) => l.kind === 'drill' || l.role === 'drill';
/** True for a Gerber / drill text that draws nothing (the renderer rejects those). */
export function isEmptySource(source, drill = false) {
  if (typeof source !== 'string') return false;
  if (drill) return !/^\s*(?:G0?[0-3]\s*)?[XY][-+]?\d/m.test(source);
  return !hasGeometry(source);
}

async function glFrame(renderer, job, body) {
  const view = frameView(fitView(job.rect, job.width, job.height, 0));
  return inTurn(renderer, async () => {
    let out = null;
    await renderer.withFrame({ width: job.width, height: job.height, background: null, compositeMode: 'stack', view, renderDrills: true }, async () => {
      out = await body(view);
    });
    // inside the turn: the frame's pixels are only ours until the next one starts
    return { canvas: copyOf(renderer.canvas, job.width, job.height), info: out || {} };
  });
}

async function renderFace(c, renderer, job) {
  const palette = c.palette && c.palette.mask?.color ? c.palette : boardPalette(c.palette || {});
  return glFrame(renderer, job, async () => {
    const ids = await addBoardLayers(renderer, c.board, { holes: true, clipSilk: true, ...c.options, side: c.side, palette });
    return { ids };
  });
}

const drawable = (list) => (list || []).filter((l) => l && l.visible !== false && l.source != null && !isEmptySource(l.source, isDrill(l)));

async function renderLayers(c, getRenderer, job) {
  const list = drawable(c.layers); // e.g. an NPTH file of a board without unplated holes draws nothing
  const o = c.options || {};
  let out = { canvas: null, info: { failures: [] } };
  if (list.length) {
    const renderer = await getRenderer();
    out = await glFrame(renderer, job, async () => {
      const failures = [];
      let edge;
      for (const l of list) {
        try {
          // without a frame background the renderer erases drill fills; as a layer they are painted
          const style = { color: l.color || [0.8, 0.8, 0.8], alpha: l.alpha ?? 1 };
          if (l.inverted) {
            // filled to the outline: hand the renderer the rings as a hidden hairline layer
            if (edge === undefined) edge = o.outline ? await renderer.renderLayer(ringsToGerber(o.outline), { visible: false }) : null;
            await renderer.renderInvertedLayer(l.source, edge != null ? { ...style, outlineLayerId: edge } : style);
          } else if (!isDrill(l)) await renderer.renderLayer(l.source, style);
          else if (typeof l.source !== 'string') await renderer.renderLayer(l.source, { ...style, kind: 'drill' });
          else if (drillGerber(l.source)) await renderer.renderLayer(drillGerber(l.source), style);
        } catch (e) {
          failures.push({ name: l.name ?? null, error: String(e?.message || e) });
        }
      }
      return { failures };
    });
  }
  if (!o.substrate && !o.holes?.length && !(o.outline && o.clip !== false)) {
    return out.canvas ? out : { canvas: newCanvas(job.width, job.height), info: out.info };
  }
  return { canvas: finishBoard(out.canvas, o, job), info: out.info };
}

/** World mm -> tile px on a 2D context (y up). */
const toTile = (g, job) => g.setTransform(job.r, 0, 0, -job.r, -job.rect.minX * job.r, job.rect.maxY * job.r);

function ringsPath(rings) {
  const path = new Path2D();
  for (const ring of rings) {
    ring.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
    path.closePath();
  }
  return path;
}

/** Round holes and stadium slots (world mm) as one path; filled holes are left out. */
export function holesPath(holes) {
  const path = new Path2D();
  for (const h of holes || []) {
    const r = (h.d ?? h.diameter ?? 0) / 2;
    if (h.filled || !(r > 0)) continue;
    if (h.x2 == null || h.y2 == null) {
      path.moveTo(h.x + r, h.y);
      path.arc(h.x, h.y, r, 0, Math.PI * 2);
    } else {
      const a = Math.atan2(h.y2 - h.y, h.x2 - h.x);
      path.moveTo(h.x + r * Math.cos(a + Math.PI / 2), h.y + r * Math.sin(a + Math.PI / 2));
      path.arc(h.x, h.y, r, a + Math.PI / 2, a + (3 * Math.PI) / 2);
      path.arc(h.x2, h.y2, r, a - Math.PI / 2, a + Math.PI / 2);
      path.closePath();
    }
  }
  return path;
}

/** The layers' pixels on the substrate, clipped to the outline, holes cut through. */
function finishBoard(drawn, o, job) {
  const out = newCanvas(job.width, job.height);
  const g = out.getContext('2d');
  const rings = o.outline;
  const shape = rings ? ringsPath(rings) : null;
  g.save();
  toTile(g, job);
  if (shape && o.clip !== false) g.clip(shape, 'evenodd');
  if (o.substrate) {
    g.fillStyle = o.substrate;
    if (shape) g.fill(shape, 'evenodd');
    else { g.setTransform(1, 0, 0, 1, 0, 0); g.fillRect(0, 0, job.width, job.height); }
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (drawn) g.drawImage(drawn, 0, 0);
  g.restore();
  if (o.holes?.length) {
    toTile(g, job);
    g.globalCompositeOperation = 'destination-out';
    g.fill(holesPath(o.holes));
    g.globalCompositeOperation = 'source-over';
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
  return out;
}

const drillCache = new Map();
function drillGerber(text) {
  if (typeof text !== 'string') return null;
  if (!drillCache.has(text)) {
    if (drillCache.size > 32) drillCache.delete(drillCache.keys().next().value);
    const holes = parseExcellon(text);
    drillCache.set(text, holes.length ? holesToGerber(holes) : null);
  }
  return drillCache.get(text);
}

const emptySide = (s) => (Array.isArray(s) ? s.filter((x) => x != null) : s != null ? [s] : []).length === 0;

async function renderDiff(c, renderer, job) {
  const view = fitView(job.rect, job.width, job.height, 0);
  const pair = { base: emptySide(c.base) ? null : c.base, head: emptySide(c.head) ? null : c.head };
  return inTurn(renderer, async () => {
    let report = null;
    const frame = { width: job.width, height: job.height, view: frameView(view) };
    if (c.regions) report = await analyzeLayerDiff(renderer, pair, { ...frame, skipIdentical: false, mergeDistance: Math.max(2, Math.round(1.5 * job.r)), minRegionPixels: 3, maxRegions: 200 });
    await renderLayerDiff(renderer, pair, { ...frame, background: null, ...stripUndefined(c.options) });
    const info = report
      ? { counts: { removed: report.removedPixels, added: report.addedPixels, unchanged: report.unchangedPixels }, regions: report.regions.filter((q) => q.world).map((q) => ({ ...q.world, kind: q.kind, pixels: q.addedPixels + q.removedPixels })) }
      : {};
    return { canvas: copyOf(renderer.canvas, job.width, job.height), info };
  });
}

function stripUndefined(o) {
  return Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined));
}

// --- images
const decoded = new WeakMap(); // content object or Blob -> Promise<drawable>
const svgText = (s) => typeof s === 'string' && /^\s*(<\?xml|<svg|<!--)/i.test(s);

function loadImg(url, revoke) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { if (revoke) URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { if (revoke) URL.revokeObjectURL(url); reject(new Error('image could not be decoded')); };
    img.src = url;
  });
}

/** Any image input as something drawImage takes (decoded once per input). */
export function decodeImage(src) {
  if (src == null) return Promise.resolve(null);
  if (typeof src === 'object' && decoded.has(src)) return decoded.get(src);
  let p;
  if (svgText(src)) p = loadImg(URL.createObjectURL(new Blob([src], { type: 'image/svg+xml' })), true);
  else if (typeof src === 'string') p = loadImg(src, false);
  else if (typeof Blob !== 'undefined' && src instanceof Blob) p = loadImg(URL.createObjectURL(src), true);
  else if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) p = src.complete && src.naturalWidth ? Promise.resolve(src) : src.decode().then(() => src);
  else p = Promise.resolve(src); // canvas, ImageBitmap, OffscreenCanvas
  if (typeof src === 'object') decoded.set(src, p);
  return p;
}

/** The pixels of `img` drawn over world `at`, rasterised over world `rect` at r px/mm (y up). */
function rasterOver(img, at, job) {
  const c = newCanvas(job.width, job.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  if (img) {
    const r = job.r;
    g.drawImage(img, (at.minX - job.rect.minX) * r, (job.rect.maxY - at.maxY) * r, (at.maxX - at.minX) * r, (at.maxY - at.minY) * r);
  }
  return { canvas: c, g };
}

async function renderImage(c, job) {
  const img = await decodeImage(c.src);
  return { canvas: rasterOver(img, c.rect, job).canvas, info: {} };
}

async function renderInk(c, job) {
  const own = (s) => (s && Object.getPrototypeOf(s) === Object.prototype && 'src' in s ? s : { src: s, rect: null });
  const [b, hd] = [own(c.base), own(c.head)];
  const [bi, hi] = await Promise.all([decodeImage(b.src), decodeImage(hd.src)]);
  const { width: w, height: h, r } = job;
  const read = (img, at) => (img ? rasterOver(img, at || c.rect, job).g.getImageData(0, 0, w, h).data : null);
  const o = c.options;
  const d = inkDiff(read(bi, b.rect), read(hi, hd.rect), w, h, { mode: o.mode, tol: o.tol, colors: o.colors, gap: Math.max(2, o.regionGapMm * r), minPixels: Math.max(3, Math.round(r * r * 0.05)) });
  const out = newCanvas(w, h);
  const g = out.getContext('2d');
  const data = g.createImageData(w, h);
  data.data.set(d.rgba);
  g.putImageData(data, 0, 0);
  const regions = d.regions.map((q) => ({
    minX: job.rect.minX + q.x / r, maxX: job.rect.minX + (q.x + q.w) / r,
    minY: job.rect.maxY - (q.y + q.h) / r, maxY: job.rect.maxY - q.y / r, pixels: q.pixels,
  }));
  return { canvas: out, info: { counts: d.counts, regions } };
}

async function renderDraw(c, job) {
  const out = newCanvas(job.width, job.height);
  const g = out.getContext('2d');
  g.setTransform(job.r, 0, 0, -job.r, -job.rect.minX * job.r, job.rect.maxY * job.r);
  await c.draw(g, job);
  return { canvas: out, info: {} };
}

async function renderRepeat(c, job, getRenderer) {
  const out = newCanvas(job.width, job.height);
  if (!c.rect || !c.placements.length) return { canvas: out, info: {} };
  const inner = rasterRect(c.rect, job.r);
  const drawn = await renderContent(c.content, { ...inner, r: job.r }, getRenderer);
  const g = out.getContext('2d');
  const { minX, maxY } = inner.rect;
  const r = job.r;
  for (const p of c.placements) {
    const { c: cos, s: sin } = turn(p.rotation);
    // inner tile px (u, v) -> world (turned, then moved) -> this tile's px
    g.setTransform(cos, -sin, sin, cos,
      r * (cos * minX - sin * maxY + (p.x || 0) - job.rect.minX),
      r * (job.rect.maxY - sin * minX - cos * maxY - (p.y || 0)));
    g.drawImage(drawn.canvas, 0, 0);
  }
  return { canvas: out, info: drawn.info };
}

/**
 * Rasterise content `c` over job.rect (world) at job.r px/mm into job.width x job.height pixels.
 * `getRenderer` is called only for gerber content. Returns { canvas, info }.
 */
export async function renderContent(c, job, getRenderer) {
  switch (c?.type) {
    case 'face': return renderFace(c, await getRenderer(), job);
    case 'layers': return renderLayers(c, getRenderer, job);
    case 'repeat': return renderRepeat(c, job, getRenderer);
    case 'diff': return renderDiff(c, await getRenderer(), job);
    case 'image': return renderImage(c, job);
    case 'inkdiff': return renderInk(c, job);
    case 'draw': return renderDraw(c, job);
    default: throw new TypeError(`view2d: unknown content ${c?.type}`);
  }
}
