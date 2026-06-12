/**
 * core/marketplace — install / uninstall / upgrade via the MARKETPLACE method.
 *
 * Marketplace is a second DELIVERY METHOD for the same connector lifecycle, not
 * a new lifecycle: `install --method marketplace` stages the connector's plugin
 * bundle under the data-root and drives the HOST's own plugin/marketplace
 * install flow, emitting the same ChangeRecords the direct method renders.
 *
 * v1 ships ONE live driver — claude-code (marketplace-drivers/claude.ts) — with
 * every other marketplace-capable host degrading to a never-silent skip/warn
 * record carrying the exact manual commands from `package`'s instructions.
 *
 * Cross-cutting rules (mirrors docs/ARCHITECTURE.md principles):
 *   • Probe-first idempotency: re-runs report `=` skips, never errors.
 *   • Double-install guard: exactly ONE method per (connector, host, scope) —
 *     a direct install on the host REFUSES the marketplace install (and the
 *     installer refuses the inverse), because a doubled connector duplicates
 *     hooks + the MCP server and corrupts telemetry. No --force escape.
 *   • By-reference staging: claude references the bundle IN PLACE, so bundles
 *     stage under <dataRoot>/marketplace/claude/ (stable across cwd changes),
 *     with ONE shared catalog named "agent-connector" listing every staged
 *     connector (regenerated content-stably on install/uninstall).
 *   • --dry-run prints the staged file tree and the exact host commands as
 *     ChangeRecords without writing or spawning.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type {
  ChangeRecord,
  DiagnosticResult,
  InstallResult,
  InstallScope,
  PlatformId,
  ResolvedConnector,
} from "./types.js";
import { loadAdapter } from "../adapters/registry.js";
import { registerConnector } from "./load-connector.js";
import { dataRoot, ensureDir, ensureHomeBin, homeBinPath } from "./paths.js";
import { resolveCliEntry, resolveTargets } from "./installer.js";
import {
  installInstructions,
  packageConnector,
  type PackageFormat,
} from "./package.js";
import {
  MARKETPLACE_NAME,
  anyClaudeAgentConnectorPlugins,
  claudeKnownMarketplacePath,
  claudePluginInstalled,
  claudePluginKey,
  claudeStagingRoot,
  hashDirectory,
  marketplaceRoot,
  readMarketplaceInstalls,
  writeMarketplaceInstalls,
  type MarketplaceInstallRecord,
} from "./marketplace-state.js";
import {
  claudeBinary,
  claudeDriveInstall,
  claudeDriveMarketplaceRemove,
  claudeDriveUninstall,
  claudeDriveUpdate,
} from "./marketplace-drivers/claude.js";
import { log } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Method types + platform → bundle-format mapping
// ─────────────────────────────────────────────────────────────────────────

/** Delivery method for install/upgrade. */
export type InstallMethod = "direct" | "marketplace";
/** Uninstall additionally supports auto (reverse whatever state says exists). */
export type UninstallMethod = InstallMethod | "auto";

/** Parse a --method value for install/upgrade. */
export function parseInstallMethod(value: string | undefined): InstallMethod | null {
  if (value == null || value === "direct" || value === "marketplace") {
    return value ?? "direct";
  }
  return null;
}

/** Parse a --method value for uninstall (default auto). */
export function parseUninstallMethod(
  value: string | undefined,
): UninstallMethod | null {
  if (value == null || value === "auto" || value === "direct" || value === "marketplace") {
    return value ?? "auto";
  }
  return null;
}

/**
 * Users think in HOSTS, not bundle formats — `--targets` keeps its PlatformId
 * meaning and the method maps platform → bundle format internally. Platforms
 * absent here have no marketplace/plugin distribution path at all.
 */
export const MARKETPLACE_FORMAT_BY_PLATFORM: Partial<
  Record<PlatformId, PackageFormat>
> = {
  "claude-code": "claude-plugin",
  codex: "codex-plugin",
  droid: "factory-plugin",
  "gemini-cli": "gemini-extension",
  "qwen-code": "qwen-extension",
  antigravity: "agy-plugin",
  "antigravity-cli": "agy-plugin",
  cursor: "cursor-plugin",
  kimi: "kimi-plugin",
  opencode: "npm-plugin",
  kilo: "npm-plugin",
  "kilo-cli": "npm-plugin",
  pi: "npm-plugin",
  "vscode-copilot": "claude-plugin",
  openclaw: "claude-plugin",
  omp: "claude-plugin",
};

