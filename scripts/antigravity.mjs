import path from 'node:path';
import { record } from './parsers.mjs';

// Decode only wire fields needed for counters. Storage references are in README.md.
export function protoFields(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('Expected protobuf bytes');
  const fields = new Map(); let offset = 0;
  const integer = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n && offset < bytes.length; shift += 7n) {
      const byte = bytes[offset++]; value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) {
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Protobuf integer overflow');
        return Number(value);
      }
    }
    throw new Error('Truncated protobuf integer');
  };
  while (offset < bytes.length) {
    const tag = integer(), field = Math.floor(tag / 8), wire = tag % 8;
    if (!field) throw new Error('Invalid protobuf field');
    let value;
    if (wire === 0) value = integer();
    else if (wire === 2) {
      const size = integer(); if (offset + size > bytes.length) throw new Error('Truncated protobuf bytes');
      value = bytes.subarray(offset, offset + size); offset += size;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > bytes.length) throw new Error('Truncated protobuf fixed field');
      continue;
    } else throw new Error('Unsupported protobuf wire type');
    if (!fields.has(field)) fields.set(field, []);
    fields.get(field).push(value);
  }
  return fields;
}
const numeric = (fields, field) => {
  const value = fields.get(field)?.[0];
  if (value === undefined) return 0;
  if (typeof value !== 'number') throw new Error('Invalid numeric usage field');
  return value;
};
export function antigravityUsage(bytes) {
  const results = [];
  for (const generation of protoFields(bytes).get(1) || []) {
    for (const raw of protoFields(generation).get(4) || []) {
      const usage = protoFields(raw);
      if (!usage.has(2) && !usage.has(3) && !usage.has(5)) continue;
      results.push({ modelId: numeric(usage, 1), input: numeric(usage, 2), output: numeric(usage, 3), cached: numeric(usage, 5), reasoning: numeric(usage, 10) });
    }
  }
  return results;
}
export async function readAntigravityDB(file, status) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  const events = [], session = path.basename(file, '.db');
  try {
    db.exec('PRAGMA query_only = ON');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    if (!tables.has('gen_metadata') || !tables.has('steps')) { status.unsupported = true; return []; }
    const times = new Map(), models = new Map();
    for (const row of db.prepare('SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL').iterate()) {
      try {
        const raw = protoFields(row.metadata).get(1)?.[0];
        if (!raw) continue;
        const timestamp = protoFields(raw), seconds = numeric(timestamp, 1), nanos = numeric(timestamp, 2);
        if (seconds > 0 && nanos < 1e9) times.set(row.idx, seconds * 1000 + Math.floor(nanos / 1e6));
      } catch { status.malformed++; }
    }
    if (tables.has('executor_metadata')) {
      for (const row of db.prepare('SELECT idx, data FROM executor_metadata WHERE data IS NOT NULL').iterate()) {
        const candidates = [...new Set(Buffer.from(row.data).toString('latin1').match(/(?:gemini|claude|gpt)-[a-zA-Z0-9][a-zA-Z0-9.\-]{1,100}/g) || [])];
        // Do not guess across steps or assign a default model to unknown enum IDs.
        if (candidates.length === 1) models.set(row.idx, candidates[0]);
      }
    }
    for (const row of db.prepare('SELECT idx, data FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx').iterate()) {
      try {
        const usage = antigravityUsage(row.data);
        if (!usage.length && row.data.length) status.unsupported = true;
        if (usage.length && !times.has(row.idx)) { status.unsupported = true; continue; }
        usage.forEach((u, index) => {
          const model = models.get(row.idx) || `antigravity-model-${u.modelId || 'unknown'}`;
          // Storage input excludes cache; output already includes reasoning.
          const e = record('antigravity', times.get(row.idx), model, session, '',
            [u.input, u.cached, 0, u.output, Math.min(u.output, u.reasoning)], `antigravity:${session}:${row.idx}:${index}`);
          if (e) { e.provider = model.startsWith('gemini-') ? 'google' : model.startsWith('claude-') ? 'anthropic' : model.startsWith('gpt-') ? 'openai' : ''; events.push(e); }
        });
      } catch { status.malformed++; }
    }
    return events;
  } finally { db.close(); }
}
