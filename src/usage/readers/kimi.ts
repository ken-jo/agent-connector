/**
 * usage/readers/kimi — Kimi CLI (Moonshot) native session-log reader.
 *
 * Faithful port of tokscale sessions/kimi.rs. Reads the wire protocol log at
 *   ~/.kimi/sessions/<GROUP_ID>/<SESSION_UUID>/wire.jsonl
 * (the model name is read from the sibling ~/.kimi/config.json). Each line is a
 * timestamped wire frame; only frames whose `message.type === "StatusUpdate"`
 * carry a `payload.token_usage` block:
 *   input_other          → input
 *   output               → output
 *   input_cache_read     → cacheRead
 *   input_cache_creation → cacheWrite  (cache CREATION cost, not a read)
 *   reasoning is always 0 (the wire protocol folds reasoning into output).
 *
 * The first line (`{"type":"metadata", …}`) and every non-StatusUpdate frame
 * (TurnBegin / ContentPart / ToolCall / StepBegin …) are skipped. Zero-token
 * StatusUpdates are dropped.
 *
 * DEDUP (the double-counting hazard): Kimi emits PROGRESSIVE StatusUpdates for a
 * single assistant message as generation streams (e.g. message_id "msg-x" at
 * 100→10 tokens, then 120→30). We dedup by `payload.message_id`, keeping the row
 * with the MAX total tokens (tie-break: the later timestamp). Records WITHOUT a
 * (non-empty) message_id are never merged — each passes through as its own row,
 * exactly as the Rust push_or_replace_status_update does. The kept row's
 * `dedupKey` is its message_id (absent for un-keyed rows).
 *
 * Storage root: ~/.kimi/sessions, with two overrides honored on top of the fixed
 * paths.ts resolution — the AGENTCONNECT_KIMI_DIR override (via
 * firstExistingRoot) and $KIMI_CODE_HOME, which relocates the Kimi home (the
 * config.json lookup is path-relative, so it transparently handles a `.kimi-code`
 * home as well as `.kimi`).
 *
 * Model: `.model` from <home>/config.json (fallback "kimi-for-coding"); provider
 * is hard-coded "moonshot". Session id is the SESSION_UUID directory name. Kimi's
 * wire log carries no cwd, so there is no project attribution. Confidence is
 * "host-reported" (real host token counts).
 *
 * Fail-open: no root → []; an unreadable/malformed file or line → skipped.
 */

import { basename, dirname, join } from "node:path";

import type { TokenBreakdown, UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { fileMtimeMs, readJsonFile, readJsonlLines } from "../jsonl.js";
import { expandHome, firstExistingRoot, isDir, walkFiles } from "../paths.js";

const PLATFORM_ID = "kimi" as const;
const DEFAULT_MODEL = "kimi-for-coding";
const DEFAULT_PROVIDER = "moonshot";

/** A wire.jsonl line: metadata header OR a timestamped message frame. */
interface WireLine {
  type?: unknown;
  timestamp?: unknown;
  message?: {
    type?: unknown;
    payload?: {
      token_usage?: {
        input_other?: unknown;
        output?: unknown;
        input_cache_read?: unknown;
        input_cache_creation?: unknown;
      };
      message_id?: unknown;
    };
  };
}

/** Coerce an unknown to a non-negative integer (0 on absence/garbage). */
function toNonNegInt(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/**
 * Convert the wire `timestamp` (Unix seconds, often fractional like
 * 1770983426.420942) to epoch ms. Returns null when unusable so the caller can
 * fall back to the file mtime (port of `timestamp * 1000.0 as i64`).
 */
function parseWireTs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return Math.trunc(v * 1000);
  }
  return null;
}

/**
 * Read the model name from the Kimi home's config.json (port of
 * read_model_from_config). The wire path is
 *   <home>/sessions/<GROUP_ID>/<SESSION_UUID>/wire.jsonl
 * so the home dir is four `dirname` hops up, and config.json sits beside the
 * sessions dir. Fail-open to DEFAULT_MODEL on any missing/garbage value.
 */
function readModelFromConfig(wirePath: string): string {
  // wire.jsonl → SESSION_UUID → GROUP_ID → sessions → <home>
  const sessionDir = dirname(wirePath);
  const groupDir = dirname(sessionDir);
  const sessionsDir = dirname(groupDir);
  const homeDir = dirname(sessionsDir);
  const configPath = join(homeDir, "config.json");

  const parsed = readJsonFile(configPath);
  if (typeof parsed === "object" && parsed !== null) {
    const model = (parsed as { model?: unknown }).model;
    if (typeof model === "string" && model !== "") return model;
  }
  return DEFAULT_MODEL;
}

/**
 * Session id from the wire path: the SESSION_UUID directory name (the immediate
 * parent of wire.jsonl). Port of extract_session_id.
 */
function extractSessionId(wirePath: string): string {
  const dir = basename(dirname(wirePath));
  return dir === "" ? "unknown" : dir;
}

