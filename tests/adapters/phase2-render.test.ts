/**
 * adapters/phase2-render — render + round-trip tests for the four Phase-2 adapters.
 *
 * Exercises the full install/uninstall path end-to-end against REAL files on disk
 * for each of vscode-copilot, copilot-cli, gemini-cli, warp:
 *   • installServer  → native MCP registration (correct ROOT KEY / fields / shape)
 *   • installHooks   → native hook registration (per-dialect event names + shape),
 *                      or the single mcp-only "skip" for Warp (no hook file written)
 *   • env-ref handling per platform (native ${env:VAR} token vs. resolved literal)
 *   • telemetry serve-wrapper command points at the stable home binary
 *   • idempotency (second installServer → "skip", no duplicates)
 *   • uninstall (entries removed; re-read from disk confirms gone)
 *
 * Filesystem isolation: every test gets a fresh os.tmpdir mkdtemp project dir, and
 * HOME is redirected there so the USER-scope adapters (copilot-cli, warp) resolve
 * their homedir()-based paths into the sandbox — never the real home. HOME and
 * AGENT_CONNECTOR_DATA_DIR are restored in afterEach.
 */

import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import vscodeCopilotAdapter from "../../src/adapters/vscode-copilot/index.js";
import copilotCliAdapter from "../../src/adapters/copilot-cli/index.js";
import geminiCliAdapter from "../../src/adapters/gemini-cli/index.js";
import warpAdapter from "../../src/adapters/warp/index.js";

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const SERVER_CWD = "/srv/acme";

/** A connector with a stdio server (env-ref + cwd) + PreToolUse and SessionStart hooks. */
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
      cwd: SERVER_CWD,
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
          return { decision: "context", additionalContext: "hello" };
        },
      },
    },
  });
}

/** Build an InstallContext scoped to a fresh temp project dir. */
function buildCtx(
  projectDir: string,
  connector: ResolvedConnector,
  scope: InstallContext["scope"] = "project",
): InstallContext {
  return {
    connector,
    scope,
    projectDir,
    homeBinPath: HOME_BIN,
    dataRoot: projectDir,
    dryRun: false,
  };
}

// Track + restore mutated env so the suite never leaks state.
let savedHome: string | undefined;
let savedDataDir: string | undefined;
let savedEnvVar: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
  savedEnvVar = process.env[ENV_VAR];
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
  restore(ENV_VAR, savedEnvVar);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/**
 * Fresh temp project dir + redirect HOME/data-root there so nothing escapes.
 * Critical for the USER-scope adapters (copilot-cli, warp) which resolve paths
 * from homedir() — pointing HOME at a temp dir keeps every write in the sandbox.
 */
function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-p2-render-"));
  process.env.HOME = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  // Set the env-ref var so literal-resolution produces a known value.
  process.env[ENV_VAR] = ENV_LITERAL;
  return dir;
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

const WRAPPED_ARGS = [
  "serve",
  "--connector",
  CONNECTOR_ID,
  "--scope",
  "project",
  "--",
  "npx",
  "-y",
  "@x/y",
];
// User-scoped adapters (copilot-cli) stamp `--scope user` instead of project.
const WRAPPED_ARGS_USER = [
  "serve",
  "--connector",
  CONNECTOR_ID,
  "--scope",
  "user",
  "--",
  "npx",
  "-y",
  "@x/y",
];

// ─────────────────────────────────────────────────────────────────────────
// VS Code Copilot
// ─────────────────────────────────────────────────────────────────────────

