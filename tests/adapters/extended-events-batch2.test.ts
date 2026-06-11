/**
 * tests/adapters/extended-events-batch2 — E1 extension-event wiring for the
 * openclaw / droid / hermes / goose adapters (PermissionRequest,
 * PostToolUseFailure, SubagentStart, SubagentStop).
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
 *       droid    → SubagentStop only (stop-only host, PascalCase 1:1); the
 *                  other three warn-skip.
 *       hermes   → subagent_stop only (snake_case native key); PermissionRequest
 *                  warn-skips because pre_approval_request is OBSERVE-ONLY (no
 *                  decision control); PostToolUseFailure / SubagentStart too.
 *       goose    → PostToolUseFailure only (Claude-style PascalCase key via the
 *                  exhaustive EVENT_CAPABILITY map); the other three warn-skip.
 *   • parseEvent — wire → normalized mapping incl. the optional-field quirks
 *     (SubagentStop may arrive WITHOUT agent_type; hermes child_id fallback;
 *     openclaw bridge payload drops empty strings).
 *   • formatReply — per-event decision semantics: feedback-only degradation
 *     (goose PostToolUseFailure deny → additionalContext+reason, never
 *     {decision:"block"}), Stop semantics on SubagentStop (droid/hermes deny →
 *     TOP-LEVEL {decision:"block",reason}), and openclaw's pass-the-normalized-
 *     response-verbatim bridge contract.
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
import { readYaml } from "../../src/core/yaml.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  PostToolUseFailureEvent,
  ResolvedConnector,
  SubagentStartEvent,
  SubagentStopEvent,
} from "../../src/core/types.js";

import openclawAdapter from "../../src/adapters/openclaw/index.js";
import droidAdapter from "../../src/adapters/droid/index.js";
import hermesAdapter from "../../src/adapters/hermes/index.js";
import gooseAdapter from "../../src/adapters/goose/index.js";

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

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseStdout(reply: { exitCode: number; stdout?: string }): any {
  expect(reply.stdout).toBeTruthy();
  return JSON.parse(reply.stdout!);
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

// ─────────────────────────────────────────────────────────────────────────
// Droid (Factory) — stop-only subagent host
// ─────────────────────────────────────────────────────────────────────────

describe("droid — extended-event install", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("registers hooks.SubagentStop (PascalCase, nested rule + agent matcher); the other three warn-skip", () => {
    const changes = droidAdapter.installHooks(ctx);

    const hooksPath = join(projectDir, ".factory", "hooks.json");
    expect(existsSync(hooksPath)).toBe(true);
    const cfg = readJson(hooksPath);

    const bucket = cfg.hooks.SubagentStop;
    expect(Array.isArray(bucket)).toBe(true);
    expect(bucket[0].matcher).toBe(AGENT_MATCHER);
    expect(bucket[0].hooks[0].command).toContain("hook droid SubagentStop");

    for (const event of ["PermissionRequest", "PostToolUseFailure", "SubagentStart"]) {
      const warn = changes.find((c) => c.action === "warn" && c.detail?.includes(event));
      expect(warn).toBeTruthy();
      expect(warn!.detail).toContain("no Droid hook equivalent");
      expect(cfg.hooks[event]).toBeUndefined();
    }
  });
});

describe("droid — extended-event parse + replies", () => {
  const COMMON = { session_id: "sess-1", cwd: "/home/dev/acme" };

  it("SubagentStop maps the Claude-compatible fields and tolerates missing agent_type", () => {
    const evt = droidAdapter.parseEvent!("SubagentStop", {
      ...COMMON,
      agent_id: "agent-7",
      agent_transcript_path: "/x/subagents/agent-7.jsonl",
      last_assistant_message: "review complete",
      stop_hook_active: true,
    }) as SubagentStopEvent;
    expect(evt.hostPlatform).toBe("droid");
    expect(evt.agentId).toBe("agent-7");
    expect(evt.agentType).toBeUndefined();
    expect(evt.agentTranscriptPath).toBe("/x/subagents/agent-7.jsonl");
    expect(evt.lastAssistantMessage).toBe("review complete");
    expect(evt.stopHookActive).toBe(true);
    expect(evt.projectDir).toBe("/home/dev/acme");
  });

  it("PermissionRequest / PostToolUseFailure / SubagentStart throw (no Droid analog)", () => {
    for (const event of ["PermissionRequest", "PostToolUseFailure", "SubagentStart"] as const) {
      expect(() => droidAdapter.parseEvent!(event, COMMON)).toThrow(
        /unsupported droid hook event/,
      );
    }
  });

  it("SubagentStop deny → TOP-LEVEL {decision:'block', reason}; Stop deny is unchanged (regression guard)", () => {
    const subagent = parseStdout(
      droidAdapter.formatReply!("SubagentStop", { decision: "deny", reason: "keep going" }),
    );
    expect(subagent).toEqual({ decision: "block", reason: "keep going" });
    expect(subagent.hookSpecificOutput).toBeUndefined();

    const stop = parseStdout(
      droidAdapter.formatReply!("Stop", { decision: "deny", reason: "halt" }),
    );
    expect(stop.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("SubagentStop context → hookSpecificOutput.additionalContext (generic context path)", () => {
    const reply = parseStdout(
      droidAdapter.formatReply!("SubagentStop", {
        decision: "context",
        additionalContext: "wrap up",
      }),
    );
    expect(reply.hookSpecificOutput).toEqual({
      hookEventName: "SubagentStop",
      additionalContext: "wrap up",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Hermes — stop-only subagent host; pre_approval_request is observe-only
// ─────────────────────────────────────────────────────────────────────────

describe("hermes — extended-event install", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector(), "user");
  });

  it("registers the native snake_case 'subagent_stop' key with the agent matcher; the other three warn-skip", () => {
    const changes = hermesAdapter.installHooks(ctx);

    const configPath = join(projectDir, ".hermes", "config.yaml");
    expect(existsSync(configPath)).toBe(true);
    const cfg = readYaml<Record<string, any>>(configPath)!;

    const bucket = cfg.hooks.subagent_stop;
    expect(Array.isArray(bucket)).toBe(true);
    expect(bucket[0].matcher).toBe(AGENT_MATCHER);
    // The command keeps the CANONICAL event token; only the YAML key is native.
    expect(bucket[0].command).toContain("hook hermes SubagentStop");
    expect(cfg.hooks.SubagentStop).toBeUndefined();

    // PermissionRequest is the deliberate exclusion: pre_approval_request is
    // observe-only (no decision control), so the event warn-skips — as do
    // PostToolUseFailure (merged into post_tool_call) and SubagentStart.
    for (const event of ["PermissionRequest", "PostToolUseFailure", "SubagentStart"]) {
      const warn = changes.find((c) => c.action === "warn" && c.detail?.includes(event));
      expect(warn).toBeTruthy();
      expect(warn!.detail).toContain("no Hermes hook equivalent");
    }
  });
});

describe("hermes — extended-event parse + replies", () => {
  const COMMON = { session_id: "sess-1", cwd: "/home/dev/acme" };

  it("SubagentStop maps agent fields (child_id fallback) and tolerates missing agent_type", () => {
    const evt = hermesAdapter.parseEvent!("SubagentStop", {
      ...COMMON,
      agent_id: "agent-7",
      agent_type: "code-reviewer",
      last_assistant_message: "done",
    }) as SubagentStopEvent;
    expect(evt.hostPlatform).toBe("hermes");
    expect(evt.agentId).toBe("agent-7");
    expect(evt.agentType).toBe("code-reviewer");
    expect(evt.lastAssistantMessage).toBe("done");

    // Hermes-native child_* names: child_id backs agentId; child_status stays
    // accessible via raw.
    const native = hermesAdapter.parseEvent!("SubagentStop", {
      ...COMMON,
      child_id: "child-3",
      child_status: "completed",
    }) as SubagentStopEvent;
    expect(native.agentId).toBe("child-3");
    expect(native.agentType).toBeUndefined();
    expect((native.raw as any).child_status).toBe("completed");
  });

  it("PermissionRequest / PostToolUseFailure / SubagentStart throw (no decision-capable analog)", () => {
    for (const event of ["PermissionRequest", "PostToolUseFailure", "SubagentStart"] as const) {
      expect(() => hermesAdapter.parseEvent!(event, COMMON)).toThrow(
        /unsupported hermes hook event/,
      );
    }
  });

  it("SubagentStop deny → TOP-LEVEL {decision:'block', reason}; PreToolUse deny is unchanged (regression guard)", () => {
    const subagent = parseStdout(
      hermesAdapter.formatReply!("SubagentStop", { decision: "deny", reason: "keep going" }),
    );
    expect(subagent).toEqual({ decision: "block", reason: "keep going" });
    expect(subagent.hookSpecificOutput).toBeUndefined();

    const pre = parseStdout(
      hermesAdapter.formatReply!("PreToolUse", { decision: "deny", reason: "nope" }),
    );
    expect(pre.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Goose — dedicated PostToolUseFailure; no permission/subagent events
// ─────────────────────────────────────────────────────────────────────────

describe("goose — extended-event install", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("registers hooks.PostToolUseFailure (capability-filtered); permission/subagent events warn-skip", () => {
    const changes = gooseAdapter.installHooks(ctx);

    const hooksPath = join(
      projectDir,
      ".agents",
      "plugins",
      CONNECTOR_ID,
      "hooks",
      "hooks.json",
    );
    expect(existsSync(hooksPath)).toBe(true);
    const cfg = readJson(hooksPath);

    const bucket = cfg.hooks.PostToolUseFailure;
    expect(Array.isArray(bucket)).toBe(true);
    expect(bucket[0].matcher).toBe("acme_query");
    expect(bucket[0].hooks[0].command).toContain("hook goose PostToolUseFailure");

    for (const event of ["PermissionRequest", "SubagentStart", "SubagentStop"]) {
      const warn = changes.find((c) => c.action === "warn" && c.detail?.includes(event));
      expect(warn).toBeTruthy();
      expect(warn!.detail).toContain("unsupported on goose");
      expect(cfg.hooks[event]).toBeUndefined();
    }
  });
});

describe("goose — extended-event parse + replies", () => {
  it("PostToolUseFailure maps error/tool_use_id/is_interrupt/duration_ms (+ working_dir → projectDir)", () => {
    const evt = gooseAdapter.parseEvent!("PostToolUseFailure", {
      session_id: "sess-1",
      working_dir: "/home/dev/acme",
      tool_name: "shell",
      tool_input: { command: "make test" },
      tool_use_id: "call_01",
      error: "exit status 2",
      is_interrupt: false,
      duration_ms: 450,
    }) as PostToolUseFailureEvent;
    expect(evt.hostPlatform).toBe("goose");
    expect(evt.toolName).toBe("shell");
    expect(evt.toolInput).toEqual({ command: "make test" });
    expect(evt.error).toBe("exit status 2");
    expect(evt.toolUseId).toBe("call_01");
    expect(evt.isInterrupt).toBe(false);
    expect(evt.durationMs).toBe(450);
    expect(evt.projectDir).toBe("/home/dev/acme");

    const minimal = gooseAdapter.parseEvent!("PostToolUseFailure", {
      tool_name: "write",
    }) as PostToolUseFailureEvent;
    expect(minimal.error).toBe("");
  });

  it("PermissionRequest / SubagentStart / SubagentStop throw (no Goose analog)", () => {
    for (const event of ["PermissionRequest", "SubagentStart", "SubagentStop"] as const) {
      expect(() => gooseAdapter.parseEvent!(event, {})).toThrow(
        /unsupported goose hook event/,
      );
    }
  });

  it("PostToolUseFailure is feedback-only: context → {additionalContext}; deny DEGRADES (never {decision:'block'}); void → exit 0", () => {
    const context = parseStdout(
      gooseAdapter.formatReply!("PostToolUseFailure", {
        decision: "context",
        additionalContext: "retry with -j1",
      }),
    );
    expect(context).toEqual({ additionalContext: "retry with -j1" });

    const denied = parseStdout(
      gooseAdapter.formatReply!("PostToolUseFailure", {
        decision: "deny",
        reason: "not blockable",
      }),
    );
    expect(denied).toEqual({ additionalContext: "not blockable" });
    expect(denied.decision).toBeUndefined();

    const noop = gooseAdapter.formatReply!("PostToolUseFailure", {});
    expect(noop).toEqual({ exitCode: 0 });
  });

  it("PreToolUse deny still renders Goose's {decision:'block', reason} (regression guard)", () => {
    const reply = parseStdout(
      gooseAdapter.formatReply!("PreToolUse", { decision: "deny", reason: "nope" }),
    );
    expect(reply).toEqual({ decision: "block", reason: "nope" });
  });
});
