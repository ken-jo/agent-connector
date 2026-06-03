/**
 * cli/commands/leaderboard — the unified top-level `agent-connector leaderboard`.
 *
 * Prints BOTH leaderboards, each clearly origin-labeled and NEVER summed:
 *   🔌 MCP / Plugin leaderboard   ← from the serve-proxy telemetry store
 *                                   (which MCP server WE wrap costs the most).
 *   🖥️  Host / User leaderboard    ← from the host usage readers
 *                                   (which CLI / host spent the most).
 * They measure different things (server bytes vs whole-conversation usage), so
 * the two sections are reported side by side but their totals are never added.
 *
 * Flags:
 *   --since 7d|24h|…   lower-bound window applied to both sources.
 *   --scope <value>    MCP-section scope slice (user|project|npx|binary|http|…);
 *                      ignored by the host section (host logs carry no scope).
 *   --json             emit { mcp:[...], host:[...] } instead of the tables.
 */

import { parseArgs } from "node:util";

import {
  formatMcpLeaderboard,
  isScopeFilter,
  mcpLeaderboard,
  SCOPE_FILTER_VALUES,
  type ScopeFilter,
} from "../../telemetry/leaderboard.js";
import { formatHostLeaderboard, hostLeaderboard } from "../../usage/leaderboard.js";
import { fail, print } from "../app.js";

/**
 * Parse a relative duration (`Ns`/`Nm`/`Nh`/`Nd`) to a lower-bound epoch ms.
 * Returns undefined for empty input and null for a malformed one. (Kept local so
 * the leaderboard command stays decoupled from the report commands.)
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

export async function run(argv: string[]): Promise<number> {
  const first = argv[0];
  if (first === "--help" || first === "-h") {
    print("usage: agent-connector leaderboard [flags]");
    print("  --since 7d|24h|…   window applied to BOTH sources");
    print(`  --scope <value>    MCP-section slice (${SCOPE_FILTER_VALUES.join("|")})`);
    print("  --json             emit { mcp:[...], host:[...] } (never summed)");
    return 0;
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      since: { type: "string" },
      scope: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

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

  // 🔌 MCP / Plugin leaderboard — serve-proxy telemetry (origin: mcp-self).
  const mcpOpts: { sinceMs?: number; scope?: ScopeFilter } = {};
  if (sinceMs !== undefined) mcpOpts.sinceMs = sinceMs;
  if (scope !== undefined) mcpOpts.scope = scope;
  const mcp = mcpLeaderboard(mcpOpts);

  // 🖥️ Host / User leaderboard — host usage readers (origin: host-native).
  const hostOpts: { sinceMs?: number } = {};
  if (sinceMs !== undefined) hostOpts.sinceMs = sinceMs;
  const host = await hostLeaderboard(hostOpts);

  if (values.json) {
    // Two separate arrays — by construction the consumer cannot sum origins.
    print(
      JSON.stringify(
        {
          mcp,
          host: host.rows,
          hostSkipped: host.skipped,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const lines: string[] = [];
  lines.push("🔌 MCP / Plugin leaderboard  (origin: mcp-self — server bytes we wrap)");
  if (scope !== undefined) lines.push(`   scope: ${scope}`);
  lines.push("");
  lines.push(formatMcpLeaderboard(mcp));
  lines.push("");
  lines.push("🖥️  Host / User leaderboard  (origin: host-native — whole-conversation usage)");
  lines.push("");
  lines.push(formatHostLeaderboard(host));
  lines.push("");
  lines.push(
    "note: the two leaderboards measure DIFFERENT things (MCP-server bytes vs " +
      "whole-conversation usage) and are never summed together.",
  );
  print(lines.join("\n"));
  return 0;
}
