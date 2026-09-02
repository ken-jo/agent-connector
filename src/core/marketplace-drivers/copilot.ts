/**
 * core/marketplace-drivers/copilot — the GitHub Copilot CLI marketplace driver.
 *
 * A CATALOG driver, mirroring claude.ts/codex.ts against copilot-cli's plugin
 * verbs (live-verified on GitHub Copilot CLI 1.0.63): `copilot plugin marketplace
 * add <stagingRoot>` + `copilot plugin install <id>@agent-connector`, with the
 * inverses `copilot plugin uninstall <id>@agent-connector` + `copilot plugin
 * marketplace remove agent-connector` on uninstall. Every step is PROBE-FIRST:
 * decisions key off Copilot's own state files (read-only) rather than exit codes,
 * so re-runs are idempotent `=` skips and an uninstall of an absent plugin can
 * never error (live-verified: `marketplace add` of an already-registered name
 * exits 1, `plugin install` is idempotent exit 0, `plugin uninstall` /
 * `marketplace remove` of an absent object exit 1 — all sidestepped by probing).
 *
 * State files (live-verified, ~/.copilot):
 *   • config.json   — JSONC, `installedPlugins: [{ name, marketplace, … }]` is
 *                     the DEFINITIVE install probe (copilotPluginInstalled).
 *   • settings.json — `extraKnownMarketplaces.agent-connector.source.path`
 *                     records the registered local marketplace dir
 *                     (copilotMarketplaceSource — presence + collision check).
 *
 * The staged bundle is the `agent-plugin` format — the Agent Plugins 1.0.0
 * package Copilot CLI, VS Code and the Copilot app all read (hooks, agents and
 * commands ride in the `com.github.copilot/` namespace; the shared
 * `.claude-plugin/marketplace.json` catalog is still what `marketplace add`
 * resolves plugins through). Live-verified on GitHub Copilot CLI 1.0.80:
 * `plugin marketplace add` + `plugin install` accept it as-is. VS Code
 * auto-discovers what the CLI installed under ~/.copilot/installed-plugins.
 *
 * NAME-COLLISION SAFETY (== claude/codex): a marketplace named "agent-connector"
 * registered at a path OTHER than our staging root belongs to the user; the
 * driver refuses and NEVER removes a registration it did not create.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ChangeRecord, ResolvedConnector } from "../types.js";
import {
  MARKETPLACE_NAME,
  anyCopilotAgentConnectorPlugins,
  copilotMarketplaceSource,
  copilotPluginInstalled,
  copilotPluginKey,
  copilotStagingRoot,
  hashDirectory,
} from "../marketplace-state.js";
import { ensureDir } from "../paths.js";
import { packageConnector } from "../package.js";
import { readAgentPluginManifest } from "../package-formats/agent-plugin.js";
import { findOnPath, firstLine, runHostCommand, samePath } from "./shared.js";
import type { MarketplaceDriveOutcome, MarketplaceDriver } from "./types.js";

const PLATFORM = "copilot-cli" as const;
const FORMAT = "agent-plugin" as const;

/** Absolute path of the copilot CLI on PATH, or null. */
export function copilotBinary(): string | null {
  return findOnPath("copilot");
}

