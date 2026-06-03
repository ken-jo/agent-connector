/**
 * core/installer — install / uninstall / sync orchestration.
 *
 * This is the coordination layer that sits above the per-platform adapters. It
 * does NOT know any platform's native dialect (that is the adapter's job); it
 * owns the cross-cutting choreography that every install flow shares:
 *
 *   1. Refresh the single stable home binary (so every host's pointer config
 *      keeps execing a working CLI) and register the connector's serializable
 *      metadata so the runtime can re-import live handlers later.
 *   2. Resolve the set of target platforms — explicit flag → connector targets →
 *      auto-detected installed hosts — intersected with the registry's known ids.
 *   3. For each target: load its adapter, build a uniform InstallContext, back up
 *      the native settings, then render the MCP server + hooks (install) or strip
 *      them (uninstall). Per-adapter failures are captured as `warn` ChangeRecords
 *      and never abort the whole run — partial success is always reported.
 *
 * `sync` is just an idempotent re-run of `install`: adapters are write-idempotent
 * (identical entries yield "skip"), and `ensureHomeBin` heals a stale/missing
 * home-bin pointer on every pass (docs/ARCHITECTURE.md §3 R1 / "sync … heals
 * stale pointers").
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ChangeRecord,
  InstallResult,
  InstallScope,
  PlatformId,
  ResolvedConnector,
} from "./types.js";
import type { Adapter, InstallContext } from "../adapters/spi.js";
import { REGISTERED_PLATFORM_IDS, loadAdapter } from "../adapters/registry.js";
import { detectInstalledPlatforms } from "../adapters/detect.js";
import { loadRegisteredConnector, registerConnector } from "./load-connector.js";
import { dataRoot, ensureHomeBin, homeBinPath } from "./paths.js";
import { log } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────

/** Options for {@link installConnector} / {@link syncConnector}. */
export interface OrchestrationOptions {
  /** The live, resolved connector (with hook handlers) to deploy. */
  connector: ResolvedConnector;
  /** Absolute path to the source module that produced `connector`. */
  modulePath: string;
  /** Default install scope; per-platform overrides win where present. */
  scope: InstallScope;
  /** Resolved project root used by project-scoped adapters and detection. */
  projectDir: string;
  /** Explicit target allow-list. Omit to derive from the connector / detection. */
  targets?: PlatformId[];
  /** Render but do not write anything. */
  dryRun: boolean;
}

