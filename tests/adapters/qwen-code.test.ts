/**
 * adapters/qwen-code.test.ts — the ONE per-host file for the Qwen Code adapter.
 *
 * qwen-code is a json-stdio host and a Gemini-CLI fork: its hook WIRE protocol is
 * Claude-compatible (PascalCase events, `hookSpecificOutput` reply wrapper) but —
 * unlike Gemini — the MCP TRANSPORT is selected by WHICH KEY is present, not a
 * `type` field (stdio → {command,args}, sse → {url}, streamable-HTTP → {httpUrl}).
 * Config surfaces:
 *   • MCP servers → <qwenDir>/settings.json, ROOT KEY "mcpServers"; env-refs have
 *                   NO native interpolation → resolved to LITERALS at install time.
 *   • Hooks       → the SAME settings.json, sibling "hooks" key, Claude-shaped
 *                   { matcher, hooks:[ { type:"command", command } ] } per
 *                   PascalCase event; nativeHooks event-name keys written VERBATIM.
 *   • Statusline  → settings.json NESTED `ui.statusLine` leaf, via the SAME
 *                   refcounted ownership ledger as configPatch (qwen-code is the
 *                   2nd v1 statusline host after claude-code).
 *   • Content     → <qwenDir>/{commands,skills,agents}: commands are TOML, skills
 *                   are <name>/SKILL.md + resources, subagents are md+frontmatter.
 *   • config dir  → user scope: ~/.qwen; project: <projectDir>/.qwen.
 *   • Reply       → JSON on stdout (exit 0): PreToolUse deny → permissionDecision;
 *                   PermissionRequest uses the nested decision{behavior} envelope
 *                   (updatedInput honored); PostToolUseFailure/SubagentStart →
 *                   additionalContext (deny degrades); SubagentStop deny →
 *                   TOP-LEVEL { decision:"block" }.
 *
 * This file consolidates what used to be split across qwen-code-native-hooks.test.ts
 * (nativeHooks passthrough), qwen-code-statusline.test.ts (statusline surface),
 * extended-events-hosts.test.ts (E1 events), surfaces-s1.test.ts (content
 * surfaces), wave2.test.ts (render/round-trip), and review-fixes.test.ts (remote
 * transport key). It uses the shared harness (tests/support/env + adapter-suite +
 * fs) per tests/README.md — ONE file per host. TOML commands are parsed with
 * @iarna/toml (the source's choice — readJson is JSON only); JSON files use readJson.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseToml } from "@iarna/toml";
import { beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import { buildHomeBinStatuslineCommand } from "../../src/core/spawn.js";
import { loadConfigPatchLedger } from "../../src/core/config-patch-ledger.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  PermissionRequestEvent,
  PostToolUseFailureEvent,
  PreToolUseEvent,
  ResolvedConnector,
  StatuslineDef,
  SubagentStartEvent,
  SubagentStopEvent,
} from "../../src/core/types.js";

import qwenAdapter from "../../src/adapters/qwen-code/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson, splitFrontmatter } from "../support/fs.js";

// ── shared fixtures ──────────────────────────────────────────────────────────

// render/round-trip (wave2) + E1 slices share the canonical "acme-db" id.
const CONNECTOR_ID = "acme-db";
// render's env-ref → settings.json literal resolution (qwen has no ${env:VAR}).
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const SERVER_CWD = "/srv/acme";
const PRE_MATCHER = "acme_query|acme_write";
// nativeHooks slice uses its own id.
const NATIVE_CONNECTOR_ID = "acme-qwen-native";
// skills slice uses its own id.
const SKILLS_CONNECTOR_ID = "acme-skills";
// content-surfaces slice uses its own id + fixtures.
const SURFACES_CONNECTOR_ID = "acme-surfaces";

// The serve-wrapper args bake the install TARGET platform as `--host <id>` (before
// `--`). qwen-code render is exercised at USER scope, so `--scope user`.
const wrappedArgsUser = (host: string): string[] => [
  "serve",
  "--connector",
  CONNECTOR_ID,
  "--scope",
  "user",
  "--host",
  host,
  "--",
  "npx",
  "-y",
  "@x/y",
];

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

/**
 * render (wave2): a stdio server (env-ref + cwd) + PreToolUse and SessionStart
 * hooks. SessionStart is supported by qwen, so both register.
 */
function buildRenderConnector(id = CONNECTOR_ID): ResolvedConnector {
  return defineConnector({
    id,
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
        matcher: PRE_MATCHER,
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

/** render (wave2): a hooks-only connector — used for the anchored-uninstall test. */
function buildHooksOnlyConnector(id: string): ResolvedConnector {
  return defineConnector({
    id,
    hooks: {
      PreToolUse: {
        handler() {
          return { decision: "allow" };
        },
      },
    },
  });
}

/** review-fixes: a server-only connector (overridable server) for the remote-key tests. */
function buildRemoteConnector(
  overrides: Partial<Parameters<typeof defineConnector>[0]> = {},
): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@x/y"],
    },
    hooks: {
      PreToolUse: { handler: () => ({ decision: "allow" }) },
      SessionStart: { handler: () => ({ decision: "allow" }) },
    },
    ...overrides,
  });
}

