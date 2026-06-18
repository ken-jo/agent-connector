/**
 * adapters/cursor.test.ts — the ONE per-host file for the Cursor adapter.
 *
 * cursor is a json-stdio host. Config surfaces:
 *   • MCP servers → <configDir>/mcp.json, ROOT KEY "mcpServers" (object map keyed
 *                   by connector id, like windsurf); stdio entry { command, args,
 *                   env? }; env-refs keep Cursor's NATIVE ${env:VAR} token.
 *   • Hooks       → <configDir>/hooks.json, shape { version, hooks: { <cursorEvent>:
 *                   [ { command, matcher? } ] } } — FLAT command objects (no
 *                   { matcher, hooks:[...] } wrapper). Normalized events map to
 *                   lower-camel native keys (preToolUse, sessionStart, …);
 *                   nativeHooks event-name keys are written VERBATIM.
 *   • Content     → <configDir>/{commands,skills,agents}: commands are BODY-ONLY
 *                   .md (no frontmatter); skills are <name>/SKILL.md + resources;
 *                   subagents are md+frontmatter.
 *   • Reply       → JSON on stdout (exit 0): deny/ask → permission + user_message;
 *                   modify → updated_input; context → agent_message (PreToolUse) /
 *                   additional_context (Post/SessionStart); UserPromptSubmit is a
 *                   block gate ({ continue, user_message }); SessionEnd/PreCompact
 *                   are no-op passthroughs.
 *
 * This file consolidates what used to be split across cursor-native-hooks.test.ts
 * (nativeHooks passthrough), render.test.ts (render/round-trip),
 * surfaces-s1.test.ts (content surfaces), and extended-events-batch.test.ts (E1
 * extension + lifecycle/prompt events). It uses the shared harness
 * (tests/support/env + adapter-suite + fs) per tests/README.md — ONE file per host.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  HookResponse,
  PostToolUseFailureEvent,
  PreCompactEvent,
  ResolvedConnector,
  SessionEndEvent,
  SubagentStartEvent,
  SubagentStopEvent,
  UserPromptSubmitEvent,
} from "../../src/core/types.js";

import cursorAdapter from "../../src/adapters/cursor/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson, splitFrontmatter } from "../support/fs.js";

// ── shared fixtures ──────────────────────────────────────────────────────────

// The render/round-trip slice declares a stdio server with an env-ref so the
// native ${env:VAR} passthrough produces a known value.
const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const AGENT_MATCHER = "code-reviewer|explore";

// The nativeHooks slice uses its own connector id.
const NATIVE_CONNECTOR_ID = "acme-cursor-native";

// The content-surfaces slice uses its own connector id + fixtures.
const SURFACES_CONNECTOR_ID = "acme-surfaces";

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

/** A connector declaring exactly the four E1 extension events. */
function buildExtConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    hooks: {
      PermissionRequest: {
        matcher: "acme_query",
        handler() {
          return { decision: "ask" };
        },
      },
      PostToolUseFailure: {
        matcher: "acme_query",
        handler() {
          return { decision: "context", additionalContext: "retry hint" };
        },
      },
      SubagentStart: {
        matcher: AGENT_MATCHER,
        handler() {
          return { decision: "context", additionalContext: "subagent ctx" };
        },
      },
      SubagentStop: {
        matcher: AGENT_MATCHER,
        handler() {
          return { decision: "deny", reason: "keep going" };
        },
      },
    },
  });
}

/** A connector declaring exactly the three lifecycle/prompt events. */
function buildLifecycleConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    hooks: {
      SessionEnd: {
        handler() {
          return;
        },
      },
      PreCompact: {
        handler() {
          return;
        },
      },
      UserPromptSubmit: {
        handler() {
          return { decision: "deny", reason: "no secrets in prompts" };
        },
      },
    },
  });
}

