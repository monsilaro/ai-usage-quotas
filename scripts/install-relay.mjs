import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function installRelay(provider, home, dataDir, env = process.env) {
  if (!['claude', 'antigravity'].includes(provider)) throw new Error('Relais non pris en charge.');
  const root = provider === 'claude' ? env.CLAUDE_CONFIG_DIR || path.join(home, '.claude') : env.ANTIGRAVITY_CLI_HOME || path.join(env.GEMINI_CLI_HOME || home, '.gemini/antigravity-cli');
  const file = path.join(root, 'settings.json');
  let settings = {}, raw;
  try { raw = await fs.readFile(file, 'utf8'); settings = JSON.parse(raw); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Impossible de lire les réglages de la barre de statut.'); }
  if (!settings || Array.isArray(settings) || typeof settings !== 'object') throw new Error('Réglages non valides.');
  const relay = path.join(dataDir, `ai-usage-${provider}-relay.mjs`);
  const originalFile = path.join(dataDir, `${provider}-original-statusline.json`);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.copyFile(fileURLToPath(new URL('./statusline-relay.mjs', import.meta.url)), relay);
  if (settings.statusLine?.command?.includes(relay)) return { message: 'Relais déjà activé; il sera actualisé à la prochaine mise à jour de la barre de statut.' };
  if (settings.statusLine && (settings.statusLine.type !== 'command' || typeof settings.statusLine.command !== 'string')) throw new Error('Barre de statut non reconnue; réglages conservés.');
  const original = settings.statusLine || null;
  await fs.writeFile(originalFile, JSON.stringify(original), { mode: 0o600 });
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = [process.execPath.replaceAll('\\', '/'), relay.replaceAll('\\', '/'), provider, dataDir.replaceAll('\\', '/'), originalFile.replaceAll('\\', '/')].map(quote).join(' ');
  await fs.mkdir(root, { recursive: true });
  if (raw) await fs.writeFile(`${file}.ai-usage-${Date.now()}.bak`, raw, { flag: 'wx', mode: 0o600 });
  // Preserve padding, enabled, refresh interval and every unrelated setting.
  const next = { ...settings, statusLine: { ...original, type: 'command', command } };
  if (provider === 'antigravity' && !original) next.statusLine.stack_with_default = true;
  await fs.writeFile(`${file}.ai-usage.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
  await fs.rename(`${file}.ai-usage.tmp`, file);
  return { message: 'Relais activé. La barre existante est conservée; utilisez le CLI pour recevoir un nouveau relevé.' };
}
