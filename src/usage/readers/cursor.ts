/**
 * usage/readers/cursor — Cursor IDE usage reader (SYNCED platform).
 *
 * Faithful port of tokscale sessions/cursor.rs. Cursor's per-event token usage
 * lives behind the Cursor dashboard export API; tokscale fetches it and caches
 * the result as CSV under ~/.config/tokscale/cursor-cache/. THIS reader never
 * authenticates and never calls that API — it only parses the cached CSV when a
 * tokscale run has already produced it. Hence kind:"synced":
 *   - cache present  → parse the CSV(s) and emit one record per data row;
 *   - cache absent   → return [] (the scan layer notes "requires sync, skipped").
 *
 * Cache layout (per docs/research/usage-readers.json + design §3d):
 *   ~/.config/tokscale/cursor-cache/usage.csv            (active account)
 *   ~/.config/tokscale/cursor-cache/usage.<account>.csv  (secondary accounts)
 *   ~/.config/tokscale/cursor-cache/archive/*.csv        (rotated exports)
 * paths.ts resolves the cache dir (env override AGENTCONNECT_TOKSCALE_DIR
 * first, the tokscale ~/.config/tokscale default second).
 *
 * CSV formats (column maps mirror cursor.rs exactly):
 *   v1 (no "Kind"):  Date,Model,Input(w/CacheWrite),Input(w/oCacheWrite),CacheRead,Output,Total,Cost,CostToYou
 *                    → model 1, in+cw 2, in 3, cacheRead 4, output 5, cost 7
 *   v2 (has "Kind", <11 cols): Date,Kind,Model,MaxMode,Input(w/CW),Input(w/oCW),CacheRead,Output,Total,Cost
 *                    → model 2, in+cw 4, in 5, cacheRead 6, output 7, cost 9
 *   v3 (has "Kind", ≥11 cols): Date,CloudAgentID,AutomationID,Kind,Model,MaxMode,Input(w/CW),Input(w/oCW),CacheRead,Output,Total,Cost
 *                    → model 4, in+cw 6, in 7, cacheRead 8, output 9, cost 11
 *
 * Per-row token math (port of parse_cursor_file):
 *   input      = Input(w/o CacheWrite)                    (clamped ≥ 0)
 *   cacheWrite = Input(w/ CacheWrite) − Input(w/o CacheWrite)  (clamped ≥ 0)
 *   cacheRead  = Cache Read                               (clamped ≥ 0)
 *   output     = Output Tokens                            (clamped ≥ 0)
 *   reasoning  = 0 (Cursor does not report it)
 * Cost is parsed from the Cost column ("$1,234.56" → 1234.56; "Included"/"-"/
 * "NaN"/"" → 0). Timestamp parses the Date column (ISO 8601 with/without ms/Z,
 * or date-only → noon UTC so local-day filtering never shifts the row).
 *
 * Attribution: provider inferred from the model (defaults to "cursor" for
 * Cursor-only ids like "auto"/"composer-2"); sessionId is the composite
 * `cursor-<account>-<date>` where account derives from the filename
 * (usage.csv → "active", usage.<x>.csv → sanitized "<x>"). No project scope
 * (account-level usage). Cursor ships no dedup key; the composite session id is
 * the implicit dedup, so dedupKey mirrors it. Confidence is "host-reported"
 * (the cached data carries real host token counts).
 *
 * Fail-open: no cache dir → []; unreadable/malformed file → skipped; a row
 * missing columns, with an empty model, or an unparseable date → skipped.
 */

import { basename } from "node:path";

import type { TokenBreakdown, UsageReader, UsageRecord } from "../types.js";
import { emptyTokens } from "../aggregate.js";
import { inferProvider } from "../normalize.js";
import { firstExistingRoot, walkFiles } from "../paths.js";

import { readFileSync } from "node:fs";

const PLATFORM_ID = "cursor" as const;
const DEFAULT_PROVIDER = "cursor";

/** Column-index map for one CSV format (mirrors cursor.rs tuple order). */
interface ColumnMap {
  model: number;
  inputCacheWrite: number;
  inputNoCache: number;
  cacheRead: number;
  output: number;
  cost: number;
}

