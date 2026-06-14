/**
 * core/marketplace-drivers/codex — the Codex CLI marketplace driver.
 *
 * A CATALOG driver, mirroring claude.ts closely against codex-cli's plugin
 * verbs (live-verified 0.139.0): `codex plugin marketplace add <stagingRoot>` +
 * `codex plugin add <id>@agent-connector`, with the inverses `codex plugin
 * remove <id>@agent-connector` + `codex plugin marketplace remove
 * agent-connector` on uninstall. Every step is PROBE-FIRST: decisions key off
 * Codex's own state file (<CODEX_HOME>/config.toml — read-only) rather than exit
 * codes, so re-runs are idempotent `=` skips.
 *
 * Differences from claude (docs/research/codex-agy-marketplace-mechanics.md):
 *   • catalog dir is `.agents/plugins` (codex REJECTS a `.codex-plugin/`
 *     catalog); staged plugin marker is `<dir>/.codex-plugin/plugin.json`;
 *   • install verb `plugin add` (not `plugin install`); remove verb
 *     `plugin remove` (not `plugin uninstall`);
 *   • state lives in TOML config.toml ([plugins."<id>@agent-connector"] +
 *     [marketplaces.agent-connector].source), CODEX_HOME env (not
 *     CLAUDE_CONFIG_DIR);
 *   • NO `plugin validate` verb (marketplace add validates) and NO `plugin
 *     update` verb — update = re-stage + `plugin add` (version-cached, so bump
 *     connector.version for the new copy to win, same caveat as claude).
 *
 * NAME-COLLISION SAFETY (== claude): a marketplace named "agent-connector"
 * registered at a path OTHER than our staging root belongs to the user; the
 * driver refuses and NEVER removes a registration it did not create.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ChangeRecord, ResolvedConnector } from "../types.js";
import {
  MARKETPLACE_NAME,
  anyCodexAgentConnectorPlugins,
  codexMarketplaceSource,
  codexPluginInstalled,
  codexPluginKey,
  codexStagingRoot,
  hashDirectory,
} from "../marketplace-state.js";
import { ensureDir } from "../paths.js";
import { packageConnector } from "../package.js";
import { findOnPath, firstLine, runHostCommand, samePath } from "./shared.js";
import type { MarketplaceDriveOutcome, MarketplaceDriver } from "./types.js";

const PLATFORM = "codex" as const;

/** Absolute path of the codex CLI on PATH, or null. */
export function codexBinary(): string | null {
  return findOnPath("codex");
}

