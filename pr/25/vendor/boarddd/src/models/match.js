// Mesh -> reference designator matching. Pure: no three.js, runs under node --test.
//
// Ported from kipr web/project/pcba3d/match.js (name first, then position with a fitted export
// origin), which ports gentoo fab/static/fab/viewer3d.js (matchToDesignators, settleTies,
// claimModule, splitBoardBodies).
//
// Frames: components arrive in KiCad mm (y down). Nodes are in the board frame (mm, y up). A
// component at (x, y) is expected at (x, -y) + T, where T (the export origin) is fitted here.

import { kicadToBoard } from '../geom/frames.js';

export const MATCH_MM = 2.0;          // how far a node may be from its placement and still match
export const HOUGH_BIN_MM = 0.5;      // translation vote resolution
export const MODULE_MARGIN_MM = 0.5;  // slack around a module's box when it claims its solids
export const BOARD_BOX_MM = 1.0;      // slack between a solid's box and a measured board body box

/** Natural sort for designators: R2 < R10, U1 < U1A. */
export function naturalCompare(a, b) {
  const ax = String(a).match(/(\d+|\D+)/g) || [];
  const bx = String(b).match(/(\d+|\D+)/g) || [];
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    const x = ax[i], y = bx[i];
    if (x === y) continue;
    const nx = /^\d/.test(x), ny = /^\d/.test(y);
    if (nx && ny) return Number(x) - Number(y) || x.length - y.length;
    return x < y ? -1 : 1;
  }
  return ax.length - bx.length;
}

/**
 * The designator a node name stands for, or null. Tries the exact name, then without a copy
 * suffix ("R5_1", "R5-2", "R5:1", "R5.1", "R5 (2)"), then the leading token ("R5 [0603]").
 * Never strips digits without a separator: "R11" must not become "R1".
 */
export function refFromName(name, refs) {
  if (!name) return null;
  const text = String(name).trim();
  if (refs.has(text)) return text;
  const stripped = text.replace(/(?:[_:.\- ]\d+|\s*\(\d+\))+$/, '');
  if (stripped !== text && refs.has(stripped)) return stripped;
  const token = text.split(/[\s[\](){}<>,;|/\\]+/)[0];
  if (token && token !== text && refs.has(token)) return token;
  return null;
}

/** KiCad component (y down) -> board frame point {x, y}. */
export function toBoardFrame(component) {
  const [x, y] = kicadToBoard(Number(component.x) || 0, Number(component.y) || 0);
  return { x, y };
}

function median(values) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Nearer of the node's origin and its box middle: the middle covers GLBs baked into world
// coordinates and models drawn far from their own origin.
function distanceTo(node, aim) {
  const d1 = Math.hypot(node.x - aim.x, node.y - aim.y);
  const d2 = Math.hypot(node.cx - aim.x, node.cy - aim.y);
  return Math.min(d1, d2);
}

/**
 * Translation T with node ~= component + T, by a Hough vote over every (component, node) pair,
 * refined by the median of the winning bin's pairs. Returns {x, y, support} or null.
 */
export function houghTranslation(nodes, aims, binMm = HOUGH_BIN_MM) {
  if (!nodes.length || !aims.length) return null;
  const votes = new Map();
  const key = (i, j) => (i + 1048576) * 2097152 + (j + 1048576);
  for (const a of aims) {
    for (const n of nodes) {
      for (const [px, py] of [[n.x, n.y], [n.cx, n.cy]]) {
        const k = key(Math.round((px - a.x) / binMm), Math.round((py - a.y) / binMm));
        votes.set(k, (votes.get(k) || 0) + 1);
      }
    }
  }
  // Score with the 3x3 neighbourhood so a translation on a bin edge still wins.
  let best = null, bestScore = -1;
  for (const k of votes.keys()) {
    const i = Math.floor(k / 2097152) - 1048576, j = (k % 2097152) - 1048576;
    let score = 0;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) score += votes.get(key(i + di, j + dj)) || 0;
    if (score > bestScore) { bestScore = score; best = [i, j]; }
  }
  return refineTranslation(nodes, aims, { x: best[0] * binMm, y: best[1] * binMm }, binMm * 2);
}

/** Median offset of each aim's nearest node within `radius` of the guess. */
export function refineTranslation(nodes, aims, guess, radius) {
  const dx = [], dy = [];
  for (const a of aims) {
    const aim = { x: a.x + guess.x, y: a.y + guess.y };
    let best = null, bestD = radius;
    for (const n of nodes) {
      for (const [px, py] of [[n.x, n.y], [n.cx, n.cy]]) {
        const d = Math.hypot(px - aim.x, py - aim.y);
        if (d <= bestD) { bestD = d; best = [px, py]; }
      }
    }
    if (best) { dx.push(best[0] - a.x); dy.push(best[1] - a.y); }
  }
  if (!dx.length) return { x: guess.x, y: guess.y, support: 0 };
  return { x: median(dx), y: median(dy), support: dx.length };
}

