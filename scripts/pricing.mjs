import fsp from 'node:fs/promises';
import path from 'node:path';

export const RATE_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
export const SUPPLEMENT_URL = 'https://models.dev/api.json';
const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export function rateTable(raw) {
  const table = new Map(), aliases = new Map();
  for (const [model, v] of Object.entries(raw || {})) {
    if (!v || !valid(v.input_cost_per_token) || !valid(v.output_cost_per_token)) continue;
    const rate = { input: v.input_cost_per_token, output: v.output_cost_per_token,
      cached: valid(v.cache_read_input_token_cost) ? v.cache_read_input_token_cost : v.input_cost_per_token,
      write: valid(v.cache_creation_input_token_cost) ? v.cache_creation_input_token_cost : v.input_cost_per_token };
    const key = model.toLowerCase(); table.set(key, rate);
    const bare = key.split('/').at(-1), previous = aliases.get(bare);
    aliases.set(bare, previous === undefined || JSON.stringify(previous) === JSON.stringify(rate) ? rate : null);
  }
  for (const [key, rate] of aliases) if (rate && !table.has(key)) table.set(key, rate);
  return table;
}
export function supplementTable(raw) {
  const table = new Map();
  for (const [provider, catalog] of Object.entries(raw || {})) {
    for (const [model, entry] of Object.entries(catalog?.models || {})) {
      const c = entry.cost;
      if (!c || !valid(c.input) || !valid(c.output)) continue;
      table.set(`${provider.toLowerCase()}/${model.toLowerCase()}`, {
        input: c.input / 1e6, output: c.output / 1e6,
        cached: (valid(c.cache_read) ? c.cache_read : c.input) / 1e6,
        write: (valid(c.cache_write) ? c.cache_write : c.input) / 1e6
      });
    }
  }
  return table;
}
export function supplementalRate(e, table) {
  let provider = e.provider || { codex: 'openai', claude: 'anthropic', gemini: 'google', grok: 'xai' }[e.tool];
  // Subscription quotas aren't API pricing: use the corresponding Z.AI public API tariff.
  if (provider === 'zai-coding-plan') provider = 'zai';
  if (!provider) return null;
  return table.get(`${provider.toLowerCase()}/${e.model.toLowerCase()}`) || null;
}
export function resolvePrice(e, table, overrides = {}, supplemental = new Map()) {
  const override = Object.hasOwn(overrides, e.model) ? overrides[e.model] : null;
  const key = e.model.toLowerCase();
  const primary = table.get(key), extra = primary ? null : supplementalRate(e, supplemental);
  const rate = override ? Object.fromEntries(Object.entries(override).map(([k, v]) => [k, v / 1e6])) : primary || extra;
  return { rate, priceSource: override ? 'custom' : primary ? 'catalog' : extra ? 'models.dev' : 'unknown' };
}
export function detectedPrices(events, table, overrides = {}, supplemental = new Map()) {
  const detected = new Map();
  for (const e of events) {
    const key = JSON.stringify([e.model, e.provider || '', e.tool]);
    if (detected.has(key)) continue;
    const { rate, priceSource } = resolvePrice(e, table, overrides, supplemental);
    detected.set(key, { model: e.model, provider: e.provider || '', tool: e.tool, priceSource,
      rates: rate ? Object.fromEntries(Object.entries(rate).map(([k, v]) => [k, v * 1e6])) : null });
  }
  return [...detected.values()].sort((a, b) => a.model.localeCompare(b.model) || a.provider.localeCompare(b.provider) || a.tool.localeCompare(b.tool));
}
export function priceEvent(e, table, overrides = {}, supplemental = new Map()) {
  const { rate, priceSource } = resolvePrice(e, table, overrides, supplemental);
  const cost = rate ? e.input * rate.input + e.cached * rate.cached + e.write * rate.write + e.output * rate.output : null;
  return { ...e, cost, savings: rate ? Math.max(0, e.cached * (rate.input - rate.cached)) : null,
    priceSource };
}
export async function loadSupplement(dataDir, force = false, fetcher = fetch) {
  const file = path.join(dataDir, 'supplemental-rates.json'); let saved = null, warning = '';
  try { saved = JSON.parse(await fsp.readFile(file, 'utf8')); } catch {}
  // First download is explicitly triggered by the missing-price button.
  if (force || (saved && Date.now() - saved.time > 86400000)) {
    try {
      const response = await fetcher(SUPPLEMENT_URL, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Catalog download failed');
      const raw = await response.json();
      if (!supplementTable(raw).size) throw new Error('Empty supplemental catalog');
      saved = { time: Date.now(), raw }; await fsp.writeFile(file, JSON.stringify(saved));
    } catch { warning = 'Catalogue complémentaire indisponible; les tarifs non vérifiés restent inconnus.'; }
  }
  return { table: supplementTable(saved?.raw), time: saved?.time || null, warning };
}
export async function loadPrices(dataDir, force = false) {
  const file = path.join(dataDir, 'rates.json'); let saved = null, warning = '';
  try { saved = JSON.parse(await fsp.readFile(file, 'utf8')); } catch {}
  if (force || !saved || Date.now() - saved.time > 86400000) {
    try {
      const response = await fetch(RATE_URL, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Price download failed');
      const raw = await response.json();
      if (rateTable(raw).size === 0) throw new Error('Empty price catalog');
      saved = { time: Date.now(), raw };
      await fsp.writeFile(file, JSON.stringify(saved));
    } catch { warning = saved ? 'Offline: using saved prices.' : 'Prices unavailable. Tokens are still counted.'; }
  }
  return { table: rateTable(saved?.raw), time: saved?.time || null, warning, source: RATE_URL };
}
export function validateOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a model price object.');
  const result = Object.create(null);
  for (const [model, v] of Object.entries(value)) {
    if (!model.trim() || model.length > 200 || !v || typeof v !== 'object' || !['input', 'output', 'cached', 'write'].every(k => valid(v[k]))) {
      throw new Error('Each model needs non-negative input, cached, write and output prices per million tokens.');
    }
    result[model] = Object.fromEntries(['input', 'cached', 'write', 'output'].map(k => [k, v[k]]));
  }
  return result;
}
