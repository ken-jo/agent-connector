/**
 * usage/readers/hermes — Hermes Agent usage reader (SQLite, sessions table).
 *
 * Faithful port of tokscale sessions/hermes.rs. Hermes stores one aggregated row
 * per session in a `sessions` table inside a single SQLite database:
 *   • ~/.hermes/state.db
 *   • $HERMES_HOME/state.db   (when HERMES_HOME is set, non-empty)
 * (the AGENTCONNECT_HERMES_DIR override + the ~/.hermes default are resolved by
 * paths.ts hostRoots("hermes"); HERMES_HOME is honored here, ahead of those, to
 * match the Rust storage-path spec which the fixed paths.ts does not encode.)
 *
 * One SELECT pulls every session that carries a model and at least one token/cost
 * signal (port of the Rust query verbatim):
 *   SELECT id, model, billing_provider, started_at, message_count,
 *          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
 *          reasoning_tokens, estimated_cost_usd, actual_cost_usd
 *   FROM sessions
 *   WHERE model IS NOT NULL AND TRIM(model) != ''
 *     AND ( COALESCE(input_tokens,0)        > 0
 *        OR COALESCE(output_tokens,0)       > 0
 *        OR COALESCE(cache_read_tokens,0)   > 0
 *        OR COALESCE(cache_write_tokens,0)  > 0
 *        OR COALESCE(reasoning_tokens,0)    > 0
 *        OR COALESCE(actual_cost_usd, estimated_cost_usd, 0) > 0 )
 *
 * Token extraction (flat columns, no JSON nesting — each NULL → 0, clamped ≥ 0):
 *   input      = input_tokens
 *   output     = output_tokens
 *   cacheRead  = cache_read_tokens
 *   cacheWrite = cache_write_tokens
 *   reasoning  = reasoning_tokens
 * Cost = actual_cost_usd ?? estimated_cost_usd ?? 0 (clamped ≥ 0, prefer actual).
 *
 * Model: the `model` column (the WHERE already drops null/blank). Provider (port of
 * resolved_provider): canonical_provider() of a non-blank `billing_provider`, else
 * inferProvider(model), else "hermes". Timestamp: `started_at` (f64) disambiguated
 * seconds-vs-milliseconds (> 1e12 → ms as-is, else × 1000). Session id = the `id`
 * column, which is also the dedup key (one row per session). messageCount =
 * `message_count` (clamped ≥ 0). agent fixed to "Hermes Agent". No project/workspace
 * in the schema. Confidence is "host-reported".
 *
 * Fail-open: db missing/locked/unreadable → openSqlite returns null → []; a bad row
 * is skipped, never thrown.
 */

import { join } from "node:path";

