/**
 * telemetry/leaderboard — the PLUGIN / MCP leaderboard, derived from the per-MCP
 * serve-proxy telemetry store (src/telemetry/*).
 *
 * This is the signature MCP-dev metric: of the MCP servers WE wrap, which one
 * costs the most tokens — platform-independent, because it measures the server's
 * OWN bytes (tool args in, tool result out, tool-defs schemas) tokenized locally,
 * the only signal identical across every host. Origin is always `mcp-self`; it is
 * NEVER summed with host-native usage (src/usage/*), which measures a different
 * thing (whole-conversation tokens).
 *
 * Pure aggregation + pure formatting over {@link TelemetryStore.query}. The scope
 * dimension (installScope/launchMethod) is OPTIONAL on each row — rows written
 * before those fields existed are read as "unknown" and are honestly labeled.
 */

import { openStore } from "./store.js";
import type {
  ConfidenceSource,
  LaunchMethod,
  QueryFilter,
  TelemetryInstallScope,
  TelemetryStore,
  ToolEventRecord,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────
// Options + scope filter
// ─────────────────────────────────────────────────────────────────────────

/**
 * A scope filter value the leaderboards accept. The two install buckets
 * (`user`/`project`) and the launch methods (`npx`/`bunx`/`uvx`/`node`/`binary`/
 * `http`) plus the honest `unknown` fallback. A record matches a `user`/`project`
 * value by its `installScope`, and a launch-method value by its `launchMethod`.
 */
export type ScopeFilter =
  | TelemetryInstallScope
  | LaunchMethod;

/** Every accepted {@link ScopeFilter} string, for CLI validation. */
export const SCOPE_FILTER_VALUES: readonly ScopeFilter[] = [
  "user",
  "project",
  "npx",
  "bunx",
  "uvx",
  "node",
  "binary",
  "http",
  "unknown",
] as const;

/** Options shared by every leaderboard query. */
export interface LeaderboardOptions {
  /** An open store to read from. Defaults to {@link openStore} on the data-root. */
  store?: TelemetryStore;
  /** Lower-bound epoch ms (inclusive) — forwarded as the store's sinceMs filter. */
  sinceMs?: number;
  /** Restrict to one connector. */
  connectorId?: string;
  /** Slice by install scope (user|project) or launch method (npx|binary|http|…). */
  scope?: ScopeFilter;
}

/** Is `value` one of the accepted scope-filter strings? */
export function isScopeFilter(value: string): value is ScopeFilter {
  return (SCOPE_FILTER_VALUES as readonly string[]).includes(value);
}

/** The install/launch values a `user`/`project` scope filter matches against. */
const INSTALL_SCOPES: ReadonlySet<string> = new Set<string>(["user", "project"]);

/**
 * Does a record satisfy the requested scope slice? `user`/`project` match the
 * record's `installScope`; any other value matches the record's `launchMethod`.
 * A record missing the relevant field reads as "unknown" and only matches a
 * literal `unknown` filter — never silently counted under a concrete bucket.
 */
function matchesScope(record: ToolEventRecord, scope: ScopeFilter): boolean {
  if (INSTALL_SCOPES.has(scope)) {
    return (record.installScope ?? "unknown") === scope;
  }
  return (record.launchMethod ?? "unknown") === scope;
}

/** Build the store {@link QueryFilter} from the shared options. */
function toFilter(opts: LeaderboardOptions): QueryFilter {
  const filter: QueryFilter = {};
  if (opts.sinceMs !== undefined) filter.sinceMs = opts.sinceMs;
  if (opts.connectorId !== undefined && opts.connectorId !== "") {
    filter.connectorId = opts.connectorId;
  }
  return filter;
}

/** Query the store and apply the (in-memory) scope slice the store cannot. */
function selectRecords(opts: LeaderboardOptions): ToolEventRecord[] {
  const store = opts.store ?? openStore({});
  const owned = opts.store === undefined;
  try {
    const rows = store.query(toFilter(opts));
    if (opts.scope === undefined) return rows;
    const scope = opts.scope;
    return rows.filter((r) => matchesScope(r, scope));
  } finally {
    if (owned) store.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Confidence (worst-of, mirroring telemetry/store.ts)
// ─────────────────────────────────────────────────────────────────────────

/** Least-trustworthy (0) → most-trustworthy, mirrored from telemetry/store.ts. */
const CONFIDENCE_RANK: Record<ConfidenceSource, number> = {
  heuristic: 0,
  "tokenizer-approx": 1,
  "tokenizer-exact": 2,
  "host-native": 3,
};

/** The worse (least-confident) of two sources, so an estimate is never hidden. */
function worstConfidence(a: ConfidenceSource, b: ConfidenceSource): ConfidenceSource {
  return CONFIDENCE_RANK[b] < CONFIDENCE_RANK[a] ? b : a;
}

// ─────────────────────────────────────────────────────────────────────────
// Leaderboard rows
// ─────────────────────────────────────────────────────────────────────────

/**
 * One row of the MCP/plugin leaderboard — a connector ranked by total measured
 * tokens. `tools` is the count of distinct tool names seen (excluding the
 * tool-defs `*` pseudo-tool); `hostPlatforms` is the distinct set of hosts that
 * ran this server, evidence that the count aggregates across machines.
 */
export interface McpLeaderboardRow {
  connectorId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Count of distinct real tool names (the tool-defs `*` row is excluded). */
  tools: number;
  /** Distinct host platforms that produced records, sorted for stable output. */
  hostPlatforms: string[];
  /** Worst (least-confident) source in the group, for honest labeling. */
  confidence: ConfidenceSource;
  lastTs: number;
}

/**
 * One row of the per-tool leaderboard — a (connector, tool) pair ranked by total
 * measured tokens. The tool-defs pseudo-tool (`*`, scope `tool_defs`) is kept as
 * its own row so the fixed schema overhead is visible rather than hidden.
 */
export interface ToolLeaderboardRow {
  connectorId: string;
  toolName: string;
  /** "call" round-trips vs the one-time "tool_defs" overhead measurement. */
  scope: ToolEventRecord["scope"];
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  confidence: ConfidenceSource;
  lastTs: number;
}

/**
 * One row of the scope breakdown — usage grouped by (installScope, launchMethod),
 * both honestly reported as "unknown" when the underlying record lacks the field.
 */
export interface ScopeBreakdownRow {
  installScope: TelemetryInstallScope | "unknown";
  launchMethod: LaunchMethod;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  confidence: ConfidenceSource;
  lastTs: number;
}

/** Mutable accumulator for the MCP leaderboard fold (sets finalized to counts). */
interface McpAcc {
  connectorId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tools: Set<string>;
  hostPlatforms: Set<string>;
  confidence: ConfidenceSource;
  lastTs: number;
}

/**
 * The PLUGIN / MCP leaderboard: rank connectors by total measured tokens desc
 * (ties broken by recency). This is the headline "which MCP server costs the
 * most" metric, platform-independent by construction.
 */
export function mcpLeaderboard(opts: LeaderboardOptions = {}): McpLeaderboardRow[] {
  const groups = new Map<string, McpAcc>();

  for (const r of selectRecords(opts)) {
    let g = groups.get(r.connectorId);
    if (g === undefined) {
      g = {
        connectorId: r.connectorId,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        tools: new Set<string>(),
        hostPlatforms: new Set<string>(),
        confidence: r.confidenceSource,
        lastTs: r.ts,
      };
      groups.set(r.connectorId, g);
    }
    // A tool_defs row is a one-time schema overhead, not a call: count its
    // tokens but do not inflate the call count or the distinct-tool count.
    if (r.scope === "call") {
      g.calls += 1;
      g.tools.add(r.toolName);
    }
    g.inputTokens += r.inputTokens;
    g.outputTokens += r.outputTokens;
    g.totalTokens += r.inputTokens + r.outputTokens;
    g.hostPlatforms.add(r.hostPlatform);
    g.confidence = worstConfidence(g.confidence, r.confidenceSource);
    if (r.ts > g.lastTs) g.lastTs = r.ts;
  }

  const rows: McpLeaderboardRow[] = [];
  for (const g of groups.values()) {
    rows.push({
      connectorId: g.connectorId,
      calls: g.calls,
      inputTokens: g.inputTokens,
      outputTokens: g.outputTokens,
      totalTokens: g.totalTokens,
      tools: g.tools.size,
      hostPlatforms: [...g.hostPlatforms].sort(),
      confidence: g.confidence,
      lastTs: g.lastTs,
    });
  }
  rows.sort((a, b) => b.totalTokens - a.totalTokens || b.lastTs - a.lastTs);
  return rows;
}

/**
 * The per-tool leaderboard: rank (connector, tool) pairs by total tokens desc
 * (ties broken by recency). Drills the MCP leaderboard down to which individual
 * tool is the expensive one.
 */
export function toolLeaderboard(opts: LeaderboardOptions = {}): ToolLeaderboardRow[] {
  const groups = new Map<string, ToolLeaderboardRow>();

  for (const r of selectRecords(opts)) {
    const key = `${r.connectorId} ${r.toolName} ${r.scope}`;
    const g = groups.get(key);
    if (g === undefined) {
      groups.set(key, {
        connectorId: r.connectorId,
        toolName: r.toolName,
        scope: r.scope,
        calls: r.scope === "call" ? 1 : 0,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        totalTokens: r.inputTokens + r.outputTokens,
        confidence: r.confidenceSource,
        lastTs: r.ts,
      });
    } else {
      if (r.scope === "call") g.calls += 1;
      g.inputTokens += r.inputTokens;
      g.outputTokens += r.outputTokens;
      g.totalTokens += r.inputTokens + r.outputTokens;
      g.confidence = worstConfidence(g.confidence, r.confidenceSource);
      if (r.ts > g.lastTs) g.lastTs = r.ts;
    }
  }

  const rows = [...groups.values()];
  rows.sort((a, b) => b.totalTokens - a.totalTokens || b.lastTs - a.lastTs);
  return rows;
}

/**
 * The scope breakdown: group usage by (installScope, launchMethod). Both
 * dimensions read "unknown" when the source row lacks the field, so a pre-scope
 * row is honestly bucketed rather than dropped or mis-attributed.
 */
export function scopeBreakdown(opts: LeaderboardOptions = {}): ScopeBreakdownRow[] {
  const groups = new Map<string, ScopeBreakdownRow>();

  for (const r of selectRecords(opts)) {
    const installScope: TelemetryInstallScope | "unknown" = r.installScope ?? "unknown";
    const launchMethod: LaunchMethod = r.launchMethod ?? "unknown";
    const key = `${installScope} ${launchMethod}`;
    const g = groups.get(key);
    if (g === undefined) {
      groups.set(key, {
        installScope,
        launchMethod,
        calls: r.scope === "call" ? 1 : 0,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        totalTokens: r.inputTokens + r.outputTokens,
        confidence: r.confidenceSource,
        lastTs: r.ts,
      });
    } else {
      if (r.scope === "call") g.calls += 1;
      g.inputTokens += r.inputTokens;
      g.outputTokens += r.outputTokens;
      g.totalTokens += r.inputTokens + r.outputTokens;
      g.confidence = worstConfidence(g.confidence, r.confidenceSource);
      if (r.ts > g.lastTs) g.lastTs = r.ts;
    }
  }

  const rows = [...groups.values()];
  rows.sort((a, b) => b.totalTokens - a.totalTokens || b.lastTs - a.lastTs);
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────
// Formatting (mirrors telemetry/report.ts: aligned table + honesty legend)
// ─────────────────────────────────────────────────────────────────────────

/** Sources whose counts are estimates (vs real / host-reported numbers). */
const ESTIMATE_SOURCES: ReadonlySet<ConfidenceSource> = new Set<ConfidenceSource>([
  "heuristic",
  "tokenizer-approx",
]);

/** Compact integer formatting with thousands separators. */
function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

/** Right-pad (left-aligned columns). */
function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Left-pad (right-aligned numeric columns). */
function padLeft(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

/**
 * Render an aligned table given headers, the data cells, and which columns are
 * left-aligned (text) vs right-aligned (numbers). Adds rule lines and a TOTAL
 * footer. Shared by every leaderboard formatter for one consistent style.
 */
function renderTable(
  headers: string[],
  dataRows: string[][],
  leftAlignedCols: ReadonlySet<number>,
  totalRow: string[],
  emptyMessage: string,
): string[] {
  const widths = headers.map((h, col) => {
    let w = h.length;
    for (const row of dataRows) w = Math.max(w, (row[col] ?? "").length);
    w = Math.max(w, (totalRow[col] ?? "").length);
    return w;
  });

  const renderRow = (cells: string[]): string =>
    cells
      .map((c, col) =>
        leftAlignedCols.has(col)
          ? padRight(c, widths[col] ?? 0)
          : padLeft(c, widths[col] ?? 0),
      )
      .join("  ")
      .trimEnd();

  const ruleWidth = widths.reduce((a, b) => a + b, 0) + 2 * (widths.length - 1);
  const rule = "-".repeat(ruleWidth);

  const lines: string[] = [];
  lines.push(renderRow(headers));
  lines.push(rule);
  if (dataRows.length === 0) {
    lines.push(emptyMessage);
  } else {
    for (const row of dataRows) lines.push(renderRow(row));
  }
  lines.push(rule);
  lines.push(renderRow(totalRow));
  return lines;
}

/** Append the estimate legend when any row carries an estimate confidence. */
function appendEstimateLegend(
  lines: string[],
  confidences: ConfidenceSource[],
): void {
  if (confidences.some((c) => ESTIMATE_SOURCES.has(c))) {
    lines.push("");
    lines.push(
      "note: heuristic and tokenizer-approx token counts are estimates, " +
        "not exact host-reported usage.",
    );
  }
}

/**
 * Format the MCP/plugin leaderboard as an aligned table:
 *   RANK | CONNECTOR | CALLS | TOOLS | IN | OUT | TOTAL | HOSTS | CONFIDENCE
 * sorted by total tokens desc, with a TOTAL footer and the honesty legend.
 */
export function formatMcpLeaderboard(rows: McpLeaderboardRow[]): string {
  const sorted = [...rows].sort(
    (a, b) => b.totalTokens - a.totalTokens || b.lastTs - a.lastTs,
  );
  const headers = [
    "RANK",
    "CONNECTOR",
    "CALLS",
    "TOOLS",
    "IN",
    "OUT",
    "TOTAL",
    "HOSTS",
    "CONFIDENCE",
  ];
  const dataRows = sorted.map((r, i) => [
    `${i + 1}`,
    r.connectorId,
    fmtInt(r.calls),
    fmtInt(r.tools),
    fmtInt(r.inputTokens),
    fmtInt(r.outputTokens),
    fmtInt(r.totalTokens),
    r.hostPlatforms.length === 0 ? "-" : r.hostPlatforms.join(","),
    r.confidence,
  ]);

  const totals = sorted.reduce(
    (acc, r) => {
      acc.calls += r.calls;
      acc.inputTokens += r.inputTokens;
      acc.outputTokens += r.outputTokens;
      acc.totalTokens += r.totalTokens;
      return acc;
    },
    { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
  const totalRow = [
    "",
    "TOTAL",
    fmtInt(totals.calls),
    "",
    fmtInt(totals.inputTokens),
    fmtInt(totals.outputTokens),
    fmtInt(totals.totalTokens),
    "",
    "",
  ];

  // Left-align RANK (0), CONNECTOR (1), HOSTS (7), CONFIDENCE (8); numbers right.
  const leftCols = new Set<number>([0, 1, 7, 8]);
  const lines = renderTable(
    headers,
    dataRows,
    leftCols,
    totalRow,
    "(no MCP telemetry recorded)",
  );
  appendEstimateLegend(
    lines,
    sorted.map((r) => r.confidence),
  );
  return lines.join("\n");
}

/**
 * Format the per-tool leaderboard:
 *   RANK | CONNECTOR | TOOL | SCOPE | CALLS | IN | OUT | TOTAL | CONFIDENCE
 * sorted by total tokens desc, with a TOTAL footer and the honesty legend.
 */
export function formatToolLeaderboard(rows: ToolLeaderboardRow[]): string {
  const sorted = [...rows].sort(
    (a, b) => b.totalTokens - a.totalTokens || b.lastTs - a.lastTs,
  );
  const headers = [
    "RANK",
    "CONNECTOR",
    "TOOL",
    "SCOPE",
    "CALLS",
    "IN",
    "OUT",
    "TOTAL",
    "CONFIDENCE",
  ];
  const dataRows = sorted.map((r, i) => [
    `${i + 1}`,
    r.connectorId,
    r.toolName,
    r.scope,
    fmtInt(r.calls),
    fmtInt(r.inputTokens),
    fmtInt(r.outputTokens),
    fmtInt(r.totalTokens),
    r.confidence,
  ]);

  const totals = sorted.reduce(
    (acc, r) => {
      acc.calls += r.calls;
      acc.inputTokens += r.inputTokens;
      acc.outputTokens += r.outputTokens;
      acc.totalTokens += r.totalTokens;
      return acc;
    },
    { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
  const totalRow = [
    "",
    "TOTAL",
    "",
    "",
    fmtInt(totals.calls),
    fmtInt(totals.inputTokens),
    fmtInt(totals.outputTokens),
    fmtInt(totals.totalTokens),
    "",
  ];

  // Left-align RANK (0), CONNECTOR (1), TOOL (2), SCOPE (3), CONFIDENCE (8).
  const leftCols = new Set<number>([0, 1, 2, 3, 8]);
  const lines = renderTable(
    headers,
    dataRows,
    leftCols,
    totalRow,
    "(no MCP telemetry recorded)",
  );
  appendEstimateLegend(
    lines,
    sorted.map((r) => r.confidence),
  );
  return lines.join("\n");
}

/**
 * Format the scope breakdown:
 *   INSTALL | LAUNCH | CALLS | IN | OUT | TOTAL | CONFIDENCE
 * with a TOTAL footer and the honesty legend.
 */
export function formatScopeBreakdown(rows: ScopeBreakdownRow[]): string {
  const sorted = [...rows].sort(
    (a, b) => b.totalTokens - a.totalTokens || b.lastTs - a.lastTs,
  );
  const headers = ["INSTALL", "LAUNCH", "CALLS", "IN", "OUT", "TOTAL", "CONFIDENCE"];
  const dataRows = sorted.map((r) => [
    r.installScope,
    r.launchMethod,
    fmtInt(r.calls),
    fmtInt(r.inputTokens),
    fmtInt(r.outputTokens),
    fmtInt(r.totalTokens),
    r.confidence,
  ]);

  const totals = sorted.reduce(
    (acc, r) => {
      acc.calls += r.calls;
      acc.inputTokens += r.inputTokens;
      acc.outputTokens += r.outputTokens;
      acc.totalTokens += r.totalTokens;
      return acc;
    },
    { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
  const totalRow = [
    "TOTAL",
    "",
    fmtInt(totals.calls),
    fmtInt(totals.inputTokens),
    fmtInt(totals.outputTokens),
    fmtInt(totals.totalTokens),
    "",
  ];

  // Left-align INSTALL (0), LAUNCH (1), CONFIDENCE (6); numbers right-aligned.
  const leftCols = new Set<number>([0, 1, 6]);
  const lines = renderTable(
    headers,
    dataRows,
    leftCols,
    totalRow,
    "(no MCP telemetry recorded)",
  );
  appendEstimateLegend(
    lines,
    sorted.map((r) => r.confidence),
  );
  return lines.join("\n");
}
