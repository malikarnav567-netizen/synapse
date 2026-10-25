import { memo, charge } from './budget';
import { isDummy } from './mode';
import { recordCacheHit } from './net';

export interface Evidence { id: string; provider: 'search'|'fetch'|'research'|'agent'|'browser'|'local'; title: string; sourceUrl: string; retrievedAt: string; publishedAt?: string; summary: string; confidence: number }
export interface AgentResult<T> { status: 'ok'|'degraded'|'failed'|'cancelled'; data: T; evidence: Evidence[]; warnings: string[] }
export interface AgentRunEvent { runId: string; seq: number; ts: string; agent: string; level: 'info'|'warn'|'error'; message: string; source: 'local'|'tinyfish' }
export interface Decision { runId: string; decisionId: string; severity: 'low'|'medium'|'high'|'critical'; action: string; confidence: number; reasoning: string; evidence: Evidence[]; requiresHumanApproval: true; evidenceRevision: number; summary: any }
export type TinyFishStatus = 'CONNECTED'|'DEGRADED'|'OFFLINE'|'NOT_CONFIGURED';

export const BASE: string = (import.meta as any).env?.VITE_API_BASE ?? '/api/tf';
export class TFError extends Error { constructor(public status: number, msg: string) { super(msg); } }

type Outcome = { ok: boolean; netFail: boolean };
const outcomes: Outcome[] = [];
let configured = true;
const listeners = new Set<() => void>();
const record = (o: Outcome) => { outcomes.push(o); if (outcomes.length > 20) outcomes.shift(); listeners.forEach(f => f()); };
export const onStatusChange = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const setConfigured = (v: boolean) => { configured = v; listeners.forEach(f => f()); };
export const isConfigured = () => configured;
export function deriveStatus(): TinyFishStatus {
  if (!configured) return 'NOT_CONFIGURED';
  const recent = outcomes.slice(-10);
  if (recent.length && recent.every(o => o.netFail)) return 'OFFLINE';
  if (recent.some(o => !o.ok)) return 'DEGRADED';
  return 'CONNECTED';
}
export async function probe() {
  try { const r = await fetch(BASE + '/status'); const j = await r.json(); setConfigured(!!j.configured); record({ ok: r.ok, netFail: false }); }
  catch { record({ ok: false, netFail: true }); }
}

const sleep = (ms: number, s?: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  s?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')); });
});

export async function tf<T>(path: string, init: RequestInit & { timeoutMs?: number; silent?: boolean } = {}, signal?: AbortSignal): Promise<T> {
  // Dummy mode is a hard offline switch: no request, no spend, no half-state.
  if (isDummy()) throw new TFError(451, 'DUMMY_MODE');
  const { timeoutMs, silent = false, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs ?? 12_000);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  // Optional background work (research, cancellation) must not drag the
  // connection badge to DEGRADED when the upstream throttles it.
  const note = (o: Outcome) => { if (!silent) record(o); };
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(BASE + path, { ...rest, signal: sig, headers: { 'Content-Type': 'application/json', ...(rest.headers ?? {}) } });
      if (res.status === 503 && (await res.clone().text()).includes('NOT_CONFIGURED')) { setConfigured(false); throw new TFError(503, 'NOT_CONFIGURED'); }
      // Only 429 and 503 are worth retrying; 401/402/403 never are.
      if ((res.status === 429 || res.status === 503) && attempt < 2) {
        const ra = Number(res.headers.get('retry-after')) * 1000;
        await sleep(ra || 500 * 2 ** attempt + Math.random() * 250, sig);
        continue;
      }
      note({ ok: res.ok, netFail: false });
      if (!res.ok) throw new TFError(res.status, await res.text());
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof TFError) throw e;
      if (!signal?.aborted) note({ ok: false, netFail: true });
      throw e;
    }
  }
}

/* ---- services ---- */
export interface SearchHit { title: string; snippet: string; url: string; date?: string; site_name?: string }
const SEARCH_PURPOSE = 'Find current shipping advisories about Red Sea transit for a cold-chain risk assessment';
/**
 * Cache windows by question type — this is what keeps the wallet alive.
 * Advisories move in hours, port notes in days, WHO storage rules in years.
 */
const SEARCH_TTL = { news: 15 * 60_000, general: 6 * 3.6e6, reference: 24 * 3.6e6 };

