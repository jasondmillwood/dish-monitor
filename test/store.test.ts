import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-store-'));
process.env.PERSIST_MS = '300';
const { DishStore } = await import('../server/store.js');
const cfgs = [{ slot: 'home', label: 'Home', address: 'x' }, { slot: 'mini', label: 'Mini', address: 'x' }] as any;

test('status file (item 7): written on change or every PERSIST_MS, not every poll', async () => {
  const s = new DishStore(cfgs);
  const fp = path.join(process.env.DATA_DIR!, 'home.json');
  s.markLive('home', { state: 'CONNECTED', deviceId: 'ut1', downMbps: 1 });
  assert.equal(s.writes, 1); assert.ok(fs.existsSync(fp));
  for (let i = 0; i < 50; i++) s.markLive('home', { state: 'CONNECTED', deviceId: 'ut1', downMbps: i });
  assert.equal(s.writes, 1, 'same state: no rewrite inside the window');
  s.markLive('home', { state: 'OBSTRUCTED', deviceId: 'ut1' });
  assert.equal(s.writes, 2, 'state change writes at once');
  await new Promise((r) => setTimeout(r, 350));
  s.markLive('home', { state: 'OBSTRUCTED', deviceId: 'ut1', downMbps: 9 });
  assert.equal(s.writes, 3, 'periodic write after PERSIST_MS');
  assert.equal(JSON.parse(fs.readFileSync(fp, 'utf8')).downMbps, 9);
  s.markLive('home', { state: 'OBSTRUCTED', deviceId: 'ut1', downMbps: 77 });
  s.flush();
  assert.equal(JSON.parse(fs.readFileSync(fp, 'utf8')).downMbps, 77, 'flush on shutdown keeps the last value');
  assert.ok(!fs.existsSync(fp + '.tmp'), 'atomic rename leaves no tmp file');
  const again = new DishStore(cfgs);
  assert.equal(again.dishes.home.freshness, 'STALE'); assert.equal(again.dishes.home.downMbps, 77);
  assert.equal(again.dishes.mini.freshness, 'UNKNOWN');
});

test('status file: corrupt file is ignored, not fatal', () => {
  fs.writeFileSync(path.join(process.env.DATA_DIR!, 'mini.json'), '{nope');
  const s = new DishStore(cfgs);
  assert.equal(s.dishes.mini.freshness, 'UNKNOWN');
});
