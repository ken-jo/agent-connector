/**
 * core/marketplace-drivers/droid — the droid (Factory) marketplace driver.
 *
 * DOCS-ONLY (BATCH 3): no `droid` binary is present on this box, so every
 * host-contract claim below is sourced from Factory's docs rather than a live
 * run. CONFIRM LIVE when a droid binary is available:
 *   • idempotency (we assume the codex model: re-`plugin install` and an absent
 *     `plugin uninstall` are idempotent `=` no-ops, all probe-first);
 *   • the settings.json key shapes (`enabledPlugins["<id>@agent-connector"] ===
 *     true` + `extraKnownMarketplaces["agent-connector"].source` — the local-path
 *     source field shape is undocumented, read defensively in marketplace-state).
 *
 * A CATALOG driver, a direct copy of codex.ts's structure against droid's plugin
 * verbs: `droid plugin marketplace add <stagingRoot>` + `droid plugin install
 * <id>@agent-connector`, with the inverses `droid plugin uninstall
 * <id>@agent-connector` + `droid plugin marketplace remove agent-connector` on
 * uninstall. Every step is PROBE-FIRST: decisions key off droid's own state file
 * (~/.factory/settings.json — read-only) rather than exit codes.
 *
 * Catalog: the FACTORY shape (claude-family.ts factory spec) — the marketplace
 * catalog is a git-repo catalog written at the staging ROOT itself
 * (<stagingRoot>/marketplace.json), NOT under a `.agents/plugins/` subdir like
 * codex. The factory emitter writes a SINGLE-plugin catalog per connector, so
 * the driver regenerates ONE shared catalog there listing every staged plugin.
 * `droid plugin marketplace add <stagingRoot>` therefore points at the root that
 * contains the regenerated catalog. Staged-plugin marker:
 * `<dir>/.factory-plugin/plugin.json`.
 *
 * NAME-COLLISION SAFETY (== codex): a marketplace named "agent-connector"
 * registered at a path OTHER than our staging root belongs to the user; the
 * driver refuses and NEVER removes a registration it did not create.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ChangeRecord, ResolvedConnector } from "../types.js";
import {
  MARKETPLACE_NAME,
  anyDroidAgentConnectorPlugins,
  droidMarketplaceSource,
  droidPluginInstalled,
  droidPluginKey,
  droidStagingRoot,
  hashDirectory,
} from "../marketplace-state.js";
import { ensureDir } from "../paths.js";
import { packageConnector } from "../package.js";
import { findOnPath, firstLine, runHostCommand, samePath } from "./shared.js";
import type { MarketplaceDriveOutcome, MarketplaceDriver } from "./types.js";

const PLATFORM = "droid" as const;

/** Absolute path of the droid CLI on PATH, or null. */
export function droidBinary(): string | null {
  return findOnPath("droid");
}

