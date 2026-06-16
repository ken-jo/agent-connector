/**
 * adapters/kimi-native-hooks — nativeHooks passthrough for kimi.
 *
 * Kimi's observation-only single-host events (StopFailure, PermissionResult,
 * Interrupt) have NO normalized HookEventName — below the >=3-host core bar
 * (docs/research/host-specific-hook-events-design.md). A connector reaches them
 * via platforms["kimi"].nativeHooks; installHooks writes the event-name [[hooks]]
 * entries VERBATIM into config.toml, and the generic uninstall reverses them by
 * connector-id ownership. (A native name that collides with a CANONICAL event is
 * rejected at defineConnector, so it can never reach install here.)
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import TOML from "@iarna/toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import kimiAdapter from "../../src/adapters/kimi/index.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-kimi-native";

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
function readToml(path: string): Record<string, any> {
  return TOML.parse(readFileSync(path, "utf8")) as Record<string, any>;
}
function configPath(projectDir: string): string {
  return join(projectDir, ".kimi", "config.toml");
}

let savedHome: string | undefined;
let savedKimiHome: string | undefined;
let savedKimiCodeHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedKimiHome = process.env.KIMI_HOME;
  savedKimiCodeHome = process.env.KIMI_CODE_HOME;
});
afterEach(() => {
  restore("HOME", savedHome);
  restore("KIMI_HOME", savedKimiHome);
  restore("KIMI_CODE_HOME", savedKimiCodeHome);
});
function restore(k: string, v: string | undefined): void {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-kimi-native-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  // Unset KIMI_HOME/KIMI_CODE_HOME → baseDir resolves to ~/.kimi (<dir>/.kimi).
  delete process.env.KIMI_HOME;
  delete process.env.KIMI_CODE_HOME;
  return dir;
}

/** A normalized PreToolUse hook + two kimi-native observation hooks. */
function nativeConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Kimi",
    version: "1.0.0",
    hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
    platforms: {
      kimi: {
        nativeHooks: {
          StopFailure: { handler: () => ({}) },
          Interrupt: { matcher: "esc", handler: () => ({}) },
        },
      },
    },
  });
}

describe("kimi adapter — nativeHooks passthrough", () => {
  it("declares supportsNativeHooks true", () => {
    expect(kimiAdapter.capabilities.supportsNativeHooks).toBe(true);
  });

  it("installHooks writes native event-name [[hooks]] entries VERBATIM beside the canonical one", () => {
    const projectDir = freshProject();
    kimiAdapter.installHooks(buildCtx(projectDir, nativeConnector()));
    const hooks = readToml(configPath(projectDir)).hooks as any[];
    const byEvent = new Map(hooks.map((h) => [h.event, h]));

    expect(byEvent.get("PreToolUse")?.command).toContain("hook kimi PreToolUse");
    expect(byEvent.get("StopFailure")?.command).toContain("hook kimi StopFailure");
    expect(byEvent.get("StopFailure")?.command).toContain(`--connector ${CONNECTOR_ID}`);
    expect(byEvent.get("Interrupt")?.command).toContain("hook kimi Interrupt");
    expect(byEvent.get("Interrupt")?.matcher).toBe("esc");
  });

  it("is idempotent (second install → skip) and uninstall removes the native entries", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, nativeConnector());
    kimiAdapter.installHooks(ctx);
    const second = kimiAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    kimiAdapter.uninstallHooks(ctx);
    expect(readToml(configPath(projectDir)).hooks).toBeUndefined();
  });

  it("nativeHooks install even when normalized hooks are disabled (hooks: false sibling)", () => {
    const projectDir = freshProject();
    const connector = defineConnector({
      id: CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: { kimi: { hooks: false, nativeHooks: { StopFailure: { handler: () => ({}) } } } },
    });
    kimiAdapter.installHooks(buildCtx(projectDir, connector));
    const events = ((readToml(configPath(projectDir)).hooks ?? []) as any[]).map((h) => h.event);
    expect(events).toContain("StopFailure"); // native installed (sibling)
    expect(events).not.toContain("PreToolUse"); // normalized disabled by hooks:false
  });
});
