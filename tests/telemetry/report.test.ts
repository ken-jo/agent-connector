import { describe, it, expect } from "vitest";

import {
  formatReport,
  summarize,
  toCSV,
  toJSONExport,
} from "../../src/telemetry/report.js";
import type { TelemetryStore } from "../../src/telemetry/types.js";
import type {
  ConfidenceSource,
  QueryFilter,
  RollupRow,
  ToolEventRecord,
} from "../../src/telemetry/types.js";

/** Build a RollupRow with defaults. */
function row(over: Partial<RollupRow> = {}): RollupRow {
  return {
    key: over.key ?? "acme_query",
    calls: over.calls ?? 1,
    inputTokens: over.inputTokens ?? 0,
    outputTokens: over.outputTokens ?? 0,
    totalTokens: over.totalTokens ?? 0,
    confidence: over.confidence ?? "tokenizer-exact",
    lastTs: over.lastTs ?? 1000,
  };
}

/** Build a ToolEventRecord with defaults. */
function rec(over: Partial<ToolEventRecord> = {}): ToolEventRecord {
  return {
    id: over.id ?? "r1",
    ts: over.ts ?? 1_700_000_000_000,
    connectorId: over.connectorId ?? "acme-db",
    toolName: over.toolName ?? "acme_query",
    scope: over.scope ?? "call",
    hostPlatform: over.hostPlatform ?? "claude-code",
    sessionId: over.sessionId ?? "sess-1",
    projectKey: over.projectKey ?? "pk-1",
    projectDir: over.projectDir ?? "/home/dev/acme",
    inputTokens: over.inputTokens ?? 10,
    outputTokens: over.outputTokens ?? 20,
    confidenceSource: over.confidenceSource ?? "tokenizer-exact",
    isError: over.isError ?? false,
  };
}

