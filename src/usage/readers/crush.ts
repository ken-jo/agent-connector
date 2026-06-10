/**
 * usage/readers/crush — Crush CLI usage reader (SQLite, cost-only).
 *
 * Faithful port of tokscale sessions/crush.rs. Crush persists usage in a single
 * SQLite database at ~/.cache/crush/crush.db (the host root, incl. the
 * AGENT_CONNECTOR_CRUSH_DIR override, is resolved by paths.ts hostRoots("crush")).
 *
 * Crush stores reliable session-level COST but NOT a stable per-message token
 * breakdown. Tokscale v1 therefore preserves cost and assistant-message counts
 * without fabricating token precision:
 *   - assistant messages (across the whole session tree) are grouped by LOCAL day;
 *   - the root session's cost is allocated across those day buckets in proportion
 *     to each bucket's assistant-message count (the last bucket absorbs the
 *     rounding remainder so the per-day costs sum back to the stored total);
 *   - all five token dimensions stay 0;
 *   - confidence is "host-estimated" (cost is real, tokens are not reported).
 * A costed root session with no assistant messages emits a single zero-count,
 * cost-bearing record at its updated_at (else created_at) timestamp.
 *
 * Two SELECTs:
 *   1. root sessions — SELECT id, cost, created_at, updated_at FROM sessions
 *      WHERE parent_session_id IS NULL
 *        AND (COALESCE(message_count,0) > 0 OR COALESCE(cost,0) > 0)
 *      ORDER BY created_at ASC;
 *   2. assistant message timestamps, attributed to their ROOT session via a
 *      RECURSIVE CTE over parent_session_id (so a descendant session's assistant
 *      messages count toward its root), filtered to role = 'assistant'.
 *
 * Timestamps tolerate both second-precision (auto ×1000) and millisecond-precision
 * values; non-positive timestamps are dropped. Model/provider are the constants
 * "session-total" / "crush". Session id = "<db_path>:<root_session_id>". No
 * project/workspace in the schema.
 *
 * Fail-open: db missing/locked/unreadable → openSqlite returns null → []; no root
 * sessions → []; a bad row is skipped, never thrown.
 */

