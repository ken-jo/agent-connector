/**
 * tests/adapters/openhands — the ONE per-host file for the OpenHands
 * (All-Hands-AI, ex-OpenDevin) adapter.
 *
 * OpenHands is a json-stdio host with TWO native config surfaces in DIFFERENT
 * files (both byte-confirmed from the All-Hands-AI source — see the adapter
 * header for the exact citations):
 *   • MCP servers → ~/.openhands/mcp.json (root key "mcpServers"; FastMCP entry
 *                   { command, args, env, transport:"stdio" }). USER-scoped only
 *                   (the CLI reads one persistence-dir file; $OPENHANDS_PERSISTENCE_DIR
 *                   overrides the dir). getServerConfigPath ignores ctx.scope.
 *   • Hooks       → a SEPARATE .openhands/hooks.json (root key "hooks"; the
 *                   Claude-Code-plugin-compatible NESTED-rule shape). 6 events:
 *                   PreToolUse / PostToolUse / UserPromptSubmit / SessionStart /
 *                   SessionEnd / Stop. HookConfig.load searches project then user.
 *
 * Runtime wire DIVERGES from Claude (the kimi false-friend class): the stdin
 * fields are event_type / working_dir / message / tool_response(dict), and the
 * reply is a FLAT {decision, reason, additionalContext} object (no
 * hookSpecificOutput envelope, no "ask"). These tests pin all of that.
 *
 * HONEST CEILING: OpenHands is not installed/authed in CI, so placement +
 * byte-oracle of the written files (and parse/format of the documented wire) is
 * the verification ceiling — there is no live hook-fire here.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  PostToolUseEvent,
  PreToolUseEvent,
  ResolvedConnector,
  SessionEndEvent,
  SessionStartEvent,
  StopEvent,
  UserPromptSubmitEvent,
} from "../../src/core/types.js";

import openhandsAdapter from "../../src/adapters/openhands/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson } from "../support/fs.js";

// ── shared fixtures ──────────────────────────────────────────────────────────

const DB_CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const TOOL_MATCHER = "acme_query|acme_write";

// The serve-wrapper args bake the install TARGET platform as `--host <id>`
// (before `--`) so the proxy stamps hostPlatform under a headless spawn.
const wrappedArgs = (host: string): string[] => [
  "serve",
  "--connector",
  DB_CONNECTOR_ID,
  "--scope",
  "user",
  "--host",
  host,
  "--",
  "npx",
  "-y",
  "@x/y",
];

/** A connector with a stdio server (env-ref) + a PreToolUse hook. */
function buildRenderConnector(): ResolvedConnector {
  return defineConnector({
    id: DB_CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@x/y"],
      env: { [ENV_VAR]: `\${env:${ENV_VAR}}` },
      tools: { include: ["*"] },
    },
    hooks: {
      PreToolUse: {
        matcher: TOOL_MATCHER,
        handler() {
          return { decision: "allow" };
        },
      },
    },
  });
}

/** A connector declaring the three OpenHands events with no native analog. */
function buildUnsupportedConnector(): ResolvedConnector {
  return defineConnector({
    id: DB_CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    hooks: {
      Notification: { handler: () => ({}) },
      PreCompact: { handler: () => ({}) },
      SubagentStop: { handler: () => ({ decision: "deny", reason: "x" }) },
    },
  });
}

function parseStdout(reply: { exitCode: number; stdout?: string }): any {
  expect(reply.stdout).toBeTruthy();
  return JSON.parse(reply.stdout!);
}

// extraKeys: the render slice mutates ACME_DB_DSN; OPENHANDS_PERSISTENCE_DIR is
// isolated so a dev box that sets it cannot leak the MCP write outside HOME.
isolateEnv([ENV_VAR, "OPENHANDS_PERSISTENCE_DIR"]);

// Shared env isolation + the same-rules-for-every-host baseline contract.
createAdapterSuite({ adapter: openhandsAdapter, paradigm: "json-stdio" });

