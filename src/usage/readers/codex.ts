/**
 * usage/readers/codex — Codex CLI native session-log reader.
 *
 * Faithful port of tokscale sessions/codex.rs (the hard, stateful reader). Reads
 * ~/.codex/sessions/**\/*.jsonl (and the rare *.json headless variants; the
 * rollout-*.jsonl files are just a subset of *.jsonl and need no special-casing).
 *
 * Codex logs a cumulative token snapshot on every `token_count` event, so naive
 * summing double-counts every turn. This reader reproduces codex.rs exactly:
 *
 *   - The per-turn increment comes from `payload.info.last_token_usage`
 *     (the DELTA source). `total_token_usage` is a mutable cumulative snapshot
 *     (compaction / context-window capping rewrites it) used ONLY for dedup and
 *     monotonicity / stale-regression checks — never as a direct delta source
 *     unless `last_token_usage` is absent.
 *   - State is tracked PER SESSION (per file): `previous_totals` is the last
 *     accepted cumulative baseline; each new snapshot must advance past it.
 *   - When the new total equals the previous baseline → skip (duplicate snapshot).
 *   - When the total regresses but `looks_like_stale_regression` holds (a small
 *     out-of-order dip that resumes from the true watermark next row) → skip,
 *     so `last_token_usage` is not counted twice.
 *   - Forked-child sessions replay parent token rows before their first
 *     `turn_context`; those inherited snapshots are skipped until totals move
 *     past the inherited baseline.
 *
 * Token mapping (CodexTotals::into_tokens): cached = min(cached, input); the
 * reported `input` already INCLUDES cached, so net input = input - cached
 * (clamped ≥ 0). cache_read = clamped cached, cache_write = 0, reasoning as-is.
 * `cached` itself is max(cached_input_tokens, cache_read_input_tokens).
 *
 * Model: model_info.slug > model > model_name > info.model > info.model_name,
 * falling back to the session's current_model (from turn_context). Provider:
 * session_meta.model_provider, else inferred from the model, else "openai".
 * Session id: the file stem. Project: session_meta.cwd, only when it looks like
 * an explicit absolute/UNC/drive path. Confidence is "host-reported".
 *
 * Dedup key (set only when the row had a real RFC3339 timestamp, matching
 * codex.rs which skips the key on the mtime fallback):
 *   codex:token_count:<ts>:<provider>:<model>:<in>:<out>:<cacheRead>:<cacheWrite>:<reasoning>
 *
 * Fail-open: no root → []; unreadable/malformed file or line → skipped.
 */

import { basename } from "node:path";

import type { TokenBreakdown, UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { fileMtimeMs, readJsonlLines } from "../jsonl.js";
import { inferProvider, normalizeWorkspaceKey, workspaceLabelFromKey } from "../normalize.js";
import { firstExistingRoot, walkFiles } from "../paths.js";

const PLATFORM_ID = "codex" as const;
const DEFAULT_MODEL = "unknown";
const DEFAULT_PROVIDER = "openai";

// ─────────────────────────────────────────────────────────────────────────
// Wire shapes (everything optional / unknown — narrowed at use)
// ─────────────────────────────────────────────────────────────────────────

interface CodexTokenUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cached_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  reasoning_output_tokens?: unknown;
  total_tokens?: unknown;
}

interface CodexInfo {
  model?: unknown;
  model_name?: unknown;
  last_token_usage?: CodexTokenUsage | null;
  total_token_usage?: CodexTokenUsage | null;
}

interface CodexModelInfo {
  slug?: unknown;
}

interface CodexPayload {
  id?: unknown;
  forked_from_id?: unknown;
  type?: unknown;
  model?: unknown;
  model_name?: unknown;
  model_info?: CodexModelInfo | null;
  info?: CodexInfo | null;
  source?: unknown;
  cwd?: unknown;
  model_provider?: unknown;
  agent_nickname?: unknown;
}

interface CodexEntry {
  type?: unknown;
  timestamp?: unknown;
  payload?: CodexPayload | null;
}

