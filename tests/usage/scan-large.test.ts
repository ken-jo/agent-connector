/**
 * tests/usage/scan-large — scanUsage survives a huge reader result.
 *
 * Regression for a real-machine crash found while dogfooding the context-mode
 * migration: `leaderboard` died with `RangeError: Maximum call stack size
 * exceeded` inside scanUsage because the per-reader merge used
 * `collected.push(...records)` — spreading hundreds of thousands of usage
 * records as call arguments. The merge must be loop-based.
 */

import { describe, expect, it, vi } from "vitest";

import type { UsageRecord } from "../../src/usage/types.js";

const COUNT = 300_000;

function fakeRecord(i: number): UsageRecord {
  return {
    platformId: "claude-code",
    sourcePath: "/fake/sessions.jsonl",
    sessionId: `s-${i % 977}`,
    ts: 1_750_000_000_000 + i,
    model: "claude-test-1",
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    confidence: "host-reported",
  } as unknown as UsageRecord;
}

vi.mock("../../src/usage/registry.js", () => ({
  USAGE_READER_REGISTRY: [
    {
      platformId: "claude-code",
      kind: "local",
      load: async () => ({
        read: async () => Array.from({ length: COUNT }, (_, i) => fakeRecord(i)),
      }),
    },
  ],
}));

describe("scanUsage with a very large reader result", () => {
  it(`merges ${COUNT.toLocaleString()} records without blowing the call stack`, async () => {
    const { scanUsage } = await import("../../src/usage/scan.js");
    const { records, skipped } = await scanUsage({});
    expect(skipped).toEqual([]);
    // dedupe may fold identical (session,ts) shapes; the crash regression is
    // what we guard — the scan must complete and return a plausible set.
    expect(records.length).toBeGreaterThan(0);
    expect(records.length).toBeLessThanOrEqual(COUNT);
  });
});
