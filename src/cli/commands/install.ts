/**
 * cli/commands/install — deploy a connector across its target platforms.
 *
 * Resolves the connector config (--connector <path>, else findConnectorConfig
 * walking up from the project dir), loads it into a live ResolvedConnector, and
 * hands it to the installer orchestration. The resulting ChangeRecords are
 * rendered as a readable diff; --dry-run renders the plan without writing.
 */

import { parseArgs } from "node:util";

import { installConnector } from "../../core/installer.js";
import { findConnectorConfig, loadConnectorFromPath } from "../../core/load-connector.js";
import { fail, parseScope, parseTargets, print, renderInstallResult } from "../app.js";

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      scope: { type: "string", default: "user" },
      targets: { type: "string" },
      connector: { type: "string" },
      project: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const projectDir = values.project ?? process.cwd();
  const configPath = values.connector ?? findConnectorConfig(projectDir);
  if (!configPath) {
    return fail(
      "no connector config found. Pass --connector <path> or add an " +
        "agent-connector.config.{mjs,js,json} to your project.",
    );
  }

  const scope = parseScope(values.scope);
  if (scope == null) return fail(`invalid --scope "${values.scope}" (use user|project)`);

  const { connector, modulePath } = await loadConnectorFromPath(configPath);
  const targets = parseTargets(values.targets);

  const result = await installConnector({
    connector,
    modulePath,
    scope,
    projectDir,
    dryRun: values["dry-run"],
    ...(targets ? { targets } : {}),
  });

  print(renderInstallResult(result, "install"));
  return result.changes.some((c) => c.action === "warn") ? 1 : 0;
}
