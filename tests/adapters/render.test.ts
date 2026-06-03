/**
 * adapters/render — render + round-trip tests for the three Phase-1 adapters.
 *
 * For each of claude-code, codex, cursor this exercises the full json-stdio path
 * end-to-end against REAL files on disk in an isolated temp project dir:
 *   • installServer  → native MCP registration (root key / TOML table / fields)
 *   • installHooks   → native hook registration (per-dialect shape)
 *   • env-ref handling per platform (native token vs. resolved literal)
 *   • telemetry serve-wrapper command points at the stable home binary
 *   • idempotency (second install → "skip", no duplicates)
 *   • uninstall (entries removed; re-read from disk confirms gone)
 *   • parseEvent + formatReply round-trip for PreToolUse deny/ask and a
 *     SessionStart context response → platform-native reply shape.
 *
 * Filesystem isolation: every test gets a fresh os.tmpdir mkdtemp project dir, so
 * config files land under <tempDir>/.claude, /.codex, /.cursor — never the real
 * home or the repo tree. HOME + AGENT_CONNECTOR_DATA_DIR are pointed at temp and
 * restored in afterEach.
 */

import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import TOML from "@iarna/toml";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  HookResponse,
  ResolvedConnector,
} from "../../src/core/types.js";

import claudeAdapter from "../../src/adapters/claude-code/index.js";
import codexAdapter from "../../src/adapters/codex/index.js";
import cursorAdapter from "../../src/adapters/cursor/index.js";

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";

/** A connector with a stdio server (env-ref) + a PreToolUse and SessionStart hook. */
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
          return { decision: "context", additionalContext: "hello" };
        },
      },
    },
  });
}

/** Build an InstallContext scoped to a fresh temp project dir. */
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

// Track + restore mutated env so the suite never leaks state.
let savedHome: string | undefined;
let savedDataDir: string | undefined;
let savedEnvVar: string | undefined;
let savedCodexHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
  savedEnvVar = process.env[ENV_VAR];
  savedCodexHome = process.env.CODEX_HOME;
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
  restore(ENV_VAR, savedEnvVar);
  restore("CODEX_HOME", savedCodexHome);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Fresh temp project dir + redirect HOME/data-root there so nothing escapes. */
function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-render-"));
  // Point HOME + data-root at a temp location so any accidental user-scope or
  // backup write lands in the sandbox, never the real home.
  process.env.HOME = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  // Set the env-ref var so codex literal-resolution produces a known value.
  process.env[ENV_VAR] = ENV_LITERAL;
  return dir;
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ─────────────────────────────────────────────────────────────────────────
// Claude Code
// ─────────────────────────────────────────────────────────────────────────

