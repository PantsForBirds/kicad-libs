// Closed loops ([[x, y], ...]) in the board frame: winding, bounds, point-to-edge clearance, and the
// outlines of drilled holes (circles) and routed slots / oval drills (stadiums). Pure: no three.js.
//
// Ported from gentoo's viewer3d.js (PantsForBirds/internal fab/static/fab/viewer3d.js: segmentsFor,
// ringPoints, slotPoints, loopAt, clearance, pointToSegment, counterClockwise) by way of kipr's
// web/project/pcba3d/boardgeom.js, where the reasons for each rule are written up; the slot construction
// is the one kipr PR #18 made the library viewer share (a stadium, never a scaled circle = an ellipse).

// Round enough that the flats never show at any size, without spending sides on 0.3 mm vias.
const HOLE_SAGITTA_MM = 0.01;
const HOLE_SEGMENTS_MIN = 10;
const HOLE_SEGMENTS_MAX = 48;

/** Segments for a full circle of `radius` mm: chord sagitta <= 0.01 mm, 10..48. */
export function segmentsFor(radius) {
  if (!(radius > 0)) return HOLE_SEGMENTS_MIN;
  const ratio = Math.min(1, HOLE_SAGITTA_MM / radius);
  const needed = Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - ratio)));
  return Math.max(HOLE_SEGMENTS_MIN, Math.min(HOLE_SEGMENTS_MAX, needed));
}

/** Twice the signed area (shoelace): > 0 counter-clockwise in a y-up frame. */
export function signedArea2(loop) {
  let a = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i, i += 1) a += loop[j][0] * loop[i][1] - loop[i][0] * loop[j][1];
  return a;
}

export const isClockwise = (loop) => signedArea2(loop) < 0;
/** The loop wound counter-clockwise (y up), reversed copy if needed. */
export const counterClockwise = (loop) => (isClockwise(loop) ? loop.slice().reverse() : loop);
/** The loop wound clockwise (y up), reversed copy if needed. */
export const clockwise = (loop) => (isClockwise(loop) ? loop : loop.slice().reverse());

export function pointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Inside a closed loop (even-odd), and the distance to its nearest edge. */
export function clearance(loop, x, y) {
  let inside = false, distance = Infinity;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i, i += 1) {
    const [xi, yi] = loop[i], [xj, yj] = loop[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    distance = Math.min(distance, pointToSegment(x, y, xi, yi, xj, yj));
  }
  return { inside, distance };
}

/** {minX, maxX, minY, maxY} of one or more loops. */
export function loopBounds(...loops) {
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const loop of loops) {
    for (const [x, y] of loop) {
      b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x);
      b.minY = Math.min(b.minY, y); b.maxY = Math.max(b.maxY, y);
    }
  }
  return b;
}

/** Bounds grown by `margin` on every side. */
export const padBounds = (b, margin) => ({ minX: b.minX - margin, maxX: b.maxX + margin, minY: b.minY - margin, maxY: b.maxY + margin });

/** A circle as a closed loop, wound clockwise (a hole, in a y-up frame). */
export function ringPoints(cx, cy, radius, segments = segmentsFor(radius)) {
  const points = [];
  for (let i = 0; i < segments; i += 1) {
    const a = (-2 * Math.PI * i) / segments;
    points.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
  return points;
}

/**
 * A slot as one closed loop: a semicircle of `radius` around each end centre, joined by straight flanks
 * (a stadium: how KiCad draws oval drills and routed slots). Each cap has `segments / 2` steps with both
 * end points included, so the flanks run exactly from cap to cap. Coincident ends give a circle.
 * Wound counter-clockwise (y up).
 */
export function slotPoints(x1, y1, x2, y2, radius, segments = segmentsFor(radius)) {
  if (Math.hypot(x2 - x1, y2 - y1) < 1e-9) return ringPoints(x1, y1, radius, segments).reverse();
  const along = Math.atan2(y2 - y1, x2 - x1);
  const half = Math.max(2, Math.round(segments / 2));
  const points = [];
  const cap = (cx, cy, from) => {
    for (let i = 0; i <= half; i += 1) {
      const a = from + (Math.PI * i) / half;
      points.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
    }
  };
  cap(x2, y2, along - Math.PI / 2);   // round the far end, right flank to left
  cap(x1, y1, along + Math.PI / 2);   // and back round the near one
  return points;
}

/** One hole's loop at `radius`: a circle for one end, a stadium for two. */
export function loopAt(ends, radius, segments) {
  return ends.length === 1 || (ends[0][0] === ends[1][0] && ends[0][1] === ends[1][1])
    ? ringPoints(ends[0][0], ends[0][1], radius, segments)
    : slotPoints(ends[0][0], ends[0][1], ends[1][0], ends[1][1], radius, segments);
}

/** A rectangle loop, counter-clockwise. */
export const rectLoop = (minX, minY, maxX, maxY) => [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];

/**
 * An outline {board, cutouts} from a KiCad-style board box (KiCad mm, y down): `origin_mm` [x, y] of the
 * top-left corner and `size_mm` [w, h]. The fallback when there is no usable Edge.Cuts.
 */
export function rectOutline({ origin_mm: [ox, oy], size_mm: [w, h] }) {
  return { board: rectLoop(ox, -oy - h, ox + w, -oy), cutouts: [], approximate: true };
}

/** Whether two outlines differ by more than `tol` mm anywhere (vertex to edge, both directions). */
export function outlinesDiffer(a, b, tol = 0.01) {
  if (!a || !b) return !!(a || b);
  const loops = (o) => [o.board, ...(o.cutouts || [])];
  const la = loops(a), lb = loops(b);
  if (la.length !== lb.length) return true;
  const far = (from, to) => from.some((ring) => ring.some(([x, y]) =>
    !to.some((other) => clearance(other, x, y).distance <= tol)));
  return far(la, lb) || far(lb, la);
}

/** A stroked polyline as filled loops: one stadium per segment (round caps and joins, as KiCad plots). */
export function strokeLoops(pts, width, closed = false) {
  const r = width / 2;
  const out = [];
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    out.push(slotPoints(x1, y1, x2, y2, r, 16));
  }
  return out;
}
