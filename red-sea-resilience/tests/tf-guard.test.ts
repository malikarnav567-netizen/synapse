/**
 * The two promises the console makes about money and provenance:
 *  - dummy mode never spends a token and never calls the proxy;
 *  - an exhausted hourly budget degrades to the local model instead of billing.
 * Both are enforced before `fetch` is reached, which is what these tests check.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { search, TFError } from '../src/lib/tf';
import { setMode } from '../src/lib/mode';
import { budgetSnapshot, charge } from '../src/lib/budget';

let calls = 0;
const stub = () => {
  calls = 0;
  (globalThis as any).fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  };
};

test('dummy mode refuses to search and never reaches the network', async () => {
  stub();
  setMode('dummy');
  await assert.rejects(() => search('red sea advisory'), (e: any) => e instanceof TFError && e.status === 451);
  assert.equal(calls, 0, 'dummy mode must not call the proxy');
  setMode('live');
});

test('once the hourly cap is spent, search degrades without a request', async () => {
  stub();
  setMode('live');
  while (charge()) { /* burn the remaining allowance */ }
  const spentBefore = budgetSnapshot().spent;
  await assert.rejects(() => search('red sea advisory'), (e: any) => e instanceof TFError && e.status === 429);
  assert.equal(calls, 0, 'budget exhaustion must be enforced locally');
  assert.equal(budgetSnapshot().spent, spentBefore, 'a refused call does not consume budget');
});
