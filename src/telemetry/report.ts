/**
 * telemetry/report — CLI-facing formatting for telemetry rollups and exports.
 *
 * Pure functions: take store output (rollup rows / raw records) and render text,
 * CSV, or JSON. No IO except {@link summarize}, which reads through a passed-in
 * {@link TelemetryStore}. Confidence is surfaced verbatim so heuristic/approx
 * numbers are never mistaken for exact host-reported usage.
 */

import type { TelemetryStore } from "./types.js";
import type {
  ConfidenceSource,
  QueryFilter,
  RollupRow,
  ToolEventRecord,
} from "./types.js";

/** Grouping dimension, mirrored from {@link TelemetryStore.rollup}. */
export type RollupDimension = "tool" | "session" | "project";

/** Human label for the leading KEY column, per grouping dimension. */
const KEY_HEADER: Record<RollupDimension, string> = {
  tool: "TOOL",
  session: "SESSION",
  project: "PROJECT",
};

/** Sources whose counts are estimates (vs. real / host-reported numbers). */
const ESTIMATE_SOURCES: ReadonlySet<ConfidenceSource> = new Set<ConfidenceSource>([
  "heuristic",
  "tokenizer-approx",
]);

/** Compact, fixed-width integer formatting with thousands separators. */
function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

/** Pad a cell to a column width (right-pad text, used for left-aligned cols). */
function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Pad a cell to a column width (left-pad, used for right-aligned numbers). */
function padLeft(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

/**
 * Render an aligned text table of rollup rows, sorted by total tokens desc, with
 * a TOTAL footer and a short legend noting which confidence labels are estimates.
 */
export function formatReport(rows: RollupRow[], by: RollupDimension): string {
  const keyHeader = KEY_HEADER[by];
  const headers = [keyHeader, "CALLS", "IN", "OUT", "TOTAL", "CONFIDENCE"];

  const sorted = [...rows].sort((a, b) => b.totalTokens - a.totalTokens);

  // Build the data matrix (string cells) first so we can measure widths.
  const dataRows = sorted.map((r) => [
    r.key,
    fmtInt(r.calls),
    fmtInt(r.inputTokens),
    fmtInt(r.outputTokens),
    fmtInt(r.totalTokens),
    r.confidence,
  ]);

  // Totals footer. Confidence is the worst (least-confident) across all rows.
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
    fmtInt(totals.calls),
    fmtInt(totals.inputTokens),
    fmtInt(totals.outputTokens),
    fmtInt(totals.totalTokens),
    "",
  ];

  // Column widths: max over header, every data cell, and the totals row.
  const widths = headers.map((h, col) => {
    let w = h.length;
    for (const row of dataRows) w = Math.max(w, (row[col] ?? "").length);
    w = Math.max(w, (totalRow[col] ?? "").length);
    return w;
  });

  // Column 0 (KEY) is left-aligned; numeric/label columns are right-aligned.
  const renderRow = (cells: string[]): string =>
    cells
      .map((c, col) =>
        col === 0
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
    lines.push("(no telemetry recorded)");
  } else {
    for (const row of dataRows) lines.push(renderRow(row));
  }
  lines.push(rule);
  lines.push(renderRow(totalRow));

  // Legend — honest labeling of which confidence values are estimates.
  const hasEstimate = sorted.some((r) => ESTIMATE_SOURCES.has(r.confidence));
  if (hasEstimate) {
    lines.push("");
    lines.push(
      "note: heuristic and tokenizer-approx token counts are estimates, " +
        "not exact host-reported usage.",
    );
  }

  return lines.join("\n");
}

/** Ordered columns for {@link toCSV}, matching the {@link ToolEventRecord} shape. */
const CSV_COLUMNS = [
  "id",
  "ts",
  "connectorId",
  "toolName",
  "scope",
  "hostPlatform",
  "sessionId",
  "projectKey",
  "projectDir",
  "inputTokens",
  "outputTokens",
  "confidenceSource",
  "isError",
  // installScope / launchMethod mirror the JSON export so the scope dimension is
  // not silently dropped from CSV; absent on a record → an empty cell.
  "installScope",
  "launchMethod",
] as const satisfies ReadonlyArray<keyof ToolEventRecord>;

/** RFC-4180-ish CSV escaping: quote when the cell holds a comma, quote, or newline. */
function csvCell(value: unknown): string {
  // An absent field (optional column like installScope/launchMethod) renders as
  // an empty cell rather than the literal "undefined" — the JSON export omits
  // the key entirely, so the CSV should likewise carry no value.
  if (value === undefined || value === null) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Serialize raw records to CSV (header + one line per record, CRLF-terminated). */
export function toCSV(records: ToolEventRecord[]): string {
  const lines: string[] = [];
  lines.push(CSV_COLUMNS.join(","));
  for (const record of records) {
    lines.push(CSV_COLUMNS.map((col) => csvCell(record[col])).join(","));
  }
  return lines.join("\r\n");
}

/** Serialize raw records to a pretty-printed JSON array string. */
export function toJSONExport(records: ToolEventRecord[]): string {
  return JSON.stringify(records, null, 2);
}

/** Options for {@link summarize}. */
export interface SummarizeOptions {
  /** Grouping dimension. Default "tool". */
  by?: RollupDimension;
  /** Query filter forwarded to the store. Default: no filter (all records). */
  filter?: QueryFilter;
}

/**
 * Roll up a store and render it in one call. Returns the structured rows (for
 * machine use) alongside the formatted text table (for the CLI).
 */
export function summarize(
  store: TelemetryStore,
  opts?: SummarizeOptions,
): { rows: RollupRow[]; text: string } {
  const by = opts?.by ?? "tool";
  const filter = opts?.filter ?? {};
  const rows = store.rollup(by, filter);
  return { rows, text: formatReport(rows, by) };
}
