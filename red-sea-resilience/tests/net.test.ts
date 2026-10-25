/**
 * Latency contract + circuit breaker. Each test uses its own hostname so the
 * module-level breaker state cannot leak between tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { netSnapshot, onNetChange, recordCacheHit, requestJson } from '../src/lib/net';

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];

const stub = (fn: (call: Call, index: number) => Promise<Response>) => {
  calls = [];
  (globalThis as any).fetch = (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return fn({ url, init }, calls.length - 1);
  };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('a successful patient read returns JSON and is recorded with its tier', async () => {
  stub(async () => json({ ok: 1 }));
  const out = await requestJson<{ ok: number }>('https://good.test/a', { tier: 'patient' });
  assert.equal(out.ok, 1);
  const snap = netSnapshot();
  assert.ok(snap.total >= 1);
  assert.equal(snap.calls[snap.calls.length - 1].tier, 'patient');
  assert.equal(snap.calls[snap.calls.length - 1].ok, true);
});

test('patient reads retry a 500 and then succeed', async () => {
  stub(async (_c, i) => (i < 2 ? json({ nope: true }, 500) : json({ ok: 2 })));
  const out = await requestJson<{ ok: number }>('https://retry.test/a', { tier: 'patient', retries: 2 });
  assert.equal(out.ok, 2);
  assert.equal(calls.length, 3, 'two failures + one success');
});

test('urgent reads fail fast: one attempt, no retry', async () => {
  stub(async () => json({ nope: true }, 500));
  await assert.rejects(
    () => requestJson('https://urgent.test/a', { tier: 'urgent' }),
    /500/,
  );
  assert.equal(calls.length, 1, 'urgent must not retry');
});

test('a hanging urgent read is cut off by its own deadline', async () => {
  // Node unrefs AbortSignal.timeout's timer, so the stub itself must hold the
  // event loop open or the process would exit with the promise pending.
  stub(({ init }) => new Promise<Response>((_res, rej) => {
    const guard = setTimeout(() => rej(new Error('stub never aborted')), 3_000);
    const sig = (init as any)?.signal as AbortSignal | undefined;
    sig?.addEventListener('abort', () => {
      clearTimeout(guard);
      rej(new DOMException('timeout', 'TimeoutError'));
    });
  }));
  const started = Date.now();
  await assert.rejects(() => requestJson('https://slow.test/a', { tier: 'urgent', timeoutMs: 120 }));
  const took = Date.now() - started;
  assert.ok(took < 1200, `should abort near 120 ms, took ${took}`);
  assert.ok(netSnapshot().timeouts >= 1, 'the timeout is counted');
});

test('the breaker opens after three failures and short-circuits the next call', async () => {
  stub(async () => json({ boom: true }, 500));
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => requestJson('https://break.test/a', { tier: 'patient', retries: 0 }));
  }
  const before = calls.length;
  await assert.rejects(() => requestJson('https://break.test/a', { tier: 'patient' }), /circuit open/);
  assert.equal(calls.length, before, 'an open circuit must not touch the network');
});

test('an urgent read ignores an open breaker (it cannot wait 15 s)', async () => {
  // Three failures trip the host, then the upstream recovers.
  stub(async (_c, i) => (i < 3 ? json({ nope: 1 }, 500) : json({ ok: 3 })));
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => requestJson('https://urgentbreak.test/a', { tier: 'patient', retries: 0 }));
  }
  await assert.rejects(() => requestJson('https://urgentbreak.test/a', { tier: 'patient' }), /circuit open/);
  const out = await requestJson<{ ok: number }>('https://urgentbreak.test/a', { tier: 'urgent' });
  assert.equal(out.ok, 3, 'the urgent tier still gets its answer while the breaker is open');
});

test('cached answers still appear in the metrics, with zero cost', async () => {
  stub(async () => json({}));
  recordCacheHit('cache.test', '/x');
  const last = netSnapshot().calls.slice(-1)[0];
  assert.equal(last.cached, true);
  assert.equal(last.ms, 0);
  assert.equal(last.ok, true);
});

test('listeners fire on every sample and can unsubscribe', async () => {
  stub(async () => json({}));
  let hits = 0;
  const off = onNetChange(() => { hits++; });
  await requestJson('https://listen.test/a', { tier: 'patient' });
  await requestJson('https://listen.test/b', { tier: 'patient' });
  off();
  await requestJson('https://listen.test/c', { tier: 'patient' });
  assert.equal(hits, 2);
});

test('p50/p95 are computed from real samples, not hard-coded', async () => {
  const delays = [10, 20, 30, 40, 500];
  stub((_c, i) => new Promise<Response>(res => setTimeout(() => res(json({})), delays[i % delays.length])));
  for (let i = 0; i < 5; i++) await requestJson(`https://lat.test/${i}`, { tier: 'patient' });
  const snap = netSnapshot();
  assert.ok(snap.p95 >= 30, `p95=${snap.p95}`);
  assert.ok(snap.p95 >= snap.p50, 'p95 is at least p50');
});
