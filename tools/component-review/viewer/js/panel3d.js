// Toolbar, status and fallbacks around the 3D module (view3d.js).
// Builds one SideSpec per side from the manifest (CONTRACT.md Addendum 2):
//   geom[side]               -> footprint geometry json (bbox, pads, courtyard, edge_cuts)
//   renders[side].layers     -> per-layer SVGs painted onto the board faces
//   model3d_by_side[side][]  -> STEP copies ("file") + KiCad offset/rotate/scale/hide
import { el, clear, assetUrl, fetchText, markdown, OFFLINE } from './util.js';

const SERVE_HINT = 'Run `python3 serve.py` in this folder for the 3D view (see README.txt). Either way it needs access to cdn.jsdelivr.net.';

let preferredMode = null;
const groupPref = new Map();

function modelsFor(item, side) {
  let list = item.model3d_by_side?.[side];
  // Older manifests: a single model3d list describing head.
  if (!Array.isArray(list)) list = side === 'head' && item.status !== 'deleted' ? item.model3d || [] : side === 'base' && item.status === 'deleted' ? item.model3d || [] : [];
  return list.filter((m) => m && !m.hide);
}

function has(item, side) {
  return !!(item.geom?.[side] || item.renders?.[side]?.layers || modelsFor(item, side).some((m) => m.file));
}

export function has3d(item) {
  return item.kind === 'footprint' && (has(item, 'head') || has(item, 'base'));
}

async function sideSpec(item, side) {
  if (!has(item, side)) return null;
  let geom = null;
  const gp = item.geom?.[side];
  if (gp && assetUrl(gp)) {
    try { geom = JSON.parse(await fetchText(gp)); } catch { geom = null; }
  }
  const models = [];
  const missing = [];
  for (const m of modelsFor(item, side)) {
    const label = String(m.path_raw || m.resolved || 'model').split('/').pop();
    if (m.file && assetUrl(m.file)) {
      models.push({ url: assetUrl(m.file), label, offset: m.offset, rotate: m.rotate, scale: m.scale });
    } else {
      missing.push(`${label}: ${m.exists === false ? 'file not found in repo' : 'no copy in this report'}`);
    }
  }
  return { geom, layers: item.renders?.[side]?.layers || null, models, missing };
}

export function createPanel3D(item, container) {
  const toolbar = el('div', { class: 'toolbar' });
  const groupsBar = el('div', { class: 'layers' });
  const stage = el('div', { class: 'stage3d' }, el('div', { class: 'loading' }, 'Loading 3D viewer…'));
  const labels = el('div', { class: 'labels3d' });
  const status = el('div', { class: 'status3d' });
  container.append(toolbar, groupsBar, el('div', { class: 'stage3d-wrap' }, stage, labels), status,
    el('div', { class: 'hint' }, 'Drag to orbit · right-drag / shift-drag to pan · wheel to zoom'));
  let viewer = null;
  let destroyed = false;

  const hasHead = has(item, 'head');
  const hasBase = has(item, 'base');
  const modes = [];
  if (hasHead && hasBase) modes.push(['side', 'Side by side'], ['overlay', 'Overlay'], ['head', 'Head'], ['base', 'Base']);
  else if (hasHead) modes.push(['head', 'Head']);
  else modes.push(['base', 'Base (deleted)']);
  let mode = modes.some(([m]) => m === preferredMode) ? preferredMode : modes[0][0];

  const seg = el('div', { class: 'seg' });
  for (const [m, label] of modes) {
    seg.append(el('button', {
      class: 'seg-btn', dataset: { mode: m }, 'aria-selected': String(m === mode),
      onclick: () => { preferredMode = m; setMode(m); },
    }, label));
  }
  const views = [['top', 'Top'], ['bottom', 'Bottom'], ['side', 'Side'], ['iso', 'Iso']];
  toolbar.append(seg, el('span', { class: 'spacer' }),
    ...views.map(([v, label]) => el('button', { class: 'btn small', dataset: { view: v }, onclick: () => viewer?.setView(v) }, label)),
    el('button', { class: 'btn small', dataset: { view: 'reset' }, title: 'Reset camera', onclick: () => viewer?.setView('reset') }, 'Reset'));

  // per-side status lines
  const lines = {};
  const line = (side) => {
    if (!lines[side]) {
      lines[side] = { text: el('span'), errs: el('ul', { class: 'warnings' }) };
      status.append(el('div', { class: 'status-line' }, el('strong', {}, `${side}: `), lines[side].text, lines[side].errs));
    }
    return lines[side];
  };
  let hinted = false;
  const onStatus = ({ side, text, errors, done }) => {
    const l = line(side);
    l.text.textContent = text;
    for (const e of errors || []) l.errs.append(el('li', {}, e));
    if (OFFLINE && done && errors?.length && !hinted) {
      hinted = true;
      status.append(el('div', { class: 'notice' }, markdown(SERVE_HINT)));
    }
  };

  function setMode(m) {
    mode = m;
    for (const b of seg.children) b.setAttribute('aria-selected', String(b.dataset.mode === m));
    viewer?.setMode(m);
    clear(labels);
    if (m === 'side') labels.append(el('span', {}, 'base'), el('span', {}, 'head'));
    else if (m === 'overlay') labels.append(el('span', { class: 'key-head' }, 'head'), el('span', { class: 'key-base' }, 'base'));
    else labels.append(el('span', {}, m));
  }

  function renderGroups() {
    clear(groupsBar);
    const gs = viewer?.groups() || [];
    if (!gs.length) { groupsBar.hidden = true; return; }
    groupsBar.hidden = false;
    groupsBar.append(el('span', { class: 'layers-title' }, 'Show'));
    for (const g of gs) {
      const cb = el('input', { type: 'checkbox', id: `g3-${g.name}`, checked: g.visible || null });
      cb.addEventListener('change', () => { groupPref.set(g.name, cb.checked); viewer.setGroupVisible(g.name, cb.checked); });
      groupsBar.append(el('label', { class: 'layer-toggle', for: `g3-${g.name}` }, cb, g.label));
    }
  }

  Promise.all([import('./view3d.js'), sideSpec(item, 'head'), sideSpec(item, 'base')])
    .then(async ([m, head, base]) => {
      for (const [side, spec] of [['head', head], ['base', base]]) {
        if (spec?.missing.length) onStatus({ side, text: '', errors: spec.missing });
      }
      const v = await m.create3DViewer(stage, { dark: matchMedia('(prefers-color-scheme: dark)').matches, onStatus });
      if (destroyed) { v.destroy(); return; }
      viewer = v;
      window.__cr3d = v; // test hook (screenshots / placement checks)
      await v.load({ head, base });
      if (destroyed) return;
      stage.querySelector('.loading')?.remove();
      for (const [g, on] of groupPref) v.setGroupVisible(g, on);
      renderGroups();
      setMode(mode);
      stage.dataset.ready = '1';
    })
    .catch((err) => {
      clear(stage).append(el('div', { class: 'empty' },
        '3D view unavailable: ', String(err?.message || err),
        el('br'), 'The viewer loads three.js and occt-import-js from cdn.jsdelivr.net; check network access.',
        OFFLINE ? markdown(SERVE_HINT) : null));
      stage.dataset.ready = 'error';
    });

  return { destroy() { destroyed = true; viewer?.destroy(); if (window.__cr3d === viewer) window.__cr3d = null; } };
}