// ── capabilities ──────────────────────────────────────────────────────────────

describe("openhands adapter — capabilities", () => {
  it("advertises the six byte-confirmed hook events and the MCP transports", () => {
    const c = openhandsAdapter.capabilities;
    expect(c.preToolUse).toBe(true);
    expect(c.postToolUse).toBe(true);
    expect(c.userPromptSubmit).toBe(true);
    expect(c.sessionStart).toBe(true);
    expect(c.sessionEnd).toBe(true);
    expect(c.stop).toBe(true);
    // No native analog for these — explicitly false / unset.
    expect(c.notification).toBe(false);
    expect(c.preCompact).toBe(false);
    expect(c.subagentStop ?? false).toBe(false);
    expect(c.permissionRequest ?? false).toBe(false);
    expect(c.transports).toEqual(["stdio", "http"]);
    expect(c.canModifyOutput).toBe(false);
    expect(c.canInjectSessionContext).toBe(true);
    // Content surfaces are CEILING'd (no byte-confirmed file layout).
    expect(c.supportsCommands ?? false).toBe(false);
    expect(c.supportsSkills ?? false).toBe(false);
    expect(c.supportsSubagents ?? false).toBe(false);
    expect(c.supportsMemory).toBe(true);
  });
});

// ── MCP render / round-trip ─────────────────────────────────────────────────

