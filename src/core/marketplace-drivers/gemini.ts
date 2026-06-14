/**
 * core/marketplace-drivers/gemini — the Gemini CLI marketplace driver.
 *
 * LEGACY: Gemini CLI is sunsetting toward Google Antigravity (driven by agy.ts).
 * This driver is kept for the many machines that still have gemini-cli installed;
 * new deployments should prefer the `antigravity` / `antigravity-cli` targets.
 *
 * A DIRECT install-by-path driver (NO marketplace, NO catalog), modeled on
 * agy.ts but speaking the single `gemini-cli` PlatformId. Live-verified against
 * gemini 0.36.0:
 *   • `gemini extensions validate <pluginDir>` — advisory pre-install validation
 *     (its result is IGNORED; gemini exits 0 even when it warns);
 *   • `gemini extensions install <pluginDir> --consent` — copies the extension
 *     into ~/.gemini/extensions/<id>/ (`--consent` is REQUIRED to run
 *     non-interactively; install-by-LOCAL-PATH is confirmed);
 *   • `gemini extensions uninstall <id>` — removes the extension dir.
 *
 * State (read-only): ~/.gemini/extensions/<id>/gemini-extension.json. Isolation
 * is via HOME (no dedicated config-dir env).
 *
 * Two CRITICAL idempotency facts (both UNLIKE agy):
 *   1. gemini exits 0 even on a LOGICAL failure → every decision keys off the
 *      fs probe, never the exit code, and we RE-PROBE after every spawn.
 *   2. Re-install REFUSES ("already installed… uninstall first") — it is NOT an
 *      idempotent overwrite (agy overwrites). So driveInstall skips when already
 *      present, and driveUpdate must uninstall-THEN-install (there is no
 *      overwrite-install path).
 *
 * VERSION CAVEAT (live-found on gemini 0.41.2, native Windows): newer gemini
 * gates a local-path `extensions install` behind a SEPARATE "trust this folder"
 * prompt that `--consent` does NOT cover, and there is no install-subcommand flag
 * to bypass it (`--skip-trust` is a global flag that does not compose with the
 * subcommand). With stdin ignored the prompt EOF-aborts cleanly (no hang, no
 * partial install). driveInstall detects this and emits an actionable warn (trust
 * the folder once interactively, or set `security.folderTrust.enabled: false`).
 * gemini 0.36.0 had no such gate, so the full lifecycle is live-verified there.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { ChangeRecord, ResolvedConnector } from "../types.js";
import {
  geminiExtensionInstalled,
  geminiStagingRoot,
  hashDirectory,
} from "../marketplace-state.js";
import { packageConnector } from "../package.js";
import { findOnPath, firstLine, runHostCommand } from "./shared.js";
import type { MarketplaceDriveOutcome, MarketplaceDriver } from "./types.js";

const PLATFORM = "gemini-cli" as const;

/** Absolute path of the gemini CLI on PATH, or null. */
export function geminiBinary(): string | null {
  return findOnPath("gemini");
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

/** The manual install hint, printed whenever the driver cannot drive. */
function manualInstall(pluginDir: string): string {
  return `gemini extensions install ${pluginDir} --consent`;
}

/** Stage (or re-stage) the connector's gemini-extension bundle in the shared root. */
export function stageGeminiBundle(
  connector: ResolvedConnector,
  changes: ChangeRecord[],
): { pluginDir: string; contentHash: string } {
  const stagingRoot = geminiStagingRoot();
  const pluginDir = join(stagingRoot, connector.id);
  const existed = existsSync(pluginDir);
  const result = packageConnector(connector, { outDir: stagingRoot, format: "gemini-extension" });
  changes.push({
    platform: PLATFORM,
    action: existed ? "update" : "create",
    path: pluginDir,
    detail: `staged marketplace bundle (${result.files.length} files, gemini-extension)`,
  });
  return { pluginDir, contentHash: hashDirectory(pluginDir) };
}

export const geminiDriver: MarketplaceDriver = {
  platform: PLATFORM,
  format: "gemini-extension",

  binary: geminiBinary,
  stagingRoot: geminiStagingRoot,
  pluginDir(id) {
    return join(geminiStagingRoot(), id);
  },
  installed: geminiExtensionInstalled,

  stage(connector, changes) {
    return stageGeminiBundle(connector, changes).contentHash;
  },

  planInstall(connector, changes) {
    const pluginDir = join(geminiStagingRoot(), connector.id);
    changes.push({
      platform: PLATFORM,
      action: geminiExtensionInstalled(connector.id) ? "skip" : "create",
      detail: geminiExtensionInstalled(connector.id)
        ? `extension ${connector.id} already installed`
        : `run: ${manualInstall(pluginDir)}`,
    });
  },

  planUninstall(id, changes) {
    const pluginDir = join(geminiStagingRoot(), id);
    changes.push({
      platform: PLATFORM,
      action: geminiExtensionInstalled(id) ? "remove" : "skip",
      detail: geminiExtensionInstalled(id)
        ? `run: gemini extensions uninstall ${id}`
        : `extension ${id} not installed on ${PLATFORM}`,
    });
    if (existsSync(pluginDir)) {
      changes.push({
        platform: PLATFORM,
        action: "remove",
        path: pluginDir,
        detail: "remove staged marketplace bundle",
      });
    }
  },

  async driveInstall(id): Promise<MarketplaceDriveOutcome> {
    const changes: ChangeRecord[] = [];
    const pluginDir = join(geminiStagingRoot(), id);

    const bin = geminiBinary();
    if (!bin) {
      changes.push(
        warn(
          `gemini CLI not found on PATH — bundle staged but not installed. ` +
            `Install manually: ${manualInstall(pluginDir)}`,
          pluginDir,
        ),
      );
      return { changes, ok: false };
    }

    // Probe-first: gemini REFUSES a re-install ("already installed… uninstall
    // first"), so an already-present extension is an idempotent `=` skip.
    if (geminiExtensionInstalled(id)) {
      changes.push({
        platform: PLATFORM,
        action: "skip",
        detail: `extension ${id} already installed`,
      });
      return { changes, ok: true };
    }

    // Advisory pre-install validation — gemini exits 0 even when it warns, so the
    // result is IGNORED; the post-install fs re-probe below is the source of truth.
    await runHostCommand(bin, ["extensions", "validate", pluginDir]);

    const install = await runHostCommand(bin, ["extensions", "install", pluginDir, "--consent"]);
    // gemini exits 0 even on a logical failure → trust the fs RE-PROBE, not the code.
    if (!geminiExtensionInstalled(id)) {
      // gemini >= 0.41 gates a local-path install behind a separate "trust this
      // folder" prompt that --consent does NOT cover; with stdin ignored it
      // EOF-aborts (no hang, no partial install). There is no install-subcommand
      // flag for it, so surface the supported one-time fix instead of failing blind.
      const trustGated = /trust (the |this )?(files|folder)/i.test(
        `${install.stdout}\n${install.stderr}`,
      );
      changes.push(
        warn(
          trustGated
            ? `extension install blocked by gemini's folder-trust prompt (newer gemini gates ` +
                `local-path installs and --consent does not bypass it). Trust the folder once, ` +
                `then re-run: run \`gemini extensions install ${pluginDir} --consent\` interactively ` +
                `(answer "y" to trust), or set \`security.folderTrust.enabled: false\` in ` +
                `~/.gemini/settings.json. The bundle is staged and ready.`
            : `extension install did not complete — ` +
                failDetail(`gemini extensions install ${pluginDir} --consent`, install),
          pluginDir,
        ),
      );
      return { changes, ok: false };
    }
    changes.push({
      platform: PLATFORM,
      action: "create",
      detail: `installed extension ${id} (scope user)`,
    });
    return { changes, ok: true };
  },

  async driveUninstall(id): Promise<MarketplaceDriveOutcome> {
    const changes: ChangeRecord[] = [];

    if (!geminiExtensionInstalled(id)) {
      changes.push({
        platform: PLATFORM,
        action: "skip",
        detail: `extension ${id} not installed on ${PLATFORM}`,
      });
      return { changes, ok: true };
    }

    const bin = geminiBinary();
    if (!bin) {
      changes.push(
        warn(
          `gemini CLI not found on PATH — cannot drive the uninstall. ` +
            `Run manually: gemini extensions uninstall ${id}`,
        ),
      );
      return { changes, ok: false };
    }

    const uninstall = await runHostCommand(bin, ["extensions", "uninstall", id]);
    // RE-PROBE the fs (gemini exits 0 regardless).
    if (geminiExtensionInstalled(id)) {
      changes.push(
        warn(
          `extension uninstall did not complete — ` +
            failDetail(`gemini extensions uninstall ${id}`, uninstall),
        ),
      );
      return { changes, ok: false };
    }
    changes.push({
      platform: PLATFORM,
      action: "remove",
      detail: `uninstalled extension ${id} (gemini extensions uninstall)`,
    });
    return { changes, ok: true };
  },

  // gemini has NO overwrite-install (re-install REFUSES), so update is
  // uninstall-THEN-install. The bundle was already re-staged by the caller.
  async driveUpdate(id): Promise<MarketplaceDriveOutcome> {
    const changes: ChangeRecord[] = [];
    const pluginDir = join(geminiStagingRoot(), id);

    const bin = geminiBinary();
    if (!bin) {
      changes.push(
        warn(
          `gemini CLI not found on PATH — bundle re-staged but the installed copy was not updated. ` +
            `Run manually: gemini extensions uninstall ${id} && ${manualInstall(pluginDir)}`,
          pluginDir,
        ),
      );
      return { changes, ok: false };
    }

    // 1. Remove the old copy (only when present; gemini exits 0 regardless).
    if (geminiExtensionInstalled(id)) {
      const uninstall = await runHostCommand(bin, ["extensions", "uninstall", id]);
      if (geminiExtensionInstalled(id)) {
        changes.push(
          warn(
            `extension update could not remove the old copy — ` +
              failDetail(`gemini extensions uninstall ${id}`, uninstall),
          ),
        );
        return { changes, ok: false };
      }
    }

    // 2. Install the freshly re-staged bundle.
    await runHostCommand(bin, ["extensions", "validate", pluginDir]);
    const install = await runHostCommand(bin, ["extensions", "install", pluginDir, "--consent"]);
    if (!geminiExtensionInstalled(id)) {
      changes.push(
        warn(
          `extension install did not complete — ` +
            failDetail(`gemini extensions install ${pluginDir} --consent`, install),
        ),
      );
      return { changes, ok: false };
    }
    changes.push({
      platform: PLATFORM,
      action: "update",
      detail: `updated extension ${id} (gemini extensions uninstall + install)`,
    });
    return { changes, ok: true };
  },

  // Direct driver: no catalog, no marketplace de-registration. Cleanup is just
  // removing the staged bundle dir (the host copied it into its own store).
  async finishUninstall(id, changes): Promise<void> {
    const pluginDir = join(geminiStagingRoot(), id);
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
  },
};
