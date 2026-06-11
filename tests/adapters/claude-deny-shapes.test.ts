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
});
