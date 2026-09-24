// 2D render view: side-by-side / overlay / blink / swipe / diff, synced pan+zoom,
// per-layer stacking for footprints, cursor readout in mm.
//
// All renders of one item share a viewBox (CONTRACT.md), so every image is placed in the
// same "world" box of vbW x vbH mm and a single transform (tx, ty, scale) drives all panes.
// Images are loaded with <img> (never inlined), so SVG content from a PR cannot run script.

import { el, clear, assetUrl, fetchText } from './util.js';

const PX_PER_MM = 20; // world pixels per mm at scale 1

// Stack order bottom -> top. Unknown layers go just below the drill/edge layers.
const LAYER_ORDER = [
  'B.Adhes', 'B.Paste', 'B.Mask', 'B.Cu', 'B.SilkS', 'B.Fab', 'B.CrtYd',
  'In1.Cu', 'In2.Cu', 'F.Adhes', 'F.Cu', 'F.Paste', 'F.Mask', 'F.SilkS', 'F.Fab', 'F.CrtYd',
  'Dwgs.User', 'Cmts.User', 'Eco1.User', 'Eco2.User', 'Margin', '*unknown*', 'Edge.Cuts', 'Drill',
];
const DEFAULT_OFF = /\.(Mask|Paste|Adhes)$/;

