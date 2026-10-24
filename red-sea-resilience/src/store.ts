import { create } from 'zustand';
import { assessDisruption, approveReroute, resetNetwork, buildNominalNetwork } from './lib/engine';

export type Phase = 'IDLE'|'SIMULATING'|'ASSESSING'|'AWAITING_APPROVAL'|'EXECUTING'|'REROUTED'|'RESETTING';
const LEGAL: Record<Phase, Phase[]> = {
  IDLE: ['SIMULATING'], SIMULATING: ['ASSESSING', 'RESETTING'], ASSESSING: ['AWAITING_APPROVAL', 'RESETTING'],
  AWAITING_APPROVAL: ['EXECUTING', 'RESETTING'], EXECUTING: ['REROUTED', 'RESETTING'], REROUTED: ['RESETTING'], RESETTING: ['IDLE'],
};

export const useNet = create<any>((set, get) => ({
  phase: 'IDLE' as Phase, activeRunId: null, events: [], decision: null, extra: [], audits: [], network: buildNominalNetwork(),

  go(next: Phase) { if (!LEGAL[get().phase as Phase].includes(next)) return false; set({ phase: next }); return true; },

  async simulate() {
    if (!get().go('SIMULATING')) return;                       // double-click safe
    set({ events: [], decision: null, extra: [], audits: [] });
    get().go('ASSESSING');
    try {
      const d = await assessDisruption(get().network,
        e => {
          if (e.seq === 1) set({ activeRunId: e.runId });      // the first event announces the ticket number
          if (e.runId !== get().activeRunId) return;           // wrong ticket → ignore
          set((s: any) => ({ events: [...s.events, e].slice(-200) }));
        },
        (runId, ev) => { if (runId === get().activeRunId) set((s: any) => ({ extra: [...s.extra, ev] })); });
      if (d.runId !== get().activeRunId) return;               // result from a dead run → ignore
      set({ decision: d }); get().go('AWAITING_APPROVAL');
    } catch { /* cancelled */ }
  },

  async approve() {
    const { decision, network } = get();
    if (!decision || !get().go('EXECUTING')) return;           // only once
    const next = approveReroute(decision, network, a => { if (get().decision?.decisionId === decision.decisionId) set((s: any) => ({ audits: [...s.audits, a] })); });
    set({ network: next }); get().go('REROUTED');
  },

  reset() {
    if (!get().go('RESETTING')) return;
    set({ network: resetNetwork(), events: [], decision: null, extra: [], audits: [], activeRunId: null });
    get().go('IDLE');
  },
}));