describe("openhands adapter — MCP render/round-trip (user-scoped persistence dir)", () => {
  let home: string;
  let ctx: InstallContext;

  beforeEach(() => {
    home = freshProject("ac-openhands-");
    process.env[ENV_VAR] = ENV_LITERAL;
    // User scope: the persistence dir resolves to ~/.openhands (the temp HOME).
    ctx = buildCtx(home, buildRenderConnector(), "user");
  });

  it("installServer writes mcpServers.<id> into ~/.openhands/mcp.json, wrapped, env LITERAL", () => {
    const changes = openhandsAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(home, ".openhands", "mcp.json");
    expect(serverPath).toBe(openhandsAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[DB_CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.transport).toBe("stdio");

    // Telemetry serve-wrapper: command points at the home binary.
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedArgs("openhands"));

    // No native interpolation token → env-ref resolves to a LITERAL value.
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("getServerConfigPath ignores scope (CLI reads ONE persistence-dir mcp.json)", () => {
    const projectCtx = buildCtx(home, buildRenderConnector(), "project");
    expect(openhandsAdapter.getServerConfigPath(projectCtx)).toBe(
      join(home, ".openhands", "mcp.json"),
    );
  });

  it("honors $OPENHANDS_PERSISTENCE_DIR for the MCP file location", () => {
    const custom = join(home, "custom-oh");
    process.env.OPENHANDS_PERSISTENCE_DIR = custom;
    expect(openhandsAdapter.getServerConfigPath(ctx)).toBe(join(custom, "mcp.json"));
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    openhandsAdapter.installServer(ctx);
    const second = openhandsAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(home, ".openhands", "mcp.json"));
    expect(Object.keys(cfg.mcpServers)).toEqual([DB_CONNECTOR_ID]);
  });

  it("uninstallServer removes the entry (re-read confirms gone)", () => {
    openhandsAdapter.installServer(ctx);
    openhandsAdapter.uninstallServer(ctx);
    const cfg = readJson(join(home, ".openhands", "mcp.json"));
    expect(cfg.mcpServers?.[DB_CONNECTOR_ID]).toBeUndefined();
  });
});

// ── Hooks: SEPARATE .openhands/hooks.json (Claude-compatible nested rule) ──────

describe("openhands adapter — hooks (separate hooks.json, project scope)", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-openhands-hooks-");
    ctx = buildCtx(projectDir, buildRenderConnector(), "project");
  });

  it("installHooks writes a SEPARATE .openhands/hooks.json (nested-rule) with the PreToolUse entry", () => {
    const changes = openhandsAdapter.installHooks(ctx);
    expect(changes[0]?.action).toBe("create");

    const hooksPath = openhandsAdapter.getHookConfigPath(ctx);
    // Hook file is SEPARATE from the MCP config file.
    expect(hooksPath).not.toBe(openhandsAdapter.getServerConfigPath(ctx));
    expect(hooksPath).toBe(join(projectDir, ".openhands", "hooks.json"));
    expect(existsSync(hooksPath)).toBe(true);

    // The engine writes the Claude-compatible WRAPPED form: { hooks: { ... } }.
    const file = readJson(hooksPath);
    const entry = file.hooks?.PreToolUse?.[0];
    expect(entry).toBeTruthy();
    expect(entry.matcher).toBe(TOOL_MATCHER);
    expect(entry.hooks[0].type).toBe("command");
    expect(entry.hooks[0].command).toContain(HOME_BIN);
    expect(entry.hooks[0].command).toContain("hook openhands PreToolUse");
    expect(entry.hooks[0].command).toContain(`--connector ${DB_CONNECTOR_ID}`);
  });

  it("user scope writes ~/.openhands/hooks.json (HookConfig.load user fallback)", () => {
    const userCtx = buildCtx(projectDir, buildRenderConnector(), "user");
    expect(openhandsAdapter.getHookConfigPath(userCtx)).toBe(
      join(homedir(), ".openhands", "hooks.json"),
    );
  });

  it("installHooks is idempotent — second call yields the byte-identical skip detail", () => {
    openhandsAdapter.installHooks(ctx);
    const second = openhandsAdapter.installHooks(ctx);
    const skip = second.find((c) => c.action === "skip");
    expect(skip).toBeTruthy();
    expect(skip!.detail).toBe("hooks.PreToolUse already registered");
  });

  it("uninstallHooks removes our entry (re-read confirms gone) with the byte-identical detail", () => {
    openhandsAdapter.installHooks(ctx);
    const removed = openhandsAdapter.uninstallHooks(ctx);
    const remove = removed.find((c) => c.action === "remove");
    expect(remove).toBeTruthy();
    expect(remove!.detail).toBe("hooks.PreToolUse (1)");
    const file = readJson(openhandsAdapter.getHookConfigPath(ctx));
    expect(file.hooks?.PreToolUse).toBeUndefined();
  });

  it("uninstall with no hooks.json present → absent skip (byte-identical detail)", () => {
    const fresh = buildCtx(freshProject("ac-openhands-hooks-"), buildRenderConnector(), "project");
    const changes = openhandsAdapter.uninstallHooks(fresh);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toBe("no hooks section present");
  });

  it("events with no OpenHands analog warn-skip (Notification / PreCompact / SubagentStop)", () => {
    const unsupportedCtx = buildCtx(projectDir, buildUnsupportedConnector(), "project");
    const changes = openhandsAdapter.installHooks(unsupportedCtx);
    for (const event of ["Notification", "PreCompact", "SubagentStop"]) {
      const warn = changes.find((c) => c.action === "warn" && c.detail?.includes(event));
      expect(warn, `${event} should warn-skip`).toBeTruthy();
      expect(warn!.detail).toBe(`${event} has no OpenHands hook equivalent — skipped`);
    }
    // Nothing of ours was written.
    const hooksPath = openhandsAdapter.getHookConfigPath(unsupportedCtx);
    expect(existsSync(hooksPath)).toBe(false);
  });
});

// ── Runtime: parseEvent reads the DIVERGENT OpenHands wire fields ──────────────

