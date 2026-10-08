// boarddd/gerber: moved from CoolNamesAllTaken/wasm-gerber-viewer packages/wasm-gerber-renderer/layers.js at 92976b5
// (earlier history lives there).
/**
 * Reading a Gerber for what it is a picture OF: which physical layer it is,
 * and which of its strokes are the board outline plotted onto it for reference.
 *
 * Pure string processing; no DOM, no WebGL. Safe in Node, workers and browsers.
 */

// ── Board profile plotted onto other layers ─────────────────────────────────
//
// KiCad (and other tools) can plot the board outline onto every layer --
// "plot on all layers" against Edge.Cuts -- and Gerber X2 says so: those
// strokes use an aperture carrying `%TA.AperFunction,Profile*%`. On a copper
// plot that is invisible, but once a layer becomes geometry (traced paste, a
// realistic board face) the outline turns into a ring of paste or silk around
// the board. The attribute is the only thing that tells those strokes from
// real ones, so they are removed by attribute, never by position.

/** `%TA.AperFunction,Profile*%` opens an attribute applied to apertures defined after it. */
const APERTURE_FUNCTION = /^%TA\.AperFunction,([^,*]*)/i;
/** `%TD*%` clears every attribute, `%TD.AperFunction*%` just this one. */
const CLEAR_ATTRIBUTE = /^%TD(\.AperFunction)?\*%/i;
/** `%ADD14C,0.100000*%`: the definition that picks up whatever attribute is open. */
const APERTURE_DEFINE = /^%ADD(\d+)/;
/** `D14*` alone on a line (optionally after G54): the aperture following operations use. */
const APERTURE_SELECT = /^(?:G54)?D(\d+)\*$/;
/** An operation that draws or moves with the current aperture (D01/D02/D03). */
const DRAW = /D0[123]\*$/;
/**
 * `G36*`/`G37*` open or close a region, whose boundary uses the same D01/D02
 * syntax but is not drawn with the current aperture. KiCad does not re-select an
 * aperture before regions, so stripping stops at a region: otherwise every
 * glyph of a silkscreen that follows the profile block would be deleted.
 */
const REGION = /^G3[67]\*/;

function profileApertures(lines) {
  const found = new Set();
  let attribute = "";
  for (const line of lines) {
    const stripped = line.trim();
    const opened = APERTURE_FUNCTION.exec(stripped);
    if (opened) {
      attribute = opened[1].trim().toLowerCase();
      continue;
    }
    if (CLEAR_ATTRIBUTE.test(stripped)) {
      attribute = "";
      continue;
    }
    const defined = APERTURE_DEFINE.exec(stripped);
    if (defined && attribute === "profile") {
      found.add(defined[1]);
    }
  }
  return found;
}

/**
 * Whether this Gerber has the board outline plotted onto it (apertures with
 * `.AperFunction,Profile`). Worth reporting on its own: a stencil house cuts the
 * paste layer as given, so an outline there is a real slit in the stencil.
 */
export function plotsProfile(text) {
  return (
    typeof text === "string" &&
    text.includes("AperFunction") &&
    profileApertures(text.split(/\r?\n/)).size > 0
  );
}

/**
 * The same Gerber with the board profile strokes taken out. Every other byte,
 * aperture definitions and selections included, is kept. Text without a
 * Profile aperture is returned unchanged (the identical string).
 */
export function withoutProfile(text) {
  if (typeof text !== "string" || !text.includes("AperFunction")) return text;
  const lines = text.split(/(?<=\n)/);
  // Two passes: an aperture can be selected before the block defining it is read.
  const profile = profileApertures(lines);
  if (profile.size === 0) return text;

  const kept = [];
  let drawing = false;
  for (const line of lines) {
    const stripped = line.trim();
    const selected = APERTURE_SELECT.exec(stripped);
    if (selected) {
      drawing = profile.has(selected[1]);
      kept.push(line);
      continue;
    }
    if (REGION.test(stripped)) drawing = false;
    if (drawing && DRAW.test(stripped)) continue;
    kept.push(line);
  }
  return kept.join("");
}

/** The layer envelope `loadOdbJob()` hands out for an ODB++ layer (the wasm reads it like Gerber text). */
const ODB_ENVELOPE = /^%ODB\+\+LAYER%/;
/** An ODB++ pad, line, arc, surface, text or barcode record (upstream job-loader's check). */
const ODB_FEATURE = /^[PLAST] |^B /m;

/**
 * Whether a Gerber draws anything: a D01 (interpolate) or D03 (flash)
 * operation, or a region. Exporters write a header-only file for a layer with
 * nothing on it (KiCad's B.SilkS on a board without bottom silkscreen); the
 * renderer rejects such a file, so callers skip it. An ODB++ layer envelope
 * (`loadOdbJob()`) draws something when it has a feature record.
 */
