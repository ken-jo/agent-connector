/**
 * usage/readers/qwen-code — Qwen CLI native session-log reader.
 *
 * Faithful port of tokscale sessions/qwen.rs (the reference reader). Reads
 * ~/.qwen/projects/<project>/chats/*.jsonl. Each line is one entry; only
 * `type:"assistant"` lines carry a `usageMetadata` token block:
 *   promptTokenCount      → input  (cumulative prompt incl. cached context)
 *   candidatesTokenCount  → output
 *   thoughtsTokenCount    → reasoning
 *   cachedContentTokenCount → cacheRead
 *   cacheWrite is always 0 (Qwen does not report it).
 *
 * Qwen reports the cumulative prompt as promptTokenCount and the cached portion
 * separately, so the net "fresh" input is promptTokenCount - cachedContentTokenCount
 * (clamped ≥ 0), keeping the dimensions disjoint for an honest total.
 *
 * No dedup, no deltas, no streaming merge — the simplest schema (one row per
 * assistant line). Session id prefers the line's sessionId, falling back to a
 * `<project>-<filename>` composite to stay unique across projects. Timestamp is
 * the line's RFC3339 ts (or the file mtime). Provider is inferred from the model
 * (qwen* → "qwen"), defaulting to "qwen". Confidence is "host-reported".
 *
 * Fail-open: no root → []; unreadable/malformed file or line → skipped.
 */

import { basename, dirname } from "node:path";

import type { UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { fileMtimeMs, readJsonlLines } from "../jsonl.js";
import { inferProvider, normalizeWorkspaceKey, workspaceLabelFromKey } from "../normalize.js";
import { firstExistingRoot, walkFiles } from "../paths.js";

const PLATFORM_ID = "qwen-code" as const;
const DEFAULT_MODEL = "unknown";
const DEFAULT_PROVIDER = "qwen";

/** The fields we read off a Qwen JSONL line (everything optional / unknown). */
interface QwenLine {
  type?: unknown;
  model?: unknown;
  timestamp?: unknown;
  sessionId?: unknown;
  usageMetadata?: {
    promptTokenCount?: unknown;
    candidatesTokenCount?: unknown;
    thoughtsTokenCount?: unknown;
    cachedContentTokenCount?: unknown;
  };
}

/** Coerce an unknown to a non-negative integer (0 on absence/garbage). */
function toNonNegInt(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/** Parse an RFC3339 / numeric timestamp to epoch ms, or null when unusable. */
function parseTs(v: unknown): number | null {
  if (typeof v === "string") {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return ms;
    const num = Number(v);
    if (Number.isFinite(num) && num > 0) return num >= 1e12 ? num : num * 1000;
    return null;
  }
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return v >= 1e12 ? v : v * 1000;
  }
  return null;
}

/**
 * Session id with fallback (port of extract_session_id_with_fallback):
 *   1. the line's sessionId, when a non-empty string;
 *   2. otherwise `<project>-<filename>` derived from the path
 *      (.../projects/<project>/chats/<file>.jsonl), so identically-named files
 *      in different projects never collide.
 */
function sessionIdWithFallback(path: string, lineSessionId: unknown): string {
  if (typeof lineSessionId === "string" && lineSessionId !== "") return lineSessionId;
  const filename = stripExt(basename(path));
  const chatsDir = dirname(path); // .../chats
  const projectDir = dirname(chatsDir); // .../projects/<project>
  const project = basename(projectDir) || "unknown";
  return `${project}-${filename}`;
}

function stripExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Workspace (project) from a path (port of qwen_workspace_from_path): scan the
 * path components for a `[projects, <key>, chats, …]` window (last match wins)
 * and normalize `<key>`. Anchoring on the chats segment ignores stray "projects"
 * directory names elsewhere in the path.
 */
function workspaceFromPath(path: string): { projectKey?: string; projectLabel?: string } {
  const components = path.split(/[\\/]+/).filter((c) => c !== "");
  for (let i = components.length - 4; i >= 0; i--) {
    const a = components[i];
    const b = components[i + 1];
    const c = components[i + 2];
    if (a === "projects" && b !== undefined && b !== "" && c === "chats") {
      const key = normalizeWorkspaceKey(b);
      if (key === undefined) return {};
      const label = workspaceLabelFromKey(key);
      return label === undefined ? { projectKey: key } : { projectKey: key, projectLabel: label };
    }
  }
  return {};
}

/** Parse one Qwen JSONL file into usage records (port of parse_qwen_file). */
function parseQwenFile(path: string): UsageRecord[] {
  const lines = readJsonlLines(path);
  if (lines.length === 0) return [];

  const mtime = fileMtimeMs(path);
  const { projectKey, projectLabel } = workspaceFromPath(path);
  const out: UsageRecord[] = [];

  for (const raw of lines) {
    if (typeof raw !== "object" || raw === null) continue;
    const line = raw as QwenLine;

    // Only assistant lines with a usageMetadata block.
    if (line.type !== "assistant") continue;
    const usage = line.usageMetadata;
    if (usage === undefined || usage === null) continue;

    const promptTokens = toNonNegInt(usage.promptTokenCount);
    const output = toNonNegInt(usage.candidatesTokenCount);
    const reasoning = toNonNegInt(usage.thoughtsTokenCount);
    const cacheRead = toNonNegInt(usage.cachedContentTokenCount);
    // Net input: cumulative prompt minus the cached portion (clamped ≥ 0).
    const input = Math.max(0, promptTokens - cacheRead);

    // Skip zero-token entries (matches the Rust input+output+cacheRead+reasoning==0 check
    // — uses the raw prompt count so a fully-cached prompt is not dropped).
    if (promptTokens + output + cacheRead + reasoning === 0) continue;

    const ts = parseTs(line.timestamp) ?? mtime;

    const modelId = typeof line.model === "string" && line.model !== "" ? line.model : DEFAULT_MODEL;
    const providerId = inferProvider(modelId) ?? DEFAULT_PROVIDER;
    const sessionId = sessionIdWithFallback(path, line.sessionId);

    const tokens = emptyTokens();
    tokens.input = input;
    tokens.output = output;
    tokens.cacheRead = cacheRead;
    tokens.reasoning = reasoning;
    // cacheWrite stays 0 (Qwen does not report it).

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
    if (projectKey !== undefined) record.projectKey = projectKey;
    if (projectLabel !== undefined) record.projectLabel = projectLabel;
    out.push(record);
  }

  return out;
}

/** The Qwen CLI usage reader singleton. */
const qwenReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    const root = firstExistingRoot(PLATFORM_ID);
    if (root === undefined) return []; // no ~/.qwen/projects → fail-open

    // ~/.qwen/projects/<project>/chats/<file>.jsonl
    const files = walkFiles(root, (name, abs) => {
      return name.endsWith(".jsonl") && /[\\/]chats[\\/][^\\/]+\.jsonl$/.test(abs);
    });

    const records: UsageRecord[] = [];
    for (const file of files) {
      const rows = parseQwenFile(file);
      for (const row of rows) {
        if (sinceMs !== undefined && row.ts < sinceMs) continue;
        records.push(row);
      }
    }
    return records;
  },
};

export default qwenReader;