import type { TokenBreakdown, UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { firstExistingRoot } from "../paths.js";
import { openSqlite } from "../sqlite.js";

const PLATFORM_ID = "crush" as const;
const CRUSH_MODEL_ID = "session-total";
const CRUSH_PROVIDER_ID = "crush";

/** Root session row (cost lives here; tokens are not trustworthy per-message). */
interface CrushSession {
  id: string;
  cost: number;
  createdAt: number;
  updatedAt: number;
}

/** One local-day bucket of assistant messages within a root session. */
interface DayBucket {
  timestampMs: number;
  messageCount: number;
}

const ROOT_SESSIONS_QUERY = `
  SELECT id, cost, created_at, updated_at
  FROM sessions
  WHERE parent_session_id IS NULL
    AND (COALESCE(message_count, 0) > 0 OR COALESCE(cost, 0) > 0)
  ORDER BY created_at ASC
`;

const ASSISTANT_BUCKETS_QUERY = `
  WITH RECURSIVE session_tree(root_session_id, session_id) AS (
    SELECT id, id
    FROM sessions
    WHERE parent_session_id IS NULL

    UNION ALL

    SELECT st.root_session_id, s.id
    FROM sessions s
    JOIN session_tree st ON s.parent_session_id = st.session_id
  )
  SELECT st.root_session_id, m.created_at
  FROM session_tree st
  JOIN messages m ON m.session_id = st.session_id
  WHERE m.role = 'assistant'
  ORDER BY st.root_session_id ASC, m.created_at ASC
`;

/** Coerce an unknown SQLite cell to a finite number, or null when absent/garbage. */
function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Coerce an unknown SQLite cell to an integer (0 on absence/garbage). */
function toInt(v: unknown): number {
  const n = toNumberOrNull(v);
  return n === null ? 0 : Math.trunc(n);
}

/**
 * Normalize a raw Crush timestamp to epoch ms (port of normalize_crush_timestamp_ms):
 * non-positive → null; values >= 100_000_000_000 are already ms; smaller values are
 * seconds and are multiplied by 1000.
 */
function normalizeCrushTimestampMs(raw: number): number | null {
  if (raw <= 0) return null;
  if (raw >= 100_000_000_000) return raw;
  return raw * 1000;
}

/**
 * Local-day key "YYYY-MM-DD" for an epoch-ms timestamp (port of local_day_key):
 * uses the host LOCAL timezone (matches chrono::Local), so buckets follow the
 * machine's calendar day. Returns null when the timestamp is not a valid date.
 */
function localDayKey(timestampMs: number): string | null {
  const d = new Date(timestampMs);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  return `${year.toString().padStart(4, "0")}-${month
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

/**
 * Fallback session timestamp (port of fallback_session_timestamp_ms): updated_at,
 * else created_at, each run through the s↔ms normalization.
 */
function fallbackSessionTimestampMs(updatedAt: number, createdAt: number): number | null {
  return normalizeCrushTimestampMs(updatedAt) ?? normalizeCrushTimestampMs(createdAt);
}

/** Load root sessions carrying a message count or cost (port of load_root_sessions). */
function loadRootSessions(db: { all(sql: string): Array<Record<string, unknown>> }): CrushSession[] {
  const out: CrushSession[] = [];
  for (const row of db.all(ROOT_SESSIONS_QUERY)) {
    const id = row.id;
    if (typeof id !== "string") continue;
    out.push({
      id,
      cost: toNumberOrNull(row.cost) ?? 0,
      createdAt: toInt(row.created_at),
      updatedAt: toInt(row.updated_at),
    });
  }
  return out;
}

/**
 * Bucket assistant messages by root session + local day (port of
 * load_assistant_buckets). The recursive CTE attributes every descendant
 * session's assistant messages to its root; within a root the per-day bucket
 * keeps the MIN timestamp and counts the messages, and buckets are emitted in
 * ascending day order (BTreeMap → insertion-ordered Map keyed by day).
 */
function loadAssistantBuckets(
  db: { all(sql: string): Array<Record<string, unknown>> },
): Map<string, DayBucket[]> {
  // root session id → (local day → bucket), days kept sorted ascending.
  const sessionDays = new Map<string, Map<string, DayBucket>>();

  for (const row of db.all(ASSISTANT_BUCKETS_QUERY)) {
    const sessionId = row.root_session_id;
    if (typeof sessionId !== "string") continue;

    const createdAt = toInt(row.created_at);
    const timestampMs = normalizeCrushTimestampMs(createdAt);
    if (timestampMs === null) continue;
    const day = localDayKey(timestampMs);
    if (day === null) continue;

    let dayMap = sessionDays.get(sessionId);
    if (dayMap === undefined) {
      dayMap = new Map<string, DayBucket>();
      sessionDays.set(sessionId, dayMap);
    }
    const existing = dayMap.get(day);
    if (existing === undefined) {
      dayMap.set(day, { timestampMs, messageCount: 1 });
    } else {
      existing.timestampMs = Math.min(existing.timestampMs, timestampMs);
      existing.messageCount += 1;
    }
  }

  const out = new Map<string, DayBucket[]>();
  for (const [sessionId, dayMap] of sessionDays) {
    // Sort by day key ascending to mirror the Rust BTreeMap iteration order.
    const sortedDays = [...dayMap.keys()].sort();
    out.set(
      sessionId,
      sortedDays.map((day) => dayMap.get(day) as DayBucket),
    );
  }
  return out;
}

/** The Crush CLI usage reader singleton. */
const crushReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    const dbPath = firstExistingRoot(PLATFORM_ID);
    if (dbPath === undefined) return []; // no crush.db → fail-open

    const db = await openSqlite(dbPath);
    if (db === null) return []; // missing / locked / unreadable / non-sqlite → fail-open

    try {
      const rootSessions = loadRootSessions(db);
      if (rootSessions.length === 0) return [];

      const assistantBuckets = loadAssistantBuckets(db);
      const records: UsageRecord[] = [];

      for (const session of rootSessions) {
        const sessionKey = `${dbPath}:${session.id}`;
        const dayBuckets = assistantBuckets.get(session.id);

        if (dayBuckets !== undefined && dayBuckets.length > 0) {
          const totalAssistantMessages = dayBuckets.reduce(
            (sum, bucket) => sum + bucket.messageCount,
            0,
          );
          const safeCost = Math.max(0, session.cost);
          let allocatedCost = 0;

          for (let index = 0; index < dayBuckets.length; index++) {
            const bucket = dayBuckets[index] as DayBucket;
            // Last bucket absorbs the remainder so per-day costs sum to the total.
            const bucketCost =
              index + 1 === dayBuckets.length
                ? Math.max(0, safeCost - allocatedCost)
                : totalAssistantMessages > 0
                  ? (safeCost * bucket.messageCount) / totalAssistantMessages
                  : 0;
            allocatedCost += bucketCost;

            const tokens: TokenBreakdown = emptyTokens(); // tokens stay all-zero
            const record: UsageRecord = {
              platformId: PLATFORM_ID,
              modelId: CRUSH_MODEL_ID,
              providerId: CRUSH_PROVIDER_ID,
              sessionId: sessionKey,
              tokens,
              cost: bucketCost,
              ts: bucket.timestampMs,
              messageCount: Math.max(0, bucket.messageCount),
              confidence: "host-estimated",
            };
            if (sinceMs === undefined || record.ts >= sinceMs) records.push(record);
          }

          continue;
        }

        // No assistant messages: emit a single cost-only record (when costed).
        if (session.cost <= 0) continue;

        const ts = fallbackSessionTimestampMs(session.updatedAt, session.createdAt);
        if (ts === null) continue;

        const record: UsageRecord = {
          platformId: PLATFORM_ID,
          modelId: CRUSH_MODEL_ID,
          providerId: CRUSH_PROVIDER_ID,
          sessionId: sessionKey,
          tokens: emptyTokens(),
          cost: Math.max(0, session.cost),
          ts,
          messageCount: 0,
          confidence: "host-estimated",
        };
        if (sinceMs === undefined || record.ts >= sinceMs) records.push(record);
      }

      // Sort by timestamp asc, then session id (port of the Rust final sort).
      records.sort((a, b) => a.ts - b.ts || a.sessionId.localeCompare(b.sessionId));
      return records;
    } finally {
      db.close();
    }
  },
};

export default crushReader;
