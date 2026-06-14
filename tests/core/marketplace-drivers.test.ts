/**
 * core/marketplace (codex + agy drivers) — the marketplace delivery method
 * against MOCK `codex` and `agy` CLIs.
 *
 * Two fake binaries (tiny node scripts behind sh/.cmd wrappers, prepended to
 * PATH) emulate the live-verified contract of the real CLIs' plugin verbs:
 *
 *   codex — `plugin marketplace add/remove` + `plugin add/remove` mutate
 *     <CODEX_HOME>/config.toml ([marketplaces.agent-connector].source +
 *     [plugins."<id>@agent-connector"]) — the same TOML state the driver probes.
 *   agy   — `plugin validate/install/uninstall` mutate
 *     ~/.gemini/config/plugins/import_manifest.json + the copied plugin dir —
 *     the same manifest the driver probes.
 *
 * Every invocation is appended to the per-CLI log so tests assert exactly which
 * host commands were (or were NOT) spawned. Isolation mirrors marketplace.test.ts:
 * HOME/USERPROFILE, AGENT_CONNECTOR_DATA_DIR, CODEX_HOME and PATH are redirected
 * to fresh temp dirs and restored verbatim afterEach.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadAdapter } from "../../src/adapters/registry.js";
import { samePath } from "../../src/core/marketplace-drivers/shared.js";
import { dataRoot, homeBinPath } from "../../src/core/paths.js";
import { defineConnector } from "../../src/core/define-connector.js";
import { installConnector } from "../../src/core/installer.js";
import {
  installViaMarketplace,
  marketplaceDoctorChecks,
  uninstallViaMarketplace,
  upgradeViaMarketplace,
} from "../../src/core/marketplace.js";
import {
  agyPluginInstalled,
  codexMarketplaceSource,
  codexPluginInstalled,
  droidMarketplaceSource,
  droidPluginInstalled,
  geminiExtensionInstalled,
  marketplaceInstallsPath,
  npmConfigFilePath,
  npmPluginInstalled,
  qwenExtensionInstalled,
  readMarketplaceInstalls,
} from "../../src/core/marketplace-state.js";
import { runHostCommand } from "../../src/core/marketplace-drivers/shared.js";
import type { PlatformId, ResolvedConnector } from "../../src/core/types.js";

const DIST_INDEX = join(__dirname, "..", "..", "dist", "index.js");
const CONNECTOR_ID = "acme-db";
const PLUGIN_KEY = `${CONNECTOR_ID}@agent-connector`;

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  PATH: process.env.PATH,
  FAKE_CODEX_LOG: process.env.FAKE_CODEX_LOG,
  FAKE_AGY_LOG: process.env.FAKE_AGY_LOG,
  FAKE_GEMINI_LOG: process.env.FAKE_GEMINI_LOG,
  FAKE_QWEN_LOG: process.env.FAKE_QWEN_LOG,
  FAKE_DROID_LOG: process.env.FAKE_DROID_LOG,
  FAKE_OPENCODE_LOG: process.env.FAKE_OPENCODE_LOG,
  FAKE_KILO_LOG: process.env.FAKE_KILO_LOG,
  TELEMETRY: process.env.AGENT_CONNECTOR_TELEMETRY,
};

let tmpHome: string;
let tmpData: string;
let tmpCodexHome: string;
let tmpXdgConfig: string;
let tmpBin: string;
let projectDir: string;
let codexLog: string;
let agyLog: string;
let geminiLog: string;
let qwenLog: string;
let droidLog: string;
let opencodeLog: string;
let kiloLog: string;
let fixtureModulePath: string;

/**
 * The fake codex CLI: maintains state as a JSON sidecar and regenerates the
 * FULL config.toml text deterministically so @iarna/toml (the driver's probe)
 * reads it back. Mirrors the live-verified contract (exit codes + state files).
 */
const FAKE_CODEX_MJS = `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_LOG) {
  appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args) + "\\n");
}
const home = process.env.CODEX_HOME;
const cfgPath = join(home, "config.toml");
const statePath = join(home, ".fake-codex-state.json");
const readState = () => {
  try { return JSON.parse(readFileSync(statePath, "utf8")); }
  catch { return { source: null, plugins: [] }; }
};
const writeState = (s) => {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(s));
  // Regenerate config.toml text from state (TOML the real parser reads back).
  let toml = "";
  if (s.source != null) {
    toml += '[marketplaces.agent-connector]\\n';
    toml += 'source_type = "local"\\n';
    toml += 'source = ' + JSON.stringify(s.source) + '\\n\\n';
  }
  for (const key of s.plugins) {
    toml += '[plugins.' + JSON.stringify(key) + ']\\n';
    toml += 'enabled = true\\n\\n';
  }
  writeFileSync(cfgPath, toml);
};

if (args[0] !== "plugin") process.exit(2);
const s = readState();
switch (args[1]) {
  case "marketplace": {
    if (args[2] === "add") { s.source = args[3]; writeState(s); process.exit(0); }
    if (args[2] === "remove") {
      if (s.source == null) process.exit(1); // real CLI: exit 1 when absent
      s.source = null; writeState(s); process.exit(0);
    }
    process.exit(2);
  }
  case "add": {
    if (!s.plugins.includes(args[2])) s.plugins.push(args[2]);
    writeState(s); process.exit(0);
  }
  case "remove": {
    if (!s.plugins.includes(args[2])) process.exit(1); // real CLI: exit 1 when absent
    s.plugins = s.plugins.filter((p) => p !== args[2]);
    writeState(s); process.exit(0);
  }
  default:
    process.exit(2);
}
`;

/**
 * The fake agy CLI: mutates ~/.gemini/config/plugins/import_manifest.json + the
 * copied plugin dir. Fully idempotent both directions (exit 0), per live verify.
 */
const FAKE_AGY_MJS = `
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const args = process.argv.slice(2);
if (process.env.FAKE_AGY_LOG) {
  appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(args) + "\\n");
}
const pluginsDir = join(homedir(), ".gemini", "config", "plugins");
const manifestPath = join(pluginsDir, "import_manifest.json");
const readManifest = () => {
  try { return JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch { return { imports: null }; }
};
const writeManifest = (m) => {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(m, null, 2));
};

if (args[0] !== "plugin") process.exit(2);
switch (args[1]) {
  case "validate":
    process.exit(0); // advisory — always exits 0 (may warn)
  case "install": {
    const src = args[2];
    const id = basename(src);
    const dest = join(pluginsDir, id);
    mkdirSync(dest, { recursive: true });
    if (existsSync(src)) cpSync(src, dest, { recursive: true });
    const m = readManifest();
    const imports = Array.isArray(m.imports) ? m.imports : [];
    if (!imports.some((e) => e && e.name === id)) {
      imports.push({ name: id, source: "antigravity", importedAt: new Date().toISOString(), components: [] });
    }
    writeManifest({ imports });
    process.exit(0);
  }
  case "uninstall": {
    const id = args[2];
    const dest = join(pluginsDir, id);
    rmSync(dest, { recursive: true, force: true });
    const m = readManifest();
    const imports = (Array.isArray(m.imports) ? m.imports : []).filter((e) => !(e && e.name === id));
    writeManifest({ imports: imports.length > 0 ? imports : null });
    process.exit(0); // idempotent: absent uninstall still exits 0
  }
  default:
    process.exit(2);
}
`;

/**
 * The fake gemini CLI: `extensions install/uninstall/validate` mutate
 * ~/.gemini/extensions/<id>/gemini-extension.json — the same marker the driver
 * probes. Live-verified contract: gemini exits 0 even on a logical failure, so
 * the driver re-probes the fs; here re-install REFUSES (exit 1, no mutation) to
 * mirror the real "already installed… uninstall first" behavior, and
 * uninstall-absent is a no-op (exit 0). validate is advisory (always exit 0).
 */
