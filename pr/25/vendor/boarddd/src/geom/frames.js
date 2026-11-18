// Coordinate frames shared by every boarddd module. Pure: no three.js.
//
//   KiCad frame  mm, x right, y DOWN: .kicad_pcb / .kicad_mod coordinates (and the SVG renders).
//   Board frame  mm, x right, y UP (= -KiCad y; Gerber coordinates), z UP out of the top copper.
//                The board's bottom face is z = 0 and its top face z = thickness, where kicad-cli's
//                GLB (once oriented, see src/models) mounts the top-side components.
//                Every boarddd mesh is built in this frame; the scene looks at it with camera.up = +z.
//
// kicadModelMatrix is ported from kipr web/library/js/kicad3d.js (modelMatrix), which reproduces
// KiCad's 3D viewer placement of a footprint's (model ...) entry.

export const BOARD_THICKNESS = 1.6;
export const COPPER_THICKNESS = 0.035;

/** KiCad (y-down) point -> board frame (y-up). */
export const kicadToBoard = (x, y) => [x, -y];
/** Board frame (y-up) point -> KiCad (y-down). */
export const boardToKicad = (x, y) => [x, -y];

/**
 * 4x4 column-major matrix (three's Matrix4.fromArray order) for a footprint `(model ...)` entry, in the
 * footprint's own board frame (origin on the footprint, z = 0 on the board surface the footprint sits on):
 *     M = T(offset) * Rz(-rz) * Ry(-ry) * Rx(-rx) * S(scale)
 * scale first, then X, Y, Z rotations (degrees, negated as KiCad does), then the offset (mm, +y = up the
 * screen, +z = away from the board).
 */
export function kicadModelMatrix({ offset = [0, 0, 0], rotate = [0, 0, 0], scale = [1, 1, 1] } = {}) {
  const rad = (d) => (-(+d || 0) * Math.PI) / 180;
  const [ax, ay, az] = rotate.map(rad);
  const cx = Math.cos(ax), sx = Math.sin(ax);
  const cy = Math.cos(ay), sy = Math.sin(ay);
  const cz = Math.cos(az), sz = Math.sin(az);
  const Rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]];
  const Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const Rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  const mul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
  const R = mul(mul(Rz, Ry), Rx);
  const [sxx, syy, szz] = scale.map((v) => (v === undefined || v === null ? 1 : +v));
  const [tx, ty, tz] = offset.map((v) => +v || 0);
  return [
    R[0][0] * sxx, R[1][0] * sxx, R[2][0] * sxx, 0,
    R[0][1] * syy, R[1][1] * syy, R[2][1] * syy, 0,
    R[0][2] * szz, R[1][2] * szz, R[2][2] * szz, 0,
    tx, ty, tz, 1,
  ];
}

/** Apply a column-major 4x4 to a point. */
export function applyMatrix(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}