/** The platforms a v1 driver can actually DRIVE end-to-end. */
export const DRIVABLE_MARKETPLACE_PLATFORMS: ReadonlySet<PlatformId> = new Set([
  "claude-code",
]);

// ─────────────────────────────────────────────────────────────────────────
// Small shared helpers
// ─────────────────────────────────────────────────────────────────────────

function newResult(connectorId: string, dryRun: boolean): InstallResult {
  return { connectorId, dryRun, changes: [], warnings: [] };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The manual install hint for a non-drivable marketplace target. */
function manualHint(platform: PlatformId, format: PackageFormat, id: string): string {
  const steps = installInstructions(format, id, "<out-dir>").join("; ");
  return (
    `agent-connector cannot drive the ${platform} marketplace flow yet — install manually: ` +
    `\`agent-connector package --format ${format} --out <out-dir>\` then: ${steps}`
  );
}

/**
 * Read-only: is `connector` DIRECTLY installed on `platform`?
 *
 * STRUCTURAL probe, not a substring scan: a marketplace plugin install makes
 * the HOST itself mention the id in these same files (Claude writes
 * `"<id>@<marketplace>"` into settings.json enabledPlugins), so a bare
 * `.includes(id)` misreports a marketplace-only install as a duplicate. We
 * only count markers a DIRECT install writes:
 *   - server config: the id as a registration KEY — JSON `"<id>":` or a TOML
 *     `[mcp_servers.<id>]`-style table heading (`.<id>]`);
 *   - hook config: a home-bin hook command carrying `--connector <id>`
 *     (plugin-bundle hooks live inside the bundle, never in the host file).
 * The plugin-state key `"<id>@<marketplace>"` matches neither.
 */
async function directInstallPresent(
  connector: ResolvedConnector,
  platform: PlatformId,
  scope: InstallScope,
  projectDir: string,
): Promise<boolean> {
  try {
    const adapter = await loadAdapter(platform);
    if (!adapter) return false;
    const ctx = {
      connector,
      scope: connector.platforms[platform]?.scope ?? scope,
      projectDir,
      homeBinPath: homeBinPath(),
      dataRoot: dataRoot(),
      dryRun: true,
    };
    const escaped = connector.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const serverKey = new RegExp(`"${escaped}"\\s*:|\\.${escaped}\\]`);
    const hookCommand = new RegExp(`--connector\\s+${escaped}(?![\\w-])`);
    const matches = (path: string, re: RegExp): boolean => {
      try {
        return re.test(readFileSync(path, "utf8"));
      } catch {
        return false;
      }
    };
    try {
      if (matches(adapter.getServerConfigPath(ctx), serverKey)) return true;
    } catch {
      /* no server config path */
    }
    try {
      if (matches(adapter.getHookConfigPath(ctx), hookCommand)) return true;
    } catch {
      /* no hook config path */
    }
    return false;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Claude staging: bundle emit + shared-catalog regeneration
// ─────────────────────────────────────────────────────────────────────────

/** Staged plugin dirs (those carrying a .claude-plugin/plugin.json manifest). */
function stagedClaudePlugins(stagingRoot: string): string[] {
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
function regenerateClaudeCatalog(
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
    platform: "claude-code",
    action: existing == null ? "create" : "update",
    path: catalogPath,
    detail: `regenerated shared marketplace catalog (${plugins.length} plugin(s))`,
  });
}

/** Stage (or re-stage) the connector's claude-plugin bundle in the shared root. */
function stageClaudeBundle(
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
    platform: "claude-code",
    action: existed ? "update" : "create",
    path: pluginDir,
    detail: `staged marketplace bundle (${result.files.length} files, claude-plugin)`,
  });
  regenerateClaudeCatalog(stagingRoot, changes);
  return { pluginDir, contentHash: hashDirectory(pluginDir) };
}