/** The manual two-step install, printed whenever the driver cannot drive. */
function droidManualInstallCommands(connectorId: string, stagingRoot: string): string {
  return (
    `droid plugin marketplace add ${stagingRoot} && ` +
    `droid plugin install ${droidPluginKey(connectorId)}`
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
// Staging: bundle emit + shared-catalog regeneration. The factory catalog sits
// at the staging ROOT (<stagingRoot>/marketplace.json); staged plugins carry a
// `.factory-plugin/plugin.json` manifest.
// ─────────────────────────────────────────────────────────────────────────

/** Staged plugin dirs (those carrying a .factory-plugin/plugin.json manifest). */
export function stagedDroidPlugins(stagingRoot: string): string[] {
  if (!existsSync(stagingRoot)) return [];
  try {
    return readdirSync(stagingRoot)
      .filter((name) =>
        existsSync(join(stagingRoot, name, ".factory-plugin", "plugin.json")),
      )
      .sort();
  } catch {
    return [];
  }
}

/** Path of the shared factory catalog: <stagingRoot>/marketplace.json (repo root). */
function droidCatalogPath(stagingRoot: string): string {
  return join(stagingRoot, "marketplace.json");
}

/**
 * Regenerate the ONE shared catalog listing every staged connector
 * (content-stable; rewritten only on an actual change). Factory shape — the same
 * minimal { name, owner, plugins:[{name,source,description}] } the emitter
 * writes, but covering EVERY staged plugin (the per-connector emit overwrites it
 * with a single entry, so the driver re-expands it here).
 */
export function regenerateDroidCatalog(stagingRoot: string, changes: ChangeRecord[]): void {
  const catalogPath = droidCatalogPath(stagingRoot);
  const plugins = stagedDroidPlugins(stagingRoot).map((name) => {
    let description = `${name} — connector emitted by agent-connector`;
    try {
      const manifest = JSON.parse(
        readFileSync(join(stagingRoot, name, ".factory-plugin", "plugin.json"), "utf8"),
      ) as { description?: string };
      if (typeof manifest.description === "string") description = manifest.description;
    } catch {
      /* keep the default description */
    }
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
  ensureDir(stagingRoot);
  writeFileSync(catalogPath, serialized, "utf8");
  changes.push({
    platform: PLATFORM,
    action: existing == null ? "create" : "update",
    path: catalogPath,
    detail: `regenerated shared marketplace catalog (${plugins.length} plugin(s))`,
  });
}

/** Stage (or re-stage) the connector's factory-plugin bundle in the shared root. */
export function stageDroidBundle(
  connector: ResolvedConnector,
  changes: ChangeRecord[],
): { pluginDir: string; contentHash: string } {
  const stagingRoot = droidStagingRoot();
  const pluginDir = join(stagingRoot, connector.id);
  const existed = existsSync(pluginDir);
  const result = packageConnector(connector, { outDir: stagingRoot, format: "factory-plugin" });
  changes.push({
    platform: PLATFORM,
    action: existed ? "update" : "create",
    path: pluginDir,
    detail: `staged marketplace bundle (${result.files.length} files, factory-plugin)`,
  });
  regenerateDroidCatalog(stagingRoot, changes);
  return { pluginDir, contentHash: hashDirectory(pluginDir) };
}

// ─────────────────────────────────────────────────────────────────────────
// Host driving (probe-first, never throws)
// ─────────────────────────────────────────────────────────────────────────

async function driveInstall(connectorId: string): Promise<MarketplaceDriveOutcome> {
  const stagingRoot = droidStagingRoot();
  const changes: ChangeRecord[] = [];
  const pluginKey = droidPluginKey(connectorId);

  const bin = droidBinary();
  if (!bin) {
    changes.push(
      warn(
        `droid CLI not found on PATH — bundle staged but not installed. ` +
          `Install manually: ${droidManualInstallCommands(connectorId, stagingRoot)}`,
        stagingRoot,
      ),
    );
    return { changes, ok: false };
  }

  // Marketplace registration (probe-first + name-collision refusal).
  const registeredAt = droidMarketplaceSource(MARKETPLACE_NAME);
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
          `(droid plugin marketplace remove ${MARKETPLACE_NAME}) or install manually: ` +
          droidManualInstallCommands(connectorId, stagingRoot),
      ),
    );
    return { changes, ok: false };
  } else {
    const add = await runHostCommand(bin, ["plugin", "marketplace", "add", stagingRoot]);
    // Probe-first: trust settings.json over the exit code. Only fail when the
    // source did NOT land on our root. samePath: win32 extended-length safety.
    if (!samePath(droidMarketplaceSource(MARKETPLACE_NAME), stagingRoot)) {
      changes.push(
        warn(
          `could not register the local marketplace — ` +
            failDetail("droid plugin marketplace add", add) +
            `. Install manually: ${droidManualInstallCommands(connectorId, stagingRoot)}`,
          stagingRoot,
        ),
      );
      return { changes, ok: false };
    }
    changes.push({
      platform: PLATFORM,
      action: "create",
      path: stagingRoot,
      detail: `registered local marketplace "${MARKETPLACE_NAME}" (droid plugin marketplace add)`,
    });
  }

  // Plugin install (probe-first).
  if (droidPluginInstalled(connectorId)) {
    changes.push({
      platform: PLATFORM,
      action: "skip",
      detail: `plugin ${pluginKey} already installed`,
    });
    return { changes, ok: true };
  }
  const install = await runHostCommand(bin, ["plugin", "install", pluginKey]);
  if (!install.ok || !droidPluginInstalled(connectorId)) {
    changes.push(
      warn(`plugin install did not complete — ` + failDetail(`droid plugin install ${pluginKey}`, install)),
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
  const pluginKey = droidPluginKey(connectorId);

  if (!droidPluginInstalled(connectorId)) {
    changes.push({
      platform: PLATFORM,
      action: "skip",
      detail: `plugin ${pluginKey} not installed on droid`,
    });
    return { changes, ok: true };
  }

  const bin = droidBinary();
  if (!bin) {
    changes.push(
      warn(
        `droid CLI not found on PATH — cannot drive the uninstall. ` +
          `Run manually: droid plugin uninstall ${pluginKey}`,
      ),
    );
    return { changes, ok: false };
  }

  const remove = await runHostCommand(bin, ["plugin", "uninstall", pluginKey]);
  if (!remove.ok || droidPluginInstalled(connectorId)) {
    changes.push(
      warn(`plugin uninstall did not complete — ` + failDetail(`droid plugin uninstall ${pluginKey}`, remove)),
    );
    return { changes, ok: false };
  }
  changes.push({
    platform: PLATFORM,
    action: "remove",
    detail: `uninstalled plugin ${pluginKey} (droid plugin uninstall)`,
  });
  return { changes, ok: true };
}

/**
 * Remove OUR marketplace registration (callers must have verified safe ordering:
 * catalog empty + no surviving @agent-connector plugins + the registration
 * points at our staging root).
 */
async function driveMarketplaceRemove(stagingRoot: string): Promise<ChangeRecord[]> {
  const bin = droidBinary();
  if (!bin) {
    return [
      warn(
        `droid CLI not found on PATH — marketplace registration "${MARKETPLACE_NAME}" left behind. ` +
          `Run manually: droid plugin marketplace remove ${MARKETPLACE_NAME}`,
        stagingRoot,
      ),
    ];
  }
  const remove = await runHostCommand(bin, ["plugin", "marketplace", "remove", MARKETPLACE_NAME]);
  if (!remove.ok && droidMarketplaceSource(MARKETPLACE_NAME) != null) {
    return [
      warn(
        `could not remove the marketplace registration — ` +
          failDetail(`droid plugin marketplace remove ${MARKETPLACE_NAME}`, remove),
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
// droidDriver: the MarketplaceDriver the orchestrator dispatches through.
// ─────────────────────────────────────────────────────────────────────────

export const droidDriver: MarketplaceDriver = {
  platform: PLATFORM,
  format: "factory-plugin",

  binary: droidBinary,
  stagingRoot: droidStagingRoot,
  pluginDir(id) {
    return join(droidStagingRoot(), id);
  },
  installed: droidPluginInstalled,

  stage(connector, changes) {
    return stageDroidBundle(connector, changes).contentHash;
  },

  planInstall(connector, changes) {
    const stagingRoot = droidStagingRoot();
    const registered = samePath(droidMarketplaceSource(MARKETPLACE_NAME), stagingRoot);
    changes.push({
      platform: PLATFORM,
      action: registered ? "skip" : "create",
      path: stagingRoot,
      detail: registered
        ? `marketplace "${MARKETPLACE_NAME}" already registered`
        : `run: droid plugin marketplace add ${stagingRoot}`,
    });
    changes.push({
      platform: PLATFORM,
      action: droidPluginInstalled(connector.id) ? "skip" : "create",
      detail: droidPluginInstalled(connector.id)
        ? `plugin ${droidPluginKey(connector.id)} already installed`
        : `run: droid plugin install ${droidPluginKey(connector.id)}`,
    });
  },

  planUninstall(id, changes) {
    const stagingRoot = droidStagingRoot();
    const pluginDir = join(stagingRoot, id);
    const pluginKey = droidPluginKey(id);
    changes.push({
      platform: PLATFORM,
      action: droidPluginInstalled(id) ? "remove" : "skip",
      detail: droidPluginInstalled(id)
        ? `run: droid plugin uninstall ${pluginKey}`
        : `plugin ${pluginKey} not installed on droid`,
    });
    if (existsSync(pluginDir)) {
      changes.push({
        platform: PLATFORM,
        action: "remove",
        path: pluginDir,
        detail: "remove staged marketplace bundle",
      });
    }
    const othersStaged = stagedDroidPlugins(stagingRoot).some((n) => n !== id);
    if (!othersStaged && samePath(droidMarketplaceSource(MARKETPLACE_NAME), stagingRoot)) {
      changes.push({
        platform: PLATFORM,
        action: "remove",
        path: stagingRoot,
        detail: `run: droid plugin marketplace remove ${MARKETPLACE_NAME} (when no plugins remain)`,
      });
    }
  },

  driveInstall,
  driveUninstall,

  // droid has no documented `plugin update` verb — update IS re-stage (done by
  // the caller) + `plugin install`, assumed idempotent + version-cached (DOCS-only).
  async driveUpdate(id): Promise<MarketplaceDriveOutcome> {
    return driveInstall(id);
  },

  async finishUninstall(id, changes): Promise<void> {
    const stagingRoot = droidStagingRoot();
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
    if (existsSync(stagingRoot)) regenerateDroidCatalog(stagingRoot, changes);

    const nothingStaged = stagedDroidPlugins(stagingRoot).length === 0;
    if (
      nothingStaged &&
      !anyDroidAgentConnectorPlugins() &&
      samePath(droidMarketplaceSource(MARKETPLACE_NAME), stagingRoot)
    ) {
      changes.push(...(await driveMarketplaceRemove(stagingRoot)));
    }
  },
};
