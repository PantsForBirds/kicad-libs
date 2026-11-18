// Units, up axis and colour space of loaded models. Pure: no three.js.
//
// kicad-cli's GLB is y-up and in metres (glTF); KiCad and occt's STEP output are z-up and in mm.
// Rather than trust either, measure: the board is the flattest thing in the file, so its thinnest
// axis is up, and a board a few metres across is a few millimetres across in the wrong unit.
// Ported from kipr web/project/pcba3d/scene.js (orient).

export const UNIT_SCALE = { m: 1000, mm: 1, cm: 10, in: 25.4, mil: 0.0254 };

/** The up axis ('x' | 'y' | 'z') of a model whose bounding box measures `size` [x, y, z]. */
export function detectUp(size, stated = null) {
  const s = stated ? String(stated).replace(/^[+-]/, '').toLowerCase() : null;
  if (s === 'x' || s === 'y' || s === 'z') return s;
  const [x, y, z] = size;
  if (y <= x && y <= z) return 'y';
  if (x < y && x < z) return 'x';
  return 'z';
}

/**
 * Scale to millimetres. `span` is the model's largest horizontal extent (in its own unit) once
 * up is known; `expectedMm` the board's known size, if any. A stated unit wins; otherwise the
 * scale that brings span closest to the expected size; otherwise metres if the span is under
 * 2 (no board is 2 mm across), else millimetres.
 */
export function detectScale(span, { units = null, expectedMm = 0 } = {}) {
  if (units && UNIT_SCALE[units]) return UNIT_SCALE[units];
  if (expectedMm > 0 && span > 0) {
    let scale = 1, best = Infinity;
    for (const s of [1, 10, 25.4, 1000]) {
      const err = Math.abs(Math.log((span * s) / expectedMm));
      if (err < best) { best = err; scale = s; }
    }
    return scale;
  }
  return span > 0 && span < 2 ? 1000 : 1;
}

const encode = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/**
 * Working-space colour for a STEP colour from occt-import-js. occt decodes the file's COLOUR_RGB
 * as sRGB and returns linear values; KiCad's 3D viewer uses the file's values unconverted as its
 * shading colour, which is what model authors tune for. So re-encode to the file's values and use
 * those as linear. Ported from kipr web/library/js/view3d.js (stepColor, kipr PR #14).
 */
export function stepColorToLinear(rgb) {
  if (!rgb) return null;
  return [encode(rgb[0]), encode(rgb[1]), encode(rgb[2])];
}