// ─────────────────────────────────────────────────────────────────────────
// CodexTotals — the four cumulative dimensions + delta / regression logic
// (port of the Rust CodexTotals struct).
// ─────────────────────────────────────────────────────────────────────────

interface CodexTotals {
  input: number;
  output: number;
  cached: number;
  reasoning: number;
}

/** Coerce an unknown to a non-negative integer (0 on absence/garbage). */
function toNonNegInt(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/** Read a possibly-missing i64-ish field as an integer (may be negative). */
function toIntOr(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

/** CodexTotals::from_usage — clamp each field ≥ 0; cached = max of both fields. */
function totalsFromUsage(usage: CodexTokenUsage): CodexTotals {
  const cached = Math.max(
    toIntOr(usage.cached_input_tokens, 0),
    toIntOr(usage.cache_read_input_tokens, 0),
  );
  return {
    input: Math.max(0, toIntOr(usage.input_tokens, 0)),
    output: Math.max(0, toIntOr(usage.output_tokens, 0)),
    cached: Math.max(0, cached),
    reasoning: Math.max(0, toIntOr(usage.reasoning_output_tokens, 0)),
  };
}

function totalsEqual(a: CodexTotals, b: CodexTotals): boolean {
  return a.input === b.input && a.output === b.output && a.cached === b.cached && a.reasoning === b.reasoning;
}

/** CodexTotals::delta_from — null when any dimension regressed. */
function deltaFrom(self: CodexTotals, previous: CodexTotals): CodexTotals | null {
  if (
    self.input < previous.input ||
    self.output < previous.output ||
    self.cached < previous.cached ||
    self.reasoning < previous.reasoning
  ) {
    return null;
  }
  return {
    input: self.input - previous.input,
    output: self.output - previous.output,
    cached: self.cached - previous.cached,
    reasoning: self.reasoning - previous.reasoning,
  };
}

/** CodexTotals::saturating_add (plain add — values are well within Number range). */
function saturatingAdd(self: CodexTotals, other: CodexTotals): CodexTotals {
  return {
    input: self.input + other.input,
    output: self.output + other.output,
    cached: self.cached + other.cached,
    reasoning: self.reasoning + other.reasoning,
  };
}

function totalsSum(t: CodexTotals): number {
  return t.input + t.output + t.cached + t.reasoning;
}

/** CodexTotals::is_within — every dimension ≤ baseline. */
function isWithin(self: CodexTotals, baseline: CodexTotals): boolean {
  return (
    self.input <= baseline.input &&
    self.output <= baseline.output &&
    self.cached <= baseline.cached &&
    self.reasoning <= baseline.reasoning
  );
}

/**
 * CodexTotals::looks_like_stale_regression — some snapshots arrive slightly out
 * of order: the cumulative total dips by ~one recent increment then resumes from
 * the true higher watermark next row. Treat those as stale (skip) rather than a
 * hard reset, so last_token_usage is not counted twice.
 */
function looksLikeStaleRegression(self: CodexTotals, previous: CodexTotals, last: CodexTotals): boolean {
  const previousTotal = totalsSum(previous);
  const currentTotal = totalsSum(self);
  const lastTotal = totalsSum(last);
  if (previousTotal <= 0 || currentTotal <= 0 || lastTotal <= 0) return false;
  return currentTotal * 100 >= previousTotal * 98 || currentTotal + lastTotal * 2 >= previousTotal;
}

/**
 * CodexTotals::into_tokens — clamp cached to ≤ input so malformed rows can't
 * inflate the total; net input = input - clamped_cached; cache_write = 0.
 */
function intoTokens(t: CodexTotals): TokenBreakdown {
  const clampedCached = Math.max(0, Math.min(t.cached, t.input));
  const tokens = emptyTokens();
  tokens.input = Math.max(0, t.input - clampedCached);
  tokens.output = Math.max(0, t.output);
  tokens.cacheRead = clampedCached;
  tokens.cacheWrite = 0;
  tokens.reasoning = Math.max(0, t.reasoning);
  return tokens;
}

// ─────────────────────────────────────────────────────────────────────────
// Per-file (per-session) parse state
// ─────────────────────────────────────────────────────────────────────────

interface CodexParseState {
  currentModel: string | undefined;
  previousTotals: CodexTotals | undefined;
  sessionIsHeadless: boolean;
  sessionProvider: string | undefined;
  sessionAgent: string | undefined;
  sessionWorkspaceKey: string | undefined;
  sessionWorkspaceLabel: string | undefined;
  forkedChildWaitingForTurnContext: boolean;
  forkedChildInheritedBaseline: CodexTotals | undefined;
  forkedChildInheritedReportedTotal: number | undefined;
}

function freshState(): CodexParseState {
  return {
    currentModel: undefined,
    previousTotals: undefined,
    sessionIsHeadless: false,
    sessionProvider: undefined,
    sessionAgent: undefined,
    sessionWorkspaceKey: undefined,
    sessionWorkspaceLabel: undefined,
    forkedChildWaitingForTurnContext: false,
    forkedChildInheritedBaseline: undefined,
    forkedChildInheritedReportedTotal: undefined,
  };
}

/**
 * A model-less token_count record buffered until a later turn resolves the
 * model (port of codex.rs `pending_model_messages`). codex.rs back-fills the
 * resolved model + dedup key onto these, and flushes any still-unresolved at EOF
 * as "unknown" — but STILL with a dedup key when the row had a real timestamp.
 * `usedFallbackTimestamp` mirrors `parsed_timestamp.is_none()`: when true the
 * dedup key is skipped on flush (the mtime fallback is not a stable identity).
 */
interface PendingCodexRecord {
  record: UsageRecord;
  tokens: TokenBreakdown;
  providerId: string;
  ts: number;
  usedFallbackTimestamp: boolean;
}

/**
 * Flush every buffered model-less record with a now-resolved model (port of
 * flush_pending_model_messages): back-fill modelId and — when the row carried a
 * real timestamp — the codex dedup key keyed on that model.
 */
function flushPending(pending: PendingCodexRecord[], out: UsageRecord[], model: string): void {
  for (const p of pending) {
    p.record.modelId = model;
    if (!p.usedFallbackTimestamp) {
      p.record.dedupKey = codexDedupKey(p.ts, p.providerId, model, p.tokens);
    }
    out.push(p.record);
  }
  pending.length = 0;
}

/** Flush remaining buffered records as "unknown" (still keyed when timestamped). */
function flushPendingAsUnknown(pending: PendingCodexRecord[], out: UsageRecord[]): void {
  if (pending.length === 0) return;
  flushPending(pending, out, DEFAULT_MODEL);
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** session id from path file stem (port of session_id_from_path). */
function sessionIdFromPath(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem === "" ? "unknown" : stem;
}

/** Parse an RFC3339 timestamp to epoch ms, or null (port of parse_codex_entry_timestamp). */
function parseEntryTimestamp(v: unknown): number | null {
  if (typeof v !== "string" || v === "") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * extract_model — model_info.slug > model > model_name > info.model >
 * info.model_name (first non-empty).
 */
function extractModel(payload: CodexPayload): string | undefined {
  return (
    nonEmptyString(payload.model_info?.slug) ??
    nonEmptyString(payload.model) ??
    nonEmptyString(payload.model_name) ??
    (payload.info ? extractModelFromInfo(payload.info) : undefined)
  );
}

/** extract_model_from_info — info.model > info.model_name. */
function extractModelFromInfo(info: CodexInfo): string | undefined {
  return nonEmptyString(info.model) ?? nonEmptyString(info.model_name);
}

/** codex_source_is_exec — session_meta.source === "exec" marks a headless run. */
function sourceIsExec(source: unknown): boolean {
  return source === "exec";
}

/** forked_from_id_from_source — source.subagent.thread_spawn.parent_thread_id. */
function forkedFromIdFromSource(source: unknown): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const sub = (source as Record<string, unknown>).subagent;
  if (typeof sub !== "object" || sub === null) return undefined;
  const spawn = (sub as Record<string, unknown>).thread_spawn;
  if (typeof spawn !== "object" || spawn === null) return undefined;
  const parent = (spawn as Record<string, unknown>).parent_thread_id;
  return nonEmptyString(parent);
}

/**
 * codex_workspace_from_cwd — normalize the cwd, but only accept it when it looks
 * like an explicit absolute/UNC/drive path AND yields a label.
 */
function workspaceFromCwd(cwd: string): { key?: string; label?: string } {
  const normalized = normalizeWorkspaceKey(cwd);
  if (normalized === undefined) return {};
  // Reject control characters.
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return {};
  }
  if (!looksLikeExplicitWorkspacePath(normalized)) return {};
  const label = workspaceLabelFromKey(normalized);
  if (label === undefined) return {};
  return { key: normalized, label };
}

/** looks_like_explicit_workspace_path — leading `/` or `//`, or `X:/` drive. */
function looksLikeExplicitWorkspacePath(path: string): boolean {
  if (path.startsWith("//") || path.startsWith("/")) return true;
  if (path.length >= 3) {
    const c0 = path.charCodeAt(0);
    const isAlpha = (c0 >= 0x41 && c0 <= 0x5a) || (c0 >= 0x61 && c0 <= 0x7a);
    if (isAlpha && path[1] === ":" && path[2] === "/") return true;
  }
  return false;
}

/** reported_total_tokens — info.total_token_usage.total_tokens when ≥ 0. */
function reportedTotalTokens(usage: CodexTokenUsage): number | undefined {
  const v = toIntOr(usage.total_tokens, NaN);
  if (!Number.isFinite(v) || v < 0) return undefined;
  return v;
}

function rememberForkedChildInheritedBaseline(state: CodexParseState, info: CodexInfo): void {
  const totalUsage = info.total_token_usage;
  if (!totalUsage) return;
  const totals = totalsFromUsage(totalUsage);
  state.previousTotals = totals;
  state.forkedChildInheritedBaseline = totals;
  state.forkedChildInheritedReportedTotal = reportedTotalTokens(totalUsage);
}

function forkedChildShouldSkipInheritedSnapshot(
  state: CodexParseState,
  totalUsage: CodexTokenUsage | null | undefined,
  totals: CodexTotals | undefined,
): boolean {
  if (totalUsage && state.forkedChildInheritedReportedTotal !== undefined) {
    const reported = reportedTotalTokens(totalUsage);
    if (reported !== undefined && reported <= state.forkedChildInheritedReportedTotal) {
      return true;
    }
  }
  if (totals !== undefined && state.forkedChildInheritedBaseline !== undefined) {
    return isWithin(totals, state.forkedChildInheritedBaseline);
  }
  return false;
}

/** The codex:token_count dedup key (port of codex_token_count_dedup_key). */
function codexDedupKey(
  ts: number,
  provider: string,
  model: string,
  tokens: TokenBreakdown,
): string {
  return `codex:token_count:${ts}:${provider}:${model}:${tokens.input}:${tokens.output}:${tokens.cacheRead}:${tokens.cacheWrite}:${tokens.reasoning}`;
}

function tokensAllZero(t: TokenBreakdown): boolean {
  return t.input === 0 && t.output === 0 && t.cacheRead === 0 && t.reasoning === 0;
}

// ─────────────────────────────────────────────────────────────────────────
// File parse (port of parse_codex_reader, stateless single-pass)
// ─────────────────────────────────────────────────────────────────────────

function parseCodexFile(path: string): UsageRecord[] {
  const lines = readJsonlLines(path);
  if (lines.length === 0) return [];

  const sessionId = sessionIdFromPath(path);
  const fallbackTs = fileMtimeMs(path);
  const state = freshState();
  const out: UsageRecord[] = [];
  // Model-less token_count rows are buffered here and back-filled once a later
  // turn resolves the model (else flushed as "unknown" WITH a dedup key at EOF).
  const pending: PendingCodexRecord[] = [];

  for (const raw of lines) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as CodexEntry;
    const payload = entry.payload;
    if (payload === undefined || payload === null) continue;

    const entryType = typeof entry.type === "string" ? entry.type : "";
    const payloadType = typeof payload.type === "string" ? payload.type : undefined;
    const isTokenCount = entryType === "event_msg" && payloadType === "token_count";

    // ── Forked-child gate: replayed parent rows arrive before turn_context. ──
    if (state.forkedChildWaitingForTurnContext) {
      if (entryType === "turn_context") {
        state.forkedChildWaitingForTurnContext = false;
        state.currentModel = extractModel(payload);
      } else {
        if (isTokenCount && payload.info) {
          rememberForkedChildInheritedBaseline(state, payload.info);
        }
        continue;
      }
    }

    // ── session_meta: headless flag, fork detection, provider, cwd. ──
    if (entryType === "session_meta") {
      if (sourceIsExec(payload.source)) state.sessionIsHeadless = true;
      const forkedFromId =
        nonEmptyString(payload.forked_from_id) ?? forkedFromIdFromSource(payload.source);
      if (forkedFromId !== undefined) {
        state.forkedChildWaitingForTurnContext = true;
        state.forkedChildInheritedBaseline = undefined;
        state.forkedChildInheritedReportedTotal = undefined;
      }
      const provider = nonEmptyString(payload.model_provider);
      if (provider !== undefined) state.sessionProvider = provider;
      const nickname = nonEmptyString(payload.agent_nickname);
      if (nickname !== undefined) state.sessionAgent = nickname;
      if (typeof payload.cwd === "string") {
        const ws = workspaceFromCwd(payload.cwd);
        state.sessionWorkspaceKey = ws.key;
        state.sessionWorkspaceLabel = ws.label;
      }
      continue;
    }

    // ── turn_context: sets the current model for subsequent token rows. When
    // it resolves a model, flush any buffered model-less rows onto it. ──
    if (entryType === "turn_context") {
      state.currentModel = extractModel(payload);
      if (state.currentModel !== undefined) {
        flushPending(pending, out, state.currentModel);
      }
      continue;
    }

    if (!isTokenCount) continue;

    const info = payload.info;
    if (info === undefined || info === null) continue;

    // Resolve model: payload model > info model > current session model.
    const payloadModel = extractModel(payload);
    const infoModel = extractModelFromInfo(info);
    const model = payloadModel ?? infoModel ?? state.currentModel;
    if (model !== undefined) {
      state.currentModel = model;
      // A resolved model back-fills any earlier model-less rows (codex.rs flushes
      // pending_model_messages here before building the current record).
      flushPending(pending, out, model);
    }

    const totalUsageRaw = info.total_token_usage ?? undefined;
    const lastUsageRaw = info.last_token_usage ?? undefined;
    const totalUsage = totalUsageRaw ? totalsFromUsage(totalUsageRaw) : undefined;
    const lastUsage = lastUsageRaw ? totalsFromUsage(lastUsageRaw) : undefined;

    // Forked child may replay >1 parent token row after the first turn_context.
    if (forkedChildShouldSkipInheritedSnapshot(state, totalUsageRaw, totalUsage)) {
      continue;
    }
    state.forkedChildInheritedBaseline = undefined;
    state.forkedChildInheritedReportedTotal = undefined;

    // ── Delta selection (exact port of the Rust match arms). ──
    let tokensTotals: CodexTotals | undefined;
    let nextTotals: CodexTotals | undefined;
    const previous = state.previousTotals;

    if (totalUsage !== undefined && lastUsage !== undefined && previous !== undefined) {
      // Both present with previous baseline (standard path).
      if (totalsEqual(totalUsage, previous)) continue;
      if (deltaFrom(totalUsage, previous) === null && looksLikeStaleRegression(totalUsage, previous, lastUsage)) {
        continue;
      }
      tokensTotals = lastUsage;
      nextTotals = totalUsage;
    } else if (totalUsage !== undefined && lastUsage !== undefined && previous === undefined) {
      // Both present, first event — use last (not full total).
      tokensTotals = lastUsage;
      nextTotals = totalUsage;
    } else if (totalUsage !== undefined && lastUsage === undefined && previous !== undefined) {
      // Only total, have previous (defensive).
      if (totalsEqual(totalUsage, previous)) continue;
      const delta = deltaFrom(totalUsage, previous);
      if (delta !== null) {
        tokensTotals = delta;
        nextTotals = totalUsage;
      } else {
        state.previousTotals = totalUsage;
        continue;
      }
    } else if (totalUsage !== undefined && lastUsage === undefined && previous === undefined) {
      // Only total, first event, no last — legacy/degraded path.
      tokensTotals = totalUsage;
      nextTotals = totalUsage;
    } else if (totalUsage === undefined && lastUsage !== undefined && previous !== undefined) {
      // Only last, have previous.
      tokensTotals = lastUsage;
      nextTotals = saturatingAdd(previous, lastUsage);
    } else if (totalUsage === undefined && lastUsage !== undefined && previous === undefined) {
      // Only last, no previous.
      tokensTotals = lastUsage;
      nextTotals = undefined;
    } else {
      // Neither.
      continue;
    }

    const tokens = intoTokens(tokensTotals);

    // Skip zero-token snapshots WITHOUT advancing the baseline, so post-compaction
    // zeros don't inflate later deltas.
    if (tokensAllZero(tokens)) continue;

    state.previousTotals = nextTotals;

    const parsedTs = parseEntryTimestamp(entry.timestamp);
    const ts = parsedTs ?? fallbackTs;

    const modelId = model ?? DEFAULT_MODEL;
    const providerId = state.sessionProvider ?? inferProvider(modelId) ?? DEFAULT_PROVIDER;
    const agent = state.sessionIsHeadless ? "headless" : state.sessionAgent;

    const record: UsageRecord = {
      platformId: PLATFORM_ID,
      modelId,
      providerId,
      sessionId,
      tokens,
      ts,
      messageCount: 1,
      confidence: "host-reported",
    };
    if (state.sessionWorkspaceKey !== undefined) record.projectKey = state.sessionWorkspaceKey;
    if (state.sessionWorkspaceLabel !== undefined) record.projectLabel = state.sessionWorkspaceLabel;
    if (agent !== undefined) record.agent = agent;

    if (model === undefined) {
      // Model not yet resolved: buffer the record and defer modelId + dedupKey
      // until a later turn resolves the model (codex.rs pending_model_messages).
      // At EOF it flushes as "unknown" but STILL with a dedup key when the row
      // carried a real timestamp — so it can dedup against cross-source overlap.
      pending.push({
        record,
        tokens,
        providerId,
        ts,
        usedFallbackTimestamp: parsedTs === null,
      });
      continue;
    }

    // Dedup key only when a real timestamp was parsed (mtime fallback skips it,
    // matching codex.rs which sets the key only when parsed_timestamp.is_some()).
    if (parsedTs !== null) {
      record.dedupKey = codexDedupKey(ts, providerId, model, tokens);
    }
    out.push(record);
  }

  // EOF: any token_count rows whose model never resolved are emitted as
  // "unknown" — keeping a dedup key when their timestamp was real (codex.rs
  // flush_pending_model_messages_as_unknown at end of file).
  flushPendingAsUnknown(pending, out);

  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Reader
// ─────────────────────────────────────────────────────────────────────────

/** The Codex CLI usage reader singleton. */
const codexReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    const root = firstExistingRoot(PLATFORM_ID);
    if (root === undefined) return []; // no ~/.codex/sessions → fail-open

    // ~/.codex/sessions/**/*.jsonl (+ *.json headless). rollout-*.jsonl is a
    // subset of *.jsonl and is matched by the same predicate.
    const files = walkFiles(root, (name) => name.endsWith(".jsonl") || name.endsWith(".json"));

    const records: UsageRecord[] = [];
    for (const file of files) {
      const rows = parseCodexFile(file);
      for (const row of rows) {
        if (sinceMs !== undefined && row.ts < sinceMs) continue;
        records.push(row);
      }
    }
    return records;
  },
};

export default codexReader;
