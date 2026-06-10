/**
 * runtime/usage-event — the OPT-IN host-native turn-usage enricher (enricher 4a).
 *
 * Gemini CLI / Antigravity fire an `AfterModel` (Antigravity CLI: `PostInvocation`)
 * hook AFTER each model turn, whose stdin payload carries a `usageMetadata` block
 * with the host's OWN exact token accounting for that whole conversation turn:
 *   { promptTokenCount, candidatesTokenCount, cachedContentTokenCount,
 *     thoughtsTokenCount, totalTokenCount }
 * This is the single point in the whole matrix where a host reports REAL per-turn
 * usage to a command we control — so we record it as `confidenceSource:"host-native"`
 * (the top of CONFIDENCE_RANK), upgrading those rows from the serve-proxy estimate.
 *
 * DISTINCT, NEVER-SUMMED ORIGIN. Host-native turn usage is WHOLE-CONVERSATION, not
 * per-MCP. To avoid double-counting against (a) the per-MCP serve-proxy `call`
 * rows and (b) the usage-reader host-scan numbers, every record written here uses
 * the DISTINCT scope `"model_turn"`. The MCP leaderboard excludes that scope (just
 * as it special-cases `tool_defs`); the unified leaderboard surfaces it as its own
 * clearly-labeled section that is explicitly never added to the other two origins.
 *
 * PRIVACY + FAIL-OPEN. This enricher is OPT-IN at install time (see the adapters);
 * it stores AGGREGATE COUNTS ONLY (no raw content — the payload's prompt/response
 * text is never read). ANY parse / store / IO error degrades to exit 0 and records
 * NOTHING: a host-native usage hook must never break a model turn. This function
 * never throws.
 */

import { projectIdentity } from "../core/paths.js";
import { newRecordId, openStore } from "../telemetry/store.js";
import type { PlatformId } from "../core/types.js";
import type { ToolEventRecord } from "../telemetry/types.js";

/** Flags + stdin the CLI hands to {@link runUsageEvent}. */
export interface RunUsageEventOptions {
  /** Host platform id from the command (`usage-event <platformId> …`). */
  platformId: string;
  /** Connector id from `--connector <id>` (stamped on the record). */
  connectorId: string;
  /** Raw stdin payload (host-native JSON). Empty string is tolerated → no record. */
  stdin: string;
}

/** Process-level result the CLI translates into an exit code. */
export interface RunUsageEventResult {
  /** Always 0 — a host-native usage hook must never block a model turn. */
  exitCode: number;
  /** True when a `model_turn` record was appended (false on any fail-open path). */
  recorded: boolean;
}

/** The never-records, never-throws result. */
const NOOP: RunUsageEventResult = { exitCode: 0, recorded: false };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Coerce a value to a non-negative safe integer (NaN/negatives/floats → 0). */
function toNonNegInt(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/** First non-empty string among the given keys of an object. */
function firstStr(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

/** Read a token field tolerant of both camelCase and snake_case spellings. */
function tokenField(
  meta: Record<string, unknown>,
  keys: readonly string[],
): number {
  for (const k of keys) {
    if (k in meta) return toNonNegInt(meta[k]);
  }
  return 0;
}

/** Locate the `usageMetadata` block under either spelling, top-level or nested. */
function findUsageMetadata(root: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const k of ["usageMetadata", "usage_metadata"]) {
    if (isObject(root[k])) return root[k] as Record<string, unknown>;
  }
  // Some hosts nest the model response (with its usage) under a `response` /
  // `modelResponse` envelope — probe one level down, best-effort.
  for (const k of ["response", "modelResponse", "model_response"]) {
    const nested = root[k];
    if (isObject(nested)) {
      for (const mk of ["usageMetadata", "usage_metadata"]) {
        if (isObject(nested[mk])) return nested[mk] as Record<string, unknown>;
      }
    }
  }
  return undefined;
}

/** A registered PlatformId, or "unknown" when the id is not one we know. */
const KNOWN_PLATFORMS: ReadonlySet<string> = new Set<PlatformId>([
  "claude-code", "codex", "cursor", "vscode-copilot", "jetbrains-copilot",
  "copilot-cli", "gemini-cli", "opencode", "kilo", "kilo-cli", "warp", "hermes",
  "openclaw", "zed", "antigravity", "antigravity-cli", "kiro", "qwen-code",
  "kimi", "pi", "omp", "droid", "roo-code", "trae", "amp", "codebuff", "mux",
  "crush", "goose", "synthetic", "unknown",
]);

function asPlatformId(id: string): PlatformId {
  return (KNOWN_PLATFORMS.has(id) ? id : "unknown") as PlatformId;
}

/**
 * Record one host-native model turn. Parses the host's `usageMetadata`, maps it to
 * a DISTINCT `model_turn` `ToolEventRecord` (confidence `host-native`, toolName
 * `"*"`), and appends it to the shared telemetry store. NEVER throws and never
 * blocks the turn: every failure path resolves to {@link NOOP} (exit 0, nothing
 * recorded).
 */
export async function runUsageEvent(
  opts: RunUsageEventOptions,
): Promise<RunUsageEventResult> {
  try {
    // Global telemetry kill switch is honored by the store's append (no-op when
    // AGENT_CONNECTOR_TELEMETRY=0); we still parse cheaply and let append drop it.
    const trimmed = opts.stdin.trim();
    if (trimmed === "") return NOOP;

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return NOOP; // malformed payload → fail-open, record nothing
    }
    if (!isObject(raw)) return NOOP;

    const meta = findUsageMetadata(raw);
    if (meta === undefined) return NOOP;

    const promptTokens = tokenField(meta, ["promptTokenCount", "prompt_token_count"]);
    const candidates = tokenField(meta, ["candidatesTokenCount", "candidates_token_count"]);
    const cached = tokenField(meta, ["cachedContentTokenCount", "cached_content_token_count"]);
    const thoughts = tokenField(meta, ["thoughtsTokenCount", "thoughts_token_count"]);

    // promptTokenCount is cache-INCLUSIVE (Gemini-family semantics, mirrored by
    // the antigravity-shared usage reader): net fresh input = prompt - cached.
    const inputTokens = Math.max(0, promptTokens - Math.min(cached, promptTokens));
    // Output = generated candidates + reasoning ("thoughts") tokens.
    const outputTokens = candidates + thoughts;

    // A turn with no measurable tokens is not worth a row.
    if (inputTokens === 0 && outputTokens === 0) return NOOP;

    // Identity: prefer payload session/cwd; fall back to process.cwd() for the
    // project key so a turn always lands in a stable project partition.
    const sessionId =
      firstStr(raw, ["session_id", "sessionId", "conversationId", "conversation_id"]) ?? "";
    const cwd = firstStr(raw, ["cwd", "workspace", "projectDir", "project_dir"]) ?? process.cwd();
    const id = projectIdentity(cwd);

    const record: ToolEventRecord = {
      id: newRecordId(0),
      ts: Date.now(),
      connectorId: opts.connectorId,
      toolName: "*",
      scope: "model_turn",
      hostPlatform: asPlatformId(opts.platformId),
      sessionId,
      projectKey: id.key,
      projectDir: id.dir,
      inputTokens,
      outputTokens,
      confidenceSource: "host-native",
      isError: false,
    };

    const store = openStore({});
    try {
      store.append(record);
    } finally {
      try {
        store.close();
      } catch {
        /* best-effort flush */
      }
    }
    return { exitCode: 0, recorded: true };
  } catch {
    // Fail-open: a host-native usage enricher must never surface an error.
    return NOOP;
  }
}

export default runUsageEvent;
