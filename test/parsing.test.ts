import { test } from 'node:test';
import assert from 'node:assert/strict';
const { parseStatus, deriveState, extractSparkline, isSchemaSuspect } = await import('../server/dishClient.js');

test('parseStatus: units, defaults and obstruction %', () => {
  const m = parseStatus({ device_info: { id: 'ut1', hardware_version: 'mini1' }, downlink_throughput_bps: 125e6, uplink_throughput_bps: '15000000',
    pop_ping_latency_ms: 28.5, pop_ping_drop_rate: 0.02, obstruction_stats: { fraction_obstructed: 0.031 }, device_state: { uptime_s: '42' } });
  assert.equal(m.deviceId, 'ut1'); assert.equal(m.downMbps, 125); assert.equal(m.upMbps, 15); assert.equal(m.pingMs, 28.5);
  assert.ok(Math.abs(m.obstructionPct - 3.1) < 1e-9); assert.equal(m.uptimeSeconds, 42); assert.equal(m.state, 'CONNECTED'); assert.equal(m.schemaSuspect, false);
  const e = parseStatus({});
  assert.equal(e.deviceId, null); assert.equal(e.downMbps, 0); assert.equal(e.pingMs, 0);
  assert.equal(parseStatus({ pop_ping_latency_ms: 'garbage' }).pingMs, 0);
});

test('deriveState: string, numeric, unknown enum, NO_SCHEDULE', () => {
  assert.equal(deriveState({}), 'CONNECTED');
  assert.equal(deriveState({ outage: { cause: 'OBSTRUCTED' } }), 'OBSTRUCTED');
  assert.equal(deriveState({ outage: { cause: 'NO_SCHEDULE' } }), 'SEARCHING');
  assert.equal(deriveState({ outage: { cause: 6 } }), 'OBSTRUCTED');
  assert.equal(deriveState({ outage: { cause: 99 } }), 'OUTAGE_99');
});

test('extractSparkline: last 60 points, drop>=1 -> ping 0, timestamps anchored at fetch time', () => {
  const n = 900, now = 1_000_000;
  const h = { downlink_throughput_bps: Array.from({ length: n }, (_, i) => i * 1e6), uplink_throughput_bps: Array(n).fill(2e6),
    pop_ping_latency_ms: Array(n).fill(40), pop_ping_drop_rate: Array.from({ length: n }, (_, i) => (i === n - 1 ? 1 : 0)) };
  const s = extractSparkline(h, 60, now);
  assert.equal(s.length, 60); assert.equal(s[59].t, now); assert.equal(s[0].t, now - 59_000);
  assert.equal(s[59].downMbps, n - 1); assert.equal(s[59].pingMs, 0); assert.equal(s[58].pingMs, 40);
  assert.deepEqual(extractSparkline({}), []);
});

test('schemaSuspect (item 9): CONNECTED with all-zero metrics', () => {
  assert.equal(parseStatus({ device_info: { id: 'x' } }).schemaSuspect, true);
  assert.equal(parseStatus({ outage: { cause: 'BOOTING' } }).schemaSuspect, false); // not connected: zeros are expected
  assert.equal(isSchemaSuspect({ state: 'CONNECTED', downMbps: 0, upMbps: 0, pingMs: 25, uptimeSeconds: 0 }), false);
});
