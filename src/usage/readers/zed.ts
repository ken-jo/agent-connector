/**
 * usage/readers/zed — Zed Agent hosted-thread usage reader (SQLite + zstd JSON).
 *
 * Faithful port of tokscale sessions/zed.rs. Zed persists one row per agent
 * thread in a `threads` table inside a single SQLite database:
 *   • Linux/FreeBSD: $XDG_DATA_HOME/zed/threads/threads.db (~/.local/share/zed/…)
 *   • macOS:         ~/Library/Application Support/Zed/threads/threads.db
 *   • Windows:       %LOCALAPPDATA%\Zed\threads\threads.db
 * (host roots, incl. the AGENT_CONNECTOR_ZED_DIR override, are resolved by
 * paths.ts hostRoots("zed").)
 *
 * Only Zed-HOSTED model rows (provider == "zed.dev", case-insensitive) are
 * counted. External ACP agents are billed/logged by their own providers/CLIs, so
 * counting their Zed UI rows would double-count those sources.
 *
 * The thread payload is stored in a `data` BLOB whose `data_type` is either:
 *   • "json" — the raw UTF-8 JSON bytes; or
 *   • "zstd" — ZSTD-compressed JSON, decompressed here via fzstd's decompress().
 * Any other data_type, a failed zstd decode, or invalid JSON → the row is skipped
 * (fail-open). A decoded payload exceeding 32 MiB is rejected.
 *
 * One SELECT pulls every thread; the schema is backward-compatible — created_at,
 * folder_paths, folder_paths_order are OPTIONAL columns (older Zed builds omit
 * them). We probe `PRAGMA table_info(threads)` and substitute NULL for any column
 * that is absent so the SELECT never errors on an old schema:
 *   SELECT id, updated_at, {created_at|NULL}, {folder_paths|NULL},
 *          {folder_paths_order|NULL}, data_type, data FROM threads
 *
 * Token extraction (nested JSON in the decoded payload; reasoning always 0 — Zed's
 * TokenUsage has no reasoning field). Each TokenUsage object maps:
 *   input      = input_tokens
 *   output     = output_tokens
 *   cacheRead  = cache_read_input_tokens
 *   cacheWrite = cache_creation_input_tokens
 * Primary source is `request_token_usage` (an object map keyed by request id, OR
 * an array): each entry with a positive total is summed and counted. When the
 * request usage total is > 0 we use it (messageCount = count, min 1). Otherwise we
 * fall back to a single `cumulative_token_usage` object (messageCount = 1). A
 * thread with no positive token total is dropped.
 *
 * Model: model.model (trimmed, required non-empty). Provider hard-coded "zed.dev"
 * (per zed.rs — the row is only kept when model.provider == "zed.dev"). Threads
 * with imported == true are skipped. Timestamp (port of timestamp_ms): the
 * created_at column, else the updated_at column, else the payload's updated_at —
 * each parsed via parse_timestamp_str (RFC3339 or numeric s/ms). Session id = the
 * `id` column (thread id), which also seeds the dedup key "zed:<thread_id>".
 * Project: folder_paths (newline-separated) selected by folder_paths_order
 * (comma-separated indices; lowest order wins) or the first path, normalized via
 * normalizeWorkspaceKey. Confidence is "host-reported".
 *
 * Fail-open: db missing/locked/unreadable/non-sqlite → openSqlite returns null →
 * []; a bad/zstd-undecodable/non-hosted row is skipped, never thrown.
 */

import { decompress } from "fzstd";

