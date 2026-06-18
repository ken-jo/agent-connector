/**
 * tests/adapters/kilo.test.ts — the ONE per-host file for Kilo Code (VS Code ext).
 *
 * Kilo Code (`kilocode.kilo-code`) was REBUILT on the Kilo CLI server in vsix 7.x
 * and shares ONE backend with the Kilo CLI (adapter id "kilo-cli"). Paradigm:
 * **ts-plugin** (a generated @kilocode/plugin bridge module that imports nothing
 * from agent-connector and shells out to the ONE stable home binary's universal
 * entrypoint over child_process, fail-open). This file consolidates EVERY kilo
 * surface (the per-host convention in tests/README.md — one file per host):
 *
 *   • MCP install/uninstall → <projectDir>/.kilo/kilo.json, root key "mcp", a
 *     stdio entry { type:"local", command:[...], environment:{} }; idempotency +
 *     uninstall. The phase3 render slice also locks the command-array dialect
 *     (HOME_BIN + serve-wrapper tail) and the NON-collision with kilo-cli (same
 *     dir + "mcp" key, DISTINCT filenames kilo.json vs kilo.jsonc).
 *   • hooks (ts-plugin) → .kilo/plugin/<id>.js plugin module + kilo.json plugin[]
 *     registration; the generated module bridges to "kilo" (not "kilo-cli");
 *     idempotency + uninstall (removes module, deregisters, cleans empty dir).
 *     THE BRIDGE WORKS — dynamic import of the generated module, PreToolUse /
 *     PostToolUse deny/allow/error round-trips.
 *   • new canonical events → UserPromptSubmit (chat.message), PermissionRequest
 *     (permission.ask), Stop (session.idle via the generic `event` hook); the
 *     generated handlers are exercised live.
 *   • skills (ts-plugin) → .kilo/skills/<name>/SKILL.md + bundled resources;
 *     idempotency + uninstall; health check.
 *   • content surfaces → md+fm commands (.kilo/commands/<n>.md), md+fm subagents
 *     (.kilo/agents/<n>.md, mode:subagent), uniform SKILL.md skills; idempotency +
 *     uninstall. (Migrated from the former surfaces-s2 suite.)
 *   • parseEvent + formatReply round-trip.
 *
 * Migrated to the shared harness (tests/support/env + adapter-suite): the
 * MCP/hooks/bridge/skills/new-event blocks were the base kilo file; the render +
 * non-collision block came from the former phase3 suite; the content-surface
 * block came from the former surfaces-s2 suite.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  ConnectorConfig,
  HookResponse,
  ResolvedConnector,
} from "../../src/core/types.js";

import kiloAdapter from "../../src/adapters/kilo/index.js";
import kiloCliAdapter from "../../src/adapters/kilo-cli/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { readJson, splitFrontmatter } from "../support/fs.js";
import { createAdapterSuite } from "../support/adapter-suite.js";

// ─────────────────────────────────────────────────────────────────────────
// node:child_process mock — hoisted above every import by vitest. The kilo
// generated-plugin bridge imports `execFileSync` (POSIX) / `execSync` (Windows)
// at top-level; the bridge + new-event slices dynamically import the freshly-
// written module and fire its handlers, so the mock must be in place before that
// module resolves node:child_process. Each test reprograms what the mock returns
// via execFileSyncImpl. (The render / content-surface slices only inspect the
// written bytes and never spawn — but they share this file's one mock.)
// ─────────────────────────────────────────────────────────────────────────

let execFileSyncImpl: (...args: any[]) => string = () => "";
const execFileSyncMock = vi.fn((...args: any[]) => execFileSyncImpl(...args));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  execSync: execFileSyncMock,
}));

// Pin process.platform to a POSIX value for the whole file so the generated
// bridge takes its execFileSync(HOME_BIN, [args]) path (on Windows it would use
// execSync(one quoted string) — correct in production, proven separately, but it
// would not match these bridges' execFileSync(bin, argv) call-shape assertions).
const REAL_PLATFORM = process.platform;
beforeEach(() => {
  execFileSyncMock.mockClear();
  execFileSyncImpl = () => "";
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
});

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

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

/** Fresh project dir + the kilo env var the server slices interpolate. */
function freshKiloProject(prefix: string): string {
  const dir = freshProject(prefix);
  process.env[ENV_VAR] = ENV_LITERAL;
  return dir;
}

