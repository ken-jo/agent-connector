/**
 * tests/adapters/extended-events-batch2 — E1 extension-event wiring for the
 * openclaw adapter (PermissionRequest, PostToolUseFailure, SubagentStart,
 * SubagentStop). (droid now lives in adapters/droid.test.ts; goose now lives in
 * adapters/goose.test.ts; hermes now lives in adapters/hermes.test.ts.)
 *
 * Per host this pins three things (mirroring extended-events-batch.test.ts):
 *   • installHooks — which of the four events register natively (and under
 *     which native key), and that unsupported ones surface the standard
 *     warn-skip (or, for the ts-plugin openclaw, the "unsupported here"
 *     detail) instead of being silently dropped:
 *       openclaw → subagent_spawned / subagent_ended wired into the generated
 *                  plugin module; PermissionRequest (gate is a requireApproval
 *                  RETURN VALUE of before_tool_call, not an event) and
 *                  PostToolUseFailure (merged into after_tool_call) are
 *                  reported as "unsupported here".
 *   • parseEvent — wire → normalized mapping incl. the optional-field quirks
 *     (openclaw bridge payload drops empty strings).
 *   • formatReply — per-event decision semantics: openclaw's
 *     pass-the-normalized-response-verbatim bridge contract.
 *
 * The openclaw bridge is exercised LIVE (generated module imported with
 * node:child_process mocked), following the wave4 idiom. Filesystem isolation:
 * fresh mkdtemp project dir, HOME redirected into it.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  ResolvedConnector,
  SubagentStartEvent,
  SubagentStopEvent,
} from "../../src/core/types.js";

import openclawAdapter from "../../src/adapters/openclaw/index.js";

// ─────────────────────────────────────────────────────────────────────────
// node:child_process mock — hoisted above every import by vitest. Only the
// openclaw generated-plugin bridge uses it; the other adapters never spawn.
// ─────────────────────────────────────────────────────────────────────────

let execFileSyncImpl: (...args: any[]) => string = () => "";
const execFileSyncMock = vi.fn((...args: any[]) => execFileSyncImpl(...args));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  execSync: execFileSyncMock,
}));

// Pin process.platform so the generated bridge takes the POSIX
// execFileSync(HOME_BIN, argv) path matching this file's call-shape assertions.
const REAL_PLATFORM = process.platform;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
});

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-db";
const AGENT_MATCHER = "code-reviewer|explore";

/** A connector declaring exactly the four E1 extension events. */
function buildConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    hooks: {
      PermissionRequest: {
        matcher: "acme_query",
        handler() {
          return { decision: "ask" };
        },
      },
      PostToolUseFailure: {
        matcher: "acme_query",
        handler() {
          return { decision: "context", additionalContext: "retry hint" };
        },
      },
      SubagentStart: {
        matcher: AGENT_MATCHER,
        handler() {
          return { decision: "context", additionalContext: "subagent ctx" };
        },
      },
      SubagentStop: {
        matcher: AGENT_MATCHER,
        handler() {
          return { decision: "deny", reason: "keep going" };
        },
      },
    },
  });
}

function buildCtx(
  projectDir: string,
  connector: ResolvedConnector,
  scope: InstallContext["scope"] = "project",
): InstallContext {
  return {
    connector,
    scope,
    projectDir,
    homeBinPath: HOME_BIN,
    dataRoot: projectDir,
    dryRun: false,
  };
}

let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let savedDataDir: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
  execFileSyncImpl = () => "";
  execFileSyncMock.mockClear();
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("USERPROFILE", savedUserProfile);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Fresh temp project dir + redirect HOME/data-root there so nothing escapes. */
function freshProject(): string {
  // realpathSync.native expands the Windows 8.3 short tmpdir (C:\Users\RUNNER~1\…)
  // so the later pathToFileURL() import of the generated bridge doesn't break on
  // the "~" (round-trips as %7E and fails to load) — same guard as phase3/wave4.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ac-ext-events2-")));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  return dir;
}

// ─────────────────────────────────────────────────────────────────────────
// OpenClaw (ts-plugin bridge)
// ─────────────────────────────────────────────────────────────────────────

describe("openclaw — extended-event install (generated plugin)", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("wires subagent_spawned/subagent_ended into the module; PermissionRequest + PostToolUseFailure reported 'unsupported here'", () => {
    const changes = openclawAdapter.installHooks(ctx);

    const pluginPath = openclawAdapter.getHookConfigPath(ctx);
    expect(existsSync(pluginPath)).toBe(true);
    const src = readFileSync(pluginPath, "utf8");

    // The generated module registers BOTH native subagent lifecycle hooks and
    // bridges them to the canonical event tokens.
    expect(src).toContain('"subagent_spawned"');
    expect(src).toContain('"subagent_ended"');
    expect(src).toContain('bridge("SubagentStart"');
    expect(src).toContain('bridge("SubagentStop"');
    // The unmapped events are NOT baked into the module.
    expect(src).not.toContain("PermissionRequest");
    expect(src).not.toContain("PostToolUseFailure");

    // The human-facing detail lists ONLY the wired events and calls out the
    // unsupported pair — never silently dropped.
    const moduleChange = changes.find((c) =>
      c.detail?.startsWith("openclaw plugin module ("),
    );
    expect(moduleChange).toBeTruthy();
    expect(moduleChange!.detail).toContain("SubagentStart,SubagentStop");
    expect(moduleChange!.detail).toContain(
      "unsupported here: PermissionRequest,PostToolUseFailure",
    );
  });
});

