I have everything I need. I'll now produce the design + build plan as markdown, grounded in the actual codebase conventions (paths.ts data-root, NDJSON store pattern, confidence-source honesty model, lazy registry, json-stdio hook entrypoint, and the existing CLI dispatch).

# Host Usage Telemetry — Design + Build Plan

`agentconnect` already ships **per-MCP serve-proxy telemetry** (`src/telemetry/*`): the framework tokenizes its own MCP bytes and records `ToolEventRecord` rows with an honest `ConfidenceSource`. This subsystem is the complement: a read-only **host usage** layer under `src/usage/` that parses each agent CLI's *native* session logs/DBs (porting tokscale's Rust logic) and reports per-platform / per-project / per-session / per-model / per-day token usage. It never writes host config and never collides with the serve-proxy store.

Design rules inherited from the existing code (keep them):
- **Data-root** via `core/paths.ts` (`AGENTCONNECT_DATA_DIR || ~/.agentconnect`). Reuse `dataRoot()`, `ensureDir()`, `projectIdentity()`, and the `normalizeWorkspaceKey` idea. Host *source* roots (`~/.claude`, `~/.codex`, …) are separate from our data-root.
- **Honesty model**: surface provenance. Host-native logs map to a new `UsageConfidence` of `"host-reported"` (the real numbers) vs `"host-estimated"` (Kiro char/4, Crush cost-only). Mirror the existing `worstConfidence` legend pattern in reports.
- **Fail-open + tolerant parse**: a malformed line/file is skipped, never thrown (matches `NdjsonStore.query` and `parseStdin`).
- **Lazy registry**: one entry per reader with a `load()` thunk, exactly like `ADAPTER_REGISTRY`.
- **ESM, Node ≥18.17, zero native build** (engines + pure-JS deps only).

---

## 1. TS module layout under `src/usage/`

```
src/usage/
  types.ts        // UsageRecord, UsageReader, UsageSummary, TokenBreakdown, GroupBy, UsageConfidence
  paths.ts        // per-platform host-root resolution (env override → platform default), expandHome, glob helpers
  normalize.ts    // normalizeModelForGrouping, inferredProviderFromModel, canonicalProvider, normalizeWorkspaceKey/Label
  sqlite.ts       // sql.js wasm loader: openDb(path) → read-only query(sql) → rows; lazy singleton WASM init
  jsonl.ts        // streaming JSONL line reader (tolerant), fileMtimeMs() fallback
  aggregate.ts    // dedup(records) + aggregateBy(records, GroupBy) → UsageSummary[]; sessionization/active-time (phase 2)
  registry.ts     // USAGE_READER_REGISTRY: [{ platformId, format, kind:'local'|'synced', load() }]
  scan.ts         // orchestrator: iterate registry → reader.read() → dedup → aggregate → filter
  report.ts       // formatUsageReport(rows, by) aligned table + CSV/JSON export (mirrors telemetry/report.ts)
  readers/
    claude-code.ts  codex.ts  gemini-cli.ts  qwen.ts  copilot-cli.ts  pi.ts  kimi.ts  openclaw.ts   // JSONL
    amp.ts  droid.ts  codebuff.ts  mux.ts  roo-code.ts  kilo.ts  kiro.ts                            // JSON
    opencode.ts  goose.ts  hermes.ts  kilo-cli.ts  zed.ts  crush.ts  synthetic.ts                   // SQLite
    cursor.ts  antigravity.ts  trae.ts  warp.ts                                                     // synced/cloud
```

### Core contracts (`types.ts`)

```ts
export interface TokenBreakdown {
  input: number; output: number;
  cacheRead: number; cacheWrite: number; reasoning: number;
}
export type UsageConfidence = "host-reported" | "host-estimated";

export interface UsageRecord {
  platformId: PlatformId;        // reuse the existing union from core/types.ts
  modelId: string;               // raw; normalized at aggregation time
  providerId: string;
  sessionId: string;
  projectKey?: string;           // normalized workspace key (when the log carries cwd/dir)
  projectLabel?: string;
  tokens: TokenBreakdown;
  cost?: number;                 // USD, only when the log carries it (pricing is out of scope v1)
  ts: number;                    // epoch ms
  messageCount: number;          // default 1
  dedupKey?: string;             // cross-source de-dup
  confidence: UsageConfidence;
  agent?: string;
}

export interface UsageReader {
  platformId: PlatformId;
  kind: "local" | "synced";      // synced = needs an external API sync we don't perform
  read(opts: { sinceMs?: number }): Promise<UsageRecord[]>;  // [] (never throws) when root absent
}

export type UsageGroupBy = "platform" | "project" | "session" | "model" | "day";

export interface UsageSummary {
  key: string;                   // the group value
  tokens: TokenBreakdown;
  total: number;                 // sum of the 5 token fields
  cost?: number;
  sessions: number;
  messages: number;
  confidence: UsageConfidence;   // worst across the group
  lastTs: number;
}
```

