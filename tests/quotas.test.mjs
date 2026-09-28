import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { codexWindows, claudeWindows, goWindows, readGo, createQuotaReader, grokSnapshot, readGrok } from '../scripts/quotas.mjs';
import { installClaudeRelay } from '../scripts/claude-quota.mjs';

test('quota windows preserve weekly primary buckets, zero, missing values and reset times', () => {
  const windows = codexWindows({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: 1789158144 } }, spark: { limitId: 'spark', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1789158144 } } } });
  assert.equal(windows[0].label, 'Semaine'); assert.equal(windows[0].usedPercent, 42);
  assert.equal(windows[0].resetsAt, 1789158144000); assert.equal(windows[1].usedPercent, 0);
  assert.deepEqual(claudeWindows({ rate_limits: { seven_day: { used_percentage: null } } }), []);
  assert.equal(claudeWindows({ rate_limits: { seven_day: { used_percentage: 101 } } })[0].usedPercent, 101);
  assert.equal(goWindows({ usage: { weekly: { percent: 0, resetsAt: '2026-09-10T00:00:00Z' } } })[0].resetsAt, Date.parse('2026-09-10T00:00:00Z'));
  assert.deepEqual(goWindows({ usage: { weekly: { percent: '50' } } }), []);
});

test('Go uses only the Go credential, fixed endpoint and no redirects; response errors never echo keys', async () => {
  const env = { OPENCODE_AUTH_CONTENT: JSON.stringify({ 'opencode-go': { type: 'api', key: 'TEST_GO_KEY' }, unrelated: { type: 'api', key: 'OTHER' } }) };
  const result = await readGo('/unused', async (url, options) => {
    assert.equal(url, 'https://opencode.ai/zen/go/v1/usage');
    assert.equal(options.headers.Authorization, 'Bearer TEST_GO_KEY'); assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => ({ usage: {} }) };
  }, env);
  assert.deepEqual(result, { usage: {} });
  await assert.rejects(readGo('/unused', async () => ({ ok: false, status: 401 }), env), /expirée/);
  await assert.rejects(readGo('/unused', () => assert.fail('must not call provider'), { OPENCODE_AUTH_CONTENT: '{}' }), /non connecté/);
});

test('quota reader isolates provider failures, caches requests and never substitutes token estimates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-usage-quota-'));
  try {
    let calls = 0;
    const reader = createQuotaReader(root, root, { codex: async () => { calls++; return { rateLimits: { primary: { usedPercent: 42, windowDurationMins: 10080 } } }; }, go: async () => { throw new Error('Unavailable'); }, grok: async () => { throw new Error('No local snapshot'); } });
    const [a, b] = await Promise.all([reader(), reader()]);
    assert.deepEqual(a, b); await reader(); assert.equal(calls, 1);
    assert.equal(a.find(c => c.id === 'codex').windows[0].usedPercent, 42);
    assert.equal(a.find(c => c.id === 'opencode').status, 'unavailable');
    assert.deepEqual(a.find(c => c.id === 'grok').windows, []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Grok reads the latest billing snapshot, preserving zero and never returning unrelated log data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-usage-grok-'));
  const row = (ts, percent) => ({ ts, msg: 'billing: fetched credits config', ctx: { config: { creditUsagePercent: percent, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-09-10T17:09:12Z' }, private: 'DO_NOT_RETURN' }, subscriptionTier: 'SuperGrok Plus', accountId: 'DO_NOT_RETURN' } });
  try {
    await fs.mkdir(path.join(root, '.grok/logs'), { recursive: true });
    const file = path.join(root, '.grok/logs/unified.jsonl');
    const older = row('2026-01-01T00:00:00Z', 63), latest = row('2026-01-01T01:00:00Z', 0);
    await fs.writeFile(file, [JSON.stringify(latest), JSON.stringify(older), '{partial'].join('\n'));
    const value = await readGrok(root, {});
    assert.equal(value.windows[0].usedPercent, 0);
    assert.equal(value.windows[0].label, 'Semaine');
    assert.equal(value.observedAt, Date.parse(latest.ts));
    assert.ok(!JSON.stringify(value).includes('DO_NOT_RETURN'));
    assert.equal(grokSnapshot({ ...older, msg: 'other message' }), null);
    assert.deepEqual(grokSnapshot(row('2026-01-01T00:00:00Z', null)).windows, []);
    await fs.writeFile(file, [JSON.stringify(older), JSON.stringify(row('2026-01-01T02:00:00Z', null))].join('\n'));
    await assert.rejects(readGrok(root, {}), /Aucun quota/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Claude relay preserves settings, records only quota fields and wraps an existing status line without changing its output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-usage-relay-'));
  const old = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
  try {
    await fs.mkdir(process.env.CLAUDE_CONFIG_DIR);
    const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
    await fs.writeFile(file, JSON.stringify({ theme: 'dark' }));
    await installClaudeRelay(root, root);
    const settings = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(settings.theme, 'dark'); assert.ok(settings.statusLine.command.includes('ai-usage-claude-relay'));
    const relay = spawnSync(process.execPath, [path.join(root, 'ai-usage-claude-relay.mjs'), 'claude', root], { input: JSON.stringify({ session_id: 'PRIVATE', transcript_path: 'PRIVATE', rate_limits: { seven_day: { used_percentage: 42, resets_at: 1789158144, extra: 'PRIVATE' } } }), encoding: 'utf8' });
    assert.equal(relay.status, 0);
    const saved = await fs.readFile(path.join(root, 'claude-quota.json'), 'utf8');
    assert.ok(!saved.includes('PRIVATE')); assert.equal(JSON.parse(saved).rate_limits.seven_day.used_percentage, 42);
    await fs.writeFile(file, JSON.stringify({ statusLine: { type: 'command', command: 'existing-status' } }));
    await fs.writeFile(file, JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: 'printf existing-status', padding: 2 } }));
    await installClaudeRelay(root, root);
    const wrapped = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(wrapped.statusLine.padding, 2);
    const rendered = spawnSync(wrapped.statusLine.command, { shell: true, input: '{}', encoding: 'utf8' });
    assert.equal(rendered.status, 0); assert.equal(rendered.stdout, 'existing-status');
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'claude-quota.json'), 'utf8')).rate_limits.seven_day.used_percentage, 42);
    await installClaudeRelay(root, root);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), wrapped);
  } finally { if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old; await fs.rm(root, { recursive: true, force: true }); }
});
