// boarddd/gerber: moved from CoolNamesAllTaken/wasm-gerber-viewer packages/wasm-gerber-renderer/outline.js at 92976b5
// (earlier history lives there).
/**
 * The board's shape as polygons, from an outline (Edge.Cuts / profile) Gerber.
 *
 * An outline is not one shape in the file: exporters emit it as separate
 * strokes -- each rounded corner its own arc -- in no particular order, and an
 * export with the drawing sheet plotted carries the sheet border too. The
 * strokes are stitched back into closed loops by matching endpoints, arcs are
 * flattened, and loops are ranked by area. The largest is usually the board and
 * the loops inside it are cutouts, but a plotted sheet border is larger than
 * the board, so `pickBoard()` takes the board size when it is known.
 *
 * Pure string processing; no DOM, no WebGL. Coordinates in millimeters.
 */

/** Endpoints closer than this (mm) are the same point. */
export const OUTLINE_TOLERANCE_MM = 0.002;

/** Points per full circle when an arc is flattened. */
const ARC_SEGMENTS = 48;
/** A loop this close in area to the board is the board drawn again, not a hole in it. */
const SAME_SHAPE = 0.98;

const FORMAT = /%FSLAX(\d)(\d)Y(\d)(\d)\*%/;
const UNITS = /%MO(MM|IN)\*%/;
// One operation: G01 line, G02/G03 arc (I/J center offset), D01 draw, D02 move, D03 flash.
// Coordinates are modal.
const OP = /^(?:G0([123]))?(?:X([-+]?\d+))?(?:Y([-+]?\d+))?(?:I([-+]?\d+))?(?:J([-+]?\d+))?D0([123])\*$/;
// The interpolation mode on a line of its own (how KiCad writes it: `G03*`, then coordinates).
const MODE = /^G0([123])\*$/;
const QUADRANT = /^G7([45])\*$/;

function scaleOf(text) {
  const format = FORMAT.exec(text);
  const decimals = format ? Number(format[2]) : 6;
  const units = UNITS.exec(text);
  return (units && units[1] === "IN" ? 25.4 : 1) / 10 ** decimals;
}

function arcPoints(start, end, center, clockwise) {
  const [sx, sy] = start;
  const [ex, ey] = end;
  const [cx, cy] = center;
  const radius = Math.hypot(sx - cx, sy - cy);
  if (radius <= 0) return [end];
  const startAngle = Math.atan2(sy - cy, sx - cx);
  let sweep = Math.atan2(ey - cy, ex - cx) - startAngle;
  if (clockwise) {
    while (sweep > 0) sweep -= 2 * Math.PI;
    if (Math.abs(sweep) < 1e-9) sweep = -2 * Math.PI; // a full circle: start == end
  } else {
    while (sweep < 0) sweep += 2 * Math.PI;
    if (Math.abs(sweep) < 1e-9) sweep = 2 * Math.PI;
  }
  const steps = Math.max(
    2,
    Math.min(ARC_SEGMENTS, Math.floor((Math.abs(sweep) / (2 * Math.PI)) * ARC_SEGMENTS) + 2),
  );
  const points = [];
  for (let i = 1; i <= steps; i += 1) {
    const angle = startAngle + (sweep * i) / steps;
    points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  return points;
}

// Single-quadrant mode (G74): I and J are magnitudes. The center is the candidate
// equidistant from both ends and reached by at most a quarter turn.
function quadrantCenter(start, end, i, j, clockwise) {
  const [sx, sy] = start;
  const [ex, ey] = end;
  let best = [sx + i, sy + j];
  let bestError = Infinity;
  for (const di of [i, -i]) {
    for (const dj of [j, -j]) {
      const cx = sx + di;
      const cy = sy + dj;
      const rStart = Math.hypot(sx - cx, sy - cy);
      const error = Math.abs(rStart - Math.hypot(ex - cx, ey - cy));
      if (error > Math.max(rStart, 1) * 1e-3) continue;
      let sweep = Math.atan2(ey - cy, ex - cx) - Math.atan2(sy - cy, sx - cx);
      if (clockwise) while (sweep > 0) sweep -= 2 * Math.PI;
      else while (sweep < 0) sweep += 2 * Math.PI;
      if (Math.abs(sweep) > Math.PI / 2 + 1e-6) continue;
      if (error < bestError) {
        best = [cx, cy];
        bestError = error;
      }
    }
  }
  return best;
}

function strokesOf(text) {
  const scale = scaleOf(text);
  const strokes = [];
  let current = [];
  let x = 0;
  let y = 0;
  let mode = 1;
  let singleQuadrant = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("%") || line.startsWith("G04") || line.startsWith("M")) continue;
    const alone = MODE.exec(line);
    if (alone) {
      mode = Number(alone[1]);
      continue;
    }
    const quadrant = QUADRANT.exec(line);
    if (quadrant) {
      singleQuadrant = quadrant[1] === "4";
      continue;
    }
    const match = OP.exec(line);
    if (!match) continue;
    const [, g, rawX, rawY, rawI, rawJ, d] = match;
    if (g) mode = Number(g);
    const nx = rawX != null ? Number(rawX) * scale : x;
    const ny = rawY != null ? Number(rawY) * scale : y;
    if (d === "2") {
      if (current.length > 1) strokes.push(current);
      current = [[nx, ny]];
    } else if (d === "1") {
      if (!current.length) current = [[x, y]];
      if (mode === 1 || (rawI == null && rawJ == null)) {
        current.push([nx, ny]);
      } else {
        const i = rawI ? Number(rawI) * scale : 0;
        const j = rawJ ? Number(rawJ) * scale : 0;
        const center = singleQuadrant
          ? quadrantCenter([x, y], [nx, ny], i, j, mode === 2)
          : [x + i, y + j];
        current.push(...arcPoints([x, y], [nx, ny], center, mode === 2));
      }
    }
    x = nx;
    y = ny;
  }
  if (current.length > 1) strokes.push(current);
  return strokes;
}

