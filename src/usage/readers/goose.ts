/**
 * usage/readers/goose — Goose CLI usage reader (SQLite, sessions table).
 *
 * Faithful port of tokscale sessions/goose.rs. Goose stores one row per session
 * in a `sessions` table inside a single SQLite database:
 *   • Linux:  ~/.local/share/goose/sessions/sessions.db
 *   • macOS:  ~/Library/Application Support/goose/sessions/sessions.db
 *   • Legacy: ~/.local/share/Block/goose/sessions/sessions.db
 * (host roots, incl. the AGENT_CONNECTOR_GOOSE_DIR override, are resolved by
 * paths.ts hostRoots("goose"); the macOS / Block variants are listed there.)
 *
 * One SELECT pulls every session that carries a model config:
 *   SELECT id, model_config_json, provider_name, created_at,
 *          total_tokens, input_tokens, output_tokens,
 *          accumulated_total_tokens, accumulated_input_tokens,
 *          accumulated_output_tokens
 *   FROM sessions
 *   WHERE model_config_json IS NOT NULL AND TRIM(model_config_json) != ''
 *
 * Token extraction (flat columns, no JSON token nesting):
 *   input  = accumulated_input_tokens  ?? input_tokens  ?? 0   (clamped ≥ 0)
 *   output = accumulated_output_tokens ?? output_tokens ?? 0   (clamped ≥ 0)
 *   total  = accumulated_total_tokens  ?? total_tokens  ?? 0   (clamped ≥ 0)
 *   reasoning = total > input + output ? total - input - output : 0  (INFERRED)
 *   cacheRead / cacheWrite are always 0 (Goose does not report them).
 * Rows with input == 0 && output == 0 && total == 0 are skipped.
 *
 * The reasoning value is *inferred*, not host-reported (Goose has no reasoning
 * column); we surface it but flag the inference in `detail`.
 *
 * Model: `model_config_json` is parsed for its `model_name` field (trimmed; the
 * row is dropped when it is missing/empty). Provider: canonical_provider() of the
 * `provider_name` column when present, else inferProvider(model), else "goose".
 * Timestamp: `created_at` (RFC3339, "YYYY-MM-DD HH:MM:SS", or "YYYY-MM-DD"),
 * parsed to epoch ms then disambiguated s↔ms. Session id = the `id` column, which
 * is also the dedup key (one row per session). No project/workspace in the schema.
 * Confidence is "host-reported".
 *
 * Fail-open: db missing/locked/unreadable → openSqlite returns null → []; a bad
 * row is skipped, never thrown.
 */

import type { UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { inferProvider } from "../normalize.js";
import { firstExistingRoot } from "../paths.js";
import { openSqlite } from "../sqlite.js";

const PLATFORM_ID = "goose" as const;
const DEFAULT_PROVIDER = "goose";

/** The session columns we read (everything optional / unknown off the row). */
interface GooseRow {
  id?: unknown;
  model_config_json?: unknown;
  provider_name?: unknown;
  created_at?: unknown;
  total_tokens?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  accumulated_total_tokens?: unknown;
  accumulated_input_tokens?: unknown;
  accumulated_output_tokens?: unknown;
}

const QUERY = `
  SELECT
    id,
    model_config_json,
    provider_name,
    created_at,
    total_tokens,
    input_tokens,
    output_tokens,
    accumulated_total_tokens,
    accumulated_input_tokens,
    accumulated_output_tokens
  FROM sessions
  WHERE model_config_json IS NOT NULL
    AND TRIM(model_config_json) != ''
`;

/**
 * Parse `model_config_json` for its `model_name` (port of parse_model_config):
 * JSON-parse the column, take the trimmed `model_name` string, or null when the
 * json is invalid / the name is absent or empty.
 */
function parseModelConfig(json: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const name = (parsed as { model_name?: unknown }).model_name;
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed === "" ? null : trimmed;
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
 * when no segment canonicalizes. Unlike the droid port, this returns undefined
 * (not the raw string) so goose's resolver can fall through to model inference,
 * matching the Rust `Option<String>` semantics.
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
 * non-blank `provider_name`, else inferProvider(model), else "goose".
 */
function resolvedProvider(providerName: unknown, modelId: string): string {
  if (typeof providerName === "string") {
    const trimmed = providerName.trim();
    if (trimmed !== "") {
      const canonical = canonicalProvider(trimmed);
      if (canonical !== undefined) return canonical;
    }
  }
  return inferProvider(modelId) ?? DEFAULT_PROVIDER;
}

// ─────────────────────────────────────────────────────────────────────────
// Timestamps & numbers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse `created_at` to epoch ms (port of parse_created_at). Accepts RFC3339,
 * "YYYY-MM-DD HH:MM:SS" (interpreted as UTC), and "YYYY-MM-DD" (UTC midnight).
 * Returns 0 when unparseable (mirroring the Rust 0.0 sentinel).
 */
function parseCreatedAt(s: string): number {
  // ORDER MATTERS: the bare "YYYY-MM-DD HH:MM:SS" and "YYYY-MM-DD" forms must be
  // matched BEFORE the Date.parse fallback. V8's Date.parse accepts both shapes
  // but interprets them as LOCAL time, whereas goose.rs treats them as UTC
  // (chrono NaiveDateTime/NaiveDate.and_utc()). Detecting them first via regex
  // and building with Date.UTC keeps the timestamp tz-stable (mirrors cursor.ts).

  // "YYYY-MM-DD HH:MM:SS" → treat the space-separated form as UTC.
  const dt = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (dt) {
    const ms = Date.UTC(
      Number(dt[1]),
      Number(dt[2]) - 1,
      Number(dt[3]),
      Number(dt[4]),
      Number(dt[5]),
      Number(dt[6]),
    );
    return Number.isNaN(ms) ? 0 : ms;
  }

  // "YYYY-MM-DD" → UTC midnight.
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (d) {
    const ms = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]));
    return Number.isNaN(ms) ? 0 : ms;
  }

  // RFC3339 (e.g. "2026-04-14T16:18:53Z" / with offset). Date.parse handles these
  // with explicit tz info, so the local-vs-UTC ambiguity above does not apply.
  const iso = Date.parse(s);
  if (!Number.isNaN(iso)) return iso;

  return 0;
}

