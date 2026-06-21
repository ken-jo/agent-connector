/**
 * adapters/codebuddy.test.ts — the ONE per-host file for the Tencent CodeBuddy adapter.
 *
 * CodeBuddy Code is a json-stdio host and a CLOSE Claude Code fork. Config surfaces
 * (all BYTE-CONFIRMED against `@tencent-ai/codebuddy-code@2.109.0`/dist/codebuddy.js):
 *   • MCP servers → `~/.codebuddy.json` (user) / `<projectDir>/.mcp.json` (project),
 *                   ROOT KEY "mcpServers"; stdio entry { type:"stdio", command, args,
 *                   env?, cwd? } serve-wrapped; http → { type:"http", url, headers? };
 *                   env/url keep CodeBuddy's NATIVE ${VAR} token (secret never baked).
 *   • Hooks       → `<configDir>/settings.json` under "hooks", keyed by event name,
 *                   nested entry { matcher, hooks:[{type:"command",command}] }; all 13
 *                   Claude events wired 1:1; nativeHooks event-name entries verbatim.
 *   • Content     → `<configDir>/{commands,skills,agents}` (claude-code renderers).
 *   • Memory      → `CODEBUDDY.md` (the fork renames CLAUDE.md; NOT AGENTS.md).
 *   • Reply       → Claude `hookSpecificOutput` envelope (PreToolUse deny →
 *                   permissionDecision; Stop-class deny → top-level decision:"block").
 *   • config dir  → `$CODEBUDDY_CONFIG_DIR` || `~/.codebuddy` (user scope).
 *
 * HONEST CEILING: CodeBuddy needs Tencent auth, so it is NOT live-verifiable
 * locally — this file is a PLACEMENT + BYTE-ORACLE ceiling (paths/shapes asserted
 * against the bundle-confirmed surface; install-roundtrip auto-covers placement +
 * no-residue). It uses the shared harness (tests/support/env + adapter-suite + fs)
 * per tests/README.md — ONE file per host.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  PostToolUseFailureEvent,
  PreToolUseEvent,
  ResolvedConnector,
  SubagentStopEvent,
} from "../../src/core/types.js";

import codebuddyAdapter from "../../src/adapters/codebuddy/index.js";
import {
  buildCtx,
  freshHomeProject,
  freshProject,
  isolateEnv,
  HOME_BIN,
} from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson, splitFrontmatter } from "../support/fs.js";

// ── shared fixtures ──────────────────────────────────────────────────────────

const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const SERVER_CWD = "/srv/acme";

const SURFACES_CONNECTOR_ID = "acme-surfaces";
const MEMORY_CONNECTOR_ID = "acme-memory";
const NATIVE_CONNECTOR_ID = "acme-native";

/** render: a stdio server (env-ref + cwd) + a PreToolUse and SessionStart hook. */
function buildRenderConnector(): ResolvedConnector {
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

/** http transport: a server-only connector for the remote-URL test. */
function httpConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Remote",
    version: "1.0.0",
    server: { transport: "http", url: "https://mcp.example.com/v1" },
  });
}

/** surfaces: a connector declaring a command + skill (with a resource) + subagent. */
function buildSurfacesConnector(): ResolvedConnector {
  return defineConnector({
    id: SURFACES_CONNECTOR_ID,
    displayName: "Acme Surfaces",
    version: "1.0.0",
    commands: [
      {
        name: "deploy",
        description: "Deploy the app to an environment.",
        prompt: "Deploy to $ARGUMENTS and report the result.",
        argumentHint: "[environment]",
        tools: { allow: ["Bash", "Read"] },
        model: "sonnet",
      },
    ],
    skills: [
      {
        name: "pdf-tools",
        description: "Extract and summarize text from PDF files when the user asks.",
        body: "# PDF Tools\n\nUse the bundled script to extract text.",
        model: "haiku",
        tools: { allow: ["Bash"] },
        disableModelInvocation: false,
        resources: { "scripts/extract.sh": "#!/bin/sh\necho extracting\n" },
      },
    ],
    subagents: [
      {
        name: "reviewer",
        description: "Reviews code diffs for correctness bugs.",
        prompt: "You are a meticulous code reviewer. Find correctness bugs.",
        tools: { allow: ["Read", "Grep"] },
        model: "opus",
      },
    ],
  });
}

