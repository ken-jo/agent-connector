/**
 * usage/readers/copilot-cli — GitHub Copilot CLI / VS Code Copilot Chat OTEL reader.
 *
 * Faithful port of tokscale sessions/copilot.rs. Parses file-exported
 * OpenTelemetry JSONL emitted by Copilot CLI and VS Code Copilot Chat monitoring:
 *   ~/.local/share/Copilot/telemetry/*.jsonl  (XDG data home / Copilot/telemetry)
 *   ~/.config/copilot/telemetry/*.jsonl       (XDG config home / copilot/telemetry)
 * (host roots resolved by paths.ts hostRoots("copilot-cli"), env-overridable).
 *
 * Each JSONL line is one OTel record. Four record shapes carry token usage, in
 * descending trust order:
 *   1. ChatSpan          — a span with gen_ai.operation.name == "chat" (or name "chat …")
 *   2. InferenceLog      — a log with event.name == "gen_ai.client.inference.operation.details"
 *                          (or body "GenAI inference:")
 *   3. AgentTurnLog      — a log with event.name == "copilot_chat.agent.turn"
 *   4. AgentSummarySpan  — a span with gen_ai.operation.name == "invoke_agent" (aggregate, fallback only)
 *
 * Tokens (per record `attributes`):
 *   gen_ai.usage.input_tokens                                   → input (incl. cache reads)
 *   gen_ai.usage.output_tokens                                  → output
 *   gen_ai.usage.cache_read.input_tokens                        → cacheRead
 *   gen_ai.usage.cache_write.input_tokens | cache_creation.…    → cacheWrite
 *   gen_ai.usage.reasoning.output_tokens | reasoning_tokens     → reasoning
 * OTEL reports input_tokens inclusive of cache reads, so net input =
 * input - min(cacheRead, input), while the reported cache buckets are kept intact.
 *
 * DEDUP / DOUBLE-COUNT GUARD (the load-bearing bit): chat span, inference log and
 * agent-turn log can all describe the SAME response. Cross-source suppression keys
 * off two stable per-event identifiers — the OTel `trace_id` and `gen_ai.response.id`
 * — and drops a lower-priority lane whenever EITHER matches a higher-priority lane.
 * Coarse session attributes (e.g. gen_ai.conversation.id) span many turns and are
 * intentionally NOT used for suppression. The surviving records then carry a stable
 * per-record `dedupKey`:
 *   ChatSpan / AgentSummarySpan : "trace_id:span_id"  (fallback "span:session:ts:index")
 *   InferenceLog                : "log:trace_id:span_id" (fallback "log:session:ts:index")
 *   AgentTurnLog                : "agent-turn:trace_id:turn.index" (fallback variants)
 *
 * model/provider: model from gen_ai.response.model | gen_ai.request.model (else the
 * trace context, else "unknown"); provider inferred from the model, defaulting to
 * "github-copilot". session: best session attr, else trace context, else trace_id,
 * else "unknown-session". timestamp: endTime/startTime/hrTime/… (epoch ms), else file
 * mtime. No project attribution (Copilot does not log cwd). Confidence "host-reported".
 *
 * Fail-open: no root → []; unreadable/malformed file or line → skipped (never throws).
 */

import type { UsageReader, UsageRecord, TokenBreakdown } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { fileMtimeMs, readJsonlLines } from "../jsonl.js";
import { inferProvider } from "../normalize.js";
import { firstExistingRoot, walkFiles } from "../paths.js";

const PLATFORM_ID = "copilot-cli" as const;
const DEFAULT_MODEL = "unknown";
const DEFAULT_PROVIDER = "github-copilot";
const DEFAULT_SESSION = "unknown-session";

// ─────────────────────────────────────────────────────────────────────────
// Record source / priority model (port of CopilotUsageSource + SessionIdPriority)
// ─────────────────────────────────────────────────────────────────────────

const enum Source {
  ChatSpan = 0,
  InferenceLog = 1,
  AgentTurnLog = 2,
  AgentSummarySpan = 3,
}

