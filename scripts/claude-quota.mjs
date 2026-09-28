import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installRelay } from './install-relay.mjs';
import { saveQuota } from './statusline-relay.mjs';
export const installClaudeRelay = (home, dataDir) => installRelay('claude', home, dataDir);

// Optional silent relay for a user-maintained status-line script.
if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 1048576) process.exit(0); }
  try { await saveQuota('claude', JSON.parse(input), process.env.AI_USAGE_DATA_DIR || path.join(os.homedir(), '.local/share/ai-usage')); }
  catch { /* Never break an existing status line. */ }
}
