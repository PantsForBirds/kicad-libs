// KiCad pad semantics, pure. Ported from kipr web/library/js/kicad3d.js (padOffset, padOutline, padToPcb,
// padDrill, padHoleCenter, padCopperSides; kipr PR #13 shape offsets, PR #18 stadium drills), with the
// chamfered-rect and trapezoid shapes of kipr's kipr/library/render/model3d.py (pad_geom).
//
// A pad is the object `parseKicadFootprint` (src/footprint) produces, also kipr's geom.json pad
// (CONTRACT Addendum 2): KiCad mm, y DOWN, in the footprint's frame:
//   { number, type: 'smd'|'thru_hole'|'np_thru_hole'|'connect', shape: 'circle'|'rect'|'oval'|'roundrect'|
//     'chamfered_rect'|'trapezoid'|'custom', at: [x, y, rotDeg], size: [w, h], offset?: [dx, dy],
//     drill?: {shape: 'circle'|'oval', size: [w, h]} | number | null, layers: ['F.Cu', '*.Mask', ...],
//     roundrect_rratio?, chamfer_ratio?, chamfer?: ['top_left', ...], rect_delta?: [dx, dy],
//     anchor?: 'circle'|'rect', primitives?: [{pts: [[x, y], ...]}] }
// Pad-local coordinates are KiCad's, before the pad's rotation; the hole sits on `at`, the copper on
// at + offset (KiCad's `(drill ... (offset x y))` moves the copper, not the hole).

import { kicadToBoard } from './frames.js';
import { slotPoints } from './loops.js';

/** The pad's copper shape offset [dx, dy] (pad-local mm). Older geom.json had it as drill.offset. */
export function padOffset(pad) {
  const o = pad.offset ?? pad.drill?.offset;
  return Array.isArray(o) ? [+o[0] || 0, +o[1] || 0] : [0, 0];
}

/** Pad-local KiCad point -> footprint KiCad point, honouring (at x y rot). KiCad turns CCW on screen. */
export function padToKicad(pad, [px, py]) {
  const [x, y, rot] = pad.at || [0, 0, 0];
  const a = ((+rot || 0) * Math.PI) / 180;
  return [x + px * Math.cos(a) + py * Math.sin(a), y - px * Math.sin(a) + py * Math.cos(a)];
}

/**
 * A w x h rectangle centred on 0, corners clockwise on screen from top-left (KiCad y down), each corner
 * either cut by a chamfer of `c` (when listed in `chamfered`), rounded by `r`, or square. KiCad's
 * roundrect with chamfers rounds the corners it does not chamfer (checked against pcbnew).
 */
function cornerRect(w, h, { r = 0, c = 0, chamfered = [], segments = 8 } = {}) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  c = Math.max(0, Math.min(c, w / 2, h / 2));
  const ch = new Set(chamfered);
  const ring = [];
  // [corner x, y, name, start angle of its rounding arc]
  const corners = [
    [-w / 2, -h / 2, 'top_left', 180], [w / 2, -h / 2, 'top_right', 270],
    [w / 2, h / 2, 'bottom_right', 0], [-w / 2, h / 2, 'bottom_left', 90],
  ];
  for (const [x, y, name, a0] of corners) {
    const sx = Math.sign(x), sy = Math.sign(y);
    if (ch.has(name) && c > 1e-9) {
      // the cut, in ring order: TL and BR are reached along a vertical edge, TR and BL along a horizontal one
      const pts = [[x, y - sy * c], [x - sx * c, y]];
      ring.push(...(name === 'top_left' || name === 'bottom_right' ? pts : pts.reverse()));
    } else if (r > 1e-9) {
      const cx = x - sx * r, cy = y - sy * r;
      for (let i = 0; i <= segments; i++) {
        const a = ((a0 + (90 * i) / segments) * Math.PI) / 180;
        ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
    } else {
      ring.push([x, y]);
    }
  }
  return ring;
}

const roundedRect = (w, h, r, segments) => cornerRect(w, h, { r, segments });

/**
 * KiCad's trapezoid, `rect_delta` [dx, dy] (checked against pcbnew's effective polygon, see
 * test/geom/pads.test.mjs): dx > 0 makes the left edge dx taller and the right edge dx shorter; dy > 0
 * makes the bottom (y+) edge dy wider and the top edge dy narrower.
 */
function trapezoid(w, h, [dx, dy] = [0, 0]) {
  const hx = w / 2, hy = h / 2, ddx = dx / 2, ddy = dy / 2;
  return [[-hx - ddy, hy + ddx], [-hx + ddy, -hy - ddx], [hx - ddy, -hy + ddx], [hx + ddy, hy - ddx]];
}

