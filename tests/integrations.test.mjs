import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCollector } from '../scripts/collector.mjs';
import { protoFields, antigravityUsage } from '../scripts/antigravity.mjs';
import { priceEvent, detectedPrices } from '../scripts/pricing.mjs';
import { saveQuota, sanitizeQuota } from '../scripts/statusline-relay.mjs';
import { readLocalQuota, antigravityWindows, createQuotaReader } from '../scripts/quotas.mjs';

test('explicit model equivalents resolve exact prices, remain traceable and yield to overrides', () => {
  const rate = { input: 4e-6, cached: .4e-6, write: 4e-6, output: 20e-6 };
  const table = new Map([['gpt-5.6-sol', rate], ['grok-4.5', rate], ['grok-4.6', rate]]);
  const base = { input: 100, cached: 500, write: 0, output: 30 };
  for (const [tool, model, expected] of [['codex', 'codex-auto-review', 'gpt-5.6-sol'], ['grok', 'grok-4.5-build', 'grok-4.5'], ['grok', 'grok-4.6-build', 'grok-4.6']]) {
    const event = { ...base, tool, model }, priced = priceEvent(event, table);
    assert.equal(priced.priceModel, expected); assert.equal(priced.priceSource, 'equivalent');
    assert.equal(priced.cost, priceEvent({ ...event, model: expected }, table).cost);
    assert.equal(detectedPrices([event], table)[0].priceModel, expected);
    assert.equal(priceEvent(event, table, { [model]: { input: 0, cached: 0, write: 0, output: 0 } }).cost, 0);
    assert.equal(priceEvent(event, new Map()).cost, null);
  }
  assert.equal(priceEvent({ ...base, tool: 'cursor', model: 'codex-auto-review' }, table).cost, null);
  assert.equal(priceEvent({ ...base, tool: 'grok', model: 'grok-4.7-build' }, table).cost, null);
});

test('quota relays discard private fields and invalid observations without resetting prior usage', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-usage-relays-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const value = { email: 'PRIVATE', transcript_path: 'PRIVATE', quota: { 'gemini-weekly': { remaining_fraction: .25, reset_time: '2026-10-01T00:00:00Z', secret: 'PRIVATE' } } };
  assert.ok(!JSON.stringify(sanitizeQuota('antigravity', value)).includes('PRIVATE'));
  assert.equal(antigravityWindows(value)[0].usedPercent, 75);
  await saveQuota('antigravity', value, dir);
  const first = await readLocalQuota('antigravity', dir);
  await saveQuota('antigravity', { quota: { bad: { remaining_fraction: 2 } } }, dir);
  assert.deepEqual(await readLocalQuota('antigravity', dir), first);
  await fs.writeFile(path.join(dir, 'antigravity-quota.json'), JSON.stringify({ ...value, observedAt: Date.now() + 600000 }));
  await assert.rejects(readLocalQuota('antigravity', dir), /Date/);
  let fail = false;
  const reader = createQuotaReader(dir, dir, {
    codex: async () => ({}), go: async () => ({}), grok: async () => ({ windows: [] }), antigravity: async () => first,
    claude: async () => { if (fail) throw new Error('Unavailable'); return { observedAt: 1000, windows: [{ label: 'Semaine', usedPercent: 50, resetsAt: 2000, minutes: 10080 }] }; }
  });
  const old = (await reader()).find(c => c.id === 'claude'); fail = true;
  const stale = (await reader(true)).find(c => c.id === 'claude');
  assert.equal(stale.status, 'unavailable'); assert.equal(stale.observedAt, old.observedAt); assert.deepEqual(stale.windows, old.windows);
});

const vint = n => { const out = []; do { out.push((n % 128) | (n >= 128 ? 128 : 0)); n = Math.floor(n / 128); } while (n); return Buffer.from(out); };
const num = (field, n) => Buffer.concat([vint(field * 8), vint(n)]);
const bytes = (field, data) => Buffer.concat([vint(field * 8 + 2), vint(data.length), data]);
const usage = () => bytes(1, bytes(4, Buffer.concat([num(1, 9999), num(2, 100), num(3, 50), num(5, 200), num(10, 30)])));

test('Antigravity SQLite CLI and IDE counters deduplicate; unknown models and legacy formats stay explicit', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-usage-antigravity-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { DatabaseSync } = await import('node:sqlite');
  const cli = path.join(root, '.gemini/antigravity-cli/conversations'), ide = path.join(root, '.gemini/antigravity-ide/conversations');
  await fs.mkdir(cli, { recursive: true }); await fs.mkdir(ide, { recursive: true });
  const file = path.join(cli, 'shared-session.db'), db = new DatabaseSync(file);
  db.exec('CREATE TABLE steps (idx INTEGER, metadata BLOB); CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE executor_metadata (idx INTEGER, data BLOB);');
  for (const idx of [1, 2]) {
    db.prepare('INSERT INTO steps VALUES (?, ?)').run(idx, bytes(1, num(1, 1780000000 + idx)));
    db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(idx, usage());
  }
  db.prepare('INSERT INTO executor_metadata VALUES (?, ?)').run(1, bytes(7, Buffer.from('gemini-3.1-pro')));
  db.close();
  await fs.copyFile(file, path.join(ide, 'shared-session.db'));
  const original = await fs.readFile(file);
  const collect = createCollector(root, root), config = { paths: { codex: [], claude: [], grok: [], opencode: [], gemini: [] } };
  const result = await collect(config);
  assert.equal(result.events.length, 2); assert.equal(result.events[0].total, 350); assert.equal(result.events[0].reasoning, 30);
  assert.equal(result.events[0].model, 'gemini-3.1-pro'); assert.equal(result.events[1].model, 'antigravity-model-9999');
  assert.equal(result.events[0].time, 1780000001000);
  assert.deepEqual(await fs.readFile(file), original);
  await fs.writeFile(path.join(ide, 'legacy.pb'), 'unsupported');
  assert.equal((await collect(config)).sources.find(s => s.tool === 'antigravity').status, 'partial');
  assert.throws(() => protoFields(Buffer.from([10, 20, 1])), /Truncated/);
  assert.throws(() => protoFields(Buffer.from([0])), /Invalid/);
  assert.equal(antigravityUsage(usage())[0].cached, 200);
});

test('Gemini legacy and JSONL snapshots preserve spent requests without counting copies twice', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-usage-gemini-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, '.gemini/tmp/project/chats'); await fs.mkdir(dir, { recursive: true });
  const message = { type: 'gemini', id: 'one', timestamp: '2026-09-01T12:00:00Z', model: 'gemini-3.1-pro', tokens: { input: 100, cached: 80, output: 20, thoughts: 10 } };
  const document = { sessionId: 'same', messages: [message] };
  await fs.writeFile(path.join(dir, 'session-one.json'), JSON.stringify(document));
  await fs.writeFile(path.join(dir, 'session-two.jsonl'), [JSON.stringify({ sessionId: 'same' }), JSON.stringify({ $set: { messages: [message] } }), JSON.stringify({ $set: { messages: [] } })].join('\n'));
  const collect = createCollector(root, root), result = await collect({ paths: { codex: [], claude: [], grok: [], opencode: [], antigravity: [] } });
  assert.equal(result.events.length, 1); assert.equal(result.events[0].total, 130);
  assert.equal(result.sources.find(s => s.tool === 'gemini').latestAt, Date.parse(message.timestamp));
});
