/**
 * usage/readers/gemini-cli — Gemini CLI native session-log reader.
 *
 * Faithful port of tokscale sessions/gemini.rs. Reads ~/.gemini/tmp/ recursively
 * and supports the three on-disk shapes the Gemini CLI has shipped:
 *   1. legacy structured JSON  — `session-*.json` with a top-level
 *      { sessionId, messages: [{ type, model, timestamp, tokens }] } object;
 *   2. headless single-value JSON — one object carrying either a direct `tokens`
 *      block (type:"gemini") or a `stats` / `result.stats` rollup;
 *   3. headless JSONL stream    — newline-delimited events: `init` (carries
 *      model + session_id), direct-token `gemini` events (keyed by `id`), and
 *      `result`/`stats` rollups.
 *
 * Discovery (port of the path filter in parse_gemini_file_with_cache_status):
 *   - legacy files whose name starts with "session-" are accepted on ANY path;
 *   - any other file must sit at exactly `.../tmp/<id>/chats/<file>` (the three
 *     components right after a `tmp` segment), so a backup/nested chats dir is
 *     rejected. Both .json and .jsonl are read.
 *
 * Token fields (alias list honored exactly as gemini.rs first_i64 / extract_*):
 *   input     ← input, prompt, input_tokens, prompt_tokens, promptTokenCount
 *   output    ← output, candidates, output_tokens, completion_tokens,
 *               candidates_tokens, candidatesTokenCount
 *   cacheRead ← cached, cached_tokens, cachedContentTokenCount
 *   reasoning ← thoughts, reasoning, thoughts_tokens, reasoning_tokens
 *   tool      ← tool, tool_tokens  (folded INTO input after normalization)
 *   total     ← total, totalTokenCount, total_tokens
 * cacheWrite is always 0 (Gemini does not report it).
 *
 * Cache-inclusive input normalization (matches gemini.rs exactly):
 *   - structured session messages: promptTokenCount is normally cache-inclusive.
 *     normalize_gemini_session_input_and_cache only subtracts the cached portion
 *     when a `total` is present AND total == input+output+reasoning+tool (i.e.
 *     cached is NOT already counted in input); otherwise input is left as-is.
 *     Then `tool` is added to the (possibly net) input.
 *   - headless stats: when the chosen input alias is a cache-INCLUSIVE one
 *     (prompt*, or a `tokens`-wrapper `input`, or the only alias present),
 *     subtract the cached overlap (clamped ≥ 0); when a net `input` alias was
 *     used directly, keep it as-is.
 *
 * Dedup (the double-count guard): within a single JSONL file, direct-token
 * events carrying an `id` are deduped LAST-WINS — a later event with the same id
 * replaces the earlier one (port of direct_message_indices HashMap). Stats-
 * derived rows and id-less direct rows are never deduped. The cross-file
 * dedupKey we expose is `<sessionId>:<id>` for the keyed direct rows.
 *
 * Provider is hard-coded "google", confidence "host-reported".
 *
 * Fail-open: no ~/.gemini/tmp → []; unreadable/malformed file or line → skipped.
 */

import { basename } from "node:path";

import type { UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { fileMtimeMs, readJsonFile, readJsonlLines } from "../jsonl.js";
import { firstExistingRoot, walkFiles } from "../paths.js";

const PLATFORM_ID = "gemini-cli" as const;
const PROVIDER = "google";
const DEFAULT_MODEL = "unknown";

// ─────────────────────────────────────────────────────────────────────────
// Scalar coercion (ports of utils.rs extract_i64 / extract_string)
// ─────────────────────────────────────────────────────────────────────────

/** extract_i64: number (int or via Number) or a numeric string → integer, else null. */
function extractI64(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isInteger(n)) return n;
  }
  return null;
}

/** extract_string: a non-undefined string value, else null. */
function extractString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** first_i64(value, keys): first key whose value coerces to an integer. */
function firstI64(obj: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const k of keys) {
    const got = extractI64(obj[k]);
    if (got !== null) return got;
  }
  return null;
}

/** Clamp to a non-negative integer (the Rust `.max(0)` on i64 values). */
function nonNeg(n: number): number {
  return n > 0 ? Math.trunc(n) : 0;
}

