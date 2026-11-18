// STEP loading with occt-import-js, in a Worker when one can be started, else on the main thread.
//
// occt-import-js (LGPL-2.1) is not bundled: pass its URLs ({occt: {js, wasm}}) or a factory
// ({occtFactory}). Ported from kipr web/library/js/step_loader.js + view3d.js (colours, polygon
// offset) and gentoo fab/static/fab/viewer3d.js (flatten/meshFor, worker termination on failure).

import * as THREE from '../../../three/three.module.js';
import { stepColorToLinear } from './units.js';

const workers = new Map();     // key -> {worker, pending, broken}
let nextId = 1;

function defaultWorkerUrl() {
  // Undefined import.meta.url (a classic-script bundle) makes this throw: use the main thread.
  try { return new URL('./step_worker.js', import.meta.url).href; } catch { return null; }
}

function getWorker(url) {
  let w = workers.get(url);
  if (w) return w;
  w = { worker: new Worker(url), pending: new Map() };
  w.worker.onmessage = (ev) => {
    const msg = ev.data || {};
    const p = w.pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'progress') p.onProgress?.(msg.stage);
    else {
      w.pending.delete(msg.id);
      if (msg.type === 'done') p.resolve(msg);
      else p.reject(new Error(msg.message || 'STEP load failed'));
    }
  };
  w.worker.onerror = (ev) => {
    ev.preventDefault?.();
    const err = Object.assign(new Error(ev.message || 'STEP worker crashed'), { workerCrashed: true });
    for (const p of w.pending.values()) p.reject(err);
    w.pending.clear();
    w.worker.terminate();
    workers.delete(url);
  };
  workers.set(url, w);
  return w;
}

/** Stop the STEP workers (frees the CAD kernel's heap; the next load starts a fresh one). */
export function terminateStepWorkers() {
  for (const w of workers.values()) {
    for (const p of w.pending.values()) p.reject(new Error('STEP worker terminated'));
    w.worker.terminate();
  }
  workers.clear();
}

const mainThreadOcct = new Map();
function loadOcctScript(js, wasm) {
  if (!mainThreadOcct.has(js)) {
    const p = new Promise((resolve, reject) => {
      if (typeof document === 'undefined') { reject(new Error('no Worker and no occtFactory: cannot load occt-import-js')); return; }
      const s = document.createElement('script');
      s.src = js;
      s.onload = () => (typeof globalThis.occtimportjs === 'function'
        ? globalThis.occtimportjs({ locateFile: () => wasm }).then(resolve, reject)
        : reject(new Error('occt-import-js did not load')));
      s.onerror = () => reject(new Error(`could not load ${js}`));
      document.head.append(s);
    });
    p.catch(() => mainThreadOcct.delete(js));
    mainThreadOcct.set(js, p);
  }
  return mainThreadOcct.get(js);
}

function readWithOcct(occt, bytes) {
  const result = occt.ReadStepFile(bytes, { linearUnit: 'millimeter' });
  if (!result || !result.success) throw new Error('OpenCascade could not read this STEP file');
  let triangles = 0;
  const meshes = (result.meshes || []).map((m) => {
    const index = new Uint32Array(m.index.array);
    triangles += index.length / 3;
    const bf = m.brep_faces || [];
    const faces = new Int32Array(bf.length * 2);
    bf.forEach((f, i) => { faces[2 * i] = f.first; faces[2 * i + 1] = f.last; });
    return {
      name: m.name || '', color: m.color || null, index, faces, faceColors: bf.map((f) => f.color || null),
      position: new Float32Array(m.attributes.position.array),
      normal: m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null,
    };
  });
  if (meshes.length && !triangles) throw new Error('OpenCascade returned only empty solids (out of memory?)');
  return { root: result.root, meshes, triangles };
}

