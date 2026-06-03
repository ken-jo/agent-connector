/**
 * usage/readers/kiro — Kiro CLI (Amazon Bedrock) native session reader.
 *
 * Faithful port of tokscale sessions/kiro.rs (parse_kiro_file). Each session is a
 * pair of adjacent files under ~/.kiro/sessions/cli/:
 *   <stem>.json   — header: session_id, cwd, and session_state with the model
 *                   info (model_id, context_window_tokens) and the per-turn
 *                   metadata list (user_turn_metadatas[*]).
 *   <stem>.jsonl  — a transcript of Prompt / AssistantMessage entries keyed by
 *                   message_id, used ONLY to estimate per-turn char counts when
 *                   the header carries no explicit token counts.
 *
 * Token logic (per turn), ported exactly from the Rust:
 *   input  = input_token_count  when > 0                       (host-reported)
 *            else context_window × context_usage_percentage/100 when both > 0
 *            else ceil(promptChars / 4)                          (host-estimated)
 *   output = output_token_count when > 0                        (host-reported)
 *            else ceil(assistantChars / 4)                       (host-estimated)
 *   cacheRead / cacheWrite / reasoning are always 0 (Kiro reports none).
 * A turn whose input+output == 0 is dropped (matches the Rust filter_map).
 *
 * Confidence is per-record: "host-reported" only when BOTH dimensions came from
 * explicit host counts; any estimation (context% × window, or chars/4) makes the
 * row "host-estimated" (design §6: Kiro token counts are often estimated).
 *
 * Provider is hardcoded "amazon-bedrock". Session id is the header's session_id
 * (else the JSON file stem). Project is header.cwd normalized to a workspace key.
 * Timestamp prefers the matched Prompt entry's meta.timestamp (float seconds →
 * ms), then end_timestamp (int/float seconds-or-ms / RFC3339 string), then file
 * mtime. Dedup key is `<sessionId>:<turnIndex>` (turn-level uniqueness across
 * file rewrites), exactly the Rust format!("{}:{}", session_id, index).
 *
 * NOTE: kiro.rs also reads a macOS SQLite source
 * (~/Library/Application Support/kiro-cli/data.sqlite3, table conversations_v2).
 * That source is intentionally NOT read in v1 — only the json/jsonl file pairs
 * are parsed here.
 *
 * Fail-open: no root → []; unreadable/malformed json or jsonl → that file is
 * skipped (the jsonl is optional — its absence just leaves char estimation at 0).
 */

import { basename } from "node:path";

import type { UsageReader, UsageRecord, UsageConfidence } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { fileMtimeMs, readJsonFile, readJsonlLines } from "../jsonl.js";
import { normalizeWorkspaceKey, workspaceLabelFromKey } from "../normalize.js";
import { firstExistingRoot, walkFiles } from "../paths.js";

const PLATFORM_ID = "kiro" as const;
const PROVIDER_ID = "amazon-bedrock";
const UNKNOWN_MODEL = "unknown";

// ─────────────────────────────────────────────────────────────────────────
// Header (.json) shapes — every field optional / unknown (host may omit any).
// ─────────────────────────────────────────────────────────────────────────

interface KiroHeader {
  session_id?: unknown;
  cwd?: unknown;
  session_state?: {
    rts_model_state?: {
      model_info?: {
        model_id?: unknown;
        context_window_tokens?: unknown;
      };
    };
    conversation_metadata?: {
      user_turn_metadatas?: unknown;
    };
  };
}

interface KiroTurn {
  input_token_count?: unknown;
  output_token_count?: unknown;
  end_timestamp?: unknown;
  total_request_count?: unknown;
  message_ids?: unknown;
  context_usage_percentage?: unknown;
}

/** Accumulated char counts (and first prompt ts) for one message_id. */
interface KiroMessageContent {
  promptChars: number;
  assistantChars: number;
  promptTimestampMs: number | null;
}

// ─────────────────────────────────────────────────────────────────────────
// Coercion helpers (tolerant — garbage degrades to a safe default).
// ─────────────────────────────────────────────────────────────────────────

