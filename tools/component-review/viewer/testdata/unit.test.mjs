// Unit tests for the pure parts of the viewer.   node --test tools/component-review/viewer/testdata/unit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelMatrix, applyMatrix, padToPcb, padDrill, padCopperSides, padOutline } from '../js/kicad3d.js';
import { safeUrl, assetUrl, githubBlobUrl } from '../js/util.js';
import { diffRows } from '../js/details.js';

const near = (a, b, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);

test('model transform: identity', () => {
  assert.ok(near(applyMatrix(modelMatrix({}), [1, 2, 3]), [1, 2, 3]));
});

test('model transform: offset in KiCad 3D frame (y up)', () => {
  assert.ok(near(applyMatrix(modelMatrix({ offset: [5.55, -3.05, 1.2] }), [0, 0, 0]), [5.55, -3.05, 1.2]));
});

test('model transform: rotate z is negated like KiCad (+90 turns +x to -y)', () => {
  assert.ok(near(applyMatrix(modelMatrix({ rotate: [0, 0, 90] }), [1, 0, 0]), [0, -1, 0]));
});

test('model transform: order is scale, X, Y, Z, then translate', () => {
  // rotate x 90 (negated -> -90 about X): +y -> -z ; then z 90 (negated): unaffected for a z vector
  const m = modelMatrix({ rotate: [90, 0, 90], scale: [2, 2, 2], offset: [1, 0, 0] });
  assert.ok(near(applyMatrix(m, [0, 1, 0]), [1, 0, -2]));
  // buzzer case from the demo PR: rotate (90, 180, 0), offset (0, -2, 5)
  const b = modelMatrix({ rotate: [90, 180, 0], offset: [0, -2, 5] });
  assert.ok(near(applyMatrix(b, [0, 0, 0]), [0, -2, 5]));
});

test('pad helpers', () => {
  const pad = { at: [1, 2, 90], size: [2, 1], shape: 'rect', layers: ['*.Cu', '*.Mask'], drill: { shape: 'circle', size: [0.8, 0.8], offset: [0, 0] } };
  assert.ok(near(padToPcb(pad, [1, 0]), [1, 1], 1e-12)); // CCW on screen: +x goes to -y (up)
  assert.deepEqual(padCopperSides(pad), { top: true, bottom: true });
  assert.equal(padDrill(pad).w, 0.8);
  assert.equal(padDrill({ drill: null }), null);
  assert.equal(padOutline({ size: [1, 1], shape: 'roundrect', roundrect_rratio: 0.25 }).outer.length, 36);
});

test('URL filters', () => {
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,x'), null);
  assert.equal(safeUrl('https://example.com/a b'), 'https://example.com/a%20b');
  assert.equal(assetUrl('../x'), null);
  assert.equal(assetUrl('items/a/../../x'), null);
  assert.equal(assetUrl('/etc/passwd'), null);
  assert.equal(assetUrl('items\\a'), null);
  assert.equal(assetUrl('items/foo bar/head_F.Cu.svg'), 'items/foo%20bar/head_F.Cu.svg');
  assert.equal(githubBlobUrl('a/b', 'abc1234', 'lib/x.kicad_mod', [3, 9]), 'https://github.com/a/b/blob/abc1234/lib/x.kicad_mod#L3-L9');
  assert.equal(githubBlobUrl('a/b"><x', 'abc1234', 'x'), null);
  assert.equal(githubBlobUrl('a/b', 'nothex!', 'x'), null);
  assert.equal(githubBlobUrl('a/b', 'abc1234', '../x'), null);
});

test('pad diff matches duplicate numbers in order', () => {
  const cols = [{ name: 'x', get: (p) => p.x }];
  const rows = diffRows([{ number: 'SH', x: 1 }, { number: 'SH', x: 2 }, { number: '1', x: 0 }],
    [{ number: 'SH', x: 1 }, { number: 'SH', x: 3 }, { number: '2', x: 0 }], (p) => p.number, cols);
  const st = rows.map((r) => r.status).sort();
  assert.deepEqual(st, ['added', 'changed', 'removed', 'same']);
});
