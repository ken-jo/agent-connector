/**
 * core/marketplace-state — pure read/write helpers for MARKETPLACE-method
 * install state. A LEAF module (fs + paths only, no adapters, no spawning) so
 * the installer, the marketplace orchestration, doctor, and status can all
 * import it without cycles.
 *
 * Two kinds of state live here:
 *
 *   1. The per-connector state record `connectorDir(id)/marketplace-installs.json`
 *      — one entry per platform a connector was marketplace-installed on
 *      ({ format, bundleDir, marketplace, scope, version, contentHash,
 *      installedAt }). It drives `uninstall --method auto`, upgrade staleness
 *      warnings, doctor, and the double-install guard.
 *
 *   2. Read-only fs EVIDENCE probes of the hosts' own plugin state (e.g.
 *      Claude Code's `$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json`).
 *      These catch installs the user performed manually from `package`'s
 *      printed instructions, which the state record alone would miss. Probes
 *      read undocumented host internals, so every reader degrades to null/false
 *      on absence or parse failure — the guard convention is "refuse only on
 *      positive evidence" (docs: design risk 4).
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import TOML from "@iarna/toml";

import type { InstallScope, PlatformId } from "./types.js";
import type { PackageFormat } from "./package.js";
import { connectorDir, connectorsDir, dataRoot, ensureDir } from "./paths.js";

// ─────────────────────────────────────────────────────────────────────────
// State record: connectorDir(id)/marketplace-installs.json
// ─────────────────────────────────────────────────────────────────────────

/** The catalog name every staged local marketplace is registered under. */
export const MARKETPLACE_NAME = "agent-connector";

/** One marketplace install of one connector on one platform. */
export interface MarketplaceInstallRecord {
  /** Bundle format that was staged + installed (e.g. "claude-plugin"). */
  format: PackageFormat;
  /** Absolute path of the staged plugin dir the host references/copied. */
  bundleDir: string;
  /** Marketplace/catalog name the install is keyed under ({@link MARKETPLACE_NAME}). */
  marketplace: string;
  /** Install scope (v1: always "user"). */
  scope: InstallScope;
  /** connector.version at install time (staleness warnings key off this). */
  version: string;
  /** sha256 over the staged plugin dir at install time (drift detection). */
  contentHash: string;
  /** ISO timestamp of the recorded install. */
  installedAt: string;
}

/** platform → record map persisted per connector. */
export type MarketplaceInstalls = Partial<
  Record<PlatformId, MarketplaceInstallRecord>
>;

/** Path of the per-connector marketplace state record. */
export function marketplaceInstallsPath(connectorId: string): string {
  return join(connectorDir(connectorId), "marketplace-installs.json");
}

/** Read the state record ({} on absence/parse failure — never throws). */
export function readMarketplaceInstalls(connectorId: string): MarketplaceInstalls {
  try {
    const raw = readFileSync(marketplaceInstallsPath(connectorId), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as MarketplaceInstalls;
    }
  } catch {
    /* absent / unreadable → empty */
  }
  return {};
}

