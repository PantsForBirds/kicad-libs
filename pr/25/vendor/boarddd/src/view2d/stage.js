// createStage: the shared 2D board stage. One view (pan / zoom over world mm, y up, optional x
// mirror for the underside) shown in one or more panes (side by side panes stay in sync by
// construction). Each pane stacks content layers (content.js) and an SVG overlay for app markers.
//
// Ported from kipr web/project/js/panzoom.js (synced panes, wheel / drag / pinch, measure, resize
// keeps the centre), kipr web/project/js/layout.js (re-render sharper on zoom in sqrt(2) steps),
// gentoo fab/static/fab/guide/stage.js (toScreen / toMm for overlays, one frame at a time, click vs
// drag, hover) and gentoo fab/static/fab/viewer.js (CSS transform on drawn pixels, pixel budget).
//
// Render on demand: a pan or zoom only moves already-drawn tiles (CSS transforms, one rAF); content
// is rasterised again only after the view settles, and only when the resolution on show is off by
// more than ~15 % (a whole-bounds tile within the pixel budget, plus a detail tile of the visible
// area when zoomed in past it). Nothing runs while the view is still.

import {
  budgetScale, contains, fitBounds, grow, intersect, panBy, rasterMatrix, rasterRect, regionOf, stepScale,
  toScreen, toWorld, viewForBox, viewForRegion, visibleBounds, worldMatrix, zoomAt, MIN_SCALE, MAX_SCALE,
} from './math.js';
import { contentRect, renderContent } from './content.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CLICK_SLOP_PX = 4;

export const STAGE_CSS = `
.bd2-stage{position:relative;display:flex;gap:2px;width:100%;height:100%;overflow:hidden}
.bd2-pane{position:relative;flex:1 1 0;min-width:0;overflow:hidden;touch-action:none;user-select:none;cursor:grab}
.bd2-pane.bd2-grabbing{cursor:grabbing}
.bd2-pane.bd2-measuring{cursor:crosshair}
.bd2-stage.bd2-static,.bd2-pane.bd2-static{pointer-events:none;cursor:auto}
.bd2-slot{position:absolute;inset:0;pointer-events:none}
.bd2-slot canvas{position:absolute;left:0;top:0;transform-origin:0 0}
.bd2-overlay{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
.bd2-world *{vector-effect:non-scaling-stroke}
.bd2-label{position:absolute;top:6px;left:6px;padding:1px 6px;border-radius:3px;font:12px system-ui,sans-serif;background:rgba(0,0,0,.55);color:#fff;pointer-events:none}
.bd2-label.bd2-right{left:auto;right:6px}
.bd2-missing{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:13px system-ui,sans-serif;color:#888;pointer-events:none}
.bd2-measure line{stroke:#ffd23f;stroke-width:1.5}
.bd2-measure circle{fill:none;stroke:#ffd23f;stroke-width:1.5}
.bd2-measure text{fill:#ffd23f;font:12px system-ui,sans-serif;paint-order:stroke;stroke:#000;stroke-width:3px}
`;

function el(tag, cls, parent) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.append(n);
  return n;
}

export function svgEl(tag, attrs = {}, parent = null) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, String(v));
  if (parent) parent.append(n);
  return n;
}

const matrixCss = (m) => `matrix(${m.map((v) => +v.toFixed(6)).join(',')})`;

/** Pointer distance text, mm to 3 decimals. */
export function measureText(m) {
  return m ? `Δx ${m.dx.toFixed(3)}  Δy ${m.dy.toFixed(3)}  d ${m.distance.toFixed(3)} mm` : '';
}

