/**
 * core/marketplace-drivers/npm-local — the opencode / kilo / kilo-cli driver.
 *
 * A NEW driver SHAPE (neither catalog nor agy-style direct): these hosts install
 * a LOCAL npm-plugin bundle by reference and have NO uninstall verb at all
 * (`<bin> uninstall` removes the HOST ITSELF — never call it). Live-verified on
 * opencode 1.17.0 / kilo 7.3.16:
 *   • install: `<bin> plugin --global file://<absPluginDir>` appends a
 *     `file://<dir>` entry to the host config's `plugin` array (idempotent — no
 *     dupe on a re-run). NO npm publish, NO marketplace registration.
 *   • uninstall: there is NO host verb. Removal = EDIT the config `plugin`
 *     array, drop the entry whose value (after stripping a leading `file://`)
 *     path-equals our staged bundle dir, delete the `plugin` key when empty.
 *
 * TWO gotchas baked in here:
 *   1. The host CLIs MUST run from a NEUTRAL cwd — running inside a project dir
 *      pollutes `./.opencode/opencode.json` instead of the global config. We pass
 *      `cwd: npmStagingRoot()` (a stable data-root dir) to runHostCommand.
 *   2. The `file://` reference points at the LIVE staged dir, so an update is
 *      just a re-run of install (the bundle was re-staged in place by the
 *      caller) — there is no separate update verb.
 *
 * Probe-first + never-throw + idempotent: install/update key off the config
 * `plugin` array (not exit codes), and the array-edit uninstall is naturally
 * idempotent (an absent entry is a `=` skip).
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ChangeRecord, PlatformId, ResolvedConnector } from "../types.js";
import {
  hashDirectory,
  npmConfigFilePath,
  npmPluginArrayEntry,
  npmPluginInstalled,
  npmStagingRoot,
  readNpmConfig,
} from "../marketplace-state.js";
import { packageConnector } from "../package.js";
import { findOnPath, firstLine, runHostCommand } from "./shared.js";
import type { MarketplaceDriveOutcome, MarketplaceDriver } from "./types.js";

/** Per-host knobs for an npm-local driver. */
export interface NpmLocalDriverOptions {
  /** The host CLI's binary name on PATH (opencode | kilo). */
  binaryName: string;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/** The `file://` reference the host config records for `id`'s staged bundle. */
function fileUrlFor(connectorId: string): string {
  return pathToFileURL(join(npmStagingRoot(), connectorId)).href;
}

/**
 * Build an npm-local driver bound to one PlatformId (opencode | kilo | kilo-cli)
 * and its host binary, so the records it emits carry the user's actual target id.
 */
export function makeNpmLocalDriver(
  platform: PlatformId,
  opts: NpmLocalDriverOptions,
): MarketplaceDriver {
  const { binaryName } = opts;

  const binary = (): string | null => findOnPath(binaryName);

  const warn = (detail: string, path?: string): ChangeRecord => ({
    platform,
    action: "warn",
    detail,
    ...(path ? { path } : {}),
  });

  const manualInstall = (connectorId: string): string =>
    `${binaryName} plugin --global ${fileUrlFor(connectorId)}`;

  /** Stage (or re-stage) the connector's npm-plugin bundle in the shared root. */
  const stageBundle = (
    connector: ResolvedConnector,
    changes: ChangeRecord[],
  ): { pluginDir: string; contentHash: string } => {
    const stagingRoot = npmStagingRoot();
    const pluginDir = join(stagingRoot, connector.id);
    const existed = existsSync(pluginDir);
    const result = packageConnector(connector, { outDir: stagingRoot, format: "npm-plugin" });
    changes.push({
      platform,
      action: existed ? "update" : "create",
      path: pluginDir,
      detail: `staged marketplace bundle (${result.files.length} files, npm-plugin)`,
    });
    return { pluginDir, contentHash: hashDirectory(pluginDir) };
  };

  /**
   * Drive the install: run the host's `plugin --global file://<dir>` from a
   * NEUTRAL cwd, then RE-PROBE the config `plugin` array (idempotent — the host
   * appends without dup; an already-present entry is a `=` skip).
   */
  const driveInstall = async (id: string): Promise<MarketplaceDriveOutcome> => {
    const changes: ChangeRecord[] = [];

    // Probe-first: already referenced → idempotent skip (host re-install is a
    // no-op too, but the probe-first driver reports it as a `=` skip).
    if (npmPluginInstalled(platform, id)) {
      changes.push({
        platform,
        action: "skip",
        detail: `plugin ${id} already installed`,
      });
      return { changes, ok: true };
    }

    const bin = binary();
    if (!bin) {
      changes.push(
        warn(
          `${binaryName} CLI not found on PATH — bundle staged but not installed. ` +
            `Install manually: ${manualInstall(id)}`,
          join(npmStagingRoot(), id),
        ),
      );
      return { changes, ok: false };
    }

    // Run from a NEUTRAL cwd (the staging root) so the host writes the GLOBAL
    // config, not a project-local ./.opencode/opencode.json.
    const stagingRoot = npmStagingRoot();
    try {
      mkdirSync(stagingRoot, { recursive: true });
    } catch {
      /* best-effort — runHostCommand still inherits cwd if this fails */
    }
    const install = await runHostCommand(bin, ["plugin", "--global", fileUrlFor(id)], {
      cwd: stagingRoot,
    });
    if (!npmPluginInstalled(platform, id)) {
      changes.push(
        warn(`plugin install did not complete — ` + failDetail(manualInstall(id), install)),
      );
      return { changes, ok: false };
    }
    changes.push({
      platform,
      action: "create",
      detail: `installed plugin ${id} (scope user)`,
    });
    return { changes, ok: true };
  };

  return {
    platform,
    format: "npm-plugin",

    binary,
    stagingRoot: npmStagingRoot,
    pluginDir(id) {
      return join(npmStagingRoot(), id);
    },
    installed: (id) => npmPluginInstalled(platform, id),

    stage(connector, changes) {
      return stageBundle(connector, changes).contentHash;
    },

    planInstall(connector, changes) {
      changes.push({
        platform,
        action: npmPluginInstalled(platform, connector.id) ? "skip" : "create",
        detail: npmPluginInstalled(platform, connector.id)
          ? `plugin ${connector.id} already installed`
          : `run: ${manualInstall(connector.id)}`,
      });
    },

    planUninstall(id, changes) {
      const pluginDir = join(npmStagingRoot(), id);
      const present = npmPluginInstalled(platform, id);
      changes.push({
        platform,
        action: present ? "remove" : "skip",
        detail: present
          ? `edit ${npmConfigFilePath(platform)}: drop the file:// plugin entry for ${id}`
          : `plugin ${id} not installed on ${platform}`,
      });
      if (existsSync(pluginDir)) {
        changes.push({
          platform,
          action: "remove",
          path: pluginDir,
          detail: "remove staged marketplace bundle",
        });
      }
    },

    driveInstall,

    // No host uninstall verb (`<bin> uninstall` removes the HOST). Removal is an
    // EDIT of the config `plugin` array: drop the entry referencing our staged
    // dir, delete the `plugin` key when empty, preserve every other key.
    async driveUninstall(id): Promise<MarketplaceDriveOutcome> {
      const changes: ChangeRecord[] = [];

      const entry = npmPluginArrayEntry(platform, id);
      if (entry == null) {
        changes.push({
          platform,
          action: "skip",
          detail: `plugin ${id} not installed on ${platform}`,
        });
        return { changes, ok: true };
      }

      const configPath = npmConfigFilePath(platform);
      const cfg = readNpmConfig(platform);
      if (!cfg) {
        changes.push(
          warn(
            `could not parse ${platform} config ${configPath} — leaving the plugin entry in place. ` +
              `Remove this entry from the "plugin" array by hand: ${entry}`,
            configPath,
          ),
        );
        return { changes, ok: false };
      }

      const arr = Array.isArray(cfg["plugin"]) ? (cfg["plugin"] as unknown[]) : [];
      const filtered = arr.filter((e) => e !== entry);
      if (filtered.length === 0) delete cfg["plugin"];
      else cfg["plugin"] = filtered;

      try {
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
      } catch (err) {
        changes.push(
          warn(`could not rewrite ${platform} config: ${errMessage(err)}`, configPath),
        );
        return { changes, ok: false };
      }

      // RE-PROBE: the edit is the source of truth, not any spawn.
      if (npmPluginInstalled(platform, id)) {
        changes.push(
          warn(`plugin entry persisted after the config edit — ${configPath}`, configPath),
        );
        return { changes, ok: false };
      }
      changes.push({
        platform,
        action: "remove",
        path: configPath,
        detail: `removed plugin ${id} from the ${platform} config "plugin" array`,
      });
      return { changes, ok: true };
    },

    // The `file://` reference points at the LIVE staged dir, so an update is just
    // a re-run of install (the bundle was re-staged in place by the caller). When
    // the entry is already present, that is an idempotent `=` skip.
    async driveUpdate(id): Promise<MarketplaceDriveOutcome> {
      return driveInstall(id);
    },

    // No catalog, no marketplace de-registration: cleanup is removing the staged
    // bundle dir (the host no longer references it after driveUninstall's edit).
    async finishUninstall(id, changes): Promise<void> {
      const pluginDir = join(npmStagingRoot(), id);
      if (existsSync(pluginDir)) {
        try {
          rmSync(pluginDir, { recursive: true, force: true });
          changes.push({
            platform,
            action: "remove",
            path: pluginDir,
            detail: "removed staged marketplace bundle",
          });
        } catch (err) {
          changes.push({
            platform,
            action: "warn",
            path: pluginDir,
            detail: `could not remove staged bundle: ${errMessage(err)}`,
          });
        }
      }
    },
  };
}