export async function search(
  q: string,
  signal?: AbortSignal,
  opts: { news?: boolean; purpose?: string; recencyMinutes?: number | null } = {},
): Promise<SearchHit[]> {
  const p = new URLSearchParams({ query: q, purpose: opts.purpose ?? SEARCH_PURPOSE });
  // Reference guidance (e.g. WHO storage rules) is not time-sensitive, so it can
  // skip the recency window that would otherwise filter out official handbooks.
  const recency = opts.recencyMinutes === undefined ? (opts.news ? 1440 : 10080) : opts.recencyMinutes;
  if (recency != null) p.set('recency_minutes', String(recency));
  if (opts.news) p.set('domain_type', 'news');

  const ttl = opts.recencyMinutes === null ? SEARCH_TTL.reference : opts.news ? SEARCH_TTL.news : SEARCH_TTL.general;
  const { value, hit } = await memo(`search:${p}`, ttl, async () => {
    if (!charge()) throw new TFError(429, 'BUDGET_EXHAUSTED');
    const r = await tf<{ results: SearchHit[] }>(`/search?${p}`, { timeoutMs: 9_000 }, signal);
    return r.results ?? [];
  });
  if (hit) recordCacheHit('api.search.tinyfish.ai', '/search');
  return value;
}
const portCache = new Map<string, SearchHit[]>();
/** Port-level advisories for the globe popups (cached per session; search is free tier). */
export async function portAdvisory(port: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const cached = portCache.get(port);
  if (cached) return cached;
  const hits = await search(`${port} port congestion strike vessel delay`, signal, {
    purpose: `Find current port congestion, strike and berth delay advisories at ${port}`,
    recencyMinutes: 20160,
  });
  const safe = hits.filter(h => /^https:\/\//.test(h.url)).slice(0, 3);
  portCache.set(port, safe);
  return safe;
}
export interface Page { url: string; final_url: string; title: string|null; description: string|null; published_date: string|null; text: string|null }
export interface FetchOut { results: Page[]; errors: { url: string; error: string }[] }
export const getContents = (urls: string[], signal?: AbortSignal) => {
  const list = urls.slice(0, 3);
  return memo(`fetch:${[...list].sort().join('|')}`, 6 * 3.6e6, async () => {
    if (!charge()) throw new TFError(429, 'BUDGET_EXHAUSTED');
    return tf<FetchOut>('/fetch', {
      method: 'POST',
      timeoutMs: 18_000,
      body: JSON.stringify({ urls: list, format: 'markdown', ttl: 0, per_url_timeout_ms: 5000 }),
    }, signal);
  }).then(r => { if (r.hit) recordCacheHit('api.fetch.tinyfish.ai', '/fetch'); return r.value; });
};

export const startResearch = (query: string) =>
  (charge() ? tf<{ research_run_id: string }>('/research/start', { method: 'POST', body: JSON.stringify({ query }), silent: true })
            : Promise.reject(new TFError(429, 'BUDGET_EXHAUSTED')));
export const getResearch = (id: string, signal?: AbortSignal) => tf<{ status: string; deep_result?: { result?: string; citations?: string[] } }>(`/research/${id}`, { silent: true }, signal);
export const cancelResearch = (id: string) => tf(`/research/${id}/cancel`, { method: 'POST', silent: true }).catch(() => {});
export const wallet = () => memo('wallet', 60_000, () => tf<any>('/wallet')).then(r => r.value);

export async function runAgent<T>(url: string, goal: string, output_schema: object, signal: AbortSignal, onProgress: (m: string) => void, onRunId: (id: string) => void): Promise<T> {
  const res = await fetch(BASE + '/agent/run-sse', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, goal, output_schema }) });
  if (!res.ok || !res.body) throw new Error('agent ' + res.status);
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; let runId = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = frame.split('\n').find(l => l.startsWith('data: ')); if (!line) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.run_id && !runId) { runId = ev.run_id; onRunId(runId); }
      if (ev.type === 'PROGRESS') onProgress(ev.purpose);
      if (ev.type === 'COMPLETE') {
        if (ev.status !== 'COMPLETED') throw new Error(ev.error?.message ?? 'agent failed');
        return (ev.result?.result ?? ev.result) as T;
      }
    }
  }
  const r = await fetch(`${BASE}/agent/run/${runId}`).then(r => r.json());
  if (r.status === 'COMPLETED') return r.result as T;
  throw new Error('agent stream ended: ' + r.status);
}
export const capture = (url: string, signal?: AbortSignal) =>
  fetch(BASE + '/browser/capture', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) }).then(r => { if (!r.ok) throw new Error('capture ' + r.status); return r.json(); });
