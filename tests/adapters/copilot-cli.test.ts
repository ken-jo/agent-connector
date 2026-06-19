/**
 * adapters/copilot-cli.test.ts — the ONE per-host file for the GitHub Copilot CLI adapter.
 *
 * copilot-cli is a json-stdio host, user/global scope only (no project-scoped
 * config). Config surfaces:
 *   • MCP servers → ~/.copilot/mcp-config.json, ROOT KEY "mcpServers"; stdio entry
 *                   written as type "local" + tools:["*"]; remote → type "http"
 *                   (Streamable) or "sse" (legacy). No native ${env:VAR} interp →
 *                   env/header/url refs resolve to LITERALS at install time.
 *   • Hooks       → a dedicated ~/.copilot/hooks/agent-connector.json shaped
 *                   { version: 1, hooks: { <PascalCaseEvent>: [ { matcher, hooks:
 *                   [ { type:"command", command } ] } ] } } — the Claude shape,
 *                   PascalCase events 1:1 (no rename table). nativeHooks (e.g.
 *                   ErrorOccurred) are filed VERBATIM as a sibling declaration.
 *   • Content     → skills + subagents (NO command surface — commands inherit the
 *                   BaseAdapter skip/warn default). user scope → ~/.copilot; project
 *                   scope → the shared <projectDir>/.github tree. skills are
 *                   <dir>/skills/<name>/SKILL.md + resources; subagents are
 *                   md+fm .agent.md (tools as CSV).
 *   • Reply       → JSON on stdout (exit 0): PreToolUse deny/ask via
 *                   hookSpecificOutput.permissionDecision; PermissionRequest uses
 *                   the nested decision{behavior} envelope (allow is an ACTIVE
 *                   grant); PostToolUseFailure/SubagentStart are context-only (deny
 *                   degrades to additionalContext); SubagentStop deny → TOP-LEVEL
 *                   {decision:"block", reason} (Stop semantics); context →
 *                   additionalContext.
 *
 * This file consolidates what used to be split across copilot-cli-native-hooks.test.ts
 * (nativeHooks passthrough), copilot-cli-sse-mcp.test.ts (remote transport type),
 * extended-events-batch.test.ts (E1 extension events — copilot-cli was the last
 * remaining host), phase2-render.test.ts (render/round-trip), and surfaces-s2.test.ts
 * (content surfaces). It uses the shared harness (tests/support/env + adapter-suite
 * + fs) per tests/README.md — ONE file per host.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  PermissionRequestEvent,
  PostToolUseFailureEvent,
  ResolvedConnector,
  SubagentStartEvent,
  SubagentStopEvent,
  Transport,
} from "../../src/core/types.js";

import copilotCliAdapter from "../../src/adapters/copilot-cli/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson, splitFrontmatter } from "../support/fs.js";

// ── shared fixtures ──────────────────────────────────────────────────────────

// The render/round-trip + extended-events slices share the canonical stdio
// connector id; the env-ref var feeds the LITERAL-resolution assertion.
const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const SERVER_CWD = "/srv/acme";
const AGENT_MATCHER = "code-reviewer|explore";

// The remote-transport slice uses its own connector id.
const REMOTE_CONNECTOR_ID = "acme-copilot-remote";

// The nativeHooks slice uses its own connector id.
const NATIVE_CONNECTOR_ID = "acme-copilot-native";

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

/** A remote (http/sse) connector. */
function remoteConnector(transport: Transport): ResolvedConnector {
  return defineConnector({
    id: REMOTE_CONNECTOR_ID,
    server: { transport, url: "https://mcp.acme.example/endpoint", tools: { include: ["*"] } },
    telemetry: { enabled: false },
  });
}

/** A normalized PreToolUse hook + a copilot-native ErrorOccurred hook. */
function nativeConnector(): ResolvedConnector {
  return defineConnector({
    id: NATIVE_CONNECTOR_ID,
    displayName: "Acme Copilot",
    version: "1.0.0",
    hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
    platforms: {
      "copilot-cli": {
        nativeHooks: {
          ErrorOccurred: { matcher: "Bash", handler: () => ({}) },
        },
      },
    },
  });
}

