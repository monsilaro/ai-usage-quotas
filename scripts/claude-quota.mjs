import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeWindows } from './quotas.mjs';

export async function installClaudeRelay(home, dataDir) {
  const root = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const file = path.join(root, 'settings.json');
  let settings = {}, raw;
  try { raw = await fs.readFile(file, 'utf8'); settings = JSON.parse(raw); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Impossible de lire les réglages Claude Code.'); }
  if (settings.statusLine?.command?.includes('ai-usage-claude-relay.mjs')) return { message: 'Relais déjà activé. Utilisez Claude Code, puis actualisez les quotas.' };
  if (settings.statusLine) throw new Error('Une barre de statut existe déjà. Elle est conservée. Ajoutez le relais à votre script actuel en suivant le README du plugin.');
  await fs.mkdir(dataDir, { recursive: true });
  // Stable path outside the versioned plugin cache. Keep the implementation self-contained in this launcher.
  const relay = path.join(dataDir, 'ai-usage-claude-relay.mjs');
  const source = `import fs from 'node:fs/promises';\nlet input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>1048576)process.exit(0);}\ntry{const value=JSON.parse(input);const rate_limits={};for(const key of ['five_hour','seven_day','spend_limit']){const w=value.rate_limits?.[key];if(typeof w?.used_percentage==='number'&&Number.isFinite(w.used_percentage)&&w.used_percentage>=0)rate_limits[key]={used_percentage:w.used_percentage,resets_at:typeof w.resets_at==='number'?w.resets_at:null};}const file=${JSON.stringify(path.join(dataDir, 'claude-quota.json'))};const tmp=file+'.'+process.pid+'.tmp';await fs.writeFile(tmp,JSON.stringify({observedAt:Date.now(),rate_limits}),{mode:0o600});await fs.rename(tmp,file);const w=rate_limits.seven_day;process.stdout.write(w?'Semaine : '+w.used_percentage+' % utilisés':'AI Usage · limites en attente');}catch{}\n`;
  await fs.writeFile(relay, source);
  // Claude runs status-line commands through a shell: quote paths, never interpolate user data.
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = `${quote(process.execPath.replaceAll('\\', '/'))} ${quote(relay.replaceAll('\\', '/'))}`;
  await fs.mkdir(root, { recursive: true });
  if (raw) await fs.writeFile(`${file}.ai-usage-${Date.now()}.bak`, raw, { flag: 'wx' });
  await fs.writeFile(`${file}.ai-usage.tmp`, JSON.stringify({ ...settings, statusLine: { type: 'command', command } }, null, 2));
  await fs.rename(`${file}.ai-usage.tmp`, file);
  return { message: 'Relais activé. Ouvrez Claude Code et envoyez votre prochaine demande habituelle; les quotas seront transmis après sa réponse.' };
}

// Can also be called from an existing status-line script, passing the original JSON on stdin.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 1024 * 1024) process.exit(0); }
  try {
    const value = JSON.parse(input), rate_limits = {};
    for (const [key, label] of [['five_hour', '5 heures'], ['seven_day', 'Semaine'], ['spend_limit', 'Limite de dépenses']]) {
      const w = claudeWindows(value).find(w => w.label === label);
      if (w) rate_limits[key] = { used_percentage: w.usedPercent, resets_at: w.resetsAt === null ? null : w.resetsAt / 1000 };
    }
    const dir = process.env.AI_USAGE_DATA_DIR || path.join(os.homedir(), '.local/share/ai-usage');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'claude-quota.json'), tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ observedAt: Date.now(), rate_limits }), { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch { /* Never break an existing status line. */ }
}
