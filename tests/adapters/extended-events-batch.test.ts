/**
 * tests/adapters/extended-events-batch — E1 extension-event wiring for the
 * cursor / vscode-copilot / copilot-cli adapters (PermissionRequest,
 * PostToolUseFailure, SubagentStart, SubagentStop).
 *
 * Per host this pins three things:
 *   • installHooks — which of the four events register natively (and under
 *     which native key), and that unsupported ones surface the standard
 *     warn-skip ("no … hook equivalent") instead of being silently dropped:
 *       cursor         → postToolUseFailure / subagentStart / subagentStop
 *                        (camelCase keys); PermissionRequest warn-skips
 *                        (Cursor's permission gate is an OUTPUT field of its
 *                        before* hooks, not an event).
 *       vscode-copilot → SubagentStart / SubagentStop (PascalCase); both
 *                        PermissionRequest and PostToolUseFailure warn-skip.
 *       copilot-cli    → all four, PascalCase 1:1 (write-all adapter).
 *   • parseEvent — wire → normalized mapping incl. the optional-field quirks
 *     (SubagentStop may arrive WITHOUT agent_type; cursor error_message↔error).
 *   • formatReply — per-event decision semantics: feedback-only degradation
 *     (PostToolUseFailure / SubagentStart deny → context+reason), Stop
 *     semantics on SubagentStop, and the PermissionRequest envelope where the
 *     host supports decision control (copilot-cli).
 *
 * Filesystem isolation mirrors phase2-render.test.ts: fresh mkdtemp project
 * dir, HOME redirected into it so the user-scoped copilot-cli writes stay in
 * the sandbox.
 */

import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  PermissionRequestEvent,
  PostToolUseFailureEvent,
  ResolvedConnector,
  SubagentStartEvent,
  SubagentStopEvent,
} from "../../src/core/types.js";

import cursorAdapter from "../../src/adapters/cursor/index.js";
import vscodeCopilotAdapter from "../../src/adapters/vscode-copilot/index.js";
import copilotCliAdapter from "../../src/adapters/copilot-cli/index.js";

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-db";
const AGENT_MATCHER = "code-reviewer|explore";

