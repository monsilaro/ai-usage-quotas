import { createHash } from 'node:crypto';

export const count = x => typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.trunc(x) : 0;
export const money = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
export const timestamp = x => typeof x === 'number' ? (x < 1e12 ? x * 1000 : x) : Date.parse(x);
export const hash = x => createHash('sha256').update(x).digest('hex').slice(0, 24);
export function record(tool, time, model, session, project, tokens, key) {
  const t = timestamp(time);
  if (!Number.isFinite(t)) return null;
  const [input, cached, write, output, reasoning = 0] = tokens.map(count);
  if (!(input + cached + write + output)) return null;
  return { tool, time: t, model: model || 'unknown', session: `${tool}:${session}`, project: project || 'Unknown project',
    input, cached, write, output, reasoning, total: input + cached + write + output, key, reportedCost: null };
}

export function codexState() { return { model: '', session: '', project: '', meta: false, signature: '', fork: false, anchor: 0 }; }
export function codexLine(row, state, fallback) {
  const p = row?.payload;
  if (!p || typeof p !== 'object') return null;
  if (row.type === 'session_meta' && !state.meta) {
    state.meta = true; state.session = p.id || p.session_id || fallback; state.project = p.cwd || '';
    state.fork = Boolean(p.forked_from_id || p.source?.subagent?.thread_spawn?.parent_thread_id);
    state.anchor = timestamp(row.timestamp); return null;
  }
  if (row.type === 'turn_context') { state.model = p.model || state.model; state.project = p.cwd || state.project; return null; }
  if (row.type !== 'event_msg' || p.type !== 'token_count' || !p.info?.last_token_usage) return null;
  const usage = p.info.last_token_usage;
  const time = timestamp(row.timestamp);
  if (!Number.isFinite(time)) return null;
  // A cumulative counter distinguishes two legitimate requests with identical deltas.
  const signature = JSON.stringify(p.info.total_token_usage || usage);
  if (signature === state.signature) return null;
  state.signature = signature;
  // Forked rollouts contain a burst of copied ancestor events, re-stamped at fork time.
  if (state.fork && time - state.anchor < 1000) { state.anchor = time; return null; }
  state.fork = false;
  const input = count(usage.input_tokens), cached = Math.min(input, count(usage.cached_input_tokens));
  const write = Math.min(input - cached, count(usage.cache_write_input_tokens));
  return record('codex', time, state.model, state.session || fallback, state.project,
    [input - cached - write, cached, write, usage.output_tokens, Math.min(count(usage.output_tokens), count(usage.reasoning_output_tokens))],
    `codex:${state.session || fallback}:${time}:${hash(signature)}`);
}

export function claudeLine(row, fallback) {
  if (row?.type !== 'assistant' || !row.message?.usage) return null;
  const m = row.message, u = m.usage;
  if (['<synthetic>', 'synthetic'].includes(m.model)) return null;
  return record('claude', row.timestamp, m.model, row.sessionId || fallback, row.cwd,
    [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, u.output_tokens],
    `claude:${m.id || row.uuid || hash(JSON.stringify(u) + row.timestamp)}:${row.requestId || ''}`);
}

export function geminiMessages(document, fallback) {
  // Preserve spent usage even when a later rewind removes it from the visible conversation.
  const records = Array.isArray(document) ? document : [document];
  let session = fallback, project = '';
  const messages = new Map();
  for (const row of records) {
    if (!row || typeof row !== 'object') continue;
    session = row.sessionId || session;
    project = row.directories?.[0] || row.projectHash || project;
    for (const m of [...(row.messages || []), ...(row.$set?.messages || []), ...(row.type === 'gemini' ? [row] : [])]) {
      if (m.type === 'gemini' && m.tokens) messages.set(m.id || hash(JSON.stringify(m.tokens) + m.timestamp), m);
    }
  }
  return [...messages].map(([id, m]) => {
    const u = m.tokens, input = count(u.input), cached = Math.min(input, count(u.cached));
    return record('gemini', m.timestamp, m.model, session, project,
      [input - cached + count(u.tool), cached, 0, count(u.output) + count(u.thoughts), u.thoughts], `gemini:${session}:${id}`);
  }).filter(Boolean);
}

