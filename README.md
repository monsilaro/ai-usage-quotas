# AI Usage

A local, multi-tool usage dashboard packaged as a Codex plugin and skill. Requires **Node.js 22.16+**. No npm packages, account connection or API key required.

## Open

- Windows: double-click **Open AI Usage.cmd**.
- Any OS: `node scripts/launch.mjs` from this plugin folder.
- Codex, after plugin installation and a new chat: “Ouvre mon dashboard AI Usage.”
- CLI summary: `node scripts/launch.mjs --json` (rolling seven days).
- URL only: `node scripts/launch.mjs --no-open`.

The launcher starts a background server on a random **127.0.0.1** port and reuses it on subsequent launches. Its URL contains a local access token. The dashboard never binds to a LAN interface. No cloud deployment is required. Stop its process using the PID in the data directory's `server.json`; launch again to restart after updating the plugin.

## Sources and coverage

| Tool | Supported history | Default source |
| --- | --- | --- |
| Codex | JSONL rollouts, including archived sessions | `~/.codex/sessions`, `~/.codex/archived_sessions` |
| Claude Code | Assistant usage in JSONL, including subagent folders | `~/.claude/projects` |
| Gemini CLI | Legacy JSON and current JSONL chat records | `~/.gemini/tmp/**/session-*.json[l]` |
| Antigravity CLI / IDE / 2.0 | SQLite generation counters (schema dependent) | `~/.gemini/{antigravity-cli,antigravity-ide,antigravity}/conversations/*.db` |
| Grok Build | Completed-turn usage in `updates.jsonl` | `~/.grok/sessions` |
| OpenCode | SQLite `message` table, or legacy `storage/message` JSON files | `~/.local/share/opencode` |
| Cursor | Imported dashboard usage CSV with input/cache/output token columns | Sources → Importer Cursor |

OpenCode's newer `session_message` format is detected and explicitly marked as partial when populated; this release reads the legacy `message` table. Cursor isn't read from its private editor database. Export usage from Cursor's account dashboard, then import that CSV. Different column order and extra columns are accepted. Usage rows without tokens can't be reconstructed. Exported `Cost` values are deliberately not used as API-equivalent prices. Cursor session counts remain unavailable unless a session ID is included.

T3 isn't a separate source: sessions driven through T3 are already present in the underlying tool histories. Counting both would inflate usage.

Sources that are absent, empty, malformed, unreadable or partially supported are visible in the Sources dialog. A source that has no recorded counters does not prove zero usage. Deleted/expired histories, other machines/accounts and unrecorded turns are not reconstructed. Archived Gemini rewinds in JSONL are retained as spent usage, though history removed from a legacy JSON snapshot cannot be recovered.

## Pricing and accounting