/** The manual two-step install, printed whenever the driver cannot drive. */
function copilotManualInstallCommands(connectorId: string, stagingRoot: string): string {
  return (
    `copilot plugin marketplace add ${stagingRoot} && ` +
    `copilot plugin install ${copilotPluginKey(connectorId)}`
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function warn(detail: string, path?: string): ChangeRecord {
  return { platform: PLATFORM, action: "warn", detail, ...(path ? { path } : {}) };
}

function failDetail(
  step: string,
  r: { code: number | null; stderr: string; stdout: string; timedOut: boolean; error?: string },
): string {
  if (r.timedOut) return `${step} timed out`;
  if (r.error) return `${step} failed to spawn: ${r.error}`;
  const line = firstLine(r.stderr) || firstLine(r.stdout);
  return `${step} exited ${r.code}${line ? `: ${line}` : ""}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Staging: bundle emit + shared-catalog regeneration. Copilot reads the same
// `.claude-plugin/marketplace.json` catalog as claude (live-verified), and the
// staged plugins carry a root Agent Plugins `plugin.json`.
// ─────────────────────────────────────────────────────────────────────────

/** The staged plugin's Agent Plugins manifest, or null when absent/foreign. */
function stagedManifest(
  stagingRoot: string,
  name: string,
): { description?: string } | null {
  try {
    return readAgentPluginManifest(readFileSync(join(stagingRoot, name, "plugin.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Staged plugin dirs (those carrying a root Agent Plugins plugin.json manifest). */
export function stagedCopilotPlugins(stagingRoot: string): string[] {
  if (!existsSync(stagingRoot)) return [];
  try {
    return readdirSync(stagingRoot)
      .filter((name) => stagedManifest(stagingRoot, name) !== null)
      .sort();
  } catch {
    return [];
  }
}

/** Path of the shared catalog: <stagingRoot>/.claude-plugin/marketplace.json. */
function copilotCatalogPath(stagingRoot: string): string {
  return join(stagingRoot, ".claude-plugin", "marketplace.json");
}

/**
 * Regenerate the ONE shared catalog listing every staged connector
 * (content-stable; rewritten only on an actual change). Same shape as claude's.
 */
export function regenerateCopilotCatalog(stagingRoot: string, changes: ChangeRecord[]): void {
  const catalogPath = copilotCatalogPath(stagingRoot);
  const plugins = stagedCopilotPlugins(stagingRoot).map((name) => {
    const manifest = stagedManifest(stagingRoot, name);
    const description =
      typeof manifest?.description === "string"
        ? manifest.description
        : `${name} — connector emitted by agent-connector`;
    return { name, source: `./${name}`, description };
  });
  const catalog = { name: MARKETPLACE_NAME, owner: { name: MARKETPLACE_NAME }, plugins };
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

/** Stage (or re-stage) the connector's agent-plugin bundle in the shared root. */
export function stageCopilotBundle(
  connector: ResolvedConnector,
  changes: ChangeRecord[],
): { pluginDir: string; contentHash: string } {
  const stagingRoot = copilotStagingRoot();
  const pluginDir = join(stagingRoot, connector.id);
  const existed = existsSync(pluginDir);
  const result = packageConnector(connector, {
    outDir: stagingRoot,
    format: FORMAT,
    hostHint: PLATFORM,
  });
  changes.push({
    platform: PLATFORM,
    action: existed ? "update" : "create",
    path: pluginDir,
    detail: `staged marketplace bundle (${result.files.length} files, ${FORMAT})`,
  });
  regenerateCopilotCatalog(stagingRoot, changes);
  return { pluginDir, contentHash: hashDirectory(pluginDir) };
}

// ─────────────────────────────────────────────────────────────────────────
// Host driving (probe-first, never throws)
// ─────────────────────────────────────────────────────────────────────────

async function driveInstall(connectorId: string): Promise<MarketplaceDriveOutcome> {
  const stagingRoot = copilotStagingRoot();
  const changes: ChangeRecord[] = [];
  const pluginKey = copilotPluginKey(connectorId);

  const bin = copilotBinary();
  if (!bin) {
    changes.push(
      warn(
        `copilot CLI not found on PATH — bundle staged but not installed. ` +
          `Install manually: ${copilotManualInstallCommands(connectorId, stagingRoot)}`,
        stagingRoot,
      ),
    );
    return { changes, ok: false };
  }

  // Marketplace registration (probe-first + name-collision refusal). Copilot has
  // no `plugin validate` verb — `marketplace add` validates the bundle itself,
  // and rejects re-adding an already-registered name (exit 1), so we MUST probe.
  const registeredAt = copilotMarketplaceSource(MARKETPLACE_NAME);
  if (samePath(registeredAt, stagingRoot)) {
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
          `(copilot plugin marketplace remove ${MARKETPLACE_NAME}) or install manually: ` +
          copilotManualInstallCommands(connectorId, stagingRoot),
      ),
    );
    return { changes, ok: false };
  } else {
    const add = await runHostCommand(bin, ["plugin", "marketplace", "add", stagingRoot]);
    // Probe-first: trust settings.json over the exit code. Only fail when the
    // source did NOT land on our root.
    if (!samePath(copilotMarketplaceSource(MARKETPLACE_NAME), stagingRoot)) {
      changes.push(
        warn(
          `could not register the local marketplace — ` +
            failDetail("copilot plugin marketplace add", add) +
            `. Install manually: ${copilotManualInstallCommands(connectorId, stagingRoot)}`,
          stagingRoot,
        ),
      );
      return { changes, ok: false };
    }
    changes.push({
      platform: PLATFORM,
      action: "create",
      path: stagingRoot,
      detail: `registered local marketplace "${MARKETPLACE_NAME}" (copilot plugin marketplace add)`,
    });
  }

  // Plugin install (probe-first).
  if (copilotPluginInstalled(connectorId)) {
    changes.push({
      platform: PLATFORM,
      action: "skip",
      detail: `plugin ${pluginKey} already installed`,
    });
    return { changes, ok: true };
  }
  const install = await runHostCommand(bin, ["plugin", "install", pluginKey]);
  if (!install.ok || !copilotPluginInstalled(connectorId)) {
    changes.push(
      warn(`plugin install did not complete — ` + failDetail(`copilot plugin install ${pluginKey}`, install)),
    );
    return { changes, ok: false };
  }
  changes.push({
    platform: PLATFORM,
    action: "create",
    detail: `installed plugin ${pluginKey} (scope user)`,
  });
  return { changes, ok: true };
}

async function driveUninstall(connectorId: string): Promise<MarketplaceDriveOutcome> {
  const changes: ChangeRecord[] = [];
  const pluginKey = copilotPluginKey(connectorId);

  if (!copilotPluginInstalled(connectorId)) {
    changes.push({
      platform: PLATFORM,
      action: "skip",
      detail: `plugin ${pluginKey} not installed on copilot-cli`,
    });
    return { changes, ok: true };
  }

  const bin = copilotBinary();
  if (!bin) {
    changes.push(
      warn(
        `copilot CLI not found on PATH — cannot drive the uninstall. ` +
          `Run manually: copilot plugin uninstall ${pluginKey}`,
      ),
    );
    return { changes, ok: false };
  }

  const remove = await runHostCommand(bin, ["plugin", "uninstall", pluginKey]);
  if (!remove.ok || copilotPluginInstalled(connectorId)) {
    changes.push(
      warn(`plugin uninstall did not complete — ` + failDetail(`copilot plugin uninstall ${pluginKey}`, remove)),
    );
    return { changes, ok: false };
  }
  changes.push({
    platform: PLATFORM,
    action: "remove",
    detail: `uninstalled plugin ${pluginKey} (copilot plugin uninstall)`,
  });
  return { changes, ok: true };
}

/**
 * Remove OUR marketplace registration (callers must have verified safe ordering:
 * catalog empty + no surviving @agent-connector plugins + the registration
 * points at our staging root).
 */
async function driveMarketplaceRemove(stagingRoot: string): Promise<ChangeRecord[]> {
  const bin = copilotBinary();
  if (!bin) {
    return [
      warn(
        `copilot CLI not found on PATH — marketplace registration "${MARKETPLACE_NAME}" left behind. ` +
          `Run manually: copilot plugin marketplace remove ${MARKETPLACE_NAME}`,
        stagingRoot,
      ),
    ];
  }
  const remove = await runHostCommand(bin, ["plugin", "marketplace", "remove", MARKETPLACE_NAME]);
  if (!remove.ok && copilotMarketplaceSource(MARKETPLACE_NAME) != null) {
    return [
      warn(
        `could not remove the marketplace registration — ` +
          failDetail(`copilot plugin marketplace remove ${MARKETPLACE_NAME}`, remove),
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

// ─────────────────────────────────────────────────────────────────────────
// copilotDriver: the MarketplaceDriver the orchestrator dispatches through.
// ─────────────────────────────────────────────────────────────────────────

export const copilotDriver: MarketplaceDriver = {
  platform: PLATFORM,
  format: FORMAT,

  binary: copilotBinary,
  stagingRoot: copilotStagingRoot,
  pluginDir(id) {
    return join(copilotStagingRoot(), id);
  },
  installed: copilotPluginInstalled,

  stage(connector, changes) {
    return stageCopilotBundle(connector, changes).contentHash;
  },

  planInstall(connector, changes) {
    const stagingRoot = copilotStagingRoot();
    const registered = samePath(copilotMarketplaceSource(MARKETPLACE_NAME), stagingRoot);
    changes.push({
      platform: PLATFORM,
      action: registered ? "skip" : "create",
      path: stagingRoot,
      detail: registered
        ? `marketplace "${MARKETPLACE_NAME}" already registered`
        : `run: copilot plugin marketplace add ${stagingRoot}`,
    });
    changes.push({
      platform: PLATFORM,
      action: copilotPluginInstalled(connector.id) ? "skip" : "create",
      detail: copilotPluginInstalled(connector.id)
        ? `plugin ${copilotPluginKey(connector.id)} already installed`
        : `run: copilot plugin install ${copilotPluginKey(connector.id)}`,
    });
  },

  planUninstall(id, changes) {
    const stagingRoot = copilotStagingRoot();
    const pluginDir = join(stagingRoot, id);
    const pluginKey = copilotPluginKey(id);
    changes.push({
      platform: PLATFORM,
      action: copilotPluginInstalled(id) ? "remove" : "skip",
      detail: copilotPluginInstalled(id)
        ? `run: copilot plugin uninstall ${pluginKey}`
        : `plugin ${pluginKey} not installed on copilot-cli`,
    });
    if (existsSync(pluginDir)) {
      changes.push({
        platform: PLATFORM,
        action: "remove",
        path: pluginDir,
        detail: "remove staged marketplace bundle",
      });
    }
    const othersStaged = stagedCopilotPlugins(stagingRoot).some((n) => n !== id);
    if (!othersStaged && samePath(copilotMarketplaceSource(MARKETPLACE_NAME), stagingRoot)) {
      changes.push({
        platform: PLATFORM,
        action: "remove",
        path: stagingRoot,
        detail: `run: copilot plugin marketplace remove ${MARKETPLACE_NAME} (when no plugins remain)`,
      });
    }
  },

  driveInstall,
  driveUninstall,

  // Copilot has no `plugin update` verb — update IS re-stage (done by the caller)
  // + `plugin install`, which is idempotent and version-cached (same caveat as
  // claude/codex: bump connector.version for the new copy to win).
  async driveUpdate(id): Promise<MarketplaceDriveOutcome> {
    return driveInstall(id);
  },

  async finishUninstall(id, changes): Promise<void> {
    const stagingRoot = copilotStagingRoot();
    const pluginDir = join(stagingRoot, id);

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
    if (existsSync(stagingRoot)) regenerateCopilotCatalog(stagingRoot, changes);

    const nothingStaged = stagedCopilotPlugins(stagingRoot).length === 0;
    if (
      nothingStaged &&
      !anyCopilotAgentConnectorPlugins() &&
      samePath(copilotMarketplaceSource(MARKETPLACE_NAME), stagingRoot)
    ) {
      changes.push(...(await driveMarketplaceRemove(stagingRoot)));
    }
  },
};
