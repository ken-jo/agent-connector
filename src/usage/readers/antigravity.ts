/**
 * usage/readers/antigravity — Antigravity IDE usage reader.
 *
 * TWO sources, in priority order, both fail-open:
 *
 * 1. NATIVE IDE brain transcripts (primary). The Antigravity desktop app persists
 *    per-conversation transcripts as `transcript*.jsonl` under a `brain/` subtree
 *    of its global dir — canonical `~/.gemini/antigravity-ide/brain/**`, with the
 *    launch-era `~/.gemini/antigravity/brain/**` probed as a fallback (both seen
 *    in the wild). Each assistant turn embeds a Gemini-style `usage_metadata`
 *    block (promptTokenCount / candidatesTokenCount / cachedContentTokenCount /
 *    thoughtsTokenCount) which we extract exactly like the gemini-cli reader
 *    (cache-inclusive prompt → net input). The conversation also has a
 *    `<conv>.pb` protobuf dump — we SKIP all `.pb` (no public schema).
 *
 * 2. TOKSCALE CACHE (fallback). Antigravity is also a SYNCED platform in tokscale:
 *    a separate tokscale run may discover running language-server instances on
 *    localhost and pull live cascade-trajectory summaries over RPC into a local
 *    cache. We DO NOT perform that sync — no process scan, no port probe, no RPC,
 *    no network of any kind. We only READ whatever local cache artifacts a
 *    separate tokscale run may already have produced (manifest.json +
 *    sessions/*.jsonl, plus the loose ~/antigravity* brain/conversations dumps),
 *    using the exact tokscale Rust line schema (`session_meta` / `usage` rows).
 *
 * Confidence is MEDIUM for the native shape (Antigravity is fast-moving and its
 * docs are JS-rendered): the `usage_metadata` field names are documented/observed
 * but versions may differ → extraction is best-effort and fails open. The tokscale
 * cache rows carry real host token counts; both sources emit "host-reported".
 *
 * Fail-open: no native root AND no cache → []; unreadable/malformed file or line
 * → skipped; `.pb` protobuf → skipped.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

import type { UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { fileMtimeMs, readJsonFile, readJsonlLines } from "../jsonl.js";
import { inferProvider } from "../normalize.js";
import {
  antigravityNativeRoots,
  firstExistingRoot,
  isDir,
  listSubdirs,
  walkFiles,
} from "../paths.js";
import {
  nonEmptyStr,
  parseUsageMetadataRow,
  resolveAlias,
  sessionMetaModel,
  toSafeInt,
} from "./antigravity-shared.js";

const PLATFORM_ID = "antigravity" as const;
const DEFAULT_MODEL = "unknown";
const DEFAULT_PROVIDER = "antigravity";

// ─────────────────────────────────────────────────────────────────────────
// 1. NATIVE IDE brain transcripts (primary source)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse one native brain `transcript*.jsonl` file (best-effort usage_metadata
 * extraction). A `session_meta` row seeds the per-conversation model fallback;
 * any row carrying a `usage_metadata` block emits a record. The conversation id
 * is taken from the row, else from the parent `brain/<conv>/` dir name.
 */
function parseNativeTranscript(path: string): UsageRecord[] {
  const lines = readJsonlLines(path);
  if (lines.length === 0) return [];

  const fallbackSessionId = conversationIdFromPath(path);
  const fallbackTs = fileMtimeMs(path);
  let fallbackModel: string | undefined;

  const out: UsageRecord[] = [];
  for (const raw of lines) {
    const meta = sessionMetaModel(raw);
    if (meta !== undefined) {
      fallbackModel = meta;
      continue;
    }
    const record = parseUsageMetadataRow(raw, {
      platformId: PLATFORM_ID,
      fallbackSessionId,
      ...(fallbackModel !== undefined ? { fallbackModel } : {}),
      fallbackTs,
    });
    if (record !== undefined) out.push(record);
  }
  return out;
}

/** The `brain/<conv>/` directory name for a transcript path (the conversation id). */
function conversationIdFromPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter((c) => c !== "");
  const brainIdx = parts.lastIndexOf("brain");
  if (brainIdx >= 0 && brainIdx + 1 < parts.length) {
    const conv = parts[brainIdx + 1];
    if (conv !== undefined && conv !== "") return conv;
  }
  // Fall back to the file stem.
  const name = basename(path);
  const dot = name.indexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Walk the first existing native IDE root for `transcript*.jsonl` (skipping `.pb`). */
function nativeTranscriptFiles(): string[] {
  for (const root of antigravityNativeRoots()) {
    if (!isDir(root)) continue;
    const brain = join(root, "brain");
    if (!isDir(brain)) continue;
    return walkFiles(brain, (name) => {
      if (!name.endsWith(".jsonl")) return false; // .pb / media / md → skip
      return name.startsWith("transcript");
    });
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────
// 2. TOKSCALE CACHE (fallback) — port of tokscale parse_antigravity_file
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
 * Returns every *.jsonl under those dirs (`.pb` is naturally excluded).
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

/** The Antigravity IDE usage reader singleton (native brain + tokscale cache). */
const antigravityReader: UsageReader = {
  platformId: PLATFORM_ID,
  // "local": the primary source is the native on-disk brain transcripts. The
  // tokscale cache is read as a best-effort fallback (never synced by us).
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    const records: UsageRecord[] = [];

    // 1. Native IDE brain transcripts (primary).
    for (const file of nativeTranscriptFiles()) {
      let rows: UsageRecord[];
      try {
        rows = parseNativeTranscript(file);
      } catch {
        rows = []; // fail-open per file
      }
      for (const row of rows) {
        if (sinceMs !== undefined && row.ts < sinceMs) continue;
        records.push(row);
      }
    }

    // 2. Tokscale cache (fallback) — read regardless so a cache mirror still
    //    contributes; dedup is handled downstream via dedupKey.
    let cacheRows: UsageRecord[];
    try {
      cacheRows = readTokscaleCache();
    } catch {
      cacheRows = [];
    }
    for (const row of cacheRows) {
      if (sinceMs !== undefined && row.ts < sinceMs) continue;
      records.push(row);
    }

    return records;
  },
};

export default antigravityReader;
