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

/** Shared Gemini-CLI staging root: <dataRoot>/marketplace/gemini. */
export function geminiStagingRoot(): string {
  return join(marketplaceRoot(), "gemini");
}

/** Shared Qwen-Code staging root: <dataRoot>/marketplace/qwen. */
export function qwenStagingRoot(): string {
  return join(marketplaceRoot(), "qwen");
}

/** Shared droid (Factory) staging root: <dataRoot>/marketplace/droid. */
export function droidStagingRoot(): string {
  return join(marketplaceRoot(), "droid");
}

/**
 * Shared npm-local staging root: <dataRoot>/marketplace/npm. Every npm-plugin
 * host (opencode / kilo / kilo-cli) stages here; the host config's `plugin`
 * array references the bundle by `file://<this>/<id>`, so it MUST live under the
 * stable data-root (it survives cwd changes and `rm -rf dist-plugin`).
 */
export function npmStagingRoot(): string {
  return join(marketplaceRoot(), "npm");
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
// droid (Factory) host-state readers (~/.factory/settings.json, JSON, NO env)
//
// DOCS-ONLY: no droid binary is present on this box. The settings.json key
// shapes below (`enabledPlugins["<id>@agent-connector"] === true` +
// `extraKnownMarketplaces["agent-connector"].source`) follow the documented
// factory plugin model — confirm the exact JSON shapes live when a droid binary
// is available. Both readers read defensively (refuse only on positive evidence).
// ─────────────────────────────────────────────────────────────────────────

/** Factory's settings file: ~/.factory/settings.json (NO dedicated env). */
export function factorySettingsPath(): string {
  return join(homedir(), ".factory", "settings.json");
}

/** The settings.json key our marketplace install creates for `id` (== codex's). */
export function droidPluginKey(connectorId: string): string {
  return `${connectorId}@${MARKETPLACE_NAME}`;
}

/** The `enabledPlugins` map from droid's settings.json (null when unreadable). */
function readDroidEnabledPlugins(): Record<string, unknown> | null {
  const parsed = readJsonFile(factorySettingsPath());
  const plugins = parsed?.enabledPlugins;
  if (plugins && typeof plugins === "object" && !Array.isArray(plugins)) {
    return plugins as Record<string, unknown>;
  }
  return null;
}

/**
 * True when droid's settings.json carries
 * `enabledPlugins["<id>@agent-connector"] === true`. DOCS-only: the strict
 * `=== true` value shape is unverified live (a future droid may store an object).
 */
export function droidPluginInstalled(connectorId: string): boolean {
  const plugins = readDroidEnabledPlugins();
  if (!plugins) return false;
  return plugins[droidPluginKey(connectorId)] === true;
}

/** True when ANY `*@agent-connector` plugin remains enabled in droid's settings. */
export function anyDroidAgentConnectorPlugins(): boolean {
  const plugins = readDroidEnabledPlugins();
  if (!plugins) return false;
  return Object.entries(plugins).some(
    ([key, value]) => key.endsWith(`@${MARKETPLACE_NAME}`) && value === true,
  );
}

/**
 * The directory droid's settings.json records as
 * `extraKnownMarketplaces["<name>"].source`, or null when not registered /
 * unreadable. Both a presence probe and the NAME-COLLISION check (a registration
 * pointing somewhere other than our staging root belongs to the user). DOCS-only:
 * the local-path `source` field shape is undocumented, so this reads defensively
 * — accepts either a bare string source or an object carrying a `path`/`source`
 * string, and NORMALIZES to a single string for the samePath compare.
 */
export function droidMarketplaceSource(name: string): string | null {
  const parsed = readJsonFile(factorySettingsPath());
  const known = parsed?.extraKnownMarketplaces;
  if (!known || typeof known !== "object" || Array.isArray(known)) return null;
  const entry = (known as Record<string, unknown>)[name];
  if (entry == null) return null;
  if (typeof entry === "string") return entry;
  if (typeof entry === "object" && !Array.isArray(entry)) {
    const e = entry as { source?: unknown; path?: unknown };
    if (typeof e.source === "string") return e.source;
    if (typeof e.path === "string") return e.path;
  }
  return null;
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
// Gemini CLI host-state readers (~/.gemini/extensions, NO env — HOME isolation)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Gemini CLI's config dir: ~/.gemini (NO dedicated config-dir env — isolation is
 * via HOME, live-confirmed on gemini 0.36.0). DISTINCT from agy's ~/.gemini/config
 * tree: gemini extensions land under ~/.gemini/extensions/<id>/.
 */
export function geminiConfigDir(): string {
  return join(homedir(), ".gemini");
}

/**
 * True when `id` is installed per Gemini's own extension store: the marker file
 * ~/.gemini/extensions/<id>/gemini-extension.json exists. Gemini exits 0 even on
 * a logical failure, so this fs probe — not the exit code — is the source of
 * truth (the driver re-probes after every spawn).
 */
export function geminiExtensionInstalled(connectorId: string): boolean {
  return existsSync(
    join(geminiConfigDir(), "extensions", connectorId, "gemini-extension.json"),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Qwen Code host-state readers (~/.qwen/extensions, NO env — HOME isolation)
//
// DOCS-ONLY: no qwen binary is present on this box. qwen-code is a gemini-cli
// fork, so the extension store SHAPE (~/.qwen/extensions/<id>/qwen-extension.json)
// mirrors gemini's — confirm the marker filename live when a qwen binary lands.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Qwen Code's config dir: ~/.qwen (NO dedicated config-dir env — isolation is
 * via HOME, like its gemini-cli parent). DOCS-only: confirm live when a qwen
 * binary is available. DISTINCT from ~/.gemini (the gemini-cli store).
 */
export function qwenConfigDir(): string {
  return join(homedir(), ".qwen");
}

/**
 * True when `id` is installed per Qwen's own extension store: the marker file
 * ~/.qwen/extensions/<id>/qwen-extension.json exists. Mirrors gemini's fs probe
 * (qwen is a gemini fork); the driver re-probes after every spawn. DOCS-only:
 * the marker filename (`qwen-extension.json`) is unverified live.
 */
export function qwenExtensionInstalled(connectorId: string): boolean {
  return existsSync(
    join(qwenConfigDir(), "extensions", connectorId, "qwen-extension.json"),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// npm-local host-state readers (opencode / kilo / kilo-cli — XDG_CONFIG_HOME)
//
// These hosts have NO uninstall verb; installs are recorded as `file://<dir>`
// entries in a `plugin` array inside an opencode-style config file, which the
// driver EDITS to remove. This module is a spawn/shared-free LEAF, so a tiny
// posix-resolve path comparison is inlined here rather than importing
// shared.ts's samePath (and samePath does not strip the `file://` scheme).
// ─────────────────────────────────────────────────────────────────────────

/** $XDG_CONFIG_HOME when set & non-empty, else ~/.config (matches the adapters). */
function xdgConfigHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && xdg.trim() !== "" ? resolve(xdg) : join(homedir(), ".config");
}

/** opencode's config dir: $XDG_CONFIG_HOME/opencode (or ~/.config/opencode). */
export function opencodeConfigDir(): string {
  return join(xdgConfigHome(), "opencode");
}

/** kilo / kilo-cli's config dir: $XDG_CONFIG_HOME/kilo (or ~/.config/kilo). */
export function kiloConfigDir(): string {
  return join(xdgConfigHome(), "kilo");
}

/**
 * Candidate config filenames per npm-local host, most-preferred first. opencode
 * accepts opencode.jsonc / opencode.json / config.json (JSONC — comments
 * tolerated); kilo / kilo-cli use opencode.json (plain JSON).
 */
function npmConfigCandidates(platform: PlatformId): string[] {
  return platform === "opencode"
    ? ["opencode.jsonc", "opencode.json", "config.json"]
    : ["opencode.json"];
}

/** The config DIR for an npm-local host (opencode vs kilo/kilo-cli). */
function npmConfigDir(platform: PlatformId): string {
  return platform === "opencode" ? opencodeConfigDir() : kiloConfigDir();
}

/**
 * The config FILE path for `platform`: the first existing candidate, else the
 * most-preferred candidate (the path a fresh install would write). Never throws.
 */
export function npmConfigFilePath(platform: PlatformId): string {
  const dir = npmConfigDir(platform);
  const candidates = npmConfigCandidates(platform);
  for (const name of candidates) {
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  return join(dir, candidates[0]!);
}

/** Strip a single leading `file://` (and `file://localhost/`) scheme prefix. */
export function stripFileScheme(entry: string): string {
  let s = entry;
  if (s.startsWith("file://localhost/")) s = s.slice("file://localhost".length);
  else if (s.startsWith("file://")) s = s.slice("file://".length);
  return s;
}

/**
 * Strip `//` line and `/* *​/` block comments from JSONC, STRING-AWARE: a `//`
 * or `/*` inside a JSON string literal (e.g. the `file://` in a plugin entry) is
 * left intact. Scans char-by-char tracking string + escape state — a naive
 * regex would corrupt `"file:///dir"` by eating from the embedded `//`.
 */
function stripJsoncComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = i + 1 < text.length ? text[i + 1]! : "";
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        // Copy the escaped char verbatim (covers \" and \\).
        if (next !== "") {
          out += next;
          i++;
        }
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** Tolerant JSONC → object: strip // line and block comments, then JSON.parse. */
function parseJsonc(text: string): Record<string, unknown> | null {
  // A parse failure degrades to null (the "refuse only on positive evidence"
  // convention) rather than throwing.
  try {
    const parsed = JSON.parse(stripJsoncComments(text)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* unreadable / not JSONC → null */
  }
  return null;
}

/** Read + parse an npm-local host's config file ({}-shaped or null). Never throws. */
export function readNpmConfig(platform: PlatformId): Record<string, unknown> | null {
  const file = npmConfigFilePath(platform);
  try {
    return parseJsonc(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Posix-resolve path equality for the npm probe: normalize `..`/`.`/trailing
 * slashes without touching the filesystem. Inlined here (leaf module) rather
 * than importing shared.ts's samePath. The caller strips `file://` first.
 */
function posixPathEquals(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const isAbs = p.startsWith("/");
    const out: string[] = [];
    for (const seg of p.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
        else if (!isAbs) out.push("..");
      } else out.push(seg);
    }
    return (isAbs ? "/" : "") + out.join("/");
  };
  return norm(a) === norm(b);
}

/**
 * The `plugin`-array ENTRY (the raw string, including any `file://`) whose value
 * — after stripping a leading `file://` — path-equals `id`'s staged bundle dir,
 * or null when no entry references it. Used both as the install probe and to
 * locate the exact entry the uninstall edit must drop.
 */
export function npmPluginArrayEntry(
  platform: PlatformId,
  connectorId: string,
): string | null {
  const cfg = readNpmConfig(platform);
  if (!cfg) return null;
  const arr = cfg["plugin"];
  if (!Array.isArray(arr)) return null;
  const target = join(npmStagingRoot(), connectorId);
  for (const raw of arr) {
    if (typeof raw !== "string") continue;
    if (posixPathEquals(stripFileScheme(raw), target)) return raw;
  }
  return null;
}

/** True when `platform`'s config `plugin` array references `id`'s staged bundle. */
export function npmPluginInstalled(platform: PlatformId, connectorId: string): boolean {
  return npmPluginArrayEntry(platform, connectorId) != null;
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
    case "gemini-cli":
      return geminiExtensionInstalled(connectorId)
        ? `extension ${connectorId} listed in Gemini's extensions store`
        : null;
    case "qwen-code":
      return qwenExtensionInstalled(connectorId)
        ? `extension ${connectorId} listed in Qwen's extensions store`
        : null;
    case "droid":
      return droidPluginInstalled(connectorId)
        ? `${droidPluginKey(connectorId)} enabled in droid's settings.json`
        : null;
    case "antigravity":
    case "antigravity-cli": {
      const dir = join(homedir(), ".gemini", "config", "plugins", connectorId);
      return existsSync(dir) ? `plugin dir ${dir} exists` : null;
    }
    case "opencode":
    case "kilo":
    case "kilo-cli":
      return npmPluginInstalled(platform, connectorId)
        ? `${connectorId} listed in ${platform}'s config plugin array`
        : null;
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
