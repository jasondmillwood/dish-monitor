import { test } from 'node:test';
import assert from 'node:assert/strict';
const { HistoryCache, RateLimiter } = await import('../server/historyCache.js');

test('HistoryCache: TTL, coalescing, error TTL', async () => {
  let t = 0, calls = 0, fail = false;
  const c = new HistoryCache(async () => { calls++; await new Promise((r) => setTimeout(r, 20)); if (fail) throw new Error('away'); return { n: calls }; }, 10_000, () => t);
  const [a, b, d] = await Promise.all([c.get('home', 'x', 30_000, 1), c.get('home', 'x', 30_000, 1), c.get('home', 'x', 30_000, 1)]);
  assert.equal(calls, 1, '3 concurrent callers -> 1 upstream fetch'); assert.deepEqual(a.history, { n: 1 }); assert.equal(b.history, d.history);
  t = 29_000; assert.equal((await c.get('home', 'x', 30_000, 1)).cached, true); assert.equal(calls, 1);
  t = 30_001; assert.equal((await c.get('home', 'x', 30_000, 1)).cached, false); assert.equal(calls, 2);
  fail = true; t = 70_000;
  await assert.rejects(c.get('home', 'x', 30_000, 1), /away/); assert.equal(calls, 3);
  t = 75_000; await assert.rejects(c.get('home', 'x', 30_000, 1), /away/); assert.equal(calls, 3, 'away dish not re-asked within error TTL');
  assert.ok(c.peek('home'), 'last good copy kept for the sparkline');
  fail = false; t = 81_000; assert.deepEqual((await c.get('home', 'x', 30_000, 1)).history, { n: 4 });
  assert.equal(c.upstreamCalls('mini'), 0);
});

test('RateLimiter: fixed window per key', () => {
  let t = 0; const r = new RateLimiter(3, 1000, () => t);
  assert.equal(r.take('a'), 0); assert.equal(r.take('a'), 0); assert.equal(r.take('a'), 0);
  assert.ok(r.take('a') > 0); assert.equal(r.take('b'), 0);
  t = 1000; assert.equal(r.take('a'), 0);
});
