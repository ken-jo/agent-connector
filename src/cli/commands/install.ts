/**
 * cli/commands/install — deploy a connector across its target platforms.
 *
 * Resolves the connector config (--connector <path>, else findConnectorConfig
 * walking up from the project dir), loads it into a live ResolvedConnector, and
 * hands it to the chosen DELIVERY METHOD's orchestration:
 *
 *   --method direct      (default) — the installer renders each host's native
 *                        MCP + hook + content config in place (zero behavior
 *                        change for existing scripts).
 *   --method marketplace — stage the connector's plugin bundle under the
 *                        data-root and DRIVE the host's own plugin/marketplace
 *                        install flow (v1 driver: claude-code; other hosts get
 *                        never-silent skip/warn records with manual commands).
 *
 * Both methods emit the same ChangeRecords, rendered as a readable diff;
 * --dry-run renders the plan without writing or spawning. A double-install
 * guard (both directions) enforces exactly one method per (connector, host,
 * scope) — a refusal is a `warn` record, so the exit-1-on-warn convention
 * carries over.
 */

import { parseArgs } from "node:util";

import { installConnector } from "../../core/installer.js";
import { installViaMarketplace, parseInstallMethod } from "../../core/marketplace.js";
import { findConnectorConfig, loadConnectorFromPath } from "../../core/load-connector.js";
import { fail, parseScope, parseTargets, print, renderInstallResult } from "../app.js";

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      method: { type: "string", default: "direct" },
      scope: { type: "string", default: "user" },
      targets: { type: "string" },
      connector: { type: "string" },
      project: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      // Memory surface: overwrite USER-EDITED managed blocks (hash drift).
      // Default behavior is warn-and-leave; --force backs the file up first.
      force: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const method = parseInstallMethod(values.method);
  if (method == null) {
    return fail(`invalid --method "${values.method}" (use direct|marketplace)`);
  }

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
  if (method === "marketplace" && scope !== "user") {
    return fail(
      "--method marketplace supports --scope user only (project-scope plugin installs are deferred)",
    );
  }

  const { connector, modulePath } = await loadConnectorFromPath(configPath);
  const targets = parseTargets(values.targets);

  const result =
    method === "marketplace"
      ? await installViaMarketplace({
          connector,
          modulePath,
          scope,
          projectDir,
          dryRun: values["dry-run"],
          ...(targets ? { targets } : {}),
        })
      : await installConnector({
          connector,
          modulePath,
          scope,
          projectDir,
          dryRun: values["dry-run"],
          force: values.force,
          ...(targets ? { targets } : {}),
        });

  print(renderInstallResult(result, "install"));
  return result.changes.some((c) => c.action === "warn") ? 1 : 0;
}
