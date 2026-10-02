// 3D view of a footprint: the part (STEP) on its footprint on a small piece of board, base vs head.
//
// Interface used by panel3d.js (keep it small so loaders/renderers can be swapped):
//     const v = await create3DViewer(container, { dark, onStatus })
//     await v.load({ head: SideSpec|null, base: SideSpec|null })
//     v.setMode('head'|'base'|'side'|'overlay'); v.setGroupVisible(name, bool); v.setView('top'|'bottom'|'side'|'iso'|'reset')
//     v.groups() -> [{name, label, visible}];  v.destroy()
// SideSpec = { geom: <geom.json object>|null, layers: {"F.Cu": url, ...}|null,
//              models: [{ url, label, offset:[x,y,z], rotate:[x,y,z], scale:[x,y,z] }] }
// Model files are loaded by extension through MODEL_LOADERS (STEP via occt-import-js in a Worker today).
import { THREE_URL, THREE_ADDONS } from './config.js';
import { modelMatrix, BOARD_THICKNESS } from './kicad3d.js';
import { buildBoard } from './board3d.js';
import { loadStep } from './step_loader.js';

export const GROUPS = [
  { name: 'board', label: 'Board' },
  { name: 'pads', label: 'Pads' },
  { name: 'silk', label: 'Silk' },
  { name: 'fab', label: 'Fab/Courtyard', defaultOff: true },
  { name: 'model', label: '3D model' },
];
const OVERLAY_COLORS = { head: 0x22c3ff, base: 0xff3d9a };

let libPromise = null;
function loadLibs() {
  libPromise ??= Promise.all([import(THREE_URL), import(`${THREE_ADDONS}controls/OrbitControls.js/+esm`),
    import(`${THREE_ADDONS}environments/RoomEnvironment.js/+esm`)])
    .then(([THREE, oc, re]) => ({ THREE, OrbitControls: oc.OrbitControls, RoomEnvironment: re.RoomEnvironment }));
  return libPromise;
}

/** Loaders by file extension; each resolves to a THREE.Object3D in the model's own (STEP) frame, mm. */
export const MODEL_LOADERS = {
  async step(THREE, url, onProgress) {
    const { meshes } = await loadStep(url, onProgress);
    const group = new THREE.Group();
    for (const m of meshes) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
      if (m.normal && m.normal.length === m.position.length) g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
      g.setIndex(new THREE.BufferAttribute(m.index, 1));
      if (!g.attributes.normal) g.computeVertexNormals();
      const color = stepColor(THREE, m.color);
      // A small positive offset pushes steep faces (hole walls seen edge-on from the Top/Bottom presets) behind the
      // footprint copper they touch; flat faces barely move. Rendering only, see padMat in board3d.js.
      const mat = new THREE.MeshStandardMaterial({
        color, metalness: 0.1, roughness: 0.6, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      });
      group.add(new THREE.Mesh(g, mat));
    }
    return group;
  },
};
MODEL_LOADERS.stp = MODEL_LOADERS.step;

/**
 * three.js colour for a STEP colour from occt-import-js. OpenCascade hands back linear RGB (it decodes the file's
 * COLOUR_RGB values as sRGB). KiCad's 3D viewer uses the file's values unconverted as its shading colour, which is
 * what model authors tune for (the RP2040-Zero board 0.09/0.22/0.42 reads mid-blue there), so do the same: re-encode
 * to the file's values and use those as linear working-space values.
 */
export function stepColor(THREE, rgb) {
  if (!rgb) return new THREE.Color(0xb4b6bc);
  return new THREE.Color(rgb[0], rgb[1], rgb[2]).convertLinearToSRGB();
}

export function modelLoaderFor(url) {
  const ext = String(url).split('?')[0].split('.').pop().toLowerCase();
  return MODEL_LOADERS[ext] || null;
}

