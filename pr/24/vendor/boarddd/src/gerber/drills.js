// boarddd/gerber: moved from CoolNamesAllTaken/wasm-gerber-viewer packages/wasm-gerber-renderer/drills.js at 92976b5
// (earlier history lives there).
/**
 * Holes: reading them out of an Excellon file, comparing two revisions of
 * them, and drawing them as openings you can see through.
 *
 * The renderer draws drill files itself (as an overlay, and -- with no frame
 * background -- as openings erased from everything under them; see board.js).
 * This module is for hosts that need the holes as data: an SVG/DOM overlay
 * over the canvas, a CSS mask that cuts holes through an element (and through
 * any CSS background behind the render), a 2D canvas cut, a 3D model, or a
 * list of added/removed holes between two revisions.
 *
 * A hole is `{ x, y, diameter, plated, x2?, y2? }` in file units converted to
 * millimeters; `x2`/`y2` are the far end of a routed slot (`null` for a round
 * hole). Anything else on the object (e.g. `filled`) is carried through.
 *
 * Everything except `drillShape()` (which creates SVG elements) and
 * `applyHoleMask()` (which sets element styles) is DOM-free.
 */

// ── Parsing ─────────────────────────────────────────────────────────────────

// KiCad writes Gerber attributes into Excellon as comments:
//   ; #@! TA.AperFunction,Plated,PTH,ViaDrill
//   ; #@! TA.AperFunction,NonPlated,NPTH,ComponentDrill
const APER_FUNCTION = /TA\.AperFunction,([^,\s]+)/i;
const TOOL_DEF = /^T(\d+)(?:[A-BD-Z][-\d.]*)*C([-+]?[\d.]+)/i;
const TOOL_SELECT = /^T(\d+)\s*$/i;
// A hole, or a slot in the G85 canned form: X…Y… optionally followed by G85X…Y….
// Either axis may be omitted and holds its last value (modal coordinates).
const HOLE = /^(?:X([-+]?[\d.]+))?(?:Y([-+]?[\d.]+))?(?:G85(?:X([-+]?[\d.]+))?(?:Y([-+]?[\d.]+))?)?$/i;
// Rout mode: G00 positions, G01 cuts, G02/G03 cut an arc (taken as its chord).
const ROUT = /^G0([0-3])(?:X([-+]?[\d.]+))?(?:Y([-+]?[\d.]+))?/i;
const UNITS = /^(METRIC|INCH)(?:,(LZ|TZ))?(?:,(0+)\.(0+))?/i;
const KICAD_FORMAT = /FORMAT=\{(\d+):(\d+)\/\s*\w+\s*\/\s*(metric|inch)\s*\/\s*([^}]*)\}/i;

// What a hit or a rout move looks like in the body, for dropping a tool's hits.
const MOTION = /^(?:[XY][-+\d.]|G0[0-3]|G85|M1[5-7]\b)/i;

/**
 * An Excellon file without its zero- or negative-diameter tools and their
 * hits, plus what was dropped. KiCad 10 writes `T1C0.000` for vias with no
 * drill (its royalblue54L_feather demo has 180 of them), and the renderer's
 * wasm rejects the whole file ("Drill tool diameter must be positive"), so
 * the board would lose every real hole with it. Everything else in the file
 * is kept byte for byte; a file with no such tool comes back unchanged.
 *
 * Returns `{ text, dropped: [{ tool, diameter, hits }], warning }` where
 * `diameter` is in file units and `warning` is a one-line message (or
 * `null` when nothing was dropped). The renderer, `board.js` and `diff.js`
 * all go through this; call it yourself before handing Excellon text to the
 * wasm by some other route.
 */
