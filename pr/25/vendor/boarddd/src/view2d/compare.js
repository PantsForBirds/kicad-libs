// Base / head compare modes on a stage: side by side (two panes, one view), diff, onion skin, swipe,
// base only, head only. Generic over the content (faces, layer stacks, single layers, SVG sheets).
// Sliders and mode buttons are the app's; this keeps the values and draws the swipe divider.
// Ported from kipr web/project/js/compare.js and layout.js (diff with a faint board underlay).

import { diff as diffContent, inkdiff as inkdiffContent } from './content.js';
import { svgEl } from './stage.js';

export const COMPARE_MODES = Object.freeze(['side', 'diff', 'onion', 'swipe', 'base', 'head']);

const asList = (c) => (Array.isArray(c) ? c.filter(Boolean) : c ? [c] : []);
const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

/**
 * The diff of base and head when the app did not give one: layer stacks diff their sources on the
 * GPU, images get an ink diff. null when there is nothing to diff.
 */
export function defaultDiff(base, head) {
  const b = asList(base);
  const h = asList(head);
  const all = [...b, ...h];
  if (!all.length) return null;
  if (all.every((c) => c.type === 'layers')) {
    const sources = (list) => list.flatMap((c) => c.layers.filter((l) => l && l.visible !== false && l.source != null).map((l) => ({ source: l.source, name: l.name })));
    return diffContent(sources(b), sources(h));
  }
  if (all.every((c) => c.type === 'image') && b.length <= 1 && h.length <= 1) {
    const rect = (b[0] || h[0]).rect;
    return inkdiffContent(b[0]?.src ?? null, h[0]?.src ?? null, rect);
  }
  return null;
}

export function createCompare(stage, options = {}) {
  const labels = { base: 'base', head: 'head', diff: 'diff', ...options.labels };
  const missing = options.missing || ((side) => `not in ${labels[side]}`);
  let base = options.base ?? null;
  let head = options.head ?? null;
  let diff = options.diff === undefined ? defaultDiff(base, head) : options.diff;
  let underlay = options.underlay ?? null;
  let mode = COMPARE_MODES.includes(options.mode) ? options.mode : 'side';
  let opacity = clamp01(options.opacity ?? 0.5);
  let swipe = clamp01(options.swipe ?? 0.5);
  const handleOn = options.handle !== false;
  const onChange = options.onChange || null;
  let handle = null;

  const layersOf = (list, extra = {}) => asList(list).map((content) => ({ content, ...extra }));

  function available() {
    const out = [];
    const hb = asList(base).length > 0;
    const hh = asList(head).length > 0;
    if (hb || hh) out.push('side', 'onion', 'swipe');
    if (diff) out.push('diff');
    if (hb) out.push('base');
    if (hh) out.push('head');
    return COMPARE_MODES.filter((m) => out.includes(m));
  }

  function scene() {
    const b = asList(base);
    const h = asList(head);
    switch (mode) {
      case 'side':
        return [
          { label: labels.base, side: 'base', layers: layersOf(b), missing: b.length ? null : missing('base') },
          { label: labels.head, side: 'head', layers: layersOf(h), missing: h.length ? null : missing('head') },
        ];
      case 'diff':
        return [{ label: labels.diff, side: 'diff', layers: [...layersOf(underlay, { opacity: 0.35, className: 'bd2-underlay' }), ...layersOf(diff)], missing: diff ? null : 'no diff' }];
      case 'onion':
        return [{ label: `${labels.base} + ${labels.head}`, side: 'onion', layers: [...layersOf(b), ...layersOf(h, { opacity })] }];
      case 'swipe':
        return [{ label: labels.base, labelRight: labels.head, side: 'swipe', layers: [...layersOf(b), ...layersOf(h, { clip: { x0: swipe, x1: 1 } })] }];
      default: {
        const list = mode === 'base' ? b : h;
        return [{ label: labels[mode], side: mode, layers: layersOf(list), missing: list.length ? null : missing(mode) }];
      }
    }
  }

  function show() {
    handle?.remove();
    handle = null;
    stage.setScene(scene());
    if (mode === 'swipe' && handleOn) addHandle();
  }

  function headSlots() {
    const n = asList(base).length;
    return asList(head).map((_, i) => n + i);
  }

  function addHandle() {
    const pane = stage.panes[0]?.el;
    if (!pane) return;
    handle = document.createElement('div');
    handle.className = 'bd2-swipe';
    handle.dataset.bd2Handle = '';
    Object.assign(handle.style, { position: 'absolute', top: '0', bottom: '0', width: '14px', marginLeft: '-7px', cursor: 'ew-resize', touchAction: 'none', zIndex: '2' });
    const line = svgEl('svg', { width: 14, height: '100%' }, handle);
    line.style.display = 'block';
    line.style.height = '100%';
    svgEl('line', { x1: 7, x2: 7, y1: 0, y2: '100%', stroke: '#fff', 'stroke-width': 2 }, line);
    pane.append(handle);
    placeHandle();
    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      handle.setPointerCapture?.(e.pointerId);
      const move = (ev) => {
        const r = pane.getBoundingClientRect();
        setSwipe((ev.clientX - r.left) / Math.max(r.width, 1));
        onChange?.(api.getState());
      };
      const h = handle;
      const stop = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', stop); h.removeEventListener('pointercancel', stop); };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', stop);
      h.addEventListener('pointercancel', stop);
    });
  }

  function placeHandle() {
    if (handle) handle.style.left = `${(swipe * 100).toFixed(3)}%`;
  }

  function setOpacity(v) {
    opacity = clamp01(v);
    if (mode === 'onion') for (const i of headSlots()) stage.setLayer(0, i, { opacity });
  }

  function setSwipe(v) {
    swipe = clamp01(v);
    if (mode === 'swipe') for (const i of headSlots()) stage.setLayer(0, i, { clip: { x0: swipe, x1: 1 } });
    placeHandle();
  }

  const api = {
    get mode() { return mode; },
    get opacity() { return opacity; },
    get swipe() { return swipe; },
    /** The modes that make sense for the current content (diff needs a diff, base / head their side). */
    get modes() { return available(); },
    setMode(m) {
      if (!COMPARE_MODES.includes(m)) throw new RangeError(`view2d: unknown compare mode ${m}`);
      mode = m;
      show();
    },
    setOpacity,
    setSwipe,
    /** New content; omitted keys stay. A diff left undefined is derived again from base / head. */
    set(next = {}) {
      if ('base' in next) base = next.base;
      if ('head' in next) head = next.head;
      if ('underlay' in next) underlay = next.underlay;
      if ('diff' in next) diff = next.diff === undefined ? defaultDiff(base, head) : next.diff;
      else if ('base' in next || 'head' in next) diff = defaultDiff(base, head);
      show();
    },
    getState() { return { mode, opacity, swipe, ...stage.getState() }; },
    /** Apply a state (getState(), or parseViewState()); keys it does not name stay. */
    setState(s = {}) {
      if (s.opacity !== undefined) opacity = clamp01(s.opacity);
      if (s.swipe !== undefined) swipe = clamp01(s.swipe);
      if (s.mode && COMPARE_MODES.includes(s.mode) && s.mode !== mode) { mode = s.mode; show(); } else { setOpacity(opacity); setSwipe(swipe); }
      const { mode: _m, opacity: _o, swipe: _s, ...rest } = s;
      stage.setState(rest);
    },
    destroy() { handle?.remove(); handle = null; },
  };
  show();
  return api;
}
