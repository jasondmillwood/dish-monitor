import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

async function freePort(): Promise<number> {
  return new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
}

async function withServer(cfg: object, fn: (base: string) => Promise<void>) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-srv-'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(cfg));
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: ROOT, env: { ...process.env, MOCK: '1', PORT: String(port), HOST: '127.0.0.1', CONFIG_PATH: path.join(tmp, 'config.json'), DATA_DIR: path.join(tmp, 'data'), POLL_MS: '200' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    await new Promise((r) => setTimeout(r, 400));
    await fn(base);
  } finally { child.kill('SIGTERM'); }
}

const j = async (u: string) => (await fetch(u)).json() as Promise<any>;

test('server, 1 dish (mock)', async () => {
  await withServer({ title: 'Cabin', dishes: [{ slot: 'solo', label: 'Roof' }] }, async (b) => {
    const c = await j(b + '/api/config');
    assert.equal(c.title, 'Cabin');
    assert.deepEqual(c.dishes.map((d: any) => d.slot), ['solo']);
    const s = await j(b + '/api/status');
    assert.equal(s.dishes.length, 1);
    assert.equal(s.dishes[0].freshness, 'LIVE');
    assert.equal(s.dishes[0].label, 'Roof');
    assert.equal((await fetch(b + '/api/dishes/solo')).status, 200);
    assert.equal((await fetch(b + '/api/dishes/home')).status, 404);
    assert.equal((await fetch(b + '/api/dish/solo/history')).status, 503);
  });
});

test('server, 2 dishes (mock)', async () => {
  const two = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.two-dish.example.json'), 'utf8'));
  for (const d of two.dishes) d.interface = '';           // no real NICs in the test box
  await withServer(two, async (b) => {
    const s = await j(b + '/api/status');
    assert.deepEqual(s.dishes.map((d: any) => d.slot), ['roof', 'mini']);
    assert.ok(s.dishes.every((d: any) => d.freshness === 'LIVE'));
    assert.notEqual(s.dishes[0].deviceId, s.dishes[1].deviceId);
    assert.equal((await fetch(b + '/api/dishes/mini')).status, 200);
  });
});
