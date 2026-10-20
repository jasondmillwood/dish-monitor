import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { orderDishes } from '../client/src/App.tsx';

const d = (slot: string) => ({ slot } as any);
test('cards follow config order and only configured slots', () => {
  const cfg: any = { dishes: [{ slot: 'b' }, { slot: 'a' }] };
  assert.deepEqual(orderDishes(cfg, { dishes: [d('a'), d('b'), d('zz')] } as any).map((x) => x.slot), ['b', 'a']);
  assert.deepEqual(orderDishes({ dishes: [{ slot: 'a' }] } as any, { dishes: [d('a')] } as any).map((x) => x.slot), ['a']);
  assert.deepEqual(orderDishes(null, null), []);
});
test('neutral theme: no wordmark, no web fonts', () => {
  const html = fs.readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../client/src/App.tsx', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../client/src/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(html + app + css, /STAR(?:LINK)|fonts\.googleapis|fonts\.gstatic|Barlow|IBM Plex/);
});
