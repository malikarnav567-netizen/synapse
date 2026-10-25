/**
 * Cargo IoT layer.
 *
 * What is real:
 *  - Vessel positions come from the actual lane geometry (densified waypoints),
 *    advanced along the voyage.
 *  - Ambient temperature, humidity, wind, cloud cover, wave height, sea surface
 *    temperature and the next 24 h air-temperature curve are fetched live from
 *    Open-Meteo at those coordinates (CORS-open, no key, ~15 min resolution).
 *    That is a genuine external measurement of the environment the box sits in.
 *
 * What is modelled:
 *  - The *inside* of a reefer. No public API exposes per-container telemetry, so
 *    the box temperature is a first-order thermal model driven by the live
 *    ambient/sea state plus deterministic compressor, door and power events.
 *    Readings are labelled `model`; the driver is labelled `live`. Nothing
 *    pretends the box probe is a real device.
 *
 * The model exposes its equilibrium (`targetC`) rather than extrapolating the
 * last few noisy samples, which is what lets the predictive path say "this will
 * cross the limit at 14:20" instead of "it rose 0.1 °C, panic".
 */

import { densify, pointAt, type LonLat } from './geo';
import { requestJson, recordCacheHit } from './net';
import type { DataMode } from './mode';

export type Source = 'live' | 'model' | 'demo';

export interface DeviceSpec {
  id: string;
  container: string;
  vesselId: string;
  kind: 'reefer' | 'gateway';
  setpointC: number;
  limitC: number;
  /** Voyage progress at boot (0..1); follows the lane geometry. */
  progress: number;
}

export interface Reading {
  id: string;
  container: string;
  vesselId: string;
  laneId: string;
  kind: 'reefer' | 'gateway';
  setpointC: number;
  limitC: number;
  boxC: number;
  /** Equilibrium the box is drifting toward, given current conditions. */
  targetC: number;
  ambientC: number;
  humidity: number;
  windKn: number;
  seaC: number;
  waveM: number;
  /** Warmest air temperature expected in the next 12 h at this position. */
  ambientPeakC: number;
  ambientPeakInH: number;
  doorOpen: boolean;
  powerOk: boolean;
  battery: number;
  trendCPerH: number;
  source: Source;
  lat: number;
  lon: number;
}

export interface Snapshot {
  at: number;
  readings: Reading[];
  /** Provenance of the *ambient* driver, not of the box probe. */
  ambient: Source;
  stale: boolean;
  latencyMs: number;
  ambientAvg: number;
  waveMax: number;
  lastError: string;
}

export const DEVICE_SPECS: DeviceSpec[] = [
  { id: 'RF-2214', container: 'MSKU 771204-3', vesselId: 'MV Aurora Pharma', kind: 'reefer', setpointC: 5, limitC: 8, progress: 0.58 },
  { id: 'RF-2215', container: 'MSKU 771211-8', vesselId: 'MV Aurora Pharma', kind: 'reefer', setpointC: 5, limitC: 8, progress: 0.575 },
  { id: 'RF-3301', container: 'TGHU 440982-1', vesselId: 'MV Cold Meridian', kind: 'reefer', setpointC: 4, limitC: 7, progress: 0.47 },
  { id: 'RF-3302', container: 'TGHU 440990-4', vesselId: 'MV Cold Meridian', kind: 'reefer', setpointC: 4, limitC: 8, progress: 0.465 },
  // Biologics: the tightest limit on the roster, so this box alarms first.
  { id: 'RF-4410', container: 'CMAU 883301-7', vesselId: 'MV Polar Star', kind: 'reefer', setpointC: 4, limitC: 6.5, progress: 0.63 },
  { id: 'RF-5507', container: 'HLBU 220144-2', vesselId: 'MV Pacific Crest', kind: 'reefer', setpointC: 3, limitC: 8, progress: 0.34 },
  { id: 'GW-0101', container: 'Gateway · L1', vesselId: 'MV Aurora Pharma', kind: 'gateway', setpointC: 0, limitC: 0, progress: 0.58 },
  { id: 'GW-0401', container: 'Gateway · L4', vesselId: 'MV Pacific Crest', kind: 'gateway', setpointC: 0, limitC: 0, progress: 0.34 },
];

