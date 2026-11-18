// Where the STEP loader (boarddd/models readStep) gets occt-import-js: the vendored copy in vendor/.
//   http(s): its URLs; boarddd tessellates in a Worker (vendor/boarddd/src/models/step_worker.js).
//   file://  workers and fetch() are blocked: occt-import-js is loaded with a plain <script> and runs on
//            the main thread, its WASM bytes coming from the pack offline/occt-import-js.js that
//            kipr library site writes (window.CR_OCCT_WASM, base64).
import { OFFLINE } from './util.js';

const OCCT_JS = new URL('../vendor/occt-import-js/dist/occt-import-js.js', import.meta.url).href;
const OCCT_WASM = new URL('../vendor/occt-import-js/dist/occt-import-js.wasm', import.meta.url).href;
const WASM_PACK = 'offline/occt-import-js.js';

function script(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(s);
  });
}

let kernel = null;
function offlineKernel() {
  kernel ??= (async () => {
    if (typeof window.occtimportjs !== 'function') await script(OCCT_JS);
    if (typeof window.CR_OCCT_WASM !== 'string') await script(WASM_PACK);
    if (typeof window.occtimportjs !== 'function' || typeof window.CR_OCCT_WASM !== 'string') {
      throw new Error('occt-import-js is not in this report (rebuild it with kipr library site)');
    }
    const bin = atob(window.CR_OCCT_WASM);
    const wasmBinary = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) wasmBinary[i] = bin.charCodeAt(i);
    return window.occtimportjs({ wasmBinary });
  })();
  kernel.catch(() => { kernel = null; });
  return kernel;
}

/** readStep options: {occt: {js, wasm}} over http, a main-thread occt factory from file://. */
export async function stepOptions() {
  if (OFFLINE) return { occtFactory: offlineKernel, workerUrl: false };
  return { occt: { js: OCCT_JS, wasm: OCCT_WASM } };
}
