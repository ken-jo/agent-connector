/**
 * usage/readers/antigravity-shared — logic shared by the Antigravity IDE
 * (`antigravity`) and Antigravity CLI (`antigravity-cli`) native usage readers.
 *
 * Both surfaces persist per-conversation transcripts as `transcript*.jsonl`
 * under a `brain/` subtree of their global dir. Each assistant turn embeds a
 * Gemini-style `usage_metadata` block (camelCase, same field names the Gemini
 * API returns):
 *   promptTokenCount        → input (cache-INCLUSIVE, like the Gemini API)
 *   candidatesTokenCount    → output
 *   cachedContentTokenCount → cacheRead (the cached portion already inside prompt)
 *   thoughtsTokenCount      → reasoning
 * cacheWrite is not reported by Gemini → always 0.
 *
 * Because promptTokenCount is cache-inclusive, net input = prompt - cached
 * (clamped ≥ 0), mirroring the gemini-cli reader's subtract_cached_overlap.
 *
 * Confidence is MEDIUM on the native JSONL shape (Antigravity is fast-moving and
 * its docs are JS-rendered): the field names above are the documented/observed
 * shape but versions may differ, so extraction is BEST-EFFORT and every caller
 * fails open to [] when the store is absent or a row does not match. We also
 * tolerate the snake_case spellings as a secondary alias set.
 *
 * The model-alias table is shared with — and kept in sync with — the tokscale
 * pricing::aliases::resolve_alias port (sessions/antigravity.rs).
 */

import { emptyTokens } from "../aggregate.js";
import { inferProvider } from "../normalize.js";
import type { PlatformId } from "../../core/types.js";
import type { UsageRecord } from "../types.js";

const DEFAULT_MODEL = "unknown";
const DEFAULT_PROVIDER = "antigravity";

// ─────────────────────────────────────────────────────────────────────────
// Model alias table (port of tokscale pricing::aliases::resolve_alias).
// Keys are lowercased; lookup lowercases the input. Resolves placeholder /
// reseller model ids (e.g. Antigravity's MODEL_PLACEHOLDER_*) to canonical ids.
// Shared by both Antigravity readers.
// ─────────────────────────────────────────────────────────────────────────
export const MODEL_ALIASES: ReadonlyMap<string, string> = new Map([
  ["big-pickle", "glm-4.7"],
  ["big pickle", "glm-4.7"],
  ["bigpickle", "glm-4.7"],
  ["k2p5", "kimi-k2-thinking"],
  ["k2-p5", "kimi-k2-thinking"],
  ["k2p6", "kimi-k2.6"],
  ["k2-p6", "kimi-k2.6"],
  ["kimi-k2p6", "kimi-k2.6"],
  ["kimi-k2.5-thinking", "kimi-k2-thinking"],
  ["kimi-for-coding", "kimi-k2.5"],
  ["model_placeholder_m26", "claude-opus-4-6"],
  ["model_placeholder_m35", "claude-sonnet-4-6"],
  ["model_placeholder_m36", "gemini-3.1-pro"],
  ["model_placeholder_m37", "gemini-3.1-pro"],
  ["model_placeholder_m47", "gemini-3-flash-preview"],
  ["model_openai_gpt_oss_120b_medium", "gpt-oss-120b-medium"],
  ["claude-opus-4-6-thinking", "claude-opus-4-6"],
  ["claude-sonnet-4-6-thinking", "claude-sonnet-4-6"],
  ["claude-opus-4.6-thinking", "claude-opus-4-6"],
  ["claude-sonnet-4.6-thinking", "claude-sonnet-4-6"],
  ["claude-opus-4-6", "claude-opus-4-6"],
  ["claude-sonnet-4-6", "claude-sonnet-4-6"],
  ["claude-haiku-4-6", "claude-haiku-4-6"],
  ["claude-opus-4.6", "claude-opus-4-6"],
  ["claude-sonnet-4.6", "claude-sonnet-4-6"],
  ["claude-haiku-4.6", "claude-haiku-4-6"],
  ["anthropic/claude-4-5-opus", "claude-opus-4-5"],
  ["anthropic/claude-4-5-sonnet", "claude-sonnet-4-5"],
  ["anthropic/claude-4-5-haiku", "claude-haiku-4-5"],
  ["anthropic/claude-4-6-opus", "claude-opus-4-6"],
  ["anthropic/claude-4-6-sonnet", "claude-sonnet-4-6"],
  ["anthropic/claude-4-6-haiku", "claude-haiku-4-6"],
  ["gemini-3.1-pro-high", "gemini-3.1-pro"],
  ["gemini-3.1-pro-low", "gemini-3.1-pro"],
  ["gemini-3-pro-high", "gemini-3-pro"],
  ["gemini-3-pro-low", "gemini-3-pro"],
  ["gemini-3-flash", "gemini-3-flash-preview"],
  ["gemini-3-flash-c", "gemini-3-flash-preview"],
  ["kimi-k2.5-nvfp4", "kimi-k2.5"],
  ["kimi-k2-instruct-0905", "kimi-k2.5"],
]);

