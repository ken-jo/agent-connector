/**
 * adapters/nemoclaw — UserPromptSubmit (before_prompt_build) + supportsNativeHooks.
 *
 * OpenClaw's before_prompt_build fires PER TURN and can ONLY inject context — it
 * has NO blocking ability. NemoClaw INHERITS the whole machinery, host-bound to
 * "nemoclaw". This suite proves the inherited wiring for nemoclaw:
 *  (b) capabilities.userPromptSubmit && supportsNativeHooks are true;
 *  (d) NemoClaw generates the same before_prompt_build + UserPromptSubmit bridge,
 *      dispatched to "nemoclaw"; nativeHooks passthrough + parseEvent are covered.
 *
 * (The openclaw rows + openclaw-specific blocks of this suite — the
 * generated-source mapping, the live coexistence bridge, and the deny-degrades
 * behavior — have moved to adapters/openclaw.test.ts; this file finishes the
 * nemoclaw migration in a later PR.)
 *
 * Filesystem isolation: every test gets a fresh mkdtemp project dir with HOME +
 * USERPROFILE redirected there, restored in afterEach. Project scope throughout
 * for deterministic plugin paths. POSIX is pinned so the generated bridge takes
 * its execFileSync(HOME_BIN, [argv]) path.
 */

import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import nemoclawAdapter from "../../src/adapters/nemoclaw/index.js";

// ── node:child_process mock (hoisted above imports) ───────────────────────────
let execFileSyncImpl: (...args: any[]) => string = () => "";
const execFileSyncMock = vi.fn((...args: any[]) => execFileSyncImpl(...args));
vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  execSync: execFileSyncMock,
}));

const CONNECTOR_ID = "acme-ups";
const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";

// ── Connectors ────────────────────────────────────────────────────────────────

/** Declares BOTH SessionStart and UserPromptSubmit (global hooks, host-agnostic). */
function connectorBoth(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    hooks: {
      SessionStart: { handler: () => ({ decision: "allow" }) },
      UserPromptSubmit: { handler: () => ({ decision: "allow" }) },
    },
  });
}

/** A canonical PreToolUse hook + a host-native passthrough hook, hooks toggled. */
function connectorNative(host: string, hooksDisabled: boolean): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
    platforms: {
      [host]: {
        nativeHooks: { agent_turn: { handler: () => undefined } },
        ...(hooksDisabled ? { hooks: false } : {}),
      },
    },
  });
}

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

// ── Isolation ─────────────────────────────────────────────────────────────────
const REAL_PLATFORM = process.platform;
let savedHome: string | undefined;
let savedUP: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedUP = process.env.USERPROFILE;
  execFileSyncMock.mockClear();
  execFileSyncImpl = () => "";
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUP === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUP;
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
});

function freshProject(): string {
  // realpathSync.native (NOT plain realpathSync) expands the Windows 8.3 short
  // name (e.g. RUNNER~1) to its long form. The "~" would otherwise survive into
  // pathToFileURL as %7E and the dynamic import()'s resolver fails to decode it
  // ("Does the file exist?"). Mirrors the opencode / mimo-code / kilo tests.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ac-openclaw-ups-")));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return dir;
}

// ── (b) capabilities (nemoclaw) ────────────────────────────────────────────────

describe.each([
  ["nemoclaw", nemoclawAdapter],
])("%s adapter — userPromptSubmit + supportsNativeHooks capabilities", (_name, adapter) => {
  it("declares userPromptSubmit && supportsNativeHooks", () => {
    expect(adapter.capabilities.userPromptSubmit).toBe(true);
    expect(adapter.capabilities.supportsNativeHooks).toBe(true);
  });
});

// ── supportsNativeHooks — passthrough loop (nemoclaw) ──────────────────────────

describe.each([
  ["nemoclaw", nemoclawAdapter],
])("%s adapter — nativeHooks passthrough", (name, adapter) => {
  it("a nativeHooks event registers an on(...) bridge in the generated plugin", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, connectorNative(name, false));
    adapter.installHooks(ctx);
    const src = readFileSync(adapter.getHookConfigPath(ctx), "utf8");
    expect(src).toContain('on("agent_turn"');
    expect(src).toContain('bridge("agent_turn"');
  });

  it("nativeHooks SURVIVE hooks:false while canonical handlers are suppressed", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, connectorNative(name, true));
    adapter.installHooks(ctx);
    const src = readFileSync(adapter.getHookConfigPath(ctx), "utf8");
    // Native passthrough was written despite hooks:false.
    expect(src).toContain('on("agent_turn"');
    // Canonical handlers suppressed by the canonicalOff guard.
    expect(src).not.toContain('on("before_tool_call"');
  });
});

// ── (d) nemoclaw inheritance ──────────────────────────────────────────────────

describe("nemoclaw adapter — inherits UserPromptSubmit, host-bound to nemoclaw", () => {
  it("generates the same before_prompt_build + UserPromptSubmit bridge, dispatched to nemoclaw", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, connectorBoth());
    nemoclawAdapter.installHooks(ctx);
    const src = readFileSync(nemoclawAdapter.getHookConfigPath(ctx), "utf8");

    expect(src).toContain('on("before_prompt_build"');
    expect(src).toContain('bridge("UserPromptSubmit"');
    // The generated bridge command is HOST-BOUND to nemoclaw (NOT openclaw).
    expect(src).toContain('["hook", "nemoclaw", event');
    expect(src).not.toContain('["hook", "openclaw", event');
  });
});

// ── parseEvent ────────────────────────────────────────────────────────────────

describe.each([
  ["nemoclaw", nemoclawAdapter],
])("%s adapter — parseEvent(UserPromptSubmit)", (name, adapter) => {
  it("normalizes the bridge payload to a prompt-carrying event", () => {
    const evt = adapter.parseEvent("UserPromptSubmit", {
      prompt: "do the thing",
      sessionId: "uc-9",
      projectDir: "/some/proj",
    });
    expect(evt).toMatchObject({
      hostPlatform: name,
      prompt: "do the thing",
      sessionId: "uc-9",
      projectDir: "/some/proj",
    });
  });
});