export function hasGeometry(text) {
  if (typeof text !== "string") return false;
  if (ODB_ENVELOPE.test(text)) return ODB_FEATURE.test(text);
  return /D0?[13]\*|G36\*/.test(text);
}

// ── Which layer is this? ────────────────────────────────────────────────────

/**
 * Roles reported by `layerRole()`:
 * `copper`, `mask`, `silk`, `paste`, `outline`, `drill`, `fab`, `doc`, `other`.
 */
export const LAYER_ROLES = Object.freeze([
  "copper",
  "mask",
  "silk",
  "paste",
  "outline",
  "drill",
  "fab",
  "doc",
  "other",
]);

const FILE_FUNCTION = /%TF\.FileFunction,([^*]*)\*%/i;

function fromFileFunction(content) {
  const match = FILE_FUNCTION.exec(content.slice(0, 20000));
  if (!match) return null;
  const parts = match[1].split(",").map((part) => part.trim());
  const kind = parts[0].toLowerCase();
  const sideOf = (value) => {
    const lower = String(value ?? "").toLowerCase();
    if (lower === "top") return "top";
    if (lower === "bot" || lower === "bottom") return "bottom";
    if (lower === "inr" || lower === "inner") return "inner";
    return null;
  };
  switch (kind) {
    case "copper": {
      const index = /^L(\d+)$/i.exec(parts[1] ?? "");
      return {
        role: "copper",
        side: sideOf(parts[2]),
        index: index ? Number(index[1]) : null,
      };
    }
    case "soldermask":
      return { role: "mask", side: sideOf(parts[1]) };
    case "legend":
      return { role: "silk", side: sideOf(parts[1]) };
    case "paste":
      return { role: "paste", side: sideOf(parts[1]) };
    case "profile":
      return { role: "outline", side: null };
    case "plated":
    case "nonplated":
      return { role: "drill", side: null, plated: kind === "plated" };
    case "assemblydrawing":
      return { role: "fab", side: sideOf(parts[1]) };
    case "other":
    case "drawing":
    case "fabricationdrawing":
      return { role: "doc", side: null };
    default:
      return null;
  }
}

const NAME_RULES = [
  // KiCad layer names inside file names: board-F_Cu.gbr, board-In2_Cu.g3, board-Edge_Cuts.gm1
  [/(^|[^a-z0-9])f[._]cu([^a-z0-9]|$)/i, { role: "copper", side: "top" }],
  [/(^|[^a-z0-9])b[._]cu([^a-z0-9]|$)/i, { role: "copper", side: "bottom" }],
  [/(^|[^a-z0-9])in(\d+)[._]cu([^a-z0-9]|$)/i, { role: "copper", side: "inner" }],
  [/(^|[^a-z0-9])f[._]mask([^a-z0-9]|$)/i, { role: "mask", side: "top" }],
  [/(^|[^a-z0-9])b[._]mask([^a-z0-9]|$)/i, { role: "mask", side: "bottom" }],
  [/(^|[^a-z0-9])f[._]silks?(creen)?([^a-z0-9]|$)/i, { role: "silk", side: "top" }],
  [/(^|[^a-z0-9])b[._]silks?(creen)?([^a-z0-9]|$)/i, { role: "silk", side: "bottom" }],
  [/(^|[^a-z0-9])f[._]paste([^a-z0-9]|$)/i, { role: "paste", side: "top" }],
  [/(^|[^a-z0-9])b[._]paste([^a-z0-9]|$)/i, { role: "paste", side: "bottom" }],
  [/(^|[^a-z0-9])f[._](fab|courtyard)([^a-z0-9]|$)/i, { role: "fab", side: "top" }],
  [/(^|[^a-z0-9])b[._](fab|courtyard)([^a-z0-9]|$)/i, { role: "fab", side: "bottom" }],
  [/(^|[^a-z0-9])edge[._]cuts([^a-z0-9]|$)/i, { role: "outline", side: null }],
  [/(^|[^a-z0-9])(dwgs|cmts|eco\d)[._]user([^a-z0-9]|$)/i, { role: "doc", side: null }],
];

const EXTENSION_RULES = new Map([
  [".gtl", { role: "copper", side: "top" }],
  [".gbl", { role: "copper", side: "bottom" }],
  [".gts", { role: "mask", side: "top" }],
  [".gbs", { role: "mask", side: "bottom" }],
  [".gto", { role: "silk", side: "top" }],
  [".gbo", { role: "silk", side: "bottom" }],
  [".gtp", { role: "paste", side: "top" }],
  [".gbp", { role: "paste", side: "bottom" }],
  [".gko", { role: "outline", side: null }],
  [".gm1", { role: "outline", side: null }],
  [".gml", { role: "outline", side: null }],
  [".drl", { role: "drill", side: null }],
  [".xln", { role: "drill", side: null }],
  [".exc", { role: "drill", side: null }],
  [".drd", { role: "drill", side: null }],
]);