const FAKE_GEMINI_MJS = `
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
if (process.env.FAKE_GEMINI_LOG) {
  appendFileSync(process.env.FAKE_GEMINI_LOG, JSON.stringify(args) + "\\n");
}
const extDir = (id) => join(homedir(), ".gemini", "extensions", id);
const marker = (id) => join(extDir(id), "gemini-extension.json");

if (args[0] !== "extensions") process.exit(2);
switch (args[1]) {
  case "validate":
    process.exit(0); // advisory — always exits 0
  case "install": {
    const src = args[2];
    const id = basename(src);
    if (process.env.FAKE_GEMINI_TRUST_GATED) {
      // gemini >= 0.41: a SEPARATE folder-trust prompt --consent does not cover.
      // With stdin ignored it EOF-aborts: prints the prompt, NO marker written.
      process.stdout.write("Do you trust the files in this folder? [y/N]: ");
      process.exit(1);
    }
    if (existsSync(marker(id))) process.exit(1); // real gemini REFUSES re-install
    mkdirSync(extDir(id), { recursive: true });
    writeFileSync(marker(id), JSON.stringify({ name: id, version: "1.0.0" }));
    process.exit(0);
  }
  case "uninstall": {
    const id = args[2];
    rmSync(extDir(id), { recursive: true, force: true });
    process.exit(0); // idempotent: absent uninstall still exits 0
  }
  default:
    process.exit(2);
}
`;

/**
 * The fake qwen CLI: `extensions install/uninstall/update` mutate
 * ~/.qwen/extensions/<id>/qwen-extension.json — the same marker the driver
 * probes. Mirrors the ASSUMED (DOCS-only) gemini-fork contract: NO `--consent`
 * flag (exits 2 if one is passed, so the driver's no-consent invocation is
 * asserted), re-install REFUSES (exit 1, no mutation), uninstall-absent throws
 * (exit 1), update keeps the marker present.
 */
const FAKE_QWEN_MJS = `
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
if (process.env.FAKE_QWEN_LOG) {
  appendFileSync(process.env.FAKE_QWEN_LOG, JSON.stringify(args) + "\\n");
}
const extDir = (id) => join(homedir(), ".qwen", "extensions", id);
const marker = (id) => join(extDir(id), "qwen-extension.json");

if (args[0] !== "extensions") process.exit(2);
switch (args[1]) {
  case "install": {
    if (args.includes("--consent")) process.exit(2); // qwen has NO --consent flag
    const src = args[2];
    const id = basename(src);
    if (existsSync(marker(id))) process.exit(1); // qwen REFUSES re-install (assumed)
    mkdirSync(extDir(id), { recursive: true });
    writeFileSync(marker(id), JSON.stringify({ name: id, version: "1.0.0" }));
    process.exit(0);
  }
  case "update": {
    const id = args[2];
    if (!existsSync(marker(id))) process.exit(1); // update of an absent ext throws
    writeFileSync(marker(id), JSON.stringify({ name: id, version: "1.0.1" }));
    process.exit(0);
  }
  case "uninstall": {
    const id = args[2];
    if (!existsSync(marker(id))) process.exit(1); // qwen is NOT idempotent (assumed)
    rmSync(extDir(id), { recursive: true, force: true });
    process.exit(0);
  }
  default:
    process.exit(2);
}
`;

/**
 * The fake droid CLI: `plugin marketplace add/remove` + `plugin install/uninstall`
 * mutate ~/.factory/settings.json (extraKnownMarketplaces["agent-connector"].source
 * + enabledPlugins["<id>@agent-connector"] === true) — the same JSON state the
 * driver probes. Mirrors the ASSUMED (DOCS-only) codex-style contract: re-install
 * is an idempotent no-op (exit 0), marketplace-remove + plugin-uninstall of an
 * absent target exit 1 (probe-first guards them anyway).
 */
const FAKE_DROID_MJS = `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
if (process.env.FAKE_DROID_LOG) {
  appendFileSync(process.env.FAKE_DROID_LOG, JSON.stringify(args) + "\\n");
}
const settingsPath = join(homedir(), ".factory", "settings.json");
const read = () => {
  try { return JSON.parse(readFileSync(settingsPath, "utf8")); }
  catch { return {}; }
};
const write = (o) => {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(o, null, 2));
};

if (args[0] !== "plugin") process.exit(2);
const s = read();
switch (args[1]) {
  case "marketplace": {
    if (args[2] === "add") {
      s.extraKnownMarketplaces = s.extraKnownMarketplaces || {};
      s.extraKnownMarketplaces["agent-connector"] = { source: args[3] };
      write(s); process.exit(0);
    }
    if (args[2] === "remove") {
      const known = s.extraKnownMarketplaces || {};
      if (known["agent-connector"] == null) process.exit(1); // absent → exit 1
      delete known["agent-connector"];
      s.extraKnownMarketplaces = known;
      write(s); process.exit(0);
    }
    process.exit(2);
  }
  case "install": {
    s.enabledPlugins = s.enabledPlugins || {};
    s.enabledPlugins[args[2]] = true; // idempotent: re-install is a no-op
    write(s); process.exit(0);
  }
  case "uninstall": {
    const plugins = s.enabledPlugins || {};
    if (plugins[args[2]] !== true) process.exit(1); // absent → exit 1
    delete plugins[args[2]];
    s.enabledPlugins = plugins;
    write(s); process.exit(0);
  }
  default:
    process.exit(2);
}
`;

/**
 * Build a fake opencode/kilo CLI for binary `bin`: `plugin --global file://<dir>`
 * APPENDS the entry to the host config's `plugin` array (idempotent — no dupe).
 * The config path is computed from XDG_CONFIG_HOME EXACTLY as the driver does
 * (opencode → $XDG/opencode/opencode.json, kilo → $XDG/kilo/opencode.json — a
 * fresh write uses the most-preferred candidate). The cwd is logged so the test
 * can assert the neutral-cwd contract. There is NO uninstall verb.
 */
function fakeNpmMjs(bin: string, logEnv: string): string {
  const dir = bin === "opencode" ? "opencode" : "kilo";
  return `
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const log = process.env[${JSON.stringify(logEnv)}];
if (log) {
  appendFileSync(log, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
}
const xdg = process.env.XDG_CONFIG_HOME;
const base = xdg && xdg.trim() !== "" ? resolve(xdg) : join(homedir(), ".config");
const cfgPath = join(base, ${JSON.stringify(dir)}, "opencode.json");
const read = () => {
  try {
    const t = readFileSync(cfgPath, "utf8").replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");
    return JSON.parse(t);
  } catch { return {}; }
};
const write = (o) => {
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify(o, null, 2));
};

if (args[0] === "plugin" && args[1] === "--global") {
  const ref = args[2];
  const cfg = read();
  const arr = Array.isArray(cfg.plugin) ? cfg.plugin : [];
  if (!arr.includes(ref)) arr.push(ref); // idempotent: no dupe
  cfg.plugin = arr;
  write(cfg);
  process.exit(0);
}
process.exit(2);
`;
}

function writeFakeCli(dir: string, name: string, mjs: string): void {
  const script = join(dir, `fake-${name}.mjs`);
  writeFileSync(script, mjs, "utf8");
  const node = process.execPath;
  if (process.platform === "win32") {
    writeFileSync(join(dir, `${name}.cmd`), `@echo off\r\n"${node}" "${script}" %*\r\n`, "utf8");
  } else {
    const sh = join(dir, name);
    writeFileSync(sh, `#!/bin/sh\nexec "${node}" "${script}" "$@"\n`, "utf8");
    chmodSync(sh, 0o755);
  }
}

function makeConnector(version = "1.2.3"): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version,
    server: { transport: "stdio", command: "npx", args: ["-y", "@acme/db-mcp"] },
    hooks: {
      PreToolUse: {
        matcher: "acme_query",
        handler() {
          return { decision: "allow" };
        },
      },
    },
  });
}

function writeFixtureModule(dir: string): string {
  const modPath = join(dir, "acme-db.config.mjs");
  const distUrl = pathToFileURL(DIST_INDEX).href;
  writeFileSync(
    modPath,
    `import { defineConnector } from ${JSON.stringify(distUrl)};
export default defineConnector({
  id: ${JSON.stringify(CONNECTOR_ID)},
  displayName: "Acme DB Tools",
  version: "1.2.3",
  server: { transport: "stdio", command: "npx", args: ["-y", "@acme/db-mcp"] },
});
`,
    "utf8",
  );
  return modPath;
}

function spawned(logFile: string): string[][] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as string[]);
}

