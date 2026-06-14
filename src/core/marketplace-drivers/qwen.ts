/**
 * core/marketplace-drivers/qwen — the Qwen Code marketplace driver.
 *
 * DOCS-ONLY (BATCH 3): no `qwen` binary is present on this box, so every
 * host-contract claim below is sourced from qwen-code's docs + its gemini-cli
 * lineage rather than a live run. CONFIRM LIVE when a qwen binary is available:
 *   • idempotency in BOTH directions (we assume qwen, like gemini, is NOT
 *     idempotent — re-install throws/refuses, uninstall-absent throws);
 *   • that `extensions install` takes NO `--consent` flag (gemini's parent
 *     REQUIRES it; qwen's docs do NOT document one — omitting it is the bet);
 *   • the extension marker filename `qwen-extension.json`.
 *
 * A DIRECT install-by-path driver (NO marketplace, NO catalog), a near-clone of
 * gemini.ts speaking the single `qwen-code` PlatformId:
 *   • `qwen extensions install <pluginDir>` — copies the extension into
 *     ~/.qwen/extensions/<id>/ (NO `--consent` — DOCS-confirmed absence, not
 *     live-verified);
 *   • `qwen extensions uninstall <id>` — removes the extension dir;
 *   • `qwen extensions update <id>` — in-place update when already installed.
 *
 * State (read-only): ~/.qwen/extensions/<id>/qwen-extension.json. Isolation is
 * via HOME (no dedicated config-dir env), like gemini.
 *
 * Idempotency assumptions (DOCS-only, source-confirmed against the gemini fork):
 *   1. The CLI may exit 0 even on a logical failure → every decision keys off
 *      the fs probe, never the exit code, and we RE-PROBE after every spawn.
 *   2. Re-install is assumed to REFUSE (not an idempotent overwrite) → drive
 *      install skips when already present; driveUpdate PREFERS `extensions
 *      update <id>` when installed, falling back to install otherwise.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { ChangeRecord, ResolvedConnector } from "../types.js";
import {
  hashDirectory,
  qwenExtensionInstalled,
  qwenStagingRoot,
} from "../marketplace-state.js";
import { packageConnector } from "../package.js";
import { findOnPath, firstLine, runHostCommand } from "./shared.js";
import type { MarketplaceDriveOutcome, MarketplaceDriver } from "./types.js";

const PLATFORM = "qwen-code" as const;

/** Absolute path of the qwen CLI on PATH, or null. */
export function qwenBinary(): string | null {
  return findOnPath("qwen");
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
  return `qwen extensions install ${pluginDir}`;
}

/** Stage (or re-stage) the connector's qwen-extension bundle in the shared root. */
export function stageQwenBundle(
  connector: ResolvedConnector,
  changes: ChangeRecord[],
): { pluginDir: string; contentHash: string } {
  const stagingRoot = qwenStagingRoot();
  const pluginDir = join(stagingRoot, connector.id);
  const existed = existsSync(pluginDir);
  const result = packageConnector(connector, { outDir: stagingRoot, format: "qwen-extension" });
  changes.push({
    platform: PLATFORM,
    action: existed ? "update" : "create",
    path: pluginDir,
    detail: `staged marketplace bundle (${result.files.length} files, qwen-extension)`,
  });
  return { pluginDir, contentHash: hashDirectory(pluginDir) };
}

