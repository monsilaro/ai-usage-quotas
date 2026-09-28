import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const finite = n => typeof n === 'number' && Number.isFinite(n);
export function sanitizeQuota(provider, value, now = Date.now()) {
  if (provider === 'claude') {
    const rate_limits = {};
    for (const key of ['five_hour', 'seven_day', 'spend_limit']) {
      const w = value?.rate_limits?.[key];
      if (finite(w?.used_percentage) && w.used_percentage >= 0) rate_limits[key] = {
        used_percentage: w.used_percentage, resets_at: finite(w.resets_at) ? w.resets_at : null
      };
    }
    return Object.keys(rate_limits).length ? { observedAt: now, rate_limits } : null;
  }
  if (provider === 'antigravity') {
    const quota = {};
    for (const [key, w] of Object.entries(value?.quota || {})) {
      if (!/^[\w .:/()-]{1,120}$/.test(key) || !finite(w?.remaining_fraction) || w.remaining_fraction < 0 || w.remaining_fraction > 1) continue;
      const reset = typeof w.reset_time === 'string' ? Date.parse(w.reset_time) : NaN;
      quota[key] = { remaining_fraction: w.remaining_fraction, reset_time: Number.isFinite(reset) ? new Date(reset).toISOString() : null };
    }
    return Object.keys(quota).length ? { observedAt: now, quota } : null;
  }
  return null;
}

export async function saveQuota(provider, value, dataDir) {
  const snapshot = sanitizeQuota(provider, value);
  // Startup payloads may omit quotas. Do not erase a valid prior observation.
  if (!snapshot) return false;
  await fs.mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, `${provider}-quota.json`), tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
  await fs.rename(tmp, file);
  return true;
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  const [provider, dataDir, originalFile] = process.argv.slice(2);
  if (!['claude', 'antigravity'].includes(provider) || !dataDir) process.exit(1);
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 1048576) process.exit(0); }
  try { await saveQuota(provider, JSON.parse(input), dataDir); } catch { /* Never break a status line. */ }
  let original;
  try { original = originalFile ? JSON.parse(await fs.readFile(originalFile, 'utf8')) : null; } catch {}
  if (original?.command) {
    // Run the existing, locally configured status line unchanged, with the same stdin.
    const child = spawn(original.command, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
    const stop = () => { child.kill(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    child.on('error', () => {}); child.stdin.on('error', () => {}); child.stdin.end(input);
    child.on('exit', () => { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); });
  } else process.stdout.write('AI Usage · quotas synchronisés');
}
