/**
 * usage/readers/codebuff — Codebuff (formerly Manicode) native session reader.
 *
 * Faithful port of tokscale sessions/codebuff.rs. Codebuff persists chat history
 * under ~/.config/manicode/projects/<project>/chats/<chatId>/chat-messages.json,
 * with parallel "dev" and "staging" channels under manicode-dev / manicode-staging.
 * Each file is a JSON array of ChatMessage objects; only assistant messages
 * (variant/role ∈ {ai, agent, assistant}) carry token usage, which can live in
 * THREE places (tried in order, each merged as a fallback for missing fields):
 *
 *   1. metadata.usage
 *   2. metadata.codebuff.usage
 *   3. the stashed RunState message history —
 *      metadata.runState.sessionState.mainAgentState.messageHistory[].providerOptions
 *      (.usage / .codebuff.usage / .codebuff.model), where OpenRouter-routed calls
 *      land their final token counts. We scan that history newest-first and merge
 *      each assistant entry as a fallback.
 *
 * Token fields accept BOTH camelCase and snake_case (matching the @ccusage/codebuff
 * valibot schema): input ← inputTokens|input_tokens|promptTokens|prompt_tokens;
 * output ← outputTokens|output_tokens|completionTokens|completion_tokens;
 * cacheRead ← cacheReadInputTokens|cache_read_input_tokens|cachedTokensCreated|
 *   cached_tokens_created, or promptTokensDetails.cachedTokens|prompt_tokens_details.cached_tokens;
 * cacheWrite ← cacheCreationInputTokens|cache_creation_input_tokens|
 *   cacheCreationTokens|cache_creation_tokens. reasoning is always 0. A `credits`
 * field (on the usage object or the message) becomes cost. A message with no
 * token signal at all (and no credits) is skipped.
 *
 * Attribution comes from the path: sessionId = "<channel>/<project>/<chatId>"
 * (e.g. "manicode/sandbox/2025-12-14T10-00-00.000Z"); projectKey/projectLabel
 * derive from the <project> ancestor. Timestamp resolution: message.timestamp |
 * message.createdAt | metadata.timestamp, else the chatId parsed back to ms
 * (the filesystem-safe ISO form 2025-12-14T10-00-00.000Z has its two TIME
 * separators restored to ':' WITHOUT touching the date '-'), else file mtime.
 *
 * Dedup: the upstream ChatMessage.id when present (stable across re-imports), else
 * a deterministic composite codebuff:<session>:<ts>:<model>:<ordinal>:<i>:<o>:<cr>:<cw>.
 * Provider is inferred from the model (default "codebuff-unknown" → "unknown").
 * Confidence is "host-reported" (real host token counts).
 *
 * Fail-open: no root → []; unreadable/malformed file → skipped (never throws).
 * Read-only.
 */

import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

import type { TokenBreakdown, UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { fileMtimeMs, readJsonFile } from "../jsonl.js";
import { inferProvider, workspaceFromPath } from "../normalize.js";
import { expandHome, walkFiles } from "../paths.js";

const PLATFORM_ID = "codebuff" as const;
const DEFAULT_MODEL = "codebuff-unknown";
const DEFAULT_PROVIDER = "unknown";

/** The three Codebuff release channels, each its own ~/.config/<channel> root. */
const CHANNELS = ["manicode", "manicode-dev", "manicode-staging"] as const;

// ─────────────────────────────────────────────────────────────────────────
// Root resolution
//
// codebuff is not in paths.ts hostRoots(), so we resolve its channel roots
// here, mirroring the paths.ts convention exactly: an explicit non-empty
// AGENTCONNECT_CODEBUFF_DIR override wins (treated as the projects dir),
// otherwise the OS config dir per channel. Read-only; never created.
// ─────────────────────────────────────────────────────────────────────────

/** $XDG_CONFIG_HOME (when set & non-empty) else ~/.config — matches paths.ts. */
function xdgConfigHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.trim() !== "") return resolve(expandHome(xdg.trim()));
  return join(homedir(), ".config");
}

/**
 * Env override, treating empty/blank as unset (paths.ts envOverride contract):
 * relative paths resolve against CWD; "~" expands. Returns undefined when unset.
 */
