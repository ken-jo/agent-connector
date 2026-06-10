/**
 * usage/readers/synthetic — Synthetic.new (Octofriend / HF gateway) usage reader.
 *
 * Faithful port of tokscale sessions/synthetic.rs (parse_octofriend_sqlite). The
 * Octofriend client persists usage in a single SQLite database. Per the tokscale
 * scanner (scanner.rs), the db lives at:
 *   ${XDG_DATA_HOME:-~/.local/share}/octofriend/sqlite.db
 * (an AGENTCONNECT_SYNTHETIC_DIR override is honored first — verbatim,
 * non-empty — mirroring the paths.ts env-override contract; `synthetic` is not
 * yet wired into paths.ts hostRoots, so the path is resolved here.)
 *
 * Octofriend historically stored only input_history (no token data), so the
 * parser is future-proofed: it first checks sqlite_master for any of the
 * token-tracking tables ('messages', 'sessions', 'token_usage'); when none
 * exist it yields []. When present it parses the `messages` table (the full
 * schema with cache + reasoning + cost), falling back to the simpler
 * `token_usage` table only when `messages` produced no rows.
 *
 * messages table (port of the primary SELECT):
 *   SELECT id, model, input_tokens, output_tokens, cache_read_tokens,
 *          cache_write_tokens, reasoning_tokens, cost, timestamp, session_id,
 *          provider
 *   FROM messages
 *   WHERE input_tokens IS NOT NULL OR output_tokens IS NOT NULL
 *   → input/output/cacheRead/cacheWrite/reasoning each clamped ≥ 0; a row whose
 *     5-dimension sum is 0 is skipped; cost ≥ 0; provider column (fallback
 *     "synthetic" when missing/empty); dedup_key = id.
 *
 * token_usage fallback (only when messages yielded nothing):
 *   SELECT id, model, input_tokens, output_tokens, timestamp, session_id
 *   FROM token_usage
 *   WHERE input_tokens > 0 OR output_tokens > 0
 *   → only input/output (cache + reasoning = 0); provider hardcoded "synthetic";
 *     cost = 0; dedup_key = id.
 *
 * Model normalization (port of normalize_synthetic_model): strips synthetic.new
 * gateway prefixes for a clean grouping id:
 *   "hf:deepseek-ai/DeepSeek-V3-0324"            → "deepseek-v3-0324"
 *   "accounts/fireworks/models/deepseek-v3-0324" → "deepseek-v3-0324"
 * Provider is inferProvider() of the cleaned model, falling back to the row's
 * provider column (or "synthetic"). Timestamp is the f64 `timestamp` column:
 * values > 1e12 are already ms, smaller values are seconds (×1000). No project
 * attribution exists in the Octofriend schema. Confidence is host-reported, but
 * the spec rates this source medium (the schema is still emergent/future-proofed),
 * so rows are marked "host-estimated" to label that honestly.
 *
 * Fail-open: db missing/locked/unreadable / non-sqlite → openSqlite returns null
 * → []; a bad row is skipped, never thrown.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { inferProvider } from "../normalize.js";
import { expandHome } from "../paths.js";
import { openSqlite } from "../sqlite.js";

const PLATFORM_ID = "synthetic" as const;
const DEFAULT_PROVIDER = "synthetic";

// ─────────────────────────────────────────────────────────────────────────
// Octofriend db-path resolution (port of scanner.rs synthetic_db discovery).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Read an env override, treating empty/blank as unset (mirrors the paths.ts
 * envOverride contract: an empty override must NOT resolve to ""). Relative
 * paths resolve against the process CWD; a leading "~" is expanded.
 */
function envOverride(name: string): string | undefined {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return undefined;
  const expanded = expandHome(raw.trim());
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** $XDG_DATA_HOME (when set & non-empty) else ~/.local/share — as in paths.ts. */
function xdgDataHome(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.trim() !== "") return resolve(expandHome(xdg.trim()));
  return join(homedir(), ".local", "share");
}