/** memory: a connector whose only payload is a memory entry. */
function buildMemoryConnector(): ResolvedConnector {
  return defineConnector({
    id: MEMORY_CONNECTOR_ID,
    displayName: "Acme Memory",
    version: "1.0.0",
    memory: [{ content: "Always prefer parameterized SQL." }],
  });
}

/** nativeHooks: a normalized PreToolUse hook + one CodeBuddy-native passthrough. */
function nativeConnector(): ResolvedConnector {
  return defineConnector({
    id: NATIVE_CONNECTOR_ID,
    displayName: "Acme Native",
    version: "1.0.0",
    hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
    platforms: {
      codebuddy: {
        nativeHooks: { WorktreeCreate: { matcher: "*", handler: () => ({}) } },
      },
    },
  });
}

// ── local helpers ────────────────────────────────────────────────────────────

/** Assert exit 0 + truthy stdout, then JSON.parse it (deny-shape slices). */
function parsed(reply: { exitCode: number; stdout?: string }) {
  expect(reply.exitCode).toBe(0);
  expect(reply.stdout).toBeTruthy();
  return JSON.parse(reply.stdout as string) as Record<string, any>;
}

// Shared env isolation + the same-rules-for-every-host baseline contract.
// extraKeys: the render slice mutates ACME_DB_DSN (the ${VAR} passthrough ref),
// and CODEBUDDY_CONFIG_DIR is the user-scope config-dir override we exercise.
isolateEnv([ENV_VAR, "CODEBUDDY_CONFIG_DIR"]);
createAdapterSuite({ adapter: codebuddyAdapter, paradigm: "json-stdio" });

// ── render + round-trip (.mcp.json mcpServers map + .codebuddy/settings.json) ──

describe("codebuddy adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-render-codebuddy-");
    process.env[ENV_VAR] = ENV_LITERAL;
    delete process.env.CODEBUDDY_CONFIG_DIR;
    ctx = buildCtx(projectDir, buildRenderConnector());
  });

  it("installServer writes mcpServers.<id> into project .mcp.json, serve-wrapped, env as native ${VAR} token", () => {
    const changes = codebuddyAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".mcp.json");
    expect(serverPath).toBe(codebuddyAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.type).toBe("stdio");

    // Telemetry serve-wrapper: command → home binary, real command after `--`,
    // and `--host codebuddy` bakes the install target.
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual([
      "serve",
      "--connector",
      CONNECTOR_ID,
      "--scope",
      "project",
      "--host",
      "codebuddy",
      "--",
      "npx",
      "-y",
      "@x/y",
    ]);

    // CodeBuddy keeps a NATIVE interpolation token (${VAR}) — secret not baked.
    expect(entry.env[ENV_VAR]).toBe(`\${${ENV_VAR}}`);
    expect(entry.env[ENV_VAR]).not.toContain("env:");
    expect(entry.env[ENV_VAR]).not.toBe(ENV_LITERAL);
    expect(entry.cwd).toBe(SERVER_CWD);
  });

  it("installHooks writes nested hooks.<event> entries referencing the home binary + connector id", () => {
    const changes = codebuddyAdapter.installHooks(ctx);
    expect(changes.every((c) => c.action !== "warn")).toBe(true);

    const settingsPath = join(projectDir, ".codebuddy", "settings.json");
    expect(settingsPath).toBe(codebuddyAdapter.getHookConfigPath(ctx));

    const cfg = readJson(settingsPath);
    const pre = cfg.hooks.PreToolUse;
    expect(Array.isArray(pre)).toBe(true);
    expect(pre[0].matcher).toBe("acme_query|acme_write");
    const cmd = pre[0].hooks[0].command;
    expect(cmd).toContain(HOME_BIN);
    expect(cmd).toContain("hook codebuddy PreToolUse");
    expect(cmd).toContain(`--connector ${CONNECTOR_ID}`);

    // SessionStart also registered (no matcher → empty string).
    expect(cfg.hooks.SessionStart[0].matcher).toBe("");
    expect(cfg.hooks.SessionStart[0].hooks[0].command).toContain("hook codebuddy SessionStart");
  });

  it("installServer / installHooks are idempotent (skip on second run) and uninstall reverses them", () => {
    codebuddyAdapter.installServer(ctx);
    expect(codebuddyAdapter.installServer(ctx)[0]?.action).toBe("skip");
    codebuddyAdapter.installHooks(ctx);
    expect(codebuddyAdapter.installHooks(ctx).every((c) => c.action === "skip")).toBe(true);

    codebuddyAdapter.uninstallServer(ctx);
    expect(readJson(join(projectDir, ".mcp.json")).mcpServers?.[CONNECTOR_ID]).toBeUndefined();

    codebuddyAdapter.uninstallHooks(ctx);
    const settings = readJson(join(projectDir, ".codebuddy", "settings.json"));
    // Our inner commands stripped → the event buckets are emptied/removed.
    const pre = settings.hooks?.PreToolUse ?? [];
    expect(pre).toHaveLength(0);
  });

  it("http server → { type:'http', url } with the native ${VAR} token preserved (no serve-wrap)", () => {
    const httpCtx = buildCtx(projectDir, httpConnector());
    codebuddyAdapter.installServer(httpCtx);
    const entry = readJson(join(projectDir, ".mcp.json")).mcpServers[CONNECTOR_ID];
    expect(entry.type).toBe("http");
    expect(entry.url).toBe("https://mcp.example.com/v1");
    expect(entry.command).toBeUndefined();
  });
});

