/**
 * core/marketplace-drivers/claude — the Claude Code marketplace driver.
 *
 * Drives the host's OWN plugin lifecycle against a LOCAL directory marketplace
 * (first-class in Claude's docs): `claude plugin marketplace add <stagingRoot>`
 * + `claude plugin install <id>@agent-connector`, with the exact inverses on
 * uninstall. Every step is PROBE-FIRST: decisions key off Claude's own state
 * files (installed_plugins.json / known_marketplaces.json — read-only) rather
 * than exit codes, so re-runs are idempotent `=` skips and `uninstall` of an
 * absent plugin can never error (live-verified: re-add / re-install exit 0,
 * uninstall/remove of an absent object exit 1).
 *
 * NAME-COLLISION SAFETY: a marketplace named "agent-connector" registered at a
 * path OTHER than our staging root belongs to the user. The driver refuses with
 * instructions and NEVER runs `marketplace remove` on a registration it did not
 * create (Claude uninstalls that marketplace's plugins on last-scope removal).
 *
 * All spawns inherit process.env, so CLAUDE_CONFIG_DIR/HOME isolation flows
 * through to the host CLI naturally (the isolated-home test contract).
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ChangeRecord, ResolvedConnector } from "../types.js";
import {
  MARKETPLACE_NAME,
  anyClaudeAgentConnectorPlugins,
  claudeKnownMarketplacePath,
  claudePluginInstalled,
  claudePluginKey,
  claudeStagingRoot,
  hashDirectory,
} from "../marketplace-state.js";
import { ensureDir } from "../paths.js";
import { packageConnector } from "../package.js";
import { findOnPath, firstLine, runHostCommand } from "./shared.js";
import type { MarketplaceDriveOutcome, MarketplaceDriver } from "./types.js";

const PLATFORM = "claude-code" as const;

/** Absolute path of the claude CLI on PATH, or null (drivers ship behind detection). */
export function claudeBinary(): string | null {
  return findOnPath("claude");
}

/** The manual two-step install, printed whenever the driver cannot drive. */
export function claudeManualInstallCommands(
  connectorId: string,
  stagingRoot: string,
): string {
  return (
    `claude plugin marketplace add ${stagingRoot} && ` +
    `claude plugin install ${claudePluginKey(connectorId)}`
  );
}

function warn(detail: string, path?: string): ChangeRecord {
  return { platform: PLATFORM, action: "warn", detail, ...(path ? { path } : {}) };
}

function failDetail(step: string, r: { code: number | null; stderr: string; stdout: string; timedOut: boolean; error?: string }): string {
  if (r.timedOut) return `${step} timed out`;
  if (r.error) return `${step} failed to spawn: ${r.error}`;
  const line = firstLine(r.stderr) || firstLine(r.stdout);
  return `${step} exited ${r.code}${line ? `: ${line}` : ""}`;
}

/** Outcome of {@link claudeDriveInstall}. */
export interface ClaudeInstallOutcome {
  changes: ChangeRecord[];
  /** True when the plugin is installed in Claude's state after this run. */
  installed: boolean;
}

/**
 * Drive the host install for an ALREADY-STAGED bundle:
 * validate (best-effort) → register the staging-root marketplace (probe-first,
 * collision-safe) → install the plugin (probe-first). Never throws; failures
 * become `warn` records and `installed: false`.
 */