/** A connector declaring ONLY the supported surfaces (skills + subagents). */
function buildSurfacesConnector(extra?: { commands?: boolean }): ResolvedConnector {
  return defineConnector({
    id: SURFACES_CONNECTOR_ID,
    displayName: "Acme Surfaces",
    version: "1.0.0",
    ...(extra?.commands
      ? { commands: [{ ...COMMAND, tools: { allow: [...COMMAND.tools.allow] } }] }
      : {}),
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
  return join(projectDir, ".copilot", "hooks", "agent-connector.json");
}

function serverFile(projectDir: string): string {
  return join(projectDir, ".copilot", "mcp-config.json");
}

function parseStdout(reply: { exitCode: number; stdout?: string }): any {
  expect(reply.stdout).toBeTruthy();
  return JSON.parse(reply.stdout!);
}

/**
 * The serve-wrapper args bake the install TARGET platform as `--host <id>` (before
 * the `--` separator) so the proxy stamps hostPlatform correctly under a headless
 * spawn. copilot-cli is user-scoped, so the wrapper stamps `--scope user`.
 */
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

// Shared env isolation + the same-rules-for-every-host baseline contract.
// extraKeys: the render/round-trip slice mutates ACME_DB_DSN (the env-ref the
// LITERAL-resolution assertion reads). HOME/USERPROFILE/AGENT_CONNECTOR_DATA_DIR
// are covered by isolateEnv's defaults.
isolateEnv([ENV_VAR]);
createAdapterSuite({ adapter: copilotCliAdapter, paradigm: "json-stdio" });

// ── render + round-trip (mcpServers type:"local" + ~/.copilot/hooks PascalCase) ──
// Copilot CLI is user/global scope only → resolves from homedir(); freshProject
// redirects HOME into the sandbox so ~/.copilot/* lands under the temp dir.

describe("copilot-cli adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-p2-render-");
    // Set the env-ref var so literal-resolution produces a known value.
    process.env[ENV_VAR] = ENV_LITERAL;
    ctx = buildCtx(projectDir, buildConnector(), "user");
  });

  it("installServer writes mcpServers.<id> with type 'local' into ~/.copilot/mcp-config.json, env as LITERAL", () => {
    const changes = copilotCliAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = serverFile(projectDir);
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
    expect(entry.args).toEqual(wrappedArgsUser("copilot-cli"));

    // No native interpolation → env-ref resolves to a LITERAL value.
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installHooks writes ~/.copilot/hooks/agent-connector.json with version 1 + Claude-shaped entries", () => {
    const changes = copilotCliAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const hooksPath = hooksFile(projectDir);
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

    const cfg = readJson(serverFile(projectDir));
    expect(Object.keys(cfg.mcpServers)).toEqual([CONNECTOR_ID]);
  });

  it("installHooks is idempotent — second call yields skip and does not duplicate entries", () => {
    copilotCliAdapter.installHooks(ctx);
    const second = copilotCliAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    const cfg = readJson(hooksFile(projectDir));
    expect(cfg.hooks.PreToolUse).toHaveLength(1);
    expect(cfg.hooks.SessionStart).toHaveLength(1);
  });

  it("uninstallServer + uninstallHooks remove the entries (re-read confirms gone)", () => {
    copilotCliAdapter.installServer(ctx);
    copilotCliAdapter.installHooks(ctx);

    copilotCliAdapter.uninstallServer(ctx);
    const serverCfg = readJson(serverFile(projectDir));
    expect(serverCfg.mcpServers?.[CONNECTOR_ID]).toBeUndefined();

    copilotCliAdapter.uninstallHooks(ctx);
    const hooks = readJson(hooksFile(projectDir));
    expect(JSON.stringify(hooks.hooks ?? {})).not.toContain(HOME_BIN);
  });
});

// ── remote MCP transport type (http + sse) ────────────────────────────────────

