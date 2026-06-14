/**
 * core/marketplace-drivers/types — the driver abstraction the marketplace
 * orchestrator dispatches through.
 *
 * A {@link MarketplaceDriver} encapsulates EVERYTHING host-specific about the
 * `install --method marketplace` lifecycle for one host family: where bundles
 * stage, how to probe the host's own install state, how to emit the bundle, and
 * how to DRIVE the host's plugin/marketplace CLI for install/uninstall/upgrade.
 * The orchestrator (marketplace.ts) keeps only the generic, platform-agnostic
 * policy (double-install guard, dry-run rendering, state-record bookkeeping).
 *
 * Two driver SHAPES exist behind the one interface:
 *   • CATALOG drivers (claude, codex) — a shared staging root holds every staged
 *     connector plus ONE regenerated catalog named "agent-connector"; install
 *     registers that local marketplace then installs `<id>@agent-connector`.
 *     `finishUninstall` regenerates the catalog and de-registers the marketplace
 *     when nothing of ours remains (collision-safe).
 *   • DIRECT drivers (agy) — no catalog, no marketplace; the host installs by
 *     path and copies the bundle into its own store, so `finishUninstall` only
 *     removes the staged bundle.
 *
 * Every method is PROBE-FIRST (decisions key off the host's state files, never
 * exit codes) and NEVER throws (failures become `warn` ChangeRecords). The
 * `drive*` methods spawn through marketplace-drivers/shared.ts.
 */

import type { ChangeRecord, PlatformId } from "../types.js";
import type { PackageFormat } from "../package.js";
import type { ResolvedConnector } from "../types.js";

/** Outcome of a host-driving step (install / uninstall / update). */
export interface MarketplaceDriveOutcome {
  /** ChangeRecords produced by the step (skips, creates, removes, warns). */
  changes: ChangeRecord[];
  /**
   * True when the host's POST-RUN state matches the step's goal:
   * install/update → plugin present; uninstall → plugin absent. The orchestrator
   * keys state-record writes (install/upgrade) and cleanup (uninstall) off this,
   * so a failed spawn leaves the record/bundle exactly as it was.
   */
  ok: boolean;
}

/**
 * One host family's marketplace driver. Implementations are stateless singletons
 * (claudeDriver / codexDriver / agyDriver) resolved via the registry.
 */
export interface MarketplaceDriver {
  /** The PlatformId this driver primarily speaks for (the agy driver serves two). */
  readonly platform: PlatformId;
  /** The bundle format this driver stages + installs. */
  readonly format: PackageFormat;

  /** Absolute path of the host CLI on PATH, or null when not installed. */
  binary(): string | null;
  /** Shared staging root under the data-root (stable across cwd changes). */
  stagingRoot(): string;
  /** Absolute path of `id`'s staged bundle dir inside the staging root. */
  pluginDir(id: string): string;
  /** PROBE: is `id` installed per the HOST's own state file (never exit codes)? */
  installed(id: string): boolean;

  /**
   * Emit (or re-emit) `id`'s bundle into the staging root, pushing the staging
   * ChangeRecords (and, for catalog drivers, regenerating the shared catalog).
   * Returns the content hash of the staged bundle for drift detection.
   */
  stage(connector: ResolvedConnector, changes: ChangeRecord[]): string;

  /** Dry-run: push the host commands install WOULD run, without spawning. */
  planInstall(connector: ResolvedConnector, changes: ChangeRecord[]): void;
  /** Dry-run: push the host commands uninstall WOULD run, without spawning. */
  planUninstall(id: string, changes: ChangeRecord[]): void;

  /** Drive the host install for an ALREADY-STAGED bundle (probe-first). */
  driveInstall(id: string): Promise<MarketplaceDriveOutcome>;
  /** Drive the host uninstall (probe-first: absent → `=` skip, never an error). */
  driveUninstall(id: string): Promise<MarketplaceDriveOutcome>;
  /** Drive the host update for an ALREADY-RE-STAGED bundle (probe-first). */
  driveUpdate(id: string): Promise<MarketplaceDriveOutcome>;

  /**
   * Post-uninstall cleanup AFTER {@link driveUninstall} confirmed removal:
   * remove the staged bundle dir, and for catalog drivers regenerate the catalog
   * without `id` + de-register the marketplace when nothing of ours remains
   * (collision-safe). Pushes its own ChangeRecords; never throws.
   */
  finishUninstall(id: string, changes: ChangeRecord[]): Promise<void>;
}
