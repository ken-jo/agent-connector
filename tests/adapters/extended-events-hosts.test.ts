/**
 * tests/adapters/extended-events-hosts — E1 extension-event wiring
 * (PermissionRequest, PostToolUseFailure, SubagentStart, SubagentStop) on the
 * kimi adapter.
 *
 * (codex's E1 + PostCompact slices were migrated to tests/adapters/codex.test.ts,
 * and qwen-code's E1 slice to tests/adapters/qwen-code.test.ts, per the
 * ONE-file-per-host convention — see tests/README.md.)
 *
 * Per-host native truth this pins (verified against the live host docs):
 *   • kimi      — Kimi-specific wire: agent_name (NOT agent_id/agent_type) +
 *                 response; context rides PLAIN stdout on exit 0; SubagentStop
 *                 deny blocks via EXIT 2 + stderr. NO permission hook →
 *                 declared PermissionRequest hooks warn-skip at install.
 *
 * Filesystem isolation mirrors wave2: fresh mkdtemp project dir with HOME +
 * KIMI_CODE_HOME + AGENT_CONNECTOR_DATA_DIR redirected into it; mutated env is
 * restored in afterEach.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import TOML from "@iarna/toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  PostToolUseFailureEvent,
  ResolvedConnector,
  SubagentStartEvent,
  SubagentStopEvent,
} from "../../src/core/types.js";

import kimiAdapter from "../../src/adapters/kimi/index.js";

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-db";

/** A hooks-only connector declaring ALL FOUR E1 events (plus PreToolUse). */
function buildConnector(id = CONNECTOR_ID): ResolvedConnector {
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

/** A connector declaring ONLY one hook event — exercises a host's single-event install path. */
function buildSingleEventConnector(
  id: string,
  event: "PostToolUseFailure" | "PermissionRequest",
): ResolvedConnector {
  return defineConnector({
    id,
    hooks: {
      [event]: {
        handler() {
          return undefined;
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
    dataRoot: join(projectDir, ".agent-connector"),
    dryRun: false,
  };
}

// Track + restore mutated env so the suite never leaks state.
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let savedKimiHome: string | undefined;
let savedDataDir: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  savedKimiHome = process.env.KIMI_CODE_HOME;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("USERPROFILE", savedUserProfile);
  restore("KIMI_CODE_HOME", savedKimiHome);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function freshProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.KIMI_CODE_HOME = join(dir, ".kimi");
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  return dir;
}

function readToml(path: string): Record<string, any> {
  return TOML.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

function parsed(reply: { stdout?: string }): Record<string, any> {
  return JSON.parse(reply.stdout ?? "{}");
}

// ─────────────────────────────────────────────────────────────────────────
// kimi
// ─────────────────────────────────────────────────────────────────────────

describe("kimi E1 events", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-ext-kimi-");
    // Kimi is user-scoped via $KIMI_CODE_HOME (set by freshProject to <dir>/.kimi).
    ctx = buildCtx(projectDir, buildConnector(), "user");
  });

  it("capabilities: every canonical event wired (full coverage incl. permissionRequest)", () => {
    const c = kimiAdapter.capabilities;
    expect(c.preToolUse).toBe(true);
    expect(c.postToolUse).toBe(true);
    expect(c.userPromptSubmit).toBe(true);
    expect(c.stop).toBe(true);
    expect(c.sessionStart).toBe(true);
    expect(c.sessionEnd).toBe(true);
    expect(c.preCompact).toBe(true);
    expect(c.postCompact ?? false).toBe(true);
    expect(c.notification).toBe(true);
    expect(c.permissionRequest ?? false).toBe(true);
    expect(c.postToolUseFailure).toBe(true);
    expect(c.subagentStart).toBe(true);
    expect(c.subagentStop).toBe(true);
  });

  it("installHooks writes one [[hooks]] entry PER declared event (no clobber); no warn now PermissionRequest is supported", () => {
    const changes = kimiAdapter.installHooks(ctx);

    // PermissionRequest is now a supported (observation-only) event → no warn-skip.
    expect(changes.filter((c) => c.action === "warn")).toHaveLength(0);

    const cfg = readToml(join(projectDir, ".kimi", "config.toml"));
    // The connector declares 5 events (PreToolUse, PermissionRequest,
    // PostToolUseFailure, SubagentStart, SubagentStop) — all wired now.
    expect(cfg.hooks).toHaveLength(5);
    const byEvent = new Map(cfg.hooks.map((h: any) => [h.event, h]));
    for (const event of [
      "PreToolUse",
      "PermissionRequest",
      "PostToolUseFailure",
      "SubagentStart",
      "SubagentStop",
    ]) {
      const entry = byEvent.get(event) as any;
      expect(entry, `missing [[hooks]] entry for ${event}`).toBeDefined();
      expect(entry.command).toContain(`hook kimi ${event}`);
      expect(entry.command).toContain(`--connector ${CONNECTOR_ID}`);
    }
    // Only the PreToolUse deny gate carries the native tool matcher.
    expect((byEvent.get("PreToolUse") as any).matcher).toContain("mcp__");
    expect((byEvent.get("SubagentStop") as any).matcher).toBe("");
    expect((byEvent.get("PermissionRequest") as any).matcher).toBe("");
  });

  it("installHooks is idempotent across multiple events; uninstall removes them all", () => {
    kimiAdapter.installHooks(ctx);
    const second = kimiAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
    expect(readToml(join(projectDir, ".kimi", "config.toml")).hooks).toHaveLength(5);

    kimiAdapter.uninstallHooks(ctx);
    expect(readToml(join(projectDir, ".kimi", "config.toml")).hooks).toBeUndefined();
  });

  it("a PermissionRequest-only connector now installs a hook + creates config.toml (gap closed)", () => {
    const only = buildCtx(
      projectDir,
      buildSingleEventConnector("acme-perm", "PermissionRequest"),
      "user",
    );
    const changes = kimiAdapter.installHooks(only);
    expect(changes.filter((c) => c.action === "warn")).toHaveLength(0);
    expect(changes.some((c) => c.action === "create")).toBe(true);
    const cfg = readToml(join(projectDir, ".kimi", "config.toml"));
    expect(cfg.hooks).toHaveLength(1);
    expect(cfg.hooks[0].event).toBe("PermissionRequest");
  });

  it("parseEvent maps Kimi's wire: agent_name → agentType, response → lastAssistantMessage", () => {
    const fail = kimiAdapter.parseEvent!("PostToolUseFailure", {
      session_id: "km-1",
      cwd: "/work/proj",
      tool_name: "Shell",
      tool_input: { command: "make" },
      error: "exit status 2",
      connector: CONNECTOR_ID,
    }) as PostToolUseFailureEvent;
    expect(fail.hostPlatform).toBe("kimi");
    expect(fail.toolName).toBe("Shell");
    expect(fail.error).toBe("exit status 2");
    expect(fail.toolUseId).toBeUndefined();

    const start = kimiAdapter.parseEvent!("SubagentStart", {
      session_id: "km-1",
      agent_name: "coder",
      prompt: "fix the tests",
    }) as SubagentStartEvent;
    expect(start.agentType).toBe("coder");
    expect(start.agentId).toBeUndefined();

    const stop = kimiAdapter.parseEvent!("SubagentStop", {
      session_id: "km-1",
      agent_name: "coder",
      response: "all green",
    }) as SubagentStopEvent;
    expect(stop.agentType).toBe("coder");
    expect(stop.lastAssistantMessage).toBe("all green");
  });

  it("formatReply: context rides PLAIN stdout on exit 0 (Kimi protocol), deny degrades", () => {
    const failCtx = kimiAdapter.formatReply!("PostToolUseFailure", {
      decision: "context",
      additionalContext: "retry with --force",
    });
    expect(failCtx.exitCode).toBe(0);
    expect(failCtx.stdout).toBe("retry with --force");

    const failDeny = kimiAdapter.formatReply!("PostToolUseFailure", {
      decision: "deny",
      reason: "not blockable — degrade",
    });
    expect(failDeny.exitCode).toBe(0);
    expect(failDeny.stdout).toBe("not blockable — degrade");

    const startCtx = kimiAdapter.formatReply!("SubagentStart", {
      decision: "context",
      additionalContext: "subagent conventions",
    });
    expect(startCtx.exitCode).toBe(0);
    expect(startCtx.stdout).toBe("subagent conventions");
  });

  it("formatReply SubagentStop: deny → EXIT 2 + stderr (block); context → stdout", () => {
    const deny = kimiAdapter.formatReply!("SubagentStop", {
      decision: "deny",
      reason: "verify before stopping",
    });
    expect(deny.exitCode).toBe(2);
    expect(deny.stderr).toBe("verify before stopping");
    expect(deny.stdout).toBeUndefined();

    const ctxReply = kimiAdapter.formatReply!("SubagentStop", {
      decision: "context",
      additionalContext: "wrap-up notes",
    });
    expect(ctxReply.exitCode).toBe(0);
    expect(ctxReply.stdout).toBe("wrap-up notes");
  });

  it("formatReply PermissionRequest degrades to silent allow (fired, but observation-only)", () => {
    // Kimi fires PermissionRequest but it is NOT blockable, so a deny degrades.
    const reply = kimiAdapter.formatReply!("PermissionRequest", {
      decision: "deny",
      reason: "would block if it could",
    });
    expect(reply.exitCode).toBe(0);
    expect(reply.stdout).toBeUndefined();
    expect(reply.stderr).toBeUndefined();
  });

  it("formatReply Stop: deny → EXIT 2 + stderr (continue); context → exit-0 stdout", () => {
    const deny = kimiAdapter.formatReply!("Stop", {
      decision: "deny",
      reason: "keep going — task incomplete",
    });
    expect(deny.exitCode).toBe(2);
    expect(deny.stderr).toBe("keep going — task incomplete");
    expect(deny.stdout).toBeUndefined();

    const ctxReply = kimiAdapter.formatReply!("Stop", {
      decision: "context",
      additionalContext: "remaining checklist",
    });
    expect(ctxReply.exitCode).toBe(0);
    expect(ctxReply.stdout).toBe("remaining checklist");
  });

  it("formatReply UserPromptSubmit: deny → EXIT 2 + stderr (block turn); context → exit-0 stdout", () => {
    const deny = kimiAdapter.formatReply!("UserPromptSubmit", {
      decision: "deny",
      reason: "prompt rejected by policy",
    });
    expect(deny.exitCode).toBe(2);
    expect(deny.stderr).toBe("prompt rejected by policy");
    expect(deny.stdout).toBeUndefined();

    const ctxReply = kimiAdapter.formatReply!("UserPromptSubmit", {
      decision: "context",
      additionalContext: "appended preamble",
    });
    expect(ctxReply.exitCode).toBe(0);
    expect(ctxReply.stdout).toBe("appended preamble");
  });

  it("formatReply observation-only events (PostToolUse/SessionStart/etc.) degrade to exit-0 allow", () => {
    for (const ev of ["PostToolUse", "SessionStart", "SessionEnd", "PreCompact", "PostCompact", "Notification"] as const) {
      const reply = kimiAdapter.formatReply!(ev, { decision: "deny", reason: "x" });
      expect(reply.exitCode, `${ev} should degrade to allow`).toBe(0);
      expect(reply.stderr).toBeUndefined();
    }
  });
});
