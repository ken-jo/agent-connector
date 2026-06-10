/**
 * cli/commands/telemetry — inspect the local per-tool token telemetry store.
 *
 * Subcommands:
 *   report  --by tool|session|project (default tool)  --since 7d|24h|… --connector <id> [--json]
 *           → summarize(openStore({}), …) + formatReport (the aligned table).
 *   export  --format csv|json (default json)  --out <file>  [--since/--connector …]
 *           → toCSV / toJSONExport of the raw records.
 *
 * Telemetry rows are aggregate counts only (never raw arguments/results).
 */

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import type { QueryFilter } from "../../telemetry/types.js";
import type { RollupDimension } from "../../telemetry/report.js";
import { openStore } from "../../telemetry/store.js";
import { summarize, toCSV, toJSONExport } from "../../telemetry/report.js";
import {
  formatMcpLeaderboard,
  formatSurfaceLeaderboard,
  formatToolLeaderboard,
  isScopeFilter,
  mcpLeaderboard,
  SCOPE_FILTER_VALUES,
  surfaceLeaderboard,
  toolLeaderboard,
  type LeaderboardOptions,
  type ScopeFilter,
  type SurfaceLeaderboardOptions,
} from "../../telemetry/leaderboard.js";
import {
  connectorFromMeta,
  listRegisteredConnectors,
  loadRegisteredConnector,
  readRegisteredMeta,
} from "../../core/load-connector.js";
import type { ResolvedConnector } from "../../core/types.js";
import { fail, print } from "../app.js";

/**
 * Parse a relative duration (`Ns`/`Nm`/`Nh`/`Nd`) to a lower-bound epoch ms.
 * Returns undefined for an empty input and null for a malformed one.
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

/** Build a QueryFilter from the shared --since / --connector flags. */
function buildFilter(
  since: string | undefined,
  connectorId: string | undefined,
): QueryFilter | null {
  const sinceMs = parseSince(since);
  if (sinceMs === null) return null;
  const filter: QueryFilter = {};
  if (sinceMs !== undefined) filter.sinceMs = sinceMs;
  if (connectorId && connectorId.trim() !== "") filter.connectorId = connectorId;
  return filter;
}

function runReport(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      by: { type: "string", default: "tool" },
      since: { type: "string" },
      connector: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const by = values.by;
  if (by !== "tool" && by !== "session" && by !== "project") {
    return fail(`invalid --by "${by}" (use tool|session|project)`);
  }
  const dimension: RollupDimension = by;

  const filter = buildFilter(values.since, values.connector);
  if (filter === null) {
    return fail(`invalid --since "${values.since}" (use forms like 30s, 15m, 24h, 7d)`);
  }

  const store = openStore({});
  try {
    const { rows, text } = summarize(store, { by: dimension, filter });
    if (values.json) {
      print(JSON.stringify(rows, null, 2));
    } else {
      print(text);
    }
  } finally {
    store.close();
  }
  return 0;
}

function runExport(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      format: { type: "string", default: "json" },
      out: { type: "string" },
      since: { type: "string" },
      connector: { type: "string" },
    },
    allowPositionals: false,
  });

  const format = values.format;
  if (format !== "csv" && format !== "json") {
    return fail(`invalid --format "${format}" (use csv|json)`);
  }

  const filter = buildFilter(values.since, values.connector);
  if (filter === null) {
    return fail(`invalid --since "${values.since}" (use forms like 30s, 15m, 24h, 7d)`);
  }

  const store = openStore({});
  let serialized: string;
  try {
    const records = store.query(filter);
    serialized = format === "csv" ? toCSV(records) : toJSONExport(records);
  } finally {
    store.close();
  }

  if (values.out && values.out.trim() !== "") {
    writeFileSync(values.out, serialized, "utf8");
    print(`wrote ${format.toUpperCase()} export → ${values.out}`);
  } else {
    print(serialized);
  }
  return 0;
}

