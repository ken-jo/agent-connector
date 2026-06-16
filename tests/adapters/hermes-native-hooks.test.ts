/**
 * adapters/hermes-native-hooks — nativeHooks passthrough for hermes.
 *
 * Hermes (Nous Research) documents many host-specific lifecycle events with NO
 * canonical analog — pre_llm_call / post_llm_call / on_session_finalize /
 * on_session_reset / pre_gateway_dispatch / pre_approval_request /
 * post_approval_response / transform_tool_result. They are host-specific (below
 * the >=3-host core bar; docs/research/host-specific-hook-events-design.md). A
 * connector reaches them via platforms["hermes"].nativeHooks; installHooks files
 * the event-name keys VERBATIM into the YAML hooks map (in ~/.hermes/config.yaml),
 * and the generic uninstall reverses them by connector-id ownership.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import { readYaml, writeYaml } from "../../src/core/yaml.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import hermesAdapter from "../../src/adapters/hermes/index.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-hermes-native";

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
function configPath(projectDir: string): string {
  return join(projectDir, ".hermes", "config.yaml");
}
function readHooks(projectDir: string): Record<string, any[]> {
  const cfg = readYaml<Record<string, any>>(configPath(projectDir)) ?? {};
  return (cfg.hooks ?? {}) as Record<string, any[]>;
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
  const dir = mkdtempSync(join(tmpdir(), "ac-hermes-native-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return dir;
}

/** A normalized PreToolUse hook + two hermes-native lifecycle hooks. */
function nativeConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Hermes",
    version: "1.0.0",
    hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
    platforms: {
      hermes: {
        nativeHooks: {
          pre_llm_call: { handler: () => ({}) },
          transform_tool_result: { matcher: "Shell", handler: () => ({}) },
        },
      },
    },
  });
}

describe("hermes adapter — nativeHooks passthrough", () => {
  it("declares supportsNativeHooks true", () => {
    expect(hermesAdapter.capabilities.supportsNativeHooks).toBe(true);
  });

  it("installHooks files native event-name keys VERBATIM beside the canonical (mapped) hook", () => {
    const projectDir = freshProject();
    hermesAdapter.installHooks(buildCtx(projectDir, nativeConnector()));
    const hooks = readHooks(projectDir);

    // Normalized PreToolUse maps to hermes' native pre_tool_call key.
    expect(hooks.pre_tool_call[0].command).toContain("hook hermes PreToolUse");
    // Native keys filed VERBATIM (no EVENT_TO_HERMES mapping).
    expect(hooks.pre_llm_call[0].command).toContain("hook hermes pre_llm_call");
    expect(hooks.pre_llm_call[0].command).toContain(`--connector ${CONNECTOR_ID}`);
    expect(hooks.transform_tool_result[0].command).toContain("hook hermes transform_tool_result");
    expect(hooks.transform_tool_result[0].matcher).toBe("Shell");
  });

  it("is idempotent (second install → skip) and uninstall removes the native entries", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, nativeConnector());
    hermesAdapter.installHooks(ctx);
    const second = hermesAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    hermesAdapter.uninstallHooks(ctx);
    expect(JSON.stringify(readHooks(projectDir))).not.toContain(HOME_BIN);
  });

  it("nativeHooks install even when normalized hooks are disabled (hooks: false sibling)", () => {
    const projectDir = freshProject();
    const connector = defineConnector({
      id: CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: { hermes: { hooks: false, nativeHooks: { pre_llm_call: { handler: () => ({}) } } } },
    });
    hermesAdapter.installHooks(buildCtx(projectDir, connector));
    const hooks = readHooks(projectDir);
    expect(hooks.pre_llm_call[0].command).toContain("hook hermes pre_llm_call");
    expect(hooks.pre_tool_call).toBeUndefined(); // normalized disabled by hooks:false
  });

  it("a native key coinciding with a mapped canonical key does NOT clobber it", () => {
    // Normalized PreToolUse maps to "pre_tool_call"; also declare a native
    // "pre_tool_call" (snake_case — NOT a canonical HookEventName, so defineConnector
    // permits it, unlike kimi where native names can't collide).
    const projectDir = freshProject();
    const connector = defineConnector({
      id: CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: { hermes: { nativeHooks: { pre_tool_call: { handler: () => ({}) } } } },
    });
    hermesAdapter.installHooks(buildCtx(projectDir, connector));
    const commands = (readHooks(projectDir).pre_tool_call ?? []).map((e: any) => e.command);
    // BOTH commands coexist (distinct event tokens) — neither was clobbered.
    expect(commands).toHaveLength(2);
    expect(commands.some((c: string) => c.includes("hook hermes PreToolUse"))).toBe(true);
    expect(commands.some((c: string) => c.includes("hook hermes pre_tool_call"))).toBe(true);
  });

  it("uninstall strips only OUR native entries, leaving a foreign hook intact", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, nativeConnector());
    hermesAdapter.installHooks(ctx);
    // Seed a foreign (non-AC) hook under the same native key our install used.
    const cfg = readYaml<Record<string, any>>(configPath(projectDir))!;
    (cfg.hooks.pre_llm_call as any[]).push({ matcher: "", command: "/usr/bin/other-tool run", timeout: 30 });
    writeYaml(configPath(projectDir), cfg, false);

    hermesAdapter.uninstallHooks(ctx);
    const hooks = readHooks(projectDir);
    // Foreign survives; every AC (HOME_BIN) command is gone.
    expect((hooks.pre_llm_call ?? []).some((e: any) => e.command.includes("other-tool"))).toBe(true);
    expect(JSON.stringify(hooks)).not.toContain(HOME_BIN);
  });
});
