/**
 * core/marketplace — install / uninstall / upgrade via the MARKETPLACE method.
 *
 * Marketplace is a second DELIVERY METHOD for the same connector lifecycle, not
 * a new lifecycle: `install --method marketplace` stages the connector's plugin
 * bundle under the data-root and drives the HOST's own plugin/marketplace
 * install flow, emitting the same ChangeRecords the direct method renders.
 *
 * Every host-specific detail lives behind a {@link MarketplaceDriver}
 * (marketplace-drivers/*), resolved per target via the registry; this module
 * keeps only the generic policy (target resolution, the double-install guard,
 * dry-run rendering, state-record bookkeeping) and dispatches through the
 * driver. Live drivers: claude-code + codex (catalog drivers — shared root +
 * one "agent-connector" catalog + a registered local marketplace) and
 * antigravity / antigravity-cli (the agy direct install-by-path driver, no
 * catalog). Every other marketplace-capable host degrades to a never-silent
 * skip/warn record carrying the exact manual commands from `package`.
 *
 * Cross-cutting rules (mirrors docs/ARCHITECTURE.md principles):
 *   • Probe-first idempotency: re-runs report `=` skips, never errors.
 *   • Double-install guard: exactly ONE method per (connector, host, scope) —
 *     a direct install on the host REFUSES the marketplace install (and the
 *     installer refuses the inverse), because a doubled connector duplicates
 *     hooks + the MCP server and corrupts telemetry. No --force escape.
 *   • By-reference staging: catalog drivers reference the bundle IN PLACE, so
 *     bundles stage under <dataRoot>/marketplace/<family>/ (stable across cwd
 *     changes), with ONE shared catalog named "agent-connector" listing every
 *     staged connector (regenerated content-stably on install/uninstall). The
 *     agy driver installs by path; the host copies the bundle into its store.
 *   • --dry-run prints the staged file tree and the exact host commands as
 *     ChangeRecords without writing or spawning.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import type {
  DiagnosticResult,
  InstallResult,
  InstallScope,
  PlatformId,
  ResolvedConnector,
} from "./types.js";
import { loadAdapter } from "../adapters/registry.js";
import { registerConnector } from "./load-connector.js";
import { dataRoot, ensureHomeBin, homeBinPath } from "./paths.js";
import { resolveCliEntry, resolveTargets } from "./installer.js";
import {
  installInstructions,
  packageConnector,
  type PackageFormat,
} from "./package.js";
import {
  MARKETPLACE_NAME,
  claudeKnownMarketplacePath,
  claudePluginInstalled,
  claudePluginKey,
  claudeStagingRoot,
  hashDirectory,
  marketplaceRoot,
  npmConfigFilePath,
  readMarketplaceInstalls,
  writeMarketplaceInstalls,
  type MarketplaceInstallRecord,
} from "./marketplace-state.js";
import { claudeBinary } from "./marketplace-drivers/claude.js";
import { getMarketplaceDriver } from "./marketplace-drivers/registry.js";
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

/** The platforms a driver can actually DRIVE end-to-end. */
export const DRIVABLE_MARKETPLACE_PLATFORMS: ReadonlySet<PlatformId> = new Set([
  "claude-code",
  "codex",
  "antigravity",
  "antigravity-cli",
  "gemini-cli",
  "qwen-code",
  "droid",
  "opencode",
  "kilo",
  "kilo-cli",
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

    // ── drivable host (dispatch through the driver) ────────────────────────
    const driver = getMarketplaceDriver(id);
    if (!driver) {
      // DRIVABLE_MARKETPLACE_PLATFORMS and the registry are kept in sync; this
      // is a never-silent guard for an out-of-sync set rather than a real path.
      result.changes.push({
        platform: id,
        action: explicit ? "warn" : "skip",
        detail: manualHint(id, format, connector.id),
      });
      continue;
    }

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

    const pluginDir = driver.pluginDir(connector.id);

    if (dryRun) {
      const planned = packageConnector(connector, {
        outDir: driver.stagingRoot(),
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
      driver.planInstall(connector, result.changes);
      continue;
    }

    const contentHash = driver.stage(connector, result.changes);
    const outcome = await driver.driveInstall(connector.id);
    result.changes.push(...outcome.changes);
    if (outcome.ok) {
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
    // Union recorded platforms with live host evidence for every drivable host
    // (a host whose probe-able state shows our plugin but whose record was lost).
    targets = Object.keys(readMarketplaceInstalls(connectorId)) as PlatformId[];
    for (const id of DRIVABLE_MARKETPLACE_PLATFORMS) {
      if (targets.includes(id)) continue;
      const driver = getMarketplaceDriver(id);
      if (driver?.installed(connectorId)) targets = [...targets, id];
    }
  }
  if (targets.length === 0) {
    result.warnings.push(
      `no marketplace installs found for "${connectorId}" (nothing recorded, no host evidence)`,
    );
    return result;
  }

  for (const id of targets) {
    const driver = getMarketplaceDriver(id);
    if (!driver) {
      // Non-drivable host: keep the manual hint + the record until the user
      // reverses it by hand (never silently drop a recorded install).
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

    if (dryRun) {
      driver.planUninstall(connectorId, result.changes);
      continue;
    }

    // 1. Presence probe + drive the host uninstall.
    const outcome = await driver.driveUninstall(connectorId);
    result.changes.push(...outcome.changes);
    if (!outcome.ok) continue; // host still references the bundle — keep everything

    // 2. Driver-specific cleanup: staged-bundle removal, catalog regen, and
    // (catalog drivers) marketplace de-registration when nothing of ours remains.
    await driver.finishUninstall(connectorId, result.changes);

    // 3. Drop the platform entry from the state record.
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

  // --purge: additionally remove every drivable host's shared staging root once
  // it holds no staged bundle of ours, then the marketplace root when empty.
  if (purge && !dryRun) {
    const seenRoots = new Set<string>();
    for (const id of DRIVABLE_MARKETPLACE_PLATFORMS) {
      const driver = getMarketplaceDriver(id);
      if (!driver) continue;
      const root = driver.stagingRoot();
      if (seenRoots.has(root)) continue;
      seenRoots.add(root);
      if (!existsSync(root)) continue;
      // Only remove a staging root with no bundle dirs left (a bundle dir is any
      // direct child dir; the catalog dir is dot-prefixed and never a bundle).
      let bundleDirs: string[];
      try {
        bundleDirs = readdirSync(root).filter((n) => !n.startsWith("."));
      } catch {
        bundleDirs = [];
      }
      if (bundleDirs.length > 0) continue;
      try {
        rmSync(root, { recursive: true, force: true });
        result.changes.push({
          platform: id,
          action: "remove",
          path: root,
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
 * then drive the host's update flow through the driver (claude: `plugin update`,
 * falling back to uninstall+install; codex/agy: re-stage + the install verb,
 * which is an idempotent overwrite). Warns when connector.version is unchanged
 * since the recorded install — hosts cache a versioned COPY, so a same-version
 * update silently no-ops.
 */
export async function upgradeViaMarketplace(
  opts: MarketplaceInstallOptions,
): Promise<InstallResult> {
  const { connector, scope, dryRun } = opts;
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
    for (const id of DRIVABLE_MARKETPLACE_PLATFORMS) {
      if (targets.includes(id)) continue;
      const driver = getMarketplaceDriver(id);
      if (driver?.installed(connector.id)) targets = [...targets, id];
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
    const driver = getMarketplaceDriver(id);
    if (!driver) {
      result.changes.push({
        platform: id,
        action: "warn",
        detail: `agent-connector cannot drive a ${id} marketplace upgrade yet — re-run \`agent-connector package\` and the host's own update flow`,
      });
      continue;
    }

    const record = readMarketplaceInstalls(connector.id)[id];
    if (!record && !driver.installed(connector.id)) {
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
          `${id} caches a versioned copy, so bump connector.version for the update to take effect`,
      });
    }

    const pluginDir = driver.pluginDir(connector.id);
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
        detail: `drive the ${id} host update flow`,
      });
      continue;
    }

    const contentHash = driver.stage(connector, result.changes);
    const outcome = await driver.driveUpdate(connector.id);
    result.changes.push(...outcome.changes);
    if (outcome.ok) {
      const installs = readMarketplaceInstalls(connector.id);
      installs[id] = {
        format: record?.format ?? driver.format,
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
 * state on ANY drivable host (no noise for direct-only users).
 *
 * Claude's group (the original, richest check set) comes first and is BYTE-
 * IDENTICAL to the pre-driver behavior — emitted only when claude has state.
 * Each other drivable host (codex, antigravity, antigravity-cli) contributes a
 * driver-based group, emitted only when THAT host has state, in registry order.
 */
export async function marketplaceDoctorChecks(
  connector: ResolvedConnector,
  scope: InstallScope,
  projectDir: string,
): Promise<MarketplaceDoctorGroup[]> {
  const groups: MarketplaceDoctorGroup[] = [];

  const claude = await claudeMarketplaceGroup(connector, scope, projectDir);
  if (claude) groups.push(claude);

  // The other drivable hosts share one generic, driver-based group builder.
  // antigravity + antigravity-cli are the SAME physical host behind one shared
  // agy driver (identical host-state probe), so emitting one group per id would
  // double-count: a record under antigravity-cli makes `installed()` true for
  // antigravity too, yielding a spurious drift group for the sibling id. Dedupe
  // by shared HOST identity, with the id that HAS the record preferred as the
  // representative (sorted first). The agy registry memoizes a SEPARATE driver
  // instance per id, so we cannot dedupe by instance identity — both agy ids
  // return the same stagingRoot, which uniquely identifies the host store.
  const seenHosts = new Set<string>();
  const candidates = (
    [
      "codex",
      "droid",
      "antigravity",
      "antigravity-cli",
      "gemini-cli",
      "qwen-code",
      "opencode",
      "kilo",
      "kilo-cli",
    ] as PlatformId[]
  ).sort((a, b) => recordRank(connector.id, a) - recordRank(connector.id, b));
  for (const platform of candidates) {
    const driver = getMarketplaceDriver(platform);
    if (!driver) continue;
    const hostKey = doctorHostKey(platform, driver.stagingRoot());
    if (seenHosts.has(hostKey)) continue;
    const group = await genericMarketplaceGroup(connector, platform, scope, projectDir);
    if (group) {
      groups.push(group);
      seenHosts.add(hostKey);
    }
  }

  // Stable, intuitive order: claude first, then codex, then the agy host.
  groups.sort((a, b) => platformDoctorRank(a.platform) - platformDoctorRank(b.platform));

  return groups;
}

/**
 * Dedup key identifying ONE physical host store, so sibling PlatformIds that
 * share a store collapse into a single doctor group. agy (antigravity +
 * antigravity-cli) and codex/gemini each have a unique staging root, so the root
 * IS the key. The npm-local hosts SHARE one staging root across three DISTINCT
 * hosts (opencode vs kilo) — but kilo and kilo-cli share the same config file —
 * so the key is the host's CONFIG file path there, not the staging root.
 */
function doctorHostKey(platform: PlatformId, stagingRoot: string): string {
  if (platform === "opencode" || platform === "kilo" || platform === "kilo-cli") {
    return npmConfigFilePath(platform);
  }
  return stagingRoot;
}

/** Sort key so a platform that HAS a marketplace record is preferred as the
 * representative id for a shared driver (the user's actual target id wins). */
function recordRank(connectorId: string, platform: PlatformId): number {
  return readMarketplaceInstalls(connectorId)[platform] ? 0 : 1;
}

/** Doctor group ordering: claude, codex, agy, gemini, then the npm hosts. */
function platformDoctorRank(platform: PlatformId): number {
  const order: PlatformId[] = [
    "claude-code",
    "codex",
    "droid",
    "antigravity",
    "antigravity-cli",
    "gemini-cli",
    "qwen-code",
    "opencode",
    "kilo",
    "kilo-cli",
  ];
  const i = order.indexOf(platform);
  return i === -1 ? order.length : i;
}

/**
 * Claude's marketplace doctor group — the original checks 1–6, unchanged. Kept
 * verbatim (only the `id`/`record`/`pluginPresent` preamble and the
 * early-return-to-null differ) so claude's output stays byte-identical. Returns
 * null when claude has no marketplace state (the original "silent" path).
 */
async function claudeMarketplaceGroup(
  connector: ResolvedConnector,
  scope: InstallScope,
  projectDir: string,
): Promise<MarketplaceDoctorGroup | null> {
  const id = connector.id;
  const record = readMarketplaceInstalls(id)["claude-code"];
  const pluginPresent = claudePluginInstalled(id);
  if (!record && !pluginPresent) return null;

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

  return { platform: "claude-code", results };
}

/**
 * The generic driver-based marketplace doctor group for a NON-claude drivable
 * host (codex, antigravity, antigravity-cli). It mirrors claude's checks via the
 * platform's {@link MarketplaceDriver} state probes, omitting only the
 * claude-specific catalog-registration check (the registration shape differs per
 * host and is covered by the host's own install path). Returns null when the
 * host has no marketplace state at all (record absent AND not host-installed) —
 * matching claude's "silent when no state" behavior, so direct-only and
 * claude-only users see no new groups.
 */
async function genericMarketplaceGroup(
  connector: ResolvedConnector,
  platform: PlatformId,
  scope: InstallScope,
  projectDir: string,
): Promise<MarketplaceDoctorGroup | null> {
  const driver = getMarketplaceDriver(platform);
  if (!driver) return null;

  const id = connector.id;
  const record = readMarketplaceInstalls(id)[platform];
  const installed = driver.installed(id);
  if (!record && !installed) return null;

  const results: DiagnosticResult[] = [];

  // 1. duplicate-registration (the double-install invariant, after the fact).
  const direct = await directInstallPresent(connector, platform, scope, projectDir);
  if (direct && installed) {
    results.push({
      check: `${id}: marketplace duplicate-registration`,
      status: "fail",
      message: `installed BOTH directly and as a marketplace plugin on ${platform} — hooks + MCP server are duplicated`,
      fix: `uninstall one method: \`agent-connector uninstall --method marketplace --targets ${platform}\` or \`agent-connector uninstall --targets ${platform}\``,
    });
  }

  // 2. state ↔ host drift (both directions).
  if (record && !installed) {
    results.push({
      check: `${id}: marketplace state drift`,
      status: "warn",
      message: `recorded as marketplace-installed but ${platform}'s state shows the plugin absent`,
      fix: `re-run \`agent-connector install --method marketplace --targets ${platform}\` or \`agent-connector uninstall --method marketplace --targets ${platform}\` to reconcile`,
    });
  } else if (!record && installed) {
    results.push({
      check: `${id}: marketplace state drift`,
      status: "warn",
      message: `${platform} lists the plugin installed but agent-connector has no record of it (manual install?)`,
      fix: `adopt it: \`agent-connector install --method marketplace --targets ${platform}\` (idempotent), or remove it via the host's plugin uninstall`,
    });
  }

  // 3. staleness: connector changed since the recorded install (the host caches
  // a versioned COPY, so edits do not reach it until an upgrade).
  if (record) {
    if (connector.version !== "0.0.0" && connector.version !== record.version) {
      results.push({
        check: `${id}: marketplace staleness`,
        status: "warn",
        message: `connector.version ${connector.version} ≠ installed ${record.version}`,
        fix: `agent-connector upgrade --method marketplace --targets ${platform}`,
      });
    } else if (
      existsSync(record.bundleDir) &&
      record.contentHash !== "" &&
      hashDirectory(record.bundleDir) !== record.contentHash
    ) {
      results.push({
        check: `${id}: marketplace staleness`,
        status: "warn",
        message: `staged bundle changed since install — ${platform}'s cached copy is stale`,
        fix: `agent-connector upgrade --method marketplace --targets ${platform}`,
      });
    }
  }

  // 4. embedded home-bin launcher: the installed plugin's hooks exec it OUTSIDE
  // any adapter-managed config.
  if (installed && !existsSync(homeBinPath())) {
    results.push({
      check: `${id}: marketplace home-bin`,
      status: "fail",
      message: `installed plugin hooks exec ${homeBinPath()} which does not exist`,
      fix: "agent-connector upgrade",
    });
  }

  // 5. host binary missing for a recorded marketplace install.
  if (record && driver.binary() == null) {
    results.push({
      check: `${id}: marketplace host binary`,
      status: "warn",
      message: `${platform} CLI not found on PATH — the recorded marketplace install cannot be managed until it is reinstalled`,
    });
  }

  // A green summary line when nothing above flagged.
  if (results.every((r) => r.status === "pass")) {
    results.push({
      check: `${id}: marketplace install`,
      status: "pass",
      message: `${id} installed via marketplace on ${platform} (version ${record?.version ?? "unknown"})`,
    });
  }

  return { platform, results };
}

// Re-exported so CLI surfaces can partition uninstall targets without importing
// the leaf state module everywhere.
export { marketplaceEvidence } from "./marketplace-state.js";
