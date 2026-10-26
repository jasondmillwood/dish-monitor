import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import { ROOT } from './root.js';
const PROTO_PATH = path.join(ROOT, 'proto/device.proto');

const OUTAGE_CAUSE: Record<number, string> = {
  0: 'UNKNOWN',
  1: 'BOOTING',
  2: 'STOWED',
  3: 'THERMAL_SHUTDOWN',
  4: 'SEARCHING',
  5: 'NO_SATS',
  6: 'OBSTRUCTED',
  7: 'NO_DOWNLINK',
  8: 'NO_PINGS',
  9: 'ACTUATOR_ACTIVITY',
  10: 'CABLE_TEST',
  11: 'CELLING_SEARCHING',
};

export interface RawDishStatus {
  deviceId: string | null;
  hardwareVersion: string | null;
  softwareVersion: string | null;
  state: string;
  downMbps: number;
  upMbps: number;
  pingMs: number;
  dropRate: number;
  snrAboveNoiseFloor: boolean;
  obstructionPct: number;
  currentlyObstructed: boolean;
  uptimeSeconds: number;
  /** True when the dish says CONNECTED but every metric reads 0/absent (likely firmware/API field drift). */
  schemaSuspect?: boolean;
  sparkline: { t: number; downMbps: number; upMbps: number; pingMs: number }[];
}

type DeviceClient = {
  Handle: (
    request: Record<string, unknown>,
    options: { deadline: Date },
    callback: (err: grpc.ServiceError | null, response: any) => void,
  ) => void;
  close: () => void;
};

let packageDef: protoLoader.PackageDefinition | null = null;

function loadProto() {
  if (!packageDef) {
    packageDef = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
  }
  return grpc.loadPackageDefinition(packageDef) as any;
}

function bpsToMbps(bps: number | undefined | null): number {
  if (bps == null || Number.isNaN(Number(bps))) return 0;
  return Number(bps) / 1_000_000;
}

export function deriveState(status: any): string {
  if (status?.outage && (status.outage.cause !== undefined || status.outage.Cause !== undefined)) {
    const cause = status.outage.cause ?? status.outage.Cause;
    if (typeof cause === 'string') {
      return cause === 'NO_SCHEDULE' ? 'SEARCHING' : cause;
    }
    return OUTAGE_CAUSE[Number(cause)] ?? `OUTAGE_${cause}`;
  }
  return 'CONNECTED';
}

export function extractSparkline(history: any, maxPoints = 60, now = Date.now()) {
  const downs: number[] = history?.downlink_throughput_bps ?? [];
  const ups: number[] = history?.uplink_throughput_bps ?? [];
  const pings: number[] = history?.pop_ping_latency_ms ?? [];
  const drops: number[] = history?.pop_ping_drop_rate ?? [];
  const n = Math.min(downs.length, ups.length, pings.length || downs.length, maxPoints);
  const start = Math.max(0, downs.length - n);
  const points = [];
  for (let i = start; i < downs.length; i++) {
    const drop = drops[i] ?? 0;
    points.push({
      t: now - (downs.length - 1 - i) * 1000,
      downMbps: bpsToMbps(downs[i]),
      upMbps: bpsToMbps(ups[i]),
      pingMs: drop >= 1 ? 0 : Number(pings[i] ?? 0),
    });
  }
  return points;
}

/** Pure: turn a dish_get_status message into metrics (no sparkline). Exported for tests. */
export function parseStatus(status: any): Omit<RawDishStatus, 'sparkline'> {
  const info = status?.device_info ?? {};
  const obstruction = status?.obstruction_stats ?? {};
  const out = {
    deviceId: info.id ?? null,
    hardwareVersion: info.hardware_version ?? null,
    softwareVersion: info.software_version ?? null,
    state: deriveState(status),
    downMbps: bpsToMbps(status?.downlink_throughput_bps),
    upMbps: bpsToMbps(status?.uplink_throughput_bps),
    pingMs: Number(status?.pop_ping_latency_ms ?? 0) || 0,
    dropRate: Number(status?.pop_ping_drop_rate ?? 0) || 0,
    snrAboveNoiseFloor: Boolean(status?.is_snr_above_noise_floor),
    obstructionPct: (Number(obstruction.fraction_obstructed ?? 0) || 0) * 100,
    currentlyObstructed: Boolean(obstruction.currently_obstructed),
    uptimeSeconds: Number(status?.device_state?.uptime_s ?? 0) || 0,
  };
  return { ...out, schemaSuspect: isSchemaSuspect(out) };
}

/** CONNECTED, yet throughput, ping and uptime all read 0: the fields probably moved in a firmware update. */
export function isSchemaSuspect(m: Pick<RawDishStatus, 'state' | 'downMbps' | 'upMbps' | 'pingMs' | 'uptimeSeconds'>): boolean {
  return m.state === 'CONNECTED' && !m.downMbps && !m.upMbps && !m.pingMs && !m.uptimeSeconds;
}

/** One get_status call (no history: that is fetched separately and cached, see historyCache.ts). */
export async function fetchDishStatus(
  address = process.env.DISH_ADDR || '192.168.100.1:9200',
  timeoutMs = 2500,
): Promise<RawDishStatus> {
  const root = loadProto();
  const Device = root.SpaceX.API.Device.Device;
  const client: DeviceClient = new Device(address, grpc.credentials.createInsecure(), {
    'grpc.max_receive_message_length': 16 * 1024 * 1024,
  });
  try {
    const statusRes = await new Promise<any>((resolve, reject) => {
      client.Handle({ get_status: {} }, { deadline: new Date(Date.now() + timeoutMs) }, (err, res) => {
        if (err) reject(err);
        else resolve(res);
      });
    });
    const status = statusRes?.dish_get_status;
    if (!status) {
      throw new Error('No dish_get_status in response (is this a Starlink dish?)');
    }
    return { ...parseStatus(status), sparkline: [] };
  } finally {
    client.close();
  }
}

/**
 * Raw get_history for history loggers. Read-only: one Handle({get_history})
 * call through the same per-dish gRPC target the poller uses. Returns the dish_get_history message
 * (snake_case keys, uint64/int64 as strings).
 */
export async function fetchDishHistory(address: string, timeoutMs = 4000): Promise<any> {
  const root = loadProto();
  const Device = root.SpaceX.API.Device.Device;
  const client: DeviceClient = new Device(address, grpc.credentials.createInsecure(), {
    'grpc.max_receive_message_length': 16 * 1024 * 1024,
  });
  try {
    const res = await new Promise<any>((resolve, reject) => {
      client.Handle({ get_history: {} }, { deadline: new Date(Date.now() + timeoutMs) }, (err, r) => {
        if (err) reject(err);
        else resolve(r);
      });
    });
    if (!res?.dish_get_history) throw new Error('No dish_get_history in response');
    return res.dish_get_history;
  } finally {
    client.close();
  }
}

export function classifyHardware(hardwareVersion: string | null | undefined, deviceId?: string | null): 'mini' | 'home' | 'unknown' {
  const hw = (hardwareVersion || '').toLowerCase();
  const id = (deviceId || '').toLowerCase();
  if (hw.includes('mini') || id.includes('mini')) return 'mini';
  if (hw || id) return 'home';
  return 'unknown';
}