### CLI plug-in

Add one lazy command to the dispatch table in `src/cli/app.ts` (`COMMANDS["usage"] = () => import("./commands/usage.js")`) and a USAGE line. New `src/cli/commands/usage.ts` mirrors `commands/telemetry.ts` (reuse `parseSince`, `parseArgs`, `print`, `fail`, `--json`/`--out`):

```
agentconnect usage report [--by platform|project|session|model|day] [--since 7d] [--platform <id>] [--json]
agentconnect usage export [--format csv|json] [--out <file>] [--since 7d] [--platform <id>]
```

- `report` → `scan({ sinceMs })` → `aggregateBy(records, by)` → `formatUsageReport(rows, by)` (or `JSON.stringify(rows)`).
- `export` → raw deduped `UsageRecord[]` to CSV/JSON.
- Default `--by platform`. Footer note flags any `host-estimated`/`synced-skipped` platforms (honest labeling, same spirit as the existing telemetry legend).

`usage` and `telemetry` stay **distinct top-level commands** (host-native vs MCP-self). Unification is documented in §4.

---

## 2. SQLite dependency decision

**Recommend `sql.js` (SQLite compiled to WASM).** Rationale, weighed against the project's hard constraints (ESM, `engines.node >=18.17`, "without a native build", cross-platform incl. Windows):

- **Pure WASM, zero native build / node-gyp / prebuilt-binary matrix.** Installs identically on Linux/macOS/Windows and in CI — the decisive factor.
- Reads our targets fine: opens a DB file as a `Uint8Array` (`readFileSync` → `new SQL.Database(bytes)`), runs `SELECT` + `json_extract(...)` (OpenCode, Kilo-cli) which sql.js supports.
- Read-only by construction here: we load bytes, query, discard — never write the host DB.
- Lazy single WASM init in `sqlite.ts` so non-SQLite report runs pay nothing.

Caveats and the plan around them:
- **Whole-file load into memory.** Acceptable for these session DBs; if a DB is very large, gate by size and `--since` mtime pre-filter.
- **Locked/WAL DBs**: copy the file (+ `-wal`/`-shm`) to a temp path before opening to avoid reading a half-flushed page (Crush/OpenCode may be live). Tolerant: on open failure, skip with a logged note.
- **Zed needs zstd** to decompress the `data` BLOB. sql.js gets the bytes; decompression is a *separate* concern (`fzstd`, pure-JS). If absent → emit "zed: zstd decode unavailable, skipped" rather than fail.

**Alternatives considered (and why not):**
- `better-sqlite3` — fastest, but **native (node-gyp/prebuilt)**; violates "no native build" and complicates Windows/CI. (Could be an *optional* drop-in behind the `sqlite.ts` interface later, same way the NDJSON store documents a SQLite upgrade path.)
- `node:sqlite` (built-in) — only **stable from Node 22+**; under `>=18.17` it's unavailable/experimental, so not portable yet. Revisit when the floor rises.
- `libsql`/`@libsql/client` — native bindings; same objection as better-sqlite3.

`sqlite.ts` exposes a tiny `interface SqliteDb { all(sql): Row[]; close() }` so any of the above can back it without touching readers.

---

## 3. Build groups (one-by-one porting, by format + difficulty)

Per platform: `platformId · storagePath · format · one-line extraction · confidence`. `LOCAL` = fully readable from disk now; `SYNCED` = needs an external API sync we will **not** perform — implement the cache-file reader where a local artifact exists, otherwise log `"<id>: requires sync, skipped"` and emit zero records.

