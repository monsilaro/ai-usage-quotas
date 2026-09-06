import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const number = v => typeof v === 'number' && Number.isFinite(v);
export function quotaWindow(label, percent, reset, minutes = null) {
  if (!number(percent) || percent < 0) return null;
  const resetsAt = typeof reset === 'string' ? Date.parse(reset) : number(reset) ? reset * 1000 : null;
  return { label, usedPercent: percent, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null, minutes };
}
export function codexWindows(result) {
  const limits = result?.rateLimitsByLimitId ? Object.values(result.rateLimitsByLimitId) : [result?.rateLimits || result];
  return limits.flatMap(limit => ['primary', 'secondary'].map(key => {
    const w = limit?.[key];
    if (!w) return null;
    const minutes = w.windowDurationMins ?? w.window_minutes;
    const duration = minutes === 10080 ? 'Semaine' : minutes === 300 ? '5 heures' : number(minutes) ? `${minutes} min` : key === 'primary' ? 'Limite principale' : 'Limite secondaire';
    const id = limit.limitName || limit.limit_name || limit.limitId || limit.limit_id;
    return quotaWindow(id && id !== 'codex' ? `${id} · ${duration}` : duration, w.usedPercent ?? w.used_percent, w.resetsAt ?? w.resets_at, minutes);
  })).filter(Boolean);
}
export function claudeWindows(value) {
  return [['five_hour', '5 heures', 300], ['seven_day', 'Semaine', 10080], ['spend_limit', 'Limite de dépenses', null]]
    .map(([key, label, minutes]) => quotaWindow(label, value?.rate_limits?.[key]?.used_percentage, value?.rate_limits?.[key]?.resets_at, minutes)).filter(Boolean);
}
export function goWindows(value) {
  return [['rolling', '5 heures', 300], ['weekly', 'Semaine', 10080], ['monthly', 'Mois', null]]
    .map(([key, label, minutes]) => quotaWindow(label, value?.usage?.[key]?.percent, value?.usage?.[key]?.resetsAt, minutes)).filter(Boolean);
}
export function grokSnapshot(row) {
  if (row?.msg !== 'billing: fetched credits config') return null;
  const observedAt = Date.parse(row.ts);
  if (!Number.isFinite(observedAt) || observedAt > Date.now() + 60000) return null;
  const config = row.ctx?.config;
  const period = config?.currentPeriod;
  const weekly = period?.type === 'USAGE_PERIOD_TYPE_WEEKLY';
  const label = weekly ? 'Semaine' : period?.type === 'USAGE_PERIOD_TYPE_MONTHLY' ? 'Mois' : 'Période du forfait';
  const window = quotaWindow(label, config?.creditUsagePercent, period?.end, weekly ? 10080 : null);
  return { observedAt, windows: window ? [window] : [], plan: typeof row.ctx?.subscriptionTier === 'string' ? row.ctx.subscriptionTier.slice(0, 100) : null };
}
export async function readGrok(home, env = process.env) {
  const file = path.join(env.GROK_HOME || path.join(home, '.grok'), 'logs/unified.jsonl');
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    // Only scan the recent tail. Never return log messages, paths, account IDs or credentials.
    const length = Math.min(size, 8 * 1024 * 1024), start = size - length;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let raw = buffer.subarray(0, bytesRead).toString('utf8');
    if (start) raw = raw.slice(raw.indexOf('\n') + 1);
    let latest = null;
    for (const line of raw.split('\n')) {
      if (!line.includes('billing: fetched credits config')) continue;
      try {
        const snapshot = grokSnapshot(JSON.parse(line));
        if (snapshot && (!latest || snapshot.observedAt >= latest.observedAt)) latest = snapshot;
      } catch { /* A partial last line may be written while we read. */ }
    }
    if (!latest?.windows.length) throw new Error('Aucun quota récent dans le journal Grok. Ouvrez Grok Build et lancez /usage, puis actualisez les quotas.');
    return latest;
  } catch (error) {
    if (error.code) throw new Error('Journal Grok indisponible. Ouvrez Grok Build et lancez /usage pour enregistrer votre quota.');
    throw error;
  } finally { await handle?.close(); }
}
let grokRefreshPending, grokRefreshAt = 0;
export async function refreshGrok(home = os.homedir()) {
  if (grokRefreshPending) return grokRefreshPending;
  if (Date.now() - grokRefreshAt < 60000) throw new Error('Patientez une minute entre deux actualisations Grok.');
  grokRefreshAt = Date.now();
  grokRefreshPending = (async () => {
    const startedAt = Date.now();
    const executable = path.join(process.env.GROK_HOME || path.join(home, '.grok'), 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok');
    const child = spawn(executable, ['--minimal'], { cwd: home, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    let failed = false;
    child.on('error', () => { failed = true; });
    child.stdin.on('error', () => {});
    try {
      for (let i = 0; i < 30; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (failed) throw new Error('Impossible de démarrer Grok Build. Vérifiez son installation.');
        const snapshot = await readGrok(home).catch(() => null);
        if (snapshot?.observedAt >= startedAt) return snapshot;
      }
      throw new Error('Grok n’a pas fourni de nouveau relevé. Vérifiez votre connexion dans Grok Build.');
    } finally { child.stdin.destroy(); child.kill(); }
  })().finally(() => { grokRefreshPending = null; });
  return grokRefreshPending;
}
export async function readCodex(home = os.homedir()) {
  const candidates = [process.env.AI_USAGE_CODEX_BIN, path.join(home, '.codex/packages/standalone/current/bin/codex.exe'), path.join(home, '.local/bin/codex')].filter(Boolean);
  let executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const candidate of candidates) { try { await fs.access(candidate); executable = candidate; break; } catch {} }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['app-server'], { cwd: home, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = readline.createInterface({ input: child.stdout });
    let finished = false;
    const timer = setTimeout(() => finish(new Error('Délai de lecture Codex dépassé.')), 15000);
    function finish(error, value) {
      if (finished) return; finished = true;
      clearTimeout(timer); lines.close(); child.stdin.end(); child.kill();
      error ? reject(error) : resolve(value);
    }
    const send = v => { if (!finished) child.stdin.write(JSON.stringify(v) + '\n'); };
    child.on('error', () => finish(new Error('CLI Codex introuvable.')));
    child.stdin.on('error', () => finish(new Error('Connexion Codex interrompue.')));
    child.on('exit', () => finish(new Error('Lecture Codex indisponible.')));
    lines.on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.id === 0) {
        if (msg.error) return finish(new Error('Initialisation Codex indisponible.'));
        send({ method: 'initialized', params: {} });
        send({ method: 'account/rateLimits/read', id: 1 });
      }
      if (msg.id === 1) {
        if (msg.error) return finish(new Error('Quota Codex inaccessible. Vérifiez votre connexion au forfait dans Codex.'));
        finish(null, msg.result);
      }
    });
    send({ method: 'initialize', id: 0, params: { clientInfo: { name: 'ai_usage', title: 'AI Usage', version: '0.1.0' } } });
  });
}
export async function readGo(home, fetcher = fetch, env = process.env) {
  // Only the Go credential is selected; it is sent only to the provider's fixed usage endpoint.
  const authFile = path.join(env.XDG_DATA_HOME || path.join(home, '.local/share'), 'opencode/auth.json');
  let auth;
  try { auth = env.OPENCODE_AUTH_CONTENT ? JSON.parse(env.OPENCODE_AUTH_CONTENT) : JSON.parse(await fs.readFile(authFile, 'utf8')); }
  catch { throw new Error('Connexion OpenCode Go introuvable. Connectez ce fournisseur dans OpenCode.'); }
  const entry = auth['opencode-go'];
  if (entry?.type !== 'api' || typeof entry.key !== 'string' || !entry.key) throw new Error('OpenCode Go non connecté dans OpenCode.');
  const response = await fetcher('https://opencode.ai/zen/go/v1/usage', { headers: { Authorization: `Bearer ${entry.key}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(response.status === 401 ? 'Connexion OpenCode Go expirée.' : response.status === 403 ? 'Aucun forfait Go accessible avec cette connexion.' : `Lecture OpenCode Go indisponible (HTTP ${response.status}).`);
  return response.json();
}
export function createQuotaReader(home, dataDir, adapters = {}) {
  let cache, pending, attemptedAt = 0;
  const read = async (force = false) => {
    const now = Date.now();
    if (pending) return pending;
    if (!force && cache && now - attemptedAt < 60000) return cache;
    attemptedAt = now;
    pending = (async () => {
      const cards = [
        { id: 'codex', name: 'Codex', url: 'https://chatgpt.com/codex/settings/usage', source: 'Compte Codex' },
        { id: 'grok', name: 'Grok', url: 'https://grok.com', source: 'Dernier relevé local Grok Build' },
        { id: 'opencode', name: 'OpenCode Go', url: 'https://opencode.ai/auth', source: 'Compte OpenCode Go' }
      ];
      return Promise.all(cards.map(async card => {
        try {
          let windows, observedAt = Date.now();
          if (card.id === 'codex') {
            const result = await (adapters.codex || readCodex)(home);
            windows = codexWindows(result);
            const plan = result.rateLimits?.planType || Object.values(result.rateLimitsByLimitId || {}).find(limit => limit.planType)?.planType;
            if (typeof plan === 'string' && plan.trim()) {
              const label = ({ prolite: 'Pro Lite', pro: 'Pro', plus: 'Plus', free: 'Free', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' })[plan.toLowerCase()] || plan.slice(0, 100);
              card.name = `Codex · ${label}`;
            }
          }
          if (card.id === 'opencode') windows = goWindows(await (adapters.go || readGo)(home));
          if (card.id === 'grok') {
            const snapshot = await (adapters.grok || readGrok)(home);
            windows = snapshot.windows; observedAt = snapshot.observedAt;
            if (snapshot.plan) card.name = `Grok · ${snapshot.plan}`;
            card.message = 'Relevé du forfait partagé. Actualisez Grok pour obtenir un nouveau relevé en arrière-plan.';
          }
          if (!windows.length) throw new Error('Aucune limite de forfait fournie par cette connexion.');
          return { ...card, windows, observedAt, status: 'available' };
        } catch (error) {
          const previous = cache?.find(c => c.id === card.id && c.windows.length);
          return { ...card, windows: previous?.windows || [], observedAt: previous?.observedAt || null, status: 'unavailable', message: error.message?.startsWith('fetch') ? 'Service temporairement inaccessible.' : error.message };
        }
      }));
    })().then(cards => { cache = cards; return cards; }).finally(() => { pending = null; });
    return pending;
  };
  return read;
}