// ── render slice fixtures (former phase3) ──────────────────────────────────
// The phase3 render slice declared a SECOND connector id (acme-db) with its own
// env-ref var and asserted the full serve-wrapper command array + non-collision
// with kilo-cli. Kept distinct from the base acme-kilo fixtures above.
const RENDER_CONNECTOR_ID = "acme-db";
const RENDER_ENV_VAR = "ACME_DB_DSN";
const RENDER_ENV_LITERAL = "postgres://acme/db";

/** A connector with a stdio server (env-ref) + a PreToolUse hook (render slice). */
function buildRenderConnector(): ResolvedConnector {
  return defineConnector({
    id: RENDER_CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@x/y"],
      env: { [RENDER_ENV_VAR]: `\${env:${RENDER_ENV_VAR}}` },
      tools: { include: ["*"] },
    },
    hooks: {
      PreToolUse: {
        matcher: "acme_query|acme_write",
        handler() {
          return { decision: "allow" };
        },
      },
    },
  });
}

/** Fresh project dir + the render-slice env var. */
function freshRenderProject(prefix: string): string {
  const dir = freshProject(prefix);
  process.env[RENDER_ENV_VAR] = RENDER_ENV_LITERAL;
  return dir;
}

// The serve-wrapper tail also bakes the install TARGET platform as `--host <id>`
// (before `--`) so the proxy stamps hostPlatform under a headless spawn.
const wrappedTail = (host: string): string[] => [
  "serve",
  "--connector",
  RENDER_CONNECTOR_ID,
  "--scope",
  "project",
  "--host",
  host,
  "--",
  "npx",
  "-y",
  "@x/y",
];

// ── content-surface fixtures (former surfaces-s2) ──────────────────────────
const SURFACE_CONNECTOR_ID = "acme-surfaces";

const COMMAND = {
  name: "deploy",
  description: "Deploy the app to an environment.",
  prompt: "Deploy to {{args}} / $ARGUMENTS and report the result.",
  argumentHint: "[environment]",
  tools: { allow: ["Bash", "Read"] },
  model: "sonnet",
} as const;

const SKILL = {
  name: "pdf-tools",
  description: "Extract and summarize text from PDF files when the user asks.",
  body: "# PDF Tools\n\nUse the bundled script to extract text.",
  model: "haiku",
  tools: { allow: ["Bash"] },
  disableModelInvocation: false,
  resources: { "scripts/extract.sh": "#!/bin/sh\necho extracting\n" },
} as const;

const SUBAGENT = {
  name: "reviewer",
  description: "Reviews code diffs for correctness bugs.",
  prompt: "You are a meticulous code reviewer. Find correctness bugs.",
  tools: { allow: ["Read", "Grep"] },
  model: "opus",
  readonly: true,
} as const;

/** Deep-clone the shared fixtures (fresh arrays so adapters never alias). */
function command() {
  return { ...COMMAND, tools: { allow: [...COMMAND.tools.allow] } };
}
function skill() {
  return {
    ...SKILL,
    tools: { allow: [...SKILL.tools.allow] },
    resources: { ...SKILL.resources },
  };
}
function subagent() {
  return { ...SUBAGENT, tools: { allow: [...SUBAGENT.tools.allow] } };
}

/** Build a connector declaring ONLY the surfaces a platform supports. */
function buildSurfaceConnector(surfaces: {
  commands?: boolean;
  skills?: boolean;
  subagents?: boolean;
}): ResolvedConnector {
  const cfg: ConnectorConfig = {
    id: SURFACE_CONNECTOR_ID,
    displayName: "Acme Surfaces",
    version: "1.0.0",
  };
  if (surfaces.commands) cfg.commands = [command()];
  if (surfaces.skills) cfg.skills = [skill()];
  if (surfaces.subagents) cfg.subagents = [subagent()];
  return defineConnector(cfg);
}

// Shared env isolation (default keys + the env-ref vars the server slices mutate)
// + the same-rules-for-every-host baseline contract.
isolateEnv([ENV_VAR, RENDER_ENV_VAR]);
createAdapterSuite({ adapter: kiloAdapter, paradigm: "ts-plugin" });

// ─────────────────────────────────────────────────────────────────────────
// MCP server install / uninstall
// ─────────────────────────────────────────────────────────────────────────