export async function claudeDriveInstall(
  connectorId: string,
  stagingRoot: string,
  pluginDir: string,
): Promise<ClaudeInstallOutcome> {
  const changes: ChangeRecord[] = [];
  const pluginKey = claudePluginKey(connectorId);

  const bin = claudeBinary();
  if (!bin) {
    changes.push(
      warn(
        `claude CLI not found on PATH — bundle staged but not installed. ` +
          `Install manually: ${claudeManualInstallCommands(connectorId, stagingRoot)}`,
        stagingRoot,
      ),
    );
    return { changes, installed: false };
  }

  // Best-effort pre-install validation (live-verified against our bundles).
  const validation = await runHostCommand(bin, ["plugin", "validate", pluginDir]);
  if (!validation.ok && !validation.error) {
    changes.push(
      warn(
        `bundle failed \`claude plugin validate\` — not installing. ` +
          failDetail("validate", validation),
        pluginDir,
      ),
    );
    return { changes, installed: false };
  }

  // Marketplace registration (probe-first + name-collision refusal).
  const registeredAt = claudeKnownMarketplacePath(MARKETPLACE_NAME);
  if (registeredAt === stagingRoot) {
    changes.push({
      platform: PLATFORM,
      action: "skip",
      path: stagingRoot,
      detail: `marketplace "${MARKETPLACE_NAME}" already registered`,
    });
  } else if (registeredAt != null) {
    changes.push(
      warn(
        `a marketplace named "${MARKETPLACE_NAME}" is already registered at ${registeredAt} ` +
          `(not ours) — refusing to touch it. Remove it first ` +
          `(claude plugin marketplace remove ${MARKETPLACE_NAME}) or install manually: ` +
          claudeManualInstallCommands(connectorId, stagingRoot),
      ),
    );
    return { changes, installed: false };
  } else {
    const add = await runHostCommand(bin, [
      "plugin",
      "marketplace",
      "add",
      stagingRoot,
    ]);
    if (!add.ok) {
      changes.push(
        warn(
          `could not register the local marketplace — ` +
            failDetail("claude plugin marketplace add", add) +
            `. Install manually: ${claudeManualInstallCommands(connectorId, stagingRoot)}`,
          stagingRoot,
        ),
      );
      return { changes, installed: false };
    }
    changes.push({
      platform: PLATFORM,
      action: "create",
      path: stagingRoot,
      detail: `registered local marketplace "${MARKETPLACE_NAME}" (claude plugin marketplace add)`,
    });
  }

  // Plugin install (probe-first).
  if (claudePluginInstalled(connectorId)) {
    changes.push({
      platform: PLATFORM,
      action: "skip",
      detail: `plugin ${pluginKey} already installed`,
    });
    return { changes, installed: true };
  }
  const install = await runHostCommand(bin, ["plugin", "install", pluginKey]);
  if (!install.ok || !claudePluginInstalled(connectorId)) {
    changes.push(
      warn(
        `plugin install did not complete — ` +
          failDetail(`claude plugin install ${pluginKey}`, install),
      ),
    );
    return { changes, installed: false };
  }
  changes.push({
    platform: PLATFORM,
    action: "create",
    detail: `installed plugin ${pluginKey} (scope user)`,
  });
  return { changes, installed: true };
}

/** Outcome of {@link claudeDriveUninstall}. */
export interface ClaudeUninstallOutcome {
  changes: ChangeRecord[];
  /** True when the plugin is absent from Claude's state after this run. */
  removed: boolean;
}

/**
 * Drive the host uninstall (probe-first: absent → `=` skip, never an error —
 * Claude exits 1 uninstalling an absent plugin, which a probe-first driver
 * never has to see).
 */
export async function claudeDriveUninstall(
  connectorId: string,
): Promise<ClaudeUninstallOutcome> {
  const changes: ChangeRecord[] = [];
  const pluginKey = claudePluginKey(connectorId);

  if (!claudePluginInstalled(connectorId)) {
    changes.push({
      platform: PLATFORM,
      action: "skip",
      detail: `plugin ${pluginKey} not installed on claude-code`,
    });
    return { changes, removed: true };
  }

  const bin = claudeBinary();
  if (!bin) {
    changes.push(
      warn(
        `claude CLI not found on PATH — cannot drive the uninstall. ` +
          `Run manually: claude plugin uninstall ${pluginKey}`,
      ),
    );
    return { changes, removed: false };
  }

  const uninstall = await runHostCommand(bin, ["plugin", "uninstall", pluginKey]);
  if (!uninstall.ok || claudePluginInstalled(connectorId)) {
    changes.push(
      warn(`plugin uninstall did not complete — ` + failDetail(`claude plugin uninstall ${pluginKey}`, uninstall)),
    );
    return { changes, removed: false };
  }
  changes.push({
    platform: PLATFORM,
    action: "remove",
    detail: `uninstalled plugin ${pluginKey} (claude plugin uninstall)`,
  });
  return { changes, removed: true };
}

/**
 * Remove OUR marketplace registration (callers must have verified the safe
 * ordering first: catalog empty + no surviving @agent-connector plugins + the
 * registration points at our staging root).
 */
export async function claudeDriveMarketplaceRemove(
  stagingRoot: string,
): Promise<ChangeRecord[]> {
  const bin = claudeBinary();
  if (!bin) {
    return [
      warn(
        `claude CLI not found on PATH — marketplace registration "${MARKETPLACE_NAME}" left behind. ` +
          `Run manually: claude plugin marketplace remove ${MARKETPLACE_NAME}`,
        stagingRoot,
      ),
    ];
  }
  const remove = await runHostCommand(bin, [
    "plugin",
    "marketplace",
    "remove",
    MARKETPLACE_NAME,
  ]);
  if (!remove.ok) {
    return [
      warn(
        `could not remove the marketplace registration — ` +
          failDetail(`claude plugin marketplace remove ${MARKETPLACE_NAME}`, remove),
        stagingRoot,
      ),
    ];
  }
  return [
    {
      platform: PLATFORM,
      action: "remove",
      path: stagingRoot,
      detail: `removed marketplace registration "${MARKETPLACE_NAME}" (no plugins remain)`,
    },
  ];
}

