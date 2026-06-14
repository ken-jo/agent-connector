/**
 * core/marketplace-drivers/agy — the Antigravity (agy) marketplace driver.
 *
 * A DIRECT install-by-path driver (NO marketplace, NO catalog): the host copies
 * the bundle into its own store, so there is no registration to manage and no
 * collision check. Live-verified against agy 1.0.7
 * (docs/research/codex-agy-marketplace-mechanics.md):
 *   • `agy plugin validate <root>/<id>`  — best-effort pre-install validation
 *     (warns when the embedded home-bin path is absent; harmless, exits 0);
 *   • `agy plugin install <root>/<id>`   — copies to ~/.gemini/config/plugins/<id>/
 *     and records it in import_manifest.json (idempotent overwrite);
 *   • `agy plugin uninstall <id>`        — removes the dir + manifest entry
 *     (fully idempotent: uninstalling an absent plugin still exits 0).
 *
 * State (read-only): ~/.gemini/config/plugins/import_manifest.json `imports[]`
 * has `{ name:<id> }` (fallback: ~/.gemini/config/plugins/<id>/plugin.json).
 * agy roots at ~/.gemini/ with NO dedicated config-dir env — isolation is via
 * HOME. There is NO `plugin update` verb: update = re-stage + `plugin install`
 * (idempotent overwrite).
 *
 * The SAME driver implementation serves BOTH `antigravity` and
 * `antigravity-cli` (both emit the agy-plugin bundle); the registry binds one
 * instance per PlatformId so ChangeRecords carry the user's actual target id.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { ChangeRecord, PlatformId, ResolvedConnector } from "../types.js";
import {
  agyPluginInstalled,
  agyStagingRoot,
  hashDirectory,
} from "../marketplace-state.js";
import { packageConnector } from "../package.js";
import { findOnPath, firstLine, runHostCommand } from "./shared.js";
import type { MarketplaceDriveOutcome, MarketplaceDriver } from "./types.js";

/** Absolute path of the agy CLI on PATH, or null. */
export function agyBinary(): string | null {
  return findOnPath("agy");
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

/** Stage (or re-stage) the connector's agy-plugin bundle in the shared root. */
export function stageAgyBundle(
  connector: ResolvedConnector,
  platform: PlatformId,
  changes: ChangeRecord[],
): { pluginDir: string; contentHash: string } {
  const stagingRoot = agyStagingRoot();
  const pluginDir = join(stagingRoot, connector.id);
  const existed = existsSync(pluginDir);
  const result = packageConnector(connector, { outDir: stagingRoot, format: "agy-plugin" });
  changes.push({
    platform,
    action: existed ? "update" : "create",
    path: pluginDir,
    detail: `staged marketplace bundle (${result.files.length} files, agy-plugin)`,
  });
  return { pluginDir, contentHash: hashDirectory(pluginDir) };
}

/**
 * Build an agy driver bound to one PlatformId (antigravity | antigravity-cli),
 * so the records it emits carry the user's actual target id.
 */
export function makeAgyDriver(platform: PlatformId): MarketplaceDriver {
  const warn = (detail: string, path?: string): ChangeRecord => ({
    platform,
    action: "warn",
    detail,
    ...(path ? { path } : {}),
  });

  const manualInstall = (pluginDir: string): string => `agy plugin install ${pluginDir}`;

  return {
    platform,
    format: "agy-plugin",

    binary: agyBinary,
    stagingRoot: agyStagingRoot,
    pluginDir(id) {
      return join(agyStagingRoot(), id);
    },
    installed: agyPluginInstalled,

    stage(connector, changes) {
      return stageAgyBundle(connector, platform, changes).contentHash;
    },

    planInstall(connector, changes) {
      const pluginDir = join(agyStagingRoot(), connector.id);
      changes.push({
        platform,
        action: agyPluginInstalled(connector.id) ? "skip" : "create",
        detail: agyPluginInstalled(connector.id)
          ? `plugin ${connector.id} already installed`
          : `run: agy plugin install ${pluginDir}`,
      });
    },

    planUninstall(id, changes) {
      const pluginDir = join(agyStagingRoot(), id);
      changes.push({
        platform,
        action: agyPluginInstalled(id) ? "remove" : "skip",
        detail: agyPluginInstalled(id)
          ? `run: agy plugin uninstall ${id}`
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

    async driveInstall(id): Promise<MarketplaceDriveOutcome> {
      const changes: ChangeRecord[] = [];
      const pluginDir = join(agyStagingRoot(), id);

      const bin = agyBinary();
      if (!bin) {
        changes.push(
          warn(
            `agy CLI not found on PATH — bundle staged but not installed. ` +
              `Install manually: ${manualInstall(pluginDir)}`,
            pluginDir,
          ),
        );
        return { changes, ok: false };
      }

      // Probe-first: already installed → idempotent skip (re-install would be a
      // silent overwrite, but a probe-first driver reports it as a `=` skip).
      if (agyPluginInstalled(id)) {
        changes.push({
          platform,
          action: "skip",
          detail: `plugin ${id} already installed`,
        });
        return { changes, ok: true };
      }

      // Best-effort pre-install validation (advisory on agy — it warns on an
      // absent home-bin path yet still exits 0; never block the install on it,
      // the post-install probe below is the source of truth).
      await runHostCommand(bin, ["plugin", "validate", pluginDir]);

      const install = await runHostCommand(bin, ["plugin", "install", pluginDir]);
      if (!install.ok || !agyPluginInstalled(id)) {
        changes.push(
          warn(`plugin install did not complete — ` + failDetail(`agy plugin install ${pluginDir}`, install)),
        );
        return { changes, ok: false };
      }
      changes.push({
        platform,
        action: "create",
        detail: `installed plugin ${id} (scope user)`,
      });
      return { changes, ok: true };
    },

    async driveUninstall(id): Promise<MarketplaceDriveOutcome> {
      const changes: ChangeRecord[] = [];

      if (!agyPluginInstalled(id)) {
        changes.push({
          platform,
          action: "skip",
          detail: `plugin ${id} not installed on ${platform}`,
        });
        return { changes, ok: true };
      }

      const bin = agyBinary();
      if (!bin) {
        changes.push(
          warn(
            `agy CLI not found on PATH — cannot drive the uninstall. ` +
              `Run manually: agy plugin uninstall ${id}`,
          ),
        );
        return { changes, ok: false };
      }

      const uninstall = await runHostCommand(bin, ["plugin", "uninstall", id]);
      if (!uninstall.ok || agyPluginInstalled(id)) {
        changes.push(
          warn(`plugin uninstall did not complete — ` + failDetail(`agy plugin uninstall ${id}`, uninstall)),
        );
        return { changes, ok: false };
      }
      changes.push({
        platform,
        action: "remove",
        detail: `uninstalled plugin ${id} (agy plugin uninstall)`,
      });
      return { changes, ok: true };
    },

    // No `plugin update` verb — update = re-stage (done by the caller) +
    // `plugin install` (idempotent overwrite). Force a fresh install even when
    // the probe already shows it present (the bundle on disk changed).
    async driveUpdate(id): Promise<MarketplaceDriveOutcome> {
      const changes: ChangeRecord[] = [];
      const pluginDir = join(agyStagingRoot(), id);

      const bin = agyBinary();
      if (!bin) {
        changes.push(
          warn(
            `agy CLI not found on PATH — bundle re-staged but the installed copy was not updated. ` +
              `Run manually: ${manualInstall(pluginDir)}`,
            pluginDir,
          ),
        );
        return { changes, ok: false };
      }
      const install = await runHostCommand(bin, ["plugin", "install", pluginDir]);
      if (!install.ok || !agyPluginInstalled(id)) {
        changes.push(
          warn(`plugin install did not complete — ` + failDetail(`agy plugin install ${pluginDir}`, install)),
        );
        return { changes, ok: false };
      }
      changes.push({
        platform,
        action: "update",
        detail: `updated plugin ${id} (agy plugin install — idempotent overwrite)`,
      });
      return { changes, ok: true };
    },

    // Direct driver: no catalog, no marketplace de-registration. Cleanup is just
    // removing the staged bundle dir (the host copied it into its own store).
    async finishUninstall(id, changes): Promise<void> {
      const pluginDir = join(agyStagingRoot(), id);
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
