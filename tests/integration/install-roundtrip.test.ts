/**
 * integration/install-roundtrip — end-to-end install → assert → uninstall.
 *
 * Drives the real {@link installConnector} / {@link uninstallConnector}
 * orchestration against the three Phase-1 adapters (claude-code, codex, cursor),
 * writing into a throwaway HOME so the real user home and the repo tree are never
 * touched. After install we assert each platform's native config file exists and
 * carries the connector id; after uninstall we assert those entries are gone.
 *
 * Isolation contract (mirrors tests/core/paths.test.ts):
 *   • HOME / USERPROFILE → a fresh os.tmpdir mkdtemp dir (adapters resolve native
 *     config paths off homedir()).
 *   • AGENTCONNECT_DATA_DIR → a separate fresh temp dir (framework state:
 *     home-bin, connector registry).
 *   • AGENTCONNECT_TELEMETRY is cleared so default wrapping behavior is used.
 *   • Every env var is restored verbatim in afterEach; both temp trees removed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { defineConnector } from "../../src/core/define-connector.js";
import {
  installConnector,
  uninstallConnector,
} from "../../src/core/installer.js";
import type { ResolvedConnector } from "../../src/core/types.js";

// Absolute path to the BUILT public entry so the fixture .mjs can import
// defineConnector at runtime (the SRC index.ts is not importable from a plain
// .mjs). The dist build is a committed prerequisite for these tests.
const DIST_INDEX = join(__dirname, "..", "..", "dist", "index.js");

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENTCONNECT_DATA_DIR,
  TELEMETRY: process.env.AGENTCONNECT_TELEMETRY,
};

const CONNECTOR_ID = "acme-db";

let tmpHome: string;
let tmpData: string;
let projectDir: string;
let fixtureModulePath: string;

/** Build the in-test live connector (server + hooks → all native files written). */
function makeConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@acme/db-mcp"],
    },
    hooks: {
      PreToolUse: {
        matcher: "acme_query|acme_write",
        handler(evt) {
          return evt.toolName === "acme_write"
            ? { decision: "ask", reason: "confirm write" }
            : { decision: "allow" };
        },
      },
      SessionStart: {
        handler() {
          return { decision: "context", additionalContext: "acme online" };
        },
      },
    },
  });
}

/**
 * Write a tiny fixture connector module. registerConnector (invoked inside
 * installConnector) persists this path so the runtime can re-import live
 * handlers; it imports defineConnector from the BUILT dist entry via an absolute
 * file URL so the .mjs resolves at runtime.
 */
