/**
 * usage/readers/warp — Warp/Oz SYNCED, AGGREGATE-ONLY usage reader.
 *
 * Faithful port of tokscale sessions/warp.rs (parse_warp_file + usage_to_message
 * + workspace_to_message). Warp is a SYNCED platform whose usage lives behind a
 * cloud GraphQL API (app.warp.dev/graphql/v2): tokscale authenticates with a
 * stored Bearer/Cookie credential, runs GetRequestLimitInfo +
 * GetWorkspacesMetadataForUser, and writes the normalized result to a local
 * cache. WE DO NOT PERFORM THAT SYNC — no auth, no GraphQL, no network of any
 * kind. We only READ the local cache artifact a separate tokscale run may have
 * produced; the credentials.json beside it is ignored entirely (never read,
 * never used). If no cache exists, the scan layer notes "requires sync, skipped"
 * and we return [].
 *
 * Local cache: ~/.config/tokscale/warp-cache/usage.json (env override
 * AGENT_CONNECTOR_WARP_DIR; resolved by paths.ts). Schema (camelCase JSON):
 *   { syncedAt: RFC3339 string,
 *     usage:   { requestsUsed, spendCents },           // account aggregate
 *     workspaces: [ { id, name, requestsUsed, spendCents }, … ] }
 *
 * Warp exposes ONLY an aggregate request-count + spend — there is NO token
 * breakdown (no input/output/cache/reasoning). So every emitted record carries
 * an all-zero TokenBreakdown, the spend (cents → USD) in `cost`, the request
 * count in `messageCount`, and a synthetic model id "aggregate-requests" under a
 * synthetic session id. Confidence is "host-estimated": these rows are NOT
 * comparable to real token rows and are clearly labeled aggregate-only.
 *
 * Attribution mirrors the Rust:
 *   - If the cache lists non-empty `workspaces[]`, one record per workspace with
 *     a usable count/spend, session id "warp-aggregate-{sanitized-id}", and the
 *     workspace id/name mapped to projectKey/projectLabel.
 *   - Otherwise fall back to a single account-level record, session id
 *     "warp-aggregate-account".
 * The synced timestamp (`syncedAt`) is the row ts; a cache with no parseable
 * positive timestamp yields no rows (matches the Rust `timestamp <= 0` guard).
 *
 * Fail-open: no cache file → []; unreadable/malformed JSON → []; a row with both
 * requests and spend at zero is dropped.
 */

import { join } from "node:path";

import type { UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { readJsonFile } from "../jsonl.js";
import { firstExistingRoot } from "../paths.js";

const PLATFORM_ID = "warp" as const;
const PROVIDER = "warp";
/** Synthetic model label — Warp returns aggregate requests, not per-model usage. */
const AGGREGATE_MODEL = "aggregate-requests";
const ACCOUNT_SESSION = "warp-aggregate-account";
const MAX_I32 = 2147483647; // request count is clamped to i32 (port of non_negative_i32).

// ─────────────────────────────────────────────────────────────────────────
// Cache schema (everything optional / unknown — tolerant narrowing below).
// ─────────────────────────────────────────────────────────────────────────

interface WarpAggregateUsage {
  requestsUsed?: unknown;
  spendCents?: unknown;
}

interface WarpWorkspaceUsage {
  id?: unknown;
  name?: unknown;
  requestsUsed?: unknown;
  spendCents?: unknown;
}

interface WarpUsageCache {
  syncedAt?: unknown;
  usage?: unknown;
  workspaces?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────
// Coercion helpers (ports of the Rust non_negative_* / cents_to_dollars).
// ─────────────────────────────────────────────────────────────────────────

/** Coerce to a non-negative i64-safe integer (number or numeric string; 0 otherwise). */
function nonNegativeInt(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/** Request count clamped into i32 range (port of non_negative_i32). */
function nonNegativeRequests(v: unknown): number {
  return Math.min(nonNegativeInt(v), MAX_I32);
}

/** Cents → dollars (port of cents_to_dollars). */
function centsToDollars(cents: number): number {
  return cents / 100;
}

/** A non-empty trimmed string, or undefined. */
function nonEmptyStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return v.trim() === "" ? undefined : v;
}

/**
 * Parse an RFC3339 (or numeric) sync timestamp to epoch ms, or 0 when unusable
 * (port of parse_rfc3339_millis + the `unwrap_or(0)` fallback; the caller drops
 * a non-positive result).
 */
function parseSyncedAtMs(v: unknown): number {
  if (typeof v === "string") {
    const ms = Date.parse(v.trim());
    if (!Number.isNaN(ms)) return ms;
    const num = Number(v.trim());
    if (Number.isFinite(num) && num > 0) return num >= 1e12 ? num : num * 1000;
    return 0;
  }
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return v >= 1e12 ? v : v * 1000;
  }
  return 0;
}

/**
 * Sanitize a workspace id for use in a synthetic session key (port of
 * sanitize_id): trim, lowercase, replace any char that is not [a-z0-9-_.] with
 * '-', then strip leading/trailing '-'. May return "" (caller defaults to
 * "unknown").
 */
function sanitizeId(value: string): string {
  let out = "";
  for (const ch of value.trim().toLowerCase()) {
    const ok = /[a-z0-9\-_.]/.test(ch);
    out += ok ? ch : "-";
  }
  return out.replace(/^-+/, "").replace(/-+$/, "");
}

// ─────────────────────────────────────────────────────────────────────────
// Record builders (ports of usage_to_message / workspace_to_message).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build one aggregate UsageRecord. `tokens` is always all-zero (Warp has no
 * token breakdown); `cost` carries the spend and `messageCount` the request
 * count. A stable `dedupKey` (session + sync ts) prevents double-counting if the
 * same cache is scanned twice.
 */
