import { search, getContents, startResearch, getResearch, capture, isConfigured } from './tf';
import type { AgentResult, AgentRunEvent, Decision, Evidence } from './tf';
import type { SensorSummary } from './iot';
import { isDummy } from './mode';

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
import { SEA_LANES, ZONE, type LonLat } from './routes';
export { ZONE } from './routes';
export type { LonLat };
const inZone = (p: LonLat, z: LonLat[]) => { let c = false; for (let i = 0, j = z.length - 1; i < z.length; j = i++) { const [xi, yi] = z[i], [xj, yj] = z[j]; if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c; } return c; };
export const intersectsZone = (g: LonLat[], z: LonLat[]) => g.some(p => inZone(p, z));
const rad = (d: number) => (d * Math.PI) / 180;
const nm = (a: LonLat, b: LonLat) => { const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]); const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2; return 2 * 3440.065 * Math.asin(Math.sqrt(h)); };
const pathNm = (g: LonLat[]) => g.slice(1).reduce((s, p, i) => s + nm(g[i], p), 0);
const SPEED_KN = 14;

export const buildNominalNetwork = () => ({
  lanes: SEA_LANES.map(l => ({
    ...l,
    geometry: l.geometry.map(p => [...p] as LonLat),
    alternate: l.alternate.map(p => [...p] as LonLat),
  })),
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

const RELEVANT = /red sea|bab[- ]el[- ]mandeb|suez|houthi|cape of good hope|cape town|durban/i;
const clean = (s: string) => s.replace(/[#*_`>\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 280);
const host = (u: string) => { try { return new URL(u).hostname; } catch { return ''; } };

function intelligenceAgent(ctx: RunCtx) {
  const A = AGENTS[1];
  return stage<{ sources: number }>(ctx, 28_000, async (signal) => {
    if (isDummy()) throw new Error('dummy mode');                     // offline demo: never call TinyFish
    if (!isConfigured()) throw new Error('tinyfish not configured');   // stay fully local until a key is set
    ctx.emit(A, `${A} started`);
    ctx.emit(A, 'TinySearch: gathering Red Sea transit advisories', 'info', 'tinyfish');
    const [newsHits, advisoryHits, capeHits, whoHits] = await Promise.all([
      search('Red Sea shipping attack Bab-el-Mandeb', signal, { news: true }),
      search('Suez Canal diversion Cape of Good Hope shipping', signal),
      search('Cape Town Durban port congestion shipping delay', signal),
      search('WHO vaccine cold chain storage temperature guidance', signal, {
        purpose: 'Find official WHO vaccine cold chain storage and 2-8 C temperature guidance',
        recencyMinutes: null,
      }),
    ]);
    const hits = [...newsHits, ...advisoryHits, ...capeHits];
    const whoOfficial = whoHits.filter(h => host(h.url).endsWith('who.int'));
    const retrievedAt = new Date().toISOString();
    ctx.emit(A, newsHits.length
      ? `Live signal: confirmed — ${newsHits.length} news hit${newsHits.length === 1 ? '' : 's'} in the last 24h`
      : 'Live signal: no news hit in the last 24h — widening to 7 days', 'info', 'tinyfish');

    // Web text is untrusted data, never instructions: drop sources that do not
    // mention the affected corridor or the cold-chain context.
    const relevant = hits.filter(h => RELEVANT.test(`${h.title} ${h.snippet}`));
    const seen = new Set<string>();
    const unique = (relevant.length >= 2 ? relevant : hits).filter(h => {
      const d = host(h.url);
      if (!d || seen.has(d)) return false;
      seen.add(d);
      return true;
    });
    if (!unique.length) throw new Error('no search hits');

    const evidence: Evidence[] = unique.slice(0, 6).map((h, i) => ({
      id: `search-${i}-${ctx.runId.slice(0, 4)}`,
      provider: 'search' as const,
      title: h.title || h.url,
      sourceUrl: h.url,
      retrievedAt,
      publishedAt: h.date,
      summary: clean(h.snippet || h.title || ''),
      confidence: 0.68,
    }));

    // WHO grounding runs through the same Fetch call (no extra request budget).
    const urls = [...unique.slice(0, 2).map(h => h.url), ...whoOfficial.slice(0, 1).map(h => h.url)];
    if (capeHits.length) {
      ctx.emit(A, `Cape route constraints: ${capeHits.length} port advisories retrieved`, 'info', 'tinyfish');
    }
    try {
      ctx.emit(A, 'TinyFetch: reading advisory sources', 'info', 'tinyfish');
      const out = await getContents(urls, signal);
      for (const p of out.results) {
        const text = (p.title ?? '') + (p.description ?? '') + (p.text ?? '').slice(0, 3000);
        if (!RELEVANT.test(text) && !p.text) continue;
        const i = evidence.findIndex(e => host(e.sourceUrl) === host(p.final_url || p.url));
        const next: Evidence = {
          id: (i >= 0 ? evidence[i].id : `fetch-${evidence.length}-${ctx.runId.slice(0, 4)}`),
          provider: 'fetch',
          title: p.title ?? p.final_url,
          sourceUrl: p.final_url || p.url,
          retrievedAt,
          publishedAt: p.published_date ?? undefined,
          summary: clean(p.description ?? p.text ?? ''),
          confidence: 0.78,
        };
        if (i >= 0) evidence[i] = next;
        else evidence.push(next);
      }
    } catch { /* search hits are already live TinyFish evidence */ }

    // Ground the cold-chain score in the WHO 2–8 °C rule when we can find it.
    if (evidence.some(e => host(e.sourceUrl).endsWith('who.int'))) {
      ctx.emit(A, 'WHO 2–8 °C storage rule grounded', 'info', 'tinyfish');
    } else if (whoOfficial[0]) {
      evidence.push({
        id: `who-${ctx.runId.slice(0, 4)}`,
        provider: 'search',
        title: whoOfficial[0].title || 'WHO vaccine storage guidance',
        sourceUrl: whoOfficial[0].url,
        retrievedAt,
        publishedAt: whoOfficial[0].date,
        summary: clean(whoOfficial[0].snippet || ''),
        confidence: 0.74,
      });
      ctx.emit(A, 'WHO 2–8 °C storage rule grounded (search excerpt)', 'info', 'tinyfish');
    } else {
      ctx.emit(A, 'WHO storage guidance not retrieved — cold-chain score stays modelled', 'warn');
    }

    if (!evidence.length) throw new Error('no relevant evidence');
    ctx.emit(A, `${evidence.length} advisory sources verified`, 'info', 'tinyfish');
    return { status: 'ok' as const, data: { sources: evidence.length }, evidence, warnings: [] as string[] };
  }, () => {
    ctx.emit(A, isDummy() ? 'Dummy mode — TinyFish bypassed, local model only' : 'TinyFish unavailable — using local resilience model', 'warn');
    ctx.emit(A, 'Assessment completed with limited external evidence', 'warn');
    return { status: 'degraded' as const, data: { sources: 0 }, evidence: [], warnings: ['local fallback'] };
  });
}

const RESEARCH_QUERY = 'Impact of Red Sea closure on pharmaceutical cold-chain shipping and Cape of Good Hope diversion';
const RESEARCH_TTL_MS = 12 * 60 * 60 * 1000;   // reuse a briefing for a working day
const RESEARCH_KEY = 'synapse.research.v1';
type ResearchCache = { id: string; status: 'running' | 'done'; startedAt: string; evidence?: Evidence };

function readResearch(): ResearchCache | null {
  try {
    const raw = localStorage.getItem(RESEARCH_KEY);
    const cached = raw ? (JSON.parse(raw) as ResearchCache) : null;
    if (!cached?.id) return null;
    if (Date.now() - Date.parse(cached.startedAt) > RESEARCH_TTL_MS) return null;
    return cached;
  } catch { return null; }
}
function writeResearch(cache: ResearchCache | null) {
  try {
    if (cache) localStorage.setItem(RESEARCH_KEY, JSON.stringify(cache));
    else localStorage.removeItem(RESEARCH_KEY);
  } catch { /* storage unavailable */ }
}

async function watchResearch(ctx: RunCtx, onEvidence: (e: Evidence) => void) {
  if (isDummy() || !isConfigured()) return;           // offline demo / no key → no background research call
  const cached = readResearch();
  if (cached?.status === 'done' && cached.evidence) { onEvidence(cached.evidence); return; }   // quota-safe reuse

  let id = cached?.status === 'running' ? cached.id : '';
  if (!id) {
    try {
      const started = await startResearch(RESEARCH_QUERY);
      id = started?.research_run_id ?? '';
      if (!id) return;
      writeResearch({ id, status: 'running', startedAt: new Date().toISOString() });
    } catch { return; }                                // bonus evidence only
  }

  // The run is shared by every simulation, so a reset must not cancel it.
  try {
    for (;;) {
      await new Promise(r => setTimeout(r, 12_000));
      if (ctx.signal.aborted) return;
      const r = await getResearch(id, ctx.signal);
      if (r.status === 'COMPLETED' && r.deep_result?.result) {
        const evidence: Evidence = { id: 'research-' + id, provider: 'research', title: 'TinyFish Research briefing', sourceUrl: r.deep_result.citations?.[0] ?? 'https://agent.tinyfish.ai', retrievedAt: new Date().toISOString(), summary: clean(r.deep_result.result), confidence: 0.8 };
        writeResearch({ id, status: 'done', startedAt: new Date().toISOString(), evidence });
        onEvidence(evidence);
        return;
      }
      if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(r.status)) { writeResearch(null); return; }
    }
  } catch { /* bonus evidence only */ }
}

async function routePlanningAgent(ctx: RunCtx, det: { lanes: any[]; vessels: any[] }) {
  const A = AGENTS[2]; ctx.emit(A, `${A} started`);
  const plans = det.vessels.map(v => {
    const lane = det.lanes.find(l => l.id === v.laneId);
    const suezNm = pathNm(lane.geometry);
    const capeNm = lane.alternate && lane.alternate.length > 1 ? pathNm(lane.alternate) : suezNm;
    const extraNm = Math.max(0, capeNm - suezNm);
    return { vesselId: v.id, extraNm, extraDays: extraNm / (SPEED_KN * 24), suezNm, capeNm };
  });
  ctx.emit(A, 'Cape of Good Hope diversion generated');
  await pause(ctx);
  return { status: 'ok' as const, data: { plans }, evidence: [] as Evidence[], warnings: [] as string[] };
}

async function coldChainAgent(ctx: RunCtx, route: { plans: any[] }, net: Network, sensors: SensorSummary | null) {
  const A = AGENTS[3]; ctx.emit(A, `${A} started`);
  if (sensors) {
    ctx.emit(A, `IoT gateway: ${sensors.devices} devices online · ambient ${sensors.ambientAvg} °C (${sensors.source}) · ${sensors.latencyMs} ms`,
      'info', sensors.source === 'live' ? 'tinyfish' : 'local');
    ctx.emit(A, `Sea state ${sensors.waveMax} m · coldest margin reviewed on ${sensors.reefers} reefers`);
    if (sensors.breaches) {
      ctx.emit(A, `${sensors.breaches} container${sensors.breaches === 1 ? '' : 's'} already above limit — hottest ${sensors.worstId} at ${sensors.worstC} °C`, 'warn');
    }
  }
  const checks = route.plans.map(p => {
    const v = net.vessels.find(x => x.id === p.vesselId)!;
    const slackDays = v.deliveryWindowDays - (v.remainingDays + p.extraDays);
    return { vesselId: v.id, slackDays, risk: slackDays < 0 ? 'high' : slackDays < 2 ? 'medium' : 'low' };
  });
  const order = { low: 0, medium: 1, high: 2 } as any;
  const worst = checks.reduce((a, c) => (!a || c.slackDays < a.slackDays ? c : a), null as any);
  let risk: 'low'|'medium'|'high' = checks.reduce((r, c) => (order[c.risk] > order[r] ? c.risk : r), 'low' as any);
  // A live breach outranks a modelled slack number: the cargo is already out of spec.
  if (sensors && sensors.breaches > 0 && risk === 'low') risk = 'high';
  const slate = sensors?.source === 'live' ? 'live sensor slate' : sensors?.source === 'demo' ? 'demo sensor slate' : 'modelled sensor slate';
  ctx.emit(A, sensors?.breaches
    ? `Cold-chain feasibility assessed — ${risk} risk, ${sensors.breaches} breach${sensors.breaches === 1 ? '' : 'es'} on the ${slate}`
    : `Cold-chain feasibility assessed on the ${slate}`);
  await pause(ctx);
  return { status: 'ok' as const, data: { checks, worst, risk, sensors }, evidence: [] as Evidence[], warnings: [] as string[] };
}

async function recommendationAgent(ctx: RunCtx, r: { detect: any; intel: any; route: any; cold: any }) {
  const A = AGENTS[4]; ctx.emit(A, `${A} started`);
  const evidence: Evidence[] = r.intel.evidence;
  const sensors = r.cold.data.sensors as SensorSummary | null;
  const sensorLine = sensors
    ? ` Live cargo feed: ${sensors.breaches} of ${sensors.reefers} reefers above limit, ambient ${sensors.ambientAvg} °C (${sensors.source}), swell ${sensors.waveMax} m.`
    : '';
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
      ? `${r.detect.data.lanes.length} lanes cross the Red Sea zone. Cape diversion adds up to ${extraDays.toFixed(1)} days; the tightest cold-chain slack is ${r.cold.data.worst?.slackDays.toFixed(1)} days (${risk} risk).${evidence.length ? ` Backed by ${evidence.length} retrieved source${evidence.length > 1 ? 's' : ''}.` : ' Modelled locally: no external evidence was retrieved.'}${sensorLine}`
      : `No eligible vessels cross the zone.${sensorLine}`,
    summary: {
      lanes: r.detect.data.lanes.length, vessels: n, extraNm, extraDays,
      slackDays: r.cold.data.worst?.slackDays ?? 0, risk, plans, checks: r.cold.data.checks, degraded,
      sensors: sensors ? { devices: sensors.devices, reefers: sensors.reefers, breaches: sensors.breaches, ambientAvg: sensors.ambientAvg, waveMax: sensors.waveMax, source: sensors.source, latencyMs: sensors.latencyMs } : null,
    },
  };
  ctx.emit(A, 'Reroute recommendation drafted');
  return { status: 'ok' as const, data: decision, evidence, warnings: [] as string[] };
}

/* ---------- orchestrator ---------- */
let current: RunCtx | null = null;
export async function assessDisruption(net: Network, onEvent?: (e: AgentRunEvent) => void, onLate?: (runId: string, e: Evidence) => void, sensors: SensorSummary | null = null) {
  current?.abort();
  const ctx = makeCtx(onEvent); current = ctx;
  ctx.emit('Orchestrator', isDummy() ? 'SIMULATE DISRUPTION initiated — dummy data mode' : 'SIMULATE DISRUPTION initiated');
  ctx.emit('Orchestrator', 'Red Sea / Bab-el-Mandeb zone activated');
  if (sensors) ctx.emit('Orchestrator', `Cargo IoT snapshot joined: ${sensors.devices} devices · ${sensors.source} ambient`);
  void watchResearch(ctx, e => onLate?.(ctx.runId, e));
  const detect = await detectionAgent(ctx, net);
  const intel = await intelligenceAgent(ctx);
  const route = await routePlanningAgent(ctx, detect.data);
  const cold = await coldChainAgent(ctx, route.data, net, sensors);
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
  const rer = new Set(vessels.filter(v => v.route === 'cape' && v.rerouteEligible).map(v => v.laneId));
  // Swap the geometry, not just the label: the globe draws the actual diversion.
  const lanes = net.lanes.map(l => (rer.has(l.id) && l.alternate
    ? { ...l, status: 'rerouted' as const, geometry: l.alternate, alternate: l.geometry }
    : l));
  const url = d.evidence[0]?.sourceUrl;
  if (url && url.startsWith('https://')) void capture(url).then(onAudit).catch(() => {});   // audit proof, never blocks
  return { lanes, vessels, appliedDecisionIds: [...net.appliedDecisionIds, d.decisionId] };
}
export function resetNetwork() { current?.abort(); current = null; return buildNominalNetwork(); }