describe("openclaw — the subagent bridge WORKS (live, child_process mocked)", () => {
  let projectDir: string;
  let ctx: InstallContext;
  let pluginPath: string;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
    openclawAdapter.installHooks(ctx);
    pluginPath = openclawAdapter.getHookConfigPath(ctx);
    expect(existsSync(pluginPath)).toBe(true);
  });

  /** Import the freshly-written generated module (cache-busted per test). */
  async function loadPlugin(): Promise<any> {
    const url = `${pathToFileURL(pluginPath).href}?t=${Date.now()}-${Math.random()}`;
    return import(/* @vite-ignore */ url);
  }

  function fakeApi(): {
    on: (e: string, h: (...a: any[]) => any) => void;
    handlers: Record<string, (...a: any[]) => any>;
  } {
    const handlers: Record<string, (...a: any[]) => any> = {};
    return {
      handlers,
      on(event: string, handler: (...a: any[]) => any) {
        handlers[event] = handler;
      },
    };
  }

  it("subagent_spawned shells out as SubagentStart with the normalized payload (observe-only: returns undefined)", async () => {
    execFileSyncImpl = () => JSON.stringify({ decision: "context", additionalContext: "x" });

    const mod = await loadPlugin();
    const api = fakeApi();
    mod.default.register(api);
    expect(typeof api.handlers["subagent_spawned"]).toBe("function");
    expect(typeof api.handlers["subagent_ended"]).toBe("function");

    const result = await api.handlers["subagent_spawned"]!({
      agentId: "agent-7",
      agentType: "code-reviewer",
    });
    // Observe-only: the bridge reply is ignored, the handler never blocks.
    expect(result).toBeUndefined();

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [bin, argv, opts] = execFileSyncMock.mock.calls[0]!;
    expect(bin).toBe(HOME_BIN);
    expect(argv).toEqual(["hook", "openclaw", "SubagentStart", "--connector", CONNECTOR_ID]);
    const payload = JSON.parse(opts.input);
    expect(payload.agentId).toBe("agent-7");
    expect(payload.agentType).toBe("code-reviewer");
  });

  it("subagent_ended shells out as SubagentStop; a string result rides along as lastAssistantMessage", async () => {
    const mod = await loadPlugin();
    const api = fakeApi();
    mod.default.register(api);

    const result = await api.handlers["subagent_ended"]!({
      subagentId: "sub-9",
      subagentType: "explore",
      result: "review complete",
    });
    expect(result).toBeUndefined();

    const [, argv, opts] = execFileSyncMock.mock.calls[0]!;
    expect(argv).toEqual(["hook", "openclaw", "SubagentStop", "--connector", CONNECTOR_ID]);
    const payload = JSON.parse(opts.input);
    // subagent_* field-name variants are normalized before posting.
    expect(payload.agentId).toBe("sub-9");
    expect(payload.agentType).toBe("explore");
    expect(payload.lastAssistantMessage).toBe("review complete");
  });

  it("unknown agent fields are OMITTED from the payload (never posted as empty strings)", async () => {
    const mod = await loadPlugin();
    const api = fakeApi();
    mod.default.register(api);

    await api.handlers["subagent_spawned"]!({});

    const [, , opts] = execFileSyncMock.mock.calls[0]!;
    const payload = JSON.parse(opts.input);
    expect("agentId" in payload).toBe(false);
    expect("agentType" in payload).toBe(false);
  });
});

describe("openclaw — extended-event parse + reply", () => {
  it("SubagentStart/SubagentStop map the bridge payload; empty strings are dropped (matcher fail-open)", () => {
    const start = openclawAdapter.parseEvent!("SubagentStart", {
      agentId: "agent-7",
      agentType: "code-reviewer",
      sessionId: "oc-1",
      projectDir: "/some/proj",
    }) as SubagentStartEvent;
    expect(start.hostPlatform).toBe("openclaw");
    expect(start.agentId).toBe("agent-7");
    expect(start.agentType).toBe("code-reviewer");
    expect(start.sessionId).toBe("oc-1");

    const stop = openclawAdapter.parseEvent!("SubagentStop", {
      agentId: "",
      agentType: "",
      lastAssistantMessage: "done",
      sessionId: "oc-1",
    }) as SubagentStopEvent;
    expect(stop.agentId).toBeUndefined();
    expect(stop.agentType).toBeUndefined();
    expect(stop.lastAssistantMessage).toBe("done");
  });

  it("formatReply stays the verbatim normalized-response bridge contract on subagent events", () => {
    const reply = openclawAdapter.formatReply!("SubagentStop", {
      decision: "deny",
      reason: "keep going",
    });
    expect(reply.exitCode).toBe(0);
    expect(JSON.parse(reply.stdout!)).toEqual({ decision: "deny", reason: "keep going" });
  });
});
