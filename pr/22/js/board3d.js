// Builds the "board" around a footprint for the 3D view, in the board frame (see kicad3d.js):
//   - an FR4 slab over geom.bbox (or the closed Edge.Cuts outline), with the drill holes cut through;
//   - the top/bottom faces painted from the per-layer SVG renders (mask, copper under mask, openings);
//   - silkscreen and fab/courtyard as separate transparent decal planes so they can be toggled;
//   - copper pads (+ plated barrels) as real geometry from geom.json.
// Every object is tagged with userData.group in {board, pads, silk, fab}.
import {
  BOARD_THICKNESS, COPPER_THICKNESS, toBoard, padOutline, padToPcb, padDrill, padDrillRing, padCopperSides,
} from './kicad3d.js';
import { imageSrc } from './util.js';

export const PALETTE = {
  mask: '#1d5b34', copperUnderMask: '#2f7d45', exposedCopper: '#d6b25a', fr4Edge: '#bfb07a',
  silk: '#f4f4ee', fab: '#a9adb5', courtyard: '#ff4fd8', pad: 0xe9b934,
};
const DECAL_Z = 0.045; // above pads (0.035) so decals are not hidden by copper
const MAX_TEXTURE_PX = 4096;
const PX_PER_MM = 48;

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

/** Draw an image recoloured to a single colour (alpha kept) — renders may use any palette. */
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

/**
 * A shape's outer ring counter-clockwise: three's extruder only normalises the holes' winding when the outer
 * ring is CCW, and a hole wound like its outer ring gets its walls facing away from the viewer (culled).
 */
function ccw(ring) {
  let a = 0;
  ring.forEach(([x, y], i) => { const [u, v] = ring[(i + 1) % ring.length]; a += x * v - u * y; });
  return a < 0 ? ring.slice().reverse() : ring;
}

function ringToShapePath(THREE, ring, PathClass) {
  const p = new PathClass();
  ring.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
  p.closePath();
  return p;
}

/**
 * The wall of a hole: the side of `ring` (board frame) extruded from z0 to z1 with no caps, sharing the
 * vertices around the loop so it shades smooth. A stadium ring gives a slot's barrel: flat flanks, round ends.
 */
function wallGeometry(THREE, ring, z0, z1) {
  const n = ring.length;
  const pos = new Float32Array(n * 2 * 3);
  ring.forEach(([x, y], i) => {
    pos.set([x, y, z1], 3 * i);
    pos.set([x, y, z0], 3 * (n + i));
  });
  const index = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    index.push(i, n + i, j, j, n + i, n + j);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** Closed outline from Edge.Cuts polylines if there is exactly one usable loop, else the bbox rectangle. */
function outlineRing(geom) {
  const loops = (geom.edge_cuts || []).filter((pl) => Array.isArray(pl) && pl.length >= 3);
  if (loops.length) {
    const longest = loops.reduce((a, b) => (b.length > a.length ? b : a));
    return longest.map((q) => toBoard(...(Array.isArray(q) ? q : [q.x, q.y])));
  }
  const [x0, y0, x1, y1] = geom.bbox;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map((q) => toBoard(...q));
}

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
  return {
    top: face('F'), bottom: face('B'),
    silkTop: decal('F', [['SilkS', PALETTE.silk, 1]]), silkBottom: decal('B', [['SilkS', PALETTE.silk, 1]]),
    fabTop: decal('F', [['Fab', PALETTE.fab, 0.9], ['CrtYd', PALETTE.courtyard, 0.9]]),
    fabBottom: decal('B', [['Fab', PALETTE.fab, 0.9], ['CrtYd', PALETTE.courtyard, 0.9]]),
    hasMaskOpenings: !!(imgs['F.Mask'] || imgs['B.Mask']),
  };
}

