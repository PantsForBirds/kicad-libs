// A small reader for KiCad footprints (.kicad_mod, KiCad 6..10; the old `(module ...)` form too):
// the parts boarddd draws, in KiCad's frame (mm, y DOWN). Not a full KiCad parser: text is skipped,
// zones and groups are ignored.
//
// parseKicadFootprint(text) -> {
//   name, layer, attr: [...],
//   pads: [pad, ...]            boarddd/geom pad objects (see src/geom/pads.js), kipr geom.json compatible
//   graphics: [{layer, kind, pts: [[x, y], ...], width, closed, filled}]   arcs/circles/curves flattened
//   models: [{path, offset, rotate, scale, hide, opacity}]
// }

import { ringPoints, strokeLoops } from '../geom/loops.js';

/** S-expressions -> nested arrays; atoms stay strings, quoted strings become {str}. */
export function parseSexpr(text) {
  const re = /\s*(?:(\()|(\))|"((?:[^"\\]|\\.)*)"|([^\s()"]+))/gy;
  const stack = [[]];
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < text.length && (m = re.exec(text))) {
    if (m[1]) stack.push([]);
    else if (m[2]) { const node = stack.pop(); if (!stack.length) break; stack[stack.length - 1].push(node); }
    else if (m[3] !== undefined) stack[stack.length - 1].push({ str: m[3].replace(/\\(.)/g, '$1') });
    else stack[stack.length - 1].push(m[4]);
  }
  return stack[0][0];
}

const head = (n) => (Array.isArray(n) ? n[0] : null);
const kids = (n, name) => (Array.isArray(n) ? n.filter((c) => head(c) === name) : []);
const kid = (n, name) => kids(n, name)[0];
const atom = (v) => (v && typeof v === 'object' && 'str' in v ? v.str : v);
const num = (v, d = 0) => { const x = Number(atom(v)); return Number.isFinite(x) ? x : d; };
const xy = (n, d = [0, 0]) => (n ? [num(n[1]), num(n[2])] : d);

function strokeWidth(n, d = 0.12) {
  const s = kid(n, 'stroke');
  const w = kid(s, 'width') || kid(n, 'width');
  return w ? num(w[1], d) : d;
}
function isFilled(n) {
  const f = kid(n, 'fill');
  if (!f) return false;
  const v = atom(f[1]);
  if (Array.isArray(f[1])) return atom(kid(f, 'type')?.[1]) !== 'none';  // (fill (type solid))
  return v === 'solid' || v === 'yes';
}

/** Arc through start, mid, end: points along it (inclusive). */
export function arcThrough([x1, y1], [xm, ym], [x2, y2], segments = 24) {
  const d = 2 * (x1 * (ym - y2) + xm * (y2 - y1) + x2 * (y1 - ym));
  if (Math.abs(d) < 1e-12) return [[x1, y1], [x2, y2]];
  const s1 = x1 * x1 + y1 * y1, sm = xm * xm + ym * ym, s2 = x2 * x2 + y2 * y2;
  const cx = (s1 * (ym - y2) + sm * (y2 - y1) + s2 * (y1 - ym)) / d;
  const cy = (s1 * (x2 - xm) + sm * (x1 - x2) + s2 * (xm - x1)) / d;
  const r = Math.hypot(x1 - cx, y1 - cy);
  const a1 = Math.atan2(y1 - cy, x1 - cx), am = Math.atan2(ym - cy, xm - cx), a2 = Math.atan2(y2 - cy, x2 - cx);
  const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let sweep = norm(a2 - a1);
  if (norm(am - a1) > sweep) sweep -= 2 * Math.PI;   // the mid point decides the direction
  const n = Math.max(2, Math.ceil((segments * Math.abs(sweep)) / (2 * Math.PI)));
  return Array.from({ length: n + 1 }, (_, i) => [cx + r * Math.cos(a1 + (sweep * i) / n), cy + r * Math.sin(a1 + (sweep * i) / n)]);
}

/** Old-format arc: (start = centre) (end = start point) (angle deg). */
function arcCentreAngle([cx, cy], [sx, sy], angleDeg) {
  const a0 = Math.atan2(sy - cy, sx - cx), r = Math.hypot(sx - cx, sy - cy);
  const sweep = (angleDeg * Math.PI) / 180;
  const am = a0 + sweep / 2, a2 = a0 + sweep;
  return arcThrough([sx, sy], [cx + r * Math.cos(am), cy + r * Math.sin(am)], [cx + r * Math.cos(a2), cy + r * Math.sin(a2)]);
}

function bezier(P, n = 24) {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n, u = 1 - t;
    return [0, 1].map((k) => u * u * u * P[0][k] + 3 * u * u * t * P[1][k] + 3 * u * t * t * P[2][k] + t * t * t * P[3][k]);
  });
}

function polyPts(n) {
  const pts = kid(n, 'pts');
  if (!pts) return [];
  const out = [];
  for (const c of pts.slice(1)) {
    if (head(c) === 'xy') out.push(xy(c));
    else if (head(c) === 'arc') out.push(...arcThrough(xy(kid(c, 'start')), xy(kid(c, 'mid')), xy(kid(c, 'end'))).slice(out.length ? 1 : 0));
  }
  return out;
}