/** A normalized PreToolUse hook + two cursor-native granular hooks. */
function nativeConnector(): ResolvedConnector {
  return defineConnector({
    id: NATIVE_CONNECTOR_ID,
    displayName: "Acme Cursor",
    version: "1.0.0",
    hooks: { PreToolUse: { matcher: "acme_query", handler: () => ({ decision: "allow" }) } },
    platforms: {
      cursor: {
        nativeHooks: {
          beforeShellExecution: { handler: () => ({}) },
          beforeReadFile: { matcher: "Read", handler: () => ({}) },
        },
      },
    },
  });
}

/** A connector declaring a command + skill (with a resource) + subagent. */
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

// ── local helpers ────────────────────────────────────────────────────────────

function hooksFile(projectDir: string): string {
  return join(projectDir, ".cursor", "hooks.json");
}

function commandsUnder(cfg: any, key: string): string[] {
  const bucket = cfg?.hooks?.[key];
  if (!Array.isArray(bucket)) return [];
  return bucket.map((e: any) => e.command);
}

function parseStdout(reply: { exitCode: number; stdout?: string }): any {
  expect(reply.stdout).toBeTruthy();
  return JSON.parse(reply.stdout!);
}

// Shared env isolation + the same-rules-for-every-host baseline contract.
// extraKeys: the render/round-trip slice mutates ACME_DB_DSN (the ${env:VAR}
// passthrough ref). HOME/USERPROFILE/AGENT_CONNECTOR_DATA_DIR are covered by
// isolateEnv's defaults.
isolateEnv([ENV_VAR]);
createAdapterSuite({ adapter: cursorAdapter, paradigm: "json-stdio" });

// ── render + round-trip (mcpServers object map + flat hooks.json) ─────────────

describe("cursor adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-render-cursor-");
    // Set the env-ref var so the native ${env:VAR} passthrough has a known value.
    process.env[ENV_VAR] = ENV_LITERAL;
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
      "--scope",
      "project",
      "--host",
      "cursor",
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
    } satisfies HookResponse);
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

// ── nativeHooks passthrough (verbatim event-name keys) ───────────────────────

describe("cursor adapter — nativeHooks passthrough", () => {
  it("declares supportsNativeHooks true", () => {
    expect(cursorAdapter.capabilities.supportsNativeHooks).toBe(true);
  });

  it("installHooks writes native event-name keys VERBATIM beside the normalized (mapped) hook", () => {
    const projectDir = freshProject("ac-cursor-native-");
    cursorAdapter.installHooks(buildCtx(projectDir, nativeConnector()));
    const cfg = readJson(hooksFile(projectDir));

    // Normalized PreToolUse maps to Cursor's native "preToolUse" key.
    expect(cfg.hooks.preToolUse[0].command).toContain("hook cursor PreToolUse");
    // Native keys written VERBATIM (no EVENT_MAP).
    expect(cfg.hooks.beforeShellExecution[0].command).toContain("hook cursor beforeShellExecution");
    expect(cfg.hooks.beforeReadFile[0].matcher).toBe("Read");
    expect(cfg.hooks.beforeReadFile[0].command).toContain("hook cursor beforeReadFile");
    expect(cfg.version).toBe(1);
  });

  it("is idempotent (second install → skip) and uninstall removes the native entries", () => {
    const projectDir = freshProject("ac-cursor-native-");
    const ctx = buildCtx(projectDir, nativeConnector());
    cursorAdapter.installHooks(ctx);
    const second = cursorAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    cursorAdapter.uninstallHooks(ctx);
    const after = readJson(hooksFile(projectDir));
    expect(JSON.stringify(after.hooks ?? {})).not.toContain(HOME_BIN);
  });

  it("nativeHooks install even when normalized hooks are disabled (hooks: false sibling)", () => {
    const projectDir = freshProject("ac-cursor-native-");
    const connector = defineConnector({
      id: NATIVE_CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: {
        cursor: { hooks: false, nativeHooks: { beforeShellExecution: { handler: () => ({}) } } },
      },
    });
    cursorAdapter.installHooks(buildCtx(projectDir, connector));
    const cfg = readJson(hooksFile(projectDir));
    expect(cfg.hooks.beforeShellExecution[0].command).toContain("hook cursor beforeShellExecution");
    expect(cfg.hooks.preToolUse).toBeUndefined(); // normalized disabled
  });

  it("a native key coinciding with a normalized event's mapped key does NOT clobber it", () => {
    // Normalized PreToolUse maps to "preToolUse"; also declare a native "preToolUse"
    // (camelCase — not a canonical HookEventName, so defineConnector permits it).
    const projectDir = freshProject("ac-cursor-native-");
    const connector = defineConnector({
      id: NATIVE_CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: { cursor: { nativeHooks: { preToolUse: { handler: () => ({}) } } } },
    });
    cursorAdapter.installHooks(buildCtx(projectDir, connector));
    const commands = commandsUnder(readJson(hooksFile(projectDir)), "preToolUse");
    // BOTH commands coexist (distinct event tokens) — neither was clobbered.
    expect(commands.some((c) => c.includes("hook cursor PreToolUse"))).toBe(true);
    expect(commands.some((c) => c.includes("hook cursor preToolUse"))).toBe(true);
  });
});

