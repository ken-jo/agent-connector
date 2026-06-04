/**
 * usage/readers/antigravity — Antigravity IDE usage reader (SYNCED platform).
 *
 * CONFIRMED-BY-INSTALL (2026-06-03, docs/research/antigravity-paths-confirmed.md):
 * the native Antigravity store is `~/.gemini/antigravity/conversations/<uuid>.pb`
 * — PROTOBUF with NO public schema — and `brain/<uuid>/` holds only media +
 * `*.metadata.json`. There are NO `transcript*.jsonl` files. The earlier
 * "read native brain transcript*.jsonl with usage_metadata" approach was based on
 * a shape that does not exist on disk.
 *
 * So this reader does NOT attempt to parse `.pb` (no schema). Like the other
 * SYNCED platforms (cursor/trae/warp), it reads only the tokscale synced-cache
 * if a separate tokscale run already produced one; otherwise it returns [] and
 * the scan layer reports "requires sync (no local cache found)" — i.e. the native
 * store is protobuf (.pb), not readable.
 *
 *   - cache present → parse the tokscale cache (manifest.json + sessions/*.jsonl,
 *     plus any loose ~/antigravity* brain/conversations *.jsonl dumps) using the
 *     tokscale Rust line schema (`session_meta` / `usage` rows);
 *   - cache absent  → [] (kind:"synced" → scan notes "requires sync").
 *
 * The native `~/.gemini/antigravity/` dir is used ONLY for platform detection (in
 * the adapter), NOT for usage parsing here. The cached rows carry real host token
 * counts → "host-reported".
 *
 * Fail-open: no cache → []; unreadable/malformed file or line → skipped; we NEVER
 * touch `.pb` protobuf.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

import type { UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { readJsonFile, readJsonlLines } from "../jsonl.js";
import { inferProvider } from "../normalize.js";
import { firstExistingRoot, isDir, listSubdirs, walkFiles } from "../paths.js";
import { nonEmptyStr, resolveAlias, toSafeInt } from "./antigravity-shared.js";

const PLATFORM_ID = "antigravity" as const;
const DEFAULT_MODEL = "unknown";
const DEFAULT_PROVIDER = "antigravity";

// ─────────────────────────────────────────────────────────────────────────
// TOKSCALE CACHE — port of tokscale parse_antigravity_file
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

/**
 * Parse one tokscale-cache Antigravity JSONL file into usage records (port of
 * parse_antigravity_file + parse_usage_row). A `session_meta` line updates the
 * running fallback model; a `usage` line emits a record when valid.
 */
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

/** Port of parse_usage_row: build a UsageRecord from a "usage" line, or undefined. */
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

/** A manifest entry's relative artifact path, tolerant of the field spelling. */
interface ManifestEntry {
  artifact_path?: unknown;
  artifactPath?: unknown;
}

/**
 * Read manifest.json (if present) and return the cache-relative artifact paths it
 * lists, resolved to absolute paths that stay INSIDE the cache dir (a traversal
 * or absolute path in the manifest is rejected, fail-open).
 */
function manifestArtifacts(cacheDir: string): string[] {
  const manifestPath = join(cacheDir, "manifest.json");
  if (!existsSync(manifestPath)) return [];
  const data = readJsonFile(manifestPath);
  if (data === undefined || data === null) return [];

  let entries: unknown[];
  if (Array.isArray(data)) {
    entries = data;
  } else if (typeof data === "object") {
    const obj = data as { sessions?: unknown; entries?: unknown };
    entries = Array.isArray(obj.sessions) ? obj.sessions : Array.isArray(obj.entries) ? obj.entries : [];
  } else {
    return [];
  }

  const cacheRootResolved = resolve(cacheDir);
  const out: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as ManifestEntry;
    const rel = nonEmptyStr(e.artifact_path) ?? nonEmptyStr(e.artifactPath);
    if (rel === undefined) continue;
    if (isAbsolute(rel)) continue;
    const abs = resolve(cacheDir, rel);
    if (abs !== cacheRootResolved && !abs.startsWith(cacheRootResolved + sep)) continue;
    out.push(abs);
  }
  return out;
}

/**
 * Loose local-filesystem trajectory dumps: ~/antigravity-prefixed dirs, each with
 * a brain/ and/or conversations/ subdir (the local half of tokscale's merge).
 * Returns every *.jsonl under those dirs (`.pb` is naturally excluded — these are
 * tokscale-produced JSONL mirrors, NOT the native protobuf store).
 */
function filesystemArtifacts(): string[] {
  const home = homedir();
  if (!isDir(home)) return [];

  const out: string[] = [];
  for (const child of listSubdirs(home)) {
    const name = basename(child);
    if (!name.startsWith("antigravity")) continue;
    for (const sub of ["brain", "conversations"]) {
      const dir = join(child, sub);
      if (!isDir(dir)) continue;
      for (const f of walkFiles(dir, (fname) => fname.endsWith(".jsonl"))) {
        out.push(f);
      }
    }
  }
  return out;
}

/** Collect tokscale-cache records (manifest ∪ sessions/*.jsonl ∪ loose ~/antigravity*). */
function readTokscaleCache(): UsageRecord[] {
  const cacheRoot = firstExistingRoot(PLATFORM_ID);

  const files = new Set<string>();
  if (cacheRoot !== undefined) {
    for (const f of manifestArtifacts(cacheRoot)) files.add(f);
    const sessionsDir = join(cacheRoot, "sessions");
    if (isDir(sessionsDir)) {
      for (const f of walkFiles(sessionsDir, (name) => name.endsWith(".jsonl"))) files.add(f);
    }
  }
  for (const f of filesystemArtifacts()) files.add(f);

  if (files.size === 0) return [];

  const out: UsageRecord[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue; // stale manifest reference → skip
    for (const row of parseCacheFile(file)) out.push(row);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Reader
// ─────────────────────────────────────────────────────────────────────────

/**
 * The Antigravity IDE usage reader singleton (SYNCED). The native store is
 * protobuf (.pb) with no public schema → not parseable; we read only the tokscale
 * synced-cache if present, else [] (scan reports "requires sync").
 */
const antigravityReader: UsageReader = {
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

export default antigravityReader;
