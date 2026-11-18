// Turning a loaded model (GLB scene or STEP group) into a board-frame object whose parts are
// known: the board's own bodies (substrate / mask / copper / silk) and components keyed by
// reference designator. Ported from kipr web/project/pcba3d/scene.js (prepareSide, mergeObject,
// disposeObject) with gentoo fab/static/fab/viewer3d.js's flatness rule and board measurement.

import * as THREE from '../../../three/three.module.js';
import { mergeGeometries } from '../../../three/addons/utils/BufferGeometryUtils.js';
import { mapNodesToRefs, refFromName, boardKindFromName, boardKindFromLook, flatness, measureBoard } from './match.js';
import { detectUp, detectScale } from './units.js';

// Board body kind -> the userData.group the rest of boarddd uses for visibility toggles.
export const PART_GROUP = { substrate: 'board', mask: 'mask', copper: 'copper', silk: 'silk' };

/**
 * Collapse everything under `obj` into one mesh per material, in obj's own frame, and put the
 * result in obj's place. kicad-cli writes one glTF primitive per face set (thousands of draw calls
 * for a small board); merged, a component is a handful of meshes. Returns the replacement Group.
 */
export function mergeObject(obj) {
  obj.updateMatrixWorld(true);
  const inverse = obj.matrixWorld.clone().invert();
  const groups = new Map();
  obj.traverse((n) => {
    if (!n.isMesh || !n.geometry?.attributes?.position) return;
    const material = Array.isArray(n.material) ? n.material[0] : n.material;
    const keep = new Set(['position', 'normal', ...(material?.map ? ['uv'] : [])]);
    const g = n.geometry.clone();
    for (const name of Object.keys(g.attributes)) if (!keep.has(name)) g.deleteAttribute(name);
    g.morphAttributes = {};
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.index) {
      const count = g.attributes.position.count;
      const index = new (count > 65535 ? Uint32Array : Uint16Array)(count);
      for (let i = 0; i < count; i++) index[i] = i;
      g.setIndex(new THREE.BufferAttribute(index, 1));
    }
    g.clearGroups();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, n.matrixWorld));
    const key = `${material ? material.uuid : 'none'}:${[...keep].join()}`;
    if (!groups.has(key)) groups.set(key, { material, list: [] });
    groups.get(key).list.push(g);
  });
  const out = new THREE.Group();
  out.name = obj.name;
  out.userData = { ...obj.userData };
  out.position.copy(obj.position);
  out.quaternion.copy(obj.quaternion);
  out.scale.copy(obj.scale);
  for (const { material, list } of groups.values()) {
    const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
    if (!merged) continue;
    for (const g of list) if (g !== merged) g.dispose();
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    const mesh = new THREE.Mesh(merged, material || new THREE.MeshStandardMaterial({ color: 0x9aa4ae }));
    mesh.name = obj.name;
    out.add(mesh);
  }
  const parent = obj.parent;
  if (parent) {
    parent.children[parent.children.indexOf(obj)] = out;
    out.parent = parent;
    obj.parent = null;
  }
  out.updateMatrixWorld(true);
  return out;
}

/** Free an object's GPU memory: geometries, materials (incl. swapped-out originals), textures. */
export function disposeObject(root) {
  const seen = new Set();
  root.traverse((n) => {
    if (n.geometry) n.geometry.dispose();
    for (const m of [n.material, n.userData?.orig].flat().filter(Boolean)) {
      if (seen.has(m)) continue;
      seen.add(m);
      for (const key of Object.keys(m)) if (m[key] && m[key].isTexture) m[key].dispose();
      m.dispose?.();
    }
  });
}

const hasMesh = (node) => { let f = false; node.traverse((n) => { if (n.isMesh) f = true; }); return f; };
// One body: a mesh, or a group of nothing but meshes (a multi-primitive glTF mesh).
const isLeafish = (node) => node.isMesh || (node.children.length > 0 && node.children.every((c) => c.isMesh && c.children.length === 0));
const worldBox = (obj) => new THREE.Box3().setFromObject(obj);
const boxArrays = (b) => ({ min: b.min.toArray(), max: b.max.toArray() });

function firstColor(node) {
  let color = null;
  node.traverse((n) => {
    if (color || !n.isMesh) return;
    const m = Array.isArray(n.material) ? n.material[0] : n.material;
    if (m && m.color) color = m.color;
  });
  return color;
}

// The names a node goes by: its own, its first mesh's, and the glTF mesh name.
function namesOf(node, meshName) {
  const names = [node.name];
  const mesh = node.isMesh ? node : node.children.find((c) => c.isMesh);
  if (mesh && mesh !== node) names.push(mesh.name);
  if (mesh && meshName) names.push(meshName(mesh), meshName(node));
  return names.filter(Boolean).join(' ');
}

