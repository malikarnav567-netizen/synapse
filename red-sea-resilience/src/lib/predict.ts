/**
 * Case triage: one sensor stream, two very different questions.
 *
 * URGENT (reactive, minutes) — something is wrong *now* or is provably about to
 * be: a box over its limit, a compressor offline, a door open. Computed from the
 * latest reading only, so it stays valid when the network is down.
 *
 * PREDICTIVE (proactive, hours) — nothing is broken yet, but the live forecast
 * peak, the sea state or the voyage geometry projects a breach or a missed
 * delivery window. This is the column a planner works from.
 *
 * The two lists never overlap: a device with an urgent case is removed from the
 * predictive column, so red reliably means "act now".
 */

import { pathNm } from './geo';
import { TAU_H, type Reading, type Snapshot } from './iot';

export type Severity = 'critical' | 'high' | 'watch';

export interface OpsCase {
  id: string;
  level: 'urgent' | 'predictive';
  severity: Severity;
  deviceId: string;
  container: string;
  vesselId: string;
  title: string;
  detail: string;
  /** Minutes until the limit is crossed (negative = already over). */
  minutes: number | null;
  metric: string;
  confidence: number;
  action: string;
  at: number;
}

export interface CaseBoard {
  urgent: OpsCase[];
  predictive: OpsCase[];
  generatedAt: number;
}

const URGENT_HORIZON_MIN = 90;
const PREDICTIVE_HORIZON_MIN = 36 * 60;
const CRUISE_KN = 14;

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Time until the box actually reaches its limit.
 *
 * A linear extrapolation of the last samples lies whenever the box is heading to
 * an equilibrium below the limit (compressor off but ambient cool enough), so we
 * solve the first-order model instead: t = -tau·ln((target-limit)/(target-box)).
 */
export function minutesToLimit(r: Reading): number | null {
  const margin = r.limitC - r.boxC;
  // Already over: we do not know when it crossed, so never invent an elapsed
  // time. 0 means "over right now" and the UI says exactly that.
  if (margin <= 0) return 0;
  if (r.targetC <= r.limitC) return null;
  const frac = (r.targetC - r.limitC) / (r.targetC - r.boxC);
  if (!(frac > 0 && frac < 1)) return null;
  const minutes = Math.round(-TAU_H * Math.log(frac) * 60);
  return Number.isFinite(minutes) ? minutes : null;
}

