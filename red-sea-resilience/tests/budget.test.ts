import test from 'node:test';
import assert from 'node:assert/strict';

import { budgetSnapshot, charge, clearCache, memo, noteSaved, remaining } from '../src/lib/budget';

test('the hourly cap is a hard ceiling', () => {
  const cap = budgetSnapshot().cap;
  let granted = 0;
  while (charge()) granted++;
  assert.ok(granted <= cap, `granted ${granted} of ${cap}`);
  assert.equal(remaining(), 0);
  assert.equal(budgetSnapshot().spent, cap);
});

test('memo runs the work once and serves the rest from cache', async () => {
  clearCache();
  let runs = 0;
  const fn = async () => { runs++; return { n: runs }; };
  const ttl = 60_000;
  const a = await memo('k1', ttl, fn);
  const b = await memo('k1', ttl, fn);
  const c = await memo('k1', ttl, fn);
  assert.equal(runs, 1);
  assert.equal(a.hit, false);
  assert.equal(b.hit, true);
  assert.equal(c.hit, true);
  assert.deepEqual(a.value, b.value);
});

test('memo expires after its TTL', async () => {
  clearCache();
  let runs = 0;
  const fn = async () => ++runs;
  const realNow = Date.now;
  const t0 = realNow();
  Date.now = () => t0;
  try {
    await memo('k2', 1_000, fn);
    await memo('k2', 1_000, fn);
    Date.now = () => t0 + 1_500;
    const late = await memo('k2', 1_000, fn);
    assert.equal(runs, 2, 'the expired entry is recomputed');
    assert.equal(late.hit, false);
  } finally {
    Date.now = realNow;
  }
});

test('concurrent callers with the same key share one upstream call', async () => {
  clearCache();
  let runs = 0;
  const fn = () => new Promise<number>(res => setTimeout(() => { runs++; res(42); }, 25));
  const results = await Promise.all([memo('k3', 60_000, fn), memo('k3', 60_000, fn), memo('k3', 60_000, fn)]);
  assert.equal(runs, 1, 'in-flight dedupe collapsed three callers into one request');
  for (const r of results) assert.equal(r.value, 42);
});

test('a rejected call does not poison the cache', async () => {
  clearCache();
  let runs = 0;
  await assert.rejects(() => memo('k4', 60_000, async () => { runs++; throw new Error('upstream'); }));
  const ok = await memo('k4', 60_000, async () => { runs++; return 'recovered'; });
  assert.equal(ok.value, 'recovered');
  assert.equal(runs, 2);
});

test('cache hits are counted separately from calls', async () => {
  clearCache();
  const before = budgetSnapshot();
  noteSaved(2);
  const after = budgetSnapshot();
  assert.equal(after.saved, before.saved + 2);
  assert.equal(after.cacheHits, before.cacheHits + 2);
  assert.equal(after.spent, before.spent, 'a cache hit costs nothing');
});
