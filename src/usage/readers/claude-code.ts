/**
 * usage/readers/claude-code — Claude Code native session-log reader.
 *
 * Faithful port of tokscale sessions/claudecode.rs. Reads
 * ~/.claude/projects/<key>/**.jsonl (one entry per line) plus the two subagent
 * layouts (nested projects/<key>/<session>/subagents/agent-*.jsonl and flat
 * projects/<key>/agent-*.jsonl) and headless .json transcripts.
 *
 * Token fields live under message.usage:
 *   input_tokens                 → input
 *   output_tokens                → output
 *   cache_read_input_tokens      → cacheRead
 *   cache_creation_input_tokens  → cacheWrite
 *   (reasoning is never reported  → always 0)
 *
 * CRITICAL DEDUP — Claude Code's streaming API rewrites the SAME logical message
 * (keyed by message.id : requestId) multiple times as the response streams in,
 * each write carrying CUMULATIVE token counts. Summing them over-counts 5–10x.
 * We therefore keep one record per dedup key and MERGE duplicates with a PER-FIELD
 * MAX (each token dimension independently keeps the highest value seen). The dedup
 * key is "<messageId>:<requestId>" when both exist, "message:<messageId>" when
 * only the id exists, and absent otherwise (such records always pass through).
 *
 * tool_result lines (type "user"/"tool_result") contribute extra INPUT tokens
 * (explicit token fields, else chars/4 estimate), deduped per tool_use_id under
 * "claude:tool_result:<session>:tool_result:<id>" (per-field max on input).
 *
 * Headless transcripts: .json files parse a single message_start/message_delta/
 * message_stop stream OR a flat usage object; same usage paths, per-field max.
 *
 * Session id = the file stem; for sidechain transcripts the parent sessionId on
 * the line is used instead (so subagent rows roll up under the parent session,
 * not an inflated synthetic one). Subagent name resolved via meta.json sidecar →
 * parent tool_use lookup → "claude-code-subagent" fallback. Project key/label
 * decoded from the dir-name-encoded cwd (.claude/projects/<key>/ window).
 *
 * Provider inferred from message.model (anthropic for claude-*), overridable by
 * an explicit providerId/provider hint on the message or entry, and by cc-mirror
 * variant metadata. Confidence is always "host-reported" (real token counts).
 *
 * Fail-open: no root → []; unreadable/malformed file or line → skipped.
 */

import { basename, dirname, sep } from "node:path";

