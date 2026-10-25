/**
 * TinyFish spend control.
 *
 * The demo runs the same assessment repeatedly, so the expensive thing is not
 * one call — it is *repeat* calls. Three cheap mechanisms keep a wallet alive:
 *
 *  1. TTL cache      — a 10-minute-old Red Sea advisory is still valid.
 *  2. in-flight dedupe — two agents asking the same question share one request.
 *  3. hourly cap     — a hard ceiling of paid calls per rolling UTC hour; past
 *                      it the system degrades to the local model instead of
 *                      silently burning credits. Cache hits do not count, so a
 *                      demo can be re-run freely inside the TTL windows.
 *
 * Everything is counted so the console can show spend instead of hiding it.
 */

const CAP_PER_HOUR = 20;
const KEY = 'synapse.tfBudget.v1';

export interface BudgetSnapshot {
  spent: number;
  cap: number;
  calls: number;
  saved: number;
  cacheHits: number;
  window: string;
}

type Stored = { window: string; spent: number; calls: number };

const nowWindow = () => new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH

const read = (): Stored => {
  const fresh: Stored = { window: nowWindow(), spent: 0, calls: 0 };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh;
    const parsed = JSON.parse(raw) as Stored;
    return parsed.window === fresh.window ? parsed : fresh;
  } catch { return fresh; }
};

let state: Stored = read();
let saved = 0;
let cacheHits = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(f => f());

export const onBudgetChange = (f: () => void) => {
  listeners.add(f);
  return () => { listeners.delete(f); };
};

const persist = () => {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode */ }
};

export function budgetSnapshot(): BudgetSnapshot {
  if (state.window !== nowWindow()) { state = { window: nowWindow(), spent: 0, calls: 0 }; persist(); }
  return { spent: state.spent, cap: CAP_PER_HOUR, calls: state.calls, saved, cacheHits, window: state.window };
}

/** Reserve one paid call. Returns false when the hourly ceiling is reached. */
export function charge(n = 1): boolean {
  if (state.window !== nowWindow()) { state = { window: nowWindow(), spent: 0, calls: 0 }; saved = 0; cacheHits = 0; }
  if (state.spent + n > CAP_PER_HOUR) return false;
  state.spent += n;
  state.calls += n;
  persist();
  notify();
  return true;
}

export function remaining(): number {
  if (state.window !== nowWindow()) return CAP_PER_HOUR;
  return Math.max(0, CAP_PER_HOUR - state.spent);
}

export function noteSaved(n = 1) {
  saved += n;
  cacheHits += n;
  notify();
}

/* ---------- TTL cache + in-flight dedupe ---------- */

const cache = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

export interface MemoResult<T> { value: T; hit: boolean }

/**
 * Run `fn` at most once per `ttlMs` per key. Concurrent callers with the same
 * key share the first promise, so a fan-out of agents costs one upstream call.
 */
export async function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<MemoResult<T>> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) {
    noteSaved(1);
    return { value: hit.value as T, hit: true };
  }
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return { value: await running, hit: true };

  const run = fn().then(value => {
    cache.set(key, { at: Date.now(), value });
    return value;
  }).finally(() => inflight.delete(key));

  inflight.set(key, run);
  return { value: await run, hit: false };
}

export function clearCache() {
  cache.clear();
  inflight.clear();
}

export function cacheSize() {
  return cache.size;
}