describe("openhands adapter — parseEvent (event_type / working_dir / message wire)", () => {
  const COMMON = { session_id: "sess-1", working_dir: "/home/dev/acme" };

  it("PreToolUse maps tool_name + tool_input and working_dir → projectDir", () => {
    const evt = openhandsAdapter.parseEvent!("PreToolUse", {
      ...COMMON,
      event_type: "PreToolUse",
      tool_name: "terminal",
      tool_input: { command: "ls" },
    }) as PreToolUseEvent;
    expect(evt.hostPlatform).toBe("openhands");
    expect(evt.sessionId).toBe("sess-1");
    expect(evt.projectDir).toBe("/home/dev/acme");
    expect(evt.toolName).toBe("terminal");
    expect(evt.toolInput).toEqual({ command: "ls" });
  });

  it("PostToolUse stringifies the tool_response DICT into toolOutput", () => {
    const evt = openhandsAdapter.parseEvent!("PostToolUse", {
      ...COMMON,
      event_type: "PostToolUse",
      tool_name: "terminal",
      tool_input: { command: "ls" },
      tool_response: { output: "a\nb", exit_code: 0 },
    }) as PostToolUseEvent;
    expect(evt.toolName).toBe("terminal");
    expect(evt.toolOutput).toBe(JSON.stringify({ output: "a\nb", exit_code: 0 }));
  });

  it("UserPromptSubmit reads the prompt from `message` (NOT `prompt`)", () => {
    const evt = openhandsAdapter.parseEvent!("UserPromptSubmit", {
      ...COMMON,
      event_type: "UserPromptSubmit",
      message: "fix the bug",
      // A stray Claude-shaped `prompt` field must be IGNORED (false-friend guard).
      prompt: "WRONG",
    } as any) as UserPromptSubmitEvent;
    expect(evt.prompt).toBe("fix the bug");
  });

  it("SessionStart defaults source to startup; SessionEnd + Stop carry only the base", () => {
    const start = openhandsAdapter.parseEvent!("SessionStart", {
      ...COMMON,
      event_type: "SessionStart",
    }) as SessionStartEvent;
    expect(start.source).toBe("startup");

    const end = openhandsAdapter.parseEvent!("SessionEnd", {
      ...COMMON,
      event_type: "SessionEnd",
    }) as SessionEndEvent;
    expect(end.sessionId).toBe("sess-1");
    expect(end.reason).toBeUndefined();

    const stop = openhandsAdapter.parseEvent!("Stop", {
      ...COMMON,
      event_type: "Stop",
    }) as StopEvent;
    expect(stop.sessionId).toBe("sess-1");
  });

  it("an unsupported event throws (no OpenHands analog)", () => {
    for (const event of ["Notification", "PreCompact", "SubagentStop"] as const) {
      expect(() => openhandsAdapter.parseEvent!(event, COMMON)).toThrow(
        /unsupported openhands hook event/,
      );
    }
  });
});

// ── Runtime: formatReply is FLAT JSON (no hookSpecificOutput, no "ask") ────────

describe("openhands adapter — formatReply (flat decision protocol)", () => {
  it("deny → flat {decision:'deny', reason} on stdout, exit 0", () => {
    const reply = openhandsAdapter.formatReply!("PreToolUse", {
      decision: "deny",
      reason: "blocked rm -rf",
    });
    expect(reply.exitCode).toBe(0);
    const out = parseStdout(reply);
    expect(out).toEqual({ decision: "deny", reason: "blocked rm -rf" });
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it("ask degrades to a deny-style block (OpenHands has no confirm on the hook wire)", () => {
    const reply = openhandsAdapter.formatReply!("PreToolUse", {
      decision: "ask",
      reason: "please confirm",
    });
    const out = parseStdout(reply);
    expect(out).toEqual({ decision: "deny", reason: "please confirm" });
  });

  it("context → flat {additionalContext} on stdout", () => {
    const reply = openhandsAdapter.formatReply!("UserPromptSubmit", {
      decision: "context",
      additionalContext: "git status: clean",
    });
    const out = parseStdout(reply);
    expect(out).toEqual({ additionalContext: "git status: clean" });
  });

  it("allow / SessionEnd → pass-through exit 0 with no stdout", () => {
    const allow = openhandsAdapter.formatReply!("PreToolUse", { decision: "allow" });
    expect(allow).toEqual({ exitCode: 0 });

    const end = openhandsAdapter.formatReply!("SessionEnd", { decision: "deny", reason: "x" });
    expect(end).toEqual({ exitCode: 0 });
  });
});
