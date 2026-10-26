// Fake Starlink dish: a real gRPC server speaking proto/device.proto Handle(get_status|get_history).
import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

export interface FakeDish {
  port: number;
  calls: { status: number; history: number };
  /** ms to delay replies (simulate a half-up dish). */
  delayMs: number;
  zeroMetrics: boolean;
  close: () => Promise<void>;
}

export async function startFakeDish(id = 'ut-fake-1', hw = 'rev4_proto3'): Promise<FakeDish> {
  const def = protoLoader.loadSync(path.join(ROOT, 'proto/device.proto'), { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
  const root = grpc.loadPackageDefinition(def) as any;
  const server = new grpc.Server();
  const fd: FakeDish = { port: 0, calls: { status: 0, history: 0 }, delayMs: 0, zeroMetrics: false, close: async () => {} };
  server.addService(root.SpaceX.API.Device.Device.service, {
    Handle: (call: any, cb: any) => {
      const req = call.request;
      const reply = (r: any) => (fd.delayMs ? setTimeout(() => cb(null, r), fd.delayMs) : cb(null, r));
      if (req.get_status) {
        fd.calls.status++;
        const z = fd.zeroMetrics;
        return reply({ dish_get_status: {
          device_info: { id, hardware_version: hw, software_version: 'fw-test' },
          device_state: { uptime_s: z ? 0 : 12345 },
          downlink_throughput_bps: z ? 0 : 150e6, uplink_throughput_bps: z ? 0 : 20e6,
          pop_ping_latency_ms: z ? 0 : 31, pop_ping_drop_rate: 0, is_snr_above_noise_floor: true,
          obstruction_stats: { fraction_obstructed: 0.01, currently_obstructed: false },
        } });
      }
      if (req.get_history) {
        fd.calls.history++;
        const n = 900;
        return reply({ dish_get_history: {
          current: String(5000 + fd.calls.history),
          pop_ping_drop_rate: Array(n).fill(0), pop_ping_latency_ms: Array(n).fill(30),
          downlink_throughput_bps: Array(n).fill(1e8), uplink_throughput_bps: Array(n).fill(1e7),
        } });
      }
      cb({ code: grpc.status.UNIMPLEMENTED, message: 'nope' });
    },
  });
  fd.port = await new Promise<number>((res, rej) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  fd.close = () => new Promise((r) => server.tryShutdown(() => r()));
  return fd;
}
