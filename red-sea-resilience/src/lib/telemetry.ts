/**
 * Live telemetry store.
 *
 * Two cadences, on purpose:
 *  - 4 s local tick  — advances the thermal model so the console feels live.
 *  - 60 s upstream   — refreshes the *real* ambient/sea reading from Open-Meteo
 *                      at the vessels' current coordinates. The upstream model
 *                      itself only updates every 15 min, so refreshing faster
 *                      would be pure waste.
 *
 * A failed refresh keeps the last good snapshot and marks it stale, because a
 * dropped sample must never blank a cold-chain console.
 */

import { create } from 'zustand';
import { sampleFleet, nudge, summarise, type SensorSummary, type Snapshot } from './iot';
import { classify, type CaseBoard } from './predict';
import { getMode } from './mode';

const EMPTY: CaseBoard = { urgent: [], predictive: [], generatedAt: 0 };

interface TelemetryState {
  snap: Snapshot | null;
  board: CaseBoard;
  summary: SensorSummary | null;
  loading: boolean;
  lastRefresh: number;
  resolved: string[];
  error: string;
  refresh(net: any): Promise<void>;
  tick(): void;
  resolve(id: string): void;
}

let busy = false;
let lastNet: any = null;

export const useTelemetry = create<TelemetryState>((set, get) => ({
  snap: null,
  board: EMPTY,
  summary: null,
  loading: false,
  lastRefresh: 0,
  resolved: [],
  error: '',

  async refresh(net: any) {
    if (busy) return;
    busy = true;
    lastNet = net;
    set({ loading: true });
    try {
      const snap = await sampleFleet(net, getMode());
      set(s => ({
        snap,
        summary: summarise(snap),
        board: classify(snap, net),
        lastRefresh: Date.now(),
        error: snap.stale ? snap.lastError || 'upstream unreachable' : '',
      }));
    } catch (e) {
      set({ error: String((e as Error)?.message ?? e).slice(0, 120) });
    } finally {
      busy = false;
      set({ loading: false });
    }
  },

  tick() {
    const snap = get().snap;
    if (!snap) return;
    const next = nudge(snap);
    set({ snap: next, summary: summarise(next), board: classify(next, lastNet) });
  },

  resolve(id: string) {
    set(s => ({ resolved: s.resolved.includes(id) ? s.resolved : [...s.resolved, id] }));
  },
}));

let timers: number[] = [];

export function startTelemetry(getNet: () => any) {
  stopTelemetry();
  const fire = () => { void useTelemetry.getState().refresh(getNet()); };
  fire();
  timers = [
    window.setInterval(() => useTelemetry.getState().tick(), 4_000),
    window.setInterval(fire, 60_000),
  ];
  return stopTelemetry;
}

export function stopTelemetry() {
  timers.forEach(t => window.clearInterval(t));
  timers = [];
}
