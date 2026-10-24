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

export async function tf<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(init.timeoutMs ?? 12_000);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(BASE + path, { ...init, signal: sig, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
      if (res.status === 503 && (await res.clone().text()).includes('NOT_CONFIGURED')) { setConfigured(false); throw new TFError(503, 'NOT_CONFIGURED'); }
      // Only 429 and 503 are worth retrying; 401/402/403 never are.
      if ((res.status === 429 || res.status === 503) && attempt < 2) {
        const ra = Number(res.headers.get('retry-after')) * 1000;
        await sleep(ra || 500 * 2 ** attempt + Math.random() * 250, sig);
        continue;
      }
      record({ ok: res.ok, netFail: false });
      if (!res.ok) throw new TFError(res.status, await res.text());
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof TFError) throw e;
      if (!signal?.aborted) record({ ok: false, netFail: true });
      throw e;
    }
  }
}

/* ---- services ---- */
export interface SearchHit { title: string; snippet: string; url: string; date?: string; site_name?: string }
export async function search(q: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const p = new URLSearchParams({ query: q, recency_minutes: '4320', domain_type: 'news', purpose: 'Find current shipping advisories about Red Sea transit for a cold-chain risk assessment' });
  const r = await tf<{ results: SearchHit[] }>(`/search?${p}`, {}, signal);
  return r.results ?? [];
}
export interface Page { url: string; final_url: string; title: string|null; description: string|null; published_date: string|null; text: string|null }
export interface FetchOut { results: Page[]; errors: { url: string; error: string }[] }
export const getContents = (urls: string[], signal?: AbortSignal) =>
  tf<FetchOut>('/fetch', { method: 'POST', timeoutMs: 20_000, body: JSON.stringify({ urls: urls.slice(0, 10), format: 'markdown', ttl: 0, per_url_timeout_ms: 8000 }) }, signal);

export const startResearch = (query: string) => tf<{ research_run_id: string }>('/research/start', { method: 'POST', body: JSON.stringify({ query }) });
export const getResearch = (id: string, signal?: AbortSignal) => tf<{ status: string; deep_result?: { result?: string; citations?: string[] } }>(`/research/${id}`, {}, signal);
export const cancelResearch = (id: string) => tf(`/research/${id}/cancel`, { method: 'POST' }).catch(() => {});
export const wallet = () => tf<any>('/wallet');

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
