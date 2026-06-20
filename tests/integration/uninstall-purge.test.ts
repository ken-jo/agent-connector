/**
 * integration/uninstall-purge — connector DEREGISTRATION via uninstall --purge.
 *
 * Per-target uninstall strips host-native MCP/hook/content registrations but, by
 * design, never removes the framework-state install wrote: the DATA-dir connector
 * record (connectorDir(id)/connector.json from registerConnector) and the shared
 * home-bin launcher (homeBinPath() from ensureHomeBin). Before this change an
 * orphan record + launcher lingered with no CLI way to remove them.
 *
 *   • uninstall WITHOUT --purge → the connector record STILL exists
 *     (loadRegisteredConnector resolves; readRegisteredMeta is non-null).
 *   • uninstall WITH --purge → the record is GONE (readRegisteredMeta === null;
 *     loadRegisteredConnector throws "not registered") AND, when it was the only
 *     connector, the home-bin launcher is removed too.
 *
 * Isolation contract (mirrors install-roundtrip): HOME + AGENT_CONNECTOR_DATA_DIR
 * are throwaway temp dirs, restored verbatim in afterEach; both trees removed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { main } from "../../src/cli/app.js";
import {
  installConnector,
  purgeFrameworkState,
  uninstallConnector,
} from "../../src/core/installer.js";
import {
  loadConnectorFromPath,
  loadRegisteredConnector,
  readRegisteredMeta,
} from "../../src/core/load-connector.js";
import { claudeStagingRoot } from "../../src/core/marketplace-state.js";
import { homeBinPath } from "../../src/core/paths.js";
import type { InstallResult } from "../../src/core/types.js";

const DIST_INDEX = join(__dirname, "..", "..", "dist", "index.js");

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  TELEMETRY: process.env.AGENT_CONNECTOR_TELEMETRY,
};

const CONNECTOR_ID = "acme-db";
const OTHER_ID = "beta-svc";

let tmpHome: string;
let tmpData: string;
let projectDir: string;
let fixtureModulePath: string;

/** Write a tiny fixture connector module that imports defineConnector from dist. */
function writeFixtureModule(dir: string, id: string): string {
  const modPath = join(dir, `${id}.config.mjs`);
  const distUrl = pathToFileURL(DIST_INDEX).href;
  const source = `
import { defineConnector } from ${JSON.stringify(distUrl)};

export default defineConnector({
  id: ${JSON.stringify(id)},
  displayName: ${JSON.stringify(id)},
  version: "1.0.0",
  server: { transport: "stdio", command: "npx", args: ["-y", "@acme/db-mcp"] },
  hooks: {
    PreToolUse: { handler() { return { decision: "allow" }; } },
  },
});
`;
  writeFileSync(modPath, source, "utf8");
  return modPath;
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-purge-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-purge-data-"));
  projectDir = mkdtempSync(join(tmpdir(), "ac-purge-proj-"));

  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENT_CONNECTOR_DATA_DIR = tmpData;
  delete process.env.AGENT_CONNECTOR_TELEMETRY;

  fixtureModulePath = writeFixtureModule(tmpData, CONNECTOR_ID);
});

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const d of [tmpHome, tmpData, projectDir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function recordPath(id: string): string {
  return join(tmpData, "connectors", id, "connector.json");
}

describe("uninstall --purge deregisters the connector record + home-bin", () => {
  it("WITHOUT --purge: the connector record survives uninstall", async () => {
    const { connector } = await loadConnectorFromPath(fixtureModulePath);

    await installConnector({
      connector,
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["claude-code"],
      dryRun: false,
    });

    // Record + launcher present after install.
    expect(existsSync(recordPath(CONNECTOR_ID))).toBe(true);
    expect(existsSync(homeBinPath())).toBe(true);

    await uninstallConnector({
      connectorId: CONNECTOR_ID,
      scope: "user",
      projectDir,
      targets: ["claude-code"],
      dryRun: false,
      // purge omitted
    });

    // Per-target stripping does NOT remove framework-state.
    expect(readRegisteredMeta(CONNECTOR_ID)).not.toBeNull();
    await expect(loadRegisteredConnector(CONNECTOR_ID)).resolves.toBeTruthy();
    expect(existsSync(recordPath(CONNECTOR_ID))).toBe(true);
    expect(existsSync(homeBinPath())).toBe(true);
  });

  it("WITH --purge: the record is removed and (sole connector) the home-bin too", async () => {
    const { connector } = await loadConnectorFromPath(fixtureModulePath);

    await installConnector({
      connector,
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["claude-code"],
      dryRun: false,
    });
    expect(existsSync(recordPath(CONNECTOR_ID))).toBe(true);
    expect(existsSync(homeBinPath())).toBe(true);

    const result = await uninstallConnector({
      connectorId: CONNECTOR_ID,
      scope: "user",
      projectDir,
      targets: ["claude-code"],
      dryRun: false,
      purge: true,
    });

    // Record gone: readRegisteredMeta null + loadRegisteredConnector rejects.
    expect(readRegisteredMeta(CONNECTOR_ID)).toBeNull();
    await expect(loadRegisteredConnector(CONNECTOR_ID)).rejects.toThrow(
      /not registered/,
    );
    expect(existsSync(recordPath(CONNECTOR_ID))).toBe(false);

    // It was the only connector → the shared home-bin launcher is removed.
    expect(existsSync(homeBinPath())).toBe(false);

    // The purge emitted explicit change records.
    const details = result.changes.map((c) => c.detail);
    expect(details).toContain("deregistered connector record");
    expect(details).toContain("removed home-bin (no connectors remain)");
  });

  it("WITH --purge but other connectors remain: keep the home-bin launcher", async () => {
    const otherModule = writeFixtureModule(tmpData, OTHER_ID);

    const a = await loadConnectorFromPath(fixtureModulePath);
    const b = await loadConnectorFromPath(otherModule);

    await installConnector({
      connector: a.connector,
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["claude-code"],
      dryRun: false,
    });
    await installConnector({
      connector: b.connector,
      modulePath: otherModule,
      scope: "user",
      projectDir,
      targets: ["claude-code"],
      dryRun: false,
    });

    const result = await uninstallConnector({
      connectorId: CONNECTOR_ID,
      scope: "user",
      projectDir,
      targets: ["claude-code"],
      dryRun: false,
      purge: true,
    });

    // The purged connector's record is gone…
    expect(existsSync(recordPath(CONNECTOR_ID))).toBe(false);
    // …but the other connector's record AND the shared launcher remain.
    expect(existsSync(recordPath(OTHER_ID))).toBe(true);
    expect(existsSync(homeBinPath())).toBe(true);

    const details = result.changes.map((c) => c.detail);
    expect(details).toContain("deregistered connector record");
    expect(details).not.toContain("removed home-bin (no connectors remain)");
  });

  it("dryRun --purge reports the changes but mutates nothing", async () => {
    const { connector } = await loadConnectorFromPath(fixtureModulePath);

    await installConnector({
      connector,
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["claude-code"],
      dryRun: false,
    });

    const result = await uninstallConnector({
      connectorId: CONNECTOR_ID,
      scope: "user",
      projectDir,
      targets: ["claude-code"],
      dryRun: true,
      purge: true,
    });

    // Nothing removed on dry-run.
    expect(existsSync(recordPath(CONNECTOR_ID))).toBe(true);
    expect(existsSync(homeBinPath())).toBe(true);
    expect(readRegisteredMeta(CONNECTOR_ID)).not.toBeNull();

    // …but the would-be purge changes are still reported.
    const details = result.changes.map((c) => c.detail);
    expect(details).toContain("deregistered connector record");
    expect(details).toContain("removed home-bin (no connectors remain)");
  });

  it("rejects an invalid connector id before purge can escape the connector record root", () => {
    const victim = mkdtempSync(join(tmpdir(), "ac-purge-victim-"));
    try {
      mkdirSync(victim, { recursive: true });
      writeFileSync(join(victim, "keep.txt"), "keep\n", "utf8");

      const result: InstallResult = {
        connectorId: "../../victim",
        dryRun: false,
        changes: [],
        warnings: [],
      };
      purgeFrameworkState("../../victim", false, result);

      expect(existsSync(join(victim, "keep.txt"))).toBe(true);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0]?.action).toBe("warn");
      expect(result.changes[0]?.detail).toContain("invalid connector id");
      expect(result.warnings[0]).toContain("invalid connector id");
    } finally {
      rmSync(victim, { recursive: true, force: true });
    }
  });

  it("warn-skips a symlinked connector record directory during purge", () => {
    const outside = mkdtempSync(join(tmpdir(), "ac-purge-link-target-"));
    try {
      mkdirSync(join(tmpData, "connectors"), { recursive: true });
      writeFileSync(join(outside, "keep.txt"), "keep\n", "utf8");
      symlinkSync(outside, join(tmpData, "connectors", CONNECTOR_ID), "dir");

      const result: InstallResult = {
        connectorId: CONNECTOR_ID,
        dryRun: false,
        changes: [],
        warnings: [],
      };
      purgeFrameworkState(CONNECTOR_ID, false, result);

      expect(existsSync(join(outside, "keep.txt"))).toBe(true);
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0]?.action).toBe("warn");
      expect(result.changes[0]?.detail).toContain("symbolic link");
      expect(result.warnings[0]).toContain("symbolic link");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

/**
 * CLI-boundary id validation — the uninstall command must reject a malformed
 * connector id (traversal / absolute / empty) BEFORE any path is built or any
 * filesystem delete runs, on BOTH the default uninstall path and the explicit
 * `--targets` marketplace path.
 *
 * Regression for the #197/#199 review gap: resolveConnectorId did not call
 * assertConnectorId, so on the explicit `--targets` marketplace branch
 * uninstallViaMarketplace skipped the readMarketplaceInstalls validation and an
 * unvalidated id reached driver.finishUninstall(id) → rmSync(join(stagingRoot,
 * id)) — a `--connector-id ../../x` traversal window. The fix validates once at
 * the top of the command, covering every branch.
 *
 * The traversal probe plants a victim at the exact location a raw `../../x` id
 * would resolve to via `rmSync(join(claudeStagingRoot(), id))` (which lands at
 * <dataRoot>/x) and asserts it survives — proof no delete ran.
 */
describe("uninstall rejects an invalid connector id at the CLI boundary", () => {
  function silenceCli(): { restore: () => void; err: () => string } {
    let errText = "";
    const outSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        errText += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      });
    return {
      restore: () => {
        outSpy.mockRestore();
        errSpy.mockRestore();
      },
      err: () => errText,
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // "../../x" and "/abs" are non-empty malformed ids that pass the
  // "could-not-determine" guard and reach assertConnectorId. The empty id is
  // rejected one step earlier (the explicit-id trim guard) — still exit 2, still
  // before any delete, but with the "could not determine" message — so it asserts
  // that distinct (and equally safe) rejection text.
  const REJECTED: ReadonlyArray<readonly [string, RegExp]> = [
    ["../../x", /connector id must be kebab-case/],
    ["/abs", /connector id must be kebab-case/],
    ["", /could not determine connector id/],
  ];

  for (const [badId, message] of REJECTED) {
    it(`rejects ${JSON.stringify(badId)} on the DEFAULT path before any delete (exit 2)`, async () => {
      const cap = silenceCli();
      const code = await main([
        "uninstall",
        "--connector-id",
        badId,
        "--project",
        projectDir,
      ]);
      cap.restore();
      expect(code).toBe(2);
      // The branded fail() carries the helpful rejection message.
      expect(cap.err()).toMatch(message);
    });

    it(`rejects ${JSON.stringify(badId)} on the --targets MARKETPLACE path before any delete (exit 2)`, async () => {
      const cap = silenceCli();
      const code = await main([
        "uninstall",
        "--method",
        "marketplace",
        "--targets",
        "claude-code",
        "--connector-id",
        badId,
        "--project",
        projectDir,
      ]);
      cap.restore();
      expect(code).toBe(2);
      expect(cap.err()).toMatch(message);
    });
  }

  it("the traversal id never reaches rmSync(join(stagingRoot, id)) on the --targets path", async () => {
    // `rmSync(join(claudeStagingRoot(), "../../x"))` resolves to <dataRoot>/x.
    const victimDir = join(tmpData, "x");
    mkdirSync(victimDir, { recursive: true });
    writeFileSync(join(victimDir, "keep.txt"), "keep\n", "utf8");
    // Make the staging root exist so finishUninstall's existsSync gate is live.
    mkdirSync(claudeStagingRoot(), { recursive: true });

    const cap = silenceCli();
    const code = await main([
      "uninstall",
      "--method",
      "marketplace",
      "--targets",
      "claude-code",
      "--connector-id",
      "../../x",
      "--project",
      projectDir,
    ]);
    cap.restore();

    expect(code).toBe(2);
    // The victim outside the connector-record root is untouched: validation
    // fired before any path construction or delete.
    expect(existsSync(join(victimDir, "keep.txt"))).toBe(true);
  });
});