export function classify(snap: Snapshot | null, net: any): CaseBoard {
  if (!snap) return { urgent: [], predictive: [], generatedAt: Date.now() };
  const urgent: OpsCase[] = [];
  const predictive: OpsCase[] = [];
  const at = snap.at;
  const base = { at, confidence: 0.9 };

  for (const r of snap.readings) {
    if (r.kind === 'gateway') {
      if (r.battery < 35) {
        predictive.push({
          ...base, id: `gw-${r.id}`, level: 'predictive', severity: 'watch', deviceId: r.id,
          container: r.container, vesselId: r.vesselId,
          title: 'Gateway battery trending low',
          detail: `Sensor gateway at ${Math.round(r.battery)}% — about ${Math.round(r.battery / 4)} h of reporting buffer left.`,
          minutes: Math.round((r.battery - 20) * 15), metric: `${Math.round(r.battery)}%`,
          confidence: 0.72, action: 'Schedule battery swap at next port',
        });
      }
      continue;
    }

    const ttl = minutesToLimit(r);
    const over = r.boxC > r.limitC;

    if (over) {
      urgent.push({
        ...base, id: `breach-${r.id}`, level: 'urgent', severity: 'critical', deviceId: r.id,
        container: r.container, vesselId: r.vesselId,
        title: `${r.container} above ${r.limitC} °C limit`,
        detail: `Box ${round1(r.boxC)} °C (setpoint ${r.setpointC} °C, live ambient ${round1(r.ambientC)} °C). ${
          r.powerOk ? 'Compressor running' : 'Compressor offline'
        }${r.doorOpen ? ', door open' : ''}.`,
        minutes: ttl, metric: `${round1(r.boxC)} °C`, confidence: 0.95,
        action: 'Escalate to fleet medical desk and pre-alert consignee',
      });
      continue;
    }

    if (!r.powerOk) {
      urgent.push({
        ...base, id: `power-${r.id}`, level: 'urgent', severity: 'critical', deviceId: r.id,
        container: r.container, vesselId: r.vesselId,
        title: 'Reefer compressor offline',
        detail: `No compressor feedback. Box ${round1(r.boxC)} °C heading to ${round1(r.targetC)} °C against a ${r.limitC} °C limit.`,
        minutes: ttl, metric: `${round1(r.boxC)} °C`, confidence: 0.92,
        action: 'Switch to backup compressor, notify master',
      });
    }

    if (r.doorOpen) {
      urgent.push({
        ...base, id: `door-${r.id}`, level: 'urgent', severity: 'high', deviceId: r.id,
        container: r.container, vesselId: r.vesselId,
        title: 'Container door reported open',
        detail: `Door contact open at sea; ambient ${round1(r.ambientC)} °C is loading the box toward ${round1(r.targetC)} °C.`,
        minutes: ttl, metric: 'door open', confidence: 0.88,
        action: 'Confirm closure with the deck officer',
      });
    }

    if (ttl != null && ttl > 0 && ttl <= URGENT_HORIZON_MIN) {
      urgent.push({
        ...base, id: `close-${r.id}`, level: 'urgent', severity: 'high', deviceId: r.id,
        container: r.container, vesselId: r.vesselId,
        title: `${r.container} reaches limit in ${ttl} min`,
        detail: `Box ${round1(r.boxC)} °C rising ${round1(r.trendCPerH)} °C/h toward an equilibrium of ${round1(r.targetC)} °C (limit ${r.limitC} °C).`,
        minutes: ttl, metric: `${round1(r.boxC)} °C`, confidence: 0.86,
        action: 'Pre-cool now and hold for arrival inspection',
      });
    } else if (ttl != null && ttl > URGENT_HORIZON_MIN && ttl <= PREDICTIVE_HORIZON_MIN) {
      predictive.push({
        ...base, id: `trend-${r.id}`, level: 'predictive', severity: ttl < 6 * 60 ? 'high' : 'watch',
        deviceId: r.id, container: r.container, vesselId: r.vesselId,
        title: `Limit in ~${Math.round(ttl / 60)} h at current load`,
        detail: `Model equilibrium ${round1(r.targetC)} °C vs ${r.limitC} °C limit; ambient ${round1(r.ambientC)} °C, ${round1(r.waveM)} m swell.`,
        minutes: ttl, metric: `${round1(r.boxC)} °C`, confidence: 0.74,
        action: 'Reserve cold-chain slack at destination',
      });
    } else {
      // Forecast: the *next* peak, not the current reading, is what melts margin.
      // The watch line is the same 1.6 °C the cargo tile turns amber at, so the
      // tile and the planner's column agree about what "thin" means.
      const WATCH_MARGIN_C = 1.6;
      const hotTarget = r.targetC + Math.max(0, r.ambientPeakC - r.ambientC) * 0.17;
      if (hotTarget > r.limitC - WATCH_MARGIN_C && r.ambientPeakC > r.ambientC + 0.4) {
        predictive.push({
          ...base, id: `forecast-${r.id}`, level: 'predictive', severity: hotTarget > r.limitC ? 'high' : 'watch',
          deviceId: r.id, container: r.container, vesselId: r.vesselId,
          title: `Forecast peak ${round1(r.ambientPeakC)} °C in ${r.ambientPeakInH} h`,
          detail: `Projected box equilibrium ${round1(hotTarget)} °C against a ${r.limitC} °C limit — margin is ${round1(r.limitC - hotTarget)} °C.`,
          minutes: r.ambientPeakInH * 60, metric: `${round1(r.ambientPeakC)} °C`, confidence: 0.7,
          action: 'Pre-cool before the forecast peak',
        });
      } else if (r.limitC - r.boxC < 1.6) {
        predictive.push({
          ...base, id: `margin-${r.id}`, level: 'predictive', severity: 'watch', deviceId: r.id,
          container: r.container, vesselId: r.vesselId,
          title: 'Thin cold-chain margin',
          detail: `Only ${round1(r.limitC - r.boxC)} °C of headroom; live ambient ${round1(r.ambientC)} °C is the main driver.`,
          minutes: null, metric: `${round1(r.boxC)} °C`, confidence: 0.68,
          action: 'Watch — no intervention yet',
        });
      }
    }
  }

  // Voyage-level prediction: sea state and corridor exposure, not a device fault.
  if (snap.waveMax > 4.5) {
    const slow = Math.round(CRUISE_KN * Math.max(0.65, 1 - (snap.waveMax - 4.5) * 0.09));
    predictive.push({
      ...base, id: 'sea-state', level: 'predictive', severity: snap.waveMax > 6 ? 'high' : 'watch',
      deviceId: 'fleet', container: 'Fleet', vesselId: 'All lanes',
      title: `Swell ${round1(snap.waveMax)} m derates speed`,
      detail: `Sea-state model trims cruise from ${CRUISE_KN} kn to ${slow} kn, adding roughly ${round1((CRUISE_KN / slow - 1) * 100)}% to remaining passage.`,
      minutes: null, metric: `${round1(snap.waveMax)} m`, confidence: 0.7,
      action: 'Re-baseline ETAs before approving a diversion',
    });
  }

  // Voyage geometry: one row for the fleet, not one per hull. Three identical
  // "Cape leaves N days" rows hide the one number an operator needs: the worst
  // margin and how many vessels share it.
  const tight: { v: any; lane: any; slack: number; extraDays: number; extraNm: number }[] = [];
  for (const v of net?.vessels ?? []) {
    const lane: any = net?.lanes?.find((l: any) => l.id === v.laneId);
    if (!lane?.alternate?.length || v.route === 'cape') continue;
    const extraNm = Math.max(0, pathNm(lane.alternate) - pathNm(lane.geometry));
    const extraDays = extraNm / (CRUISE_KN * 24);
    tight.push({ v, lane, extraDays, extraNm, slack: v.deliveryWindowDays - v.remainingDays - extraDays });
  }
  if (tight.length) {
    const worst = tight.reduce((a, b) => (b.slack < a.slack ? b : a));
    const short = tight.filter(t => t.slack < 3).length;
    if (short > 0) {
      predictive.push({
        ...base, id: 'plan-fleet', level: 'predictive', severity: worst.slack < 0 ? 'high' : 'watch',
        deviceId: 'plan-fleet', container: `${short} vessel${short === 1 ? '' : 's'}`, vesselId: worst.v.id,
        title: `Cape diversion leaves ${round1(worst.slack)} d of slack`,
        detail: `${short} of ${tight.length} vessels fall short: +${round1(worst.extraDays)} d / +${Math.round(worst.extraNm).toLocaleString()} nm against a ${worst.v.deliveryWindowDays} d window on ${worst.v.id}.`,
        minutes: null, metric: `${round1(worst.slack)} d`, confidence: 0.82,
        action: 'Confirm consignee tolerance before committing',
      });
    }
  }

  const zoneVessels = (net?.vessels ?? []).filter((v: any) => v.route === 'suez');
  if (zoneVessels.length) {
    predictive.push({
      ...base, id: 'corridor', level: 'predictive', severity: 'watch', deviceId: 'corridor',
      container: 'Corridor', vesselId: `${zoneVessels.length} vessels`,
      title: 'Red Sea transit exposure ahead',
      detail: `${zoneVessels.length} vessel${zoneVessels.length > 1 ? 's' : ''} still routed through Bab-el-Mandeb; diversion lead time is the binding constraint.`,
      minutes: null, metric: `${zoneVessels.length} hulls`, confidence: 0.8,
      action: 'Decide before the next waypoint commit',
    });
  }

  const weight: Record<Severity, number> = { critical: 0, high: 1, watch: 2 };
  const order = (list: OpsCase[]) =>
    list.sort((a, b) => weight[a.severity] - weight[b.severity] || (a.minutes ?? 9e9) - (b.minutes ?? 9e9));

  // One case per device: a box that lost its compressor also looks like a trend
  // alarm, and two rows for one container makes the red column unreadable.
  const perDevice = (list: OpsCase[]) => {
    const used = new Set<string>();
    return list.filter(c => (used.has(c.deviceId) ? false : (used.add(c.deviceId), true)));
  };

  const urgentSorted = perDevice(order(urgent)).slice(0, 5);
  const urgentDevices = new Set(urgentSorted.map(c => c.deviceId));
  const predictiveSorted = order(predictive)
    .filter(c => !urgentDevices.has(c.deviceId))
    .slice(0, 5);

  return { urgent: urgentSorted, predictive: predictiveSorted, generatedAt: at };
}

export const boardSummary = (b: CaseBoard) => ({
  urgent: b.urgent.length,
  predictive: b.predictive.length,
  critical: b.urgent.filter(c => c.severity === 'critical').length,
});