// ── extended events (E1): postToolUseFailure / subagentStart / subagentStop ───

describe("cursor — extended-event install", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-ext-events-cursor-");
    ctx = buildCtx(projectDir, buildExtConnector());
  });

  it("registers postToolUseFailure/subagentStart/subagentStop under camelCase keys; PermissionRequest warn-skips", () => {
    const changes = cursorAdapter.installHooks(ctx);

    const hooksPath = join(projectDir, ".cursor", "hooks.json");
    expect(existsSync(hooksPath)).toBe(true);
    const cfg = readJson(hooksPath);

    for (const [native, canonical] of [
      ["postToolUseFailure", "PostToolUseFailure"],
      ["subagentStart", "SubagentStart"],
      ["subagentStop", "SubagentStop"],
    ] as const) {
      const bucket = cfg.hooks[native];
      expect(Array.isArray(bucket)).toBe(true);
      expect(bucket[0].command).toContain(`hook cursor ${canonical}`);
    }
    // Subagent events persist the agent-type matcher.
    expect(cfg.hooks.subagentStart[0].matcher).toBe(AGENT_MATCHER);
    expect(cfg.hooks.subagentStop[0].matcher).toBe(AGENT_MATCHER);

    // PermissionRequest: never silently dropped — the standard warn-skip.
    const warn = changes.find(
      (c) => c.action === "warn" && c.detail?.includes("PermissionRequest"),
    );
    expect(warn).toBeTruthy();
    expect(warn!.detail).toContain("no Cursor hook equivalent");
    expect(cfg.hooks.permissionRequest).toBeUndefined();
    expect(cfg.hooks.PermissionRequest).toBeUndefined();
  });
});

