// Pixel "ink" diff of two renders of the same area (schematic sheets, PCB layers). Pure: works on
// RGBA byte arrays, no DOM. Ported from kipr web/project/js/inkdiff.js.
//
//   ink      a pixel something was drawn on: opaque enough and not near-white paper.
//   removed  ink in base with no head ink within `tol` pixels   -> red
//   added    ink in head with no base ink within `tol` pixels   -> green
//   common   ink in both                                        -> dimmed
// The tolerance keeps anti-aliasing and sub-pixel shifts from lighting up every edge.

export const DIFF_COLORS = {
  removed: [225, 40, 40, 255],
  added: [30, 175, 70, 255],
  common: [110, 110, 110, 150],
};

/** 1 where the RGBA pixel is ink. White/transparent paper is not ink. */
export function inkMask(rgba, w, h, { alphaMin = 40, lumMax = 235 } = {}) {
  const n = w * h;
  const m = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (rgba[j + 3] < alphaMin) continue;
    const lum = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    if (lum <= lumMax) m[i] = 1;
  }
  return m;
}

/** 1 where the pixel's alpha is at least alphaMin, whatever its colour (for single-colour layer renders). */
export function alphaMask(rgba, w, h, alphaMin = 40) {
  const n = w * h;
  const m = new Uint8Array(n);
  for (let i = 0, j = 3; i < n; i++, j += 4) if (rgba[j] >= alphaMin) m[i] = 1;
  return m;
}

/** Square dilation by r pixels (separable, O(n)). r <= 0 returns a copy. */
export function dilate(mask, w, h, r) {
  if (r <= 0) return mask.slice();
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  // horizontal: running count of set pixels in [x-r, x+r]
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let count = 0;
    for (let x = 0; x < Math.min(r, w); x++) count += mask[row + x];
    for (let x = 0; x < w; x++) {
      if (x + r < w) count += mask[row + x + r];
      if (x - r - 1 >= 0) count -= mask[row + x - r - 1];
      tmp[row + x] = count > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < Math.min(r, h); y++) count += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      if (y + r < h) count += tmp[(y + r) * w + x];
      if (y - r - 1 >= 0) count -= tmp[(y - r - 1) * w + x];
      out[y * w + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

/** Classify two ink masks. Returns masks and pixel counts. */
export function diffMasks(base, head, w, h, tol = 1) {
  const n = w * h;
  const hd = dilate(head, w, h, tol);
  const bd = dilate(base, w, h, tol);
  const removed = new Uint8Array(n);
  const added = new Uint8Array(n);
  const common = new Uint8Array(n);
  let nr = 0; let na = 0; let nc = 0;
  for (let i = 0; i < n; i++) {
    if (base[i] && !hd[i]) { removed[i] = 1; nr++; } else if (head[i] && !bd[i]) { added[i] = 1; na++; } else if (base[i] || head[i]) { common[i] = 1; nc++; }
  }
  return { removed, added, common, counts: { removed: nr, added: na, common: nc } };
}

/** Paint a diff into an RGBA buffer (e.g. ImageData.data). Pixels that are none of the three stay transparent. */
export function paintDiff(out, d, colors = DIFF_COLORS) {
  const n = d.removed.length;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const c = d.removed[i] ? colors.removed : d.added[i] ? colors.added : d.common[i] ? colors.common : null;
    if (c) { out[j] = c[0]; out[j + 1] = c[1]; out[j + 2] = c[2]; out[j + 3] = c[3]; } else out[j + 3] = 0;
  }
  return out;
}

/**
 * Bounding boxes of changed areas: connected components of `mask`, where pixels closer than `gap` are
 * merged into one region. Boxes are tight around the original pixels. Regions with fewer than
 * `minPixels` set pixels are dropped (noise). Sorted top-to-bottom, then left-to-right.
 */
export function regions(mask, w, h, { gap = 6, minPixels = 4, max = 200 } = {}) {
  const grown = dilate(mask, w, h, Math.max(0, Math.floor(gap / 2)));
  const label = new Int32Array(w * h);
  const out = [];
  const stack = [];
  let next = 0;
  for (let start = 0; start < w * h; start++) {
    if (!grown[start] || label[start]) continue;
    next++;
    let x0 = w; let y0 = h; let x1 = -1; let y1 = -1; let pixels = 0;
    label[start] = next;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop();
      const x = i % w; const y = (i - x) / w;
      if (mask[i]) {
        pixels++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      if (x > 0 && grown[i - 1] && !label[i - 1]) { label[i - 1] = next; stack.push(i - 1); }
      if (x < w - 1 && grown[i + 1] && !label[i + 1]) { label[i + 1] = next; stack.push(i + 1); }
      if (y > 0 && grown[i - w] && !label[i - w]) { label[i - w] = next; stack.push(i - w); }
      if (y < h - 1 && grown[i + w] && !label[i + w]) { label[i + w] = next; stack.push(i + w); }
    }
    if (pixels >= minPixels) out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, pixels });
  }
  out.sort((a, b) => b.pixels - a.pixels);
  const kept = out.slice(0, max);
  kept.sort((a, b) => a.y - b.y || a.x - b.x);
  return kept;
}

/** OR of two masks. */
export function orMask(a, b) {
  const o = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = a[i] | b[i];
  return o;
}

/**
 * The whole ink diff of two same-size RGBA rasters (either may be null: nothing drawn): coloured
 * RGBA, counts and changed regions in pixels (y down). `mode`: 'ink' (paper ignored) or 'alpha'.
 */
export function inkDiff(base, head, w, h, { mode = 'ink', tol = 1, colors = DIFF_COLORS, gap = 6, minPixels = 4, max = 200 } = {}) {
  const mk = (x) => (x ? (mode === 'alpha' ? alphaMask(x, w, h) : inkMask(x, w, h)) : new Uint8Array(w * h));
  const d = diffMasks(mk(base), mk(head), w, h, tol);
  const rgba = paintDiff(new Uint8ClampedArray(w * h * 4), d, colors);
  return { rgba, counts: d.counts, regions: regions(orMask(d.removed, d.added), w, h, { gap, minPixels, max }) };
}