describe("claude-code adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("installServer writes mcpServers.<id> into project .mcp.json, wrapped for telemetry, env as native ${VAR} token", () => {
    const changes = claudeAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".mcp.json");
    expect(serverPath).toBe(claudeAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.type).toBe("stdio");

    // Telemetry serve-wrapper: command points at the home binary, real command
    // is pushed into the serve args after the `--` separator.
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual([
      "serve",
      "--connector",
      CONNECTOR_ID,
      "--",
      "npx",
      "-y",
      "@x/y",
    ]);

    // Claude keeps a NATIVE interpolation token (${VAR}) — secret not baked in.
    expect(entry.env[ENV_VAR]).toBe(`\${${ENV_VAR}}`);
    expect(entry.env[ENV_VAR]).not.toContain("env:");
    expect(entry.env[ENV_VAR]).not.toBe(ENV_LITERAL);
  });

  it("installHooks writes hooks.<event> entries that reference the home binary + connector id", () => {
    const changes = claudeAdapter.installHooks(ctx);
    expect(changes.every((c) => c.action !== "warn")).toBe(true);

    const settingsPath = join(projectDir, ".claude", "settings.json");
    expect(settingsPath).toBe(claudeAdapter.getHookConfigPath(ctx));

    const cfg = readJson(settingsPath);
    const pre = cfg.hooks.PreToolUse;
    expect(Array.isArray(pre)).toBe(true);
    expect(pre[0].matcher).toBe("acme_query|acme_write");
    const cmd = pre[0].hooks[0].command;
    expect(cmd).toContain(HOME_BIN);
    expect(cmd).toContain("hook claude-code PreToolUse");
    expect(cmd).toContain(`--connector ${CONNECTOR_ID}`);

    // SessionStart is also registered (no matcher → empty string).
    expect(cfg.hooks.SessionStart[0].hooks[0].command).toContain(
      "hook claude-code SessionStart",
    );
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    claudeAdapter.installServer(ctx);
    const second = claudeAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".mcp.json"));
    expect(Object.keys(cfg.mcpServers)).toEqual([CONNECTOR_ID]);
  });

  it("installHooks is idempotent — second call yields skip and does not duplicate entries", () => {
    claudeAdapter.installHooks(ctx);
    const second = claudeAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    const cfg = readJson(join(projectDir, ".claude", "settings.json"));
    expect(cfg.hooks.PreToolUse).toHaveLength(1);
    expect(cfg.hooks.SessionStart).toHaveLength(1);
  });

  it("uninstallServer + uninstallHooks remove the entries (re-read confirms gone)", () => {
    claudeAdapter.installServer(ctx);
    claudeAdapter.installHooks(ctx);

    claudeAdapter.uninstallServer(ctx);
    const serverCfg = readJson(join(projectDir, ".mcp.json"));
    expect(serverCfg.mcpServers?.[CONNECTOR_ID]).toBeUndefined();

    claudeAdapter.uninstallHooks(ctx);
    const settings = readJson(join(projectDir, ".claude", "settings.json"));
    // Either the events are dropped entirely or no entry references our command.
    const all = JSON.stringify(settings.hooks ?? {});
    expect(all).not.toContain(HOME_BIN);
  });

  it("parseEvent + formatReply round-trip: PreToolUse deny → native hookSpecificOutput", () => {
    const evt = claudeAdapter.parseEvent!("PreToolUse", {
      tool_name: "acme_write",
      tool_input: { sql: "DELETE" },
      cwd: projectDir,
      session_id: "sess-1",
      connector: CONNECTOR_ID,
    });
    expect(evt).toMatchObject({
      hostPlatform: "claude-code",
      toolName: "acme_write",
      toolInput: { sql: "DELETE" },
      sessionId: "sess-1",
    });

    const deny: HookResponse = { decision: "deny", reason: "no writes" };
    const reply = claudeAdapter.formatReply!("PreToolUse", deny);
    expect(reply.exitCode).toBe(0);
    const out = JSON.parse(reply.stdout!);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("no writes");
  });

  it("formatReply: PreToolUse ask → permissionDecision ask", () => {
    const reply = claudeAdapter.formatReply!("PreToolUse", {
      decision: "ask",
      reason: "confirm",
    });
    const out = JSON.parse(reply.stdout!);
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("confirm");
  });

  it("parseEvent + formatReply round-trip: SessionStart context → additionalContext", () => {
    const evt = claudeAdapter.parseEvent!("SessionStart", {
      source: "startup",
      cwd: projectDir,
      session_id: "s2",
    });
    expect(evt).toMatchObject({ hostPlatform: "claude-code", source: "startup" });

    const reply = claudeAdapter.formatReply!("SessionStart", {
      decision: "context",
      additionalContext: "ctx here",
    });
    const out = JSON.parse(reply.stdout!);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toBe("ctx here");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Codex
// ─────────────────────────────────────────────────────────────────────────

describe("codex adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("installServer writes [mcp_servers.<id>] TOML table, wrapped for telemetry, env as a LITERAL (no native interpolation)", () => {
    const changes = codexAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const tomlPath = join(projectDir, ".codex", "config.toml");
    expect(tomlPath).toBe(codexAdapter.getServerConfigPath(ctx));
    expect(existsSync(tomlPath)).toBe(true);

    const cfg = TOML.parse(readFileSync(tomlPath, "utf8")) as any;
    expect(cfg.mcp_servers).toBeTruthy();
    const entry = cfg.mcp_servers[CONNECTOR_ID];
    expect(entry).toBeTruthy();

    // Serve-wrapper points at the home binary.
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual([
      "serve",
      "--connector",
      CONNECTOR_ID,
      "--",
      "npx",
      "-y",
      "@x/y",
    ]);

    // TOML cannot interpolate → the env-ref is resolved to a LITERAL value.
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installHooks writes hooks.json entries referencing the home binary + codex platform token", () => {
    const changes = codexAdapter.installHooks(ctx);
    expect(changes.length).toBeGreaterThan(0);

    const hooksPath = join(projectDir, ".codex", "hooks.json");
    expect(hooksPath).toBe(codexAdapter.getHookConfigPath(ctx));

    const cfg = readJson(hooksPath);
    const pre = cfg.hooks.PreToolUse;
    expect(Array.isArray(pre)).toBe(true);
    const cmd = pre[0].hooks[0].command;
    expect(cmd).toContain(HOME_BIN);
    expect(cmd).toContain("hook codex PreToolUse");
    expect(cmd).toContain(`--connector ${CONNECTOR_ID}`);
    // PreToolUse carries the charset-clean Codex matcher.
    expect(pre[0].matcher).toContain("mcp__");

    // SessionStart is registered too (it is in CODEX_HOOK_EVENTS).
    expect(cfg.hooks.SessionStart[0].hooks[0].command).toContain(
      "hook codex SessionStart",
    );
  });

  it("installServer is idempotent — second call yields skip, no duplicate table", () => {
    codexAdapter.installServer(ctx);
    const second = codexAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = TOML.parse(
      readFileSync(join(projectDir, ".codex", "config.toml"), "utf8"),
    ) as any;
    expect(Object.keys(cfg.mcp_servers)).toEqual([CONNECTOR_ID]);
  });

  it("installHooks is idempotent — second call yields skip and does not duplicate entries", () => {
    codexAdapter.installHooks(ctx);
    const second = codexAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    const cfg = readJson(join(projectDir, ".codex", "hooks.json"));
    expect(cfg.hooks.PreToolUse).toHaveLength(1);
    expect(cfg.hooks.SessionStart).toHaveLength(1);
  });

  it("uninstallServer + uninstallHooks remove the entries (re-read confirms gone)", () => {
    codexAdapter.installServer(ctx);
    codexAdapter.installHooks(ctx);

    codexAdapter.uninstallServer(ctx);
    const cfg = TOML.parse(
      readFileSync(join(projectDir, ".codex", "config.toml"), "utf8"),
    ) as any;
    expect(cfg.mcp_servers?.[CONNECTOR_ID]).toBeUndefined();

    codexAdapter.uninstallHooks(ctx);
    const hooks = readJson(join(projectDir, ".codex", "hooks.json"));
    expect(JSON.stringify(hooks.hooks ?? {})).not.toContain(HOME_BIN);
  });

  it("parseEvent + formatReply round-trip: PreToolUse deny → native hookSpecificOutput", () => {
    const evt = codexAdapter.parseEvent!("PreToolUse", {
      tool_name: "acme_write",
      tool_input: { sql: "DROP" },
      cwd: projectDir,
      session_id: "cx-1",
    });
    expect(evt).toMatchObject({
      hostPlatform: "codex",
      toolName: "acme_write",
      toolInput: { sql: "DROP" },
      sessionId: "cx-1",
    });

    const reply = codexAdapter.formatReply!("PreToolUse", {
      decision: "deny",
      reason: "blocked",
    });
    expect(reply.exitCode).toBe(0);
    const out = JSON.parse(reply.stdout!);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("blocked");
  });

  it("formatReply: SessionStart context → additionalContext native wrapper", () => {
    const evt = codexAdapter.parseEvent!("SessionStart", {
      source: "startup",
      cwd: projectDir,
      session_id: "cx-2",
    });
    expect(evt).toMatchObject({ hostPlatform: "codex", source: "startup" });

    const reply = codexAdapter.formatReply!("SessionStart", {
      decision: "context",
      additionalContext: "codex ctx",
    });
    const out = JSON.parse(reply.stdout!);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toBe("codex ctx");
  });

  it("formatReply: ask is unsupported on Codex → passthrough (no stdout decision)", () => {
    const reply = codexAdapter.formatReply!("PreToolUse", {
      decision: "ask",
      reason: "confirm",
    });
    // Codex does not honor ask; it fails open (exit 0, no permission payload).
    expect(reply.exitCode).toBe(0);
    expect(reply.stdout).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cursor
// ─────────────────────────────────────────────────────────────────────────

describe("cursor adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("installServer writes mcpServers.<id> into project .cursor/mcp.json, wrapped, env keeps native ${env:VAR} token", () => {
    const changes = cursorAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const mcpPath = join(projectDir, ".cursor", "mcp.json");
    expect(mcpPath).toBe(cursorAdapter.getServerConfigPath(ctx));
    expect(existsSync(mcpPath)).toBe(true);

    const cfg = readJson(mcpPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry).toBeTruthy();

    // Serve-wrapper: command = home binary; real command in serve args.
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual([
      "serve",
      "--connector",
      CONNECTOR_ID,
      "--",
      "npx",
      "-y",
      "@x/y",
    ]);

    // Cursor keeps its native ${env:VAR} interpolation token (passthrough).
    expect(entry.env[ENV_VAR]).toBe(`\${env:${ENV_VAR}}`);
    expect(entry.env[ENV_VAR]).not.toBe(ENV_LITERAL);
  });

  it("installHooks writes flat command entries under cursor-native event keys + version 1", () => {
    const changes = cursorAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const hooksPath = join(projectDir, ".cursor", "hooks.json");
    expect(hooksPath).toBe(cursorAdapter.getHookConfigPath(ctx));

    const cfg = readJson(hooksPath);
    expect(cfg.version).toBe(1);

    // Cursor uses lower-camel native event keys and FLAT command objects.
    const pre = cfg.hooks.preToolUse;
    expect(Array.isArray(pre)).toBe(true);
    expect(pre[0].command).toContain(HOME_BIN);
    expect(pre[0].command).toContain("hook cursor PreToolUse");
    expect(pre[0].command).toContain(`--connector ${CONNECTOR_ID}`);
    expect(pre[0].matcher).toBe("acme_query|acme_write");

    // SessionStart maps to the native sessionStart key.
    expect(cfg.hooks.sessionStart[0].command).toContain(
      "hook cursor SessionStart",
    );
  });

  it("installServer is idempotent — second call yields skip, no duplicate", () => {
    cursorAdapter.installServer(ctx);
    const second = cursorAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".cursor", "mcp.json"));
    expect(Object.keys(cfg.mcpServers)).toEqual([CONNECTOR_ID]);
  });

  it("installHooks is idempotent — second call yields skip and does not duplicate entries", () => {
    cursorAdapter.installHooks(ctx);
    const second = cursorAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    const cfg = readJson(join(projectDir, ".cursor", "hooks.json"));
    expect(cfg.hooks.preToolUse).toHaveLength(1);
    expect(cfg.hooks.sessionStart).toHaveLength(1);
  });

  it("uninstallServer + uninstallHooks remove the entries (re-read confirms gone)", () => {
    cursorAdapter.installServer(ctx);
    cursorAdapter.installHooks(ctx);

    cursorAdapter.uninstallServer(ctx);
    const mcp = readJson(join(projectDir, ".cursor", "mcp.json"));
    expect(mcp.mcpServers?.[CONNECTOR_ID]).toBeUndefined();

    cursorAdapter.uninstallHooks(ctx);
    const hooks = readJson(join(projectDir, ".cursor", "hooks.json"));
    expect(JSON.stringify(hooks.hooks ?? {})).not.toContain(HOME_BIN);
  });

  it("parseEvent + formatReply round-trip: PreToolUse deny → permission/user_message", () => {
    const evt = cursorAdapter.parseEvent!("PreToolUse", {
      tool_name: "acme_write",
      tool_input: { sql: "TRUNCATE" },
      cwd: projectDir,
      conversation_id: "cur-1",
    });
    expect(evt).toMatchObject({
      hostPlatform: "cursor",
      toolName: "acme_write",
      toolInput: { sql: "TRUNCATE" },
      sessionId: "cur-1",
    });

    const reply = cursorAdapter.formatReply!("PreToolUse", {
      decision: "deny",
      reason: "nope",
    });
    expect(reply.exitCode).toBe(0);
    const out = JSON.parse(reply.stdout!);
    expect(out.permission).toBe("deny");
    expect(out.user_message).toBe("nope");
  });

  it("formatReply: PreToolUse ask → permission ask + user_message", () => {
    const reply = cursorAdapter.formatReply!("PreToolUse", {
      decision: "ask",
      reason: "confirm",
    });
    const out = JSON.parse(reply.stdout!);
    expect(out.permission).toBe("ask");
    expect(out.user_message).toBe("confirm");
  });

  it("parseEvent + formatReply round-trip: SessionStart context → additional_context", () => {
    const evt = cursorAdapter.parseEvent!("SessionStart", {
      source: "startup",
      cwd: projectDir,
      conversation_id: "cur-2",
    });
    expect(evt).toMatchObject({ hostPlatform: "cursor", source: "startup" });

    const reply = cursorAdapter.formatReply!("SessionStart", {
      decision: "context",
      additionalContext: "cursor ctx",
    });
    const out = JSON.parse(reply.stdout!);
    expect(out.additional_context).toBe("cursor ctx");
  });
});