function keyOf(point, tolerance) {
  return `${Math.round(point[0] / tolerance)},${Math.round(point[1] / tolerance)}`;
}

// Greedy stitching: extend a chain with whichever unused stroke starts or ends
// where it ends, until it closes. A closed chain stops at once, so an outline
// drawn twice becomes two loops rather than one that goes round twice.
function stitch(strokes, tolerance) {
  const ends = new Map();
  strokes.forEach((stroke, index) => {
    for (const point of [stroke[0], stroke[stroke.length - 1]]) {
      const key = keyOf(point, tolerance);
      if (!ends.has(key)) ends.set(key, []);
      ends.get(key).push(index);
    }
  });
  const used = new Array(strokes.length).fill(false);
  const loops = [];
  const closed = (chain) =>
    chain.length > 2 && keyOf(chain[0], tolerance) === keyOf(chain[chain.length - 1], tolerance);
  for (let index = 0; index < strokes.length; index += 1) {
    if (used[index]) continue;
    used[index] = true;
    const chain = [...strokes[index]];
    let extended = true;
    while (extended && !closed(chain)) {
      extended = false;
      const tail = keyOf(chain[chain.length - 1], tolerance);
      for (const candidate of ends.get(tail) ?? []) {
        if (used[candidate]) continue;
        const stroke = strokes[candidate];
        if (keyOf(stroke[0], tolerance) === tail) {
          chain.push(...stroke.slice(1));
        } else if (keyOf(stroke[stroke.length - 1], tolerance) === tail) {
          chain.push(...stroke.slice(0, -1).reverse());
        } else {
          continue;
        }
        used[candidate] = true;
        extended = true;
        break;
      }
    }
    if (closed(chain)) loops.push(chain);
  }
  return loops;
}

/** Signed area of a polygon (positive when counter-clockwise, y up). */
export function signedArea(points) {
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    total += x1 * y2 - x2 * y1;
  }
  return total / 2;
}

/**
 * Every closed loop drawn in an outline Gerber, largest first:
 * `[{ points: [[x, y], ...], area, bounds: {minX, maxX, minY, maxY} }]`.
 * Points are in mm, the closing point not repeated, in drawing order.
 */
export function outlineContours(text, { tolerance = OUTLINE_TOLERANCE_MM } = {}) {
  const found = [];
  for (const loop of stitch(strokesOf(text), tolerance)) {
    const points = loop.slice(0, -1);
    if (points.length < 3) continue;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of points) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    found.push({ points, area: Math.abs(signedArea(points)), bounds: { minX, maxX, minY, maxY } });
  }
  found.sort((a, b) => b.area - a.area);
  return found;
}

function contains(outer, inner) {
  return (
    outer.bounds.minX <= inner.bounds.minX &&
    outer.bounds.maxX >= inner.bounds.maxX &&
    outer.bounds.minY <= inner.bounds.minY &&
    outer.bounds.maxY >= inner.bounds.maxY
  );
}

/**
 * The loop that is the board. With the board's `width`/`height` (e.g. from a
 * .gbrjob) the loop whose box matches within 2 mm in total wins -- reliable
 * even with a plotted sheet border; otherwise the largest loop.
 */
