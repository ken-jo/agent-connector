/**
 * usage/aggregate — token math, cross-source de-dup, and group-by rollups.
 *
 * Ports tokscale's shared aggregation model (docs/research/usage-shared-model.md
 * §4–5): a TokenBreakdown total is the sum of all five dimensions; dedup keeps
 * the FIRST occurrence per dedupKey in insertion order (un-keyed records always
 * pass through); group-by folds records into UsageSummary rows summing tokens /
 * cost / messages, counting distinct sessions, tracking the worst confidence and
 * the latest timestamp, sorted by total desc.
 */

import type {
  TokenBreakdown,
  UsageConfidence,
  UsageGroupBy,
  UsageRecord,
  UsageSummary,
} from "./types.js";
import { normalizeModelForGrouping } from "./normalize.js";

// ─────────────────────────────────────────────────────────────────────────
// Token helpers
// ─────────────────────────────────────────────────────────────────────────

/** A fresh all-zero TokenBreakdown. */
export function emptyTokens(): TokenBreakdown {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

/** Element-wise sum of two breakdowns into a NEW object (operands untouched). */
export function addTokens(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
  };
}

/** Scalar total across all five token dimensions. */
export function sumTokens(t: TokenBreakdown): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite + t.reasoning;
}

/** Accumulate `b` into `a` in place (used inside the rollup fold). */
function addTokensInPlace(a: TokenBreakdown, b: TokenBreakdown): void {
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheWrite += b.cacheWrite;
  a.reasoning += b.reasoning;
}

// ─────────────────────────────────────────────────────────────────────────
// Confidence
// ─────────────────────────────────────────────────────────────────────────

/** Least-trustworthy (0) → most-trustworthy. host-estimated is the weaker. */
const CONFIDENCE_RANK: Record<UsageConfidence, number> = {
  "host-estimated": 0,
  "host-reported": 1,
};

/** The worse (least-confident) of two provenance labels. */
export function worstConfidence(a: UsageConfidence, b: UsageConfidence): UsageConfidence {
  return CONFIDENCE_RANK[b] < CONFIDENCE_RANK[a] ? b : a;
}

// ─────────────────────────────────────────────────────────────────────────
// De-duplication
// ─────────────────────────────────────────────────────────────────────────

/**
 * Cross-source de-dup. Keep the FIRST record seen per `dedupKey` in insertion
 * order; records without a dedupKey always pass through (the per-reader dedup is
 * the real safeguard — this is the global backstop, per shared-model §5 and
 * design §6). Deterministic: same input order → same output.
 */
export function dedupe(records: UsageRecord[]): UsageRecord[] {
  const seen = new Set<string>();
  const out: UsageRecord[] = [];
  for (const rec of records) {
    const key = rec.dedupKey;
    if (key === undefined || key === "") {
      out.push(rec); // un-keyed → always include
      continue;
    }
    if (!seen.has(key)) {
      seen.add(key);
      out.push(rec);
    }
    // duplicate key → drop (keep-first)
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Group-by aggregation
// ─────────────────────────────────────────────────────────────────────────

/** Local YYYY-MM-DD for an epoch-ms timestamp (matches tokscale's local-tz date). */
function localDay(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The grouping key value for a record under the requested dimension. */
function groupKey(rec: UsageRecord, by: UsageGroupBy): string {
  switch (by) {
    case "platform":
      return rec.platformId;
    case "project":
      return rec.projectLabel ?? rec.projectKey ?? "(no project)";
    case "session":
      return rec.sessionId;
    case "model":
      return normalizeModelForGrouping(rec.modelId);
    case "day":
      return localDay(rec.ts);
  }
}

interface MutableSummary extends UsageSummary {
  /** Distinct session ids folded into this group (counted at finalization). */
  _sessions: Set<string>;
}

/**
 * Roll records up into {@link UsageSummary} rows by the chosen dimension. Tokens,
 * cost, and message counts sum; `sessions` counts distinct session ids; the row
 * carries the worst confidence and the latest timestamp seen. Sorted by total
 * tokens descending (ties broken by recency).
 */
export function aggregateBy(records: UsageRecord[], by: UsageGroupBy): UsageSummary[] {
  const groups = new Map<string, MutableSummary>();

  for (const rec of records) {
    const key = groupKey(rec, by);
    let g = groups.get(key);
    if (g === undefined) {
      g = {
        key,
        tokens: emptyTokens(),
        total: 0,
        sessions: 0,
        messages: 0,
        confidence: rec.confidence,
        lastTs: rec.ts,
        _sessions: new Set<string>(),
      };
      groups.set(key, g);
    }

    addTokensInPlace(g.tokens, rec.tokens);
    g.messages += rec.messageCount;
    g._sessions.add(rec.sessionId);
    g.confidence = worstConfidence(g.confidence, rec.confidence);
    if (rec.ts > g.lastTs) g.lastTs = rec.ts;
    if (rec.cost !== undefined) g.cost = (g.cost ?? 0) + rec.cost;
  }

  const rows: UsageSummary[] = [];
  for (const g of groups.values()) {
    const { _sessions, ...summary } = g;
    summary.total = sumTokens(summary.tokens);
    summary.sessions = _sessions.size;
    rows.push(summary);
  }

  rows.sort((a, b) => b.total - a.total || b.lastTs - a.lastTs);
  return rows;
}
