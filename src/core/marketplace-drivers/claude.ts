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

import type { ChangeRecord } from "../types.js";
import {
  MARKETPLACE_NAME,
  claudeKnownMarketplacePath,
  claudePluginInstalled,
  claudePluginKey,
} from "../marketplace-state.js";
import { findOnPath, firstLine, runHostCommand } from "./shared.js";

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
