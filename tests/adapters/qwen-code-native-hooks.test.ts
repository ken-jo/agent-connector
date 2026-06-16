/**
 * adapters/qwen-code-native-hooks — nativeHooks passthrough for qwen-code.
 *
 * Qwen's 16-event hook surface is wider than the canonical union: it adds 3
 * host-specific events with no canonical analog — TodoCreated / TodoCompleted /
 * StopFailure (QwenLM/qwen-code docs/users/features/hooks.md). A connector reaches
 * them via platforms["qwen-code"].nativeHooks; installHooks files the PascalCase
 * event-name key VERBATIM into settings.json hooks, and the generic uninstall
 * reverses it by connector-id ownership.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import qwenAdapter from "../../src/adapters/qwen-code/index.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-qwen-native";

function buildCtx(projectDir: string, connector: ResolvedConnector): InstallContext {
  return { connector, scope: "user", projectDir, homeBinPath: HOME_BIN, dataRoot: projectDir, dryRun: false };
}
function readHooks(ctx: InstallContext): Record<string, any[]> {
  const file = JSON.parse(readFileSync(qwenAdapter.getHookConfigPath!(ctx), "utf8"));
  return (file.hooks ?? {}) as Record<string, any[]>;
}

let savedHome: string | undefined;
let savedUP: string | undefined;
beforeEach(() => { savedHome = process.env.HOME; savedUP = process.env.USERPROFILE; });
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedUP === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUP;
});
function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-qwen-native-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return dir;
}

function nativeConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
    platforms: {
      "qwen-code": { nativeHooks: { TodoCreated: { matcher: "", handler: () => ({}) } } },
    },
  });
}

describe("qwen-code adapter — nativeHooks passthrough", () => {
  it("declares supportsNativeHooks true", () => {
    expect(qwenAdapter.capabilities.supportsNativeHooks).toBe(true);
  });

  it("files the native TodoCreated key VERBATIM beside the canonical PreToolUse", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, nativeConnector());
    qwenAdapter.installHooks(ctx);
    const hooks = readHooks(ctx);
    expect(hooks.PreToolUse[0].hooks[0].command).toContain("hook qwen-code PreToolUse");
    expect(hooks.TodoCreated[0].hooks[0].command).toContain("hook qwen-code TodoCreated");
    expect(hooks.TodoCreated[0].hooks[0].command).toContain(`--connector ${CONNECTOR_ID}`);
  });

  it("nativeHooks install even when normalized hooks are disabled (hooks:false sibling)", () => {
    const projectDir = freshProject();
    const c = defineConnector({
      id: CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: { "qwen-code": { hooks: false, nativeHooks: { StopFailure: { handler: () => ({}) } } } },
    });
    const ctx = buildCtx(projectDir, c);
    qwenAdapter.installHooks(ctx);
    const hooks = readHooks(ctx);
    expect(hooks.StopFailure[0].hooks[0].command).toContain("hook qwen-code StopFailure");
    expect(hooks.PreToolUse).toBeUndefined();
  });

  it("idempotent + uninstall strips the native key, leaving a foreign hook intact", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, nativeConnector());
    qwenAdapter.installHooks(ctx);
    expect(qwenAdapter.installHooks(ctx).every((c) => c.action === "skip")).toBe(true);

    const path = qwenAdapter.getHookConfigPath!(ctx);
    const file = JSON.parse(readFileSync(path, "utf8"));
    file.hooks.TodoCreated.push({ matcher: "", hooks: [{ type: "command", command: "/usr/bin/other run" }] });
    writeFileSync(path, JSON.stringify(file));

    qwenAdapter.uninstallHooks(ctx);
    const flat = JSON.stringify(readHooks(ctx));
    expect(flat).toContain("other run");
    expect(flat).not.toContain(HOME_BIN);
  });
});
