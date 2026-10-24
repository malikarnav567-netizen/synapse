import { search, getContents, startResearch, getResearch, cancelResearch, runAgent, capture, isConfigured, BASE } from './tf';
import type { AgentResult, AgentRunEvent, Decision, Evidence } from './tf';

/* ---------- runtime ---------- */
export interface RunCtx { runId: string; signal: AbortSignal; abort(): void; emit(agent: string, message: string, level?: AgentRunEvent['level'], source?: AgentRunEvent['source']): void; onCleanup(fn: () => void): void }
export function makeCtx(onEvent?: (e: AgentRunEvent) => void): RunCtx {
  const ac = new AbortController(); const cleanups: (() => void)[] = []; let seq = 0; const runId = crypto.randomUUID();
  return {
    runId, signal: ac.signal,
    abort() { ac.abort(); cleanups.splice(0).forEach(f => { try { f(); } catch {} }); },
    onCleanup: f => { cleanups.push(f); },
    emit(agent, message, level = 'info', source = 'local') {
      if (ac.signal.aborted) return;
      onEvent?.({ runId, seq: ++seq, ts: new Date().toISOString(), agent, level, message, source });
    },
  };
}
export async function stage<T>(ctx: RunCtx, ms: number, live: (s: AbortSignal) => Promise<AgentResult<T>>, local: () => AgentResult<T>): Promise<AgentResult<T>> {
  const ac = new AbortController(); const fwd = () => ac.abort();
  ctx.signal.addEventListener('abort', fwd, { once: true });
  const timer = setTimeout(() => ac.abort(), ms);
  try { return await live(ac.signal); }
  catch { return ctx.signal.aborted ? { ...local(), status: 'cancelled' } : { ...local(), status: 'degraded', warnings: ['Live call failed; local model used'] }; }
  finally { clearTimeout(timer); ctx.signal.removeEventListener('abort', fwd); }
}
const pause = (ctx: RunCtx, ms = 450) => new Promise<void>(r => setTimeout(r, ctx.signal.aborted ? 0 : ms));

/* ---------- demo network ---------- */
export type LonLat = [number, number];
export const ZONE: LonLat[] = [[32, 12], [44, 12], [44, 30], [32, 30]];   // Red Sea / Bab-el-Mandeb
const inZone = (p: LonLat, z: LonLat[]) => { let c = false; for (let i = 0, j = z.length - 1; i < z.length; j = i++) { const [xi, yi] = z[i], [xj, yj] = z[j]; if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c; } return c; };
export const intersectsZone = (g: LonLat[], z: LonLat[]) => g.some(p => inZone(p, z));
const rad = (d: number) => (d * Math.PI) / 180;
const nm = (a: LonLat, b: LonLat) => { const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]); const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2; return 2 * 3440.065 * Math.asin(Math.sqrt(h)); };
const pathNm = (g: LonLat[]) => g.slice(1).reduce((s, p, i) => s + nm(g[i], p), 0);
const CAPE: LonLat[] = [[62, -8], [40, -28], [20, -36], [3, -22], [-10, 0], [-20, 14.5], [-12, 37], [-6, 48.5]];
const SPEED_KN = 14;

export const buildNominalNetwork = () => ({
  lanes: [
    { id: 'L1', name: 'Mumbai → Rotterdam', geometry: [[72.8, 18.9], [60, 14], [43.3, 12.6], [38, 20], [32.5, 30], [15, 36], [4.1, 51.9]] as LonLat[], status: 'nominal' },
    { id: 'L2', name: 'Colombo → Hamburg', geometry: [[79.8, 6.9], [60, 10], [43.5, 12.8], [35, 24], [32.4, 29.9], [10, 38], [9.9, 53.5]] as LonLat[], status: 'nominal' },
    { id: 'L3', name: 'Jebel Ali → Felixstowe', geometry: [[55, 25], [58, 22], [43.4, 12.7], [34, 26], [32.4, 29.9], [10, 38], [1.3, 51.9]] as LonLat[], status: 'nominal' },
    { id: 'L4', name: 'Shanghai → Los Angeles', geometry: [[121.5, 31], [180, 45], [-118, 33.7]] as LonLat[], status: 'nominal' },
  ],
  vessels: [
    { id: 'MV Aurora Pharma', laneId: 'L1', cargo: 'Vaccines, 2–8 °C', rerouteEligible: true, deliveryWindowDays: 33, remainingDays: 17, route: 'suez', extraDays: 0 },
    { id: 'MV Cold Meridian', laneId: 'L2', cargo: 'Insulin, 2–8 °C', rerouteEligible: true, deliveryWindowDays: 27, remainingDays: 19, route: 'suez', extraDays: 0 },
    { id: 'MV Polar Star', laneId: 'L3', cargo: 'Biologics, 2–8 °C', rerouteEligible: false, deliveryWindowDays: 30, remainingDays: 12, route: 'suez', extraDays: 0 },
    { id: 'MV Pacific Crest', laneId: 'L4', cargo: 'Reagents, 2–8 °C', rerouteEligible: true, deliveryWindowDays: 24, remainingDays: 10, route: 'suez', extraDays: 0 },
  ],
  appliedDecisionIds: [] as string[],
});
export type Network = ReturnType<typeof buildNominalNetwork>;

