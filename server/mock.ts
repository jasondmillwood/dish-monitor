import type { RawDishStatus } from './dishClient.js';

function wave(t: number, mid: number, amp: number, periodSec: number, phase = 0): number {
  return mid + amp * Math.sin((2 * Math.PI * t) / periodSec + phase);
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export function mockDish(index: number, isMini = index > 0, t = Date.now() / 1000): RawDishStatus {
  const sparkline = [];
  for (let i = 59; i >= 0; i--) {
    const tt = t - i;
    sparkline.push({
      t: tt * 1000,
      downMbps: clamp(wave(tt, isMini ? 85 : 220, isMini ? 25 : 60, isMini ? 17 : 23, 0.4), 5, 400),
      upMbps: clamp(wave(tt, isMini ? 12 : 28, isMini ? 4 : 8, isMini ? 13 : 19, 1.1), 1, 80),
      pingMs: clamp(wave(tt, isMini ? 38 : 28, isMini ? 10 : 8, 11, 2.2), 12, 120),
    });
  }
  const last = sparkline[sparkline.length - 1];
  return {
    deviceId: `ut00000000-00000000-mock${index + 1}`,
    hardwareVersion: isMini ? 'Mini.2' : 'rev4_proto3',
    softwareVersion: isMini ? '2026.03.15.mr12345' : '2026.03.15.mr12345',
    state: 'CONNECTED',
    downMbps: last.downMbps,
    upMbps: last.upMbps,
    pingMs: last.pingMs,
    dropRate: clamp(wave(t, 0.01, 0.015, 31, isMini ? 0.7 : 0), 0, 0.08),
    snrAboveNoiseFloor: true,
    obstructionPct: clamp(wave(t, isMini ? 1.2 : 0.4, 0.8, 47), 0, 8),
    currentlyObstructed: false,
    uptimeSeconds: Math.floor(t % 1_000_000) + (isMini ? 40_000 : 120_000),
    sparkline,
  };
}

/** MOCK_HISTORY=1 test aid: a small dish_get_history-shaped message (counts calls). */
export let mockHistoryCalls = 0;
export async function mockHistory(_target: string, _timeoutMs: number): Promise<any> {
  mockHistoryCalls++;
  const n = 120;
  return {
    current: String(1000 + mockHistoryCalls * 30),
    pop_ping_drop_rate: Array.from({ length: n }, () => 0),
    pop_ping_latency_ms: Array.from({ length: n }, (_, i) => 30 + (i % 7)),
    downlink_throughput_bps: Array.from({ length: n }, (_, i) => 1e8 + i * 1e5),
    uplink_throughput_bps: Array.from({ length: n }, () => 1e7),
  };
}
