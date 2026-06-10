/**
 * cli/commands/uninstall — strip a connector's MCP + hook registrations.
 *
 * The connector id is taken from --connector-id, or inferred from the local
 * connector config (--connector <path> / findConnectorConfig). The installer's
 * uninstall orchestration loads the registered connector for context and removes
 * its entries from every resolved target.
 *
 * --purge additionally removes the framework-state this connector left behind:
 * its DATA-dir connector record (connectorDir(id)) and, when no connectors
 * remain, the shared home-bin launcher. Without --purge those linger so the
 * connector can be re-synced without re-registering.
 */

import { parseArgs } from "node:util";

import { uninstallConnector } from "../../core/installer.js";
import { findConnectorConfig, loadConnectorFromPath } from "../../core/load-connector.js";
import { fail, parseScope, parseTargets, print, renderInstallResult } from "../app.js";

/** Resolve the connector id from flags, then from a local config file. */
async function resolveConnectorId(
  explicitId: string | undefined,
  connectorPath: string | undefined,
  projectDir: string,
): Promise<string | null> {
  if (explicitId && explicitId.trim() !== "") return explicitId;
  const configPath = connectorPath ?? findConnectorConfig(projectDir);
  if (!configPath) return null;
  const { connector } = await loadConnectorFromPath(configPath);
  return connector.id;
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      scope: { type: "string", default: "user" },
      targets: { type: "string" },
      connector: { type: "string" },
      "connector-id": { type: "string" },
      project: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      purge: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const projectDir = values.project ?? process.cwd();

  const scope = parseScope(values.scope);
  if (scope == null) return fail(`invalid --scope "${values.scope}" (use user|project)`);

  const connectorId = await resolveConnectorId(
    values["connector-id"],
    values.connector,
    projectDir,
  );
  if (!connectorId) {
    return fail(
      "could not determine connector id. Pass --connector-id <id>, " +
        "--connector <path>, or run inside a project with an agentconnect config.",
    );
  }

  const targets = parseTargets(values.targets);

  const result = await uninstallConnector({
    connectorId,
    scope,
    projectDir,
    dryRun: values["dry-run"],
    purge: values.purge,
    ...(targets ? { targets } : {}),
  });

  print(renderInstallResult(result, "uninstall"));
  return result.changes.some((c) => c.action === "warn") ? 1 : 0;
}
