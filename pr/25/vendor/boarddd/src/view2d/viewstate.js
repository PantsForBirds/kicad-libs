// View state as short strings, so apps can keep mode / zoom / sliders across navigation (URL params,
// history entries, storage). Pure. Ported from kipr web/project/js/viewstate.js.
//
//   z=cx,cy,w   region on show: centre and visible width in mm; absent: fitted
//   mode=side   compare mode
//   sw=0.3      swipe divider (0..1), only in swipe mode
//   op=0.7      onion head opacity (0..1), only in onion mode

/** "cx,cy,w" for a region { cx, cy, w }; null for none (fitted). */
export function formatRegion(r) {
  if (!r || ![r.cx, r.cy, r.w].every(Number.isFinite) || !(r.w > 0)) return null;
  const w = Number(r.w.toPrecision(5));
  const d = w < 5 ? 3 : 2; // small regions need finer centres
  return `${+r.cx.toFixed(d)},${+r.cy.toFixed(d)},${w}`;
}

/** { cx, cy, w } from a z= value, or null when absent / malformed. */
export function parseRegion(v) {
  if (typeof v !== 'string' || !v) return null;
  const n = v.split(',').map(Number);
  if (n.length !== 3 || !n.every(Number.isFinite) || !(n[2] > 0) || n[2] > 1e5) return null;
  return { cx: n[0], cy: n[1], w: n[2] };
}

/** Two regions show the same thing (centre and width within 1% of the width). */
export function sameRegion(a, b) {
  if (!a || !b) return !a && !b;
  const tol = Math.max(a.w, b.w) * 0.01;
  return Math.abs(a.cx - b.cx) <= tol && Math.abs(a.cy - b.cy) <= tol && Math.abs(a.w - b.w) <= tol;
}

/** A 0..1 slider value as a string, or null when `on` is false (that slider is not on show). */
export function formatSlider(v, on = true) {
  if (!on || !Number.isFinite(v)) return null;
  return String(+Math.min(1, Math.max(0, v)).toFixed(3));
}

/** A slider string back to 0..1; absent / malformed: null (keep the current value). */
export function parseSlider(v) {
  const n = typeof v === 'string' && v ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

/**
 * A view state ({ region, mode, opacity, swipe }, as stage.getState() / compare.getState() return)
 * as params; keys with nothing to say are left out.
 */
export function formatViewState(state = {}) {
  const out = {};
  const z = formatRegion(state.region);
  if (z) out.z = z;
  if (typeof state.mode === 'string' && state.mode) out.mode = state.mode;
  const sw = formatSlider(state.swipe, state.mode === 'swipe');
  if (sw !== null) out.sw = sw;
  const op = formatSlider(state.opacity, state.mode === 'onion');
  if (op !== null) out.op = op;
  return out;
}

/** The inverse of formatViewState; takes a plain object or URLSearchParams. Missing keys stay undefined. */
export function parseViewState(params) {
  const get = (k) => (typeof params?.get === 'function' ? params.get(k) ?? undefined : params?.[k]);
  const out = {};
  const region = parseRegion(get('z'));
  out.region = region;
  const mode = get('mode');
  if (typeof mode === 'string' && /^[a-z]{1,16}$/.test(mode)) out.mode = mode;
  const sw = parseSlider(get('sw'));
  if (sw !== null) out.swipe = sw;
  const op = parseSlider(get('op'));
  if (op !== null) out.opacity = op;
  return out;
}