export function dropEmptyTools(text) {
  const source = String(text ?? "");
  const lines = source.split(/\r?\n/);
  const empty = new Map();
  for (const raw of lines) {
    const found = TOOL_DEF.exec(raw.trim());
    if (found && !(Number(found[2]) > 0)) {
      const tool = Number(found[1]);
      if (!empty.has(tool)) empty.set(tool, { tool, diameter: Number(found[2]), hits: 0 });
    }
  }
  if (!empty.size) return { text, dropped: [], warning: null };

  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const out = [];
  let dropping = null;
  let inBody = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "%" || /^M95\b/i.test(line)) inBody = true;
    const definition = TOOL_DEF.exec(line);
    const select = definition && inBody ? definition : TOOL_SELECT.exec(line);
    if (definition && !inBody) {
      if (!empty.has(Number(definition[1]))) out.push(raw);
      continue;
    }
    if (select) {
      dropping = empty.get(Number(select[1])) ?? null;
      if (!dropping) out.push(raw);
      continue;
    }
    if (dropping && MOTION.test(line)) {
      if (/^[XY]/i.test(line)) dropping.hits += 1;
      continue;
    }
    if (/^(M30|M00)\b/i.test(line)) dropping = null;
    out.push(raw);
  }
  const dropped = [...empty.values()];
  const hits = dropped.reduce((sum, entry) => sum + entry.hits, 0);
  const tools = dropped.map((entry) => `T${entry.tool}C${entry.diameter}`).join(", ");
  return {
    text: out.join(newline),
    dropped,
    warning:
      `Dropped ${dropped.length === 1 ? "a drill tool" : `${dropped.length} drill tools`} ` +
      `with no diameter (${tools}) and ${hits} ${hits === 1 ? "hit" : "hits"}`,
  };
}

/** `dropEmptyTools(text).text`: the Excellon text without zero-diameter tools. */
export function withoutEmptyTools(text) {
  return dropEmptyTools(text).text;
}

/**
 * Every hole in an Excellon drill file, round holes and slots alike.
 *
 * Handles what EDA tools emit in practice: METRIC/INCH headers, decimal
 * coordinates, implied-decimal coordinates with LZ/TZ and an explicit or
 * default (3.3 metric, 2.4 inch) format, KiCad's plating comments, G85 slots
 * and rout-mode slots (G00 / M15 / G01 / M16). Not a general Excellon reader:
 * no repeat codes, no tool compensation. Coordinates come out in millimeters.
 *
 * A tool with no plating attribute counts as plated unless the file name
 * passed as `options.plated` says otherwise (`false` for an NPTH file).
 *
 * Hits of a tool with no diameter (KiCad 10's `T1C0.000`) are left out;
 * `options.onWarning(message)` hears about them once per file.
 */
