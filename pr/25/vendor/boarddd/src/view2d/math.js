// View maths of the 2D stage: pure, no DOM.
//
// World: board mm, y up (the Gerber frame). A view is { cx, cy, s }: the world point at the centre
// of the pane and CSS px per mm. `flip` mirrors x (the underside seen from below). Keeping the
// centre rather than a corner makes a resize keep what is on show, and makes a view portable
// between panes of different sizes (see regionOf / viewForRegion).
//
// Ported from kipr web/project/js/panzoom.js (fitTransform, zoomAbout, regionOf, viewForRegion) and
// gentoo fab/static/fab/viewer.js (renderScale budget, resharpen threshold).

export const MIN_SCALE = 1e-3; // px per mm
export const MAX_SCALE = 2e4;

const fx = (flip) => (flip ? -1 : 1);

/** Bounds { minX, maxX, minY, maxY } as { x, y, w, h } and back. */
export function boundsSize(b) {
  return { w: Math.max(b.maxX - b.minX, 1e-9), h: Math.max(b.maxY - b.minY, 1e-9) };
}

/**
 * The view that shows `bounds` in a pw x ph pane with `pad` (fraction of the pane) and `padPx`
 * (CSS px) on every side.
 */
export function fitBounds(bounds, pw, ph, pad = 0.02, padPx = 0) {
  const { w, h } = boundsSize(bounds);
  const s = Math.min(Math.max(1, pw - 2 * padPx) / w, Math.max(1, ph - 2 * padPx) / h) * (1 - 2 * pad);
  return { cx: (bounds.minX + bounds.maxX) / 2, cy: (bounds.minY + bounds.maxY) / 2, s: clampScale(s) };
}

export function clampScale(s, min = MIN_SCALE, max = MAX_SCALE) {
  return Math.min(Math.max(s, min), max);
}

/** World mm -> pane CSS px. */
export function toScreen(v, pw, ph, x, y, flip = false) {
  return [pw / 2 + v.s * fx(flip) * (x - v.cx), ph / 2 - v.s * (y - v.cy)];
}

/** Pane CSS px -> world mm. */
export function toWorld(v, pw, ph, px, py, flip = false) {
  return [v.cx + (px - pw / 2) / (v.s * fx(flip)), v.cy - (py - ph / 2) / v.s];
}

/** Zoom by `factor` about pane point (px, py): the world point under it stays put. */
export function zoomAt(v, pw, ph, px, py, factor, flip = false, min = MIN_SCALE, max = MAX_SCALE) {
  const [wx, wy] = toWorld(v, pw, ph, px, py, flip);
  const s = clampScale(v.s * factor, min, max);
  return { s, cx: wx - (px - pw / 2) / (s * fx(flip)), cy: wy + (py - ph / 2) / s };
}

/** Pan by a pointer move of (dx, dy) CSS px. */
export function panBy(v, dx, dy, flip = false) {
  return { s: v.s, cx: v.cx - dx / (v.s * fx(flip)), cy: v.cy + dy / v.s };
}

/** The world bounds a pw x ph pane shows. */
export function visibleBounds(v, pw, ph) {
  const hw = pw / 2 / v.s;
  const hh = ph / 2 / v.s;
  return { minX: v.cx - hw, maxX: v.cx + hw, minY: v.cy - hh, maxY: v.cy + hh };
}

/** What a view shows, independent of the pane: centre and visible width in mm (kipr's zoom region). */
export function regionOf(v, pw) {
  return { cx: v.cx, cy: v.cy, w: pw / v.s };
}

/** The view that shows region r ({ cx, cy, w }) across a pane pw wide. */
export function viewForRegion(r, pw) {
  return { cx: r.cx, cy: r.cy, s: clampScale(pw / r.w) };
}

/** The view that frames world box b; small boxes get at least `minMm` of context. */
export function viewForBox(b, pw, ph, { minMm = 8, pad = 0.18 } = {}) {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const w = Math.max(b.maxX - b.minX, minMm) / 2;
  const h = Math.max(b.maxY - b.minY, minMm) / 2;
  return fitBounds({ minX: cx - w, maxX: cx + w, minY: cy - h, maxY: cy + h }, pw, ph, pad);
}

/**
 * CSS `matrix()` that places a raster of `rect` (world bounds; row 0 = maxY) drawn at r px/mm,
 * with transform-origin 0 0 and CSS size = its pixel size.
 */
export function rasterMatrix(v, pw, ph, rect, r, flip = false) {
  const a = (v.s * fx(flip)) / r;
  const d = v.s / r;
  const e = pw / 2 + v.s * fx(flip) * (rect.minX - v.cx);
  const f = ph / 2 - v.s * (rect.maxY - v.cy);
  return [a, 0, 0, d, e, f];
}

/** SVG `matrix()` that maps world mm (y up) to pane px: for overlays drawn in mm. */
export function worldMatrix(v, pw, ph, flip = false) {
  const a = v.s * fx(flip);
  return [a, 0, 0, -v.s, pw / 2 - a * v.cx, ph / 2 + v.s * v.cy];
}

/** Render resolution (px per mm) for a screen scale: steps of sqrt(2) so small zooms don't re-render. */
export function stepScale(cssPerMm, dpr = 1, min = 1) {
  const want = Math.max(cssPerMm * dpr, 1e-6);
  return Math.max(min, 2 ** (Math.ceil(Math.log2(want) * 2) / 2));
}

/** The largest px/mm a w x h mm raster may use within an edge and a pixel budget. */
export function budgetScale(wMm, hMm, { maxEdge = 4096, maxPixels = 16e6 } = {}) {
  return Math.min(
    maxEdge / Math.max(wMm, 1e-9),
    maxEdge / Math.max(hMm, 1e-9),
    Math.sqrt(maxPixels / Math.max(wMm * hMm, 1e-12)),
  );
}

/** A rect snapped to whole pixels at r px/mm: { rect, width, height } with the rect's aspect exact. */
export function rasterRect(b, r) {
  const width = Math.max(1, Math.ceil((b.maxX - b.minX) * r - 1e-6));
  const height = Math.max(1, Math.ceil((b.maxY - b.minY) * r - 1e-6));
  return { rect: { minX: b.minX, maxX: b.minX + width / r, minY: b.maxY - height / r, maxY: b.maxY }, width, height };
}

/** Intersection of two bounds, or null when they don't overlap. */
export function intersect(a, b) {
  const out = { minX: Math.max(a.minX, b.minX), maxX: Math.min(a.maxX, b.maxX), minY: Math.max(a.minY, b.minY), maxY: Math.min(a.maxY, b.maxY) };
  return out.minX < out.maxX && out.minY < out.maxY ? out : null;
}

/** `b` grown by `frac` of its size on every side. */
export function grow(b, frac) {
  const { w, h } = boundsSize(b);
  return { minX: b.minX - w * frac, maxX: b.maxX + w * frac, minY: b.minY - h * frac, maxY: b.maxY + h * frac };
}

/** Whether `inner` lies inside `outer` (with `eps` mm slack). */
export function contains(outer, inner, eps = 1e-6) {
  return inner.minX >= outer.minX - eps && inner.maxX <= outer.maxX + eps && inner.minY >= outer.minY - eps && inner.maxY <= outer.maxY + eps;
}
