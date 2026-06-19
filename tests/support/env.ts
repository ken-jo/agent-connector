/**
 * tests/support/env — the ONE shared test-environment harness for adapter tests.
 *
 * Before this module each adapter test re-declared its own `HOME_BIN`,
 * `buildCtx`, `freshProject`, and env save/restore (buildCtx in ~68 files,
 * freshProject in ~55). That duplication is how the Windows 8.3 short-name bug
 * (RUNNER~1 → %7E breaking dynamic import()) shipped: only ~13 of the 55
 * freshProject copies expanded the short name. Centralising it here fixes that
 * bug class ONCE and gives every host file the same predictable setup.
 *
 * Convention (see tests/README.md): a per-host test file calls `isolateEnv()`
 * once at suite top, then `freshProject()` + `buildCtx()` per test. Cross-host
 * invariants live in tests/contracts/ and reuse the same helpers.
 */
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach } from "vitest";

import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

/** The canonical fake home-bin path every adapter test points hook commands at. */
export const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";

/**
 * The Windows-safe temp-dir primitive. `realpathSync.native` expands the Windows
 * 8.3 short name (e.g. `C:\Users\RUNNER~1\…`) to its long form — otherwise the
 * `~` survives into `pathToFileURL` as `%7E` and a dynamic `import()` of a
 * generated plugin fails to resolve ("Does the file exist?"). EVERY temp dir in
 * the test suite goes through here. Does NOT touch env (use the shapes below).
 */
export function tempDir(prefix = "ac-test-"): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * Shape A (most adapters): one temp dir that is BOTH HOME and the project dir —
 * project-scoped writes land under it, user-scoped writes under the same HOME.
 * Sets HOME / USERPROFILE / data-root. Returns the dir.
 */
export function freshProject(prefix = "ac-test-"): string {
  const dir = tempDir(prefix);
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  // Sandbox $XDG_CONFIG_HOME to the temp HOME. Equivalent to the unset-fallback
  // (xdgConfigHome() → join(homedir(), ".config")) on a clean box, but explicit so
  // an XDG-honoring adapter (kilo / kilo-cli / crush …) resolves user-scope paths
  // deterministically — CI runners set XDG_CONFIG_HOME=/home/runner/.config, which
  // would otherwise leak in and (a) break user-scope path assertions and (b) write
  // into the runner's real ~/.config. Matches freshHomeProject's sandboxing.
  process.env.XDG_CONFIG_HOME = join(dir, ".config");
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  return dir;
}

/**
 * Shape B (user-scoped hosts whose config lives under HOME, e.g. windsurf /
 * amazon-q / cursor): a separate HOME and a `project/` subdir, plus the
 * Windows/XDG config roots so `homedir()`-based resolution is fully sandboxed.
 */
export function freshHomeProject(prefix = "ac-test-"): { home: string; projectDir: string } {
  const home = tempDir(prefix);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.AGENT_CONNECTOR_DATA_DIR = join(home, ".agent-connector");
  const projectDir = join(home, "project");
  mkdirSync(projectDir, { recursive: true });
  return { home, projectDir };
}

/** Options for {@link buildCtx} — all default to the common adapter-test shape. */
export interface BuildCtxOptions {
  scope?: InstallContext["scope"];
  dataRoot?: string;
  homeBinPath?: string;
  dryRun?: boolean;
}

/**
 * Build an InstallContext scoped to `projectDir` with the canonical defaults.
 * The 3rd argument accepts either a bare scope string (the common
 * `buildCtx(dir, c, "user")` form the existing suite uses) OR a full options
 * object for the rare cases that need a custom dataRoot / homeBinPath / dryRun.
 */
export function buildCtx(
  projectDir: string,
  connector: ResolvedConnector,
  scopeOrOpts: InstallContext["scope"] | BuildCtxOptions = "project",
): InstallContext {
  const opts: BuildCtxOptions =
    typeof scopeOrOpts === "string" ? { scope: scopeOrOpts } : scopeOrOpts;
  return {
    connector,
    scope: opts.scope ?? "project",
    projectDir,
    homeBinPath: opts.homeBinPath ?? HOME_BIN,
    dataRoot: opts.dataRoot ?? join(projectDir, ".agent-connector"),
    dryRun: opts.dryRun ?? false,
  };
}

/**
 * Register beforeEach/afterEach that snapshot + restore the env keys a test
 * mutates (HOME / USERPROFILE / AGENT_CONNECTOR_DATA_DIR by default, plus any
 * connector-specific vars passed in `extraKeys`). Call once at suite top.
 */
export function isolateEnv(extraKeys: readonly string[] = []): void {
  const keys = [
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "XDG_CONFIG_HOME",
    "AGENT_CONNECTOR_DATA_DIR",
    ...extraKeys,
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}
