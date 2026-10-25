import test from 'node:test';
import assert from 'node:assert/strict';

import { DEVICE_SPECS, nudge, sampleFleet, summarise } from '../src/lib/iot';
import type { LonLat } from '../src/lib/geo';

let calls: string[] = [];

const net = {
  vessels: [
    { id: 'MV Aurora Pharma', laneId: 'L1' },
    { id: 'MV Cold Meridian', laneId: 'L2' },
    { id: 'MV Polar Star', laneId: 'L3' },
    { id: 'MV Pacific Crest', laneId: 'L4' },
  ],
  lanes: [
    { id: 'L1', geometry: [[72.8, 18.9], [56, 15.6], [43.8, 12.6], [32.55, 29.95], [4.1, 51.9]] as LonLat[] },
    { id: 'L2', geometry: [[79.8, 6.9], [62, 11.2], [43.8, 12.6], [32.55, 29.95], [9.9, 53.5]] as LonLat[] },
    { id: 'L3', geometry: [[55.05, 25], [54.9, 15.2], [43.8, 12.6], [32.55, 29.95], [1.3, 51.9]] as LonLat[] },
    { id: 'L4', geometry: [[121.5, 31], [140, 20.5], [-140, 35], [-118.2, 33.7]] as LonLat[] },
  ],
};

const weather = (i: number) => ({
  current: { temperature_2m: 26 + i, relative_humidity_2m: 70, wind_speed_10m: 14, cloud_cover: 30 },
  hourly: {
    time: Array.from({ length: 12 }, (_, h) => new Date(Date.now() + h * 3.6e6).toISOString()),
    temperature_2m: Array.from({ length: 12 }, (_, h) => 26 + i + (h === 4 ? 4 : 0)),
  },
});

const sea = (i: number) => ({
  current: { wave_height: 1.2 + i * 0.4, sea_surface_temperature: 27 + i },
});

const stubOk = () => {
  calls = [];
  (globalThis as any).fetch = async (url: string) => {
    calls.push(url);
    const n = 4; // four unique vessels, whatever the query string says
    const body = /marine/.test(url) ? Array.from({ length: n }, (_, i) => sea(i)) : Array.from({ length: n }, (_, i) => weather(i));
    return new Response(JSON.stringify(body), { status: 200 });
  };
};

test('live sampling batches all vessels into exactly two upstream calls', async () => {
  stubOk();
  const snap = await sampleFleet(net, 'live');
  assert.equal(calls.length, 2, `expected air + marine, got ${calls.length}`);
  assert.match(calls[0], /open-meteo\.com\/v1\/forecast/);
  assert.match(calls[1], /marine-api\.open-meteo\.com/);
  // x-www-form-urlencoded? no: arrays are comma separated, so 4 coordinates each.
  const lat = new URL(calls[0]).searchParams.get('latitude')?.split(',') ?? [];
  assert.equal(lat.length, 4, 'one coordinate per unique vessel, not per device');
});

test('live sampling reads the measured ambient and labels the box as modelled', async () => {
  stubOk();
  const snap = await sampleFleet(net, 'live');
  assert.equal(snap.ambient, 'live');
  assert.equal(snap.stale, false);
  assert.equal(snap.readings.length, DEVICE_SPECS.length);
  assert.ok(snap.ambientAvg > 20 && snap.ambientAvg < 35, `ambientAvg=${snap.ambientAvg}`);
  const reefer = snap.readings.find(r => r.kind === 'reefer')!;
  assert.equal(reefer.source, 'model');
  assert.ok(Number.isFinite(reefer.lat) && Number.isFinite(reefer.lon));
  assert.ok(reefer.boxC > 0 && reefer.boxC < reefer.limitC, 'starts inside its limit');
  assert.ok(snap.waveMax > 0);
});

test('a dead upstream degrades to the model instead of blanking the console', async () => {
  calls = [];
  (globalThis as any).fetch = async () => { throw new Error('network down'); };
  const snap = await sampleFleet(net, 'live');
  assert.equal(snap.stale, true);
  assert.equal(snap.ambient, 'model');
  assert.equal(snap.readings.length, DEVICE_SPECS.length, 'every device still reports');
  assert.ok(snap.lastError.length > 0);
  assert.ok(snap.readings.every(r => Number.isFinite(r.boxC)));
});

test('dummy sampling never touches the network', async () => {
  calls = [];
  (globalThis as any).fetch = async () => { throw new Error('dummy mode must not fetch'); };
  const snap = await sampleFleet(net, 'dummy');
  assert.equal(calls.length, 0);
  assert.equal(snap.ambient, 'demo');
  assert.equal(snap.readings.length, DEVICE_SPECS.length);
  assert.ok(snap.readings.every(r => r.source === 'demo'));
});

test('the thermal tick keeps every box finite and inside the physical envelope', async () => {
  stubOk();
  let snap = await sampleFleet(net, 'live');
  for (let i = 0; i < 40; i++) snap = nudge(snap);
  for (const r of snap.readings) {
    assert.ok(Number.isFinite(r.boxC), `${r.id} boxC`);
    assert.ok(r.boxC > -5 && r.boxC < 30, `${r.id} boxC=${r.boxC}`);
    assert.ok(Math.abs(r.trendCPerH) <= 6, `${r.id} trend=${r.trendCPerH}`);
    assert.ok(r.targetC >= r.setpointC, 'equilibrium never falls below setpoint');
  }
});

test('the tick does not invent a phantom ramp between samples', async () => {
  stubOk();
  let snap = await sampleFleet(net, 'live');
  const before = new Map(snap.readings.map(r => [r.id, r.boxC]));
  snap = nudge(snap);
  for (const r of snap.readings) {
    const jump = Math.abs(r.boxC - (before.get(r.id) as number));
    assert.ok(jump < 1.5, `${r.id} jumped ${jump.toFixed(2)} °C in one 4 s tick`);
  }
});

test('the summary reports the worst box and the breach count', async () => {
  stubOk();
  const snap = await sampleFleet(net, 'live');
  const s = summarise(snap)!;
  assert.equal(s.devices, DEVICE_SPECS.length);
  assert.equal(s.reefers, DEVICE_SPECS.filter(d => d.kind === 'reefer').length);
  assert.equal(s.breaches, snap.readings.filter(r => r.kind === 'reefer' && r.boxC > r.limitC).length);
  const worst = Math.max(...snap.readings.filter(r => r.kind === 'reefer').map(r => r.boxC));
  assert.ok(Math.abs(s.worstC - worst) < 0.06);
  assert.equal(summarise(null), null);
});

test('device positions stay on their own lane, not on the origin', async () => {
  stubOk();
  const snap = await sampleFleet(net, 'live');
  const seen = new Set(snap.readings.map(r => `${r.lat.toFixed(1)},${r.lon.toFixed(1)}`));
  assert.ok(seen.size >= 3, 'vessels at different coordinates ask for different weather');
  for (const r of snap.readings) {
    assert.ok(Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180, `${r.id} position ${r.lat},${r.lon}`);
    assert.notEqual(r.lon, 0, `${r.id} fell back to a null island coordinate`);
  }
});