/** nativeHooks: a normalized PreToolUse hook + a qwen-native TodoCreated key. */
function nativeConnector(): ResolvedConnector {
  return defineConnector({
    id: NATIVE_CONNECTOR_ID,
    hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
    platforms: {
      "qwen-code": { nativeHooks: { TodoCreated: { matcher: "", handler: () => ({}) } } },
    },
  });
}

/** E1: a hooks-only connector declaring ALL FOUR E1 events (plus PreToolUse). */
function buildE1Connector(id = CONNECTOR_ID): ResolvedConnector {
  return defineConnector({
    id,
    hooks: {
      PreToolUse: {
        handler() {
          return { decision: "allow" };
        },
      },
      PermissionRequest: {
        matcher: "Bash",
        handler() {
          return { decision: "ask" };
        },
      },
      PostToolUseFailure: {
        handler() {
          return { decision: "context", additionalContext: "failure noted" };
        },
      },
      SubagentStart: {
        handler() {
          return { decision: "context", additionalContext: "subagent ctx" };
        },
      },
      SubagentStop: {
        matcher: "code-reviewer",
        handler() {
          return { decision: "deny", reason: "keep going" };
        },
      },
    },
  });
}

/** skills: a connector whose only payload is the SKILL fixture. */
function buildSkillsConnector(): ResolvedConnector {
  return defineConnector({
    id: SKILLS_CONNECTOR_ID,
    displayName: "Acme Skills",
    version: "1.0.0",
    skills: [
      {
        ...SKILL,
        tools: { allow: [...SKILL.tools.allow] },
        resources: { ...SKILL.resources },
      },
    ],
  });
}

/** content surfaces: a connector declaring a command + skill (resource) + subagent. */
function buildSurfacesConnector(): ResolvedConnector {
  return defineConnector({
    id: SURFACES_CONNECTOR_ID,
    displayName: "Acme Surfaces",
    version: "1.0.0",
    commands: [{ ...COMMAND, tools: { allow: [...COMMAND.tools.allow] } }],
    skills: [
      {
        ...SKILL,
        tools: { allow: [...SKILL.tools.allow] },
        resources: { ...SKILL.resources },
      },
    ],
    subagents: [{ ...SUBAGENT, tools: { allow: [...SUBAGENT.tools.allow] } }],
  });
}

/** statusline: a connector whose only payload is a status line. */
function statuslineConnector(id: string, def: StatuslineDef): ResolvedConnector {
  return defineConnector({ id, statusline: def });
}

// ── local helpers ────────────────────────────────────────────────────────────

function parsed(reply: { stdout?: string }): Record<string, any> {
  return JSON.parse(reply.stdout ?? "{}");
}

function readHooks(ctx: InstallContext): Record<string, any[]> {
  const file = readJson(qwenAdapter.getHookConfigPath!(ctx));
  return (file.hooks ?? {}) as Record<string, any[]>;
}

// Shared env isolation + the same-rules-for-every-host baseline contract.
// extraKeys: the render/round-trip slice mutates ACME_DB_DSN (the ${env:VAR} →
// settings.json literal). HOME/USERPROFILE/AGENT_CONNECTOR_DATA_DIR are isolateEnv
// defaults.
isolateEnv([ENV_VAR]);
createAdapterSuite({ adapter: qwenAdapter, paradigm: "json-stdio" });

// ── render + round-trip (mcpServers + sibling "hooks" in the SAME settings.json) ─

