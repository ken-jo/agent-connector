/**
 * tests/adapters/extended-events-degrade — E1 extension-event DEGRADATION on
 * the batch of hook-capable hosts with NO native analog for any of the four
 * new canonical events (PermissionRequest, PostToolUseFailure, SubagentStart,
 * SubagentStop): gemini-cli, jetbrains-copilot, kiro, crush, antigravity,
 * antigravity-cli, and the ts-plugin trio opencode / kilo-cli / omp.
 *
 * Per host this pins three things:
 *   • capabilities — all four E1 flags stay unset (read as false), so the
 *     single-API layer treats the events as unsupported everywhere here
 *     (antigravity-cli must INHERIT that surface from the IDE adapter).
 *   • installHooks — a connector declaring the four events is never silently
 *     dropped: json-stdio hosts surface the standard per-event warn-skip
 *     ("<Event> has no <Host> hook equivalent — skipped"), and the ts-plugin
 *     hosts report them via the "unsupported here: …" detail. The native
 *     hook file / generated bridge must NOT reference any of the four events
 *     (canonical or host-native analog names).
 *   • parseEvent — jetbrains-copilot's exhaustive switch now routes the four
 *     events to an explicit unsupported-throw (the compile-forced degrade
 *     case), so a runtime mis-dispatch stays loud rather than mis-parsing.
 *
 * Crush previously dropped EVERY undeclared-native event silently; per the
 * registry-wide E1 convention (mirroring kimi/codex WARN_SKIP_EVENTS) it now
 * warn-skips exactly the four new events while the legacy silent drop of
 * SessionStart/Stop/… is deliberately preserved — both behaviors are pinned.
 *
 * Filesystem isolation mirrors wave2: fresh mkdtemp project dir with HOME +
 * AGENT_CONNECTOR_DATA_DIR redirected into it (kiro's user-scope agent file
 * resolves under the HOME sandbox); mutated env is restored in afterEach.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { Adapter, InstallContext } from "../../src/adapters/spi.js";
import type { HookEventName, ResolvedConnector } from "../../src/core/types.js";

import geminiCliAdapter from "../../src/adapters/gemini-cli/index.js";
import jetbrainsCopilotAdapter from "../../src/adapters/jetbrains-copilot/index.js";
import kiroAdapter from "../../src/adapters/kiro/index.js";
import crushAdapter from "../../src/adapters/crush/index.js";
import antigravityAdapter from "../../src/adapters/antigravity/index.js";
import antigravityCliAdapter from "../../src/adapters/antigravity-cli/index.js";
import opencodeAdapter from "../../src/adapters/opencode/index.js";
import kiloCliAdapter from "../../src/adapters/kilo-cli/index.js";
import ompAdapter from "../../src/adapters/omp/index.js";

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-db";

const E1_EVENTS = [
  "PermissionRequest",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
] as const;

/** Substrings that must never leak into a native hook file / generated bridge. */
const FORBIDDEN_NATIVE_TOKENS = [
  ...E1_EVENTS,
  // host-native analog spellings (camelCase / snake_case families)
  "permissionRequest",
  "postToolUseFailure",
  "subagentStart",
  "subagentStop",
  "permission.ask",
  "subagent_spawned",
  "subagent_ended",
  "subagent_stop",
];

/** PreToolUse (universally wired here) + ALL FOUR E1 extension events. */
function buildConnector(id = CONNECTOR_ID): ResolvedConnector {
  return defineConnector({
    id,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    hooks: {
      PreToolUse: {
        matcher: "acme_query",
        handler() {
          return { decision: "allow" };
        },
      },
      PermissionRequest: {
        matcher: "acme_query",
        handler() {
          return { decision: "ask" };
        },
      },
      PostToolUseFailure: {
        handler() {
          return { decision: "context", additionalContext: "retry hint" };
        },
      },
      SubagentStart: {
        matcher: "code-reviewer",
        handler() {
          return { decision: "context", additionalContext: "subagent ctx" };
        },
      },
      SubagentStop: {
        matcher: "code-reviewer",
        handler() {
          return { decision: "deny", reason: "keep going" };
        },
      },
    },
  });
}

