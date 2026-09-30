// KiCad footprint 3D conventions, as pure functions (no three.js import, so they are easy to test).
//
// Frames used by the 3D view:
//   PCB frame    : KiCad footprint coordinates, mm, x right, y DOWN (what .kicad_mod files and the SVGs use).
//   Board frame  : KiCad's 3D-viewer frame, mm, x right, y UP (= -pcb y), z out of the top copper.
//                  Board top surface is z = 0, bottom is z = -thickness. Models are placed in this frame.
//   Scene frame  : three.js y-up; the board-frame root group is rotated -90 deg about X (board z -> scene y).

export const BOARD_THICKNESS = 1.6;
export const COPPER_THICKNESS = 0.035;

/** PCB (y-down) point -> board frame (y-up). */
export const toBoard = (x, y) => [x, -y];

/**
 * 4x4 column-major matrix (as three.js Matrix4.fromArray expects) for a footprint `(model ...)` entry,
 * reproducing KiCad's 3D viewer:
 *     M = T(offset) * Rz(-rz) * Ry(-ry) * Rx(-rx) * S(scale)
 * i.e. scale first, then rotate about X, then Y, then Z (angles in degrees, negated as KiCad does),
 * then translate by the offset (mm, board frame: +y moves the model UP the screen, +z away from the board).
 */
export function modelMatrix({ offset = [0, 0, 0], rotate = [0, 0, 0], scale = [1, 1, 1] } = {}) {
  const rad = (d) => (-(+d || 0) * Math.PI) / 180;
  const [ax, ay, az] = rotate.map(rad);
  const cx = Math.cos(ax); const sx = Math.sin(ax);
  const cy = Math.cos(ay); const sy = Math.sin(ay);
  const cz = Math.cos(az); const sz = Math.sin(az);
  const Rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]];
  const Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const Rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  const mul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
  const R = mul(mul(Rz, Ry), Rx);
  const [sxx, syy, szz] = scale.map((v) => (v === undefined || v === null ? 1 : +v));
  const [tx, ty, tz] = offset.map((v) => +v || 0);
  // column-major: element (row r, col c) at index c*4 + r
  return [
    R[0][0] * sxx, R[1][0] * sxx, R[2][0] * sxx, 0,
    R[0][1] * syy, R[1][1] * syy, R[2][1] * syy, 0,
    R[0][2] * szz, R[1][2] * szz, R[2][2] * szz, 0,
    tx, ty, tz, 1,
  ];
}

/** Apply a column-major 4x4 to a point (for tests / bounding boxes). */
export function applyMatrix(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/**
 * Outline of a pad in its own frame (PCB orientation, before rotation), as a list of rings
 * [[x,y],...]. Returns {outer: ring, extra: [rings]} (extra = custom-pad primitives).
 */
export function padOutline(pad, segments = 8) {
  const [w, h] = pad.size || [0, 0];
  const shape = pad.shape || 'rect';
  const ring = [];
  if (shape === 'circle') {
    const r = w / 2;
    for (let i = 0; i < segments * 4; i++) {
      const a = (i / (segments * 4)) * Math.PI * 2;
      ring.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    return { outer: ring, extra: [] };
  }
  let r = 0;
  if (shape === 'oval') r = Math.min(w, h) / 2;
  else if (shape === 'roundrect') r = Math.min(w, h) * (pad.roundrect_rratio ?? 0.25);
  r = Math.min(r, w / 2, h / 2);
  if (r <= 1e-6) {
    ring.push([-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]);
  } else {
    const corners = [[w / 2 - r, -h / 2 + r, -90], [w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, 90], [-w / 2 + r, -h / 2 + r, 180]];
    for (const [cx, cy, a0] of corners) {
      for (let i = 0; i <= segments; i++) {
        const a = ((a0 + (90 * i) / segments) * Math.PI) / 180;
        ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
    }
  }
  const extra = [];
  for (const p of pad.primitives || []) {
    const pts = p?.pts || p?.points;
    if (Array.isArray(pts) && pts.length >= 3) extra.push(pts.map((q) => (Array.isArray(q) ? q : [q.x, q.y])));
  }
  return { outer: ring, extra };
}

/** Pad-local PCB point -> PCB point, honouring the pad's (at x y rot). KiCad rotates CCW on screen. */
export function padToPcb(pad, [px, py]) {
  const [x, y, rot] = pad.at || [0, 0, 0];
  const a = ((+rot || 0) * Math.PI) / 180;
  return [x + px * Math.cos(a) + py * Math.sin(a), y - px * Math.sin(a) + py * Math.cos(a)];
}

/** Drill as {w, h, offset:[x,y]} in pad-local coords, or null. Accepts the Addendum-2 object or a bare number. */
export function padDrill(pad) {
  const d = pad.drill;
  if (d === null || d === undefined || d === 0) return null;
  if (typeof d === 'number') return { w: d, h: d, offset: [0, 0] };
  const [w, h] = Array.isArray(d.size) ? d.size : [d.size, d.size];
  if (!w) return null;
  return { w, h: h || w, offset: d.offset || [0, 0], oval: d.shape === 'oval' || (h && h !== w) };
}

export function padCopperSides(pad) {
  const L = pad.layers || [];
  const any = (re) => L.some((l) => re.test(l));
  return { top: any(/^(F|\*)\.Cu$/), bottom: any(/^(B|\*)\.Cu$/) };
}
