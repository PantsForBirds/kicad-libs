// Hit-testing in world mm: shapes with an exact distance test and a grid index, so "what is under the
// pointer" is a lookup, not a walk over every pad or track on each move. Pure.
// The pick rule is gentoo's (fab/static/fab/guide/stage.js padIndex): the smallest shape under the
// point wins, unless that is background (20x the area of a near miss) and a small shape is within slack.

const area = (b) => Math.max(b.maxX - b.minX, 1e-9) * Math.max(b.maxY - b.minY, 1e-9);

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** A track / line of `width` mm from (x1, y1) to (x2, y2), round ends. */
export function segmentShape(x1, y1, x2, y2, width = 0, data = null) {
  const r = width / 2;
  return {
    kind: 'segment', x1, y1, x2, y2, width, data,
    bounds: { minX: Math.min(x1, x2) - r, maxX: Math.max(x1, x2) + r, minY: Math.min(y1, y2) - r, maxY: Math.max(y1, y2) + r },
    area: Math.hypot(x2 - x1, y2 - y1) * Math.max(width, 1e-3) + Math.PI * r * r,
    distance: (x, y) => Math.max(0, segDist(x, y, x1, y1, x2, y2) - r),
  };
}

/** An axis-aligned rect centred on (x, y), w x h mm. */
export function rectShape(x, y, w, h, data = null) {
  return {
    kind: 'rect', x, y, w, h, data,
    bounds: { minX: x - w / 2, maxX: x + w / 2, minY: y - h / 2, maxY: y + h / 2 },
    area: w * h,
    distance: (px, py) => Math.hypot(Math.max(0, Math.abs(px - x) - w / 2), Math.max(0, Math.abs(py - y) - h / 2)),
  };
}

/** A circle of diameter d mm. */
export function circleShape(x, y, d, data = null) {
  const r = d / 2;
  return {
    kind: 'circle', x, y, d, data,
    bounds: { minX: x - r, maxX: x + r, minY: y - r, maxY: y + r },
    area: Math.PI * r * r,
    distance: (px, py) => Math.max(0, Math.hypot(px - x, py - y) - r),
  };
}

/** A closed polygon ([[x, y], ...]), filled even-odd. */
export function polygonShape(points, data = null) {
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity; let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    a += x * y2 - x2 * y;
  }
  return {
    kind: 'polygon', points, data,
    bounds: { minX, maxX, minY, maxY },
    area: Math.abs(a / 2),
    distance(px, py) {
      let inside = false;
      let best = Infinity;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
        best = Math.min(best, segDist(px, py, xi, yi, xj, yj));
      }
      return inside ? 0 : best;
    },
  };
}

/**
 * A grid index over shapes ({ bounds, distance(x, y), area?, data }). `at(x, y, slack)` is the
 * shape picked at a point (slack in mm: callers pass a few screen pixels' worth, stage.mmPerPx()).
 */
export function createHitIndex(shapes = [], { cell = 0 } = {}) {
  const list = shapes.filter((s) => s && s.bounds && typeof s.distance === 'function');
  let size = cell;
  if (!(size > 0)) {
    // about one shape per cell on average, never finer than 0.1 mm
    const mean = list.length ? list.reduce((t, s) => t + Math.sqrt(area(s.bounds)), 0) / list.length : 1;
    size = Math.max(0.1, mean * 2);
  }
  const grid = new Map();
  const big = []; // shapes spanning many cells: tested every time
  for (const s of list) {
    const b = s.bounds;
    const x0 = Math.floor(b.minX / size); const x1 = Math.floor(b.maxX / size);
    const y0 = Math.floor(b.minY / size); const y1 = Math.floor(b.maxY / size);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 256) { big.push(s); continue; }
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const k = `${gx},${gy}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(s);
      }
    }
  }

  function near(x, y, slack) {
    const seen = new Set();
    const out = [];
    const test = (s) => {
      if (seen.has(s)) return;
      seen.add(s);
      const d = s.distance(x, y);
      if (d <= slack) out.push({ shape: s, d });
    };
    for (let gx = Math.floor((x - slack) / size); gx <= Math.floor((x + slack) / size); gx++) {
      for (let gy = Math.floor((y - slack) / size); gy <= Math.floor((y + slack) / size); gy++) {
        for (const s of grid.get(`${gx},${gy}`) || []) test(s);
      }
    }
    for (const s of big) test(s);
    return out;
  }

  const sizeOf = (s) => s.area ?? area(s.bounds);
  return {
    shapes: list,
    /** Every shape within `slack` mm of (x, y), nearest first. */
    all(x, y, slack = 0) {
      return near(x, y, slack).sort((a, b) => a.d - b.d || sizeOf(a.shape) - sizeOf(b.shape)).map((h) => h.shape);
    },
    /** The shape picked at (x, y), or null. */
    at(x, y, slack = 0) {
      const hits = near(x, y, slack);
      if (!hits.length) return null;
      const inside = hits.filter((h) => h.d === 0).map((h) => h.shape);
      const nearest = (hs) => hs.reduce((best, h) => (!best || h.d < best.d ? h : best), null)?.shape ?? null;
      if (!inside.length) return nearest(hits);
      const under = inside.reduce((best, s) => (sizeOf(s) < sizeOf(best) ? s : best));
      const small = hits.filter((h) => h.d > 0 && sizeOf(h.shape) * 20 < sizeOf(under));
      return small.length ? nearest(small) : under;
    },
  };
}