function envOverride(name: string): string | undefined {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return undefined;
  const expanded = expandHome(raw.trim());
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/**
 * Candidate `projects` roots, most-preferred first. The override (when present)
 * is the projects dir for the default channel; otherwise one root per channel
 * under the config home. Readers walk each existing root.
 */
function codebuffProjectRoots(): string[] {
  const out: string[] = [];
  const override = envOverride("AGENTCONNECT_CODEBUFF_DIR");
  if (override !== undefined) out.push(override);
  const config = xdgConfigHome();
  for (const channel of CHANNELS) {
    out.push(join(config, channel, "projects"));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Raw value helpers (everything off a parsed JSON value is unknown)
// ─────────────────────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Coerce to a finite number (i64/u64/f64 in Rust), or null. */
function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return null;
}

/**
 * pick_number: first key whose value coerces to a positive integer wins (>0,
 * truncated). Mirrors the Rust as_i64/as_u64/as_f64 chain with its `n > 0` gate.
 */
function pickNumber(obj: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const num = asNumber(obj[key]);
    if (num !== null) {
      const n = Math.trunc(num);
      if (n > 0) return n;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Timestamp parsing (port of utils.rs parse_timestamp_str / parse_timestamp_value)
// ─────────────────────────────────────────────────────────────────────────

/** RFC3339 / numeric-string → epoch ms; null when unusable (port of parse_timestamp_str). */
function parseTimestampStr(value: string): number | null {
  const ms = Date.parse(value);
  if (!Number.isNaN(ms)) return ms;
  // Pure-integer string fallback (Rust value.parse::<i64>()).
  if (/^-?\d+$/.test(value)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return numeric >= 1_000_000_000_000 ? numeric : numeric * 1000;
  }
  return null;
}

/** JSON value (string or positive number) → epoch ms (port of parse_timestamp_value). */
function parseTimestampValue(value: unknown): number | null {
  if (typeof value === "string") return parseTimestampStr(value);
  const numeric = asNumber(value);
  if (numeric === null) return null;
  const n = Math.trunc(numeric);
  if (n <= 0) return null;
  return n >= 1_000_000_000_000 ? n : n * 1000;
}

/**
 * Convert a filesystem-safe chatId back to epoch ms. Codebuff's chatId is the
 * chat's ISO-8601 timestamp with the two TIME separators (HH-MM-SS) flipped to
 * '-' for filesystem safety (e.g. 2025-12-14T10-00-00.000Z). Restore ONLY the
 * first two '-' AFTER the 'T' back to ':'; a naive global replace would corrupt
 * the date to 2025:12:14T... and break parsing. Trailing '-' (ms/timezone) stay.
 */
function parseChatIdToMillis(chatId: string): number | null {
  const tIndex = chatId.indexOf("T");
  if (tIndex < 0) return null;
  const date = chatId.slice(0, tIndex);
  const timeWithSeparator = chatId.slice(tIndex); // starts with 'T'
  const rebuilt = date + replaceFirst(timeWithSeparator, "-", ":", 2);
  return parseTimestampStr(rebuilt);
}

/** Replace the first `count` occurrences of `from` with `to` (Rust replacen). */
function replaceFirst(s: string, from: string, to: string, count: number): string {
  let result = s;
  let done = 0;
  let idx = result.indexOf(from);
  while (idx >= 0 && done < count) {
    result = result.slice(0, idx) + to + result.slice(idx + from.length);
    done++;
    idx = result.indexOf(from, idx + to.length);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// Path → (channel, project, chatId) and session id
// ─────────────────────────────────────────────────────────────────────────

/**
 * Walk up a chat-messages.json path → (channel, project, chatId). Layout:
 * <channel>/projects/<project>/chats/<chatId>/chat-messages.json. Missing
 * ancestors fall back to deterministic defaults (lossy, never throws).
 */
function deriveContextFromPath(path: string): { channel: string; project: string; chatId: string } {
  const chatDir = dirname(path); // .../chats/<chatId>
  const chatId = basename(chatDir) || "unknown";

  const chatsDir = dirname(chatDir); // .../<project>/chats
  const projectDir = dirname(chatsDir); // .../<project>
  const project = basename(projectDir) || "unknown";

  const projectsDir = dirname(projectDir); // .../projects
  const channelDir = dirname(projectsDir); // .../<channel>
  const channel = basename(channelDir) || "manicode";

  return { channel, project, chatId };
}

// ─────────────────────────────────────────────────────────────────────────
// Assistant role + timestamp
// ─────────────────────────────────────────────────────────────────────────

function isAssistantRole(msg: Record<string, unknown>): boolean {
  const variant = asString(msg.variant) ?? asString(msg.role) ?? "";
  return variant === "ai" || variant === "agent" || variant === "assistant";
}

/** message.timestamp | message.createdAt | metadata.timestamp → ms, else null. */
function messageTimestamp(msg: Record<string, unknown>): number | null {
  for (const key of ["timestamp", "createdAt"] as const) {
    if (key in msg) {
      const ts = parseTimestampValue(msg[key]);
      if (ts !== null) return ts;
    }
  }
  const meta = asRecord(msg.metadata);
  if (meta !== undefined && "timestamp" in meta) {
    return parseTimestampValue(meta.timestamp);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Usage extraction (port of AssistantUsage + extract_assistant_usage)
// ─────────────────────────────────────────────────────────────────────────

interface AssistantUsage {
  model?: string;
  credits: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function newUsage(): AssistantUsage {
  return { credits: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function hasSignal(u: AssistantUsage): boolean {
  return u.input > 0 || u.output > 0 || u.cacheRead > 0 || u.cacheWrite > 0 || u.credits > 0;
}

/** Fill any unset (<=0 / undefined) field of `self` from `other` (merge_fallback). */
function mergeFallback(self: AssistantUsage, other: AssistantUsage): void {
  if (self.input <= 0) self.input = other.input;
  if (self.output <= 0) self.output = other.output;
  if (self.cacheRead <= 0) self.cacheRead = other.cacheRead;
  if (self.cacheWrite <= 0) self.cacheWrite = other.cacheWrite;
  if (self.model === undefined) self.model = other.model;
  if (self.credits <= 0) self.credits = other.credits;
}

/** Parse a usage object, accepting camelCase and snake_case (parse_usage_object). */
function parseUsageObject(value: unknown): AssistantUsage {
  const usage = newUsage();
  const obj = asRecord(value);
  if (obj === undefined) return usage;

  const input = pickNumber(obj, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]);
  const output = pickNumber(obj, [
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens",
  ]);
  let cacheRead = pickNumber(obj, [
    "cacheReadInputTokens",
    "cache_read_input_tokens",
    "cachedTokensCreated",
    "cached_tokens_created",
  ]);
  if (cacheRead === null) {
    const details = asRecord(obj.promptTokensDetails) ?? asRecord(obj.prompt_tokens_details);
    if (details !== undefined) {
      const cached = asNumber(details.cachedTokens ?? details.cached_tokens);
      if (cached !== null) cacheRead = Math.trunc(cached);
    }
  }
  const cacheWrite = pickNumber(obj, [
    "cacheCreationInputTokens",
    "cache_creation_input_tokens",
    "cacheCreationTokens",
    "cache_creation_tokens",
  ]);

  usage.input = input ?? 0;
  usage.output = output ?? 0;
  usage.cacheRead = cacheRead ?? 0;
  usage.cacheWrite = cacheWrite ?? 0;

  const credits = asNumber(obj.credits);
  if (credits !== null) usage.credits = credits;
  const model = asString(obj.model);
  if (model !== undefined) usage.model = model;

  return usage;
}

/**
 * Last assistant entry in metadata.runState.sessionState.mainAgentState.
 * messageHistory, pulling providerOptions.usage / providerOptions.codebuff.usage
 * (+ .codebuff.model). Scans newest-first, merging each as a fallback. Returns
 * undefined when no usable entry is found (port of extract_usage_from_run_state).
 */
function extractUsageFromRunState(metadata: Record<string, unknown>): AssistantUsage | undefined {
  const history = asRecord(asRecord(asRecord(asRecord(metadata.runState)?.sessionState)?.mainAgentState));
  const rawHistory = history?.messageHistory;
  if (!Array.isArray(rawHistory)) return undefined;

  const accumulator = newUsage();
  let foundAny = false;
  for (let i = rawHistory.length - 1; i >= 0; i--) {
    const entry = asRecord(rawHistory[i]);
    if (entry === undefined) continue;
    if (asString(entry.role) !== "assistant") continue;
    const providerOptions = asRecord(entry.providerOptions);
    if (providerOptions === undefined) continue;

    const entryUsage = newUsage();
    if ("usage" in providerOptions) {
      mergeFallback(entryUsage, parseUsageObject(providerOptions.usage));
    }
    const codebuff = asRecord(providerOptions.codebuff);
    if (codebuff !== undefined && "usage" in codebuff) {
      mergeFallback(entryUsage, parseUsageObject(codebuff.usage));
    }
    const cbModel = codebuff !== undefined ? asString(codebuff.model) : undefined;
    if (cbModel !== undefined) entryUsage.model = cbModel;

    if (hasSignal(entryUsage) || entryUsage.model !== undefined) foundAny = true;
    mergeFallback(accumulator, entryUsage);
  }
  return foundAny ? accumulator : undefined;
}

/**
 * Extract assistant usage, trying in order metadata.usage, metadata.codebuff.usage,
 * then the RunState message history; each is merged as a fallback. A top-level
 * `credits` fills cost when the usage objects carry none (extract_assistant_usage).
 */
function extractAssistantUsage(msg: Record<string, unknown>): AssistantUsage {
  const usage = newUsage();
  const metadata = asRecord(msg.metadata);

  if (metadata !== undefined) {
    const model = asString(metadata.model);
    if (model !== undefined) usage.model = model;
    if ("usage" in metadata) {
      mergeFallback(usage, parseUsageObject(metadata.usage));
    }
    const codebuff = asRecord(metadata.codebuff);
    if (codebuff !== undefined && "usage" in codebuff) {
      mergeFallback(usage, parseUsageObject(codebuff.usage));
    }
    const runStateUsage = extractUsageFromRunState(metadata);
    if (runStateUsage !== undefined) mergeFallback(usage, runStateUsage);
  }

  const credits = asNumber(msg.credits);
  if (credits !== null && credits > 0 && usage.credits <= 0) usage.credits = credits;

  return usage;
}

// ─────────────────────────────────────────────────────────────────────────
// Dedup
// ─────────────────────────────────────────────────────────────────────────

/** Upstream ChatMessage.id when a non-empty string (stable across re-imports). */
function upstreamMessageId(msg: Record<string, unknown>): string | undefined {
  const id = asString(msg.id);
  return id !== undefined && id !== "" ? id : undefined;
}

/** Deterministic fallback dedup key (derive_dedup_key). */
function deriveDedupKey(
  sessionId: string,
  ts: number,
  model: string,
  usage: AssistantUsage,
  ordinal: number,
): string {
  const i = Math.max(0, usage.input);
  const o = Math.max(0, usage.output);
  const cr = Math.max(0, usage.cacheRead);
  const cw = Math.max(0, usage.cacheWrite);
  return `codebuff:${sessionId}:${ts}:${model}:${ordinal}:${i}:${o}:${cr}:${cw}`;
}

// ─────────────────────────────────────────────────────────────────────────
// File parse
// ─────────────────────────────────────────────────────────────────────────

/** Parse one chat-messages.json into usage records (port of parse_codebuff_file). */
function parseCodebuffFile(path: string): UsageRecord[] {
  const root = readJsonFile(path);
  if (!Array.isArray(root)) return []; // missing / malformed / non-array → no rows

  const { channel, project, chatId } = deriveContextFromPath(path);
  const sessionId = `${channel}/${project}/${chatId}`;
  const { projectKey, projectLabel } = workspaceFromPath(project);

  const chatIdTs = parseChatIdToMillis(chatId); // null when unparseable
  const mtime = fileMtimeMs(path);

  const out: UsageRecord[] = [];
  for (let ordinal = 0; ordinal < root.length; ordinal++) {
    const msg = asRecord(root[ordinal]);
    if (msg === undefined) continue;
    if (!isAssistantRole(msg)) continue;

    const usage = extractAssistantUsage(msg);
    if (!hasSignal(usage)) continue;

    const ts = messageTimestamp(msg) ?? (chatIdTs !== null && chatIdTs > 0 ? chatIdTs : mtime);
    const modelId = usage.model ?? DEFAULT_MODEL;
    const providerId = inferProvider(modelId) ?? DEFAULT_PROVIDER;
    const dedupKey =
      upstreamMessageId(msg) ?? deriveDedupKey(sessionId, ts, modelId, usage, ordinal);

    const tokens: TokenBreakdown = emptyTokens();
    tokens.input = Math.max(0, usage.input);
    tokens.output = Math.max(0, usage.output);
    tokens.cacheRead = Math.max(0, usage.cacheRead);
    tokens.cacheWrite = Math.max(0, usage.cacheWrite);
    // reasoning stays 0 (Codebuff does not report it).

    const record: UsageRecord = {
      platformId: PLATFORM_ID,
      modelId,
      providerId,
      sessionId,
      tokens,
      ts,
      messageCount: 1,
      dedupKey,
      confidence: "host-reported",
    };
    const cost = Math.max(0, usage.credits);
    if (cost > 0) record.cost = cost;
    if (projectKey !== undefined) record.projectKey = projectKey;
    if (projectLabel !== undefined) record.projectLabel = projectLabel;
    out.push(record);
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Reader
// ─────────────────────────────────────────────────────────────────────────

/** The Codebuff (Manicode) usage reader singleton. */
const codebuffReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    const records: UsageRecord[] = [];

    // Scan each channel's projects root that exists.
    // <root>/<project>/chats/<chatId>/chat-messages.json
    for (const root of codebuffProjectRoots()) {
      const files = walkFiles(root, (name, abs) => {
        return (
          name === "chat-messages.json" &&
          /[\\/]chats[\\/][^\\/]+[\\/]chat-messages\.json$/.test(abs)
        );
      });
      for (const file of files) {
        for (const row of parseCodebuffFile(file)) {
          if (sinceMs !== undefined && row.ts < sinceMs) continue;
          records.push(row);
        }
      }
    }

    return records;
  },
};

export default codebuffReader;
