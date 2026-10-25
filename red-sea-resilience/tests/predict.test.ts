import test from 'node:test';
import assert from 'node:assert/strict';

import { classify, minutesToLimit } from '../src/lib/predict';
import { TAU_H, type Reading, type Snapshot } from '../src/lib/iot';

const base = (over: Partial<Reading> = {}): Reading => ({
  id: 'RF-1',
  container: 'MSKU 000001-1',
  vesselId: 'MV Test',
  laneId: 'L1',
  kind: 'reefer',
  setpointC: 4,
  limitC: 8,
  boxC: 5,
  targetC: 5,
  ambientC: 24,
  humidity: 70,
  windKn: 12,
  seaC: 26,
  waveM: 1.2,
  ambientPeakC: 25,
  ambientPeakInH: 6,
  doorOpen: false,
  powerOk: true,
  battery: 100,
  trendCPerH: 0,
  source: 'model',
  lat: 20,
  lon: 40,
  ...over,
});

const snap = (readings: Reading[], over: Partial<Snapshot> = {}): Snapshot => ({
  at: Date.now(),
  readings,
  ambient: 'live',
  stale: false,
  latencyMs: 120,
  ambientAvg: 24,
  waveMax: Math.max(...readings.map(r => r.waveM)),
  lastError: '',
  ...over,
});

test('minutesToLimit says "now" when the box is already over its limit', () => {
  assert.equal(minutesToLimit(base({ boxC: 9 })), 0);
});

test('minutesToLimit refuses to predict when the equilibrium is safe', () => {
  // Compressor off but the box settles at 6 °C against an 8 °C limit: never crosses.
  assert.equal(minutesToLimit(base({ boxC: 5, targetC: 6, limitC: 8 })), null);
});

test('minutesToLimit solves the first-order model, not a linear guess', () => {
  // t = -tau·ln((target-limit)/(target-box)); target 10, limit 8, box 6 → ln 0.5.
  const minutes = minutesToLimit(base({ boxC: 6, targetC: 10, limitC: 8 }));
  assert.ok(minutes !== null);
  const expected = Math.round(-TAU_H * Math.log(0.5) * 60);
  assert.equal(minutes, expected);
  assert.ok(minutes! > 0 && minutes! < 90, `a 2 °C over-shoot crosses inside the reactive window (${minutes} min)`);
  // Halving the over-shoot roughly doubles the time: the model is exponential.
  const slower = minutesToLimit(base({ boxC: 6, targetC: 9, limitC: 8 }))!;
  assert.ok(slower > minutes! * 1.4, `slower=${slower} faster=${minutes}`);
});

test('the exported thermal time constant is a plausible reefer value', () => {
  assert.ok(TAU_H > 0.05 && TAU_H < 2, `TAU_H=${TAU_H}`);
});

test('an over-limit box is a critical urgent case, not a prediction', () => {
  const board = classify(snap([base({ boxC: 9.1 })]), null);
  assert.equal(board.urgent.length, 1);
  assert.equal(board.urgent[0].severity, 'critical');
  assert.equal(board.urgent[0].minutes, 0);
  assert.equal(board.predictive.length, 0, 'the same device must not also be predictive');
});

test('a dead compressor is urgent even while the box is still inside its limit', () => {
  const board = classify(snap([base({ powerOk: false, boxC: 6, targetC: 9 })]), null);
  assert.equal(board.urgent.length, 1);
  assert.match(board.urgent[0].title, /compressor offline/i);
  assert.ok(board.urgent[0].minutes! > 0, 'it still reports time to the limit');
  assert.equal(board.predictive.length, 0);
});

test('a door event is urgent and one case per device survives dedupe', () => {
  const board = classify(snap([base({ doorOpen: true, powerOk: false, boxC: 7.5, targetC: 9 })]), null);
  assert.equal(board.urgent.length, 1, 'power + door + trend collapse to one row per container');
  assert.equal(board.urgent[0].severity, 'critical');
});

test('a slow drift is predictive, and urgent stays empty', () => {
  // Crosses at ~105 min: outside the 90 min reactive window, inside the 36 h horizon.
  const board = classify(snap([base({ boxC: 6, targetC: 8.6, limitC: 8 })]), null);
  assert.equal(board.urgent.length, 0, JSON.stringify(board.urgent.map(c => c.title)));
  assert.equal(board.predictive.length, 1);
  assert.match(board.predictive[0].title, /2 h/);
  assert.ok(board.predictive[0].minutes! > 90);
});