/** Sum of the five token dimensions (port of TokenBreakdown::total). */
function tokenTotal(t: TokenBreakdown): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite + t.reasoning;
}

/**
 * Whether `candidate` should replace `existing` for the same message_id. Port of
 * should_replace_status_update: a strictly larger total wins; on an equal total
 * the later-or-equal timestamp wins (so the freshest progressive update is kept).
 */
function shouldReplace(existing: UsageRecord, candidate: UsageRecord): boolean {
  const existingTotal = tokenTotal(existing.tokens);
  const candidateTotal = tokenTotal(candidate.tokens);
  return (
    candidateTotal > existingTotal ||
    (candidateTotal === existingTotal && candidate.ts >= existing.ts)
  );
}

/** Parse one Kimi wire.jsonl file into usage records (port of parse_kimi_file). */
function parseKimiFile(path: string): UsageRecord[] {
  const lines = readJsonlLines(path);
  if (lines.length === 0) return [];

  const model = readModelFromConfig(path);
  const sessionId = extractSessionId(path);
  const mtime = fileMtimeMs(path);

  const out: UsageRecord[] = [];
  // message_id → index into `out`, for progressive-StatusUpdate dedup.
  const keyedIndices = new Map<string, number>();

  for (const raw of lines) {
    if (typeof raw !== "object" || raw === null) continue;
    const wire = raw as WireLine;

    // Skip the metadata header line.
    if (wire.type === "metadata") continue;

    const message = wire.message;
    if (typeof message !== "object" || message === null) continue;

    // Only StatusUpdate frames carry token usage.
    if (message.type !== "StatusUpdate") continue;

    const payload = message.payload;
    if (typeof payload !== "object" || payload === null) continue;

    const usage = payload.token_usage;
    if (typeof usage !== "object" || usage === null) continue;

    const input = toNonNegInt(usage.input_other);
    const output = toNonNegInt(usage.output);
    const cacheRead = toNonNegInt(usage.input_cache_read);
    const cacheWrite = toNonNegInt(usage.input_cache_creation);

    // Skip zero-token entries.
    if (input + output + cacheRead + cacheWrite === 0) continue;

    const ts = parseWireTs(wire.timestamp) ?? mtime;

    const tokens = emptyTokens();
    tokens.input = input;
    tokens.output = output;
    tokens.cacheRead = cacheRead;
    tokens.cacheWrite = cacheWrite;
    // reasoning stays 0 — the Kimi wire protocol folds reasoning into output.

    const messageId = payload.message_id;
    const dedupKey =
      typeof messageId === "string" && messageId !== "" ? messageId : undefined;

    const record: UsageRecord = {
      platformId: PLATFORM_ID,
      modelId: model,
      providerId: DEFAULT_PROVIDER,
      sessionId,
      tokens,
      ts,
      messageCount: 1,
      confidence: "host-reported",
    };
    if (dedupKey !== undefined) record.dedupKey = dedupKey;

    if (dedupKey === undefined) {
      // Un-keyed StatusUpdates are never merged — each is its own row.
      out.push(record);
      continue;
    }

    const existingIndex = keyedIndices.get(dedupKey);
    if (existingIndex !== undefined) {
      const existing = out[existingIndex];
      if (existing !== undefined && shouldReplace(existing, record)) {
        out[existingIndex] = record;
      }
      continue;
    }

    keyedIndices.set(dedupKey, out.length);
    out.push(record);
  }

  return out;
}

/**
 * Candidate Kimi session roots, most-preferred first. Honors the fixed paths.ts
 * resolution (AGENTCONNECT_KIMI_DIR override → ~/.kimi/sessions) plus
 * $KIMI_CODE_HOME, which relocates the Kimi home directory.
 */
function kimiSessionRoots(): string[] {
  const roots: string[] = [];

  const codeHome = process.env.KIMI_CODE_HOME;
  if (codeHome != null && codeHome.trim() !== "") {
    roots.push(join(expandHome(codeHome.trim()), "sessions"));
  }

  const standard = firstExistingRoot(PLATFORM_ID);
  if (standard !== undefined) roots.push(standard);

  return roots;
}

/** The Kimi CLI usage reader singleton. */
const kimiReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    const roots = kimiSessionRoots().filter((r) => isDir(r));
    if (roots.length === 0) return []; // no ~/.kimi/sessions → fail-open

    // <root>/<GROUP_ID>/<SESSION_UUID>/wire.jsonl
    const seen = new Set<string>();
    const records: UsageRecord[] = [];
    for (const root of roots) {
      const files = walkFiles(root, (name) => name === "wire.jsonl");
      for (const file of files) {
        if (seen.has(file)) continue; // de-overlap if KIMI_CODE_HOME == ~/.kimi
        seen.add(file);
        const rows = parseKimiFile(file);
        for (const row of rows) {
          if (sinceMs !== undefined && row.ts < sinceMs) continue;
          records.push(row);
        }
      }
    }
    return records;
  },
};

export default kimiReader;