function outlineAt0(pad, segments) {
  const [w, h] = pad.size || [0, 0];
  let shape = pad.shape || 'rect';
  if (shape === 'custom') shape = pad.anchor === 'circle' ? 'circle' : 'rect';
  let outer;
  if (shape === 'circle') {
    const r = w / 2, n = segments * 4;
    outer = Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)]);
  } else if (shape === 'oval') {
    outer = roundedRect(w, h, Math.min(w, h) / 2, segments);
  } else if (shape === 'roundrect' || shape === 'chamfered_rect') {
    const rr = shape === 'roundrect' ? (pad.roundrect_rratio ?? 0.25) : (pad.roundrect_rratio ?? 0);
    outer = cornerRect(w, h, {
      r: Math.min(w, h) * rr, c: Math.min(w, h) * (pad.chamfer_ratio ?? 0.2), chamfered: pad.chamfer || [], segments,
    });
  } else if (shape === 'trapezoid') {
    outer = trapezoid(w, h, pad.rect_delta || pad.delta);
  } else {
    outer = roundedRect(w, h, 0, segments);
  }
  const extra = [];
  for (const p of pad.primitives || []) {
    const pts = p?.pts || p?.points;
    if (Array.isArray(pts) && pts.length >= 3) extra.push(pts.map((q) => (Array.isArray(q) ? q : [q.x, q.y])));
  }
  return { outer, extra };
}

/**
 * The pad's copper outline in its own frame (KiCad orientation, before rotation, shape offset applied):
 * `{outer: loop, extra: [loops]}`; `extra` are a custom pad's primitives. `segments` per quarter turn.
 */
export function padOutline(pad, segments = 8) {
  const [ox, oy] = padOffset(pad);
  const { outer, extra } = outlineAt0(pad, segments);
  const shift = (ring) => ring.map(([x, y]) => [x + ox, y + oy]);
  return { outer: shift(outer), extra: extra.map(shift) };
}

/** The pad's copper loops in the footprint's board frame (y up): [outer, ...extra]. */
export function padCopperLoops(pad, segments = 8) {
  const { outer, extra } = padOutline(pad, segments);
  return [outer, ...extra].map((ring) => ring.map((q) => kicadToBoard(...padToKicad(pad, q))));
}

/** Drill as {w, h, oval} (centred on `at`), or null. Accepts {shape, size}, {size: n} or a bare number. */
export function padDrill(pad) {
  const d = pad.drill;
  if (d === null || d === undefined || d === 0) return null;
  if (typeof d === 'number') return { w: d, h: d, oval: false };
  const [w, h] = Array.isArray(d.size) ? d.size : [d.size, d.size];
  if (!w) return null;
  return { w, h: h || w, oval: d.shape === 'oval' || (!!h && h !== w) };
}

/** KiCad-frame centre of the pad's hole: always `at` (only the copper moves with the shape offset). */
export function padHoleCenter(pad) {
  return [pad.at?.[0] || 0, pad.at?.[1] || 0];
}

/**
 * The pad's drill as a slot, KiCad frame: two end centres and a radius. An oval drill's long axis follows
 * the larger of w/h in the pad's frame, turned with the pad; a round drill has one centre twice. `grow`
 * widens the radius (plating, annular ring). Null without a drill.
 */
export function padDrillSlot(pad, grow = 0) {
  const d = padDrill(pad);
  if (!d) return null;
  const r = Math.min(d.w, d.h) / 2;
  const half = Math.max(d.w, d.h) / 2 - r;
  const local = d.w >= d.h ? [[-half, 0], [half, 0]] : [[0, -half], [0, half]];
  return { ends: local.map((q) => padToKicad(pad, q)), radius: r + grow };
}

/** The pad's drill outline as a board-frame (y up) loop (circle or stadium, CCW), or null. */
export function padDrillLoop(pad, { grow = 0, segments = 24 } = {}) {
  const s = padDrillSlot(pad, grow);
  if (!s) return null;
  const [[x1, y1], [x2, y2]] = s.ends.map((q) => kicadToBoard(...q));
  return slotPoints(x1, y1, x2, y2, s.radius, segments);
}

/** Which copper faces the pad is on: {top, bottom}. `*.Cu` and `F&B.Cu` are both. */
export function padCopperSides(pad) {
  const L = pad.layers || [];
  const any = (re) => L.some((l) => re.test(l));
  return { top: any(/^(F|\*|F&B)\.Cu$/), bottom: any(/^(B|\*|F&B)\.Cu$/) };
}

/** An NPTH whose pad is no larger than its drill has no copper to draw (common for mounting holes). */
export function padHasCopper(pad) {
  const sides = padCopperSides(pad);
  if (!sides.top && !sides.bottom) return false;
  const d = padDrill(pad);
  if (pad.type === 'np_thru_hole' && d && Math.min(...(pad.size || [0])) <= Math.min(d.w, d.h) + 1e-6) return false;
  return true;
}