describe("cursor — extended-event parse", () => {
  const COMMON = { conversation_id: "conv-1", cwd: "/home/dev/acme" };

  it("PostToolUseFailure maps error_message (Cursor vocabulary) + optional fields", () => {
    const evt = cursorAdapter.parseEvent!("PostToolUseFailure", {
      ...COMMON,
      hook_event_name: "postToolUseFailure",
      tool_name: "Shell",
      tool_input: { command: "make test" },
      error_message: "exit status 2",
      duration_ms: 450,
    }) as PostToolUseFailureEvent;

    expect(evt.hostPlatform).toBe("cursor");
    expect(evt.toolName).toBe("Shell");
    expect(evt.toolInput).toEqual({ command: "make test" });
    expect(evt.error).toBe("exit status 2");
    expect(evt.durationMs).toBe(450);
    expect(evt.projectDir).toBe("/home/dev/acme");
  });

  it("PostToolUseFailure falls back to the Claude-compatible `error` field", () => {
    const evt = cursorAdapter.parseEvent!("PostToolUseFailure", {
      ...COMMON,
      tool_name: "Shell",
      error: "boom",
    }) as PostToolUseFailureEvent;
    expect(evt.error).toBe("boom");
  });

  it("SubagentStart maps agent_id/agent_type with subagent_* fallback", () => {
    const evt = cursorAdapter.parseEvent!("SubagentStart", {
      ...COMMON,
      agent_id: "agent-7",
      agent_type: "code-reviewer",
    }) as SubagentStartEvent;
    expect(evt.agentId).toBe("agent-7");
    expect(evt.agentType).toBe("code-reviewer");

    const fallback = cursorAdapter.parseEvent!("SubagentStart", {
      ...COMMON,
      subagent_id: "sub-9",
      subagent_type: "explore",
    }) as SubagentStartEvent;
    expect(fallback.agentId).toBe("sub-9");
    expect(fallback.agentType).toBe("explore");
  });

  it("SubagentStop maps last_assistant_message/stop_hook_active and tolerates missing agent_type", () => {
    const evt = cursorAdapter.parseEvent!("SubagentStop", {
      ...COMMON,
      last_assistant_message: "review complete",
      stop_hook_active: true,
    }) as SubagentStopEvent;
    expect(evt.agentId).toBeUndefined();
    expect(evt.agentType).toBeUndefined();
    expect(evt.lastAssistantMessage).toBe("review complete");
    expect(evt.stopHookActive).toBe(true);
  });

  it("PermissionRequest throws (no Cursor analog — permission is an output field, not an event)", () => {
    expect(() => cursorAdapter.parseEvent!("PermissionRequest", COMMON)).toThrow(
      /unsupported cursor hook event/,
    );
  });
});

describe("cursor — extended-event replies", () => {
  it("PostToolUseFailure: context → additional_context; deny DEGRADES to context+reason; void → empty payload", () => {
    const context = parseStdout(
      cursorAdapter.formatReply!("PostToolUseFailure", {
        decision: "context",
        additionalContext: "retry with -j1",
      }),
    );
    expect(context).toEqual({ additional_context: "retry with -j1" });

    const denied = parseStdout(
      cursorAdapter.formatReply!("PostToolUseFailure", {
        decision: "deny",
        reason: "not blockable",
      }),
    );
    expect(denied).toEqual({ additional_context: "not blockable" });
    expect(denied.permission).toBeUndefined();

    // Cursor rejects empty stdout — the no-op is a minimal valid payload.
    const noop = parseStdout(cursorAdapter.formatReply!("PostToolUseFailure", {}));
    expect(noop).toEqual({ additional_context: "" });
  });

  it("SubagentStart: context → additional_context; deny degrades the same way", () => {
    const context = parseStdout(
      cursorAdapter.formatReply!("SubagentStart", {
        decision: "context",
        additionalContext: "subagent ctx",
      }),
    );
    expect(context).toEqual({ additional_context: "subagent ctx" });

    const denied = parseStdout(
      cursorAdapter.formatReply!("SubagentStart", {
        decision: "deny",
        reason: "spawn is not blockable",
      }),
    );
    expect(denied).toEqual({ additional_context: "spawn is not blockable" });
  });

  it("SubagentStop deny follows the adapter's Stop idiom (permission deny + user_message)", () => {
    const reply = parseStdout(
      cursorAdapter.formatReply!("SubagentStop", {
        decision: "deny",
        reason: "keep going",
      }),
    );
    expect(reply).toEqual({ permission: "deny", user_message: "keep going" });
  });
});

// ── lifecycle/prompt hooks (SessionEnd / PreCompact / UserPromptSubmit) ───────