/* ---------- agents ---------- */
export const AGENTS = ['Disruption Detection Agent', 'TinyFish Intelligence Agent', 'Route Planning Agent', 'Cold-Chain Validation Agent', 'Recommendation Agent'];

async function detectionAgent(ctx: RunCtx, net: Network) {
  const A = AGENTS[0]; ctx.emit(A, `${A} started`);
  const lanes = net.lanes.filter(l => intersectsZone(l.geometry, ZONE));
  const ids = new Set(lanes.map(l => l.id));
  const vessels = net.vessels.filter(v => ids.has(v.laneId) && v.rerouteEligible && v.route === 'suez');
  ctx.emit(A, `${lanes.length} lanes flagged at risk`); ctx.emit(A, `${vessels.length} vessels identified for rerouting`);
  await pause(ctx);
  return { status: 'ok' as const, data: { lanes, vessels }, evidence: [] as Evidence[], warnings: [] as string[] };
}

const RELEVANT = /red sea|bab[- ]el[- ]mandeb|suez|houthi|cape of good hope/i;
const clean = (s: string) => s.replace(/[#*_`>\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 280);
const host = (u: string) => { try { return new URL(u).hostname; } catch { return ''; } };

function intelligenceAgent(ctx: RunCtx) {
  const A = AGENTS[1];
  return stage<{ sources: number }>(ctx, 24_000, async (signal) => {
    if (!isConfigured()) throw new Error('tinyfish not configured');   // stay fully local until a key is set
    ctx.emit(A, `${A} started`);
    ctx.emit(A, 'TinySearch: gathering Red Sea transit advisories', 'info', 'tinyfish');
    const hits = (await Promise.all([search('Red Sea Bab-el-Mandeb shipping advisory', signal), search('Suez Canal diversion Cape of Good Hope shipping', signal)])).flat();
    const seen = new Set<string>();
    const urls = hits.filter(h => { const d = host(h.url); if (!d || seen.has(d)) return false; seen.add(d); return true; }).slice(0, 4).map(h => h.url);
    if (!urls.length) throw new Error('no search hits');
    ctx.emit(A, 'TinyFetch: reading advisory sources', 'info', 'tinyfish');
    const out = await getContents(urls, signal);
    const retrievedAt = new Date().toISOString();
    const evidence: Evidence[] = out.results
      .filter(p => RELEVANT.test((p.title ?? '') + (p.description ?? '') + (p.text ?? '').slice(0, 3000)))
      .map((p, i) => ({ id: `fetch-${i}-${ctx.runId.slice(0, 4)}`, provider: 'fetch' as const, title: p.title ?? p.final_url, sourceUrl: p.final_url, retrievedAt, publishedAt: p.published_date ?? undefined, summary: clean(p.description ?? p.text ?? ''), confidence: 0.7 }));

    // Hard-page backup: a browsing agent for one blocked page.
    const hard = out.errors.find(e => /bot_blocked|empty_content/.test(e.error));
    if (hard && evidence.length < 2) {
      try {
        ctx.emit(A, 'TinyFish Agent: opening a protected advisory page', 'info', 'tinyfish');
        let id = '';
        const r: any = await runAgent(hard.url, 'Return the advisory title, date and a 2-sentence summary',
          { type: 'object', properties: { title: { type: 'string' }, date: { type: 'string' }, summary: { type: 'string' } } },
          signal, m => ctx.emit(A, m, 'info', 'tinyfish'), rid => { id = rid; ctx.onCleanup(() => { fetch(`${BASE}/agent/cancel/${id}`, { method: 'POST' }).catch(() => {}); }); });
        if (r?.summary) evidence.push({ id: 'agent-' + ctx.runId.slice(0, 4), provider: 'agent', title: r.title ?? hard.url, sourceUrl: hard.url, retrievedAt: new Date().toISOString(), publishedAt: r.date, summary: clean(r.summary), confidence: 0.6 });
      } catch { /* backup only */ }
    }
    if (!evidence.length) throw new Error('no relevant evidence');
    ctx.emit(A, `${evidence.length} advisory sources verified`, 'info', 'tinyfish');
    return { status: 'ok' as const, data: { sources: evidence.length }, evidence, warnings: out.errors.map(e => `${e.url}: ${e.error}`) };
  }, () => {
    ctx.emit(A, 'TinyFish unavailable — using local resilience model', 'warn');
    ctx.emit(A, 'Assessment completed with limited external evidence', 'warn');
    return { status: 'degraded' as const, data: { sources: 0 }, evidence: [], warnings: ['local fallback'] };
  });
}

async function watchResearch(ctx: RunCtx, onEvidence: (e: Evidence) => void) {
  if (!isConfigured()) return;                                     // no key → no background research call
  try {
    const { research_run_id: id } = await startResearch('Impact of Red Sea closure on pharmaceutical cold-chain shipping and Cape of Good Hope diversion');
    ctx.onCleanup(() => { cancelResearch(id); });
    for (;;) {
      await new Promise(r => setTimeout(r, 12_000));
      if (ctx.signal.aborted) return;
      const r = await getResearch(id, ctx.signal);
      if (r.status === 'COMPLETED' && r.deep_result?.result) {
        onEvidence({ id: 'research-' + id, provider: 'research', title: 'TinyFish Research briefing', sourceUrl: r.deep_result.citations?.[0] ?? 'https://agent.tinyfish.ai', retrievedAt: new Date().toISOString(), summary: clean(r.deep_result.result), confidence: 0.8 });
        return;
      }
      if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(r.status)) return;
    }
  } catch { /* bonus evidence only */ }
}

async function routePlanningAgent(ctx: RunCtx, det: { lanes: any[]; vessels: any[] }) {
  const A = AGENTS[2]; ctx.emit(A, `${A} started`);
  const plans = det.vessels.map(v => {
    const g: LonLat[] = det.lanes.find(l => l.id === v.laneId).geometry;
    const extraNm = pathNm([g[0], ...CAPE, g[g.length - 1]]) - pathNm(g);
    return { vesselId: v.id, extraNm, extraDays: extraNm / (SPEED_KN * 24) };
  });
  ctx.emit(A, 'Cape of Good Hope diversion generated');
  await pause(ctx);
  return { status: 'ok' as const, data: { plans }, evidence: [] as Evidence[], warnings: [] as string[] };
}

async function coldChainAgent(ctx: RunCtx, route: { plans: any[] }, net: Network) {
  const A = AGENTS[3]; ctx.emit(A, `${A} started`);
  const checks = route.plans.map(p => {
    const v = net.vessels.find(x => x.id === p.vesselId)!;
    const slackDays = v.deliveryWindowDays - (v.remainingDays + p.extraDays);
    return { vesselId: v.id, slackDays, risk: slackDays < 0 ? 'high' : slackDays < 2 ? 'medium' : 'low' };
  });
  const order = { low: 0, medium: 1, high: 2 } as any;
  const worst = checks.reduce((a, c) => (!a || c.slackDays < a.slackDays ? c : a), null as any);
  const risk: 'low'|'medium'|'high' = checks.reduce((r, c) => (order[c.risk] > order[r] ? c.risk : r), 'low' as any);
  ctx.emit(A, 'Cold-chain feasibility assessed');
  await pause(ctx);
  return { status: 'ok' as const, data: { checks, worst, risk }, evidence: [] as Evidence[], warnings: [] as string[] };
}

async function recommendationAgent(ctx: RunCtx, r: { detect: any; intel: any; route: any; cold: any }) {
  const A = AGENTS[4]; ctx.emit(A, `${A} started`);
  const evidence: Evidence[] = r.intel.evidence;
  const domains = new Set(evidence.map(e => host(e.sourceUrl)));
  const degraded = [r.intel, r.route, r.cold].some((x: any) => x.status !== 'ok');
  const confidence = degraded && !evidence.length ? 0.62 : Math.min(0.95, Math.max(0.3, 0.55 + 0.1 * Math.min(domains.size, 3) - (degraded ? 0.15 : 0)));
  const plans = r.route.data.plans;
  const extraNm = plans.reduce((s: number, p: any) => s + p.extraNm, 0) / Math.max(1, plans.length);
  const extraDays = plans.reduce((s: number, p: any) => Math.max(s, p.extraDays), 0);
  const risk = r.cold.data.risk as 'low'|'medium'|'high';
  const sev = ({ low: 'medium', medium: 'high', high: 'critical' } as const)[risk];
  const n = plans.length;
  const decision: Decision = {
    runId: ctx.runId, decisionId: crypto.randomUUID(), severity: n ? sev : 'low', confidence, evidence, requiresHumanApproval: true, evidenceRevision: 0,
    action: n ? `Reroute ${n} vessel${n > 1 ? 's' : ''} via the Cape of Good Hope (+${Math.round(extraNm).toLocaleString()} nm, up to +${extraDays.toFixed(1)} days)` : 'No reroute required',
    reasoning: n
      ? `${r.detect.data.lanes.length} lanes cross the Red Sea zone. Cape diversion adds up to ${extraDays.toFixed(1)} days; the tightest cold-chain slack is ${r.cold.data.worst?.slackDays.toFixed(1)} days (${risk} risk).${evidence.length ? ` Backed by ${evidence.length} retrieved source${evidence.length > 1 ? 's' : ''}.` : ' Modelled locally: no external evidence was retrieved.'}`
      : 'No eligible vessels cross the zone.',
    summary: { lanes: r.detect.data.lanes.length, vessels: n, extraNm, extraDays, slackDays: r.cold.data.worst?.slackDays ?? 0, risk, plans, checks: r.cold.data.checks, degraded },
  };
  ctx.emit(A, 'Reroute recommendation drafted');
  return { status: 'ok' as const, data: decision, evidence, warnings: [] as string[] };
}

/* ---------- orchestrator ---------- */
let current: RunCtx | null = null;
export async function assessDisruption(net: Network, onEvent?: (e: AgentRunEvent) => void, onLate?: (runId: string, e: Evidence) => void) {
  current?.abort();
  const ctx = makeCtx(onEvent); current = ctx;
  ctx.emit('Orchestrator', 'SIMULATE DISRUPTION initiated');
  ctx.emit('Orchestrator', 'Red Sea / Bab-el-Mandeb zone activated');
  void watchResearch(ctx, e => onLate?.(ctx.runId, e));
  const detect = await detectionAgent(ctx, net);
  const intel = await intelligenceAgent(ctx);
  const route = await routePlanningAgent(ctx, detect.data);
  const cold = await coldChainAgent(ctx, route.data, net);
  const rec = await recommendationAgent(ctx, { detect, intel, route, cold });
  if (ctx.signal.aborted) throw new DOMException('cancelled', 'AbortError');
  ctx.emit('Orchestrator', 'Reroute recommendation ready — operator approval required');
  return rec.data;
}

export function approveReroute(d: Decision, net: Network, onAudit: (a: any) => void): Network {
  if (net.appliedDecisionIds.includes(d.decisionId)) return net;
  const plans: any[] = d.summary.plans;
  const moved = new Set(plans.map(p => p.vesselId));
  const vessels = net.vessels.map(v => { const p = plans.find(x => x.vesselId === v.id); return moved.has(v.id) ? { ...v, route: 'cape', extraDays: p.extraDays } : v; });
  const rer = new Set(vessels.filter(v => v.route === 'cape').map(v => v.laneId));
  const lanes = net.lanes.map(l => (rer.has(l.id) ? { ...l, status: 'rerouted' } : l));
  const url = d.evidence[0]?.sourceUrl;
  if (url && url.startsWith('https://')) void capture(url).then(onAudit).catch(() => {});   // audit proof, never blocks
  return { lanes, vessels, appliedDecisionIds: [...net.appliedDecisionIds, d.decisionId] };
}
export function resetNetwork() { current?.abort(); current = null; return buildNominalNetwork(); }
