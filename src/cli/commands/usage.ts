/**
 * cli/commands/usage — inspect HOST-native token usage parsed from each agent
 * CLI's own session logs/DBs (the read-only complement to `telemetry`, which
 * measures the MCP server's own bytes — the two are NOT summed: they measure
 * different things).
 *
 * Subcommands:
 *   report  --by platform|project|session|model|day (default platform)
 *           --since 7d|24h|… --platform <id> [--json]
 *           → scanUsage → aggregateBy → formatUsageReport (prints skip notes).
 *   export  --format csv|json (default json)  --out <file>
 *           --since 7d  --platform <id>
 *           → deduped UsageRecord[] to CSV/JSON.
 *
 * Usage rows are aggregate counts only (never raw prompts/results) and the layer
 * is strictly read-only — it parses host logs, it never writes host config.
 */

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import type { PlatformId } from "../../core/types.js";
import type { UsageGroupBy } from "../../usage/types.js";
import { aggregateBy } from "../../usage/aggregate.js";
import { formatUsageReport, usageToCSV, usageToJSON } from "../../usage/report.js";
import { formatHostLeaderboard, hostLeaderboard } from "../../usage/leaderboard.js";
import { scanUsage } from "../../usage/scan.js";
import { fail, print } from "../app.js";

/**
 * Parse a relative duration (`Ns`/`Nm`/`Nh`/`Nd`) to a lower-bound epoch ms.
 * Returns undefined for empty input and null for a malformed one. (Mirrors
 * telemetry.ts parseSince — kept local so the two commands stay decoupled.)
 */
export function parseSince(since: string | undefined): number | null | undefined {
  if (since == null || since.trim() === "") return undefined;
  const m = since.trim().match(/^(\d+)\s*([smhd])$/i);
  if (!m || !m[1] || !m[2]) return null;
  const n = Number(m[1]);
  const unitMs: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  const factor = unitMs[m[2].toLowerCase()];
  if (factor == null) return null;
  return Date.now() - n * factor;
}

const GROUP_BY_VALUES: ReadonlySet<string> = new Set([
  "platform",
  "project",
  "session",
  "model",
  "day",
]);

/** Build the scan options shared by report/export from --since / --platform. */
function buildScanOpts(
  since: string | undefined,
  platform: string | undefined,
): { sinceMs?: number; platforms?: PlatformId[] } | null {
  const sinceMs = parseSince(since);
  if (sinceMs === null) return null;
  const opts: { sinceMs?: number; platforms?: PlatformId[] } = {};
  if (sinceMs !== undefined) opts.sinceMs = sinceMs;
  if (platform && platform.trim() !== "") opts.platforms = [platform.trim() as PlatformId];
  return opts;
}

async function runReport(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      by: { type: "string", default: "platform" },
      since: { type: "string" },
      platform: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const by = values.by;
  if (!GROUP_BY_VALUES.has(by ?? "")) {
    return fail(`invalid --by "${by}" (use platform|project|session|model|day)`);
  }
  const dimension = by as UsageGroupBy;

  const scanOpts = buildScanOpts(values.since, values.platform);
  if (scanOpts === null) {
    return fail(`invalid --since "${values.since}" (use forms like 30s, 15m, 24h, 7d)`);
  }

  const { records, skipped } = await scanUsage(scanOpts);
  const rows = aggregateBy(records, dimension);

  if (values.json) {
    print(JSON.stringify({ by: dimension, rows, skipped }, null, 2));
  } else {
    print(formatUsageReport(rows, dimension, skipped));
  }
  return 0;
}

async function runExport(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      format: { type: "string", default: "json" },
      out: { type: "string" },
      since: { type: "string" },
      platform: { type: "string" },
    },
    allowPositionals: false,
  });

  const format = values.format;
  if (format !== "csv" && format !== "json") {
    return fail(`invalid --format "${format}" (use csv|json)`);
  }

  const scanOpts = buildScanOpts(values.since, values.platform);
  if (scanOpts === null) {
    return fail(`invalid --since "${values.since}" (use forms like 30s, 15m, 24h, 7d)`);
  }

  const { records } = await scanUsage(scanOpts);
  const serialized = format === "csv" ? usageToCSV(records) : usageToJSON(records);

  if (values.out && values.out.trim() !== "") {
    writeFileSync(values.out, serialized, "utf8");
    print(`wrote ${format.toUpperCase()} export → ${values.out}`);
  } else {
    print(serialized);
  }
  return 0;
}

/**
 * `usage leaderboard` — the HOST / USER leaderboard: rank host usage by platform
 * (--by platform, the default "which CLI/host spent the most") or by model
 * (--by model). Honors --since / --platform; notes synced/host-estimated rows.
 */
async function runLeaderboard(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      by: { type: "string", default: "platform" },
      since: { type: "string" },
      platform: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const by = values.by;
  if (by !== "platform" && by !== "model") {
    return fail(`invalid --by "${by}" (use platform|model)`);
  }

  const scanOpts = buildScanOpts(values.since, values.platform);
  if (scanOpts === null) {
    return fail(`invalid --since "${values.since}" (use forms like 30s, 15m, 24h, 7d)`);
  }

  const lbOpts: { by: "platform" | "model"; sinceMs?: number; platforms?: PlatformId[] } = {
    by,
  };
  if (scanOpts.sinceMs !== undefined) lbOpts.sinceMs = scanOpts.sinceMs;
  if (scanOpts.platforms !== undefined) lbOpts.platforms = scanOpts.platforms;

  const result = await hostLeaderboard(lbOpts);

  if (values.json) {
    print(JSON.stringify({ by: result.by, rows: result.rows, skipped: result.skipped }, null, 2));
  } else {
    print(formatHostLeaderboard(result));
  }
  return 0;
}

export async function run(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case "report":
      return runReport(rest);
    case "export":
      return runExport(rest);
    case "leaderboard":
      return runLeaderboard(rest);
    case undefined:
    case "--help":
    case "-h":
      print("usage: agentconnect usage <report|export|leaderboard> [flags]");
      print("  report       --by platform|project|session|model|day  --since 7d  --platform <id>  --json");
      print("  export       --format csv|json  --out <file>  --since 7d  --platform <id>");
      print("  leaderboard  --by platform|model  --since 7d  --platform <id>  --json");
      return sub === undefined ? 1 : 0;
    default:
      return fail(`unknown usage subcommand "${sub}" (use report|export|leaderboard)`);
  }
}
