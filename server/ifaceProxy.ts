import net from 'node:net';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { DishConfig } from './config.js';
import type { DishSlot } from './types.js';
import { ROOT } from './root.js';
import { log } from './log.js';

const PY_PROXY = process.env.IFACE_PROXY_SCRIPT || path.join(ROOT, 'scripts/iface_proxy.py');
const PYTHON = process.env.DISH_PYTHON || 'python3';

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
  /** Python helper restarts so far (supervised handles only). */
  restarts?: number;
}

/** True if `bin` runs (`bin --version` exits 0). Checked synchronously: an ENOENT from spawn() is async. */
export function pythonAvailable(bin = PYTHON): boolean {
  try {
    const r = spawnSync(bin, ['--version'], { stdio: 'ignore', timeout: 5000 });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
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
      log.debug(`[proxy:${slot}] upstream error:`, err.message);
      client.destroy();
    });
    client.on('error', () => upstream.destroy());
  });

  server.listen(listenPort, '127.0.0.1');
  server.on('error', (err) => log.warn(`[proxy:${slot}] node proxy listen error:`, (err as Error).message));
  server.on('listening', () => {
    log.info(
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

export interface SuperviseOpts {
  python?: string;
  script?: string;
  /** First restart delay; doubles per quick crash up to maxBackoffMs. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** A run that lasted this long resets the backoff/crash counter. */
  healthyMs?: number;
  /** This many consecutive quick crashes -> give up on python and switch to the Node proxy. */
  maxQuickCrashes?: number;
  /** Called to start the Node fallback on the same listen port. */
  fallback?: () => ProxyHandle;
}

/**
 * Supervised Python SO_BINDTODEVICE helper. Restarts it with backoff whenever it exits (unless stopped);
 * if python is missing (spawn ENOENT) or it keeps crashing, falls back to the Node localAddress proxy so the
 * handle keeps serving the same 127.0.0.1:port. The returned handle object is mutated in place (mode, restarts).
 */
export function startPythonProxy(
  slot: DishSlot,
  target: string,
  iface?: string,
  localAddress?: string,
  opts: SuperviseOpts = {},
): ProxyHandle {
  const listenPort = LISTEN_PORTS[slot];
  const python = opts.python ?? PYTHON;
  const script = opts.script ?? PY_PROXY;
  const base = opts.backoffMs ?? 1000;
  const maxB = opts.maxBackoffMs ?? 30_000;
  const healthyMs = opts.healthyMs ?? 60_000;
  const maxQuick = opts.maxQuickCrashes ?? 8;
  const args = [script, '--listen', `127.0.0.1:${listenPort}`, '--target', target];
  if (iface) args.push('--interface', iface);
  if (localAddress) args.push('--local-address', localAddress);

  let child: ChildProcess | null = null;
  let stopped = false;
  let quick = 0;
  let timer: NodeJS.Timeout | null = null;
  let fallbackHandle: ProxyHandle | null = null;

  const handle: ProxyHandle = {
    slot,
    listenHost: '127.0.0.1',
    listenPort,
    grpcTarget: `127.0.0.1:${listenPort}`,
    mode: 'python-iface',
    restarts: 0,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      child?.kill('SIGTERM');
      fallbackHandle?.stop();
    },
  };

  const toFallback = (why: string) => {
    if (stopped || fallbackHandle) return;
    log.warn(`[proxy:${slot}] python helper ${why}; falling back to the Node proxy (localAddress bind)`);
    const fb = opts.fallback ?? (() => {
      const { host, port } = parseAddr(target);
      return startNodeProxy(slot, host, port, localAddress);
    });
    fallbackHandle = fb();
    handle.mode = fallbackHandle.mode;
    handle.grpcTarget = fallbackHandle.grpcTarget;
  };

  const launch = () => {
    if (stopped) return;
    const startedAt = Date.now();
    let spawnFailed = false;
    const c = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child = c;
    c.stdout?.on('data', (b) => process.stdout.write(String(b)));
    c.stderr?.on('data', (b) => process.stderr.write(String(b)));
    c.on('error', (err: NodeJS.ErrnoException) => {
      spawnFailed = true;
      if (err.code === 'ENOENT' || err.code === 'EACCES') toFallback(`could not start (${python}: ${err.code})`);
      else log.warn(`[proxy:${slot}] python helper error: ${err.message}`);
    });
    c.on('exit', (code, signal) => {
      if (child === c) child = null;
      if (stopped || spawnFailed || fallbackHandle) return;
      quick = Date.now() - startedAt >= healthyMs ? 1 : quick + 1;
      if (quick >= maxQuick) return toFallback(`crashed ${quick} times in a row (last code=${code} signal=${signal})`);
      const delay = Math.min(maxB, base * 2 ** (quick - 1));
      log.warn(`[proxy:${slot}] python helper exited code=${code} signal=${signal}; restart #${(handle.restarts ?? 0) + 1} in ${delay}ms`);
      timer = setTimeout(() => { timer = null; handle.restarts = (handle.restarts ?? 0) + 1; launch(); }, delay);
    });
  };

  if (!pythonAvailable(python)) toFallback(`not found (${python})`);
  else launch();
  return handle;
}

/** Test hook: set the listen port for a slot without starting every proxy. */
export function setListenPort(slot: DishSlot, port: number) { LISTEN_PORTS[slot] = port; }
export { startNodeProxy };

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
        log.warn(`[proxy:${d.slot}] python proxy failed, falling back to node:`, err);
      }
    }

    const { host, port } = parseAddr(d.address);
    map.set(d.slot, startNodeProxy(d.slot, host, port, local || undefined));
  }
  return map;
}
