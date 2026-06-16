/**
 * adapters/cursor-native-hooks — nativeHooks passthrough for cursor.
 *
 * Cursor documents many granular hooks with NO canonical analog —
 * beforeShellExecution / afterShellExecution / beforeMCPExecution /
 * afterMCPExecution / beforeReadFile / afterFileEdit / afterAgentResponse /
 * afterAgentThought (cursor.com/docs/hooks). They are host-specific (below the
 * >=3-host core bar; docs/research/host-specific-hook-events-design.md). A
 * connector reaches them via platforms["cursor"].nativeHooks; installHooks writes
 * the event-name keys VERBATIM into hooks.json (flat { command, matcher? }), and
 * the generic uninstall reverses them by connector-id ownership.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import cursorAdapter from "../../src/adapters/cursor/index.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-cursor-native";

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
function hooksFile(projectDir: string): string {
  return join(projectDir, ".cursor", "hooks.json");
}
function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "ac-cursor-native-"));
}
function commandsUnder(cfg: any, key: string): string[] {
  const bucket = cfg?.hooks?.[key];
  if (!Array.isArray(bucket)) return [];
  return bucket.map((e: any) => e.command);
}

/** A normalized PreToolUse hook + two cursor-native granular hooks. */
function nativeConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Cursor",
    version: "1.0.0",
    hooks: { PreToolUse: { matcher: "acme_query", handler: () => ({ decision: "allow" }) } },
    platforms: {
      cursor: {
        nativeHooks: {
          beforeShellExecution: { handler: () => ({}) },
          beforeReadFile: { matcher: "Read", handler: () => ({}) },
        },
      },
    },
  });
}

describe("cursor adapter — nativeHooks passthrough", () => {
  it("declares supportsNativeHooks true", () => {
    expect(cursorAdapter.capabilities.supportsNativeHooks).toBe(true);
  });

  it("installHooks writes native event-name keys VERBATIM beside the normalized (mapped) hook", () => {
    const projectDir = freshProject();
    cursorAdapter.installHooks(buildCtx(projectDir, nativeConnector()));
    const cfg = readJson(hooksFile(projectDir));

    // Normalized PreToolUse maps to Cursor's native "preToolUse" key.
    expect(cfg.hooks.preToolUse[0].command).toContain("hook cursor PreToolUse");
    // Native keys written VERBATIM (no EVENT_MAP).
    expect(cfg.hooks.beforeShellExecution[0].command).toContain("hook cursor beforeShellExecution");
    expect(cfg.hooks.beforeReadFile[0].matcher).toBe("Read");
    expect(cfg.hooks.beforeReadFile[0].command).toContain("hook cursor beforeReadFile");
    expect(cfg.version).toBe(1);
  });

  it("is idempotent (second install → skip) and uninstall removes the native entries", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, nativeConnector());
    cursorAdapter.installHooks(ctx);
    const second = cursorAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    cursorAdapter.uninstallHooks(ctx);
    const after = readJson(hooksFile(projectDir));
    expect(JSON.stringify(after.hooks ?? {})).not.toContain(HOME_BIN);
  });

  it("nativeHooks install even when normalized hooks are disabled (hooks: false sibling)", () => {
    const projectDir = freshProject();
    const connector = defineConnector({
      id: CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: {
        cursor: { hooks: false, nativeHooks: { beforeShellExecution: { handler: () => ({}) } } },
      },
    });
    cursorAdapter.installHooks(buildCtx(projectDir, connector));
    const cfg = readJson(hooksFile(projectDir));
    expect(cfg.hooks.beforeShellExecution[0].command).toContain("hook cursor beforeShellExecution");
    expect(cfg.hooks.preToolUse).toBeUndefined(); // normalized disabled
  });

  it("a native key coinciding with a normalized event's mapped key does NOT clobber it", () => {
    // Normalized PreToolUse maps to "preToolUse"; also declare a native "preToolUse"
    // (camelCase — not a canonical HookEventName, so defineConnector permits it).
    const projectDir = freshProject();
    const connector = defineConnector({
      id: CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: { cursor: { nativeHooks: { preToolUse: { handler: () => ({}) } } } },
    });
    cursorAdapter.installHooks(buildCtx(projectDir, connector));
    const commands = commandsUnder(readJson(hooksFile(projectDir)), "preToolUse");
    // BOTH commands coexist (distinct event tokens) — neither was clobbered.
    expect(commands.some((c) => c.includes("hook cursor PreToolUse"))).toBe(true);
    expect(commands.some((c) => c.includes("hook cursor preToolUse"))).toBe(true);
  });
});