describe("qwen-code adapter render + round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave2-qwen-");
    // Set the env-ref var so qwen literal-resolution produces a known value.
    process.env[ENV_VAR] = ENV_LITERAL;
    // user scope → ~/.qwen/settings.json resolves into the HOME sandbox.
    ctx = buildCtx(projectDir, buildRenderConnector(), "user");
  });

  it("installServer writes mcpServers.<id> (type stdio) into ~/.qwen/settings.json, wrapped, env LITERAL", () => {
    const changes = qwenAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".qwen", "settings.json");
    expect(serverPath).toBe(qwenAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.type).toBe("stdio");

    // Telemetry serve-wrapper: command points at the home binary.
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedArgsUser("qwen-code"));

    // Qwen has no ${env:VAR} support → env-ref resolves to a LITERAL value.
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
    expect(entry.cwd).toBe(SERVER_CWD);
  });

  it("installHooks writes the sibling 'hooks' key in the SAME settings.json (PascalCase, nested shape)", () => {
    const changes = qwenAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const settingsPath = join(projectDir, ".qwen", "settings.json");
    expect(settingsPath).toBe(qwenAdapter.getHookConfigPath(ctx));

    const cfg = readJson(settingsPath);
    // PascalCase event keys, identical to Claude — NOT Gemini's BeforeTool.
    const pre = cfg.hooks.PreToolUse;
    expect(Array.isArray(pre)).toBe(true);
    expect(pre[0].matcher).toBe(PRE_MATCHER);
    const cmd = pre[0].hooks[0].command;
    expect(cmd).toContain(HOME_BIN);
    expect(cmd).toContain("hook qwen-code PreToolUse");
    expect(cmd).toContain(`--connector ${CONNECTOR_ID}`);

    // SessionStart is supported and registered under the canonical PascalCase name.
    expect(cfg.hooks.SessionStart[0].hooks[0].command).toContain(
      "hook qwen-code SessionStart",
    );
  });

  it("installServer + installHooks coexist in ONE settings.json; idempotent on a second run", () => {
    qwenAdapter.installServer(ctx);
    qwenAdapter.installHooks(ctx);

    const both = readJson(join(projectDir, ".qwen", "settings.json"));
    expect(both.mcpServers?.[CONNECTOR_ID]).toBeTruthy();
    expect(both.hooks?.PreToolUse).toBeTruthy();

    const secondServer = qwenAdapter.installServer(ctx);
    expect(secondServer[0]?.action).toBe("skip");
    const secondHooks = qwenAdapter.installHooks(ctx);
    expect(secondHooks.every((c) => c.action === "skip")).toBe(true);

    const cfg = readJson(join(projectDir, ".qwen", "settings.json"));
    expect(Object.keys(cfg.mcpServers)).toEqual([CONNECTOR_ID]);
    expect(cfg.hooks.PreToolUse).toHaveLength(1);
    expect(cfg.hooks.SessionStart).toHaveLength(1);
  });

  it("uninstallServer + uninstallHooks remove the entries (re-read confirms gone)", () => {
    qwenAdapter.installServer(ctx);
    qwenAdapter.installHooks(ctx);

    qwenAdapter.uninstallServer(ctx);
    const afterServer = readJson(join(projectDir, ".qwen", "settings.json"));
    expect(afterServer.mcpServers?.[CONNECTOR_ID]).toBeUndefined();
    // Removing the server must not disturb the hooks section.
    expect(afterServer.hooks?.PreToolUse).toBeTruthy();

    qwenAdapter.uninstallHooks(ctx);
    const afterHooks = readJson(join(projectDir, ".qwen", "settings.json"));
    expect(JSON.stringify(afterHooks.hooks ?? {})).not.toContain(HOME_BIN);
  });

  it("uninstallHooks removes via ANCHORED match — uninstalling 'acme' leaves 'acme-db' intact", () => {
    const acme = buildCtx(projectDir, buildHooksOnlyConnector("acme"), "user");
    const acmedb = buildCtx(projectDir, buildHooksOnlyConnector("acme-db"), "user");

    qwenAdapter.installHooks(acme);
    qwenAdapter.installHooks(acmedb);

    const settingsPath = qwenAdapter.getHookConfigPath(acmedb);
    let text = readFileSync(settingsPath, "utf8");
    expect(text).toContain("--connector acme-db");
    expect(text).toContain("--connector acme");

    // Remove only 'acme' — its id is a prefix of 'acme-db'.
    qwenAdapter.uninstallHooks(acme);

    text = readFileSync(settingsPath, "utf8");
    // acme-db must survive; the standalone 'acme' token must be gone.
    expect(text).toContain("--connector acme-db");
    expect(text).not.toContain('--connector acme"');

    // Doctor agrees: acme-db still registered, acme no longer.
    const acmedbHealthy = qwenAdapter
      .getHealthChecks!(acmedb)
      .find((c) => c.name.includes("hook command registered"))!
      .check();
    const acmeHealthy = qwenAdapter
      .getHealthChecks!(acme)
      .find((c) => c.name.includes("hook command registered"))!
      .check();
    expect(acmedbHealthy.status).toBe("OK");
    expect(acmeHealthy.status).toBe("FAIL");
  });

  it("parseEvent yields a normalized PreToolUse; formatReply(deny) → stdout hookSpecificOutput deny, exit 0", () => {
    const ev = qwenAdapter.parseEvent!("PreToolUse", {
      session_id: "sess-123",
      cwd: "/work/proj",
      hook_event_name: "PreToolUse",
      tool_name: "acme_query",
      tool_input: { sql: "SELECT 1" },
      connector: CONNECTOR_ID,
    }) as PreToolUseEvent;
    expect(ev.hostPlatform).toBe("qwen-code");
    expect(ev.connectorId).toBe(CONNECTOR_ID);
    expect(ev.toolName).toBe("acme_query");
    expect(ev.toolInput).toEqual({ sql: "SELECT 1" });
    expect(ev.sessionId).toBe("sess-123");

    const reply = qwenAdapter.formatReply!("PreToolUse", {
      decision: "deny",
      reason: "blocked by policy",
    });
    expect(reply.exitCode).toBe(0);
    const out = JSON.parse(reply.stdout!);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("blocked by policy");
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  });
});

// ── remote transport selected by KEY (Gemini-fork: httpUrl / url, no type) ─────