function buildRecord(
  sessionId: string,
  requests: number,
  spendCents: number,
  ts: number,
  workspace?: { projectKey?: string; projectLabel?: string },
): UsageRecord {
  const record: UsageRecord = {
    platformId: PLATFORM_ID,
    modelId: AGGREGATE_MODEL,
    providerId: PROVIDER,
    sessionId,
    tokens: emptyTokens(), // no token breakdown — all dimensions stay 0.
    cost: centsToDollars(spendCents),
    ts,
    messageCount: requests,
    dedupKey: `warp:${sessionId}:${ts}`,
    confidence: "host-estimated", // aggregate-only; not comparable to token rows.
  };
  if (workspace?.projectKey !== undefined) record.projectKey = workspace.projectKey;
  if (workspace?.projectLabel !== undefined) record.projectLabel = workspace.projectLabel;
  return record;
}

/** Port of usage_to_message: account-level aggregate, or undefined when empty. */
function accountRecord(usage: WarpAggregateUsage, ts: number): UsageRecord | undefined {
  const requests = nonNegativeRequests(usage.requestsUsed);
  const spendCents = nonNegativeInt(usage.spendCents);
  if (requests === 0 && spendCents === 0) return undefined;
  return buildRecord(ACCOUNT_SESSION, requests, spendCents, ts);
}

/** Port of workspace_to_message: per-workspace aggregate, or undefined when empty. */
function workspaceRecord(ws: WarpWorkspaceUsage, ts: number): UsageRecord | undefined {
  const requests = nonNegativeRequests(ws.requestsUsed);
  const spendCents = nonNegativeInt(ws.spendCents);
  if (requests === 0 && spendCents === 0) return undefined;

  const rawId = nonEmptyStr(ws.id);
  const sanitized = rawId !== undefined ? sanitizeId(rawId) : "";
  const idForSession = sanitized !== "" ? sanitized : "unknown";

  // set_workspace: original (untrimmed-but-non-blank) id/name → project key/label.
  const project: { projectKey?: string; projectLabel?: string } = {};
  if (rawId !== undefined) project.projectKey = rawId;
  const name = nonEmptyStr(ws.name);
  if (name !== undefined) project.projectLabel = name;

  return buildRecord(`warp-aggregate-${idForSession}`, requests, spendCents, ts, project);
}

// ─────────────────────────────────────────────────────────────────────────
// Reader
// ─────────────────────────────────────────────────────────────────────────

/** The Warp synced, aggregate-only usage reader singleton. */
const warpReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "synced",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    // Local cache root: ~/.config/tokscale/warp-cache (or env override). Absent →
    // no sync has populated it → fail-open to [] (scan notes "requires sync,
    // skipped"). We NEVER authenticate or call any GraphQL/network API.
    const cacheRoot = firstExistingRoot(PLATFORM_ID);
    if (cacheRoot === undefined) return [];

    const data = readJsonFile(join(cacheRoot, "usage.json"));
    if (data === undefined || data === null || typeof data !== "object") return [];
    const cache = data as WarpUsageCache;

    const ts = parseSyncedAtMs(cache.syncedAt);
    if (ts <= 0) return []; // no parseable sync time → no rows (port of timestamp <= 0).

    // Prefer per-workspace rows; fall back to the account aggregate when none.
    const records: UsageRecord[] = [];
    if (Array.isArray(cache.workspaces)) {
      for (const entry of cache.workspaces) {
        if (typeof entry !== "object" || entry === null) continue;
        const rec = workspaceRecord(entry as WarpWorkspaceUsage, ts);
        if (rec !== undefined) records.push(rec);
      }
    }
    if (records.length === 0 && cache.usage !== undefined && cache.usage !== null && typeof cache.usage === "object") {
      const rec = accountRecord(cache.usage as WarpAggregateUsage, ts);
      if (rec !== undefined) records.push(rec);
    }

    if (sinceMs !== undefined) {
      return records.filter((r) => r.ts >= sinceMs);
    }
    return records;
  },
};

export default warpReader;