export const qwenDriver: MarketplaceDriver = {
  platform: PLATFORM,
  format: "qwen-extension",

  binary: qwenBinary,
  stagingRoot: qwenStagingRoot,
  pluginDir(id) {
    return join(qwenStagingRoot(), id);
  },
  installed: qwenExtensionInstalled,

  stage(connector, changes) {
    return stageQwenBundle(connector, changes).contentHash;
  },

  planInstall(connector, changes) {
    const pluginDir = join(qwenStagingRoot(), connector.id);
    changes.push({
      platform: PLATFORM,
      action: qwenExtensionInstalled(connector.id) ? "skip" : "create",
      detail: qwenExtensionInstalled(connector.id)
        ? `extension ${connector.id} already installed`
        : `run: ${manualInstall(pluginDir)}`,
    });
  },

  planUninstall(id, changes) {
    const pluginDir = join(qwenStagingRoot(), id);
    changes.push({
      platform: PLATFORM,
      action: qwenExtensionInstalled(id) ? "remove" : "skip",
      detail: qwenExtensionInstalled(id)
        ? `run: qwen extensions uninstall ${id}`
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
    const pluginDir = join(qwenStagingRoot(), id);

    const bin = qwenBinary();
    if (!bin) {
      changes.push(
        warn(
          `qwen CLI not found on PATH — bundle staged but not installed. ` +
            `Install manually: ${manualInstall(pluginDir)}`,
          pluginDir,
        ),
      );
      return { changes, ok: false };
    }

    // Probe-first: qwen is assumed to REFUSE a re-install (DOCS-only, like its
    // gemini parent), so an already-present extension is an idempotent `=` skip.
    if (qwenExtensionInstalled(id)) {
      changes.push({
        platform: PLATFORM,
        action: "skip",
        detail: `extension ${id} already installed`,
      });
      return { changes, ok: true };
    }

    // NO `--consent` — DOCS-confirmed absent on qwen (unlike gemini); confirm live.
    const install = await runHostCommand(bin, ["extensions", "install", pluginDir]);
    // qwen may exit 0 even on a logical failure → trust the fs RE-PROBE (DOCS-only).
    if (!qwenExtensionInstalled(id)) {
      changes.push(
        warn(
          `extension install did not complete — ` +
            failDetail(`qwen extensions install ${pluginDir}`, install),
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

    if (!qwenExtensionInstalled(id)) {
      changes.push({
        platform: PLATFORM,
        action: "skip",
        detail: `extension ${id} not installed on ${PLATFORM}`,
      });
      return { changes, ok: true };
    }

    const bin = qwenBinary();
    if (!bin) {
      changes.push(
        warn(
          `qwen CLI not found on PATH — cannot drive the uninstall. ` +
            `Run manually: qwen extensions uninstall ${id}`,
        ),
      );
      return { changes, ok: false };
    }

    const uninstall = await runHostCommand(bin, ["extensions", "uninstall", id]);
    // RE-PROBE the fs (qwen may exit 0 regardless — DOCS-only).
    if (qwenExtensionInstalled(id)) {
      changes.push(
        warn(
          `extension uninstall did not complete — ` +
            failDetail(`qwen extensions uninstall ${id}`, uninstall),
        ),
      );
      return { changes, ok: false };
    }
    changes.push({
      platform: PLATFORM,
      action: "remove",
      detail: `uninstalled extension ${id} (qwen extensions uninstall)`,
    });
    return { changes, ok: true };
  },

  // qwen documents an `extensions update <id>` verb (UNLIKE gemini, which has no
  // overwrite path) — PREFER it when the extension is already installed, else
  // fall back to a fresh install. The bundle was already re-staged by the caller.
  // DOCS-only: the `update` verb + its exit semantics are unverified live.
  async driveUpdate(id): Promise<MarketplaceDriveOutcome> {
    const changes: ChangeRecord[] = [];
    const pluginDir = join(qwenStagingRoot(), id);

    const bin = qwenBinary();
    if (!bin) {
      changes.push(
        warn(
          `qwen CLI not found on PATH — bundle re-staged but the installed copy was not updated. ` +
            `Run manually: qwen extensions update ${id}`,
          pluginDir,
        ),
      );
      return { changes, ok: false };
    }

    // PREFER `extensions update <id>` when already installed; otherwise install.
    if (qwenExtensionInstalled(id)) {
      const update = await runHostCommand(bin, ["extensions", "update", id]);
      // RE-PROBE: an update keeps the marker present, so a missing marker = failure.
      if (!qwenExtensionInstalled(id)) {
        changes.push(
          warn(
            `extension update did not complete — ` +
              failDetail(`qwen extensions update ${id}`, update),
          ),
        );
        return { changes, ok: false };
      }
      changes.push({
        platform: PLATFORM,
        action: "update",
        detail: `updated extension ${id} (qwen extensions update)`,
      });
      return { changes, ok: true };
    }

    const install = await runHostCommand(bin, ["extensions", "install", pluginDir]);
    if (!qwenExtensionInstalled(id)) {
      changes.push(
        warn(
          `extension install did not complete — ` +
            failDetail(`qwen extensions install ${pluginDir}`, install),
        ),
      );
      return { changes, ok: false };
    }
    changes.push({
      platform: PLATFORM,
      action: "update",
      detail: `updated extension ${id} (qwen extensions install)`,
    });
    return { changes, ok: true };
  },

  // Direct driver: no catalog, no marketplace de-registration. Cleanup is just
  // removing the staged bundle dir (the host copied it into its own store).
  async finishUninstall(id, changes): Promise<void> {
    const pluginDir = join(qwenStagingRoot(), id);
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
