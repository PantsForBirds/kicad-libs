// The view cube: a labelled cube in the top-right corner showing which way up you are; a click on
// a face looks from that side. Drawn into the viewer's canvas as a second pass with its own
// viewport and a cleared depth buffer (one WebGL context, one resize).
// Ported from kipr web/project/pcba3d/viewcube.js, itself from gentoo fab/static/fab/viewer3d.js.

import * as THREE from '../../../three/three.module.js';

export const CUBE_PX = 84;
const MARGIN = 8;

// BoxGeometry's material order: +x, -x, +y, -y, +z, -z.
const ORDER = ['Right', 'Left', 'Back', 'Front', 'Top', 'Bottom'];
const COLORS = {
  light: { fill: '#f4f6f8', edge: '#8a96a3', text: '#25303b', hover: 0x8ab4f8 },
  dark: { fill: '#2b3540', edge: '#7c8b9a', text: '#e6edf3', hover: 0x8ab4f8 },
};

function faceTexture(label, c) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = c.fill; g.fillRect(0, 0, size, size);
  g.strokeStyle = c.edge; g.lineWidth = 6; g.strokeRect(3, 3, size - 6, size - 6);
  g.fillStyle = c.text; g.font = '600 26px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(label, size / 2, size / 2);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class ViewCube {
  constructor(theme = 'light') {
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 100);
    this.materials = ORDER.map(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.7, 1.7), this.materials);
    this.scene.add(this.mesh);
    this.hover = -1;
    this.raycaster = new THREE.Raycaster();
    this.setTheme(theme);
  }

  setTheme(theme) {
    const c = COLORS[theme] || COLORS.light;
    this.hoverColor = c.hover;
    ORDER.forEach((label, i) => {
      this.materials[i].map?.dispose();
      this.materials[i].map = faceTexture(label, c);
      this.materials[i].needsUpdate = true;
    });
  }

  /** Cube size in CSS px for a width x height canvas; 0 when too small to be worth the corner. */
  size(width, height) {
    const s = Math.min(CUBE_PX, Math.floor(Math.min(width, height) * 0.28));
    return s < 40 ? 0 : s;
  }

  /** Draw over the top-right corner, with the main camera's rotation and none of its position. */
  draw(renderer, camera, target, width, height) {
    const s = this.size(width, height);
    if (!s) return;
    const dir = camera.position.clone().sub(target).normalize();
    this.camera.position.copy(dir.multiplyScalar(5));
    this.camera.up.copy(camera.up);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    const x = width - s - MARGIN, y = height - s - MARGIN;   // GL counts from the bottom
    const autoClear = renderer.autoClear;
    const background = this.scene.background;
    renderer.setScissorTest(true);
    renderer.setViewport(x, y, s, s);
    renderer.setScissor(x, y, s, s);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);       // no colour clear: the board shows around it
    renderer.autoClear = autoClear;
    this.scene.background = background;
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, width, height);
  }

  /** Face name under a canvas point (CSS px), '' for the corner but not the cube, null elsewhere. */
  faceAt(px, py, width, height) {
    const s = this.size(width, height);
    if (!s) return null;
    const left = width - s - MARGIN;
    if (px < left || px > width - MARGIN + 2 || py > s + MARGIN || py < MARGIN - 2) return null;
    const ndc = new THREE.Vector2(((px - left) / s) * 2 - 1, -((py - MARGIN) / s) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    return hit ? ORDER[hit.face.materialIndex] : '';
  }

  /** Canvas point (CSS px) of a face's middle, for tests and automation; null if hidden. */
  facePoint(face, width, height) {
    const s = this.size(width, height);
    if (!s) return null;
    const i = ORDER.indexOf(face);
    const n = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]][i];
    const p = new THREE.Vector3(...n).multiplyScalar(0.85).project(this.camera);
    if (p.z > 1 || new THREE.Vector3(...n).dot(this.camera.position) <= 0) return null;
    return { x: width - s - MARGIN + ((p.x + 1) / 2) * s, y: MARGIN + ((1 - p.y) / 2) * s };
  }

  /** Light the face under the pointer; returns whether anything changed. */
  setHover(face) {
    const i = face ? ORDER.indexOf(face) : -1;
    if (i === this.hover) return false;
    if (this.hover >= 0) this.materials[this.hover].color.setHex(0xffffff);
    this.hover = i;
    if (i >= 0) this.materials[i].color.setHex(this.hoverColor);
    return true;
  }

  dispose() {
    for (const m of this.materials) { m.map?.dispose(); m.dispose(); }
    this.mesh.geometry.dispose();
  }
}