export function grokLine(row, fallback) {
  const p = row?.params, update = p?.update;
  if (update?.sessionUpdate !== 'turn_completed' || !update.usage) return [];
  const u = update.usage, session = p.sessionId || fallback;
  const time = p._meta?.agentTimestampMs || row.timestamp;
  const entries = Object.entries(u.modelUsage || {});
  const results = (entries.length ? entries : [['grok', u]]).map(([model, v]) => {
    const input = count(v.inputTokens), cached = Math.min(input, count(v.cachedReadTokens));
    const write = Math.min(input - cached, count(v.cacheCreationTokens));
    const r = record('grok', time, model, session, '', [input - cached - write, cached, write, v.outputTokens, v.reasoningTokens],
      `grok:${session}:${update.prompt_id || time}:${model}`);
    if (r && money(v.costUsdTicks) !== null) r.reportedCost = v.costUsdTicks / 1e10;
    return r;
  }).filter(Boolean);
  return results;
}

export function opencodeMessage(m, fallback, project) {
  if (m?.role !== 'assistant' || !m.tokens) return null;
  const u = m.tokens;
  // OpenCode normalizes output and reasoning separately; input excludes cache.
  const r = record('opencode', m.time?.completed || m.time?.created, m.modelID, m.sessionID || fallback, project || m.path?.cwd,
    [u.input, u.cache?.read, u.cache?.write, count(u.output) + count(u.reasoning), u.reasoning],
    `opencode:${m.id || hash(JSON.stringify([fallback, m.time, u]))}`);
  if (r) r.provider = m.providerID || '';
  return r;
}

export function csvRows(csv) {
  const rows = []; let row = [], value = '', quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') {
      if (quoted && csv[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted;
    } else if (c === ',' && !quoted) { row.push(value); value = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && csv[i + 1] === '\n') i++;
      row.push(value); if (row.some(Boolean)) rows.push(row); row = []; value = '';
    } else value += c;
  }
  if (quoted) throw new Error('CSV: unclosed quoted field.');
  row.push(value); if (row.some(Boolean)) rows.push(row);
  return rows;
}
export function cursorCSV(csv) {
  const rows = csvRows(csv.replace(/^\uFEFF/, ''));
  const header = (rows.shift() || []).map(x => x.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const index = (...names) => names.map(n => header.indexOf(n)).find(i => i >= 0);
  const date = index('date', 'dateutc', 'timestamp'), model = index('model');
  const uncached = index('inputwocachewrite', 'inputwocacheread', 'uncachedinputtokens', 'inputtokens'), cache = index('cacheread', 'cachereadtokens', 'cachedinputtokens');
  const write = index('inputwcachewrite', 'cachewrite', 'cachewritetokens'), output = index('outputtokens', 'output');
  if ([date, model, uncached, output].some(i => i === undefined)) throw new Error('Cursor CSV: expected Date, Model, Input (w/o Cache Write), and Output Tokens columns.');
  const session = index('sessionid', 'conversationid'), id = index('requestid', 'id');
  const number = (row, i) => i === undefined ? 0 : Number(String(row[i] || '').replace(/[$,\s]/g, ''));
  const events = [], occurrences = new Map(); let skipped = 0;
  for (const row of rows) {
    const identity = id === undefined ? hash(JSON.stringify(row)) : row[id];
    const occurrence = occurrences.get(identity) || 0; occurrences.set(identity, occurrence + 1);
    const key = `cursor:${identity}:${occurrence}`;
    const values = [number(row, uncached), number(row, cache), number(row, write), number(row, output)];
    if (values.some(n => !Number.isFinite(n) || n < 0)) { skipped++; continue; }
    const r = record('cursor', row[date], row[model], session === undefined ? 'unavailable' : row[session], '', values, key);
    if (r) { r.sessionKnown = session !== undefined; events.push(r); } else skipped++;
  }
  return { events, skipped };
}
