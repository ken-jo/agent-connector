/**
 * usage/report — CLI-facing formatting for host usage rollups and exports.
 *
 * Pure functions, mirroring telemetry/report.ts: an aligned text table with a
 * TOTAL footer and an honesty legend, plus CSV/JSON serializers for raw records.
 * Confidence is surfaced verbatim so a host-estimated row is never read as exact
 * host-reported usage; a footer note also explains synced-but-uncached platforms.
 */

import type {
  UsageGroupBy,
  UsageRecord,
  UsageSummary,
} from "./types.js";
import type { SkippedPlatform } from "./scan.js";
import { sumTokens } from "./aggregate.js";

/** Human label for the leading KEY column, per grouping dimension. */
const KEY_HEADER: Record<UsageGroupBy, string> = {
  platform: "PLATFORM",
  project: "PROJECT",
  session: "SESSION",
  model: "MODEL",
  day: "DAY",
};

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
 * Render an aligned table of usage rows (already aggregated). Columns:
 *   KEY | IN | OUT | CACHE_R | CACHE_W | REASON | TOTAL | SESS | CONF
 * with a TOTAL footer (worst confidence across rows) and an honesty legend.
 * Optionally appends notes for platforms the scan skipped.
 */
export function formatUsageReport(
  rows: UsageSummary[],
  by: UsageGroupBy,
  skipped: SkippedPlatform[] = [],
): string {
  const keyHeader = KEY_HEADER[by];
  const headers = [
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

  const sorted = [...rows].sort((a, b) => b.total - a.total || b.lastTs - a.lastTs);

  const dataRows = sorted.map((r) => [
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

  // Totals + worst confidence across all rows.
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

  const renderRow = (cells: string[]): string =>
    cells
      .map((c, col) => (col === 0 ? padRight(c, widths[col] ?? 0) : padLeft(c, widths[col] ?? 0)))
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
  const hasEstimate = sorted.some((r) => r.confidence === "host-estimated");
  if (hasEstimate) {
    lines.push("");
    lines.push(
      "note: host-estimated rows are derived (e.g. char/4 or cost-only), " +
        "not exact host-reported token counts.",
    );
  }
  if (skipped.length > 0) {
    lines.push("");
    lines.push("skipped:");
    for (const s of skipped) lines.push(`  - ${s.platformId}: ${s.reason}`);
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// Exports (raw deduped records)
// ─────────────────────────────────────────────────────────────────────────

/** Ordered CSV columns (flattening the token breakdown into separate fields). */
const CSV_COLUMNS = [
  "platformId",
  "modelId",
  "providerId",
  "sessionId",
  "projectKey",
  "projectLabel",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "total",
  "cost",
  "ts",
  "messageCount",
  "confidence",
  "agent",
] as const;

/** RFC-4180-ish escaping: quote a cell holding a comma, quote, or newline. */
function csvCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Flatten one record into the CSV column order. */
function recordRow(r: UsageRecord): unknown[] {
  return [
    r.platformId,
    r.modelId,
    r.providerId,
    r.sessionId,
    r.projectKey,
    r.projectLabel,
    r.tokens.input,
    r.tokens.output,
    r.tokens.cacheRead,
    r.tokens.cacheWrite,
    r.tokens.reasoning,
    sumTokens(r.tokens),
    r.cost,
    r.ts,
    r.messageCount,
    r.confidence,
    r.agent,
  ];
}

/** Serialize raw records to CSV (header + one CRLF-terminated line per record). */
export function usageToCSV(records: UsageRecord[]): string {
  const lines: string[] = [];
  lines.push(CSV_COLUMNS.join(","));
  for (const r of records) {
    lines.push(recordRow(r).map(csvCell).join(","));
  }
  return lines.join("\r\n");
}

/** Serialize raw records to a pretty-printed JSON array string. */
export function usageToJSON(records: UsageRecord[]): string {
  return JSON.stringify(records, null, 2);
}
