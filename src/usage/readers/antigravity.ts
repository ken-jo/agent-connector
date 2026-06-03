/**
 * usage/readers/antigravity — Antigravity (Codeium cascade) SYNCED usage reader.
 *
 * Faithful port of tokscale sessions/antigravity.rs (parse_antigravity_file +
 * parse_usage_row). Antigravity is a SYNCED platform: tokscale fills a local
 * cache by discovering running language-server instances on localhost and pulling
 * live cascade-trajectory summaries over an RPC channel (clients.rs), merging
 * them with the local filesystem. We DO NOT perform that sync — no process scan,
 * no port probe, no RPC, no network of any kind. We only READ whatever local
 * cache artifacts a separate tokscale run may already have produced, plus the
 * loose filesystem brain/conversations dumps, and parse them with the exact
 * Rust line schema. If no cache exists, the scan layer notes "requires sync,
 * skipped" and we return [].
 *
 * Local cache root: ~/.config/tokscale/antigravity-cache (env override
 * AGENT_CONNECTOR_ANTIGRAVITY_DIR; resolved by paths.ts). Artifacts read:
 *   - manifest.json — optional ManifestSessionEntry[] index; each entry's
 *     artifact_path (relative, e.g. "sessions/{id}-{hash}.jsonl") points at a
 *     session JSONL dump. We resolve those (cache-root-relative, never escaping
 *     the cache dir) and parse them.
 *   - sessions/*.jsonl — the on-disk session dumps (parsed directly too, so a
 *     present artifact is read even if the manifest is missing/stale; a manifest
 *     entry whose file is absent is simply skipped, fail-open).
 *   - ~/antigravity-prefixed dirs, brain/ and conversations/ subtrees (the
 *     `*.jsonl` loose local-filesystem trajectory dumps) — the part of the merge
 *     that is purely local; the RPC part is skipped. Parsed with the same schema.
 * The PID-based sync.lock is ignored entirely (we never write).
 *
 * JSONL line schema (one JSON object per line). Two row types matter:
 *   - "session_meta": carries a `modelId` used as the per-session fallback model.
 *   - "usage": the token row — modelId (fallback to session_meta), providerId
 *     (fallback to model-inferred / "antigravity"), input/output/cacheRead/
 *     cacheWrite/reasoning, timestamp (epoch ms, must be > 0), responseId (dedup).
 * Placeholder model ids (e.g. "MODEL_PLACEHOLDER_M26") are resolved via the
 * tokscale model-alias table before grouping. Zero-token usage rows are dropped.
 *
 * Confidence is "host-reported" (the cache carries real host token counts);
 * the spec's "medium" confidence is expressed at the SCAN level for synced
 * platforms — this reader emits honest host-reported token rows per cached line.
 *
 * Fail-open: no cache root → []; unreadable/malformed file or line → skipped.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

import type { UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { readJsonFile, readJsonlLines } from "../jsonl.js";
import { inferProvider } from "../normalize.js";
import { firstExistingRoot, isDir, listSubdirs, walkFiles } from "../paths.js";

const PLATFORM_ID = "antigravity" as const;
const DEFAULT_MODEL = "unknown";
const DEFAULT_PROVIDER = "antigravity";

// ─────────────────────────────────────────────────────────────────────────
// Model alias table (port of tokscale pricing::aliases::resolve_alias).
// Keys are lowercased; lookup lowercases the input. Resolves placeholder /
// reseller model ids (e.g. Antigravity's MODEL_PLACEHOLDER_*) to canonical ids.
// ─────────────────────────────────────────────────────────────────────────
const MODEL_ALIASES: ReadonlyMap<string, string> = new Map([
  ["big-pickle", "glm-4.7"],
  ["big pickle", "glm-4.7"],
  ["bigpickle", "glm-4.7"],
  ["k2p5", "kimi-k2-thinking"],
  ["k2-p5", "kimi-k2-thinking"],
  ["k2p6", "kimi-k2.6"],
  ["k2-p6", "kimi-k2.6"],
  ["kimi-k2p6", "kimi-k2.6"],
  ["kimi-k2.5-thinking", "kimi-k2-thinking"],
  ["kimi-for-coding", "kimi-k2.5"],
  ["model_placeholder_m26", "claude-opus-4-6"],
  ["model_placeholder_m35", "claude-sonnet-4-6"],
  ["model_placeholder_m36", "gemini-3.1-pro"],
  ["model_placeholder_m37", "gemini-3.1-pro"],
  ["model_placeholder_m47", "gemini-3-flash-preview"],
  ["model_openai_gpt_oss_120b_medium", "gpt-oss-120b-medium"],
  ["claude-opus-4-6-thinking", "claude-opus-4-6"],
  ["claude-sonnet-4-6-thinking", "claude-sonnet-4-6"],
  ["claude-opus-4.6-thinking", "claude-opus-4-6"],
  ["claude-sonnet-4.6-thinking", "claude-sonnet-4-6"],
  ["claude-opus-4-6", "claude-opus-4-6"],
  ["claude-sonnet-4-6", "claude-sonnet-4-6"],
  ["claude-haiku-4-6", "claude-haiku-4-6"],
  ["claude-opus-4.6", "claude-opus-4-6"],
  ["claude-sonnet-4.6", "claude-sonnet-4-6"],
  ["claude-haiku-4.6", "claude-haiku-4-6"],
  ["anthropic/claude-4-5-opus", "claude-opus-4-5"],
  ["anthropic/claude-4-5-sonnet", "claude-sonnet-4-5"],
  ["anthropic/claude-4-5-haiku", "claude-haiku-4-5"],
  ["anthropic/claude-4-6-opus", "claude-opus-4-6"],
  ["anthropic/claude-4-6-sonnet", "claude-sonnet-4-6"],
  ["anthropic/claude-4-6-haiku", "claude-haiku-4-6"],
  ["gemini-3.1-pro-high", "gemini-3.1-pro"],
  ["gemini-3.1-pro-low", "gemini-3.1-pro"],
  ["gemini-3-pro-high", "gemini-3-pro"],
  ["gemini-3-pro-low", "gemini-3-pro"],
  ["gemini-3-flash", "gemini-3-flash-preview"],
  ["gemini-3-flash-c", "gemini-3-flash-preview"],
  ["kimi-k2.5-nvfp4", "kimi-k2.5"],
  ["kimi-k2-instruct-0905", "kimi-k2.5"],
]);

/** Resolve a model alias to its canonical id, or undefined when none matches. */
function resolveAlias(modelId: string): string | undefined {
  return MODEL_ALIASES.get(modelId.toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────
// Line schema
// ─────────────────────────────────────────────────────────────────────────

/** Fields we read off an Antigravity JSONL line (everything optional / unknown). */
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
 * Coerce an unknown to a non-negative i64-safe integer (port of to_safe_i64):
 * accepts number or numeric string, floors toward zero, clamps at 0; 0 otherwise.
 */
function toSafeInt(v: unknown): number {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string"
        ? Number(v.trim())
        : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/** A non-empty trimmed string, or undefined (port of the `.filter(!is_empty)` guards). */
function nonEmptyStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return v.trim() === "" ? undefined : v;
}

/**
 * Parse one Antigravity JSONL file into usage records (port of
 * parse_antigravity_file + parse_usage_row). A `session_meta` line updates the
 * running fallback model; a `usage` line emits a record when valid. Order is
 * preserved so a `session_meta` seen before its usage rows supplies the fallback.
 */
function parseAntigravityFile(path: string): UsageRecord[] {
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

    const record = parseUsageRow(line, sessionModel);
    if (record !== undefined) out.push(record);
  }

  return out;
}

/** Port of parse_usage_row: build a UsageRecord from a "usage" line, or undefined. */
function parseUsageRow(line: AntigravityLine, fallbackModel: string | undefined): UsageRecord | undefined {
  const sessionId = nonEmptyStr(line.sessionId);
  if (sessionId === undefined) return undefined;

  const timestamp = toSafeInt(line.timestamp);
  if (timestamp <= 0) return undefined;

  // modelId: line → session_meta fallback → "unknown"; then alias-resolved.
  const rawModel = nonEmptyStr(line.modelId) ?? fallbackModel ?? DEFAULT_MODEL;
  const modelId = resolveAlias(rawModel) ?? rawModel;

  // providerId: explicit field → inferred from model → "antigravity".
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

// ─────────────────────────────────────────────────────────────────────────
// File discovery (LOCAL artifacts only — NEVER RPC / process / port scan)
// ─────────────────────────────────────────────────────────────────────────

/** A manifest entry's relative artifact path, tolerant of the field spelling. */
interface ManifestEntry {
  artifact_path?: unknown;
  artifactPath?: unknown;
}

/**
 * Read manifest.json (if present) and return the cache-relative artifact paths it
 * lists, resolved to absolute paths that stay INSIDE the cache dir (a traversal
 * or absolute path in the manifest is rejected, fail-open). The manifest may be
 * an array of entries or an object with a `sessions`/`entries` array.
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
    // Reject absolute paths and any that escape the cache dir (no traversal).
    if (isAbsolute(rel)) continue;
    const abs = resolve(cacheDir, rel);
    if (abs !== cacheRootResolved && !abs.startsWith(cacheRootResolved + sep)) continue;
    out.push(abs);
  }
  return out;
}

/**
 * Loose local-filesystem trajectory dumps: ~/antigravity-prefixed dirs, each
 * with a brain/ and/or conversations/ subdir (the local half of tokscale's
 * merge; the RPC half is skipped).
 * Returns every *.jsonl under those dirs. Tolerant of a missing home / dirs.
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

// ─────────────────────────────────────────────────────────────────────────
// Reader
// ─────────────────────────────────────────────────────────────────────────

/** The Antigravity synced usage reader singleton. */
const antigravityReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "synced",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    // Local cache root: ~/.config/tokscale/antigravity-cache (or env override).
    // Absent → no sync has populated it → fail-open to [] (scan notes "requires
    // sync, skipped"). We NEVER discover servers, probe ports, or call any RPC.
    const cacheRoot = firstExistingRoot(PLATFORM_ID);

    // Dedupe the file set: manifest-listed artifacts ∪ loose sessions/*.jsonl ∪
    // local-filesystem brain/conversations dumps. A manifest entry whose file is
    // gone is skipped by the existsSync guard below.
    const files = new Set<string>();

    if (cacheRoot !== undefined) {
      for (const f of manifestArtifacts(cacheRoot)) files.add(f);

      // sessions/*.jsonl directly under the cache (read even sans manifest).
      const sessionsDir = join(cacheRoot, "sessions");
      if (isDir(sessionsDir)) {
        for (const f of walkFiles(sessionsDir, (name) => name.endsWith(".jsonl"))) {
          files.add(f);
        }
      }
    }

    for (const f of filesystemArtifacts()) files.add(f);

    if (files.size === 0) return [];

    const records: UsageRecord[] = [];
    for (const file of files) {
      if (!existsSync(file)) continue; // stale manifest reference → skip
      for (const row of parseAntigravityFile(file)) {
        if (sinceMs !== undefined && row.ts < sinceMs) continue;
        records.push(row);
      }
    }
    return records;
  },
};

export default antigravityReader;