describe("qwen-code remote transport key", () => {
  it("a remote http server renders with key 'httpUrl' (NOT type:'http')", () => {
    const projectDir = freshProject("ac-rf-qwen-http-");
    const connector = buildRemoteConnector({
      server: { transport: "http", url: "https://mcp.example.com/mcp" },
    });
    const ctx = buildCtx(projectDir, connector);

    qwenAdapter.installServer(ctx);
    const cfg = readJson(qwenAdapter.getServerConfigPath(ctx));
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry.httpUrl).toBe("https://mcp.example.com/mcp");
    expect(entry.type).toBeUndefined();
    expect(entry.url).toBeUndefined();
  });

  it("an sse server renders with key 'url'", () => {
    const projectDir = freshProject("ac-rf-qwen-sse-");
    const connector = buildRemoteConnector({
      server: { transport: "sse", url: "https://mcp.example.com/sse" },
    });
    const ctx = buildCtx(projectDir, connector);

    qwenAdapter.installServer(ctx);
    const cfg = readJson(qwenAdapter.getServerConfigPath(ctx));
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry.url).toBe("https://mcp.example.com/sse");
    expect(entry.httpUrl).toBeUndefined();
    expect(entry.type).toBeUndefined();
  });
});

// ── nativeHooks passthrough (verbatim qwen-native event-name keys) ─────────────

describe("qwen-code adapter — nativeHooks passthrough", () => {
  it("declares supportsNativeHooks true", () => {
    expect(qwenAdapter.capabilities.supportsNativeHooks).toBe(true);
  });

  it("files the native TodoCreated key VERBATIM beside the canonical PreToolUse", () => {
    const projectDir = freshProject("ac-qwen-native-");
    const ctx = buildCtx(projectDir, nativeConnector(), "user");
    qwenAdapter.installHooks(ctx);
    const hooks = readHooks(ctx);
    expect(hooks.PreToolUse[0].hooks[0].command).toContain("hook qwen-code PreToolUse");
    expect(hooks.TodoCreated[0].hooks[0].command).toContain("hook qwen-code TodoCreated");
    expect(hooks.TodoCreated[0].hooks[0].command).toContain(`--connector ${NATIVE_CONNECTOR_ID}`);
  });

  it("nativeHooks install even when normalized hooks are disabled (hooks:false sibling)", () => {
    const projectDir = freshProject("ac-qwen-native-");
    const c = defineConnector({
      id: NATIVE_CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: { "qwen-code": { hooks: false, nativeHooks: { StopFailure: { handler: () => ({}) } } } },
    });
    const ctx = buildCtx(projectDir, c, "user");
    qwenAdapter.installHooks(ctx);
    const hooks = readHooks(ctx);
    expect(hooks.StopFailure[0].hooks[0].command).toContain("hook qwen-code StopFailure");
    expect(hooks.PreToolUse).toBeUndefined();
  });

  it("idempotent + uninstall strips the native key, leaving a foreign hook intact", () => {
    const projectDir = freshProject("ac-qwen-native-");
    const ctx = buildCtx(projectDir, nativeConnector(), "user");
    qwenAdapter.installHooks(ctx);
    expect(qwenAdapter.installHooks(ctx).every((c) => c.action === "skip")).toBe(true);

    const path = qwenAdapter.getHookConfigPath!(ctx);
    const file = readJson(path);
    file.hooks.TodoCreated.push({ matcher: "", hooks: [{ type: "command", command: "/usr/bin/other run" }] });
    writeFileSync(path, JSON.stringify(file));

    qwenAdapter.uninstallHooks(ctx);
    const flat = JSON.stringify(readHooks(ctx));
    expect(flat).toContain("other run");
    expect(flat).not.toContain(HOME_BIN);
  });
});

// ── E1 extension events (PermissionRequest / PostToolUseFailure / Subagent*) ───

