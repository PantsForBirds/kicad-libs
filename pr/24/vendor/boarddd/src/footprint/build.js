// One KiCad footprint on a small board, as three.js meshes in the board frame (mm, y up, z up; the board's
// bottom face at z = 0, top face at z = thickness). The footprint origin is (0, 0).
//
// Ported from kipr's web/library/js/board3d.js (buildBoard: slab with the drills cut through, copper pads
// with their holes, plated barrels; polygon offset so copper wins over a STEP body touching it, kipr PR #14;
// stadium slots + barrel walls, kipr PR #18) and kipr/library/render/model3d.py (graphics layers as thin
// sheets, board from the courtyard + 1 mm). Text is not drawn.
//
// Groups (userData.group): board, copper, barrels, silk, fab, courtyard.

import * as THREE from '../../../three/three.module.js';
import {
  BOARD_THICKNESS, COPPER_THICKNESS, kicadToBoard, kicadModelMatrix, counterClockwise, clockwise, loopBounds,
  padBounds, rectLoop, clearance, strokeLoops, padCopperLoops, padDrillLoop, padCopperSides, padHasCopper,
} from '../geom/index.js';
import { COLORS as BOARD_COLORS, faceMaterial, planarUVs, splitCaps, canvasTexture } from '../board/solid.js';

export const FOOTPRINT_COLORS = {
  mask: 0x1d5b34, fr4: BOARD_COLORS.fr4, copper: 0xe9b934, silk: 0xf4f4ee, fab: 0xa9adb5, courtyard: 0xff4fd8,
};
const GFX = { silk: { dz: 0.010, layers: /\.SilkS$/ }, fab: { dz: 0.020, layers: /\.Fab$/ }, courtyard: { dz: 0.030, layers: /\.CrtYd$/ } };
const COPPER_OFFSET = { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 };

const v2 = (loop) => loop.map(([x, y]) => new THREE.Vector2(x, y));
const toBoardLoop = (pts) => pts.map(([x, y]) => kicadToBoard(x, y));

