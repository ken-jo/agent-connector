/**
 * usage/readers/kilo-cli — Kilo CLI SQLite session reader.
 *
 * Faithful port of tokscale sessions/kilo.rs (parse_kilo_sqlite /
 * parse_kilo_sqlite_with_fallback, lines 53-155). The Kilo CLI stores every
 * message as one row in a `message` table whose `data` column is the raw message
 * JSON (TEXT) — the same shape OpenCode uses. This reader opens that DB read-only
 * and reports the assistant rows' token usage.
 *
 * This is the SQLite Kilo CLI reader and is DISTINCT from the already-shipped
 * `kilo` reader (sessions/kilocode.rs), which parses the VS Code KiloCode task
 * logs (`ui_messages.json`, the Roo/Kilo `api_req_started` JSON format). They are
 * different products with different storage and carry different platformIds
 * (`kilo-cli` here vs `kilo` there) so their rows never merge.
 *
 * DB path: ~/.local/share/kilo/kilo.db (XDG_DATA_HOME and the
 * AGENT_CONNECTOR_KILO_CLI_DIR override are honored via paths.ts hostRoots).
 *
 * SQL (port of the Rust `query`):
 *   SELECT m.id, m.session_id, m.data
 *   FROM message m
 *   WHERE json_valid(m.data)
 *     AND json_extract(m.data, '$.role') = 'assistant'
 *     AND json_extract(m.data, '$.tokens') IS NOT NULL
 *
 * Tokens (off the parsed `data` JSON, each clamped ≥ 0 — the Rust `.max(0)` on
 * the i64 fields; KiloTokens makes input/output/cache.read/cache.write required
 * and reasoning optional, so a row missing one of the required fields fails the
 * serde deserialize and is skipped — replicated here):
 *   tokens.input        → input
 *   tokens.output       → output
 *   tokens.cache.read   → cacheRead
 *   tokens.cache.write  → cacheWrite
 *   tokens.reasoning    → reasoning   (optional; 0 when absent)
 * cost is `data.$.cost` (clamped ≥ 0), emitted only when > 0.
 *
 * model / provider: data.$.modelID is REQUIRED — a row without it is skipped
 * (the Rust `match msg.model_id { None => continue }`). provider prefers
 * data.$.providerID, then inferProvider(modelId), then the "kilo" default.
 *
 * agent: data.$.agent then data.$.mode (Rust `msg.agent.or(msg.mode)` — note this
 * is the OPPOSITE precedence to the OpenCode reader's mode-then-agent).
 *
 * session: data.$.session_id (preferred) else the m.session_id column.
 *
 * project: NONE — the Kilo CLI log carries no cwd/workspace, so no projectKey
 * is emitted (matches the spec's "projectAttribution: None").
 *
 * timestamp: data.$.time.created (Unix MILLISECONDS, float, truncated to int).
 * When the `time` block is absent the fallback is the DB file's mtime (port of
 * file_modified_timestamp_ms). A `time` block present but with a non-numeric
 * `created` fails the serde deserialize, so the row is skipped (not fallen back).
 *
 * DEDUP — dedupKey = data.$.id (the embedded message id) else the m.id row id
 * (Rust `msg.id.or(Some(row_id))`). No fingerprint merge: the Kilo CLI is a
 * single source of record, so a row-id backstop is sufficient.
 *
 * confidence: "host-reported" (Kilo logs real token counts).
 *
 * Fail-open: DB missing/locked/unreadable/corrupt → openSqlite() returns null →
 * []; a malformed row → skipped. Never throws. Read-only.
 */

