/**
 * core/marketplace — the marketplace delivery method against a MOCK claude CLI.
 *
 * A fake `claude` binary (a tiny node script behind sh/.cmd wrappers, prepended
 * to PATH) emulates the live-verified contract of the real CLI's plugin verbs:
 * `plugin marketplace add/remove` mutate known_marketplaces.json and
 * `plugin install/uninstall` mutate installed_plugins.json under
 * $CLAUDE_CONFIG_DIR/plugins/ — the same state files the drivers' probes read.
 * Every invocation is appended to $FAKE_CLAUDE_LOG so tests can assert exactly
 * which host commands were (or were NOT) spawned.
 *
 * Isolation contract (mirrors tests/integration/install-roundtrip.test.ts):
 * HOME/USERPROFILE, AGENT_CONNECTOR_DATA_DIR, CLAUDE_CONFIG_DIR, and PATH are
 * all redirected to fresh temp dirs and restored verbatim afterEach.
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
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

import { defineConnector } from "../../src/core/define-connector.js";
import { installConnector, uninstallConnector } from "../../src/core/installer.js";
import {
  installViaMarketplace,
  marketplaceDoctorChecks,
  uninstallViaMarketplace,
  upgradeViaMarketplace,
} from "../../src/core/marketplace.js";
import {
  claudePluginInstalled,
  claudeKnownMarketplacePath,
  marketplaceEvidence,
  marketplaceInstallsPath,
  readMarketplaceInstalls,
} from "../../src/core/marketplace-state.js";
import type { ResolvedConnector } from "../../src/core/types.js";

const DIST_INDEX = join(__dirname, "..", "..", "dist", "index.js");
const CONNECTOR_ID = "acme-db";
const PLUGIN_KEY = `${CONNECTOR_ID}@agent-connector`;

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  PATH: process.env.PATH,
  FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG,
  TELEMETRY: process.env.AGENT_CONNECTOR_TELEMETRY,
};

let tmpHome: string;
let tmpData: string;
let tmpCfg: string;
let tmpBin: string;
let projectDir: string;
let logPath: string;
let fixtureModulePath: string;

/** The fake claude CLI: emulates the live-verified plugin-verb contract. */
const FAKE_CLAUDE_MJS = `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + "\\n");
}
const cfg = process.env.CLAUDE_CONFIG_DIR;
const kmPath = join(cfg, "plugins", "known_marketplaces.json");
const ipPath = join(cfg, "plugins", "installed_plugins.json");
const readJson = (p, dflt) => {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return dflt; }
};
const writeJson = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2));
};

if (args[0] !== "plugin") process.exit(2);
switch (args[1]) {
  case "validate":
    process.exit(process.env.FAKE_CLAUDE_VALIDATE_FAIL ? 1 : 0);
  case "marketplace": {
    const km = readJson(kmPath, {});
    if (args[2] === "add") {
      km["agent-connector"] = {
        source: { source: "directory", path: args[3] },
        installLocation: args[3],
        lastUpdated: new Date().toISOString(),
      };
      writeJson(kmPath, km);
      process.exit(0);
    }
    if (args[2] === "remove") {
      if (!km[args[3]]) process.exit(1); // real CLI: exit 1 when absent
      delete km[args[3]];
      writeJson(kmPath, km);
      process.exit(0);
    }
    process.exit(2);
  }
  case "install": {
    const ip = readJson(ipPath, { version: 2, plugins: {} });
    ip.plugins[args[2]] = [
      { scope: "user", installPath: "/fake/cache", version: "1.2.3", installedAt: new Date().toISOString() },
    ];
    writeJson(ipPath, ip);
    process.exit(0);
  }
  case "uninstall": {
    const ip = readJson(ipPath, { version: 2, plugins: {} });
    if (!ip.plugins[args[2]]) process.exit(1); // real CLI: exit 1 when absent
    delete ip.plugins[args[2]];
    writeJson(ipPath, ip);
    process.exit(0);
  }
  case "update":
    process.exit(claudePluginListed() ? 0 : 1);
  default:
    process.exit(2);
}
function claudePluginListed() {
  const ip = readJson(ipPath, { version: 2, plugins: {} });
  return Object.keys(ip.plugins).length > 0;
}
`;

