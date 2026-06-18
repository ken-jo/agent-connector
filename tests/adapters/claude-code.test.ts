/**
 * adapters/claude-code.test.ts — the ONE per-host file for the Claude Code adapter.
 *
 * claude-code is the canonical json-stdio host (PascalCase events,
 * `hookSpecificOutput` reply wrapper). Many other adapters reuse its renderers.
 * Config surfaces:
 *   • MCP servers → <projectDir>/.mcp.json, ROOT KEY "mcpServers" (object map
 *                   keyed by connector id); stdio entry { type:"stdio", command,
 *                   args, env? }; env-refs keep Claude's NATIVE ${VAR} token.
 *   • Hooks       → <configDir>/.claude/settings.json, { matcher, hooks:[
 *                   { type:"command", command } ] } per PascalCase event;
 *                   nativeHooks event-name keys are written VERBATIM.
 *   • Content     → <configDir>/.claude/{commands,skills,agents}: commands are
 *                   md+frontmatter; skills are <name>/SKILL.md (+ resources);
 *                   subagents are md+frontmatter.
 *   • Reply       → JSON on stdout (exit 0): PreToolUse deny/ask →
 *                   hookSpecificOutput.permissionDecision; Stop / UserPromptSubmit
 *                   / PostToolUse / SubagentStop deny → TOP-LEVEL
 *                   { decision:"block", reason }; PostToolUseFailure deny DEGRADES
 *                   to additionalContext; PermissionRequest uses the nested
 *                   decision{behavior} envelope (ask/void fall through to the
 *                   native dialog); SessionStart/PostToolUse context →
 *                   additionalContext.
 *
 * This file consolidates what used to be split across render.test.ts
 * (render/round-trip — claude-code was the last host left there),
 * claude-deny-shapes.test.ts (event-specific deny shapes + PermissionRequest
 * decision shapes), claude-extended-events-parse.test.ts (E1 parseEvent mapping),
 * and surfaces-claude.test.ts (content surfaces + health checks). It uses the
 * shared harness (tests/support/env + adapter-suite + fs) per tests/README.md —
 * ONE file per host. (The fleet INVARIANT tests/adapters/uninstall-collision.test.ts
 * also references claude-code but is not its per-host file and stays separate.)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  HookResponse,
  PermissionRequestEvent,
  PostToolUseFailureEvent,
  ResolvedConnector,
  SubagentStartEvent,
  SubagentStopEvent,
} from "../../src/core/types.js";

import claudeAdapter from "../../src/adapters/claude-code/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson, splitFrontmatter } from "../support/fs.js";

// ── shared fixtures ──────────────────────────────────────────────────────────

// The render/round-trip slice declares a stdio server with an env-ref so the
// native ${VAR} passthrough produces a known value.
const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";

// The content-surfaces slice uses its own connector id + fixtures.
const SURFACES_CONNECTOR_ID = "acme-surfaces";

/** render: a stdio server (env-ref) + a PreToolUse and SessionStart hook. */
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
        resources: {
          "scripts/extract.sh": "#!/bin/sh\necho extracting\n",
        },
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

// The E1 parseEvent slice shares a base payload across its events.
const COMMON = {
  session_id: "sess-ext",
  transcript_path: "/home/dev/.claude/projects/x/0a1b2c3d-0a1b-4c3d-8e5f-0a1b2c3d4e5f.jsonl",
  cwd: "/home/dev/acme",
};

// ── local helpers ────────────────────────────────────────────────────────────

/** Assert exit 0 + truthy stdout, then JSON.parse it (deny-shape slices). */
function parsed(reply: { exitCode: number; stdout?: string }) {
  expect(reply.exitCode).toBe(0);
  expect(reply.stdout).toBeTruthy();
  return JSON.parse(reply.stdout as string) as Record<string, unknown>;
}

// Shared env isolation + the same-rules-for-every-host baseline contract.
// extraKeys: the render/round-trip slice mutates ACME_DB_DSN (the ${VAR}
// passthrough ref). HOME/USERPROFILE/AGENT_CONNECTOR_DATA_DIR are covered by
// isolateEnv's defaults.
isolateEnv([ENV_VAR]);
createAdapterSuite({ adapter: claudeAdapter, paradigm: "json-stdio" });

// ── render + round-trip (.mcp.json mcpServers map + .claude/settings.json) ────