// ── user scope: ~/.codebuddy.json + ~/.codebuddy/settings.json + $CODEBUDDY_CONFIG_DIR ──

describe("codebuddy adapter — user scope + config-dir override", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject("ac-codebuddy-user-"));
    delete process.env.CODEBUDDY_CONFIG_DIR;
  });

  it("user scope: MCP → ~/.codebuddy.json, hooks → ~/.codebuddy/settings.json", () => {
    const ctx = buildCtx(projectDir, buildRenderConnector(), "user");
    expect(codebuddyAdapter.getServerConfigPath(ctx)).toBe(join(home, ".codebuddy.json"));
    expect(codebuddyAdapter.getHookConfigPath(ctx)).toBe(
      join(home, ".codebuddy", "settings.json"),
    );
  });

  it("CODEBUDDY_CONFIG_DIR redirects the user config dir for hooks (and config dir)", () => {
    const custom = join(home, "custom-codebuddy");
    process.env.CODEBUDDY_CONFIG_DIR = custom;
    const ctx = buildCtx(projectDir, buildRenderConnector(), "user");
    expect(codebuddyAdapter.getHookConfigPath(ctx)).toBe(join(custom, "settings.json"));
    // The user MCP file stays ~/.codebuddy.json (a homedir-level file, not under
    // the config dir — bundle-confirmed `eF=".codebuddy.json"` at homedir).
    expect(codebuddyAdapter.getServerConfigPath(ctx)).toBe(join(home, ".codebuddy.json"));
  });
});

// ── content surfaces: commands / skills / subagents ───────────────────────────
// Bundle-confirmed dirs: <configDir>/{commands,skills,agents}. Renderers are the
// shared claude-code ones, so frontmatter is byte-identical to Claude Code.

