// KiCad-like lighting and background, without network access. Ported from kipr
// web/library/js/view3d.js (kipr PR #14), moved from its y-up scene into the z-up board frame.

import * as THREE from '../../../three/three.module.js';
import { RoomEnvironment } from '../../../three/addons/environments/RoomEnvironment.js';

export const BACKGROUNDS = {
  light: ['#d2d4ea', '#8a8ca6'],
  dark: ['#3a3d4a', '#15161b'],
};

/** Vertical two-stop gradient [top, bottom] like KiCad's 3D viewer background. */
export function gradientTexture([top, bottom]) {
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

/**
 * Generated studio environment (PMREM of RoomEnvironment, no download) so metal pads and
 * connector shells have something to reflect. Returns the PMREM render target: use its .texture,
 * dispose() the target itself (disposing only the texture leaks GPU memory).
 */
export function roomEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const target = pmrem.fromScene(room, 0.04);
  room.dispose?.();
  pmrem.dispose();
  return target;
}

/**
 * Even fill from every side, a weak key from above and a headlight that follows the camera
 * (call update() before each draw), so the bottom view is lit as well as the top.
 * Returns {group, headlight, update(camera, target), dispose()}.
 */
export function kicadLights() {
  const group = new THREE.Group();
  group.name = 'boarddd-lights';
  group.add(new THREE.AmbientLight(0xffffff, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 0.35);
  key.position.set(40, -50, 80);
  group.add(key);
  const headlight = new THREE.DirectionalLight(0xffffff, 1.4);
  group.add(headlight, headlight.target);
  return {
    group,
    headlight,
    update(camera, target) {
      headlight.position.copy(camera.position);
      headlight.target.position.copy(target);
      headlight.target.updateMatrixWorld();
    },
    dispose() { for (const l of group.children) l.dispose?.(); },
  };
}