export async function buildBoard(THREE, { geom, layers, maxAnisotropy = 1 }) {
  const root = new THREE.Group();
  root.name = 'board-root';
  const [x0, y0, x1, y1] = geom.bbox;
  // bbox in board frame (y flipped)
  const bb = [x0, -y1, x1, -y0];
  const w = x1 - x0;
  const h = y1 - y0;
  const ppm = Math.min(PX_PER_MM, MAX_TEXTURE_PX / Math.max(w, h));
  const W = Math.max(2, Math.round(w * ppm));
  const H = Math.max(2, Math.round(h * ppm));

  // --- slab with holes
  const shape = new THREE.Shape();
  ccw(outlineRing(geom)).forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y)));
  shape.closePath();
  const pads = geom.pads || [];
  for (const pad of pads) {
    const ring = padDrillRing(pad);
    if (ring) shape.holes.push(ringToShapePath(THREE, ring, THREE.Path));
  }
  const slabGeo = new THREE.ExtrudeGeometry(shape, { depth: BOARD_THICKNESS, bevelEnabled: false, curveSegments: 8 });
  slabGeo.translate(0, 0, -BOARD_THICKNESS);
  const edgeMat = new THREE.MeshStandardMaterial({ color: PALETTE.fr4Edge, roughness: 0.85 });
  const capMat = new THREE.MeshStandardMaterial({ color: PALETTE.mask, roughness: 0.6 });
  const slab = new THREE.Mesh(slabGeo, [capMat, edgeMat]);
  slab.userData.group = 'board';
  root.add(slab);

  // --- painted faces + decals: flat ShapeGeometry copies of the outline (with the same holes)
  const faces = await paintFaces(layers, W, H);
  const texture = (canvas) => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAnisotropy;
    return t;
  };
  const plane = (canvas, z, group, { transparent = false, bottom = false } = {}) => {
    if (!canvas) return null;
    const g = new THREE.ShapeGeometry(shape, 8);
    const pos = g.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uv[2 * i] = (pos.getX(i) - bb[0]) / (bb[2] - bb[0]);
      uv[2 * i + 1] = (pos.getY(i) - bb[1]) / (bb[3] - bb[1]);
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.translate(0, 0, z);
    const m = new THREE.MeshStandardMaterial({
      map: texture(canvas), transparent, roughness: transparent ? 0.8 : 0.55, metalness: 0,
      side: bottom ? THREE.BackSide : THREE.FrontSide, depthWrite: !transparent,
      polygonOffset: true, polygonOffsetFactor: transparent ? -2 : -1, polygonOffsetUnits: transparent ? -2 : -1,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.userData.group = group;
    mesh.renderOrder = transparent ? 2 : 1;
    root.add(mesh);
    return mesh;
  };
  plane(faces.top, 0.001, 'board');
  plane(faces.bottom, -BOARD_THICKNESS - 0.001, 'board', { bottom: true });
  plane(faces.silkTop, DECAL_Z, 'silk', { transparent: true });
  plane(faces.silkBottom, -BOARD_THICKNESS - DECAL_Z, 'silk', { transparent: true, bottom: true });
  plane(faces.fabTop, DECAL_Z + 0.005, 'fab', { transparent: true });
  plane(faces.fabBottom, -BOARD_THICKNESS - DECAL_Z - 0.005, 'fab', { transparent: true, bottom: true });

  // --- copper pads and plated barrels
  // The copper is KiCad's footprint data: when a STEP body touches it (castellated module, pads at the same z),
  // let the copper win the depth test instead of z-fighting. Rendering only; the geometry stays where KiCad puts it.
  const copper = { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 };
  const padMat = new THREE.MeshStandardMaterial({ color: PALETTE.pad, metalness: 0.5, roughness: 0.4, ...copper });
  const barrelMat = new THREE.MeshStandardMaterial({ color: PALETTE.pad, metalness: 0.5, roughness: 0.45, side: THREE.DoubleSide, ...copper });
  let padCount = 0;
  for (const pad of pads) {
    const sides = padCopperSides(pad);
    if (!sides.top && !sides.bottom) continue;
    // NPTH pads often list *.Cu but have no annular ring (pad size <= drill): no copper to draw.
    const dr = padDrill(pad);
    if (pad.type === 'np_thru_hole' && dr && Math.min(...(pad.size || [0])) <= Math.min(dr.w, dr.h) + 1e-6) continue;
    const { outer, extra } = padOutline(pad);
    const rings = [outer, ...extra].map((ring) => ring.map((q) => toBoard(...padToPcb(pad, q))));
    const hole = padDrillRing(pad);
    for (const ring of rings) {
      const s = new THREE.Shape();
      ccw(ring).forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
      s.closePath();
      if (hole && ring === rings[0]) s.holes.push(ringToShapePath(THREE, hole, THREE.Path));
      const g = new THREE.ExtrudeGeometry(s, { depth: COPPER_THICKNESS, bevelEnabled: false, curveSegments: 8 });
      if (sides.top) {
        const m = new THREE.Mesh(g, padMat);
        m.userData.group = 'pads';
        root.add(m);
      }
      if (sides.bottom) {
        const m = new THREE.Mesh(g.clone().translate(0, 0, -BOARD_THICKNESS - COPPER_THICKNESS), padMat);
        m.userData.group = 'pads';
        root.add(m);
      }
    }
    if (hole && pad.type === 'thru_hole') {
      // plated barrel: the drill outline (a stadium for slots) as a wall through the board
      const m = new THREE.Mesh(wallGeometry(THREE, hole, -BOARD_THICKNESS, 0), barrelMat);
      m.userData.group = 'pads';
      root.add(m);
    }
    padCount++;
  }
  return { root, padCount, bboxBoard: bb, hasFab: !!(faces.fabTop || faces.fabBottom), hasSilk: !!(faces.silkTop || faces.silkBottom) };
}

