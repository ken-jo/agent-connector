/**
 * adapters/jetbrains-copilot-block-contract — turn-control deny shape.
 *
 * JetBrains Copilot's reply contract is identical to vscode-copilot's:
 * `hookSpecificOutput.permissionDecision` is read ONLY for the pre-execution
 * PreToolUse event; the post-execution / turn-control events (PostToolUse,
 * UserPromptSubmit, Stop, SubagentStop) block via the TOP-LEVEL
 * {"decision":"block","reason"}. Previously formatReply routed EVERY deny through
 * permissionDecision, so a PostToolUse / UserPromptSubmit deny was a silent no-op
 * (same class as the vscode-copilot #58 bug). This also wires UserPromptSubmit.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import jetbrainsAdapter from "../../src/adapters/jetbrains-copilot/index.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-jb-block";

function buildCtx(projectDir: string, connector: ResolvedConnector): InstallContext {
  return { connector, scope: "project", projectDir, homeBinPath: HOME_BIN, dataRoot: projectDir, dryRun: false };
}

describe("jetbrains-copilot adapter — turn-control block contract", () => {
  it("capabilities: userPromptSubmit now true", () => {
    expect(jetbrainsAdapter.capabilities.userPromptSubmit).toBe(true);
  });

  it("installHooks wires UserPromptSubmit (PascalCase)", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "ac-jb-block-"));
    const ctx = buildCtx(
      projectDir,
      defineConnector({
        id: CONNECTOR_ID,
        hooks: { UserPromptSubmit: { handler: () => ({ decision: "allow" }) } },
      }),
    );
    jetbrainsAdapter.installHooks(ctx);
    const file = JSON.parse(readFileSync(jetbrainsAdapter.getHookConfigPath!(ctx), "utf8"));
    expect(file.hooks.UserPromptSubmit[0].command).toContain("hook jetbrains-copilot UserPromptSubmit");
  });

  it("formatReply: PostToolUse + UserPromptSubmit deny → TOP-LEVEL {decision:block} (not permissionDecision)", () => {
    for (const event of ["PostToolUse", "UserPromptSubmit"] as const) {
      const out = JSON.parse(
        jetbrainsAdapter.formatReply!(event, { decision: "deny", reason: "blocked" }).stdout ?? "{}",
      );
      expect(out.decision).toBe("block");
      expect(out.reason).toBe("blocked");
      expect(out.hookSpecificOutput).toBeUndefined();
    }
  });

  it("formatReply: PreToolUse deny still uses permissionDecision (no regression)", () => {
    const out = JSON.parse(
      jetbrainsAdapter.formatReply!("PreToolUse", { decision: "deny", reason: "no" }).stdout ?? "{}",
    );
    expect(out.decision).toBeUndefined();
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("no");
  });
});
