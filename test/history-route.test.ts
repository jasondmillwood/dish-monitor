import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, getFrom, sleep } from './helpers/server.js';
import { startFakeDish } from './helpers/fakeDish.js';

const LOKI = '127.0.0.5';     // stands in for the home hub poller
const LAN = '127.0.0.9';      // another LAN device
const ABUSER = '127.0.0.66';

test('item 3: no CORS headers, preflight not answered', async () => {
  const s = await startServer({ dishes: [{ slot: 'solo', label: 'Roof' }] }, { MOCK: '1', POLL_MS: '200' });
  try {
    const r = await fetch(s.base + '/api/config', { headers: { Origin: 'http://evil.example' } });
    assert.equal(r.status, 200, 'plain GET still works (LAN, hub)');
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    const pre = await fetch(s.base + '/api/dish/solo/history', { method: 'OPTIONS', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'GET' } });
    assert.notEqual(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), null);
  } finally { await s.stop(); }
});

test('history away path: unreachable dish -> 503 {away:true}, status STALE/UNKNOWN, 404 unknown dish', async () => {
  const s = await startServer({ pollIntervalMs: 500, dishes: [{ slot: 'home', label: 'Home', address: '127.0.0.1:9' }] });
  try {
    await sleep(800);
    const h = await getFrom(LOKI, s.port, '/api/dish/home/history');
    assert.equal(h.status, 503); assert.equal(h.body.away, true); assert.ok(h.body.error);
    const h2 = await getFrom(LOKI, s.port, '/api/dish/home/history');
    assert.equal(h2.status, 503, 'still away (served from error cache)');
    assert.equal((await getFrom(LOKI, s.port, '/api/dish/nope/history')).status, 404);
    const st = await getFrom(LOKI, s.port, '/api/status');
    assert.notEqual(st.body.dishes[0].freshness, 'LIVE');
  } finally { await s.stop(); }
});

test('fake dish end-to-end (built JS, item 5): LIVE status, cached history, sparkline every 30 s not every poll', async () => {
  const home = await startFakeDish('ut-home', 'rev4_proto3');
  const mini = await startFakeDish('ut-mini', 'mini1_prod1');
  const s = await startServer({ pollIntervalMs: 300, mode: 'dual', dishes: [
    { slot: 'home', label: 'Home', address: `127.0.0.1:${home.port}` }, { slot: 'mini', label: 'Mini', kind: 'mini', address: `127.0.0.1:${mini.port}` }] },
    { HISTORY_POLL_MS: '30000' }, { dist: true });
  try {
    await sleep(2000);
    const st = await getFrom(LAN, s.port, '/api/status');
    assert.deepEqual(st.body.dishes.map((d: any) => d.freshness), ['LIVE', 'LIVE']);
    assert.equal(st.body.dishes[0].downMbps, 150); assert.equal(st.body.dishes[1].deviceId, 'ut-mini');
    assert.equal(st.body.dishes[0].sparkline.length, 60);
    assert.ok(home.calls.status >= 5, `status calls ${home.calls.status}`);
    assert.equal(home.calls.history, 1, 'one get_history in 2 s (old code: one per poll)');
    const h = await getFrom(LOKI, s.port, '/api/dish/home/history');
    assert.equal(h.status, 200); assert.equal(h.body.dish, 'home'); assert.equal(h.body.history.pop_ping_drop_rate.length, 900);
    assert.equal(h.body.cached, true, 'route reuses the poller fetch (<10 s old)');
    assert.ok(Math.abs(Date.now() - h.body.fetchedAt) < 10_000);
    assert.equal(home.calls.history, 1);
    assert.equal((await getFrom(LAN, s.port, '/')).status, 200, 'UI served from dist/client');
  } finally { await s.stop(); await home.close(); await mini.close(); }
});

test('item 3 rate limit: simulated Loki poller (time-scaled 1:20) never limited; abuser gets 429; dish sees bounded get_history', async () => {
  const dish = await startFakeDish();
  // Scaled 1:20: 60 s window -> 3 s, 10 s upstream interval -> 500 ms, Loki every 5 s -> 250 ms. Max stays 30/window.
  const s = await startServer({ pollIntervalMs: 1000, dishes: [{ slot: 'home', label: 'Home', address: `127.0.0.1:${dish.port}` }] },
    { HISTORY_RATE_WINDOW_MS: '3000', HISTORY_MIN_INTERVAL_MS: '500', HISTORY_POLL_MS: '600000' });
  try {
    const codes: number[] = [];
    const loki = (async () => { for (let i = 0; i < 40; i++) { codes.push((await getFrom(LOKI, s.port, '/api/dish/home/history')).status); await sleep(250); } })();
    await sleep(300);
    const burst = await Promise.all(Array.from({ length: 60 }, () => getFrom(ABUSER, s.port, '/api/dish/home/history')));
    const lan = await getFrom(LAN, s.port, '/api/dish/home/history');
    await loki;
    assert.ok(codes.every((c) => c === 200), `Loki codes: ${codes.join(',')}`);
    assert.equal(lan.status, 200, 'other LAN client unaffected');
    const n429 = burst.filter((r) => r.status === 429).length;
    assert.equal(n429, 30, 'abuser capped at 30/window');
    assert.ok(burst.find((r) => r.status === 429)!.headers['retry-after']);
    // ~10.5 s of scaled time at <=1 upstream/500 ms -> <= ~22 upstream calls, despite 100+ requests
    assert.ok(dish.calls.history <= 25, `dish get_history calls: ${dish.calls.history}`);
  } finally { await s.stop(); await dish.close(); }
});

test('logging: no per-request or per-poll info lines', async () => {
  const dish = await startFakeDish();
  const s = await startServer({ pollIntervalMs: 200, dishes: [{ slot: 'home', label: 'Home', address: `127.0.0.1:${dish.port}` }] });
  try {
    for (let i = 0; i < 20; i++) await getFrom(LOKI, s.port, '/api/status');
    await sleep(1500);
    const lines = s.out().trim().split('\n');
    assert.ok(!/incoming request|request completed/.test(s.out()), 'no fastify request logs');
    assert.ok(lines.length <= 4, `startup lines only, got ${lines.length}:\n${s.out()}`);
  } finally { await s.stop(); await dish.close(); }
});

test('item 9: all-zero CONNECTED dish -> schemaSuspect + one warning line', async () => {
  const dish = await startFakeDish(); dish.zeroMetrics = true;
  const s = await startServer({ pollIntervalMs: 200, dishes: [{ slot: 'home', label: 'Home', address: `127.0.0.1:${dish.port}` }] });
  try {
    await sleep(1200);
    const st = await getFrom(LOKI, s.port, '/api/status');
    assert.equal(st.body.dishes[0].schemaSuspect, true);
    assert.equal((s.out().match(/schemaSuspect/g) || []).length, 1, 'warned once, not every poll');
  } finally { await s.stop(); await dish.close(); }
});
