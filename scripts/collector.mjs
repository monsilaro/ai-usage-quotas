import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { codexState, codexLine, claudeLine, geminiMessages, grokLine, opencodeMessage } from './parsers.mjs';

export const labels = { codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini CLI', grok: 'Grok Build', opencode: 'OpenCode', cursor: 'Cursor' };
export function sourcePaths(home = os.homedir(), config = {}, env = process.env) {
  const root = (key, fallback) => env[key]?.trim() || fallback;
  const sources = {
    codex: [path.join(root('CODEX_HOME', path.join(home, '.codex')), 'sessions'), path.join(root('CODEX_HOME', path.join(home, '.codex')), 'archived_sessions')],
    claude: [path.join(root('CLAUDE_CONFIG_DIR', path.join(home, '.claude')), 'projects')],
    gemini: [path.join(root('GEMINI_CLI_HOME', home), '.gemini', 'tmp')],
    grok: [path.join(root('GROK_HOME', path.join(home, '.grok')), 'sessions')],
    opencode: [path.join(root('XDG_DATA_HOME', path.join(home, '.local', 'share')), 'opencode')],
    cursor: []
  };
  for (const [tool, paths] of Object.entries(config.paths || {})) {
    if (tool in sources && Array.isArray(paths)) sources[tool] = paths.map(p => path.resolve(p.replace(/^~(?=[/\\]|$)/, home)));
  }
  return sources;
}
async function walk(root, accept, status) {
  const results = [];
  async function visit(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e.code !== 'ENOENT') status.errors++; return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && accept(file)) results.push(file);
    }
  }
  await visit(root); return results;
}
export function createCollector(home, dataDir) {
  const cache = new Map();
  async function parseFile(file, tool, status) {
    const stat = await fsp.stat(file), stamp = `${stat.size}:${stat.mtimeMs}`;
    const cached = cache.get(file);
    if (cached?.stamp === stamp) { status.malformed += cached.malformed; return cached.events; }
    const events = [], fallback = path.basename(file), state = codexState();
    let malformed = 0;
    if (tool === 'gemini') {
      const raw = await fsp.readFile(file, 'utf8'); let document;
      try { document = JSON.parse(raw); }
      catch {
        document = [];
        for (const line of raw.split(/\r?\n/)) if (line.trim()) {
          try { document.push(JSON.parse(line)); } catch { malformed++; }
        }
      }
      events.push(...geminiMessages(document, fallback));
    } else if (tool === 'opencode') {
      const m = JSON.parse(await fsp.readFile(file, 'utf8'));
      const r = opencodeMessage(m, path.basename(path.dirname(file))); if (r) events.push(r);
    } else {
      const stream = fs.createReadStream(file, { encoding: 'utf8' });
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          const relevant = tool === 'codex' ? /"(?:token_count|session_meta|turn_context)"/.test(line) :
            tool === 'claude' ? line.includes('"usage"') : line.includes('"turn_completed"');
          if (!relevant) continue;
          let row; try { row = JSON.parse(line); } catch { malformed++; continue; }
          if (tool === 'grok') events.push(...grokLine(row, fallback));
          else { const r = tool === 'codex' ? codexLine(row, state, fallback) : claudeLine(row, fallback); if (r) events.push(r); }
        }
      } finally { lines.close(); stream.destroy(); }
    }
    status.malformed += malformed; cache.set(file, { stamp, events, malformed }); return events;
  }
  async function openCodeDB(file, status) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec('PRAGMA query_only = ON');
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
      if (!tables.has('message')) { status.unsupported = true; return []; }
      if (tables.has('session_message') && db.prepare('SELECT count(*) AS n FROM session_message').get().n > 0) status.unsupported = true;
      const records = [];
      const statement = db.prepare("SELECT m.id, m.session_id, m.data, s.directory FROM message m LEFT JOIN session s ON s.id = m.session_id WHERE json_extract(m.data, '$.role') = 'assistant'");
      for (const row of statement.iterate()) {
        try {
          const m = JSON.parse(row.data);
          const r = opencodeMessage({ ...m, id: row.id, sessionID: row.session_id }, row.session_id, row.directory);
          if (r) records.push(r);
        } catch { status.malformed++; }
      }
      return records;
    } finally { db.close(); }
  }
  return async function collect(config = {}) {
    const all = [], sources = [], liveFiles = new Set();
    for (const [tool, roots] of Object.entries(sourcePaths(home, config))) {
      const status = { tool, label: labels[tool], paths: roots, files: 0, records: 0, errors: 0, malformed: 0, unsupported: false, status: 'not-found' };
      let events = [];
      if (tool === 'cursor') {
        try { events = JSON.parse(await fsp.readFile(path.join(dataDir, 'cursor-events.json'), 'utf8')); status.files = 1; }
        catch (e) { if (e.code !== 'ENOENT') status.errors++; }
        status.status = events.length ? 'imported' : 'import-required';
      } else {
        for (const root of [...new Set(roots)]) {
          if (fs.existsSync(root)) status.status = 'empty';
          if (tool === 'opencode') {
            const db = root.endsWith('.db') ? root : path.join(root, 'opencode.db');
            if (fs.existsSync(db)) {
              status.files++;
              try { events.push(...await openCodeDB(db, status)); } catch { status.errors++; }
              continue; // A migrated installation can retain JSON copies of the database history.
            }
          }
          const files = await walk(root, file => tool === 'gemini' ? /^session-.*\.jsonl?$/.test(path.basename(file)) :
            tool === 'grok' ? path.basename(file) === 'updates.jsonl' :
              tool === 'opencode' ? file.endsWith('.json') && /[/\\]message[/\\]/.test(file) : file.endsWith('.jsonl'), status);
          status.files += files.length;
          for (const file of files) {
            liveFiles.add(file);
            try { events.push(...await parseFile(file, tool, status)); } catch { status.errors++; }
          }
        }
      }
      // Providers may save repeated blocks and copies in multiple files; retain the fullest usage.
      const deduped = new Map();
      for (const e of events) if (!deduped.has(e.key) || deduped.get(e.key).total < e.total) deduped.set(e.key, e);
      events = [...deduped.values()];
      status.records = events.length;
      if (events.length && tool !== 'cursor') status.status = 'connected';
      if (status.errors || status.malformed || status.unsupported) status.status = 'partial';
      sources.push(status); all.push(...events);
    }
    for (const key of cache.keys()) if (!liveFiles.has(key)) cache.delete(key);
    return { events: all.sort((a, b) => a.time - b.time), sources };
  };
}