describe("copilot-cli adapter — remote MCP transport type (http + sse)", () => {
  function readEntry(projectDir: string): Record<string, any> {
    return readJson(serverFile(projectDir)).mcpServers[REMOTE_CONNECTOR_ID];
  }

  it("advertises sse alongside stdio + http", () => {
    expect(copilotCliAdapter.capabilities.transports).toContain("sse");
    expect(copilotCliAdapter.capabilities.transports).toContain("http");
  });

  it('renders an sse server as type:"sse"', () => {
    const projectDir = freshProject("ac-copilot-sse-");
    copilotCliAdapter.installServer(buildCtx(projectDir, remoteConnector("sse"), "user"));
    const entry = readEntry(projectDir);
    expect(entry.type).toBe("sse");
    expect(entry.url).toBe("https://mcp.acme.example/endpoint");
  });

  it('still renders an http server as type:"http" (regression)', () => {
    const projectDir = freshProject("ac-copilot-sse-");
    copilotCliAdapter.installServer(buildCtx(projectDir, remoteConnector("http"), "user"));
    expect(readEntry(projectDir).type).toBe("http");
  });
});

// ── nativeHooks passthrough (ErrorOccurred filed verbatim) ────────────────────

describe("copilot-cli adapter — nativeHooks passthrough", () => {
  function readHooks(projectDir: string): Record<string, any[]> {
    const file = readJson(hooksFile(projectDir));
    return (file.hooks ?? {}) as Record<string, any[]>;
  }

  it("declares supportsNativeHooks true", () => {
    expect(copilotCliAdapter.capabilities.supportsNativeHooks).toBe(true);
  });

  it("installHooks files the native ErrorOccurred key VERBATIM beside the canonical PreToolUse", () => {
    const projectDir = freshProject("ac-copilot-native-");
    copilotCliAdapter.installHooks(buildCtx(projectDir, nativeConnector(), "user"));
    const hooks = readHooks(projectDir);

    expect(hooks.PreToolUse[0].hooks[0].command).toContain("hook copilot-cli PreToolUse");
    // Native key filed verbatim (no EVENT_MAP) with the native event token.
    expect(hooks.ErrorOccurred[0].hooks[0].command).toContain("hook copilot-cli ErrorOccurred");
    expect(hooks.ErrorOccurred[0].hooks[0].command).toContain(`--connector ${NATIVE_CONNECTOR_ID}`);
    expect(hooks.ErrorOccurred[0].matcher).toBe("Bash");
  });

  it("nativeHooks install even when normalized hooks are disabled (hooks:false sibling)", () => {
    const projectDir = freshProject("ac-copilot-native-");
    const connector = defineConnector({
      id: NATIVE_CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: {
        "copilot-cli": { hooks: false, nativeHooks: { ErrorOccurred: { handler: () => ({}) } } },
      },
    });
    copilotCliAdapter.installHooks(buildCtx(projectDir, connector, "user"));
    const hooks = readHooks(projectDir);
    expect(hooks.ErrorOccurred[0].hooks[0].command).toContain("hook copilot-cli ErrorOccurred");
    expect(hooks.PreToolUse).toBeUndefined(); // normalized disabled by hooks:false
  });

  it("is idempotent (second install → skip) and uninstall removes the native entry", () => {
    const projectDir = freshProject("ac-copilot-native-");
    const ctx = buildCtx(projectDir, nativeConnector(), "user");
    copilotCliAdapter.installHooks(ctx);
    const second = copilotCliAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    copilotCliAdapter.uninstallHooks(ctx);
    expect(JSON.stringify(readHooks(projectDir))).not.toContain(HOME_BIN);
  });

  it("uninstall strips only OUR native entry, leaving a foreign hook intact", () => {
    const projectDir = freshProject("ac-copilot-native-");
    const ctx = buildCtx(projectDir, nativeConnector(), "user");
    copilotCliAdapter.installHooks(ctx);
    // Seed a foreign (non-AC) hook under the same native key.
    const path = hooksFile(projectDir);
    const file = JSON.parse(readFileSync(path, "utf8"));
    file.hooks.ErrorOccurred.push({ matcher: "", hooks: [{ type: "command", command: "/usr/bin/other run" }] });
    writeFileSync(path, JSON.stringify(file));

    copilotCliAdapter.uninstallHooks(ctx);
    const hooks = readHooks(projectDir);
    const flat = JSON.stringify(hooks);
    expect(flat).toContain("other run"); // foreign survives
    expect(flat).not.toContain(HOME_BIN); // every AC command gone
  });
});

// ── extended events (E1): PermissionRequest/PostToolUseFailure/SubagentStart/Stop ──

