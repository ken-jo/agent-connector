/**
 * cli/commands/status — a light, glanceable install-state summary.
 *
 * There is NO MCP standard for "which connectors are installed into which host
 * configs on this machine" — distribution/wire standards (server.json, MCPB,
 * the lifecycle) cover publishing + the protocol, not local install state. So
 * `status` is purely agent-connector infrastructure, and we design it for the
 * everyday question it answers in one line per platform:
 *
 *   "which of my connectors are present on which hosts?"
 *
 * It REUSES detect (host enumeration) + the adapters' own config-path resolvers
 * (a read-only presence check) — NO new adapter SPI methods. Unlike `doctor`
 * (deep health checks, non-zero exit on failure) and `doctor --probe` (a live
 * protocol probe that FAILs on a dead server), `status` ALWAYS exits 0: it
 * describes, it never gates. A connector being absent is informational.
 */

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";

import type { InstallScope, PlatformId, ResolvedConnector } from "../../core/types.js";
import type { InstallContext } from "../../adapters/spi.js";
import { detectInstalledPlatforms } from "../../adapters/detect.js";
import { loadAdapter } from "../../adapters/registry.js";
import {
  findConnectorConfig,
  listRegisteredConnectors,
  loadConnectorFromPath,
} from "../../core/load-connector.js";
import { dataRoot, homeBinPath } from "../../core/paths.js";
import { fail, parseScope, print } from "../app.js";

/**
 * Resolve which connector(s) status reports on: an explicit --connector path or
 * a local config first, else every connector registered under the data-root
 * (what is actually installed). Empty array when none — status still lists the
 * detected platforms.
 */
async function resolveConnectors(
  connectorPath: string | undefined,
  projectDir: string,
): Promise<ResolvedConnector[]> {
  const configPath = connectorPath ?? findConnectorConfig(projectDir);
  if (configPath) {
    try {
      const { connector } = await loadConnectorFromPath(configPath);
      return [connector];
    } catch {
      /* fall through to the registry */
    }
  }
  return listRegisteredConnectors();
}

function buildContext(
  connector: ResolvedConnector,
  id: PlatformId,
  scope: InstallScope,
  projectDir: string,
): InstallContext {
  return {
    connector,
    scope: connector.platforms[id]?.scope ?? scope,
    projectDir,
    homeBinPath: homeBinPath(),
    dataRoot: dataRoot(),
    dryRun: true,
  };
}

/** Read-only: does the file at `path` mention `needle`? Missing/unreadable → false. */
function fileMentions(path: string, needle: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(needle);
  } catch {
    return false;
  }
}

interface ConnStatus {
  id: string;
  serverPresent: boolean;
  hooksPresent: boolean;
}
interface StatusRow {
  platform: PlatformId;
  scope: InstallScope;
  configPath: string;
  connectors: ConnStatus[];
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      scope: { type: "string", default: "user" },
      connector: { type: "string" },
      project: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const projectDir = values.project ?? process.cwd();
  const scope = parseScope(values.scope);
  if (scope == null) return fail(`invalid --scope "${values.scope}" (use user|project)`);

  const connectors = await resolveConnectors(values.connector, projectDir);
  const detected = await detectInstalledPlatforms(projectDir);

  const rows: StatusRow[] = [];
  for (const p of detected) {
    const adapter = await loadAdapter(p.id);
    if (!adapter) continue;
    const connStatuses: ConnStatus[] = connectors.map((connector) => {
      const ctx = buildContext(connector, p.id, scope, projectDir);
      let serverPath = "";
      let hookPath = "";
      try {
        serverPath = adapter.getServerConfigPath(ctx);
      } catch {
        /* adapter has no server config path */
      }
      try {
        hookPath = adapter.getHookConfigPath(ctx);
      } catch {
        /* adapter has no hook config path */
      }
      return {
        id: connector.id,
        serverPresent: serverPath ? fileMentions(serverPath, connector.id) : false,
        hooksPresent: hookPath ? fileMentions(hookPath, connector.id) : false,
      };
    });
    rows.push({
      platform: p.id,
      scope: p.scope,
      configPath: p.configPath,
      connectors: connStatuses,
    });
  }

  if (values.json) {
    print(JSON.stringify(rows, null, 2));
    return 0;
  }

  if (rows.length === 0) {
    print("status: no agent platforms detected.");
    return 0;
  }
  if (connectors.length === 0) {
    print("status: no connectors found (pass --connector <path> or install one).\n");
  }

  for (const r of rows) {
    print(`${r.platform}  [${r.scope}]  ${r.configPath}`);
    if (r.connectors.length === 0) {
      print("  (no connectors to check)");
    } else {
      for (const c of r.connectors) {
        const mark = c.serverPresent || c.hooksPresent ? "[installed]" : "[absent   ]";
        const server = c.serverPresent ? "server ✓" : "server ·";
        const hooks = c.hooksPresent ? "hooks ✓" : "hooks ·";
        print(`  ${mark} ${c.id}  ${server}  ${hooks}`);
      }
    }
    print("");
  }

  // Always 0: status is descriptive (what is installed where), never a gate —
  // that contrast with doctor (non-zero on FAIL) is the reason it exists.
  return 0;
}
