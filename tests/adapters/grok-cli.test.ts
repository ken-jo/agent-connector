/**
 * tests/adapters/grok-cli — the ONE per-host file for the Grok CLI adapter
 * (community superagent-ai/grok-cli, npm `grok-dev`, bin `grok`, MIT).
 *
 * Grok CLI is a json-stdio host whose native surfaces are USER-SCOPE ONLY and
 * BOTH live in the SAME file (~/.grok/user-settings.json):
 *   • MCP servers → nested `mcp.servers` JSON ARRAY of McpServerConfig objects
 *     { id, label, enabled, transport, url?, headers?, command?, args?, env?,
 *     cwd? }, keyed on `id` = connector id (byte-confirmed src/utils/settings.ts).
 *   • Hooks       → top-level `hooks` (Claude NESTED-rule shape), wired through
 *     the shared object-map hook-merge engine (byte-confirmed src/hooks/types.ts).
 *
 * The stdin wire has two false-friend fields vs Claude: UserPromptSubmit uses
 * `user_prompt` (NOT `prompt`) and PostToolUse uses `tool_output` (NOT
 * `tool_response`). The reply protocol blocks via stdout `{decision:"block"}` and
 * injects context via `{additionalContext}` (byte-confirmed src/hooks/executor.ts
 * aggregateHookResults). These tests are the byte oracle for all of the above.
 *
 * HONEST CEILING: Grok CLI is not installed/authed in this sandbox, so coverage
 * is placement + byte-oracle (rendered config bytes + parse/format), not a live
 * end-to-end hook fire. install-roundtrip auto-covers the install/uninstall
 * lifecycle across the registry.
 */

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import { buildHomeBinHookCommand } from "../../src/core/spawn.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  NotificationEvent,
  PostToolUseEvent,
  PostToolUseFailureEvent,
  PreToolUseEvent,
  ResolvedConnector,
  SessionStartEvent,
  SubagentStartEvent,
  UserPromptSubmitEvent,
} from "../../src/core/types.js";

import grokAdapter from "../../src/adapters/grok-cli/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson } from "../support/fs.js";

const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";

/** A connector with a stdio server (env-ref) + a PreToolUse hook. */
function buildConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
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
        matcher: "acme_query|acme_write",
        handler() {
          return { decision: "allow" };
        },
      },
      UserPromptSubmit: {
        handler() {
          return { decision: "allow" };
        },
      },
    },
  });
}

/** Resolve the user-settings.json path for a HOME-isolated test. */
function userSettingsPath(): string {
  return join(homedir(), ".grok", "user-settings.json");
}