/** Saturating add of two non-negative ints (i64 saturating_add ≈ JS add for our ranges). */
function satAdd(a: number, b: number): number {
  return a + b;
}

// ─────────────────────────────────────────────────────────────────────────
// Timestamp (ports of utils.rs parse_timestamp_value + extract_timestamp_from_value)
// ─────────────────────────────────────────────────────────────────────────

/** parse_timestamp_value: RFC3339 string, numeric (s→ms unless already ms), >0 only. */
function parseTimestampValue(v: unknown): number | null {
  if (typeof v === "string") {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return ms;
    const numeric = Number(v);
    if (Number.isInteger(numeric)) {
      if (numeric <= 0) return null;
      return numeric >= 1_000_000_000_000 ? numeric : numeric * 1000;
    }
    return null;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    const numeric = Math.trunc(v);
    if (numeric <= 0) return null;
    return numeric >= 1_000_000_000_000 ? numeric : numeric * 1000;
  }
  return null;
}

/** extract_timestamp_from_value: `timestamp` then `created_at`, via parse_timestamp_value. */
function extractTimestampFromValue(obj: Record<string, unknown>): number | null {
  const ts = obj.timestamp;
  if (ts !== undefined) {
    const got = parseTimestampValue(ts);
    if (got !== null) return got;
  }
  const created = obj.created_at;
  if (created !== undefined) {
    const got = parseTimestampValue(created);
    if (got !== null) return got;
  }
  return null;
}

/** Parse an RFC3339 timestamp string only (used for structured session messages). */
function parseRfc3339(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

// ─────────────────────────────────────────────────────────────────────────
// Cache-inclusive input normalization (ports of gemini.rs)
// ─────────────────────────────────────────────────────────────────────────

/** subtract_cached_overlap: net input = max(0, input - min(cached, input)); cached unchanged. */
function subtractCachedOverlap(input: number, cached: number): [number, number] {
  const i = nonNeg(input);
  const c = nonNeg(cached);
  const cachedPortion = Math.min(c, i);
  return [i - cachedPortion, c];
}

/**
 * normalize_gemini_session_input_and_cache: only subtract the cached overlap
 * when a total is present and equals the cache-EXCLUSIVE sum
 * (input+output+reasoning+tool), i.e. cached is not already inside `input`.
 */
function normalizeSessionInputAndCache(
  input: number,
  cached: number,
  output: number,
  reasoning: number,
  tool: number,
  total: number | null,
): [number, number] {
  const i = nonNeg(input);
  const c = nonNeg(cached);

  if (total === null) return [i, c];
  const t = nonNeg(total);

  const inclusiveTotal = satAdd(satAdd(satAdd(i, nonNeg(output)), nonNeg(reasoning)), nonNeg(tool));
  const exclusiveTotal = satAdd(inclusiveTotal, c);

  if (c > 0 && t === inclusiveTotal && t !== exclusiveTotal) {
    return subtractCachedOverlap(i, c);
  }
  return [i, c];
}

// ─────────────────────────────────────────────────────────────────────────
// Token deserialization
// ─────────────────────────────────────────────────────────────────────────

interface GeminiTokens {
  input: number | null;
  output: number | null;
  cached: number | null;
  thoughts: number | null;
  tool: number | null;
  total: number | null;
}

/** deserialize_tokens: structured-message alias list via first_i64. */
function deserializeTokens(value: unknown): GeminiTokens | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  return {
    input: firstI64(obj, ["input", "prompt", "input_tokens", "prompt_tokens", "promptTokenCount"]),
    output: firstI64(obj, [
      "output",
      "candidates",
      "output_tokens",
      "completion_tokens",
      "candidatesTokenCount",
    ]),
    cached: firstI64(obj, ["cached", "cached_tokens", "cachedContentTokenCount"]),
    thoughts: firstI64(obj, ["thoughts", "reasoning", "thoughts_tokens"]),
    tool: firstI64(obj, ["tool", "tool_tokens"]),
    total: firstI64(obj, ["total", "totalTokenCount", "total_tokens"]),
  };
}

/**
 * build_gemini_token_message: structured-message → record. `tool` is folded into
 * input after the (possibly cache-net) normalization; cacheWrite stays 0.
 */
