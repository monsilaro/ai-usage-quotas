import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexState, codexLine, claudeLine, geminiMessages, grokLine, opencodeMessage, cursorCSV } from '../scripts/parsers.mjs';
import { rateTable, priceEvent, validateOverrides } from '../scripts/pricing.mjs';
import { createCollector } from '../scripts/collector.mjs';
import { createApp } from '../scripts/server.mjs';

const time = '2026-09-04T12:00:00.000Z';
const usage = { input_tokens: 1000, cached_input_tokens: 700, output_tokens: 100, reasoning_output_tokens: 40 };
const event = (last = usage, total = 1100, stamp = time) => ({ type: 'event_msg', timestamp: stamp, payload: { type: 'token_count', info: { last_token_usage: last, total_token_usage: { total_tokens: total } } } });
function state(fork = false) {
  const s = codexState();
  codexLine({ type: 'session_meta', timestamp: '2026-09-04T11:59:59Z', payload: { id: 's1', cwd: '/project', ...(fork ? { forked_from_id: 'parent' } : {}) } }, s);
  codexLine({ type: 'turn_context', payload: { model: 'model-a' } }, s); return s;
}
test('Codex counts cache once, drops repeated notifications, retains equal requests with different cumulative counts', () => {
  const s = state(); const r = codexLine(event(), s);
  assert.equal(r.input, 300); assert.equal(r.total, 1100); assert.equal(r.output, 100);
  assert.equal(codexLine(event(), s), null);
  assert.equal(codexLine(event(usage, 2200), s).total, 1100);
  codexLine({ type: 'turn_context', payload: { model: 'model-b' } }, s);
  assert.equal(codexLine(event(usage, 3300), s).model, 'model-b');
});
test('Codex copied fork prefix is suppressed without reassigning the session', () => {
  const s = state(true);
  codexLine({ type: 'session_meta', payload: { id: 'parent' } }, s);
  assert.equal(codexLine(event(usage, 1100, '2026-09-04T11:59:59.050Z'), s), null);
  const r = codexLine(event(usage, 2200, '2026-09-04T12:00:05Z'), s);
  assert.equal(r.session, 'codex:s1'); assert.equal(r.total, 1100);
});
test('Claude, Gemini and OpenCode normalize their different cache and reasoning semantics', () => {
  const claude = claudeLine({ type: 'assistant', timestamp: time, sessionId: 's', message: { id: 'm', model: 'claude', usage: { input_tokens: 100, cache_read_input_tokens: 700, cache_creation_input_tokens: 200, output_tokens: 50 } } });
  assert.equal(claude.total, 1050);
  const messages = [{ sessionId: 's', projectHash: 'p' }, { type: 'gemini', id: 'm', timestamp: time, model: 'gemini', tokens: { input: 1000, cached: 700, output: 50, thoughts: 20 } }];
  assert.equal(geminiMessages(messages, 'fallback')[0].total, 1070);
  assert.equal(geminiMessages([...messages, messages[1], { $rewindTo: 'm' }], 'fallback').length, 1);
  const oc = opencodeMessage({ role: 'assistant', id: 'm', modelID: 'model', time: { created: Date.parse(time) }, cost: 0, tokens: { input: 100, output: 50, reasoning: 20, cache: { read: 700, write: 200 } } }, 's');
  assert.equal(oc.total, 1070); assert.equal(oc.reportedCost, null);
});
test('Grok uses completed turn model usage without also counting the aggregate', () => {
  const rows = grokLine({ timestamp: Date.parse(time) / 1000, params: { sessionId: 's', update: { sessionUpdate: 'turn_completed', prompt_id: 'p', usage: { inputTokens: 200, modelUsage: { grok: { inputTokens: 1000, cachedReadTokens: 800, outputTokens: 100 } } } } } });
  assert.equal(rows.length, 1); assert.equal(rows[0].total, 1100);
});
test('Cursor accepts actual export headers and quoted cells and preserves reimport identities', () => {
  const csv = 'Date (UTC),Kind,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Cost\r\n2026-09-04T12:00:00Z,Included,"model, variant",200,100,"1,000",50,Included\r\n';
  const a = cursorCSV(csv), b = cursorCSV(csv);
  assert.equal(a.events[0].total, 1350); assert.equal(a.events[0].model, 'model, variant');
  assert.equal(a.events[0].key, b.events[0].key); assert.equal(a.events[0].sessionKnown, false);
  assert.throws(() => cursorCSV('foo,bar\n1,2'), /expected/);
  assert.throws(() => cursorCSV('"unclosed'), /unclosed/);
});
test('Pricing stays unknown for missing or ambiguous models and honors explicit zero tariffs', () => {
  const table = rateTable({ model: { input_cost_per_token: .000002, output_cost_per_token: .00001, cache_read_input_token_cost: .0000002 }, 'a/conflict': { input_cost_per_token: 1, output_cost_per_token: 1 }, 'b/conflict': { input_cost_per_token: 2, output_cost_per_token: 2 } });
  const e = { model: 'model', input: 100, cached: 1000, write: 0, output: 20 };
  assert.ok(Math.abs(priceEvent(e, table).cost - .0006) < 1e-12);
  assert.equal(priceEvent({ ...e, model: 'missing' }, table).cost, null);
  assert.equal(priceEvent({ ...e, model: 'conflict' }, table).cost, null);
  assert.equal(priceEvent(e, table, { model: { input: 0, output: 0, cached: 0, write: 0 } }).cost, 0);
  assert.throws(() => validateOverrides({ model: { input: -1 } }));
});
test('Collector deduplicates files and refreshes changed data; SQLite is read only and legacy JSON copies are skipped', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ai-usage-test-')); t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'codex'); await fsp.mkdir(dir);
  const rows = [{ type: 'session_meta', payload: { id: 's' } }, { type: 'turn_context', payload: { model: 'model' } }, event()];
  const file = path.join(dir, 'one.jsonl'); await fsp.writeFile(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  await fsp.copyFile(file, path.join(dir, 'copy.jsonl'));
  const { DatabaseSync } = await import('node:sqlite'); const ocDir = path.join(root, 'oc'); await fsp.mkdir(ocDir);
  const db = new DatabaseSync(path.join(ocDir, 'opencode.db'));
  db.exec('CREATE TABLE session (id TEXT, directory TEXT); CREATE TABLE message (id TEXT, session_id TEXT, data TEXT);');
  db.prepare('INSERT INTO session VALUES (?, ?)').run('s', '/project');
  db.prepare('INSERT INTO message VALUES (?, ?, ?)').run('m', 's', JSON.stringify({ role: 'assistant', modelID: 'm', time: { created: Date.parse(time) }, tokens: { input: 100, output: 50 } })); db.close();
  const config = { paths: { codex: [dir], claude: [], gemini: [], grok: [], opencode: [ocDir] } };
  const collect = createCollector(root, root);
  assert.equal((await collect(config)).events.length, 2);
  assert.equal((await collect(config)).events.length, 2);
  await fsp.appendFile(file, JSON.stringify(event(usage, 2200, '2026-09-04T12:00:05Z')) + '\n');
  const result = await collect(config); assert.equal(result.events.length, 3); assert.equal(result.sources.find(s => s.tool === 'opencode').status, 'connected');
});
test('Local server enforces token and origin, imports idempotently and applies persisted prices', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ai-usage-http-')); t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await fsp.writeFile(path.join(dir, 'config.json'), JSON.stringify({ paths: { codex: [], claude: [], gemini: [], grok: [], opencode: [] } }));
  await fsp.writeFile(path.join(dir, 'supplemental-rates.json'), JSON.stringify({ time: Date.now(), raw: {} }));
  await fsp.writeFile(path.join(dir, 'rates.json'), JSON.stringify({ time: Date.now(), raw: {} }));
  await fsp.writeFile(path.join(dir, 'exchange.json'), JSON.stringify({ fetchedAt: Date.now(), rate: 1.4, date: '2026-09-04' }));
  const app = await createApp({ home: dir, dataDir: dir }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(url + '/api/data')).status, 403);
  assert.equal((await fetch(url + '/api/data', { headers: { 'X-AI-Usage-Token': app.token, Origin: 'https://example.com' } })).status, 403);
  const call = (route, body) => fetch(url + route, { method: 'POST', headers: { 'X-AI-Usage-Token': app.token }, body: JSON.stringify(body) });
  const csv = 'Date,Model,Input (w/o Cache Write),Output Tokens\n2026-09-04T12:00:00Z,test,100,20';
  assert.equal((await (await call('/api/import/cursor', { csv })).json()).imported, 1);
  assert.equal((await (await call('/api/import/cursor', { csv })).json()).imported, 0);
  const data = await (await call('/api/prices', { test: { input: 1, cached: 0, write: 0, output: 5 } })).json();
  assert.ok(Math.abs(data.events[0].cost - .0002) < 1e-12);
  assert.equal((await call('/api/prices', { test: { input: -1 } })).status, 400);
  const cad = await (await call('/api/prices/model', { model: 'test', currency: 'CAD', exchangeRate: 1.4, rates: { input: 1.4, cached: 0, write: 0, output: 7 } })).json();
  assert.ok(Math.abs(cad.events[0].cost - .0002) < 1e-12);
  assert.ok(Math.abs(cad.customPrices.test.input - 1) < 1e-12);
  assert.equal((await call('/api/prices/model', { model: 'test', currency: 'CAD', exchangeRate: 1.5, rates: { input: 1, cached: 0, write: 0, output: 1 } })).status, 400);
});
