/**
 * usage/readers/amp — Amp (Sourcegraph) native session-log reader.
 *
 * Faithful port of tokscale sessions/amp.rs. Reads one JSON file per thread from
 * ~/.local/share/amp/threads/*.json. Each thread carries token usage in TWO
 * overlapping places that describe the SAME calls and must be MERGED, not summed:
 *
 *   1. `usageLedger.events[]` — billing ledger rows:
 *        tokens.input                    → input
 *        tokens.output                   → output
 *        tokens.cacheReadInputTokens     → cacheRead
 *        tokens.cacheCreationInputTokens → cacheWrite
 *        model, credits (cost), timestamp (RFC3339), toMessageId.
 *   2. `messages[].usage` (assistant role only) — per-message usage:
 *        inputTokens / outputTokens / cacheReadInputTokens /
 *        cacheCreationInputTokens, model, credits.
 *
 * Reconciliation (port of parse_amp_file + merge_amp_records): when a ledger
 * exists, each assistant message-record is matched to at most one ledger record —
 * first by `toMessageId == messageId`, else by an exact (model, tokens) heuristic
 * — using a rotating search cursor so earlier matches are not re-consumed. A match
 * MERGES into the ledger record (the ledger keeps its explicit timestamp/cost,
 * but borrows the message timestamp/cost where it lacks them); an unmatched
 * message-record is appended as its own row. Ledger rows that match nothing stay.
 * When there is NO ledger, message-records pass through directly. This in-file
 * merge is the dedup: a call logged in both places yields ONE row, never two.
 *
 * Timestamps (port of parse_amp_timestamp / fallback_amp_timestamp): a ledger
 * event prefers its RFC3339 string, else thread.created, else file mtime. A
 * message-record derives `thread.created (or mtime) + messageId*1000` so messages
 * order by id. reasoning is always 0 (Amp does not report it).
 *
 * Attribution: session = thread.id (or the filename stem). Project is not captured
 * by Amp, so projectKey/projectLabel are omitted. model/provider come from the
 * row's model (provider inferred, default "anthropic"). Confidence is
 * "host-reported" (real host token counts). A stable cross-source `dedupKey`
 * (`amp:<thread>:<ts>:<model>:<tokens>`) guards against the same file being read
 * twice; the in-file merge already prevents ledger/message double counting.
 *
 * Fail-open: no root → []; unreadable/malformed file → skipped (no throw).
 * Read-only.
 */

import { basename } from "node:path";

import type { UsageReader, UsageRecord, TokenBreakdown } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { fileMtimeMs, readJsonFile } from "../jsonl.js";
import { inferProvider } from "../normalize.js";
import { firstExistingRoot, walkFiles } from "../paths.js";

const PLATFORM_ID = "amp" as const;
const DEFAULT_PROVIDER = "anthropic";

// ─────────────────────────────────────────────────────────────────────────
// Raw shapes (everything optional / unknown — narrowed at read time)
// ─────────────────────────────────────────────────────────────────────────

interface AmpTokensRaw {
  input?: unknown;
  output?: unknown;
  cacheReadInputTokens?: unknown;
  cacheCreationInputTokens?: unknown;
}

interface AmpUsageEventRaw {
  timestamp?: unknown;
  model?: unknown;
  credits?: unknown;
  tokens?: AmpTokensRaw;
  toMessageId?: unknown;
}

interface AmpMessageUsageRaw {
  model?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadInputTokens?: unknown;
  cacheCreationInputTokens?: unknown;
  credits?: unknown;
}

interface AmpMessageRaw {
  role?: unknown;
  messageId?: unknown;
  usage?: AmpMessageUsageRaw;
}

interface AmpThreadRaw {
  id?: unknown;
  created?: unknown;
  messages?: unknown;
  usageLedger?: { events?: unknown };
}

// ─────────────────────────────────────────────────────────────────────────
// Coercion helpers
// ─────────────────────────────────────────────────────────────────────────