/** One graphic item (fp_* or a pad primitive gr_*) -> {kind, pts, width, closed, filled}, or null. */
function graphic(n) {
  const kind = head(n).replace(/^(fp|gr)_/, '');
  const width = strokeWidth(n);
  const filled = isFilled(n);
  if (kind === 'line') return { kind, pts: [xy(kid(n, 'start')), xy(kid(n, 'end'))], width, closed: false, filled: false };
  if (kind === 'rect') {
    const [x0, y0] = xy(kid(n, 'start')), [x1, y1] = xy(kid(n, 'end'));
    return { kind, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], width, closed: true, filled };
  }
  if (kind === 'circle') {
    const [cx, cy] = xy(kid(n, 'center')), [ex, ey] = xy(kid(n, 'end'));
    const r = Math.hypot(ex - cx, ey - cy);
    return { kind, pts: ringPoints(cx, cy, r, 48).reverse(), width, closed: true, filled, center: [cx, cy], r };
  }
  if (kind === 'arc') {
    const mid = kid(n, 'mid');
    const pts = mid ? arcThrough(xy(kid(n, 'start')), xy(mid), xy(kid(n, 'end')))
      : arcCentreAngle(xy(kid(n, 'start')), xy(kid(n, 'end')), num(kid(n, 'angle')?.[1]));
    return { kind, pts, width, closed: false, filled: false };
  }
  if (kind === 'poly') return { kind, pts: polyPts(n), width, closed: true, filled: filled || head(n) === 'gr_poly' && !kid(n, 'fill') };
  if (kind === 'curve') return { kind, pts: bezier(polyPts(n)), width, closed: false, filled: false };
  return null;
}

/** A pad primitive as filled loops in pad-local mm. */
function primitiveLoops(g) {
  if (!g || g.pts.length < 2) return [];
  if (g.closed && (g.filled || g.kind === 'poly')) {
    const loops = [g.pts];
    if (g.width > 0) loops.push(...strokeLoops(g.pts, g.width, true));
    return loops;
  }
  return strokeLoops(g.pts, g.width || 0.01, g.closed);
}

function pad(n) {
  const [, number, type, shape] = n.map(atom);
  const at = kid(n, 'at');
  const size = kid(n, 'size');
  const p = {
    number: String(number ?? ''), type, shape,
    at: [num(at?.[1]), num(at?.[2]), num(at?.[3])],
    size: [num(size?.[1]), num(size?.[2])],
    offset: [0, 0], drill: null, layers: (kid(n, 'layers') || []).slice(1).map(atom),
  };
  const d = kid(n, 'drill');
  if (d) {
    const vals = d.slice(1).filter((v) => !Array.isArray(v)).map(atom);
    const oval = vals[0] === 'oval';
    const nums = vals.filter((v) => v !== 'oval').map(Number);
    if (nums[0] > 0) p.drill = { shape: oval ? 'oval' : 'circle', size: [nums[0], oval && nums.length > 1 ? nums[1] : nums[0]] };
    const off = kid(d, 'offset');
    if (off) p.offset = xy(off);
  }
  const rr = kid(n, 'roundrect_rratio'); if (rr) p.roundrect_rratio = num(rr[1]);
  const cr = kid(n, 'chamfer_ratio'); if (cr) p.chamfer_ratio = num(cr[1]);
  const ch = kid(n, 'chamfer'); if (ch) p.chamfer = ch.slice(1).map(atom);
  const rd = kid(n, 'rect_delta'); if (rd) p.rect_delta = xy(rd);
  const opts = kid(n, 'options');
  if (opts) p.anchor = atom(kid(opts, 'anchor')?.[1]) || 'rect';
  const prims = kid(n, 'primitives');
  if (prims) p.primitives = prims.slice(1).filter(Array.isArray).map(graphic).flatMap(primitiveLoops).map((pts) => ({ pts }));
  const mm = kid(n, 'solder_mask_margin'); if (mm) p.solder_mask_margin = num(mm[1]);
  return p;
}

function model(n) {
  const vec = (name, d) => {
    const v = kid(n, name);
    const x = kid(v, 'xyz');
    return x ? [num(x[1]), num(x[2]), num(x[3])] : d;
  };
  let offset = vec('offset', null);
  if (!offset) offset = vec('at', [0, 0, 0]).map((v) => v * 25.4);   // KiCad 5: (at (xyz ..)) in inches
  const op = kid(n, 'opacity');
  return { path: atom(n[1]), offset, rotate: vec('rotate', [0, 0, 0]), scale: vec('scale', [1, 1, 1]), hide: n.includes('hide') || atom(kid(n, 'hide')?.[1]) === 'yes', opacity: op ? num(op[1], 1) : 1 };
}

/** Parse a .kicad_mod (or one `(footprint ...)` s-expression); see the header for the result. */
export function parseKicadFootprint(text) {
  const root = typeof text === 'string' ? parseSexpr(text) : text;
  if (!root || !['footprint', 'module'].includes(head(root))) throw new Error('not a KiCad footprint');
  const out = { name: atom(root[1]), layer: atom(kid(root, 'layer')?.[1]) || 'F.Cu', attr: (kid(root, 'attr') || []).slice(1).map(atom), pads: [], graphics: [], models: [] };
  for (const c of root) {
    if (!Array.isArray(c)) continue;
    const h = head(c);
    if (h === 'pad') out.pads.push(pad(c));
    else if (h === 'model') out.models.push(model(c));
    else if (/^fp_(line|rect|circle|arc|poly|curve)$/.test(h)) {
      const g = graphic(c);
      if (g) out.graphics.push({ layer: atom(kid(c, 'layer')?.[1]), ...g });
    }
  }
  return out;
}