describe("claude-code adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-render-claude-");
    // Set the env-ref var so the native ${VAR} token assertion has a known value.
    process.env[ENV_VAR] = ENV_LITERAL;
    ctx = buildCtx(projectDir, buildRenderConnector());
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
      "--scope",
      "project",
      "--host",
      "claude-code",
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

  it("nativeHooks passthrough: capability flag + verbatim event-name keys beside normalized hooks", () => {
    expect(claudeAdapter.capabilities.supportsNativeHooks).toBe(true);

    const connector = defineConnector({
      id: CONNECTOR_ID,
      hooks: {
        PreToolUse: { matcher: "acme_query", handler: () => ({ decision: "allow" }) },
      },
      platforms: {
        "claude-code": {
          nativeHooks: {
            TaskCreated: {
              handler: () => ({ continue: false, stopReason: "no new tasks" }),
            },
            StopFailure: { matcher: "rate_limit", handler: () => {} },
          },
        },
      },
    });
    const nativeCtx = buildCtx(projectDir, connector);

    claudeAdapter.installHooks(nativeCtx);
    const cfg = readJson(join(projectDir, ".claude", "settings.json"));
    // Normalized + native entries coexist; native keys are written VERBATIM.
    expect(cfg.hooks.PreToolUse[0].hooks[0].command).toContain(
      "hook claude-code PreToolUse",
    );
    expect(cfg.hooks.TaskCreated[0].hooks[0].command).toContain(
      "hook claude-code TaskCreated",
    );
    expect(cfg.hooks.StopFailure[0].matcher).toBe("rate_limit");

    claudeAdapter.uninstallHooks(nativeCtx);
    const after = readJson(join(projectDir, ".claude", "settings.json"));
    expect(JSON.stringify(after.hooks ?? {})).not.toContain(HOME_BIN);
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

// ── deny shapes: Claude's deny shape is event-specific ────────────────────────
//
// Regression for a bug found porting oh-my-claudecode: formatReply rendered
// EVERY deny as hookSpecificOutput.permissionDecision, but Claude only honors
// that on PreToolUse. Stop / UserPromptSubmit / PostToolUse take the TOP-LEVEL
// {"decision":"block","reason"} — with the old shape, OMC ralph's Stop-deny
// persistence loop silently never blocked.

describe("claude-code formatReply deny shapes", () => {
  it("Stop deny → top-level {decision:'block'} (the ralph persistence contract)", () => {
    const out = parsed(
      claudeAdapter.formatReply!("Stop", { decision: "deny", reason: "boulder rolls on" }),
    );
    expect(out.decision).toBe("block");
    expect(out.reason).toBe("boulder rolls on");
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it("UserPromptSubmit deny → top-level block", () => {
    const out = parsed(
      claudeAdapter.formatReply!("UserPromptSubmit", { decision: "deny", reason: "nope" }),
    );
    expect(out.decision).toBe("block");
    expect(out.reason).toBe("nope");
  });

  it("PostToolUse deny → top-level block (reason fed back to the model)", () => {
    const out = parsed(
      claudeAdapter.formatReply!("PostToolUse", { decision: "deny", reason: "redo it" }),
    );
    expect(out.decision).toBe("block");
  });

  it("PreToolUse deny → hookSpecificOutput.permissionDecision (unchanged)", () => {
    const out = parsed(
      claudeAdapter.formatReply!("PreToolUse", { decision: "deny", reason: "blocked" }),
    );
    const hso = out.hookSpecificOutput as Record<string, unknown>;
    expect(hso.permissionDecision).toBe("deny");
    expect(hso.permissionDecisionReason).toBe("blocked");
    expect(out.decision).toBeUndefined();
  });

  it("PreToolUse ask stays a permissionDecision", () => {
    const out = parsed(
      claudeAdapter.formatReply!("PreToolUse", { decision: "ask", reason: "sure?" }),
    );
    const hso = out.hookSpecificOutput as Record<string, unknown>;
    expect(hso.permissionDecision).toBe("ask");
  });

  it("SubagentStop deny → top-level block (Stop semantics: keeps the subagent running)", () => {
    const out = parsed(
      claudeAdapter.formatReply!("SubagentStop", {
        decision: "deny",
        reason: "verify before stopping",
      }),
    );
    expect(out.decision).toBe("block");
    expect(out.reason).toBe("verify before stopping");
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it("PostToolUseFailure deny DEGRADES to additionalContext (not blockable)", () => {
    const out = parsed(
      claudeAdapter.formatReply!("PostToolUseFailure", {
        decision: "deny",
        reason: "retry with --force",
      }),
    );
    expect(out.decision).toBeUndefined();
    const hso = out.hookSpecificOutput as Record<string, unknown>;
    expect(hso.hookEventName).toBe("PostToolUseFailure");
    expect(hso.additionalContext).toBe("retry with --force");
  });

  it("SubagentStart context → additionalContext (observe-only)", () => {
    const out = parsed(
      claudeAdapter.formatReply!("SubagentStart", {
        decision: "context",
        additionalContext: "project conventions live in CONTRIBUTING.md",
      }),
    );
    const hso = out.hookSpecificOutput as Record<string, unknown>;
    expect(hso.hookEventName).toBe("SubagentStart");
    expect(hso.additionalContext).toBe("project conventions live in CONTRIBUTING.md");
  });
});

describe("claude-code formatReply PermissionRequest decision shapes", () => {
  function permissionDecision(out: Record<string, unknown>) {
    const hso = out.hookSpecificOutput as Record<string, unknown>;
    expect(hso.hookEventName).toBe("PermissionRequest");
    return hso.decision as Record<string, unknown>;
  }

  it("deny → hookSpecificOutput.decision{behavior:'deny', message}", () => {
    const out = parsed(
      claudeAdapter.formatReply!("PermissionRequest", {
        decision: "deny",
        reason: "secrets stay local",
      }),
    );
    const d = permissionDecision(out);
    expect(d.behavior).toBe("deny");
    expect(d.message).toBe("secrets stay local");
    expect(out.decision).toBeUndefined(); // never the top-level Stop block shape
  });

  it("explicit allow → ACTIVE grant decision{behavior:'allow'}", () => {
    const out = parsed(claudeAdapter.formatReply!("PermissionRequest", { decision: "allow" }));
    const d = permissionDecision(out);
    expect(d.behavior).toBe("allow");
    expect(d.updatedInput).toBeUndefined();
  });

  it("allow with updatedInput carries the replacement input", () => {
    const out = parsed(
      claudeAdapter.formatReply!("PermissionRequest", {
        decision: "allow",
        updatedInput: { cmd: "ls -la" },
      }),
    );
    const d = permissionDecision(out);
    expect(d.behavior).toBe("allow");
    expect(d.updatedInput).toEqual({ cmd: "ls -la" });
  });

  it("modify with updatedInput degrades to an allow grant carrying it", () => {
    const out = parsed(
      claudeAdapter.formatReply!("PermissionRequest", {
        decision: "modify",
        updatedInput: { cmd: "git status" },
      }),
    );
    const d = permissionDecision(out);
    expect(d.behavior).toBe("allow");
    expect(d.updatedInput).toEqual({ cmd: "git status" });
  });

  it("ask falls through to the native dialog (exit 0, NO decision output)", () => {
    const reply = claudeAdapter.formatReply!("PermissionRequest", {
      decision: "ask",
      reason: "the dialog IS the ask",
    });
    expect(reply.exitCode).toBe(0);
    expect(reply.stdout).toBeUndefined();
  });

  it("no decision (void-normalized {}) falls through — never an implied grant", () => {
    const reply = claudeAdapter.formatReply!("PermissionRequest", {});
    expect(reply.exitCode).toBe(0);
    expect(reply.stdout).toBeUndefined();
  });
});

// ── extended-events parse (E1: PermissionRequest / PostToolUseFailure /
//    SubagentStart / SubagentStop) ──────────────────────────────────────────
//
// Pins the snake_case → camelCase wire mapping, the optional-field handling
// (notably the real-world quirk that SubagentStop may arrive WITHOUT
// agent_type), and the shared base extraction (session id from the transcript
// path, projectDir from cwd).

describe("claude-code parseEvent — PermissionRequest", () => {
  it("maps tool_name/tool_input/permission_suggestions", () => {
    const evt = claudeAdapter.parseEvent!("PermissionRequest", {
      ...COMMON,
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /tmp/x" },
      permission_suggestions: [
        { type: "addRules", behavior: "allow", destination: "session" },
      ],
    }) as PermissionRequestEvent;

    expect(evt.hostPlatform).toBe("claude-code");
    expect(evt.toolName).toBe("Bash");
    expect(evt.toolInput).toEqual({ command: "rm -rf /tmp/x" });
    expect(evt.permissionSuggestions).toEqual([
      { type: "addRules", behavior: "allow", destination: "session" },
    ]);
    expect(evt.sessionId).toBe("0a1b2c3d-0a1b-4c3d-8e5f-0a1b2c3d4e5f");
    expect(evt.projectDir).toBe("/home/dev/acme");
  });

  it("omits permissionSuggestions when the host sends none", () => {
    const evt = claudeAdapter.parseEvent!("PermissionRequest", {
      ...COMMON,
      hook_event_name: "PermissionRequest",
      tool_name: "Read",
      tool_input: {},
    }) as PermissionRequestEvent;
    expect(evt.permissionSuggestions).toBeUndefined();
  });
});

describe("claude-code parseEvent — PostToolUseFailure", () => {
  it("maps error/tool_use_id/is_interrupt/duration_ms", () => {
    const evt = claudeAdapter.parseEvent!("PostToolUseFailure", {
      ...COMMON,
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "make test" },
      tool_use_id: "toolu_01",
      error: "exit status 2",
      is_interrupt: false,
      duration_ms: 1234,
    }) as PostToolUseFailureEvent;

    expect(evt.toolName).toBe("Bash");
    expect(evt.toolInput).toEqual({ command: "make test" });
    expect(evt.toolUseId).toBe("toolu_01");
    expect(evt.error).toBe("exit status 2");
    expect(evt.isInterrupt).toBe(false);
    expect(evt.durationMs).toBe(1234);
  });

  it("tolerates a minimal payload (error defaults to empty string)", () => {
    const evt = claudeAdapter.parseEvent!("PostToolUseFailure", {
      hook_event_name: "PostToolUseFailure",
      tool_name: "Write",
    }) as PostToolUseFailureEvent;
    expect(evt.error).toBe("");
    expect(evt.toolUseId).toBeUndefined();
    expect(evt.isInterrupt).toBeUndefined();
    expect(evt.durationMs).toBeUndefined();
  });
});

describe("claude-code parseEvent — SubagentStart", () => {
  it("maps agent_id/agent_type", () => {
    const evt = claudeAdapter.parseEvent!("SubagentStart", {
      ...COMMON,
      hook_event_name: "SubagentStart",
      agent_id: "agent-7",
      agent_type: "code-reviewer",
    }) as SubagentStartEvent;
    expect(evt.agentId).toBe("agent-7");
    expect(evt.agentType).toBe("code-reviewer");
  });
});

describe("claude-code parseEvent — SubagentStop", () => {
  it("maps the full payload incl. transcript path + last assistant message", () => {
    const evt = claudeAdapter.parseEvent!("SubagentStop", {
      ...COMMON,
      hook_event_name: "SubagentStop",
      agent_id: "agent-7",
      agent_type: "code-reviewer",
      agent_transcript_path: "/home/dev/.claude/projects/x/subagents/agent-7.jsonl",
      last_assistant_message: "review complete",
      stop_hook_active: true,
    }) as SubagentStopEvent;

    expect(evt.agentId).toBe("agent-7");
    expect(evt.agentType).toBe("code-reviewer");
    expect(evt.agentTranscriptPath).toBe(
      "/home/dev/.claude/projects/x/subagents/agent-7.jsonl",
    );
    expect(evt.lastAssistantMessage).toBe("review complete");
    expect(evt.stopHookActive).toBe(true);
  });

  it("tolerates the missing-agent_type quirk (SDK does not reliably send it)", () => {
    const evt = claudeAdapter.parseEvent!("SubagentStop", {
      ...COMMON,
      hook_event_name: "SubagentStop",
      last_assistant_message: "done",
    }) as SubagentStopEvent;
    expect(evt.agentId).toBeUndefined();
    expect(evt.agentType).toBeUndefined();
    expect(evt.lastAssistantMessage).toBe("done");
  });
});

// ── content surfaces: commands / skills / subagents (+ health checks) ─────────

describe("claude-code adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-claude-surfaces-");
    ctx = buildCtx(projectDir, buildSurfacesConnector());
  });

  it("declares support for all three content surfaces", () => {
    expect(claudeAdapter.capabilities.supportsCommands).toBe(true);
    expect(claudeAdapter.capabilities.supportsSkills).toBe(true);
    expect(claudeAdapter.capabilities.supportsSubagents).toBe(true);
  });

  // ── Commands ──────────────────────────────────────────────────────────────

  it("installCommands writes <configDir>/commands/<name>.md with correct frontmatter + body", () => {
    const changes = claudeAdapter.installCommands!(ctx);
    expect(changes[0]?.action).toBe("create");

    const cmdPath = join(projectDir, ".claude", "commands", "deploy.md");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(cmdPath, "utf8"));
    expect(frontmatter.description).toBe("Deploy the app to an environment.");
    expect(frontmatter["argument-hint"]).toBe("[environment]");
    expect(frontmatter["allowed-tools"]).toBe("Bash, Read");
    expect(frontmatter.model).toBe("sonnet");
    expect(body.trim()).toBe("Deploy to $ARGUMENTS and report the result.");
  });

  it("installCommands is idempotent — second call yields skip", () => {
    claudeAdapter.installCommands!(ctx);
    const second = claudeAdapter.installCommands!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("installCommands honors platforms['claude-code'].commands === false", () => {
    const disabled = defineConnector({
      id: SURFACES_CONNECTOR_ID,
      commands: [{ name: "deploy", prompt: "do it" }],
      platforms: { "claude-code": { commands: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    const changes = claudeAdapter.installCommands!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".claude", "commands", "deploy.md"))).toBe(false);
  });

  it("uninstallCommands removes the command file (re-read confirms gone)", () => {
    claudeAdapter.installCommands!(ctx);
    const cmdPath = join(projectDir, ".claude", "commands", "deploy.md");
    expect(existsSync(cmdPath)).toBe(true);

    const changes = claudeAdapter.uninstallCommands!(ctx);
    expect(changes[0]?.action).toBe("remove");
    expect(existsSync(cmdPath)).toBe(false);
  });

  // ── Skills ──────────────────────────────────────────────────────────────

  it("installSkills writes SKILL.md + resource with correct frontmatter + body", () => {
    const changes = claudeAdapter.installSkills!(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const skillMd = join(projectDir, ".claude", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".claude", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(
      "Extract and summarize text from PDF files when the user asks.",
    );
    expect(frontmatter.model).toBe("haiku");
    expect(frontmatter["allowed-tools"]).toBe("Bash");
    expect(frontmatter["disable-model-invocation"]).toBe(false);
    expect(body).toContain("# PDF Tools");

    // Resource written verbatim.
    expect(readFileSync(resource, "utf8")).toBe("#!/bin/sh\necho extracting\n");
  });

  it("installSkills is idempotent — second call yields skip", () => {
    claudeAdapter.installSkills!(ctx);
    const second = claudeAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes the skill dir contents (re-read confirms gone)", () => {
    claudeAdapter.installSkills!(ctx);
    const skillDir = join(projectDir, ".claude", "skills", "pdf-tools");
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);

    claudeAdapter.uninstallSkills!(ctx);
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(false);
    expect(existsSync(join(skillDir, "scripts", "extract.sh"))).toBe(false);
    expect(existsSync(skillDir)).toBe(false);
  });

  // ── Subagents ───────────────────────────────────────────────────────────────

  it("installSubagents writes <configDir>/agents/<name>.md with correct frontmatter + body", () => {
    const changes = claudeAdapter.installSubagents!(ctx);
    expect(changes[0]?.action).toBe("create");

    const agentPath = join(projectDir, ".claude", "agents", "reviewer.md");
    expect(changes[0]?.path).toBe(agentPath);
    expect(existsSync(agentPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(agentPath, "utf8"));
    expect(frontmatter.name).toBe("reviewer");
    expect(frontmatter.description).toBe("Reviews code diffs for correctness bugs.");
    expect(frontmatter.tools).toBe("Read, Grep");
    expect(frontmatter.model).toBe("opus");
    expect(body.trim()).toBe(
      "You are a meticulous code reviewer. Find correctness bugs.",
    );
  });

  it("installSubagents is idempotent — second call yields skip", () => {
    claudeAdapter.installSubagents!(ctx);
    const second = claudeAdapter.installSubagents!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSubagents removes the subagent file (re-read confirms gone)", () => {
    claudeAdapter.installSubagents!(ctx);
    const agentPath = join(projectDir, ".claude", "agents", "reviewer.md");
    expect(existsSync(agentPath)).toBe(true);

    const changes = claudeAdapter.uninstallSubagents!(ctx);
    expect(changes[0]?.action).toBe("remove");
    expect(existsSync(agentPath)).toBe(false);
  });

  // ── User scope path resolution ──────────────────────────────────────────

  it("user scope resolves surfaces under ~/.claude (HOME redirected to temp)", () => {
    const userCtx: InstallContext = { ...ctx, scope: "user" };
    claudeAdapter.installCommands!(userCtx);
    // freshProject points HOME at projectDir, so ~/.claude === projectDir/.claude
    expect(existsSync(join(projectDir, ".claude", "commands", "deploy.md"))).toBe(true);
  });

  // ── Health checks ──────────────────────────────────────────────────────

  it("getHealthChecks reports surface presence after install", () => {
    claudeAdapter.installCommands!(ctx);
    claudeAdapter.installSkills!(ctx);
    claudeAdapter.installSubagents!(ctx);

    const checks = claudeAdapter.getHealthChecks!(ctx);
    const byName = new Map(checks.map((c) => [c.name, c.check()]));
    expect(byName.get("Claude Code: command deploy present")?.status).toBe("OK");
    expect(byName.get("Claude Code: skill pdf-tools present")?.status).toBe("OK");
    expect(byName.get("Claude Code: subagent reviewer present")?.status).toBe("OK");
  });
});
