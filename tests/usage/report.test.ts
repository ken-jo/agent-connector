import { describe, it, expect } from "vitest";
import { formatUsageReport, usageToCSV, usageToJSON } from "../../src/usage/report.js";
import { emptyTokens } from "../../src/usage/aggregate.js";
import type {
  TokenBreakdown,
  UsageRecord,
  UsageSummary,
} from "../../src/usage/types.js";
import type { SkippedPlatform } from "../../src/usage/scan.js";

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

function tokens(partial: Partial<TokenBreakdown>): TokenBreakdown {
  return { ...emptyTokens(), ...partial };
}

function summary(overrides: Partial<UsageSummary>): UsageSummary {
  const base: UsageSummary = {
    key: "qwen-code",
    tokens: emptyTokens(),
    total: 0,
    sessions: 1,
    messages: 1,
    confidence: "host-reported",
    lastTs: 1_000,
  };
  return { ...base, ...overrides };
}

function record(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    platformId: "qwen-code",
    modelId: "qwen-max",
    providerId: "qwen",
    sessionId: "s1",
    tokens: emptyTokens(),
    ts: 1_700_000_000_000,
    messageCount: 1,
    confidence: "host-reported",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// formatUsageReport
// ─────────────────────────────────────────────────────────────────────────

describe("formatUsageReport", () => {
  it("renders a header with the per-dimension KEY column and all token columns", () => {
    const out = formatUsageReport([], "platform");
    const headerLine = out.split("\n")[0]!;
    expect(headerLine).toContain("PLATFORM");
    for (const col of ["IN", "OUT", "CACHE_R", "CACHE_W", "REASON", "TOTAL", "SESS", "CONF"]) {
      expect(headerLine).toContain(col);
    }
  });

  it("uses the correct KEY header per grouping dimension", () => {
    expect(formatUsageReport([], "project").split("\n")[0]).toContain("PROJECT");
    expect(formatUsageReport([], "session").split("\n")[0]).toContain("SESSION");
    expect(formatUsageReport([], "model").split("\n")[0]).toContain("MODEL");
    expect(formatUsageReport([], "day").split("\n")[0]).toContain("DAY");
  });

  it("shows an empty-state line and a zero TOTAL row when there are no rows", () => {
    const out = formatUsageReport([], "platform");
    expect(out).toContain("(no host usage found)");
    expect(out).toContain("TOTAL");
  });

  it("renders a data row with formatted token counts and the confidence label", () => {
    const rows = [
      summary({
        key: "qwen-code",
        tokens: tokens({ input: 1234, output: 567, cacheRead: 89 }),
        total: 1890,
        sessions: 2,
        confidence: "host-reported",
      }),
    ];
    const out = formatUsageReport(rows, "platform");
    expect(out).toContain("qwen-code");
    expect(out).toContain("1,234"); // thousands separator
    expect(out).toContain("567");
    expect(out).toContain("1,890");
    expect(out).toContain("host-reported");
  });

  it("sums all rows into a TOTAL footer", () => {
    const rows = [
      summary({ key: "a", tokens: tokens({ input: 100 }), total: 100, sessions: 1, lastTs: 2 }),
      summary({ key: "b", tokens: tokens({ input: 200 }), total: 200, sessions: 1, lastTs: 1 }),
    ];
    const out = formatUsageReport(rows, "platform");
    const totalLine = out.split("\n").find((l) => l.startsWith("TOTAL"))!;
    expect(totalLine).toContain("300"); // 100 + 200 input == total
  });

  it("sorts data rows by total descending", () => {
    const rows = [
      summary({ key: "small", total: 10, tokens: tokens({ input: 10 }), lastTs: 9 }),
      summary({ key: "big", total: 1000, tokens: tokens({ input: 1000 }), lastTs: 1 }),
      summary({ key: "mid", total: 100, tokens: tokens({ input: 100 }), lastTs: 5 }),
    ];
    const out = formatUsageReport(rows, "platform");
    const lines = out.split("\n");
    const idxBig = lines.findIndex((l) => l.startsWith("big"));
    const idxMid = lines.findIndex((l) => l.startsWith("mid"));
    const idxSmall = lines.findIndex((l) => l.startsWith("small"));
    expect(idxBig).toBeLessThan(idxMid);
    expect(idxMid).toBeLessThan(idxSmall);
  });

  it("appends the honesty legend only when an estimated row is present", () => {
    const reportedOnly = formatUsageReport(
      [summary({ key: "a", total: 1, tokens: tokens({ input: 1 }), confidence: "host-reported" })],
      "platform",
    );
    expect(reportedOnly).not.toContain("host-estimated rows are derived");

    const withEstimate = formatUsageReport(
      [summary({ key: "b", total: 1, tokens: tokens({ input: 1 }), confidence: "host-estimated" })],
      "platform",
    );
    expect(withEstimate).toContain("host-estimated rows are derived");
  });

  it("lists skipped platforms with their reasons", () => {
    const skipped: SkippedPlatform[] = [
      { platformId: "cursor" as SkippedPlatform["platformId"], reason: "requires sync (no local cache found)" },
    ];
    const out = formatUsageReport([], "platform", skipped);
    expect(out).toContain("skipped:");
    expect(out).toContain("cursor");
    expect(out).toContain("requires sync (no local cache found)");
  });

  it("does not mutate the caller's rows array when sorting", () => {
    const rows = [
      summary({ key: "small", total: 10, tokens: tokens({ input: 10 }) }),
      summary({ key: "big", total: 1000, tokens: tokens({ input: 1000 }) }),
    ];
    const before = rows.map((r) => r.key);
    formatUsageReport(rows, "platform");
    expect(rows.map((r) => r.key)).toEqual(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// usageToCSV
// ─────────────────────────────────────────────────────────────────────────

describe("usageToCSV", () => {
  it("emits the header row even with no records", () => {
    const csv = usageToCSV([]);
    const header = csv.split("\r\n")[0]!;
    for (const col of [
      "platformId",
      "modelId",
      "providerId",
      "sessionId",
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "reasoning",
      "total",
      "confidence",
    ]) {
      expect(header).toContain(col);
    }
  });

  it("flattens the token breakdown and computes total per record", () => {
    const csv = usageToCSV([
      record({
        sessionId: "s1",
        tokens: tokens({ input: 10, output: 20, cacheRead: 5, reasoning: 2 }),
      }),
    ]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(2);
    const cells = lines[1]!.split(",");
    const header = lines[0]!.split(",");
    const col = (name: string) => cells[header.indexOf(name)];
    expect(col("input")).toBe("10");
    expect(col("output")).toBe("20");
    expect(col("cacheRead")).toBe("5");
    expect(col("cacheWrite")).toBe("0");
    expect(col("reasoning")).toBe("2");
    expect(col("total")).toBe("37"); // 10+20+5+0+2
    expect(col("platformId")).toBe("qwen-code");
  });

  it("uses CRLF line endings between rows", () => {
    const csv = usageToCSV([record({ sessionId: "s1", tokens: tokens({ input: 1 }) })]);
    expect(csv).toContain("\r\n");
    expect(csv.split("\r\n")).toHaveLength(2);
  });

  it("leaves optional missing fields (projectKey, cost, agent) blank", () => {
    const csv = usageToCSV([record({ sessionId: "s1", tokens: tokens({ input: 1 }) })]);
    const [header, row] = csv.split("\r\n");
    const cells = row!.split(",");
    const cols = header!.split(",");
    expect(cells[cols.indexOf("projectKey")]).toBe("");
    expect(cells[cols.indexOf("cost")]).toBe("");
    expect(cells[cols.indexOf("agent")]).toBe("");
  });

  it("quotes/escapes cells containing commas or quotes (RFC-4180)", () => {
    const csv = usageToCSV([
      record({
        sessionId: "s1",
        projectLabel: 'my, "weird" repo',
        tokens: tokens({ input: 1 }),
      }),
    ]);
    // Comma + embedded quote → wrapped in quotes with doubled inner quotes.
    expect(csv).toContain('"my, ""weird"" repo"');
  });

  it("serializes cost and agent when present", () => {
    const csv = usageToCSV([
      record({ sessionId: "s1", tokens: tokens({ input: 1 }), cost: 0.42, agent: "subagent-x" }),
    ]);
    const [header, row] = csv.split("\r\n");
    const cells = row!.split(",");
    const cols = header!.split(",");
    expect(cells[cols.indexOf("cost")]).toBe("0.42");
    expect(cells[cols.indexOf("agent")]).toBe("subagent-x");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// usageToJSON (companion serializer)
// ─────────────────────────────────────────────────────────────────────────

describe("usageToJSON", () => {
  it("round-trips records through pretty JSON", () => {
    const recs = [record({ sessionId: "s1", tokens: tokens({ input: 5, output: 6 }) })];
    const parsed = JSON.parse(usageToJSON(recs)) as UsageRecord[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.sessionId).toBe("s1");
    expect(parsed[0]?.tokens.input).toBe(5);
    expect(parsed[0]?.tokens.output).toBe(6);
  });

  it("emits '[]' for an empty record set", () => {
    expect(usageToJSON([])).toBe("[]");
  });
});