describe("kilo adapter — MCP server install/uninstall", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshKiloProject("ac-kilo-mcp-");
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
// Render slice (former phase3) — command-array dialect + non-collision with
// the Kilo CLI (same dir + "mcp" key, DISTINCT filenames).
// ─────────────────────────────────────────────────────────────────────────

describe("kilo adapter (Kilo Code VS Code extension, ts-plugin) render", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshRenderProject("ac-p3-kilo-ext-");
    ctx = buildCtx(projectDir, buildRenderConnector());
  });

  it("has the extension identity (id kilo / name Kilo Code)", () => {
    expect(kiloAdapter.id).toBe("kilo");
    expect(kiloAdapter.name).toBe("Kilo Code");
    // 7.x rebuilt on the Kilo CLI server → shares the ts-plugin hook layer.
    expect(kiloAdapter.paradigm).toBe("ts-plugin");
  });

  it("installServer writes .kilo/kilo.json under 'mcp' with type 'local' and a command ARRAY (delegated kilo backend), NOT the legacy 'mcpServers'", () => {
    const changes = kiloAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".kilo", "kilo.json");
    expect(serverPath).toBe(kiloAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    // vsix 7.3.28 root key is "mcp" (kilo backend), NOT the legacy "mcpServers".
    expect(cfg).toHaveProperty("mcp");
    expect(cfg).not.toHaveProperty("mcpServers");

    const entry = cfg.mcp[RENDER_CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.type).toBe("local");
    // Backend dialect: a single command ARRAY (exe + args folded together).
    expect(Array.isArray(entry.command)).toBe(true);
    expect(entry.command[0]).toBe(HOME_BIN);
    expect(entry.command).toEqual([HOME_BIN, ...wrappedTail("kilo")]);

    // No native interpolation token → env resolves to a LITERAL value.
    expect(entry.environment[RENDER_ENV_VAR]).toBe(RENDER_ENV_LITERAL);
    expect(entry.environment[RENDER_ENV_VAR]).not.toContain("${");
  });

  it("installServer is idempotent — second call yields skip; uninstall removes it", () => {
    kiloAdapter.installServer(ctx);
    expect(kiloAdapter.installServer(ctx)[0]?.action).toBe("skip");
    kiloAdapter.uninstallServer(ctx);
    const cfg = readJson(join(projectDir, ".kilo", "kilo.json"));
    expect(cfg.mcp?.[RENDER_CONNECTOR_ID]).toBeUndefined();
  });

  it("installHooks writes the ts-plugin module (.kilo/plugin/<id>.js), distinct from the server config", () => {
    const changes = kiloAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);
    const hooksPath = kiloAdapter.getHookConfigPath(ctx);
    // Hooks now have their OWN path — no longer aliased to the server config.
    expect(hooksPath).toBe(join(projectDir, ".kilo", "plugin", `${RENDER_CONNECTOR_ID}.js`));
    expect(hooksPath).not.toBe(kiloAdapter.getServerConfigPath(ctx));
    expect(existsSync(hooksPath)).toBe(true);
  });

  it("does NOT collide with kilo-cli: same dir + 'mcp' key but DISTINCT filenames for the same connector", () => {
    kiloAdapter.installServer(ctx);
    kiloCliAdapter.installServer(ctx);

    const extPath = join(projectDir, ".kilo", "kilo.json");
    const cliPath = join(projectDir, ".kilo", "kilo.jsonc");
    // Same backend dir, DIFFERENT filenames — they must not converge on one file.
    expect(extPath).not.toBe(cliPath);
    expect(existsSync(extPath)).toBe(true);
    expect(existsSync(cliPath)).toBe(true);

    const ext = readJson(extPath);
    const cli = readJson(cliPath);
    // Both now share the "mcp" key + command-array dialect (the shared backend).
    expect(Array.isArray(ext.mcp[RENDER_CONNECTOR_ID].command)).toBe(true);
    expect(Array.isArray(cli.mcp[RENDER_CONNECTOR_ID].command)).toBe(true);
    // But the CLI carries a "plugin" array the extension never writes.
    expect(ext).not.toHaveProperty("plugin");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Hooks (ts-plugin) — install / uninstall
// ─────────────────────────────────────────────────────────────────────────

describe("kilo adapter — hooks (ts-plugin) install/uninstall", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshKiloProject("ac-kilo-hooks-");
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
    projectDir = freshKiloProject("ac-kilo-bridge-");
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
    projectDir = freshKiloProject("ac-kilo-skills-");
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
// Content surfaces (commands / skills / subagents) — former surfaces-s2.
// ─────────────────────────────────────────────────────────────────────────

describe("kilo adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-kilo-surfaces-");
    // Declare ONLY the supported surfaces (commands + subagents). Skills are
    // exercised separately below; with none declared they resolve to a skip.
    ctx = buildCtx(projectDir, buildSurfaceConnector({ commands: true, subagents: true }));
  });

  it("declares commands + subagents + skills (OpenCode-fork backend)", () => {
    expect(kiloAdapter.capabilities.supportsCommands).toBe(true);
    expect(kiloAdapter.capabilities.supportsSubagents).toBe(true);
    expect(kiloAdapter.capabilities.supportsSkills).toBe(true);
  });

  it("installCommands writes md+fm command at .kilo/commands/<n>.md", () => {
    const changes = kiloAdapter.installCommands!(ctx);
    expect(changes[0]?.action).toBe("create");
    const cmdPath = join(projectDir, ".kilo", "commands", "deploy.md");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(cmdPath, "utf8"));
    expect(frontmatter.description).toBe("Deploy the app to an environment.");
    expect(frontmatter["argument-hint"]).toBe("[environment]");
    expect(frontmatter.model).toBe("sonnet");
    expect(body.trim()).toBe(COMMAND.prompt);
  });

  it("installSubagents writes md+fm subagent at .kilo/agents/<n>.md (mode:subagent, permission)", () => {
    const changes = kiloAdapter.installSubagents!(ctx);
    expect(changes[0]?.action).toBe("create");
    const agentPath = join(projectDir, ".kilo", "agents", "reviewer.md");
    expect(changes[0]?.path).toBe(agentPath);
    expect(existsSync(agentPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(agentPath, "utf8"));
    expect(frontmatter.description).toBe(SUBAGENT.description);
    expect(frontmatter.mode).toBe("subagent");
    expect(frontmatter.model).toBe("opus");
    // readonly → per-tool deny permission map.
    expect(frontmatter.permission).toEqual({ edit: "deny", bash: "deny" });
    expect(body.trim()).toBe(SUBAGENT.prompt);
  });

  it("installSkills writes uniform SKILL.md at .kilo/skills/<n>/SKILL.md", () => {
    const withSkill = buildCtx(
      projectDir,
      buildSurfaceConnector({ commands: true, skills: true, subagents: true }),
    );
    const changes = kiloAdapter.installSkills!(withSkill);
    expect(changes[0]?.action).toBe("create");
    const skillMd = join(projectDir, ".kilo", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);
    // Skills live under the .kilo/skills tree, never the legacy .kilocode tree.
    expect(existsSync(join(projectDir, ".kilocode", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("is idempotent — second install yields skip (commands + subagents)", () => {
    kiloAdapter.installCommands!(ctx);
    kiloAdapter.installSubagents!(ctx);
    expect(kiloAdapter.installCommands!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(kiloAdapter.installSubagents!(ctx).every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall removes command + subagent files", () => {
    kiloAdapter.installCommands!(ctx);
    kiloAdapter.installSubagents!(ctx);
    kiloAdapter.uninstallCommands!(ctx);
    kiloAdapter.uninstallSubagents!(ctx);
    expect(existsSync(join(projectDir, ".kilo", "commands", "deploy.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".kilo", "agents", "reviewer.md"))).toBe(false);
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

// ─────────────────────────────────────────────────────────────────────────
// New canonical events: UserPromptSubmit / PermissionRequest / Stop
// ─────────────────────────────────────────────────────────────────────────

/** A connector declaring the three newly-wired canonical hook events. */
function buildNewEventsConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Kilo New Events",
    version: "1.0.0",
    hooks: {
      UserPromptSubmit: { handler: () => ({ decision: "allow" }) },
      PermissionRequest: { handler: () => ({ decision: "allow" }) },
      Stop: { handler: () => ({ decision: "allow" }) },
    },
  });
}

describe("kilo adapter — new canonical events (capabilities + wiring)", () => {
  it("capability flags for the three new events are true", () => {
    expect(kiloAdapter.capabilities.userPromptSubmit).toBe(true);
    expect(kiloAdapter.capabilities.permissionRequest).toBe(true);
    expect(kiloAdapter.capabilities.stop).toBe(true);
  });

  it("generated plugin registers chat.message, permission.ask, and an event-hook session.idle branch", () => {
    const projectDir = freshKiloProject("ac-kilo-newev-");
    const ctx = buildCtx(projectDir, buildNewEventsConnector());
    kiloAdapter.installHooks(ctx);
    const src = readFileSync(kiloAdapter.getHookConfigPath(ctx), "utf8");

    expect(src).toContain('"chat.message": async (input, output) =>');
    expect(src).toContain('"permission.ask": async (input, output) =>');
    expect(src).toContain("event: async ({ event }) =>");
    expect(src).toContain('event.type !== "session.idle"');
    // The bridge dispatches each new canonical event by name.
    expect(src).toContain('bridge("UserPromptSubmit"');
    expect(src).toContain('bridge("PermissionRequest"');
    expect(src).toContain('bridge("Stop"');
  });

  it("parseEvent maps a UserPromptSubmit payload (prompt passthrough)", () => {
    const evt = kiloAdapter.parseEvent!("UserPromptSubmit", {
      prompt: "hello kilo",
      sessionId: "kilo-up",
    });
    expect(evt).toMatchObject({
      hostPlatform: "kilo",
      prompt: "hello kilo",
      sessionId: "kilo-up",
    });
  });

  it("parseEvent maps a PermissionRequest payload (tool name + input)", () => {
    const evt = kiloAdapter.parseEvent!("PermissionRequest", {
      toolName: "bash",
      toolInput: { command: "rm -rf /" },
      sessionId: "kilo-pr",
    });
    expect(evt).toMatchObject({
      hostPlatform: "kilo",
      toolName: "bash",
      toolInput: { command: "rm -rf /" },
    });
  });

  it("parseEvent maps a Stop payload", () => {
    const evt = kiloAdapter.parseEvent!("Stop", { sessionId: "kilo-stop" });
    expect(evt).toMatchObject({ hostPlatform: "kilo", sessionId: "kilo-stop" });
  });
});

describe("kilo generated plugin — new event handlers (live, child_process mocked)", () => {
  let projectDir: string;
  let pluginPath: string;

  beforeEach(() => {
    projectDir = freshKiloProject("ac-kilo-newev-live-");
    const ctx = buildCtx(projectDir, buildNewEventsConnector());
    kiloAdapter.installHooks(ctx);
    pluginPath = kiloAdapter.getHookConfigPath(ctx);
    expect(existsSync(pluginPath)).toBe(true);
  });

  async function loadPlugin(): Promise<any> {
    const url = `${pathToFileURL(pluginPath).href}?t=${Date.now()}-${Math.random()}`;
    return import(/* @vite-ignore */ url);
  }

  it("permission.ask mutates output.status to 'deny' on a deny decision", async () => {
    execFileSyncImpl = () => JSON.stringify({ decision: "deny", reason: "no" });
    const mod = await loadPlugin();
    const hooks = await mod.default.server({ directory: projectDir });

    const output: any = { status: "ask" };
    await hooks["permission.ask"]({ type: "bash", sessionID: "s1" }, output);
    expect(output.status).toBe("deny");

    const [, argv] = execFileSyncMock.mock.calls[0]!;
    expect(argv).toEqual(["hook", "kilo", "PermissionRequest", "--connector", CONNECTOR_ID]);
  });

  it("the event hook bridges Stop only for session.idle and throws on a deny decision", async () => {
    execFileSyncImpl = () => JSON.stringify({ decision: "deny", reason: "stay" });
    const mod = await loadPlugin();
    const hooks = await mod.default.server({ directory: projectDir });

    // A non-idle event is ignored (no bridge call, no throw).
    await expect(
      hooks.event({ event: { type: "session.updated", properties: {} } }),
    ).resolves.toBeUndefined();
    expect(execFileSyncMock).not.toHaveBeenCalled();

    // session.idle bridges Stop; a deny decision throws.
    await expect(
      hooks.event({ event: { type: "session.idle", properties: { sessionID: "s2" } } }),
    ).rejects.toThrow();
    const [, argv] = execFileSyncMock.mock.calls[0]!;
    expect(argv).toEqual(["hook", "kilo", "Stop", "--connector", CONNECTOR_ID]);
  });

  it("chat.message pushes additionalContext as a text part on output.parts", async () => {
    execFileSyncImpl = () => JSON.stringify({ additionalContext: "INJECTED" });
    const mod = await loadPlugin();
    const hooks = await mod.default.server({ directory: projectDir });

    const output: any = { parts: [{ type: "text", text: "hi" }] };
    await hooks["chat.message"]({ sessionID: "s3" }, output);
    expect(output.parts).toContainEqual({ type: "text", text: "INJECTED" });

    const [, argv] = execFileSyncMock.mock.calls[0]!;
    expect(argv).toEqual(["hook", "kilo", "UserPromptSubmit", "--connector", CONNECTOR_ID]);
  });
});
