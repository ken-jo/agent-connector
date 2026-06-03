/**
 * usage/leaderboard — the USER / HOST leaderboard, derived from the host usage
 * readers (src/usage/*).
 *
 * Where {@link import("../telemetry/leaderboard.js")} answers "which MCP server
 * costs the most" from the bytes WE wrap, this answers "which CLI / host spent
 * the most" from each agent's OWN native session logs. Origin is always
 * `host-native`; it is NEVER summed with the serve-proxy MCP leaderboard (they
 * measure different things: server bytes vs whole-conversation usage).
 *
 * Thin wrapper over {@link scanUsage} + {@link aggregateBy}: the ranking is just
 * the platform (or model) group-by, which `aggregateBy` already sorts by total
 * tokens desc. A dedicated formatter notes synced / host-estimated platforms.
 */

import type { SkippedPlatform } from "./scan.js";
import type { PlatformId } from "../core/types.js";
import type { UsageRecord, UsageSummary } from "./types.js";
import { aggregateBy } from "./aggregate.js";
import { scanUsage } from "./scan.js";

/** Options for the host leaderboard queries. */
export interface HostLeaderboardOptions {
  /** Lower-bound epoch ms (inclusive); forwarded to {@link scanUsage}. */
  sinceMs?: number;
  /** Restrict to these platforms; omit/empty to scan every registered reader. */
  platforms?: PlatformId[];
  /** Rank dimension. "platform" (default) is the headline host leaderboard. */
  by?: "platform" | "model";
}

/** The host leaderboard result: ranked rows plus any honest skip notes. */
export interface HostLeaderboardResult {
  /** The ranking dimension actually used. */
  by: "platform" | "model";
  /** Ranked summary rows (sorted by total tokens desc by aggregateBy). */
  rows: UsageSummary[];
  /** Platforms the scan could not (fully) read (synced-but-uncached, errors). */
  skipped: SkippedPlatform[];
}

/**
 * The USER / HOST leaderboard: scan every host reader, then rank by platform
 * (the default — "which CLI/host spent the most") or by model. Returns the
 * ranked rows and the scan's skip notes so the formatter can stay honest about
 * cloud platforms that require a sync we do not perform.
 */
export async function hostLeaderboard(
  opts: HostLeaderboardOptions = {},
): Promise<HostLeaderboardResult> {
  const by = opts.by ?? "platform";
  const scanOpts: { sinceMs?: number; platforms?: PlatformId[] } = {};
  if (opts.sinceMs !== undefined) scanOpts.sinceMs = opts.sinceMs;
  if (opts.platforms !== undefined && opts.platforms.length > 0) {
    scanOpts.platforms = opts.platforms;
  }
  const { records, skipped } = await scanUsage(scanOpts);
  const rows = aggregateBy(records, by);
  return { by, rows, skipped };
}

// ─────────────────────────────────────────────────────────────────────────
// Formatting (mirrors usage/report.ts style: aligned table + honesty legend)
// ─────────────────────────────────────────────────────────────────────────

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
 * Format the host leaderboard as an aligned, ranked table:
 *   RANK | PLATFORM|MODEL | IN | OUT | CACHE_R | CACHE_W | REASON | TOTAL | SESS | CONF
 * with a TOTAL footer (worst confidence across rows), an estimate legend, and
 * skip notes for synced-but-uncached platforms.
 */
export function formatHostLeaderboard(
  result: HostLeaderboardResult,
): string {
  const keyHeader = result.by === "model" ? "MODEL" : "PLATFORM";
  const headers = [
    "RANK",
    keyHeader,
    "IN",
    "OUT",
    "CACHE_R",
    "CACHE_W",
    "REASON",
    "TOTAL",
    "SESS",
    "CONF",
  ];

  // aggregateBy already sorts by total desc; re-sort defensively for stability.
  const sorted = [...result.rows].sort(
    (a, b) => b.total - a.total || b.lastTs - a.lastTs,
  );

  const dataRows = sorted.map((r, i) => [
    `${i + 1}`,
    r.key,
    fmtInt(r.tokens.input),
    fmtInt(r.tokens.output),
    fmtInt(r.tokens.cacheRead),
    fmtInt(r.tokens.cacheWrite),
    fmtInt(r.tokens.reasoning),
    fmtInt(r.total),
    fmtInt(r.sessions),
    r.confidence,
  ]);

  const totals = sorted.reduce(
    (acc, r) => {
      acc.input += r.tokens.input;
      acc.output += r.tokens.output;
      acc.cacheRead += r.tokens.cacheRead;
      acc.cacheWrite += r.tokens.cacheWrite;
      acc.reasoning += r.tokens.reasoning;
      acc.total += r.total;
      acc.sessions += r.sessions;
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, sessions: 0 },
  );
  const totalRow = [
    "",
    "TOTAL",
    fmtInt(totals.input),
    fmtInt(totals.output),
    fmtInt(totals.cacheRead),
    fmtInt(totals.cacheWrite),
    fmtInt(totals.reasoning),
    fmtInt(totals.total),
    fmtInt(totals.sessions),
    "",
  ];

  const widths = headers.map((h, col) => {
    let w = h.length;
    for (const row of dataRows) w = Math.max(w, (row[col] ?? "").length);
    w = Math.max(w, (totalRow[col] ?? "").length);
    return w;
  });

  // Left-align RANK (0), the KEY column (1), and CONF (9); numbers right.
  const leftCols = new Set<number>([0, 1, 9]);
  const renderRow = (cells: string[]): string =>
    cells
      .map((c, col) =>
        leftCols.has(col) ? padRight(c, widths[col] ?? 0) : padLeft(c, widths[col] ?? 0),
      )
      .join("  ")
      .trimEnd();

  const ruleWidth = widths.reduce((a, b) => a + b, 0) + 2 * (widths.length - 1);
  const rule = "-".repeat(ruleWidth);

  const lines: string[] = [];
  lines.push(renderRow(headers));
  lines.push(rule);
  if (dataRows.length === 0) {
    lines.push("(no host usage found)");
  } else {
    for (const row of dataRows) lines.push(renderRow(row));
  }
  lines.push(rule);
  lines.push(renderRow(totalRow));

  // Honesty legend — estimated rows and skipped synced platforms.
  if (sorted.some((r) => r.confidence === "host-estimated")) {
    lines.push("");
    lines.push(
      "note: host-estimated rows are derived (e.g. char/4 or cost-only), " +
        "not exact host-reported token counts.",
    );
  }
  if (result.skipped.length > 0) {
    lines.push("");
    lines.push("skipped (synced/host-estimated platforms):");
    for (const s of result.skipped) lines.push(`  - ${s.platformId}: ${s.reason}`);
  }

  return lines.join("\n");
}