### (a) JSONL file readers — *start here (highest ROI, no WASM)*
| platformId | storage path | fmt | extraction (one-line) | conf |
|---|---|---|---|---|
| `claude-code` | `~/.claude/projects/*/**.jsonl` (+ subagents, `.json` headless) | jsonl | `message.usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}`; per-field **MAX** merge on `messageId:requestId` | high |
| `codex` | `~/.codex/sessions/*.jsonl` | jsonl | `payload.info.last_token_usage` **delta** vs prev baseline; `input -= cached`; cache_write=0; stateful | high |
| `gemini-cli` | `~/.gemini/tmp/*/{session-*,chats/*}.{json,jsonl}` | jsonl/json | `messages[].tokens.{input,output,cached,reasoning,tool}` w/ alias list; cache-inclusive input normalization | high |
| `qwen-code` | `~/.qwen/projects/*/chats/*.jsonl` | jsonl | `usageMetadata.{promptTokenCount,candidatesTokenCount,thoughtsTokenCount,cachedContentTokenCount}`; role=assistant; no dedup | high |
| `copilot-cli` | `~/.local/share/Copilot/telemetry/*.jsonl`, `~/.config/copilot/telemetry/*.jsonl` | jsonl(OTEL) | `gen_ai.usage.{input_tokens,output_tokens,cache_read.input_tokens,cache_write.input_tokens,reasoning.output_tokens}`; dedup `trace_id:span_id` + `response.id` | high |
| `pi` | `~/.pi/agent/sessions/<cwd>/*.jsonl` | jsonl | `message.usage.{input,output,cacheRead,cacheWrite}`; header line `id`/`cwd`; assistant-only | high |
| `kimi` | `~/.kimi/sessions/*/*/wire.jsonl` (+ `config.json` for model) | jsonl | StatusUpdate `payload.token_usage.{input_other,output,input_cache_read,input_cache_creation}`; dedup by `message_id` (keep max) | high |
| `openclaw` | `<agent-dir>/*.jsonl` (+ legacy `sessions.json`) | jsonl | `message.usage.{input,output,cacheRead,cacheWrite}`; stateful model from `model_change`/snapshot | high |

### (b) JSON file readers
| platformId | storage path | fmt | extraction | conf |
|---|---|---|---|---|
| `amp` | `~/.local/share/amp/threads/*.json` | json | `usageLedger.events[].tokens.*` + `messages[].usage.*` (assistant); merge by message_id/token heuristic | high |
| `droid` | `~/.factory/sessions/*.settings.json` | json | `tokenUsage.{inputTokens,outputTokens,cacheCreationTokens,cacheReadTokens,thinkingTokens}`; custom model normalize | high |
| `codebuff` | `~/.config/manicode[-dev|-staging]/projects/*/chats/*/chat-messages.json` | json | assistant `metadata.usage` (camel+snake variants); session from path | high |
| `mux` | `~/.mux/sessions/<wsId>/session-usage.json` | json | `byModel.<key>.{input,cached,cacheCreate,output,reasoning}.tokens`; provider = key prefix before `:` | high |
| `roo-code` | `<globalStorage>/tasks/<id>/ui_messages.json` (+ `api_conversation_history.json`) | json | `say=api_req_started` text-JSON `{tokensIn,tokensOut,cacheReads,cacheWrites}`; model via XML tags | high |
| `kilo` | `<task-root>/ui_messages.json` | jsonl/json | same `api_req_started` shape; session = parent dir; model from sibling XML | medium |
| `kiro` | `~/.kiro/sessions/cli/*.{json,jsonl}` (+ mac sqlite) | json(+sqlite) | turn `input_token_count`/`output_token_count`; **estimated** (context% or chars/4) when absent → `host-estimated` | medium |

