// GLB / glTF loading (kicad-cli pcb export glb, or any glTF). Ported from kipr
// web/project/pcba3d/scene.js (parseGlb) and assets.js.

import { GLTFLoader } from '../../../three/addons/loaders/GLTFLoader.js';

/**
 * Load a GLB. source: URL string | ArrayBuffer | Uint8Array.
 * Resolves to {scene, gltf, meshName(object) -> the glTF mesh name of a loaded object or ''}.
 * KiCad 10 leaves board body nodes unnamed and puts the kind in the mesh name, which three only
 * exposes through the parser's associations: prepareModel takes meshName for that.
 */
export async function loadGLB(source, { signal, loader = null } = {}) {
  let buffer = source;
  if (source instanceof Uint8Array) buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  else if (!(source instanceof ArrayBuffer)) {
    const res = await fetch(source, { signal, credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${source}`);
    buffer = await res.arrayBuffer();
  }
  const gltf = await new Promise((resolve, reject) => {
    (loader || new GLTFLoader()).parse(buffer, '', resolve, (e) => reject(e instanceof Error ? e : new Error(String(e?.message || e))));
  });
  const parser = gltf.parser;
  const meshName = (obj) => {
    const idx = parser?.associations?.get(obj)?.meshes;
    return idx === undefined ? '' : parser.json.meshes?.[idx]?.name || '';
  };
  return { scene: gltf.scene, gltf, meshName };
}
