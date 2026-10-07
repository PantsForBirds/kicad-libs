// 3D view of a footprint: the part (STEP) on its footprint on a small piece of board, base vs head.
// Built on boarddd (web/vendor/boarddd: footprint, models, scene); what stays here is kipr's own:
// the SideSpec from the manifest, the board faces painted from kipr's per-layer SVG renders, and the
// Head / Base / Side by side / Overlay modes.
//
// Interface used by panel3d.js (keep it small so loaders/renderers can be swapped):
//     const v = await create3DViewer(container, { dark, onStatus })
//     await v.load({ head: SideSpec|null, base: SideSpec|null })
//     v.setMode('head'|'base'|'side'|'overlay'); v.setGroupVisible(name, bool); v.setView('top'|'bottom'|'side'|'iso'|'reset')
//     v.groups() -> [{name, label, visible}];  v.destroy()
// SideSpec = { geom: <geom.json object>|null, layers: {"F.Cu": url, ...}|null,
//              models: [{ url, label, offset:[x,y,z], rotate:[x,y,z], scale:[x,y,z] }] }
// Model files are loaded by extension through MODEL_LOADERS (STEP via boarddd/models + occt-import-js).
import * as THREE from '../vendor/three/three.module.js';
import { createViewer } from '../vendor/boarddd/src/scene/index.js';
import { buildFootprint, footprintModelMatrix } from '../vendor/boarddd/src/footprint/index.js';
import { readStep, stepToObject } from '../vendor/boarddd/src/models/index.js';
import { BOARD_THICKNESS, kicadToBoard } from '../vendor/boarddd/src/geom/index.js';
import { OFFLINE, imageSrc, fetchBytes } from './util.js';
import { stepOptions } from './occt.js';

export const GROUPS = [
  { name: 'board', label: 'Board' },
  { name: 'pads', label: 'Pads' },
  { name: 'silk', label: 'Silk' },
  { name: 'fab', label: 'Fab/Courtyard', defaultOff: true },
  { name: 'model', label: '3D model' },
];
// boarddd's mesh groups -> the toggles above
const GROUP_OF = { board: 'board', copper: 'pads', barrels: 'pads', silk: 'silk', fab: 'fab', courtyard: 'fab', model: 'model' };
const OVERLAY_COLORS = { head: 0x22c3ff, base: 0xff3d9a };
const SEE_THROUGH = ['pads', 'model'];   // what overlay draws for both sides

// The board faces are painted from kipr's per-layer SVG renders of the footprint (render step).
export const PALETTE = {
  mask: '#1d5b34', copperUnderMask: '#2f7d45', exposedCopper: '#d6b25a',
  silk: '#f4f4ee', fab: '#a9adb5', courtyard: '#ff4fd8',
};
const MAX_TEXTURE_PX = 4096;
const PX_PER_MM = 48;

// Directions in the board frame (x right, y up, z up), as the viewer had them before boarddd.
const VIEWS = {
  top: { dir: [0, 0, 1], up: [0, 1, 0] },
  bottom: { dir: [0, 0, -1], up: [0, 1, 0] },
  side: { dir: [0, -1, 0.18], up: [0, 0, 1] },
  iso: { dir: [0.7, -1, 0.85], up: [0, 0, 1] },
};
VIEWS.reset = VIEWS.iso;
// boarddd fits the box's projection; these margins frame the part as the viewer always has
const FIT_PAD = { top: 1.3, bottom: 1.3, side: 1.05, iso: 0.95, reset: 0.95 };

/** Loaders by file extension; each resolves to a THREE.Object3D in the model's own (STEP) frame, mm. */
const stepCache = new Map();
export const MODEL_LOADERS = {
  async step(url, onProgress) {
    const abs = new URL(url, document.baseURI).href;
    if (!stepCache.has(abs)) {
      // offline (file://): the bytes come from the item's pack; occt runs on the main thread there
      const raw = url.split('/').map(decodeURIComponent).join('/');
      const p = (async () => readStep(OFFLINE ? await fetchBytes(raw) : abs, { ...await stepOptions(), onProgress }))();
      p.catch(() => stepCache.delete(abs));
      stepCache.set(abs, p);
    }
    return stepToObject(await stepCache.get(abs));
  },
};
MODEL_LOADERS.stp = MODEL_LOADERS.step;

export function modelLoaderFor(url) {
  const ext = String(url).split('?')[0].split('.').pop().toLowerCase();
  return MODEL_LOADERS[ext] || null;
}

async function loadImage(url) {
  let safe = null;
  try { safe = await imageSrc(url); } catch { safe = null; } // offline: blob: URL from the item's pack
  if (!safe) return null;
  const img = await new Promise((resolve) => {
    const im = new Image();
    im.decoding = 'async';
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = safe;
  });
  if (safe.startsWith('blob:')) URL.revokeObjectURL(safe);
  return img;
}