test('forecast peak creates a predictive case without any fault', () => {
  const board = classify(snap([base({ boxC: 6.4, targetC: 6.5, limitC: 8, ambientC: 30, ambientPeakC: 36, ambientPeakInH: 5 })]), null);
  assert.equal(board.urgent.length, 0);
  assert.ok(board.predictive.some(c => /Forecast peak/.test(c.title)), JSON.stringify(board.predictive.map(c => c.title)));
});

test('a low gateway battery is a predictive watch item', () => {
  const gw = base({ id: 'GW-1', kind: 'gateway', container: 'Gateway', limitC: 0, boxC: 24, targetC: 24, battery: 30 });
  const board = classify(snap([gw]), null);
  assert.equal(board.urgent.length, 0);
  assert.equal(board.predictive.length, 1);
  assert.equal(board.predictive[0].severity, 'watch');
});

test('critical cases sort before high, then by time remaining', () => {
  const board = classify(snap([
    base({ id: 'SLOW', boxC: 6, targetC: 8.4, limitC: 8 }),   // ~3 h → predictive-ish
    base({ id: 'SOON', boxC: 6, targetC: 10, limitC: 8 }),    // ~50 min
    base({ id: 'DOOR', doorOpen: true }),                     // high fault, no crossing
    base({ id: 'OVER', boxC: 9 }),                            // critical over-limit
  ]), null);
  assert.deepEqual(board.urgent.map(c => c.deviceId), ['OVER', 'SOON', 'DOOR']);
  assert.ok(board.urgent.every(c => c.deviceId !== 'SLOW'), 'the 3 h drift stays predictive');
});

test('surge on every vessel collapses into one fleet slack case', () => {
  const net = {
    vessels: [
      { id: 'V1', laneId: 'L1', route: 'suez', rerouteEligible: true, deliveryWindowDays: 30, remainingDays: 20, extraDays: 0 },
      { id: 'V2', laneId: 'L2', route: 'suez', rerouteEligible: true, deliveryWindowDays: 30, remainingDays: 22, extraDays: 0 },
      { id: 'V3', laneId: 'L3', route: 'suez', rerouteEligible: true, deliveryWindowDays: 60, remainingDays: 20, extraDays: 0 },
    ],
    lanes: [
      { id: 'L1', geometry: [[72, 18], [43, 12]], alternate: [[72, 18], [10, -34], [4, 51]] },
      { id: 'L2', geometry: [[79, 7], [43, 12]], alternate: [[79, 7], [10, -34], [9, 53]] },
      { id: 'L3', geometry: [[55, 25], [43, 12]], alternate: [[55, 25], [10, -34], [1, 51]] },
    ],
  };
  const board = classify(snap([base({ boxC: 5, targetC: 5 })]), net);
  const fleet = board.predictive.filter(c => c.id === 'plan-fleet');
  assert.equal(fleet.length, 1, 'one row for the fleet, not one per hull');
  assert.match(fleet[0].detail, /2 of 3 vessels fall short/);
});

test('the two columns never share a device or a case id', () => {
  const net = {
    vessels: [{ id: 'V1', laneId: 'L1', route: 'suez', deliveryWindowDays: 20, remainingDays: 20, extraDays: 0 }],
    lanes: [{ id: 'L1', geometry: [[72, 18], [43, 12]], alternate: [[72, 18], [10, -34], [4, 51]] }],
  };
  const board = classify(snap([
    base({ id: 'A', boxC: 9 }),
    base({ id: 'B', boxC: 6, targetC: 9, limitC: 8 }),
    base({ id: 'C', boxC: 5 }),
  ]), net);
  const urgentDevices = new Set(board.urgent.map(c => c.deviceId));
  for (const p of board.predictive) assert.ok(!urgentDevices.has(p.deviceId), `${p.id} duplicates ${p.deviceId}`);
  const ids = [...board.urgent, ...board.predictive].map(c => c.id);
  assert.equal(new Set(ids).size, ids.length, 'case ids are unique');
});

test('an empty snapshot produces an empty board instead of throwing', () => {
  const board = classify(null, null);
  assert.deepEqual(board.urgent, []);
  assert.deepEqual(board.predictive, []);
});

test('each column is capped so the console stays readable', () => {
  const many = Array.from({ length: 12 }, (_, i) => base({ id: `R${i}`, boxC: 9 }));
  const board = classify(snap(many), null);
  assert.ok(board.urgent.length <= 5, `urgent=${board.urgent.length}`);
});