import type { SqliteDb } from "../sqlite.js";
import type { UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { fileMtimeMs } from "../jsonl.js";
import { inferProvider } from "../normalize.js";
import { firstExistingRoot } from "../paths.js";
import { openSqlite } from "../sqlite.js";

const PLATFORM_ID = "kilo-cli" as const;
const DEFAULT_PROVIDER = "kilo";

const QUERY = `
  SELECT m.id, m.session_id, m.data
  FROM message m
  WHERE json_valid(m.data)
    AND json_extract(m.data, '$.role') = 'assistant'
    AND json_extract(m.data, '$.tokens') IS NOT NULL
`;

// ─────────────────────────────────────────────────────────────────────────
// Value coercion
// ─────────────────────────────────────────────────────────────────────────

/** A non-negative integer token field (port of `.max(0)` on an i64). */
function tokenField(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/** A finite number (the serde i64/f64 required-field semantics), or undefined. */
function asFiniteNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** A non-empty string, or undefined. */
function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** A SELECT column that may come back as Uint8Array (BLOB) / number — to string. */
function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// The parsed `data` column (the KiloMessage subset we read)
// ─────────────────────────────────────────────────────────────────────────

interface KiloTokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

interface ParsedMessage {
  /** Embedded message id (preferred dedup key); undefined when absent. */
  id: string | undefined;
  /** Embedded session id (preferred over the row column); undefined when absent. */
  sessionId: string | undefined;
  modelId: string;
  providerId: string;
  agent: string | undefined;
  tokens: KiloTokens;
  cost: number;
  /** Truncated time.created (ms), or undefined → caller uses the mtime fallback. */
  ts: number | undefined;
}

/**
 * Parse the `data` JSON of a row (port of the KiloMessage deserialize + the
 * post-deserialize checks). Returns undefined for any row the Rust would skip:
 *   • not a JSON object / not parseable;
 *   • role != "assistant" (redundant with the SQL filter, but the Rust re-checks);
 *   • no tokens block, or a tokens block missing a REQUIRED field
 *     (input / output / cache.read / cache.write — serde would fail the struct);
 *   • a `time` block present but with a non-numeric `created` (serde fails);
 *   • no modelID (the Rust `match msg.model_id { None => continue }`).
 */
function parseData(dataJson: string): ParsedMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(dataJson);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;

  if (obj["role"] !== "assistant") return undefined;

  // tokens — required block; input/output/cache.{read,write} are required fields
  // (KiloTokens / KiloCache), reasoning is optional. A missing required field
  // would fail serde, so we reject the row rather than coerce it to 0.
  const tokensRaw = obj["tokens"];
  if (typeof tokensRaw !== "object" || tokensRaw === null) return undefined;
  const t = tokensRaw as Record<string, unknown>;
  const input = asFiniteNumber(t["input"]);
  const output = asFiniteNumber(t["output"]);
  if (input === undefined || output === undefined) return undefined;

  const cacheRaw = t["cache"];
  if (typeof cacheRaw !== "object" || cacheRaw === null) return undefined;
  const cache = cacheRaw as Record<string, unknown>;
  const cacheRead = asFiniteNumber(cache["read"]);
  const cacheWrite = asFiniteNumber(cache["write"]);
  if (cacheRead === undefined || cacheWrite === undefined) return undefined;

  // modelID — required (the Rust skips a row that lacks it).
  const modelId = asNonEmptyString(obj["modelID"]);
  if (modelId === undefined) return undefined;

  // time — optional block; when present, `created` is a required f64 (serde
  // would fail an absent/non-numeric created), so a malformed time skips the row.
  const timeRaw = obj["time"];
  let ts: number | undefined;
  if (timeRaw !== undefined && timeRaw !== null) {
    if (typeof timeRaw !== "object") return undefined;
    const created = asFiniteNumber((timeRaw as Record<string, unknown>)["created"]);
    if (created === undefined) return undefined;
    ts = Math.trunc(created);
  }

  // provider: data.$.providerID, then inferred from model, then the "kilo" default.
  const providerId =
    asNonEmptyString(obj["providerID"]) ?? inferProvider(modelId) ?? DEFAULT_PROVIDER;

  // agent prefers agent then mode (Rust: msg.agent.or(msg.mode)).
  const agent = asNonEmptyString(obj["agent"]) ?? asNonEmptyString(obj["mode"]);

  return {
    id: asNonEmptyString(obj["id"]),
    sessionId: asNonEmptyString(obj["session_id"]),
    modelId,
    providerId,
    agent,
    tokens: {
      input: tokenField(input),
      output: tokenField(output),
      reasoning: tokenField(t["reasoning"]),
      cacheRead: tokenField(cacheRead),
      cacheWrite: tokenField(cacheWrite),
    },
    cost: Math.max(0, asFiniteNumber(obj["cost"]) ?? 0),
    ts,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// DB read
// ─────────────────────────────────────────────────────────────────────────

/** The three selected columns of one row. */
interface Row {
  id: string;
  sessionId: string;
  data: string;
}

/** Select the assistant rows that carry a tokens block. */
function selectRows(db: SqliteDb): Row[] {
  const rows: Row[] = [];
  for (const r of db.all(QUERY)) {
    const id = asString(r["id"]);
    const sessionId = asString(r["session_id"]);
    const data = asString(r["data"]);
    if (id === undefined || sessionId === undefined || data === undefined) continue;
    rows.push({ id, sessionId, data });
  }
  return rows;
}

/** Parse the Kilo CLI SQLite DB into usage records (fallbackTs = DB file mtime). */
function parseDb(db: SqliteDb, fallbackTs: number): UsageRecord[] {
  const records: UsageRecord[] = [];

  for (const row of selectRows(db)) {
    const msg = parseData(row.data);
    if (msg === undefined) continue;

    // dedupKey prefers the embedded message id; falls back to the row id.
    const dedupKey = msg.id ?? row.id;
    // session prefers the embedded id; falls back to the m.session_id column.
    const sessionId = msg.sessionId ?? row.sessionId;
    // timestamp prefers time.created; falls back to the DB file mtime.
    const ts = msg.ts ?? fallbackTs;

    const tokens = emptyTokens();
    tokens.input = msg.tokens.input;
    tokens.output = msg.tokens.output;
    tokens.cacheRead = msg.tokens.cacheRead;
    tokens.cacheWrite = msg.tokens.cacheWrite;
    tokens.reasoning = msg.tokens.reasoning;

    const record: UsageRecord = {
      platformId: PLATFORM_ID,
      modelId: msg.modelId,
      providerId: msg.providerId,
      sessionId,
      tokens,
      ts,
      messageCount: 1,
      dedupKey,
      confidence: "host-reported",
    };
    if (msg.cost > 0) record.cost = msg.cost;
    if (msg.agent !== undefined) record.agent = msg.agent;

    records.push(record);
  }

  return records;
}

// ─────────────────────────────────────────────────────────────────────────
// Reader singleton
// ─────────────────────────────────────────────────────────────────────────

/** The Kilo CLI usage reader singleton. */
const kiloCliReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    const dbPath = firstExistingRoot(PLATFORM_ID);
    if (dbPath === undefined) return []; // no kilo.db → fail-open

    const db = await openSqlite(dbPath);
    if (db === null) return []; // missing/locked/unreadable/corrupt → fail-open

    try {
      const fallbackTs = fileMtimeMs(dbPath);
      const rows = parseDb(db, fallbackTs);
      if (sinceMs === undefined) return rows;
      return rows.filter((r) => r.ts >= sinceMs);
    } catch {
      return []; // any unexpected error → fail-open
    } finally {
      db.close();
    }
  },
};

export default kiloCliReader;