function writeFixtureModule(dir: string): string {
  const modPath = join(dir, "acme-db.config.mjs");
  const distUrl = pathToFileURL(DIST_INDEX).href;
  const source = `
import { defineConnector } from ${JSON.stringify(distUrl)};

export default defineConnector({
  id: ${JSON.stringify(CONNECTOR_ID)},
  displayName: "Acme DB Tools",
  version: "1.2.3",
  server: { transport: "stdio", command: "npx", args: ["-y", "@acme/db-mcp"] },
  hooks: {
    PreToolUse: {
      matcher: "acme_query|acme_write",
      handler(evt) {
        return evt.toolName === "acme_write"
          ? { decision: "ask", reason: "confirm write" }
          : { decision: "allow" };
      },
    },
    SessionStart: {
      handler() {
        return { decision: "context", additionalContext: "acme online" };
      },
    },
  },
});
`;
  writeFileSync(modPath, source, "utf8");
  return modPath;
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-it-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-it-data-"));
  projectDir = mkdtempSync(join(tmpdir(), "ac-it-proj-"));

  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENTCONNECT_DATA_DIR = tmpData;
  delete process.env.AGENTCONNECT_TELEMETRY;

  fixtureModulePath = writeFixtureModule(tmpData);
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

/** The three native config files each adapter writes at user scope. */
function nativePaths() {
  return {
    claudeServers: join(tmpHome, ".claude.json"),
    claudeHooks: join(tmpHome, ".claude", "settings.json"),
    codexConfig: join(tmpHome, ".codex", "config.toml"),
    codexHooks: join(tmpHome, ".codex", "hooks.json"),
    cursorMcp: join(tmpHome, ".cursor", "mcp.json"),
    cursorHooks: join(tmpHome, ".cursor", "hooks.json"),
  };
}

describe("install → uninstall roundtrip across claude-code, codex, cursor", () => {
  it("install writes all three platforms' native files containing the connector id", async () => {
    const connector = makeConnector();

    const result = await installConnector({
      connector,
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["claude-code", "codex", "cursor"],
      dryRun: false,
    });

    expect(result.connectorId).toBe(CONNECTOR_ID);
    expect(result.dryRun).toBe(false);
    // No adapter should have warned (all three are registered + drivable).
    expect(result.warnings).toEqual([]);

    const p = nativePaths();

    // ── Claude Code ──────────────────────────────────────────────────────
    expect(existsSync(p.claudeServers)).toBe(true);
    const claudeServers = JSON.parse(readFileSync(p.claudeServers, "utf8"));
    expect(claudeServers.mcpServers).toHaveProperty(CONNECTOR_ID);
    expect(existsSync(p.claudeHooks)).toBe(true);
    const claudeHooksRaw = readFileSync(p.claudeHooks, "utf8");
    expect(claudeHooksRaw).toContain(`--connector ${CONNECTOR_ID}`);

    // ── Codex ────────────────────────────────────────────────────────────
    expect(existsSync(p.codexConfig)).toBe(true);
    const codexConfig = readFileSync(p.codexConfig, "utf8");
    // TOML table header for the connector's MCP server.
    expect(codexConfig).toContain(`[mcp_servers.${CONNECTOR_ID}]`);
    expect(existsSync(p.codexHooks)).toBe(true);
    expect(readFileSync(p.codexHooks, "utf8")).toContain(
      `--connector ${CONNECTOR_ID}`,
    );

    // ── Cursor ───────────────────────────────────────────────────────────
    expect(existsSync(p.cursorMcp)).toBe(true);
    const cursorMcp = JSON.parse(readFileSync(p.cursorMcp, "utf8"));
    expect(cursorMcp.mcpServers).toHaveProperty(CONNECTOR_ID);
    expect(existsSync(p.cursorHooks)).toBe(true);
    expect(readFileSync(p.cursorHooks, "utf8")).toContain(
      `--connector ${CONNECTOR_ID}`,
    );
  });

  it("registers the connector record under the data-root on install", async () => {
    const connector = makeConnector();
    await installConnector({
      connector,
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["claude-code", "codex", "cursor"],
      dryRun: false,
    });

    const recordPath = join(
      tmpData,
      "connectors",
      CONNECTOR_ID,
      "connector.json",
    );
    expect(existsSync(recordPath)).toBe(true);
    const meta = JSON.parse(readFileSync(recordPath, "utf8"));
    expect(meta.id).toBe(CONNECTOR_ID);
    expect(meta.modulePath).toBe(fixtureModulePath);
    // SessionStart + PreToolUse handlers were declared → recorded as hookEvents.
    expect(meta.hookEvents).toEqual(
      expect.arrayContaining(["SessionStart", "PreToolUse"]),
    );
  });

  it("uninstall removes every connector entry from the native files", async () => {
    const connector = makeConnector();
    await installConnector({
      connector,
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["claude-code", "codex", "cursor"],
      dryRun: false,
    });

    const uninstall = await uninstallConnector({
      connectorId: CONNECTOR_ID,
      scope: "user",
      projectDir,
      targets: ["claude-code", "codex", "cursor"],
      dryRun: false,
    });
    expect(uninstall.connectorId).toBe(CONNECTOR_ID);

    const p = nativePaths();

    // Server entries gone from the JSON roots.
    const claudeServers = JSON.parse(readFileSync(p.claudeServers, "utf8"));
    expect(claudeServers.mcpServers ?? {}).not.toHaveProperty(CONNECTOR_ID);

    const cursorMcp = JSON.parse(readFileSync(p.cursorMcp, "utf8"));
    expect(cursorMcp.mcpServers ?? {}).not.toHaveProperty(CONNECTOR_ID);

    // Codex TOML table header for this connector is gone.
    expect(readFileSync(p.codexConfig, "utf8")).not.toContain(
      `[mcp_servers.${CONNECTOR_ID}]`,
    );

    // Hook commands for this connector are gone from every hook file.
    for (const hookFile of [p.claudeHooks, p.codexHooks, p.cursorHooks]) {
      if (existsSync(hookFile)) {
        expect(readFileSync(hookFile, "utf8")).not.toContain(
          `--connector ${CONNECTOR_ID}`,
        );
      }
    }
  });

  it("is idempotent: a second install reports skips and keeps a single entry", async () => {
    const connector = makeConnector();
    const opts = {
      connector,
      modulePath: fixtureModulePath,
      scope: "user" as const,
      projectDir,
      targets: ["claude-code", "codex", "cursor"] as const,
      dryRun: false,
    };

    await installConnector({ ...opts, targets: [...opts.targets] });
    const second = await installConnector({ ...opts, targets: [...opts.targets] });

    // The second pass must not create duplicate native registrations.
    expect(second.warnings).toEqual([]);
    expect(second.changes.some((c) => c.action === "skip")).toBe(true);

    const p = nativePaths();
    const claudeServers = JSON.parse(readFileSync(p.claudeServers, "utf8"));
    expect(Object.keys(claudeServers.mcpServers)).toEqual([CONNECTOR_ID]);
  });

  it("dryRun does not write any native file or registry record", async () => {
    const connector = makeConnector();
    const result = await installConnector({
      connector,
      modulePath: fixtureModulePath,
      scope: "user",
      projectDir,
      targets: ["claude-code", "codex", "cursor"],
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    const p = nativePaths();
    for (const f of Object.values(p)) {
      expect(existsSync(f)).toBe(false);
    }
    // dryRun skips registerConnector → no record on disk.
    const recordPath = join(
      tmpData,
      "connectors",
      CONNECTOR_ID,
      "connector.json",
    );
    expect(existsSync(recordPath)).toBe(false);
  });
});
