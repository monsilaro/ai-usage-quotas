import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { createCollector } from './collector.mjs';
import { loadPrices, loadSupplement, priceEvent, detectedPrices, validateOverrides } from './pricing.mjs';
import { loadExchange, ratesToUsd } from './exchange.mjs';
import { cursorCSV } from './parsers.mjs';
import { createQuotaReader } from './quotas.mjs';

export const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const buildId = createHash('sha256').update(['scripts/server.mjs', 'scripts/launch.mjs', 'scripts/collector.mjs', 'scripts/parsers.mjs', 'scripts/pricing.mjs', 'scripts/exchange.mjs', 'scripts/quotas.mjs', 'scripts/claude-quota.mjs', 'web/index.html', 'web/app.js', 'web/style.css'].map(file => fs.readFileSync(path.join(pluginRoot, file), 'utf8')).join('\n')).digest('hex');
export const defaultDataDir = () => process.env.AI_USAGE_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'ai-usage');
export async function createApp({ home = os.homedir(), dataDir = defaultDataDir(), token = randomBytes(24).toString('hex') } = {}) {
  await fsp.mkdir(dataDir, { recursive: true });
  const configFile = path.join(dataDir, 'config.json');
  const readConfig = async () => {
    try { return JSON.parse(await fsp.readFile(configFile, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return {}; throw new Error('Cannot read config.json. Check its JSON syntax.'); }
  };
  const writeConfig = async value => {
    const tmp = `${configFile}.tmp`; await fsp.writeFile(tmp, JSON.stringify(value, null, 2)); await fsp.rename(tmp, configFile);
  };
  const collect = createCollector(home, dataDir);
  const readQuotas = createQuotaReader(home, dataDir);
  let snapshot = null, pending = null;
  const refresh = (force = false, complete = false) => {
    if (pending) return pending;
    pending = (async () => {
      const config = await readConfig();
      const [usage, prices, supplemental, exchange] = await Promise.all([collect(config), loadPrices(dataDir, force), loadSupplement(dataDir, complete), loadExchange(dataDir, force)]);
      snapshot = { ...usage, events: usage.events.map(e => priceEvent(e, prices.table, config.prices, supplemental.table)), exchange,
        generatedAt: Date.now(), pricing: { updatedAt: prices.time, warning: [prices.warning, supplemental.warning].filter(Boolean).join(' '), models: prices.table.size, source: prices.source, supplementalUpdatedAt: supplemental.time },
        detectedPrices: detectedPrices(usage.events, prices.table, config.prices, supplemental.table),
        customPrices: config.prices || {}, configFile, version: '0.1.0' };
      return snapshot;
    })().finally(() => { pending = null; });
    return pending;
  };
  async function body(req) {
    let size = 0, chunks = [];
    for await (const chunk of req) {
      size += chunk.length; if (size > 20 * 1024 * 1024) throw new Error('Import exceeds 20 MB.'); chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const server = http.createServer(async (req, res) => {
    const send = (code, data, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      res.end(type === 'application/json' ? JSON.stringify(data) : data);
    };
    try {
      const address = server.address(), expected = `127.0.0.1:${address.port}`;
      if (req.headers.host !== expected) return send(403, { error: 'Invalid host.' });
      if (req.headers.origin && req.headers.origin !== `http://${expected}`) return send(403, { error: 'Invalid origin.' });
      const url = new URL(req.url, `http://${expected}`);
      if (url.searchParams.get('token') !== token && req.headers['x-ai-usage-token'] !== token) return send(403, { error: 'Open this dashboard using its launch shortcut.' });
      if (url.pathname === '/api/health' && req.method === 'GET') return send(200, { app: 'ai-usage', root: pluginRoot, buildId, version: '0.1.0' });
      if (url.pathname === '/api/shutdown' && req.method === 'POST') { send(200, { stopped: true }); server.close(); return; }
      if (url.pathname === '/api/data' && req.method === 'GET') return send(200, snapshot || await refresh());
      if (url.pathname === '/api/quotas' && req.method === 'GET') return send(200, { cards: await readQuotas() });
      if (url.pathname === '/api/refresh' && req.method === 'POST') return send(200, await refresh());
      if (url.pathname === '/api/prices/refresh' && req.method === 'POST') return send(200, await refresh(true));
      if (url.pathname === '/api/prices/complete' && req.method === 'POST') {
        if (pending) await pending;
        const before = snapshot || await refresh();
        const unknown = new Set(before.events.filter(e => e.cost === null).map(e => e.model));
        const next = await refresh(true, true);
        const remaining = [...new Set(next.events.filter(e => e.cost === null).map(e => e.model))];
        return send(200, { data: next, resolved: [...unknown].filter(m => !remaining.includes(m)), remaining });
      }
      if (url.pathname === '/api/prices/model' && req.method === 'POST') {
        const request = await body(req);
        if (typeof request.model !== 'string') throw new Error('Identifiant de modèle requis.');
        const checked = validateOverrides({ [request.model]: request.rates });
        if (pending) await pending;
        const current = snapshot || await refresh();
        const rates = ratesToUsd(checked[request.model], request.currency, current.exchange, request.exchangeRate);
        const config = await readConfig();
        await writeConfig({ ...config, prices: { ...config.prices, [request.model]: rates } });
        return send(200, await refresh());
      }
      if (url.pathname === '/api/prices' && req.method === 'POST') {
        const prices = validateOverrides(await body(req));
        // Serialize config changes with any in-flight scan so the response cannot show stale pricing.
        if (pending) await pending;
        const config = await readConfig(); await writeConfig({ ...config, prices });
        return send(200, await refresh());
      }
      if (url.pathname === '/api/import/cursor' && req.method === 'POST') {
        const request = await body(req);
        if (typeof request.csv !== 'string') throw new Error('Choose a Cursor usage CSV.');
        const parsed = cursorCSV(request.csv);
        if (!parsed.events.length) throw new Error('No usable token records found in this CSV.');
        if (pending) await pending;
        const file = path.join(dataDir, 'cursor-events.json'); let existing = [];
        try { existing = JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        const events = new Map(existing.map(e => [e.key, e]));
        const before = events.size; for (const e of parsed.events) events.set(e.key, e);
        await fsp.writeFile(`${file}.tmp`, JSON.stringify([...events.values()])); await fsp.rename(`${file}.tmp`, file);
        return send(200, { data: await refresh(), imported: events.size - before, skipped: parsed.skipped });
      }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method === 'GET' && assets[url.pathname]) {
        const [file, type] = assets[url.pathname]; let content = await fsp.readFile(path.join(pluginRoot, 'web', file), 'utf8');
        if (file === 'index.html') content = content.replaceAll('__TOKEN__', token);
        return send(200, content, type);
      }
      return send(404, { error: 'Not found.' });
    } catch (e) { return send(400, { error: e.message }); }
  });
  return { server, token, refresh };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = defaultDataDir();
  const app = await createApp({ dataDir, home: process.env.AI_USAGE_HOME || os.homedir() });
  app.server.listen(0, '127.0.0.1', async () => {
    const url = `http://127.0.0.1:${app.server.address().port}/?token=${app.token}`;
    await fsp.writeFile(path.join(dataDir, 'server.json'), JSON.stringify({ url, pid: process.pid, root: pluginRoot }));
    console.log(url);
  });
  app.server.on('error', e => { console.error(e.message); process.exitCode = 1; });
}