/** Coerce to a finite number, or null when not numeric. */
function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Coerce to an integer clamped ≥ 0 (Rust `.unwrap_or(0).max(0)`). */
function toNonNegInt(v: unknown): number {
  const n = toNum(v);
  if (n === null) return 0;
  return Math.max(0, Math.trunc(n));
}

/** ceil(chars / 4) — Rust div_ceil estimation (4 chars per token). */
function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

/** float seconds → epoch ms (Rust seconds_to_millis: truncating). */
function secondsToMillis(seconds: number): number {
  return Math.trunc(seconds * 1000);
}

/** Strip a single file extension from a basename. */
function stripExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Parse end_timestamp (port of parse_timestamp_value): a number < 1e12 is
 * seconds (→ ms), ≥ 1e12 is already ms; a string is RFC3339, else numeric
 * seconds. Returns null when unusable.
 */
function parseTimestampValue(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.abs(v) < 1_000_000_000_000 ? secondsToMillis(v) : Math.trunc(v);
  }
  if (typeof v === "string") {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return ms;
    const n = Number(v);
    if (Number.isFinite(n)) return secondsToMillis(n);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// JSONL transcript → per-message char counts (port of the BufReader loop).
// ─────────────────────────────────────────────────────────────────────────

/** Sum chars of the "text" parts of a content array (kind absent ⇒ text). */
function textCharCount(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const kind = (part as { kind?: unknown }).kind;
    const isText = kind === undefined || kind === null || kind === "text";
    if (!isText) continue;
    const data = (part as { data?: unknown }).data;
    if (typeof data === "string") total += [...data].length; // chars, not UTF-16 units
  }
  return total;
}

/**
 * Build message_id → char-count map from the adjacent .jsonl, exactly as the
 * Rust: a "Prompt" entry stages a pending (chars, ts); the next
 * "AssistantMessage" attaches the staged prompt to that assistant's message_id
 * and adds the assistant's own chars. A missing/empty jsonl yields an empty map.
 */
function readJsonlContent(jsonlPath: string): Map<string, KiroMessageContent> {
  const byId = new Map<string, KiroMessageContent>();
  const lines = readJsonlLines(jsonlPath);
  if (lines.length === 0) return byId;

  let pendingPromptChars: number | null = null;
  let pendingPromptTs: number | null = null;

  for (const raw of lines) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as { kind?: unknown; data?: unknown };
    const kind = entry.kind;
    const data = entry.data;
    if (typeof data !== "object" || data === null) continue;

    const messageId = (data as { message_id?: unknown }).message_id;
    if (typeof messageId !== "string") continue;

    const textChars = textCharCount((data as { content?: unknown }).content);

    if (kind === "Prompt") {
      const metaTs = (data as { meta?: { timestamp?: unknown } }).meta?.timestamp;
      const tsNum = toNum(metaTs);
      pendingPromptChars = textChars;
      pendingPromptTs = tsNum === null ? null : secondsToMillis(tsNum);
    } else if (kind === "AssistantMessage") {
      let msg = byId.get(messageId);
      if (msg === undefined) {
        msg = { promptChars: 0, assistantChars: 0, promptTimestampMs: null };
        byId.set(messageId, msg);
      }
      if (pendingPromptChars !== null) {
        msg.promptChars += pendingPromptChars;
        if (msg.promptTimestampMs === null) msg.promptTimestampMs = pendingPromptTs;
        pendingPromptChars = null;
        pendingPromptTs = null;
      }
      msg.assistantChars += textChars;
    }
    // other kinds are ignored
  }
  return byId;
}

// ─────────────────────────────────────────────────────────────────────────
// One session (.json + adjacent .jsonl) → usage records.
// ─────────────────────────────────────────────────────────────────────────