const enum SessionPriority {
  Missing = 0,
  Response = 1,
  Interaction = 2,
  Session = 3,
}

/** Model attribute keys, in preference order. */
const MODEL_ATTRS = ["gen_ai.response.model", "gen_ai.request.model"] as const;

/** Session attribute keys with their priority (port of SESSION_ATTRS). */
const SESSION_ATTRS: ReadonlyArray<readonly [string, SessionPriority]> = [
  ["gen_ai.conversation.id", SessionPriority.Session],
  ["copilot_chat.session_id", SessionPriority.Session],
  ["copilot_chat.chat_session_id", SessionPriority.Session],
  ["session.id", SessionPriority.Session],
  ["github.copilot.interaction_id", SessionPriority.Interaction],
  ["gen_ai.response.id", SessionPriority.Response],
];

type JsonObject = Record<string, unknown>;

interface TraceContext {
  model?: string;
  sessionId?: string;
  sessionIdPriority: SessionPriority;
}

interface Candidate {
  source: Source;
  traceId?: string;
  responseId?: string;
  model: string;
  providerId: string;
  sessionId: string;
  ts: number;
  tokens: TokenBreakdown;
  dedupKey: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Value coercion helpers (port of value_as_i64 / attr_* / timestamp helpers)
// ─────────────────────────────────────────────────────────────────────────

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Port of value_as_i64: number / numeric-string → integer, else undefined. */
function valueAsI64(v: unknown): number | undefined {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return undefined;
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    // Rust parses as i64 (integer-only) for value_as_i64's str branch.
    const trimmed = v.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }
  return undefined;
}

/** attr_i64: non-negative integer at `key` (0 on absence/garbage), clamped ≥ 0. */
function attrI64(attrs: JsonObject, key: string): number {
  const raw = valueAsI64(attrs[key]);
  if (raw === undefined) return 0;
  return Math.max(0, raw);
}

/** attr_i64_first: first key whose attr_i64 value is > 0, else 0. */
function attrI64First(attrs: JsonObject, keys: readonly string[]): number {
  for (const key of keys) {
    const v = attrI64(attrs, key);
    if (v > 0) return v;
  }
  return 0;
}

function attrStr(attrs: JsonObject, key: string): string | undefined {
  return asString(attrs[key]);
}

/** first_non_empty_attr: first key whose string value is non-empty (trimmed). */
function firstNonEmptyAttr(attrs: JsonObject, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const s = asString(attrs[key]);
    if (s !== undefined && s.trim() !== "") return s;
  }
  return undefined;
}

/** best_session_attr: the session attr with the highest priority (LAST wins on ties). */
function bestSessionAttr(attrs: JsonObject): { id: string; priority: SessionPriority } | undefined {
  let best: { id: string; priority: SessionPriority } | undefined;
  for (const [key, priority] of SESSION_ATTRS) {
    const value = asString(attrs[key]);
    if (value === undefined || value.trim() === "") continue;
    // Rust's max_by_key keeps the LAST element among equal maxima; SESSION_ATTRS
    // is NOT priority-descending (four Session-priority keys lead the list), so a
    // later equal-priority key must win. Use >= so e.g. `session.id` beats an
    // earlier `gen_ai.conversation.id` when both are present (matches copilot.rs).
    if (best === undefined || priority >= best.priority) {
      best = { id: value, priority };
    }
  }
  return best;
}

function recordBody(value: JsonObject): string | undefined {
  return asString(value["body"]) ?? asString(value["_body"]);
}

