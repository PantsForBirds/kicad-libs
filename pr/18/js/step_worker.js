// Tessellates STEP files with occt-import-js (OpenCascade compiled to WebAssembly), off the main thread.
// A classic worker because occt-import-js ships a UMD/Emscripten bundle meant for importScripts().
//
// Protocol:  in  {id, cmd: 'load', occtJs, occtWasm, url, bytes?}   (bytes: the file itself, when the page
//                 can't be fetched from here, e.g. offline from file://)
//            out {id, type: 'progress', stage} ...  then  {id, type: 'done', meshes:[...]} | {id, type: 'error', message}
// Meshes: {name, color: [r,g,b]|null, position: Float32Array, normal: Float32Array|null, index: Uint32Array}
// (typed arrays are transferred, not copied).
/* global importScripts, occtimportjs */
'use strict';

let occtPromise = null;

function getOcct(occtJs, occtWasm) {
  if (!occtPromise) {
    importScripts(occtJs);
    occtPromise = occtimportjs({ locateFile: () => occtWasm });
  }
  return occtPromise;
}

self.onmessage = async (ev) => {
  const { id, occtJs, occtWasm, url, bytes: given } = ev.data || {};
  const progress = (stage) => self.postMessage({ id, type: 'progress', stage });
  try {
    progress('starting CAD kernel');
    const occt = await getOcct(occtJs, occtWasm);
    let bytes = given instanceof Uint8Array ? given : null;
    if (!bytes) {
      progress('downloading model');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
      bytes = new Uint8Array(await res.arrayBuffer());
    }
    progress(`tessellating ${(bytes.length / 1e6).toFixed(2)} MB`);
    const result = occt.ReadStepFile(bytes, { linearUnit: 'millimeter' });
    if (!result || !result.success) throw new Error('OpenCascade could not read this STEP file');
    const meshes = [];
    const transfer = [];
    let triangles = 0;
    for (const m of result.meshes || []) {
      const position = new Float32Array(m.attributes.position.array);
      const normal = m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null;
      const index = new Uint32Array(m.index.array);
      triangles += index.length / 3;
      meshes.push({ name: m.name || '', color: m.color || null, position, normal, index });
      transfer.push(position.buffer, index.buffer);
      if (normal) transfer.push(normal.buffer);
    }
    // A kernel that runs out of wasm heap reports success with empty solids; say so instead of showing nothing.
    if (meshes.length && !triangles) throw new Error('OpenCascade returned only empty solids (out of memory?)');
    self.postMessage({ id, type: 'done', meshes, triangles }, transfer);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String((err && err.message) || err) });
  }
};
