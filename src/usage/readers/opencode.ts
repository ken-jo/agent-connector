/**
 * usage/readers/opencode — OpenCode SQLite session reader.
 *
 * Faithful port of tokscale sessions/opencode.rs (parse_opencode_sqlite, lines
 * 192-336). OpenCode 1.2+ stores every message as one row in a `message` table
 * whose `data` column is the raw message JSON; this reader reads that DB
 * read-only and reports the assistant rows' token usage. (The Rust crate also
 * walks a legacy `storage/message/*.json` tree and reconciles it with SQLite via
 * a migration cache — that legacy/JSON path and its cache are out of scope here:
 * SQLite is the system of record on every supported OpenCode version, and the
 * cross-source overlap it guards against is collapsed by the same dedupKey this
 * reader emits.)
 *
 * DB path: ~/.local/share/opencode/opencode.db (XDG_DATA_HOME / the
 * AGENT_CONNECTOR_OPENCODE_DIR override are honored via paths.ts hostRoots).
 *
 * SQL (modern, with the session table for workspace attribution):
 *   SELECT m.id, m.session_id, m.data, NULLIF(s.directory, '') AS workspace_root
 *   FROM message m
 *   LEFT JOIN session s ON s.id = m.session_id
 *   WHERE json_extract(m.data, '$.role') = 'assistant'
 *     AND json_extract(m.data, '$.tokens') IS NOT NULL
 *   ORDER BY m.id, m.session_id
 * When the `session` table is absent (legacy schema) the join cannot run, so we
 * fall back to the same query without it (workspace_root NULL), mirroring the
 * Rust `prepare(modern).or_else(prepare(legacy))`.
 *
 * Tokens (off the parsed `data` JSON, each clamped ≥ 0 — defense-in-depth):
 *   tokens.input        → input
 *   tokens.output       → output
 *   tokens.cache.read   → cacheRead
 *   tokens.cache.write  → cacheWrite
 *   tokens.reasoning    → reasoning   (optional; 0 when absent)
 * cost is `data.$.cost` (clamped ≥ 0), emitted only when > 0.
 *
 * model / provider: data.$.modelID (row skipped when absent) and data.$.providerID
 * (default "unknown"). agent prefers data.$.mode then data.$.agent, normalized via
 * normalizeOpencodeAgentName BEFORE the dedup fingerprint (matching opencode.rs:272)
 * so fork-copied history that differs only in a raw agent string collapses.
 *
 * session: the m.session_id column (the message→session linkage). Workspace
 * (project): session.directory (modern) else the embedded data.$.path.root
 * (legacy), normalized to a stable key + repo-name label.
 *
 * timestamp: data.$.time.created (Unix MILLISECONDS, float). Only assistant rows
 * with a tokens block are emitted.
 *
 * DEDUP — fingerprint, to drop SQLite-vs-legacy-JSON overlap and fork-copied
 * history that OpenCode duplicates across sessions. The fingerprint is the tuple
 * (created, completed, modelID, providerID, input, output, reasoning, cacheRead,
 * cacheWrite, cost, agent); the first row for a fingerprint wins. A later row that
 * carries an EMBEDDED data.$.id promotes the survivor's dedupKey to that id, so
 * the SQLite/JSON overlap (keyed on the same message id) keeps deduplicating
 * cross-source via the global dedupKey backstop. dedupKey itself prefers the
 * embedded data.$.id, falling back to the m.id row id. Duplicate rows that point
 * at a DIFFERENT workspace collapse the survivor's workspace to none (a forked
 * copy is genuinely ambiguous about which repo it belongs to).
 *
 * confidence: "host-reported" (OpenCode logs real token counts).
 *
 * Fail-open: DB missing/locked/unreadable/corrupt → openSqlite() returns null →
 * []; a malformed row → skipped. Never throws. Read-only.
 */

