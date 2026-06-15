/**
 * adapters/mimo-code — focused tests for the Xiaomi MiMoCode adapter.
 *
 * MiMoCode is a STANDALONE adapter mirroring OpenCode's render logic with the
 * mimocode paths (a clean fork that routes detection, the runtime bridge, and
 * per-platform overrides to its OWN id rather than "opencode"). These tests prove:
 *   1. Detection keys on the mimocode config dir (project .mimocode/mimocode.json,
 *      user ~/.config/mimocode) — distinct from opencode, so no collision.
 *   2. installServer writes the MCP server under ROOT KEY "mcp" (the OpenCode
 *      shape, NOT "mcpServers") in mimocode.json, as { type:"local", command:[…] }.
 *   3. installHooks synthesizes a self-contained ts-plugin bridge that shells out
 *      to `<homeBin> hook mimo-code <event>` (NOT `hook opencode`) — the standalone
 *      payoff. The bridge is exercised LIVE with node:child_process mocked.
 *   4. uninstall reverses both surfaces.
 *
 * Filesystem isolation: every test gets a fresh mkdtemp project dir with HOME +
 * AGENT_CONNECTOR_DATA_DIR redirected there, restored in afterEach. Project scope
 * throughout for deterministic paths.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { HookResponse, ResolvedConnector } from "../../src/core/types.js";

import mimoAdapter from "../../src/adapters/mimo-code/index.js";

// ── node:child_process mock (hoisted above imports) ───────────────────────
let execFileSyncImpl: (...args: any[]) => string = () => "";
const execFileSyncMock = vi.fn((...args: any[]) => execFileSyncImpl(...args));
vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  execSync: execFileSyncMock,
}));

// Pin POSIX so the generated bridge takes its execFileSync(HOME_BIN, [argv]) path.
const REAL_PLATFORM = process.platform;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
});

const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";

function buildConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@x/y"],
      env: { [ENV_VAR]: `\${env:${ENV_VAR}}` },
      tools: { include: ["*"] },
    },
    hooks: {
      PreToolUse: {
        matcher: "acme_query|acme_write",
        handler() {
          return { decision: "allow" };
        },
      },
      SessionStart: {
        handler() {
          return { decision: "allow" };
        },
      },
    },
  });
}

function buildCtx(projectDir: string, connector: ResolvedConnector): InstallContext {
  return {
    connector,
    scope: "project",
    projectDir,
    homeBinPath: HOME_BIN,
    dataRoot: projectDir,
    dryRun: false,
  };
}

let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let savedDataDir: string | undefined;
let savedEnvVar: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
  savedEnvVar = process.env[ENV_VAR];
  execFileSyncMock.mockClear();
  execFileSyncImpl = () => "";
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("USERPROFILE", savedUserProfile);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
  restore(ENV_VAR, savedEnvVar);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function freshProject(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  process.env[ENV_VAR] = ENV_LITERAL;
  return dir;
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("mimo-code adapter — identity + detection (distinct from opencode)", () => {
  it("has the mimo-code identity and the ts-plugin paradigm", () => {
    expect(mimoAdapter.id).toBe("mimo-code");
    expect(mimoAdapter.name).toBe("MiMoCode");
    expect(mimoAdapter.paradigm).toBe("ts-plugin");
  });

  it("detects only when the mimocode config (.mimocode/mimocode.json) is present", () => {
    const projectDir = freshProject("ac-mimo-detect-");
    expect(mimoAdapter.detectInstalled(projectDir).installed).toBe(false);

    // A project-scope mimocode.json at the project root → installed.
    const ctx = buildCtx(projectDir, buildConnector());
    mimoAdapter.installServer(ctx);
    const det = mimoAdapter.detectInstalled(projectDir);
    expect(det.installed).toBe(true);
    expect(det.id).toBe("mimo-code");
    expect(det.reason).toMatch(/MiMoCode/);
  });
});

describe("mimo-code adapter — MCP install (root key 'mcp', mimocode.json)", () => {
  let projectDir: string;
  let ctx: InstallContext;
  let serverPath: string;

  beforeEach(() => {
    projectDir = freshProject("ac-mimo-mcp-");
    ctx = buildCtx(projectDir, buildConnector());
    serverPath = join(projectDir, "mimocode.json");
    expect(serverPath).toBe(mimoAdapter.getServerConfigPath(ctx));
  });

  it("installServer writes ROOT KEY 'mcp' with a { type:'local', command:[…] } entry", () => {
    const changes = mimoAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.platform).toBe("mimo-code");
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    // OpenCode shape: root key "mcp" (NOT "mcpServers").
    expect(cfg).toHaveProperty("mcp");
    expect(cfg).not.toHaveProperty("mcpServers");

    const entry = cfg.mcp[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.type).toBe("local");
    // command is an ARRAY whose head is the telemetry-wrapped home bin.
    expect(Array.isArray(entry.command)).toBe(true);
    expect(entry.command[0]).toBe(HOME_BIN);
    expect(entry.command).toContain("serve");
    expect(entry.command).toContain("--connector");
    expect(entry.command).toContain(CONNECTOR_ID);
    // The serve-wrapper bakes the install target as `--host mimo-code`.
    expect(entry.command).toContain("--host");
    expect(entry.command).toContain("mimo-code");
    // env key is "environment"; no native token → resolved to a literal.
    expect(entry.environment[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.environment[ENV_VAR]).not.toContain("${");
  });

  it("installServer is idempotent — second call yields skip, no duplicate", () => {
    mimoAdapter.installServer(ctx);
    const second = mimoAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");
    const cfg = readJson(serverPath);
    expect(Object.keys(cfg.mcp)).toEqual([CONNECTOR_ID]);
  });

  it("uninstallServer removes the mcp.<id> entry", () => {
    mimoAdapter.installServer(ctx);
    mimoAdapter.uninstallServer(ctx);
    const cfg = readJson(serverPath);
    expect(cfg.mcp?.[CONNECTOR_ID]).toBeUndefined();
  });
});

describe("mimo-code adapter — ts-plugin hooks dispatch to `hook mimo-code` (standalone payoff)", () => {
  let projectDir: string;
  let ctx: InstallContext;
  let pluginPath: string;

  beforeEach(() => {
    projectDir = freshProject("ac-mimo-hooks-");
    ctx = buildCtx(projectDir, buildConnector());
    pluginPath = mimoAdapter.getHookConfigPath(ctx);
  });

  it("installHooks writes the plugin module into the .mimocode/plugin dir", () => {
    const changes = mimoAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);
    expect(changes[0]?.platform).toBe("mimo-code");

    const expected = join(projectDir, ".mimocode", "plugin", `${CONNECTOR_ID}.js`);
    expect(pluginPath).toBe(expected);
    expect(existsSync(pluginPath)).toBe(true);

    const src = readFileSync(pluginPath, "utf8");
    // Self-contained: imports nothing from agent-connector.
    expect(src).not.toMatch(/from\s+["'][^"']*agent-connector/);
    expect(src).not.toMatch(/require\(\s*["'][^"']*agent-connector/);
    expect(src).toContain('import { execFileSync, execSync } from "node:child_process"');
    // CRITICAL standalone assertion: dispatches to mimo-code, NOT opencode.
    expect(src).toContain('"mimo-code"');
    expect(src).not.toContain('"hook", "opencode"');
    expect(src).toContain(HOME_BIN);
    expect(src).toContain(CONNECTOR_ID);
    // OpenCode-shaped event keys.
    expect(src).toContain("tool.execute.before");
  });

  it("installHooks is idempotent — second call yields skip", () => {
    mimoAdapter.installHooks(ctx);
    const second = mimoAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallHooks removes the plugin module", () => {
    mimoAdapter.installHooks(ctx);
    expect(existsSync(pluginPath)).toBe(true);
    mimoAdapter.uninstallHooks(ctx);
    expect(existsSync(pluginPath)).toBe(false);
  });

  it("THE BRIDGE WORKS — a 'deny' throws in tool.execute.before, shelling out with `hook mimo-code`", async () => {
    mimoAdapter.installHooks(ctx);
    execFileSyncImpl = () => JSON.stringify({ decision: "deny", reason: "nope" });

    const url = `${pathToFileURL(pluginPath).href}?t=${Date.now()}-${Math.random()}`;
    const mod = await import(/* @vite-ignore */ url);
    const factory = mod.default;
    expect(typeof factory).toBe("function");

    const hooks = await factory({ directory: projectDir });
    const before = hooks["tool.execute.before"];
    expect(typeof before).toBe("function");

    await expect(
      before({ tool: "acme_write", sessionID: "s1" }, { args: { sql: "DELETE" } }),
    ).rejects.toThrow("nope");

    // The bridge shelled out to the universal entrypoint with the mimo-code id.
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [bin, argv] = execFileSyncMock.mock.calls[0]!;
    expect(bin).toBe(HOME_BIN);
    expect(argv).toEqual(["hook", "mimo-code", "PreToolUse", "--connector", CONNECTOR_ID]);
  });
});

describe("mimo-code adapter runtime dispatch — parseEvent + formatReply round-trip", () => {
  it("formatReply returns exit 0 + stdout that JSON-parses to the normalized response", () => {
    const deny: HookResponse = { decision: "deny", reason: "x" };
    const reply = mimoAdapter.formatReply!("PreToolUse", deny);
    expect(reply.exitCode).toBe(0);
    expect(JSON.parse(reply.stdout!)).toEqual({ decision: "deny", reason: "x" });
  });

  it("parseEvent stamps hostPlatform=mimo-code (NOT opencode)", () => {
    const evt = mimoAdapter.parseEvent!("PreToolUse", {
      toolName: "acme_write",
      toolInput: { sql: "DELETE" },
      sessionId: "mc-1",
      projectDir: "/some/proj",
    });
    expect(evt).toMatchObject({
      hostPlatform: "mimo-code",
      toolName: "acme_write",
      toolInput: { sql: "DELETE" },
      sessionId: "mc-1",
      projectDir: "/some/proj",
    });
  });
});
