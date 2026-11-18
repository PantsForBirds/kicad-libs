// The board as a solid: an outline extruded to the board's thickness, drilled holes and slots punched
// through it, plated barrels standing in the plated ones, the caps split into a top and a bottom group,
// and planar UVs that put a face texture exactly where the face raster painted it.
//
// Ported from gentoo's viewer3d.js (PantsForBirds/internal fab/static/fab/viewer3d.js: buildBoard,
// buildBarrels, planarUVs, splitCaps) by way of kipr's web/project/pcba3d/boardgeom.js (boardGeometry).
// The outer ring is forced counter-clockwise: three's ExtrudeGeometry only normalises the holes' winding
// when it reverses the outer ring, and a hole wound like its outline gets its wall culled (you look
// through the board at the sky) -- gentoo hit it on one board and not the other; kipr PR #18 again.

import * as THREE from '../../../three/three.module.js';
import { counterClockwise, loopBounds, usableHoles, holeLoop, PLATING_MM, BOARD_THICKNESS } from '../geom/index.js';

export const COLORS = {
  fr4: 0xc9b27c,        // the laminate, seen on the cut edge and the hole walls
  copper: 0xb87333,     // plated barrels
  mask: 0x1d5b34,       // a face with no texture
};
// A barrel's outer wall is buried this far in the laminate: coplanar walls z-fight, and the plating loses.
const BARREL_BITE_MM = 0.005;

const v2 = (loop) => loop.map(([x, y]) => new THREE.Vector2(x, y));

/** UVs from x and y over `bounds` ({minX, maxX, minY, maxY}): the face raster's own linear map. */
export function planarUVs(geometry, bounds) {
  const w = Math.max(bounds.maxX - bounds.minX, 1e-6), h = Math.max(bounds.maxY - bounds.minY, 1e-6);
  const pos = geometry.attributes.position, uv = geometry.attributes.uv;
  for (let i = 0; i < pos.count; i += 1) uv.setXY(i, (pos.getX(i) - bounds.minX) / w, (pos.getY(i) - bounds.minY) / h);
  uv.needsUpdate = true;
}

/** Groups: 0 = top cap, 1 = bottom cap, 2 = walls (the extruder puts both caps in one group). */
export function splitCaps(geometry) {
  const pos = geometry.attributes.position;
  const caps = geometry.groups.find((g) => g.materialIndex === 0);
  const walls = geometry.groups.find((g) => g.materialIndex === 1);
  if (!caps) return;
  let low = Infinity, high = -Infinity;
  for (let i = caps.start; i < caps.start + caps.count; i += 1) {
    const z = pos.getZ(i);
    if (z < low) low = z;
    if (z > high) high = z;
  }
  if (high - low < 1e-9) return;
  const middle = (low + high) / 2;
  const firstIsTop = pos.getZ(caps.start) > middle;
  let boundary = caps.start + caps.count;
  for (let i = caps.start; i < caps.start + caps.count; i += 3) {
    if ((pos.getZ(i) > middle) !== firstIsTop) { boundary = i; break; }
  }
  const runs = [[caps.start, boundary - caps.start], [boundary, caps.start + caps.count - boundary]];
  const [top, bottom] = firstIsTop ? runs : [runs[1], runs[0]];
  geometry.clearGroups();
  geometry.addGroup(top[0], top[1], 0);
  geometry.addGroup(bottom[0], bottom[1], 1);
  if (walls) geometry.addGroup(walls.start, walls.count, 2);
}

/**
 * The board solid's geometry.
 *   outline   {board: [[x, y]], cutouts?: [[[x, y]]]} board frame (y up), mm
 *   holes     drills as parseExcellon gives them (see geom usableHoles), or already-kept holes
 *   thickness mm; the solid spans z = 0 (bottom face) .. thickness (top face)
 *   uvBounds  the face rasters' bounds (default: the outline's)
 * Returns {body (groups top/bottom/walls), barrels | null, holes: usableHoles() report}.
 */