/**
 * One-to-one nearest matching with an ambiguity guard (a match must be under half the
 * runner-up's distance), then mutual-nearest tie settling (gentoo settleTies).
 * nodes: [{x, y, cx, cy}]; targets: [{ref, aim: {x, y}}].
 * Returns {matched: Map ref -> node index, ambiguous: [ref], unmatched: [ref], taken: Set}.
 */
export function matchByPosition(nodes, targets, tol = MATCH_MM) {
  const taken = new Set();
  const matched = new Map();
  let ambiguous = [];
  const unmatched = [];
  // Per node, its nearest and second-nearest target: a node another part sits clearly closer to
  // is not this part's to take, however alone it is (a model-less 0402 next to a crystal).
  const nearestTargets = nodes.map((n) => {
    let a = Infinity, b = Infinity, ref = null;
    for (const t of targets) {
      const d = distanceTo(n, t.aim);
      if (d < a) { b = a; a = d; ref = t.ref; } else if (d < b) b = d;
    }
    return { ref, a, b };
  });
  const rival = (i, t) => (nearestTargets[i].ref === t.ref ? nearestTargets[i].b : nearestTargets[i].a);

  for (const t of targets) {
    let best = -1, bestD = Infinity, runnerUp = Infinity;
    nodes.forEach((n, i) => {
      if (taken.has(i)) return;
      const d = distanceTo(n, t.aim);
      if (d < bestD) { runnerUp = bestD; bestD = d; best = i; } else if (d < runnerUp) runnerUp = d;
    });
    if (best < 0 || bestD > tol) { unmatched.push(t.ref); continue; }
    // Clearly closer than the runner-up node AND than any other part to that node. Two exact
    // hits (a model split in two nodes on one origin) are not a coin toss: small floor.
    const floor = (d) => Math.max(d / 2, 0.05);
    if (bestD > floor(runnerUp) || bestD > floor(rival(best, t))) { ambiguous.push(t); continue; }
    taken.add(best);
    matched.set(t.ref, best);
  }

  // Among what is left, a node whose nearest waiting claimant is this component is its node.
  let progress = true;
  while (progress && ambiguous.length) {
    progress = false;
    for (const t of ambiguous.slice()) {
      let best = -1, bestD = Infinity;
      nodes.forEach((n, i) => {
        if (taken.has(i)) return;
        const d = distanceTo(n, t.aim);
        if (d < bestD) { bestD = d; best = i; }
      });
      if (best < 0 || bestD > tol) continue;
      if (ambiguous.some((o) => o !== t && distanceTo(nodes[best], o.aim) < bestD)) continue;
      taken.add(best);
      matched.set(t.ref, best);
      ambiguous.splice(ambiguous.indexOf(t), 1);
      progress = true;
    }
  }
  // Left with nothing free in reach: its candidate went to a closer part, so it has no geometry.
  for (const t of ambiguous.slice()) {
    if (nodes.some((n, i) => !taken.has(i) && distanceTo(n, t.aim) <= tol)) continue;
    ambiguous.splice(ambiguous.indexOf(t), 1);
    unmatched.push(t.ref);
  }
  ambiguous = ambiguous.map((t) => t.ref);
  return { matched, ambiguous, unmatched, taken };
}

/**
 * A module box -> board-frame {minX, minY, maxX, maxY, minZ?, maxZ?}, shifted by T. [x0, y0, x1, y1] or
 * [x0, y0, z0, x1, y1, z1] (z is then checked too); KiCad frame (y down) unless `flip` is false.
 */
function boardBox(box, offset, flip = true) {
  const three = box.length >= 6;
  const [x0, y0, x1, y1] = three ? [box[0], box[1], box[3], box[4]] : box;
  const [ax, ay] = flip ? kicadToBoard(x0, y0) : [x0, y0];
  const [bx, by] = flip ? kicadToBoard(x1, y1) : [x1, y1];
  const b = {
    minX: Math.min(ax, bx) + offset.x, maxX: Math.max(ax, bx) + offset.x,
    minY: Math.min(ay, by) + offset.y, maxY: Math.max(ay, by) + offset.y,
  };
  if (three) { b.minZ = Math.min(box[2], box[5]); b.maxZ = Math.max(box[2], box[5]); }
  return b;
}