/** Join segments/polylines (KiCad frame) whose ends meet into closed loops; open chains are dropped. */
export function chainLoops(polylines, tol = 1e-3) {
  const open = polylines.filter((p) => p.length >= 2).map((p) => p.slice());
  const loops = [];
  const same = (a, b) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
  while (open.length) {
    let chain = open.shift();
    let grown = true;
    while (grown && !same(chain[0], chain[chain.length - 1])) {
      grown = false;
      for (let i = 0; i < open.length; i++) {
        const p = open[i];
        const end = chain[chain.length - 1];
        if (same(end, p[0])) chain = chain.concat(p.slice(1));
        else if (same(end, p[p.length - 1])) chain = chain.concat(p.slice(0, -1).reverse());
        else continue;
        open.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (chain.length >= 4 && same(chain[0], chain[chain.length - 1])) loops.push(chain.slice(0, -1));
  }
  return loops;
}

/**
 * The footprint's board outline, board frame: the largest closed Edge.Cuts loop if it has one, else the
 * courtyard's bbox (or everything's) grown by `margin`. Returns {board, cutouts: []}.
 */
export function footprintOutline(fp, margin = 1) {
  const edge = chainLoops(fp.graphics.filter((g) => g.layer === 'Edge.Cuts').map((g) => (g.closed ? [...g.pts, g.pts[0]] : g.pts)));
  if (edge.length) {
    const biggest = edge.map(toBoardLoop).reduce((a, b) => {
      const s = (l) => { const q = loopBounds(l); return (q.maxX - q.minX) * (q.maxY - q.minY); };
      return s(b) > s(a) ? b : a;
    });
    return { board: biggest, cutouts: [] };
  }
  const crt = fp.graphics.filter((g) => /\.CrtYd$/.test(g.layer));
  const pts = crt.length ? crt.flatMap((g) => toBoardLoop(g.pts))
    : [...fp.graphics.flatMap((g) => toBoardLoop(g.pts)), ...fp.pads.flatMap((p) => padCopperLoops(p).flat())];
  const b = pts.length ? padBounds(loopBounds(pts), margin) : { minX: -5, maxX: 5, minY: -5, maxY: 5 };
  return { board: rectLoop(b.minX, b.minY, b.maxX, b.maxY), cutouts: [] };
}

/** A footprint model's placement, board frame: KiCad's model matrix lifted onto the top face. */
export function footprintModelMatrix(model, thickness = BOARD_THICKNESS) {
  const m = kicadModelMatrix(model);
  m[14] += thickness;
  return m;
}

/** The side wall of a closed loop from z0 to z1, no caps, smooth-shaded (a hole's barrel). */
export function wallGeometry(loop, z0, z1) {
  const n = loop.length;
  const pos = new Float32Array(n * 6);
  loop.forEach(([x, y], i) => { pos.set([x, y, z1], 3 * i); pos.set([x, y, z0], 3 * (n + i)); });
  const index = [];
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; index.push(i, n + i, j, j, n + i, n + j); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

function sheet(loops, z, depth) {
  const shapes = loops.filter((l) => l.length >= 3).map((l) => new THREE.Shape(v2(counterClockwise(l))));
  if (!shapes.length) return null;
  const g = depth > 0 ? new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false, curveSegments: 1 }) : new THREE.ShapeGeometry(shapes, 1);
  g.translate(0, 0, z);
  return g;
}

/**
 * Build a footprint (from parseKicadFootprint, or kipr's geom.json + `graphics`) on a small board.
 * Options:
 *   thickness   board thickness, mm (1.6)
 *   margin      board margin around the courtyard, mm (1)
 *   outline     {board, cutouts} board-frame override
 *   faces       {top, bottom}: textures/canvases painted over `uvBounds` (e.g. kipr's per-layer renders
 *               composited), or colours; default solder-mask green
 *   uvBounds    the faces' bounds, board frame (default: the outline's)
 *   decals      {silk, fab, courtyard}: each {top, bottom} pictures (textures/canvases/images painted over
 *               `uvBounds`, transparent where empty, e.g. kipr's per-layer SVG renders) drawn as sheets just
 *               above the copper, in that group; the way to show text, which the graphics sheets leave out
 *   colors      overrides of FOOTPRINT_COLORS
 * Returns {group, outline, thickness, meshes: {board, copper[], barrels[], silk[], fab[], courtyard[]},
 *          modelMatrix(model), dispose()}.
 */
export function buildFootprint(fp, options = {}) {
  const thickness = options.thickness ?? BOARD_THICKNESS;
  const colors = { ...FOOTPRINT_COLORS, ...(options.colors || {}) };
  const outline = options.outline || footprintOutline(fp, options.margin ?? 1);
  const group = new THREE.Group();
  group.name = `footprint-${fp.name || ''}`;
  const disposables = [];
  const meshes = { board: null, copper: [], barrels: [], silk: [], fab: [], courtyard: [] };
  const add = (geometry, material, kind, name) => {
    if (!geometry) return null;
    const m = new THREE.Mesh(geometry, material);
    m.name = name || kind;
    m.userData.group = kind;
    group.add(m);
    disposables.push(geometry);
    if (Array.isArray(meshes[kind])) meshes[kind].push(m); else meshes[kind] = m;
    return m;
  };

  // --- the board, with every drill punched through (holes crossing the outline are left out)
  const shape = new THREE.Shape(v2(counterClockwise(outline.board)));
  for (const c of outline.cutouts || []) shape.holes.push(new THREE.Path(v2(clockwise(c))));
  const drills = [];
  for (const pad of fp.pads) {
    const loop = padDrillLoop(pad);
    if (!loop) continue;
    const inside = loop.every(([x, y]) => { const c = clearance(outline.board, x, y); return c.inside && c.distance > 1e-3; });
    if (inside) { drills.push({ pad, loop }); shape.holes.push(new THREE.Path(v2(clockwise(loop)))); }
  }
  const slab = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 1 });
  const uvBounds = options.uvBounds || loopBounds(outline.board);
  planarUVs(slab, uvBounds);
  // ExtrudeGeometry: group 0 = both caps, 1 = walls; split the caps for two face pictures
  splitCaps(slab);
  const faces = options.faces || {};
  const faceMats = { top: faceMaterial(faces.top ?? colors.mask), bottom: faceMaterial(faces.bottom ?? colors.mask) };
  const wallMat = new THREE.MeshStandardMaterial({ color: colors.fr4, roughness: 0.85 });
  add(slab, [faceMats.top, faceMats.bottom, wallMat], 'board', 'footprint-board');

  // --- copper: each pad's outline with its hole, as thin plates on the faces it is on
  const padMat = new THREE.MeshStandardMaterial({ color: colors.copper, metalness: 0.5, roughness: 0.4, ...COPPER_OFFSET });
  const barrelMat = new THREE.MeshStandardMaterial({ color: colors.copper, metalness: 0.5, roughness: 0.45, side: THREE.DoubleSide, ...COPPER_OFFSET });
  for (const pad of fp.pads) {
    if (!padHasCopper(pad)) continue;
    const sides = padCopperSides(pad);
    const loops = padCopperLoops(pad, 8);
    const hole = drills.find((d) => d.pad === pad)?.loop || padDrillLoop(pad);
    const shapes = loops.map((l, i) => {
      const s = new THREE.Shape(v2(counterClockwise(l)));
      if (hole && i === 0) s.holes.push(new THREE.Path(v2(clockwise(hole))));
      return s;
    });
    const plate = new THREE.ExtrudeGeometry(shapes, { depth: COPPER_THICKNESS, bevelEnabled: false, curveSegments: 1 });
    const label = `pad-${pad.number}`;
    if (sides.top) add(plate.clone().translate(0, 0, thickness), padMat, 'copper', label);
    if (sides.bottom) add(plate.clone().translate(0, 0, -COPPER_THICKNESS), padMat, 'copper', label);
    plate.dispose();
  }
  // --- plated barrels: the drill outline (a stadium for slots) as a wall through the board
  for (const { pad, loop } of drills) {
    if (pad.type !== 'thru_hole') continue;
    add(wallGeometry(loop, 0, thickness), barrelMat, 'barrels', `barrel-${pad.number}`);
  }

  // --- graphics: silk, fab, courtyard as thin sheets just above the copper (below it on the back)
  const gfxMats = {};
  for (const [kind, { dz, layers }] of Object.entries(GFX)) {
    for (const side of ['F', 'B']) {
      const items = fp.graphics.filter((g) => g.layer?.startsWith(`${side}.`) && layers.test(g.layer));
      if (!items.length) continue;
      const loops = items.flatMap((g) => {
        const pts = toBoardLoop(g.pts);
        if (g.closed && g.filled && pts.length >= 3) return [pts, ...(g.width > 0 ? strokeLoops(pts, g.width, true) : [])];
        return strokeLoops(pts, Math.max(g.width || 0, 0.02), g.closed);
      });
      gfxMats[kind] ??= new THREE.MeshStandardMaterial({ color: colors[kind], roughness: 0.8, ...COPPER_OFFSET, polygonOffsetUnits: -6 });
      const z = side === 'F' ? thickness + COPPER_THICKNESS + dz : -COPPER_THICKNESS - dz - 0.001;
      add(sheet(loops, z, 0.001), gfxMats[kind], kind, `${side}.${kind}`);
    }
  }

  // --- decals: layer pictures over the board's shape (holes included), transparent, toggled with their group
  const decalMats = [];
  for (const [kind, { dz }] of Object.entries(GFX)) {
    const pics = options.decals?.[kind];
    if (!pics) continue;
    for (const side of ['top', 'bottom']) {
      const pic = pics[side];
      if (!pic) continue;
      const g = new THREE.ShapeGeometry(shape, 1);
      planarUVs(g, uvBounds);
      const top = side === 'top';
      g.translate(0, 0, top ? thickness + COPPER_THICKNESS + dz + 0.002 : -COPPER_THICKNESS - dz - 0.003);
      const owned = !pic.isTexture;
      const m = new THREE.MeshStandardMaterial({
        map: canvasTexture(pic), transparent: true, depthWrite: false, roughness: 0.8, metalness: 0,
        side: top ? THREE.FrontSide : THREE.BackSide, ...COPPER_OFFSET, polygonOffsetUnits: -8,
      });
      m.userData.ownsMap = owned;
      decalMats.push(m);
      const mesh = add(g, m, kind, `${side === 'top' ? 'F' : 'B'}.${kind}-decal`);
      mesh.renderOrder = 2;
    }
  }

  const materials = [faceMats.top, faceMats.bottom, wallMat, padMat, barrelMat, ...Object.values(gfxMats)];
  return {
    group, outline, thickness, meshes, uvBounds,
    /** Matrix4 array for one of fp.models, board frame (apply to the loaded model's root). */
    modelMatrix: (model) => footprintModelMatrix(model, thickness),
    dispose() {
      for (const g of disposables) g.dispose();
      for (const m of materials) { if (m.map) m.map.dispose(); m.dispose(); }
      for (const m of decalMats) { if (m.userData.ownsMap) m.map.dispose(); m.dispose(); }
    },
  };
}