### (c) SQLite readers (need `sql.js`)
| platformId | storage path | fmt | extraction | conf |
|---|---|---|---|---|
| `opencode` | `~/.local/share/opencode/opencode.db` | sqlite | `json_extract(m.data,'$.tokens.{input,output,cache.read,cache.write,reasoning}')`; assistant; fingerprint dedup | high |
| `goose` | `~/.local/share/goose/sessions/sessions.db` (+ variants) | sqlite | columns `accumulated_*_tokens`→fallback `*_tokens`; reasoning inferred = total−in−out; model from `model_config_json` | high |
| `hermes` | `~/.hermes/state.db` | sqlite | flat columns `input_tokens…reasoning_tokens`, `actual/estimated_cost_usd`; `started_at` s/ms disambiguation | high |
| `kilo-cli` | `~/.local/share/kilo/kilo.db` | sqlite | `json_extract(m.data,'$.tokens.*')`; assistant; dedup `m.data.$.id` | high |
| `zed` | `…/zed/threads/threads.db` | sqlite+**zstd** | decompress `data` BLOB → `request_token_usage`/`cumulative_token_usage`; provider hard-coded `zed.dev` | high (partial: needs zstd) |
| `crush` | `~/.cache/crush/crush.db` | sqlite | **no per-msg tokens** — cost-only, bucket assistant msgs by local day → `host-estimated`, tokens=0 | high |
| `synthetic` | `<octofriend>/data.sqlite3` | sqlite | `messages` table tokens (fallback `token_usage`); strip `hf:`/`accounts/…` model prefix | medium |

### (d) Synced / cloud — LOCAL-feasible vs require-sync
| platformId | local artifact | LOCAL? | behavior |
|---|---|---|---|
| `cursor` | `~/.config/tokscale/cursor-cache/usage*.csv` | **partial LOCAL** | parse cached CSV (v1/v2/v3 column maps) **if present**; never call the export API. No cache → "requires sync, skipped". conf high (on cached data) |
| `antigravity` | `~/.config/.../antigravity-cache/manifest.json` + `sessions/*.jsonl` + `~/antigravity*/{brain,conversations}` | **partial LOCAL** | read manifest artifacts + filesystem brain/conversations; skip RPC discovery. conf medium |
| `trae` | `…/trae-cache/sessions/usage-*.json` | **synced only** | parse cached artifacts **if present**; never auth/REST. Else "requires sync, skipped". conf medium |
| `warp` | `…/warp-cache/usage.json` | **synced only, aggregate** | request-count + spend only, **no token breakdown** → report under a synthetic model, mark aggregate; else skipped. conf low |

> The `note` cursor/antigravity/trae/warp caches live under tokscale's `~/.config/tokscale/...` root. We read them read-only if a user also runs tokscale; we do **not** create or sync them. `paths.ts` resolves these with env overrides first, tokscale default second.

---

## 4. Per-MCP telemetry COMPLETION items (separate track, `src/telemetry/*`)

These finish the *existing* serve-proxy layer; they are not part of `src/usage/`.

**4a. Gemini host-native usage enricher.** Gemini's `AfterModel` hook payload carries `usageMetadata.totalTokenCount` — the one place a host reports real per-LLM-call usage (noted as deliberately unimplemented in the gemini adapter header). Implement it:
- Add `"AfterModel"` to the Gemini `EVENT_MAP`/`GEMINI_EVENT` and install it (host-native-only event; no connector handler needed).
- In `runtime/hook-entrypoint.ts`, special-case the host-native usage event: parse `usageMetadata.{promptTokenCount,candidatesTokenCount,totalTokenCount,cachedContentTokenCount,thoughtsTokenCount}` and append a `ToolEventRecord` (or a small `UsageEventRecord`) with `confidenceSource: "host-native"` — the source rank already sits at the top of `CONFIDENCE_RANK` (3). Keep fail-open: any parse error → allow, record nothing.
- This upgrades Gemini rows from `tokenizer-approx` (serve-proxy estimate) to `host-native` (exact), per-session/per-project keyed via the existing `parseEvent` base (`sessionId`, `cwd`→`projectIdentity`).

**4b. Anthropic `count_tokens` calibration sampler (opt-in).** The serve-proxy tokenizes Anthropic-family bytes as `tokenizer-approx`. Add an **opt-in** (`AGENTCONNECT_CALIBRATE=anthropic`, requires `ANTHROPIC_API_KEY`) sampler that, for a small fraction of measured payloads, calls Anthropic's `count_tokens` endpoint and records the ratio (exact/approx) to derive a per-family correction factor stored in the data-root. Applied as a documented multiplier; never on by default (network + key); records stay aggregate-only. Surface a `tokenizer-calibrated` confidence between `approx` and `exact`.