export function parseExcellon(text, options = {}) {
  const lines = String(text ?? "").split(/\r?\n/);
  let metric = true;
  let zeros = "LZ"; // which zeros are present: LZ = leading kept, TZ = trailing kept
  let integerDigits = null;
  let decimalDigits = null;
  const defaultPlated = options.plated ?? true;

  const diameters = new Map();
  const plating = new Map();
  let pendingPlated = null;
  let current = null;
  let inBody = false;
  let routDown = false;
  let at = null; // last position, for modal coordinates and rout cuts
  const holes = [];

  const scale = () => (metric ? 1 : 25.4);
  const coordinate = (raw) => {
    if (raw == null) return null;
    if (raw.includes(".")) return Number(raw) * scale();
    const negative = raw.startsWith("-");
    const digits = raw.replace(/^[-+]/, "");
    const intDigits = integerDigits ?? (metric ? 3 : 2);
    const decDigits = decimalDigits ?? (metric ? 3 : 4);
    let value;
    if (zeros === "TZ") {
      // Trailing zeros kept, leading ones suppressed: the decimals are the rightmost digits.
      value = Number(digits) / 10 ** decDigits;
    } else {
      // Leading zeros kept, trailing ones suppressed: the integer part is the leftmost digits.
      const padded = digits.padEnd(intDigits + decDigits, "0");
      value = Number(padded.slice(0, intDigits) + "." + padded.slice(intDigits));
    }
    return (negative ? -value : value) * scale();
  };

  let skipped = 0;
  const add = (x, y, x2 = null, y2 = null) => {
    const diameter = current == null ? 0 : diameters.get(current) ?? 0;
    if (!(diameter > 0)) {
      skipped += 1;
      return;
    }
    holes.push({
      x,
      y,
      diameter,
      plated: plating.get(current) ?? defaultPlated,
      x2,
      y2,
    });
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith(";")) {
      const found = APER_FUNCTION.exec(line);
      if (found) pendingPlated = found[1].trim().toLowerCase() !== "nonplated";
      const format = KICAD_FORMAT.exec(line);
      if (format) {
        integerDigits = Number(format[1]);
        decimalDigits = Number(format[2]);
        metric = format[3].toLowerCase() === "metric";
        const suppression = format[4].toLowerCase();
        if (suppression.includes("suppress trailing")) zeros = "LZ";
        else if (suppression.includes("suppress leading")) zeros = "TZ";
      }
      continue;
    }
    if (line === "%" || /^M95\b/i.test(line)) {
      inBody = true;
      continue;
    }
    const units = UNITS.exec(line);
    if (units) {
      metric = units[1].toUpperCase() === "METRIC";
      if (units[2]) zeros = units[2].toUpperCase();
      if (units[3]) {
        integerDigits = units[3].length;
        decimalDigits = units[4].length;
      }
      continue;
    }
    if (/^M72\b/i.test(line)) {
      metric = false;
      continue;
    }
    if (/^M71\b/i.test(line)) {
      metric = true;
      continue;
    }
    if (/^M15\b/i.test(line)) {
      routDown = true;
      continue;
    }
    if (/^M1[67]\b/i.test(line)) {
      routDown = false;
      continue;
    }
    if (/^G05\b/i.test(line)) {
      at = null;
      routDown = false;
      continue;
    }
    if (/^(M48|M30|M00|FMAT|G90|G91|ICI|VER|DETECT|ATC)/i.test(line)) continue;

    const definition = TOOL_DEF.exec(line);
    if (definition && !inBody) {
      const tool = Number(definition[1]);
      diameters.set(tool, Number(definition[2]) * scale());
      plating.set(tool, pendingPlated ?? defaultPlated);
      pendingPlated = null;
      continue;
    }
    if (definition && inBody) {
      // A tool defined in the body (legal, rare): define and select it.
      const tool = Number(definition[1]);
      if (!diameters.has(tool)) diameters.set(tool, Number(definition[2]) * scale());
      current = tool;
      at = null;
      routDown = false;
      continue;
    }
    const select = TOOL_SELECT.exec(line);
    if (select) {
      current = Number(select[1]);
      at = null;
      routDown = false;
      continue;
    }

    const motion = ROUT.exec(line);
    if (motion) {
      const x = coordinate(motion[2]) ?? at?.[0] ?? null;
      const y = coordinate(motion[3]) ?? at?.[1] ?? null;
      if (x == null || y == null) continue;
      if (routDown && at && (x !== at[0] || y !== at[1])) {
        add(at[0], at[1], x, y);
      }
      at = [x, y];
      continue;
    }

    const hit = HOLE.exec(line);
    if (hit && current != null && (hit[1] != null || hit[2] != null)) {
      const x = coordinate(hit[1]) ?? at?.[0] ?? null;
      const y = coordinate(hit[2]) ?? at?.[1] ?? null;
      if (x == null || y == null) continue;
      const slotted = hit[3] != null || hit[4] != null;
      const x2 = slotted ? coordinate(hit[3]) ?? x : null;
      const y2 = slotted ? coordinate(hit[4]) ?? y : null;
      at = slotted ? [x2, y2] : [x, y];
      add(x, y, x2, y2);
    }
  }
  if (skipped && typeof options.onWarning === "function") {
    options.onWarning(`Left out ${skipped} drill ${skipped === 1 ? "hit" : "hits"} of tools with no diameter`);
  }
  return holes;
}

function holeKey(hole, digits = 3) {
  const round = (value) => Number(value).toFixed(digits);
  const ends = [`${round(hole.x)},${round(hole.y)}`];
  if (hole.x2 != null && hole.y2 != null) ends.push(`${round(hole.x2)},${round(hole.y2)}`);
  ends.sort();
  return `${ends.join("|")}|${round(hole.diameter ?? hole.d)}`;
}

/**
 * Each hole once, however many files listed it (a KiCad export often carries
 * a combined drill file and a PTH/NPTH pair). Position, size and both ends of
 * a slot (unordered) to the micron; the first listing wins.
 */
export function distinctHoles(holes) {
  const seen = new Set();
  const result = [];
  for (const hole of holes) {
    const key = holeKey(hole);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(hole);
  }
  return result;
}

/**
 * Holes added, removed and unchanged between two revisions, matched by
 * position, size and slot ends to `tolerance` millimeters (default 1 µm).
 * Plating changes count as a removal plus an addition.
 */