/**
 * Rotate and scale `inner` so it is z-up and in mm. Up: stated, else the thinnest axis. Units:
 * stated, else the scale that matches boardSizeMm, else metres if under 2 units across.
 */
export function orientModel(inner, { up = null, units = null, boardSizeMm = null } = {}) {
  inner.updateMatrixWorld(true);
  const axis = detectUp(worldBox(inner).getSize(new THREE.Vector3()).toArray(), up);
  if (axis === 'y') inner.rotation.x = Math.PI / 2;          // (x, y, z) -> (x, -z, y)
  else if (axis === 'x') inner.rotation.y = -Math.PI / 2;
  inner.updateMatrixWorld(true);
  const s = worldBox(inner).getSize(new THREE.Vector3());
  const expected = boardSizeMm ? Math.max(boardSizeMm[0] || 0, boardSizeMm[1] || 0) : 0;
  const scale = detectScale(Math.max(s.x, s.y), { units, expectedMm: expected });
  inner.scale.setScalar(scale);
  inner.updateMatrixWorld(true);
  return { up: axis, scale };
}

/**
 * Place a model in the board frame and name its parts.
 *
 *   model       a loadGLB() result, a GLTFLoader result, a loadSTEP() group or any Object3D
 *   components  [{ref, x, y, side?, assembly?, box?}] KiCad mm (y down); see mapNodesToRefs
 *   opts        boardSize [w, h] mm and boardOrigin [x, y] (KiCad top-left corner) if known;
 *               units / up if known (measured otherwise); merge (default true) collapses each part
 *               to one mesh per material; seat (default true) moves the substrate's bottom to z = 0;
 *               boardBodies: measured board body boxes for splitBoardBodies-style claiming.
 *
 * Returns {root, parts, comps, loose, meshes, board, boardBox, bounds, report}.
 *   parts: {substrate, mask, copper, silk} -> [Object3D]
 *   comps: Map ref -> {ref, objects, meshes, component, box, bottom}
 *   board: {bottom, top, thickness} measured from the substrate (before seating), or null
 * Every mesh gets userData.group ('model' | 'board' | 'mask' | 'copper' | 'silk'), userData.orig
 * (its own material) and, for components, userData.ref.
 */