const AMBIENT_URL = 'https://api.open-meteo.com/v1/forecast';
const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';
/**
 * First-order time constant of a loaded reefer, in hours.
 *
 * The air inside an empty box responds in minutes, but the 2–8 °C limit is a
 * *product* limit and a loaded pallet has real thermal mass: one hour is the
 * conservative middle of the 0.7–3 h range quoted for reefer cargo. Using the
 * air constant (12 min) made every excursion cross its limit within half an
 * hour, which is why no cold-chain case could ever reach the 36 h predictive
 * horizon — the prediction column was unreachable by construction.
 */
export const TAU_H = 1.2;

/* ---------- deterministic helpers ---------- */

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Rough sea-level climatology — fallback and dummy mode only. */
const climatology = (lat: number, seed: number, t: number) => {
  const base = 29.5 - Math.max(0, lat - 14) * 0.22;
  return base + Math.sin(t / 7.2e5 + seed * 6.28) * 1.8;
};

/* ---------- positions ---------- */

interface Pt { vesselId: string; laneId: string; progress: number; lon: number; lat: number }

const geometryCache = new Map<string, LonLat[]>();

function laneIdFor(vesselId: string, net: any): string {
  return net?.vessels?.find((v: any) => v.id === vesselId)?.laneId ?? '';
}

function positions(net: any): Pt[] {
  const out: Pt[] = [];
  for (const spec of DEVICE_SPECS) {
    const lane = net?.lanes?.find((l: any) => l.id === laneIdFor(spec.vesselId, net));
    if (!lane?.geometry?.length) continue;
    const key = `${lane.id}:${lane.geometry.length}:${lane.geometry[0]?.join(',')}`;
    let line = geometryCache.get(key);
    if (!line) { line = densify(lane.geometry as LonLat[], 1.5); geometryCache.set(key, line); }
    const p = pointAt(line, clamp(spec.progress, 0.02, 0.98));
    out.push({ vesselId: spec.vesselId, laneId: lane.id, progress: spec.progress, lon: p.coord[0], lat: p.coord[1] });
  }
  return out;
}

/* ---------- live weather ---------- */