import type { TokenBreakdown, UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { fileMtimeMs, readJsonFile, readJsonlLines } from "../jsonl.js";
import { inferProvider, normalizeWorkspaceKey, workspaceLabelFromKey } from "../normalize.js";
import { firstExistingRoot, isFile, walkFiles } from "../paths.js";

const PLATFORM_ID = "claude-code" as const;
const DEFAULT_MODEL = "unknown";
const DEFAULT_PROVIDER = "anthropic";
const SUBAGENT_FALLBACK = "claude-code-subagent";

/** Internal Claude Code user-content tags that are NOT genuine human turns. */
const INTERNAL_USER_TAGS = [
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<command-name>",
  "<command-message>",
  "<system-reminder>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
] as const;

// ─────────────────────────────────────────────────────────────────────────
// Coercion helpers
// ─────────────────────────────────────────────────────────────────────────

/** Coerce an unknown to a non-negative integer (0 on absence/garbage). */
function toNonNegInt(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/** Coerce an unknown to an integer or null (port of extract_i64: number/string only). */
function toIntOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

/** A non-empty string, or undefined. */
function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ─────────────────────────────────────────────────────────────────────────
// Provider / model resolution (port of claude_provider_choice + canonicalize)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Resolve the provider id from a raw model and an optional provider hint.
 * Mirrors claude_provider_choice/_from_parts:
 *   - an explicit hint that canonicalizes to a non-anthropic provider wins;
 *   - a hint of "anthropic" yields the model-inferred provider when that differs
 *     (e.g. an "anthropic" wrapper actually serving a non-claude model), else
 *     "anthropic";
 *   - with no hint, a "provider/model" prefix wins, then model inference, then
 *     "unknown" (we surface the platform default DEFAULT_PROVIDER instead of a
 *     bare "unknown" only when nothing at all is known and the model is absent).
 */
function resolveProvider(rawModel: string | undefined, hint: string | undefined): string {
  const canonicalHint = canonicalProvider(hint);
  if (canonicalHint !== undefined) {
    if (canonicalHint === "anthropic") {
      const inferred = rawModel !== undefined ? inferProvider(rawModel) : null;
      if (inferred !== null && inferred !== "anthropic") return inferred;
      return "anthropic";
    }
    return canonicalHint;
  }

  if (rawModel === undefined) return DEFAULT_PROVIDER;

  // provider_from_model_prefix: a "provider/model" form canonicalizes the prefix.
  if (rawModel.trim().includes("/")) {
    const prefixProvider = canonicalProvider(rawModel);
    if (prefixProvider !== undefined) return prefixProvider;
  }

  const inferred = inferProvider(rawModel);
  if (inferred !== null) return inferred;

  return DEFAULT_PROVIDER;
}

/**
 * Lightweight stand-in for provider_identity::canonical_provider. The fixed infra
 * exposes inferProvider (model→provider family); for an explicit provider hint we
 * canonicalize a "vendor/model" or bare-vendor token via the same family table,
 * with the documented cc-mirror "mirror"→anthropic special case folded in by the
 * caller. Returns undefined for an empty/unrecognized hint.
 */
function canonicalProvider(hint: string | undefined): string | undefined {
  if (hint === undefined) return undefined;
  const trimmed = hint.trim();
  if (trimmed === "") return undefined;
  // A "vendor/model" hint: infer from the whole string (covers "openrouter/anthropic").
  const inferred = inferProvider(trimmed);
  if (inferred !== null) return inferred;
  // Bare vendor token: take the segment before any '/' as the provider id.
  const head = trimmed.split("/")[0];
  if (head !== undefined && head !== "") return head.toLowerCase();
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Workspace (project) from path (port of claude_workspace_from_path)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Decode the project key/label from a path. Scans for a `[.claude, projects, key]`
 * window, then a cc-mirror `[.cc-mirror, *, config, projects, key]` window, then a
 * trailing `[projects, key]` window (last match). The key is the dir-name-encoded
 * cwd (e.g. "-Users-me-work"); we keep it verbatim as the stable key, exactly as
 * the Rust normalize_workspace_key/workspace_label_from_key do.
 */
function workspaceFromPath(path: string): { projectKey?: string; projectLabel?: string } {
  const components = path.split(/[\\/]+/).filter((c) => c !== "");

  for (let i = 0; i + 2 < components.length; i++) {
    if (components[i] === ".claude" && components[i + 1] === "projects") {
      return keyAndLabel(components[i + 2]);
    }
  }

  for (let i = 0; i + 4 < components.length; i++) {
    if (
      components[i] === ".cc-mirror" &&
      components[i + 2] === "config" &&
      components[i + 3] === "projects"
    ) {
      return keyAndLabel(components[i + 4]);
    }
  }

  for (let i = components.length - 2; i >= 0; i--) {
    if (components[i] === "projects") {
      return keyAndLabel(components[i + 1]);
    }
  }

  return {};
}

function keyAndLabel(raw: string | undefined): { projectKey?: string; projectLabel?: string } {
  if (raw === undefined) return {};
  const key = normalizeWorkspaceKey(raw);
  if (key === undefined) return {};
  const label = workspaceLabelFromKey(key);
  return label === undefined ? { projectKey: key } : { projectKey: key, projectLabel: label };
}

// ─────────────────────────────────────────────────────────────────────────
// Subagent name resolution (port of resolve_subagent_name)
// ─────────────────────────────────────────────────────────────────────────

/** A small per-scan cache of parent-session agentId→subagent_type lookups. */
type ParentSubagentCache = Map<string, Map<string, string>>;

function stripExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Resolve the subagent display name for a sidechain transcript.
 * Tier 1: sibling `<stem>.meta.json` agentType.
 * Tier 2: scan the parent session JSONL for the spawning tool_use's subagent_type.
 * Tier 3: "claude-code-subagent".
 */
function resolveSubagentName(
  path: string,
  parentSessionId: string | undefined,
  entryAgentId: string | undefined,
  cache: ParentSubagentCache,
): string {
  const stem = stripExt(basename(path));
  if (stem === "") return SUBAGENT_FALLBACK;

  // Tier 1: sibling meta.json
  const metaPath = `${dirname(path)}${sep}${stem}.meta.json`;
  const meta = readJsonFile(metaPath);
  if (isObject(meta)) {
    const agentType = asNonEmptyString(meta["agentType"]);
    if (agentType !== undefined && agentType.trim() !== "") return agentType;
  }

  // Tier 2: parent session tool_use inference
  const lookupAgentId =
    entryAgentId !== undefined && entryAgentId.trim() !== ""
      ? entryAgentId
      : agentIdFromStem(stem);
  if (parentSessionId !== undefined && lookupAgentId !== undefined) {
    const parentPath = findParentSessionPath(path, parentSessionId);
    if (parentPath !== undefined) {
      const subagentType = lookupSubagentTypeInParent(parentPath, lookupAgentId, cache);
      if (subagentType !== undefined) return subagentType;
    }
  }

  // Tier 3
  return SUBAGENT_FALLBACK;
}

/** Derive an agentId from an "agent-<id>" stem (port of sidechain_agent_id_from_stem). */
function agentIdFromStem(stem: string): string | undefined {
  if (!stem.startsWith("agent-")) return undefined;
  const agentStem = stem.slice("agent-".length);
  if (!agentStem.includes("-")) return agentStem;
  const trailing = agentStem.slice(agentStem.lastIndexOf("-") + 1);
  if (trailing !== "" && /^[0-9a-fA-F]+$/.test(trailing)) return trailing;
  return agentStem;
}

/** Locate the parent main-session JSONL for a sidechain transcript. */
function findParentSessionPath(sidechainPath: string, parentSessionId: string): string | undefined {
  const parentFilename = `${parentSessionId}.jsonl`;
  const dir = dirname(sidechainPath);

  // Nested layout: file → subagents → session-dir → project-dir
  if (basename(dir) === "subagents") {
    const projectDir = dirname(dirname(dir));
    const candidate = `${projectDir}${sep}${parentFilename}`;
    if (isFile(candidate)) return candidate;
  }

  // Flat layout: parent dir is one level up
  const flat = `${dir}${sep}${parentFilename}`;
  if (isFile(flat)) return flat;

  return undefined;
}

/** Cached agentId→subagent_type lookup for a parent session. */
function lookupSubagentTypeInParent(
  parentPath: string,
  targetAgentId: string,
  cache: ParentSubagentCache,
): string | undefined {
  let lookup = cache.get(parentPath);
  if (lookup === undefined) {
    lookup = buildParentSubagentLookup(parentPath);
    cache.set(parentPath, lookup);
  }
  return lookup.get(targetAgentId);
}

/**
 * Scan a parent session JSONL to recover subagent_type per agentId. Joins
 * tool_use.id→subagent_type with tool_result.tool_use_id→agentId (from result text).
 * Port of build_parent_subagent_type_lookup.
 */
function buildParentSubagentLookup(parentPath: string): Map<string, string> {
  const out = new Map<string, string>();
  const toolUseTypes = new Map<string, string>(); // tool_use.id → subagent_type
  const agentIdLinks = new Map<string, string>(); // tool_use_id → agentId

  for (const raw of readJsonlLines(parentPath)) {
    if (!isObject(raw)) continue;
    const message = raw["message"];
    if (!isObject(message)) continue;
    const content = message["content"];
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!isObject(block)) continue;
      const blockType = block["type"];
      if (blockType === "tool_use") {
        const id = asNonEmptyString(block["id"]);
        const input = block["input"];
        const subagentType = isObject(input) ? asNonEmptyString(input["subagent_type"]) : undefined;
        if (id !== undefined && subagentType !== undefined) {
          toolUseTypes.set(id, subagentType);
        }
      } else if (blockType === "tool_result") {
        const toolUseId = asNonEmptyString(block["tool_use_id"]);
        if (toolUseId === undefined) continue;
        const resultContent = block["content"];
        if (!Array.isArray(resultContent)) continue;
        for (const cb of resultContent) {
          if (!isObject(cb)) continue;
          const text = cb["text"];
          if (typeof text === "string") {
            const aid = extractAgentIdFromText(text);
            if (aid !== undefined) {
              agentIdLinks.set(toolUseId, aid);
              break;
            }
          }
        }
      }
    }
  }

  for (const [toolUseId, agentId] of agentIdLinks) {
    const subagentType = toolUseTypes.get(toolUseId);
    if (subagentType !== undefined) out.set(agentId, subagentType);
  }
  return out;
}

/** Extract `agentId: <alphanumeric>` from a tool_result text block. */
function extractAgentIdFromText(text: string): string | undefined {
  const marker = "agentId: ";
  const pos = text.indexOf(marker);
  if (pos < 0) return undefined;
  const rest = text.slice(pos + marker.length);
  let end = 0;
  while (end < rest.length && /[0-9a-zA-Z]/.test(rest[end] as string)) end++;
  return end > 0 ? rest.slice(0, end) : undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// tool_result input-token extraction (port of extract_claude_tool_result_usage)
// ─────────────────────────────────────────────────────────────────────────

interface ToolResultUsage {
  inputTokens: number;
  /** "tool_result:<id>" when an id was present, else undefined. */
  dedupId?: string;
}

/** Sum input tokens across all tool_result blocks in a line, deduping by id. */
function extractToolResultUsage(value: Record<string, unknown>): ToolResultUsage | undefined {
  let total = 0;
  let firstDedupId: string | undefined;
  const seen = new Set<string>();

  for (const toolResult of collectToolResultValues(value)) {
    const id = extractToolResultId(toolResult);
    if (id !== undefined) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    if (firstDedupId === undefined && id !== undefined) firstDedupId = `tool_result:${id}`;
    total += extractToolResultInputTokens(toolResult);
  }

  if (total <= 0) return undefined;
  return firstDedupId === undefined
    ? { inputTokens: total }
    : { inputTokens: total, dedupId: firstDedupId };
}

/** Gather every tool_result Value reachable from a line (port of claude_tool_result_values). */
function collectToolResultValues(value: Record<string, unknown>): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];

  if (value["type"] === "tool_result") results.push(value);

  const directTr = value["tool_result"];
  if (isObject(directTr)) results.push(directTr);

  const message = value["message"];
  if (isObject(message)) {
    const msgTr = message["tool_result"];
    if (isObject(msgTr)) results.push(msgTr);
  }

  const content = isObject(message) ? message["content"] : value["content"];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (isObject(block) && block["type"] === "tool_result") results.push(block);
    }
  }

  return results;
}

