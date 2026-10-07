// Entry point, a classic script so it also runs from file:// (a downloaded, unzipped CI artifact).
//
//   http(s)  (GitHub Pages, serve.py): tighten the CSP back to what the ES-module app needs (no eval,
//            workers only from 'self') and load js/app.js as a module, exactly as before.
//   file://  browsers block module scripts, fetch() and file workers there, so load data.js
//            (manifest + review + diffs, written by kipr library site) and js/bundle.js, the same modules
//            concatenated into one classic script. The 3D view then starts its STEP worker from a blob:
//            URL, and occt-import-js needs 'unsafe-eval' in such a worker (index.html allows it for that).
(function () {
  'use strict';
  function add(src, module) {
    var s = document.createElement('script');
    if (module) s.type = 'module';
    s.src = src;
    s.async = false; // keep insertion order
    document.head.appendChild(s);
  }
  if (location.protocol === 'file:') {
    add('data.js');
    add('js/bundle.js');
    return;
  }
  var csp = document.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = "script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'; worker-src 'self'";
  document.head.appendChild(csp);
  add('js/app.js', true);
}());