describe("cursor — lifecycle/prompt-event install", () => {
  it("registers sessionEnd/preCompact/beforeSubmitPrompt under their camelCase keys (no warn-skip)", () => {
    const projectDir = freshProject("ac-ext-events-cursor-");
    const ctx = buildCtx(projectDir, buildLifecycleConnector());

    const changes = cursorAdapter.installHooks(ctx);

    const hooksPath = join(projectDir, ".cursor", "hooks.json");
    expect(existsSync(hooksPath)).toBe(true);
    const cfg = readJson(hooksPath);

    for (const [native, canonical] of [
      ["sessionEnd", "SessionEnd"],
      ["preCompact", "PreCompact"],
      ["beforeSubmitPrompt", "UserPromptSubmit"],
    ] as const) {
      const bucket = cfg.hooks[native];
      expect(Array.isArray(bucket)).toBe(true);
      expect(bucket[0].command).toContain(`hook cursor ${canonical}`);
    }

    // None of the three is the "no Cursor hook equivalent" warn-skip anymore.
    const warn = changes.find(
      (c) =>
        c.action === "warn" &&
        /SessionEnd|PreCompact|UserPromptSubmit/.test(c.detail ?? ""),
    );
    expect(warn).toBeUndefined();
  });
});

describe("cursor — lifecycle/prompt-event parse", () => {
  const COMMON = { conversation_id: "conv-1", cwd: "/home/dev/acme" };

  it("SessionEnd maps the documented `reason` enum (session_id folds into base)", () => {
    const evt = cursorAdapter.parseEvent!("SessionEnd", {
      session_id: "sess-9",
      reason: "completed",
      duration_ms: 45000,
      cwd: "/home/dev/acme",
    }) as SessionEndEvent;
    expect(evt.hostPlatform).toBe("cursor");
    expect(evt.sessionId).toBe("sess-9");
    expect(evt.reason).toBe("completed");
    expect(evt.projectDir).toBe("/home/dev/acme");
  });

  it("UserPromptSubmit maps the `prompt` text (attachments preserved via raw)", () => {
    const evt = cursorAdapter.parseEvent!("UserPromptSubmit", {
      ...COMMON,
      prompt: "summarize the diff",
      attachments: [{ type: "file", file_path: "/a/b.ts" }],
    }) as UserPromptSubmitEvent;
    expect(evt.prompt).toBe("summarize the diff");
    expect((evt.raw as any).attachments).toEqual([
      { type: "file", file_path: "/a/b.ts" },
    ]);

    // No prompt field → empty string, never undefined.
    const empty = cursorAdapter.parseEvent!(
      "UserPromptSubmit",
      COMMON,
    ) as UserPromptSubmitEvent;
    expect(empty.prompt).toBe("");
  });

  it("PreCompact maps the `trigger` enum and ignores an unknown trigger", () => {
    const auto = cursorAdapter.parseEvent!("PreCompact", {
      ...COMMON,
      trigger: "auto",
      context_usage_percent: 85,
    }) as PreCompactEvent;
    expect(auto.trigger).toBe("auto");

    const manual = cursorAdapter.parseEvent!("PreCompact", {
      ...COMMON,
      trigger: "manual",
    }) as PreCompactEvent;
    expect(manual.trigger).toBe("manual");

    // An unrecognized trigger is dropped (no invented value).
    const unknown = cursorAdapter.parseEvent!("PreCompact", {
      ...COMMON,
      trigger: "weird",
    }) as PreCompactEvent;
    expect(unknown.trigger).toBeUndefined();
  });
});

