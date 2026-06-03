/**
 * cli/commands/sync — idempotent re-install of a connector.
 *
 * Same resolution + flags as `install`, but calls syncConnector: every adapter
 * re-renders (identical entries report "skip") and the stable home-bin pointer
 * is healed. Use after editing a connector or upgrading the framework.
 */

import { parseArgs } from "node:util";

import { syncConnector } from "../../core/installer.js";
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

  const result = await syncConnector({
    connector,
    modulePath,
    scope,
    projectDir,
    dryRun: values["dry-run"],
    ...(targets ? { targets } : {}),
  });

  print(renderInstallResult(result, "sync"));
  return result.changes.some((c) => c.action === "warn") ? 1 : 0;
}