function parseKiroFile(jsonPath: string): UsageRecord[] {
  const header = readJsonFile(jsonPath);
  if (typeof header !== "object" || header === null) return []; // malformed → skip
  const h = header as KiroHeader;

  const fallbackTs = fileMtimeMs(jsonPath);

  const sessionId =
    typeof h.session_id === "string" && h.session_id !== ""
      ? h.session_id
      : stripExt(basename(jsonPath)) || "unknown";

  const modelInfo = h.session_state?.rts_model_state?.model_info;
  const rawModel = modelInfo?.model_id;
  const modelId =
    typeof rawModel === "string" && rawModel.trim() !== "" ? rawModel : UNKNOWN_MODEL;
  const contextWindow = toNonNegInt(modelInfo?.context_window_tokens);

  let projectKey: string | undefined;
  let projectLabel: string | undefined;
  if (typeof h.cwd === "string") {
    projectKey = normalizeWorkspaceKey(h.cwd);
    if (projectKey !== undefined) projectLabel = workspaceLabelFromKey(projectKey);
  }

  const turnsRaw = h.session_state?.conversation_metadata?.user_turn_metadatas;
  const turns: KiroTurn[] = Array.isArray(turnsRaw) ? (turnsRaw as KiroTurn[]) : [];
  if (turns.length === 0) return [];

  // Adjacent .jsonl (same stem) drives char-based estimation.
  const jsonlPath = jsonPath.replace(/\.json$/, ".jsonl");
  const contentById = readJsonlContent(jsonlPath);

  const out: UsageRecord[] = [];

  turns.forEach((turn, index) => {
    if (typeof turn !== "object" || turn === null) return;

    // Aggregate char counts / first prompt ts over this turn's message_ids.
    let promptChars = 0;
    let assistantChars = 0;
    let promptTimestampMs: number | null = null;
    const messageIds = turn.message_ids;
    if (Array.isArray(messageIds)) {
      for (const mid of messageIds) {
        if (typeof mid !== "string") continue;
        const content = contentById.get(mid);
        if (content === undefined) continue;
        promptChars += content.promptChars;
        assistantChars += content.assistantChars;
        if (promptTimestampMs === null) promptTimestampMs = content.promptTimestampMs;
      }
    }

    const explicitInput = toNonNegInt(turn.input_token_count);
    const explicitOutput = toNonNegInt(turn.output_token_count);

    let input: number;
    let inputEstimated: boolean;
    if (explicitInput > 0) {
      input = explicitInput;
      inputEstimated = false;
    } else {
      inputEstimated = true;
      const ctxPct = toNum(turn.context_usage_percentage) ?? 0;
      if (contextWindow > 0 && ctxPct > 0) {
        input = Math.trunc((contextWindow * ctxPct) / 100);
      } else {
        input = estimateTokens(promptChars);
      }
    }

    let output: number;
    let outputEstimated: boolean;
    if (explicitOutput > 0) {
      output = explicitOutput;
      outputEstimated = false;
    } else {
      output = estimateTokens(assistantChars);
      outputEstimated = true;
    }

    if (input + output === 0) return; // matches Rust filter_map drop

    const endTs = parseTimestampValue(turn.end_timestamp);
    const ts = promptTimestampMs ?? endTs ?? fallbackTs;

    const messageCount = Math.max(1, toNonNegInt(turn.total_request_count) || 1);

    const tokens = emptyTokens();
    tokens.input = input;
    tokens.output = output;
    // cacheRead / cacheWrite / reasoning stay 0 (Kiro reports none).

    // host-reported only when BOTH dimensions are explicit host counts.
    const confidence: UsageConfidence =
      inputEstimated || outputEstimated ? "host-estimated" : "host-reported";

    const record: UsageRecord = {
      platformId: PLATFORM_ID,
      modelId,
      providerId: PROVIDER_ID,
      sessionId,
      tokens,
      ts,
      messageCount,
      dedupKey: `${sessionId}:${index}`,
      confidence,
    };
    if (projectKey !== undefined) record.projectKey = projectKey;
    if (projectLabel !== undefined) record.projectLabel = projectLabel;
    out.push(record);
  });

  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Reader singleton.
// ─────────────────────────────────────────────────────────────────────────

const kiroReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    const root = firstExistingRoot(PLATFORM_ID);
    if (root === undefined) return []; // no ~/.kiro/sessions/cli → fail-open

    // Drive off the .json headers; each pulls its adjacent .jsonl when present.
    const files = walkFiles(root, (name) => name.endsWith(".json"));

    const records: UsageRecord[] = [];
    for (const file of files) {
      const rows = parseKiroFile(file);
      for (const row of rows) {
        if (sinceMs !== undefined && row.ts < sinceMs) continue;
        records.push(row);
      }
    }
    return records;
  },
};

export default kiroReader;