const V1_COLUMNS: ColumnMap = {
  model: 1,
  inputCacheWrite: 2,
  inputNoCache: 3,
  cacheRead: 4,
  output: 5,
  cost: 7,
};
const V2_COLUMNS: ColumnMap = {
  model: 2,
  inputCacheWrite: 4,
  inputNoCache: 5,
  cacheRead: 6,
  output: 7,
  cost: 9,
};
const V3_COLUMNS: ColumnMap = {
  model: 4,
  inputCacheWrite: 6,
  inputNoCache: 7,
  cacheRead: 8,
  output: 9,
  cost: 11,
};

/**
 * Derive the account id from a cache filename (port of
 * account_id_from_cursor_cache_path):
 *   - "usage.csv"        → "active";
 *   - "usage.<x>.csv"    → "<x>" with non-[A-Za-z0-9-_.] chars replaced by '-'
 *                          (empty after cleaning → "unknown");
 *   - anything else      → "unknown".
 */
function accountIdFromPath(path: string): string {
  const fileName = basename(path) || "usage.csv";
  if (fileName === "usage.csv") return "active";

  if (fileName.startsWith("usage.") && fileName.endsWith(".csv")) {
    const stem = fileName.slice("usage.".length, fileName.length - ".csv".length);
    let cleaned = "";
    for (const ch of stem) {
      cleaned += /[A-Za-z0-9._-]/.test(ch) ? ch : "-";
    }
    return cleaned === "" ? "unknown" : cleaned;
  }

  return "unknown";
}

/** Coerce a CSV field to a non-negative integer (0 on absence/garbage). */
function toNonNegInt(field: string): number {
  const trimmed = field.trim().replace(/^"|"$/g, "").trim();
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/**
 * Parse a cost string like "$0.50" / "1,234.56" to a number. Port of parse_cost:
 * strip '$' and ',', then 0 for empty / "NaN" / values with no ASCII digit
 * (e.g. "Included", "-"). Negative results are clamped to 0 by the caller.
 */
function parseCost(costStr: string): number {
  const cleaned = costStr.replace(/[$,]/g, "");
  const trimmed = cleaned.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "nan" || !/[0-9]/.test(trimmed)) {
    return 0;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Simple CSV line splitter that respects quoted fields (port of parse_csv_line):
 * a '"' toggles quote state, a ',' outside quotes ends a field. Quote characters
 * are kept in the slice (callers strip surrounding quotes per field), matching
 * the Rust byte-index behavior.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let start = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields.push(line.slice(start, i));
      start = i + 1;
    }
  }
  fields.push(line.slice(start));
  return fields;
}

/** Trim a field and strip a single layer of surrounding double quotes. */
function unquote(field: string): string {
  return field.trim().replace(/^"|"$/g, "");
}

/**
 * Parse a Cursor Date string to epoch ms (port of parse_date_to_timestamp).
 * Tries ISO 8601 with/without ms and trailing Z, then date-only (→ noon UTC so
 * the local date is stable for any tz from UTC-12..UTC+14). Returns null when
 * unparseable (the row is then skipped, matching the Rust ts==0 skip).
 */
function parseDateToMs(dateStr: string): number | null {
  // ISO forms with explicit time: Date.parse handles
  // "YYYY-MM-DDTHH:MM:SS", "...SS.mmm", and either with a trailing "Z".
  if (dateStr.includes("T")) {
    const ms = Date.parse(dateStr);
    return Number.isNaN(ms) ? null : ms;
  }

  // Date-only "YYYY-MM-DD" → noon UTC (12:00:00Z).
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (m !== null) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const ms = Date.UTC(year, month - 1, day, 12, 0, 0, 0);
    return Number.isNaN(ms) ? null : ms;
  }

  return null;
}

/**
 * Pick the column map for a header line (port of the cursor.rs format detect):
 * a "Kind" column with ≥11 total columns is v3; "Kind" with fewer is v2; no
 * "Kind" is v1. Returns null when the header is not a recognizable Cursor CSV
 * (must contain both "Date" and "Model").
 */