/**
 * Resolve the Octofriend sqlite.db path. Honors AGENTCONNECT_SYNTHETIC_DIR
 * first (treated as the octofriend directory: `<dir>/sqlite.db`), else the
 * tokscale default `${XDG_DATA_HOME:-~/.local/share}/octofriend/sqlite.db`.
 */
function octofriendDbPath(): string {
  const override = envOverride("AGENTCONNECT_SYNTHETIC_DIR");
  if (override !== undefined) return join(override, "sqlite.db");
  return join(xdgDataHome(), "octofriend", "sqlite.db");
}

// ─────────────────────────────────────────────────────────────────────────
// Model normalization (port of normalize_synthetic_model).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Normalize a synthetic.new model id to a standard form, lowercased:
 *   "hf:<org>/<model>"                  → "<model>"
 *   "hf:<model>"                        → "<model>"
 *   "accounts/<provider>/models/<model>" → "<model>"
 * Any other id passes through lowercased. Mirrors the Rust strip_prefix /
 * split_once chain exactly.
 */
function normalizeSyntheticModel(modelId: string): string {
  const lower = modelId.toLowerCase();

  // Strip "hf:" prefix and (optional) org name.
  if (lower.startsWith("hf:")) {
    const rest = lower.slice("hf:".length);
    const slash = rest.indexOf("/");
    if (slash >= 0) return rest.slice(slash + 1);
    return rest;
  }

  // Strip "accounts/<provider>/models/" prefix.
  if (lower.startsWith("accounts/")) {
    const rest = lower.slice("accounts/".length);
    const marker = "/models/";
    const idx = rest.indexOf(marker);
    if (idx >= 0) return rest.slice(idx + marker.length);
  }

  return lower;
}

// ─────────────────────────────────────────────────────────────────────────
// Cell coercion & timestamp.
// ─────────────────────────────────────────────────────────────────────────