/** A connector declaring exactly the four E1 extension events. */
function buildConnector(): ResolvedConnector {
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

let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let savedDataDir: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("USERPROFILE", savedUserProfile);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Fresh temp project dir + redirect HOME/data-root there so nothing escapes. */
function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-ext-events-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  return dir;
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseStdout(reply: { exitCode: number; stdout?: string }): any {
  expect(reply.stdout).toBeTruthy();
  return JSON.parse(reply.stdout!);
}

// ─────────────────────────────────────────────────────────────────────────
// Cursor
// ─────────────────────────────────────────────────────────────────────────

describe("cursor — extended-event install", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
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

// ─────────────────────────────────────────────────────────────────────────
// VS Code Copilot
// ─────────────────────────────────────────────────────────────────────────

describe("vscode-copilot — extended-event install", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("registers SubagentStart/SubagentStop (PascalCase); PermissionRequest + PostToolUseFailure warn-skip", () => {
    const changes = vscodeCopilotAdapter.installHooks(ctx);

    const hooksPath = join(projectDir, ".github", "hooks", `${CONNECTOR_ID}.json`);
    expect(existsSync(hooksPath)).toBe(true);
    const cfg = readJson(hooksPath);
    expect(cfg.version).toBe(1);

    expect(cfg.hooks.SubagentStart[0].command).toContain(
      "hook vscode-copilot SubagentStart",
    );
    expect(cfg.hooks.SubagentStop[0].command).toContain(
      "hook vscode-copilot SubagentStop",
    );

    for (const event of ["PermissionRequest", "PostToolUseFailure"]) {
      const warn = changes.find(
        (c) => c.action === "warn" && c.detail?.includes(event),
      );
      expect(warn).toBeTruthy();
      expect(warn!.detail).toContain("no VS Code Copilot hook equivalent");
      expect(cfg.hooks[event]).toBeUndefined();
    }
  });
});

describe("vscode-copilot — extended-event parse + replies", () => {
  const COMMON = { session_id: "sess-1", cwd: "/home/dev/acme" };

  it("SubagentStart/SubagentStop parse the Claude-compatible snake_case fields", () => {
    const start = vscodeCopilotAdapter.parseEvent!("SubagentStart", {
      ...COMMON,
      agent_id: "agent-7",
      agent_type: "code-reviewer",
    }) as SubagentStartEvent;
    expect(start.hostPlatform).toBe("vscode-copilot");
    expect(start.agentId).toBe("agent-7");
    expect(start.agentType).toBe("code-reviewer");

    const stop = vscodeCopilotAdapter.parseEvent!("SubagentStop", {
      ...COMMON,
      agent_id: "agent-7",
      agent_transcript_path: "/x/subagents/agent-7.jsonl",
      last_assistant_message: "done",
      stop_hook_active: false,
    }) as SubagentStopEvent;
    // The missing-agent_type quirk stays tolerated.
    expect(stop.agentType).toBeUndefined();
    expect(stop.agentId).toBe("agent-7");
    expect(stop.agentTranscriptPath).toBe("/x/subagents/agent-7.jsonl");
    expect(stop.lastAssistantMessage).toBe("done");
    expect(stop.stopHookActive).toBe(false);
  });

  it("PermissionRequest / PostToolUseFailure throw (no VS Code analog)", () => {
    expect(() =>
      vscodeCopilotAdapter.parseEvent!("PermissionRequest", COMMON),
    ).toThrow(/unsupported vscode-copilot hook event/);
    expect(() =>
      vscodeCopilotAdapter.parseEvent!("PostToolUseFailure", COMMON),
    ).toThrow(/unsupported vscode-copilot hook event/);
  });

  it("SubagentStop deny → TOP-LEVEL {decision:'block', reason} (Stop semantics, NOT permissionDecision)", () => {
    const reply = parseStdout(
      vscodeCopilotAdapter.formatReply!("SubagentStop", {
        decision: "deny",
        reason: "keep going",
      }),
    );
    expect(reply).toEqual({ decision: "block", reason: "keep going" });
    expect(reply.hookSpecificOutput).toBeUndefined();
  });

  it("PreToolUse deny still uses hookSpecificOutput.permissionDecision (regression guard)", () => {
    const reply = parseStdout(
      vscodeCopilotAdapter.formatReply!("PreToolUse", {
        decision: "deny",
        reason: "nope",
      }),
    );
    expect(reply.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("SubagentStart: context → additionalContext; deny degrades to context+reason; void → exit 0", () => {
    const context = parseStdout(
      vscodeCopilotAdapter.formatReply!("SubagentStart", {
        decision: "context",
        additionalContext: "subagent ctx",
      }),
    );
    expect(context.hookSpecificOutput).toEqual({
      hookEventName: "SubagentStart",
      additionalContext: "subagent ctx",
    });

    const denied = parseStdout(
      vscodeCopilotAdapter.formatReply!("SubagentStart", {
        decision: "deny",
        reason: "spawn is not blockable",
      }),
    );
    expect(denied.hookSpecificOutput.additionalContext).toBe(
      "spawn is not blockable",
    );
    expect(denied.hookSpecificOutput.permissionDecision).toBeUndefined();

    const noop = vscodeCopilotAdapter.formatReply!("SubagentStart", {});
    expect(noop).toEqual({ exitCode: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GitHub Copilot CLI
// ─────────────────────────────────────────────────────────────────────────

describe("copilot-cli — extended-event install", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector(), "user");
  });

  it("registers all four extension events PascalCase 1:1 with matchers (write-all adapter)", () => {
    const changes = copilotCliAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "warn")).toBe(false);

    const hooksPath = join(projectDir, ".copilot", "hooks", "agent-connector.json");
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
