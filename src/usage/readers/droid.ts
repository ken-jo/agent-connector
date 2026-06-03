/**
 * usage/readers/droid — Droid (Factory.ai) native session-settings reader.
 *
 * Faithful port of tokscale sessions/droid.rs. Reads
 * ~/.factory/sessions/*.settings.json. Each settings file is a single JSON
 * object carrying a cumulative `tokenUsage` block for one session:
 *   tokenUsage.inputTokens          → input
 *   tokenUsage.outputTokens         → output
 *   tokenUsage.cacheReadTokens      → cacheRead
 *   tokenUsage.cacheCreationTokens  → cacheWrite
 *   tokenUsage.thinkingTokens       → reasoning
 * A file with no tokenUsage, or whose five dimensions sum to 0, yields no row.
 *
 * Model id comes from the `model` field run through Droid's custom normalization
 * (strip a `custom:` prefix, remove [bracket] groups, trim trailing hyphens,
 * lowercase, dots→hyphens, collapse repeated hyphens — e.g.
 * "custom:Claude-Opus-4.5-Thinking-[Anthropic]-0" → "claude-opus-4-5-thinking-0").
 * When `model` is absent it falls back to scanning the sibling .jsonl
 * (<id>.settings.json → <id>.jsonl) for a `Model:` system-reminder pattern, and
 * finally to a provider-based default (anthropic→claude-unknown, openai→gpt-unknown,
 * google→gemini-unknown, xai→grok-unknown, else <provider>-unknown).
 *
 * Provider prefers the `providerLock` field; otherwise it is inferred from the
 * model (defaulting to "unknown", matching the Rust `unwrap_or("unknown")`).
 *
 * Session id is the filename stem with `.settings` stripped
 * (uuid.settings.json → uuid). Timestamp prefers `providerLockTimestamp`
 * (RFC3339 → epoch ms), falling back to the file mtime; a row with no usable
 * timestamp (0) is dropped — to match the Rust mtime-or-0 path, an unreadable
 * mtime is treated as 0 (not "now"), so we do not synthesize a timestamp here.
 *
 * No dedup (the session id is the primary key) and no project attribution
 * (Droid settings carry neither). Confidence is "host-reported".
 *
 * Fail-open: no root → []; unreadable/malformed file → skipped.
 */

import { statSync } from "node:fs";
import { basename } from "node:path";

