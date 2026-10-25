import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bearingBetween, boundsOf, densify, greatCircle, legNm, morphLine, pathNm, pointAt, resample,
  type LonLat,
} from '../src/lib/geo';

const near = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${a} ≈ ${b} (±${tol})`);

test('one degree of latitude is ~60 nautical miles', () => {
  near(legNm([0, 0], [0, 1]), 60.04, 0.2);
});

test('legNm is symmetric and zero for identical points', () => {
  near(legNm([72.8, 18.9], [55.05, 25.0]), legNm([55.05, 25.0], [72.8, 18.9]), 1e-9);
  assert.equal(legNm([10, 10], [10, 10]), 0);
});

test('greatCircle keeps both endpoints and interpolates between them', () => {
  const line = greatCircle([72.8, 18.9], [32.55, 29.95], 2);
  assert.deepEqual(line[0], [72.8, 18.9]);
  assert.deepEqual(line[line.length - 1], [32.55, 29.95]);
  assert.ok(line.length > 2);
  // Every intermediate point must lie on the path, so the summed legs equal the
  // direct distance (within rounding of the spherical interpolation).
  near(pathNm(line), legNm([72.8, 18.9], [32.55, 29.95]), 1);
});

test('densify preserves the endpoints of a multi-leg line', () => {
  const raw: LonLat[] = [[72.8, 18.9], [56, 15.6], [43.8, 12.6]];
  const dense = densify(raw, 1.5);
  assert.deepEqual(dense[0], raw[0]);
  assert.deepEqual(dense[dense.length - 1], raw[raw.length - 1]);
  assert.ok(dense.length > raw.length * 5);
  near(pathNm(dense), pathNm(raw), 2);
});

test('pointAt walks the path and clamps out-of-range fractions', () => {
  const line = densify([[72.8, 18.9], [32.55, 29.95]], 1);
  near(pointAt(line, 0).coord[0], line[0][0], 1e-9);
  near(pointAt(line, 0).coord[1], line[0][1], 1e-9);
  near(pointAt(line, 1).coord[0], line[line.length - 1][0], 1e-9);
  near(pointAt(line, 1).coord[1], line[line.length - 1][1], 1e-9);
  near(pointAt(line, -5).coord[0], line[0][0], 1e-9, 'clamps below zero');
  near(pointAt(line, 5).coord[0], line[line.length - 1][0], 1e-9, 'clamps above one');
  const mid = pointAt(line, 0.5).coord;
  assert.ok(mid[0] > 32 && mid[0] < 73, 'midpoint longitude falls inside the segment');
});

test('pointAt crosses the antimeridian the short way', () => {
  const { coord } = pointAt([[179, 0], [-179, 0]], 0.5);
  assert.ok(Math.abs(coord[0]) > 179, `expected ±180-ish, got ${coord[0]}`);
});

test('bearingBetween reports the four cardinal directions', () => {
  near(bearingBetween([0, 0], [0, 10]), 0, 0.5, 'north');
  near(bearingBetween([0, 0], [10, 0]), 90, 0.5, 'east');
  near(bearingBetween([0, 10], [0, 0]), 180, 0.5, 'south');
  near(bearingBetween([10, 0], [0, 0]), 270, 0.5, 'west');
});

test('resample returns exactly n evenly spaced points along a straight line', () => {
  const line = densify([[0, 0], [0, 10]], 1);
  const out = resample(line, 32);
  assert.equal(out.length, 32);
  assert.deepEqual(out[0], line[0]);
  assert.deepEqual(out[out.length - 1], line[line.length - 1]);
  const expected = pathNm(line) / 31;
  for (let i = 1; i < out.length; i++) near(legNm(out[i - 1], out[i]), expected, expected * 0.02, `gap ${i}`);
});

test('resample keeps spacing across a corner (chord shortens, path does not)', () => {
  const line = densify([[0, 0], [0, 10], [10, 10]], 1);
  const out = resample(line, 32);
  const expected = pathNm(line) / 31;
  let alongPath = 0;
  for (let i = 1; i < out.length; i++) alongPath += legNm(out[i - 1], out[i]);
  // The straight-line chord cuts a right-angle corner, so the sum is slightly
  // shorter than the polyline while the per-step spacing stays within ~35 %.
  assert.ok(alongPath < pathNm(line) + 1);
  assert.ok(alongPath > pathNm(line) * 0.97, `chord sum ${alongPath} vs path ${pathNm(line)}`);
  for (let i = 1; i < out.length; i++) {
    const gap = legNm(out[i - 1], out[i]);
    assert.ok(gap > expected * 0.6 && gap < expected * 1.4, `gap ${i}=${gap} vs ${expected}`);
  }
});

test('morphLine starts at the source and ends at the destination', () => {
  const from = densify([[72.8, 18.9], [32.55, 29.95]], 2);
  const to = densify([[72.8, 18.9], [18.43, -33.9], [4.1, 51.9]], 2);
  const a = morphLine(from, to, 0, 24);
  const b = morphLine(from, to, 1, 24);
  assert.equal(a.length, 24);
  for (let i = 0; i < 24; i++) {
    near(a[i][1], resample(from, 24)[i][1], 1e-6, 'latitude blends from');
    near(b[i][1], resample(to, 24)[i][1], 1e-6, 'latitude blends to');
  }
});

test('boundsOf wraps all supplied lines', () => {
  const [[w, s], [e, n]] = boundsOf([[[10, 20], [30, 40]], [[-10, -5], [5, 5]]]);
  assert.deepEqual([w, s, e, n], [-10, -5, 30, 40]);
});

test('Cape diversion is genuinely longer than the Suez lane', () => {
  // The KPI and the predictive slack depend on this being true of real geometry.
  const suez = pathNm(densify([[72.8, 18.9], [56, 15.6], [43.8, 12.6], [32.55, 29.95], [4.1, 51.9]], 2));
  const cape = pathNm(densify([[72.8, 18.9], [56, 15.6], [43.8, 12.6], [18.43, -33.9], [4.1, 51.9]], 2));
  assert.ok(cape > suez * 1.15, `cape ${cape} should exceed suez ${suez}`);
});
