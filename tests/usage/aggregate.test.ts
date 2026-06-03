import { describe, it, expect } from "vitest";
import {
  emptyTokens,
  addTokens,
  sumTokens,
  worstConfidence,
  dedupe,
  aggregateBy,
} from "../../src/usage/aggregate.js";
import type {
  TokenBreakdown,
  UsageConfidence,
  UsageRecord,
} from "../../src/usage/types.js";

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

function tokens(partial: Partial<TokenBreakdown>): TokenBreakdown {
  return { ...emptyTokens(), ...partial };
}

function rec(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    platformId: "qwen-code",
    modelId: "qwen-max",
    providerId: "qwen",
    sessionId: "s1",
    tokens: emptyTokens(),
    ts: 1_000,
    messageCount: 1,
    confidence: "host-reported",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// emptyTokens
// ─────────────────────────────────────────────────────────────────────────

describe("emptyTokens", () => {
  it("returns an all-zero breakdown across all five dimensions", () => {
    expect(emptyTokens()).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    });
  });

  it("returns a fresh object each call (no shared mutable state)", () => {
    const a = emptyTokens();
    const b = emptyTokens();
    expect(a).not.toBe(b);
    a.input = 99;
    expect(b.input).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// addTokens
// ─────────────────────────────────────────────────────────────────────────

describe("addTokens", () => {
  it("sums element-wise across all five dimensions", () => {
    const a = tokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 });
    const b = tokens({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 50 });
    expect(addTokens(a, b)).toEqual({
      input: 11,
      output: 22,
      cacheRead: 33,
      cacheWrite: 44,
      reasoning: 55,
    });
  });

  it("does not mutate either operand (returns a new object)", () => {
    const a = tokens({ input: 1, output: 2 });
    const b = tokens({ input: 3, output: 4 });
    const out = addTokens(a, b);
    expect(out).not.toBe(a);
    expect(out).not.toBe(b);
    expect(a).toEqual(tokens({ input: 1, output: 2 }));
    expect(b).toEqual(tokens({ input: 3, output: 4 }));
  });

  it("is the additive identity when one operand is emptyTokens()", () => {
    const a = tokens({ input: 7, cacheWrite: 9, reasoning: 11 });
    expect(addTokens(a, emptyTokens())).toEqual(a);
    expect(addTokens(emptyTokens(), a)).toEqual(a);
  });
});

describe("sumTokens", () => {
  it("totals all five dimensions", () => {
    expect(sumTokens(tokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 }))).toBe(15);
    expect(sumTokens(emptyTokens())).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// worstConfidence
// ─────────────────────────────────────────────────────────────────────────

describe("worstConfidence", () => {
  it("returns host-estimated when either side is estimated", () => {
    expect(worstConfidence("host-reported", "host-estimated")).toBe("host-estimated");
    expect(worstConfidence("host-estimated", "host-reported")).toBe("host-estimated");
    expect(worstConfidence("host-estimated", "host-estimated")).toBe("host-estimated");
  });

  it("returns host-reported only when both sides are reported", () => {
    expect(worstConfidence("host-reported", "host-reported")).toBe("host-reported");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// dedupe (by dedupKey)
// ─────────────────────────────────────────────────────────────────────────

describe("dedupe", () => {
  it("keeps the FIRST record per dedupKey in insertion order", () => {
    const first = rec({ sessionId: "first", dedupKey: "k1" });
    const dup = rec({ sessionId: "dup", dedupKey: "k1" });
    const out = dedupe([first, dup]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(first);
    expect(out[0]?.sessionId).toBe("first");
  });

  it("passes through every un-keyed record (undefined or empty dedupKey)", () => {
    const a = rec({ sessionId: "a" }); // no dedupKey
    const b = rec({ sessionId: "b", dedupKey: "" }); // empty key
    const c = rec({ sessionId: "c" });
    const out = dedupe([a, b, c]);
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.sessionId)).toEqual(["a", "b", "c"]);
  });

  it("de-dupes distinct keys independently while preserving order", () => {
    const records = [
      rec({ sessionId: "k1-a", dedupKey: "k1" }),
      rec({ sessionId: "k2-a", dedupKey: "k2" }),
      rec({ sessionId: "k1-b", dedupKey: "k1" }), // dropped
      rec({ sessionId: "free" }), // un-keyed → kept
      rec({ sessionId: "k2-b", dedupKey: "k2" }), // dropped
    ];
    const out = dedupe(records);
    expect(out.map((r) => r.sessionId)).toEqual(["k1-a", "k2-a", "free"]);
  });

  it("is deterministic: same input order yields same output", () => {
    const records = [
      rec({ sessionId: "x", dedupKey: "k" }),
      rec({ sessionId: "y", dedupKey: "k" }),
    ];
    expect(dedupe(records)).toEqual(dedupe(records));
  });

  it("returns [] for an empty input", () => {
    expect(dedupe([])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// aggregateBy (grouping + sums + worst confidence)
// ─────────────────────────────────────────────────────────────────────────

describe("aggregateBy", () => {
  it("groups by platform and sums token dimensions + messages", () => {
    const records = [
      rec({
        platformId: "qwen-code",
        sessionId: "s1",
        tokens: tokens({ input: 10, output: 5, cacheRead: 2 }),
        messageCount: 1,
      }),
      rec({
        platformId: "qwen-code",
        sessionId: "s2",
        tokens: tokens({ input: 20, output: 15, reasoning: 3 }),
        messageCount: 2,
      }),
    ];
    const rows = aggregateBy(records, "platform");
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.key).toBe("qwen-code");
    expect(r.tokens).toEqual({
      input: 30,
      output: 20,
      cacheRead: 2,
      cacheWrite: 0,
      reasoning: 3,
    });
    expect(r.total).toBe(55);
    expect(r.messages).toBe(3);
  });

  it("counts DISTINCT sessions per group", () => {
    const records = [
      rec({ sessionId: "s1", tokens: tokens({ input: 1 }) }),
      rec({ sessionId: "s1", tokens: tokens({ input: 1 }) }), // same session
      rec({ sessionId: "s2", tokens: tokens({ input: 1 }) }),
    ];
    const rows = aggregateBy(records, "platform");
    expect(rows[0]?.sessions).toBe(2);
    expect(rows[0]?.messages).toBe(3);
  });

  it("groups by session and produces one row per session", () => {
    const records = [
      rec({ sessionId: "s1", tokens: tokens({ input: 100 }) }),
      rec({ sessionId: "s2", tokens: tokens({ input: 50 }) }),
      rec({ sessionId: "s1", tokens: tokens({ output: 25 }) }),
    ];
    const rows = aggregateBy(records, "session");
    expect(rows).toHaveLength(2);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.total]));
    expect(byKey["s1"]).toBe(125);
    expect(byKey["s2"]).toBe(50);
  });

  it("normalizes model ids when grouping by model", () => {
    const records = [
      rec({ modelId: "claude-3.5-sonnet-20241022", tokens: tokens({ input: 10 }) }),
      rec({ modelId: "claude-3.5-sonnet", tokens: tokens({ input: 20 }) }),
    ];
    const rows = aggregateBy(records, "model");
    // Both normalize to "claude-3-5-sonnet" → single group.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe("claude-3-5-sonnet");
    expect(rows[0]?.tokens.input).toBe(30);
  });

  it("uses projectLabel (then projectKey, then placeholder) as the project key", () => {
    const records = [
      rec({ sessionId: "s1", projectLabel: "repo-a", tokens: tokens({ input: 1 }) }),
      rec({ sessionId: "s2", projectKey: "/x/repo-b", tokens: tokens({ input: 2 }) }),
      rec({ sessionId: "s3", tokens: tokens({ input: 3 }) }),
    ];
    const rows = aggregateBy(records, "project");
    const keys = rows.map((r) => r.key).sort();
    expect(keys).toEqual(["(no project)", "/x/repo-b", "repo-a"]);
  });

  it("carries the WORST (least-confident) provenance in a mixed group", () => {
    const records = [
      rec({ sessionId: "s1", confidence: "host-reported", tokens: tokens({ input: 1 }) }),
      rec({ sessionId: "s2", confidence: "host-estimated", tokens: tokens({ input: 1 }) }),
    ];
    const rows = aggregateBy(records, "platform");
    expect(rows[0]?.confidence).toBe("host-estimated");
  });

  it("keeps host-reported for a group with only reported records", () => {
    const records = [
      rec({ sessionId: "s1", confidence: "host-reported", tokens: tokens({ input: 1 }) }),
      rec({ sessionId: "s2", confidence: "host-reported", tokens: tokens({ input: 1 }) }),
    ];
    expect(aggregateBy(records, "platform")[0]?.confidence).toBe("host-reported");
  });

  it("tracks the latest timestamp seen per group", () => {
    const records = [
      rec({ sessionId: "s1", ts: 5_000, tokens: tokens({ input: 1 }) }),
      rec({ sessionId: "s2", ts: 9_000, tokens: tokens({ input: 1 }) }),
      rec({ sessionId: "s3", ts: 1_000, tokens: tokens({ input: 1 }) }),
    ];
    expect(aggregateBy(records, "platform")[0]?.lastTs).toBe(9_000);
  });

  it("sums cost only when present and omits it when no record carries cost", () => {
    const withCost = aggregateBy(
      [
        rec({ sessionId: "s1", cost: 0.5, tokens: tokens({ input: 1 }) }),
        rec({ sessionId: "s2", cost: 1.25, tokens: tokens({ input: 1 }) }),
      ],
      "platform",
    );
    expect(withCost[0]?.cost).toBeCloseTo(1.75, 10);

    const noCost = aggregateBy([rec({ tokens: tokens({ input: 1 }) })], "platform");
    expect(noCost[0]?.cost).toBeUndefined();
  });

  it("sorts groups by total tokens descending (recency breaks ties)", () => {
    const records = [
      rec({ platformId: "a" as UsageRecord["platformId"], sessionId: "a", tokens: tokens({ input: 10 }), ts: 1 }),
      rec({ platformId: "b" as UsageRecord["platformId"], sessionId: "b", tokens: tokens({ input: 100 }), ts: 1 }),
      rec({ platformId: "c" as UsageRecord["platformId"], sessionId: "c", tokens: tokens({ input: 50 }), ts: 1 }),
    ];
    const rows = aggregateBy(records, "platform");
    expect(rows.map((r) => r.key)).toEqual(["b", "c", "a"]);
  });

  it("breaks total ties by recency (later lastTs first)", () => {
    const records = [
      rec({ platformId: "old" as UsageRecord["platformId"], sessionId: "o", tokens: tokens({ input: 10 }), ts: 100 }),
      rec({ platformId: "new" as UsageRecord["platformId"], sessionId: "n", tokens: tokens({ input: 10 }), ts: 900 }),
    ];
    const rows = aggregateBy(records, "platform");
    expect(rows.map((r) => r.key)).toEqual(["new", "old"]);
  });

  it("returns [] for no records", () => {
    expect(aggregateBy([], "platform")).toEqual([]);
  });

  it("does not leak the internal _sessions Set onto summary rows", () => {
    const rows = aggregateBy([rec({ tokens: tokens({ input: 1 }) })], "platform");
    expect(rows[0]).not.toHaveProperty("_sessions");
  });
});