export function diffHoles(baseHoles, headHoles, { tolerance = 0.001 } = {}) {
  const digits = Math.max(0, Math.round(-Math.log10(tolerance)));
  const key = (hole) => `${holeKey(hole, digits)}|${hole.plated === false ? "n" : "p"}`;
  const remaining = new Map();
  for (const hole of headHoles) {
    const k = key(hole);
    if (!remaining.has(k)) remaining.set(k, []);
    remaining.get(k).push(hole);
  }
  const removed = [];
  const unchanged = [];
  for (const hole of baseHoles) {
    const bucket = remaining.get(key(hole));
    if (bucket && bucket.length) {
      bucket.shift();
      unchanged.push(hole);
    } else {
      removed.push(hole);
    }
  }
  const added = [...remaining.values()].flat();
  return { added, removed, unchanged, changed: added.length + removed.length > 0 };
}

// ── Projection and drawing ─────────────────────────────────────────────────

/**
 * Holes projected into canvas CSS pixels as `[near, far, radius, hole]`:
 * `near`/`far` are `[x, y]` (far is `null` for a round hole). Filled-and-capped
 * holes (`hole.filled`) are left out -- they have no opening. `project` is a
 * `(x, y) => [px, py]` function, e.g. `(x, y) => project(view, x, y, opts)`
 * from view.js; `pixelsPerMm` converts diameters. Radii are at least
 * `minRadius` so a tiny via stays visible.
 */
export function projectHoles(holes, projectPoint, pixelsPerMm, { minRadius = 0.6 } = {}) {
  return holes
    .filter((hole) => !hole.filled)
    .map((hole) => [
      projectPoint(hole.x, hole.y),
      hole.x2 == null || hole.y2 == null ? null : projectPoint(hole.x2, hole.y2),
      Math.max(minRadius, ((hole.diameter ?? hole.d) / 2) * pixelsPerMm),
      hole,
    ]);
}

const SVG_NS = "http://www.w3.org/2000/svg";
const fixed = (value) => Number(value).toFixed(2);

/**
 * The outline of a routed slot (a stadium: two flanks and a semicircular cap
 * at each end) as SVG path data, in the same pixels as its projected ends.
 * Both caps are drawn with sweep-flag 0, which bulges each away from the
 * other end in any orientation once y points down.
 */
export function slotPath(x1, y1, x2, y2, radius) {
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (length === 0) return circlePath(x1, y1, radius);
  const nx = (-(y2 - y1) / length) * radius;
  const ny = ((x2 - x1) / length) * radius;
  const at = (x, y) => `${fixed(x)},${fixed(y)}`;
  const arc = `A${fixed(radius)},${fixed(radius)} 0 0 0 `;
  return (
    `M${at(x1 + nx, y1 + ny)} L${at(x2 + nx, y2 + ny)} ${arc}${at(x2 - nx, y2 - ny)}` +
    ` L${at(x1 - nx, y1 - ny)} ${arc}${at(x1 + nx, y1 + ny)} Z`
  );
}

/** A round hole as SVG path data: two half-circle arcs. */
export function circlePath(x, y, radius) {
  const r = fixed(radius);
  return (
    `M${fixed(x + radius)},${fixed(y)} A${r},${r} 0 1 0 ${fixed(x - radius)},${fixed(y)}` +
    ` A${r},${r} 0 1 0 ${fixed(x + radius)},${fixed(y)} Z`
  );
}

/** SVG path data for every projected hole (`projectHoles()` output). */
export function holesPath(projected) {
  return projected
    .map(([near, far, radius]) =>
      !far || (far[0] === near[0] && far[1] === near[1])
        ? circlePath(near[0], near[1], radius)
        : slotPath(near[0], near[1], far[0], far[1], radius),
    )
    .join(" ");
}

/**
 * The SVG element for one projected hole: a `circle`, or a stadium `path` for
 * a slot. Fill is the opening, stroke the rim -- style with CSS. Needs a DOM
 * (`document`, or pass one).
 */
export function drillShape(near, far, radius, doc = globalThis.document) {
  const [x1, y1] = near;
  if (!far || (far[0] === x1 && far[1] === y1)) {
    const circle = doc.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", fixed(x1));
    circle.setAttribute("cy", fixed(y1));
    circle.setAttribute("r", fixed(radius));
    return circle;
  }
  const path = doc.createElementNS(SVG_NS, "path");
  path.setAttribute("d", slotPath(x1, y1, far[0], far[1], radius));
  return path;
}