export function sortLayers(names) {
  const rank = (n) => {
    const i = LAYER_ORDER.indexOf(n);
    if (i >= 0) return i;
    return LAYER_ORDER.indexOf(n.startsWith('User') || n.endsWith('.User') ? 'Dwgs.User' : '*unknown*') + 0.5;
  };
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// Layer visibility persists across items (a reviewer who hides F.Fab usually wants it hidden everywhere).
const layerState = new Map();
let preferredMode = null;

export function createView2D(item, container) {
  const hasHead = !!item.renders?.head;
  const hasBase = !!item.renders?.base;
  const isFp = item.kind === 'footprint';
  const layerNames = sortLayers(new Set([
    ...Object.keys(item.renders?.head?.layers || {}),
    ...Object.keys(item.renders?.base?.layers || {}),
  ]));
  for (const n of layerNames) if (!layerState.has(n)) layerState.set(n, !DEFAULT_OFF.test(n));

  const modes = [];
  if (hasHead && hasBase) modes.push(['side', 'Side by side'], ['overlay', 'Overlay'], ['blink', 'Blink'], ['swipe', 'Swipe']);
  else if (hasHead) modes.push(['single', 'Head']);
  else if (hasBase) modes.push(['single', 'Base (deleted)']);
  if (item.diff_png) modes.push(['diff', 'Diff']);
  if (!modes.length) {
    container.append(el('div', { class: 'empty' }, 'No 2D renders in the manifest for this item.'));
    return { destroy() {} };
  }
  let mode = modes.some(([m]) => m === preferredMode) ? preferredMode : modes[0][0];

  // --- state
  const view = { tx: 0, ty: 0, s: 1 };
  let vb = null; // {x, y, w, h} in mm, parsed from the first SVG we can fetch
  let opacity = 0.5;
  let blinkShowHead = true;
  let blinkTimer = null;
  let swipe = 0.5;
  let panes = [];

  // --- toolbar
  const modeBar = el('div', { class: 'seg', role: 'tablist', 'aria-label': '2D compare mode' });
  const extra = el('div', { class: 'toolbar-extra' });
  const readout = el('span', { class: 'readout', title: 'Cursor position in footprint/symbol coordinates (mm)' }, '');
  const zoomLbl = el('span', { class: 'readout zoom' }, '');
  const toolbar = el('div', { class: 'toolbar' }, modeBar, extra,
    el('span', { class: 'spacer' }), readout, zoomLbl,
    el('button', { class: 'btn', title: 'Fit to view (double-click also works)', onclick: () => fit() }, 'Fit'));
  const layerBar = el('div', { class: 'layers' });
  const stageWrap = el('div', { class: 'stage-wrap' });
  const legend = el('div', { class: 'legend' });
  container.append(toolbar, layerBar, stageWrap, legend);

  for (const [m, label] of modes) {
    modeBar.append(el('button', {
      class: 'seg-btn', role: 'tab', dataset: { mode: m }, onclick: () => { preferredMode = m; setMode(m); },
    }, label));
  }

  // --- layers
  function renderLayerBar() {
    clear(layerBar);
    if (!isFp || !layerNames.length || mode === 'diff') { layerBar.hidden = true; return; }
    layerBar.hidden = false;
    const quick = (label, pred) => el('button', {
      class: 'btn small', onclick: () => { for (const n of layerNames) layerState.set(n, pred(n)); renderLayerBar(); refreshLayers(); },
    }, label);
    layerBar.append(el('span', { class: 'layers-title' }, 'Layers'),
      quick('All', () => true), quick('Front', (n) => !n.startsWith('B.')), quick('Back', (n) => !n.startsWith('F.')),
      quick('Copper', (n) => /\.Cu$|^Drill$|^Edge\.Cuts$/.test(n)));
    for (const n of layerNames) {
      const id = `ly-${n.replace(/[^A-Za-z0-9]/g, '_')}`;
      const cb = el('input', { type: 'checkbox', id, checked: layerState.get(n) || null });
      cb.addEventListener('change', () => { layerState.set(n, cb.checked); refreshLayers(); });
      layerBar.append(el('label', { class: 'layer-toggle', for: id, dataset: { layer: n } }, cb, el('span', { class: 'swatch', dataset: { layer: n } }), n));
    }
  }

  // --- building image stacks
  /** An absolutely-positioned stack of images for one side covering the world box. */
  function stackFor(side, cls = '') {
    const r = item.renders?.[side];
    const stack = el('div', { class: `stack ${cls}`, dataset: { side } });
    if (!r) return stack;
    const layers = r.layers && Object.keys(r.layers).length ? r.layers : null;
    if (isFp && layers) {
      for (const n of sortLayers(Object.keys(layers))) {
        const img = el('img', { src: layers[n], alt: `${side} ${n}`, draggable: 'false', dataset: { layer: n } });
        img.hidden = !layerState.get(n);
        stack.append(img);
      }
    } else {
      const src = r.svg || r.png;
      if (src) stack.append(el('img', { src, alt: `${side} render`, draggable: 'false' }));
    }
    return stack;
  }

  function refreshLayers() {
    for (const img of stageWrap.querySelectorAll('img[data-layer]')) img.hidden = !layerState.get(img.dataset.layer);
  }

  function pane(label, ...stacks) {
    const world = el('div', { class: 'world' }, ...stacks);
    const p = el('div', { class: `pane ${isFp ? 'board-bg' : 'paper-bg'}` }, world, label ? el('div', { class: 'pane-label' }, label) : null);
    p._world = world;
    return p;
  }

  function missing(text) {
    return el('div', { class: 'stack missing' }, el('div', { class: 'missing-msg' }, text));
  }

  function setMode(m) {
    const relayout = (m === 'side') !== (mode === 'side');
    mode = m;
    stopBlink();
    for (const b of modeBar.children) b.setAttribute('aria-selected', String(b.dataset.mode === m));
    clear(stageWrap); clear(extra); clear(legend);
    panes = [];
    if (m === 'side') {
      panes = [pane('base', hasBase ? stackFor('base') : missing('not in base')), pane('head', hasHead ? stackFor('head') : missing('not in head'))];
      stageWrap.className = 'stage-wrap split';
    } else if (m === 'single') {
      panes = [pane(hasHead ? 'head' : 'base (deleted in this PR)', stackFor(hasHead ? 'head' : 'base'))];
      stageWrap.className = 'stage-wrap';
    } else if (m === 'overlay') {
      const head = stackFor('head', 'top');
      head.style.opacity = opacity;
      panes = [pane('base + head', stackFor('base'), head)];
      const slider = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: opacity, 'aria-label': 'Head opacity' });
      slider.addEventListener('input', () => { opacity = +slider.value; head.style.opacity = opacity; });
      extra.append(el('label', { class: 'slider' }, 'base', slider, 'head'));
      stageWrap.className = 'stage-wrap';
    } else if (m === 'blink') {
      const base = stackFor('base');
      const head = stackFor('head', 'top');
      const label = el('div', { class: 'pane-label' });
      const show = () => { head.hidden = !blinkShowHead; label.textContent = blinkShowHead ? 'head' : 'base'; };
      const p = pane(null, base, head);
      p.append(label);
      panes = [p];
      show();
      const playBtn = el('button', { class: 'btn small' }, 'Pause');
      const tick = () => { blinkShowHead = !blinkShowHead; show(); };
      const start = () => { blinkTimer = setInterval(tick, 700); playBtn.textContent = 'Pause'; };
      playBtn.addEventListener('click', () => { if (blinkTimer) { stopBlink(); playBtn.textContent = 'Play'; } else start(); });
      extra.append(playBtn, el('button', { class: 'btn small', title: 'Step (space)', onclick: () => { stopBlink(); playBtn.textContent = 'Play'; tick(); } }, 'Step'));
      start();
      stageWrap.className = 'stage-wrap';
    } else if (m === 'swipe') {
      const head = stackFor('head', 'top');
      const handle = el('div', { class: 'swipe-handle' });
      const p = pane(null, stackFor('base'), head);
      p.append(el('div', { class: 'pane-label left' }, 'base'), el('div', { class: 'pane-label' }, 'head'), handle);
      panes = [p];
      const apply = () => {
        // clip in pane (screen) space so the divider stays put while panning
        const w = p.clientWidth;
        const cut = swipe * w;
        const worldX = (cut - view.tx) / view.s;
        head.style.clipPath = `inset(0 0 0 ${Math.max(0, worldX)}px)`;
        handle.style.left = `${cut}px`;
      };
      p._afterTransform = apply;
      const slider = el('input', { type: 'range', min: 0, max: 1, step: 0.001, value: swipe, 'aria-label': 'Swipe position' });
      slider.addEventListener('input', () => { swipe = +slider.value; apply(); });
      extra.append(el('label', { class: 'slider' }, 'base', slider, 'head'));
      stageWrap.className = 'stage-wrap';
    } else if (m === 'diff') {
      const under = stackFor(hasHead ? 'head' : 'base');
      under.classList.add('faint');
      const diffStack = el('div', { class: 'stack top' }, el('img', { src: item.diff_png, alt: 'diff', draggable: 'false' }));
      panes = [pane('diff', under, diffStack)];
      legend.append(el('span', { class: 'key removed' }, 'removed (base only)'), el('span', { class: 'key added' }, 'added (head only)'));
      stageWrap.className = 'stage-wrap';
    }
    stageWrap.append(...panes);
    renderLayerBar();
    for (const p of panes) attachInteraction(p);
    sizeWorlds();
    // pane size changes between split and single layouts: refit instead of keeping a transform made for the other size
    if (!fitted || relayout) fit(); else applyTransform();
  }

  function stopBlink() { if (blinkTimer) clearInterval(blinkTimer); blinkTimer = null; }

  // --- geometry
  function worldSize() {
    if (vb) return { w: vb.w * PX_PER_MM, h: vb.h * PX_PER_MM };
    const img = stageWrap.querySelector('img');
    return { w: img?.naturalWidth || 400, h: img?.naturalHeight || 300 };
  }

  function sizeWorlds() {
    const { w, h } = worldSize();
    for (const p of panes) {
      p._world.style.width = `${w}px`;
      p._world.style.height = `${h}px`;
    }
  }

  let fitted = false;
  function fit() {
    const p = panes[0];
    if (!p) return;
    const { w, h } = worldSize();
    const pw = p.clientWidth || 400;
    const ph = p.clientHeight || 300;
    view.s = Math.min(pw / w, ph / h) * 0.92;
    view.tx = (pw - w * view.s) / 2;
    view.ty = (ph - h * view.s) / 2;
    fitted = true;
    applyTransform();
  }

  function applyTransform() {
    for (const p of panes) {
      p._world.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`;
      p._afterTransform?.();
    }
    zoomLbl.textContent = vb ? `${(view.s * PX_PER_MM).toFixed(1)} px/mm` : `${Math.round(view.s * 100)}%`;
  }

  function zoomAt(px, py, factor) {
    const s = Math.min(Math.max(view.s * factor, 0.02), 400);
    const f = s / view.s;
    view.tx = px - (px - view.tx) * f;
    view.ty = py - (py - view.ty) * f;
    view.s = s;
    applyTransform();
  }

  function toMm(p, clientX, clientY) {
    if (!vb) return null;
    const r = p.getBoundingClientRect();
    const wx = (clientX - r.left - view.tx) / view.s;
    const wy = (clientY - r.top - view.ty) / view.s;
    return { x: vb.x + wx / PX_PER_MM, y: vb.y + wy / PX_PER_MM };
  }

  // --- interaction (wheel zoom, drag pan, pinch, double-click fit)
  function attachInteraction(p) {
    const pointers = new Map();
    let pinchDist = 0;
    p.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = p.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015)));
    }, { passive: false });
    p.addEventListener('pointerdown', (e) => {
      p.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      p.classList.add('grabbing');
    });
    p.addEventListener('pointermove', (e) => {
      const mm = toMm(p, e.clientX, e.clientY);
      readout.textContent = mm ? `x ${mm.x.toFixed(3)}  y ${mm.y.toFixed(3)} mm` : '';
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      if (pointers.size === 1) {
        view.tx += e.clientX - prev.x;
        view.ty += e.clientY - prev.y;
        applyTransform();
      } else if (pointers.size === 2) {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist) {
          const r = p.getBoundingClientRect();
          zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, d / pinchDist);
        }
        pinchDist = d;
        return;
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    const up = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (!pointers.size) p.classList.remove('grabbing');
    };
    p.addEventListener('pointerup', up);
    p.addEventListener('pointercancel', up);
    p.addEventListener('pointerleave', () => { readout.textContent = ''; });
    p.addEventListener('dblclick', () => fit());
  }

  const onKey = (e) => {
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'f') fit();
    if (e.key === ' ' && mode === 'blink') { e.preventDefault(); blinkShowHead = !blinkShowHead; setMode('blink'); }
    const idx = modes.findIndex(([mm]) => mm === mode);
    if (e.key === 'm') setMode(modes[(idx + 1) % modes.length][0]);
  };
  document.addEventListener('keydown', onKey);
  const ro = new ResizeObserver(() => { if (fitted) applyTransform(); });
  ro.observe(stageWrap);

  // --- viewBox: every SVG of an item shares it, so the first one we can read is enough
  const svgSrc = item.renders?.head?.svg || item.renders?.base?.svg
    || Object.values(item.renders?.head?.layers || item.renders?.base?.layers || {})[0];
  setMode(mode);
  const mv = item.view?.viewbox;
  if (Array.isArray(mv) && mv.length === 4 && mv.every(Number.isFinite) && mv[2] > mv[0] && mv[3] > mv[1]) {
    // render worker states the shared frame explicitly: [xmin, ymin, xmax, ymax] in mm
    vb = { x: mv[0], y: mv[1], w: mv[2] - mv[0], h: mv[3] - mv[1] };
    sizeWorlds();
    fit();
  } else if (svgSrc && assetUrl(svgSrc)) {
    fetchText(svgSrc).then((txt) => {
      const m = txt.match(/viewBox\s*=\s*["']\s*(-?[\d.eE+-]+)[\s,]+(-?[\d.eE+-]+)[\s,]+([\d.eE+-]+)[\s,]+([\d.eE+-]+)/);
      if (m) {
        vb = { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
        sizeWorlds();
        fit();
      }
    }).catch(() => {});
  } else {
    // PNG only: size from the image once it has loaded
    stageWrap.querySelector('img')?.addEventListener('load', () => { sizeWorlds(); fit(); }, { once: true });
  }

  return {
    destroy() {
      stopBlink();
      document.removeEventListener('keydown', onKey);
      ro.disconnect();
    },
  };
}