export interface Weather {
  ambientC: number;
  humidity: number;
  windKn: number;
  cloud: number;
  seaC: number;
  waveM: number;
  peakC: number;
  peakInH: number;
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

const asArray = (v: any) => (Array.isArray(v) ? v : [v]);

function peakOf(hourly: any, fallbackC: number): { peakC: number; peakInH: number } {
  const times: string[] = hourly?.time ?? [];
  const temps: number[] = hourly?.temperature_2m ?? [];
  if (!times.length || !temps.length) return { peakC: fallbackC + 2.2, peakInH: 8 };
  const now = Date.now();
  let peakC = fallbackC;
  let peakInH = 0;
  for (let i = 0; i < Math.min(times.length, 14); i++) {
    const t = Date.parse(times[i]);
    if (!Number.isFinite(t) || t < now - 3.6e6) continue;
    const c = temps[i];
    if (typeof c === 'number' && c > peakC) { peakC = c; peakInH = Math.max(0, Math.round((t - now) / 3.6e6)); }
  }
  return { peakC, peakInH };
}

async function fetchWeather(pts: Pt[], signal?: AbortSignal): Promise<{ byVessel: Map<string, Weather>; ms: number }> {
  const uniq = [...new Map(pts.map(p => [p.vesselId, p])).values()];
  const lat = uniq.map(p => p.lat.toFixed(3)).join(',');
  const lon = uniq.map(p => p.lon.toFixed(3)).join(',');
  const started = performance.now();

  const air = requestJson<any>(
    `${AMBIENT_URL}?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,cloud_cover` +
      `&hourly=temperature_2m&forecast_days=1&timezone=UTC`,
    { tier: 'patient', timeoutMs: 7_000, signal },
  );
  const sea = requestJson<any>(
    `${MARINE_URL}?latitude=${lat}&longitude=${lon}&current=wave_height,sea_surface_temperature&timezone=UTC`,
    { tier: 'patient', timeoutMs: 7_000, signal },
  );

  const [airRes, seaRes] = await Promise.allSettled([air, sea]);
  if (airRes.status === 'rejected' && seaRes.status === 'rejected') throw airRes.reason;

  const airList = airRes.status === 'fulfilled' ? asArray(airRes.value) : [];
  const seaList = seaRes.status === 'fulfilled' ? asArray(seaRes.value) : [];
  const byVessel = new Map<string, Weather>();

  uniq.forEach((p, i) => {
    const a = airList[i]?.current ?? {};
    const s = seaList[i]?.current ?? {};
    const ambientC = num(a.temperature_2m, climatology(p.lat, hash(p.vesselId), Date.now()));
    const peak = peakOf(airList[i]?.hourly, ambientC);
    byVessel.set(p.vesselId, {
      ambientC,
      humidity: num(a.relative_humidity_2m, 74),
      windKn: num(a.wind_speed_10m, 14) * 0.539957,
      cloud: num(a.cloud_cover, 45),
      seaC: num(s.sea_surface_temperature, ambientC - 1.2),
      waveM: num(s.wave_height, 1.4),
      peakC: Math.max(peak.peakC, ambientC),
      peakInH: peak.peakInH,
    });
  });

  recordCacheHit('api.open-meteo.com', '/v1/forecast+marine', 'patient');
  return { byVessel, ms: Math.round(performance.now() - started) };
}

/* ---------- thermal twin ---------- */

const lastBox = new Map<string, number>();
const lastTrend = new Map<string, number>();

/**
 * Scenario faults. The disruption run injects a power-bus and a door fault into
 * the two lanes that cross the zone, which is what a real closure would produce
 * (crew transfers, shore-power loss, inspection openings). The readings that
 * follow are still the thermal model reacting to live ambient — only the fault
 * itself is scripted, and `reset` clears it.
 */
let scenarioFaults = false;
export const setScenarioFaults = (on: boolean) => { scenarioFaults = on; };

/** Equilibrium offset above setpoint for a reefer under these conditions. */
export function excursion(w: Weather, door: boolean, power: boolean, phase: number) {
  const solar = w.cloud < 45 ? 0.45 : 0.12;
  const heat = Math.max(0, w.ambientC - 24) * 0.17;
  const motion = Math.max(0, w.waveM - 1.1) * 0.19;
  const doorStep = door ? 1.5 : 0;
  const compressorOff = power ? 0 : 2.7;
  return clamp(0.22 + heat + motion + doorStep + compressorOff + solar + Math.sin(phase) * 0.12, 0, 4.6);
}

function buildReadings(pts: Pt[], weather: Map<string, Weather>, source: Source, dtSec: number): Reading[] {
  const now = Date.now();
  return DEVICE_SPECS.map(spec => {
    const p = pts.find(x => x.vesselId === spec.vesselId);
    const w: Weather = weather.get(spec.vesselId)
      ?? { ambientC: 28, humidity: 74, windKn: 12, cloud: 40, seaC: 27, waveM: 1.4, peakC: 30, peakInH: 8 };
    const seed = hash(spec.id);
    const minutes = now / 60_000;
    const doorOpen = spec.kind === 'reefer'
      && (Math.sin(minutes * 0.62 + seed * 9) > 0.965 || (scenarioFaults && spec.id === 'RF-2214'));
    const powerOk = Math.sin(minutes * 0.19 + seed * 13) < 0.992
      && !(scenarioFaults && spec.id === 'RF-4410');
    const battery = spec.kind === 'gateway' ? clamp(92 - ((minutes / 60) % 30) * 0.9, 26, 100) : 100;

    const base = {
      id: spec.id, container: spec.container, vesselId: spec.vesselId, laneId: p?.laneId ?? '',
      setpointC: spec.setpointC, limitC: spec.limitC,
      ambientC: w.ambientC, humidity: w.humidity, windKn: w.windKn, seaC: w.seaC, waveM: w.waveM,
      ambientPeakC: w.peakC, ambientPeakInH: w.peakInH,
      doorOpen, powerOk, battery, source, lat: p?.lat ?? 0, lon: p?.lon ?? 0,
    };

    if (spec.kind === 'gateway') {
      return {
        ...base, kind: 'gateway' as const, boxC: w.ambientC, targetC: w.ambientC, trendCPerH: 0,
      };
    }

    const targetC = spec.setpointC + excursion(w, doorOpen, powerOk, minutes / 3 + seed * 6);
    const seen = lastBox.has(spec.id);
    // Boot at equilibrium: starting cold and leaping to target on the first
    // sample would fabricate a 100 °C/h ramp.
    const prev = seen ? (lastBox.get(spec.id) as number) : targetC;
    const alpha = seen ? clamp(dtSec / (TAU_H * 3600), 0.02, 0.6) : 1;
    const boxC = prev + (targetC - prev) * alpha;

    // Instantaneous rate implied by the model, smoothed and physically clamped.
    const instant = (targetC - boxC) / TAU_H;
    const trendCPerH = clamp((lastTrend.get(spec.id) ?? 0) * 0.65 + instant * 0.35, -6, 6);
    lastBox.set(spec.id, boxC);
    lastTrend.set(spec.id, trendCPerH);

    return { ...base, kind: 'reefer' as const, boxC, targetC, trendCPerH };
  });
}

function finish(readings: Reading[], ambient: Source, latencyMs: number, stale: boolean, lastError: string): Snapshot {
  const reefers = readings.filter(r => r.kind === 'reefer');
  return {
    at: Date.now(), readings, ambient, stale, latencyMs, lastError,
    ambientAvg: reefers.length ? reefers.reduce((s, r) => s + r.ambientC, 0) / reefers.length : 0,
    waveMax: readings.reduce((m, r) => Math.max(m, r.waveM), 0),
  };
}

/* ---------- public API ---------- */

let lastSampleAt = 0;

const dtSeconds = () => {
  const dt = lastSampleAt ? (Date.now() - lastSampleAt) / 1000 : 5;
  lastSampleAt = Date.now();
  return Math.min(900, Math.max(1, dt));
};

const syntheticWeather = (pts: Pt[], t: number, dummy: boolean) => {
  const map = new Map<string, Weather>();
  for (const p of pts) {
    const seed = hash(p.vesselId);
    const ambientC = climatology(p.lat, seed, t) + (dummy ? Math.sin(t / 9e4 + seed * 4) * 0.9 : 0);
    map.set(p.vesselId, {
      ambientC, humidity: 68 + seed * 20, windKn: 9 + seed * 14, cloud: 20 + seed * 60,
      seaC: ambientC - 1.4, waveM: 0.8 + seed * 3.4,
      peakC: ambientC + (dummy ? 2.6 : 1.8), peakInH: dummy ? 7 : 9,
    });
  }
  return map;
};

export async function sampleFleet(net: any, mode: DataMode, signal?: AbortSignal): Promise<Snapshot> {
  const pts = positions(net);
  const dtSec = dtSeconds();

  if (mode === 'dummy') {
    return finish(buildReadings(pts, syntheticWeather(pts, Date.now(), true), 'demo', dtSec), 'demo', 0, false, '');
  }

  try {
    const { byVessel, ms } = await fetchWeather(pts, signal);
    return finish(buildReadings(pts, byVessel, 'model', dtSec), 'live', ms, false, '');
  } catch (e) {
    return finish(
      buildReadings(pts, syntheticWeather(pts, Date.now(), false), 'model', dtSec),
      'model', 0, true, String((e as Error)?.message ?? e).slice(0, 90),
    );
  }
}

/** Local 4 s tick: advances the thermal model without touching the network. */
export function nudge(snap: Snapshot): Snapshot {
  const weather = new Map<string, Weather>();
  for (const r of snap.readings) {
    weather.set(r.vesselId, {
      ambientC: r.ambientC, humidity: r.humidity, windKn: r.windKn, cloud: 45,
      seaC: r.seaC, waveM: r.waveM, peakC: r.ambientPeakC, peakInH: r.ambientPeakInH,
    });
  }
  const pts: Pt[] = snap.readings.map(r => ({ vesselId: r.vesselId, laneId: r.laneId, progress: 0, lon: r.lon, lat: r.lat }));
  return { ...snap, at: Date.now(), readings: buildReadings(pts, weather, snap.ambient === 'live' ? 'model' : snap.ambient, 4) };
}

export interface SensorSummary {
  devices: number;
  reefers: number;
  ambientAvg: number;
  waveMax: number;
  breaches: number;
  worstC: number;
  worstId: string;
  source: Source;
  latencyMs: number;
}

export function summarise(snap: Snapshot | null): SensorSummary | null {
  if (!snap) return null;
  const reefers = snap.readings.filter(r => r.kind === 'reefer');
  const worst = reefers.reduce((a, b) => (b.boxC > (a?.boxC ?? -99) ? b : a), reefers[0]);
  return {
    devices: snap.readings.length,
    reefers: reefers.length,
    ambientAvg: Number(snap.ambientAvg.toFixed(1)),
    waveMax: Number(snap.waveMax.toFixed(1)),
    breaches: reefers.filter(r => r.boxC > r.limitC).length,
    worstC: worst ? Number(worst.boxC.toFixed(1)) : 0,
    worstId: worst?.id ?? '',
    source: snap.ambient,
    latencyMs: snap.latencyMs,
  };
}