function buildTokenRecord(
  model: string,
  sessionId: string,
  ts: number,
  tokens: GeminiTokens,
): UsageRecord {
  const [input, cacheRead] = normalizeSessionInputAndCache(
    tokens.input ?? 0,
    tokens.cached ?? 0,
    tokens.output ?? 0,
    tokens.thoughts ?? 0,
    tokens.tool ?? 0,
    tokens.total,
  );
  const tool = nonNeg(tokens.tool ?? 0);

  const tk = emptyTokens();
  tk.input = satAdd(input, tool);
  tk.output = nonNeg(tokens.output ?? 0);
  tk.cacheRead = cacheRead;
  tk.cacheWrite = 0;
  tk.reasoning = nonNeg(tokens.thoughts ?? 0);

  return {
    platformId: PLATFORM_ID,
    modelId: model,
    providerId: PROVIDER,
    sessionId,
    tokens: tk,
    ts,
    messageCount: 1,
    confidence: "host-reported",
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Headless stats extraction (ports of extract_gemini_usage* + build_messages_from_stats)
// ─────────────────────────────────────────────────────────────────────────

interface GeminiHeadlessUsage {
  model: string;
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  inputIncludesCache: boolean;
}

/** extract_gemini_usage_from_value: pull a usage from a stats blob (optionally `tokens`-wrapped). */
function extractUsageFromValue(model: string, value: unknown): GeminiHeadlessUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const outer = value as Record<string, unknown>;
  const hasTokensWrapper = outer.tokens !== undefined;
  const tokens =
    hasTokensWrapper && typeof outer.tokens === "object" && outer.tokens !== null
      ? (outer.tokens as Record<string, unknown>)
      : outer;

  const promptInput =
    extractI64(tokens.prompt) ??
    extractI64(tokens.input_tokens) ??
    extractI64(tokens.prompt_tokens);
  const netInput = extractI64(tokens.input);
  const wrapperInput = hasTokensWrapper ? netInput : null;
  const input = promptInput ?? wrapperInput ?? netInput ?? 0;

  const output =
    extractI64(tokens.candidates) ??
    extractI64(tokens.output) ??
    extractI64(tokens.output_tokens) ??
    extractI64(tokens.candidates_tokens) ??
    0;
  const cached = extractI64(tokens.cached) ?? extractI64(tokens.cached_tokens) ?? 0;
  const reasoning =
    extractI64(tokens.thoughts) ??
    extractI64(tokens.thoughts_tokens) ??
    extractI64(tokens.reasoning) ??
    extractI64(tokens.reasoning_tokens) ??
    0;

  if (input === 0 && output === 0 && cached === 0 && reasoning === 0) return null;

  return {
    model,
    input,
    output,
    cached,
    reasoning,
    inputIncludesCache: promptInput !== null || wrapperInput !== null || netInput === null,
  };
}

/** extract_gemini_usages: per-model breakdown under stats.models, else a single flat usage. */
function extractUsages(stats: Record<string, unknown>, modelHint: string | null): GeminiHeadlessUsage[] {
  const models = stats.models;
  if (typeof models === "object" && models !== null && !Array.isArray(models)) {
    const usages: GeminiHeadlessUsage[] = [];
    for (const [model, data] of Object.entries(models as Record<string, unknown>)) {
      const usage = extractUsageFromValue(model, data);
      if (usage !== null) usages.push(usage);
    }
    if (usages.length > 0) return usages;
  }
  const single = extractUsageFromValue(modelHint ?? DEFAULT_MODEL, stats);
  return single === null ? [] : [single];
}

/** build_messages_from_stats: usages → records (net input via headless normalization). */
function buildRecordsFromStats(
  stats: Record<string, unknown>,
  modelHint: string | null,
  sessionId: string,
  ts: number,
): UsageRecord[] {
  return extractUsages(stats, modelHint).map((usage) => {
    const [input, cacheRead] = usage.inputIncludesCache
      ? subtractCachedOverlap(usage.input, usage.cached) // normalize_gemini_headless_input_and_cache
      : [nonNeg(usage.input), nonNeg(usage.cached)];
    const tk = emptyTokens();
    tk.input = input;
    tk.output = nonNeg(usage.output);
    tk.cacheRead = cacheRead;
    tk.cacheWrite = 0;
    tk.reasoning = nonNeg(usage.reasoning);
    return {
      platformId: PLATFORM_ID,
      modelId: usage.model,
      providerId: PROVIDER,
      sessionId,
      tokens: tk,
      ts,
      messageCount: 1,
      confidence: "host-reported",
    };
  });
}

/** stats = value.stats || value.result.stats (the rollup container). */
function findStats(obj: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof obj.stats === "object" && obj.stats !== null) return obj.stats as Record<string, unknown>;
  const result = obj.result;
  if (typeof result === "object" && result !== null) {
    const inner = (result as Record<string, unknown>).stats;
    if (typeof inner === "object" && inner !== null) return inner as Record<string, unknown>;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Direct-token messages (type:"gemini" or a `tokens` block present)
// ─────────────────────────────────────────────────────────────────────────

/** parse_direct_gemini_token_message: needs a model (own or hint) and a `tokens` block. */
function parseDirectTokenRecord(
  obj: Record<string, unknown>,
  modelHint: string | null,
  sessionId: string,
  fallbackTs: number,
): UsageRecord | null {
  const model = extractString(obj.model) ?? modelHint;
  if (model === null) return null;
  if (obj.tokens === undefined) return null;
  const tokens = deserializeTokens(obj.tokens);
  if (tokens === null) return null;
  const ts = extractTimestampFromValue(obj) ?? fallbackTs;
  return buildTokenRecord(model, sessionId, ts, tokens);
}

// ─────────────────────────────────────────────────────────────────────────
// Path discovery (port of the parse_gemini_file_with_cache_status filter)
// ─────────────────────────────────────────────────────────────────────────

function pathComponents(abs: string): string[] {
  return abs.split(/[\\/]+/).filter((c) => c !== "");
}

/**
 * Accept this file? Legacy `session-*` names pass anywhere. Otherwise the path
 * must end `.../tmp/<id>/chats/<file>` — exactly three components after a `tmp`
 * segment, with the middle one literally "chats" and the last being this file.
 */
function isAcceptedFile(abs: string): boolean {
  const name = basename(abs);
  if (name.startsWith("session-")) return true;
  const comps = pathComponents(abs);
  for (let i = 0; i + 1 < comps.length; i++) {
    if (comps[i] === "tmp") {
      const afterTmp = comps.slice(i + 1);
      if (afterTmp.length === 3 && afterTmp[1] === "chats" && afterTmp[2] === name) {
        return true;
      }
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Per-file parsing
// ─────────────────────────────────────────────────────────────────────────

/** Is a parsed JSON value a structured GeminiSession (has a messages array)? */
function asGeminiSession(value: unknown): { sessionId: string; messages: unknown[] } | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.messages)) return null;
  // serde requires sessionId/projectHash/startTime/lastUpdated as strings; mirror
  // the strict struct shape so a headless value (no sessionId) falls through.
  if (typeof obj.sessionId !== "string") return null;
  return { sessionId: obj.sessionId, messages: obj.messages };
}

/** parse_gemini_session: structured messages with a `tokens` block and a `model`. */
function parseSession(
  session: { sessionId: string; messages: unknown[] },
  fallbackTs: number,
): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const raw of session.messages) {
    if (typeof raw !== "object" || raw === null) continue;
    const msg = raw as Record<string, unknown>;
    const tokens = deserializeTokens(msg.tokens);
    if (tokens === null) continue; // only messages with token data
    const model = extractString(msg.model);
    if (model === null) continue; // model required
    const ts = parseRfc3339(msg.timestamp) ?? fallbackTs;
    out.push(buildTokenRecord(model, session.sessionId, ts, tokens));
  }
  return out;
}

