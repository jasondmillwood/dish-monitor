import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DishConfig } from './config.js';
import type { DishSlot } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PY_PROXY = path.resolve(__dirname, '../scripts/iface_proxy.py');

const BASE_PORT = Number(process.env.PROXY_BASE_PORT || 19001);
const LISTEN_PORTS: Record<DishSlot, number> = {};

export interface ProxyHandle {
  slot: DishSlot;
  listenHost: string;
  listenPort: number;
  /** gRPC target for the client (127.0.0.1:port when proxied, else dish address). */
  grpcTarget: string;
  mode: 'python-iface' | 'node-localAddress' | 'direct';
  stop: () => void;
}

function pipeSockets(a: net.Socket, b: net.Socket) {
  a.pipe(b);
  b.pipe(a);
  const close = () => {
    a.destroy();
    b.destroy();
  };
  a.on('error', close);
  b.on('error', close);
  a.on('close', close);
  b.on('close', close);
}

/** Pure Node TCP proxy using source IP bind (cross-platform; needs correct routes). */
function startNodeProxy(
  slot: DishSlot,
  dishHost: string,
  dishPort: number,
  localAddress?: string,
): ProxyHandle {
  const listenPort = LISTEN_PORTS[slot];
  const server = net.createServer((client) => {
    const upstream = net.connect({
      host: dishHost,
      port: dishPort,
      localAddress: localAddress || undefined,
    });
    upstream.on('connect', () => pipeSockets(client, upstream));
    upstream.on('error', (err) => {
      console.warn(`[proxy:${slot}] upstream error:`, err.message);
      client.destroy();
    });
    client.on('error', () => upstream.destroy());
  });

  server.listen(listenPort, '127.0.0.1');
  server.on('listening', () => {
    console.log(
      `[proxy:${slot}] node 127.0.0.1:${listenPort} -> ${dishHost}:${dishPort}` +
        (localAddress ? ` localAddress=${localAddress}` : ''),
    );
  });

  return {
    slot,
    listenHost: '127.0.0.1',
    listenPort,
    grpcTarget: `127.0.0.1:${listenPort}`,
    mode: 'node-localAddress',
    stop: () => {
      server.close();
    },
  };
}

function startPythonProxy(
  slot: DishSlot,
  target: string,
  iface?: string,
  localAddress?: string,
): ProxyHandle {
  const listenPort = LISTEN_PORTS[slot];
  const args = [
    PY_PROXY,
    '--listen',
    `127.0.0.1:${listenPort}`,
    '--target',
    target,
  ];
  if (iface) args.push('--interface', iface);
  if (localAddress) args.push('--local-address', localAddress);

  const child: ChildProcess = spawn('python3', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (b) => process.stdout.write(String(b)));
  child.stderr?.on('data', (b) => process.stderr.write(String(b)));
  child.on('exit', (code) => {
    console.warn(`[proxy:${slot}] python proxy exited code=${code}`);
  });

  return {
    slot,
    listenHost: '127.0.0.1',
    listenPort,
    grpcTarget: `127.0.0.1:${listenPort}`,
    mode: 'python-iface',
    stop: () => {
      child.kill('SIGTERM');
    },
  };
}

function parseAddr(address: string): { host: string; port: number } {
  const [host, portStr] = address.split(':');
  return { host, port: Number(portStr || 9200) };
}

/**
 * Start per-dish proxies when interface and/or localAddress is configured.
 * Prefer Python SO_BINDTODEVICE when an interface name is set (Linux).
 * Fall back to Node localAddress bind. If neither bind option is set, return direct target.
 */
export function startDishProxies(dishes: DishConfig[]): Map<DishSlot, ProxyHandle> {
  const map = new Map<DishSlot, ProxyHandle>();
  dishes.forEach((d, i) => (LISTEN_PORTS[d.slot] = BASE_PORT + i));
  for (const d of dishes) {
    const iface = d.interface?.trim() || '';
    const local = d.localAddress?.trim() || '';
    if (!iface && !local) {
      map.set(d.slot, {
        slot: d.slot,
        listenHost: '',
        listenPort: 0,
        grpcTarget: d.address,
        mode: 'direct',
        stop: () => {},
      });
      continue;
    }

    // Prefer python iface proxy when interface is named (best for same-IP dual path on Linux).
    if (iface) {
      try {
        map.set(d.slot, startPythonProxy(d.slot, d.address, iface, local || undefined));
        continue;
      } catch (err) {
        console.warn(`[proxy:${d.slot}] python proxy failed, falling back to node:`, err);
      }
    }

    const { host, port } = parseAddr(d.address);
    map.set(d.slot, startNodeProxy(d.slot, host, port, local || undefined));
  }
  return map;
}
