/**
 * tests/adapters/kilo.test.ts
 *
 * Verifies the Kilo Code (VS Code extension) adapter after the 7.x rebuild:
 *
 *   MCP install/uninstall
 *     • installServer  → <projectDir>/.kilo/kilo.json, root key "mcp", stdio
 *       entry { type:"local", command:[...], environment:{} }.
 *     • idempotency + uninstall.
 *
 *   Hooks (ts-plugin — NEW in 7.x)
 *     • installHooks   → .kilo/plugin/<id>.js (plugin module) + kilo.json
 *       plugin[] registration.
 *     • The generated module targets "kilo" (not "kilo-cli") in the bridge argv.
 *     • idempotency + uninstall (removes module, deregisters from plugin[],
 *       cleans empty plugin dir).
 *     • THE BRIDGE WORKS — dynamic import of the generated module, fake
 *       @kilocode/plugin server() call, PreToolUse deny/allow/error round-trips.
 *
 *   Skills (ts-plugin — NEW in 7.x)
 *     • installSkills  → .kilo/skills/<name>/SKILL.md.
 *     • resources bundled beside SKILL.md.
 *     • idempotency + uninstall (removes SKILL.md + dir).
 *
 *   parseEvent + formatReply round-trip
 *     • PreToolUse deny reconstructed from bridge payload.
 *
 * Filesystem isolation: every test uses a fresh mkdtemp dir with HOME and
 * AGENT_CONNECTOR_DATA_DIR redirected there so nothing escapes the sandbox.
 * PROJECT scope throughout for deterministic paths.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { HookResponse, ResolvedConnector } from "../../src/core/types.js";

import kiloAdapter from "../../src/adapters/kilo/index.js";

// ─────────────────────────────────────────────────────────────────────────
// node:child_process mock — hoisted above every import by vitest.
// ─────────────────────────────────────────────────────────────────────────

let execFileSyncImpl: (...args: any[]) => string = () => "";
const execFileSyncMock = vi.fn((...args: any[]) => execFileSyncImpl(...args));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  execSync: execFileSyncMock,
}));

// Pin process.platform to POSIX so the generated bridge takes the execFileSync
// path (not the Windows execSync path).
const REAL_PLATFORM = process.platform;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
});

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

const HOME_BIN = "/fake/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-kilo";
const ENV_VAR = "ACME_KILO_KEY";
const ENV_LITERAL = "secret-key-123";

/** A connector with a stdio server + hooks + skills. */
function buildConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Kilo Tools",
    version: "1.0.0",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@acme/kilo-mcp"],
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
    skills: [
      {
        name: "acme-helper",
        description: "Acme helper skill",
        body: "Use this skill to help with Acme tasks.",
      },
    ],
  });
}

/** A connector with only hooks (no server), for hook-isolated tests. */
function buildHooksOnlyConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Kilo Hooks",
    version: "1.0.0",
    hooks: {
      PreToolUse: {
        matcher: ".*",
        handler() {
          return { decision: "allow" };
        },
      },
      PostToolUse: {
        handler() {
          return { decision: "allow" };
        },
      },
    },
  });
}

/** A connector with only skills (no server, no hooks). */
function buildSkillsOnlyConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Kilo Skills",
    version: "1.0.0",
    skills: [
      {
        name: "query-helper",
        description: "Query helper skill",
        body: "Helps run queries.",
        resources: { "examples.md": "# Examples\nSELECT 1;" },
      },
    ],
  });
}

/** InstallContext scoped to a fresh temp project dir. */
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

// Track + restore mutated env.
let savedHome: string | undefined;
let savedDataDir: string | undefined;
let savedEnvVar: string | undefined;
let savedXdgConfigHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
  savedEnvVar = process.env[ENV_VAR];
  savedXdgConfigHome = process.env.XDG_CONFIG_HOME;
  execFileSyncMock.mockClear();
  execFileSyncImpl = () => "";
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("USERPROFILE", savedHome);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
  restore(ENV_VAR, savedEnvVar);
  restore("XDG_CONFIG_HOME", savedXdgConfigHome);
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
  delete process.env.XDG_CONFIG_HOME;
  return dir;
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ─────────────────────────────────────────────────────────────────────────
// MCP server install / uninstall
// ─────────────────────────────────────────────────────────────────────────