/**
 * `telemetry leaderboard` — rank the per-MCP telemetry by connector (--by mcp,
 * the default and signature "which MCP server costs the most" metric), by tool
 * (--by tool), or by developer-axis surface (--by surface — the FIVE surfaces:
 * server + hook runtime rows plus static command/skill/subagent footprints).
 * Honors --since / --connector and the scope slice (--scope).
 */
async function runLeaderboard(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      by: { type: "string", default: "mcp" },
      since: { type: "string" },
      connector: { type: "string" },
      scope: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const by = values.by;
  if (by !== "mcp" && by !== "tool" && by !== "surface") {
    return fail(`invalid --by "${by}" (use mcp|tool|surface)`);
  }

  const sinceMs = parseSince(values.since);
  if (sinceMs === null) {
    return fail(`invalid --since "${values.since}" (use forms like 30s, 15m, 24h, 7d)`);
  }

  let scope: ScopeFilter | undefined;
  if (values.scope !== undefined && values.scope.trim() !== "") {
    const s = values.scope.trim();
    if (!isScopeFilter(s)) {
      return fail(`invalid --scope "${s}" (use ${SCOPE_FILTER_VALUES.join("|")})`);
    }
    scope = s;
  }

  const opts: LeaderboardOptions = {};
  if (sinceMs !== undefined) opts.sinceMs = sinceMs;
  if (values.connector && values.connector.trim() !== "") {
    opts.connectorId = values.connector.trim();
  }
  if (scope !== undefined) opts.scope = scope;

  if (by === "tool") {
    const rows = toolLeaderboard(opts);
    print(values.json ? JSON.stringify(rows, null, 2) : formatToolLeaderboard(rows));
  } else if (by === "surface") {
    // The per-surface view folds the STATIC command/skill/subagent footprints of
    // the registered connector(s) into the runtime server/hook rows.
    const connectorId = values.connector?.trim();
    const surfaceOpts: SurfaceLeaderboardOptions = {
      ...opts,
      connectors: await gatherConnectors(connectorId),
    };
    const rows = surfaceLeaderboard(surfaceOpts);
    print(values.json ? JSON.stringify(rows, null, 2) : formatSurfaceLeaderboard(rows));
  } else {
    const rows = mcpLeaderboard(opts);
    print(values.json ? JSON.stringify(rows, null, 2) : formatMcpLeaderboard(rows));
  }
  return 0;
}

/**
 * Gather the registered connector(s) whose STATIC command/skill/subagent
 * footprints feed the per-surface view. When `connectorId` is given, prefer the
 * LIVE module (freshest content) and fall back to the persisted meta record;
 * otherwise enumerate every registered connector from its meta. Best-effort: a
 * connector that cannot be loaded is skipped (the surface view still renders the
 * runtime rows it can read from the store).
 */
async function gatherConnectors(
  connectorId: string | undefined,
): Promise<ResolvedConnector[]> {
  if (connectorId !== undefined && connectorId !== "") {
    try {
      return [await loadRegisteredConnector(connectorId)];
    } catch {
      const meta = readRegisteredMetaSafe(connectorId);
      return meta ? [connectorFromMeta(meta)] : [];
    }
  }
  return listRegisteredConnectors();
}

/** readRegisteredMeta wrapped so a missing/corrupt record never throws here. */
function readRegisteredMetaSafe(id: string): ReturnType<typeof readRegisteredMeta> {
  try {
    return readRegisteredMeta(id);
  } catch {
    return null;
  }
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
      return await runLeaderboard(rest);
    case undefined:
    case "--help":
    case "-h":
      print("usage: agentconnect telemetry <report|export|leaderboard> [flags]");
      print("  report       --by tool|session|project  --since 7d  --connector <id>  --json");
      print("  export       --format csv|json  --out <file>  --since 7d  --connector <id>");
      print("  leaderboard  --by mcp|tool|surface  --since 7d  --connector <id>  --scope <slice>  --json");
      return sub === undefined ? 1 : 0;
    default:
      return fail(`unknown telemetry subcommand "${sub}" (use report|export|leaderboard)`);
  }
}