/**
 * Disambiguate a seconds-or-ms timestamp (port of timestamp_secs_to_ms): values
 * already in ms (> 1e12) pass through; smaller values are treated as seconds.
 * `parseCreatedAt` already yields ms, but we replicate the Rust pipeline exactly
 * (parse_created_at → timestamp_secs_to_ms) so a 0 sentinel stays 0.
 */
function timestampSecsToMs(ts: number): number {
  return ts > 1e12 ? Math.trunc(ts) : Math.trunc(ts * 1000);
}

/** Coerce an unknown SQLite cell to a non-negative integer, or null when absent. */
function toIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

/** First non-null of (accumulated, plain), defaulting to 0, clamped ≥ 0. */
function preferAccumulated(accumulated: unknown, plain: unknown): number {
  const acc = toIntOrNull(accumulated);
  const value = acc ?? toIntOrNull(plain) ?? 0;
  return Math.max(0, value);
}

// ─────────────────────────────────────────────────────────────────────────
// Reader
// ─────────────────────────────────────────────────────────────────────────

/** The Goose CLI usage reader singleton. */
const gooseReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    const dbPath = firstExistingRoot(PLATFORM_ID);
    if (dbPath === undefined) return []; // no sessions.db → fail-open

    const db = await openSqlite(dbPath);
    if (db === null) return []; // missing / locked / unreadable / non-sqlite → fail-open

    try {
      const rows = db.all(QUERY); // bad SQL / schema mismatch → [] (fail-open)
      const records: UsageRecord[] = [];

      for (const raw of rows) {
        const row = raw as GooseRow;

        const sessionId = row.id;
        if (typeof sessionId !== "string" || sessionId === "") continue;

        const modelConfig = row.model_config_json;
        if (typeof modelConfig !== "string") continue;
        const modelId = parseModelConfig(modelConfig);
        if (modelId === null) continue;

        const input = preferAccumulated(row.accumulated_input_tokens, row.input_tokens);
        const output = preferAccumulated(row.accumulated_output_tokens, row.output_tokens);
        const total = preferAccumulated(row.accumulated_total_tokens, row.total_tokens);

        // Skip all-zero sessions (matches the Rust input==0 && output==0 && total==0 check).
        if (input === 0 && output === 0 && total === 0) continue;

        // Reasoning is INFERRED, not reported: total minus accounted input+output.
        const reasoning = total > input + output ? total - input - output : 0;

        const createdAtRaw = typeof row.created_at === "string" ? row.created_at : "";
        const ts = timestampSecsToMs(parseCreatedAt(createdAtRaw));
        if (sinceMs !== undefined && ts < sinceMs) continue;

        const providerId = resolvedProvider(row.provider_name, modelId);

        const tokens = emptyTokens();
        tokens.input = input;
        tokens.output = output;
        tokens.reasoning = reasoning;
        // cacheRead / cacheWrite stay 0 (Goose does not report them).

        const record: UsageRecord = {
          platformId: PLATFORM_ID,
          modelId,
          providerId,
          sessionId,
          tokens,
          ts,
          messageCount: 1,
          dedupKey: sessionId, // one row per session → session id is the dedup key
          confidence: "host-reported",
        };
        records.push(record);
      }

      return records;
    } finally {
      db.close();
    }
  },
};

export default gooseReader;