/**
 * What physical layer a file is: `{ role, side, index?, plated? }`.
 *
 * Reads the Gerber X2 `%TF.FileFunction` attribute when `content` is given
 * (authoritative), then KiCad layer names in the file name (`-F_Cu`, `-B_Mask`,
 * `-In1_Cu`, `-Edge_Cuts`), then Protel extensions (`.gtl`, `.gbs`, `.g2`...).
 * `side` is `"top" | "bottom" | "inner" | null`. Unknown files are `other`.
 */
export function layerRole(name = "", content = "") {
  if (typeof content === "string" && content) {
    // An ODB++ envelope says what it is; its Gerber-style name may still read as copper (`drill_plated_f.cu-b.cu.drl`).
    const envelope = ODB_ENVELOPE.test(content) && /^kind=(\w+)$/m.exec(content.slice(0, 200));
    if (envelope && (envelope[1] === "drill" || envelope[1] === "rout")) {
      const plating = /^plating=(\w+)$/m.exec(content.slice(0, 300))?.[1];
      if (plating === "plated" || plating === "non_plated") return { role: "drill", side: null, plated: plating === "plated" };
      const lower = String(name).toLowerCase();
      return { role: "drill", side: null, ...drillPlating(name), ...(/(^|[^a-z-])plated/.test(lower) ? { plated: true } : {}) };
    }
    if (envelope && envelope[1] === "profile") return { role: "outline", side: null };
    const found = fromFileFunction(content);
    if (found) return found;
    if (/^\s*M48\b/m.test(content.slice(0, 2000))) {
      return { role: "drill", side: null, ...drillPlating(name) };
    }
  }
  const base = String(name).split(/[\\/]/).pop();
  for (const [pattern, result] of NAME_RULES) {
    const match = pattern.exec(base);
    if (match) {
      if (result.side === "inner") {
        return { ...result, index: Number(match[2]) + 1 };
      }
      return { ...result };
    }
  }
  const lower = base.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const extension = dot >= 0 ? lower.slice(dot) : "";
  const byExtension = EXTENSION_RULES.get(extension);
  if (byExtension) {
    return byExtension.role === "drill"
      ? { ...byExtension, ...drillPlating(base) }
      : { ...byExtension };
  }
  const inner = /^\.g(\d+)$/.exec(extension);
  if (inner) return { role: "copper", side: "inner", index: Number(inner[1]) };
  return { role: "other", side: null };
}

function drillPlating(name) {
  const lower = String(name).toLowerCase();
  if (/(^|[^a-z])npth([^a-z]|$)|non[-_ ]?plated/.test(lower)) return { plated: false };
  if (/(^|[^a-z])pth([^a-z]|$)/.test(lower)) return { plated: true };
  return {};
}

/**
 * Sort a set of fabrication files into a board description for `renderBoard()`.
 *
 * `files` is an array of `{ name, source, content? }`; `content` (the text) lets
 * X2 attributes decide. Returns
 * `{ outline, top: {copper, mask, silk, paste, fab}, bottom: {...},
 *    inner: [{index, source, name}], drills: [...], other: [...] }`
 * where each entry is `{ name, source }` (or `null`). The first file wins
 * when two claim the same slot; the rest go to `other`.
 */
export function groupBoardLayers(files) {
  const face = () => ({ copper: null, mask: null, silk: null, paste: null, fab: null });
  const board = { outline: null, top: face(), bottom: face(), inner: [], drills: [], other: [] };
  for (const file of files) {
    const entry = { name: file.name, source: file.source ?? file.content };
    const found = layerRole(file.name, typeof file.content === "string" ? file.content : "");
    if (found.role === "outline") {
      if (!board.outline) board.outline = entry;
      else board.other.push(entry);
    } else if (found.role === "drill") {
      board.drills.push({ ...entry, plated: found.plated ?? null });
    } else if (found.role === "copper" && found.side === "inner") {
      board.inner.push({ ...entry, index: found.index ?? null });
    } else if ((found.side === "top" || found.side === "bottom") && found.role in board[found.side]) {
      const slot = board[found.side];
      if (slot[found.role] == null) slot[found.role] = entry;
      else board.other.push(entry);
    } else {
      board.other.push(entry);
    }
  }
  board.inner.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return board;
}
