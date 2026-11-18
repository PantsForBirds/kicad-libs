// boarddd/gerber: moved from CoolNamesAllTaken/wasm-gerber-viewer packages/wasm-gerber-renderer/palette.js at 92976b5
// (earlier history lives there).
/**
 * What a board looks like: the colors a realistic render is drawn in.
 *
 * Colors are chosen to look like a board rather than to be maximally
 * distinguishable -- someone checking a layout is helped by the picture
 * resembling the thing on their bench. All colors here are CSS hex strings or
 * normalized `[r, g, b]` triples (0..1), which is what the renderer takes.
 *
 * Framework-free and DOM-free; safe to import in Node, a worker or a browser.
 */

/** Bare glass-epoxy laminate: what shows where the mask is pulled back and no copper lies. */
export const SUBSTRATE_COLOR = "#c9b27c";

/** Bare copper. */
export const COPPER_COLOR = "#cc9933";

/**
 * Solder mask colors by name, as fab houses and KiCad's stackup editor name them.
 * Names are matched case-insensitively with spaces, dashes and underscores ignored,
 * so "Light Green", "light-green" and "lightgreen" are the same entry.
 */
export const MASK_COLORS = Object.freeze({
  green: "#0d5229",
  lightgreen: "#5ba80c",
  saturatedgreen: "#0d680b",
  mattegreen: "#2e5b3a",
  red: "#b51315",
  lightred: "#d2280e",
  blue: "#023ba2",
  lightblue: "#364f74",
  greenblue: "#154650",
  black: "#0b0b0b",
  matteblack: "#1c1c1c",
  white: "#f5f5f5",
  purple: "#200235",
  lightpurple: "#771f5b",
  yellow: "#c2c300",
});

/** Silkscreen (legend) colors by name. `none` means the board is ordered without one. */
export const SILK_COLORS = Object.freeze({
  white: "#f5f5f5",
  black: "#080808",
  yellow: "#e6d82e",
  red: "#c81e1e",
  blue: "#1e50c8",
  green: "#28a03c",
});

/** Surface finish on exposed copper, by name (KiCad's names and common aliases). */
export const FINISH_COLORS = Object.freeze({
  enig: "#d4af37",
  enepig: "#d4af37",
  gold: "#d4af37",
  hardgold: "#d4af37",
  hasl: "#c0c0c8",
  haslleadfree: "#c0c0c8",
  leadfreehasl: "#c0c0c8",
  immersionsilver: "#d8d8dc",
  immersiontin: "#c8c8cc",
  osp: "#cc9933",
  none: "#cc9933",
});

/**
 * Default style per generic layer role. `color` is a 0..1 triple, `alpha` 0..1.
 * The roles are the ones `layerRole()` in layers.js reports.
 */
export const LAYER_STYLES = Object.freeze({
  outline: Object.freeze({ color: [0.85, 0.85, 0.35], alpha: 1.0 }),
  copper: Object.freeze({ color: [0.8, 0.6, 0.2], alpha: 1.0 }),
  mask: Object.freeze({ color: [0.05, 0.32, 0.16], alpha: 1.0 }),
  paste: Object.freeze({ color: [0.65, 0.65, 0.7], alpha: 0.9 }),
  silk: Object.freeze({ color: [0.96, 0.96, 0.96], alpha: 1.0 }),
  fab: Object.freeze({ color: [0.45, 0.55, 0.75], alpha: 0.9 }),
  doc: Object.freeze({ color: [0.4, 0.4, 0.45], alpha: 0.8 }),
  drill: Object.freeze({ color: [0.83, 0.69, 0.22], alpha: 1.0 }),
});

/** `#rrggbb` (or `#rgb`) as a 0..1 triple, or `null` when it is not one. */
export function parseHexColor(hex) {
  const text = String(hex ?? "").trim();
  let match = /^#([0-9a-f]{6})$/i.exec(text);
  if (match) {
    const value = match[1];
    return [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16) / 255);
  }
  match = /^#([0-9a-f]{3})$/i.exec(text);
  if (match) {
    return [...match[1]].map((digit) => parseInt(digit + digit, 16) / 255);
  }
  return null;
}

/** A 0..1 triple as `#rrggbb`. */
export function toHexColor(color) {
  return (
    "#" +
    color
      .slice(0, 3)
      .map((channel) =>
        Math.round(Math.min(1, Math.max(0, Number(channel))) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

function colorKey(name) {
  return String(name).toLowerCase().replace(/[\s_\-()]+/g, "");
}

/**
 * Any color this module understands as a 0..1 triple: a triple, a hex string,
 * or a name looked up in `table` (e.g. `MASK_COLORS`). Returns `null` when the
 * value is empty or unknown.
 */
export function resolveColor(value, table = {}) {
  if (value == null || value === "") return null;
  if (Array.isArray(value)) {
    if (value.length < 3 || !value.slice(0, 3).every(Number.isFinite)) return null;
    return value.slice(0, 3).map(Number);
  }
  const hex = parseHexColor(value);
  if (hex) return hex;
  const named = table[colorKey(value)];
  return named ? parseHexColor(named) : null;
}

/** A mask color (name, hex or triple) as a triple, or `null`. */
export function maskColor(value) {
  return resolveColor(value, MASK_COLORS);
}

/** A silkscreen color as a triple, `"none"` for no silkscreen, or `null` when unknown. */
export function silkColor(value) {
  if (typeof value === "string" && colorKey(value) === "none") return "none";
  return resolveColor(value, SILK_COLORS);
}

/** A surface finish (name, hex or triple) as a triple, or `null`. */
export function finishColor(value) {
  return resolveColor(value, FINISH_COLORS);
}

/**
 * A complete palette for a realistic board render, with every color resolved.
 *
 * Every option may be a name, hex or triple; omitted ones take the defaults
 * (green mask, white silk, ENIG finish). `silk: "none"` hides the silkscreen.
 * `maskAlpha` below 1 lets copper show through the mask as a lighter tint,
 * which is how a real board looks.
 *
 * @returns {{substrate: number[], copper: number[], finish: number[],
 *   mask: {color: number[], alpha: number}, silk: {color: number[], alpha: number} | null,
 *   paste: {color: number[], alpha: number}, plating: number[]}}
 */
export function boardPalette(options = {}) {
  const substrate = resolveColor(options.substrate) ?? parseHexColor(SUBSTRATE_COLOR);
  const copper = resolveColor(options.copper) ?? parseHexColor(COPPER_COLOR);
  const finish = finishColor(options.finish) ?? parseHexColor(FINISH_COLORS.enig);
  const mask = maskColor(options.mask) ?? parseHexColor(MASK_COLORS.green);
  const silk = options.silk === undefined ? parseHexColor(SILK_COLORS.white) : silkColor(options.silk);
  const maskAlpha = clampAlpha(options.maskAlpha, 0.9);
  const silkAlpha = clampAlpha(options.silkAlpha, 1);
  return {
    substrate,
    copper,
    finish,
    mask: { color: mask, alpha: maskAlpha },
    silk:
      silk === "none"
        ? null
        : { color: silk ?? parseHexColor(SILK_COLORS.white), alpha: silkAlpha },
    paste: {
      color: resolveColor(options.paste) ?? [...LAYER_STYLES.paste.color],
      alpha: clampAlpha(options.pasteAlpha, LAYER_STYLES.paste.alpha),
    },
    plating: resolveColor(options.plating) ?? finish,
  };
}

function clampAlpha(value, fallback) {
  const number = Number(value);
  if (value == null || !Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}