export function prepareModel(model, components = [], opts = {}) {
  const { boardSize = null, boardOrigin = null, units = null, up = null, merge = true, seat = true } = opts;
  const inner = model.scene || model;
  const meshName = model.meshName || (model.parser ? ((obj) => {
    const idx = model.parser.associations?.get(obj)?.meshes;
    return idx === undefined ? '' : model.parser.json.meshes?.[idx]?.name || '';
  }) : null);
  const root = new THREE.Group();
  root.name = 'boarddd-model';
  root.add(inner);
  const orientation = orientModel(inner, { up, units, boardSizeMm: boardSize });
  root.updateMatrixWorld(true);

  const refs = new Set(components.map((c) => c.ref));
  const allSize = worldBox(inner).getSize(new THREE.Vector3());
  const boardArea = boardSize?.[0] && boardSize?.[1] ? boardSize[0] * boardSize[1] : Math.max(allSize.x * allSize.y, 1e-6);
  const take = (o) => (merge ? mergeObject(o) : o);

  const parts = { substrate: [], mask: [], copper: [], silk: [] };
  const candidates = [];
  const wide = [];
  (function visit(node) {
    if (!hasMesh(node)) return;
    if (node !== inner && refFromName(node.name, refs)) { candidates.push(take(node)); return; }
    const leaf = isLeafish(node);
    const named = leaf ? boardKindFromName(namesOf(node, meshName)) : null;
    if (named) { parts[named].push(take(node)); return; }
    const box = worldBox(node);
    const size = box.getSize(new THREE.Vector3());
    const big = size.x * size.y > 0.4 * boardArea;
    if (!big && node !== inner) { candidates.push(take(node)); return; }
    if (leaf) {
      if (big) wide.push({ node, size });
      else candidates.push(take(node));
      return;
    }
    for (const child of node.children.slice()) visit(child);
  })(inner);
  // Board-wide bodies without a telling name. Films (<= 0.3 mm) go by colour. Of the thick ones,
  // the flattest is the substrate unless one was named; the rest (a shield can over most of the
  // board) are components.
  let haveSubstrate = parts.substrate.length > 0;
  wide.sort((a, b) => flatness(b.size.toArray()) - flatness(a.size.toArray()));
  for (const { node, size } of wide) {
    if (size.z <= 0.3) {
      const hsl = firstColor(node)?.getHSL({}) || null;
      parts[boardKindFromLook(hsl, size.z)].push(take(node));
    } else if (!haveSubstrate && flatness(size.toArray()) > 200) {
      parts.substrate.push(take(node));
      haveSubstrate = true;
    } else candidates.push(take(node));
  }

  const v = new THREE.Vector3();
  const nodes = candidates.map((obj) => {
    obj.getWorldPosition(v);
    const c = worldBox(obj).getCenter(new THREE.Vector3());
    return { name: obj.name, x: v.x, y: v.y, cx: c.x, cy: c.y };
  });

  // Fallback origin when nothing matches: the substrate's box against the known board box.
  let fallbackOffset = null;
  const substrateBox = new THREE.Box3();
  for (const p of parts.substrate) substrateBox.union(worldBox(p));
  if (boardOrigin && boardSize && !substrateBox.isEmpty()) {
    const c = substrateBox.getCenter(new THREE.Vector3());
    fallbackOffset = { x: c.x - (boardOrigin[0] + boardSize[0] / 2), y: c.y + (boardOrigin[1] + boardSize[1] / 2) };
  }

  let match = mapNodesToRefs(nodes, components, { fallbackOffset });
  // An exporter whose y runs the other way: the mirror image matches far better.
  let mirrored = false;
  if (match.method !== 'name' && components.length >= 3) {
    const flipped = mapNodesToRefs(nodes.map((n) => ({ ...n, y: -n.y, cy: -n.cy })), components,
      { fallbackOffset: fallbackOffset && { x: fallbackOffset.x, y: -fallbackOffset.y } });
    if (flipped.byRef.size > match.byRef.size * 1.5 + 1) { match = flipped; mirrored = true; }
  }
  if (mirrored) {
    const flip = new THREE.Group();
    root.remove(inner);
    flip.scale.y = -1;
    flip.add(inner);
    root.add(flip);
  }
  root.position.set(-match.offset.x, -match.offset.y, 0);
  root.updateMatrixWorld(true);

  // Board surfaces, then seat the substrate's bottom on z = 0 (the board frame).
  const bodies = [];
  for (const [kind, list] of Object.entries(parts)) for (const p of list) bodies.push({ kind, box: boxArrays(worldBox(p)) });
  const board = measureBoard(bodies);
  if (seat && board) { root.position.z = -board.bottom; root.updateMatrixWorld(true); }

  const byRef = new Map(components.map((c) => [c.ref, c]));
  const comps = new Map();
  const meshes = [];
  for (const [ref, idx] of match.byRef) {
    const entry = { ref, objects: idx.map((i) => candidates[i]), component: byRef.get(ref), box: new THREE.Box3(), meshes: [] };
    for (const o of entry.objects) {
      o.userData.ref = ref;
      o.userData.home = o.position.clone();
      o.traverse((n) => {
        if (!n.isMesh) return;
        Object.assign(n.userData, { ref, group: 'model', orig: n.material });
        entry.meshes.push(n);
        meshes.push(n);
      });
      entry.box.union(worldBox(o));
    }
    comps.set(ref, entry);
  }
  const loose = match.leftover.map((i) => candidates[i]);
  for (const o of loose) {
    o.userData.home = o.position.clone();
    o.traverse((n) => { if (n.isMesh) Object.assign(n.userData, { group: 'model', orig: n.material }); });
  }
  const boardBox = new THREE.Box3();
  for (const [kind, list] of Object.entries(parts)) {
    for (const p of list) {
      p.userData.boardKind = kind;
      p.userData.home = p.position.clone();
      p.traverse((n) => { if (n.isMesh) Object.assign(n.userData, { boardKind: kind, group: PART_GROUP[kind], orig: n.material }); });
      if (kind === 'substrate') boardBox.union(worldBox(p));
    }
  }
  if (boardBox.isEmpty()) for (const list of Object.values(parts)) for (const p of list) boardBox.union(worldBox(p));
  const midZ = boardBox.isEmpty() ? 0 : (boardBox.min.z + boardBox.max.z) / 2;
  for (const entry of comps.values()) {
    const s = entry.component?.side;
    entry.bottom = s ? s === 'bottom' : entry.box.getCenter(v).z < midZ;
  }

  const report = {
    method: match.method, byName: match.byName, byPosition: match.byPosition,
    matched: comps.size, expected: components.length, ambiguous: match.ambiguous, unmatched: match.unmatched,
    loose: loose.length, offset: match.offset, mirrored, ...orientation, zShift: seat && board ? -board.bottom : 0,
    boardParts: Object.fromEntries(Object.entries(parts).map(([k, l]) => [k, l.length])),
  };
  return { root, parts, comps, loose, meshes, board, boardBox, bounds: worldBox(root), report };
}