/** parse_gemini_headless_value: one JSON value → direct-token row or stats rows. */
function parseHeadlessValue(
  value: unknown,
  sessionId: string,
  fallbackTs: number,
): UsageRecord[] {
  if (typeof value !== "object" || value === null) return [];
  const obj = value as Record<string, unknown>;

  if (obj.type === "gemini" || obj.tokens !== undefined) {
    const direct = parseDirectTokenRecord(obj, null, sessionId, fallbackTs);
    if (direct !== null) return [direct];
  }

  const stats = findStats(obj);
  if (stats === null) return [];
  const modelHint = extractString(obj.model);
  const ts = extractTimestampFromValue(obj) ?? fallbackTs;
  return buildRecordsFromStats(stats, modelHint, sessionId, ts);
}

/**
 * parse_gemini_headless_jsonl: stateful newline-delimited stream.
 *   - `init` sets current_model + session_id;
 *   - any line may carry session_id/sessionId (updates the running id);
 *   - direct-token events (type:"gemini" or has `tokens`) build a row, deduped
 *     LAST-WINS by `id` (a later same-id event overwrites the earlier row);
 *   - `stats`/`result.stats` rollups append non-deduped rows.
 * Session id seeds from the file stem.
 */
function parseHeadlessJsonl(path: string, fallbackTs: number): UsageRecord[] {
  const lines = readJsonlLines(path);
  let sessionId = stripExt(basename(path)) || "unknown";
  let currentModel: string | null = null;
  const records: UsageRecord[] = [];
  const directIndexById = new Map<string, number>();

  for (const raw of lines) {
    if (typeof raw !== "object" || raw === null) continue;
    const obj = raw as Record<string, unknown>;
    const eventType = extractString(obj.type) ?? "";

    if (eventType === "init") {
      const model = extractString(obj.model);
      if (model !== null) currentModel = model;
      const id = extractString(obj.session_id) ?? extractString(obj.sessionId);
      if (id !== null) sessionId = id;
      continue;
    }

    const lineSession = extractString(obj.session_id) ?? extractString(obj.sessionId);
    if (lineSession !== null) sessionId = lineSession;

    if (eventType === "gemini" || obj.tokens !== undefined) {
      const model = extractString(obj.model);
      if (model !== null) currentModel = model;

      const record = parseDirectTokenRecord(obj, currentModel, sessionId, fallbackTs);
      if (record !== null) {
        const id = extractString(obj.id);
        if (id !== null) {
          record.dedupKey = `${sessionId}:${id}`;
          const existing = directIndexById.get(id);
          if (existing !== undefined) {
            records[existing] = record; // replace (last-wins)
          } else {
            directIndexById.set(id, records.length);
            records.push(record);
          }
        } else {
          records.push(record);
        }
      }
      continue;
    }

    const stats = findStats(obj);
    if (stats !== null) {
      const ts = extractTimestampFromValue(obj) ?? fallbackTs;
      for (const rec of buildRecordsFromStats(stats, currentModel, sessionId, ts)) {
        records.push(rec);
      }
    }
  }

  return records;
}

function stripExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Parse one Gemini file (port of parse_gemini_file_with_cache_status). */
function parseGeminiFile(path: string): UsageRecord[] {
  const fallbackTs = fileMtimeMs(path);

  // .jsonl always uses the streaming parser.
  if (path.endsWith(".jsonl")) {
    return parseHeadlessJsonl(path, fallbackTs);
  }

  // .json: try structured session, then headless value, then JSONL fallback.
  const value = readJsonFile(path);
  if (value !== undefined) {
    const session = asGeminiSession(value);
    if (session !== null) {
      return parseSession(session, fallbackTs);
    }
    const sessionId = stripExt(basename(path)) || "unknown";
    const headless = parseHeadlessValue(value, sessionId, fallbackTs);
    if (headless.length > 0) return headless;
  }

  // Last resort: treat as JSONL (mirrors the Rust fall-through).
  return parseHeadlessJsonl(path, fallbackTs);
}

// ─────────────────────────────────────────────────────────────────────────
// Reader
// ─────────────────────────────────────────────────────────────────────────

const geminiReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    const root = firstExistingRoot(PLATFORM_ID);
    if (root === undefined) return []; // no ~/.gemini/tmp → fail-open

    const files = walkFiles(root, (name, abs) => {
      if (!name.endsWith(".json") && !name.endsWith(".jsonl")) return false;
      return isAcceptedFile(abs);
    });

    const records: UsageRecord[] = [];
    for (const file of files) {
      let rows: UsageRecord[];
      try {
        rows = parseGeminiFile(file);
      } catch {
        rows = []; // fail-open per file
      }
      for (const row of rows) {
        if (sinceMs !== undefined && row.ts < sinceMs) continue;
        records.push(row);
      }
    }
    return records;
  },
};

export default geminiReader;
