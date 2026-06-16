/**
 * adapters/copilot-cli-native-hooks — nativeHooks passthrough for copilot-cli.
 *
 * GitHub Copilot CLI documents an `errorOccurred` / `ErrorOccurred` lifecycle
 * event (and other camelCase aliases) with NO canonical HookEventName analog —
 * host-specific, below the >=3-host core bar (docs/research/host-specific-hook-
 * events-design.md). A connector reaches it via platforms["copilot-cli"].
 * nativeHooks; installHooks files the event-name key VERBATIM into the
 * Claude-shaped hooks file (~/.copilot/hooks/agent-connector.json), and the
 * generic uninstall reverses it by connector-id ownership.
 *
 * Copilot CLI's hooks file uses PascalCase keys (the Claude-compatible payload
 * convention the adapter already adopts), so `ErrorOccurred` is the native key.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import copilotCliAdapter from "../../src/adapters/copilot-cli/index.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-copilot-native";

function buildCtx(projectDir: string, connector: ResolvedConnector): InstallContext {
  return {
    connector,
    scope: "user",
    projectDir,
    homeBinPath: HOME_BIN,
    dataRoot: projectDir,
    dryRun: false,
  };
}
function readHooks(ctx: InstallContext): Record<string, any[]> {
  const file = JSON.parse(readFileSync(copilotCliAdapter.getHookConfigPath!(ctx), "utf8"));
  return (file.hooks ?? {}) as Record<string, any[]>;
}

let savedHome: string | undefined;
let savedUserProfile: string | undefined;
beforeEach(() => {
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
});
afterEach(() => {
  restore("HOME", savedHome);
  restore("USERPROFILE", savedUserProfile);
});
function restore(k: string, v: string | undefined): void {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-copilot-native-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return dir;
}

/** A normalized PreToolUse hook + a copilot-native ErrorOccurred hook. */
function nativeConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
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

describe("copilot-cli adapter — nativeHooks passthrough", () => {
  it("declares supportsNativeHooks true", () => {
    expect(copilotCliAdapter.capabilities.supportsNativeHooks).toBe(true);
  });

  it("installHooks files the native ErrorOccurred key VERBATIM beside the canonical PreToolUse", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, nativeConnector());
    copilotCliAdapter.installHooks(ctx);
    const hooks = readHooks(ctx);

    expect(hooks.PreToolUse[0].hooks[0].command).toContain("hook copilot-cli PreToolUse");
    // Native key filed verbatim (no EVENT_MAP) with the native event token.
    expect(hooks.ErrorOccurred[0].hooks[0].command).toContain("hook copilot-cli ErrorOccurred");
    expect(hooks.ErrorOccurred[0].hooks[0].command).toContain(`--connector ${CONNECTOR_ID}`);
    expect(hooks.ErrorOccurred[0].matcher).toBe("Bash");
  });

  it("nativeHooks install even when normalized hooks are disabled (hooks:false sibling)", () => {
    const projectDir = freshProject();
    const connector = defineConnector({
      id: CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: {
        "copilot-cli": { hooks: false, nativeHooks: { ErrorOccurred: { handler: () => ({}) } } },
      },
    });
    const ctx = buildCtx(projectDir, connector);
    copilotCliAdapter.installHooks(ctx);
    const hooks = readHooks(ctx);
    expect(hooks.ErrorOccurred[0].hooks[0].command).toContain("hook copilot-cli ErrorOccurred");
    expect(hooks.PreToolUse).toBeUndefined(); // normalized disabled by hooks:false
  });

  it("is idempotent (second install → skip) and uninstall removes the native entry", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, nativeConnector());
    copilotCliAdapter.installHooks(ctx);
    const second = copilotCliAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    copilotCliAdapter.uninstallHooks(ctx);
    expect(JSON.stringify(readHooks(ctx))).not.toContain(HOME_BIN);
  });

  it("uninstall strips only OUR native entry, leaving a foreign hook intact", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, nativeConnector());
    copilotCliAdapter.installHooks(ctx);
    // Seed a foreign (non-AC) hook under the same native key.
    const path = copilotCliAdapter.getHookConfigPath!(ctx);
    const file = JSON.parse(readFileSync(path, "utf8"));
    file.hooks.ErrorOccurred.push({ matcher: "", hooks: [{ type: "command", command: "/usr/bin/other run" }] });
    writeFileSync(path, JSON.stringify(file));

    copilotCliAdapter.uninstallHooks(ctx);
    const hooks = readHooks(ctx);
    const flat = JSON.stringify(hooks);
    expect(flat).toContain("other run"); // foreign survives
    expect(flat).not.toContain(HOME_BIN); // every AC command gone
  });
});
