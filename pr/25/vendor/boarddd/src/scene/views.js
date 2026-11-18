// View presets and camera fitting. Pure: no three.js, node-testable.
// Board frame: z up out of the top copper, y up the screen in the top view.

// Bottom keeps y up the screen, so the board reads mirrored left-right, as when it is flipped
// over (KiCad's bottom view). Iso views follow kipr web/project/pcba3d/viewer.js.
export const VIEWS = {
  top: { dir: [0, 0, 1], up: [0, 1, 0] },
  bottom: { dir: [0, 0, -1], up: [0, 1, 0] },
  front: { dir: [0, -1, 0], up: [0, 0, 1] },
  back: { dir: [0, 1, 0], up: [0, 0, 1] },
  right: { dir: [1, 0, 0], up: [0, 0, 1] },
  left: { dir: [-1, 0, 0], up: [0, 0, 1] },
  iso: { dir: [0.55, -1, 0.95], up: [0, 0, 1] },
  isoBottom: { dir: [0.55, -1, -0.95], up: [0, 0, -1] },
};
VIEWS.side = VIEWS.front;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * Camera placement that shows box {min, max} from direction `dir` (camera -> scene is -dir) with
 * screen-up `up`, for a perspective camera of vertical fov `fovDeg` and `aspect`, with `pad` margin.
 * Fits the box's projection (not its bounding sphere), so a flat board fills a top view.
 * Returns {position, target, up, distance, radius}.
 */
export function fitCamera(box, { dir, up }, fovDeg, aspect, pad = 1.05) {
  const center = [0, 1, 2].map((k) => (box.min[k] + box.max[k]) / 2);
  const back = norm(dir);
  let right = cross(norm(up), back);
  if (Math.hypot(...right) < 1e-9) right = cross([0, 1, 0], back);   // up parallel to dir
  right = norm(right);
  const camUp = cross(back, right);
  let hw = 0, hh = 0, hd = 0;
  for (let i = 0; i < 8; i++) {
    const p = sub([i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2]], center);
    hw = Math.max(hw, Math.abs(dot(p, right)));
    hh = Math.max(hh, Math.abs(dot(p, camUp)));
    hd = Math.max(hd, dot(p, back));
  }
  const vt = Math.tan((fovDeg * Math.PI) / 360);
  const ht = vt * aspect;
  const radius = Math.max(Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2, 0.5);
  const distance = Math.max((hw * pad) / ht, (hh * pad) / vt, 1e-3) + hd;
  return {
    position: [center[0] + back[0] * distance, center[1] + back[1] * distance, center[2] + back[2] * distance],
    target: center, up: camUp, distance, radius,
  };
}

/**
 * Near/far for what is drawn, from where the camera is now: a fixed radius/200 .. radius*200 range
 * cannot resolve footprint copper ~10 um from a STEP body (kipr PR #14). sphere: {center, radius}.
 */
export function clipPlanes(cameraPos, sphere) {
  const d = Math.hypot(...sub(cameraPos, sphere.center));
  const far = d + sphere.radius * 1.05;
  return { near: Math.max(d - sphere.radius * 1.05, far / 2000, 1e-4), far };
}
