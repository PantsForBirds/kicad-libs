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
 * KiCad's pad shape offset ((drill ... (offset x y)) in the .kicad_mod), pad-local mm: the copper is drawn at
 * at+offset, the hole stays at `at`. SMD pads carry it too. Older geom.json files only had it as drill.offset.
 */
export function padOffset(pad) {
  const o = pad.offset ?? pad.drill?.offset;
  return Array.isArray(o) ? [+o[0] || 0, +o[1] || 0] : [0, 0];
}

/**
 * Outline of a pad in its own frame (PCB orientation, before rotation, shape offset applied), as a list of
 * rings [[x,y],...]. Returns {outer: ring, extra: [rings]} (extra = custom-pad primitives).
 */
export function padOutline(pad, segments = 8) {
  const [ox, oy] = padOffset(pad);
  const { outer, extra } = padOutlineAt0(pad, segments);
  const shift = (ring) => ring.map(([x, y]) => [x + ox, y + oy]);
  return { outer: shift(outer), extra: extra.map(shift) };
}

function padOutlineAt0(pad, segments) {
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

/** Drill as {w, h, oval} (centred on the pad position), or null. Accepts the Addendum-2 object or a bare number. */
export function padDrill(pad) {
  const d = pad.drill;
  if (d === null || d === undefined || d === 0) return null;
  if (typeof d === 'number') return { w: d, h: d };
  const [w, h] = Array.isArray(d.size) ? d.size : [d.size, d.size];
  if (!w) return null;
  return { w, h: h || w, oval: d.shape === 'oval' || (h && h !== w) };
}

/**
 * A slot as one closed loop: a semicircle of `radius` around each end centre (x1, y1) and (x2, y2), joined by
 * straight flanks (a stadium, as KiCad draws oval drills and routed slots). Coincident ends give a circle.
 * `segments` is per full turn; each end cap gets half of them, both of its end points included, so the
 * flanks run exactly from cap to cap. Same construction as the project viewer's boardgeom.js slotPoints.
 */
export function slotPoints(x1, y1, x2, y2, radius, segments = 24) {
  const half = Math.max(2, Math.round(segments / 2));
  const points = [];
  if (Math.hypot(x2 - x1, y2 - y1) < 1e-9) {
    for (let i = 0; i < 2 * half; i++) {
      const a = (Math.PI * i) / half;
      points.push([x1 + radius * Math.cos(a), y1 + radius * Math.sin(a)]);
    }
    return points;
  }
  const along = Math.atan2(y2 - y1, x2 - x1);
  const cap = (cx, cy, from) => {
    for (let i = 0; i <= half; i++) {
      const a = from + (Math.PI * i) / half;
      points.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
    }
  };
  cap(x2, y2, along - Math.PI / 2);
  cap(x1, y1, along + Math.PI / 2);
  return points;
}

/**
 * A pad's drill as its two end centres and radius, PCB frame: an oval drill (drill oval w h) is a slot whose
 * long axis follows the larger of w/h in the pad's frame, turned with the pad; a round drill has one centre
 * twice. `grow` widens the radius (plating, annular ring). Null without a drill.
 */
export function padDrillSlot(pad, grow = 0) {
  const d = padDrill(pad);
  if (!d) return null;
  const r = Math.min(d.w, d.h) / 2;
  const half = Math.max(d.w, d.h) / 2 - r;
  const local = d.w >= d.h ? [[-half, 0], [half, 0]] : [[0, -half], [0, half]];
  const [a, b] = local.map((q) => padToPcb(pad, q));
  return { ends: [a, b], radius: r + grow };
}

/** The drill outline of a pad as a board-frame (y up) ring, or null. See padDrillSlot / slotPoints. */
export function padDrillRing(pad, { grow = 0, segments = 24 } = {}) {
  const s = padDrillSlot(pad, grow);
  if (!s) return null;
  const [[x1, y1], [x2, y2]] = s.ends.map((q) => toBoard(...q));
  return slotPoints(x1, y1, x2, y2, s.radius, segments);
}

/** PCB-frame centre of a pad's hole: KiCad keeps the hole on the pad position (`at`); only the copper moves. */
export function padHoleCenter(pad) {
  return [pad.at?.[0] || 0, pad.at?.[1] || 0];
}

export function padCopperSides(pad) {
  const L = pad.layers || [];
  const any = (re) => L.some((l) => re.test(l));
  return { top: any(/^(F|\*)\.Cu$/), bottom: any(/^(B|\*)\.Cu$/) };
}
