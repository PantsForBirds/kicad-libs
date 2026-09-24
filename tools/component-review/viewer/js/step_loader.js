// Main-thread side of step_worker.js: one shared worker, requests queued by id, results cached per URL.
import { OCCT_JS, OCCT_WASM } from './config.js';

let worker = null;
let nextId = 1;
const pending = new Map();
const cache = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./step_worker.js', import.meta.url));
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
    for (const p of pending.values()) p.reject(new Error(ev.message || 'STEP worker crashed'));
    pending.clear();
    worker = null;
  };
  return worker;
}

/** Resolve to {meshes, triangles} for a STEP file URL (relative to the page). */
export function loadStep(url, onProgress) {
  const abs = new URL(url, document.baseURI).href;
  if (!cache.has(abs)) {
    const promise = new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, onProgress });
      getWorker().postMessage({ id, occtJs: OCCT_JS, occtWasm: OCCT_WASM, url: abs });
    });
    promise.catch(() => cache.delete(abs));
    cache.set(abs, promise);
  }
  return cache.get(abs);
}
