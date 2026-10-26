import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-pt-'));
process.env.HISTORY_POLL_MS = '1000';
const { statusTimeoutMs, startPoller } = await import('../server/poller.js');
const { normalizeConfig } = await import('../server/config.js');
const { DishStore } = await import('../server/store.js');
const { HistoryCache } = await import('../server/historyCache.js');
const { mockDish } = await import('../server/mock.js');

test('item 12: status deadline fits the poll interval', () => {
  assert.equal(statusTimeoutMs(3000, 1), 2500);
  assert.equal(statusTimeoutMs(3000, 2), 1375);
  assert.equal(statusTimeoutMs(1000, 1), 750);
  assert.ok(statusTimeoutMs(200, 2) >= 300);
});

test('item 12 + 4: hung dish never makes ticks skip; history fetched ~every HISTORY_POLL_MS, not every poll', async () => {
  const cfg = normalizeConfig({ pollIntervalMs: 400, mode: 'dual', dishes: [{ slot: 'home', interface: 'a' }, { slot: 'mini', interface: 'b', kind: 'mini' }] } as any, {});
  const store = new DishStore(cfg.dishes);
  let hist = 0;
  const history = new HistoryCache(async () => { hist++; return { downlink_throughput_bps: [1e6], uplink_throughput_bps: [1e6], pop_ping_latency_ms: [20], pop_ping_drop_rate: [0] }; });
  const proxies = new Map(cfg.dishes.map((d: any) => [d.slot, { slot: d.slot, grpcTarget: d.slot, mode: 'python-iface' } as any]));
  let statusCalls = 0;
  const fetchStatus = async (target: string, timeoutMs: number) => {
    statusCalls++;
    if (target === 'mini') { await new Promise((r) => setTimeout(r, timeoutMs)); throw new Error('DEADLINE_EXCEEDED'); }
    return mockDish(0, false);
  };
  const p = startPoller(store, cfg, proxies, { history, fetchStatus, mock: false });
  assert.ok(p.statusTimeoutMs < 400);
  await new Promise((r) => setTimeout(r, 2500));
  p.stop();
  assert.equal(p.stats().skipped, 0, 'no skipped ticks');
  assert.equal(store.dishes.home.freshness, 'LIVE');
  assert.equal(store.dishes.mini.freshness, 'UNKNOWN');
  assert.ok(store.dishes.home.sparkline.length === 1, 'sparkline from cached history');
  assert.ok(statusCalls >= 10, `statusCalls=${statusCalls}`);
  assert.ok(hist >= 2 && hist <= 4, `history fetched ${hist}x in 2.5 s at HISTORY_POLL_MS=1000 (was every 400 ms)`);
});

test('item 9: schemaSuspect flows to the store', async () => {
  const cfg = normalizeConfig({ pollIntervalMs: 1000, mode: 'dual', dishes: [{ slot: 'z', interface: 'a' }] } as any, {});
  const store = new DishStore(cfg.dishes);
  const proxies = new Map([['z', { slot: 'z', grpcTarget: 'z', mode: 'python-iface' } as any]]);
  const p = startPoller(store, cfg, proxies, { history: new HistoryCache(async () => ({})), mock: false,
    fetchStatus: async () => ({ ...mockDish(0), downMbps: 0, upMbps: 0, pingMs: 0, uptimeSeconds: 0, schemaSuspect: true }) });
  await new Promise((r) => setTimeout(r, 200)); p.stop();
  assert.equal(store.dishes.z.schemaSuspect, true);
});
