import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-data-'));
const { normalizeConfig } = await import('../server/config.js');
const { DishStore } = await import('../server/store.js');
const { resolveSlot } = await import('../server/poller.js');
const { mockDish } = await import('../server/mock.js');

test('1 dish: every reply maps to the only slot', () => {
  const cfg = normalizeConfig({ dishes: [{ slot: 'solo', label: 'Solo' }] as any }, {});
  const store = new DishStore(cfg.dishes);
  assert.equal(resolveSlot(store, cfg, mockDish(0, true)), 'solo');
  assert.equal(store.snapshot({ mock: false, mode: 'single', pollIntervalMs: 1, dishAddress: '' }).dishes.length, 1);
});

test('2 dishes, single NIC: maps by kind, pinned id, then seen id', () => {
  const cfg = normalizeConfig({ dishes: [
    { slot: 'roof', kind: 'standard' }, { slot: 'van', kind: 'mini', deviceId: 'ut-pinned' }] as any }, {});
  const store = new DishStore(cfg.dishes);
  assert.equal(resolveSlot(store, cfg, mockDish(0, false)), 'roof');
  assert.equal(resolveSlot(store, cfg, mockDish(1, true)), 'van');
  assert.equal(resolveSlot(store, cfg, { ...mockDish(0, false), deviceId: 'ut-pinned' }), 'van');
  store.markLive('roof', { deviceId: 'ut-seen' });
  assert.equal(resolveSlot(store, cfg, { ...mockDish(1, true), deviceId: 'ut-seen' }), 'roof');
  const snap = store.snapshot({ mock: false, mode: 'single', pollIntervalMs: 1, dishAddress: '' });
  assert.deepEqual(snap.dishes.map((d) => d.slot), ['roof', 'van']);
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR!, 'roof.json')));
});