describe("qwen-code E1 events", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-ext-qwen-");
    ctx = buildCtx(projectDir, buildE1Connector());
  });

  it("capabilities: all four E1 events native", () => {
    expect(qwenAdapter.capabilities.permissionRequest).toBe(true);
    expect(qwenAdapter.capabilities.postToolUseFailure).toBe(true);
    expect(qwenAdapter.capabilities.subagentStart).toBe(true);
    expect(qwenAdapter.capabilities.subagentStop).toBe(true);
  });

  it("installHooks registers all four natively, rendering connector matchers", () => {
    const changes = qwenAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "warn")).toBe(false);

    const settings = readJson(join(projectDir, ".qwen", "settings.json"));
    for (const event of [
      "PermissionRequest",
      "PostToolUseFailure",
      "SubagentStart",
      "SubagentStop",
    ]) {
      expect(settings.hooks[event]).toHaveLength(1);
      expect(settings.hooks[event][0].hooks[0].command).toContain(
        `hook qwen-code ${event}`,
      );
    }
    // Tool-name matcher (PermissionRequest) and agent-type matcher (SubagentStop)
    // pass through to the native registration.
    expect(settings.hooks.PermissionRequest[0].matcher).toBe("Bash");
    expect(settings.hooks.SubagentStop[0].matcher).toBe("code-reviewer");
  });

  it("parseEvent maps the Claude-identical wire fields (incl. quirks)", () => {
    const perm = qwenAdapter.parseEvent!("PermissionRequest", {
      session_id: "qw-1",
      tool_name: "WriteFile",
      tool_input: { file_path: "/tmp/a" },
      permission_suggestions: [{ behavior: "allow" }],
    }) as PermissionRequestEvent;
    expect(perm.toolName).toBe("WriteFile");
    expect(perm.permissionSuggestions).toEqual([{ behavior: "allow" }]);

    const fail = qwenAdapter.parseEvent!("PostToolUseFailure", {
      session_id: "qw-1",
      tool_name: "Bash",
      tool_input: { command: "make" },
      tool_use_id: "tu-1",
      error: "exit status 2",
      is_interrupt: false,
    }) as PostToolUseFailureEvent;
    expect(fail.error).toBe("exit status 2");
    expect(fail.toolUseId).toBe("tu-1");
    expect(fail.isInterrupt).toBe(false);
    // Qwen's failure payload has no duration_ms.
    expect(fail.durationMs).toBeUndefined();

    const start = qwenAdapter.parseEvent!("SubagentStart", {
      session_id: "qw-1",
      agent_id: "agent-1",
      agent_type: "Explorer",
    }) as SubagentStartEvent;
    expect(start.agentId).toBe("agent-1");
    expect(start.agentType).toBe("Explorer");

    // SubagentStop tolerates the missing-agent_type quirk.
    const stop = qwenAdapter.parseEvent!("SubagentStop", {
      session_id: "qw-1",
      agent_transcript_path: "/tmp/sub.jsonl",
      last_assistant_message: "done",
      stop_hook_active: false,
    }) as SubagentStopEvent;
    expect(stop.agentType).toBeUndefined();
    expect(stop.agentTranscriptPath).toBe("/tmp/sub.jsonl");
    expect(stop.lastAssistantMessage).toBe("done");
    expect(stop.stopHookActive).toBe(false);
  });

  it("formatReply PermissionRequest: nested decision envelope; updatedInput honored", () => {
    const deny = parsed(
      qwenAdapter.formatReply!("PermissionRequest", {
        decision: "deny",
        reason: "blocked",
      }),
    );
    expect(deny.hookSpecificOutput.decision).toEqual({
      behavior: "deny",
      message: "blocked",
    });
    expect(deny.decision).toBeUndefined();

    const allow = parsed(
      qwenAdapter.formatReply!("PermissionRequest", {
        decision: "allow",
        updatedInput: { command: "ls -la" },
      }),
    );
    expect(allow.hookSpecificOutput.decision).toEqual({
      behavior: "allow",
      updatedInput: { command: "ls -la" },
    });

    const modify = parsed(
      qwenAdapter.formatReply!("PermissionRequest", {
        decision: "modify",
        updatedInput: { command: "git status" },
      }),
    );
    expect(modify.hookSpecificOutput.decision.behavior).toBe("allow");
    expect(modify.hookSpecificOutput.decision.updatedInput).toEqual({
      command: "git status",
    });

    // ask / void-normalized {} fall through to the native dialog.
    expect(qwenAdapter.formatReply!("PermissionRequest", { decision: "ask" }).stdout).toBeUndefined();
    expect(qwenAdapter.formatReply!("PermissionRequest", {}).stdout).toBeUndefined();
  });

  it("formatReply PostToolUseFailure/SubagentStart are feedback-only (deny degrades)", () => {
    const failCtx = parsed(
      qwenAdapter.formatReply!("PostToolUseFailure", {
        decision: "context",
        additionalContext: "retry with --force",
      }),
    );
    expect(failCtx.hookSpecificOutput.hookEventName).toBe("PostToolUseFailure");
    expect(failCtx.hookSpecificOutput.additionalContext).toBe("retry with --force");

    const failDeny = parsed(
      qwenAdapter.formatReply!("PostToolUseFailure", {
        decision: "deny",
        reason: "not blockable — degrade",
      }),
    );
    expect(failDeny.decision).toBeUndefined();
    expect(failDeny.hookSpecificOutput.additionalContext).toBe("not blockable — degrade");

    const startCtx = parsed(
      qwenAdapter.formatReply!("SubagentStart", {
        decision: "context",
        additionalContext: "conventions in CONTRIBUTING.md",
      }),
    );
    expect(startCtx.hookSpecificOutput.hookEventName).toBe("SubagentStart");
    expect(startCtx.hookSpecificOutput.additionalContext).toBe(
      "conventions in CONTRIBUTING.md",
    );
  });

  it("formatReply SubagentStop deny → TOP-LEVEL block (Stop semantics)", () => {
    const out = parsed(
      qwenAdapter.formatReply!("SubagentStop", {
        decision: "deny",
        reason: "verify before stopping",
      }),
    );
    expect(out.decision).toBe("block");
    expect(out.reason).toBe("verify before stopping");
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it("formatReply legacy deny shape is unchanged for the original events", () => {
    // Regression guard: the SubagentStop top-level block must not leak into the
    // pre-E1 deny path (PreToolUse keeps permissionDecision).
    const out = parsed(
      qwenAdapter.formatReply!("PreToolUse", { decision: "deny", reason: "no" }),
    );
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.decision).toBeUndefined();
  });
});

