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
  marketplaceInstallsPath,
  readMarketplaceInstalls,
} from "../../src/core/marketplace-state.js";
import type { PlatformId, ResolvedConnector } from "../../src/core/types.js";

const DIST_INDEX = join(__dirname, "..", "..", "dist", "index.js");
const CONNECTOR_ID = "acme-db";
const PLUGIN_KEY = `${CONNECTOR_ID}@agent-connector`;

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  PATH: process.env.PATH,
  FAKE_CODEX_LOG: process.env.FAKE_CODEX_LOG,
  FAKE_AGY_LOG: process.env.FAKE_AGY_LOG,
  TELEMETRY: process.env.AGENT_CONNECTOR_TELEMETRY,
};

let tmpHome: string;
let tmpData: string;
let tmpCodexHome: string;
let tmpBin: string;
let projectDir: string;
let codexLog: string;
let agyLog: string;
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
  tmpBin = mkdtempSync(join(tmpdir(), "ac-drv-bin-"));
  projectDir = mkdtempSync(join(tmpdir(), "ac-drv-proj-"));
  codexLog = join(tmpBin, "codex.log");
  agyLog = join(tmpBin, "agy.log");

  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENT_CONNECTOR_DATA_DIR = tmpData;
  process.env.CODEX_HOME = tmpCodexHome;
  process.env.FAKE_CODEX_LOG = codexLog;
  process.env.FAKE_AGY_LOG = agyLog;
  process.env.PATH = `${tmpBin}${delimiter}${SAVED.PATH ?? ""}`;
  delete process.env.AGENT_CONNECTOR_TELEMETRY;

  writeFakeCli(tmpBin, "codex", FAKE_CODEX_MJS);
  writeFakeCli(tmpBin, "agy", FAKE_AGY_MJS);
  fixtureModulePath = writeFixtureModule(tmpData);
});

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const d of [tmpHome, tmpData, tmpCodexHome, tmpBin, projectDir]) {
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