export function pickBoard(contours, { width = null, height = null } = {}) {
  if (!contours.length) return null;
  if (width && height) {
    const error = (contour) =>
      Math.abs(contour.bounds.maxX - contour.bounds.minX - width) +
      Math.abs(contour.bounds.maxY - contour.bounds.minY - height);
    let best = contours[0];
    for (const contour of contours) if (error(contour) < error(best)) best = contour;
    if (error(best) <= 2) return best;
  }
  return contours[0];
}

function sameLoop(a, b, tolerance) {
  return (
    Math.abs(a.bounds.minX - b.bounds.minX) <= tolerance &&
    Math.abs(a.bounds.maxX - b.bounds.maxX) <= tolerance &&
    Math.abs(a.bounds.minY - b.bounds.minY) <= tolerance &&
    Math.abs(a.bounds.maxY - b.bounds.maxY) <= tolerance &&
    (Math.max(a.area, b.area) <= 0 || Math.min(a.area, b.area) / Math.max(a.area, b.area) >= SAME_SHAPE)
  );
}

/**
 * The loops inside the board (slots, windows), each once. A loop the board's
 * own size is the outline drawn twice and is excluded; duplicates (a KiKit
 * panel stamps every slot twice) are dropped, because two coincident holes
 * cancel under an even-odd fill.
 */
export function boardCutouts(contours, board, { tolerance = OUTLINE_TOLERANCE_MM } = {}) {
  const kept = [];
  for (const contour of contours) {
    if (contour === board || !contains(board, contour)) continue;
    if (board.area > 0 && contour.area / board.area >= SAME_SHAPE) continue;
    if (kept.some((other) => sameLoop(contour, other, tolerance))) continue;
    kept.push(contour);
  }
  return kept;
}

/**
 * The board outline as polygons: `{ outer, holes, bounds }` with `outer`
 * wound counter-clockwise and `holes` clockwise (y up), the convention
 * extruders and triangulators expect; or `null` when nothing closes.
 * `options.width`/`height` help pick the board over a plotted sheet border.
 */
export function boardOutline(text, options = {}) {
  const contours = outlineContours(text, options);
  const board = pickBoard(contours, options);
  if (!board) return null;
  const wind = (points, ccw) => (signedArea(points) > 0 === ccw ? points : [...points].reverse());
  return {
    outer: wind(board.points, true),
    holes: boardCutouts(contours, board, options).map((cutout) => wind(cutout.points, false)),
    bounds: { ...board.bounds },
  };
}

/**
 * The bounding box of every coordinate a Gerber names (flashes included), or
 * `null`. Not a silhouette: with a drawing sheet plotted it is the sheet.
 */
export function gerberExtents(text) {
  const scale = scaleOf(text);
  let x = 0;
  let y = 0;
  let bounds = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const match = OP.exec(raw.trim());
    if (!match) continue;
    if (match[2] != null) x = Number(match[2]) * scale;
    if (match[3] != null) y = Number(match[3]) * scale;
    bounds = bounds
      ? {
          minX: Math.min(bounds.minX, x),
          maxX: Math.max(bounds.maxX, x),
          minY: Math.min(bounds.minY, y),
          maxY: Math.max(bounds.maxY, y),
        }
      : { minX: x, maxX: x, minY: y, maxY: y };
  }
  return bounds;
}

/**
 * Closed rings (`[[x, y], ...]` in millimeters, e.g. `boardOutline()`'s
 * `outer` and `holes`, or a host's own stored outline) as an RS-274X Gerber of
 * hairline strokes. What a frame needs to clip or invert against an outline it
 * has as geometry rather than as an Edge.Cuts file: render it hidden and pass
 * its id as `outlineLayerId` (see board.js). `width` is the stroke in mm.
 */
export function ringsToGerber(rings, { width = 0.01 } = {}) {
  const at = (value) => Math.round(Number(value) * 1e6);
  const lines = ["%FSLAX46Y46*%", "%MOMM*%", "%LPD*%", `%ADD10C,${Number(width).toFixed(6)}*%`, "D10*", "G01*"];
  for (const ring of rings || []) {
    if (!ring || ring.length < 2) continue;
    lines.push(`X${at(ring[0][0])}Y${at(ring[0][1])}D02*`);
    for (const [x, y] of ring.slice(1).concat([ring[0]])) lines.push(`X${at(x)}Y${at(y)}D01*`);
  }
  lines.push("M02*");
  return lines.join("\n") + "\n";
}