/** Resolve a model alias to its canonical id, or undefined when none matches. */
export function resolveAlias(modelId: string): string | undefined {
  return MODEL_ALIASES.get(modelId.toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────
// Scalar coercion (shared with the tokscale to_safe_i64 contract)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Coerce an unknown to a non-negative i64-safe integer (port of to_safe_i64):
 * accepts number or numeric string, floors toward zero, clamps at 0; 0 otherwise.
 */
export function toSafeInt(v: unknown): number {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string"
        ? Number(v.trim())
        : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/** A non-empty trimmed string, or undefined (port of the `.filter(!is_empty)` guards). */
export function nonEmptyStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return v.trim() === "" ? undefined : v;
}

/** First key whose value coerces to a positive-or-zero integer (ignoring absent/zero). */
function firstInt(obj: Record<string, unknown>, keys: readonly string[]): number {
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    const n = toSafeInt(v);
    if (n > 0) return n;
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────
// Native-transcript usage_metadata extraction (best-effort, MEDIUM confidence)
// ─────────────────────────────────────────────────────────────────────────

/** The camelCase Gemini field names + snake_case secondary aliases. */
const PROMPT_KEYS = ["promptTokenCount", "prompt_token_count"] as const;
const CANDIDATES_KEYS = ["candidatesTokenCount", "candidates_token_count"] as const;
const CACHED_KEYS = ["cachedContentTokenCount", "cached_content_token_count"] as const;
const THOUGHTS_KEYS = ["thoughtsTokenCount", "thoughts_token_count"] as const;

/** A `usage_metadata` object pulled off a transcript row (any spelling). */
function findUsageMetadata(row: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const k of ["usage_metadata", "usageMetadata"]) {
    const v = row[k];
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  }
  return undefined;
}

/** Pull a model id off a transcript row, tolerant of common spellings. */
function findModelId(row: Record<string, unknown>): string | undefined {
  return (
    nonEmptyStr(row.modelId) ??
    nonEmptyStr(row.model) ??
    nonEmptyStr(row.model_id) ??
    nonEmptyStr(row.modelName) ??
    nonEmptyStr(row.model_name)
  );
}

/** Pull a session/conversation id off a row, tolerant of common spellings. */
function findSessionId(row: Record<string, unknown>): string | undefined {
  return (
    nonEmptyStr(row.sessionId) ??
    nonEmptyStr(row.session_id) ??
    nonEmptyStr(row.conversationId) ??
    nonEmptyStr(row.conversation_id)
  );
}

/** Options carried per-file so a transcript with no per-row model/session can borrow them. */
export interface UsageMetadataContext {
  /** Platform attribution for emitted records. */
  platformId: PlatformId;
  /** Session id to attribute rows to when the row itself carries none. */
  fallbackSessionId: string;
  /** Per-conversation model fallback (e.g. from a session_meta row), if known. */
  fallbackModel?: string;
  /** Timestamp (epoch ms) to use when the row carries none — never drops a row for it. */
  fallbackTs: number;
}

/**
 * Best-effort parse of one native brain-transcript JSONL row into a usage record,
 * or undefined when the row has no `usage_metadata` / no tokens. Mirrors the
 * gemini-cli cache-inclusive normalization: net input = prompt - cached (≥ 0).
 *
 * Fail-soft: any shape that does not match yields undefined (the caller skips it).
 */
export function parseUsageMetadataRow(
  row: unknown,
  ctx: UsageMetadataContext,
): UsageRecord | undefined {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return undefined;
  const obj = row as Record<string, unknown>;

  const meta = findUsageMetadata(obj);
  if (meta === undefined) return undefined;

  const promptTokens = firstInt(meta, PROMPT_KEYS);
  const output = firstInt(meta, CANDIDATES_KEYS);
  const cacheRead = firstInt(meta, CACHED_KEYS);
  const reasoning = firstInt(meta, THOUGHTS_KEYS);

  // promptTokenCount is cache-inclusive → net input = prompt - cached (≥ 0).
  const input = Math.max(0, promptTokens - Math.min(cacheRead, promptTokens));

  if (input === 0 && output === 0 && cacheRead === 0 && reasoning === 0) return undefined;

  const rawModel = findModelId(obj) ?? ctx.fallbackModel ?? DEFAULT_MODEL;
  const modelId = resolveAlias(rawModel) ?? rawModel;
  const providerId = inferProvider(modelId) ?? DEFAULT_PROVIDER;

  const sessionId = findSessionId(obj) ?? ctx.fallbackSessionId;

  const ts = parseRowTimestamp(obj) ?? ctx.fallbackTs;

  const tokens = emptyTokens();
  tokens.input = input;
  tokens.output = output;
  tokens.cacheRead = cacheRead;
  tokens.cacheWrite = 0;
  tokens.reasoning = reasoning;

  const record: UsageRecord = {
    platformId: ctx.platformId,
    modelId,
    providerId,
    sessionId,
    tokens,
    ts,
    messageCount: 1,
    confidence: "host-reported",
  };

  const dedupKey = nonEmptyStr(obj.responseId) ?? nonEmptyStr(obj.response_id) ?? nonEmptyStr(obj.id);
  if (dedupKey !== undefined) record.dedupKey = `${sessionId}:${dedupKey}`;

  return record;
}

/** Parse a per-row timestamp (epoch ms / s, or RFC3339 string), else undefined. */
function parseRowTimestamp(obj: Record<string, unknown>): number | undefined {
  const v = obj.timestamp ?? obj.ts ?? obj.created_at ?? obj.createdAt;
  if (typeof v === "number" && Number.isFinite(v)) {
    const n = Math.trunc(v);
    if (n <= 0) return undefined;
    return n >= 1_000_000_000_000 ? n : n * 1000;
  }
  if (typeof v === "string") {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return ms;
    const numeric = Number(v.trim());
    if (Number.isInteger(numeric) && numeric > 0) {
      return numeric >= 1_000_000_000_000 ? numeric : numeric * 1000;
    }
  }
  return undefined;
}

/** A per-conversation model fallback off a `session_meta` row, else undefined. */
export function sessionMetaModel(row: unknown): string | undefined {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return undefined;
  const obj = row as Record<string, unknown>;
  const rowType = nonEmptyStr(obj.type);
  if (rowType !== "session_meta") return undefined;
  return findModelId(obj);
}
