/**
 * tests/adapters/claude-deny-shapes — Claude's deny shape is event-specific.
 *
 * Regression for a bug found porting oh-my-claudecode: formatReply rendered
 * EVERY deny as hookSpecificOutput.permissionDecision, but Claude only honors
 * that on PreToolUse. Stop / UserPromptSubmit / PostToolUse take the TOP-LEVEL
 * {"decision":"block","reason"} — with the old shape, OMC ralph's Stop-deny
 * persistence loop silently never blocked.
 */

import { describe, expect, it } from "vitest";

import { ADAPTER_REGISTRY } from "../../src/adapters/registry.js";

async function loadClaude() {
  const entry = ADAPTER_REGISTRY.find((a) => a.id === "claude-code");
  if (!entry) throw new Error("claude-code adapter missing from registry");
  return entry.load();
}

function parsed(reply: { exitCode: number; stdout?: string }) {
  expect(reply.exitCode).toBe(0);
  expect(reply.stdout).toBeTruthy();
  return JSON.parse(reply.stdout as string) as Record<string, unknown>;
}

describe("claude-code formatReply deny shapes", () => {
  it("Stop deny → top-level {decision:'block'} (the ralph persistence contract)", async () => {
    const adapter = await loadClaude();
    const out = parsed(
      adapter.formatReply("Stop", { decision: "deny", reason: "boulder rolls on" }),
    );
    expect(out.decision).toBe("block");
    expect(out.reason).toBe("boulder rolls on");
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it("UserPromptSubmit deny → top-level block", async () => {
    const adapter = await loadClaude();
    const out = parsed(
      adapter.formatReply("UserPromptSubmit", { decision: "deny", reason: "nope" }),
    );
    expect(out.decision).toBe("block");
    expect(out.reason).toBe("nope");
  });

  it("PostToolUse deny → top-level block (reason fed back to the model)", async () => {
    const adapter = await loadClaude();
    const out = parsed(
      adapter.formatReply("PostToolUse", { decision: "deny", reason: "redo it" }),
    );
    expect(out.decision).toBe("block");
  });

  it("PreToolUse deny → hookSpecificOutput.permissionDecision (unchanged)", async () => {
    const adapter = await loadClaude();
    const out = parsed(
      adapter.formatReply("PreToolUse", { decision: "deny", reason: "blocked" }),
    );
    const hso = out.hookSpecificOutput as Record<string, unknown>;
    expect(hso.permissionDecision).toBe("deny");
    expect(hso.permissionDecisionReason).toBe("blocked");
    expect(out.decision).toBeUndefined();
  });

  it("PreToolUse ask stays a permissionDecision", async () => {
    const adapter = await loadClaude();
    const out = parsed(
      adapter.formatReply("PreToolUse", { decision: "ask", reason: "sure?" }),
    );
    const hso = out.hookSpecificOutput as Record<string, unknown>;
    expect(hso.permissionDecision).toBe("ask");
  });

  it("SubagentStop deny → top-level block (Stop semantics: keeps the subagent running)", async () => {
    const adapter = await loadClaude();
    const out = parsed(
      adapter.formatReply("SubagentStop", {
        decision: "deny",
        reason: "verify before stopping",
      }),
    );
    expect(out.decision).toBe("block");
    expect(out.reason).toBe("verify before stopping");
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it("PostToolUseFailure deny DEGRADES to additionalContext (not blockable)", async () => {
    const adapter = await loadClaude();
    const out = parsed(
      adapter.formatReply("PostToolUseFailure", {
        decision: "deny",
        reason: "retry with --force",
      }),
    );
    expect(out.decision).toBeUndefined();
    const hso = out.hookSpecificOutput as Record<string, unknown>;
    expect(hso.hookEventName).toBe("PostToolUseFailure");
    expect(hso.additionalContext).toBe("retry with --force");
  });

  it("SubagentStart context → additionalContext (observe-only)", async () => {
    const adapter = await loadClaude();
    const out = parsed(
      adapter.formatReply("SubagentStart", {
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

  it("deny → hookSpecificOutput.decision{behavior:'deny', message}", async () => {
    const adapter = await loadClaude();
    const out = parsed(
      adapter.formatReply("PermissionRequest", {
        decision: "deny",
        reason: "secrets stay local",
      }),
    );
    const d = permissionDecision(out);
    expect(d.behavior).toBe("deny");
    expect(d.message).toBe("secrets stay local");
    expect(out.decision).toBeUndefined(); // never the top-level Stop block shape
  });

  it("explicit allow → ACTIVE grant decision{behavior:'allow'}", async () => {
    const adapter = await loadClaude();
    const out = parsed(adapter.formatReply("PermissionRequest", { decision: "allow" }));
    const d = permissionDecision(out);
    expect(d.behavior).toBe("allow");
    expect(d.updatedInput).toBeUndefined();
  });

  it("allow with updatedInput carries the replacement input", async () => {
    const adapter = await loadClaude();
    const out = parsed(
      adapter.formatReply("PermissionRequest", {
        decision: "allow",
        updatedInput: { cmd: "ls -la" },
      }),
    );
    const d = permissionDecision(out);
    expect(d.behavior).toBe("allow");
    expect(d.updatedInput).toEqual({ cmd: "ls -la" });
  });

  it("modify with updatedInput degrades to an allow grant carrying it", async () => {
    const adapter = await loadClaude();
    const out = parsed(
      adapter.formatReply("PermissionRequest", {
        decision: "modify",
        updatedInput: { cmd: "git status" },
      }),
    );
    const d = permissionDecision(out);
    expect(d.behavior).toBe("allow");
    expect(d.updatedInput).toEqual({ cmd: "git status" });
  });

  it("ask falls through to the native dialog (exit 0, NO decision output)", async () => {
    const adapter = await loadClaude();
    const reply = adapter.formatReply("PermissionRequest", {
      decision: "ask",
      reason: "the dialog IS the ask",
    });
    expect(reply.exitCode).toBe(0);
    expect(reply.stdout).toBeUndefined();
  });

  it("no decision (void-normalized {}) falls through — never an implied grant", async () => {
    const adapter = await loadClaude();
    const reply = adapter.formatReply("PermissionRequest", {});
    expect(reply.exitCode).toBe(0);
    expect(reply.stdout).toBeUndefined();
  });
});