import type { TokenBreakdown, UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { normalizeWorkspaceKey, workspaceLabelFromKey } from "../normalize.js";
import { firstExistingRoot } from "../paths.js";
import { openSqlite } from "../sqlite.js";

const PLATFORM_ID = "zed" as const;
/** Only Zed-hosted threads (provider == this) are counted (per zed.rs). */
const ZED_HOSTED_PROVIDER = "zed.dev";
/** Reject a decoded thread payload larger than this (mirrors the Rust guard). */
const MAX_ZED_THREAD_JSON_BYTES = 32 * 1024 * 1024;

/** The thread columns we read off each SQLite row (everything unknown). */
interface ZedThreadRow {
  id?: unknown;
  updated_at?: unknown;
  created_at?: unknown;
  folder_paths?: unknown;
  folder_paths_order?: unknown;
  data_type?: unknown;
  data?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────
// Schema probe + query build (backward-compat optional columns)
// ─────────────────────────────────────────────────────────────────────────

/** The set of column names on the `threads` table (empty on any probe error). */
function threadColumns(db: { all(sql: string): Array<Record<string, unknown>> }): Set<string> {
  const cols = new Set<string>();
  for (const row of db.all("PRAGMA table_info(threads)")) {
    // table_info's column-name field is `name`.
    const name = row.name;
    if (typeof name === "string") cols.add(name);
  }
  return cols;
}

/** `column` when present on the table, else the literal `NULL` (port of optional_column). */
function optionalColumn(columns: Set<string>, column: string): string {
  return columns.has(column) ? column : "NULL";
}

/** Build the threads SELECT, substituting NULL for any absent optional column. */
function buildThreadsQuery(columns: Set<string>): string {
  const createdAt = optionalColumn(columns, "created_at");
  const folderPaths = optionalColumn(columns, "folder_paths");
  const folderPathsOrder = optionalColumn(columns, "folder_paths_order");
  return (
    `SELECT id, updated_at, ${createdAt}, ${folderPaths}, ${folderPathsOrder}, ` +
    `data_type, data FROM threads`
  );
}

// ─────────────────────────────────────────────────────────────────────────
// BLOB decode (json / zstd → JSON value)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Coerce a sql.js BLOB cell to a Uint8Array (sql.js returns BLOBs as Uint8Array;
 * be tolerant of Buffer / number[] just in case), or null when it is not bytes.
 */
function toBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return null;
}

/**
 * Decode the `data` BLOB to JSON bytes (port of decode_thread_json): "json"
 * passes the bytes through; "zstd" decompresses via fzstd. Returns null on an
 * unsupported data_type, a failed zstd decode, or an over-size payload (the row
 * is then skipped — fail-open).
 */
function decodeThreadJson(dataType: string, data: Uint8Array): Uint8Array | null {
  switch (dataType.trim().toLowerCase()) {
    case "json": {
      if (data.length > MAX_ZED_THREAD_JSON_BYTES) return null;
      return data;
    }
    case "zstd": {
      let decoded: Uint8Array;
      try {
        decoded = decompress(data);
      } catch {
        return null; // undecodable zstd → skip the row (fail-open)
      }
      if (decoded.length > MAX_ZED_THREAD_JSON_BYTES) return null;
      return decoded;
    }
    default:
      return null; // unsupported data_type → skip
  }
}

/** Decode a UTF-8 byte payload to a parsed JSON value, or null on failure. */
function parseJsonBytes(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Token usage extraction (port of thread_usage / token_usage_from_value)
// ─────────────────────────────────────────────────────────────────────────

/** Sum the five token dimensions of a breakdown. */
function totalTokens(t: TokenBreakdown): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite + t.reasoning;
}

/**
 * Coerce a TokenUsage field to a non-negative integer (port of usage_field):
 * accept a number or a numeric string; clamp ≥ 0; 0 on absence/garbage.
 */
function usageField(obj: Record<string, unknown>, field: string): number {
  const v = obj[field];
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string") n = Number(v);
  else return 0;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/**
 * Build a TokenBreakdown from a single TokenUsage value (port of
 * token_usage_from_value); reasoning stays 0 (not present in Zed's schema).
 * Returns null when the value is not an object.
 */
function tokenUsageFromValue(value: unknown): TokenBreakdown | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const tokens = emptyTokens();
  tokens.input = usageField(obj, "input_tokens");
  tokens.output = usageField(obj, "output_tokens");
  tokens.cacheRead = usageField(obj, "cache_read_input_tokens");
  tokens.cacheWrite = usageField(obj, "cache_creation_input_tokens");
  // reasoning stays 0.
  return tokens;
}

