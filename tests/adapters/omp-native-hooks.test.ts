/**
 * adapters/omp-native-hooks — nativeHooks passthrough for omp.
 *
 * OMP's main-loop lifecycle events — agent_start, agent_end, turn_start,
 * turn_end — have NO canonical HookEventName analog (verified in oh-my-pi
 * shared-events.ts), so they are not in EVENT_TO_OMP. A connector reaches them
 * via platforms["omp"].nativeHooks; the generated ts-plugin index.js REGISTERS a
 * pi.on(<native_event>, …) handler that bridges the native event name verbatim to
 * the home-bin → runNativeHook dispatches it host-generically. These tests lock:
 *   - the generated index.js contains pi.on("agent_start"…) + bridge("agent_start"…)
 *   - supportsNativeHooks is true
 *   - a NATIVE-ONLY connector (no canonical hooks) still synthesizes the plugin
 *   - hooks:false (canonical-disabled) + a nativeHook STILL registers the plugin
 */
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import ompAdapter from "../../src/adapters/omp/index.js";

const CONNECTOR_ID = "acme-omp-native";
const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";

function buildCtx(projectDir: string, c: ResolvedConnector): InstallContext {
  return {
    connector: c,
    scope: "project",
    projectDir,
    homeBinPath: HOME_BIN,
    dataRoot: projectDir,
    dryRun: false,
  };
}

/** Path of the generated ts-plugin module (project scope). */
function entryPath(projectDir: string): string {
  return join(projectDir, ".omp", "extensions", CONNECTOR_ID, "index.js");
}

let saved: Record<string, string | undefined> = {};
const KEYS = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_PROJECT_DIR"];
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function freshHome(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ac-omp-native-")));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.PI_CODING_AGENT_DIR;
  return dir;
}

/** A normalized PreToolUse hook + an omp-native main-loop hook. */
function nativeConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme OMP",
    version: "1.0.0",
    hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
    platforms: {
      omp: {
        nativeHooks: {
          agent_start: { handler: () => ({}) },
          turn_end: { handler: () => ({}) },
        },
      },
    },
  });
}

describe("omp adapter — nativeHooks passthrough", () => {
  it("declares supportsNativeHooks true", () => {
    expect(ompAdapter.capabilities.supportsNativeHooks).toBe(true);
  });

  it("generated index.js registers + bridges each declared native event verbatim", () => {
    const projectDir = freshHome();
    ompAdapter.installHooks(buildCtx(projectDir, nativeConnector()));
    const src = readFileSync(entryPath(projectDir), "utf8");

    // native registrations present, by the native event name (not a canonical one)
    expect(src).toContain('pi.on("agent_start"');
    expect(src).toContain('bridge("agent_start"');
    expect(src).toContain('pi.on("turn_end"');
    expect(src).toContain('bridge("turn_end"');
    // the canonical handler still wired alongside (no regression)
    expect(src).toContain('pi.on("tool_call"');
  });

  it("native-only connector (no canonical hooks) STILL synthesizes the plugin", () => {
    const projectDir = freshHome();
    const connector = defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme OMP Native Only",
      version: "1.0.0",
      platforms: { omp: { nativeHooks: { agent_start: { handler: () => ({}) } } } },
    });

    const changes = ompAdapter.installHooks(buildCtx(projectDir, connector));
    // not a skip — the module is written for the native event
    expect(changes.some((c) => c.action === "skip")).toBe(false);

    const src = readFileSync(entryPath(projectDir), "utf8");
    expect(src).toContain('pi.on("agent_start"');
    expect(src).toContain('bridge("agent_start"');
    // no canonical handler, but the factory + bridge scaffolding is still valid
    expect(src).not.toContain('pi.on("tool_call"');
    expect(src).toContain("export default function plugin(pi)");
  });

  it("hooks:false disables canonical events but a nativeHook STILL registers the plugin", () => {
    const projectDir = freshHome();
    const connector = defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme OMP Hooks Off",
      version: "1.0.0",
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: {
        omp: { hooks: false, nativeHooks: { turn_start: { handler: () => ({}) } } },
      },
    });

    const changes = ompAdapter.installHooks(buildCtx(projectDir, connector));
    expect(changes.some((c) => c.action === "skip")).toBe(false);

    const src = readFileSync(entryPath(projectDir), "utf8");
    expect(src).toContain('pi.on("turn_start"'); // native installed (sibling)
    expect(src).toContain('bridge("turn_start"');
    expect(src).not.toContain('pi.on("tool_call"'); // canonical disabled by hooks:false
  });

  it("idempotent second install → skip; uninstall removes the extension", () => {
    const projectDir = freshHome();
    const ctx = buildCtx(projectDir, nativeConnector());
    ompAdapter.installHooks(ctx);
    const second = ompAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    ompAdapter.uninstallHooks(ctx);
    const removed = ompAdapter.uninstallHooks(ctx);
    expect(removed.every((c) => c.action === "skip")).toBe(true);
  });
});