describe("codebuddy adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-codebuddy-surfaces-");
    delete process.env.CODEBUDDY_CONFIG_DIR;
    ctx = buildCtx(projectDir, buildSurfacesConnector());
  });

  it("installCommands writes <configDir>/commands/<name>.md with Claude-shaped frontmatter", () => {
    const changes = codebuddyAdapter.installCommands!(ctx);
    expect(changes[0]?.action).toBe("create");
    const p = join(projectDir, ".codebuddy", "commands", "deploy.md");
    expect(changes[0]?.path).toBe(p);
    const { frontmatter, body } = splitFrontmatter(readFileSync(p, "utf8"));
    expect(frontmatter.description).toBe("Deploy the app to an environment.");
    expect(frontmatter["argument-hint"]).toBe("[environment]");
    expect(frontmatter["allowed-tools"]).toBe("Bash, Read");
    expect(frontmatter.model).toBe("sonnet");
    expect(body).toContain("Deploy to $ARGUMENTS");
  });

  it("installSkills writes <configDir>/skills/<name>/SKILL.md + resource files", () => {
    codebuddyAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".codebuddy", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".codebuddy", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);
    const { frontmatter } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter["allowed-tools"]).toBe("Bash");
  });

  it("installSubagents writes <configDir>/agents/<name>.md", () => {
    codebuddyAdapter.installSubagents!(ctx);
    const p = join(projectDir, ".codebuddy", "agents", "reviewer.md");
    expect(existsSync(p)).toBe(true);
    const { frontmatter } = splitFrontmatter(readFileSync(p, "utf8"));
    expect(frontmatter.name).toBe("reviewer");
    expect(frontmatter.tools).toBe("Read, Grep");
    expect(frontmatter.model).toBe("opus");
  });

  it("content surfaces are idempotent (skip) and reversible (uninstall removes files)", () => {
    codebuddyAdapter.installCommands!(ctx);
    expect(codebuddyAdapter.installCommands!(ctx).every((c) => c.action === "skip")).toBe(true);
    codebuddyAdapter.installSkills!(ctx);
    codebuddyAdapter.installSubagents!(ctx);

    codebuddyAdapter.uninstallCommands!(ctx);
    codebuddyAdapter.uninstallSkills!(ctx);
    codebuddyAdapter.uninstallSubagents!(ctx);
    expect(existsSync(join(projectDir, ".codebuddy", "commands", "deploy.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".codebuddy", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".codebuddy", "agents", "reviewer.md"))).toBe(false);
  });
});

// ── memory surface: CODEBUDDY.md (exception host — NOT AGENTS.md) ──────────────

describe("codebuddy adapter — memory surface (CODEBUDDY.md)", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = freshProject("ac-codebuddy-memory-");
    delete process.env.CODEBUDDY_CONFIG_DIR;
  });

  it("declares supportsMemory and writes a managed block into project CODEBUDDY.md (not AGENTS.md)", () => {
    expect(codebuddyAdapter.capabilities.supportsMemory).toBe(true);
    const ctx = buildCtx(projectDir, buildMemoryConnector(), "project");
    const changes = codebuddyAdapter.installMemory!(ctx);
    expect(changes.some((c) => c.action === "create" || c.action === "update")).toBe(true);

    const memPath = join(projectDir, "CODEBUDDY.md");
    expect(existsSync(memPath)).toBe(true);
    expect(existsSync(join(projectDir, "AGENTS.md"))).toBe(false);
    const text = readFileSync(memPath, "utf8");
    expect(text).toContain("Always prefer parameterized SQL.");
    expect(text).toContain(`agent-connector:begin ${MEMORY_CONNECTOR_ID}/memory`);
  });

  it("user scope targets <configDir>/CODEBUDDY.md (honors CODEBUDDY_CONFIG_DIR)", () => {
    const { home, projectDir: proj } = freshHomeProject("ac-codebuddy-mem-user-");
    delete process.env.CODEBUDDY_CONFIG_DIR;
    const ctx = buildCtx(proj, buildMemoryConnector(), "user");
    codebuddyAdapter.installMemory!(ctx);
    expect(existsSync(join(home, ".codebuddy", "CODEBUDDY.md"))).toBe(true);
  });

  it("memory is idempotent (second install → skip) and reversible (uninstall removes the block)", () => {
    const ctx = buildCtx(projectDir, buildMemoryConnector(), "project");
    codebuddyAdapter.installMemory!(ctx);
    const second = codebuddyAdapter.installMemory!(ctx);
    expect(second.some((c) => c.action === "skip")).toBe(true);

    codebuddyAdapter.uninstallMemory!(ctx);
    const memPath = join(projectDir, "CODEBUDDY.md");
    const text = existsSync(memPath) ? readFileSync(memPath, "utf8") : "";
    expect(text).not.toContain(`agent-connector:begin ${MEMORY_CONNECTOR_ID}/memory`);
  });
});

// ── nativeHooks passthrough (verbatim CodeBuddy-native event-name entries) ─────

describe("codebuddy adapter — nativeHooks passthrough", () => {
  beforeEach(() => {
    delete process.env.CODEBUDDY_CONFIG_DIR;
  });

  it("declares supportsNativeHooks true", () => {
    expect(codebuddyAdapter.capabilities.supportsNativeHooks).toBe(true);
  });

  it("installHooks writes the native event-name entry VERBATIM beside the canonical one", () => {
    const projectDir = freshProject("ac-codebuddy-native-");
    const ctx = buildCtx(projectDir, nativeConnector());
    codebuddyAdapter.installHooks(ctx);

    const cfg = readJson(join(projectDir, ".codebuddy", "settings.json"));
    expect(cfg.hooks.PreToolUse[0].hooks[0].command).toContain("hook codebuddy PreToolUse");
    const wt = cfg.hooks.WorktreeCreate;
    expect(Array.isArray(wt)).toBe(true);
    expect(wt[0].matcher).toBe("*");
    expect(wt[0].hooks[0].command).toContain("hook codebuddy WorktreeCreate");
    expect(wt[0].hooks[0].command).toContain(`--connector ${NATIVE_CONNECTOR_ID}`);
  });
});

