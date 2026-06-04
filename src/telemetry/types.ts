/**
 * telemetry/types — runtime telemetry contracts.
 *
 * The framework measures the MCP server's OWN bytes (tool args in, tool result
 * out, tool-definition schemas) and tokenizes them locally — the only signal
 * identical across every host (no host reports per-tool usage to a server).
 * Records are aggregate counts only; raw arguments/results are NEVER stored.
 */

import type { PlatformId } from "../core/types.js";

/** Provenance of a token count — surfaced so "estimate" is never read as "exact". */
export type ConfidenceSource =
  | "tokenizer-exact" // real BPE for a matching model family
  | "tokenizer-calibrated" // approx adjusted by a sampled Anthropic count_tokens factor
  | "tokenizer-approx" // real BPE used as a documented approximation (e.g. Anthropic)
  | "heuristic" // chars/4 fallback
  | "host-native"; // a host actually reported usage (e.g. Gemini AfterModel)

/**
 * Confidence ranking, least-trustworthy (0) → most-trustworthy. The single
 * source of truth for ordering {@link ConfidenceSource} values; every
 * worst-of comparison across the telemetry subsystem (store rollup, both
 * leaderboards, report, measure) reads through {@link rankOf} /
 * {@link worstConfidence} so a new value orders correctly everywhere.
 *
 *   heuristic < tokenizer-approx < tokenizer-calibrated < tokenizer-exact < host-native
 *
 * `tokenizer-calibrated` sits between the raw approximation and an exact
 * family-matched BPE count: it is an approximation nudged toward truth by a
 * sampled real count_tokens factor, so it is more trustworthy than bare approx
 * but still not the exact encoding for the target family.
 */
export const CONFIDENCE_RANK: Record<ConfidenceSource, number> = {
  heuristic: 0,
  "tokenizer-approx": 1,
  "tokenizer-calibrated": 2,
  "tokenizer-exact": 3,
  "host-native": 4,
};

/** Trust rank of a single {@link ConfidenceSource} (higher = more trustworthy). */
export function rankOf(c: ConfidenceSource): number {
  return CONFIDENCE_RANK[c];
}

/** Return whichever source is the worse (least-confident) of the two. */
export function worstConfidence(
  a: ConfidenceSource,
  b: ConfidenceSource,
): ConfidenceSource {
  return CONFIDENCE_RANK[b] < CONFIDENCE_RANK[a] ? b : a;
}

export type ModelFamily = "openai" | "anthropic" | "generic";

export interface TokenCount {
  tokens: number;
  source: ConfidenceSource;
}

/** Pluggable tokenizer. Default impl uses gpt-tokenizer; fallback is chars/4. */
export interface Tokenizer {
  /** Count tokens for a string under the given model family. */
  count(text: string, family: ModelFamily): TokenCount;
  /** Count tokens for an arbitrary JSON value (serialized canonically first). */
  countValue(value: unknown, family: ModelFamily): TokenCount;
}

/**
 * What a record measures. DISTINCT origins that must never be summed:
 *   • `call`       — one per-MCP `tools/call` round-trip (serve-proxy bytes).
 *   • `tool_defs`  — the one-time `tools/list` schema overhead (serve-proxy).
 *   • `model_turn` — a WHOLE-CONVERSATION host-native turn reported by the host
 *     (e.g. Gemini/Antigravity AfterModel `usageMetadata`). This is NOT per-MCP:
 *     it covers the entire model turn, so the MCP leaderboard EXCLUDES it (just
 *     as it treats `tool_defs` specially) and it is surfaced as its own labeled
 *     section rather than added to the per-MCP `call` totals or to the
 *     usage-reader host-scan numbers.
 *   • `hook`       — one RUNTIME hook dispatch through the home-bin `hook`
 *     entrypoint (src/runtime/hook-entrypoint). The framework tokenizes the
 *     inbound normalized event payload the handler reads (input) and what the
 *     handler returns that becomes context/decision (output). The per-item
 *     `toolName` is the hook EVENT name (e.g. "SessionStart"). This is the
 *     developer-axis "hook" surface — measured live, like `call`.
 */
export type EventScope = "call" | "tool_defs" | "model_turn" | "hook";

