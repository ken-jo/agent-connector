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
  | "tokenizer-approx" // real BPE used as a documented approximation (e.g. Anthropic)
  | "heuristic" // chars/4 fallback
  | "host-native"; // a host actually reported usage (e.g. Gemini AfterModel)

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

/** Whether a record measures a single tool call or the fixed tool-defs overhead. */
export type EventScope = "call" | "tool_defs";

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