/** Options for {@link uninstallConnector}. */
export interface UninstallOptions {
  /** Id of a previously-registered connector to tear down. */
  connectorId: string;
  /** Default scope to uninstall from; per-platform overrides win. */
  scope: InstallScope;
  /** Resolved project root used by project-scoped adapters and detection. */
  projectDir: string;
  /** Explicit target allow-list. Omit to derive from the connector / detection. */
  targets?: PlatformId[];
  /** Compute changes but do not write anything. */
  dryRun: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// Public orchestration
// ─────────────────────────────────────────────────────────────────────────

/**
 * Install a connector across its target platforms.
 *
 * Steps mirror docs/ARCHITECTURE.md §8 ("Install per target"):
 *   1. Refresh the stable home binary + register connector metadata.
 *   2. Resolve targets (flag → connector.targets → auto-detect) ∩ registry ids.
 *   3. Per target: backup → installServer → installHooks, collecting changes.
 * Per-adapter errors become `warn` records; the run never aborts midway.
 */
export async function installConnector(
  opts: OrchestrationOptions,
): Promise<InstallResult> {
  const { connector, modulePath, scope, projectDir, dryRun } = opts;

  // 1. Stable home binary + connector registry record. These are framework-state
  //    mutations (never platform-native config) and are safe to skip on dry-run.
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

  const targets = await resolveTargets(opts.targets, connector.targets, projectDir);
  const result = newResult(connector.id, dryRun);

  if (targets.length === 0) {
    result.warnings.push(
      "no target platforms resolved (none installed / detected, or all filtered out)",
    );
    return result;
  }

  for (const id of targets) {
    const adapter = await tryLoadAdapter(id, result);
    if (!adapter) continue;

    const ctx = buildContext(connector, id, scope, projectDir, dryRun);

    // Back up native settings before any mutation (no-op on dry-run / absent file).
    if (!dryRun) {
      runStep(id, "backupSettings", result, () => {
        const backup = adapter.backupSettings(ctx);
        if (backup) {
          result.changes.push({
            platform: id,
            action: "create",
            path: backup,
            detail: "backed up settings before install",
          });
        }
      });
    }

    runStep(id, "installServer", result, () => {
      pushAll(result.changes, adapter.installServer(ctx));
    });
    runStep(id, "installHooks", result, () => {
      pushAll(result.changes, adapter.installHooks(ctx));
    });

    // Content surfaces: guarded by declaration so undeclared surfaces add no
    // noise. BaseAdapter defines all six, so the `!` is safe; per-step
    // try/catch (runStep) turns any adapter failure into a warn, never aborting.
    if (connector.commands.length) {
      runStep(id, "installCommands", result, () => {
        pushAll(result.changes, adapter.installCommands!(ctx));
      });
    }
    if (connector.skills.length) {
      runStep(id, "installSkills", result, () => {
        pushAll(result.changes, adapter.installSkills!(ctx));
      });
    }
    if (connector.subagents.length) {
      runStep(id, "installSubagents", result, () => {
        pushAll(result.changes, adapter.installSubagents!(ctx));
      });
    }
  }

  return result;
}

/**
 * Idempotent re-run of {@link installConnector}: every adapter re-renders its
 * config (identical entries report "skip"), and `ensureHomeBin` repairs a stale
 * or missing home-bin pointer. Use after editing a connector or upgrading the
 * framework. Behaviorally identical to install — the distinct name documents
 * intent and gives the CLI a stable verb to wire `agent-connector sync` to.
 */
export async function syncConnector(
  opts: OrchestrationOptions,
): Promise<InstallResult> {
  return installConnector(opts);
}

/**
 * Uninstall a previously-registered connector: strip its hook registrations and
 * MCP server entries from every target platform. The registered connector is
 * loaded (best-effort) only to provide adapter context (server id, hook ids,
 * per-platform overrides); when it cannot be loaded a minimal synthetic
 * connector built from the id still lets adapters locate and remove their
 * entries (they key removals off `connector.id` + the home-bin path).
 */
export async function uninstallConnector(
  opts: UninstallOptions,
): Promise<InstallResult> {
  const { connectorId, scope, projectDir, dryRun } = opts;

  const connector = await loadConnectorForUninstall(connectorId);
  const result = newResult(connectorId, dryRun);

  const targets = await resolveTargets(opts.targets, connector.targets, projectDir);
  if (targets.length === 0) {
    result.warnings.push(
      "no target platforms resolved for uninstall (none installed / detected, or all filtered out)",
    );
    return result;
  }

  for (const id of targets) {
    const adapter = await tryLoadAdapter(id, result);
    if (!adapter) continue;

    const ctx = buildContext(connector, id, scope, projectDir, dryRun);

    // Inverse order of install: remove content surfaces, then hooks, then the
    // server entry. Surface removals are guarded by declaration; BaseAdapter
    // defines all six so the `!` is safe.
    if (connector.subagents.length) {
      runStep(id, "uninstallSubagents", result, () => {
        pushAll(result.changes, adapter.uninstallSubagents!(ctx));
      });
    }
    if (connector.commands.length) {
      runStep(id, "uninstallCommands", result, () => {
        pushAll(result.changes, adapter.uninstallCommands!(ctx));
      });
    }
    if (connector.skills.length) {
      runStep(id, "uninstallSkills", result, () => {
        pushAll(result.changes, adapter.uninstallSkills!(ctx));
      });
    }
    runStep(id, "uninstallHooks", result, () => {
      pushAll(result.changes, adapter.uninstallHooks(ctx));
    });
    runStep(id, "uninstallServer", result, () => {
      pushAll(result.changes, adapter.uninstallServer(ctx));
    });
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────

/**
 * Absolute path to the CLI entry (`dist/cli.js`) the home binary should exec.
 *
 * Robust to the bundler's output layout: tsup flattens this module into a
 * `dist/chunk-*.js`, so a fixed relative guess like `../cli.js` is wrong. We
 * instead walk up from this module to the package root (the dir whose
 * `package.json` declares the `agent-connector` bin) and use its `dist/cli.js`.
 * Fallbacks: a same-directory `cli.js` (flat-bundle case) then `process.argv[1]`.
 */
export function resolveCliEntry(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      if (existsSync(join(dir, "package.json"))) {
        const cli = join(dir, "dist", "cli.js");
        if (existsSync(cli)) return cli;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    // Flat-bundle case: cli.js sits beside this chunk.
    const sameDir = fileURLToPath(new URL("./cli.js", import.meta.url));
    if (existsSync(sameDir)) return sameDir;
  } catch {
    /* fall through */
  }
  const argv1 = process.argv[1];
  if (argv1 && argv1.length > 0) return argv1;
  return "cli.js";
}

/**
 * Resolve the ordered, de-duplicated list of platform targets, intersected with
 * the adapter registry's known ids (an unknown id can have no adapter to drive).
 *
 * Precedence: explicit `flagTargets` → connector's `targets` array → auto-detect
 * installed hosts. "auto" connector targets also fall through to detection.
 */
async function resolveTargets(
  flagTargets: PlatformId[] | undefined,
  connectorTargets: ResolvedConnector["targets"],
  projectDir: string,
): Promise<PlatformId[]> {
  let requested: PlatformId[];
  if (flagTargets && flagTargets.length > 0) {
    requested = flagTargets;
  } else if (Array.isArray(connectorTargets) && connectorTargets.length > 0) {
    requested = connectorTargets;
  } else {
    requested = await autoDetectIds(projectDir);
  }

  const seen = new Set<PlatformId>();
  const out: PlatformId[] = [];
  for (const id of requested) {
    if (!REGISTERED_PLATFORM_IDS.has(id)) continue; // no adapter registered → cannot drive it
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Auto-detect installed platforms and map them to their ids (best-effort). */
async function autoDetectIds(projectDir: string): Promise<PlatformId[]> {
  try {
    const detected = await detectInstalledPlatforms(projectDir);
    return detected.filter((p) => p.installed).map((p) => p.id);
  } catch (err) {
    log.warn(`platform detection failed: ${errMessage(err)}`);
    return [];
  }
}

/**
 * Build the uniform InstallContext for one platform. The effective scope is the
 * connector's per-platform override when present, else the run-wide default.
 */
function buildContext(
  connector: ResolvedConnector,
  id: PlatformId,
  defaultScope: InstallScope,
  projectDir: string,
  dryRun: boolean,
): InstallContext {
  return {
    connector,
    scope: connector.platforms[id]?.scope ?? defaultScope,
    projectDir,
    homeBinPath: homeBinPath(),
    dataRoot: dataRoot(),
    dryRun,
  };
}

/**
 * Load an adapter, recording a `warn` change (not throwing) when unavailable.
 * `loadAdapter` returns `undefined` for an unregistered id and may reject if the
 * adapter module itself fails to import; both degrade to a warn here.
 */
async function tryLoadAdapter(
  id: PlatformId,
  result: InstallResult,
): Promise<Adapter | null> {
  try {
    const adapter = await loadAdapter(id);
    if (adapter) return adapter;
    const detail = `no adapter registered for ${id}`;
    result.changes.push({ platform: id, action: "warn", detail });
    result.warnings.push(detail);
    return null;
  } catch (err) {
    const detail = `failed to load adapter for ${id}: ${errMessage(err)}`;
    result.changes.push({ platform: id, action: "warn", detail });
    result.warnings.push(detail);
    return null;
  }
}

/**
 * Run one adapter step, converting any thrown error into a `warn` ChangeRecord +
 * warning string so a single bad adapter never aborts the whole run.
 */
function runStep(
  id: PlatformId,
  step: string,
  result: InstallResult,
  fn: () => void,
): void {
  try {
    fn();
  } catch (err) {
    const detail = `${step} failed on ${id}: ${errMessage(err)}`;
    result.changes.push({ platform: id, action: "warn", detail });
    result.warnings.push(detail);
  }
}

/**
 * Load the registered connector for uninstall context. If it cannot be loaded
 * (record removed, source module deleted/moved), fall back to a minimal
 * synthetic connector carrying just the id — enough for adapters to locate and
 * strip their entries, which they match by `connector.id` + the home-bin path.
 */
async function loadConnectorForUninstall(
  connectorId: string,
): Promise<ResolvedConnector> {
  try {
    return await loadRegisteredConnector(connectorId);
  } catch (err) {
    log.warn(
      `could not load registered connector "${connectorId}" for uninstall (${errMessage(err)}); ` +
        "proceeding with a minimal id-only context",
    );
    return syntheticConnector(connectorId);
  }
}

/** Minimal id-only connector used as uninstall fallback context. */
function syntheticConnector(id: string): ResolvedConnector {
  return {
    id,
    displayName: id,
    version: "0.0.0",
    hooks: {},
    hookEvents: [],
    telemetry: {
      enabled: true,
      modelFamilyHint: "auto",
      measureToolDefs: true,
      store: "ndjson",
      calibration: { anthropicCountTokens: false },
    },
    commands: [],
    skills: [],
    subagents: [],
    platforms: {},
    targets: "auto",
  };
}

function newResult(connectorId: string, dryRun: boolean): InstallResult {
  return { connectorId, dryRun, changes: [], warnings: [] };
}

function pushAll(target: ChangeRecord[], records: ChangeRecord[]): void {
  for (const r of records) target.push(r);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
