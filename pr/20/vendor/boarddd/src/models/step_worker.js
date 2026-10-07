// Tessellates STEP files with occt-import-js (OpenCascade in WebAssembly), off the main thread.
// A classic worker: occt-import-js ships an Emscripten bundle meant for importScripts().
// Ported from kipr web/library/js/step_worker.js and gentoo fab/static/fab/step_worker.js.
//
//   in   {id, occtJs, occtWasm, url?, bytes?}
//   out  {id, type: 'progress', stage} ... then {id, type: 'done', root, meshes, triangles} | {id, type: 'error', message}
// meshes: {name, color, position, normal, index, faces: Int32Array [first, last, ...], faceColors: [rgb|null]}
// (typed arrays transferred).
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
      const res = await fetch(url, { credentials: 'same-origin' });
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
      const bf = m.brep_faces || [];
      const faces = new Int32Array(bf.length * 2);
      bf.forEach((f, i) => { faces[2 * i] = f.first; faces[2 * i + 1] = f.last; });
      triangles += index.length / 3;
      meshes.push({ name: m.name || '', color: m.color || null, position, normal, index, faces, faceColors: bf.map((f) => f.color || null) });
      transfer.push(position.buffer, index.buffer, faces.buffer);
      if (normal) transfer.push(normal.buffer);
    }
    // Out of wasm heap looks like success with empty solids: say so.
    if (meshes.length && !triangles) throw new Error('OpenCascade returned only empty solids (out of memory?)');
    self.postMessage({ id, type: 'done', root: result.root, meshes, triangles }, transfer);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String((err && err.message) || err) });
  }
};