describe("vscode-copilot adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("installServer writes the entry under ROOT KEY 'servers' (NOT 'mcpServers'), wrapped, env as native ${env:VAR}", () => {
    const changes = vscodeCopilotAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".vscode", "mcp.json");
    expect(serverPath).toBe(vscodeCopilotAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    // The single most common VS Code footgun: root key is "servers", not "mcpServers".
    expect(cfg).toHaveProperty("servers");
    expect(cfg).not.toHaveProperty("mcpServers");

    const entry = cfg.servers[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.type).toBe("stdio");

    // Telemetry serve-wrapper: command points at the home binary.
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(WRAPPED_ARGS);

    // VS Code keeps a NATIVE interpolation token (${env:VAR}) — secret not baked in.
    expect(entry.env[ENV_VAR]).toBe(`\${env:${ENV_VAR}}`);
    expect(entry.env[ENV_VAR]).not.toBe(ENV_LITERAL);

    // cwd flows through as the native `cwd` key (VS Code stdio shape).
    expect(entry.cwd).toBe(SERVER_CWD);
  });

  it("installHooks writes a .github/hooks/<id>.json with PascalCase event names + version 1, command at the home bin", () => {
    const changes = vscodeCopilotAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const hooksPath = join(projectDir, ".github", "hooks", `${CONNECTOR_ID}.json`);
    expect(hooksPath).toBe(vscodeCopilotAdapter.getHookConfigPath(ctx));
    expect(existsSync(hooksPath)).toBe(true);

    const cfg = readJson(hooksPath);
    // The required top-level version — a version-less file is rejected by Copilot.
    expect(cfg.version).toBe(1);

    // PascalCase event keys + FLAT { type, command } entries.
    const pre = cfg.hooks.PreToolUse;
    expect(Array.isArray(pre)).toBe(true);
    expect(pre[0].type).toBe("command");
    expect(pre[0].command).toContain(HOME_BIN);
    expect(pre[0].command).toContain("hook vscode-copilot PreToolUse");
    expect(pre[0].command).toContain(`--connector ${CONNECTOR_ID}`);

    // SessionStart is registered too (PascalCase, in the VS Code event map).
    expect(cfg.hooks.SessionStart[0].command).toContain(
      "hook vscode-copilot SessionStart",
    );
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    vscodeCopilotAdapter.installServer(ctx);
    const second = vscodeCopilotAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".vscode", "mcp.json"));
    expect(Object.keys(cfg.servers)).toEqual([CONNECTOR_ID]);
  });

  it("installHooks is idempotent — second call yields skip and does not duplicate entries", () => {
    vscodeCopilotAdapter.installHooks(ctx);
    const second = vscodeCopilotAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    const cfg = readJson(
      join(projectDir, ".github", "hooks", `${CONNECTOR_ID}.json`),
    );
    expect(cfg.hooks.PreToolUse).toHaveLength(1);
    expect(cfg.hooks.SessionStart).toHaveLength(1);
  });

  it("uninstallServer + uninstallHooks remove the entries (re-read confirms gone)", () => {
    vscodeCopilotAdapter.installServer(ctx);
    vscodeCopilotAdapter.installHooks(ctx);

    vscodeCopilotAdapter.uninstallServer(ctx);
    const serverCfg = readJson(join(projectDir, ".vscode", "mcp.json"));
    expect(serverCfg.servers?.[CONNECTOR_ID]).toBeUndefined();

    vscodeCopilotAdapter.uninstallHooks(ctx);
    const hooks = readJson(
      join(projectDir, ".github", "hooks", `${CONNECTOR_ID}.json`),
    );
    expect(JSON.stringify(hooks.hooks ?? {})).not.toContain(HOME_BIN);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GitHub Copilot CLI (user/global scope → resolves from homedir())
// ─────────────────────────────────────────────────────────────────────────

describe("copilot-cli adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    // Copilot CLI is user-scoped; HOME was redirected to projectDir by freshProject,
    // so ~/.copilot/* lands inside the sandbox.
    ctx = buildCtx(projectDir, buildConnector(), "user");
  });

  it("installServer writes mcpServers.<id> with type 'local' into ~/.copilot/mcp-config.json, env as LITERAL", () => {
    const changes = copilotCliAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".copilot", "mcp-config.json");
    expect(serverPath).toBe(copilotCliAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry).toBeTruthy();

    // stdio is registered as type "local" with a tools allow-list.
    expect(entry.type).toBe("local");
    expect(entry.tools).toEqual(["*"]);

    // Telemetry serve-wrapper: command points at the home binary.
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(WRAPPED_ARGS_USER);

    // No native interpolation → env-ref resolves to a LITERAL value.
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installHooks writes ~/.copilot/hooks/agent-connector.json with version 1 + Claude-shaped entries", () => {
    const changes = copilotCliAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const hooksPath = join(
      projectDir,
      ".copilot",
      "hooks",
      "agent-connector.json",
    );
    expect(hooksPath).toBe(copilotCliAdapter.getHookConfigPath(ctx));
    expect(existsSync(hooksPath)).toBe(true);

    const cfg = readJson(hooksPath);
    expect(cfg.version).toBe(1);

    // PascalCase event keys; nested { matcher, hooks: [{ type, command }] } shape.
    const pre = cfg.hooks.PreToolUse;
    expect(Array.isArray(pre)).toBe(true);
    expect(pre[0].matcher).toBe("acme_query|acme_write");
    const cmd = pre[0].hooks[0].command;
    expect(cmd).toContain(HOME_BIN);
    expect(cmd).toContain("hook copilot-cli PreToolUse");
    expect(cmd).toContain(`--connector ${CONNECTOR_ID}`);

    expect(cfg.hooks.SessionStart[0].hooks[0].command).toContain(
      "hook copilot-cli SessionStart",
    );
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    copilotCliAdapter.installServer(ctx);
    const second = copilotCliAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".copilot", "mcp-config.json"));
    expect(Object.keys(cfg.mcpServers)).toEqual([CONNECTOR_ID]);
  });

  it("installHooks is idempotent — second call yields skip and does not duplicate entries", () => {
    copilotCliAdapter.installHooks(ctx);
    const second = copilotCliAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    const cfg = readJson(
      join(projectDir, ".copilot", "hooks", "agent-connector.json"),
    );
    expect(cfg.hooks.PreToolUse).toHaveLength(1);
    expect(cfg.hooks.SessionStart).toHaveLength(1);
  });

  it("uninstallServer + uninstallHooks remove the entries (re-read confirms gone)", () => {
    copilotCliAdapter.installServer(ctx);
    copilotCliAdapter.installHooks(ctx);

    copilotCliAdapter.uninstallServer(ctx);
    const serverCfg = readJson(join(projectDir, ".copilot", "mcp-config.json"));
    expect(serverCfg.mcpServers?.[CONNECTOR_ID]).toBeUndefined();

    copilotCliAdapter.uninstallHooks(ctx);
    const hooks = readJson(
      join(projectDir, ".copilot", "hooks", "agent-connector.json"),
    );
    expect(JSON.stringify(hooks.hooks ?? {})).not.toContain(HOME_BIN);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Gemini CLI
// ─────────────────────────────────────────────────────────────────────────

describe("gemini-cli adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("installServer writes mcpServers.<id> with command/args (stdio by key, no `type`), env as LITERAL", () => {
    const changes = geminiCliAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".gemini", "settings.json");
    expect(serverPath).toBe(geminiCliAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry).toBeTruthy();

    // Gemini selects transport BY KEY (command/args), not a `type` field.
    expect(entry).not.toHaveProperty("type");
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(WRAPPED_ARGS);

    // No native ${env:VAR} support → env-ref resolves to a LITERAL value.
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installHooks writes the top-level `hooks` key in the SAME settings.json using Gemini event names", () => {
    const changes = geminiCliAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const settingsPath = join(projectDir, ".gemini", "settings.json");
    expect(settingsPath).toBe(geminiCliAdapter.getHookConfigPath(ctx));

    const cfg = readJson(settingsPath);

    // PreToolUse → BeforeTool (Gemini's distinct event vocabulary).
    const before = cfg.hooks.BeforeTool;
    expect(Array.isArray(before)).toBe(true);
    expect(before[0].matcher).toBe("acme_query|acme_write");
    const cmd = before[0].hooks[0].command;
    expect(cmd).toContain(HOME_BIN);
    expect(cmd).toContain("hook gemini-cli PreToolUse");
    expect(cmd).toContain(`--connector ${CONNECTOR_ID}`);

    // SessionStart maps 1:1 to Gemini's SessionStart.
    expect(cfg.hooks.SessionStart[0].hooks[0].command).toContain(
      "hook gemini-cli SessionStart",
    );
    // The Claude-style PreToolUse key must NOT appear (renamed to BeforeTool).
    expect(cfg.hooks.PreToolUse).toBeUndefined();
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    geminiCliAdapter.installServer(ctx);
    const second = geminiCliAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".gemini", "settings.json"));
    expect(Object.keys(cfg.mcpServers)).toEqual([CONNECTOR_ID]);
  });

  it("installHooks is idempotent — second call yields skip and does not duplicate entries", () => {
    geminiCliAdapter.installHooks(ctx);
    const second = geminiCliAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    const cfg = readJson(join(projectDir, ".gemini", "settings.json"));
    expect(cfg.hooks.BeforeTool).toHaveLength(1);
    expect(cfg.hooks.SessionStart).toHaveLength(1);
  });

  it("server + hooks coexist in the SAME settings.json; uninstall removes both (re-read confirms gone)", () => {
    geminiCliAdapter.installServer(ctx);
    geminiCliAdapter.installHooks(ctx);

    // Both sections live in one file.
    const both = readJson(join(projectDir, ".gemini", "settings.json"));
    expect(both.mcpServers?.[CONNECTOR_ID]).toBeTruthy();
    expect(both.hooks?.BeforeTool).toBeTruthy();

    geminiCliAdapter.uninstallServer(ctx);
    const afterServer = readJson(join(projectDir, ".gemini", "settings.json"));
    expect(afterServer.mcpServers?.[CONNECTOR_ID]).toBeUndefined();
    // Removing the server must not disturb the hooks section.
    expect(afterServer.hooks?.BeforeTool).toBeTruthy();

    geminiCliAdapter.uninstallHooks(ctx);
    const afterHooks = readJson(join(projectDir, ".gemini", "settings.json"));
    expect(JSON.stringify(afterHooks.hooks ?? {})).not.toContain(HOME_BIN);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Warp (mcp-only — no hook system)
// ─────────────────────────────────────────────────────────────────────────

describe("warp adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("installServer writes mcpServers.<id> into .warp/.mcp.json with `working_directory` (NOT cwd), env LITERAL", () => {
    const changes = warpAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".warp", ".mcp.json");
    expect(serverPath).toBe(warpAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry).toBeTruthy();

    // Telemetry serve-wrapper: command points at the home binary.
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(WRAPPED_ARGS);

    // QUIRK: Warp keys the working directory as `working_directory`, never `cwd`.
    expect(entry.working_directory).toBe(SERVER_CWD);
    expect(entry).not.toHaveProperty("cwd");

    // No native interpolation token → env-ref resolves to a LITERAL value.
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installHooks returns a single skip ChangeRecord and writes NO hook file", () => {
    const changes = warpAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");

    // Warp's hook config path equals its server config path; with only installHooks
    // called, no file should exist at all (nothing is written for mcp-only hooks).
    const hooksPath = warpAdapter.getHookConfigPath(ctx);
    expect(hooksPath).toBe(warpAdapter.getServerConfigPath(ctx));
    expect(existsSync(hooksPath)).toBe(false);
  });

  it("installHooks does not add a hooks section to an already-written .mcp.json", () => {
    warpAdapter.installServer(ctx);
    warpAdapter.installHooks(ctx);

    const cfg = readJson(join(projectDir, ".warp", ".mcp.json"));
    // The server file carries ONLY the MCP registration — no hooks key.
    expect(cfg).not.toHaveProperty("hooks");
    expect(cfg.mcpServers?.[CONNECTOR_ID]).toBeTruthy();
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    warpAdapter.installServer(ctx);
    const second = warpAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".warp", ".mcp.json"));
    expect(Object.keys(cfg.mcpServers)).toEqual([CONNECTOR_ID]);
  });

  it("uninstallServer removes the entry; uninstallHooks is a clean skip", () => {
    warpAdapter.installServer(ctx);

    warpAdapter.uninstallServer(ctx);
    const cfg = readJson(join(projectDir, ".warp", ".mcp.json"));
    expect(cfg.mcpServers?.[CONNECTOR_ID]).toBeUndefined();

    const hookChanges = warpAdapter.uninstallHooks(ctx);
    expect(hookChanges).toHaveLength(1);
    expect(hookChanges[0]?.action).toBe("skip");
  });
});
