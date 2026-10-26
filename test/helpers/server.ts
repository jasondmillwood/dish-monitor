import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

export const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

export async function freePort(): Promise<number> {
  return new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
}

export interface Srv { base: string; port: number; child: ChildProcess; out: () => string; tmp: string; stop: () => Promise<void> }

/** Start the built server (node dist/server/index.js) or tsx source. */
export async function startServer(cfg: object, env: Record<string, string> = {}, opts: { dist?: boolean } = {}): Promise<Srv> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-srv-'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(cfg));
  const port = await freePort();
  const args = opts.dist ? ['dist/server/index.js'] : ['--import', 'tsx', 'server/index.ts'];
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CONFIG_PATH: path.join(tmp, 'config.json'), DATA_DIR: path.join(tmp, 'data'), PROXY_BASE_PORT: String(await freePort()), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', (b) => (out += b)); child.stderr!.on('data', (b) => (out += b));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  return { base, port, child, out: () => out, tmp, stop: () => new Promise((r) => { if (child.exitCode !== null) return r(); child.once('exit', () => r()); child.kill('SIGTERM'); }) };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** HTTP GET from a chosen loopback source address (to simulate distinct clients, e.g. 127.0.0.5 = "Loki"). */
export function getFrom(src: string, port: number, p: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, any>; body: any }> {
  return new Promise((resolve, reject) => {
    import('node:http').then(({ request }) => {
      const req = request({ host: '127.0.0.1', port, path: p, localAddress: src, headers }, (res) => {
        let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let b: any = d; try { b = JSON.parse(d); } catch {} resolve({ status: res.statusCode!, headers: res.headers, body: b }); });
      });
      req.on('error', reject); req.end();
    });
  });
}
