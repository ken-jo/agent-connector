/**
 * cli/commands/leaderboard — the unified top-level `agent-connector leaderboard`.
 *
 * Prints THREE leaderboards, each clearly origin-labeled and NEVER summed:
 *   🔌 MCP / Plugin leaderboard       ← origin `mcp-self`: the serve-proxy
 *        telemetry store (which MCP server WE wrap costs the most — per-MCP `call`
 *        + `tool_defs` rows; the `model_turn` rows are EXCLUDED here).
 *   🖥️  Host / User leaderboard        ← origin `host-scan-logs`: the host usage
 *        readers scanning agent CLI logs (which CLI / host spent the most).
 *   🛰️  Host-native turns (live, exact) ← origin `host-native-live`: the opt-in
 *        AfterModel / PostInvocation usage hook (scope `model_turn`, confidence
 *        host-native) — whole-conversation usage the host reported in real time.
 *
 * All three measure DIFFERENT things (per-MCP server bytes vs whole-conversation
 * usage from logs vs whole-conversation usage from a live hook). They are reported
 * side by side but their totals are NEVER added together.
 *
 * Flags:
 *   --since 7d|24h|…     lower-bound window applied to both sources.
 *   --scope <value>      MCP-section scope slice (user|project|npx|binary|http|…);
 *                        ignored by the host section (host logs carry no scope).
 *   --connector <id>     restrict the 🔌 MCP/plugin + 🛰️ host-native-turns
 *                        sections to ONE connector id. The 🖥️ host-scan section
 *                        is connector-agnostic (host CLI logs carry no connector
 *                        attribution) and is intentionally NOT filtered.
 *   --json               emit { mcp:[...], host:[...] } instead of the tables.
 */

import { parseArgs } from "node:util";

import {
  formatHostNativeTurns,
  formatMcpLeaderboard,
  hostNativeTurns,
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
    print("  --connector <id>   restrict the 🔌 MCP + 🛰️ host-native sections to one connector");
    print("  --json             emit { mcp:[...], host:[...] } (never summed)");
    return 0;
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      since: { type: "string" },
      scope: { type: "string" },
      connector: { type: "string" },
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

  // The optional --connector <id> FILTER restricts the two connector-attributed
  // sections (🔌 MCP/plugin + 🛰️ host-native turns) to one connector. The
  // 🖥️ host-scan section below is intentionally NOT filtered: host CLI logs carry
  // no connector attribution, so it stays connector-agnostic (whole-conversation).
  const connectorId =
    values.connector !== undefined && values.connector.trim() !== ""
      ? values.connector.trim()
      : undefined;

  // 🔌 MCP / Plugin leaderboard — serve-proxy telemetry (origin: mcp-self).
  const mcpOpts: { sinceMs?: number; scope?: ScopeFilter; connectorId?: string } = {};
  if (sinceMs !== undefined) mcpOpts.sinceMs = sinceMs;
  if (scope !== undefined) mcpOpts.scope = scope;
  if (connectorId !== undefined) mcpOpts.connectorId = connectorId;
  const mcp = mcpLeaderboard(mcpOpts);

  // 🖥️ Host / User leaderboard — host usage readers (origin: host-scan-logs).
  // Connector-agnostic by construction: NOT filtered by --connector.
  const hostOpts: { sinceMs?: number } = {};
  if (sinceMs !== undefined) hostOpts.sinceMs = sinceMs;
  const host = await hostLeaderboard(hostOpts);

  // 🛰️ Host-native turns — opt-in AfterModel usage hook (origin: host-native-live).
  // Scope `model_turn` rows ONLY; the MCP section above already excludes them.
  const turnsOpts: { sinceMs?: number; scope?: ScopeFilter; connectorId?: string } = {};
  if (sinceMs !== undefined) turnsOpts.sinceMs = sinceMs;
  if (scope !== undefined) turnsOpts.scope = scope;
  if (connectorId !== undefined) turnsOpts.connectorId = connectorId;
  const turns = hostNativeTurns(turnsOpts);

  if (values.json) {
    // Three separate arrays — by construction the consumer cannot sum origins.
    print(
      JSON.stringify(
        {
          mcp, // origin: mcp-self
          host: host.rows, // origin: host-scan-logs
          hostSkipped: host.skipped,
          hostNativeTurns: turns, // origin: host-native-live (scope model_turn)
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const lines: string[] = [];
  lines.push(
    "🔌 MCP / Plugin leaderboard  (origin: mcp-self — per-MCP server bytes we wrap; " +
      "excludes host-native model_turn rows)",
  );
  if (scope !== undefined) lines.push(`   scope: ${scope}`);
  if (connectorId !== undefined) lines.push(`   connector: ${connectorId}`);
  lines.push("");
  lines.push(formatMcpLeaderboard(mcp));
  lines.push("");
  lines.push(
    "🖥️  Host / User leaderboard  (origin: host-scan-logs — whole-conversation usage from CLI logs)",
  );
  if (connectorId !== undefined) {
    lines.push("   (connector-agnostic — host CLI logs carry no connector attribution; --connector not applied here)");
  }
  lines.push("");
  lines.push(formatHostLeaderboard(host));
  lines.push("");
  lines.push(
    "🛰️  Host-native turns (live, exact)  (origin: host-native-live — opt-in AfterModel usage hook)",
  );
  lines.push("");
  lines.push(formatHostNativeTurns(turns));
  lines.push("");
  lines.push(
    "note: the THREE leaderboards measure DIFFERENT things (per-MCP server bytes vs " +
      "whole-conversation usage from logs vs live host-native turns) and are never " +
      "summed together (their totals are NEVER added across origins).",
  );
  print(lines.join("\n"));
  return 0;
}