describe("kilo adapter — MCP server install/uninstall", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-kilo-mcp-");
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("installServer writes .kilo/kilo.json with root key 'mcp' and a stdio entry", () => {
    const changes = kiloAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".kilo", "kilo.json");
    expect(serverPath).toBe(kiloAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcp");
    expect(cfg).not.toHaveProperty("mcpServers");

    const entry = cfg.mcp[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.type).toBe("local");
    expect(Array.isArray(entry.command)).toBe(true);
    // env var resolves to the literal value (no ${env:...} interpolation left)
    expect(entry.environment[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.environment[ENV_VAR]).not.toContain("${");
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    kiloAdapter.installServer(ctx);
    const second = kiloAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".kilo", "kilo.json"));
    expect(Object.keys(cfg.mcp)).toEqual([CONNECTOR_ID]);
  });

  it("uninstallServer removes the entry", () => {
    kiloAdapter.installServer(ctx);
    kiloAdapter.uninstallServer(ctx);

    const cfg = readJson(join(projectDir, ".kilo", "kilo.json"));
    expect(cfg.mcp?.[CONNECTOR_ID]).toBeUndefined();
  });

  it("paradigm is ts-plugin (not mcp-only)", () => {
    expect(kiloAdapter.paradigm).toBe("ts-plugin");
  });

  it("supportsSkills is true", () => {
    expect(kiloAdapter.capabilities.supportsSkills).toBe(true);
  });

  it("hook capabilities are true", () => {
    expect(kiloAdapter.capabilities.preToolUse).toBe(true);
    expect(kiloAdapter.capabilities.postToolUse).toBe(true);
    expect(kiloAdapter.capabilities.sessionStart).toBe(true);
    expect(kiloAdapter.capabilities.canModifyArgs).toBe(true);
    expect(kiloAdapter.capabilities.canModifyOutput).toBe(true);
    expect(kiloAdapter.capabilities.canInjectSessionContext).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Hooks (ts-plugin) — install / uninstall
// ─────────────────────────────────────────────────────────────────────────

describe("kilo adapter — hooks (ts-plugin) install/uninstall", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-kilo-hooks-");
    ctx = buildCtx(projectDir, buildHooksOnlyConnector());
  });

  it("installHooks writes .kilo/plugin/<id>.js and registers in kilo.json plugin[]", () => {
    const changes = kiloAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const pluginPath = join(projectDir, ".kilo", "plugin", `${CONNECTOR_ID}.js`);
    expect(pluginPath).toBe(kiloAdapter.getHookConfigPath(ctx));
    expect(existsSync(pluginPath)).toBe(true);

    // The plugin array must be registered in kilo.json.
    const configPath = join(projectDir, ".kilo", "kilo.json");
    expect(existsSync(configPath)).toBe(true);
    const cfg = readJson(configPath);
    expect(Array.isArray(cfg.plugin)).toBe(true);
    expect(cfg.plugin).toContain(pluginPath);
  });

  it("generated plugin module bridges to 'kilo' (not 'kilo-cli')", () => {
    kiloAdapter.installHooks(ctx);
    const pluginPath = kiloAdapter.getHookConfigPath(ctx);
    const src = readFileSync(pluginPath, "utf8");

    // Must reference "kilo" as the platform id in the bridge argv.
    expect(src).toContain('"hook", "kilo",');
    // Must NOT reference "kilo-cli".
    expect(src).not.toContain('"kilo-cli"');
  });

  it("generated plugin module imports nothing from agent-connector", () => {
    kiloAdapter.installHooks(ctx);
    const src = readFileSync(kiloAdapter.getHookConfigPath(ctx), "utf8");
    expect(src).not.toMatch(/from\s+["'][^"']*agent-connector/);
    expect(src).not.toMatch(/require\(\s*["'][^"']*agent-connector/);
    expect(src).toContain('import { execFileSync, execSync } from "node:child_process"');
  });

  it("generated plugin module contains the connector id and home bin", () => {
    kiloAdapter.installHooks(ctx);
    const src = readFileSync(kiloAdapter.getHookConfigPath(ctx), "utf8");
    expect(src).toContain(CONNECTOR_ID);
    expect(src).toContain(HOME_BIN);
  });

  it("generated plugin module uses @kilocode/plugin PluginModule shape (default export plugin)", () => {
    kiloAdapter.installHooks(ctx);
    const src = readFileSync(kiloAdapter.getHookConfigPath(ctx), "utf8");
    expect(src).toContain("export default plugin");
    expect(src).toContain("server: async (input)");
  });

  it("installHooks is idempotent — second call yields all skips", () => {
    kiloAdapter.installHooks(ctx);
    const second = kiloAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallHooks deregisters from plugin[], removes the module file, cleans the empty plugin dir", () => {
    kiloAdapter.installHooks(ctx);
    const pluginPath = kiloAdapter.getHookConfigPath(ctx);
    const pluginDir = dirname(pluginPath);

    expect(existsSync(pluginPath)).toBe(true);

    kiloAdapter.uninstallHooks(ctx);

    expect(existsSync(pluginPath)).toBe(false);
    expect(existsSync(pluginDir)).toBe(false);

    // The plugin[] in kilo.json should no longer include the path.
    const configPath = join(projectDir, ".kilo", "kilo.json");
    if (existsSync(configPath)) {
      const cfg = readJson(configPath);
      const plugins: unknown[] = Array.isArray(cfg.plugin) ? cfg.plugin : [];
      expect(plugins).not.toContain(pluginPath);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// THE BRIDGE WORKS (live, child_process mocked)
// ─────────────────────────────────────────────────────────────────────────

describe("kilo generated plugin — THE BRIDGE WORKS (live, child_process mocked)", () => {
  let projectDir: string;
  let ctx: InstallContext;
  let pluginPath: string;

  beforeEach(() => {
    projectDir = freshProject("ac-kilo-bridge-");
    ctx = buildCtx(projectDir, buildHooksOnlyConnector());
    kiloAdapter.installHooks(ctx);
    pluginPath = kiloAdapter.getHookConfigPath(ctx);
    expect(existsSync(pluginPath)).toBe(true);
  });

  async function loadPlugin(): Promise<any> {
    const url = `${pathToFileURL(pluginPath).href}?t=${Date.now()}-${Math.random()}`;
    return import(/* @vite-ignore */ url);
  }

  it("default export is the @kilocode/plugin PluginModule shape { id, server }", async () => {
    const mod = await loadPlugin();
    expect(mod.default).toBeTruthy();
    expect(mod.default.id).toBe(CONNECTOR_ID);
    expect(typeof mod.default.server).toBe("function");
  });

  it("server() returns an object keyed by hook event names", async () => {
    const mod = await loadPlugin();
    const hooks = await mod.default.server({});
    expect(typeof hooks["tool.execute.before"]).toBe("function");
    expect(typeof hooks["tool.execute.after"]).toBe("function");
  });

  it("a 'deny' decision from the bridge throws (blocks the tool call)", async () => {
    execFileSyncImpl = () => JSON.stringify({ decision: "deny", reason: "nope" });

    const mod = await loadPlugin();
    const hooks = await mod.default.server({ directory: projectDir });

    const before = hooks["tool.execute.before"];
    await expect(
      before(
        { tool: "acme_write", sessionID: "s1" },
        { args: { sql: "DELETE FROM users" } },
      ),
    ).rejects.toThrow();

    // The bridge shelled out to the universal entrypoint with "kilo" as host.
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [bin, argv] = execFileSyncMock.mock.calls[0]!;
    expect(bin).toBe(HOME_BIN);
    expect(argv).toEqual(["hook", "kilo", "PreToolUse", "--connector", CONNECTOR_ID]);
  });

  it("an 'allow' decision does not throw", async () => {
    execFileSyncImpl = () => JSON.stringify({ decision: "allow" });

    const mod = await loadPlugin();
    const hooks = await mod.default.server({ directory: projectDir });

    await expect(
      hooks["tool.execute.before"](
        { tool: "acme_query", sessionID: "s2" },
        { args: { sql: "SELECT 1" } },
      ),
    ).resolves.toBeUndefined();
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it("a bridge error fails OPEN — tool.execute.before does not throw", async () => {
    execFileSyncImpl = () => {
      throw new Error("bin missing");
    };

    const mod = await loadPlugin();
    const hooks = await mod.default.server({ directory: projectDir });

    await expect(
      hooks["tool.execute.before"](
        { tool: "acme_query", sessionID: "s3" },
        { args: {} },
      ),
    ).resolves.toBeUndefined();
  });

  it("PostToolUse handler calls bridge with PostToolUse event", async () => {
    execFileSyncImpl = () => "";

    const mod = await loadPlugin();
    const hooks = await mod.default.server({ directory: projectDir });

    await hooks["tool.execute.after"](
      { tool: "acme_query", args: { sql: "SELECT 1" }, sessionID: "s4" },
      { output: "row1" },
    );

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [, argv] = execFileSyncMock.mock.calls[0]!;
    expect(argv).toContain("PostToolUse");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Skills install / uninstall
// ─────────────────────────────────────────────────────────────────────────

describe("kilo adapter — skills install/uninstall", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-kilo-skills-");
    ctx = buildCtx(projectDir, buildSkillsOnlyConnector());
  });

  it("installSkills writes .kilo/skills/<name>/SKILL.md", () => {
    const changes = kiloAdapter.installSkills(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const skillMd = join(projectDir, ".kilo", "skills", "query-helper", "SKILL.md");
    expect(existsSync(skillMd)).toBe(true);

    const content = readFileSync(skillMd, "utf8");
    expect(content).toContain("query-helper");
    expect(content).toContain("Query helper skill");
    expect(content).toContain("Helps run queries.");
  });

  it("installSkills writes resource files beside SKILL.md", () => {
    kiloAdapter.installSkills(ctx);

    const examplesPath = join(projectDir, ".kilo", "skills", "query-helper", "examples.md");
    expect(existsSync(examplesPath)).toBe(true);
    const content = readFileSync(examplesPath, "utf8");
    expect(content).toContain("SELECT 1");
  });

  it("installSkills is idempotent — second call yields skip", () => {
    kiloAdapter.installSkills(ctx);
    const second = kiloAdapter.installSkills(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource files, and the skill dir", () => {
    kiloAdapter.installSkills(ctx);
    const skillDir = join(projectDir, ".kilo", "skills", "query-helper");
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);

    kiloAdapter.uninstallSkills(ctx);

    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(false);
    expect(existsSync(skillDir)).toBe(false);
  });

  it("skill path is under .kilo/skills (not .kilocode/skills)", () => {
    kiloAdapter.installSkills(ctx);
    const skillMd = join(projectDir, ".kilo", "skills", "query-helper", "SKILL.md");
    expect(existsSync(skillMd)).toBe(true);
    // Must NOT be under the legacy .kilocode tree.
    const legacyPath = join(projectDir, ".kilocode", "skills", "query-helper", "SKILL.md");
    expect(existsSync(legacyPath)).toBe(false);
  });

  it("getHealthChecks includes a skill check that passes after install", () => {
    kiloAdapter.installSkills(ctx);
    const checks = kiloAdapter.getHealthChecks!(ctx);
    const skillCheck = checks.find((c) => c.name.includes("skill query-helper"))!;
    expect(skillCheck).toBeTruthy();
    expect(skillCheck.check().status).toBe("OK");
  });

  it("getHealthChecks skill check FAILS when skill file is absent", () => {
    // do NOT install; just run the health check on a fresh context.
    const checks = kiloAdapter.getHealthChecks!(ctx);
    const skillCheck = checks.find((c) => c.name.includes("skill query-helper"))!;
    expect(skillCheck).toBeTruthy();
    expect(skillCheck.check().status).toBe("FAIL");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// parseEvent + formatReply round-trip
// ─────────────────────────────────────────────────────────────────────────

describe("kilo adapter runtime dispatch — parseEvent + formatReply round-trip", () => {
  it("formatReply returns exit 0 and stdout that JSON-parses to the normalized response", () => {
    const deny: HookResponse = { decision: "deny", reason: "blocked" };
    const reply = kiloAdapter.formatReply!("PreToolUse", deny);

    expect(reply.exitCode).toBe(0);
    const out = JSON.parse(reply.stdout!);
    expect(out).toEqual({ decision: "deny", reason: "blocked" });
  });

  it("parseEvent maps a bridge payload to a normalized PreToolUse event", () => {
    const evt = kiloAdapter.parseEvent!("PreToolUse", {
      toolName: "acme_write",
      toolInput: { sql: "DELETE" },
      sessionId: "kilo-1",
      projectDir: "/some/proj",
    });

    expect(evt).toMatchObject({
      hostPlatform: "kilo",
      toolName: "acme_write",
      toolInput: { sql: "DELETE" },
      sessionId: "kilo-1",
      projectDir: "/some/proj",
    });
  });

  it("parseEvent maps a bridge payload to a normalized PostToolUse event", () => {
    const evt = kiloAdapter.parseEvent!("PostToolUse", {
      toolName: "acme_query",
      toolInput: {},
      toolOutput: "result-set",
      isError: false,
      sessionId: "kilo-2",
    });

    expect(evt).toMatchObject({
      hostPlatform: "kilo",
      toolName: "acme_query",
      toolOutput: "result-set",
      isError: false,
    });
  });

  it("parseEvent maps a SessionStart payload correctly", () => {
    const evt = kiloAdapter.parseEvent!("SessionStart", {
      sessionId: "kilo-3",
      projectDir: "/proj",
    });

    expect(evt).toMatchObject({
      hostPlatform: "kilo",
      sessionId: "kilo-3",
      source: "startup",
    });
  });
});