/** Write the state record; an empty map DELETES the file (uninstall leaves no husk). */
export function writeMarketplaceInstalls(
  connectorId: string,
  installs: MarketplaceInstalls,
): void {
  const path = marketplaceInstallsPath(connectorId);
  if (Object.keys(installs).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(installs, null, 2)}\n`, "utf8");
}

/** True when THIS connector has any recorded marketplace install. */
export function connectorHasMarketplaceRecords(connectorId: string): boolean {
  return Object.keys(readMarketplaceInstalls(connectorId)).length > 0;
}

/**
 * True when ANY registered connector (optionally excluding one) still records a
 * marketplace install. Guards home-bin removal on purge: an installed plugin's
 * hooks exec the home-bin OUTSIDE any adapter-managed config, so removing the
 * launcher while a marketplace install survives would silently kill its hooks.
 */
export function anyMarketplaceRecordsRemain(excludeConnectorId?: string): boolean {
  const dir = connectorsDir();
  if (!existsSync(dir)) return false;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  return entries.some(
    (id) => id !== excludeConnectorId && connectorHasMarketplaceRecords(id),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Staging roots — bundles staged by-reference must survive cwd changes and
// `rm -rf dist-plugin`, so they live under the data-root, one shared root per
// host family, holding every marketplace-installed connector's bundle plus ONE
// regenerated catalog named "agent-connector" listing them all.
// ─────────────────────────────────────────────────────────────────────────

/** Root for every marketplace staging tree: <dataRoot>/marketplace. */
export function marketplaceRoot(): string {
  return join(dataRoot(), "marketplace");
}

/** Shared Claude-family staging root: <dataRoot>/marketplace/claude. */
export function claudeStagingRoot(): string {
  return join(marketplaceRoot(), "claude");
}

/** Shared Codex-family staging root: <dataRoot>/marketplace/codex. */
export function codexStagingRoot(): string {
  return join(marketplaceRoot(), "codex");
}

/** Shared agy (Antigravity) staging root: <dataRoot>/marketplace/agy. */
export function agyStagingRoot(): string {
  return join(marketplaceRoot(), "agy");
}

// ─────────────────────────────────────────────────────────────────────────
// Claude Code host-state readers ($CLAUDE_CONFIG_DIR || ~/.claude)
// ─────────────────────────────────────────────────────────────────────────

/** Claude Code's config dir, honoring the CLAUDE_CONFIG_DIR override. */
export function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override && override.trim() !== "") return resolve(override);
  return join(homedir(), ".claude");
}

/** The installed_plugins.json key our marketplace install creates for `id`. */
export function claudePluginKey(connectorId: string): string {
  return `${connectorId}@${MARKETPLACE_NAME}`;
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* absent / unreadable → null */
  }
  return null;
}

/** The `plugins` map from Claude's installed_plugins.json (null when unreadable). */
export function readClaudeInstalledPlugins(): Record<string, unknown> | null {
  const file = join(claudeConfigDir(), "plugins", "installed_plugins.json");
  const parsed = readJsonFile(file);
  const plugins = parsed?.plugins;
  if (plugins && typeof plugins === "object" && !Array.isArray(plugins)) {
    return plugins as Record<string, unknown>;
  }
  return null;
}

/** True when Claude's own state lists `<id>@agent-connector` as installed. */
export function claudePluginInstalled(connectorId: string): boolean {
  const plugins = readClaudeInstalledPlugins();
  if (!plugins) return false;
  const entry = plugins[claudePluginKey(connectorId)];
  return Array.isArray(entry) ? entry.length > 0 : entry != null;
}

/** True when ANY `*@agent-connector` plugin remains in Claude's state. */
export function anyClaudeAgentConnectorPlugins(): boolean {
  const plugins = readClaudeInstalledPlugins();
  if (!plugins) return false;
  return Object.entries(plugins).some(
    ([key, entry]) =>
      key.endsWith(`@${MARKETPLACE_NAME}`) &&
      (Array.isArray(entry) ? entry.length > 0 : entry != null),
  );
}

/**
 * The directory Claude's known_marketplaces.json records for `name`, or null
 * when not registered / unreadable. Used both as a presence probe and as the
 * NAME-COLLISION check: a registration pointing somewhere other than our
 * staging root belongs to the user and must never be touched.
 */
export function claudeKnownMarketplacePath(name: string): string | null {
  const file = join(claudeConfigDir(), "plugins", "known_marketplaces.json");
  const parsed = readJsonFile(file);
  const entry = parsed?.[name];
  if (!entry || typeof entry !== "object") return null;
  const e = entry as { installLocation?: unknown; source?: { path?: unknown } };
  if (typeof e.installLocation === "string") return e.installLocation;
  const sourcePath = e.source?.path;
  return typeof sourcePath === "string" ? sourcePath : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Codex host-state readers ($CODEX_HOME || ~/.codex → config.toml)
// ─────────────────────────────────────────────────────────────────────────

/** Codex's config home, honoring the CODEX_HOME override (defaults to ~/.codex). */
export function codexConfigHome(): string {
  const env = process.env.CODEX_HOME;
  if (env && env.trim() !== "") {
    if (env.startsWith("~")) return join(homedir(), env.replace(/^~[/\\]?/, ""));
    return resolve(env);
  }
  return join(homedir(), ".codex");
}

/** The config.toml key our marketplace install creates for `id` (== claude's). */
export function codexPluginKey(connectorId: string): string {
  return `${connectorId}@${MARKETPLACE_NAME}`;
}

/** Parse <CODEX_HOME>/config.toml ({} on absence/parse failure — never throws). */
function readCodexConfig(): Record<string, unknown> {
  const file = join(codexConfigHome(), "config.toml");
  try {
    return TOML.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * True when Codex's config.toml carries the `[plugins."<id>@agent-connector"]`
 * table. The DEFINITIVE install probe — empty `plugins/cache/...` dirs linger
 * after uninstall, so the cache dir must NOT be used (docs: codex quirk).
 */
export function codexPluginInstalled(connectorId: string): boolean {
  const cfg = readCodexConfig();
  const plugins = cfg["plugins"];
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return false;
  return codexPluginKey(connectorId) in (plugins as Record<string, unknown>);
}

/** True when ANY `*@agent-connector` plugin remains in Codex's config.toml. */
export function anyCodexAgentConnectorPlugins(): boolean {
  const cfg = readCodexConfig();
  const plugins = cfg["plugins"];
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return false;
  return Object.keys(plugins as Record<string, unknown>).some((k) =>
    k.endsWith(`@${MARKETPLACE_NAME}`),
  );
}

/**
 * The directory config.toml records as `[marketplaces.agent-connector].source`,
 * or null when not registered / unreadable. Both a presence probe and the
 * NAME-COLLISION check: a registration pointing somewhere other than our
 * staging root belongs to the user and must never be touched.
 */
export function codexMarketplaceSource(name: string): string | null {
  const cfg = readCodexConfig();
  const marketplaces = cfg["marketplaces"];
  if (!marketplaces || typeof marketplaces !== "object" || Array.isArray(marketplaces)) {
    return null;
  }
  const entry = (marketplaces as Record<string, unknown>)[name];
  if (!entry || typeof entry !== "object") return null;
  const source = (entry as { source?: unknown }).source;
  return typeof source === "string" ? source : null;
}

// ─────────────────────────────────────────────────────────────────────────
// agy (Antigravity) host-state readers (~/.gemini/config/plugins, NO env)
// ─────────────────────────────────────────────────────────────────────────

/** agy's config dir: ~/.gemini/config (NO dedicated env — HOME isolation). */
export function agyConfigDir(): string {
  return join(homedir(), ".gemini", "config");
}

/** agy's plugins dir: ~/.gemini/config/plugins. */
export function agyPluginsDir(): string {
  return join(agyConfigDir(), "plugins");
}

/**
 * Candidate `import_manifest.json` locations. agy 1.0.7 records the manifest at
 * `<config>/plugins/import_manifest.json` on POSIX but at
 * `<config>/import_manifest.json` on Windows (live-confirmed on the my-window
 * box) — both are probed, then the copied plugin dir is the final fallback.
 */
export function agyImportManifestPaths(): string[] {
  return [
    join(agyConfigDir(), "import_manifest.json"), // win32 location
    join(agyPluginsDir(), "import_manifest.json"), // posix location
  ];
}

/** @deprecated single-location accessor — prefer {@link agyImportManifestPaths}. */
export function agyImportManifestPath(): string {
  return join(agyPluginsDir(), "import_manifest.json");
}

/**
 * True when `id` is installed per agy's import manifest (`imports[].name`),
 * checking BOTH the win32 and posix manifest locations, with a fallback probe of
 * the copied plugin dir's plugin.json. agy's uninstall removes the plugin dir
 * and clears the manifest entry (live-verified on Windows: install → dir +
 * manifest present, uninstall → both gone, re-install idempotent).
 */
export function agyPluginInstalled(connectorId: string): boolean {
  for (const manifest of agyImportManifestPaths()) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
        imports?: unknown;
      };
      const imports = parsed.imports;
      if (
        Array.isArray(imports) &&
        imports.some(
          (e) =>
            e != null &&
            typeof e === "object" &&
            (e as { name?: unknown }).name === connectorId,
        )
      ) {
        return true;
      }
    } catch {
      /* absent / unreadable manifest → try the next candidate */
    }
  }
  return existsSync(join(agyPluginsDir(), connectorId, "plugin.json"));
}

// ─────────────────────────────────────────────────────────────────────────
// Cross-host marketplace-install EVIDENCE (the double-install guard's probe)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Read-only evidence that `connectorId` is marketplace/plugin-installed on
 * `platform`: the state record first, then a cheap fs probe of the host's own
 * plugin state (catches manual installs from `package`'s printed instructions).
 * Returns a human-readable description of the evidence, or null when none.
 */
export function marketplaceEvidence(
  connectorId: string,
  platform: PlatformId,
): string | null {
  if (readMarketplaceInstalls(connectorId)[platform]) {
    return "recorded in marketplace-installs.json";
  }
  switch (platform) {
    case "claude-code":
      if (claudePluginInstalled(connectorId)) {
        return `${claudePluginKey(connectorId)} listed in Claude's installed_plugins.json`;
      }
      return null;
    case "gemini-cli": {
      const dir = join(homedir(), ".gemini", "extensions", connectorId);
      return existsSync(dir) ? `extension dir ${dir} exists` : null;
    }
    case "antigravity":
    case "antigravity-cli": {
      const dir = join(homedir(), ".gemini", "config", "plugins", connectorId);
      return existsSync(dir) ? `plugin dir ${dir} exists` : null;
    }
    case "codex": {
      const codexHome =
        process.env.CODEX_HOME && process.env.CODEX_HOME.trim() !== ""
          ? resolve(process.env.CODEX_HOME)
          : join(homedir(), ".codex");
      const dir = join(codexHome, "plugins", "cache", MARKETPLACE_NAME, connectorId);
      return existsSync(dir) ? `codex plugin cache ${dir} exists` : null;
    }
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Content hashing — staged-bundle drift detection
// ─────────────────────────────────────────────────────────────────────────

/**
 * Deterministic sha256 over every file under `dir` (sorted relative paths +
 * bytes). Empty string when the dir is missing/unreadable. Used to record the
 * staged bundle's content at install time and detect drift later (claude caches
 * a versioned COPY, so an edited connector goes silently stale without this).
 */
export function hashDirectory(dir: string): string {
  if (!existsSync(dir)) return "";
  const files: string[] = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const full = join(d, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) files.push(full);
    }
  };
  walk(dir);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(relative(dir, file).split("\\").join("/"));
    hash.update("\0");
    try {
      hash.update(readFileSync(file));
    } catch {
      /* unreadable file contributes only its path */
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}