function detectColumns(header: string): ColumnMap | null {
  if (!header.includes("Date") || !header.includes("Model")) return null;

  const fields = parseCsvLine(header);
  const hasKind = fields.some((f) => f.trim() === "Kind");
  const columnCount = fields.length;

  if (hasKind && columnCount >= 11) return V3_COLUMNS;
  if (hasKind) return V2_COLUMNS;
  return V1_COLUMNS;
}

/** Parse one cached Cursor CSV file into usage records (port of parse_cursor_file). */
function parseCursorFile(path: string): UsageRecord[] {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return []; // unreadable → fail-open
  }

  const lines = content.split("\n");
  if (lines.length === 0) return [];

  const header = lines[0];
  if (header === undefined) return [];

  const columns = detectColumns(header);
  if (columns === null) return []; // not a Cursor CSV

  const minFields = columns.cost + 1;
  const accountId = accountIdFromPath(path);
  const out: UsageRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine === undefined) continue;
    // Strip a trailing CR (CRLF files) before the empty-line check.
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") continue;

    const fields = parseCsvLine(line);
    if (fields.length < minFields) continue; // not enough columns for this format

    const dateStr = unquote(fields[0] ?? "");
    const model = unquote(fields[columns.model] ?? "");
    if (model === "") continue; // skip empty/errored entries

    const ts = parseDateToMs(dateStr);
    if (ts === null) continue; // unparseable date → skip (Rust ts==0)

    const inputWithCacheWrite = toNonNegInt(fields[columns.inputCacheWrite] ?? "");
    const inputWithoutCacheWrite = toNonNegInt(fields[columns.inputNoCache] ?? "");
    const cacheReadTokens = toNonNegInt(fields[columns.cacheRead] ?? "");
    const outputTokens = toNonNegInt(fields[columns.output] ?? "");
    const cost = Math.max(0, parseCost(unquote(fields[columns.cost] ?? "")));

    // cacheWrite = (w/ cache write) − (w/o cache write), clamped ≥ 0.
    const cacheWrite = Math.max(0, inputWithCacheWrite - inputWithoutCacheWrite);
    const input = Math.max(0, inputWithoutCacheWrite);

    const providerId = inferProvider(model) ?? DEFAULT_PROVIDER;
    // Composite session id is also the implicit dedup key (Cursor has none).
    const sessionId = `cursor-${accountId}-${dateStr}`;

    const tokens: TokenBreakdown = emptyTokens();
    tokens.input = input;
    tokens.output = outputTokens;
    tokens.cacheRead = cacheReadTokens;
    tokens.cacheWrite = cacheWrite;
    // reasoning stays 0 (Cursor does not report it).

    const record: UsageRecord = {
      platformId: PLATFORM_ID,
      modelId: model,
      providerId,
      sessionId,
      tokens,
      cost,
      ts,
      messageCount: 1,
      dedupKey: sessionId,
      confidence: "host-reported",
    };
    out.push(record);
  }

  return out;
}

/** The Cursor synced usage reader singleton. */
const cursorReader: UsageReader = {
  platformId: PLATFORM_ID,
  kind: "synced",
  async read({ sinceMs }: { sinceMs?: number }): Promise<UsageRecord[]> {
    // The cache dir is ~/.config/tokscale/cursor-cache (env override first).
    // Absent → [] so the scan layer reports "requires sync, skipped".
    const root = firstExistingRoot(PLATFORM_ID);
    if (root === undefined) return [];

    // Enumerate cached exports: usage*.csv at the cache root AND any archive/
    // subdir (walkFiles recurses), covering the active + secondary accounts.
    const files = walkFiles(root, (name) => {
      const lower = name.toLowerCase();
      return lower.startsWith("usage") && lower.endsWith(".csv");
    });

    const records: UsageRecord[] = [];
    for (const file of files) {
      const rows = parseCursorFile(file);
      for (const row of rows) {
        if (sinceMs !== undefined && row.ts < sinceMs) continue;
        records.push(row);
      }
    }
    return records;
  },
};

export default cursorReader;