/** Vertical two-stop gradient (top, bottom) like KiCad's 3D viewer background. */
function gradientTexture(THREE, [top, bottom]) {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, c.height);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export async function create3DViewer(container, { dark = false, onStatus = () => {} } = {}) {
  const { THREE, OrbitControls, RoomEnvironment } = await loadLibs();

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setScissorTest(true);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.append(renderer.domElement);
  // Generated studio environment (no download) so metal pads and connector shells have something to reflect.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 5000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.screenSpacePanning = true;

  const bg = new THREE.Color(dark ? 0x1b1d22 : 0xe9ecf0);
  const bgTexture = gradientTexture(THREE, dark ? ['#3a3d4a', '#15161b'] : ['#d2d4ea', '#8a8ca6']);
  const sides = { head: null, base: null }; // {scene, root}
  const visible = Object.fromEntries(GROUPS.map((g) => [g.name, !g.defaultOff]));
  const present = new Set();
  let mode = 'head';
  let lastView = 'iso';
  const center = new THREE.Vector3();
  let radius = 10;
  const bounds = new THREE.Sphere(new THREE.Vector3(), 10); // bounds of everything drawn, for near/far

  function makeScene() {
    const scene = new THREE.Scene();
    scene.background = bgTexture;
    scene.environment = envMap;
    scene.environmentIntensity = 0.15;
    // KiCad-like: even fill from every side, a key from above and a headlight that follows the camera
    // (set in render()), so the Bottom view is lit as well as the Top.
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 0.35);
    key.position.set(40, 80, 50);
    scene.add(key);
    const head = new THREE.DirectionalLight(0xffffff, 1.4);
    scene.add(head, head.target);
    scene.userData.headlight = head;
    // Board frame (KiCad 3D: z up out of the board) -> three.js y-up
    const root = new THREE.Group();
    root.rotation.x = -Math.PI / 2;
    scene.add(root);
    return { scene, root };
  }

  async function buildSide(side, spec) {
    if (!spec) return null;
    const s = makeScene();
    if (spec.geom?.bbox) {
      const board = await buildBoard(THREE, { geom: spec.geom, layers: spec.layers, maxAnisotropy });
      s.root.add(board.root);
      present.add('board');
      if (board.padCount) present.add('pads');
      if (board.hasSilk) present.add('silk');
      if (board.hasFab) present.add('fab');
    } else {
      onStatus({ side, text: 'no footprint geometry (geom) in the manifest: showing the 3D model only' });
    }
    const models = spec.models || [];
    if (models.length) present.add('model');
    const results = await Promise.allSettled(models.map(async (m, i) => {
      const loader = modelLoaderFor(m.url);
      if (!loader) throw new Error(`${m.label || m.url}: no browser loader for this file type`);
      const obj = await loader(THREE, m.url, (stage) => onStatus({ side, text: `${m.label || 'model'}: ${stage}` }));
      const holder = new THREE.Group();
      holder.name = `model:${m.label || i}`;
      holder.userData.group = 'model';
      holder.matrixAutoUpdate = false;
      holder.matrix.fromArray(modelMatrix(m));
      holder.add(obj);
      obj.traverse((o) => { if (o.isMesh) o.userData.group = 'model'; });
      s.root.add(holder);
      return m.label;
    }));
    const failed = results.map((r, i) => (r.status === 'rejected' ? `${models[i].label || 'model'}: ${r.reason?.message || r.reason}` : null)).filter(Boolean);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    onStatus({ side, done: true, text: models.length ? `${ok}/${models.length} 3D model(s) loaded` : 'no 3D model file for this side', errors: failed });
    return s;
  }

  function forEachTagged(fn) {
    for (const [side, s] of Object.entries(sides)) {
      s?.root.traverse((o) => { if (o.isMesh && o.userData.group) fn(o, side); });
    }
  }

  function applyVisibility() {
    invalidate();
    forEachTagged((o, side) => {
      let on = visible[o.userData.group] !== false;
      // overlay: one board (head's) with both sides' copper + models drawn see-through
      if (mode === 'overlay' && side === 'base' && sides.head && !['pads', 'model'].includes(o.userData.group)) on = false;
      o.visible = on;
    });
  }

  function applyOverlayMaterials() {
    invalidate();
    forEachTagged((o, side) => {
      if (!['pads', 'model'].includes(o.userData.group)) return;
      o.userData.origMat ??= o.material;
      if (mode !== 'overlay' || !(sides.head && sides.base)) { o.material = o.userData.origMat; return; }
      o.userData.overlayMat ??= new THREE.MeshStandardMaterial({
        color: OVERLAY_COLORS[side], transparent: true, opacity: 0.45, depthWrite: false, roughness: 0.5, side: THREE.DoubleSide,
      });
      o.material = o.userData.overlayMat;
    });
  }

  function frame() {
    // Frame the part (pads + model), not the board: the board bbox also covers long Value texts.
    const box = new THREE.Box3();
    for (const s of Object.values(sides)) {
      s?.scene.updateMatrixWorld(true);
      s?.root.traverse((o) => { if (o.isMesh && ['pads', 'model'].includes(o.userData.group)) box.expandByObject(o); });
    }
    if (box.isEmpty()) for (const s of Object.values(sides)) if (s) box.expandByObject(s.root);
    if (box.isEmpty()) return;
    box.expandByScalar(0.5);
    box.getCenter(center);
    radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
    const all = new THREE.Box3();
    for (const s of Object.values(sides)) if (s) all.expandByObject(s.root);
    (all.isEmpty() ? box : all).getBoundingSphere(bounds);
  }

  // Depth precision: fit near/far to what is drawn, from where the camera is now (every frame, since the user
  // zooms). The footprint copper and a STEP body can be ~10 um apart (castellated modules), which a fixed
  // radius/200 .. radius*200 range cannot resolve from a normal viewing distance.
  function fitClipPlanes() {
    const d = camera.position.distanceTo(bounds.center);
    const far = d + bounds.radius * 1.05;
    camera.near = Math.max(d - bounds.radius * 1.05, far / 2000, 1e-4);
    camera.far = far;
  }

  function setView(name) {
    lastView = name;
    const w = (container.clientWidth || 400) / (mode === 'side' ? 2 : 1);
    const h = container.clientHeight || 300;
    const vfov = (camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * (w / h));
    const d = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.02;
    const dirs = {
      top: [0, 1, 1e-4], bottom: [0, -1, 1e-4], side: [0, 0.18, 1], iso: [0.7, 0.85, 1], reset: [0.7, 0.85, 1],
    };
    const v = new THREE.Vector3(...(dirs[name] || dirs.iso)).normalize().multiplyScalar(d);
    camera.position.copy(center).add(v);
    // top: PCB +y (scene +z) points down the screen, like KiCad; bottom: looking up, mirrored like flipping the board
    camera.up.set(0, 1, 0);
    if (name === 'top') camera.up.set(0, 0, -1);
    if (name === 'bottom') camera.up.set(0, 0, -1);
    controls.target.copy(center);
    camera.lookAt(center);
    controls.update();
    invalidate();
  }

  let raf = 0;
  let stopped = false;
  // Draw only when something changed (camera incl. damping, size, view/mode/visibility): an idle viewer costs
  // nothing, which matters on laptops and in software GL (CI screenshots).
  let dirty = true;
  const invalidate = () => { dirty = true; };
  controls.addEventListener('change', invalidate);

  function render() {
    if (stopped) return;
    raf = requestAnimationFrame(render);
    const moved = controls.update();
    const w = container.clientWidth || 400;
    const h = container.clientHeight || 300;
    const px = renderer.getPixelRatio();
    if (renderer.domElement.width !== Math.floor(w * px) || renderer.domElement.height !== Math.floor(h * px)) {
      renderer.setSize(w, h, false);
      dirty = true;
    }
    if (!dirty && !moved) return;
    dirty = false;
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.setScissor(0, 0, w, h);
    renderer.setViewport(0, 0, w, h);
    renderer.setClearColor(bg);
    renderer.clear();
    const draw = (s, x, width, clearDepth = false) => {
      if (!s) return;
      renderer.setViewport(x, 0, width, h);
      renderer.setScissor(x, 0, width, h);
      camera.aspect = width / h;
      fitClipPlanes();
      camera.updateProjectionMatrix();
      if (clearDepth) renderer.clearDepth();
      const head = s.scene.userData.headlight;
      head.position.copy(camera.position);
      head.target.position.copy(controls.target);
      renderer.render(s.scene, camera);
    };
    renderer.autoClear = false;
    if (mode === 'side') {
      const half = Math.floor(w / 2);
      draw(sides.base, 0, half);
      draw(sides.head, half + 1, w - half - 1);
    } else if (mode === 'overlay') {
      draw(sides.head || sides.base, 0, w);
      if (sides.head && sides.base) {
        // same depth buffer, so base parts sort correctly against the head board/parts
        const saved = sides.base.scene.background;
        sides.base.scene.background = null;
        draw(sides.base, 0, w);
        sides.base.scene.background = saved;
      }
    } else {
      draw(sides[mode] || sides.head || sides.base, 0, w);
    }
  }

  return {
    async load({ head, base }) {
      const [h, b] = await Promise.all([buildSide('head', head), buildSide('base', base)]);
      sides.head = h;
      sides.base = b;
      mode = sides.head ? 'head' : 'base';
      applyVisibility();
      frame();
      setView('iso');
      if (!raf) render();
    },
    setMode(m) {
      const reframe = (m === 'side') !== (mode === 'side');
      mode = m;
      applyOverlayMaterials();
      applyVisibility();
      if (reframe) setView(lastView);
    },
    setGroupVisible(name, on) { visible[name] = on; applyVisibility(); },
    groups: () => GROUPS.filter((g) => present.has(g.name)).map((g) => ({ name: g.name, label: g.label, visible: visible[g.name] })),
    setView,
    /** For tests: world-space bounding boxes of each group per side (board frame -> scene). */
    debugBoxes() {
      const out = {};
      for (const [side, s] of Object.entries(sides)) {
        if (!s) continue;
        out[side] = {};
        s.scene.updateMatrixWorld(true);
        const boxes = {};
        s.root.traverse((o) => {
          if (!o.isMesh || !o.userData.group) return;
          (boxes[o.userData.group] ??= new THREE.Box3()).expandByObject(o);
        });
        for (const [g, bx] of Object.entries(boxes)) {
          // report in board frame: x, y_board = -scene z, z_board = scene y
          out[side][g] = { min: [bx.min.x, -bx.max.z, bx.min.y], max: [bx.max.x, -bx.min.z, bx.max.y] };
        }
      }
      return out;
    },
    boardThickness: BOARD_THICKNESS,
    destroy() {
      stopped = true;
      cancelAnimationFrame(raf);
      controls.dispose();
      envMap.dispose();
      bgTexture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
