// Third-party libraries, pinned. Unmodified upstream builds from jsDelivr:
//   three.js 0.185.1 (MIT)              https://github.com/mrdoob/three.js
//   occt-import-js 0.0.23 (LGPL-2.1)    https://github.com/kovacsv/occt-import-js  (OpenCascade: LGPL-2.1 + exception)
// To self-host, drop the same files under viewer/vendor/ with their LICENSE files and point these at them.
export const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.185.1/+esm';
export const THREE_ADDONS = 'https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/';
export const OCCT_JS = 'https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/dist/occt-import-js.js';
export const OCCT_WASM = 'https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/dist/occt-import-js.wasm';