/** The manual two-step install, printed whenever the driver cannot drive. */
function codexManualInstallCommands(connectorId: string, stagingRoot: string): string {
  return (
    `codex plugin marketplace add ${stagingRoot} && ` +
    `codex plugin add ${codexPluginKey(connectorId)}`
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
// Staging: bundle emit + shared-catalog regeneration (codex catalog dir is
// `.agents/plugins`; staged plugins carry `.codex-plugin/plugin.json`).
// ─────────────────────────────────────────────────────────────────────────

/** Staged plugin dirs (those carrying a .codex-plugin/plugin.json manifest). */
export function stagedCodexPlugins(stagingRoot: string): string[] {
  if (!existsSync(stagingRoot)) return [];
  try {
    return readdirSync(stagingRoot)
      .filter((name) =>
        existsSync(join(stagingRoot, name, ".codex-plugin", "plugin.json")),
      )
      .sort();
  } catch {
    return [];
  }
}

/** Path of the shared catalog: <stagingRoot>/.agents/plugins/marketplace.json. */
function codexCatalogPath(stagingRoot: string): string {
  return join(stagingRoot, ".agents", "plugins", "marketplace.json");
}

/**
 * Regenerate the ONE shared catalog listing every staged connector
 * (content-stable; rewritten only on an actual change). Same shape as claude's.
 */
export function regenerateCodexCatalog(stagingRoot: string, changes: ChangeRecord[]): void {
  const catalogPath = codexCatalogPath(stagingRoot);
  const plugins = stagedCodexPlugins(stagingRoot).map((name) => {
    let description = `${name} — connector emitted by agent-connector`;
    try {
      const manifest = JSON.parse(
        readFileSync(join(stagingRoot, name, ".codex-plugin", "plugin.json"), "utf8"),
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
  ensureDir(dirname(catalogPath));
  writeFileSync(catalogPath, serialized, "utf8");
  changes.push({
    platform: PLATFORM,
    action: existing == null ? "create" : "update",
    path: catalogPath,
    detail: `regenerated shared marketplace catalog (${plugins.length} plugin(s))`,
  });
}

/** Stage (or re-stage) the connector's codex-plugin bundle in the shared root. */
export function stageCodexBundle(
  connector: ResolvedConnector,
  changes: ChangeRecord[],
): { pluginDir: string; contentHash: string } {
  const stagingRoot = codexStagingRoot();
  const pluginDir = join(stagingRoot, connector.id);
  const existed = existsSync(pluginDir);
  const result = packageConnector(connector, { outDir: stagingRoot, format: "codex-plugin" });
  changes.push({
    platform: PLATFORM,
    action: existed ? "update" : "create",
    path: pluginDir,
    detail: `staged marketplace bundle (${result.files.length} files, codex-plugin)`,
  });
  regenerateCodexCatalog(stagingRoot, changes);
  return { pluginDir, contentHash: hashDirectory(pluginDir) };
}

// ─────────────────────────────────────────────────────────────────────────
// Host driving (probe-first, never throws)
// ─────────────────────────────────────────────────────────────────────────

async function driveInstall(connectorId: string): Promise<MarketplaceDriveOutcome> {
  const stagingRoot = codexStagingRoot();
  const changes: ChangeRecord[] = [];
  const pluginKey = codexPluginKey(connectorId);

  const bin = codexBinary();
  if (!bin) {
    changes.push(
      warn(
        `codex CLI not found on PATH — bundle staged but not installed. ` +
          `Install manually: ${codexManualInstallCommands(connectorId, stagingRoot)}`,
        stagingRoot,
      ),
    );
    return { changes, ok: false };
  }

  // Marketplace registration (probe-first + name-collision refusal). Codex has
  // no `plugin validate` — `marketplace add` validates the bundle itself.
  const registeredAt = codexMarketplaceSource(MARKETPLACE_NAME);
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
          `(codex plugin marketplace remove ${MARKETPLACE_NAME}) or install manually: ` +
          codexManualInstallCommands(connectorId, stagingRoot),
      ),
    );
    return { changes, ok: false };
  } else {
    const add = await runHostCommand(bin, ["plugin", "marketplace", "add", stagingRoot]);
    // Probe-first: trust config.toml over the exit code (codex prints a harmless
    // WARNING under /tmp). Only fail when the source did NOT land on our root.
    // samePath: codex stores the win32 extended-length `\\?\C:\…` form.
    if (!samePath(codexMarketplaceSource(MARKETPLACE_NAME), stagingRoot)) {
      changes.push(
        warn(
          `could not register the local marketplace — ` +
            failDetail("codex plugin marketplace add", add) +
            `. Install manually: ${codexManualInstallCommands(connectorId, stagingRoot)}`,
          stagingRoot,
        ),
      );
      return { changes, ok: false };
    }
    changes.push({
      platform: PLATFORM,
      action: "create",
      path: stagingRoot,
      detail: `registered local marketplace "${MARKETPLACE_NAME}" (codex plugin marketplace add)`,
    });
  }

  // Plugin add (probe-first).
  if (codexPluginInstalled(connectorId)) {
    changes.push({
      platform: PLATFORM,
      action: "skip",
      detail: `plugin ${pluginKey} already installed`,
    });
    return { changes, ok: true };
  }
  const add = await runHostCommand(bin, ["plugin", "add", pluginKey]);
  if (!add.ok || !codexPluginInstalled(connectorId)) {
    changes.push(
      warn(`plugin add did not complete — ` + failDetail(`codex plugin add ${pluginKey}`, add)),
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
  const pluginKey = codexPluginKey(connectorId);

  if (!codexPluginInstalled(connectorId)) {
    changes.push({
      platform: PLATFORM,
      action: "skip",
      detail: `plugin ${pluginKey} not installed on codex`,
    });
    return { changes, ok: true };
  }

  const bin = codexBinary();
  if (!bin) {
    changes.push(
      warn(
        `codex CLI not found on PATH — cannot drive the uninstall. ` +
          `Run manually: codex plugin remove ${pluginKey}`,
      ),
    );
    return { changes, ok: false };
  }

  const remove = await runHostCommand(bin, ["plugin", "remove", pluginKey]);
  if (!remove.ok || codexPluginInstalled(connectorId)) {
    changes.push(
      warn(`plugin remove did not complete — ` + failDetail(`codex plugin remove ${pluginKey}`, remove)),
    );
    return { changes, ok: false };
  }
  changes.push({
    platform: PLATFORM,
    action: "remove",
    detail: `uninstalled plugin ${pluginKey} (codex plugin remove)`,
  });
  return { changes, ok: true };
}

/**
 * Remove OUR marketplace registration (callers must have verified safe ordering:
 * catalog empty + no surviving @agent-connector plugins + the registration
 * points at our staging root).
 */
async function driveMarketplaceRemove(stagingRoot: string): Promise<ChangeRecord[]> {
  const bin = codexBinary();
  if (!bin) {
    return [
      warn(
        `codex CLI not found on PATH — marketplace registration "${MARKETPLACE_NAME}" left behind. ` +
          `Run manually: codex plugin marketplace remove ${MARKETPLACE_NAME}`,
        stagingRoot,
      ),
    ];
  }
  const remove = await runHostCommand(bin, ["plugin", "marketplace", "remove", MARKETPLACE_NAME]);
  if (!remove.ok && codexMarketplaceSource(MARKETPLACE_NAME) != null) {
    return [
      warn(
        `could not remove the marketplace registration — ` +
          failDetail(`codex plugin marketplace remove ${MARKETPLACE_NAME}`, remove),
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
// codexDriver: the MarketplaceDriver the orchestrator dispatches through.
// ─────────────────────────────────────────────────────────────────────────

export const codexDriver: MarketplaceDriver = {
  platform: PLATFORM,
  format: "codex-plugin",

  binary: codexBinary,
  stagingRoot: codexStagingRoot,
  pluginDir(id) {
    return join(codexStagingRoot(), id);
  },
  installed: codexPluginInstalled,

  stage(connector, changes) {
    return stageCodexBundle(connector, changes).contentHash;
  },

  planInstall(connector, changes) {
    const stagingRoot = codexStagingRoot();
    const registered = samePath(codexMarketplaceSource(MARKETPLACE_NAME), stagingRoot);
    changes.push({
      platform: PLATFORM,
      action: registered ? "skip" : "create",
      path: stagingRoot,
      detail: registered
        ? `marketplace "${MARKETPLACE_NAME}" already registered`
        : `run: codex plugin marketplace add ${stagingRoot}`,
    });
    changes.push({
      platform: PLATFORM,
      action: codexPluginInstalled(connector.id) ? "skip" : "create",
      detail: codexPluginInstalled(connector.id)
        ? `plugin ${codexPluginKey(connector.id)} already installed`
        : `run: codex plugin add ${codexPluginKey(connector.id)}`,
    });
  },

  planUninstall(id, changes) {
    const stagingRoot = codexStagingRoot();
    const pluginDir = join(stagingRoot, id);
    const pluginKey = codexPluginKey(id);
    changes.push({
      platform: PLATFORM,
      action: codexPluginInstalled(id) ? "remove" : "skip",
      detail: codexPluginInstalled(id)
        ? `run: codex plugin remove ${pluginKey}`
        : `plugin ${pluginKey} not installed on codex`,
    });
    if (existsSync(pluginDir)) {
      changes.push({
        platform: PLATFORM,
        action: "remove",
        path: pluginDir,
        detail: "remove staged marketplace bundle",
      });
    }
    const othersStaged = stagedCodexPlugins(stagingRoot).some((n) => n !== id);
    if (!othersStaged && samePath(codexMarketplaceSource(MARKETPLACE_NAME), stagingRoot)) {
      changes.push({
        platform: PLATFORM,
        action: "remove",
        path: stagingRoot,
        detail: `run: codex plugin marketplace remove ${MARKETPLACE_NAME} (when no plugins remain)`,
      });
    }
  },

  driveInstall,
  driveUninstall,

  // Codex has no `plugin update` verb — update IS re-stage (done by the caller)
  // + `plugin add`, which is idempotent and version-cached.
  async driveUpdate(id): Promise<MarketplaceDriveOutcome> {
    return driveInstall(id);
  },

  async finishUninstall(id, changes): Promise<void> {
    const stagingRoot = codexStagingRoot();
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
    if (existsSync(stagingRoot)) regenerateCodexCatalog(stagingRoot, changes);

    const nothingStaged = stagedCodexPlugins(stagingRoot).length === 0;
    if (
      nothingStaged &&
      !anyCodexAgentConnectorPlugins() &&
      samePath(codexMarketplaceSource(MARKETPLACE_NAME), stagingRoot)
    ) {
      changes.push(...(await driveMarketplaceRemove(stagingRoot)));
    }
  },
};
