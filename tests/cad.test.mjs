import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseExchange, loadExchange, ratesToUsd } from '../scripts/exchange.mjs';
import { supplementTable, supplementalRate, priceEvent, loadSupplement } from '../scripts/pricing.mjs';

test('Bank of Canada observations use CAD per USD, with a dated offline fallback', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ai-usage-fx-')); t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const raw = { observations: [{ d: '2026-09-03', FXUSDCAD: { v: '1.38' } }, { d: '2026-09-04', FXUSDCAD: { v: '1.3840' } }] };
  assert.deepEqual(parseExchange(raw), { rate: 1.384, date: '2026-09-04' });
  assert.throws(() => parseExchange({ observations: [{ d: '2026-09-04', FXUSDCAD: { v: 'NaN' } }] }));
  const live = await loadExchange(dir, true, async () => ({ ok: true, json: async () => raw }));
  assert.equal(live.currency, 'CAD'); assert.equal(live.rate, 1.384);
  const offline = await loadExchange(dir, true, async () => { throw new Error('offline'); });
  assert.equal(offline.rate, 1.384); assert.ok(offline.warning.includes('hors ligne'));
});
test('Unavailable FX never labels USD numbers as CAD', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ai-usage-no-fx-')); t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const result = await loadExchange(dir, true, async () => { throw new Error('offline'); });
  assert.equal(result.rate, null); assert.equal(result.currency, 'USD');
  assert.deepEqual(ratesToUsd({ input: 1.4, output: 7 }, 'CAD', { rate: 1.4 }, 1.4), { input: 1, output: 5 });
  assert.throws(() => ratesToUsd({ input: 1 }, 'CAD', {}, 1.4));
});
const catalog = {
  zai: { models: { 'glm-5.2': { cost: { input: 1.4, output: 4.4, cache_read: .26, cache_write: 0 } } } },
  'zai-coding-plan': { models: { 'glm-5.2': { cost: { input: 0, output: 0 } } } },
  alternate: { models: { 'glm-5.2': { cost: { input: .1, output: .5 } } } }
};
test('Missing price completion uses the exact provider, not a cheaper unrelated route or a free subscription', () => {
  const table = supplementTable(catalog);
  const event = { tool: 'opencode', provider: 'zai-coding-plan', model: 'glm-5.2', input: 1e6, cached: 0, write: 0, output: 1e6 };
  const result = priceEvent(event, new Map(), {}, table);
  assert.ok(Math.abs(result.cost - 5.8) < 1e-12); assert.equal(result.priceSource, 'models.dev');
  assert.equal(supplementalRate({ ...event, provider: 'unknown' }, table), null);
  assert.equal(supplementalRate({ ...event, model: 'glm-5.3' }, table), null);
  assert.equal(priceEvent({ ...event, model: 'codex-auto-review' }, new Map(), {}, table).cost, null);
  assert.equal(priceEvent(event, new Map(), { 'glm-5.2': { input: 2, output: 3, cached: 0, write: 0 } }, table).cost, 5);
});
test('Supplemental prices persist and can resolve later without a network request', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ai-usage-extra-')); t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  let requests = 0;
  const fetcher = async () => { requests++; return { ok: true, json: async () => catalog }; };
  assert.equal((await loadSupplement(dir, false, fetcher)).table.size, 3); assert.equal(requests, 1);
  assert.equal((await loadSupplement(dir, false, fetcher)).table.size, 3);
  assert.equal((await loadSupplement(dir, false, fetcher)).table.size, 3); assert.equal(requests, 1);
});