/**
 * Drive `claude plugin update` for an already-re-staged bundle; on a CLI
 * without the verb (older releases) fall back to a recorded uninstall+install
 * pair, per the design.
 */
export async function claudeDriveUpdate(
  connectorId: string,
  stagingRoot: string,
  pluginDir: string,
): Promise<ClaudeInstallOutcome> {
  const pluginKey = claudePluginKey(connectorId);
  const bin = claudeBinary();
  if (!bin) {
    return {
      changes: [
        warn(
          `claude CLI not found on PATH — bundle re-staged but the installed copy was not updated. ` +
            `Run manually: claude plugin update ${pluginKey}`,
          stagingRoot,
        ),
      ],
      installed: false,
    };
  }
  if (!claudePluginInstalled(connectorId)) {
    // Not installed → an update IS an install.
    return claudeDriveInstall(connectorId, stagingRoot, pluginDir);
  }
  const update = await runHostCommand(bin, ["plugin", "update", pluginKey]);
  if (update.ok) {
    return {
      changes: [
        {
          platform: PLATFORM,
          action: "update",
          detail: `updated plugin ${pluginKey} (claude plugin update)`,
        },
      ],
      installed: true,
    };
  }
  // Fallback: uninstall + reinstall (older CLIs without `plugin update`).
  const changes: ChangeRecord[] = [
    warn(
      `\`claude plugin update\` did not complete (` +
        failDetail("update", update) +
        `) — falling back to uninstall + install`,
    ),
  ];
  const un = await claudeDriveUninstall(connectorId);
  changes.push(...un.changes);
  if (!un.removed) return { changes, installed: claudePluginInstalled(connectorId) };
  const re = await claudeDriveInstall(connectorId, stagingRoot, pluginDir);
  changes.push(...re.changes);
  return { changes, installed: re.installed };
}

// ─────────────────────────────────────────────────────────────────────────
// Staging: bundle emit + shared-catalog regeneration (moved here from the
// orchestrator so all claude-specific logic lives behind the driver).
// ─────────────────────────────────────────────────────────────────────────

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Staged plugin dirs (those carrying a .claude-plugin/plugin.json manifest). */
export function stagedClaudePlugins(stagingRoot: string): string[] {
  if (!existsSync(stagingRoot)) return [];
  try {
    return readdirSync(stagingRoot)
      .filter((name) =>
        existsSync(join(stagingRoot, name, ".claude-plugin", "plugin.json")),
      )
      .sort();
  } catch {
    return [];
  }
}

/**
 * Regenerate the ONE shared catalog listing every staged connector (solves the
 * multi-connector marketplace-name collision a per-bundle catalog would cause).
 * Content-stable: rewritten only when the serialized catalog actually changed.
 */
export function regenerateClaudeCatalog(
  stagingRoot: string,
  changes: ChangeRecord[],
): void {
  const catalogPath = join(stagingRoot, ".claude-plugin", "marketplace.json");
  const plugins = stagedClaudePlugins(stagingRoot).map((name) => {
    let description = `${name} — connector emitted by agent-connector`;
    try {
      const manifest = JSON.parse(
        readFileSync(join(stagingRoot, name, ".claude-plugin", "plugin.json"), "utf8"),
      ) as { description?: string };
      if (typeof manifest.description === "string") description = manifest.description;
    } catch {
      /* keep the default description */
    }
    return { name, source: `./${name}`, description };
  });
  const catalog = {
    name: MARKETPLACE_NAME,
    owner: { name: MARKETPLACE_NAME },
    plugins,
  };
  const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
  let existing: string | null = null;
  try {
    existing = readFileSync(catalogPath, "utf8");
  } catch {
    /* absent */
  }
  if (existing === serialized) return; // content-stable: no record, no write
  ensureDir(dirname(catalogPath));
  writeFileSync(catalogPath, serialized, "utf8");
  changes.push({
    platform: PLATFORM,
    action: existing == null ? "create" : "update",
    path: catalogPath,
    detail: `regenerated shared marketplace catalog (${plugins.length} plugin(s))`,
  });
}

/** Stage (or re-stage) the connector's claude-plugin bundle in the shared root. */
export function stageClaudeBundle(
  connector: ResolvedConnector,
  changes: ChangeRecord[],
): { pluginDir: string; contentHash: string } {
  const stagingRoot = claudeStagingRoot();
  const pluginDir = join(stagingRoot, connector.id);
  const existed = existsSync(pluginDir);
  const result = packageConnector(connector, {
    outDir: stagingRoot,
    format: "claude-plugin",
  });
  changes.push({
    platform: PLATFORM,
    action: existed ? "update" : "create",
    path: pluginDir,
    detail: `staged marketplace bundle (${result.files.length} files, claude-plugin)`,
  });
  regenerateClaudeCatalog(stagingRoot, changes);
  return { pluginDir, contentHash: hashDirectory(pluginDir) };
}