function writeFakeClaude(dir: string): void {
  const script = join(dir, "fake-claude.mjs");
  writeFileSync(script, FAKE_CLAUDE_MJS, "utf8");
  const node = process.execPath;
  if (process.platform === "win32") {
    writeFileSync(
      join(dir, "claude.cmd"),
      `@echo off\r\n"${node}" "${script}" %*\r\n`,
      "utf8",
    );
  } else {
    const sh = join(dir, "claude");
    writeFileSync(sh, `#!/bin/sh\nexec "${node}" "${script}" "$@"\n`, "utf8");
    chmodSync(sh, 0o755);
  }
}

function makeConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
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

/** The fake CLI's logged invocations (argv arrays), [] when nothing spawned. */
function spawnedCommands(): string[][] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as string[]);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const installedPluginsPath = (): string =>
  join(tmpCfg, "plugins", "installed_plugins.json");
const stagingRoot = (): string => join(tmpData, "marketplace", "claude");
const stagedPluginDir = (): string => join(stagingRoot(), CONNECTOR_ID);
const catalogPath = (): string =>
  join(stagingRoot(), ".claude-plugin", "marketplace.json");

function marketplaceInstall(connector = makeConnector()) {
  return installViaMarketplace({
    connector,
    modulePath: fixtureModulePath,
    scope: "user",
    projectDir,
    targets: ["claude-code"],
    dryRun: false,
  });
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-mkt-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-mkt-data-"));
  tmpCfg = mkdtempSync(join(tmpdir(), "ac-mkt-cfg-"));
  tmpBin = mkdtempSync(join(tmpdir(), "ac-mkt-bin-"));
  projectDir = mkdtempSync(join(tmpdir(), "ac-mkt-proj-"));
  logPath = join(tmpBin, "invocations.log");

  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENT_CONNECTOR_DATA_DIR = tmpData;
  process.env.CLAUDE_CONFIG_DIR = tmpCfg;
  process.env.FAKE_CLAUDE_LOG = logPath;
  process.env.PATH = `${tmpBin}${delimiter}${SAVED.PATH ?? ""}`;
  delete process.env.AGENT_CONNECTOR_TELEMETRY;
  delete process.env.FAKE_CLAUDE_VALIDATE_FAIL;

  writeFakeClaude(tmpBin);
  fixtureModulePath = writeFixtureModule(tmpData);
});

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env.FAKE_CLAUDE_VALIDATE_FAIL;
  for (const d of [tmpHome, tmpData, tmpCfg, tmpBin, projectDir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("installViaMarketplace (mock claude)", () => {
  it("stages the bundle, drives marketplace add + plugin install, and records state", async () => {
    const result = await marketplaceInstall();

    expect(result.changes.some((c) => c.action === "warn")).toBe(false);

    // Staged bundle + regenerated shared catalog under the DATA-root.
    expect(existsSync(join(stagedPluginDir(), ".claude-plugin", "plugin.json"))).toBe(true);
    const catalog = readJson(catalogPath()) as {
      name: string;
      plugins: Array<{ name: string }>;
    };
    expect(catalog.name).toBe("agent-connector");
    expect(catalog.plugins.map((p) => p.name)).toEqual([CONNECTOR_ID]);

    // The host CLI was driven: validate → marketplace add → plugin install.
    const cmds = spawnedCommands();
    expect(cmds).toContainEqual(["plugin", "marketplace", "add", stagingRoot()]);
    expect(cmds).toContainEqual(["plugin", "install", PLUGIN_KEY]);

    // Claude's own state files now show the install (written by the fake CLI).
    expect(claudeKnownMarketplacePath("agent-connector")).toBe(stagingRoot());
    expect(claudePluginInstalled(CONNECTOR_ID)).toBe(true);

    // State record drives uninstall --method auto, upgrade, doctor, guards.
    const record = readMarketplaceInstalls(CONNECTOR_ID)["claude-code"];
    expect(record).toBeDefined();
    expect(record!.format).toBe("claude-plugin");
    expect(record!.bundleDir).toBe(stagedPluginDir());
    expect(record!.version).toBe("1.2.3");
    expect(record!.contentHash).not.toBe("");
    expect(marketplaceEvidence(CONNECTOR_ID, "claude-code")).toBeTruthy();
  });

  it("is idempotent: a re-run reports `=` skips and never re-drives the install", async () => {
    await marketplaceInstall();
    const before = spawnedCommands().length;

    const again = await marketplaceInstall();
    expect(again.changes.some((c) => c.action === "warn")).toBe(false);
    const skips = again.changes.filter((c) => c.action === "skip");
    expect(skips.some((c) => c.detail.includes("already registered"))).toBe(true);
    expect(skips.some((c) => c.detail.includes("already installed"))).toBe(true);

    // Only the (idempotent) validate spawn is allowed on the re-run.
    const after = spawnedCommands().slice(before);
    expect(after.every((argv) => argv[1] === "validate")).toBe(true);
  });

  it("--dry-run prints the staged tree + exact host commands without writing or spawning", async () => {
    const connector = makeConnector();
    const result = await installViaMarketplace({
      connector,
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["claude-code"],
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    const details = result.changes.map((c) => c.detail);
    expect(details).toContain(`run: claude plugin marketplace add ${stagingRoot()}`);
    expect(details).toContain(`run: claude plugin install ${PLUGIN_KEY}`);
    expect(result.changes.some((c) => c.detail === "stage bundle file")).toBe(true);

    expect(spawnedCommands()).toEqual([]); // nothing spawned
    expect(existsSync(stagingRoot())).toBe(false); // nothing written
    expect(existsSync(marketplaceInstallsPath(CONNECTOR_ID))).toBe(false);
  });

  it("refuses (warn) when the connector is already installed DIRECTLY — and spawns nothing", async () => {
    const connector = makeConnector();
    await installConnector({
      connector,
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["claude-code"],
      dryRun: false,
    });

    const result = await marketplaceInstall(connector);
    const warns = result.changes.filter((c) => c.action === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.detail).toContain("already installed DIRECTLY");
    expect(spawnedCommands()).toEqual([]);
    expect(readMarketplaceInstalls(CONNECTOR_ID)).toEqual({});
  });

  it("refuses a pre-existing marketplace named agent-connector at a foreign path", async () => {
    mkdirSync(join(tmpCfg, "plugins"), { recursive: true });
    writeFileSync(
      join(tmpCfg, "plugins", "known_marketplaces.json"),
      JSON.stringify({
        "agent-connector": {
          source: { source: "directory", path: "/somewhere/else" },
          installLocation: "/somewhere/else",
        },
      }),
      "utf8",
    );

    const result = await marketplaceInstall();
    const warns = result.changes.filter((c) => c.action === "warn");
    expect(warns.some((c) => c.detail.includes("not ours"))).toBe(true);
    // It never drove add/install/remove against the user's registration.
    const cmds = spawnedCommands().filter((argv) => argv[1] !== "validate");
    expect(cmds).toEqual([]);
    expect(claudePluginInstalled(CONNECTOR_ID)).toBe(false);
  });

  it("degrades to staged-bundle + manual instructions when claude is not on PATH", async () => {
    process.env.PATH = tmpHome; // no claude anywhere
    const result = await marketplaceInstall();
    const warns = result.changes.filter((c) => c.action === "warn");
    expect(warns.some((c) => c.detail.includes("claude CLI not found"))).toBe(true);
    expect(warns.some((c) => c.detail.includes("claude plugin marketplace add"))).toBe(true);
    // Bundle IS staged (the printed manual commands point at it)…
    expect(existsSync(stagedPluginDir())).toBe(true);
    // …but no record is written (the install did not happen).
    expect(readMarketplaceInstalls(CONNECTOR_ID)).toEqual({});
  });

  it("direct install refuses (warn) when marketplace evidence exists — the inverse guard", async () => {
    const connector = makeConnector();
    await marketplaceInstall(connector);

    const result = await installConnector({
      connector,
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["claude-code"],
      dryRun: false,
    });
    const warns = result.changes.filter((c) => c.action === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.detail).toContain("via MARKETPLACE");
    // The host config was never written.
    expect(existsSync(join(tmpHome, ".claude.json"))).toBe(false);
  });
});

describe("uninstallViaMarketplace (mock claude)", () => {
  it("drives plugin uninstall, removes staging + record, and de-registers the marketplace when last", async () => {
    await marketplaceInstall();

    const result = await uninstallViaMarketplace({
      connectorId: CONNECTOR_ID,
      projectDir,
      dryRun: false,
    });

    expect(result.changes.some((c) => c.action === "warn")).toBe(false);
    const cmds = spawnedCommands();
    expect(cmds).toContainEqual(["plugin", "uninstall", PLUGIN_KEY]);
    expect(cmds).toContainEqual(["plugin", "marketplace", "remove", "agent-connector"]);

    expect(claudePluginInstalled(CONNECTOR_ID)).toBe(false);
    expect(claudeKnownMarketplacePath("agent-connector")).toBeNull();
    expect(existsSync(stagedPluginDir())).toBe(false);
    expect(readMarketplaceInstalls(CONNECTOR_ID)).toEqual({});
    expect(existsSync(marketplaceInstallsPath(CONNECTOR_ID))).toBe(false);
  });

  it("is idempotent: uninstalling an absent plugin is a `=` skip, never an error", async () => {
    const result = await uninstallViaMarketplace({
      connectorId: CONNECTOR_ID,
      projectDir,
      targets: ["claude-code"],
      dryRun: false,
    });
    expect(result.changes.some((c) => c.action === "warn")).toBe(false);
    expect(
      result.changes.some(
        (c) => c.action === "skip" && c.detail.includes("not installed"),
      ),
    ).toBe(true);
    // Probe-first: the fake CLI (which exits 1 on absent uninstall) is never hit.
    expect(spawnedCommands()).toEqual([]);
  });

  it("keeps the shared marketplace registered while ANOTHER staged connector remains", async () => {
    await marketplaceInstall();
    // Stage a second connector into the shared root via a second install.
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
      targets: ["claude-code"],
      dryRun: false,
    });

    await uninstallViaMarketplace({
      connectorId: CONNECTOR_ID,
      projectDir,
      dryRun: false,
    });

    // acme-db is gone but the shared marketplace + other-tool survive.
    expect(claudePluginInstalled(CONNECTOR_ID)).toBe(false);
    expect(claudePluginInstalled("other-tool")).toBe(true);
    expect(claudeKnownMarketplacePath("agent-connector")).toBe(stagingRoot());
    const catalog = readJson(catalogPath()) as { plugins: Array<{ name: string }> };
    expect(catalog.plugins.map((p) => p.name)).toEqual(["other-tool"]);
  });

  it("direct uninstall --purge REFUSES while marketplace installs survive (home-bin guard)", async () => {
    await marketplaceInstall();

    const result = await uninstallConnector({
      connectorId: CONNECTOR_ID,
      scope: "user",
      projectDir,
      targets: ["codex"],
      dryRun: false,
      purge: true,
    });
    expect(
      result.changes.some(
        (c) => c.action === "warn" && c.detail.includes("--purge skipped"),
      ),
    ).toBe(true);
    // The connector record (holding marketplace-installs.json) survives.
    expect(existsSync(marketplaceInstallsPath(CONNECTOR_ID))).toBe(true);
  });
});

describe("upgradeViaMarketplace (mock claude)", () => {
  it("re-stages in place, drives `plugin update`, and warns on an unchanged version", async () => {
    await marketplaceInstall();
    const before = readMarketplaceInstalls(CONNECTOR_ID)["claude-code"]!;

    const result = await upgradeViaMarketplace({
      connector: makeConnector(), // same version 1.2.3
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      dryRun: false,
    });

    expect(
      result.changes.some(
        (c) => c.action === "warn" && c.detail.includes("unchanged"),
      ),
    ).toBe(true);
    expect(spawnedCommands()).toContainEqual(["plugin", "update", PLUGIN_KEY]);
    const after = readMarketplaceInstalls(CONNECTOR_ID)["claude-code"]!;
    expect(after.installedAt).toBe(before.installedAt); // record preserved, refreshed in place
  });

  it("warns when nothing is marketplace-installed", async () => {
    const result = await upgradeViaMarketplace({
      connector: makeConnector(),
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      dryRun: false,
    });
    expect(result.warnings.some((w) => w.includes("no marketplace installs"))).toBe(true);
  });
});

describe("marketplaceDoctorChecks (mock claude)", () => {
  it("passes after a clean marketplace install", async () => {
    const connector = makeConnector();
    await marketplaceInstall(connector);

    const groups = await marketplaceDoctorChecks(connector, "user", projectDir);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.platform).toBe("claude-code");
    expect(groups[0]!.results.every((r) => r.status === "pass")).toBe(true);
  });

  it("is silent for a connector with no marketplace state", async () => {
    const groups = await marketplaceDoctorChecks(makeConnector(), "user", projectDir);
    expect(groups).toEqual([]);
  });

  it("Claude's own plugin-state entry is NOT a duplicate (structural probe)", async () => {
    const connector = makeConnector();
    await marketplaceInstall(connector);
    // After a real `claude plugin install`, Claude itself writes the plugin
    // key into settings.json (enabledPlugins) — the old substring probe
    // misread this as a direct install and FAILed every clean marketplace
    // install with duplicate-registration.
    mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { [`${CONNECTOR_ID}@agent-connector`]: true } }),
      "utf8",
    );

    const groups = await marketplaceDoctorChecks(connector, "user", projectDir);
    const dup = groups[0]!.results.find((r) =>
      r.check.includes("duplicate-registration"),
    );
    expect(dup).toBeUndefined();
  });

  it("a real direct hook command IS a duplicate (hook-config probe)", async () => {
    const connector = makeConnector();
    await marketplaceInstall(connector);
    mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "",
              hooks: [
                {
                  type: "command",
                  command: `"/x/agent-connector" hook claude-code SessionStart --connector ${CONNECTOR_ID}`,
                },
              ],
            },
          ],
        },
      }),
      "utf8",
    );

    const groups = await marketplaceDoctorChecks(connector, "user", projectDir);
    const dup = groups[0]!.results.find((r) =>
      r.check.includes("duplicate-registration"),
    );
    expect(dup).toBeDefined();
    expect(dup!.status).toBe("fail");
  });

  it("FAILs duplicate-registration when both methods are present", async () => {
    const connector = makeConnector();
    await marketplaceInstall(connector);
    // Simulate a manual direct install bypassing the CLI guard.
    writeFileSync(
      join(tmpHome, ".claude.json"),
      JSON.stringify({ mcpServers: { [CONNECTOR_ID]: { command: "x" } } }),
      "utf8",
    );

    const groups = await marketplaceDoctorChecks(connector, "user", projectDir);
    const dup = groups[0]!.results.find((r) =>
      r.check.includes("duplicate-registration"),
    );
    expect(dup).toBeDefined();
    expect(dup!.status).toBe("fail");
  });

  it("warns on state↔host drift when the host lost the plugin", async () => {
    const connector = makeConnector();
    await marketplaceInstall(connector);
    rmSync(installedPluginsPath(), { force: true }); // host state wiped

    const groups = await marketplaceDoctorChecks(connector, "user", projectDir);
    const drift = groups[0]!.results.find((r) => r.check.includes("state drift"));
    expect(drift).toBeDefined();
    expect(drift!.status).toBe("warn");
  });

  it("FAILs when the home-bin launcher the plugin hooks exec is missing", async () => {
    const connector = makeConnector();
    await marketplaceInstall(connector);
    rmSync(join(tmpData, "bin"), { recursive: true, force: true });

    const groups = await marketplaceDoctorChecks(connector, "user", projectDir);
    const homeBin = groups[0]!.results.find((r) => r.check.includes("home-bin"));
    expect(homeBin).toBeDefined();
    expect(homeBin!.status).toBe("fail");
    expect(homeBin!.fix).toContain("upgrade");
  });

  it("warns on version staleness vs the recorded install", async () => {
    await marketplaceInstall();
    const bumped = defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme DB Tools",
      version: "2.0.0",
      server: { transport: "stdio", command: "npx", args: ["-y", "@acme/db-mcp"] },
    });
    const groups = await marketplaceDoctorChecks(bumped, "user", projectDir);
    const stale = groups[0]!.results.find((r) => r.check.includes("staleness"));
    expect(stale).toBeDefined();
    expect(stale!.status).toBe("warn");
    expect(stale!.fix).toContain("upgrade --method marketplace");
  });
});
