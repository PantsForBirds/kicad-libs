// The layer stack of a board for the 2D stage: which files are which layer (boarddd/gerber's
// layerRole), paint order back -> front, per-layer colours (KiCad's defaults, for the per-layer
// view on a dark ground) and the BoardDescription of a realistic face. Pure.
// Colours, alphas and order are kipr's (web/project/js/board.js, layout.js).

import { groupBoardLayers, layerRole } from '../gerber/layers.js';

// KiCad's default layer colours (renderer triples 0..1)
const COPPER = { top: [0.78, 0.2, 0.2], bottom: [0.3, 0.5, 0.77] };
const INNER = [[0.5, 0.78, 0.5], [0.81, 0.49, 0.17], [0.96, 0.46, 0.66], [0.58, 0.42, 0.95], [0.26, 0.71, 0.72], [0.76, 0.58, 0.26]];
const SIDED = {
  mask: { top: [0.85, 0.39, 1.0], bottom: [0.01, 1.0, 0.93] },
  paste: { top: [0.71, 0.63, 0.63], bottom: [0.0, 0.76, 0.76] },
  silk: { top: [0.95, 0.93, 0.63], bottom: [0.91, 0.7, 0.65] },
  fab: { top: [0.69, 0.69, 0.69], bottom: [0.35, 0.36, 0.52] },
};
const OTHER = { outline: [0.82, 0.82, 0.0], doc: [0.76, 0.76, 0.76], other: [0.6, 0.6, 0.6] };
const DRILL = { plated: [0.86, 0.86, 0.86], unplated: [0.55, 0.85, 0.95] };

export const LAYER_ALPHA = Object.freeze({ copper: 0.85, mask: 0.45, paste: 0.6, silk: 0.95, outline: 1, drill: 1, fab: 0.8, doc: 0.7, other: 0.7 });

/** The per-layer colour of a classified layer ({ role, side, index, plated }). */
export function layerColor(l) {
  if (l.role === 'copper') {
    if (l.side === 'inner') return INNER[Math.max(0, (l.index ?? 2) - 2) % INNER.length];
    return COPPER[l.side] || COPPER.top;
  }
  if (l.role === 'drill') return l.plated === false ? DRILL.unplated : DRILL.plated;
  if (SIDED[l.role]) return SIDED[l.role][l.side === 'bottom' ? 'bottom' : 'top'];
  return OTHER[l.role] || OTHER.other;
}

const KIND_RANK = { copper: 0, mask: 1, paste: 2, silk: 3, fab: 4, doc: 6, other: 6 };

/** Paint rank, low first: back side (silk furthest), inner copper bottom-up, front, outline, drills. */
export function layerRank(l) {
  if (l.role === 'outline') return 400;
  if (l.role === 'drill') return 500;
  const k = KIND_RANK[l.role] ?? 6;
  if (l.side === 'bottom') return 100 + (6 - k);
  if (l.side === 'inner') return 200 + (999 - Math.min(l.index ?? 0, 999)) / 10;
  if (l.side === 'top') return 300 + k;
  return 350 + k;
}

const natural = new Intl.Collator('en', { numeric: true });

/** Layers in paint order (back to front). */
export function sortLayers(layers) {
  return [...layers].sort((a, b) => layerRank(a) - layerRank(b) || natural.compare(a.name, b.name));
}

/** On by default in the per-layer view: copper, silk, outline, drills. */
export function defaultVisible(l) {
  return ['copper', 'silk', 'outline', 'drill'].includes(l.role);
}

/**
 * The layer stack of a set of files ({ name, source } with Gerber / Excellon text; `role`, `side`,
 * `index`, `plated` override the classification): sorted back to front, each with a colour, alpha
 * and default visibility.
 */
export function layerStack(files) {
  return sortLayers(files.filter(Boolean).map((f) => {
    const guess = f.role ? {} : layerRole(f.name || '', typeof f.source === 'string' ? f.source : '');
    const l = {
      name: f.name || '',
      source: f.source,
      role: f.role ?? guess.role,
      side: f.side !== undefined ? f.side : guess.side ?? null,
      index: f.index ?? guess.index ?? null,
      plated: f.plated ?? guess.plated ?? null,
    };
    return { ...l, id: f.id ?? l.name, color: f.color ?? layerColor(l), alpha: f.alpha ?? LAYER_ALPHA[l.role] ?? 0.8, visible: f.visible ?? defaultVisible(l) };
  }));
}

/**
 * The board description of one realistic face (boarddd/gerber addBoardLayers) from files or a
 * layerStack(): outline, that side's copper / mask / silk / paste, every drill file.
 */
export function faceBoard(files, side = 'top') {
  const g = groupBoardLayers(files.map((f) => ({ name: f.name, source: f.source, content: typeof f.source === 'string' ? f.source : '' })));
  const face = g[side] || {};
  return {
    outline: g.outline,
    drills: g.drills,
    [side]: { copper: face.copper ?? null, mask: face.mask ?? null, silk: face.silk ?? null, paste: face.paste ?? null },
  };
}