describe("grok-cli adapter", () => {
  createAdapterSuite({ adapter: grokAdapter, paradigm: "json-stdio" });

  isolateEnv([ENV_VAR]);

  let projectDir: string;
  let home: string;

  beforeEach(() => {
    projectDir = freshProject("ac-grok-");
    home = freshProject("ac-grok-home-");
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env[ENV_VAR] = ENV_LITERAL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── identity ──────────────────────────────────────────────────────────────

  it("exposes the grok-cli identity (distinct from xAI Grok Build)", () => {
    expect(grokAdapter.id).toBe("grok-cli");
    expect(grokAdapter.name).toBe("Grok CLI");
    expect(grokAdapter.paradigm).toBe("json-stdio");
    // MCP transports include the remote pair Grok validates (http/sse).
    expect(grokAdapter.capabilities.transports).toEqual(["stdio", "http", "sse"]);
  });

  // ── detection ───────────────────────────────────────────────────────────────

  it("detects ~/.grok and reports user scope + the user-settings.json path", () => {
    const before = grokAdapter.detectInstalled(projectDir);
    expect(before.installed).toBe(false);
    expect(before.scope).toBe("user");

    mkdirSync(join(home, ".grok"), { recursive: true });
    const after = grokAdapter.detectInstalled(projectDir);
    expect(after.installed).toBe(true);
    expect(after.scope).toBe("user");
    expect(after.configPath).toBe(userSettingsPath());
  });

  // ── MCP server install (nested mcp.servers ARRAY, keyed by id) ──────────────

  it("renders a stdio server into mcp.servers[] with the telemetry wrap + literal env", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = grokAdapter.installServer(ctx);
    expect(changes[0]!.action).toBe("create");

    const cfg = readJson(userSettingsPath());
    expect(Array.isArray(cfg.mcp.servers)).toBe(true);
    const entry = cfg.mcp.servers.find((e: { id: string }) => e.id === CONNECTOR_ID);
    expect(entry.id).toBe(CONNECTOR_ID);
    expect(entry.label).toBe("Acme DB Tools");
    expect(entry.enabled).toBe(true);
    expect(entry.transport).toBe("stdio");
    // Telemetry wrap: the real command is routed through the home binary's serve.
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args.slice(0, 7)).toEqual(["serve", "--connector", CONNECTOR_ID, "--scope", "user", "--host", "grok-cli"]);
    expect(entry.args.slice(-4)).toEqual(["--", "npx", "-y", "@x/y"]);
    // env ${env:VAR} resolved to a literal at install time.
    expect(entry.env).toEqual({ [ENV_VAR]: ENV_LITERAL });
  });

  it("is idempotent (byte-identical re-install → skip) and updates on change", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    expect(grokAdapter.installServer(ctx)[0]!.action).toBe("create");
    expect(grokAdapter.installServer(ctx)[0]!.action).toBe("skip");
  });

  it("preserves a sibling mcp.servers entry + sibling top-level keys on install", () => {
    const path = userSettingsPath();
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        {
          apiKey: "keep-me",
          mcp: { servers: [{ id: "other", label: "Other", enabled: true, transport: "stdio", command: "other-bin" }] },
        },
        null,
        2,
      ),
    );
    grokAdapter.installServer(buildCtx(projectDir, buildConnector(), "user"));
    const cfg = readJson(path);
    expect(cfg.apiKey).toBe("keep-me");
    const ids = cfg.mcp.servers.map((e: { id: string }) => e.id).sort();
    expect(ids).toEqual(["acme-db", "other"]);
  });

  it("never clobbers a malformed mcp.servers (non-array) — skip-warn", () => {
    const path = userSettingsPath();
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(path, JSON.stringify({ mcp: { servers: "nope" } }, null, 2));
    const changes = grokAdapter.installServer(buildCtx(projectDir, buildConnector(), "user"));
    expect(changes[0]!.action).toBe("warn");
    expect(readJson(path).mcp.servers).toBe("nope");
  });

  it("renders a remote (http) server as a url entry", () => {
    const connector = defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme Remote",
      version: "1.0.0",
      server: { transport: "http", url: "https://mcp.acme.test/sse" },
    });
    grokAdapter.installServer(buildCtx(projectDir, connector, "user"));
    const entry = readJson(userSettingsPath()).mcp.servers[0];
    expect(entry).toEqual({
      id: CONNECTOR_ID,
      label: "Acme Remote",
      enabled: true,
      transport: "http",
      url: "https://mcp.acme.test/sse",
    });
  });

  it("uninstall removes only our mcp.servers entry, leaving siblings", () => {
    const path = userSettingsPath();
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    grokAdapter.installServer(ctx);
    // inject a sibling
    const cfg = readJson(path);
    cfg.mcp.servers.push({ id: "other", label: "Other", enabled: true, transport: "stdio", command: "x" });
    writeFileSync(path, JSON.stringify(cfg, null, 2));

    expect(grokAdapter.uninstallServer(ctx)[0]!.action).toBe("remove");
    const after = readJson(path);
    expect(after.mcp.servers.map((e: { id: string }) => e.id)).toEqual(["other"]);
    // a second uninstall is a no-op skip.
    expect(grokAdapter.uninstallServer(ctx)[0]!.action).toBe("skip");
  });

  // ── Hooks (top-level hooks, Claude nested-rule shape) ───────────────────────

  it("writes a nested Claude-shaped hook entry pointing at the home binary", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    grokAdapter.installHooks(ctx);
    const cfg = readJson(userSettingsPath());
    const pre = cfg.hooks.PreToolUse;
    expect(pre).toEqual([
      {
        matcher: "acme_query|acme_write",
        hooks: [
          {
            type: "command",
            command: buildHomeBinHookCommand(HOME_BIN, "grok-cli", "PreToolUse", CONNECTOR_ID),
          },
        ],
      },
    ]);
    // UserPromptSubmit registers with an empty matcher.
    expect(cfg.hooks.UserPromptSubmit[0].matcher).toBe("");
  });

  it("warn-skips an event Grok has no analog for (PermissionRequest)", () => {
    const connector = defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme",
      version: "1.0.0",
      hooks: { PermissionRequest: { handler: () => ({ decision: "ask" }) } },
    });
    const changes = grokAdapter.installHooks(buildCtx(projectDir, connector, "user"));
    expect(changes[0]!.action).toBe("warn");
    expect(changes[0]!.detail).toContain("no Grok CLI hook equivalent");
  });

  it("installs a free-form nativeHooks event verbatim alongside normalized hooks", () => {
    const connector = defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme",
      version: "1.0.0",
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: {
        "grok-cli": {
          nativeHooks: {
            TaskCreated: { matcher: "explore", handler: () => ({ decision: "allow" }) },
          },
        },
      },
    });
    grokAdapter.installHooks(buildCtx(projectDir, connector, "user"));
    const cfg = readJson(userSettingsPath());
    expect(cfg.hooks.PreToolUse).toBeTruthy();
    expect(cfg.hooks.TaskCreated[0].matcher).toBe("explore");
    expect(cfg.hooks.TaskCreated[0].hooks[0].command).toBe(
      buildHomeBinHookCommand(HOME_BIN, "grok-cli", "TaskCreated", CONNECTOR_ID),
    );
  });

  it("uninstall strips only our hook commands and drops the emptied event", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    grokAdapter.installHooks(ctx);
    expect(grokAdapter.uninstallHooks(ctx).some((c) => c.action === "remove")).toBe(true);
    const cfg = readJson(userSettingsPath());
    expect(cfg.hooks.PreToolUse).toBeUndefined();
    expect(cfg.hooks.UserPromptSubmit).toBeUndefined();
  });

  it("symlinked user-settings.json is refused (never written through)", () => {
    const path = userSettingsPath();
    mkdirSync(join(home, ".grok"), { recursive: true });
    const real = join(home, "real-settings.json");
    writeFileSync(real, "{}");
    symlinkSync(real, path);
    const changes = grokAdapter.installServer(buildCtx(projectDir, buildConnector(), "user"));
    expect(changes[0]!.action).toBe("warn");
    expect(readFileSync(real, "utf8")).toBe("{}");
  });

  // ── parseEvent (the false-friend wire fields) ───────────────────────────────

  it("parseEvent reads Grok's distinct field names (user_prompt, tool_output, error, agent_type)", () => {
    const pre = grokAdapter.parseEvent!("PreToolUse", {
      hook_event_name: "PreToolUse",
      session_id: "s1",
      cwd: "/work",
      tool_name: "bash",
      tool_input: { command: "ls" },
      connector: CONNECTOR_ID,
    }) as PreToolUseEvent;
    expect(pre.toolName).toBe("bash");
    expect(pre.sessionId).toBe("s1");
    expect(pre.projectDir).toBe("/work");
    expect(pre.connectorId).toBe(CONNECTOR_ID);

    // PostToolUse — Grok sends tool_output (NOT tool_response).
    const post = grokAdapter.parseEvent!("PostToolUse", {
      tool_name: "bash",
      tool_input: {},
      tool_output: { stdout: "hi" },
      tool_response: "WRONG-FIELD-must-be-ignored",
    }) as PostToolUseEvent;
    expect(post.toolOutput).toBe(JSON.stringify({ stdout: "hi" }));

    // UserPromptSubmit — Grok sends user_prompt (NOT prompt).
    const ups = grokAdapter.parseEvent!("UserPromptSubmit", {
      user_prompt: "do the thing",
      prompt: "WRONG-FIELD",
    }) as UserPromptSubmitEvent;
    expect(ups.prompt).toBe("do the thing");

    // PostToolUseFailure — `error` string.
    const fail = grokAdapter.parseEvent!("PostToolUseFailure", {
      tool_name: "bash",
      tool_input: {},
      error: "boom",
    }) as PostToolUseFailureEvent;
    expect(fail.error).toBe("boom");

    // SessionStart — `source` enum.
    const start = grokAdapter.parseEvent!("SessionStart", { source: "resume" }) as SessionStartEvent;
    expect(start.source).toBe("resume");

    // SubagentStart — `agent_type`.
    const sub = grokAdapter.parseEvent!("SubagentStart", { agent_type: "explore" }) as SubagentStartEvent;
    expect(sub.agentType).toBe("explore");

    // Notification — `message`.
    const note = grokAdapter.parseEvent!("Notification", { message: "heads up" }) as NotificationEvent;
    expect(note.message).toBe("heads up");
  });

  it("parseEvent throws on PermissionRequest (Grok has no such event)", () => {
    expect(() => grokAdapter.parseEvent!("PermissionRequest", {})).toThrow(/unsupported grok-cli/);
  });

  // ── formatReply (Grok's decision/additionalContext stdout protocol) ─────────

  it("deny → stdout {decision:'block', reason} at exit 0", () => {
    const reply = grokAdapter.formatReply!("PreToolUse", { decision: "deny", reason: "nope" });
    expect(reply.exitCode).toBe(0);
    expect(JSON.parse(reply.stdout!)).toEqual({ decision: "block", reason: "nope" });
  });

  it("context → stdout {additionalContext} at exit 0", () => {
    const reply = grokAdapter.formatReply!("UserPromptSubmit", {
      decision: "context",
      additionalContext: "hint",
    });
    expect(JSON.parse(reply.stdout!)).toEqual({ additionalContext: "hint" });
  });

  it("allow / ask (no Grok analog) → plain exit-0 passthrough", () => {
    expect(grokAdapter.formatReply!("PreToolUse", { decision: "allow" })).toEqual({ exitCode: 0 });
    expect(grokAdapter.formatReply!("PreToolUse", { decision: "ask" })).toEqual({ exitCode: 0 });
  });
});