/**
 * Sum every positive TokenUsage in `request_token_usage` (port of
 * sum_request_token_usage). The value may be an object map (keyed by request id)
 * or an array; non-object members and zero-total entries are skipped. Returns the
 * summed breakdown and the count of positive entries.
 */
function sumRequestTokenUsage(value: unknown): { tokens: TokenBreakdown; count: number } {
  const total = emptyTokens();
  let count = 0;

  let usages: unknown[];
  if (Array.isArray(value)) {
    usages = value;
  } else if (typeof value === "object" && value !== null) {
    usages = Object.values(value as Record<string, unknown>);
  } else {
    return { tokens: total, count };
  }

  for (const usageValue of usages) {
    const usage = tokenUsageFromValue(usageValue);
    if (usage === null) continue;
    if (totalTokens(usage) <= 0) continue;
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.reasoning += usage.reasoning;
    count += 1;
  }

  return { tokens: total, count };
}

/**
 * Resolve a thread's usage (port of thread_usage): prefer the summed
 * request_token_usage when its total is > 0 (messageCount = count, min 1),
 * otherwise fall back to a single cumulative_token_usage (messageCount = 1).
 * Returns null when neither source yields a positive total.
 */
function threadUsage(thread: Record<string, unknown>): { tokens: TokenBreakdown; messageCount: number } | null {
  const { tokens: requestTokens, count } = sumRequestTokenUsage(thread.request_token_usage);
  if (totalTokens(requestTokens) > 0) {
    return { tokens: requestTokens, messageCount: Math.max(1, count) };
  }

  const cumulative = tokenUsageFromValue(thread.cumulative_token_usage);
  if (cumulative !== null && totalTokens(cumulative) > 0) {
    return { tokens: cumulative, messageCount: 1 };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Timestamp (port of timestamp_ms + parse_timestamp_str)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse a timestamp string to epoch ms (port of parse_timestamp_str): RFC3339
 * first, else a positive integer disambiguated s↔ms (≥ 1e12 → ms, else × 1000).
 * Returns null on a non-positive / unparseable value.
 */
function parseTimestampStr(value: string): number | null {
  const iso = Date.parse(value);
  if (!Number.isNaN(iso)) return iso;

  // Strict integer parse (the Rust path uses i64::from_str_radix-style parsing).
  if (/^[+-]?\d+$/.test(value.trim())) {
    const numeric = Number(value.trim());
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return numeric >= 1_000_000_000_000 ? Math.trunc(numeric) : Math.trunc(numeric * 1000);
  }
  return null;
}

/** A cell that should be a string, else undefined. */
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Resolve the thread timestamp (port of timestamp_ms): created_at column, else
 * updated_at column, else the payload's updated_at — first that parses. Returns
 * null when none yields a valid timestamp.
 */
function timestampMs(row: ZedThreadRow, thread: Record<string, unknown>): number | null {
  const createdAt = asString(row.created_at);
  if (createdAt !== undefined) {
    const ms = parseTimestampStr(createdAt);
    if (ms !== null) return ms;
  }
  const updatedAt = asString(row.updated_at);
  if (updatedAt !== undefined) {
    const ms = parseTimestampStr(updatedAt);
    if (ms !== null) return ms;
  }
  const payloadUpdatedAt = asString(thread.updated_at);
  if (payloadUpdatedAt !== undefined) {
    const ms = parseTimestampStr(payloadUpdatedAt);
    if (ms !== null) return ms;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Project / workspace (port of workspace_key_from_folders)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Pick the index of the lowest-order path (port of first_ordered_path_index):
 * `order` is a comma-separated list of indices aligned positionally with the
 * paths; we take the position whose parsed order value is smallest, ignoring
 * positions beyond the path count. Returns undefined when nothing parses.
 */
function firstOrderedPathIndex(order: string, pathCount: number): number | undefined {
  let bestIndex: number | undefined;
  let bestOrder = Number.POSITIVE_INFINITY;
  const parts = order.split(",");
  for (let index = 0; index < parts.length; index++) {
    if (index >= pathCount) continue;
    const raw = (parts[index] as string).trim();
    if (!/^\d+$/.test(raw)) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (value < bestOrder) {
      bestOrder = value;
      bestIndex = index;
    }
  }
  return bestIndex;
}

/**
 * Derive a normalized workspace key from the folder columns (port of
 * workspace_key_from_folders): split `paths` on newlines (trimmed, non-empty),
 * select by `order` (lowest-order index) or the first path, then normalize.
 */
function workspaceKeyFromFolders(paths: unknown, order: unknown): string | undefined {
  if (typeof paths !== "string") return undefined;
  const list = paths
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (list.length === 0) return undefined;

  let selected: string | undefined;
  if (typeof order === "string") {
    const idx = firstOrderedPathIndex(order, list.length);
    if (idx !== undefined) selected = list[idx];
  }
  if (selected === undefined) selected = list[0];

  return normalizeWorkspaceKey(selected as string);
}

// ─────────────────────────────────────────────────────────────────────────
// Row → record (port of parse_thread_row)
// ─────────────────────────────────────────────────────────────────────────

/** Parse one threads row into a UsageRecord, or null when it should be skipped. */
function parseThreadRow(row: ZedThreadRow): UsageRecord | null {
  const id = asString(row.id);
  if (id === undefined || id === "") return null;

  const dataType = asString(row.data_type);
  if (dataType === undefined) return null;
  const dataBytes = toBytes(row.data);
  if (dataBytes === null) return null;

  const jsonBytes = decodeThreadJson(dataType, dataBytes);
  if (jsonBytes === null) return null; // unsupported / undecodable / oversize → skip

  const parsed = parseJsonBytes(jsonBytes);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const thread = parsed as Record<string, unknown>;

  // Skip imported threads.
  if (thread.imported === true) return null;

  // Require a hosted (zed.dev) model with a non-empty model id.
  const model = thread.model;
  if (typeof model !== "object" || model === null || Array.isArray(model)) return null;
  const modelObj = model as Record<string, unknown>;
  const provider = asString(modelObj.provider);
  if (provider === undefined) return null;
  if (provider.trim().toLowerCase() !== ZED_HOSTED_PROVIDER) return null;

  const modelRaw = asString(modelObj.model);
  if (modelRaw === undefined) return null;
  const modelId = modelRaw.trim();
  if (modelId === "") return null;

  const usage = threadUsage(thread);
  if (usage === null) return null; // no positive token total → drop

  const ts = timestampMs(row, thread);
  if (ts === null) return null;

  const record: UsageRecord = {
    platformId: PLATFORM_ID,
    modelId,
    providerId: ZED_HOSTED_PROVIDER,
    sessionId: id,
    tokens: usage.tokens,
    ts,
    messageCount: usage.messageCount,
    dedupKey: `zed:${id}`,
    confidence: "host-reported",
  };

  const projectKey = workspaceKeyFromFolders(row.folder_paths, row.folder_paths_order);
  if (projectKey !== undefined) {
    record.projectKey = projectKey;
    const label = workspaceLabelFromKey(projectKey);
    if (label !== undefined) record.projectLabel = label;
  }

  return record;
}

// ─────────────────────────────────────────────────────────────────────────
// Reader
// ─────────────────────────────────────────────────────────────────────────

/** The Zed Agent hosted-thread usage reader singleton. */
const zedReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    const dbPath = firstExistingRoot(PLATFORM_ID);
    if (dbPath === undefined) return []; // no threads.db → fail-open

    const db = await openSqlite(dbPath);
    if (db === null) return []; // missing / locked / unreadable / non-sqlite → fail-open

    try {
      const columns = threadColumns(db);
      const query = buildThreadsQuery(columns);
      const rows = db.all(query); // bad SQL / schema mismatch → [] (fail-open)
      const records: UsageRecord[] = [];

      for (const raw of rows) {
        let record: UsageRecord | null;
        try {
          record = parseThreadRow(raw as ZedThreadRow);
        } catch {
          continue; // any per-row decode failure → skip (fail-open)
        }
        if (record === null) continue;
        if (sinceMs !== undefined && record.ts < sinceMs) continue;
        records.push(record);
      }

      return records;
    } finally {
      db.close();
    }
  },
};

export default zedReader;