All recorded model IDs are supported for token counting. A downloaded [LiteLLM catalog](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) supplies estimated base USD rates. Downloaded prices are cached for 24 hours; offline mode uses the saved copy. A missing model is **unpriced**, never assumed free. Conflicting provider aliases are not guessed. The supplemental models.dev catalog downloads automatically on first use and refreshes daily. Explicit equivalents are shown beside the model: `codex-auto-review` → `gpt-5.6-sol` (user-selected), `grok-4.5-build` → `grok-4.5`, and `grok-4.6-build` → `grok-4.6`. Custom prices still take precedence. Grok equivalents use base API rates; per-request context tiers cannot be recovered from aggregated turn counters. Sources: [Grok 4.5](https://docs.x.ai/developers/models/grok-4.5), [Grok 4.6](https://docs.x.ai/developers/models/grok-4.6).

Use **Tarifs des modèles** to enter exact model IDs and input, cache read, cache write and output prices per million tokens. Zero is allowed explicitly. Custom rates take precedence. Removing a custom price returns to catalog pricing. These are current-rate API-equivalent estimates, **not subscription invoices, remaining quotas or guaranteed historical charges**. Priority/flex, context tiers and negotiated discounts are not inferred.

Codex/Grok cache is included in reported input and is subtracted before pricing uncached input. Claude/OpenCode input excludes cache. Codex/Grok reasoning is already inside output; Gemini/OpenCode reasoning is added to their separate output counters. Repeated Claude blocks, duplicate files and Codex usage notifications are deduplicated. Codex fork-prefix suppression uses the same timing approach as T3 (leading copied events within one second); an unusual rollout format may require a parser update. When a cumulative counter is present, identical legitimate Codex requests remain separate.

Days and charts use the browser's local timezone. “7 jours” covers today plus six previous calendar days; “24 h” is a rolling 24-hour period. “Tout” covers available recorded history. The chart draws one line per model (smallest models grouped as « Autres »); the current day or hour is dashed because it is still in progress. Sidebar tools act as filters, and table columns sort on click. Unknown-cost tokens remain visible and cost totals are labeled partial. CSV exports aggregate only tool/model/day and counters, omitting conversations, paths and session IDs. CSV exports include CAD and USD estimates plus the conversion rate and its date.

## Configuration and privacy

Data directory: `~/.local/share/ai-usage`, overridable using `AI_USAGE_DATA_DIR`. It contains `config.json`, cached prices, normalized imported Cursor counters, server state and a server log. Parsed transcripts are held in memory, cached by file size and modification time and reread when changed; they are not copied to disk. File contents are read to extract metadata, but prompts and responses are not returned to the UI or sent over the network. The history dashboard fetches public LiteLLM/models.dev price catalogs and the Bank of Canada exchange rate. Subscription cards additionally contact the signed-in Codex account through its app-server and the OpenCode Go usage endpoint through its existing local Go credential. No transcript or model usage is sent with these requests. There is no analytics/telemetry or team upload.

`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME`, `GEMINI_CLI_HOME` and `XDG_DATA_HOME` are honored. To change individual source roots, edit the plugin's `config.json` and refresh. Roots point to the folders shown in the Sources table, not to an arbitrary home folder. Use arrays to include multiple accounts or `[]` to disable a source:

```json
{
  "paths": {
    "codex": ["C:/Users/you/.codex/sessions", "C:/Users/you/.codex/archived_sessions"],
    "claude": ["C:/Users/you/.claude/projects"],
    "opencode": ["C:/Users/you/.local/share/opencode"]
  },
  "prices": {}
}
```

The dashboard reads source histories without editing them. An explicit Grok refresh launches Grok Build, which can write its own normal local logs and runtime state. OpenCode opens SQLite in read-only/query-only mode. For quota reads only, the backend selects the opencode-go credential from OpenCode auth.json (or OPENCODE_AUTH_CONTENT), sends it only to the fixed HTTPS opencode.ai usage endpoint with redirects disabled, and never returns it to the browser or logs. Codex manages its own connection. The dashboard does not read Grok or Claude credentials or browser cookies. A background Grok Build process uses its existing sign-in to fetch billing information. All HTTP routes require the launch token and a loopback Host; cross-origin requests are rejected. CSV imports are limited to 20 MB and persist only normalized counters. Overlapping Cursor exports are deduplicated by request ID when present, otherwise by exact row and occurrence; exports that change historical row metadata without request IDs can require clearing `cursor-events.json` and reimporting a single complete export.

## Development and sharing

Run `node --test tests/*.test.mjs`. Tests cover accounting, local server access, pricing, currency conversion, quota schemas, provider isolation, request caching and the Claude relay.

The plugin is self-contained and can be copied to another machine with Node.js. Runtime data is outside the plugin so it isn't included when the plugin is shared. Add adapters in `scripts/parsers.mjs` and discovery in `scripts/collector.mjs`; keep the normalized record contract and report unsupported schemas.

Implementation references: [T3 transcripts](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/usage/usageTranscripts.ts), [T3 pricing](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/usage/usagePricing.ts), [Gemini recording types](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingTypes.ts), [OpenCode SQLite schema](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/sql.ts). See `THIRD_PARTY_NOTICES.md` for T3 attribution.

## Subscription quotas

The **Forfaits** sidebar tab has its own view, separate from the default **Coûts et activité** page. Each provider occupies one row with its first two windows visible side by side (5 hours before weekly); additional windows and provenance are under **Source et détails**. Accounts without observations are grouped under **Autres fournisseurs**. Open `#forfaits` directly or use browser Back to return between views; cost filters are preserved. Quotas are read only while the Forfaits view is visible, so the costs page does not start quota-provider requests. Expanded details remain open during refresh. They show provider-reported percentages, remaining allowance, window length, reset time and observation time. They are account-wide, independent of history filters, and never calculated from token totals or API estimates. The browser refreshes while visible, at most once per minute per server. Read errors retain the previous observation explicitly marked old. A passed reset time means a fresh observation is required, never an assumed zero.

- **Codex:** Uses `codex app-server` and `account/rateLimits/read`, including separate model buckets. It starts no thread and sends no model prompt. The CLI is discovered on PATH, in the Codex app installation or via `AI_USAGE_CODEX_BIN`.
- **Claude Code:** Reads the official status-line `rate_limits` payload through a local relay. **Autres fournisseurs → Connecter le CLI** wraps the existing command and preserves its output and status-line settings. A dated settings backup is created first. A new observation arrives on the next normal status-line update; no model prompt is sent. Empty payloads do not erase earlier observations.
- **Antigravity quotas:** Optional CLI status-line relay reads `quota` fractions and reset dates. Enable it from the Antigravity card on the machine running that CLI. The quota is separate from Gemini CLI, and IDE-only live quota retrieval is not implemented.
- **OpenCode Go:** Uses `GET https://opencode.ai/zen/go/v1/usage`. Sign into the `opencode-go` provider in OpenCode first. The stored API credential is used only for that provider request. An unavailable endpoint or missing subscription is reported explicitly.
- **Grok:** Reads the latest billing snapshot from the last 8 MiB of `~/.grok/logs/unified.jsonl` (honoring `GROK_HOME`). Shows provider-reported usage, period end and subscription tier with the original observation time. This is the shared subscription quota, not just Build token usage. Use **Actualiser Grok** on its card to request a fresh snapshot in the background. Grok Build must be installed and already signed in.

### Refreshing Grok

**Actualiser les quotas** and the automatic visible-page refresh reread quota sources; they do not launch Grok. Visiting the usage page on grok.com does not update the local Grok Build log.

**Actualiser Grok** starts the installed Grok Build executable with `--minimal`, with its window hidden on Windows and no model prompt. Grok uses its existing connection to retrieve billing information. The dashboard checks the local log once per second for an observation recorded after the refresh began, then requests termination of the process it launched. It also requests termination on error or after 30 polling attempts (about 30 seconds). Other existing Grok sessions are not targeted; the dashboard does not inspect or terminate descendant or shared leader processes.

Repeated requests share an in-progress refresh, with at least one minute between launch attempts. The button displays **Actualisation…**, then the card updates its percentage and observation time. If no fresh observation arrives, an error is shown and the previous observation is not relabeled as current. Check the Grok Build installation and sign-in; running `/usage` manually in Grok Build remains a fallback.

Observations older than 15 minutes, or unavailable readings, are displayed as **Ancien relevé** with reduced opacity. This explains why Grok can appear darker than Codex. Passed reset times require a fresh reading; the dashboard never assumes usage has become zero. Reset countdowns use discreet text; exact dates remain available in their tooltip and observation metadata under Source et détails.

### Antigravity history and Gemini coverage

Gemini CLI history is already supported separately (legacy JSON and JSONL snapshots). Sources shows the last recorded date even when the selected history period contains no events. This does not fetch Gemini CLI account quotas; use `/stats model` inside Gemini CLI for those.

Antigravity automatically discovers the three standard roots above on the machine where this skill runs. Override them through `config.json` with `paths.antigravity` pointing to app-data roots, not conversation subfolders. SQLite is opened read-only and query-only. Generation metadata supplies uncached input, cache reads and output including reasoning. Identical conversation/step records found in multiple roots are deduplicated. Missing timestamps are not replaced with file modification times. Unknown numeric model IDs remain explicit and unpriced; a different model from the same conversation is never substituted.

The SQLite/protobuf format is undocumented by Google and may change. The adapter uses the observed `steps`, `gen_metadata` and `executor_metadata` storage layouts described by the maintainers of [Antigravity Usage Intelligence](https://github.com/Nir-Bhay/antigravity-usage-intelligence) and [txcript](https://docs.rs/crate/txcript/latest/source/docs/formats/antigravity.md). The implementation is independently written and tested using synthetic SQLite fixtures. No real Antigravity installation was available for this change: validate on the recipient’s version before treating coverage as complete. Older `.pb` stores, corrupt rows, missing dates and unfamiliar schemas are marked partial. The text transcripts are not used to estimate tokens.

The optional quota relay uses the [official Antigravity CLI status-line schema](https://antigravity.google/docs/cli/statusline/). It saves only normalized quotas and observation time. It does not read Google OAuth credentials, conversation contents, email or context-window counters. A CLI observation is not presented as a fresh IDE reading.

To restore a status line after enabling a relay, restore only its `statusLine` field from the dated `settings.json.ai-usage-*.bak` backup. Preserve any later unrelated settings changes.

References: [Codex account limits](https://learn.chatgpt.com/docs/app-server), [Claude status-line rate_limits](https://code.claude.com/docs/en/statusline), [OpenCode Go usage endpoint](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/go/v1/usage.ts), [Grok weekly limits](https://docs.x.ai/grok/faq).

Claude cards and token history are enabled. Both Claude and Antigravity relays run locally and preserve existing status-line output. No transcript payload is persisted by a quota relay.