export function createStage(container, options = {}) {
  const opt = {
    padding: 0.02, paddingPx: 0, interactive: true, pixelSnap: false, settleMs: 180, maxEdge: 4096, maxPixels: 16e6, minScale: MIN_SCALE, maxScale: MAX_SCALE,
    background: null, measureLabel: true, injectCss: true, ...options,
  };
  let bounds = opt.bounds || null;
  let flip = !!opt.flip;
  let view = { cx: 0, cy: 0, s: 1 };
  let autoFit = true; // still the fitted view: refit when the panes resize
  let pendingRegion = opt.region || null; // a region asked for before any pane had a size
  let tool = 'pan';
  let measure = [];
  let destroyed = false;
  let panes = [];
  const overlays = new Set();
  const listeners = new Map();
  const stats = { frames: 0, renders: 0, pixels: 0 };
  let rendererPromise = null;

  const root = el('div', `bd2-stage${opt.interactive ? '' : ' bd2-static'}`, container);
  if (opt.injectCss) el('style', null, root).textContent = STAGE_CSS; // off under a strict CSP: ship STAGE_CSS in a stylesheet

  function emit(name, payload) {
    const set = listeners.get(name);
    if (name === 'error' && !set?.size) console.warn('view2d:', payload?.error || payload);
    for (const fn of set || []) fn(payload);
  }

  function getRenderer() {
    if (!rendererPromise) {
      const r = opt.renderer;
      if (!r) return Promise.reject(new Error('view2d: gerber content needs a renderer (createStage({ renderer }))'));
      rendererPromise = Promise.resolve(typeof r === 'function' ? r() : r);
      rendererPromise.catch(() => { rendererPromise = null; });
    }
    return rendererPromise;
  }

  const dpr = () => opt.dpr || Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
  const size = (p = panes[0]) => ({ pw: p?.el.clientWidth || 600, ph: p?.el.clientHeight || 400 });

  // --- scene
  function makeSlot(pane, spec, old) {
    const content = spec?.content ?? null;
    const reuse = content && old.find((s) => s.content === content && !s.taken);
    const slot = reuse || { content, base: null, detail: null, info: null, gen: 0 };
    if (reuse) reuse.taken = true;
    slot.el = el('div', `bd2-slot${spec?.className ? ` ${spec.className}` : ''}`, pane.layersEl);
    for (const t of [slot.base, slot.detail]) if (t) slot.el.append(t.canvas);
    slot.opacity = spec?.opacity ?? 1;
    slot.clip = spec?.clip ?? null;
    styleSlot(slot);
    return slot;
  }

  function styleSlot(slot) {
    slot.el.style.opacity = slot.opacity === 1 ? '' : String(slot.opacity);
    const c = slot.clip;
    slot.el.style.clipPath = c ? `inset(0 ${((1 - (c.x1 ?? 1)) * 100).toFixed(3)}% 0 ${((c.x0 ?? 0) * 100).toFixed(3)}%)` : '';
  }

  /**
   * Show panes: [{ label?, labelRight?, side?, missing?, layers: [{ content, opacity?, clip?: { x0, x1 }, className? }] }].
   * Tiles of content objects already on show are kept (pass the same object to avoid a re-render).
   */
  function setScene(specs) {
    const old = panes.flatMap((p) => p.slots);
    for (const p of panes) p.el.remove();
    panes = specs.map((spec, index) => {
      const pane = { index, spec, side: spec.side ?? null, el: el('div', `bd2-pane${opt.interactive ? '' : ' bd2-static'}${spec.className ? ` ${spec.className}` : ''}`, root) };
      if (spec.side) pane.el.dataset.side = spec.side;
      if (opt.background) pane.el.style.background = opt.background;
      if (tool === 'measure') pane.el.classList.add('bd2-measuring');
      pane.layersEl = el('div', 'bd2-layers', pane.el);
      if (spec.missing) el('div', 'bd2-missing', pane.el).textContent = spec.missing;
      pane.slots = (spec.layers || []).filter((l) => l && l.content).map((l) => makeSlot(pane, l, old));
      pane.svg = svgEl('svg', { class: 'bd2-overlay' }, pane.el);
      pane.worldG = svgEl('g', { class: 'bd2-world' }, pane.svg);
      pane.screenG = svgEl('g', { class: 'bd2-screen' }, pane.svg);
      pane.measureG = svgEl('g', { class: 'bd2-measure' }, pane.svg);
      pane.groups = new Map();
      if (spec.label) el('div', 'bd2-label', pane.el).textContent = spec.label;
      if (spec.labelRight) el('div', 'bd2-label bd2-right', pane.el).textContent = spec.labelRight;
      attach(pane);
      return pane;
    });
    for (const s of old) {
      if (!s.taken) { s.dead = true; s.base = null; s.detail = null; }
      delete s.taken;
    }
    for (const o of overlays) o.dirty = true;
    if (pendingRegion && panes.length) { view = viewForRegion(pendingRegion, size().pw); autoFit = false; pendingRegion = null; }
    if (autoFit) fitNow(); else requestFrame();
    settle(0);
  }

  /** Change one layer's opacity / clip without re-rendering (onion, swipe). */
  function setLayer(paneIndex, layerIndex, { opacity, clip } = {}) {
    const slot = panes[paneIndex]?.slots[layerIndex];
    if (!slot) return;
    if (opacity !== undefined) slot.opacity = opacity;
    if (clip !== undefined) slot.clip = clip;
    styleSlot(slot);
  }

  // --- view
  function fitNow() {
    if (!bounds) return;
    const { pw, ph } = size();
    view = fitBounds(bounds, pw, ph, opt.padding, opt.paddingPx);
    autoFit = true;
    requestFrame();
  }

  function setViewNow(v, auto = false) {
    view = { cx: v.cx, cy: v.cy, s: Math.min(Math.max(v.s, opt.minScale), opt.maxScale) };
    autoFit = auto;
    requestFrame();
    settle();
  }

  let rafId = 0;
  function requestFrame() {
    if (rafId || destroyed) return;
    rafId = requestAnimationFrame(() => { rafId = 0; frame(); });
  }

  function paneCtx(pane) {
    const { pw, ph } = size(pane);
    return {
      pane: pane.index, side: pane.side, label: pane.spec.label ?? null, width: pw, height: ph, view: { ...view }, flip,
      toScreen: (x, y) => toScreen(view, pw, ph, x, y, flip),
      toWorld: (px, py) => toWorld(view, pw, ph, px, py, flip),
      mmPerPx: () => 1 / view.s,
      svg: svgEl,
    };
  }

  function frame() {
    if (destroyed) return;
    stats.frames++;
    for (const pane of panes) {
      const { pw, ph } = size(pane);
      for (const slot of pane.slots) {
        for (const t of [slot.base, slot.detail]) if (t) t.canvas.style.transform = matrixCss(rasterMatrix(view, pw, ph, t.rect, t.r, flip));
      }
      pane.worldG.setAttribute('transform', `matrix(${worldMatrix(view, pw, ph, flip).map((v) => +v.toFixed(6)).join(' ')})`);
      const ctx = paneCtx(pane);
      for (const o of overlays) {
        let g = pane.groups.get(o);
        if (!g) {
          g = svgEl('g', o.className ? { class: o.className } : {}, o.space === 'world' ? pane.worldG : pane.screenG);
          pane.groups.set(o, g);
          o.dirty = true;
        }
        if (o.space === 'world' && !o.dirty) continue;
        g.replaceChildren();
        o.draw(g, ctx);
      }
      drawMeasure(pane, ctx);
    }
    for (const o of overlays) o.dirty = false;
    emit('view', { view: { ...view }, region: getRegion(), flip });
  }

  // --- tiles
  let settleTimer = null;
  let work = Promise.resolve();
  let busy = 0;
  const idleWaiters = [];

  let busyShown = false;
  let jobsLeft = 0; // tiles still to render in the current pass

  function settle(ms = opt.settleMs) {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { settleTimer = null; resharpen(); }, ms);
    updateBusy();
  }

  // 'busy': a re-render is scheduled or running (a pan that needs none is not busy)
  function updateBusy() {
    const now = jobsLeft > 0 || (!!settleTimer && !destroyed && plan().length > 0);
    if (now !== busyShown) { busyShown = now; emit('busy', { busy: now }); }
  }

  function checkIdle() {
    updateBusy();
    if (!busy && !settleTimer) for (const fn of idleWaiters.splice(0)) fn();
  }

  function resharpen() {
    busy++;
    work = work.then(sharpenNow).catch((e) => emit('error', { error: e })).finally(() => { busy--; checkIdle(); });
  }

  /*
   * pixelSnap: a tile drawn at the screen's own resolution starts on a device pixel, so at rest
   * every tile pixel is one screen pixel (no resampling: the picture is what the renderer drew).
   * The rect grows outwards to the grid; mirrored, its left edge is its maxX side on screen.
   */
  function snapRect(b, pw, ph) {
    const d = dpr();
    const { s, cx, cy } = view;
    const minX = flip
      ? cx - (Math.ceil((pw / 2 - s * (b.minX - cx)) * d - 1e-6) / d - pw / 2) / s
      : cx + (Math.floor((pw / 2 + s * (b.minX - cx)) * d + 1e-6) / d - pw / 2) / s;
    const maxY = cy + (ph / 2 - Math.floor((ph / 2 - s * (b.maxY - cy)) * d + 1e-6) / d) / s;
    return { minX, maxX: b.maxX, minY: b.minY, maxY };
  }

  const atScreenRes = (r) => Math.abs(r / (view.s * dpr()) - 1) < 1e-9;

  /** Whether a tile drawn at screen resolution still sits on the device pixel grid. */
  function onGrid(tile, pw, ph) {
    const d = dpr();
    const [, , , , e, f] = rasterMatrix(view, pw, ph, tile.rect, tile.r, flip);
    const off = (v) => Math.abs(v * d - Math.round(v * d));
    return off(e) < 1e-3 && off(f) < 1e-3;
  }

  /** The resolution a view wants: sqrt(2) steps, or with pixelSnap the screen's own. */
  // render resolution for the view on show; minRender: a floor (px/mm), still within the tile budget
  const wantScale = () => Math.max(opt.minRender || 0, opt.pixelSnap ? view.s * dpr() : stepScale(view.s, dpr()));

  async function renderTile(slot, b, r, paneIndex, layerIndex, kind) {
    const gen = slot.gen;
    const { pw, ph } = size(panes[paneIndex]);
    const { rect, width, height } = rasterRect(opt.pixelSnap && atScreenRes(r) ? snapRect(b, pw, ph) : b, r);
    const job = { rect, width, height, r };
    let out;
    try {
      out = await renderContent(slot.content, job, getRenderer);
    } catch (error) {
      emit('error', { error, pane: paneIndex, layer: layerIndex, content: slot.content });
      slot.failed = true;
      return;
    }
    stats.renders++;
    stats.pixels += width * height;
    if (destroyed || slot.dead || gen !== slot.gen) return;
    const tile = { canvas: out.canvas, rect, r };
    out.canvas.style.width = `${width}px`;
    out.canvas.style.height = `${height}px`;
    if (kind === 'base') {
      slot.base?.canvas.remove();
      slot.base = tile;
      slot.el.prepend(tile.canvas);
      slot.info = out.info;
    } else {
      slot.detail?.canvas.remove();
      slot.detail = tile;
      slot.el.append(tile.canvas);
    }
    requestFrame();
    if (kind === 'base') emit('render', { pane: paneIndex, layer: layerIndex, content: slot.content, info: out.info, r });
  }

  const offBy = (have, want) => have < want * 0.87 || have > want * 2.5;

  /** The tiles the view on show needs: [{ slot, area, r, pane, layer, kind }] (base or detail). */
  function plan() {
    const jobs = [];
    const want = wantScale();
    for (const pane of panes) {
      const { pw, ph } = size(pane);
      const visible = visibleBounds(view, pw, ph);
      // a tile at screen resolution that a fractional pan or a flip moved off the pixel grid
      const offGrid = (t) => opt.pixelSnap && atScreenRes(t.r) && !onGrid(t, pw, ph);
      for (const [li, slot] of pane.slots.entries()) {
        if (slot.dead || slot.failed) continue;
        const area = contentRect(slot.content) || bounds;
        if (!area) continue;
        const rmax = budgetScale(area.maxX - area.minX, area.maxY - area.minY, opt);
        const baseR = Math.min(want, rmax);
        if (!slot.base || offBy(slot.base.r, baseR) || offGrid(slot.base)) jobs.push({ slot, area, r: baseR, pane: pane.index, layer: li, kind: 'base' });
        if (want <= rmax * 1.15) continue;
        const now = intersect(visible, area);
        const zone = intersect(grow(visible, 0.25), area);
        if (!now || !zone) continue;
        const detailR = Math.min(want, budgetScale(zone.maxX - zone.minX, zone.maxY - zone.minY, opt));
        if (!slot.detail || !contains(slot.detail.rect, now) || offBy(slot.detail.r, detailR) || offGrid(slot.detail)) jobs.push({ slot, area: zone, r: detailR, pane: pane.index, layer: li, kind: 'detail' });
      }
    }
    return jobs;
  }

  async function sharpenNow() {
    if (destroyed) return;
    const jobs = plan();
    jobsLeft = jobs.length;
    updateBusy();
    try {
      for (const j of jobs) { await renderTile(j.slot, j.area, j.r, j.pane, j.layer, j.kind); jobsLeft--; }
    } finally {
      jobsLeft = 0;
    }
    // zoomed back out within the whole-bounds budget: the detail tiles go
    const want = wantScale();
    for (const pane of panes) {
      for (const slot of pane.slots) {
        const area = contentRect(slot.content) || bounds;
        if (!slot.detail || !area) continue;
        if (want <= budgetScale(area.maxX - area.minX, area.maxY - area.minY, opt) * 1.15) {
          slot.detail.canvas.remove();
          slot.detail = null;
        }
      }
    }
  }

  // --- measure
  function measureResult() {
    if (measure.length < 2) return null;
    const [a, b] = measure;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return { a, b, dx, dy, distance: Math.hypot(dx, dy) };
  }

  function drawMeasure(pane, ctx) {
    const g = pane.measureG;
    g.replaceChildren();
    if (!measure.length) return;
    const pts = measure.map((p) => ctx.toScreen(p.x, p.y));
    if (pts[1]) svgEl('line', { x1: pts[0][0], y1: pts[0][1], x2: pts[1][0], y2: pts[1][1] }, g);
    for (const [x, y] of pts) svgEl('circle', { cx: x, cy: y, r: 4 }, g);
    const m = measureResult();
    if (m && opt.measureLabel) {
      const t = svgEl('text', { x: (pts[0][0] + pts[1][0]) / 2 + 8, y: (pts[0][1] + pts[1][1]) / 2 - 8 }, g);
      t.textContent = `${m.distance.toFixed(3)} mm`;
    }
  }

  function setMeasure(points = []) {
    measure = points.slice(0, 2).map((p) => ({ x: p.x, y: p.y }));
    requestFrame();
    emit('measure', { points: measure.slice(), result: measureResult() });
  }

  function setTool(t) {
    tool = t === 'measure' ? 'measure' : 'pan';
    for (const p of panes) p.el.classList.toggle('bd2-measuring', tool === 'measure');
    if (tool !== 'measure') setMeasure([]);
  }

  // --- pointer: drag pans, wheel / pinch zoom, a press that did not move is a click, dblclick fits
  function attach(pane) {
    if (!opt.interactive) return; // a picture: pointer events go to what is under the stage
    const p = pane.el;
    const pointers = new Map();
    let pinch = 0;
    let moved = 0;
    const local = (e) => {
      const r = p.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const at = (e) => {
      const [px, py] = local(e);
      const { pw, ph } = size(pane);
      const [x, y] = toWorld(view, pw, ph, px, py, flip);
      return { x, y, px, py, pane: pane.index, side: pane.side, event: e };
    };
    p.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [px, py] = local(e);
      const { pw, ph } = size(pane);
      setViewNow(zoomAt(view, pw, ph, px, py, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015)), flip, opt.minScale, opt.maxScale));
    }, { passive: false });
    p.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      if (e.target.closest?.('[data-bd2-handle]')) return;
      p.setPointerCapture?.(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = 0;
      p.classList.add('bd2-grabbing');
    });
    p.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) { emit('move', at(e)); return; }
      if (pointers.size === 1) {
        const dx = e.clientX - prev.x;
        const dy = e.clientY - prev.y;
        moved += Math.abs(dx) + Math.abs(dy);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (dx || dy) setViewNow(panBy(view, dx, dy, flip));
        return;
      }
      moved += 10;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) {
        const r = p.getBoundingClientRect();
        const { pw, ph } = size(pane);
        setViewNow(zoomAt(view, pw, ph, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, d / pinch, flip, opt.minScale, opt.maxScale));
      }
      pinch = d;
    });
    const up = (e) => {
      const click = pointers.has(e.pointerId) && pointers.size === 1 && moved < CLICK_SLOP_PX && e.type === 'pointerup';
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      if (!pointers.size) p.classList.remove('bd2-grabbing');
      if (!click) return;
      const hit = at(e);
      if (tool === 'measure') setMeasure(measure.length >= 2 ? [hit] : [...measure, hit]);
      emit('click', hit);
    };
    p.addEventListener('pointerup', up);
    p.addEventListener('pointercancel', up);
    p.addEventListener('pointerleave', () => emit('leave', { pane: pane.index }));
    p.addEventListener('dblclick', () => { if (tool === 'pan') { fitNow(); settle(); } });
  }

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
    if (autoFit) fitNow(); else requestFrame();
    settle();
  }) : null;
  ro?.observe(root);

  // --- public
  function getRegion() {
    if (pendingRegion) return { ...pendingRegion };
    return autoFit ? null : regionOf(view, size().pw);
  }

  const api = {
    root,
    get panes() { return panes.map((p) => ({ el: p.el, index: p.index, side: p.side, label: p.spec.label ?? null })); },
    get flip() { return flip; },
    get bounds() { return bounds; },
    get tool() { return tool; },
    setScene,
    setLayer,
    /** World bounds to fit and to rasterise content over; keeps the view unless it is the fitted one. */
    setBounds(b) {
      bounds = b;
      for (const p of panes) for (const s of p.slots) { s.gen++; s.failed = false; s.base?.canvas.remove(); s.detail?.canvas.remove(); s.base = s.detail = null; }
      if (autoFit) fitNow(); else requestFrame();
      settle(0);
    },
    /** Mirror x (the underside seen from below); the region on show stays on show. */
    setFlip(f) {
      flip = !!f;
      requestFrame();
      for (const o of overlays) o.dirty = true;
      if (opt.pixelSnap) settle();
    },
    fit() { fitNow(); settle(); },
    /** Zoom to a world box; small boxes get at least `minMm` of context. */
    zoomTo(b, o) { const { pw, ph } = size(); setViewNow(viewForBox(b, pw, ph, o)); },
    getView() { return { ...view }; },
    setView(v) { setViewNow(v); },
    /** The region on show ({ cx, cy, w } mm), or null while it is the fitted view. */
    getRegion,
    setRegion(r) {
      if (!panes.length) { pendingRegion = r; return; }
      if (!r) { fitNow(); settle(); } else setViewNow(viewForRegion(r, size().pw));
    },
    getState() { return { region: getRegion(), flip, tool, measure: measure.slice() }; },
    setState(s = {}) {
      if (s.flip !== undefined) api.setFlip(s.flip);
      if (s.tool !== undefined) setTool(s.tool);
      if (s.measure !== undefined) setMeasure(s.measure);
      if (s.region !== undefined) api.setRegion(s.region);
    },
    toScreen(x, y, pane = 0) { const { pw, ph } = size(panes[pane]); return toScreen(view, pw, ph, x, y, flip); },
    toWorld(px, py, pane = 0) { const { pw, ph } = size(panes[pane]); return toWorld(view, pw, ph, px, py, flip); },
    /** World mm per CSS pixel: hit-test slack is a few of these. */
    mmPerPx() { return 1 / view.s; },
    setTool,
    getMeasure: measureResult,
    setMeasure,
    /**
     * An overlay drawn in every pane: draw(g, ctx) fills an SVG <g>. space 'world': g is in mm (y up),
     * drawn once and moved with the view (strokes keep their width); 'screen': g is in pane px,
     * redrawn on every view change (constant-size markers, text). Returns { invalidate, remove }.
     */
    addOverlay({ space = 'world', draw, className = '' }) {
      const o = { space: space === 'screen' ? 'screen' : 'world', draw, className, dirty: true };
      overlays.add(o);
      requestFrame();
      return {
        invalidate() { o.dirty = true; requestFrame(); },
        remove() { overlays.delete(o); for (const p of panes) { p.groups.get(o)?.remove(); p.groups.delete(o); } },
      };
    },
    /** Events: view, click, move, leave, measure, render, error. Returns an unsubscribe function. */
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name)?.delete(fn);
    },
    /** What the last base render of a layer reported (diff counts / regions, failures). */
    info(paneIndex = 0, layerIndex = 0) { return panes[paneIndex]?.slots[layerIndex]?.info ?? null; },
    /** Drop every tile and render again (content changed in place). */
    invalidate() { api.setBounds(bounds); },
    /** Resolves once nothing is scheduled or rendering. */
    ready() {
      return new Promise((resolve) => { idleWaiters.push(resolve); checkIdle(); }).then(() => new Promise((r) => requestAnimationFrame(() => r())));
    },
    stats() {
      return {
        ...stats,
        tiles: panes.map((p) => p.slots.map((s) => ({
          base: s.base && { r: s.base.r, width: s.base.canvas.width, height: s.base.canvas.height, rect: s.base.rect },
          detail: s.detail && { r: s.detail.r, width: s.detail.canvas.width, height: s.detail.canvas.height, rect: s.detail.rect },
        }))),
      };
    },
    /** The pane's content (not the overlay) as a canvas at `scale` x its CSS size. */
    capture(paneIndex = 0, { scale = 1, background = null } = {}) {
      const pane = panes[paneIndex];
      const { pw, ph } = size(pane);
      const c = document.createElement('canvas');
      c.width = Math.round(pw * scale);
      c.height = Math.round(ph * scale);
      const g = c.getContext('2d');
      if (background) { g.fillStyle = background; g.fillRect(0, 0, c.width, c.height); }
      for (const slot of pane?.slots || []) {
        g.save();
        g.globalAlpha = slot.opacity;
        if (slot.clip) {
          g.beginPath();
          g.rect((slot.clip.x0 ?? 0) * c.width, 0, ((slot.clip.x1 ?? 1) - (slot.clip.x0 ?? 0)) * c.width, c.height);
          g.clip();
        }
        for (const t of [slot.base, slot.detail]) {
          if (!t) continue;
          const [a, b, cc, d, e, f] = rasterMatrix(view, pw, ph, t.rect, t.r, flip);
          g.setTransform(a * scale, b * scale, cc * scale, d * scale, e * scale, f * scale);
          g.drawImage(t.canvas, 0, 0);
        }
        g.restore();
      }
      return c;
    },
    destroy() {
      destroyed = true;
      clearTimeout(settleTimer);
      settleTimer = null;
      if (rafId) cancelAnimationFrame(rafId);
      ro?.disconnect();
      listeners.clear();
      overlays.clear();
      root.remove();
      for (const fn of idleWaiters.splice(0)) fn();
    },
  };
  return api;
}
