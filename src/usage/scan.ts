/**
 * usage/scan — orchestrate every registered reader into one deduped record set.
 *
 * Iterates USAGE_READER_REGISTRY (optionally filtered by platform), loads and
 * runs each reader, and folds the results together. Per-reader robustness:
 *   • a reader that throws (it shouldn't — readers are fail-open) is CAUGHT and
 *     recorded as skipped, never aborting the whole scan;
 *   • a "synced" reader that returns no rows is noted as skipped("requires sync")
 *     so the report can honestly explain why a cloud platform shows nothing;
 *   • a reader that simply has no local data returns [] silently (no root).
 *
 * After collection: global cross-source dedupe, then a final sinceMs filter
 * (readers also honor sinceMs, but the scan re-filters as a backstop).
 */

import type { PlatformId } from "../core/types.js";
import type { UsageReader, UsageReaderFactory, UsageRecord } from "./types.js";
import { dedupe } from "./aggregate.js";
import { USAGE_READER_REGISTRY } from "./registry.js";

/** A platform the scan could not (fully) read, with a human reason. */
export interface SkippedPlatform {
  platformId: PlatformId;
  reason: string;
}

/** Options controlling a scan. */
export interface ScanOptions {
  /** Lower-bound epoch ms; records older than this are dropped. */
  sinceMs?: number;
  /** Restrict to these platforms; omit/empty to scan every registered reader. */
  platforms?: PlatformId[];
}

/** The result of a scan: deduped records + notes on anything skipped. */
export interface ScanResult {
  records: UsageRecord[];
  skipped: SkippedPlatform[];
}

/**
 * Scan host usage across the selected readers. Returns deduped, since-filtered
 * records plus a `skipped` list (load/read failures and synced-but-uncached
 * platforms). Never throws — a single bad reader is isolated.
 */
export async function scanUsage(opts: ScanOptions = {}): Promise<ScanResult> {
  const { sinceMs, platforms } = opts;
  const wanted = platforms && platforms.length > 0 ? new Set(platforms) : undefined;

  const factories = USAGE_READER_REGISTRY.filter(
    (f) => wanted === undefined || wanted.has(f.platformId),
  );

  const collected: UsageRecord[] = [];
  const skipped: SkippedPlatform[] = [];

  // Run readers concurrently; each result is independent.
  const results = await Promise.all(
    factories.map(async (factory) => readOne(factory, sinceMs)),
  );

  for (const r of results) {
    if (r.skipped) skipped.push(r.skipped);
    if (r.records.length > 0) collected.push(...r.records);
  }

  const deduped = dedupe(collected);
  const filtered =
    sinceMs === undefined ? deduped : deduped.filter((rec) => rec.ts >= sinceMs);

  return { records: filtered, skipped };
}

/** Load + run a single reader, isolating any failure into a skip note. */
async function readOne(
  factory: UsageReaderFactory,
  sinceMs: number | undefined,
): Promise<{ records: UsageRecord[]; skipped?: SkippedPlatform }> {
  let reader: UsageReader;
  try {
    reader = await factory.load();
  } catch (err) {
    return {
      records: [],
      skipped: { platformId: factory.platformId, reason: `failed to load reader: ${errMsg(err)}` },
    };
  }

  let records: UsageRecord[];
  try {
    records = await reader.read(sinceMs === undefined ? {} : { sinceMs });
  } catch (err) {
    return {
      records: [],
      skipped: { platformId: factory.platformId, reason: `read error: ${errMsg(err)}` },
    };
  }

  if (records.length === 0 && factory.kind === "synced") {
    return {
      records: [],
      skipped: {
        platformId: factory.platformId,
        reason: "requires sync (no local cache found)",
      },
    };
  }

  return { records };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