// ─────────────────────────────────────────────────────────────────────────
// install --method marketplace
// ─────────────────────────────────────────────────────────────────────────

/** Options for {@link installViaMarketplace} / {@link upgradeViaMarketplace}. */
export interface MarketplaceInstallOptions {
  connector: ResolvedConnector;
  /** Absolute path to the source module that produced `connector`. */
  modulePath: string;
  /** v1: must be "user" (project-scope plugin installs are deferred). */
  scope: InstallScope;
  projectDir: string;
  targets?: PlatformId[];
  dryRun: boolean;
}

/**
 * Deploy a connector by driving each target host's plugin/marketplace install.
 * Targets resolve exactly like the direct install (flag → connector.targets →
 * auto-detect); non-drivable hosts get never-silent skip/warn records with the
 * exact manual commands (warn when the user explicitly targeted them).
 */
export async function installViaMarketplace(
  opts: MarketplaceInstallOptions,
): Promise<InstallResult> {
  const { connector, modulePath, scope, projectDir, dryRun } = opts;
  const result = newResult(connector.id, dryRun);

  if (scope !== "user") {
    result.warnings.push(
      "--method marketplace supports --scope user only in this version " +
        "(project-scope plugin installs are deferred)",
    );
    return result;
  }

  // Same framework-state step as the direct install: the staged bundle's hooks
  // + MCP entry exec the stable home-bin, and the runtime re-imports the
  // registered module to run live handlers.
  if (!dryRun) {
    try {
      ensureHomeBin(resolveCliEntry());
    } catch (err) {
      log.warn(`ensureHomeBin failed: ${errMessage(err)}`);
    }
    try {
      registerConnector(connector, modulePath);
    } catch (err) {
      log.warn(`registerConnector failed: ${errMessage(err)}`);
    }
  }

  const explicit = opts.targets != null && opts.targets.length > 0;
  const targets = await resolveTargets(opts.targets, connector.targets, projectDir);
  if (targets.length === 0) {
    result.warnings.push(
      "no target platforms resolved (none installed / detected, or all filtered out)",
    );
    return result;
  }

  for (const id of targets) {
    const format = MARKETPLACE_FORMAT_BY_PLATFORM[id];
    if (!format) {
      result.changes.push({
        platform: id,
        action: explicit ? "warn" : "skip",
        detail:
          `no marketplace/plugin distribution path exists for ${id} — ` +
          `use the direct method: \`agent-connector install --targets ${id}\``,
      });
      continue;
    }
    if (!DRIVABLE_MARKETPLACE_PLATFORMS.has(id)) {
      result.changes.push({
        platform: id,
        action: explicit ? "warn" : "skip",
        detail: manualHint(id, format, connector.id),
      });
      continue;
    }

    // ── claude-code (the v1 driver) ────────────────────────────────────────
    // Double-install guard: exactly one method per (connector, host, scope).
    if (await directInstallPresent(connector, id, scope, projectDir)) {
      result.changes.push({
        platform: id,
        action: "warn",
        detail:
          `"${connector.id}" is already installed DIRECTLY on ${id} — refusing the marketplace ` +
          `install (both at once duplicates hooks + the MCP server and corrupts telemetry). ` +
          `Run \`agent-connector uninstall --targets ${id}\` first, or keep the direct install.`,
      });
      continue;
    }

    const stagingRoot = claudeStagingRoot();
    const pluginDir = join(stagingRoot, connector.id);

    if (dryRun) {
      const planned = packageConnector(connector, {
        outDir: stagingRoot,
        format,
        dryRun: true,
      });
      for (const file of planned.files) {
        result.changes.push({
          platform: id,
          action: "create",
          path: file,
          detail: "stage bundle file",
        });
      }
      const registeredAt = claudeKnownMarketplacePath(MARKETPLACE_NAME);
      result.changes.push({
        platform: id,
        action: registeredAt === stagingRoot ? "skip" : "create",
        path: stagingRoot,
        detail:
          registeredAt === stagingRoot
            ? `marketplace "${MARKETPLACE_NAME}" already registered`
            : `run: claude plugin marketplace add ${stagingRoot}`,
      });
      result.changes.push({
        platform: id,
        action: claudePluginInstalled(connector.id) ? "skip" : "create",
        detail: claudePluginInstalled(connector.id)
          ? `plugin ${claudePluginKey(connector.id)} already installed`
          : `run: claude plugin install ${claudePluginKey(connector.id)}`,
      });
      continue;
    }

    const { contentHash } = stageClaudeBundle(connector, result.changes);
    const outcome = await claudeDriveInstall(connector.id, stagingRoot, pluginDir);
    result.changes.push(...outcome.changes);
    if (outcome.installed) {
      const installs = readMarketplaceInstalls(connector.id);
      const record: MarketplaceInstallRecord = {
        format,
        bundleDir: pluginDir,
        marketplace: MARKETPLACE_NAME,
        scope,
        version: connector.version,
        contentHash,
        installedAt: installs[id]?.installedAt ?? new Date().toISOString(),
      };
      installs[id] = record;
      writeMarketplaceInstalls(connector.id, installs);
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// uninstall --method marketplace (or auto resolving to it)
// ─────────────────────────────────────────────────────────────────────────

/** Options for {@link uninstallViaMarketplace}. */
export interface MarketplaceUninstallOptions {
  connectorId: string;
  projectDir: string;
  /** Omit to derive from the state record (recorded platforms ∪ claude evidence). */
  targets?: PlatformId[];
  dryRun: boolean;
  /** Also remove the shared marketplace staging root when it ends up empty. */
  purge?: boolean;
}

/** Manual uninstall commands for evidence on non-drivable hosts. */
const MANUAL_UNINSTALL: Partial<Record<PlatformId, (id: string) => string>> = {
  "gemini-cli": (id) => `gemini extensions uninstall ${id}`,
  antigravity: (id) => `agy plugin uninstall ${id}`,
  "antigravity-cli": (id) => `agy plugin uninstall ${id}`,
  codex: (id) => `codex plugin remove ${id}@${MARKETPLACE_NAME}`,
};

/**
 * Reverse a marketplace install per target, inverse order: host plugin
 * uninstall → catalog regen (without this connector) → marketplace
 * de-registration when nothing of ours remains → staged-bundle removal →
 * state-record removal. Probe-first: an absent plugin is an idempotent skip.
 */
export async function uninstallViaMarketplace(
  opts: MarketplaceUninstallOptions,
): Promise<InstallResult> {
  const { connectorId, dryRun, purge } = opts;
  const result = newResult(connectorId, dryRun);

  let targets: PlatformId[];
  if (opts.targets && opts.targets.length > 0) {
    targets = [...new Set(opts.targets)];
  } else {
    const recorded = Object.keys(readMarketplaceInstalls(connectorId)) as PlatformId[];
    targets = recorded;
    if (!targets.includes("claude-code") && claudePluginInstalled(connectorId)) {
      targets = [...targets, "claude-code"];
    }
  }
  if (targets.length === 0) {
    result.warnings.push(
      `no marketplace installs found for "${connectorId}" (nothing recorded, no host evidence)`,
    );
    return result;
  }

  for (const id of targets) {
    if (id !== "claude-code") {
      const manual = MANUAL_UNINSTALL[id];
      const recorded = readMarketplaceInstalls(connectorId)[id] != null;
      result.changes.push({
        platform: id,
        action: recorded ? "warn" : "skip",
        detail: recorded
          ? `agent-connector cannot drive the ${id} marketplace uninstall yet — ` +
            `run manually${manual ? `: ${manual(connectorId)}` : ""} (record kept until then)`
          : `no marketplace install recorded for ${id}`,
      });
      continue;
    }

    const stagingRoot = claudeStagingRoot();
    const pluginDir = join(stagingRoot, connectorId);
    const pluginKey = claudePluginKey(connectorId);

    if (dryRun) {
      result.changes.push({
        platform: id,
        action: claudePluginInstalled(connectorId) ? "remove" : "skip",
        detail: claudePluginInstalled(connectorId)
          ? `run: claude plugin uninstall ${pluginKey}`
          : `plugin ${pluginKey} not installed on claude-code`,
      });
      if (existsSync(pluginDir)) {
        result.changes.push({
          platform: id,
          action: "remove",
          path: pluginDir,
          detail: "remove staged marketplace bundle",
        });
      }
      const othersStaged = stagedClaudePlugins(stagingRoot).some((n) => n !== connectorId);
      if (!othersStaged && claudeKnownMarketplacePath(MARKETPLACE_NAME) === stagingRoot) {
        result.changes.push({
          platform: id,
          action: "remove",
          path: stagingRoot,
          detail: `run: claude plugin marketplace remove ${MARKETPLACE_NAME} (when no plugins remain)`,
        });
      }
      continue;
    }

    // 1+2. Presence probe + drive the host uninstall.
    const outcome = await claudeDriveUninstall(connectorId);
    result.changes.push(...outcome.changes);
    if (!outcome.removed) continue; // host still references the bundle — keep everything

    // 4 (bundle part). Remove the staged bundle dir, then regenerate the catalog
    // without this connector (content-stable write).
    if (existsSync(pluginDir)) {
      try {
        rmSync(pluginDir, { recursive: true, force: true });
        result.changes.push({
          platform: id,
          action: "remove",
          path: pluginDir,
          detail: "removed staged marketplace bundle",
        });
      } catch (err) {
        result.changes.push({
          platform: id,
          action: "warn",
          path: pluginDir,
          detail: `could not remove staged bundle: ${errMessage(err)}`,
        });
      }
    }
    if (existsSync(stagingRoot)) regenerateClaudeCatalog(stagingRoot, result.changes);

    // 3. De-register OUR marketplace only when nothing of ours remains anywhere
    // (safe ordering: plugins are gone first, so Claude's "removing a
    // marketplace uninstalls its plugins" behavior cannot bite a survivor) and
    // ONLY when the registration actually points at our staging root.
    const nothingStaged = stagedClaudePlugins(stagingRoot).length === 0;
    if (
      nothingStaged &&
      !anyClaudeAgentConnectorPlugins() &&
      claudeKnownMarketplacePath(MARKETPLACE_NAME) === stagingRoot
    ) {
      result.changes.push(...(await claudeDriveMarketplaceRemove(stagingRoot)));
    }

    // 4 (state part). Drop the platform entry from the state record.
    const installs = readMarketplaceInstalls(connectorId);
    if (installs[id]) {
      delete installs[id];
      writeMarketplaceInstalls(connectorId, installs);
      result.changes.push({
        platform: id,
        action: "remove",
        path: marketplaceRoot(),
        detail: "removed marketplace install record",
      });
    }
  }

  // --purge: additionally remove the shared staging roots once empty.
  if (purge && !dryRun) {
    const claudeRoot = claudeStagingRoot();
    if (existsSync(claudeRoot) && stagedClaudePlugins(claudeRoot).length === 0) {
      try {
        rmSync(claudeRoot, { recursive: true, force: true });
        result.changes.push({
          platform: "claude-code",
          action: "remove",
          path: claudeRoot,
          detail: "removed empty marketplace staging root (--purge)",
        });
      } catch (err) {
        log.warn(`marketplace staging-root removal failed: ${errMessage(err)}`);
      }
    }
    const root = marketplaceRoot();
    try {
      if (existsSync(root) && readdirSync(root).length === 0) {
        rmSync(root, { recursive: true, force: true });
      }
    } catch {
      /* best-effort */
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// upgrade --method marketplace
// ─────────────────────────────────────────────────────────────────────────

/**
 * Bring a marketplace install current: re-stage the bundle + catalog in place,
 * then drive the host's update verb (claude: `plugin update`, falling back to a
 * recorded uninstall+install pair on CLIs without it). Warns when
 * connector.version is unchanged since the recorded install — Claude caches a
 * versioned COPY, so a same-version update silently no-ops.
 */
export async function upgradeViaMarketplace(
  opts: MarketplaceInstallOptions,
): Promise<InstallResult> {
  const { connector, scope, projectDir, dryRun } = opts;
  const result = newResult(connector.id, dryRun);

  if (scope !== "user") {
    result.warnings.push(
      "--method marketplace supports --scope user only in this version",
    );
    return result;
  }

  let targets: PlatformId[];
  if (opts.targets && opts.targets.length > 0) {
    targets = [...new Set(opts.targets)];
  } else {
    targets = Object.keys(readMarketplaceInstalls(connector.id)) as PlatformId[];
    if (!targets.includes("claude-code") && claudePluginInstalled(connector.id)) {
      targets = [...targets, "claude-code"];
    }
  }
  if (targets.length === 0) {
    result.warnings.push(
      `no marketplace installs found for "${connector.id}" — ` +
        "run `agent-connector install --method marketplace` first",
    );
    return result;
  }

  for (const id of targets) {
    if (id !== "claude-code") {
      result.changes.push({
        platform: id,
        action: "warn",
        detail: `agent-connector cannot drive a ${id} marketplace upgrade yet — re-run \`agent-connector package\` and the host's own update flow`,
      });
      continue;
    }

    const record = readMarketplaceInstalls(connector.id)[id];
    if (!record && !claudePluginInstalled(connector.id)) {
      result.changes.push({
        platform: id,
        action: "warn",
        detail:
          `"${connector.id}" is not marketplace-installed on ${id} — ` +
          `run \`agent-connector install --method marketplace --targets ${id}\``,
      });
      continue;
    }

    if (record && record.version === connector.version) {
      result.changes.push({
        platform: id,
        action: "warn",
        detail:
          `connector.version is unchanged since the recorded install (${record.version}) — ` +
          `Claude caches a versioned copy, so bump connector.version for the update to take effect`,
      });
    }

    const stagingRoot = claudeStagingRoot();
    const pluginDir = join(stagingRoot, connector.id);
    if (dryRun) {
      result.changes.push({
        platform: id,
        action: "update",
        path: pluginDir,
        detail: "re-stage marketplace bundle in place",
      });
      result.changes.push({
        platform: id,
        action: "update",
        detail: `run: claude plugin update ${claudePluginKey(connector.id)}`,
      });
      continue;
    }

    const { contentHash } = stageClaudeBundle(connector, result.changes);
    const outcome = await claudeDriveUpdate(connector.id, stagingRoot, pluginDir);
    result.changes.push(...outcome.changes);
    if (outcome.installed) {
      const installs = readMarketplaceInstalls(connector.id);
      installs[id] = {
        format: record?.format ?? "claude-plugin",
        bundleDir: pluginDir,
        marketplace: MARKETPLACE_NAME,
        scope,
        version: connector.version,
        contentHash,
        installedAt: record?.installedAt ?? new Date().toISOString(),
      };
      writeMarketplaceInstalls(connector.id, installs);
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// doctor — framework-level marketplace checks (read-only fs, no spawning)
// ─────────────────────────────────────────────────────────────────────────

/** Marketplace doctor results for one platform. */
export interface MarketplaceDoctorGroup {
  platform: PlatformId;
  results: DiagnosticResult[];
}

/**
 * The framework-level marketplace health checks (design checks 1–6): duplicate
 * registration, registration intact, state↔host drift, staleness, the embedded
 * home-bin launcher, and a missing host binary. Pure fs reads, so they run in
 * isolated homes without spawning. Empty when the connector has no marketplace
 * state at all (no noise for direct-only users).
 */
export async function marketplaceDoctorChecks(
  connector: ResolvedConnector,
  scope: InstallScope,
  projectDir: string,
): Promise<MarketplaceDoctorGroup[]> {
  const id = connector.id;
  const record = readMarketplaceInstalls(id)["claude-code"];
  const pluginPresent = claudePluginInstalled(id);
  if (!record && !pluginPresent) return [];

  const results: DiagnosticResult[] = [];
  const stagingRoot = claudeStagingRoot();
  const pluginKey = claudePluginKey(id);

  // 1. duplicate-registration (the double-install invariant, after the fact —
  // manual installs can bypass the CLI guards).
  const direct = await directInstallPresent(connector, "claude-code", scope, projectDir);
  if (direct && pluginPresent) {
    results.push({
      check: `${id}: marketplace duplicate-registration`,
      status: "fail",
      message: `installed BOTH directly and as plugin ${pluginKey} — hooks + MCP server are duplicated`,
      fix: `uninstall one method: \`agent-connector uninstall --method marketplace --targets claude-code\` or \`agent-connector uninstall --targets claude-code\``,
    });
  }

  // 2. marketplace registration intact (covers a deleted/relocated data-root
  // dangling the by-reference marketplace).
  if (record) {
    const registeredAt = claudeKnownMarketplacePath(MARKETPLACE_NAME);
    const catalogPath = join(stagingRoot, ".claude-plugin", "marketplace.json");
    let catalogListed = false;
    try {
      const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
        plugins?: Array<{ name?: string }>;
      };
      catalogListed = (catalog.plugins ?? []).some((p) => p.name === id);
    } catch {
      catalogListed = false;
    }
    const intact =
      registeredAt === stagingRoot && existsSync(record.bundleDir) && catalogListed;
    results.push({
      check: `${id}: marketplace registration`,
      status: intact ? "pass" : "fail",
      message: intact
        ? `local marketplace "${MARKETPLACE_NAME}" registered at ${stagingRoot}, bundle staged + cataloged`
        : `marketplace registration broken (registered at ${registeredAt ?? "nowhere"}, bundle ${existsSync(record.bundleDir) ? "present" : "missing"}, catalog ${catalogListed ? "lists it" : "does not list it"})`,
      ...(intact
        ? {}
        : { fix: `agent-connector install --method marketplace --targets claude-code` }),
    });
  }

  // 3. state ↔ host drift (both directions).
  if (record && !pluginPresent) {
    results.push({
      check: `${id}: marketplace state drift`,
      status: "warn",
      message: `recorded as marketplace-installed but Claude's state shows ${pluginKey} absent`,
      fix: `re-run \`agent-connector install --method marketplace --targets claude-code\` or \`agent-connector uninstall --method marketplace --targets claude-code\` to reconcile`,
    });
  } else if (!record && pluginPresent) {
    results.push({
      check: `${id}: marketplace state drift`,
      status: "warn",
      message: `Claude lists ${pluginKey} installed but agent-connector has no record of it (manual install?)`,
      fix: `adopt it: \`agent-connector install --method marketplace --targets claude-code\` (idempotent), or remove it: \`claude plugin uninstall ${pluginKey}\``,
    });
  }

  // 4. staleness: connector changed since the recorded install (claude caches a
  // versioned COPY, so edits do not reach the host until an upgrade).
  if (record) {
    if (connector.version !== "0.0.0" && connector.version !== record.version) {
      results.push({
        check: `${id}: marketplace staleness`,
        status: "warn",
        message: `connector.version ${connector.version} ≠ installed ${record.version}`,
        fix: `agent-connector upgrade --method marketplace --targets claude-code`,
      });
    } else if (
      existsSync(record.bundleDir) &&
      record.contentHash !== "" &&
      hashDirectory(record.bundleDir) !== record.contentHash
    ) {
      results.push({
        check: `${id}: marketplace staleness`,
        status: "warn",
        message: "staged bundle changed since install — Claude's cached copy is stale",
        fix: `agent-connector upgrade --method marketplace --targets claude-code`,
      });
    }
  }

  // 5. embedded home-bin launcher: the installed plugin's hooks exec it OUTSIDE
  // any adapter-managed config.
  if (pluginPresent && !existsSync(homeBinPath())) {
    results.push({
      check: `${id}: marketplace home-bin`,
      status: "fail",
      message: `installed plugin hooks exec ${homeBinPath()} which does not exist`,
      fix: "agent-connector upgrade",
    });
  }

  // 6. host binary missing for a recorded marketplace install.
  if (record && claudeBinary() == null) {
    results.push({
      check: `${id}: marketplace host binary`,
      status: "warn",
      message:
        "claude CLI not found on PATH — the recorded marketplace install cannot be managed until it is reinstalled",
    });
  }

  // A green summary line when nothing above flagged.
  if (results.every((r) => r.status === "pass")) {
    results.push({
      check: `${id}: marketplace install`,
      status: "pass",
      message: `${pluginKey} installed via marketplace (version ${record?.version ?? "unknown"})`,
    });
  }

  return [{ platform: "claude-code", results }];
}

// Re-exported so CLI surfaces can partition uninstall targets without importing
// the leaf state module everywhere.
export { marketplaceEvidence } from "./marketplace-state.js";