function extractToolResultId(tr: Record<string, unknown>): string | undefined {
  return (
    asNonEmptyString(tr["tool_use_id"]) ??
    asNonEmptyString(tr["id"]) ??
    asNonEmptyString(tr["tool_result_id"])
  );
}

/** Explicit input-token count for a tool_result, else a chars/4 estimate. */
function extractToolResultInputTokens(tr: Record<string, unknown>): number {
  const explicit = explicitToolResultInputTokens(tr);
  if (explicit !== undefined) return explicit;
  const chars = toolResultOutputCharCount(tr);
  return chars > 0 ? Math.ceil(chars / 4) : 0;
}

function explicitToolResultInputTokens(tr: Record<string, unknown>): number | undefined {
  const toolOutput = isObject(tr["tool_output"]) ? (tr["tool_output"] as Record<string, unknown>) : undefined;
  const usage = isObject(tr["usage"]) ? (tr["usage"] as Record<string, unknown>) : undefined;
  const toolOutputUsage =
    toolOutput !== undefined && isObject(toolOutput["usage"])
      ? (toolOutput["usage"] as Record<string, unknown>)
      : undefined;

  const candidates: unknown[] = [
    tr["input_tokens"],
    tr["token_count"],
    tr["tokens"],
    usage?.["input_tokens"],
    toolOutput?.["input_tokens"],
    toolOutput?.["token_count"],
    toolOutput?.["tokens"],
    toolOutputUsage?.["input_tokens"],
  ];
  for (const c of candidates) {
    const n = toIntOrNull(c);
    if (n !== null) return Math.max(0, n);
  }
  return undefined;
}