/**
 * A CSS `mask-image` value that cuts every projected hole out of an element
 * `width` x `height` CSS pixels, or `""` when there is nothing to cut.
 *
 * A mask rather than subpaths in a clip-path: a clip only subtracts with fill
 * rules, and overlapping holes cancel back to solid under even-odd. In a mask
 * the holes are painted black over white, and paint does not cancel. An SVG
 * data URL, which works as an image mask on HTML elements in every browser.
 * Because the element itself is masked, its CSS background (e.g. a substrate
 * color painted behind a transparent render) is cut too.
 */
export function holeMask(projected, width, height) {
  if (!projected.length) return "";
  const d = holesPath(projected);
  const w = fixed(width);
  const h = fixed(height);
  const svg =
    `<svg xmlns="${SVG_NS}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}">` +
    `<rect width="${w}" height="${h}" fill="#fff"/><path d="${d}" fill="#000"/></mask>` +
    `<rect width="${w}" height="${h}" fill="#fff" mask="url(#m)"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * Set (or with `""` clear) a `holeMask()` on an element, sized to its box.
 * Sets the `-webkit-` properties too (Safari before 15.4 needs them).
 */
export function applyHoleMask(element, mask) {
  const style = element.style;
  style.maskImage = style.webkitMaskImage = mask;
  style.maskSize = style.webkitMaskSize = mask ? "100% 100%" : "";
  style.maskRepeat = style.webkitMaskRepeat = mask ? "no-repeat" : "";
}

/**
 * Erase projected holes from a 2D canvas context (`destination-out`), so what
 * is behind the canvas shows through. Coordinates are in the context's
 * current transform; restores the composite operation afterwards.
 */
export function cutHoles(context, projected) {
  if (!projected.length) return;
  const previous = context.globalCompositeOperation;
  context.globalCompositeOperation = "destination-out";
  context.fillStyle = "#000";
  context.beginPath();
  for (const [near, far, radius] of projected) {
    if (!far || (far[0] === near[0] && far[1] === near[1])) {
      context.moveTo(near[0] + radius, near[1]);
      context.arc(near[0], near[1], radius, 0, Math.PI * 2);
    } else {
      const angle = Math.atan2(far[1] - near[1], far[0] - near[0]);
      context.moveTo(
        near[0] + Math.cos(angle + Math.PI / 2) * radius,
        near[1] + Math.sin(angle + Math.PI / 2) * radius,
      );
      context.arc(near[0], near[1], radius, angle + Math.PI / 2, angle + (3 * Math.PI) / 2);
      context.arc(far[0], far[1], radius, angle - Math.PI / 2, angle + Math.PI / 2);
      context.closePath();
    }
  }
  // Nonzero: every subpath is wound the same way, and overlapping holes stay open.
  context.fill("nonzero");
  context.globalCompositeOperation = previous;
}

/**
 * Holes as an RS-274X Gerber: each round hole a circle flash, each slot a
 * stroke with a round aperture of the hole's diameter. Lets holes go wherever
 * an ordinary Gerber layer can -- a composite, a layer diff, a mask cut.
 */
export function holesToGerber(holes) {
  const apertures = new Map();
  for (const hole of holes) {
    const diameter = Number(hole.diameter ?? hole.d);
    if (!(diameter > 0)) continue;
    const key = diameter.toFixed(6);
    if (!apertures.has(key)) apertures.set(key, 10 + apertures.size);
  }
  const coordinate = (value) => String(Math.round(Number(value) * 1e6));
  const lines = ["%FSLAX46Y46*%", "%MOMM*%", "%LPD*%", "G01*"];
  for (const [key, code] of apertures) lines.push(`%ADD${code}C,${key}*%`);
  let selected = null;
  for (const hole of holes) {
    const diameter = Number(hole.diameter ?? hole.d);
    if (!(diameter > 0)) continue;
    const code = apertures.get(diameter.toFixed(6));
    if (code !== selected) {
      lines.push(`D${code}*`);
      selected = code;
    }
    const at = `X${coordinate(hole.x)}Y${coordinate(hole.y)}`;
    if (hole.x2 == null || hole.y2 == null || (hole.x2 === hole.x && hole.y2 === hole.y)) {
      lines.push(`${at}D03*`);
    } else {
      lines.push(`${at}D02*`, `X${coordinate(hole.x2)}Y${coordinate(hole.y2)}D01*`);
    }
  }
  lines.push("M02*");
  return lines.join("\n") + "\n";
}
