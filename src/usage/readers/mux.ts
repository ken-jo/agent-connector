/**
 * usage/readers/mux — Mux (Coder) native session-usage reader.
 *
 * Faithful port of tokscale sessions/mux.rs. Reads the aggregate
 * ~/.mux/sessions/<workspaceId>/session-usage.json file (one per workspace).
 * This is NOT a JSONL log: each file is a single JSON object carrying a
 * `byModel` map keyed by `<provider>:<model>`, with one cumulative token bucket
 * group per model used in the session:
 *   byModel.<key>.input.tokens       → input
 *   byModel.<key>.cached.tokens      → cacheRead
 *   byModel.<key>.cacheCreate.tokens → cacheWrite
 *   byModel.<key>.output.tokens      → output
 *   byModel.<key>.reasoning.tokens   → reasoning
 * Each bucket also carries an optional `.cost_usd`; the Rust sums those across
 * the five buckets into a source cost, but cost is out of scope for v1 readers
 * (matching the droid/amp JSON siblings) so we do not emit it. Negative token
 * counts are clamped to 0 and an entry whose five dimensions sum to 0 is dropped.
 *
 * One UsageRecord is produced per `byModel` entry (model used in the session).
 * The model key is split on the FIRST ':' only: the prefix is the provider id,
 * the remainder is the model id (so "provider:sub:model" → provider="provider",
 * model="sub:model"). A key with no ':' yields an empty provider and the full
 * key as the model id (matching the Rust empty-string provider).
 *
 * Session id is the parent directory name (the workspaceId), e.g.
 * ".../sessions/abc123/session-usage.json" → "abc123". The session-usage.json
 * structure carries no cwd/dir, so there is no project attribution. Timestamp
 * prefers `lastRequest.timestamp` (i64 epoch milliseconds), falling back to the
 * file mtime. No dedup is needed — the file is an aggregate, not an incremental
 * log, and each model key appears once. Confidence is "host-reported".
 *
 * Fail-open: no root → []; unreadable/malformed file → skipped (never throws).
 */

import { basename, dirname } from "node:path";

import type { UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { fileMtimeMs, readJsonFile } from "../jsonl.js";
import { firstExistingRoot, walkFiles } from "../paths.js";

const PLATFORM_ID = "mux" as const;

/** A single token bucket within a model entry (every field optional / unknown). */
interface MuxTokenBucket {
  tokens?: unknown;
}

/** One model entry under `byModel` (every bucket optional / unknown). */
interface MuxModelUsage {
  input?: MuxTokenBucket;
  cached?: MuxTokenBucket;
  cacheCreate?: MuxTokenBucket;
  output?: MuxTokenBucket;
  reasoning?: MuxTokenBucket;
}

/** The session-usage.json shape we read (everything optional / unknown). */
interface MuxSessionUsage {
  byModel?: unknown;
  lastRequest?: {
    timestamp?: unknown;
  };
}

/**
 * Coerce a bucket's token count to a non-negative integer, mirroring the Rust
 * closure `b.as_ref().and_then(|b| b.tokens).unwrap_or(0).max(0)`: absent or
 * non-numeric → 0, negatives clamped to 0.
 */
function bucketTokens(bucket: MuxTokenBucket | undefined): number {
  const v = bucket?.tokens;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/**
 * Parse a `lastRequest.timestamp` to epoch ms, or null when unusable. Mux logs
 * an i64 of epoch milliseconds, so a positive finite number is taken verbatim
 * (no seconds heuristic — the Rust treats it as raw millis).
 */
function parseTimestampMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.trunc(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  }
  return null;
}

/**
 * Split a model key on the FIRST ':' into provider + model (port of the Rust
 * splitn(2, ':')): "anthropic:claude-opus-4-6" → { provider: "anthropic",
 * model: "claude-opus-4-6" }; "provider:sub:model" → { provider: "provider",
 * model: "sub:model" }; a key with no ':' → empty provider, full key as model.
 */
function splitModelKey(key: string): { provider: string; model: string } {
  const colon = key.indexOf(":");
  if (colon < 0) return { provider: "", model: key };
  return { provider: key.slice(0, colon), model: key.slice(colon + 1) };
}

/** Parse one mux session-usage.json file into usage records (port of parse_mux_file). */
function parseMuxFile(path: string): UsageRecord[] {
  const raw = readJsonFile(path);
  if (typeof raw !== "object" || raw === null) return [];
  const usage = raw as MuxSessionUsage;

  const byModel = usage.byModel;
  if (typeof byModel !== "object" || byModel === null) return [];

  // Timestamp: lastRequest.timestamp (epoch ms) else the file mtime.
  const ts = parseTimestampMs(usage.lastRequest?.timestamp) ?? fileMtimeMs(path);

  // Session id = the parent directory name (the workspaceId).
  const sessionId = basename(dirname(path));

  const out: UsageRecord[] = [];
  for (const [modelKey, value] of Object.entries(byModel as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const modelUsage = value as MuxModelUsage;

    const input = bucketTokens(modelUsage.input);
    const cacheRead = bucketTokens(modelUsage.cached);
    const cacheWrite = bucketTokens(modelUsage.cacheCreate);
    const output = bucketTokens(modelUsage.output);
    const reasoning = bucketTokens(modelUsage.reasoning);

    // Skip entries with no tokens in any dimension.
    if (input + cacheRead + cacheWrite + output + reasoning === 0) continue;

    const { provider, model } = splitModelKey(modelKey);

    const tokens = emptyTokens();
    tokens.input = input;
    tokens.output = output;
    tokens.cacheRead = cacheRead;
    tokens.cacheWrite = cacheWrite;
    tokens.reasoning = reasoning;

    out.push({
      platformId: PLATFORM_ID,
      modelId: model,
      providerId: provider,
      sessionId,
      tokens,
      ts,
      messageCount: 1,
      confidence: "host-reported",
    });
  }

  return out;
}

/** The Mux (Coder) usage reader singleton. */
const muxReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    const root = firstExistingRoot(PLATFORM_ID);
    if (root === undefined) return []; // no ~/.mux/sessions → fail-open

    // ~/.mux/sessions/<workspaceId>/session-usage.json
    const files = walkFiles(root, (name) => name === "session-usage.json");

    const records: UsageRecord[] = [];
    for (const file of files) {
      const rows = parseMuxFile(file);
      for (const row of rows) {
        if (sinceMs !== undefined && row.ts < sinceMs) continue;
        records.push(row);
      }
    }
    return records;
  },
};

export default muxReader;
