import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { freePort, ROOT, sleep } from './helpers/server.js';
const { startPythonProxy, setListenPort, pythonAvailable } = await import('../server/ifaceProxy.js');

async function echoServer(): Promise<{ port: number; close: () => void }> {
  const s = net.createServer((c) => c.pipe(c));
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { port: (s.address() as net.AddressInfo).port, close: () => s.close() };
}
async function roundTrip(port: number, msg = 'ping'): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try {
      return await new Promise<string>((res, rej) => {
        const c = net.connect(port, '127.0.0.1', () => c.write(msg));
        c.on('data', (d) => { res(String(d)); c.destroy(); }); c.on('error', rej);
      });
    } catch { await sleep(100); }
  }
  throw new Error('no round trip');
}

test('python helper (item 1): restarted with backoff after it exits', async () => {
  const crash = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-py-')), 'crash.py');
  fs.writeFileSync(crash, 'import time,sys\ntime.sleep(0.1)\nsys.exit(3)\n');
  setListenPort('t1', await freePort());
  const h = startPythonProxy('t1', '127.0.0.1:1', 'lo', undefined, { script: crash, backoffMs: 50, maxBackoffMs: 100, maxQuickCrashes: 100 });
  await sleep(1500);
  h.stop();
  assert.equal(h.mode, 'python-iface');
  assert.ok((h.restarts ?? 0) >= 3, `restarts=${h.restarts}`);
  const r = h.restarts; await sleep(400); assert.equal(h.restarts, r, 'no restarts after stop()');
});

test('python helper: keeps crashing -> falls back to the Node proxy on the same port', async () => {
  const echo = await echoServer();
  const crash = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-py-')), 'crash.py');
  fs.writeFileSync(crash, 'import sys\nsys.exit(1)\n');
  const port = await freePort(); setListenPort('t2', port);
  const h = startPythonProxy('t2', `127.0.0.1:${echo.port}`, 'lo', '127.0.0.1', { script: crash, backoffMs: 20, maxBackoffMs: 40, maxQuickCrashes: 3 });
  await sleep(800);
  assert.equal(h.mode, 'node-localAddress'); assert.equal(h.grpcTarget, `127.0.0.1:${port}`);
  assert.equal(await roundTrip(port), 'ping');
  h.stop(); echo.close();
});

test('python missing -> immediate Node fallback (spawn ENOENT is async, so checked up front)', async () => {
  const echo = await echoServer();
  const port = await freePort(); setListenPort('t3', port);
  assert.equal(pythonAvailable('/nonexistent/python3'), false);
  const h = startPythonProxy('t3', `127.0.0.1:${echo.port}`, 'lo', undefined, { python: '/nonexistent/python3' });
  assert.equal(h.mode, 'node-localAddress');
  assert.equal(await roundTrip(port, 'hi'), 'hi');
  h.stop(); echo.close();
});

test('iface_proxy.py: forwards TCP to the target (local-address bind) and exits on SIGTERM', async (t) => {
  if (!pythonAvailable()) return t.skip('python3 not installed');
  const echo = await echoServer();
  const port = await freePort();
  const p = spawn('python3', [path.join(ROOT, 'scripts/iface_proxy.py'), '--listen', `127.0.0.1:${port}`, '--target', `127.0.0.1:${echo.port}`, '--local-address', '127.0.0.1'], { stdio: 'ignore' });
  try {
    assert.equal(await roundTrip(port, 'abc'), 'abc');
    assert.equal(await roundTrip(port, 'second'), 'second');
  } finally {
    const exited = new Promise((r) => p.once('exit', r)); p.kill('SIGTERM'); await exited; echo.close();
  }
});

test('iface_proxy.py: target down -> client closed, proxy stays up', async (t) => {
  if (!pythonAvailable()) return t.skip('python3 not installed');
  const port = await freePort(), dead = await freePort();
  const p = spawn('python3', [path.join(ROOT, 'scripts/iface_proxy.py'), '--listen', `127.0.0.1:${port}`, '--target', `127.0.0.1:${dead}`], { stdio: 'ignore' });
  try {
    await sleep(500);
    await new Promise<void>((res) => { const c = net.connect(port, '127.0.0.1'); c.on('close', () => res()); c.on('error', () => {}); });
    assert.equal(p.exitCode, null, 'proxy still running');
  } finally { p.kill('SIGTERM'); }
});