async function toBytes(source, signal) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  const res = await fetch(source, { signal, credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${source}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Tessellate a STEP file. No three.js involved.
 * source: URL string | ArrayBuffer | Uint8Array.
 * opts: {occt: {js, wasm}} URLs of occt-import-js, and/or occtFactory: () => Promise<occt>;
 *   workerUrl (default: step_worker.js beside this module; false = main thread); onProgress(stage);
 *   fallback (default true): when the Worker crashes (usually out of wasm heap), retry on the main
 *   thread; false rejects instead (the error has workerCrashed: true), for hosts that would rather
 *   say so than risk the page on a model that just exhausted a worker.
 * Resolves to {root, meshes, triangles} (occt's node tree; meshes with typed arrays).
 */
export async function readStep(source, opts = {}) {
  const { occt = null, occtFactory = null, onProgress = null, signal, fallback = true } = opts;
  const workerUrl = opts.workerUrl === undefined ? defaultWorkerUrl() : opts.workerUrl;
  const mainThread = async (bytes) => {
    onProgress?.('starting CAD kernel (main thread)');
    const kernel = occtFactory ? await occtFactory() : await loadOcctScript(occt.js, occt.wasm);
    const data = bytes || await toBytes(source, signal);
    onProgress?.(`tessellating ${(data.length / 1e6).toFixed(2)} MB`);
    return readWithOcct(kernel, data);
  };
  if (!occt && !occtFactory) throw new Error('loadSTEP needs {occt: {js, wasm}} or {occtFactory}');
  if (!occt || !workerUrl || typeof Worker === 'undefined') return mainThread(null);

  let w;
  try { w = getWorker(workerUrl); } catch { return mainThread(null); }   // CSP, file://
  // Strings are fetched in the worker; bytes are transferred (a copy is kept for a fallback).
  const given = typeof source === 'string' || source instanceof URL ? null : await toBytes(source, signal);
  const abs = given ? null : new URL(String(source), globalThis.document?.baseURI || globalThis.location?.href).href;
  const copy = given ? given.slice() : null;
  try {
    return await new Promise((resolve, reject) => {
      const id = nextId++;
      w.pending.set(id, { resolve, reject, onProgress });
      const msg = { id, occtJs: new URL(occt.js, globalThis.document?.baseURI || globalThis.location?.href).href,
        occtWasm: new URL(occt.wasm, globalThis.document?.baseURI || globalThis.location?.href).href, url: abs };
      if (given) { msg.bytes = given; w.worker.postMessage(msg, [given.buffer]); } else w.worker.postMessage(msg);
    });
  } catch (err) {
    if (!err.workerCrashed || !fallback) throw err;
    return mainThread(copy);
  }
}

/** Mesh material for a STEP colour, in KiCad's colour handling (see stepColorToLinear). */
export function stepMaterial(rgb, { polygonOffset = true } = {}) {
  const c = stepColorToLinear(rgb);
  return new THREE.MeshStandardMaterial({
    color: c ? new THREE.Color(c[0], c[1], c[2]) : new THREE.Color(0xb4b6bc),
    metalness: 0.1, roughness: 0.6, side: THREE.DoubleSide,
    // Pushes steep faces (hole walls seen edge-on from top/bottom) behind coplanar footprint
    // copper; flat faces barely move. See src/scene for the depth range fitting that goes with it.
    polygonOffset, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
}

function meshFor(m, materialFor) {
  const g = new THREE.BufferGeometry();
  // A copy: centring translates it, and readStep()'s arrays may be used again (a cached tessellation).
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m.position), 3));
  if (m.normal && m.normal.length === m.position.length) g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
  g.setIndex(new THREE.BufferAttribute(m.index, 1));
  if (!g.attributes.normal) g.computeVertexNormals();
  // Per-face colours (a body with a coloured pin-1 face): one geometry group per run of a colour.
  const colours = [];
  const key = (c) => (c ? c.map((v) => v.toFixed(4)).join(',') : 'mesh');
  if (m.faceColors?.some(Boolean)) {
    let start = 0, current = null;
    for (let i = 0; i < m.faceColors.length; i++) {
      const k = key(m.faceColors[i] || m.color);
      const first = m.faces[2 * i] * 3, end = (m.faces[2 * i + 1] + 1) * 3;
      if (current !== k) {
        if (current !== null) g.addGroup(start, first - start, colours.indexOf(current));
        if (!colours.includes(k)) colours.push(k);
        current = k; start = first;
      }
      if (i === m.faceColors.length - 1) g.addGroup(start, end - start, colours.indexOf(current));
    }
  }
  const material = colours.length > 1
    ? colours.map((k) => materialFor(k === 'mesh' ? m.color : k.split(',').map(Number)))
    : materialFor(colours.length ? (colours[0] === 'mesh' ? m.color : colours[0].split(',').map(Number)) : m.color);
  if (!Array.isArray(material)) g.clearGroups();
  const mesh = new THREE.Mesh(g, material);
  mesh.name = m.name || '';
  return mesh;
}

/**
 * Build three objects from readStep()'s result: a Group (STEP frame: mm, z up) with one child
 * Group per occt node that has geometry, named after the node (or its nearest named ancestor) and
 * placed at its box middle so it can be matched and moved like a GLB node. With center: false each
 * group stays at the origin and its vertices keep occt's absolute coordinates.
 * Materials are shared between meshes of one colour: clone them before changing one mesh's.
 */
export function stepToObject(data, { polygonOffset = true, center = true } = {}) {
  const cache = new Map();
  const materialFor = (rgb) => {
    const k = rgb ? rgb.join(',') : 'none';
    if (!cache.has(k)) cache.set(k, stepMaterial(rgb, { polygonOffset }));
    return cache.get(k);
  };
  const out = new THREE.Group();
  out.name = data.root?.name || 'step';
  const used = new Set();
  const visit = (node, inherited) => {
    const name = node.name || inherited || '';
    const own = (node.meshes || []).map((i) => data.meshes[i]).filter(Boolean);
    if (own.length) {
      const group = new THREE.Group();
      group.name = name;
      for (const m of own) { used.add(m); group.add(meshFor(m, materialFor)); }
      if (center) {
        const box = new THREE.Box3().setFromObject(group);
        const c = box.getCenter(new THREE.Vector3());
        for (const child of group.children) child.geometry.translate(-c.x, -c.y, -c.z);
        group.position.copy(c);
      }
      out.add(group);
    }
    for (const child of node.children || []) visit(child, name);
  };
  if (data.root) visit(data.root, '');
  // Meshes the tree does not reference (should not happen) still get drawn.
  for (const m of data.meshes) if (!used.has(m)) out.add(meshFor(m, materialFor));
  out.userData.triangles = data.triangles;
  return out;
}

/** readStep + stepToObject. Resolves to a THREE.Group in the STEP frame (mm, z up). */
export async function loadSTEP(source, opts = {}) {
  return stepToObject(await readStep(source, opts), opts);
}