// ── deny shapes + parseEvent (Claude-fork wire contract) ──────────────────────
// CodeBuddy reuses claude-code/wire: snake_case stdin fields + the
// hookSpecificOutput reply envelope (Stop-class deny uses top-level decision:"block").

describe("codebuddy formatReply / parseEvent (Claude-shaped)", () => {
  it("PreToolUse deny → exit 0 + hookSpecificOutput.permissionDecision 'deny'", () => {
    const out = parsed(
      codebuddyAdapter.formatReply!("PreToolUse", { decision: "deny", reason: "blocked by policy" }),
    );
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("blocked by policy");
  });

  it("Stop / UserPromptSubmit / PostToolUse deny → top-level decision:'block' (NOT permissionDecision)", () => {
    for (const event of ["Stop", "UserPromptSubmit", "PostToolUse"] as const) {
      const out = parsed(
        codebuddyAdapter.formatReply!(event, { decision: "deny", reason: "keep going" }),
      );
      expect(out.decision, `${event}`).toBe("block");
      expect(out.reason).toBe("keep going");
      expect(out.hookSpecificOutput).toBeUndefined();
    }
  });

  it("PreToolUse modify → updatedInput; ask → permissionDecision 'ask'; allow → exit 0 empty", () => {
    const mod = parsed(
      codebuddyAdapter.formatReply!("PreToolUse", {
        decision: "modify",
        updatedInput: { sql: "SELECT 1" },
      }),
    );
    expect(mod.hookSpecificOutput.updatedInput).toEqual({ sql: "SELECT 1" });

    const ask = parsed(
      codebuddyAdapter.formatReply!("PreToolUse", { decision: "ask", reason: "confirm?" }),
    );
    expect(ask.hookSpecificOutput.permissionDecision).toBe("ask");

    const allow = codebuddyAdapter.formatReply!("PreToolUse", { decision: "allow" });
    expect(allow.exitCode).toBe(0);
    expect(allow.stdout).toBeUndefined();
  });

  it("PermissionRequest deny → nested decision{behavior:'deny'}; PostToolUseFailure context → additionalContext", () => {
    const perm = parsed(
      codebuddyAdapter.formatReply!("PermissionRequest", { decision: "deny", reason: "no" }),
    );
    expect(perm.hookSpecificOutput.decision.behavior).toBe("deny");
    expect(perm.hookSpecificOutput.decision.message).toBe("no");

    const fail = parsed(
      codebuddyAdapter.formatReply!("PostToolUseFailure", {
        decision: "context",
        additionalContext: "retry with --force",
      }),
    );
    expect(fail.hookSpecificOutput.additionalContext).toBe("retry with --force");
  });

  it("parseEvent normalizes a PreToolUse payload (snake_case fields + transcript session id)", () => {
    const ev = codebuddyAdapter.parseEvent!("PreToolUse", {
      session_id: "sess-1",
      cwd: "/work/proj",
      hook_event_name: "PreToolUse",
      tool_name: "acme_query",
      tool_input: { sql: "SELECT 1" },
      connector: CONNECTOR_ID,
    }) as PreToolUseEvent;
    expect(ev.hostPlatform).toBe("codebuddy");
    expect(ev.connectorId).toBe(CONNECTOR_ID);
    expect(ev.toolName).toBe("acme_query");
    expect(ev.toolInput).toEqual({ sql: "SELECT 1" });
    expect(ev.sessionId).toBe("sess-1");
    expect(ev.projectDir).toBe("/work/proj");
  });

  it("parseEvent normalizes PostToolUseFailure (error string) and SubagentStop (last_assistant_message)", () => {
    const fail = codebuddyAdapter.parseEvent!("PostToolUseFailure", {
      session_id: "s",
      tool_name: "Shell",
      tool_input: { command: "make" },
      error: "exit status 2",
    }) as PostToolUseFailureEvent;
    expect(fail.error).toBe("exit status 2");
    expect(fail.toolName).toBe("Shell");

    const stop = codebuddyAdapter.parseEvent!("SubagentStop", {
      session_id: "s",
      agent_id: "a1",
      last_assistant_message: "all green",
    }) as SubagentStopEvent;
    expect(stop.agentId).toBe("a1");
    expect(stop.lastAssistantMessage).toBe("all green");
  });
});
