/**
 * Shared HTTP layer for every external read.
 *
 * Two latency classes, because this app serves two very different questions:
 *
 *  - `urgent` (reactive): is a container out of limits *right now*? Hard 2.6 s
 *    ceiling, no retries. A late answer about a box that is already at 9 °C is
 *    worthless, so fail fast and let the caller use the last good reading.
 *  - `patient` (predictive/background): 12 s ceiling, two jittered retries and a
 *    per-host circuit breaker, so a flapping upstream cannot stall the console.
 *
 * Everything is measured, so the UI reports real p50/p95 latency instead of a
 * decorative number.
 */

export type Tier = 'urgent' | 'patient';

export interface CallSample {
  host: string;
  path: string;
  tier: Tier;
  ms: number;
  ok: boolean;
  status: number;
  at: number;
  timedOut: boolean;
  cached: boolean;
}

export interface NetSnapshot {
  calls: CallSample[];
  total: number;
  okRate: number;
  p50: number;
  p95: number;
  last: number;
  timeouts: number;
  avg: number;
  openHosts: string[];
}

const MAX_SAMPLES = 48;
const samples: CallSample[] = [];
const listeners = new Set<() => void>();
const breakers = new Map<string, { fails: number; until: number }>();

const notify = () => listeners.forEach(f => f());
export const onNetChange = (f: () => void) => {
  listeners.add(f);
  return () => { listeners.delete(f); };
};

const hostOf = (u: string) => {
  try { return new URL(u).hostname; } catch { return u; }
};

const percentile = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
};

export function netSnapshot(): NetSnapshot {
  const ok = samples.filter(s => s.ok).length;
  const ms = samples.map(s => s.ms);
  const now = Date.now();
  return {
    calls: samples,
    total: samples.length,
    okRate: samples.length ? ok / samples.length : 1,
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    last: samples.length ? samples[samples.length - 1].ms : 0,
    timeouts: samples.filter(s => s.timedOut).length,
    avg: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0,
    openHosts: [...breakers.entries()].filter(([, b]) => b.until > now).map(([h]) => h),
  };
}

/** A cached answer costs nothing, but it should still be visible as traffic. */
export function recordCacheHit(host: string, path: string, tier: Tier = 'patient') {
  push({ host, path, tier, ms: 0, ok: true, status: 200, at: Date.now(), timedOut: false, cached: true });
}

function push(s: CallSample) {
  samples.push(s);
  if (samples.length > MAX_SAMPLES) samples.shift();
  notify();
}

const sleep = (ms: number, sig?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    sig?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')); }, { once: true });
  });

export interface ReqOpts {
  tier?: Tier;
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT: Record<Tier, number> = { urgent: 2_600, patient: 12_000 };
const DEFAULT_RETRIES: Record<Tier, number> = { urgent: 0, patient: 2 };

const BREAK_AFTER = 3;
const BREAK_FOR_MS = 15_000;

/**
 * A response we already counted as a breaker failure. Without this marker the
 * throw below is caught by the same try/catch and the failure is counted twice,
 * which trips a three-strike breaker after two bad responses.
 */
class HttpResponseError extends Error {}

/** Fetch JSON under an explicit latency contract, with metrics and retries. */
export async function requestJson<T>(url: string, opts: ReqOpts = {}): Promise<T> {
  const tier = opts.tier ?? 'patient';
  const host = hostOf(url);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT[tier];
  const retries = opts.retries ?? DEFAULT_RETRIES[tier];
  const brake = breakers.get(host);
  const now = Date.now();

  if (brake && brake.until > now && tier === 'patient') {
    push({ host, path: pathOf(url), tier, ms: 0, ok: false, status: 0, at: now, timedOut: false, cached: false });
    throw new Error(`${host} circuit open — retry in ${Math.ceil((brake.until - now) / 1000)}s`);
  }

  const trip = (host: string) => {
    const b = breakers.get(host) ?? { fails: 0, until: 0 };
    const fails = b.fails + 1;
    breakers.set(host, { fails, until: fails >= BREAK_AFTER ? Date.now() + BREAK_FOR_MS : 0 });
  };

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = performance.now();
    const timeout = AbortSignal.timeout(timeoutMs);
    const sig = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: opts.headers,
        body: opts.body == null ? undefined : JSON.stringify(opts.body),
        signal: sig,
        credentials: 'omit',
      });
      const ms = Math.round(performance.now() - started);
      const ok = res.ok;
      push({ host, path: pathOf(url), tier, ms, ok, status: res.status, at: Date.now(), timedOut: false, cached: false });
      if (ok) {
        breakers.delete(host);
        return (await res.json()) as T;
      }
      if (res.status === 429 || res.status >= 500) {
        trip(host);
        if (attempt < retries) { await sleep(300 * 2 ** attempt + Math.random() * 250, opts.signal); continue; }
      }
      throw new HttpResponseError(`${host} ${res.status}`);
    } catch (e) {
      // A status error was already counted above; only transport failures and
      // timeouts are counted here, once per attempt.
      if (e instanceof HttpResponseError) throw e;
      lastErr = e;
      const timedOut = (e as any)?.name === 'TimeoutError';
      if (timedOut) push({ host, path: pathOf(url), tier, ms: Math.round(performance.now() - started), ok: false, status: 0, at: Date.now(), timedOut: true, cached: false });
      trip(host);
      if (opts.signal?.aborted) break;
      if (attempt < retries && !timedOut) { await sleep(320 * 2 ** attempt + Math.random() * 220, opts.signal); continue; }
      break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('request failed');
}

const pathOf = (url: string) => {
  try { const u = new URL(url); return u.pathname; } catch { return url; }
};