describe("cursor — lifecycle/prompt-event replies", () => {
  it("UserPromptSubmit: deny → { continue:false, user_message }; non-deny → { continue:true }", () => {
    const denied = parseStdout(
      cursorAdapter.formatReply!("UserPromptSubmit", {
        decision: "deny",
        reason: "no secrets in prompts",
      }),
    );
    expect(denied).toEqual({ continue: false, user_message: "no secrets in prompts" });

    const allowed = parseStdout(
      cursorAdapter.formatReply!("UserPromptSubmit", { decision: "allow" }),
    );
    expect(allowed).toEqual({ continue: true });

    // context cannot inject on beforeSubmitPrompt (no such output field) → continue:true
    const ctxReply = parseStdout(
      cursorAdapter.formatReply!("UserPromptSubmit", {
        decision: "context",
        additionalContext: "ignored — no field",
      }),
    );
    expect(ctxReply).toEqual({ continue: true });
  });

  it("SessionEnd and PreCompact are no-op passthroughs even on a deny (cannot block)", () => {
    for (const event of ["SessionEnd", "PreCompact"] as const) {
      const allow = cursorAdapter.formatReply!(event, {});
      expect(allow).toEqual({ exitCode: 0 });
      // A deny cannot block these events — it must NOT degrade to permission:deny.
      const deny = cursorAdapter.formatReply!(event, {
        decision: "deny",
        reason: "irrelevant",
      });
      expect(deny).toEqual({ exitCode: 0 });
    }
  });
});

// ── content surfaces: commands (body-only) / skills / subagents ───────────────

describe("cursor adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-surfaces-cursor-");
    ctx = buildCtx(projectDir, buildSurfacesConnector());
  });

  it("declares support for all three content surfaces", () => {
    expect(cursorAdapter.capabilities.supportsCommands).toBe(true);
    expect(cursorAdapter.capabilities.supportsSkills).toBe(true);
    expect(cursorAdapter.capabilities.supportsSubagents).toBe(true);
  });

  it("installCommands writes a BODY-ONLY .md command with NO frontmatter delimiter", () => {
    const changes = cursorAdapter.installCommands!(ctx);
    expect(changes[0]?.action).toBe("create");
    const cmdPath = join(projectDir, ".cursor", "commands", "deploy.md");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);

    const text = readFileSync(cmdPath, "utf8");
    // No YAML frontmatter block: the file must not open with the `---` delimiter.
    expect(text.startsWith("---\n")).toBe(false);
    // The prompt body is present verbatim.
    expect(text).toContain(COMMAND.prompt);
  });

  it("installSkills writes uniform SKILL.md + resource", () => {
    cursorAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".cursor", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".cursor", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    const { frontmatter } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
  });

  it("installSubagents writes md+fm agents/<name>.md (name, description, model, readonly)", () => {
    cursorAdapter.installSubagents!(ctx);
    const agentPath = join(projectDir, ".cursor", "agents", "reviewer.md");
    expect(existsSync(agentPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(agentPath, "utf8"));
    expect(frontmatter.name).toBe("reviewer");
    expect(frontmatter.description).toBe(SUBAGENT.description);
    expect(frontmatter.model).toBe("opus");
    expect(frontmatter.readonly).toBe(true);
    expect(body.trim()).toBe(SUBAGENT.prompt);
  });

  it("is idempotent — second install yields skip across all surfaces", () => {
    cursorAdapter.installCommands!(ctx);
    cursorAdapter.installSkills!(ctx);
    cursorAdapter.installSubagents!(ctx);
    expect(cursorAdapter.installCommands!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(cursorAdapter.installSkills!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(cursorAdapter.installSubagents!(ctx).every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall removes all written files", () => {
    cursorAdapter.installCommands!(ctx);
    cursorAdapter.installSkills!(ctx);
    cursorAdapter.installSubagents!(ctx);

    cursorAdapter.uninstallCommands!(ctx);
    cursorAdapter.uninstallSkills!(ctx);
    cursorAdapter.uninstallSubagents!(ctx);

    expect(existsSync(join(projectDir, ".cursor", "commands", "deploy.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".cursor", "skills", "pdf-tools"))).toBe(false);
    expect(existsSync(join(projectDir, ".cursor", "agents", "reviewer.md"))).toBe(false);
  });
});