/** A connector declaring ONLY the four E1 events (pure warn-skip path). */
function buildE1OnlyConnector(id = CONNECTOR_ID): ResolvedConnector {
  return defineConnector({
    id,
    hooks: {
      PermissionRequest: { handler() {} },
      PostToolUseFailure: { handler() {} },
      SubagentStart: { handler() {} },
      SubagentStop: { handler() {} },
    },
  });
}

/** Build an InstallContext scoped to a fresh temp project dir. */
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
    dataRoot: join(projectDir, ".agent-connector"),
    dryRun: false,
  };
}

// Track + restore mutated env so the suite never leaks state.
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let savedDataDir: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
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

/** Fresh temp project dir + redirect HOME / data-root into the sandbox. */
function freshProject(prefix = "ac-e1-degrade-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  return dir;
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The warn records for exactly the four E1 events, with the standard detail. */
function expectE1WarnSkips(
  changes: ReturnType<NonNullable<Adapter["installHooks"]>>,
  platformId: string,
  hostLabel: string,
): void {
  const warns = changes.filter((c) => c.action === "warn");
  for (const event of E1_EVENTS) {
    const warn = warns.find((c) => c.detail?.startsWith(`${event} `));
    expect(warn, `expected a warn-skip record for ${event}`).toBeTruthy();
    expect(warn!.platform).toBe(platformId);
    expect(warn!.detail).toBe(`${event} has no ${hostLabel} hook equivalent — skipped`);
  }
  expect(warns).toHaveLength(E1_EVENTS.length);
}

// ─────────────────────────────────────────────────────────────────────────
// Capabilities — all four E1 flags stay unset on every batch host
// ─────────────────────────────────────────────────────────────────────────

describe("E1 capability flags stay unset on hosts without a native analog", () => {
  const hosts: ReadonlyArray<[string, Adapter]> = [
    ["gemini-cli", geminiCliAdapter],
    ["jetbrains-copilot", jetbrainsCopilotAdapter],
    ["kiro", kiroAdapter],
    ["crush", crushAdapter],
    ["antigravity", antigravityAdapter],
    ["antigravity-cli", antigravityCliAdapter],
    ["opencode", opencodeAdapter],
    ["kilo-cli", kiloCliAdapter],
    ["omp", ompAdapter],
  ];

  it.each(hosts)("%s leaves permissionRequest/postToolUseFailure/subagentStart/subagentStop falsy", (_id, adapter) => {
    expect(adapter.capabilities.permissionRequest ?? false).toBe(false);
    expect(adapter.capabilities.postToolUseFailure ?? false).toBe(false);
    expect(adapter.capabilities.subagentStart ?? false).toBe(false);
    expect(adapter.capabilities.subagentStop ?? false).toBe(false);
  });

  it("antigravity-cli INHERITS the IDE adapter's capability surface", () => {
    // The class field initializer gives each instance its own object — assert
    // structural identity (the CLI adapter declares no capabilities of its own).
    expect(antigravityCliAdapter.capabilities).toStrictEqual(antigravityAdapter.capabilities);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// json-stdio hosts — per-event warn-skip + native file never references E1
// ─────────────────────────────────────────────────────────────────────────

describe("gemini-cli E1 degradation", () => {
  it("installHooks warn-skips all four; settings.json wires BeforeTool only", () => {
    const projectDir = freshProject("ac-e1-gemini-");
    const ctx = buildCtx(projectDir, buildConnector());

    const changes = geminiCliAdapter.installHooks!(ctx);
    expectE1WarnSkips(changes, "gemini-cli", "Gemini CLI");

    const settingsPath = geminiCliAdapter.getHookConfigPath!(ctx);
    const cfg = readJson(settingsPath);
    expect(Object.keys(cfg.hooks)).toEqual(["BeforeTool"]);
    const text = readFileSync(settingsPath, "utf8");
    for (const token of FORBIDDEN_NATIVE_TOKENS) {
      expect(text).not.toContain(token);
    }
  });
});

describe("jetbrains-copilot E1 degradation", () => {
  it("installHooks warn-skips all four; hooks file wires PreToolUse only", () => {
    const projectDir = freshProject("ac-e1-jetbrains-");
    const ctx = buildCtx(projectDir, buildConnector());

    const changes = jetbrainsCopilotAdapter.installHooks!(ctx);
    expectE1WarnSkips(changes, "jetbrains-copilot", "JetBrains Copilot");

    const hooksPath = join(projectDir, ".github", "hooks", `${CONNECTOR_ID}.json`);
    const file = readJson(hooksPath);
    expect(Object.keys(file.hooks)).toEqual(["PreToolUse"]);
  });

  it("parseEvent throws the explicit unsupported error for each E1 event (degrade case)", () => {
    for (const event of E1_EVENTS) {
      expect(() =>
        jetbrainsCopilotAdapter.parseEvent!(event as HookEventName, {
          session_id: "s1",
          cwd: "/work",
          connector: CONNECTOR_ID,
        }),
      ).toThrow(`unsupported jetbrains-copilot hook event: ${event}`);
    }
  });
});

describe("kiro E1 degradation", () => {
  it("installHooks warn-skips all four; agent file gains no E1 keys", () => {
    const projectDir = freshProject("ac-e1-kiro-");
    const ctx = buildCtx(projectDir, buildConnector(), "user");

    const changes = kiroAdapter.installHooks!(ctx);
    expectE1WarnSkips(changes, "kiro", "Kiro");

    // User-scope agent file resolves under the HOME sandbox.
    const agentPath = kiroAdapter.getHookConfigPath!(ctx);
    expect(agentPath.startsWith(projectDir)).toBe(true);
    const agent = readJson(agentPath);
    expect(Object.keys(agent.hooks)).toEqual(["preToolUse"]);
    const text = readFileSync(agentPath, "utf8");
    for (const token of FORBIDDEN_NATIVE_TOKENS) {
      expect(text).not.toContain(token);
    }
  });
});

describe("crush E1 degradation", () => {
  it("installHooks warn-skips all four (NEW convention) while still wiring PreToolUse", () => {
    const projectDir = freshProject("ac-e1-crush-");
    const ctx = buildCtx(projectDir, buildConnector());

    const changes = crushAdapter.installHooks!(ctx);
    expectE1WarnSkips(changes, "crush", "Crush");
    expect(changes.some((c) => c.action === "create" && c.detail === "hooks.PreToolUse")).toBe(
      true,
    );

    const cfg = readJson(join(projectDir, ".crush.json"));
    expect(Object.keys(cfg.hooks)).toEqual(["PreToolUse"]);
  });

  it("a connector declaring ONLY E1 events → four warns and NO file write", () => {
    const projectDir = freshProject("ac-e1-crush-only-");
    const ctx = buildCtx(projectDir, buildE1OnlyConnector());

    const changes = crushAdapter.installHooks!(ctx);
    expectE1WarnSkips(changes, "crush", "Crush");
    expect(changes.every((c) => c.action === "warn")).toBe(true);
    // No registrable event → crush.json must not be created at all.
    expect(existsSync(join(projectDir, ".crush.json"))).toBe(false);
  });

  it("legacy silent drop of host-unwired NON-E1 events is preserved (SessionStart)", () => {
    const projectDir = freshProject("ac-e1-crush-legacy-");
    const legacy = defineConnector({
      id: CONNECTOR_ID,
      hooks: {
        PreToolUse: { handler() {} },
        SessionStart: { handler() {} },
      },
    });
    const changes = crushAdapter.installHooks!(buildCtx(projectDir, legacy));
    // SessionStart predates the warn-skip convention: dropped, not warned.
    expect(changes.some((c) => c.action === "warn")).toBe(false);
    const cfg = readJson(join(projectDir, ".crush.json"));
    expect(Object.keys(cfg.hooks)).toEqual(["PreToolUse"]);
  });
});

describe("antigravity (IDE + CLI) E1 degradation", () => {
  it("antigravity installHooks warn-skips all four; hooks.json wires PreToolUse only", () => {
    const projectDir = freshProject("ac-e1-antigravity-");
    const ctx = buildCtx(projectDir, buildConnector());

    const changes = antigravityAdapter.installHooks!(ctx);
    expectE1WarnSkips(changes, "antigravity", "Antigravity");

    const hooksPath = antigravityAdapter.getHookConfigPath!(ctx);
    const file = readJson(hooksPath);
    expect(Object.keys(file.hooks)).toEqual(["PreToolUse"]);
  });

  it("antigravity-cli inherits the same warn-skips under its OWN platform id", () => {
    const projectDir = freshProject("ac-e1-agy-");
    const ctx = buildCtx(projectDir, buildConnector());

    const changes = antigravityCliAdapter.installHooks!(ctx);
    expectE1WarnSkips(changes, "antigravity-cli", "Antigravity");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ts-plugin hosts — generated bridge must NOT reference the new events
// ─────────────────────────────────────────────────────────────────────────

describe("ts-plugin bridges never reference E1 events (opencode / kilo-cli / omp)", () => {
  const UNSUPPORTED_DETAIL =
    "unsupported here: PermissionRequest,PostToolUseFailure,SubagentStart,SubagentStop";

  it("opencode: install detail reports the four as unsupported; bridge wires tool.execute.before only", () => {
    const projectDir = freshProject("ac-e1-opencode-");
    const ctx = buildCtx(projectDir, buildConnector());

    const changes = opencodeAdapter.installHooks!(ctx);
    const moduleChange = changes.find((c) => c.detail?.startsWith("opencode plugin module"));
    expect(moduleChange?.detail).toBe(`opencode plugin module (PreToolUse; ${UNSUPPORTED_DETAIL})`);

    const source = readFileSync(opencodeAdapter.getHookConfigPath!(ctx), "utf8");
    expect(source).toContain("tool.execute.before");
    for (const token of FORBIDDEN_NATIVE_TOKENS) {
      expect(source).not.toContain(token);
    }
  });

  it("kilo-cli: install detail reports the four as unsupported; bridge wires tool.execute.before only", () => {
    const projectDir = freshProject("ac-e1-kilo-");
    const ctx = buildCtx(projectDir, buildConnector());

    const changes = kiloCliAdapter.installHooks!(ctx);
    const moduleChange = changes.find((c) => c.detail?.startsWith("kilo plugin module"));
    expect(moduleChange?.detail).toBe(`kilo plugin module (PreToolUse; ${UNSUPPORTED_DETAIL})`);

    const source = readFileSync(kiloCliAdapter.getHookConfigPath!(ctx), "utf8");
    expect(source).toContain("tool.execute.before");
    for (const token of FORBIDDEN_NATIVE_TOKENS) {
      expect(source).not.toContain(token);
    }
  });

  it("omp: install detail reports the four as unsupported; bridge wires tool_call only", () => {
    const projectDir = freshProject("ac-e1-omp-");
    const ctx = buildCtx(projectDir, buildConnector());

    const changes = ompAdapter.installHooks!(ctx);
    const moduleChange = changes.find((c) =>
      c.detail?.startsWith("omp plugin module"),
    );
    expect(moduleChange?.detail).toBe(`omp plugin module (PreToolUse; ${UNSUPPORTED_DETAIL})`);

    const source = readFileSync(ompAdapter.getHookConfigPath!(ctx), "utf8");
    expect(source).toContain("tool_call");
    for (const token of FORBIDDEN_NATIVE_TOKENS) {
      expect(source).not.toContain(token);
    }
  });
});