function getObject(value: JsonObject, key: string): JsonObject | undefined {
  const v = value[key];
  return isObject(v) ? v : undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Trace / span identity (port of trace_id_from_record / span_id_from_record)
// ─────────────────────────────────────────────────────────────────────────

function traceIdFromRecord(value: JsonObject): string | undefined {
  const top = asString(value["traceId"]);
  if (top !== undefined) return top;
  const ctx = getObject(value, "spanContext");
  return ctx === undefined ? undefined : asString(ctx["traceId"]);
}

function spanIdFromRecord(value: JsonObject): string | undefined {
  const top = asString(value["spanId"]);
  if (top !== undefined) return top;
  const ctx = getObject(value, "spanContext");
  return ctx === undefined ? undefined : asString(ctx["spanId"]);
}

// ─────────────────────────────────────────────────────────────────────────
// Timestamp + duration parsing (port of timestamp_ms_from_* / duration helpers)
// ─────────────────────────────────────────────────────────────────────────

/** OTel hrTime/startTime/endTime: [seconds, nanos] array → epoch ms. */
function timestampMsFromValue(value: unknown): number | undefined {
  if (!Array.isArray(value)) return undefined;
  const seconds = valueAsI64(value[0]);
  if (seconds === undefined) return undefined;
  const nanos = valueAsI64(value[1]);
  if (nanos === undefined) return undefined;
  return seconds * 1000 + Math.trunc(nanos / 1_000_000);
}

/** Scalar epoch with magnitude auto-detection (ns/us/ms/s). */
function timestampMsFromScalar(value: unknown): number | undefined {
  const raw = valueAsI64(value);
  if (raw === undefined) return undefined;
  const abs = Math.abs(raw);
  if (abs >= 100_000_000_000_000_000) return Math.trunc(raw / 1_000_000); // ns
  if (abs >= 100_000_000_000_000) return Math.trunc(raw / 1_000); // us
  if (abs >= 100_000_000_000) return raw; // ms
  return raw * 1000; // s
}

/** OTel timeUnixNano is unsigned; refuse ≤ 0 so a malformed value falls through. */
function timestampMsFromUnixNanos(value: unknown): number | undefined {
  const raw = valueAsI64(value);
  if (raw === undefined || raw <= 0) return undefined;
  return Math.trunc(raw / 1_000_000);
}

function timestampMsFromRecord(value: JsonObject): number | undefined {
  return (
    timestampMsFromValue(value["endTime"]) ??
    timestampMsFromValue(value["startTime"]) ??
    timestampMsFromValue(value["hrTime"]) ??
    timestampMsFromValue(value["_hrTime"]) ??
    timestampMsFromValue(value["time"]) ??
    timestampMsFromScalar(value["timestamp"]) ??
    timestampMsFromScalar(value["observedTimestamp"]) ??
    timestampMsFromUnixNanos(value["timeUnixNano"])
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Token normalization (port of normalize_input_tokens)
// ─────────────────────────────────────────────────────────────────────────

function normalizeInputTokens(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  reasoning: number,
): TokenBreakdown {
  // input_tokens is reported inclusive of cache reads; subtract only the cached
  // portion out of input, keeping the reported cache buckets intact.
  const cacheReadForInput = Math.min(Math.max(cacheRead, 0), Math.max(input, 0));
  const tokens = emptyTokens();
  tokens.input = Math.max(0, Math.max(input, 0) - cacheReadForInput);
  tokens.output = Math.max(output, 0);
  tokens.cacheRead = Math.max(cacheRead, 0);
  tokens.cacheWrite = Math.max(cacheWrite, 0);
  tokens.reasoning = Math.max(reasoning, 0);
  return tokens;
}

function tokenTotal(t: TokenBreakdown): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite + t.reasoning;
}

// ─────────────────────────────────────────────────────────────────────────
// Record classification (port of is_*_record)
// ─────────────────────────────────────────────────────────────────────────

function isSpanRecord(value: JsonObject): boolean {
  // VS Code Copilot Chat exports omit `type:"span"`; infer span-ness from a
  // top-level `name` plus span identity / timing / kind. Inference- and
  // agent-turn-log records carry NO top-level `name`, which disambiguates them.
  const type = asString(value["type"]);
  if (type === "span") return true;
  if (type !== undefined) return false;

  const hasName = asString(value["name"]) !== undefined;
  const hasSpanIdentity =
    asString(value["spanId"]) !== undefined || asString(value["traceId"]) !== undefined;
  const hasSpanTiming =
    value["startTime"] !== undefined ||
    value["endTime"] !== undefined ||
    value["duration"] !== undefined;

  return hasName && (hasSpanIdentity || hasSpanTiming || value["kind"] !== undefined);
}

function isChatSpanRecord(value: JsonObject, attrs: JsonObject): boolean {
  if (!isSpanRecord(value)) return false;
  if (attrStr(attrs, "gen_ai.operation.name") === "chat") return true;
  const name = asString(value["name"]);
  return name !== undefined && name.startsWith("chat ");
}

function isAgentSummarySpanRecord(value: JsonObject, attrs: JsonObject): boolean {
  if (!isSpanRecord(value)) return false;
  if (attrStr(attrs, "gen_ai.operation.name") === "invoke_agent") return true;
  const name = asString(value["name"]);
  return name !== undefined && name.startsWith("invoke_agent ");
}

function isInferenceLogRecord(value: JsonObject, attrs: JsonObject): boolean {
  if (isSpanRecord(value)) return false;
  if (attrStr(attrs, "event.name") === "gen_ai.client.inference.operation.details") return true;
  const body = recordBody(value);
  return body !== undefined && body.startsWith("GenAI inference:");
}

function isAgentTurnLogRecord(value: JsonObject, attrs: JsonObject): boolean {
  if (isSpanRecord(value)) return false;
  if (attrStr(attrs, "event.name") === "copilot_chat.agent.turn") return true;
  const body = recordBody(value);
  return body !== undefined && body.startsWith("copilot_chat.agent.turn");
}

// ─────────────────────────────────────────────────────────────────────────
// Trace context collection (port of collect_trace_contexts)
// ─────────────────────────────────────────────────────────────────────────

function collectTraceContexts(records: JsonObject[]): Map<string, TraceContext> {
  const contexts = new Map<string, TraceContext>();

  for (const record of records) {
    const traceId = traceIdFromRecord(record);
    if (traceId === undefined) continue;
    const attrs = getObject(record, "attributes");
    if (attrs === undefined) continue;

    let context = contexts.get(traceId);
    if (context === undefined) {
      context = { sessionIdPriority: SessionPriority.Missing };
      contexts.set(traceId, context);
    }

    if (context.model === undefined) {
      context.model = firstNonEmptyAttr(attrs, MODEL_ATTRS);
    }

    const best = bestSessionAttr(attrs);
    if (best !== undefined && best.priority > context.sessionIdPriority) {
      context.sessionId = best.id;
      context.sessionIdPriority = best.priority;
    }
  }

  return contexts;
}

// ─────────────────────────────────────────────────────────────────────────
// Dedup key (port of dedup_key_for_record)
// ─────────────────────────────────────────────────────────────────────────

function dedupKeyForRecord(
  source: Source,
  record: JsonObject,
  attrs: JsonObject,
  traceId: string | undefined,
  sessionId: string,
  ts: number,
  index: number,
): string {
  const spanId = spanIdFromRecord(record);

  switch (source) {
    case Source.ChatSpan:
    case Source.AgentSummarySpan:
      if (traceId !== undefined && spanId !== undefined) return `${traceId}:${spanId}`;
      return `span:${sessionId}:${ts}:${index}`;
    case Source.InferenceLog:
      if (traceId !== undefined && spanId !== undefined) return `log:${traceId}:${spanId}`;
      return `log:${sessionId}:${ts}:${index}`;
    case Source.AgentTurnLog: {
      // Use a real turn.index when present (stable across re-runs); otherwise fall
      // back to the line index so two turn-less records in the same trace differ.
      let turnPart: string | undefined;
      for (const key of ["turn.index", "copilot_chat.turn.index"]) {
        const v = valueAsI64(attrs[key]);
        if (v !== undefined) {
          turnPart = String(v);
          break;
        }
      }
      const part = turnPart ?? `idx-${index}`;
      if (traceId !== undefined) return `agent-turn:${traceId}:${part}`;
      return `agent-turn:${sessionId}:${part}:${index}`;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Candidate construction (port of usage_candidate_from_record / candidate_from_attributes)
// ─────────────────────────────────────────────────────────────────────────

function classify(value: JsonObject, attrs: JsonObject): Source | undefined {
  if (isChatSpanRecord(value, attrs)) return Source.ChatSpan;
  if (isInferenceLogRecord(value, attrs)) return Source.InferenceLog;
  if (isAgentTurnLogRecord(value, attrs)) return Source.AgentTurnLog;
  if (isAgentSummarySpanRecord(value, attrs)) return Source.AgentSummarySpan;
  return undefined;
}

function candidateFromRecord(
  record: JsonObject,
  index: number,
  fallbackTimestamp: number,
  traceContexts: Map<string, TraceContext>,
): Candidate | undefined {
  const attrs = getObject(record, "attributes");
  if (attrs === undefined) return undefined;

  const source = classify(record, attrs);
  if (source === undefined) return undefined;

  const traceId = traceIdFromRecord(record);
  const traceContext = traceId === undefined ? undefined : traceContexts.get(traceId);

  const input = attrI64First(attrs, ["gen_ai.usage.input_tokens"]);
  const output = attrI64First(attrs, ["gen_ai.usage.output_tokens"]);
  const cacheRead = attrI64First(attrs, ["gen_ai.usage.cache_read.input_tokens"]);
  const cacheWrite = attrI64First(attrs, [
    "gen_ai.usage.cache_write.input_tokens",
    "gen_ai.usage.cache_creation.input_tokens",
  ]);
  const reasoning = attrI64First(attrs, [
    "gen_ai.usage.reasoning.output_tokens",
    "gen_ai.usage.reasoning_tokens",
  ]);

  const tokens = normalizeInputTokens(input, output, cacheRead, cacheWrite, reasoning);
  if (tokenTotal(tokens) === 0) return undefined;

  const responseIdRaw = asString(attrs["gen_ai.response.id"]);
  const responseId =
    responseIdRaw !== undefined && responseIdRaw.trim() !== "" ? responseIdRaw.trim() : undefined;

  const model =
    firstNonEmptyAttr(attrs, MODEL_ATTRS) ?? traceContext?.model ?? DEFAULT_MODEL;
  const providerId = inferProvider(model) ?? DEFAULT_PROVIDER;

  const sessionId =
    bestSessionAttr(attrs)?.id ?? traceContext?.sessionId ?? traceId ?? DEFAULT_SESSION;

  const ts = timestampMsFromRecord(record) ?? fallbackTimestamp;
  const dedupKey = dedupKeyForRecord(source, record, attrs, traceId, sessionId, ts, index);

  const candidate: Candidate = {
    source,
    model,
    providerId,
    sessionId,
    ts,
    tokens,
    dedupKey,
  };
  if (traceId !== undefined) candidate.traceId = traceId;
  if (responseId !== undefined) candidate.responseId = responseId;
  return candidate;
}

// ─────────────────────────────────────────────────────────────────────────
// Cross-source suppression (port of should_emit_candidate)
// ─────────────────────────────────────────────────────────────────────────

function traceIdsForSource(candidates: Candidate[], source: Source): Set<string> {
  const set = new Set<string>();
  for (const c of candidates) {
    if (c.source === source && c.traceId !== undefined) set.add(c.traceId);
  }
  return set;
}

function responseIdsForSource(candidates: Candidate[], source: Source): Set<string> {
  const set = new Set<string>();
  for (const c of candidates) {
    if (c.source === source && c.responseId !== undefined) set.add(c.responseId);
  }
  return set;
}

function shouldEmit(
  candidate: Candidate,
  chatTraces: Set<string>,
  inferenceTraces: Set<string>,
  agentTurnTraces: Set<string>,
  chatResponseIds: Set<string>,
  inferenceResponseIds: Set<string>,
  agentTurnResponseIds: Set<string>,
): boolean {
  // Suppression keys off the per-event trace_id and gen_ai.response.id — either
  // match is sufficient to drop a lower-priority lane. Coarse session attributes
  // (gen_ai.conversation.id, …) span multiple turns and are intentionally unused.
  const { traceId, responseId } = candidate;
  const traceMatch = (traces: Set<string>): boolean =>
    traceId !== undefined && traces.has(traceId);
  const responseMatch = (ids: Set<string>): boolean =>
    responseId !== undefined && ids.has(responseId);

  switch (candidate.source) {
    case Source.ChatSpan:
      return true;
    case Source.InferenceLog:
      return !traceMatch(chatTraces) && !responseMatch(chatResponseIds);
    case Source.AgentTurnLog:
      return (
        !traceMatch(chatTraces) &&
        !traceMatch(inferenceTraces) &&
        !responseMatch(chatResponseIds) &&
        !responseMatch(inferenceResponseIds)
      );
    case Source.AgentSummarySpan:
      return (
        !traceMatch(chatTraces) &&
        !traceMatch(inferenceTraces) &&
        !traceMatch(agentTurnTraces) &&
        !responseMatch(chatResponseIds) &&
        !responseMatch(inferenceResponseIds) &&
        !responseMatch(agentTurnResponseIds)
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// File parse (port of parse_copilot_file)
// ─────────────────────────────────────────────────────────────────────────

function parseCopilotFile(path: string): UsageRecord[] {
  const lines = readJsonlLines(path);
  if (lines.length === 0) return [];

  const fallbackTimestamp = fileMtimeMs(path);
  const records: JsonObject[] = [];
  for (const raw of lines) {
    if (isObject(raw)) records.push(raw);
  }

  const traceContexts = collectTraceContexts(records);

  const candidates: Candidate[] = [];
  records.forEach((record, index) => {
    const candidate = candidateFromRecord(record, index, fallbackTimestamp, traceContexts);
    if (candidate !== undefined) candidates.push(candidate);
  });

  const chatTraces = traceIdsForSource(candidates, Source.ChatSpan);
  const inferenceTraces = traceIdsForSource(candidates, Source.InferenceLog);
  const agentTurnTraces = traceIdsForSource(candidates, Source.AgentTurnLog);
  const chatResponseIds = responseIdsForSource(candidates, Source.ChatSpan);
  const inferenceResponseIds = responseIdsForSource(candidates, Source.InferenceLog);
  const agentTurnResponseIds = responseIdsForSource(candidates, Source.AgentTurnLog);

  const out: UsageRecord[] = [];
  for (const candidate of candidates) {
    if (
      !shouldEmit(
        candidate,
        chatTraces,
        inferenceTraces,
        agentTurnTraces,
        chatResponseIds,
        inferenceResponseIds,
        agentTurnResponseIds,
      )
    ) {
      continue;
    }

    out.push({
      platformId: PLATFORM_ID,
      modelId: candidate.model,
      providerId: candidate.providerId,
      sessionId: candidate.sessionId,
      tokens: candidate.tokens,
      ts: candidate.ts,
      messageCount: 1,
      dedupKey: candidate.dedupKey,
      confidence: "host-reported",
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Reader singleton
// ─────────────────────────────────────────────────────────────────────────

const copilotReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    const root = firstExistingRoot(PLATFORM_ID);
    if (root === undefined) return []; // no telemetry root → fail-open

    // <root>/*.jsonl (and any nested .jsonl the export produces).
    const files = walkFiles(root, (name) => name.endsWith(".jsonl"));

    const records: UsageRecord[] = [];
    for (const file of files) {
      let rows: UsageRecord[];
      try {
        rows = parseCopilotFile(file);
      } catch {
        continue; // fail-open per file
      }
      for (const row of rows) {
        if (sinceMs !== undefined && row.ts < sinceMs) continue;
        records.push(row);
      }
    }
    return records;
  },
};

export default copilotReader;