describe("copilot-cli — extended-event install", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-ext-events-");
    ctx = buildCtx(projectDir, buildExtConnector(), "user");
  });

  it("registers all four extension events PascalCase 1:1 with matchers (write-all adapter)", () => {
    const changes = copilotCliAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "warn")).toBe(false);

    const hooksPath = hooksFile(projectDir);
    expect(existsSync(hooksPath)).toBe(true);
    const cfg = readJson(hooksPath);
    expect(cfg.version).toBe(1);

    for (const event of [
      "PermissionRequest",
      "PostToolUseFailure",
      "SubagentStart",
      "SubagentStop",
    ]) {
      const bucket = cfg.hooks[event];
      expect(Array.isArray(bucket)).toBe(true);
      expect(bucket[0].hooks[0].command).toContain(`hook copilot-cli ${event}`);
    }
    expect(cfg.hooks.PermissionRequest[0].matcher).toBe("acme_query");
    expect(cfg.hooks.SubagentStop[0].matcher).toBe(AGENT_MATCHER);
  });
});

// ── capability gate: unsupported events warn-skip, never written to hooks.json ──
// Copilot CLI delivers every canonical event EXCEPT PostCompact (no post-
// compaction hook → postCompact unset on `capabilities`). installHooks must
// filter declared events against capabilities BEFORE writing — a connector that
// declares PostCompact must get only a graceful warn ChangeRecord, never a dead
// hooks.PostCompact the host never fires. Mirrors goose's equivalent gate test.

describe("copilot-cli — capability gate (unsupported PostCompact warn-skips)", () => {
  function gateConnector(): ResolvedConnector {
    return defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme DB Tools",
      version: "1.2.3",
      hooks: {
        PreToolUse: {
          matcher: "acme_query",
          handler() {
            return { decision: "allow" };
          },
        },
        PostCompact: {
          handler() {
            return { decision: "allow" };
          },
        },
      },
    });
  }

  it("SKIPS PostCompact with a warn but still writes PreToolUse", () => {
    const projectDir = freshProject("ac-copilot-gate-");
    const ctx = buildCtx(projectDir, gateConnector(), "user");

    const changes = copilotCliAdapter.installHooks(ctx);

    // PostCompact is unsupported on copilot-cli → a warn ChangeRecord, never written.
    const warn = changes.find(
      (c) => c.action === "warn" && c.detail?.includes("PostCompact"),
    );
    expect(warn).toBeTruthy();
    expect(warn?.detail).toBe("PostCompact unsupported on copilot-cli — skipped");

    // PreToolUse IS supported → created.
    expect(
      changes.some((c) => c.action === "create" && c.detail === "hooks.PreToolUse"),
    ).toBe(true);

    // No NON-warn change record wrote hooks.PostCompact.
    expect(
      changes.some((c) => c.action !== "warn" && c.detail === "hooks.PostCompact"),
    ).toBe(false);

    // The on-disk file carries PreToolUse but NOT the unsupported PostCompact.
    const cfg = readJson(hooksFile(projectDir));
    expect(cfg.hooks.PreToolUse).toBeTruthy();
    expect(cfg.hooks.PreToolUse[0].hooks[0].command).toContain(
      "hook copilot-cli PreToolUse",
    );
    expect(cfg.hooks.PostCompact).toBeUndefined();
  });
});