/**
 * Which of the FIVE developer-axis surfaces a record (or footprint) belongs to.
 * `server`/`hook` are RUNTIME-measured surfaces that produce {@link ToolEventRecord}
 * store rows; `command`/`skill`/`subagent` are STATIC footprints computed from the
 * registered connector (the host loads them as context — we never intercept them,
 * so they are NEVER written as usage rows). OPTIONAL on the record so rows written
 * before this field existed (every legacy serve-proxy row) read as `server`.
 */
export type SurfaceKind = "server" | "hook" | "command" | "skill" | "subagent";

/**
 * The install scope a wrapped server was deployed under, narrowed to the two
 * dimensions that matter for slicing telemetry: a `user`-global install vs a
 * `project`-local one. The framework's broader {@link InstallScope}
 * (`system|user|project|profile|managed`) is mapped down to this at wrap time —
 * everything that is not project-local reads as `user`. Optional on the record
 * so rows written before this field existed are treated as "unknown".
 */
export type TelemetryInstallScope = "user" | "project";

/**
 * How the real MCP server underneath the proxy was launched. `npx`/`bunx`/`uvx`
 * are ephemeral package runners; `node`/`bun`/`deno` are interpreters running a
 * local script; `binary` is a resolved executable on PATH; `http` marks a remote
 * server reached over the network (no local launch); `unknown` is the honest
 * fallback. Optional on the record so older rows read as "unknown".
 */
export type LaunchMethod =
  | "npx"
  | "bunx"
  | "uvx"
  | "node"
  | "binary"
  | "http"
  | "unknown";

/**
 * One telemetry row. Aggregate counts only — no content. `projectKey` is the
 * hashed stable project identity (git remote || normalized abs path); `projectDir`
 * is kept human-readable for reports but is the same partition.
 */
export interface ToolEventRecord {
  /** Monotonic-ish unique id (e.g. `${ts}-${seq}`). */
  id: string;
  /** Epoch milliseconds. */
  ts: number;
  connectorId: string;
  toolName: string;
  scope: EventScope;
  hostPlatform: PlatformId;
  sessionId: string;
  projectKey: string;
  projectDir: string;
  inputTokens: number;
  outputTokens: number;
  confidenceSource: ConfidenceSource;
  isError: boolean;
  /**
   * The (narrowed) install scope the wrapped server was deployed under — a
   * slicing dimension for global(user) vs project usage. OPTIONAL: rows written
   * before this field existed lack it and must be read as "unknown".
   */
  installScope?: TelemetryInstallScope;
  /**
   * How the real server was launched (npx/bunx/uvx/node/binary/http) — the
   * "launch-method" slicing dimension. OPTIONAL: older rows lack it → "unknown".
   */
  launchMethod?: LaunchMethod;
  /**
   * Which developer-axis surface produced this row. OPTIONAL and
   * backward-compatible: rows written before this field existed (every legacy
   * serve-proxy `call`/`tool_defs` row) lack it and MUST be read as `server`.
   * Runtime rows stamp it explicitly (`server` for the proxy, `hook` for the
   * hook runtime); the static command/skill/subagent surfaces never produce
   * store rows (they are reported as footprints — see surface-footprint.ts).
   */
  surfaceKind?: SurfaceKind;
}

export interface QueryFilter {
  connectorId?: string;
  projectKey?: string;
  sessionId?: string;
  toolName?: string;
  /** Lower bound epoch ms (inclusive). */
  sinceMs?: number;
}

/** A grouped rollup row for reports. */
export interface RollupRow {
  /** The grouping key value (tool name, session id, or project dir). */
  key: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Worst (least-confident) source seen in the group, for honest labeling. */
  confidence: ConfidenceSource;
  lastTs: number;
}

/**
 * Local-first telemetry store. The default NDJSON implementation appends one
 * line per record (append is atomic enough for concurrent multi-host writers);
 * a SQLite/WAL implementation is a drop-in upgrade behind this same interface.
 */
export interface TelemetryStore {
  append(record: ToolEventRecord): void;
  query(filter: QueryFilter): ToolEventRecord[];
  /** Group + aggregate by tool | session | project. */
  rollup(by: "tool" | "session" | "project", filter: QueryFilter): RollupRow[];
  close(): void;
}