export function boardGeometry(outline, holes = [], thickness = BOARD_THICKNESS, uvBounds = null, { budget } = {}) {
  const shape = new THREE.Shape(v2(counterClockwise(outline.board)));
  for (const hole of outline.cutouts || []) if (hole.length >= 3) shape.holes.push(new THREE.Path(v2(hole)));
  const report = usableHoles(holes, outline, budget);
  for (const hole of report.kept) shape.holes.push(new THREE.Path(v2(holeLoop(hole))));
  const body = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 1 });
  planarUVs(body, uvBounds || loopBounds(outline.board));
  splitCaps(body);
  const shapes = [];
  for (const hole of report.kept) {
    if (!hole.plated) continue;
    const s = new THREE.Shape(v2(counterClockwise(holeLoop(hole, BARREL_BITE_MM))));
    if (hole.radius - PLATING_MM > 0) s.holes.push(new THREE.Path(v2(holeLoop(hole, -PLATING_MM))));
    shapes.push(s);
  }
  const barrels = shapes.length ? new THREE.ExtrudeGeometry(shapes, { depth: thickness, bevelEnabled: false }) : null;
  return { body, barrels, holes: report };
}

/** A face material: a texture (THREE.Texture, canvas or image) or a flat colour. */
export function faceMaterial(face, fallbackColor = COLORS.mask) {
  if (face && !face.isTexture && (face instanceof Object) && ('width' in face) && ('height' in face)) face = canvasTexture(face);
  return face?.isTexture
    ? new THREE.MeshStandardMaterial({ map: face, roughness: 0.55, metalness: 0.05 })
    : new THREE.MeshStandardMaterial({ color: face ?? fallbackColor, roughness: 0.7, metalness: 0 });
}

/** A canvas/image as an sRGB, mipmapped texture. */
export function canvasTexture(canvas, { anisotropy = 4 } = {}) {
  const t = canvas.isTexture ? canvas : new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * The board as a THREE.Group: `body` (userData.group 'board') and `barrels` (userData.group 'barrels').
 *   faces  {top, bottom}: textures / canvases (mapped over `uvBounds`) or colours; default mask green
 * Returns {group, body, barrels, materials, holes, outline, thickness, setFaces({top, bottom}), dispose()}.
 */
export function buildBoard({ outline, holes = [], thickness = BOARD_THICKNESS, uvBounds = null, faces = {}, budget, name = 'board' } = {}) {
  if (!outline?.board || outline.board.length < 3) throw new Error('buildBoard: needs outline.board (>= 3 points)');
  const geo = boardGeometry(outline, holes, thickness, uvBounds, { budget });
  const materials = {
    top: faceMaterial(faces.top), bottom: faceMaterial(faces.bottom),
    walls: new THREE.MeshStandardMaterial({ color: COLORS.fr4, roughness: 0.9 }),
    barrels: new THREE.MeshStandardMaterial({ color: COLORS.copper, roughness: 0.45, metalness: 0.65 }),
  };
  const group = new THREE.Group();
  group.name = name;
  const body = new THREE.Mesh(geo.body, [materials.top, materials.bottom, materials.walls]);
  body.name = `${name}-body`;
  body.userData.group = 'board';
  group.add(body);
  let barrels = null;
  if (geo.barrels) {
    barrels = new THREE.Mesh(geo.barrels, materials.barrels);
    barrels.name = `${name}-barrels`;
    barrels.userData.group = 'barrels';
    group.add(barrels);
  }
  const owned = new Set();
  const result = {
    group, body, barrels, materials, holes: geo.holes, outline, thickness,
    /** Swap the face pictures (e.g. to a copper-diff texture); textures passed in stay the caller's. */
    setFaces({ top, bottom } = {}) {
      for (const [k, f] of [['top', top], ['bottom', bottom]]) {
        if (f === undefined) continue;
        materials[k].dispose();
        materials[k] = faceMaterial(f);
        if (materials[k].map && !(f?.isTexture)) owned.add(materials[k].map);
      }
      body.material = [materials.top, materials.bottom, materials.walls];
    },
    dispose() {
      geo.body.dispose(); geo.barrels?.dispose();
      for (const m of Object.values(materials)) m.dispose();
      for (const t of owned) t.dispose();
    },
  };
  for (const k of ['top', 'bottom']) if (materials[k].map && !faces[k]?.isTexture) owned.add(materials[k].map);
  return result;
}

/** Line loops of an outline at heights `zs` (a ghost edge, e.g. the base board's outline over head's). */
export function outlineGhost(outline, zs = [0], { color = 0xe5534b, opacity = 0.9 } = {}) {
  const group = new THREE.Group();
  group.name = 'outline-ghost';
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false });
  for (const z of zs) {
    for (const loop of [outline.board, ...(outline.cutouts || [])]) {
      if (loop.length < 2) continue;
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(loop.map(([x, y]) => new THREE.Vector3(x, y, z))), material);
      line.renderOrder = 5;
      group.add(line);
    }
  }
  return group;
}