// ── statusline (HUD) surface — nested ui.statusLine via the ownership ledger ───

describe("qwen-code adapter — statusline", () => {
  let projectDir: string;
  let dataRoot: string;

  beforeEach(() => {
    projectDir = freshProject("ac-qsl-");
    dataRoot = join(projectDir, ".agent-connector-sl");
  });

  /** Project-scope statusline ctx with an isolated data root for the ledger. */
  function slCtx(connector: ResolvedConnector): InstallContext {
    return buildCtx(projectDir, connector, { scope: "project", dataRoot });
  }

  /** Project-scope Qwen settings.json: <projectDir>/.qwen/settings.json. */
  function settingsPath(): string {
    return join(projectDir, ".qwen", "settings.json");
  }

  function readSettings(): Record<string, any> {
    return readJson(settingsPath());
  }

  function writeSettings(data: unknown): void {
    mkdirSync(join(projectDir, ".qwen"), { recursive: true });
    writeFileSync(settingsPath(), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  it("advertises supportsStatusline === true", () => {
    expect(qwenAdapter.capabilities.supportsStatusline).toBe(true);
  });

  it("installs the ownership-tracked ui.statusLine.command (ledger row, prior absent)", () => {
    const connector = statuslineConnector("sl-install", { render: () => "x" });
    const changes = qwenAdapter.installStatusline!(slCtx(connector));
    expect(changes.some((c) => c.action === "create")).toBe(true);

    // Nested under `ui` with type:"command" and OUR home-bin command.
    const settings = readSettings();
    expect(settings.ui.statusLine).toEqual({
      type: "command",
      command: buildHomeBinStatuslineCommand(HOME_BIN, "qwen-code", "sl-install"),
    });

    // The ledger has a refcounted ownership row keyed on the NESTED leaf path.
    const ledger = loadConfigPatchLedger(dataRoot);
    const entry = ledger.entries.find(
      (e) => e.platform === "qwen-code" && e.key === "ui.statusLine",
    );
    expect(entry).toBeTruthy();
    expect(entry!.prior).toEqual({ present: false });
    expect(entry!.owners.map((o) => o.connectorId)).toContain("sl-install");
  });

  it("creates the `ui` intermediate when absent (set-if-absent on the leaf)", () => {
    // No settings file at all — install must create ui + the statusLine leaf.
    const connector = statuslineConnector("sl-mkdir", { render: () => "x" });
    qwenAdapter.installStatusline!(slCtx(connector));
    const settings = readSettings();
    expect(typeof settings.ui).toBe("object");
    expect(settings.ui.statusLine.type).toBe("command");
  });

  it("preserves sibling user keys under `ui` and at top level", () => {
    writeSettings({ theme: "dark", ui: { hideTips: true } });
    const connector = statuslineConnector("sl-merge", { render: () => "x" });
    qwenAdapter.installStatusline!(slCtx(connector));
    const settings = readSettings();
    expect(settings.theme).toBe("dark");
    expect(settings.ui.hideTips).toBe(true);
    expect(settings.ui.statusLine.type).toBe("command");
  });

  it("is idempotent on re-install (skip, no duplicate)", () => {
    const connector = statuslineConnector("sl-idem", { render: () => "x" });
    qwenAdapter.installStatusline!(slCtx(connector));
    const second = qwenAdapter.installStatusline!(slCtx(connector));
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall reverses (removes the key + drops the ledger row)", () => {
    const connector = statuslineConnector("sl-uninstall", { render: () => "x" });
    qwenAdapter.installStatusline!(slCtx(connector));
    expect(readSettings().ui.statusLine).toBeTruthy();

    const changes = qwenAdapter.uninstallStatusline!(slCtx(connector));
    expect(changes.some((c) => c.action === "remove")).toBe(true);
    expect(readSettings().ui.statusLine).toBeUndefined();

    const ledger = loadConfigPatchLedger(dataRoot);
    expect(ledger.entries.find((e) => e.key === "ui.statusLine")).toBeUndefined();
  });

  it("NEVER clobbers a pre-existing non-AC ui.statusLine (skip-warn)", () => {
    writeSettings({ ui: { statusLine: { type: "command", command: "my-own.sh" } } });
    const connector = statuslineConnector("sl-conflict", { render: () => "x" });
    const changes = qwenAdapter.installStatusline!(slCtx(connector));

    expect(changes.some((c) => c.action === "warn")).toBe(true);
    // The user's ui.statusLine is untouched.
    expect(readSettings().ui.statusLine).toEqual({
      type: "command",
      command: "my-own.sh",
    });
    // No ownership was taken on a key we did not create.
    const ledger = loadConfigPatchLedger(dataRoot);
    expect(ledger.entries.find((e) => e.key === "ui.statusLine")).toBeUndefined();
  });

  it("uninstall never deletes a non-AC ui.statusLine (no ownership recorded → skip)", () => {
    writeSettings({ ui: { statusLine: { type: "command", command: "my-own.sh" } } });
    const connector = statuslineConnector("sl-conflict2", { render: () => "x" });
    qwenAdapter.installStatusline!(slCtx(connector)); // skip-warn (not ours)
    const changes = qwenAdapter.uninstallStatusline!(slCtx(connector));
    expect(changes.every((c) => c.action === "skip")).toBe(true);
    expect(readSettings().ui.statusLine).toEqual({
      type: "command",
      command: "my-own.sh",
    });
  });

  it("skip-warns when `ui` exists but is not an object (never replace it)", () => {
    writeSettings({ ui: "dark" });
    const connector = statuslineConnector("sl-blocked", { render: () => "x" });
    const changes = qwenAdapter.installStatusline!(slCtx(connector));
    expect(changes.some((c) => c.action === "warn")).toBe(true);
    expect(readSettings().ui).toBe("dark");
  });

  it("per-platform statusline:false skips the install entirely", () => {
    const connector = defineConnector({
      id: "sl-disabled",
      statusline: { render: () => "x" },
      platforms: { "qwen-code": { statusline: false } },
    });
    const changes = qwenAdapter.installStatusline!(slCtx(connector));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(existsSync(settingsPath())).toBe(false);
  });

  it("skips silently when no statusline is declared", () => {
    const connector = defineConnector({
      id: "sl-none",
      commands: [{ name: "noop", prompt: "p" }],
    });
    const changes = qwenAdapter.installStatusline!(slCtx(connector));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toContain("no statusline");
  });
});

describe("qwen-code adapter — statusline parse/format", () => {
  it("parseStatusInput maps Qwen's documented statusLine stdin JSON", () => {
    const raw = {
      session_id: "sess-q",
      version: "0.14.3",
      model: { display_name: "Qwen3-Coder" },
      context_window: {
        context_window_size: 262144,
        used_percentage: 12.5,
        remaining_percentage: 87.5,
        current_usage: 32768,
        total_input_tokens: 30000,
        total_output_tokens: 2768,
      },
      workspace: { current_dir: "/home/dev/acme" },
      git: { branch: "main" },
    };
    const ctx = qwenAdapter.parseStatusInput!(raw);
    expect(ctx.host).toBe("qwen-code");
    expect(ctx.sessionId).toBe("sess-q");
    expect(ctx.cwd).toBe("/home/dev/acme");
    expect(ctx.model).toEqual({ displayName: "Qwen3-Coder" });
    expect(ctx.context).toEqual({
      maxTokens: 262144,
      usedTokens: 32768,
      percent: 12.5,
    });
    // Qwen has NO cost analog — cost must be undefined.
    expect(ctx.cost).toBeUndefined();
    // raw is the verbatim escape hatch (version/git/total_* etc.).
    expect(ctx.raw).toBe(raw);
  });

  it("parseStatusInput omits every field the payload does not carry (tolerant parser)", () => {
    const ctx = qwenAdapter.parseStatusInput!({});
    expect(ctx.host).toBe("qwen-code");
    expect(ctx.sessionId).toBeUndefined();
    expect(ctx.cwd).toBeUndefined();
    expect(ctx.model).toBeUndefined();
    expect(ctx.context).toBeUndefined();
    expect(ctx.cost).toBeUndefined();
  });

  it("parseStatusInput tolerates a partial context_window (only present fields mapped)", () => {
    const ctx = qwenAdapter.parseStatusInput!({
      context_window: { used_percentage: 40 },
    });
    expect(ctx.context).toEqual({ percent: 40 });
  });

  it("formatStatusOutput returns exit 0 + the rendered line on stdout", () => {
    expect(qwenAdapter.formatStatusOutput!("Qwen3-Coder /home/dev")).toEqual({
      exitCode: 0,
      stdout: "Qwen3-Coder /home/dev",
    });
  });
});

// ── content surfaces: commands (TOML) / skills (SKILL.md) / subagents (md+fm) ──

describe("qwen-code adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-surfaces-qwen-");
    ctx = buildCtx(projectDir, buildSurfacesConnector());
  });

  it("declares commands + skills + subagents", () => {
    expect(qwenAdapter.capabilities.supportsCommands).toBe(true);
    expect(qwenAdapter.capabilities.supportsSkills).toBe(true);
    expect(qwenAdapter.capabilities.supportsSubagents).toBe(true);
  });

  it("installCommands writes a TOML command (description + prompt)", () => {
    const changes = qwenAdapter.installCommands!(ctx);
    expect(changes[0]?.action).toBe("create");
    const cmdPath = join(projectDir, ".qwen", "commands", "deploy.toml");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);

    const toml = parseToml(readFileSync(cmdPath, "utf8")) as Record<string, unknown>;
    expect(toml.description).toBe("Deploy the app to an environment.");
    expect(toml.prompt).toBe(COMMAND.prompt);
  });

  it("installSubagents writes md+fm agents/<name>.md", () => {
    qwenAdapter.installSubagents!(ctx);
    const agentPath = join(projectDir, ".qwen", "agents", "reviewer.md");
    expect(existsSync(agentPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(agentPath, "utf8"));
    expect(frontmatter.name).toBe("reviewer");
    expect(frontmatter.tools).toBe("Read, Grep");
    expect(frontmatter.model).toBe("opus");
    expect(body.trim()).toBe(SUBAGENT.prompt);
  });

  it("installSkills writes SKILL.md under .qwen/skills/<name>/SKILL.md", () => {
    const changes = qwenAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");
    const skillMd = join(projectDir, ".qwen", "skills", "pdf-tools", "SKILL.md");
    expect(existsSync(skillMd)).toBe(true);
    const { frontmatter, body } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
    expect(frontmatter.model).toBe("haiku");
    expect(frontmatter["allowed-tools"]).toBe("Bash");
    expect(body).toContain("# PDF Tools");
  });

  it("installSkills is idempotent — second install yields skip", () => {
    qwenAdapter.installSkills!(ctx);
    expect(qwenAdapter.installSkills!(ctx).every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md", () => {
    qwenAdapter.installSkills!(ctx);
    qwenAdapter.uninstallSkills!(ctx);
    expect(existsSync(join(projectDir, ".qwen", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("is idempotent — second install yields skip (commands + subagents)", () => {
    qwenAdapter.installCommands!(ctx);
    qwenAdapter.installSubagents!(ctx);
    expect(qwenAdapter.installCommands!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(qwenAdapter.installSubagents!(ctx).every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall removes command + subagent files", () => {
    qwenAdapter.installCommands!(ctx);
    qwenAdapter.installSubagents!(ctx);
    qwenAdapter.uninstallCommands!(ctx);
    qwenAdapter.uninstallSubagents!(ctx);
    expect(existsSync(join(projectDir, ".qwen", "commands", "deploy.toml"))).toBe(false);
    expect(existsSync(join(projectDir, ".qwen", "agents", "reviewer.md"))).toBe(false);
  });
});

// ── skills surface (the dedicated skills slice — distinct id + frontmatter set) ─
// Verified dir: .qwen/skills/<name>/SKILL.md (project), ~/.qwen/skills/<name>/SKILL.md
// (user) — kilo-pi-ground-truth.md § "Already-known skills gaps".

describe("qwen-code adapter — skills surface", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = freshProject("ac-qwen-skills-");
  });

  it("declares supportsSkills: true", () => {
    expect(qwenAdapter.capabilities.supportsSkills).toBe(true);
  });

  it("installSkills (project scope) writes SKILL.md at .qwen/skills/<name>/SKILL.md", () => {
    const ctx = buildCtx(projectDir, buildSkillsConnector(), "project");
    const changes = qwenAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");

    const skillMd = join(projectDir, ".qwen", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
    expect(frontmatter.model).toBe("haiku");
    expect(frontmatter["allowed-tools"]).toBe("Bash");
    expect(frontmatter["disable-model-invocation"]).toBe(false);
    expect(body).toContain("# PDF Tools");
  });

  it("installSkills (project scope) writes resource files beside SKILL.md", () => {
    const ctx = buildCtx(projectDir, buildSkillsConnector(), "project");
    qwenAdapter.installSkills!(ctx);

    const resource = join(projectDir, ".qwen", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills (user scope) writes SKILL.md at ~/.qwen/skills/<name>/SKILL.md", () => {
    const ctx = buildCtx(projectDir, buildSkillsConnector(), "user");
    const changes = qwenAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");

    const skillMd = join(projectDir, ".qwen", "skills", "pdf-tools", "SKILL.md");
    expect(existsSync(skillMd)).toBe(true);
  });

  it("installSkills is idempotent — second install yields skip", () => {
    const ctx = buildCtx(projectDir, buildSkillsConnector(), "project");
    qwenAdapter.installSkills!(ctx);
    const second = qwenAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md and resource", () => {
    const ctx = buildCtx(projectDir, buildSkillsConnector(), "project");
    qwenAdapter.installSkills!(ctx);

    const skillMd = join(projectDir, ".qwen", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".qwen", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    qwenAdapter.uninstallSkills!(ctx);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(resource)).toBe(false);
  });

  it("skills disabled via platforms opt-out → skip", () => {
    const connector = defineConnector({
      id: SKILLS_CONNECTOR_ID,
      displayName: "Acme Skills",
      version: "1.0.0",
      skills: [{ ...SKILL, tools: { allow: [...SKILL.tools.allow] } }],
      platforms: { "qwen-code": { skills: false } },
    });
    const ctx = buildCtx(projectDir, connector, "project");
    const changes = qwenAdapter.installSkills!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
  });

  it("no skills declared → skip", () => {
    const connector = defineConnector({
      id: SKILLS_CONNECTOR_ID,
      displayName: "Acme Skills",
      version: "1.0.0",
      // Use a subagent so the connector has at least one surface (skills omitted).
      subagents: [{ name: "a", description: "d", prompt: "p" }],
    });
    const ctx = buildCtx(projectDir, connector, "project");
    const changes = qwenAdapter.installSkills!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
  });
});