/** Draw an image recoloured to a single colour (alpha kept): renders may use any palette. */
function drawTinted(ctx, img, color, W, H, alpha = 1) {
  if (!img) return;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const t = c.getContext('2d');
  t.drawImage(img, 0, 0, W, H);
  t.globalCompositeOperation = 'source-in';
  t.fillStyle = color;
  t.fillRect(0, 0, W, H);
  ctx.globalAlpha = alpha;
  ctx.drawImage(c, 0, 0);
  ctx.globalAlpha = 1;
}

/** Face pictures (mask, copper under mask, openings) and decals (silk, fab + courtyard) from the layer SVGs. */
async function paintFaces(layerUrls, W, H) {
  const want = ['F.Cu', 'F.Mask', 'B.Cu', 'B.Mask', 'F.SilkS', 'B.SilkS', 'F.Fab', 'F.CrtYd', 'B.Fab', 'B.CrtYd'];
  const imgs = Object.fromEntries(await Promise.all(want.map(async (n) => [n, layerUrls?.[n] ? await loadImage(layerUrls[n]) : null])));
  const canvas = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
  const face = (side) => {
    const c = canvas();
    const ctx = c.getContext('2d');
    ctx.fillStyle = PALETTE.mask;
    ctx.fillRect(0, 0, W, H);
    drawTinted(ctx, imgs[`${side}.Cu`], PALETTE.copperUnderMask, W, H);
    drawTinted(ctx, imgs[`${side}.Mask`], PALETTE.exposedCopper, W, H); // mask layer = openings
    return c;
  };
  const decal = (side, parts) => {
    if (!parts.some(([n]) => imgs[`${side}.${n}`])) return null;
    const c = canvas();
    const ctx = c.getContext('2d');
    for (const [n, color, a] of parts) drawTinted(ctx, imgs[`${side}.${n}`], color, W, H, a);
    return c;
  };
  const fab = [['Fab', PALETTE.fab, 0.9], ['CrtYd', PALETTE.courtyard, 0.9]];
  return {
    faces: { top: face('F'), bottom: face('B') },
    decals: {
      silk: { top: decal('F', [['SilkS', PALETTE.silk, 1]]), bottom: decal('B', [['SilkS', PALETTE.silk, 1]]) },
      fab: { top: decal('F', fab), bottom: decal('B', fab) },
    },
  };
}

/** The board outline, board frame: the longest Edge.Cuts polyline, else the bbox the SVGs were rendered over. */
function outlineOf(geom) {
  const loops = (geom.edge_cuts || []).filter((pl) => Array.isArray(pl) && pl.length >= 3);
  if (loops.length) {
    const longest = loops.reduce((a, b) => (b.length > a.length ? b : a));
    return { board: longest.map((q) => kicadToBoard(...(Array.isArray(q) ? q : [q.x, q.y]))), cutouts: [] };
  }
  const [x0, y0, x1, y1] = geom.bbox;
  return { board: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map((q) => kicadToBoard(...q)), cutouts: [] };
}

/** The footprint on its board (boarddd/footprint) with faces and decals from the layer renders. */
async function buildBoard(geom, layers) {
  const [x0, y0, x1, y1] = geom.bbox;
  const w = x1 - x0, h = y1 - y0;
  const ppm = Math.min(PX_PER_MM, MAX_TEXTURE_PX / Math.max(w, h));
  const W = Math.max(2, Math.round(w * ppm)), H = Math.max(2, Math.round(h * ppm));
  const { faces, decals } = await paintFaces(layers, W, H);
  // boarddd draws no copper for an NPTH pad without an annular ring (pad size <= drill), as before
  return buildFootprint({ name: '', pads: geom.pads || [], graphics: [], models: [] }, {
    outline: outlineOf(geom), uvBounds: { minX: x0, maxX: x1, minY: -y1, maxY: -y0 }, faces, decals,
  });
}

