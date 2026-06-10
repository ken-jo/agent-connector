/**
 * usage/readers/openclaw — OpenClaw (Gateway) native transcript reader.
 *
 * Faithful port of tokscale sessions/openclaw.rs (the transcript-direct path).
 * OpenClaw stores one JSONL transcript per session under an agent directory:
 *   ~/.openclaw/agents/**\/*.jsonl   (current)
 *   ~/.clawdbot/agents/**\/*.jsonl   (legacy: Clawd → Moltbot → OpenClaw rebrand)
 *   ~/.moltbot/agents/**\/*.jsonl    (legacy)
 *   ~/.moldbot/agents/**\/*.jsonl    (legacy)
 * The glob is `*.jsonl*` in tokscale (clients.rs OpenClaw.pattern), so archived
 * copies are also picked up: `name.jsonl`, `name.jsonl.deleted.<ts>`, and
 * `name.jsonl.reset.<ISO8601>`. The session id is the filename stem before the
 * first `.jsonl`, so all three forms map to the same session id.
 *
 * Each line is one entry with a `type`:
 *   - "model_change"  → snapshot of the current model/provider (entry.modelId /
 *                       entry.provider). STATEFUL: applies to later messages.
 *   - "custom" + customType=="model-snapshot" → same, from entry.data.{modelId,
 *                       provider}. STATEFUL.
 *   - "message"       → only `role:"assistant"` lines with a `usage` block count.
 *                       Tokens come straight from message.usage.{input, output,
 *                       cacheRead, cacheWrite}; cost from usage.cost.total.
 *                       Model/provider prefer the inline message.{model,provider}
 *                       (when non-empty), else fall back to the tracked current
 *                       model/provider state; provider defaults to "unknown".
 * reasoning is always 0 (OpenClaw does not report it).
 *
 * DEDUP — this is where double-counting hides. tokscale's PRODUCTION scan parses
 * ONLY the transcripts via parse_openclaw_transcript (one `*.jsonl*` file at a
 * time, each scan root visited once). The legacy `sessions.json` index parser
 * (parse_openclaw_index) is NOT wired into the live scan — it points at the SAME
 * `.jsonl` files the walk already visits, so parsing both would double-count.
 * We therefore mirror production: walk transcripts only, never the index. The
 * per-record dedupKey (`openclaw:<sessionId>:<entry.id|ordinal>`) collapses the
 * same transcript line if it is ever seen twice (e.g. a `.jsonl` plus its
 * `.deleted`/`.reset` archive of the same session), keeping totals honest while
 * never merging genuinely distinct messages.
 *
 * Project/workspace attribution: not exposed in the OpenClaw transcript format,
 * so projectKey/projectLabel are left unset (matching the Rust parser, which
 * never sets workspace on these rows).
 *
 * Confidence: "host-reported" (real token counts logged by the host).
 *
 * Fail-open: no agent root present → []; an unreadable/malformed file or line is
 * skipped (never thrown). Read-only — this reader only enumerates and reads.
 */

