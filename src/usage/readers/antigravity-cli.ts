/**
 * usage/readers/antigravity-cli — Antigravity CLI (`agy`) usage reader (SYNCED).
 *
 * CONFIRMED-BY-INSTALL (2026-06-03, docs/research/antigravity-paths-confirmed.md):
 * the `agy` CLI v1.0.0 has NO separate config/storage dir — it SHARES the IDE's
 * `~/.gemini/antigravity/` tree, whose native conversation store is
 * `conversations/<uuid>.pb` (PROTOBUF, no public schema) with `brain/<uuid>/`
 * holding only media + `*.metadata.json`. There are NO `transcript*.jsonl` files
 * and NO separate `~/.gemini/antigravity-cli/` dir. The earlier "read native
 * brain transcript*.jsonl with usage_metadata" approach targeted a non-existent
 * shape.
 *
 * So this reader does NOT attempt to parse `.pb` (no schema). Like the IDE reader
 * (and the other SYNCED platforms cursor/trae/warp), it reads only the tokscale
 * synced-cache if a separate tokscale run already produced one; otherwise it
 * returns [] and the scan layer reports "requires sync (no local cache found)"
 * — i.e. the native store is protobuf (.pb), not readable.
 *
 * The native `~/.gemini/antigravity/` dir (shared with the IDE) is used ONLY for
 * platform detection (in the adapter), NOT for usage parsing here. Cached rows
 * carry real host token counts → "host-reported".
 *
 * Fail-open: no cache → []; unreadable/malformed file or line → skipped; we NEVER
 * touch `.pb` protobuf.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { readJsonlLines } from "../jsonl.js";
import { inferProvider } from "../normalize.js";
import { firstExistingRoot, isDir, walkFiles } from "../paths.js";
import { nonEmptyStr, resolveAlias, toSafeInt } from "./antigravity-shared.js";

const PLATFORM_ID = "antigravity-cli" as const;
const DEFAULT_MODEL = "unknown";
const DEFAULT_PROVIDER = "antigravity";

// ─────────────────────────────────────────────────────────────────────────
// TOKSCALE CACHE — same line schema as the IDE reader
// ─────────────────────────────────────────────────────────────────────────

/** Fields we read off a tokscale-cache Antigravity JSONL line (all optional). */
interface AntigravityLine {
  type?: unknown;
  modelId?: unknown;
  providerId?: unknown;
  sessionId?: unknown;
  timestamp?: unknown;
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  reasoning?: unknown;
  responseId?: unknown;
}

/** Parse one tokscale-cache JSONL file into usage records (session_meta + usage rows). */
function parseCacheFile(path: string): UsageRecord[] {
  const lines = readJsonlLines(path);
  if (lines.length === 0) return [];

  const out: UsageRecord[] = [];
  let sessionModel: string | undefined;

  for (const raw of lines) {
    if (typeof raw !== "object" || raw === null) continue;
    const line = raw as AntigravityLine;

    const rowType = typeof line.type === "string" ? line.type : "";
    if (rowType === "session_meta") {
      const meta = nonEmptyStr(line.modelId);
      if (meta !== undefined) sessionModel = meta;
      continue;
    }
    if (rowType !== "usage") continue;

    const record = parseCacheUsageRow(line, sessionModel);
    if (record !== undefined) out.push(record);
  }

  return out;
}

/** Build a UsageRecord from a "usage" line, or undefined when invalid/empty. */
function parseCacheUsageRow(line: AntigravityLine, fallbackModel: string | undefined): UsageRecord | undefined {
  const sessionId = nonEmptyStr(line.sessionId);
  if (sessionId === undefined) return undefined;

  const timestamp = toSafeInt(line.timestamp);
  if (timestamp <= 0) return undefined;

  const rawModel = nonEmptyStr(line.modelId) ?? fallbackModel ?? DEFAULT_MODEL;
  const modelId = resolveAlias(rawModel) ?? rawModel;
  const providerId = nonEmptyStr(line.providerId) ?? inferProvider(modelId) ?? DEFAULT_PROVIDER;

  const input = toSafeInt(line.input);
  const output = toSafeInt(line.output);
  const cacheRead = toSafeInt(line.cacheRead);
  const cacheWrite = toSafeInt(line.cacheWrite);
  const reasoning = toSafeInt(line.reasoning);
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && reasoning === 0) {
    return undefined;
  }

  const tokens = emptyTokens();
  tokens.input = input;
  tokens.output = output;
  tokens.cacheRead = cacheRead;
  tokens.cacheWrite = cacheWrite;
  tokens.reasoning = reasoning;

  const record: UsageRecord = {
    platformId: PLATFORM_ID,
    modelId,
    providerId,
    sessionId,
    tokens,
    ts: timestamp,
    messageCount: 1,
    confidence: "host-reported",
  };
  const dedupKey = nonEmptyStr(line.responseId);
  if (dedupKey !== undefined) record.dedupKey = dedupKey;
  return record;
}

/** Collect tokscale-cache records (sessions/*.jsonl under the cache root). */
function readTokscaleCache(): UsageRecord[] {
  const cacheRoot = firstExistingRoot(PLATFORM_ID);
  if (cacheRoot === undefined) return [];

  const files = new Set<string>();
  const sessionsDir = join(cacheRoot, "sessions");
  if (isDir(sessionsDir)) {
    for (const f of walkFiles(sessionsDir, (name) => name.endsWith(".jsonl"))) files.add(f);
  }
  // Also tolerate loose *.jsonl directly under the cache root.
  for (const f of walkFiles(cacheRoot, (name) => name.endsWith(".jsonl"))) files.add(f);

  if (files.size === 0) return [];

  const out: UsageRecord[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const row of parseCacheFile(file)) out.push(row);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Reader
// ─────────────────────────────────────────────────────────────────────────

/**
 * The Antigravity CLI usage reader singleton (SYNCED). `agy` shares the IDE's
 * protobuf (.pb) native store with no public schema → not parseable; we read only
 * the tokscale synced-cache if present, else [] (scan reports "requires sync").
 */
const antigravityCliReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "synced",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    let cacheRows: UsageRecord[];
    try {
      cacheRows = readTokscaleCache();
    } catch {
      cacheRows = []; // fail-open
    }

    const records: UsageRecord[] = [];
    for (const row of cacheRows) {
      if (sinceMs !== undefined && row.ts < sinceMs) continue;
      records.push(row);
    }
    return records;
  },
};

export default antigravityCliReader;
