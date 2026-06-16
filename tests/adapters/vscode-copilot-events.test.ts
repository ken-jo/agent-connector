/**
 * adapters/vscode-copilot-events — UserPromptSubmit + Stop coverage.
 *
 * VS Code Copilot's official Hook Events table (microsoft/vscode-copilot-chat:
 * assets/prompts/skills/agent-customization/references/hooks.md) is eight
 * PascalCase events INCLUDING UserPromptSubmit and Stop, which AC previously left
 * unwired (capability false / absent from EVENT_MAP). Both are BLOCKABLE: deny ->
 * the TOP-LEVEL { decision:"block", reason } per VS Code's Output Contract (NOT
 * the hookSpecificOutput.permissionDecision path, which is tool-permission-only).
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  ResolvedConnector,
  StopEvent,
  UserPromptSubmitEvent,
} from "../../src/core/types.js";

import vscodeAdapter from "../../src/adapters/vscode-copilot/index.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-vsc";

function connector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme VSC",
    version: "1.0.0",
    hooks: {
      UserPromptSubmit: { handler: () => ({ decision: "allow" }) },
      Stop: { handler: () => ({ decision: "allow" }) },
    },
  });
}
function buildCtx(projectDir: string): InstallContext {
  return {
    connector: connector(),
    scope: "project",
    projectDir,
    homeBinPath: HOME_BIN,
    dataRoot: projectDir,
    dryRun: false,
  };
}
function readJson(p: string): any {
  return JSON.parse(readFileSync(p, "utf8"));
}
function hooksFile(d: string): string {
  return join(d, ".github", "hooks", `${CONNECTOR_ID}.json`);
}
function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "ac-vsc-events-"));
}

describe("vscode-copilot adapter — UserPromptSubmit + Stop", () => {
  it("capabilities: userPromptSubmit + stop are now true", () => {
    expect(vscodeAdapter.capabilities.userPromptSubmit).toBe(true);
    expect(vscodeAdapter.capabilities.stop).toBe(true);
  });

  it("installHooks writes UserPromptSubmit + Stop PascalCase keys", () => {
    const projectDir = freshProject();
    vscodeAdapter.installHooks(buildCtx(projectDir));
    const cfg = readJson(hooksFile(projectDir));
    expect(cfg.version).toBe(1);
    expect(cfg.hooks.UserPromptSubmit[0].command).toContain("hook vscode-copilot UserPromptSubmit");
    expect(cfg.hooks.UserPromptSubmit[0].type).toBe("command");
    expect(cfg.hooks.Stop[0].command).toContain("hook vscode-copilot Stop");
  });

  it("parseEvent normalizes UserPromptSubmit (prompt) and Stop (stop_hook_active)", () => {
    const up = vscodeAdapter.parseEvent!("UserPromptSubmit", {
      session_id: "s1",
      cwd: "/w",
      prompt: "do the thing",
      connector: CONNECTOR_ID,
    }) as UserPromptSubmitEvent;
    expect(up.prompt).toBe("do the thing");

    const st = vscodeAdapter.parseEvent!("Stop", {
      session_id: "s1",
      cwd: "/w",
      stop_hook_active: true,
      connector: CONNECTOR_ID,
    }) as StopEvent;
    expect(st.stopHookActive).toBe(true);
  });

  it("formatReply: UserPromptSubmit + Stop deny -> TOP-LEVEL {decision:block} (not permissionDecision)", () => {
    const up = JSON.parse(
      vscodeAdapter.formatReply!("UserPromptSubmit", { decision: "deny", reason: "blocked prompt" }).stdout ?? "{}",
    );
    expect(up.decision).toBe("block");
    expect(up.reason).toBe("blocked prompt");
    expect(up.hookSpecificOutput).toBeUndefined();

    const st = JSON.parse(
      vscodeAdapter.formatReply!("Stop", { decision: "deny", reason: "keep going" }).stdout ?? "{}",
    );
    expect(st.decision).toBe("block");
    expect(st.reason).toBe("keep going");
    expect(st.hookSpecificOutput).toBeUndefined();
  });

  it("formatReply: PostToolUse deny -> TOP-LEVEL {decision:block} but PreToolUse keeps permissionDecision", () => {
    // hooks.md Output Contract: permissionDecision is read ONLY for PreToolUse
    // (pre-execution). PostToolUse "can block further processing with decision:
    // block" — the post-execution event uses the top-level shape, and emitting a
    // permissionDecision there is a silent no-op (the bug this guards against).
    const post = JSON.parse(
      vscodeAdapter.formatReply!("PostToolUse", { decision: "deny", reason: "bad output" }).stdout ?? "{}",
    );
    expect(post.decision).toBe("block");
    expect(post.reason).toBe("bad output");
    expect(post.hookSpecificOutput).toBeUndefined();

    // PreToolUse is the permission event — it MUST still use permissionDecision.
    const pre = JSON.parse(
      vscodeAdapter.formatReply!("PreToolUse", { decision: "deny", reason: "no" }).stdout ?? "{}",
    );
    expect(pre.decision).toBeUndefined();
    expect(pre.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(pre.hookSpecificOutput.permissionDecisionReason).toBe("no");
  });

  it("formatReply: UserPromptSubmit context -> hookSpecificOutput.additionalContext", () => {
    const out = JSON.parse(
      vscodeAdapter.formatReply!("UserPromptSubmit", {
        decision: "context",
        additionalContext: "extra context",
      }).stdout ?? "{}",
    );
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toBe("extra context");
  });
});
