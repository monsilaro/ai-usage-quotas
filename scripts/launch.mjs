import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { defaultDataDir, pluginRoot, buildId } from './server.mjs';

const dataDir = defaultDataDir();
await fsp.mkdir(dataDir, { recursive: true });
async function running() {
  try {
    const info = JSON.parse(await fsp.readFile(path.join(dataDir, 'server.json'), 'utf8'));
    const url = new URL(info.url); if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') return null;
    url.pathname = '/api/health';
    const health = await (await fetch(url, { signal: AbortSignal.timeout(1000) })).json();
    if (health.app !== 'ai-usage') return null;
    if (health.buildId === buildId) return info.url;
    // Source-folder and installed-cache launchers share one server; changed code restarts it.
    url.pathname = '/api/shutdown';
    await fetch(url, { method: 'POST', signal: AbortSignal.timeout(1000) });
    return null;
  } catch { return null; }
}
let url = await running();
if (!url) {
  const log = fs.openSync(path.join(dataDir, 'server.log'), 'a');
  const child = spawn(process.execPath, [path.join(pluginRoot, 'scripts', 'server.mjs')],
    { detached: true, windowsHide: true, stdio: ['ignore', log, log], env: process.env });
  child.on('error', e => { console.error(e.message); process.exitCode = 1; }); child.unref(); fs.closeSync(log);
  for (let i = 0; i < 40 && !url; i++) { await new Promise(resolve => setTimeout(resolve, 250)); url = await running(); }
  if (!url) throw new Error(`Dashboard did not start. Check ${path.join(dataDir, 'server.log')}`);
}
if (process.argv.includes('--json')) {
  const endpoint = new URL(url); endpoint.pathname = '/api/data';
  const data = await (await fetch(endpoint)).json();
  const since = Date.now() - 7 * 86400000;
  const totals = { tokens: 0, estimatedUsd: 0, unpricedTokens: 0 };
  for (const e of data.events || []) if (e.time >= since) {
    totals.tokens += e.total; if (e.cost === null) totals.unpricedTokens += e.total; else totals.estimatedUsd += e.cost;
  }
  totals.estimatedCad = data.exchange?.rate ? totals.estimatedUsd * data.exchange.rate : null;
  console.log(JSON.stringify({ url, period: 'last 7 x 24 hours', totals, exchange: data.exchange, sources: data.sources, pricing: data.pricing }, null, 2));
} else console.log(url);
if (!process.argv.includes('--no-open') && !process.argv.includes('--json')) {
  // Spawn argument arrays, never interpolate the token URL into shell code.
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const browser = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  browser.on('error', () => console.error('Open the URL above in your browser.')); browser.unref();
}
