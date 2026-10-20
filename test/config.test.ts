import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeConfig, resolveMode, ConfigError } from '../server/config.js';

const one = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
const two = JSON.parse(fs.readFileSync(new URL('../config.two-dish.example.json', import.meta.url), 'utf8'));

test('empty config -> one default dish, single mode', () => {
  const c = normalizeConfig({}, {});
  assert.equal(c.dishes.length, 1);
  assert.equal(c.dishes[0].slot, 'dish1');
  assert.equal(c.title, 'Dish Monitor');
  assert.equal(resolveMode(c), 'single');
});

test('1-dish example: single mode even if mode=dual', () => {
  const c = normalizeConfig({ ...one, mode: 'dual' }, {});
  assert.equal(c.dishes.length, 1);
  assert.equal(resolveMode(c), 'single');
});

test('2-dish example with interfaces -> dual', () => {
  const c = normalizeConfig(two, {});
  assert.deepEqual(c.dishes.map((d) => d.slot), ['roof', 'mini']);
  assert.equal(resolveMode(c), 'dual');
});

test('2 dishes without interfaces -> single-NIC fallback', () => {
  const c = normalizeConfig({ dishes: [{ slot: 'a' }, { slot: 'b' }] as any }, {});
  assert.equal(resolveMode(c), 'single');
});

test('env overrides per dish index', () => {
  const c = normalizeConfig({ dishes: [{ slot: 'a' }, { slot: 'b' }] as any }, { DISH1_IFACE: 'eth9', DISH2_IFACE: 'eth8' });
  assert.equal(c.dishes[1].interface, 'eth8');
  assert.equal(resolveMode(c), 'dual');
});

test('rejects 3 dishes, duplicate or unsafe slots, bad mode', () => {
  assert.throws(() => normalizeConfig({ dishes: [{}, {}, {}] as any }, {}), ConfigError);
  assert.throws(() => normalizeConfig({ dishes: [{ slot: 'x' }, { slot: 'x' }] as any }, {}), ConfigError);
  assert.throws(() => normalizeConfig({ dishes: [{ slot: '../etc' }] as any }, {}), ConfigError);
  assert.throws(() => normalizeConfig({ mode: 'both' as any }, {}), ConfigError);
});