/** Parse an npm-CLI log: each line is `{ args, cwd }` (cwd-contract assertions). */
function spawnedNpm(logFile: string): Array<{ args: string[]; cwd: string }> {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as { args: string[]; cwd: string });
}

function marketplaceInstall(target: PlatformId, connector = makeConnector()) {
  return installViaMarketplace({
    connector,
    modulePath: fixtureModulePath,
    scope: "user",
    projectDir,
    targets: [target],
    dryRun: false,
  });
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-drv-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-drv-data-"));
  tmpCodexHome = mkdtempSync(join(tmpdir(), "ac-drv-codex-"));
  tmpXdgConfig = mkdtempSync(join(tmpdir(), "ac-drv-xdg-"));
  tmpBin = mkdtempSync(join(tmpdir(), "ac-drv-bin-"));
  projectDir = mkdtempSync(join(tmpdir(), "ac-drv-proj-"));
  codexLog = join(tmpBin, "codex.log");
  agyLog = join(tmpBin, "agy.log");
  geminiLog = join(tmpBin, "gemini.log");
  qwenLog = join(tmpBin, "qwen.log");
  droidLog = join(tmpBin, "droid.log");
  opencodeLog = join(tmpBin, "opencode.log");
  kiloLog = join(tmpBin, "kilo.log");

  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENT_CONNECTOR_DATA_DIR = tmpData;
  process.env.CODEX_HOME = tmpCodexHome;
  process.env.XDG_CONFIG_HOME = tmpXdgConfig;
  process.env.FAKE_CODEX_LOG = codexLog;
  process.env.FAKE_AGY_LOG = agyLog;
  process.env.FAKE_GEMINI_LOG = geminiLog;
  process.env.FAKE_QWEN_LOG = qwenLog;
  process.env.FAKE_DROID_LOG = droidLog;
  process.env.FAKE_OPENCODE_LOG = opencodeLog;
  process.env.FAKE_KILO_LOG = kiloLog;
  process.env.PATH = `${tmpBin}${delimiter}${SAVED.PATH ?? ""}`;
  delete process.env.AGENT_CONNECTOR_TELEMETRY;

  writeFakeCli(tmpBin, "codex", FAKE_CODEX_MJS);
  writeFakeCli(tmpBin, "agy", FAKE_AGY_MJS);
  writeFakeCli(tmpBin, "gemini", FAKE_GEMINI_MJS);
  writeFakeCli(tmpBin, "qwen", FAKE_QWEN_MJS);
  writeFakeCli(tmpBin, "droid", FAKE_DROID_MJS);
  writeFakeCli(tmpBin, "opencode", fakeNpmMjs("opencode", "FAKE_OPENCODE_LOG"));
  writeFakeCli(tmpBin, "kilo", fakeNpmMjs("kilo", "FAKE_KILO_LOG"));
  fixtureModulePath = writeFixtureModule(tmpData);
});

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const d of [tmpHome, tmpData, tmpCodexHome, tmpXdgConfig, tmpBin, projectDir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────
// codex (catalog driver)
// ─────────────────────────────────────────────────────────────────────────

const codexStagingRootPath = (): string => join(tmpData, "marketplace", "codex");
const codexPluginDir = (): string => join(codexStagingRootPath(), CONNECTOR_ID);
const codexCatalogPath = (): string =>
  join(codexStagingRootPath(), ".agents", "plugins", "marketplace.json");

describe("installViaMarketplace — codex (mock)", () => {
  it("stages the bundle, drives marketplace add + plugin add, and records state", async () => {
    const result = await marketplaceInstall("codex");

    expect(result.changes.some((c) => c.action === "warn")).toBe(false);

    // Staged bundle (codex manifest dir) + shared catalog at .agents/plugins.
    expect(existsSync(join(codexPluginDir(), ".codex-plugin", "plugin.json"))).toBe(true);
    const catalog = JSON.parse(readFileSync(codexCatalogPath(), "utf8")) as {
      name: string;
      plugins: Array<{ name: string }>;
    };
    expect(catalog.name).toBe("agent-connector");
    expect(catalog.plugins.map((p) => p.name)).toEqual([CONNECTOR_ID]);

    // Host driven: marketplace add → plugin add (codex verbs, NO validate).
    const cmds = spawned(codexLog);
    expect(cmds).toContainEqual(["plugin", "marketplace", "add", codexStagingRootPath()]);
    expect(cmds).toContainEqual(["plugin", "add", PLUGIN_KEY]);
    expect(cmds.some((argv) => argv[1] === "validate")).toBe(false);

    // Codex's own config.toml shows the install (written by the fake CLI).
    expect(codexMarketplaceSource("agent-connector")).toBe(codexStagingRootPath());
    expect(codexPluginInstalled(CONNECTOR_ID)).toBe(true);

    const record = readMarketplaceInstalls(CONNECTOR_ID)["codex"];
    expect(record).toBeDefined();
    expect(record!.format).toBe("codex-plugin");
    expect(record!.bundleDir).toBe(codexPluginDir());
    expect(record!.version).toBe("1.2.3");
    expect(record!.contentHash).not.toBe("");
  });

  it("is idempotent: a re-run reports `=` skips and never re-drives the install", async () => {
    await marketplaceInstall("codex");
    const before = spawned(codexLog).length;

    const again = await marketplaceInstall("codex");
    expect(again.changes.some((c) => c.action === "warn")).toBe(false);
    const skips = again.changes.filter((c) => c.action === "skip");
    expect(skips.some((c) => c.detail.includes("already registered"))).toBe(true);
    expect(skips.some((c) => c.detail.includes("already installed"))).toBe(true);

    // Probe-first: nothing spawned on the idempotent re-run (no validate verb).
    expect(spawned(codexLog).length).toBe(before);
  });

  it("refuses (warn) when already installed DIRECTLY — and spawns nothing", async () => {
    const connector = makeConnector();
    await installConnector({
      connector,
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["codex"],
      dryRun: false,
    });

    const result = await marketplaceInstall("codex", connector);
    const warns = result.changes.filter((c) => c.action === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.detail).toContain("already installed DIRECTLY");
    expect(spawned(codexLog)).toEqual([]);
    expect(readMarketplaceInstalls(CONNECTOR_ID)).toEqual({});
  });

  it("direct install refuses (warn) when marketplace evidence exists — inverse guard", async () => {
    const connector = makeConnector();
    await marketplaceInstall("codex", connector);

    const result = await installConnector({
      connector,
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["codex"],
      dryRun: false,
    });
    const warns = result.changes.filter((c) => c.action === "warn");
    expect(warns.some((c) => c.detail.includes("via MARKETPLACE"))).toBe(true);
  });

  it("uninstalls: drives plugin remove, removes staging + record, de-registers when last", async () => {
    await marketplaceInstall("codex");

    const result = await uninstallViaMarketplace({
      connectorId: CONNECTOR_ID,
      projectDir,
      dryRun: false,
    });

    expect(result.changes.some((c) => c.action === "warn")).toBe(false);
    const cmds = spawned(codexLog);
    expect(cmds).toContainEqual(["plugin", "remove", PLUGIN_KEY]);
    expect(cmds).toContainEqual(["plugin", "marketplace", "remove", "agent-connector"]);

    expect(codexPluginInstalled(CONNECTOR_ID)).toBe(false);
    expect(codexMarketplaceSource("agent-connector")).toBeNull();
    expect(existsSync(codexPluginDir())).toBe(false);
    expect(readMarketplaceInstalls(CONNECTOR_ID)).toEqual({});
    expect(existsSync(marketplaceInstallsPath(CONNECTOR_ID))).toBe(false);
  });

  it("keeps the shared marketplace registered while ANOTHER staged connector remains", async () => {
    await marketplaceInstall("codex");
    const other = defineConnector({
      id: "other-tool",
      displayName: "Other Tool",
      version: "0.1.0",
      server: { transport: "stdio", command: "npx", args: ["-y", "other"] },
    });
    await installViaMarketplace({
      connector: other,
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["codex"],
      dryRun: false,
    });

    await uninstallViaMarketplace({
      connectorId: CONNECTOR_ID,
      projectDir,
      dryRun: false,
    });

    // acme-db is gone but the shared marketplace + other-tool survive.
    expect(codexPluginInstalled(CONNECTOR_ID)).toBe(false);
    expect(codexPluginInstalled("other-tool")).toBe(true);
    expect(codexMarketplaceSource("agent-connector")).toBe(codexStagingRootPath());
    const catalog = JSON.parse(readFileSync(codexCatalogPath(), "utf8")) as {
      plugins: Array<{ name: string }>;
    };
    expect(catalog.plugins.map((p) => p.name)).toEqual(["other-tool"]);
  });

  it("upgrade: re-stages in place, drives plugin add, warns on an unchanged version", async () => {
    await marketplaceInstall("codex");
    const before = readMarketplaceInstalls(CONNECTOR_ID)["codex"]!;

    const result = await upgradeViaMarketplace({
      connector: makeConnector(), // same version 1.2.3
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["codex"],
      dryRun: false,
    });

    expect(
      result.changes.some((c) => c.action === "warn" && c.detail.includes("unchanged")),
    ).toBe(true);
    // codex has no `plugin update` — update re-drives `plugin add`.
    expect(spawned(codexLog)).toContainEqual(["plugin", "add", PLUGIN_KEY]);
    const after = readMarketplaceInstalls(CONNECTOR_ID)["codex"]!;
    expect(after.installedAt).toBe(before.installedAt);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// agy (direct driver) — serves both antigravity + antigravity-cli
// ─────────────────────────────────────────────────────────────────────────

const agyStagingRootPath = (): string => join(tmpData, "marketplace", "agy");
const agyPluginDir = (): string => join(agyStagingRootPath(), CONNECTOR_ID);

describe.each(["antigravity", "antigravity-cli"] as PlatformId[])(
  "installViaMarketplace — agy (mock) [%s]",
  (target) => {
    it("stages the bundle, drives plugin install (no catalog), and records state", async () => {
      const result = await marketplaceInstall(target);

      expect(result.changes.some((c) => c.action === "warn")).toBe(false);
      // agy bundle: root plugin.json, NO catalog file anywhere.
      expect(existsSync(join(agyPluginDir(), "plugin.json"))).toBe(true);

      const cmds = spawned(agyLog);
      expect(cmds).toContainEqual(["plugin", "validate", agyPluginDir()]);
      expect(cmds).toContainEqual(["plugin", "install", agyPluginDir()]);
      // No marketplace verb exists for agy.
      expect(cmds.some((argv) => argv[1] === "marketplace")).toBe(false);

      expect(agyPluginInstalled(CONNECTOR_ID)).toBe(true);
      const record = readMarketplaceInstalls(CONNECTOR_ID)[target];
      expect(record).toBeDefined();
      expect(record!.format).toBe("agy-plugin");
      expect(record!.bundleDir).toBe(agyPluginDir());
      // Every emitted record carries the user's actual target id.
      expect(result.changes.every((c) => c.platform === target)).toBe(true);
    });

    it("is idempotent: a re-run reports a `=` skip and never re-drives install", async () => {
      await marketplaceInstall(target);
      const before = spawned(agyLog).length;

      const again = await marketplaceInstall(target);
      expect(again.changes.some((c) => c.action === "warn")).toBe(false);
      expect(again.changes.some((c) => c.action === "skip" && c.detail.includes("already installed"))).toBe(true);
      // Probe-first: no validate/install spawned again.
      expect(spawned(agyLog).length).toBe(before);
    });

    it("refuses (warn) when already installed DIRECTLY — and spawns nothing", async () => {
      const connector = makeConnector();
      await installConnector({
        connector,
        modulePath: fixtureModulePath,
        scope: "user",
        projectDir,
        targets: [target],
        dryRun: false,
      });

      const result = await marketplaceInstall(target, connector);
      const warns = result.changes.filter((c) => c.action === "warn");
      expect(warns).toHaveLength(1);
      expect(warns[0]!.detail).toContain("already installed DIRECTLY");
      expect(spawned(agyLog)).toEqual([]);
      expect(readMarketplaceInstalls(CONNECTOR_ID)).toEqual({});
    });

    it("direct install refuses (warn) when marketplace evidence exists — inverse guard", async () => {
      const connector = makeConnector();
      await marketplaceInstall(target, connector);

      const result = await installConnector({
        connector,
        modulePath: fixtureModulePath,
        scope: "user",
        projectDir,
        targets: [target],
        dryRun: false,
      });
      const warns = result.changes.filter((c) => c.action === "warn");
      expect(warns.some((c) => c.detail.includes("via MARKETPLACE"))).toBe(true);
    });

    it("uninstalls: drives plugin uninstall, removes staging + record (no marketplace dereg)", async () => {
      await marketplaceInstall(target);

      const result = await uninstallViaMarketplace({
        connectorId: CONNECTOR_ID,
        projectDir,
        dryRun: false,
      });

      expect(result.changes.some((c) => c.action === "warn")).toBe(false);
      const cmds = spawned(agyLog);
      expect(cmds).toContainEqual(["plugin", "uninstall", CONNECTOR_ID]);
      expect(cmds.some((argv) => argv[1] === "marketplace")).toBe(false);

      expect(agyPluginInstalled(CONNECTOR_ID)).toBe(false);
      expect(existsSync(agyPluginDir())).toBe(false);
      expect(readMarketplaceInstalls(CONNECTOR_ID)).toEqual({});
      expect(existsSync(marketplaceInstallsPath(CONNECTOR_ID))).toBe(false);
    });

    it("upgrade: re-stages in place, drives plugin install (idempotent overwrite)", async () => {
      await marketplaceInstall(target);

      const result = await upgradeViaMarketplace({
        connector: makeConnector(),
        modulePath: fixtureModulePath,
        scope: "user",
        projectDir,
        targets: [target],
        dryRun: false,
      });

      expect(
        result.changes.some((c) => c.action === "warn" && c.detail.includes("unchanged")),
      ).toBe(true);
      expect(spawned(agyLog)).toContainEqual(["plugin", "install", agyPluginDir()]);
      expect(agyPluginInstalled(CONNECTOR_ID)).toBe(true);
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────
// marketplaceDoctorChecks — the generic driver-based group for codex/agy.
//
// PART A (the doctor false-FAIL fix): a clean marketplace install reports a
// passing group for its platform (no direct-surface FAILs), and codex/agy
// produce NO group without their own state (claude-only behavior preserved).
// PART B: duplicate-registration FAILs when a direct install is also present.
// ─────────────────────────────────────────────────────────────────────────

describe("marketplaceDoctorChecks — codex (mock)", () => {
  it("passes after a clean marketplace install (no false direct-surface FAILs)", async () => {
    const connector = makeConnector();
    await marketplaceInstall("codex", connector);

    const groups = await marketplaceDoctorChecks(connector, "user", projectDir);
    // No claude state → only the codex group.
    expect(groups.map((g) => g.platform)).toEqual(["codex"]);
    const codex = groups[0]!;
    expect(codex.results.every((r) => r.status === "pass")).toBe(true);
    expect(codex.results.some((r) => r.check.includes("marketplace install"))).toBe(true);
  });

  it("is silent for a connector with no codex marketplace state", async () => {
    const groups = await marketplaceDoctorChecks(makeConnector(), "user", projectDir);
    expect(groups).toEqual([]);
  });

  it("FAILs duplicate-registration when a direct install is also present", async () => {
    const connector = makeConnector();
    await marketplaceInstall("codex", connector);
    // Simulate a manual direct install bypassing the CLI guard: write the id as
    // a TOML server table heading into codex's config.toml.
    writeFileSync(
      join(tmpCodexHome, "config.toml"),
      `${readFileSync(join(tmpCodexHome, "config.toml"), "utf8")}\n[mcp_servers.${CONNECTOR_ID}]\ncommand = "x"\n`,
      "utf8",
    );

    const groups = await marketplaceDoctorChecks(connector, "user", projectDir);
    const codex = groups.find((g) => g.platform === "codex")!;
    const dup = codex.results.find((r) => r.check.includes("duplicate-registration"));
    expect(dup).toBeDefined();
    expect(dup!.status).toBe("fail");
  });
});

describe.each(["antigravity", "antigravity-cli"] as PlatformId[])(
  "marketplaceDoctorChecks — agy (mock) [%s]",
  (target) => {
    it("passes after a clean marketplace install (no false direct-surface FAILs)", async () => {
      const connector = makeConnector();
      await marketplaceInstall(target, connector);

      const groups = await marketplaceDoctorChecks(connector, "user", projectDir);
      // No claude/codex state → only the agy group, keyed to the user's target.
      expect(groups.map((g) => g.platform)).toEqual([target]);
      const agy = groups[0]!;
      expect(agy.results.every((r) => r.status === "pass")).toBe(true);
      expect(agy.results.some((r) => r.check.includes("marketplace install"))).toBe(true);
    });

    it("FAILs duplicate-registration when a direct install is also present", async () => {
      const connector = makeConnector();
      await marketplaceInstall(target, connector);
      // Simulate a manual direct install bypassing the CLI guard: write a
      // home-bin hook command carrying `--connector <id>` at the adapter's
      // resolved hook-config path (the same marker directInstallPresent probes).
      // installConnector itself would REFUSE while marketplace evidence exists.
      await writeDirectHookMarker(target, connector);

      const groups = await marketplaceDoctorChecks(connector, "user", projectDir);
      const agy = groups.find((g) => g.platform === target)!;
      const dup = agy.results.find((r) => r.check.includes("duplicate-registration"));
      expect(dup).toBeDefined();
      expect(dup!.status).toBe("fail");
    });
  },
);

/**
 * Write a DIRECT-install marker (a home-bin hook command with `--connector
 * <id>`) at the platform adapter's resolved hook-config path, so the
 * marketplace duplicate-registration probe sees both methods present. Resolving
 * via the adapter keeps the test robust to per-host path-resolution details.
 */
async function writeDirectHookMarker(
  target: PlatformId,
  connector: ResolvedConnector,
): Promise<void> {
  const adapter = await loadAdapter(target);
  const ctx = {
    connector,
    scope: "user" as const,
    projectDir,
    homeBinPath: homeBinPath(),
    dataRoot: dataRoot(),
    dryRun: true,
  };
  const hookPath = adapter!.getHookConfigPath(ctx);
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(
    hookPath,
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: `"${homeBinPath()}" hook ${target} SessionStart --connector ${connector.id}`,
              },
            ],
          },
        ],
      },
    }),
    "utf8",
  );
}

// ─────────────────────────────────────────────────────────────────────────
// agyPluginInstalled — manifest location robustness. agy 1.0.7 records the
// import manifest at <config>/plugins/import_manifest.json on POSIX but at
// <config>/import_manifest.json on Windows (live-confirmed) — both must be read.
// ─────────────────────────────────────────────────────────────────────────

describe("agyPluginInstalled (cross-platform manifest locations)", () => {
  const writeManifest = (rel: string[], name: string) => {
    const p = join(tmpHome, ".gemini", "config", ...rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ imports: [{ name, source: "x", components: ["installed"] }] }), "utf8");
  };

  it("detects the install from the POSIX manifest (config/plugins/import_manifest.json)", () => {
    writeManifest(["plugins", "import_manifest.json"], "acme-db");
    expect(agyPluginInstalled("acme-db")).toBe(true);
    expect(agyPluginInstalled("other")).toBe(false);
  });

  it("detects the install from the WIN32 manifest (config/import_manifest.json)", () => {
    writeManifest(["import_manifest.json"], "acme-db");
    expect(agyPluginInstalled("acme-db")).toBe(true);
  });

  it("falls back to the copied plugin dir when no manifest lists it", () => {
    const pj = join(tmpHome, ".gemini", "config", "plugins", "acme-db", "plugin.json");
    mkdirSync(dirname(pj), { recursive: true });
    writeFileSync(pj, JSON.stringify({ name: "acme-db", version: "1.0.0" }), "utf8");
    expect(agyPluginInstalled("acme-db")).toBe(true);
  });

  it("is false when neither manifest nor plugin dir exists", () => {
    expect(agyPluginInstalled("acme-db")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// gemini (direct driver) — single gemini-cli PlatformId, re-install REFUSES.
// ─────────────────────────────────────────────────────────────────────────

const geminiStagingRootPath = (): string => join(tmpData, "marketplace", "gemini");
const geminiPluginDir = (): string => join(geminiStagingRootPath(), CONNECTOR_ID);

describe("installViaMarketplace — gemini (mock)", () => {
  it("stages the bundle, drives validate + install --consent, records state", async () => {
    const result = await marketplaceInstall("gemini-cli");

    expect(result.changes.some((c) => c.action === "warn")).toBe(false);
    // gemini bundle: gemini-extension.json at the staged root, NO catalog.
    expect(existsSync(join(geminiPluginDir(), "gemini-extension.json"))).toBe(true);

    const cmds = spawned(geminiLog);
    expect(cmds).toContainEqual(["extensions", "validate", geminiPluginDir()]);
    expect(cmds).toContainEqual(["extensions", "install", geminiPluginDir(), "--consent"]);
    expect(cmds.some((argv) => argv[1] === "marketplace")).toBe(false);

    expect(geminiExtensionInstalled(CONNECTOR_ID)).toBe(true);
    const record = readMarketplaceInstalls(CONNECTOR_ID)["gemini-cli"];
    expect(record).toBeDefined();
    expect(record!.format).toBe("gemini-extension");
    expect(record!.bundleDir).toBe(geminiPluginDir());
    expect(record!.contentHash).not.toBe("");
  });

  it("folder-trust gate (gemini >= 0.41): degrades to an actionable warn, no install, no record", async () => {
    process.env.FAKE_GEMINI_TRUST_GATED = "1";
    try {
      const result = await marketplaceInstall("gemini-cli");
      const w = result.changes.find((c) => c.action === "warn");
      expect(w).toBeDefined();
      expect(w!.detail).toMatch(/folder-trust|trust the folder/i);
      expect(w!.detail).toMatch(/folderTrust\.enabled/);
      // the prompt EOF-aborted: nothing installed, nothing recorded.
      expect(geminiExtensionInstalled(CONNECTOR_ID)).toBe(false);
      expect(readMarketplaceInstalls(CONNECTOR_ID)["gemini-cli"]).toBeUndefined();
    } finally {
      delete process.env.FAKE_GEMINI_TRUST_GATED;
    }
  });

  it("is idempotent: a re-run reports a `=` skip and never re-drives install (gemini refuses)", async () => {
    await marketplaceInstall("gemini-cli");
    const before = spawned(geminiLog).length;

    const again = await marketplaceInstall("gemini-cli");
    expect(again.changes.some((c) => c.action === "warn")).toBe(false);
    expect(
      again.changes.some((c) => c.action === "skip" && c.detail.includes("already installed")),
    ).toBe(true);
    // Probe-first: nothing spawned again (a real re-install would REFUSE).
    expect(spawned(geminiLog).length).toBe(before);
  });

  it("refuses (warn) when already installed DIRECTLY — and spawns nothing", async () => {
    const connector = makeConnector();
    await installConnector({
      connector,
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["gemini-cli"],
      dryRun: false,
    });

    const result = await marketplaceInstall("gemini-cli", connector);
    const warns = result.changes.filter((c) => c.action === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.detail).toContain("already installed DIRECTLY");
    expect(spawned(geminiLog)).toEqual([]);
    expect(readMarketplaceInstalls(CONNECTOR_ID)).toEqual({});
  });

  it("uninstalls: drives extensions uninstall, removes staging + record; re-uninstall is a `=` skip", async () => {
    await marketplaceInstall("gemini-cli");

    const result = await uninstallViaMarketplace({
      connectorId: CONNECTOR_ID,
      projectDir,
      dryRun: false,
    });

    expect(result.changes.some((c) => c.action === "warn")).toBe(false);
    expect(spawned(geminiLog)).toContainEqual(["extensions", "uninstall", CONNECTOR_ID]);
    expect(geminiExtensionInstalled(CONNECTOR_ID)).toBe(false);
    expect(existsSync(geminiPluginDir())).toBe(false);
    expect(readMarketplaceInstalls(CONNECTOR_ID)).toEqual({});

    // Re-uninstall with no state/evidence → nothing-found warning, never an error.
    const again = await uninstallViaMarketplace({
      connectorId: CONNECTOR_ID,
      projectDir,
      dryRun: false,
    });
    expect(again.warnings.some((w) => w.includes("no marketplace installs found"))).toBe(true);
  });

  it("upgrade: re-stages then drives uninstall + install (no overwrite path)", async () => {
    await marketplaceInstall("gemini-cli");

    const result = await upgradeViaMarketplace({
      connector: makeConnector(), // same version 1.2.3
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["gemini-cli"],
      dryRun: false,
    });

    expect(
      result.changes.some((c) => c.action === "warn" && c.detail.includes("unchanged")),
    ).toBe(true);
    // gemini has no overwrite-install — update = uninstall THEN install.
    const cmds = spawned(geminiLog);
    expect(cmds).toContainEqual(["extensions", "uninstall", CONNECTOR_ID]);
    expect(cmds).toContainEqual(["extensions", "install", geminiPluginDir(), "--consent"]);
    expect(geminiExtensionInstalled(CONNECTOR_ID)).toBe(true);
  });

  it("doctor: passes after a clean install, silent without state", async () => {
    expect(await marketplaceDoctorChecks(makeConnector(), "user", projectDir)).toEqual([]);

    const connector = makeConnector();
    await marketplaceInstall("gemini-cli", connector);
    const groups = await marketplaceDoctorChecks(connector, "user", projectDir);
    expect(groups.map((g) => g.platform)).toEqual(["gemini-cli"]);
    const gemini = groups[0]!;
    expect(gemini.results.every((r) => r.status === "pass")).toBe(true);
    expect(gemini.results.some((r) => r.check.includes("marketplace install"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// qwen (direct driver, DOCS-only) — single qwen-code PlatformId, gemini fork.
// Mock contract: NO --consent, re-install REFUSES, update keeps the marker.
// ─────────────────────────────────────────────────────────────────────────

const qwenStagingRootPath = (): string => join(tmpData, "marketplace", "qwen");
const qwenPluginDir = (): string => join(qwenStagingRootPath(), CONNECTOR_ID);

describe("installViaMarketplace — qwen (mock)", () => {
  it("stages the bundle, drives install (NO --consent), records state", async () => {
    const result = await marketplaceInstall("qwen-code");

    expect(result.changes.some((c) => c.action === "warn")).toBe(false);
    // qwen bundle: qwen-extension.json at the staged root, NO catalog.
    expect(existsSync(join(qwenPluginDir(), "qwen-extension.json"))).toBe(true);

    const cmds = spawned(qwenLog);
    expect(cmds).toContainEqual(["extensions", "install", qwenPluginDir()]);
    // qwen has NO --consent flag (unlike gemini) and NO marketplace verb.
    expect(cmds.some((argv) => argv.includes("--consent"))).toBe(false);
    expect(cmds.some((argv) => argv[1] === "marketplace")).toBe(false);

    expect(qwenExtensionInstalled(CONNECTOR_ID)).toBe(true);
    const record = readMarketplaceInstalls(CONNECTOR_ID)["qwen-code"];
    expect(record).toBeDefined();
    expect(record!.format).toBe("qwen-extension");
    expect(record!.bundleDir).toBe(qwenPluginDir());
    expect(record!.contentHash).not.toBe("");
  });

  it("is idempotent: a re-run reports a `=` skip and never re-drives install (qwen refuses)", async () => {
    await marketplaceInstall("qwen-code");
    const before = spawned(qwenLog).length;

    const again = await marketplaceInstall("qwen-code");
    expect(again.changes.some((c) => c.action === "warn")).toBe(false);
    expect(
      again.changes.some((c) => c.action === "skip" && c.detail.includes("already installed")),
    ).toBe(true);
    // Probe-first: nothing spawned again (a real re-install would REFUSE).
    expect(spawned(qwenLog).length).toBe(before);
  });

  it("refuses (warn) when already installed DIRECTLY — and spawns nothing", async () => {
    const connector = makeConnector();
    await installConnector({
      connector,
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["qwen-code"],
      dryRun: false,
    });

    const result = await marketplaceInstall("qwen-code", connector);
    const warns = result.changes.filter((c) => c.action === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.detail).toContain("already installed DIRECTLY");
    expect(spawned(qwenLog)).toEqual([]);
    expect(readMarketplaceInstalls(CONNECTOR_ID)).toEqual({});
  });

  it("uninstalls: drives extensions uninstall, removes staging + record; re-uninstall is a `=` skip", async () => {
    await marketplaceInstall("qwen-code");

    const result = await uninstallViaMarketplace({
      connectorId: CONNECTOR_ID,
      projectDir,
      dryRun: false,
    });

    expect(result.changes.some((c) => c.action === "warn")).toBe(false);
    expect(spawned(qwenLog)).toContainEqual(["extensions", "uninstall", CONNECTOR_ID]);
    expect(qwenExtensionInstalled(CONNECTOR_ID)).toBe(false);
    expect(existsSync(qwenPluginDir())).toBe(false);
    expect(readMarketplaceInstalls(CONNECTOR_ID)).toEqual({});

    // Re-uninstall with no state/evidence → nothing-found warning, never an error.
    const again = await uninstallViaMarketplace({
      connectorId: CONNECTOR_ID,
      projectDir,
      dryRun: false,
    });
    expect(again.warnings.some((w) => w.includes("no marketplace installs found"))).toBe(true);
  });

  it("upgrade: re-stages then PREFERS `extensions update` (marker stays present)", async () => {
    await marketplaceInstall("qwen-code");

    const result = await upgradeViaMarketplace({
      connector: makeConnector(), // same version 1.2.3
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["qwen-code"],
      dryRun: false,
    });

    expect(
      result.changes.some((c) => c.action === "warn" && c.detail.includes("unchanged")),
    ).toBe(true);
    // qwen documents an `extensions update <id>` verb — preferred when installed.
    const cmds = spawned(qwenLog);
    expect(cmds).toContainEqual(["extensions", "update", CONNECTOR_ID]);
    expect(qwenExtensionInstalled(CONNECTOR_ID)).toBe(true);
  });

  it("doctor: passes after a clean install, silent without state", async () => {
    expect(await marketplaceDoctorChecks(makeConnector(), "user", projectDir)).toEqual([]);

    const connector = makeConnector();
    await marketplaceInstall("qwen-code", connector);
    const groups = await marketplaceDoctorChecks(connector, "user", projectDir);
    expect(groups.map((g) => g.platform)).toEqual(["qwen-code"]);
    const qwen = groups[0]!;
    expect(qwen.results.every((r) => r.status === "pass")).toBe(true);
    expect(qwen.results.some((r) => r.check.includes("marketplace install"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// droid (catalog driver, DOCS-only) — factory shape; catalog at the staging
// ROOT (<stagingRoot>/marketplace.json). Mock contract: settings.json state,
// re-install idempotent, marketplace-remove de-registers on the last plugin.
// ─────────────────────────────────────────────────────────────────────────

const droidStagingRootPath = (): string => join(tmpData, "marketplace", "droid");
const droidPluginDir = (): string => join(droidStagingRootPath(), CONNECTOR_ID);
const droidCatalogPath = (): string => join(droidStagingRootPath(), "marketplace.json");

describe("installViaMarketplace — droid (mock)", () => {
  it("stages the bundle, drives marketplace add + plugin install, records state", async () => {
    const result = await marketplaceInstall("droid");

    expect(result.changes.some((c) => c.action === "warn")).toBe(false);

    // Staged bundle (factory manifest dir) + shared catalog at the staging ROOT.
    expect(existsSync(join(droidPluginDir(), ".factory-plugin", "plugin.json"))).toBe(true);
    const catalog = JSON.parse(readFileSync(droidCatalogPath(), "utf8")) as {
      name: string;
      plugins: Array<{ name: string }>;
    };
    expect(catalog.name).toBe("agent-connector");
    expect(catalog.plugins.map((p) => p.name)).toEqual([CONNECTOR_ID]);

    // Host driven: marketplace add → plugin install (droid verbs).
    const cmds = spawned(droidLog);
    expect(cmds).toContainEqual(["plugin", "marketplace", "add", droidStagingRootPath()]);
    expect(cmds).toContainEqual(["plugin", "install", PLUGIN_KEY]);

    // droid's own settings.json shows the install (written by the fake CLI).
    expect(droidMarketplaceSource("agent-connector")).toBe(droidStagingRootPath());
    expect(droidPluginInstalled(CONNECTOR_ID)).toBe(true);

    const record = readMarketplaceInstalls(CONNECTOR_ID)["droid"];
    expect(record).toBeDefined();
    expect(record!.format).toBe("factory-plugin");
    expect(record!.bundleDir).toBe(droidPluginDir());
    expect(record!.version).toBe("1.2.3");
    expect(record!.contentHash).not.toBe("");
  });

  it("is idempotent: a re-run reports `=` skips and never re-drives the install", async () => {
    await marketplaceInstall("droid");
    const before = spawned(droidLog).length;

    const again = await marketplaceInstall("droid");
    expect(again.changes.some((c) => c.action === "warn")).toBe(false);
    const skips = again.changes.filter((c) => c.action === "skip");
    expect(skips.some((c) => c.detail.includes("already registered"))).toBe(true);
    expect(skips.some((c) => c.detail.includes("already installed"))).toBe(true);

    // Probe-first: nothing spawned on the idempotent re-run.
    expect(spawned(droidLog).length).toBe(before);
  });

  it("refuses (warn) when already installed DIRECTLY — and spawns nothing", async () => {
    const connector = makeConnector();
    await installConnector({
      connector,
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["droid"],
      dryRun: false,
    });

    const result = await marketplaceInstall("droid", connector);
    const warns = result.changes.filter((c) => c.action === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.detail).toContain("already installed DIRECTLY");
    expect(spawned(droidLog)).toEqual([]);
    expect(readMarketplaceInstalls(CONNECTOR_ID)).toEqual({});
  });

  it("refuses to touch a foreign marketplace registered at another path", async () => {
    // A user already registered "agent-connector" at a DIFFERENT source path.
    const foreign = mkdtempSync(join(tmpdir(), "ac-drv-foreign-"));
    const settingsPath = join(tmpHome, ".factory", "settings.json");
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({ extraKnownMarketplaces: { "agent-connector": { source: foreign } } }),
      "utf8",
    );

    const result = await marketplaceInstall("droid");
    const warns = result.changes.filter((c) => c.action === "warn");
    expect(warns.some((c) => c.detail.includes("not ours"))).toBe(true);
    // Never re-pointed the foreign registration, never installed a plugin.
    expect(droidMarketplaceSource("agent-connector")).toBe(foreign);
    expect(droidPluginInstalled(CONNECTOR_ID)).toBe(false);

    rmSync(foreign, { recursive: true, force: true });
  });

  it("uninstalls: drives plugin uninstall, removes staging + record, de-registers when last", async () => {
    await marketplaceInstall("droid");

    const result = await uninstallViaMarketplace({
      connectorId: CONNECTOR_ID,
      projectDir,
      dryRun: false,
    });

    expect(result.changes.some((c) => c.action === "warn")).toBe(false);
    const cmds = spawned(droidLog);
    expect(cmds).toContainEqual(["plugin", "uninstall", PLUGIN_KEY]);
    expect(cmds).toContainEqual(["plugin", "marketplace", "remove", "agent-connector"]);

    expect(droidPluginInstalled(CONNECTOR_ID)).toBe(false);
    expect(droidMarketplaceSource("agent-connector")).toBeNull();
    expect(existsSync(droidPluginDir())).toBe(false);
    expect(readMarketplaceInstalls(CONNECTOR_ID)).toEqual({});
    expect(existsSync(marketplaceInstallsPath(CONNECTOR_ID))).toBe(false);
  });

  it("keeps the shared marketplace registered while ANOTHER staged connector remains", async () => {
    await marketplaceInstall("droid");
    const other = defineConnector({
      id: "other-tool",
      displayName: "Other Tool",
      version: "0.1.0",
      server: { transport: "stdio", command: "npx", args: ["-y", "other"] },
    });
    await installViaMarketplace({
      connector: other,
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["droid"],
      dryRun: false,
    });

    await uninstallViaMarketplace({
      connectorId: CONNECTOR_ID,
      projectDir,
      dryRun: false,
    });

    // acme-db is gone but the shared marketplace + other-tool survive.
    expect(droidPluginInstalled(CONNECTOR_ID)).toBe(false);
    expect(droidPluginInstalled("other-tool")).toBe(true);
    expect(droidMarketplaceSource("agent-connector")).toBe(droidStagingRootPath());
    const catalog = JSON.parse(readFileSync(droidCatalogPath(), "utf8")) as {
      plugins: Array<{ name: string }>;
    };
    expect(catalog.plugins.map((p) => p.name)).toEqual(["other-tool"]);
  });

  it("upgrade: re-stages in place, drives plugin install, warns on an unchanged version", async () => {
    await marketplaceInstall("droid");
    const before = readMarketplaceInstalls(CONNECTOR_ID)["droid"]!;

    const result = await upgradeViaMarketplace({
      connector: makeConnector(), // same version 1.2.3
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["droid"],
      dryRun: false,
    });

    expect(
      result.changes.some((c) => c.action === "warn" && c.detail.includes("unchanged")),
    ).toBe(true);
    // droid has no `plugin update` — update re-drives `plugin install`.
    expect(spawned(droidLog)).toContainEqual(["plugin", "install", PLUGIN_KEY]);
    const after = readMarketplaceInstalls(CONNECTOR_ID)["droid"]!;
    expect(after.installedAt).toBe(before.installedAt);
  });

  it("doctor: passes after a clean install, silent without state", async () => {
    expect(await marketplaceDoctorChecks(makeConnector(), "user", projectDir)).toEqual([]);

    const connector = makeConnector();
    await marketplaceInstall("droid", connector);
    const groups = await marketplaceDoctorChecks(connector, "user", projectDir);
    expect(groups.map((g) => g.platform)).toEqual(["droid"]);
    const droid = groups[0]!;
    expect(droid.results.every((r) => r.status === "pass")).toBe(true);
    expect(droid.results.some((r) => r.check.includes("marketplace install"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// npm-local (opencode / kilo / kilo-cli) — install EDITS a config `plugin`
// array; uninstall EDITS it back (NO host uninstall verb); neutral cwd.
// ─────────────────────────────────────────────────────────────────────────

const npmStagingRootPath = (): string => join(tmpData, "marketplace", "npm");
const npmPluginDirPath = (): string => join(npmStagingRootPath(), CONNECTOR_ID);

describe.each([
  ["opencode", () => opencodeLog] as const,
  ["kilo", () => kiloLog] as const,
  ["kilo-cli", () => kiloLog] as const,
])("installViaMarketplace — npm-local (mock) [%s]", (target, getLog) => {
  const platform = target as PlatformId;

  it("stages the bundle, drives `plugin --global file://...` from a NEUTRAL cwd, records one array entry", async () => {
    const result = await marketplaceInstall(platform);

    expect(result.changes.some((c) => c.action === "warn")).toBe(false);
    // npm-plugin bundle: package.json + index.js at the staged root, NO catalog.
    expect(existsSync(join(npmPluginDirPath(), "package.json"))).toBe(true);
    expect(existsSync(join(npmPluginDirPath(), "index.js"))).toBe(true);

    const calls = spawnedNpm(getLog());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0]).toBe("plugin");
    expect(calls[0]!.args[1]).toBe("--global");
    expect(calls[0]!.args[2]).toMatch(/^file:\/\//);
    expect(calls[0]!.args[2]).toContain(CONNECTOR_ID);
    // Neutral cwd: the staging root, NOT the project dir (no ./.opencode pollution).
    expect(samePath(calls[0]!.cwd, npmStagingRootPath())).toBe(true);
    expect(samePath(calls[0]!.cwd, projectDir)).toBe(false);

    // Exactly ONE entry in the config `plugin` array, and the driver probe agrees.
    const cfg = JSON.parse(readFileSync(npmConfigFilePath(platform), "utf8")) as {
      plugin?: string[];
    };
    expect(cfg.plugin).toHaveLength(1);
    expect(npmPluginInstalled(platform, CONNECTOR_ID)).toBe(true);

    const record = readMarketplaceInstalls(CONNECTOR_ID)[platform];
    expect(record).toBeDefined();
    expect(record!.format).toBe("npm-plugin");
    expect(record!.bundleDir).toBe(npmPluginDirPath());
    expect(result.changes.every((c) => c.platform === platform)).toBe(true);
  });

  it("is idempotent: a re-run reports a `=` skip, never re-drives, no dupe entry", async () => {
    await marketplaceInstall(platform);
    const before = spawnedNpm(getLog()).length;

    const again = await marketplaceInstall(platform);
    expect(again.changes.some((c) => c.action === "warn")).toBe(false);
    expect(
      again.changes.some((c) => c.action === "skip" && c.detail.includes("already installed")),
    ).toBe(true);
    // Probe-first: no second spawn.
    expect(spawnedNpm(getLog()).length).toBe(before);
    const cfg = JSON.parse(readFileSync(npmConfigFilePath(platform), "utf8")) as {
      plugin?: string[];
    };
    expect(cfg.plugin).toHaveLength(1);
  });

  it("uninstalls by EDITING the array (never `<bin> uninstall`), deletes the key when empty", async () => {
    await marketplaceInstall(platform);

    const result = await uninstallViaMarketplace({
      connectorId: CONNECTOR_ID,
      projectDir,
      dryRun: false,
    });

    expect(result.changes.some((c) => c.action === "warn")).toBe(false);
    // NEVER spawn an uninstall verb — the only host spawn was the install.
    const calls = spawnedNpm(getLog());
    expect(calls.some((c) => c.args.includes("uninstall"))).toBe(false);

    expect(npmPluginInstalled(platform, CONNECTOR_ID)).toBe(false);
    const cfg = JSON.parse(readFileSync(npmConfigFilePath(platform), "utf8")) as Record<
      string,
      unknown
    >;
    expect(cfg.plugin).toBeUndefined(); // key deleted when the array empties
    expect(existsSync(npmPluginDirPath())).toBe(false);
    expect(readMarketplaceInstalls(CONNECTOR_ID)).toEqual({});

    // Re-uninstall is a `=` skip (the array edit is naturally idempotent).
    const again = await uninstallViaMarketplace({
      connectorId: CONNECTOR_ID,
      projectDir,
      dryRun: false,
    });
    expect(again.warnings.some((w) => w.includes("no marketplace installs found"))).toBe(true);
  });

  it("array-edit uninstall preserves OTHER keys and OTHER plugin entries", async () => {
    await marketplaceInstall(platform);
    // Inject an unrelated key + a foreign plugin entry into the host config.
    const cfgPath = npmConfigFilePath(platform);
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as {
      plugin: string[];
      theme?: string;
    };
    cfg.theme = "dark";
    cfg.plugin.push("some-other-plugin");
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");

    await uninstallViaMarketplace({ connectorId: CONNECTOR_ID, projectDir, dryRun: false });

    const after = JSON.parse(readFileSync(cfgPath, "utf8")) as {
      plugin?: string[];
      theme?: string;
    };
    expect(after.theme).toBe("dark"); // unrelated key survives
    expect(after.plugin).toEqual(["some-other-plugin"]); // only ours removed
    expect(npmPluginInstalled(platform, CONNECTOR_ID)).toBe(false);
  });

  it("JSONC-tolerant: a config with // and /* */ comments still probes + uninstalls", async () => {
    await marketplaceInstall(platform);
    const cfgPath = npmConfigFilePath(platform);
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { plugin: string[] };
    // Rewrite as JSONC with comments around the (preserved) plugin entry.
    const jsonc =
      `{\n  // a line comment\n  /* a block comment */\n` +
      `  "theme": "dark",\n  "plugin": ${JSON.stringify(cfg.plugin)}\n}\n`;
    writeFileSync(cfgPath, jsonc, "utf8");

    expect(npmPluginInstalled(platform, CONNECTOR_ID)).toBe(true);
    const result = await uninstallViaMarketplace({
      connectorId: CONNECTOR_ID,
      projectDir,
      dryRun: false,
    });
    expect(result.changes.some((c) => c.action === "warn")).toBe(false);
    expect(npmPluginInstalled(platform, CONNECTOR_ID)).toBe(false);
  });

  it("upgrade: re-stages in place + idempotent install (file:// points at the live dir)", async () => {
    await marketplaceInstall(platform);

    const result = await upgradeViaMarketplace({
      connector: makeConnector(),
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: [platform],
      dryRun: false,
    });

    expect(
      result.changes.some((c) => c.action === "warn" && c.detail.includes("unchanged")),
    ).toBe(true);
    // Still exactly one entry (file:// already pointed at the live staged dir).
    const cfg = JSON.parse(readFileSync(npmConfigFilePath(platform), "utf8")) as {
      plugin?: string[];
    };
    expect(cfg.plugin).toHaveLength(1);
    expect(npmPluginInstalled(platform, CONNECTOR_ID)).toBe(true);
  });

  it("doctor: passes after a clean install", async () => {
    const connector = makeConnector();
    await marketplaceInstall(platform, connector);
    const groups = await marketplaceDoctorChecks(connector, "user", projectDir);
    expect(groups.map((g) => g.platform)).toEqual([platform]);
    expect(groups[0]!.results.every((r) => r.status === "pass")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runHostCommand cwd option — the new, backward-compatible third argument.
// ─────────────────────────────────────────────────────────────────────────

describe("runHostCommand — cwd option (backward-compatible)", () => {
  it("inherits the parent cwd when no cwd is given (claude/codex/agy contract)", async () => {
    // The fake opencode CLI logs process.cwd(); with no cwd option the child
    // inherits the parent's cwd unchanged — the existing-callers contract.
    const r = await runHostCommand("opencode", ["plugin", "--global", "file:///x"]);
    expect(r.ok).toBe(true);
    const calls = spawnedNpm(opencodeLog);
    expect(calls).toHaveLength(1);
    expect(samePath(calls[0]!.cwd, process.cwd())).toBe(true);
  });

  it("runs the child in the requested cwd when one is given", async () => {
    const r = await runHostCommand("opencode", ["plugin", "--global", "file:///x"], {
      cwd: tmpData,
    });
    expect(r.ok).toBe(true);
    const calls = spawnedNpm(opencodeLog);
    expect(calls).toHaveLength(1);
    expect(samePath(calls[0]!.cwd, tmpData)).toBe(true);
  });

  it("still accepts a bare numeric timeout positional (legacy callers unaffected)", async () => {
    // A legacy positional number must keep meaning timeoutMs (no cwd applied).
    const r = await runHostCommand("opencode", ["plugin", "--global", "file:///x"], 30_000);
    expect(r.ok).toBe(true);
    const calls = spawnedNpm(opencodeLog);
    expect(samePath(calls[0]!.cwd, process.cwd())).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// samePath — host-recorded path vs the path WE built (Windows \\?\ canonical
// form regression: live-confirmed codex stores `\\?\C:\…` on win32).
// ─────────────────────────────────────────────────────────────────────────

describe("samePath (cross-host path equivalence)", () => {
  it("null/undefined never matches", () => {
    expect(samePath(null, "/a")).toBe(false);
    expect(samePath("/a", undefined)).toBe(false);
    expect(samePath(null, null)).toBe(false);
  });

  it("resolves equivalent paths (trailing slash, .., .)", () => {
    expect(samePath("/a/b", "/a/b")).toBe(true);
    expect(samePath("/a/b/", "/a/b")).toBe(true);
    expect(samePath("/a/x/../b", "/a/b")).toBe(true);
    expect(samePath("/a/./b", "/a/b")).toBe(true);
    expect(samePath("/a/b", "/a/c")).toBe(false);
  });

  it.runIf(process.platform === "win32")(
    "strips the win32 extended-length \\\\?\\ prefix and case-folds",
    () => {
      expect(samePath("\\\\?\\C:\\Users\\x\\codex", "C:\\Users\\x\\codex")).toBe(true);
      expect(samePath("\\\\?\\C:\\USERS\\X\\CODEX", "c:\\users\\x\\codex")).toBe(true);
      expect(samePath("\\\\?\\C:\\Users\\x\\codex", "C:\\Users\\y\\codex")).toBe(false);
    },
  );
});
