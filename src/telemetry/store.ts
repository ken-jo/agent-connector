/**
 * telemetry/store — the default NDJSON {@link TelemetryStore} implementation.
 *
 * Local-first, dependency-free persistence. One JSON object per line; appends
 * are atomic enough for concurrent multi-host writers (a single `appendFileSync`
 * of a `<line>\n` chunk is written in one `write(2)` for small payloads, so
 * interleaving across processes does not corrupt individual records). A
 * SQLite/WAL backend is a drop-in upgrade behind the same interface.
 *
 * Telemetry stores AGGREGATE COUNTS ONLY — raw tool arguments/results are never
 * persisted (enforced by the {@link ToolEventRecord} shape, which carries no
 * content fields).
 *
 * Global kill switch: AGENTCONNECT_TELEMETRY=0 makes `append` a no-op so a
 * disabled telemetry layer can never touch disk or break a host's tool call.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { ensureDir, telemetryPath } from "../core/paths.js";
import { worstConfidence } from "./types.js";
import type {
  QueryFilter,
  RollupRow,
  TelemetryStore,
  ToolEventRecord,
} from "./types.js";

/** Options for {@link openStore}. */
export interface OpenStoreOptions {
  /** Override the NDJSON file path. Defaults to telemetryPath("ndjson"). */
  path?: string;
}

// Confidence ranking + worst-of comparison live in ./types (the single source
// of truth) so a new ConfidenceSource value orders correctly everywhere.

/** Is `process.env.AGENTCONNECT_TELEMETRY` an explicit off switch? */
function telemetryDisabled(): boolean {
  return process.env.AGENTCONNECT_TELEMETRY === "0";
}

/**
 * A unique-enough record id. Combines the wall clock with a caller-supplied
 * sequence so two records written in the same millisecond still differ.
 */
export function newRecordId(seq: number): string {
  return `${Date.now()}-${seq}`;
}

class NdjsonStore implements TelemetryStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  append(record: ToolEventRecord): void {
    if (telemetryDisabled()) return;
    ensureDir(dirname(this.path));
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
  }

  query(filter: QueryFilter): ToolEventRecord[] {
    if (!existsSync(this.path)) return [];

    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }

    const out: ToolEventRecord[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;

      let record: ToolEventRecord;
      try {
        record = JSON.parse(trimmed) as ToolEventRecord;
      } catch {
        continue; // skip malformed lines
      }

      if (matches(record, filter)) out.push(record);
    }
    return out;
  }

  rollup(by: "tool" | "session" | "project", filter: QueryFilter): RollupRow[] {
    const groups = new Map<string, RollupRow>();

    for (const record of this.query(filter)) {
      const key = groupKey(record, by);
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, {
          key,
          calls: 1,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          totalTokens: record.inputTokens + record.outputTokens,
          confidence: record.confidenceSource,
          lastTs: record.ts,
        });
      } else {
        existing.calls += 1;
        existing.inputTokens += record.inputTokens;
        existing.outputTokens += record.outputTokens;
        existing.totalTokens += record.inputTokens + record.outputTokens;
        existing.confidence = worstConfidence(
          existing.confidence,
          record.confidenceSource,
        );
        if (record.ts > existing.lastTs) existing.lastTs = record.ts;
      }
    }

    return [...groups.values()];
  }

  close(): void {
    /* no-op for the NDJSON backend */
  }
}

/** Does a record satisfy every set field of the filter? */
function matches(record: ToolEventRecord, filter: QueryFilter): boolean {
  if (
    filter.connectorId !== undefined &&
    record.connectorId !== filter.connectorId
  ) {
    return false;
  }
  if (
    filter.projectKey !== undefined &&
    record.projectKey !== filter.projectKey
  ) {
    return false;
  }
  if (filter.sessionId !== undefined && record.sessionId !== filter.sessionId) {
    return false;
  }
  if (filter.toolName !== undefined && record.toolName !== filter.toolName) {
    return false;
  }
  if (filter.sinceMs !== undefined && record.ts < filter.sinceMs) {
    return false;
  }
  return true;
}

/** Resolve the grouping key value for a record under the requested dimension. */
function groupKey(
  record: ToolEventRecord,
  by: "tool" | "session" | "project",
): string {
  switch (by) {
    case "tool":
      return record.toolName;
    case "session":
      return record.sessionId;
    case "project":
      return record.projectDir;
  }
}

/**
 * Open the default local telemetry store. NDJSON backend; no native deps. The
 * returned store is safe to use even when telemetry is disabled — `append`
 * becomes a no-op and reads of a missing file return empty results.
 */
export function openStore(opts?: OpenStoreOptions): TelemetryStore {
  const path = opts?.path ?? telemetryPath("ndjson");
  return new NdjsonStore(path);
}
