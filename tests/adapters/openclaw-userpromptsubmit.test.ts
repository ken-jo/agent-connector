/**
 * adapters/openclaw — UserPromptSubmit (before_prompt_build) + supportsNativeHooks.
 *
 * OpenClaw's before_prompt_build fires PER TURN and can ONLY inject context — it
 * has NO blocking ability. This suite proves the wiring:
 *  (a) the generated plugin maps UserPromptSubmit → a before_prompt_build handler
 *      that bridges "UserPromptSubmit" (EVENT_TO_OPENCLAW is module-private, so the
 *      mapping is asserted via the generated source + live behavior);
 *  (b) capabilities.userPromptSubmit && supportsNativeHooks are true;
 *  (c) ONE before_prompt_build handler COEXISTS for BOTH SessionStart (inject ONCE,
 *      first build) AND UserPromptSubmit (inject EVERY turn) — exercised LIVE with
 *      node:child_process mocked, via SEPARATE state so the once-only SessionStart
 *      flag never suppresses the per-turn injection; a deny degrades to a no-op;
 *  (d) NemoClaw INHERITS the whole machinery, host-bound to "nemoclaw".
 *
 * Filesystem isolation: every test gets a fresh mkdtemp project dir with HOME +
 * USERPROFILE redirected there, restored in afterEach. Project scope throughout
 * for deterministic plugin paths. POSIX is pinned so the generated bridge takes
 * its execFileSync(HOME_BIN, [argv]) path.
 */

import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import openclawAdapter from "../../src/adapters/openclaw/index.js";
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

/** Declares UserPromptSubmit only (no SessionStart → no session_start handler). */
function connectorPromptOnly(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    hooks: { UserPromptSubmit: { handler: () => ({ decision: "allow" }) } },
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

/** Dynamically import the generated plugin and collect its api.on registrations. */
async function loadHandlers(pluginPath: string): Promise<Record<string, any>> {
  const url = `${pathToFileURL(pluginPath).href}?t=${Date.now()}-${Math.random()}`;
  const mod = await import(/* @vite-ignore */ url);
  const handlers: Record<string, any> = {};
  mod.default.register({ on: (event: string, h: any) => (handlers[event] = h) });
  return handlers;
}

// ── (b) capabilities (openclaw + nemoclaw) ────────────────────────────────────

describe.each([
  ["openclaw", openclawAdapter],
  ["nemoclaw", nemoclawAdapter],
])("%s adapter — userPromptSubmit + supportsNativeHooks capabilities", (_name, adapter) => {
  it("declares userPromptSubmit && supportsNativeHooks", () => {
    expect(adapter.capabilities.userPromptSubmit).toBe(true);
    expect(adapter.capabilities.supportsNativeHooks).toBe(true);
  });
});

// ── (a) generated-source mapping ──────────────────────────────────────────────

describe("openclaw adapter — UserPromptSubmit maps to before_prompt_build", () => {
  it("a UserPromptSubmit-only connector emits a before_prompt_build handler bridging UserPromptSubmit", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, connectorPromptOnly());
    openclawAdapter.installHooks(ctx);
    const src = readFileSync(openclawAdapter.getHookConfigPath(ctx), "utf8");

    expect(src).toContain('on("before_prompt_build"');
    expect(src).toContain('bridge("UserPromptSubmit"');
    expect(src).toContain("out.appendContext = ures.additionalContext");
    // before_prompt_build CANNOT block → no { block: true } gate for the prompt.
    expect(src).not.toMatch(/before_prompt_build[\s\S]*block: true/);
    // No SessionStart declared → no session_start handler in the source.
    expect(src).not.toContain('on("session_start"');
  });

  it("install detail reports UserPromptSubmit as MAPPED (not 'unsupported here')", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, connectorPromptOnly());
    const changes = openclawAdapter.installHooks(ctx);
    const moduleChange = changes.find((c) => c.path?.endsWith("index.mjs"));
    expect(moduleChange?.detail).toContain("UserPromptSubmit");
    expect(moduleChange?.detail).not.toContain("unsupported here");
  });
});

// ── (c) coexistence — exercised LIVE ──────────────────────────────────────────

describe("openclaw adapter — before_prompt_build COEXISTENCE (SessionStart once + UserPromptSubmit per-turn)", () => {
  it("THE BRIDGE WORKS — SessionStart context injects ONCE, UserPromptSubmit context EVERY turn", async () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, connectorBoth());
    openclawAdapter.installHooks(ctx);
    const pluginPath = openclawAdapter.getHookConfigPath(ctx);

    execFileSyncImpl = (_bin: string, argv: string[]) => {
      const event = argv[2];
      if (event === "SessionStart")
        return JSON.stringify({ additionalContext: "SESSION_CTX" });
      if (event === "UserPromptSubmit")
        return JSON.stringify({ additionalContext: "TURN_CTX" });
      return "";
    };

    const handlers = await loadHandlers(pluginPath);
    expect(typeof handlers["session_start"]).toBe("function");
    expect(typeof handlers["before_prompt_build"]).toBe("function");

    await handlers["session_start"]({ sessionId: "s1" });

    // First build: BOTH the once-only SessionStart context AND the per-turn one.
    const first = handlers["before_prompt_build"]({ prompt: "first turn" });
    expect(first).toEqual({
      appendSystemContext: "SESSION_CTX",
      appendContext: "TURN_CTX",
    });

    // Second build: SessionStart already injected (separate flag) → only per-turn.
    const second = handlers["before_prompt_build"]({ prompt: "second turn" });
    expect(second).toEqual({ appendContext: "TURN_CTX" });

    // The UserPromptSubmit bridge carried the per-turn prompt, host-bound to openclaw.
    const upsCalls = execFileSyncMock.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1][2] === "UserPromptSubmit",
    );
    expect(upsCalls).toHaveLength(2);
    expect(upsCalls[0]![1]).toEqual([
      "hook",
      "openclaw",
      "UserPromptSubmit",
      "--connector",
      CONNECTOR_ID,
    ]);
    expect(JSON.parse(upsCalls[0]![2].input).prompt).toBe("first turn");
    expect(JSON.parse(upsCalls[1]![2].input).prompt).toBe("second turn");
  });

  it("a UserPromptSubmit deny/block decision DEGRADES to a no-op (before_prompt_build cannot block)", async () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, connectorPromptOnly());
    openclawAdapter.installHooks(ctx);
    const pluginPath = openclawAdapter.getHookConfigPath(ctx);

    execFileSyncImpl = () => JSON.stringify({ decision: "deny", reason: "nope" });
    const handlers = await loadHandlers(pluginPath);

    // deny carries no additionalContext → nothing injected → undefined (no-op).
    const out = handlers["before_prompt_build"]({ prompt: "hi" });
    expect(out).toBeUndefined();
  });
});

// ── supportsNativeHooks — passthrough loop (openclaw + nemoclaw) ───────────────

describe.each([
  ["openclaw", openclawAdapter],
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
  ["openclaw", openclawAdapter],
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