describe("formatReport", () => {
  it("renders a header row with the dimension-specific key column", () => {
    const out = formatReport([row({ key: "t1", totalTokens: 5 })], "tool");
    const lines = out.split("\n");
    expect(lines[0]).toContain("TOOL");
    expect(lines[0]).toContain("CALLS");
    expect(lines[0]).toContain("IN");
    expect(lines[0]).toContain("OUT");
    expect(lines[0]).toContain("TOTAL");
    expect(lines[0]).toContain("CONFIDENCE");
  });

  it("uses SESSION / PROJECT headers for those dimensions", () => {
    expect(formatReport([row()], "session").split("\n")[0]).toContain("SESSION");
    expect(formatReport([row()], "project").split("\n")[0]).toContain("PROJECT");
  });

  it("renders one data row per rollup row", () => {
    const rows = [
      row({ key: "alpha", totalTokens: 30 }),
      row({ key: "beta", totalTokens: 20 }),
      row({ key: "gamma", totalTokens: 10 }),
    ];
    const out = formatReport(rows, "tool");
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).toContain("gamma");
  });

  it("sorts rows by total tokens descending", () => {
    const rows = [
      row({ key: "low", totalTokens: 5 }),
      row({ key: "high", totalTokens: 100 }),
      row({ key: "mid", totalTokens: 50 }),
    ];
    const out = formatReport(rows, "tool");
    const idxHigh = out.indexOf("high");
    const idxMid = out.indexOf("mid");
    const idxLow = out.indexOf("low");
    expect(idxHigh).toBeGreaterThanOrEqual(0);
    expect(idxHigh).toBeLessThan(idxMid);
    expect(idxMid).toBeLessThan(idxLow);
  });

  it("does not mutate the input rows array order", () => {
    const rows = [
      row({ key: "low", totalTokens: 5 }),
      row({ key: "high", totalTokens: 100 }),
    ];
    formatReport(rows, "tool");
    expect(rows.map((r) => r.key)).toEqual(["low", "high"]);
  });

  it("renders a TOTAL line summing calls/in/out/total across rows", () => {
    const rows = [
      row({ key: "a", calls: 2, inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
      row({ key: "b", calls: 3, inputTokens: 20, outputTokens: 10, totalTokens: 30 }),
    ];
    const out = formatReport(rows, "tool");
    const totalLine = out.split("\n").find((l) => l.startsWith("TOTAL"));
    expect(totalLine).toBeDefined();
    // calls 5, in 30, out 15, total 45
    expect(totalLine).toContain("5");
    expect(totalLine).toContain("30");
    expect(totalLine).toContain("15");
    expect(totalLine).toContain("45");
  });

  it("formats large numbers with thousands separators", () => {
    const out = formatReport([row({ key: "big", totalTokens: 1234567 })], "tool");
    expect(out).toContain("1,234,567");
  });

  it("shows an empty-state line when there are no rows but still has header + TOTAL", () => {
    const out = formatReport([], "tool");
    const lines = out.split("\n");
    expect(lines[0]).toContain("TOOL");
    expect(out).toContain("(no telemetry recorded)");
    expect(out.split("\n").some((l) => l.startsWith("TOTAL"))).toBe(true);
  });

  it("adds an estimate legend when an estimate-source row is present", () => {
    const out = formatReport(
      [row({ key: "approx", confidence: "tokenizer-approx" })],
      "tool",
    );
    expect(out).toContain("estimates");
    expect(out).toContain("tokenizer-approx");
  });

  it("adds the legend for heuristic rows too", () => {
    const out = formatReport(
      [row({ key: "heur", confidence: "heuristic" })],
      "tool",
    );
    expect(out).toContain("estimates");
  });

  it("omits the estimate legend when every row is exact/host-native", () => {
    const out = formatReport(
      [
        row({ key: "exact", confidence: "tokenizer-exact" }),
        row({ key: "native", confidence: "host-native" }),
      ],
      "tool",
    );
    expect(out).not.toContain("are estimates");
  });

  it("renders the confidence label per row", () => {
    const out = formatReport(
      [row({ key: "t", confidence: "host-native" as ConfidenceSource })],
      "tool",
    );
    expect(out).toContain("host-native");
  });
});

describe("toCSV", () => {
  it("has a header row plus one line per record", () => {
    const records = [rec({ id: "a" }), rec({ id: "b" }), rec({ id: "c" })];
    const csv = toCSV(records);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(records.length + 1); // header + 3
  });

  it("the header row lists the expected columns in order", () => {
    const csv = toCSV([]);
    const header = csv.split("\r\n")[0]!;
    expect(header).toBe(
      "id,ts,connectorId,toolName,scope,hostPlatform,sessionId,projectKey,projectDir,inputTokens,outputTokens,confidenceSource,isError",
    );
  });

  it("an empty record list yields just the header", () => {
    const csv = toCSV([]);
    expect(csv.split("\r\n")).toHaveLength(1);
  });

  it("emits the record values in column order", () => {
    const csv = toCSV([rec({ id: "x1", toolName: "acme_query", inputTokens: 11 })]);
    const dataLine = csv.split("\r\n")[1]!;
    const cells = dataLine.split(",");
    expect(cells[0]).toBe("x1"); // id
    expect(cells[3]).toBe("acme_query"); // toolName
    expect(cells[9]).toBe("11"); // inputTokens
  });

  it("escapes cells containing commas/quotes/newlines per RFC-4180", () => {
    const csv = toCSV([
      rec({ id: "weird", projectDir: 'a,b "c"\nd' }),
    ]);
    const dataLine = csv.split("\r\n")[1]!;
    // The projectDir cell must be quoted and inner quotes doubled.
    expect(dataLine).toContain('"a,b ""c""');
  });
});

describe("toJSONExport", () => {
  it("round-trips via JSON.parse", () => {
    const records = [rec({ id: "1" }), rec({ id: "2", toolName: "acme_write" })];
    const json = toJSONExport(records);
    const parsed = JSON.parse(json) as ToolEventRecord[];
    expect(parsed).toEqual(records);
  });

  it("produces a JSON array", () => {
    const json = toJSONExport([rec()]);
    expect(json.trimStart().startsWith("[")).toBe(true);
    expect(Array.isArray(JSON.parse(json))).toBe(true);
  });

  it("round-trips an empty list to []", () => {
    expect(JSON.parse(toJSONExport([]))).toEqual([]);
  });

  it("is pretty-printed (multi-line) for a non-empty list", () => {
    const json = toJSONExport([rec()]);
    expect(json).toContain("\n");
  });
});

describe("summarize", () => {
  /** A minimal in-memory TelemetryStore returning canned rollup rows. */
  function fakeStore(rows: RollupRow[]): TelemetryStore & { lastBy?: string } {
    const store: TelemetryStore & { lastBy?: string; lastFilter?: QueryFilter } = {
      append() {},
      query() {
        return [];
      },
      rollup(by, filter) {
        store.lastBy = by;
        store.lastFilter = filter;
        return rows;
      },
      close() {},
    };
    return store;
  }

  it("rolls up via the store and renders the matching text table", () => {
    const rows = [row({ key: "acme_query", totalTokens: 40 })];
    const store = fakeStore(rows);
    const { rows: outRows, text } = summarize(store);
    expect(outRows).toBe(rows);
    expect(text).toBe(formatReport(rows, "tool"));
  });

  it('defaults the grouping dimension to "tool" and filter to {}', () => {
    const store = fakeStore([]);
    summarize(store);
    expect(store.lastBy).toBe("tool");
  });

  it("forwards a custom dimension and filter to the store", () => {
    const store = fakeStore([row({ key: "/proj" })]);
    const { text } = summarize(store, {
      by: "project",
      filter: { connectorId: "acme-db" },
    });
    expect(store.lastBy).toBe("project");
    expect(text.split("\n")[0]).toContain("PROJECT");
  });
});