/** Coerce an unknown to a non-negative integer (0 on absence/garbage). Mirrors `.unwrap_or(0).max(0)`. */
function toNonNegInt(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/** Coerce an unknown to a non-negative float (0 on absence/garbage). Mirrors credits `.unwrap_or(0.0).max(0.0)`. */
function toNonNegFloat(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n);
}

/** Coerce an unknown to an integer, or null when absent/garbage (for ids). */
function toIntOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

/**
 * Parse an RFC3339 timestamp string to epoch ms, filtering 0 out. Port of
 * parse_amp_timestamp: returns null when absent, unparseable, or exactly 0.
 */
function parseAmpTimestamp(v: unknown): number | null {
  if (typeof v !== "string" || v === "") return null;
  const ms = Date.parse(v);
  if (Number.isNaN(ms) || ms === 0) return null;
  return ms;
}

/**
 * Pick a ledger timestamp with fallback (port of fallback_amp_timestamp):
 * explicit (when non-zero) → thread.created (when non-zero) → file mtime.
 */
function fallbackAmpTimestamp(
  explicit: number | null,
  threadCreatedMs: number,
  fileMtime: number,
): number {
  if (explicit !== null && explicit !== 0) return explicit;
  if (threadCreatedMs !== 0) return threadCreatedMs;
  return fileMtime;
}

// ─────────────────────────────────────────────────────────────────────────
// Intermediate record (port of AmpUsageRecord)
// ─────────────────────────────────────────────────────────────────────────

interface AmpUsageRecord {
  model: string;
  timestamp: number;
  hasExplicitTimestamp: boolean;
  /** assistant messageId (>0) when this row came from / merged a message. */
  messageId: number | null;
  /** ledger event's toMessageId (>0) used for id-based matching. */
  ledgerToMessageId: number | null;
  tokens: TokenBreakdown;
  cost: number;
}

/** Element-wise token equality (port of `self.tokens == other.tokens`). */
function tokensEqual(a: TokenBreakdown, b: TokenBreakdown): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite &&
    a.reasoning === b.reasoning
  );
}

/** Heuristic match: same model AND identical tokens (port of matches_message_usage). */
function matchesMessageUsage(a: AmpUsageRecord, b: AmpUsageRecord): boolean {
  return a.model === b.model && tokensEqual(a.tokens, b.tokens);
}

// ─────────────────────────────────────────────────────────────────────────
// Ledger / message parsing
// ─────────────────────────────────────────────────────────────────────────

/** Port of parse_amp_ledger_records. */
function parseLedgerRecords(
  eventsRaw: unknown,
  threadCreatedMs: number,
  fileMtime: number,
): AmpUsageRecord[] {
  if (!Array.isArray(eventsRaw)) return [];

  const out: AmpUsageRecord[] = [];
  for (const raw of eventsRaw) {
    if (typeof raw !== "object" || raw === null) continue;
    const event = raw as AmpUsageEventRaw;

    if (typeof event.model !== "string" || event.model === "") continue; // model? early-return
    const model = event.model;

    const explicit = parseAmpTimestamp(event.timestamp);
    const timestamp = fallbackAmpTimestamp(explicit, threadCreatedMs, fileMtime);

    const tokensRaw = event.tokens ?? {};
    const tokens = emptyTokens();
    tokens.input = toNonNegInt(tokensRaw.input);
    tokens.output = toNonNegInt(tokensRaw.output);
    tokens.cacheRead = toNonNegInt(tokensRaw.cacheReadInputTokens);
    tokens.cacheWrite = toNonNegInt(tokensRaw.cacheCreationInputTokens);
    // reasoning stays 0.

    const toMsgId = toIntOrNull(event.toMessageId);

    out.push({
      model,
      timestamp,
      hasExplicitTimestamp: explicit !== null,
      messageId: null,
      ledgerToMessageId: toMsgId !== null && toMsgId > 0 ? toMsgId : null,
      tokens,
      cost: toNonNegFloat(event.credits),
    });
  }
  return out;
}

