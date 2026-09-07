/**
 * core/version — agent-connector's own package version, plus the version of
 * the agent-connector install that a given CLI entry file belongs to.
 *
 * Used by `--version`, by registerConnector (which stamps the framework version
 * onto every connector record so doctor can spot installs rendered by an older
 * release), and by doctor's home-bin check (which compares the launcher's
 * target install against the running CLI).
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const PACKAGE_NAME = "@ken-jo/agent-connector";

/**
 * Resolve agent-connector's own package version at runtime. Works from both the
 * bundled dist layout (dist/*.js → ../package.json) and the src layout under
 * tsx/vitest (src/core/ → ../../package.json); the name check guards against
 * accidentally reading some other package.json on the walk.
 */
export function resolveOwnVersion(): string {
  const req = createRequire(import.meta.url);
  for (const rel of ["../package.json", "../../package.json", "../../../package.json"]) {
    try {
      const pkg = req(rel) as { name?: string; version?: string };
      if (pkg.name === PACKAGE_NAME && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      /* keep walking */
    }
  }
  return "0.0.0";
}

/**
 * The agent-connector package version that OWNS `cliEntry` (an absolute path to
 * a `dist/cli.js`), found by walking up to the nearest package.json whose name
 * is agent-connector's. Returns null when no such package.json is reachable
 * (the entry is not inside an agent-connector install, or it is gone).
 */
export function versionOfCliEntry(cliEntry: string): string | null {
  let dir = dirname(cliEntry);
  for (let i = 0; i < 6; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
        if (pkg.name === PACKAGE_NAME && typeof pkg.version === "string") return pkg.version;
      } catch {
        /* unreadable — keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The CLI entry a home-bin launcher execs, parsed from the launcher text that
 * ensureHomeBin writes (`exec "<node>" "<cli>" "$@"` on POSIX, `"<node>" "<cli>" %*`
 * on Windows). Null when the text is not a launcher we wrote.
 */
export function cliEntryOfLauncher(launcherText: string): string | null {
  const m = launcherText.match(/"([^"]+)"\s+"([^"]+)"\s+(?:"\$@"|%\*)/);
  return m?.[2] ?? null;
}