export async function create3DViewer(container, { dark = false, onStatus = () => {} } = {}) {
  const viewer = createViewer(container, {
    controls: 'orbit', theme: dark ? 'dark' : 'light', preserveDrawingBuffer: true,
  });
  const sides = { head: null, base: null };   // {group, built}
  const visible = Object.fromEntries(GROUPS.map((g) => [g.name, !g.defaultOff]));
  const present = new Set();
  let mode = 'head';
  let lastView = 'iso';
  let focusBox = null;

  async function buildSide(side, spec) {
    if (!spec) return null;
    const group = new THREE.Group();
    group.name = `footprint-${side}`;
    let built = null;
    if (spec.geom?.bbox) {
      built = await buildBoard(spec.geom, spec.layers);
      group.add(built.group);
      present.add('board');
      if (built.meshes.copper.length) present.add('pads');
      if (built.meshes.silk.length) present.add('silk');
      if (built.meshes.fab.length) present.add('fab');
    } else {
      onStatus({ side, text: 'no footprint geometry (geom) in the manifest: showing the 3D model only' });
    }
    const models = spec.models || [];
    if (models.length) present.add('model');
    const results = await Promise.allSettled(models.map(async (m, i) => {
      const loader = modelLoaderFor(m.url);
      if (!loader) throw new Error(`${m.label || m.url}: no browser loader for this file type`);
      const obj = await loader(m.url, (stage) => onStatus({ side, text: `${m.label || 'model'}: ${stage}` }));
      const holder = new THREE.Group();
      holder.name = `model:${m.label || i}`;
      holder.matrixAutoUpdate = false;
      holder.matrix.fromArray(footprintModelMatrix(m, built?.thickness ?? BOARD_THICKNESS));
      holder.add(obj);
      obj.traverse((o) => { if (o.isMesh) o.userData.group = 'model'; });
      group.add(holder);
      return m.label;
    }));
    const failed = results.map((r, i) => (r.status === 'rejected' ? `${models[i].label || 'model'}: ${r.reason?.message || r.reason}` : null)).filter(Boolean);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    onStatus({ side, done: true, text: models.length ? `${ok}/${models.length} 3D model(s) loaded` : 'no 3D model file for this side', errors: failed });
    group.traverse((o) => { if (o.isMesh) o.userData.orig = o.material; });
    return { group, built };
  }

  function forEachTagged(fn) {
    for (const [side, s] of Object.entries(sides)) {
      s?.group.traverse((o) => { if (o.isMesh && GROUP_OF[o.userData.group]) fn(o, side, GROUP_OF[o.userData.group]); });
    }
  }

  function apply() {
    const both = !!(sides.head && sides.base);
    for (const [side, s] of Object.entries(sides)) {
      if (!s) continue;
      s.group.visible = mode === 'side' || mode === 'overlay' || mode === side || (!sides[mode] && s === (sides.head || sides.base));
    }
    forEachTagged((o, side, g) => {
      let on = visible[g] !== false;
      // overlay: one board (head's) with both sides' copper + models drawn see-through
      if (mode === 'overlay' && side === 'base' && sides.head && !SEE_THROUGH.includes(g)) on = false;
      o.visible = on;
      if (!SEE_THROUGH.includes(g)) return;
      if (mode === 'overlay' && both) {
        o.userData.overlayMat ??= new THREE.MeshStandardMaterial({
          color: OVERLAY_COLORS[side], transparent: true, opacity: 0.45, depthWrite: false, roughness: 0.5, side: THREE.DoubleSide,
        });
        o.material = o.userData.overlayMat;
        o.renderOrder = 3;   // after the silk/fab decals (2), which would otherwise show through the parts
      } else {
        o.material = o.userData.orig;
        o.renderOrder = 0;
      }
    });
    viewer.setPanes(mode === 'side' && both ? [[sides.base.group], [sides.head.group]] : null);
    viewer.requestRender();
  }

  // Frame the part (pads + model), not the board: the board also covers long Value texts.
  function frameBox() {
    const box = new THREE.Box3();
    viewer.content.updateMatrixWorld(true);
    forEachTagged((o, side, g) => { if (SEE_THROUGH.includes(g)) box.expandByObject(o); });
    if (box.isEmpty()) for (const s of Object.values(sides)) if (s) box.expandByObject(s.group);
    if (!box.isEmpty()) box.expandByScalar(0.5);
    return box.isEmpty() ? null : box;
  }

  function setView(name) {
    lastView = name;
    viewer.setView(VIEWS[name] || VIEWS.iso, { box: focusBox, pad: FIT_PAD[name] || FIT_PAD.iso });
  }

  return {
    async load({ head, base }) {
      const [h, b] = await Promise.all([buildSide('head', head), buildSide('base', base)]);
      sides.head = h;
      sides.base = b;
      for (const s of [h, b]) if (s) viewer.add(s.group);
      mode = sides.head ? 'head' : 'base';
      apply();
      focusBox = frameBox();
      setView('iso');
    },
    setMode(m) {
      const reframe = (m === 'side') !== (mode === 'side');
      mode = m;
      apply();
      if (reframe) setView(lastView);
    },
    setGroupVisible(name, on) { visible[name] = on; apply(); },
    groups: () => GROUPS.filter((g) => present.has(g.name)).map((g) => ({ name: g.name, label: g.label, visible: visible[g.name] })),
    setView,
    /** For tests: board-frame bounding boxes of each group per side (board bottom face at z = 0). */
    debugBoxes() {
      const out = {};
      viewer.content.updateMatrixWorld(true);
      for (const [side, s] of Object.entries(sides)) {
        if (!s) continue;
        const boxes = {};
        s.group.traverse((o) => {
          const g = o.isMesh && GROUP_OF[o.userData.group];
          if (g) (boxes[g] ??= new THREE.Box3()).expandByObject(o);
        });
        out[side] = Object.fromEntries(Object.entries(boxes).map(([g, bx]) => [g, { min: bx.min.toArray(), max: bx.max.toArray() }]));
      }
      return out;
    },
    viewer,
    boardThickness: BOARD_THICKNESS,
    destroy() {
      for (const s of Object.values(sides)) s?.group.traverse((o) => o.userData.overlayMat?.dispose());
      viewer.dispose();   // frees the content too (geometries, materials, face textures)
    },
  };
}