import type { SqliteDb } from "../sqlite.js";
import type { UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import {
  normalizeOpencodeAgentName,
  normalizeWorkspaceKey,
  workspaceLabelFromKey,
} from "../normalize.js";
import { firstExistingRoot } from "../paths.js";
import { openSqlite } from "../sqlite.js";

const PLATFORM_ID = "opencode" as const;
const DEFAULT_PROVIDER = "unknown";

const MODERN_QUERY = `
  SELECT m.id, m.session_id, m.data, NULLIF(s.directory, '') AS workspace_root
  FROM message m
  LEFT JOIN session s ON s.id = m.session_id
  WHERE json_extract(m.data, '$.role') = 'assistant'
    AND json_extract(m.data, '$.tokens') IS NOT NULL
  ORDER BY m.id, m.session_id
`;

const LEGACY_QUERY = `
  SELECT m.id, m.session_id, m.data, NULL AS workspace_root
  FROM message m
  WHERE json_extract(m.data, '$.role') = 'assistant'
    AND json_extract(m.data, '$.tokens') IS NOT NULL
  ORDER BY m.id, m.session_id
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

/** A finite f64, or undefined (port of Option<f64> on time/cost). */
function asF64(v: unknown): number | undefined {
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
// Workspace (port of workspace_from_root)
// ─────────────────────────────────────────────────────────────────────────

interface Workspace {
  key?: string;
  label?: string;
}

/** Normalize a root dir into a stable workspace key + repo-name label. */
function workspaceFromRoot(root: string | undefined): Workspace {
  if (root === undefined) return {};
  const key = normalizeWorkspaceKey(root);
  if (key === undefined) return {};
  const label = workspaceLabelFromKey(key);
  return label === undefined ? { key } : { key, label };
}

// ─────────────────────────────────────────────────────────────────────────
// The parsed `data` column (the OpenCodeMessage subset we read)
// ─────────────────────────────────────────────────────────────────────────

interface OpenCodeTokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

interface ParsedMessage {
  /** Embedded message id (preferred dedup key); undefined when absent. */
  id: string | undefined;
  modelId: string;
  providerId: string;
  agent: string | undefined;
  tokens: OpenCodeTokens;
  cost: number;
  created: number;
  completed: number | undefined;
  /** Embedded workspace root (data.$.path.root) — legacy fallback. */
  embeddedRoot: string | undefined;
}

/**
 * Parse the `data` JSON of a row. Returns undefined when the row is not an
 * assistant message, lacks a tokens block, or lacks a modelID (the Rust
 * `continue` cases). `path` is read only as an object with a `root` string (a
 * non-object `path`, e.g. a bare string, is ignored, not rejected).
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

  const tokensRaw = obj["tokens"];
  if (typeof tokensRaw !== "object" || tokensRaw === null) return undefined;
  const t = tokensRaw as Record<string, unknown>;

  const modelId = asNonEmptyString(obj["modelID"]);
  if (modelId === undefined) return undefined;

  const time = obj["time"];
  const created = typeof time === "object" && time !== null
    ? asF64((time as Record<string, unknown>)["created"])
    : undefined;
  if (created === undefined) return undefined;
  const completed = typeof time === "object" && time !== null
    ? asF64((time as Record<string, unknown>)["completed"])
    : undefined;

  const cache = t["cache"];
  const cacheObj = typeof cache === "object" && cache !== null ? (cache as Record<string, unknown>) : {};

  // agent prefers mode then agent (Rust: msg.mode.or(msg.agent)), then is run
  // through normalize_opencode_agent_name BEFORE the dedup fingerprint so fork
  // copies (which differ only in a raw agent string) collapse (opencode.rs:272).
  const rawAgent = asNonEmptyString(obj["mode"]) ?? asNonEmptyString(obj["agent"]);
  const agent = rawAgent === undefined ? undefined : normalizeOpencodeAgentName(rawAgent);

  const pathRaw = obj["path"];
  const embeddedRoot = typeof pathRaw === "object" && pathRaw !== null
    ? asNonEmptyString((pathRaw as Record<string, unknown>)["root"])
    : undefined;

  return {
    id: asNonEmptyString(obj["id"]),
    modelId,
    providerId: asNonEmptyString(obj["providerID"]) ?? DEFAULT_PROVIDER,
    agent,
    tokens: {
      input: tokenField(t["input"]),
      output: tokenField(t["output"]),
      reasoning: tokenField(t["reasoning"]),
      cacheRead: tokenField(cacheObj["read"]),
      cacheWrite: tokenField(cacheObj["write"]),
    },
    cost: Math.max(0, asF64(obj["cost"]) ?? 0),
    created,
    completed,
    embeddedRoot,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Fingerprint dedup (port of OpenCodeSqliteFingerprint + dedup state)
// ─────────────────────────────────────────────────────────────────────────

/**
 * A stable fingerprint string for a parsed message. Uses the float values
 * verbatim (created/completed/cost) so distinct calls that merely share a
 * creation timestamp stay distinct, while byte-identical fork copies collapse —
 * the JS analog of the Rust f64::to_bits() tuple.
 */
function fingerprint(m: ParsedMessage): string {
  return [
    m.created,
    m.completed ?? "",
    m.modelId,
    m.providerId,
    m.tokens.input,
    m.tokens.output,
    m.tokens.reasoning,
    m.tokens.cacheRead,
    m.tokens.cacheWrite,
    m.cost,
    m.agent ?? "",
  ].join(" ");
}

/** Per-survivor dedup bookkeeping (port of OpenCodeSqliteDedupState). */
interface DedupState {
  hasEmbeddedMessageId: boolean;
  hasWorkspaceConflict: boolean;
}

/** Apply a workspace to a record (clearing both fields together when undefined). */
function setWorkspace(record: UsageRecord, ws: Workspace): void {
  if (ws.key !== undefined) record.projectKey = ws.key;
  else delete record.projectKey;
  if (ws.label !== undefined) record.projectLabel = ws.label;
  else delete record.projectLabel;
}

/**
 * Reconcile a duplicate row's workspace into the survivor (port of
 * merge_duplicate_workspace): fill a missing workspace from the candidate; on a
 * genuine conflict (two different repos) drop to none and latch the conflict.
 */
function mergeDuplicateWorkspace(
  record: UsageRecord,
  state: DedupState,
  candidate: Workspace,
): void {
  if (state.hasWorkspaceConflict) return;
  const existing = record.projectKey;
  if (existing === undefined) {
    if (candidate.key !== undefined) setWorkspace(record, candidate);
    return;
  }
  if (candidate.key !== undefined && existing !== candidate.key) {
    state.hasWorkspaceConflict = true;
    setWorkspace(record, {});
  }
}

// ─────────────────────────────────────────────────────────────────────────
// DB read
// ─────────────────────────────────────────────────────────────────────────

/** The four selected columns of one row. */
interface Row {
  id: string;
  sessionId: string;
  data: string;
  workspaceRoot: string | undefined;
}

/**
 * Run the modern query; if it yields no rows fall back to the legacy query (no
 * session join). With sql.js a query against a missing `session` table returns
 * [] rather than throwing, so an empty modern result is the signal to retry
 * without the join — faithfully covering the legacy schema either way.
 */
function selectRows(db: SqliteDb): Row[] {
  let raw = db.all(MODERN_QUERY);
  if (raw.length === 0) raw = db.all(LEGACY_QUERY);

  const rows: Row[] = [];
  for (const r of raw) {
    const id = asString(r["id"]);
    const sessionId = asString(r["session_id"]);
    const data = asString(r["data"]);
    if (id === undefined || sessionId === undefined || data === undefined) continue;
    rows.push({ id, sessionId, data, workspaceRoot: asString(r["workspace_root"]) });
  }
  return rows;
}

/** Parse the OpenCode SQLite DB into deduplicated usage records. */
function parseDb(db: SqliteDb): UsageRecord[] {
  const records: UsageRecord[] = [];
  const indexByFingerprint = new Map<string, number>();
  const states: DedupState[] = [];

  for (const row of selectRows(db)) {
    const msg = parseData(row.data);
    if (msg === undefined) continue;

    // Workspace: session.directory (modern) else embedded data.$.path.root (legacy).
    const ws = workspaceFromRoot(row.workspaceRoot ?? msg.embeddedRoot);

    // dedupKey prefers the embedded message id; falls back to the row id.
    const dedupKey = msg.id ?? row.id;
    const fp = fingerprint(msg);

    const existingIndex = indexByFingerprint.get(fp);
    if (existingIndex !== undefined) {
      const state = states[existingIndex] as DedupState;
      const survivor = records[existingIndex] as UsageRecord;
      // Promote to the embedded id so SQLite/JSON cross-source overlap dedups.
      if (msg.id !== undefined && !state.hasEmbeddedMessageId) {
        state.hasEmbeddedMessageId = true;
        survivor.dedupKey = dedupKey;
      }
      mergeDuplicateWorkspace(survivor, state, ws);
      continue;
    }

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
      sessionId: row.sessionId,
      tokens,
      ts: Math.trunc(msg.created),
      messageCount: 1,
      dedupKey,
      confidence: "host-reported",
    };
    if (msg.cost > 0) record.cost = msg.cost;
    if (msg.agent !== undefined) record.agent = msg.agent;
    setWorkspace(record, ws);

    states.push({ hasEmbeddedMessageId: msg.id !== undefined, hasWorkspaceConflict: false });
    indexByFingerprint.set(fp, records.length);
    records.push(record);
  }

  return records;
}

// ─────────────────────────────────────────────────────────────────────────
// Reader singleton
// ─────────────────────────────────────────────────────────────────────────

/** The OpenCode usage reader singleton. */
const opencodeReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    const dbPath = firstExistingRoot(PLATFORM_ID);
    if (dbPath === undefined) return []; // no opencode.db → fail-open

    const db = await openSqlite(dbPath);
    if (db === null) return []; // missing/locked/unreadable/corrupt → fail-open

    try {
      const rows = parseDb(db);
      if (sinceMs === undefined) return rows;
      return rows.filter((r) => r.ts >= sinceMs);
    } catch {
      return []; // any unexpected error → fail-open
    } finally {
      db.close();
    }
  },
};

export default opencodeReader;