/** Port of parse_amp_message_records (assistant rows only). */
function parseMessageRecords(
  messagesRaw: unknown,
  threadCreatedMs: number,
  fileMtime: number,
): AmpUsageRecord[] {
  if (!Array.isArray(messagesRaw)) return [];

  const baseTimestamp = threadCreatedMs !== 0 ? threadCreatedMs : fileMtime;

  const out: AmpUsageRecord[] = [];
  for (const raw of messagesRaw) {
    if (typeof raw !== "object" || raw === null) continue;
    const msg = raw as AmpMessageRaw;

    if (msg.role !== "assistant") continue;
    const usage = msg.usage;
    if (usage === undefined || usage === null) continue; // usage? early-return
    if (typeof usage.model !== "string" || usage.model === "") continue; // model? early-return
    const model = usage.model;

    const messageId = Math.max(0, toIntOrNull(msg.messageId) ?? 0);
    // base + messageId*1000 (saturating in Rust; JS numbers don't overflow here).
    const timestamp = baseTimestamp + messageId * 1000;

    const tokens = emptyTokens();
    tokens.input = toNonNegInt(usage.inputTokens);
    tokens.output = toNonNegInt(usage.outputTokens);
    tokens.cacheRead = toNonNegInt(usage.cacheReadInputTokens);
    tokens.cacheWrite = toNonNegInt(usage.cacheCreationInputTokens);
    // reasoning stays 0.

    out.push({
      model,
      timestamp,
      hasExplicitTimestamp: false,
      messageId: messageId > 0 ? messageId : null,
      ledgerToMessageId: null,
      tokens,
      cost: toNonNegFloat(usage.credits),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Reconciliation (port of find_matching_ledger_record + merge_amp_records)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Find an unconsumed ledger record matching `messageRecord`, scanning from
 * `searchStart` forward then wrapping to the front (port of the rotating
 * find_match). Prefers a `toMessageId == messageId` match, then the
 * (model, tokens) heuristic. Returns the index, or null when none matches.
 */
function findMatchingLedgerRecord(
  ledger: AmpUsageRecord[],
  consumed: boolean[],
  searchStart: number,
  messageRecord: AmpUsageRecord,
): number | null {
  const findMatch = (predicate: (i: number) => boolean): number | null => {
    for (let i = searchStart; i < ledger.length; i++) {
      if (predicate(i)) return i;
    }
    for (let i = 0; i < searchStart; i++) {
      if (predicate(i)) return i;
    }
    return null;
  };

  if (messageRecord.messageId !== null) {
    const byId = findMatch(
      (i) => !consumed[i] && ledger[i]!.ledgerToMessageId === messageRecord.messageId,
    );
    if (byId !== null) return byId;
  }

  return findMatch((i) => !consumed[i] && matchesMessageUsage(ledger[i]!, messageRecord));
}

/**
 * Merge a matched message-record into its ledger record (port of merge_amp_records).
 * If the ledger row has an explicit timestamp, it wins (only borrowing the
 * message cost/messageId when the ledger had no cost); otherwise the merged row
 * adopts the message timestamp, keeping ledger tokens and the better cost.
 */
function mergeAmpRecords(ledger: AmpUsageRecord, message: AmpUsageRecord): AmpUsageRecord {
  if (ledger.hasExplicitTimestamp) {
    if (ledger.cost > 0 || message.cost <= 0) {
      return ledger;
    }
    return { ...ledger, cost: message.cost, messageId: message.messageId };
  }
  return {
    model: ledger.model,
    timestamp: message.timestamp,
    hasExplicitTimestamp: false,
    messageId: message.messageId,
    ledgerToMessageId: ledger.ledgerToMessageId,
    tokens: ledger.tokens,
    cost: ledger.cost > 0 ? ledger.cost : message.cost,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// File parse (port of parse_amp_file)
// ─────────────────────────────────────────────────────────────────────────

function stripExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Stable cross-source dedup key for one reconciled row. */
function dedupKey(threadId: string, rec: AmpUsageRecord): string {
  const t = rec.tokens;
  return `amp:${threadId}:${rec.timestamp}:${rec.model}:${t.input}-${t.output}-${t.cacheRead}-${t.cacheWrite}-${t.reasoning}`;
}

function parseAmpFile(path: string): UsageRecord[] {
  const parsed = readJsonFile(path);
  if (typeof parsed !== "object" || parsed === null) return []; // missing/malformed → []
  const thread = parsed as AmpThreadRaw;

  const fileMtime = fileMtimeMs(path);

  const threadId =
    typeof thread.id === "string" && thread.id !== ""
      ? thread.id
      : stripExt(basename(path)) || "unknown";

  const threadCreatedMs = toIntOrNull(thread.created) ?? 0;

  const ledgerRecords = parseLedgerRecords(
    thread.usageLedger?.events,
    threadCreatedMs,
    fileMtime,
  );
  const messageRecords = parseMessageRecords(thread.messages, threadCreatedMs, fileMtime);

  let reconciled: AmpUsageRecord[];

  if (ledgerRecords.length === 0) {
    // No ledger → message-records pass through, sorted by timestamp.
    reconciled = messageRecords.slice().sort((a, b) => a.timestamp - b.timestamp);
  } else {
    const consumed = new Array<boolean>(ledgerRecords.length).fill(false);
    let searchStart = 0;
    const unmatched: AmpUsageRecord[] = [];

    for (const messageRecord of messageRecords) {
      const index = findMatchingLedgerRecord(
        ledgerRecords,
        consumed,
        searchStart,
        messageRecord,
      );
      if (index !== null) {
        consumed[index] = true;
        searchStart = index + 1;
        ledgerRecords[index] = mergeAmpRecords(ledgerRecords[index]!, messageRecord);
      } else {
        unmatched.push(messageRecord);
      }
    }

    reconciled = ledgerRecords.concat(unmatched).sort((a, b) => a.timestamp - b.timestamp);
  }

  return reconciled.map((rec) => {
    const modelId = rec.model;
    const providerId = inferProvider(modelId) ?? DEFAULT_PROVIDER;

    const tokens = emptyTokens();
    tokens.input = rec.tokens.input;
    tokens.output = rec.tokens.output;
    tokens.cacheRead = rec.tokens.cacheRead;
    tokens.cacheWrite = rec.tokens.cacheWrite;
    tokens.reasoning = rec.tokens.reasoning;

    const record: UsageRecord = {
      platformId: PLATFORM_ID,
      modelId,
      providerId,
      sessionId: threadId,
      tokens,
      ts: rec.timestamp,
      messageCount: 1,
      confidence: "host-reported",
      dedupKey: dedupKey(threadId, rec),
    };
    if (rec.cost > 0) record.cost = rec.cost;
    // Amp does not capture a project → projectKey/projectLabel omitted.
    return record;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Reader
// ─────────────────────────────────────────────────────────────────────────

/** The Amp (Sourcegraph) usage reader singleton. */
const ampReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    const root = firstExistingRoot(PLATFORM_ID);
    if (root === undefined) return []; // no ~/.local/share/amp/threads → fail-open

    // ~/.local/share/amp/threads/*.json
    const files = walkFiles(root, (name) => name.endsWith(".json"));

    const records: UsageRecord[] = [];
    for (const file of files) {
      const rows = parseAmpFile(file);
      for (const row of rows) {
        if (sinceMs !== undefined && row.ts < sinceMs) continue;
        records.push(row);
      }
    }
    return records;
  },
};

export default ampReader;