/** Count chars across a tool_result's output/content text (port of tool_result_output_char_count). */
function toolResultOutputCharCount(tr: Record<string, unknown>): number {
  let chars = 0;

  const toolOutput = tr["tool_output"];
  if (isObject(toolOutput)) {
    const output = toolOutput["output"];
    if (typeof output === "string") chars += [...output].length;
  }

  const content = tr["content"];
  if (typeof content === "string") {
    chars += [...content].length;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!isObject(block)) continue;
      const blockToolOutput = block["tool_output"];
      const blockOutput = isObject(blockToolOutput) ? blockToolOutput["output"] : undefined;
      const text =
        typeof blockOutput === "string"
          ? blockOutput
          : typeof block["text"] === "string"
            ? (block["text"] as string)
            : undefined;
      if (text !== undefined) chars += [...text].length;
    }
  }

  return chars;
}

// ─────────────────────────────────────────────────────────────────────────
// is_human_turn (kept for parity; does not affect token counts)
// ─────────────────────────────────────────────────────────────────────────

/** True when a `type:"user"` line is genuine human input (not tool/system). */
function isHumanTurn(rawLine: string): boolean {
  const pos = rawLine.indexOf('"content":');
  if (pos < 0) return false;
  const after = rawLine.slice(pos + '"content":'.length).trimStart();
  if (after.startsWith("[")) return false;
  if (after.startsWith('"')) {
    const contentStart = after.slice(1);
    for (const tag of INTERNAL_USER_TAGS) {
      if (contentStart.startsWith(tag)) return false;
    }
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Accumulator (one entry per dedup key, per-field MAX merge)
// ─────────────────────────────────────────────────────────────────────────

interface Accum {
  record: UsageRecord;
  /** Provider confidence rank (0..3) so a stronger hint from a later duplicate wins. */
  providerConfidence: number;
}

const PC_DEFAULT = 1; // hint canonicalized to anthropic
const PC_INFERRED = 2; // model-inferred / stored non-anthropic
const PC_EXPLICIT = 3; // explicit "vendor/model" hint or prefix

/** Provider confidence for a freshly resolved choice (port of the confidence ranks). */
function providerConfidence(rawModel: string | undefined, hint: string | undefined): number {
  const canonicalHint = canonicalProvider(hint);
  if (canonicalHint !== undefined) {
    if (canonicalHint === "anthropic") {
      const inferred = rawModel !== undefined ? inferProvider(rawModel) : null;
      if (inferred !== null && inferred !== "anthropic") return PC_INFERRED;
      return PC_DEFAULT;
    }
    return PC_EXPLICIT;
  }
  if (rawModel !== undefined) {
    if (rawModel.trim().includes("/") && canonicalProvider(rawModel) !== undefined) return PC_EXPLICIT;
    if (inferProvider(rawModel) !== null) return PC_INFERRED;
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────
// JSONL file parse
// ─────────────────────────────────────────────────────────────────────────

interface ClaudeUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}

/**
 * Parse a Claude Code session file (.jsonl, or headless .json) into usage records.
 * Each record carries a dedupKey; streaming duplicates are pre-merged here so the
 * dedupKey is unique per logical message (the aggregate-level dedup is then a
 * cross-source backstop, not the primary defense against streaming over-count).
 */
function parseClaudeFile(path: string, parentCache: ParentSubagentCache): UsageRecord[] {
  const fallbackTs = fileMtimeMs(path);
  const { projectKey, projectLabel } = workspaceFromPath(path);

  // Headless .json: try the whole-file JSON shape first.
  if (path.endsWith(".json")) {
    const headless = parseHeadlessJson(path, fallbackTs, projectKey, projectLabel);
    if (headless.length > 0) return headless;
  }

  const lines = readJsonlLines(path);
  if (lines.length === 0) return [];

  // session id defaults to the file stem.
  let sessionId = stripExt(basename(path)) || "unknown";

  // Per-key accumulators, in insertion order.
  const byKey = new Map<string, Accum>();
  const ordered: Accum[] = [];

  let lastModel: string | undefined;
  let lastProviderHint: string | undefined;
  let sidechainAgent: string | undefined;
  let sidechainDetected = false;

  // Headless streaming state (for message_start/_delta/_stop lines inside a .jsonl).
  const headlessState = newHeadlessState();
  const headlessOut: UsageRecord[] = [];

  for (let li = 0; li < lines.length; li++) {
    const value = lines[li];
    if (!isObject(value)) continue;
    const rawLine = JSON.stringify(value); // for the is_human_turn / nothing-critical path

    const entryType = value["type"];
    const message = isObject(value["message"]) ? (value["message"] as Record<string, unknown>) : undefined;
    const entryProviderHint =
      asNonEmptyString(value["providerId"]) ??
      asNonEmptyString(value["provider_id"]) ??
      asNonEmptyString(value["provider"]);

    // Detect sidechain on the first parseable entry.
    if (!sidechainDetected) {
      sidechainDetected = true;
      if (value["isSidechain"] === true) {
        const parentId = asNonEmptyString(value["sessionId"]);
        if (parentId !== undefined) sessionId = parentId;
        sidechainAgent = resolveSubagentName(
          path,
          asNonEmptyString(value["sessionId"]),
          asNonEmptyString(value["agentId"]),
          parentCache,
        );
      }
    }

    // ── user / tool_result lines ──────────────────────────────────────────
    if (entryType === "user" || entryType === "tool_result") {
      const tr = extractToolResultUsage(value);
      if (tr !== undefined) {
        const rawModel =
          extractModel(value) ??
          (message !== undefined ? asNonEmptyString(message["model"]) : undefined) ??
          lastModel;
        const providerHint =
          extractProviderHint(value) ??
          (message !== undefined ? messageProviderHint(message) : undefined) ??
          entryProviderHint ??
          lastProviderHint;
        const ts =
          parseTs(value["timestamp"]) ?? extractClaudeTimestamp(value) ?? fallbackTs;

        const dedupKey =
          tr.dedupId !== undefined
            ? `claude:tool_result:${sessionId}:${tr.dedupId}`
            : undefined;

        if (dedupKey !== undefined) {
          const existing = byKey.get(dedupKey);
          if (existing !== undefined) {
            existing.record.tokens.input = Math.max(existing.record.tokens.input, tr.inputTokens);
            if (ts >= existing.record.ts) existing.record.ts = ts;
            continue;
          }
        }

        const tokens = emptyTokens();
        tokens.input = tr.inputTokens;
        const record = buildRecord({
          rawModel,
          providerHint,
          sessionId,
          ts,
          tokens,
          messageCount: 0,
          dedupKey,
          projectKey,
          projectLabel,
          agent: sidechainAgent,
        });
        const accum: Accum = { record, providerConfidence: providerConfidence(rawModel, providerHint) };
        if (dedupKey !== undefined) byKey.set(dedupKey, accum);
        ordered.push(accum);
      }
      continue;
    }

    // ── assistant lines (the token-bearing path) ─────────────────────────
    if (entryType === "assistant") {
      if (message === undefined) continue;

      const msgModel = asNonEmptyString(message["model"]);
      if (msgModel !== undefined) {
        lastModel = msgModel;
        lastProviderHint = messageProviderHint(message) ?? entryProviderHint;
      }

      const usage = message["usage"];
      if (!isObject(usage)) continue;
      const u = usage as ClaudeUsage;

      const msgId = asNonEmptyString(message["id"]);
      const reqId = asNonEmptyString(value["requestId"]);
      const providerHint = messageProviderHint(message) ?? entryProviderHint;

      // Dedup key: messageId:requestId, else message:messageId, else none.
      let dedupKey: string | undefined;
      if (msgId !== undefined && reqId !== undefined) dedupKey = `${msgId}:${reqId}`;
      else if (msgId !== undefined) dedupKey = `message:${msgId}`;

      const ts = parseTs(value["timestamp"]) ?? fallbackTs;

      // Merge into an existing duplicate via PER-FIELD MAX.
      if (dedupKey !== undefined) {
        const existing = byKey.get(dedupKey);
        if (existing !== undefined) {
          mergeUsageMax(existing.record.tokens, u);
          if (ts >= existing.record.ts) existing.record.ts = ts;
          // A later duplicate may carry a stronger provider hint; promote it.
          const cand = providerConfidence(msgModel, providerHint);
          if (cand > existing.providerConfidence) {
            existing.providerConfidence = cand;
            existing.record.providerId = resolveProvider(msgModel, providerHint);
          }
          continue;
        }
      }

      // First occurrence: model is required to keep the record (matches Rust:
      // a model:None assistant entry is skipped without polluting the dedup map).
      if (msgModel === undefined) continue;

      const tokens = emptyTokens();
      tokens.input = toNonNegInt(u.input_tokens);
      tokens.output = toNonNegInt(u.output_tokens);
      tokens.cacheRead = toNonNegInt(u.cache_read_input_tokens);
      tokens.cacheWrite = toNonNegInt(u.cache_creation_input_tokens);

      const record = buildRecord({
        rawModel: msgModel,
        providerHint,
        sessionId,
        ts,
        tokens,
        messageCount: 1,
        dedupKey,
        projectKey,
        projectLabel,
        agent: sidechainAgent,
      });
      const accum: Accum = { record, providerConfidence: providerConfidence(msgModel, providerHint) };
      if (dedupKey !== undefined) byKey.set(dedupKey, accum);
      ordered.push(accum);
      continue;
    }

    // ── headless streaming lines inside a .jsonl (message_start/_delta/_stop) ─
    const completed = processHeadlessLine(value, rawLine, sessionId, headlessState, fallbackTs);
    if (completed !== undefined) {
      if (projectKey !== undefined) completed.projectKey = projectKey;
      if (projectLabel !== undefined) completed.projectLabel = projectLabel;
      headlessOut.push(completed);
    }
  }

  const finalHeadless = finalizeHeadlessState(headlessState, sessionId, fallbackTs);
  if (finalHeadless !== undefined) {
    if (projectKey !== undefined) finalHeadless.projectKey = projectKey;
    if (projectLabel !== undefined) finalHeadless.projectLabel = projectLabel;
    headlessOut.push(finalHeadless);
  }

  return [...ordered.map((a) => a.record), ...headlessOut];
}

/** Per-field MAX merge of a usage block into an existing token breakdown. */
function mergeUsageMax(tokens: TokenBreakdown, u: ClaudeUsage): void {
  tokens.input = Math.max(tokens.input, toNonNegInt(u.input_tokens));
  tokens.output = Math.max(tokens.output, toNonNegInt(u.output_tokens));
  tokens.cacheRead = Math.max(tokens.cacheRead, toNonNegInt(u.cache_read_input_tokens));
  tokens.cacheWrite = Math.max(tokens.cacheWrite, toNonNegInt(u.cache_creation_input_tokens));
}

interface BuildRecordArgs {
  rawModel: string | undefined;
  providerHint: string | undefined;
  sessionId: string;
  ts: number;
  tokens: TokenBreakdown;
  messageCount: number;
  dedupKey: string | undefined;
  projectKey: string | undefined;
  projectLabel: string | undefined;
  agent: string | undefined;
}

function buildRecord(a: BuildRecordArgs): UsageRecord {
  const modelId = a.rawModel !== undefined && a.rawModel !== "" ? a.rawModel : DEFAULT_MODEL;
  const record: UsageRecord = {
    platformId: PLATFORM_ID,
    modelId,
    providerId: resolveProvider(a.rawModel, a.providerHint),
    sessionId: a.sessionId,
    tokens: a.tokens,
    ts: a.ts,
    messageCount: a.messageCount,
    confidence: "host-reported",
  };
  if (a.dedupKey !== undefined) record.dedupKey = a.dedupKey;
  if (a.projectKey !== undefined) record.projectKey = a.projectKey;
  if (a.projectLabel !== undefined) record.projectLabel = a.projectLabel;
  if (a.agent !== undefined) record.agent = a.agent;
  return record;
}

// ─────────────────────────────────────────────────────────────────────────
// Model / provider / timestamp extraction off a generic value
// ─────────────────────────────────────────────────────────────────────────

function extractModel(value: Record<string, unknown>): string | undefined {
  const top = asNonEmptyString(value["model"]);
  if (top !== undefined) return top;
  const message = value["message"];
  return isObject(message) ? asNonEmptyString(message["model"]) : undefined;
}

function messageProviderHint(message: Record<string, unknown>): string | undefined {
  return (
    asNonEmptyString(message["providerId"]) ??
    asNonEmptyString(message["provider_id"]) ??
    asNonEmptyString(message["provider"])
  );
}

function extractProviderHint(value: Record<string, unknown>): string | undefined {
  const top =
    asNonEmptyString(value["providerId"]) ??
    asNonEmptyString(value["provider_id"]) ??
    asNonEmptyString(value["provider"]);
  if (top !== undefined) return top;
  const message = value["message"];
  return isObject(message) ? messageProviderHint(message) : undefined;
}

function extractClaudeTimestamp(value: Record<string, unknown>): number | null {
  const direct = parseTs(value["timestamp"]) ?? parseTs(value["created_at"]);
  if (direct !== null) return direct;
  const message = value["message"];
  if (isObject(message)) {
    const m = parseTs(message["created_at"]);
    if (m !== null) return m;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Headless JSON / streaming-line support (port of *_headless_*)
// ─────────────────────────────────────────────────────────────────────────

interface HeadlessState {
  model?: string;
  providerHint?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  ts: number | null;
}

function newHeadlessState(): HeadlessState {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ts: null };
}

function resetHeadlessState(s: HeadlessState): void {
  s.model = undefined;
  s.providerHint = undefined;
  s.input = 0;
  s.output = 0;
  s.cacheRead = 0;
  s.cacheWrite = 0;
  s.ts = null;
}

/** Whole-file headless JSON parse (a single usage object). */
function parseHeadlessJson(
  path: string,
  fallbackTs: number,
  projectKey: string | undefined,
  projectLabel: string | undefined,
): UsageRecord[] {
  const value = readJsonFile(path);
  if (!isObject(value)) return [];
  const record = extractHeadlessMessage(value, "unknown-session", fallbackTs);
  if (record === undefined) return [];
  // session id is the file stem (matches Rust passing session_id from the stem).
  record.sessionId = stripExt(basename(path)) || "unknown";
  if (projectKey !== undefined) record.projectKey = projectKey;
  if (projectLabel !== undefined) record.projectLabel = projectLabel;
  return [record];
}

/** Process one streaming line; returns a completed record on message_start/_stop. */
function processHeadlessLine(
  value: Record<string, unknown>,
  _rawLine: string,
  sessionId: string,
  state: HeadlessState,
  fallbackTs: number,
): UsageRecord | undefined {
  const eventType = typeof value["type"] === "string" ? (value["type"] as string) : "";

  switch (eventType) {
    case "message_start": {
      const completed = finalizeHeadlessState(state, sessionId, fallbackTs);
      state.model = extractModel(value);
      state.providerHint = extractProviderHint(value);
      const ts = extractClaudeTimestamp(value);
      if (ts !== null) state.ts = ts;
      const message = value["message"];
      const usage =
        (isObject(message) && isObject(message["usage"]) ? (message["usage"] as Record<string, unknown>) : undefined) ??
        (isObject(value["usage"]) ? (value["usage"] as Record<string, unknown>) : undefined);
      if (usage !== undefined) updateHeadlessUsage(state, usage);
      return completed;
    }
    case "message_delta": {
      const delta = value["delta"];
      const usage =
        (isObject(value["usage"]) ? (value["usage"] as Record<string, unknown>) : undefined) ??
        (isObject(delta) && isObject(delta["usage"]) ? (delta["usage"] as Record<string, unknown>) : undefined);
      if (usage !== undefined) updateHeadlessUsage(state, usage);
      return undefined;
    }
    case "message_stop":
      return finalizeHeadlessState(state, sessionId, fallbackTs);
    default:
      return extractHeadlessMessage(value, sessionId, fallbackTs);
  }
}

function updateHeadlessUsage(state: HeadlessState, usage: Record<string, unknown>): void {
  const input = toIntOrNull(usage["input_tokens"]);
  if (input !== null) state.input = Math.max(state.input, input);
  const output = toIntOrNull(usage["output_tokens"]);
  if (output !== null) state.output = Math.max(state.output, output);
  const cacheRead = toIntOrNull(usage["cache_read_input_tokens"]);
  if (cacheRead !== null) state.cacheRead = Math.max(state.cacheRead, cacheRead);
  const cacheWrite = toIntOrNull(usage["cache_creation_input_tokens"]);
  if (cacheWrite !== null) state.cacheWrite = Math.max(state.cacheWrite, cacheWrite);
}

/** Emit a record from accumulated streaming state, then reset (port of finalize_headless_state). */
function finalizeHeadlessState(
  state: HeadlessState,
  sessionId: string,
  fallbackTs: number,
): UsageRecord | undefined {
  const rawModel = state.model;
  if (rawModel === undefined) return undefined;
  if (state.input === 0 && state.output === 0 && state.cacheRead === 0 && state.cacheWrite === 0) {
    resetHeadlessState(state);
    return undefined;
  }
  const tokens = emptyTokens();
  tokens.input = Math.max(0, state.input);
  tokens.output = Math.max(0, state.output);
  tokens.cacheRead = Math.max(0, state.cacheRead);
  tokens.cacheWrite = Math.max(0, state.cacheWrite);

  const record = buildRecord({
    rawModel,
    providerHint: state.providerHint,
    sessionId,
    ts: state.ts ?? fallbackTs,
    tokens,
    messageCount: 1,
    dedupKey: undefined,
    projectKey: undefined,
    projectLabel: undefined,
    agent: undefined,
  });
  resetHeadlessState(state);
  return record;
}

/** Extract a flat usage-bearing message (port of extract_claude_headless_message). */
function extractHeadlessMessage(
  value: Record<string, unknown>,
  sessionId: string,
  fallbackTs: number,
): UsageRecord | undefined {
  const message = value["message"];
  const usage =
    (isObject(value["usage"]) ? (value["usage"] as Record<string, unknown>) : undefined) ??
    (isObject(message) && isObject(message["usage"]) ? (message["usage"] as Record<string, unknown>) : undefined);
  if (usage === undefined) return undefined;
  const rawModel = extractModel(value);
  if (rawModel === undefined) return undefined;
  const providerHint = extractProviderHint(value);
  const ts = extractClaudeTimestamp(value) ?? fallbackTs;

  const tokens = emptyTokens();
  tokens.input = Math.max(0, toIntOrNull(usage["input_tokens"]) ?? 0);
  tokens.output = Math.max(0, toIntOrNull(usage["output_tokens"]) ?? 0);
  tokens.cacheRead = Math.max(0, toIntOrNull(usage["cache_read_input_tokens"]) ?? 0);
  tokens.cacheWrite = Math.max(0, toIntOrNull(usage["cache_creation_input_tokens"]) ?? 0);

  return buildRecord({
    rawModel,
    providerHint,
    sessionId,
    ts,
    tokens,
    messageCount: 1,
    dedupKey: undefined,
    projectKey: undefined,
    projectLabel: undefined,
    agent: undefined,
  });
}

// Touch the parity-only helper so a strict no-unused-locals build stays clean
// without changing behavior: isHumanTurn mirrors the Rust turn-detection used
// for is_turn_start, which the usage record does not carry.
void isHumanTurn;

// ─────────────────────────────────────────────────────────────────────────
// Reader
// ─────────────────────────────────────────────────────────────────────────

/** The Claude Code usage reader singleton. */
const claudeCodeReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "local",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    const root = firstExistingRoot(PLATFORM_ID);
    if (root === undefined) return []; // no ~/.claude/projects → fail-open

    // ~/.claude/projects/<key>/**.jsonl  (+ subagents/agent-*.jsonl)  +  .json headless
    const files = walkFiles(root, (name) => {
      if (name.endsWith(".meta.json")) return false; // sidecar, not a transcript
      return name.endsWith(".jsonl") || name.endsWith(".json");
    });

    const parentCache: ParentSubagentCache = new Map();
    const records: UsageRecord[] = [];
    for (const file of files) {
      let rows: UsageRecord[];
      try {
        rows = parseClaudeFile(file, parentCache);
      } catch {
        continue; // fail-open per file
      }
      for (const row of rows) {
        if (sinceMs !== undefined && row.ts < sinceMs) continue;
        records.push(row);
      }
    }
    return records;
  },
};

export default claudeCodeReader;