import { basename, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

import type { UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { fileMtimeMs, readJsonlLines } from "../jsonl.js";
import { expandHome, walkFiles } from "../paths.js";

const PLATFORM_ID = "openclaw" as const;
const DEFAULT_PROVIDER = "unknown";

/** One OpenClaw JSONL entry (every field optional / unknown). */
interface OpenClawEntry {
  type?: unknown;
  /** Stable per-entry id (e.g. "msg1") — used for the dedup key when present. */
  id?: unknown;
  message?: OpenClawMessage;
  /** "custom" entry discriminator (e.g. "model-snapshot"). */
  customType?: unknown;
  /** Payload for a "custom" model-snapshot entry. */
  data?: { provider?: unknown; modelId?: unknown };
  /** Set on a "model_change" entry. */
  modelId?: unknown;
  provider?: unknown;
}

/** The `message` object on a "message" entry. */
interface OpenClawMessage {
  role?: unknown;
  usage?: OpenClawUsage;
  timestamp?: unknown;
  provider?: unknown;
  model?: unknown;
}

/** The `message.usage` token/cost block. */
interface OpenClawUsage {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: { total?: unknown };
}

/** Coerce an unknown to a non-negative integer (0 on absence/garbage). */
function toNonNegInt(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/** Coerce an unknown to a finite non-negative number, else undefined. */
function toNonNegFloat(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, n);
}

/** A non-empty trimmed string, or undefined. */
function nonEmptyString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return v === "" ? undefined : v;
}

/**
 * Parse the OpenClaw `timestamp` (i64 milliseconds) to epoch ms, or null when
 * unusable. The Rust parser treats it as raw millis; we accept a numeric string
 * too and tolerate a seconds-scale value defensively.
 */
function parseTs(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n >= 1e12 ? n : n * 1000;
}

/**
 * Session id = the filename stem before the FIRST `.jsonl` (port of
 * parse_openclaw_transcript's `split_once(".jsonl")`). Handles archived suffixes:
 *   "abc.jsonl"                              → "abc"
 *   "abc.jsonl.deleted.1700000000000"        → "abc"
 *   "abc.jsonl.reset.2026-03-20T06-34-44.520Z" → "abc"
 * Returns null when there is no `.jsonl` segment or the stem is empty.
 */
function sessionIdFromFilename(path: string): string | null {
  const name = basename(path);
  const idx = name.indexOf(".jsonl");
  if (idx < 0) return null;
  const id = name.slice(0, idx);
  return id === "" ? null : id;
}

/**
 * Parse one OpenClaw transcript into usage records (port of
 * parse_openclaw_session). Tracks current model/provider statefully across the
 * file and emits one record per assistant message that carries a usage block.
 */
function parseOpenclawTranscript(path: string): UsageRecord[] {
  const sessionId = sessionIdFromFilename(path);
  if (sessionId === null) return [];

  const lines = readJsonlLines(path);
  if (lines.length === 0) return [];

  const mtime = fileMtimeMs(path);
  const out: UsageRecord[] = [];

  let currentModel: string | undefined;
  let currentProvider: string | undefined;
  let ordinal = 0; // fallback per-message identity when entry.id is absent

  for (const raw of lines) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as OpenClawEntry;
    const type = entry.type;

    if (type === "model_change") {
      const model = nonEmptyString(entry.modelId);
      if (model !== undefined) currentModel = model;
      const provider = nonEmptyString(entry.provider);
      if (provider !== undefined) currentProvider = provider;
      continue;
    }

    if (type === "custom") {
      if (entry.customType !== "model-snapshot") continue;
      const data = entry.data;
      if (data !== undefined && data !== null) {
        const model = nonEmptyString(data.modelId);
        if (model !== undefined) currentModel = model;
        const provider = nonEmptyString(data.provider);
        if (provider !== undefined) currentProvider = provider;
      }
      continue;
    }

    if (type !== "message") continue;

    const msg = entry.message;
    if (msg === undefined || msg === null) continue;
    if (msg.role !== "assistant") continue;

    const usage = msg.usage;
    if (usage === undefined || usage === null) continue;

    // Model: inline message.model (non-empty) → tracked current model.
    // No model anywhere → skip (port: `None => continue`).
    const model = nonEmptyString(msg.model) ?? currentModel;
    if (model === undefined) continue;

    // Provider: inline message.provider (non-empty) → tracked current provider →
    // "unknown" fallback (port of the unwrap_or("unknown")).
    const provider = nonEmptyString(msg.provider) ?? currentProvider ?? DEFAULT_PROVIDER;

    // The parser persists the resolved model/provider as the new state.
    currentModel = model;
    currentProvider = provider;

    const ts = parseTs(msg.timestamp) ?? mtime;

    const tokens = emptyTokens();
    tokens.input = toNonNegInt(usage.input);
    tokens.output = toNonNegInt(usage.output);
    tokens.cacheRead = toNonNegInt(usage.cacheRead);
    tokens.cacheWrite = toNonNegInt(usage.cacheWrite);
    // reasoning stays 0 (OpenClaw does not report it).

    ordinal += 1;
    const entryId = nonEmptyString(entry.id);
    const dedupKey = `openclaw:${sessionId}:${entryId ?? `#${ordinal}`}`;

    const record: UsageRecord = {
      platformId: PLATFORM_ID,
      modelId: model,
      providerId: provider,
      sessionId,
      tokens,
      ts,
      messageCount: 1,
      dedupKey,
      confidence: "host-reported",
    };

    // NOTE: provider is stored verbatim (host value or "unknown"); the Rust
    // parser never applies model-based provider inference here, so we do not
    // either — provider grouping happens at aggregation time in the infra.
    const cost = toNonNegFloat(usage.cost?.total);
    if (cost !== undefined && cost > 0) record.cost = cost;

    out.push(record);
  }

  return out;
}

/**
 * Candidate OpenClaw agent roots, most-preferred first. paths.ts has no
 * `openclaw` case (the framework's hostRoots table only covers the simpler
 * single-root platforms), so the agent dirs are resolved here directly, mirroring
 * tokscale scanner.rs: the current `~/.openclaw/agents` plus the legacy rebrand
 * dirs. An AGENTCONNECT_OPENCLAW_DIR override (non-empty) is honored first.
 */
function openclawRoots(): string[] {
  const out: string[] = [];
  const override = process.env.AGENTCONNECT_OPENCLAW_DIR;
  if (override != null && override.trim() !== "") {
    const expanded = expandHome(override.trim());
    out.push(isAbsolute(expanded) ? expanded : resolve(expanded));
  }
  const home = homedir();
  out.push(join(home, ".openclaw", "agents"));
  out.push(join(home, ".clawdbot", "agents"));
  out.push(join(home, ".moltbot", "agents"));
  out.push(join(home, ".moldbot", "agents"));
  return out;
}

/** The OpenClaw transcript usage reader singleton. */
const openclawReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    const records: UsageRecord[] = [];

    // Walk every agent root (current + legacy). walkFiles is fail-open: a
    // non-existent root yields []. If NO root exists, this stays empty → [].
    for (const root of openclawRoots()) {
      // Glob `*.jsonl*`: `.jsonl`, `.jsonl.deleted.<ts>`, `.jsonl.reset.<ISO>`.
      const files = walkFiles(root, (name) => name.includes(".jsonl"));
      for (const file of files) {
        const rows = parseOpenclawTranscript(file);
        for (const row of rows) {
          if (sinceMs !== undefined && row.ts < sinceMs) continue;
          records.push(row);
        }
      }
    }

    return records;
  },
};

export default openclawReader;
