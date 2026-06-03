/**
 * usage/types — contracts for the HOST usage-telemetry subsystem.
 *
 * This is the read-only complement to the per-MCP serve-proxy telemetry
 * (src/telemetry/*). Where that layer measures the bytes of the MCP server WE
 * deploy, this layer parses each agent CLI's OWN native session logs/DBs (a
 * faithful TypeScript port of tokscale's Rust parsers) to report per-platform /
 * per-project / per-session / per-model token usage. It never writes host config
 * and never sums across the two layers by default (they measure different things).
 */

import type { PlatformId } from "../core/types.js";

/** The five token dimensions every reader normalizes to. */
export interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

/**
 * Provenance of a host usage row:
 *  - "host-reported": the host logged real token counts (the trustworthy case).
 *  - "host-estimated": derived (e.g. Kiro context%/chars-4, Crush cost-only).
 */
export type UsageConfidence = "host-reported" | "host-estimated";

/** One usage row, attributed to a platform/session/model. Aggregate counts only. */
export interface UsageRecord {
  platformId: PlatformId;
  /** Raw model id as logged; normalized for grouping at aggregation time. */
  modelId: string;
  providerId: string;
  sessionId: string;
  /** Normalized stable project key (when the log carries cwd/dir). */
  projectKey?: string;
  projectLabel?: string;
  tokens: TokenBreakdown;
  /** USD, only when the host log carries cost (pricing is out of scope v1). */
  cost?: number;
  /** Epoch milliseconds. */
  ts: number;
  /** Number of host messages folded into this record (default 1). */
  messageCount: number;
  /** Cross-source de-dup key to prevent double counting (see each reader). */
  dedupKey?: string;
  confidence: UsageConfidence;
  /** Optional sub-agent label where the host distinguishes one. */
  agent?: string;
}

/**
 * A platform usage reader. `read` MUST be fail-open: return [] (never throw)
 * when the host's storage root is absent or a file is malformed.
 */
export interface UsageReader {
  readonly platformId: PlatformId;
  /** "synced" = needs an external API sync we do NOT perform (local cache only). */
  readonly kind: "local" | "synced";
  read(opts: { sinceMs?: number }): Promise<UsageRecord[]>;
}

/** Lazy registry entry — one per reader, mirroring ADAPTER_REGISTRY. */
export interface UsageReaderFactory {
  readonly platformId: PlatformId;
  readonly format: "jsonl" | "json" | "sqlite" | "synced-cache";
  readonly kind: "local" | "synced";
  readonly load: () => Promise<UsageReader>;
}

export type UsageGroupBy = "platform" | "project" | "session" | "model" | "day";

/** An aggregated group for reporting. */
export interface UsageSummary {
  /** The grouping key value (platform id, project label, session id, model, or day). */
  key: string;
  tokens: TokenBreakdown;
  /** Sum of the five token dimensions. */
  total: number;
  cost?: number;
  sessions: number;
  messages: number;
  /** Worst (least-confident) provenance seen in the group, for honest labeling. */
  confidence: UsageConfidence;
  lastTs: number;
}

/** Empty token breakdown helper shape (impl provides the value). */
export type EmptyTokens = TokenBreakdown;
