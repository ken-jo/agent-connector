/**
 * cli/commands/uninstall — strip a connector's registrations, method-aware.
 *
 * The connector id is taken from --connector-id, or inferred from the local
 * connector config (--connector <path> / findConnectorConfig).
 *
 * --method auto (default) reverses WHATEVER is actually there, per target:
 * targets with marketplace evidence (the state record, or the host's own plugin
 * state) get the HOST plugin uninstall; everything else gets the existing
 * direct adapter strip. Install chooses a method (a user decision); uninstall
 * reverses what exists (a state decision) — and since the double-install guard
 * enforces exactly one method per (connector, host, scope), auto is
 * unambiguous. Explicit --method direct|marketplace forces one path for every
 * target. Config removal vs plugin uninstall is therefore method-resolved:
 * never both, never neither.
 *
 * --purge additionally removes the framework-state this connector left behind:
 * its DATA-dir connector record (connectorDir(id)), the empty marketplace
 * staging root, and, when no connectors remain, the shared home-bin launcher.
 * Without --purge those linger so the connector can be re-synced without
 * re-registering.
 */

import { parseArgs } from "node:util";

import {
  purgeFrameworkState,
  resolveUninstallTargets,
  uninstallConnector,
} from "../../core/installer.js";
import {
  marketplaceEvidence,
  parseUninstallMethod,
  uninstallViaMarketplace,
} from "../../core/marketplace.js";
import { readMarketplaceInstalls } from "../../core/marketplace-state.js";
import { findConnectorConfig, loadConnectorFromPath } from "../../core/load-connector.js";
import type { InstallResult, PlatformId } from "../../core/types.js";
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
      method: { type: "string", default: "auto" },
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

  const method = parseUninstallMethod(values.method);
  if (method == null) {
    return fail(`invalid --method "${values.method}" (use auto|direct|marketplace)`);
  }

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
        "--connector <path>, or run inside a project with an agent-connector config.",
    );
  }

  const targets = parseTargets(values.targets);
  const dryRun = values["dry-run"];

  // ── Explicit --method marketplace: every target goes to the marketplace path
  // (targets default to the recorded installs); framework purge runs here since
  // no direct pass follows.
  if (method === "marketplace") {
    const result = await uninstallViaMarketplace({
      connectorId,
      projectDir,
      dryRun,
      purge: values.purge,
      ...(targets ? { targets } : {}),
    });
    if (values.purge) purgeFrameworkState(connectorId, dryRun, result);
    print(renderInstallResult(result, "uninstall"));
    return result.changes.some((c) => c.action === "warn") ? 1 : 0;
  }

  // ── --method auto: partition the resolved targets by marketplace evidence.
  // (--method direct keeps every target on the adapter strip — today's path.)
  let marketplaceTargets: PlatformId[] = [];
  let directTargets: PlatformId[] = [];
  if (method === "auto") {
    const resolved = await resolveUninstallTargets(connectorId, targets, projectDir);
    // With no explicit --targets, recorded marketplace platforms are unioned
    // in: the state record IS the authority for what we installed, and host
    // detection can miss a host whose probe-able config dir was relocated.
    // An explicit --targets list is always respected as-is.
    const recorded = targets
      ? []
      : (Object.keys(readMarketplaceInstalls(connectorId)) as PlatformId[]);
    const candidates = [...new Set([...resolved, ...recorded])];
    marketplaceTargets = candidates.filter(
      (id) => marketplaceEvidence(connectorId, id) != null,
    );
    directTargets = resolved.filter((id) => !marketplaceTargets.includes(id));
  }

  // No marketplace evidence anywhere (or --method direct): exactly today's
  // single-orchestration path, byte-for-byte — zero behavior change for users
  // who never touched the marketplace method.
  if (marketplaceTargets.length === 0) {
    const result = await uninstallConnector({
      connectorId,
      scope,
      projectDir,
      dryRun,
      purge: values.purge,
      ...(targets ? { targets } : {}),
    });
    print(renderInstallResult(result, "uninstall"));
    return result.changes.some((c) => c.action === "warn") ? 1 : 0;
  }

  const results: InstallResult[] = [
    await uninstallViaMarketplace({
      connectorId,
      projectDir,
      targets: marketplaceTargets,
      dryRun,
      purge: values.purge,
    }),
  ];

  // The direct strip runs only for its partition (never both methods on one
  // target). When every target was marketplace-routed, --purge still runs the
  // framework purge (the marketplace records were just cleared, so it can
  // proceed to the connector record + home-bin).
  if (directTargets.length > 0) {
    results.push(
      await uninstallConnector({
        connectorId,
        scope,
        projectDir,
        dryRun,
        purge: values.purge,
        targets: directTargets,
      }),
    );
  } else if (values.purge) {
    const purgeResult: InstallResult = {
      connectorId,
      dryRun,
      changes: [],
      warnings: [],
    };
    if (dryRun) {
      // On a real run the marketplace records are removed BEFORE this purge;
      // calling purgeFrameworkState now would false-refuse on records that the
      // marketplace pass only PLANNED to remove. Report the plan instead.
      purgeResult.changes.push({
        platform: connectorId as PlatformId,
        action: "remove",
        detail:
          "would purge framework state (connector record; home-bin when no connectors remain)",
      });
    } else {
      purgeFrameworkState(connectorId, dryRun, purgeResult);
    }
    results.push(purgeResult);
  }

  const merged: InstallResult = {
    connectorId,
    dryRun,
    changes: results.flatMap((r) => r.changes),
    warnings: results.flatMap((r) => r.warnings),
  };
  print(renderInstallResult(merged, "uninstall"));
  return merged.changes.some((c) => c.action === "warn") ? 1 : 0;
}