describe("copilot-cli — extended-event parse", () => {
  const COMMON = {
    session_id: "sess-1",
    transcript_path:
      "/home/dev/.copilot/history/0a1b2c3d-0a1b-4c3d-8e5f-0a1b2c3d4e5f.jsonl",
    cwd: "/home/dev/acme",
  };

  it("PermissionRequest maps tool_name/tool_input/permission_suggestions", () => {
    const evt = copilotCliAdapter.parseEvent!("PermissionRequest", {
      ...COMMON,
      tool_name: "bash",
      tool_input: { command: "rm -rf /tmp/x" },
      permission_suggestions: [{ behavior: "allow" }],
    }) as PermissionRequestEvent;
    expect(evt.hostPlatform).toBe("copilot-cli");
    expect(evt.toolName).toBe("bash");
    expect(evt.toolInput).toEqual({ command: "rm -rf /tmp/x" });
    expect(evt.permissionSuggestions).toEqual([{ behavior: "allow" }]);
    expect(evt.sessionId).toBe("0a1b2c3d-0a1b-4c3d-8e5f-0a1b2c3d4e5f");
  });

  it("PostToolUseFailure maps error/tool_use_id/is_interrupt/duration_ms (error defaults to '')", () => {
    const evt = copilotCliAdapter.parseEvent!("PostToolUseFailure", {
      ...COMMON,
      tool_name: "bash",
      tool_input: { command: "make test" },
      tool_use_id: "call_01",
      error: "exit status 2",
      is_interrupt: false,
      duration_ms: 1234,
    }) as PostToolUseFailureEvent;
    expect(evt.error).toBe("exit status 2");
    expect(evt.toolUseId).toBe("call_01");
    expect(evt.isInterrupt).toBe(false);
    expect(evt.durationMs).toBe(1234);

    const minimal = copilotCliAdapter.parseEvent!("PostToolUseFailure", {
      tool_name: "write",
    }) as PostToolUseFailureEvent;
    expect(minimal.error).toBe("");
  });

  it("SubagentStart + SubagentStop map agent fields; SubagentStop tolerates missing agent_type", () => {
    const start = copilotCliAdapter.parseEvent!("SubagentStart", {
      ...COMMON,
      agent_id: "agent-7",
      agent_type: "code-reviewer",
    }) as SubagentStartEvent;
    expect(start.agentId).toBe("agent-7");
    expect(start.agentType).toBe("code-reviewer");

    const stop = copilotCliAdapter.parseEvent!("SubagentStop", {
      ...COMMON,
      agent_id: "agent-7",
      agent_transcript_path: "/x/subagents/agent-7.jsonl",
      last_assistant_message: "review complete",
      stop_hook_active: true,
    }) as SubagentStopEvent;
    expect(stop.agentType).toBeUndefined();
    expect(stop.agentTranscriptPath).toBe("/x/subagents/agent-7.jsonl");
    expect(stop.lastAssistantMessage).toBe("review complete");
    expect(stop.stopHookActive).toBe(true);
  });
});