// ─────────────────────────────────────────────────────────────────────────
// claudeDriver: the MarketplaceDriver implementation the orchestrator dispatches
// through. Wraps the functions above into the shared interface.
// ─────────────────────────────────────────────────────────────────────────

export const claudeDriver: MarketplaceDriver = {
  platform: PLATFORM,
  format: "claude-plugin",

  binary: claudeBinary,
  stagingRoot: claudeStagingRoot,
  pluginDir(id) {
    return join(claudeStagingRoot(), id);
  },
  installed: claudePluginInstalled,

  stage(connector, changes) {
    return stageClaudeBundle(connector, changes).contentHash;
  },

  planInstall(connector, changes) {
    const stagingRoot = claudeStagingRoot();
    const registeredAt = claudeKnownMarketplacePath(MARKETPLACE_NAME);
    changes.push({
      platform: PLATFORM,
      action: registeredAt === stagingRoot ? "skip" : "create",
      path: stagingRoot,
      detail:
        registeredAt === stagingRoot
          ? `marketplace "${MARKETPLACE_NAME}" already registered`
          : `run: claude plugin marketplace add ${stagingRoot}`,
    });
    changes.push({
      platform: PLATFORM,
      action: claudePluginInstalled(connector.id) ? "skip" : "create",
      detail: claudePluginInstalled(connector.id)
        ? `plugin ${claudePluginKey(connector.id)} already installed`
        : `run: claude plugin install ${claudePluginKey(connector.id)}`,
    });
  },

  planUninstall(id, changes) {
    const stagingRoot = claudeStagingRoot();
    const pluginDir = join(stagingRoot, id);
    const pluginKey = claudePluginKey(id);
    changes.push({
      platform: PLATFORM,
      action: claudePluginInstalled(id) ? "remove" : "skip",
      detail: claudePluginInstalled(id)
        ? `run: claude plugin uninstall ${pluginKey}`
        : `plugin ${pluginKey} not installed on claude-code`,
    });
    if (existsSync(pluginDir)) {
      changes.push({
        platform: PLATFORM,
        action: "remove",
        path: pluginDir,
        detail: "remove staged marketplace bundle",
      });
    }
    const othersStaged = stagedClaudePlugins(stagingRoot).some((n) => n !== id);
    if (!othersStaged && claudeKnownMarketplacePath(MARKETPLACE_NAME) === stagingRoot) {
      changes.push({
        platform: PLATFORM,
        action: "remove",
        path: stagingRoot,
        detail: `run: claude plugin marketplace remove ${MARKETPLACE_NAME} (when no plugins remain)`,
      });
    }
  },

  async driveInstall(id): Promise<MarketplaceDriveOutcome> {
    const stagingRoot = claudeStagingRoot();
    const out = await claudeDriveInstall(id, stagingRoot, join(stagingRoot, id));
    return { changes: out.changes, ok: out.installed };
  },

  async driveUninstall(id): Promise<MarketplaceDriveOutcome> {
    const out = await claudeDriveUninstall(id);
    return { changes: out.changes, ok: out.removed };
  },

  async driveUpdate(id): Promise<MarketplaceDriveOutcome> {
    const stagingRoot = claudeStagingRoot();
    const out = await claudeDriveUpdate(id, stagingRoot, join(stagingRoot, id));
    return { changes: out.changes, ok: out.installed };
  },

  async finishUninstall(id, changes): Promise<void> {
    const stagingRoot = claudeStagingRoot();
    const pluginDir = join(stagingRoot, id);

    // Remove the staged bundle, then regenerate the catalog without this id.
    if (existsSync(pluginDir)) {
      try {
        rmSync(pluginDir, { recursive: true, force: true });
        changes.push({
          platform: PLATFORM,
          action: "remove",
          path: pluginDir,
          detail: "removed staged marketplace bundle",
        });
      } catch (err) {
        changes.push({
          platform: PLATFORM,
          action: "warn",
          path: pluginDir,
          detail: `could not remove staged bundle: ${errMessage(err)}`,
        });
      }
    }
    if (existsSync(stagingRoot)) regenerateClaudeCatalog(stagingRoot, changes);

    // De-register OUR marketplace only when nothing of ours remains anywhere
    // (safe ordering: plugins are gone first, so Claude's "removing a
    // marketplace uninstalls its plugins" behavior cannot bite a survivor) and
    // ONLY when the registration actually points at our staging root.
    const nothingStaged = stagedClaudePlugins(stagingRoot).length === 0;
    if (
      nothingStaged &&
      !anyClaudeAgentConnectorPlugins() &&
      claudeKnownMarketplacePath(MARKETPLACE_NAME) === stagingRoot
    ) {
      changes.push(...(await claudeDriveMarketplaceRemove(stagingRoot)));
    }
  },
};