**4c. Unify both telemetry sources in reporting.** Reports should present *MCP-self* (serve-proxy) and *host-native usage* coherently:
- Keep two stores (`telemetry.ndjson` for serve-proxy; `usage.ndjson`/on-the-fly host scan for host usage) but add a combined `report` view that labels each row's origin (`mcp-self` vs `host-native` vs `host-scan`) and **never sums across origins by default** (they measure different things: server bytes vs whole-conversation usage). A `--combine` flag with explicit double-count warnings is opt-in. Confidence legend already exists in `telemetry/report.ts`; extend it with the host origins.

---

## 5. Recommended build order

1. **Scaffolding**: `types.ts`, `paths.ts`, `normalize.ts` (port `normalizeModelForGrouping` exactly — order-dependent), `jsonl.ts`, `aggregate.ts` (dedup + group-by), `registry.ts`, `scan.ts`, `report.ts`, and the `usage` CLI command. Wire one trivial reader end-to-end first.
2. **Group (a) JSONL, high-confidence local**, in this order: `qwen-code` (simplest: no dedup/deltas) → `claude-code` → `codex` (stateful deltas — exercises the hard path early) → `gemini-cli` → `copilot-cli` → `pi` → `kimi` → `openclaw`.
3. **Group (b) JSON, high-confidence local**: `mux` → `droid` → `amp` → `codebuff` → `roo-code` → `kilo` → `kiro` (estimation-heavy, `host-estimated`).
4. **`sqlite.ts` (sql.js) + Group (c)**: `goose`/`hermes` (flat columns, easiest) → `opencode`/`kilo-cli` (`json_extract`) → `synthetic` → `crush` (cost-only) → **`zed` last** (needs zstd).
5. **Telemetry completion §4a** (Gemini host-native enricher) — small, high value, lands the `host-native` path.
6. **Group (d) synced**, local-cache-only: `cursor` (CSV) → `antigravity` (manifest+fs) → `trae` → `warp`. Each emits "requires sync, skipped" when no cache.
7. **§4b calibration sampler** and **§4c unified reporting** last (optional / cross-cutting).

---

## 6. Honesty notes

**Fully readable locally (real host-reported tokens):** claude-code, codex, gemini-cli, qwen-code, copilot-cli, pi, kimi, openclaw, amp, droid, codebuff, mux, roo-code, kilo, opencode, goose, hermes, kilo-cli, synthetic. → `host-reported`.

**Partial / estimated:**
- **kiro** — token counts are often estimated (`context% × window` or chars/4). Mark `host-estimated`.
- **crush** — reliable *cost*, no per-message tokens; tokens reported as 0, cost-only. `host-estimated`.
- **zed** — fully local **only with a zstd decoder**; without `fzstd` it must be skipped (logged), not silently zero.
- **goose** — reasoning is *inferred* (total − input − output), not reported; flag in row detail.

**Synced/cloud (no token data without an external sync we don't perform):**
- **cursor / antigravity / trae** — read cached artifacts if a tokscale sync already produced them; otherwise "requires sync, skipped". Never authenticate or hit the API.
- **warp** — aggregate request-count + spend only, **no token breakdown**; lowest confidence, clearly labeled as not comparable to token rows.

**Where dedup is critical (must implement to avoid double counting):**
- **codex** — cumulative `total_token_usage` vs per-turn `last_token_usage`; must use **deltas** and the `codex:token_count:…` dedup key with stale-regression detection, or every turn double-counts.
- **claude-code** — streaming rewrites the same `messageId:requestId` with cumulative counts; **per-field MAX merge**, else 5–10× over-count.
- **kimi** — progressive StatusUpdates per `message_id`; keep the **max/latest** per key.
- **opencode** — SQLite vs legacy JSON overlap and fork copies → fingerprint dedup (prefer embedded message_id).
- **copilot-cli** — chat span + inference log + agent-turn log can describe the same response → dedup on `trace_id:span_id` (+ `gen_ai.response.id`).
- **amp** — ledger events and message-usage describe the same call → merge, don't add.
- **trae** — API returns cumulative deltas; latest-per-`(session_id, usage_time)` wins.
- **Cross-platform**: a single API key shared across CLIs can surface the same call in two platforms' logs; the global `dedupKey`-insertion-order filter in `aggregate.ts` is the backstop, but it cannot catch un-keyed overlaps — so per-reader dedup above is mandatory, and the report footer should state that cross-platform numbers are additive-per-platform, not guaranteed globally unique.