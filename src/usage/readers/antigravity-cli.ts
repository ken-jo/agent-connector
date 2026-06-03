/**
 * usage/readers/antigravity-cli — Antigravity CLI (`agy`) native usage reader.
 *
 * The Antigravity CLI is a distinct binary from the desktop IDE with its own
 * global dir, `~/.gemini/antigravity-cli/` (honoring an
 * AGENT_CONNECTOR_ANTIGRAVITY_CLI_DIR override). It keeps per-conversation
 * transcripts as `transcript*.jsonl` under `brain/<conv>/`, plus a top-level
 * `history.jsonl` index of conversations.
 *
 * We read the transcripts directly (kind:"local", format:"jsonl") and extract the
 * Gemini-style `usage_metadata` per turn (promptTokenCount / candidatesTokenCount
 * / cachedContentTokenCount / thoughtsTokenCount) exactly like the gemini-cli and
 * Antigravity-IDE readers (shared antigravity-shared module). The conversation
 * also has `.pb` protobuf dumps — we SKIP all `.pb` (no public schema).
 *
 * `history.jsonl` is read best-effort to recover a per-conversation MODEL
 * fallback (and to attribute a friendlier session id) for transcripts whose rows
 * carry none; it never adds token rows itself.
 *
 * Confidence is MEDIUM (native JSONL shape; Antigravity is fast-moving + docs are
 * JS-rendered). Extraction is best-effort and FAILS OPEN: no
 * `~/.gemini/antigravity-cli/` → []; unreadable/malformed file or line → skipped;
 * `.pb` → skipped.
 */

import { basename, join } from "node:path";

import type { UsageReader, UsageRecord } from "../types.js";
import { fileMtimeMs, readJsonlLines } from "../jsonl.js";
import { antigravityCliNativeRoots, isDir, walkFiles } from "../paths.js";
import {
  nonEmptyStr,
  parseUsageMetadataRow,
  sessionMetaModel,
} from "./antigravity-shared.js";

const PLATFORM_ID = "antigravity-cli" as const;

// ─────────────────────────────────────────────────────────────────────────
// history.jsonl index (best-effort per-conversation model fallback)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Read `<root>/history.jsonl` and return a conversation-id → model map. The index
 * shape is not contractually stable, so this is fully tolerant: each line that
 * carries both an id and a model contributes; anything else is ignored.
 */
function readHistoryModelIndex(root: string): Map<string, string> {
  const index = new Map<string, string>();
  const historyPath = join(root, "history.jsonl");
  for (const raw of readJsonlLines(historyPath)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const obj = raw as Record<string, unknown>;
    const id =
      nonEmptyStr(obj.conversationId) ??
      nonEmptyStr(obj.conversation_id) ??
      nonEmptyStr(obj.id) ??
      nonEmptyStr(obj.sessionId) ??
      nonEmptyStr(obj.session_id);
    const model =
      nonEmptyStr(obj.modelId) ??
      nonEmptyStr(obj.model) ??
      nonEmptyStr(obj.model_id) ??
      nonEmptyStr(obj.modelName);
    if (id !== undefined && model !== undefined) index.set(id, model);
  }
  return index;
}

// ─────────────────────────────────────────────────────────────────────────
// Transcript parsing
// ─────────────────────────────────────────────────────────────────────────

/** The `brain/<conv>/` directory name for a transcript path (the conversation id). */
function conversationIdFromPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter((c) => c !== "");
  const brainIdx = parts.lastIndexOf("brain");
  if (brainIdx >= 0 && brainIdx + 1 < parts.length) {
    const conv = parts[brainIdx + 1];
    if (conv !== undefined && conv !== "") return conv;
  }
  const name = basename(path);
  const dot = name.indexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Parse one `transcript*.jsonl` into usage records. A `session_meta` row seeds
 * the per-conversation model fallback; the history index supplies a model when
 * the transcript carries none. Any row with a `usage_metadata` block emits a
 * record (best-effort).
 */
function parseTranscript(path: string, historyModel: string | undefined): UsageRecord[] {
  const lines = readJsonlLines(path);
  if (lines.length === 0) return [];

  const fallbackSessionId = conversationIdFromPath(path);
  const fallbackTs = fileMtimeMs(path);
  let fallbackModel = historyModel;

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

// ─────────────────────────────────────────────────────────────────────────
// Reader
// ─────────────────────────────────────────────────────────────────────────

/** The Antigravity CLI usage reader singleton (native brain transcripts). */
const antigravityCliReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    // First existing native global root (env override → canonical default).
    const root = antigravityCliNativeRoots().find((r) => isDir(r));
    if (root === undefined) return []; // no ~/.gemini/antigravity-cli → fail-open

    const brain = join(root, "brain");
    if (!isDir(brain)) return [];

    const historyIndex = readHistoryModelIndex(root);

    const files = walkFiles(brain, (name) => {
      if (!name.endsWith(".jsonl")) return false; // .pb / media → skip
      return name.startsWith("transcript");
    });

    const records: UsageRecord[] = [];
    for (const file of files) {
      const conv = conversationIdFromPath(file);
      let rows: UsageRecord[];
      try {
        rows = parseTranscript(file, historyIndex.get(conv));
      } catch {
        rows = []; // fail-open per file
      }
      for (const row of rows) {
        if (sinceMs !== undefined && row.ts < sinceMs) continue;
        records.push(row);
      }
    }
    return records;
  },
};

export default antigravityCliReader;
