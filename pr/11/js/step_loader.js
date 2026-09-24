// Main-thread side of step_worker.js: one shared worker, requests queued by id, results cached per URL.
//
// Served over http(s) the worker fetches the STEP file itself. Opened from file:// (a downloaded artifact)
// the page can neither start a worker from a file nor fetch files, so the bundle (build_site.py) provides
// the worker's source (window.CR_STEP_WORKER_SRC) to start it from a blob: URL, and the model bytes come from
// the item's offline pack. If no worker can be started at all, occt-import-js runs on the main thread.
import { OCCT_JS, OCCT_WASM } from './config.js';
import { OFFLINE, fetchBytes } from './util.js';

let worker = null;
let workerBroken = false; // the worker failed to start (CSP, file://): use the main thread from now on
let nextId = 1;
const pending = new Map();
const cache = new Map();

function workerUrl() {
  const src = typeof window !== 'undefined' ? window.CR_STEP_WORKER_SRC : null;
  if (typeof src === 'string') return URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  return new URL('./step_worker.js', import.meta.url);
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(workerUrl());
  worker.onmessage = (ev) => {
    const msg = ev.data || {};
    const p = pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'progress') p.onProgress?.(msg.stage);
    else {
      pending.delete(msg.id);
      if (msg.type === 'done') p.resolve(msg);
      else p.reject(new Error(msg.message || 'STEP load failed'));
    }
  };
  worker.onerror = (ev) => {
    workerBroken = true;
    for (const p of pending.values()) p.reject(new Error(ev.message || 'STEP worker crashed'));
    pending.clear();
    worker = null;
  };
  return worker;
}

// --- main-thread fallback (no Worker available) --------------------------------------------------------
let occtPromise = null;
function mainThreadOcct() {
  occtPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = OCCT_JS;
    s.onload = () => (typeof window.occtimportjs === 'function'
      ? window.occtimportjs({ locateFile: () => OCCT_WASM }).then(resolve, reject)
      : reject(new Error('occt-import-js did not load')));
    s.onerror = () => reject(new Error(`could not load ${OCCT_JS}`));
    document.head.append(s);
  });
  occtPromise.catch(() => { occtPromise = null; });
  return occtPromise;
}

async function loadOnMainThread(bytes, onProgress) {
  onProgress?.('starting CAD kernel (main thread)');
  const occt = await mainThreadOcct();
  onProgress?.(`tessellating ${(bytes.length / 1e6).toFixed(2)} MB`);
  const result = occt.ReadStepFile(bytes, { linearUnit: 'millimeter' });
  if (!result || !result.success) throw new Error('OpenCascade could not read this STEP file');
  let triangles = 0;
  const meshes = (result.meshes || []).map((m) => {
    const index = new Uint32Array(m.index.array);
    triangles += index.length / 3;
    return {
      name: m.name || '', color: m.color || null, index,
      position: new Float32Array(m.attributes.position.array),
      normal: m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null,
    };
  });
  if (meshes.length && !triangles) throw new Error('OpenCascade returned only empty solids (out of memory?)');
  return { meshes, triangles };
}

const rawPath = (url) => url.split('/').map(decodeURIComponent).join('/');

async function load(url, abs, onProgress) {
  const bytes = OFFLINE ? await fetchBytes(rawPath(url)) : null;
  let w = null;
  if (!workerBroken) {
    try { w = getWorker(); } catch { workerBroken = true; }
  }
  if (!w) return loadOnMainThread(bytes || await fetchBytes(rawPath(url)), onProgress);
  const copy = bytes ? bytes.slice() : null; // the worker's copy is transferred away
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onProgress });
    const msg = { id, occtJs: OCCT_JS, occtWasm: OCCT_WASM, url: abs };
    if (bytes) {
      msg.bytes = bytes;
      w.postMessage(msg, [bytes.buffer]);
    } else w.postMessage(msg);
  }).catch(async (err) => {
    if (!workerBroken) throw err;
    return loadOnMainThread(copy || await fetchBytes(rawPath(url)), onProgress);
  });
}

/** Resolve to {meshes, triangles} for a STEP file URL (relative to the page). */
export function loadStep(url, onProgress) {
  const abs = new URL(url, document.baseURI).href;
  if (!cache.has(abs)) {
    const promise = load(url, abs, onProgress);
    promise.catch(() => cache.delete(abs));
    cache.set(abs, promise);
  }
  return cache.get(abs);
}