import type { UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { readJsonFile, readJsonlLines } from "../jsonl.js";
import { inferProvider } from "../normalize.js";
import { firstExistingRoot, walkFiles } from "../paths.js";

const PLATFORM_ID = "droid" as const;
const DEFAULT_PROVIDER = "unknown";
/** Cap matching the Rust scan (avoids slurping a huge sibling .jsonl). */
const JSONL_MODEL_SCAN_LIMIT = 500;

/** The fields we read off a Droid settings.json file (all optional / unknown). */
interface DroidSettings {
  model?: unknown;
  providerLock?: unknown;
  providerLockTimestamp?: unknown;
  tokenUsage?: {
    inputTokens?: unknown;
    outputTokens?: unknown;
    cacheCreationTokens?: unknown;
    cacheReadTokens?: unknown;
    thinkingTokens?: unknown;
  };
}

/** Coerce an unknown to a non-negative integer (0 on absence/garbage). */
function toNonNegInt(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/**
 * Normalize a model name from Droid's custom format (port of
 * droid.rs normalize_model_name). Order is load-bearing:
 *   1. strip a leading `custom:` prefix;
 *   2. remove every `[...]` bracket group (vendor tags like "[Anthropic]");
 *   3. trim trailing hyphens (NOT trailing digits — those are kept);
 *   4. lowercase;
 *   5. replace dots with hyphens;
 *   6. collapse runs of hyphens into one.
 */
function normalizeModelName(model: string): string {
  let normalized = model.startsWith("custom:") ? model.slice("custom:".length) : model;

  // Remove [anything] groups (mirrors /\[.*?\]/g — bracket-depth-agnostic, just
  // drops chars while inside a bracket span).
  let stripped = "";
  let inBracket = false;
  for (const ch of normalized) {
    if (ch === "[") inBracket = true;
    else if (ch === "]") inBracket = false;
    else if (!inBracket) stripped += ch;
  }
  normalized = stripped;

  // Trim trailing hyphens only (mirrors /-+$/), keep trailing digits.
  normalized = normalized.replace(/-+$/, "");

  normalized = normalized.toLowerCase();
  normalized = normalized.replace(/\./g, "-");

  // Collapse consecutive hyphens (mirrors /-+/g → "-").
  normalized = normalized.replace(/-+/g, "-");

  return normalized;
}

/**
 * Canonicalize a provider segment (port of the subset of
 * provider_identity.rs canonicalize_provider_segment needed by
 * get_default_model_from_provider). Returns the input lowercased/`-`→`_` when no
 * canonical alias applies, so the default-model switch can match cleanly.
 */
function canonicalizeProviderSegment(segment: string): string | undefined {
  const normalized = segment.trim().replace(/\/+$/, "").toLowerCase().replace(/-/g, "_");
  if (normalized.startsWith("<") && normalized.endsWith(">")) return undefined;
  switch (normalized) {
    case "":
    case "unknown":
      return undefined;
    case "x_ai":
    case "xai":
      return "xai";
    case "z_ai":
    case "zai":
      return "zai";
    case "moonshot":
    case "moonshotai":
      return "moonshotai";
    case "meta":
    case "meta_llama":
      return "meta_llama";
    case "azure":
    case "azure_ai":
      return "azure_ai";
    case "anthropic":
    case "vertex":
    case "vertex_ai":
      return "anthropic";
    case "together":
    case "together_ai":
      return "together_ai";
    case "fireworks":
    case "fireworks_ai":
      return "fireworks_ai";
    case "google":
    case "gemini":
      return "google";
    case "openai":
    case "openai_codex":
      return "openai";
    case "minimax":
    case "minimaxai":
    case "minimax_ai":
      return "minimax";
    case "mistral":
    case "mistralai":
      return "mistralai";
    case "ai21":
      return "ai21";
    default:
      // Reject segments containing digits (model-name fragments, not providers).
      if (/[0-9]/.test(normalized)) return undefined;
      return normalized;
  }
}

/** Port of canonical_provider: first non-empty canonical tag, or the raw fallback. */
function canonicalProvider(raw: string): string {
  for (const segment of raw.trim().replace(/\/+$/, "").split("/")) {
    const tag = canonicalizeProviderSegment(segment);
    if (tag !== undefined) return tag;
    if (segment.includes(".")) {
      for (const dotted of segment.split(".")) {
        const dottedTag = canonicalizeProviderSegment(dotted);
        if (dottedTag !== undefined) return dottedTag;
      }
    }
  }
  return raw;
}

/**
 * Provider-based default model when no model id is available (port of
 * get_default_model_from_provider).
 */
function defaultModelFromProvider(provider: string): string {
  switch (canonicalProvider(provider)) {
    case "anthropic":
      return "claude-unknown";
    case "openai":
      return "gpt-unknown";
    case "google":
      return "gemini-unknown";
    case "xai":
      return "grok-unknown";
    default:
      return `${provider}-unknown`;
  }
}

/**
 * Try to extract a model name from the sibling .jsonl by scanning early lines
 * for a `Model:` system-reminder (port of extract_model_from_jsonl). The value
 * runs from after `Model:` up to the first `[`, `\`, or `"`, trimmed; the result
 * is run through normalizeModelName. Returns undefined when nothing matches.
 */
function extractModelFromJsonl(jsonlPath: string): string | undefined {
  // readJsonlLines is fail-open ([] on a missing/unreadable file); we scan the
  // raw text of each parsed line's stringification is not what Rust does — Rust
  // scans raw file lines, so we read the lines as-is via the tolerant reader and
  // search their original text. Since readJsonlLines parses JSON, re-serialize is
  // lossy; instead search the parsed objects' stringified form, which preserves
  // the embedded "Model:" text that lives inside string fields.
  const lines = readJsonlLines(jsonlPath);
  const scan = lines.slice(0, JSONL_MODEL_SCAN_LIMIT);
  for (const obj of scan) {
    const text = typeof obj === "string" ? obj : JSON.stringify(obj);
    const pos = text.indexOf("Model:");
    if (pos < 0) continue;
    const after = text.slice(pos + "Model:".length);
    let modelPart = "";
    for (const ch of after) {
      if (ch === "[" || ch === "\\" || ch === '"') break;
      modelPart += ch;
    }
    const trimmed = modelPart.trim();
    if (trimmed !== "") return normalizeModelName(trimmed);
  }
  return undefined;
}

/** File mtime in epoch ms, or 0 when unreadable (matches the Rust mtime-or-0 path). */
function fileMtimeOrZero(path: string): number {
  try {
    return Math.floor(statSync(path).mtimeMs);
  } catch {
    return 0;
  }
}

/** Session id from a settings filename: stem with a trailing `.settings` removed. */
function sessionIdFromPath(path: string): string {
  const name = basename(path);
  // Drop a final extension (the `.json`), then strip `.settings`.
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const id = stem.replace(/\.settings$/, "");
  return id === "" ? "unknown" : id;
}

/** Parse one Droid settings.json file into usage records (port of parse_droid_file). */
function parseDroidFile(path: string): UsageRecord[] {
  const raw = readJsonFile(path);
  if (typeof raw !== "object" || raw === null) return [];
  const settings = raw as DroidSettings;

  const usage = settings.tokenUsage;
  if (usage === undefined || usage === null || typeof usage !== "object") return [];

  const input = toNonNegInt(usage.inputTokens);
  const output = toNonNegInt(usage.outputTokens);
  const cacheWrite = toNonNegInt(usage.cacheCreationTokens);
  const cacheRead = toNonNegInt(usage.cacheReadTokens);
  const reasoning = toNonNegInt(usage.thinkingTokens);

  // Skip sessions with no usage at all.
  if (input + output + cacheWrite + cacheRead + reasoning === 0) return [];

  const sessionId = sessionIdFromPath(path);

  // Provider: providerLock if a non-empty string, else inferred from the model
  // (defaulting to "unknown" — matches the Rust unwrap_or("unknown")).
  const providerLock =
    typeof settings.providerLock === "string" && settings.providerLock !== ""
      ? settings.providerLock
      : undefined;
  const modelField = typeof settings.model === "string" ? settings.model : undefined;
  const providerId =
    providerLock ?? inferProvider(modelField ?? "") ?? DEFAULT_PROVIDER;

  // Model: normalize the model field, else scan the sibling .jsonl, else default.
  let modelId: string;
  if (modelField !== undefined) {
    modelId = normalizeModelName(modelField);
  } else {
    const jsonlPath = path.replace(/\.settings\.json$/, ".jsonl");
    modelId = jsonlPath !== path
      ? extractModelFromJsonl(jsonlPath) ?? defaultModelFromProvider(providerId)
      : defaultModelFromProvider(providerId);
  }

  // Timestamp: providerLockTimestamp (RFC3339 → ms) else file mtime; 0 → drop.
  let ts = 0;
  if (typeof settings.providerLockTimestamp === "string") {
    const parsed = Date.parse(settings.providerLockTimestamp);
    if (!Number.isNaN(parsed)) ts = parsed;
  }
  if (ts === 0) ts = fileMtimeOrZero(path);
  if (ts === 0) return [];

  const tokens = emptyTokens();
  tokens.input = input;
  tokens.output = output;
  tokens.cacheRead = cacheRead;
  tokens.cacheWrite = cacheWrite;
  tokens.reasoning = reasoning;

  return [
    {
      platformId: PLATFORM_ID,
      modelId,
      providerId,
      sessionId,
      tokens,
      ts,
      messageCount: 1,
      confidence: "host-reported",
    },
  ];
}

/** The Droid (Factory.ai) usage reader singleton. */
const droidReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    const root = firstExistingRoot(PLATFORM_ID);
    if (root === undefined) return []; // no ~/.factory/sessions → fail-open

    // ~/.factory/sessions/*.settings.json
    const files = walkFiles(root, (name) => name.endsWith(".settings.json"));

    const records: UsageRecord[] = [];
    for (const file of files) {
      const rows = parseDroidFile(file);
      for (const row of rows) {
        if (sinceMs !== undefined && row.ts < sinceMs) continue;
        records.push(row);
      }
    }
    return records;
  },
};

export default droidReader;