describe("copilot-cli — extended-event replies", () => {
  it("PermissionRequest deny → nested decision{behavior:'deny', message}", () => {
    const reply = parseStdout(
      copilotCliAdapter.formatReply!("PermissionRequest", {
        decision: "deny",
        reason: "not on my watch",
      }),
    );
    expect(reply.hookSpecificOutput).toEqual({
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "not on my watch" },
    });
  });

  it("PermissionRequest explicit allow → ACTIVE grant; modify carries updatedInput", () => {
    const allowed = parseStdout(
      copilotCliAdapter.formatReply!("PermissionRequest", { decision: "allow" }),
    );
    expect(allowed.hookSpecificOutput.decision).toEqual({ behavior: "allow" });

    const modified = parseStdout(
      copilotCliAdapter.formatReply!("PermissionRequest", {
        decision: "modify",
        updatedInput: { command: "ls" },
      }),
    );
    expect(modified.hookSpecificOutput.decision).toEqual({
      behavior: "allow",
      updatedInput: { command: "ls" },
    });
  });

  it("PermissionRequest ask/void emit NO decision (fall through to the native dialog)", () => {
    expect(
      copilotCliAdapter.formatReply!("PermissionRequest", { decision: "ask" }),
    ).toEqual({ exitCode: 0 });
    expect(copilotCliAdapter.formatReply!("PermissionRequest", {})).toEqual({
      exitCode: 0,
    });
  });

  it("PostToolUseFailure + SubagentStart: deny DEGRADES to additionalContext+reason", () => {
    for (const event of ["PostToolUseFailure", "SubagentStart"] as const) {
      const reply = parseStdout(
        copilotCliAdapter.formatReply!(event, {
          decision: "deny",
          reason: "not blockable",
        }),
      );
      expect(reply.hookSpecificOutput).toEqual({
        hookEventName: event,
        additionalContext: "not blockable",
      });
    }
  });

  it("SubagentStop deny → TOP-LEVEL {decision:'block', reason}; Stop deny is unchanged (regression guard)", () => {
    const subagent = parseStdout(
      copilotCliAdapter.formatReply!("SubagentStop", {
        decision: "deny",
        reason: "keep going",
      }),
    );
    expect(subagent).toEqual({ decision: "block", reason: "keep going" });

    const stop = parseStdout(
      copilotCliAdapter.formatReply!("Stop", { decision: "deny", reason: "halt" }),
    );
    expect(stop.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

// ── content surfaces: NO commands / skills / subagents (shared .github tree) ──

describe("copilot-cli adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-surfaces-s2-");
    // Declare ONLY the supported surfaces (skills + subagents). Commands are
    // unsupported on Copilot CLI; with none declared they resolve to a skip.
    ctx = buildCtx(projectDir, buildSurfacesConnector());
  });

  it("declares skills + subagents but NOT commands", () => {
    expect(copilotCliAdapter.capabilities.supportsCommands).toBe(false);
    expect(copilotCliAdapter.capabilities.supportsSkills).toBe(true);
    expect(copilotCliAdapter.capabilities.supportsSubagents).toBe(true);
  });

  it("installCommands is unsupported → BaseAdapter skip/warn, writes no prompt file", () => {
    // Even when a command IS declared, Copilot CLI has no command surface: the
    // BaseAdapter default routes it through warn (declared) without writing any
    // native file. The CONTRACT permits warn OR skip here.
    const withCmd = buildCtx(projectDir, buildSurfacesConnector({ commands: true }));
    const changes = copilotCliAdapter.installCommands!(withCmd);
    expect(changes).toHaveLength(1);
    expect(["warn", "skip"]).toContain(changes[0]?.action);
    expect(existsSync(join(projectDir, ".github", "prompts", "deploy.prompt.md"))).toBe(false);
  });

  it("installSkills writes uniform SKILL.md + resource (project scope under .github)", () => {
    copilotCliAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".github", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".github", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    const { frontmatter } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
  });

  it("installSubagents (project scope) writes md+fm .github/agents/<n>.agent.md", () => {
    const changes = copilotCliAdapter.installSubagents!(ctx);
    expect(changes[0]?.action).toBe("create");
    const agentPath = join(projectDir, ".github", "agents", "reviewer.agent.md");
    expect(changes[0]?.path).toBe(agentPath);
    expect(existsSync(agentPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(agentPath, "utf8"));
    expect(frontmatter.name).toBe("reviewer");
    expect(frontmatter.description).toBe(SUBAGENT.description);
    expect(frontmatter.tools).toBe("Read, Grep");
    expect(frontmatter.model).toBe("opus");
    expect(body.trim()).toBe(SUBAGENT.prompt);
  });

  it("installSubagents (USER scope) writes to ~/.copilot/agents (HOME temp)", () => {
    const userCtx = buildCtx(projectDir, buildSurfacesConnector(), "user");
    const changes = copilotCliAdapter.installSubagents!(userCtx);
    expect(changes[0]?.action).toBe("create");

    // HOME redirected to projectDir → ~/.copilot === projectDir/.copilot.
    const agentPath = join(projectDir, ".copilot", "agents", "reviewer.agent.md");
    expect(changes[0]?.path).toBe(agentPath);
    expect(existsSync(agentPath)).toBe(true);
    // Must NOT have written into the shared project .github tree at user scope.
    expect(existsSync(join(projectDir, ".github", "agents", "reviewer.agent.md"))).toBe(false);
  });

  it("is idempotent — second install yields skip (skills + subagents)", () => {
    copilotCliAdapter.installSkills!(ctx);
    copilotCliAdapter.installSubagents!(ctx);
    expect(copilotCliAdapter.installSkills!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(copilotCliAdapter.installSubagents!(ctx).every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall removes skill + subagent files (project scope)", () => {
    copilotCliAdapter.installSkills!(ctx);
    copilotCliAdapter.installSubagents!(ctx);
    copilotCliAdapter.uninstallSkills!(ctx);
    copilotCliAdapter.uninstallSubagents!(ctx);
    expect(existsSync(join(projectDir, ".github", "skills", "pdf-tools"))).toBe(false);
    expect(existsSync(join(projectDir, ".github", "agents", "reviewer.agent.md"))).toBe(false);
  });
});
