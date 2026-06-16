/**
 * adapters/gemini-cli-native-hooks — nativeHooks passthrough for gemini-cli.
 *
 * Gemini's LLM-lifecycle hooks (BeforeModel, AfterAgent, BeforeToolSelection, …)
 * have NO normalized HookEventName — they are request-mutating and gemini-only,
 * below the >=3-host core bar (docs/research/host-specific-hook-events-design.md).
 * A connector reaches them via platforms["gemini-cli"].nativeHooks; installHooks
 * writes the event-name keys VERBATIM into settings.json (no EVENT_MAP), and the
 * generic uninstall reverses them by connector-id ownership.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import geminiAdapter from "../../src/adapters/gemini-cli/index.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-gem";

function buildCtx(projectDir: string, connector: ResolvedConnector): InstallContext {
  return {
    connector,
    scope: "project",
    projectDir,
    homeBinPath: HOME_BIN,
    dataRoot: projectDir,
    dryRun: false,
  };
}
function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}
function settingsFile(projectDir: string): string {
  return join(projectDir, ".gemini", "settings.json");
}
function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "ac-gem-native-"));
}
function commandsUnder(cfg: any, key: string): string[] {
  const bucket = cfg?.hooks?.[key];
  if (!Array.isArray(bucket)) return [];
  return bucket.flatMap((e: any) => (e.hooks ?? []).map((h: any) => h.command));
}

/** A normalized PreToolUse hook + two gemini-native lifecycle hooks. */
function nativeConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Gemini",
    version: "1.0.0",
    hooks: { PreToolUse: { matcher: "acme_query", handler: () => ({ decision: "allow" }) } },
    platforms: {
      "gemini-cli": {
        nativeHooks: {
          BeforeModel: { handler: () => ({}) },
          BeforeToolSelection: { matcher: "Shell", handler: () => ({}) },
        },
      },
    },
  });
}

describe("gemini-cli adapter — nativeHooks passthrough", () => {
  it("declares supportsNativeHooks true", () => {
    expect(geminiAdapter.capabilities.supportsNativeHooks).toBe(true);
  });

  it("installHooks writes native event-name keys VERBATIM beside the normalized (mapped) hook", () => {
    const projectDir = freshProject();
    geminiAdapter.installHooks(buildCtx(projectDir, nativeConnector()));
    const cfg = readJson(settingsFile(projectDir));

    // Normalized PreToolUse is mapped to Gemini's native BeforeTool key.
    expect(cfg.hooks.BeforeTool[0].hooks[0].command).toContain("hook gemini-cli PreToolUse");
    // Native keys are written VERBATIM (NOT routed through EVENT_MAP).
    expect(cfg.hooks.BeforeModel[0].hooks[0].command).toContain("hook gemini-cli BeforeModel");
    expect(cfg.hooks.BeforeToolSelection[0].matcher).toBe("Shell");
    expect(cfg.hooks.BeforeToolSelection[0].hooks[0].command).toContain(
      "hook gemini-cli BeforeToolSelection",
    );
  });

  it("is idempotent (second install → skip) and uninstall removes the native entries", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, nativeConnector());
    geminiAdapter.installHooks(ctx);
    const second = geminiAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    geminiAdapter.uninstallHooks(ctx);
    const after = readJson(settingsFile(projectDir));
    expect(JSON.stringify(after.hooks ?? {})).not.toContain(HOME_BIN);
  });

  it("nativeHooks install even when normalized hooks are disabled (hooks: false sibling)", () => {
    const projectDir = freshProject();
    const connector = defineConnector({
      id: CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: {
        "gemini-cli": { hooks: false, nativeHooks: { BeforeModel: { handler: () => ({}) } } },
      },
    });
    geminiAdapter.installHooks(buildCtx(projectDir, connector));
    const cfg = readJson(settingsFile(projectDir));
    // Native installed; the normalized PreToolUse (→ BeforeTool) is NOT.
    expect(cfg.hooks.BeforeModel[0].hooks[0].command).toContain("hook gemini-cli BeforeModel");
    expect(cfg.hooks.BeforeTool).toBeUndefined();
  });

  it("a native key coinciding with a normalized event's mapped key does NOT clobber it", () => {
    // Normalized PreToolUse maps to "BeforeTool"; also declare a native "BeforeTool".
    const projectDir = freshProject();
    const connector = defineConnector({
      id: CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: { "gemini-cli": { nativeHooks: { BeforeTool: { handler: () => ({}) } } } },
    });
    geminiAdapter.installHooks(buildCtx(projectDir, connector));
    const commands = commandsUnder(readJson(settingsFile(projectDir)), "BeforeTool");
    // BOTH commands coexist (distinct event tokens) — neither was clobbered.
    expect(commands.some((c) => c.includes("hook gemini-cli PreToolUse"))).toBe(true);
    expect(commands.some((c) => c.includes("hook gemini-cli BeforeTool"))).toBe(true);
  });
});