/** Coerce a SQLite cell to an integer (Rust get::<i64>().unwrap_or(0)), no clamp. */
function toInt(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

/** Coerce a SQLite cell to a float (Rust get::<f64>().unwrap_or(0.0)). */
function toFloat(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** Coerce to a non-empty trimmed string, or undefined. */
function toStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return v;
}

/**
 * Convert the f64 `timestamp` column to epoch ms (port of the Rust branch):
 * values > 1e12 are already milliseconds (cast); smaller values are seconds
 * (×1000). Truncating, matching the Rust `as i64`.
 */
function timestampToMs(timestamp: number): number {
  return timestamp > 1e12 ? Math.trunc(timestamp) : Math.trunc(timestamp * 1000);
}

// ─────────────────────────────────────────────────────────────────────────
// Table presence check (port of the sqlite_master count).
// ─────────────────────────────────────────────────────────────────────────

const TABLE_CHECK_SQL = `
  SELECT count(*) AS n
  FROM sqlite_master
  WHERE type='table' AND name IN ('messages', 'sessions', 'token_usage')
`;

/** Row shape for the primary `messages` SELECT (all cells optional / unknown). */
interface MessagesRow {
  id?: unknown;
  model?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_tokens?: unknown;
  cache_write_tokens?: unknown;
  reasoning_tokens?: unknown;
  cost?: unknown;
  timestamp?: unknown;
  session_id?: unknown;
  provider?: unknown;
}

const MESSAGES_SQL = `
  SELECT id, model, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, reasoning_tokens, cost, timestamp, session_id, provider
  FROM messages
  WHERE input_tokens IS NOT NULL OR output_tokens IS NOT NULL
`;

/** Row shape for the `token_usage` fallback SELECT. */
interface TokenUsageRow {
  id?: unknown;
  model?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  timestamp?: unknown;
  session_id?: unknown;
}

const TOKEN_USAGE_SQL = `
  SELECT id, model, input_tokens, output_tokens, timestamp, session_id
  FROM token_usage
  WHERE input_tokens > 0 OR output_tokens > 0
`;

// ─────────────────────────────────────────────────────────────────────────
// Reader
// ─────────────────────────────────────────────────────────────────────────

/** The Synthetic.new (Octofriend) usage reader singleton. */
const syntheticReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    const dbPath = octofriendDbPath();

    const db = await openSqlite(dbPath);
    if (db === null) return []; // missing / locked / unreadable / non-sqlite → fail-open

    try {
      // Future-proofing: only parse when a token-tracking table exists.
      const tableCheck = db.all(TABLE_CHECK_SQL);
      const tableCount = tableCheck.length > 0 ? toInt(tableCheck[0]?.n) : 0;
      if (tableCount <= 0) return [];

      const records: UsageRecord[] = [];

      // Primary schema: the `messages` table (full token breakdown + cost).
      const messageRows = db.all(MESSAGES_SQL); // bad SQL / schema mismatch → []
      for (const raw of messageRows) {
        const row = raw as MessagesRow;

        const id = toStr(row.id);
        if (id === undefined) continue; // Rust requires id (row.get(0)? bails otherwise)

        const rawModel = toStr(row.model) ?? "";
        const input = Math.max(0, toInt(row.input_tokens));
        const output = Math.max(0, toInt(row.output_tokens));
        const cacheRead = Math.max(0, toInt(row.cache_read_tokens));
        const cacheWrite = Math.max(0, toInt(row.cache_write_tokens));
        const reasoning = Math.max(0, toInt(row.reasoning_tokens));

        // Skip zero-token rows (Rust: total == 0 → continue), using raw (signed) sums.
        const total =
          toInt(row.input_tokens) +
          toInt(row.output_tokens) +
          toInt(row.cache_read_tokens) +
          toInt(row.cache_write_tokens) +
          toInt(row.reasoning_tokens);
        if (total === 0) continue;

        const cost = Math.max(0, toFloat(row.cost));
        const ts = timestampToMs(toFloat(row.timestamp));
        if (sinceMs !== undefined && ts < sinceMs) continue;

        const sessionId = toStr(row.session_id) ?? "unknown";
        // Provider: row column when present, else "synthetic" (Rust unwrap_or).
        const rowProvider = toStr(row.provider);
        const columnProvider =
          rowProvider !== undefined && rowProvider !== "" ? rowProvider : DEFAULT_PROVIDER;

        const modelId = normalizeSyntheticModel(rawModel);
        const providerId = inferProvider(modelId) ?? columnProvider;

        const tokens = emptyTokens();
        tokens.input = input;
        tokens.output = output;
        tokens.cacheRead = cacheRead;
        tokens.cacheWrite = cacheWrite;
        tokens.reasoning = reasoning;

        const record: UsageRecord = {
          platformId: PLATFORM_ID,
          modelId,
          providerId,
          sessionId,
          tokens,
          ts,
          messageCount: 1,
          dedupKey: id, // messages.id → one record per row
          confidence: "host-estimated", // spec rates this source medium
        };
        if (cost > 0) record.cost = cost;
        records.push(record);
      }

      // Fallback schema: only when `messages` produced nothing.
      if (records.length === 0) {
        const tokenRows = db.all(TOKEN_USAGE_SQL);
        for (const raw of tokenRows) {
          const row = raw as TokenUsageRow;

          const id = toStr(row.id);
          if (id === undefined) continue;

          const rawModel = toStr(row.model) ?? "";
          const input = Math.max(0, toInt(row.input_tokens));
          const output = Math.max(0, toInt(row.output_tokens));

          const ts = timestampToMs(toFloat(row.timestamp));
          if (sinceMs !== undefined && ts < sinceMs) continue;

          const sessionId = toStr(row.session_id) ?? "unknown";
          const modelId = normalizeSyntheticModel(rawModel);
          const providerId = inferProvider(modelId) ?? DEFAULT_PROVIDER;

          const tokens = emptyTokens();
          tokens.input = input;
          tokens.output = output;
          // cacheRead / cacheWrite / reasoning stay 0 (token_usage has no such columns).

          const record: UsageRecord = {
            platformId: PLATFORM_ID,
            modelId,
            providerId,
            sessionId,
            tokens,
            ts,
            messageCount: 1,
            dedupKey: id,
            confidence: "host-estimated",
          };
          records.push(record);
        }
      }

      return records;
    } finally {
      db.close();
    }
  },
};

export default syntheticReader;