/**
 * Map candidate nodes to components.
 *
 * nodes:      [{name, x, y, cx, cy}] board frame (mm, y up): origin and box middle.
 * components: [{ref, x, y, assembly?, box?}] KiCad mm (y down). An `assembly` (a module that
 *             arrives as many anonymous solids) with a `box` [x0, y0, x1, y1] claims every
 *             unclaimed node whose middle is inside it, after everything else (gentoo claimModule).
 * opts:       tol; fallbackOffset (used when nothing fits one);
 *             frame 'kicad' (default) or 'board': components (and module boxes) already in the nodes'
 *               frame, no y flip -- e.g. placements measured in the model's own coordinates;
 *             offset: a known T, used as is (no fitting);
 *             byName (true): match node names to designators first;
 *             joinExtras (true): an unclaimed node near a matched placement joins it (step 5).
 *             A module box may be [x0, y0, z0, x1, y1, z1] (node `cz` is then checked against z).
 * Returns {byRef: Map ref -> [node index], offset: {x, y}, method: 'name'|'position'|'mixed'|'none',
 *          byName, byPosition, ambiguous: [ref], unmatched: [ref], leftover: [node index]}.
 */
export function mapNodesToRefs(nodes, components, {
  tol = MATCH_MM, fallbackOffset = null, frame = 'kicad', offset: given = null, byName: useNames = true, joinExtras = true,
} = {}) {
  const flip = frame !== 'board';
  const toFrame = (c) => (flip ? toBoardFrame(c) : { x: Number(c.x) || 0, y: Number(c.y) || 0 });
  const refs = new Set(components.map((c) => c.ref));
  const byRef = new Map();
  const claimed = new Set();
  const claim = (ref, i) => {
    if (!byRef.has(ref)) byRef.set(ref, []);
    byRef.get(ref).push(i);
    claimed.add(i);
  };

  // 1. Names.
  if (useNames) {
    nodes.forEach((n, i) => {
      const ref = refFromName(n.name, refs);
      if (ref) claim(ref, i);
    });
  }
  const byName = byRef.size;

  // 2. The translation between the frames: from the named nodes, else a Hough vote.
  let offset = given ? { x: given.x, y: given.y } : null;
  if (!offset && byName) {
    const dx = [], dy = [];
    for (const c of components) {
      const idx = byRef.get(c.ref);
      if (!idx) continue;
      const a = toFrame(c);
      const n = idx.map((i) => nodes[i]).reduce((p, q) => (Math.hypot(q.x - a.x, q.y - a.y) < Math.hypot(p.x - a.x, p.y - a.y) ? q : p));
      dx.push(n.x - a.x); dy.push(n.y - a.y);
    }
    offset = { x: median(dx), y: median(dy) };
  }
  const loose = components.filter((c) => !byRef.has(c.ref) && !(c.assembly && c.box));
  const modules = components.filter((c) => !byRef.has(c.ref) && c.assembly && c.box);
  const restNodes = () => nodes.map((n, i) => ({ n, i })).filter(({ i }) => !claimed.has(i));
  if (!offset && loose.length) {
    const rest = restNodes();
    if (rest.length) {
      const t = houghTranslation(rest.map(({ n }) => n), loose.map(toFrame));
      // A vote carried by one or two pairs is noise.
      if (t && t.support >= Math.min(3, loose.length, rest.length)) offset = { x: t.x, y: t.y };
    }
  }
  if (!offset) offset = fallbackOffset || { x: 0, y: 0 };

  // 3. Positions, for what the names did not find.
  let byPosition = 0, ambiguous = [], unmatched = [];
  if (loose.length) {
    const rest = restNodes();
    const targets = loose.map((c) => {
      const a = toFrame(c);
      return { ref: c.ref, aim: { x: a.x + offset.x, y: a.y + offset.y } };
    });
    const r = matchByPosition(rest.map(({ n }) => n), targets, tol);
    for (const [ref, k] of r.matched) { claim(ref, rest[k].i); byPosition++; }
    ambiguous = r.ambiguous;
    unmatched = r.unmatched;
  }

  // 4. Modules take the unclaimed solids inside their box.
  for (const c of modules) {
    const b = boardBox(c.box, offset, flip);
    const m = MODULE_MARGIN_MM;
    const inside = restNodes().filter(({ n }) => n.cx >= b.minX - m && n.cx <= b.maxX + m && n.cy >= b.minY - m && n.cy <= b.maxY + m
      && (b.minZ === undefined || !Number.isFinite(n.cz) || (n.cz >= b.minZ - m && n.cz <= b.maxZ + m)));
    if (!inside.length) { unmatched.push(c.ref); continue; }
    for (const { i } of inside) claim(c.ref, i);
    byPosition++;
  }

  // 5. Extra pieces (body + pins as sibling nodes, several models on one footprint): an
  //    unclaimed node on a matched placement, nearer it than any other, joins it.
  const placed = !joinExtras ? [] : components.filter((c) => byRef.has(c.ref) && !c.assembly).map((c) => {
    const a = toFrame(c);
    return { ref: c.ref, x: a.x + offset.x, y: a.y + offset.y };
  });
  const leftover = [];
  nodes.forEach((n, i) => {
    if (claimed.has(i)) return;
    let best = null, bestD = tol;
    for (const p of placed) {
      const d = distanceTo(n, p);
      if (d < bestD) { bestD = d; best = p.ref; }
    }
    if (best) claim(best, i); else leftover.push(i);
  });

  const method = byName && byPosition ? 'mixed' : byName ? 'name' : byPosition ? 'position' : 'none';
  return { byRef, offset, method, byName, byPosition, ambiguous, unmatched, leftover };
}