import type { UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { inferProvider } from "../normalize.js";
import { firstExistingRoot } from "../paths.js";
import { openSqlite } from "../sqlite.js";

const PLATFORM_ID = "hermes" as const;
const DEFAULT_PROVIDER = "hermes";
const HERMES_AGENT_NAME = "Hermes Agent";

/** The session columns we read (everything optional / unknown off the row). */
interface HermesRow {
  id?: unknown;
  model?: unknown;
  billing_provider?: unknown;
  started_at?: unknown;
  message_count?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_tokens?: unknown;
  cache_write_tokens?: unknown;
  reasoning_tokens?: unknown;
  estimated_cost_usd?: unknown;
  actual_cost_usd?: unknown;
}

const QUERY = `
  SELECT
    id,
    model,
    billing_provider,
    started_at,
    message_count,
    input_tokens,
    output_tokens,
    cache_read_tokens,
    cache_write_tokens,
    reasoning_tokens,
    estimated_cost_usd,
    actual_cost_usd
  FROM sessions
  WHERE model IS NOT NULL
    AND TRIM(model) != ''
    AND (
      COALESCE(input_tokens, 0) > 0 OR
      COALESCE(output_tokens, 0) > 0 OR
      COALESCE(cache_read_tokens, 0) > 0 OR
      COALESCE(cache_write_tokens, 0) > 0 OR
      COALESCE(reasoning_tokens, 0) > 0 OR
      COALESCE(actual_cost_usd, estimated_cost_usd, 0) > 0
    )
`;

// ─────────────────────────────────────────────────────────────────────────
// DB path resolution (honor $HERMES_HOME, ahead of paths.ts defaults)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Resolve the Hermes state DB. The Rust spec lists both `~/.hermes/state.db` and
 * `$HERMES_HOME/state.db`; the fixed paths.ts only encodes the former (+ the
 * AGENTCONNECT_HERMES_DIR override), so we honor HERMES_HOME first here.
 * Returns the first existing candidate, or undefined when none is present.
 */
function resolveDbPath(): string | undefined {
  const home = process.env.HERMES_HOME;
  if (home != null && home.trim() !== "") {
    const candidate = join(home.trim(), "state.db");
    // existsSync is checked by openSqlite (returns null on a missing file), but we
    // still need an explicit candidate; let firstExistingRoot cover the default.
    return candidate;
  }
  return firstExistingRoot(PLATFORM_ID);
}

// ─────────────────────────────────────────────────────────────────────────
// Provider resolution (port of provider_identity.rs canonical_provider)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Canonicalize a single provider segment (port of canonicalize_provider_segment):
 * trim, drop a trailing slash, lowercase, `-`→`_`; reject `<…>` placeholders, the
 * empty/`unknown` segment, and unknown segments that contain a digit (those are
 * model-name fragments). Returns the canonical id or undefined.
 */
function canonicalizeProviderSegment(segment: string): string | undefined {
  const normalized = segment.trim().replace(/\/+$/, "").toLowerCase().replace(/-/g, "_");
  if (normalized.startsWith("<") && normalized.endsWith(">")) return undefined;
  switch (normalized) {
    case "":
    case "unknown":
      return undefined;
    case "x_ai":
    case "xai":
      return "xai";
    case "z_ai":
    case "zai":
      return "zai";
    case "moonshot":
    case "moonshotai":
      return "moonshotai";
    case "meta":
    case "meta_llama":
      return "meta_llama";
    case "azure":
    case "azure_ai":
      return "azure_ai";
    case "anthropic":
    case "vertex":
    case "vertex_ai":
      return "anthropic";
    case "together":
    case "together_ai":
      return "together_ai";
    case "fireworks":
    case "fireworks_ai":
      return "fireworks_ai";
    case "google":
    case "gemini":
      return "google";
    case "openai":
    case "openai_codex":
      return "openai";
    case "minimax":
    case "minimaxai":
    case "minimax_ai":
      return "minimax";
    case "mistral":
    case "mistralai":
      return "mistralai";
    case "ai21":
      return "ai21";
    default:
      if (/[0-9]/.test(normalized)) return undefined;
      return normalized;
  }
}

/**
 * Port of canonical_provider: the first canonical tag from `provider_tags(raw)`
 * (split on '/', and for any dotted segment also try its dot-parts), or undefined
 * when no segment canonicalizes — so the resolver can fall through to model
 * inference, matching the Rust `Option<String>` semantics.
 */
function canonicalProvider(raw: string): string | undefined {
  for (const segment of raw.trim().replace(/\/+$/, "").split("/")) {
    const tag = canonicalizeProviderSegment(segment);
    if (tag !== undefined) return tag;
    if (segment.includes(".")) {
      for (const dotted of segment.split(".")) {
        const dottedTag = canonicalizeProviderSegment(dotted);
        if (dottedTag !== undefined) return dottedTag;
      }
    }
  }
  return undefined;
}

/**
 * Resolve the provider (port of resolved_provider): canonical_provider of a
 * non-blank `billing_provider`, else inferProvider(model), else "hermes".
 */
function resolvedProvider(billingProvider: unknown, modelId: string): string {
  if (typeof billingProvider === "string") {
    const trimmed = billingProvider.trim();
    if (trimmed !== "") {
      const canonical = canonicalProvider(trimmed);
      if (canonical !== undefined) return canonical;
    }
  }
  return inferProvider(modelId) ?? DEFAULT_PROVIDER;
}

// ─────────────────────────────────────────────────────────────────────────
// Numbers & timestamps
// ─────────────────────────────────────────────────────────────────────────

/** Coerce an unknown SQLite cell to an integer ≥ 0 (port of `Option<i64>?.unwrap_or(0).max(0)`). */
function tokenCell(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/** Coerce an unknown SQLite cell to a finite float, or null when absent/garbage. */
function floatOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Disambiguate `started_at` (f64) seconds-vs-milliseconds (port of
 * timestamp_secs_to_ms): values already in ms (> 1e12) pass through truncated to
 * an integer; smaller values are treated as seconds and scaled × 1000.
 */
function timestampSecsToMs(timestamp: number): number {
  return timestamp > 1e12 ? Math.trunc(timestamp) : Math.trunc(timestamp * 1000);
}

// ─────────────────────────────────────────────────────────────────────────
// Reader
// ─────────────────────────────────────────────────────────────────────────

/** The Hermes Agent usage reader singleton. */
const hermesReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    const dbPath = resolveDbPath();
    if (dbPath === undefined) return []; // no state.db → fail-open

    const db = await openSqlite(dbPath);
    if (db === null) return []; // missing / locked / unreadable / non-sqlite → fail-open

    try {
      const rows = db.all(QUERY); // bad SQL / schema mismatch → [] (fail-open)
      const records: UsageRecord[] = [];

      for (const raw of rows) {
        const row = raw as HermesRow;

        // id and model are read as non-null strings in the Rust decode; the WHERE
        // clause already enforces a non-blank model, but we mirror the decode by
        // skipping any row whose id/model is not a usable string.
        const sessionId = row.id;
        if (typeof sessionId !== "string" || sessionId === "") continue;

        const modelId = row.model;
        if (typeof modelId !== "string" || modelId.trim() === "") continue;

        const startedAt = floatOrNull(row.started_at) ?? 0;
        const ts = timestampSecsToMs(startedAt);
        if (sinceMs !== undefined && ts < sinceMs) continue;

        const providerId = resolvedProvider(row.billing_provider, modelId);

        const tokens = emptyTokens();
        tokens.input = tokenCell(row.input_tokens);
        tokens.output = tokenCell(row.output_tokens);
        tokens.cacheRead = tokenCell(row.cache_read_tokens);
        tokens.cacheWrite = tokenCell(row.cache_write_tokens);
        tokens.reasoning = tokenCell(row.reasoning_tokens);

        // Cost: prefer actual, fall back to estimated, default 0 — clamped ≥ 0.
        const actual = floatOrNull(row.actual_cost_usd);
        const estimated = floatOrNull(row.estimated_cost_usd);
        const cost = Math.max(0, actual ?? estimated ?? 0);

        // message_count: Option<i32>.unwrap_or(0).max(0).
        const messageCount = tokenCell(row.message_count);

        const record: UsageRecord = {
          platformId: PLATFORM_ID,
          modelId,
          providerId,
          sessionId,
          tokens,
          cost,
          ts,
          messageCount,
          dedupKey: sessionId, // one row per session → session id is the dedup key
          confidence: "host-reported",
          agent: HERMES_AGENT_NAME,
        };
        records.push(record);
      }

      return records;
    } finally {
      db.close();
    }
  },
};

export default hermesReader;