/* ─── Board bodies ─────────────────────────────────────────────────────────────── */

// Board parts by the names KiCad's exporter gives them ("<board>_PCB", "_soldermask",
// "_silkscreen", "_pad", tracks/vias/zones).
const BOARD_KINDS = [
  ['silk', /silk/i],
  ['mask', /mask/i],
  ['copper', /copper|\bcu\b|[_\s-]cu$|pad|track|via|zone|plating/i],
  ['substrate', /(^|[_\s-])(pcb|board|substrate|core|fr-?4)($|[_\s-])/i],
];

/** 'substrate' | 'mask' | 'copper' | 'silk' for a KiCad board body name, or null. */
export function boardKindFromName(name) {
  if (!name) return null;
  for (const [kind, re] of BOARD_KINDS) if (re.test(name)) return kind;
  return null;
}

/** A board-wide body with no telling name: by colour (HSL 0..1, or null) and thickness (mm). */
export function boardKindFromLook(hsl, thicknessMm) {
  if (thicknessMm > 0.3 || !hsl) return 'substrate';
  if (hsl.l > 0.75 && hsl.s < 0.3) return 'silk';
  if (hsl.h > 0.06 && hsl.h < 0.17 && hsl.s > 0.35) return 'copper';
  return 'mask';
}

/** Area over thickness: films are near-infinitely flat, a slab is flat, a shield can is not. */
export function flatness(size) {
  return (size[0] * size[1]) / Math.max(size[2], 1e-4);
}

/**
 * Which nodes are the board's own bodies (gentoo splitBoardBodies).
 *
 * nodes: [{box: {min: [x,y,z], max: [x,y,z]}}] board frame. boardArea in mm^2.
 * measured: optional [{box: [x0,y0,z0,x1,y1,z1], ...}] boxes known for the board bodies; claimed
 *   closest pair first, so a module's film 65 um from the board's does not steal it.
 * Otherwise: board-wide (>= 50 % of the board) and flat (flatness > 200) is board; a board-wide
 * shield can is not flat and stays a component.
 * Returns {board: [index], components: [index], measuredBy: Map index -> measured entry}.
 */
export function splitBoardBodies(nodes, boardArea, measured = null) {
  const measuredBy = new Map();
  if (measured && measured.length) {
    const pairs = [];
    measured.forEach((wanted, which) => {
      nodes.forEach((node, index) => {
        const b = node.box, w = wanted.box;
        const apart = Math.max(
          Math.abs(b.min[0] - w[0]), Math.abs(b.min[1] - w[1]), Math.abs(b.min[2] - w[2]),
          Math.abs(b.max[0] - w[3]), Math.abs(b.max[1] - w[4]), Math.abs(b.max[2] - w[5]));
        if (apart <= BOARD_BOX_MM) pairs.push({ apart, which, index });
      });
    });
    pairs.sort((a, b) => a.apart - b.apart);
    const spoken = new Set();
    for (const p of pairs) {
      if (spoken.has(p.which) || measuredBy.has(p.index)) continue;
      spoken.add(p.which);
      measuredBy.set(p.index, measured[p.which]);
    }
    const board = [...measuredBy.keys()].sort((a, b) => a - b);
    return { board, components: nodes.map((_, i) => i).filter((i) => !measuredBy.has(i)), measuredBy };
  }
  const area = Math.max(boardArea || 0, 1e-6);
  const board = [], components = [];
  nodes.forEach((node, i) => {
    const size = [0, 1, 2].map((k) => node.box.max[k] - node.box.min[k]);
    const wide = (size[0] * size[1]) / area >= 0.5;
    (wide && flatness(size) > 200 ? board : components).push(i);
  });
  return { board, components, measuredBy };
}

/**
 * Board thickness and surfaces from its bodies: the substrate's z extent (named, else the
 * thickest), not the whole film stack (gentoo measureBoard).
 * bodies: [{kind?, box: {min, max}}]. Returns {bottom, top, thickness} or null.
 */
export function measureBoard(bodies) {
  const named = bodies.filter((b) => b.kind === 'substrate');
  let core = null;
  for (const b of named.length ? named : bodies) {
    const depth = b.box.max[2] - b.box.min[2];
    if (!core || depth > core.thickness) core = { bottom: b.box.min[2], top: b.box.max[2], thickness: depth };
  }
  return core && core.thickness > 0 ? core : null;
}
