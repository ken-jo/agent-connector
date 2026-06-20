/**
 * adapters/openclaw.test.ts — the ONE per-host file for OpenClaw (Gateway).
 *
 * OpenClaw is a `ts-plugin` host with DUAL REGISTRATION: its config
 * (~/.openclaw/openclaw.json, a JSONC/JSON5 file) carries BOTH a nested
 * `mcp.servers.<id>` entry AND a `plugins.entries.<id>` reference + a
 * `plugins.load.paths` dir scan; the generated plugin module (index.mjs) imports
 * nothing from agent-connector and shells out to the ONE stable home binary's
 * universal entrypoint over child_process (fail-open). This file consolidates
 * EVERY openclaw surface (the per-host convention in tests/README.md — one file
 * per host):
 *   • MCP server  → nested mcp.servers.<id> (NOT a top-level mcpServers key);
 *                   stdio sidecars infer transport from `command` (NO transport
 *                   key); remote http → the accepted literal "streamable-http".
 *   • hooks       → the generated plugin module + openclaw.plugin.json manifest,
 *                   plugins.entries.<id> = { enabled }, plugins.load.paths dir;
 *                   before_tool_call (PreToolUse, modify-in-place),
 *                   before_prompt_build (SessionStart once + UserPromptSubmit
 *                   per-turn, inject-only), subagent_spawned/subagent_ended
 *                   (SubagentStart/SubagentStop, observe-only); hooks:false must
 *                   suppress the canonical handlers even via installActions.
 *   • skills      → AgentSkills dir-per-skill SKILL.md under <workspace>/skills
 *                   (project) / ~/.openclaw/skills (user).
 *   • actions     → slash commands registered INSIDE the shared plugin module.
 *   • regressions → JSONC parseJsonc tolerance (// comment + in-string ",]").
 *
 * The generated bridge is exercised LIVE (the freshly-written module is
 * dynamically imported with node:child_process mocked, following the wave4
 * idiom). Migrated to the shared harness (tests/support/env + adapter-suite); the
 * render/dual-registration/skills/action blocks came from the old wave4 suite,
 * the extension-event blocks from the extended-events batch suite, the
 * UserPromptSubmit blocks from the UserPromptSubmit suite, the remote transport
 * block from the remote-transport suite, the hooks:false leak block from the
 * hooks:false-leak suite, and the parseJsonc regression from the review-fixes
 * suite. (The nemoclaw rows of the shared trio suites moved to nemoclaw.test.ts.)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDir } from "../../src/core/paths.js";
import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  HookResponse,
  ResolvedConnector,
  SubagentStartEvent,
  SubagentStopEvent,
  Transport,
} from "../../src/core/types.js";

import openclawAdapter from "../../src/adapters/openclaw/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { readJson } from "../support/fs.js";
import { createAdapterSuite } from "../support/adapter-suite.js";

// ─────────────────────────────────────────────────────────────────────────
// node:child_process mock — hoisted above every import by vitest. The openclaw
// generated-plugin bridge imports `execFileSync` (POSIX) / `execSync` (Windows)
// at top-level; each test reprograms what the mock returns via execFileSyncImpl,
// then dynamically imports the freshly-written module so the bridge calls into
// this mock. (Carried from the former extended-events-batch2.test.ts / wave4.)
// ─────────────────────────────────────────────────────────────────────────

let execFileSyncImpl: (...args: any[]) => string = () => "";
const execFileSyncMock = vi.fn((...args: any[]) => execFileSyncImpl(...args));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  execSync: execFileSyncMock,
}));

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const AGENT_MATCHER = "code-reviewer|explore";
// The UserPromptSubmit slice declares a distinct connector id (acme-ups).
const UPS_CONNECTOR_ID = "acme-ups";

// The serve-wrapper tail also bakes the install TARGET platform as `--host <id>`
// (before `--`) so the proxy stamps hostPlatform under a headless spawn.
const wrappedTail = (host: string): string[] =>
  ["serve", "--connector", CONNECTOR_ID, "--scope", "project", "--host", host, "--", "npx", "-y", "@x/y"];

/** A connector with a stdio server (env-ref) + PreToolUse and SessionStart hooks. */
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
      SessionStart: {
        handler() {
          return { decision: "allow" };
        },
      },
    },
  });
}

/** A connector declaring exactly the four E1 extension events. */
function buildExtConnector(): ResolvedConnector {
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

/** Declares BOTH SessionStart and UserPromptSubmit (global hooks, host-agnostic). */
function connectorBoth(): ResolvedConnector {
  return defineConnector({
    id: UPS_CONNECTOR_ID,
    hooks: {
      SessionStart: { handler: () => ({ decision: "allow" }) },
      UserPromptSubmit: { handler: () => ({ decision: "allow" }) },
    },
  });
}

/** Declares UserPromptSubmit only (no SessionStart → no session_start handler). */
function connectorPromptOnly(): ResolvedConnector {
  return defineConnector({
    id: UPS_CONNECTOR_ID,
    hooks: { UserPromptSubmit: { handler: () => ({ decision: "allow" }) } },
  });
}

/** A canonical PreToolUse hook + a host-native passthrough hook, hooks toggled. */
function connectorNative(host: string, hooksDisabled: boolean): ResolvedConnector {
  return defineConnector({
    id: UPS_CONNECTOR_ID,
    hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
    platforms: {
      [host]: {
        nativeHooks: { agent_turn: { handler: () => undefined } },
        ...(hooksDisabled ? { hooks: false } : {}),
      },
    },
  });
}

/** A connector declaring one skill (with a bundled resource) — drives skills. */
function buildSkillsConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    skills: [
      {
        name: "db-explain",
        description: "Explain a SQL query plan. Use when the user asks why a query is slow.",
        body: "# DB Explain\n\nRun EXPLAIN on the query and summarize the plan.",
        resources: { "scripts/run.sh": "#!/bin/sh\necho explain\n" },
      },
    ],
  });
}

/** A connector with ONLY actions (no server, no hooks) — drives installActions. */
function actionsOnlyConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    actions: [
      { id: "reindex", description: "Rebuild the search index.", run: () => undefined },
      // A description with an embedded double-quote — must be JSON-escaped so the
      // generated module still parses (a raw " would take the whole plugin down).
      { id: "purge", description: 'Purge the "stale" cache.', run: () => undefined },
    ],
  });
}

/** A connector with BOTH hooks and actions — drives the shared-ensurePlugin path. */
function hooksAndActionsConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: { transport: "stdio", command: "npx", args: ["-y", "@x/y"], tools: { include: ["*"] } },
    hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
    actions: [{ id: "reindex", description: "Rebuild the search index.", run: () => undefined }],
  });
}

// ── remote transport fixtures ─────────────────────────────────────────────────
const REMOTE_CONNECTOR_ID = "acme-remote";

function remoteConnector(transport: Transport): ResolvedConnector {
  return defineConnector({
    id: REMOTE_CONNECTOR_ID,
    displayName: "Acme Remote",
    version: "1.0.0",
    server: {
      transport,
      url: "https://mcp.acme.example/endpoint",
      headers: { Authorization: "Bearer ${env:ACME_TOKEN}" },
      tools: { include: ["*"] },
    },
  });
}

/** Install a remote server and return the written native entry. */
function installRemoteAndRead(transport: Transport, prefix: string): Record<string, any> {
  const projectDir = freshRemoteHome(prefix);
  const ctx = buildCtx(projectDir, remoteConnector(transport));
  openclawAdapter.installServer!(ctx);
  const cfg = JSON.parse(readFileSync(openclawAdapter.getServerConfigPath!(ctx), "utf8"));
  return cfg.mcp.servers[REMOTE_CONNECTOR_ID];
}

/** Fresh HOME for the remote-transport slice: pins ACME_TOKEN, clears OPENCLAW_*. */
function freshRemoteHome(prefix: string): string {
  const dir = freshProject(prefix);
  process.env.ACME_TOKEN = "tok-123";
  delete process.env.OPENCLAW_CONFIG_PATH;
  delete process.env.OPENCLAW_STATE_DIR;
  return dir;
}

// ── hooks:false leak fixtures ──────────────────────────────────────────────────
const LEAK_CONNECTOR_ID = "acme-leak";

/** A connector with a canonical PreToolUse hook + an action, hooks toggled per arg. */
function leakConnector(hooksDisabled: boolean): ResolvedConnector {
  return defineConnector({
    id: LEAK_CONNECTOR_ID,
    hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
    actions: [{ id: "reindex", description: "Rebuild the search index.", run: () => undefined }],
    platforms: hooksDisabled ? { openclaw: { hooks: false } } : {},
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Live-bridge helpers (dynamic import of the freshly-written generated module)
// ─────────────────────────────────────────────────────────────────────────

/** Build a fake `api` that records every api.on(event, handler) registration. */
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

/** Dynamically import the generated plugin and collect its api.on registrations. */
async function loadHandlers(pluginPath: string): Promise<Record<string, any>> {
  const url = `${pathToFileURL(pluginPath).href}?t=${Date.now()}-${Math.random()}`;
  const mod = await import(/* @vite-ignore */ url);
  const handlers: Record<string, any> = {};
  mod.default.register({ on: (event: string, h: any) => (handlers[event] = h) });
  return handlers;
}

// Pin process.platform to a POSIX value for the whole file so the generated
// bridge takes its execFileSync(HOME_BIN, [args]) path (on Windows it would use
// execSync(one quoted string) — correct in production, proven separately, but it
// would not match these bridges' execFileSync(bin, argv) call-shape assertions).
const REAL_PLATFORM = process.platform;
beforeEach(() => {
  execFileSyncMock.mockClear();
  execFileSyncImpl = () => "";
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
});

// Shared env isolation (default keys + the env-ref / OpenClaw root vars the
// render/remote slices mutate) + the same-rules-for-every-host baseline contract.
isolateEnv([ENV_VAR, "ACME_TOKEN", "OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"]);
createAdapterSuite({ adapter: openclawAdapter, paradigm: "ts-plugin" });

// ─────────────────────────────────────────────────────────────────────────
// MCP server render + dual registration (NESTED mcp.servers, JSON5 config)
// ─────────────────────────────────────────────────────────────────────────

describe("openclaw adapter (ts-plugin) render + dual registration", () => {
  let projectDir: string;
  let ctx: InstallContext;
  let configPath: string;

  beforeEach(() => {
    projectDir = freshProject("ac-w4-oclaw-");
    process.env[ENV_VAR] = ENV_LITERAL;
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.OPENCLAW_STATE_DIR;
    ctx = buildCtx(projectDir, buildConnector());
    configPath = join(projectDir, "openclaw.json");
    expect(configPath).toBe(openclawAdapter.getServerConfigPath(ctx));
  });

  it("installServer writes the NESTED mcp.servers.<id> entry (not a top-level mcpServers key)", () => {
    const changes = openclawAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(existsSync(configPath)).toBe(true);

    const cfg = readJson(configPath);
    // Nested under the top-level "mcp" object, key "servers".
    expect(cfg).toHaveProperty("mcp");
    expect(cfg).not.toHaveProperty("mcpServers");
    expect(cfg.mcp).toHaveProperty("servers");

    const entry = cfg.mcp.servers[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    // OpenClaw 2026.6.1 REJECTS transport:"stdio" — a stdio sidecar is inferred
    // from `command`, so the entry must carry NO transport key.
    expect(entry.transport).toBeUndefined();
    expect("transport" in entry).toBe(false);
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedTail("openclaw"));
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    openclawAdapter.installServer(ctx);
    const second = openclawAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(configPath);
    expect(Object.keys(cfg.mcp.servers)).toEqual([CONNECTOR_ID]);
  });

  it("uninstallServer removes the nested entry (re-read confirms gone)", () => {
    openclawAdapter.installServer(ctx);
    openclawAdapter.uninstallServer(ctx);

    const cfg = readJson(configPath);
    expect(cfg.mcp?.servers?.[CONNECTOR_ID]).toBeUndefined();
  });

  it("installHooks adds BOTH the plugin module AND a plugins.entries reference (BOTH present)", () => {
    const changes = openclawAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    // Half (a): plugin module on disk.
    const pluginPath = join(
      projectDir,
      ".openclaw",
      "extensions",
      CONNECTOR_ID,
      "index.mjs",
    );
    expect(pluginPath).toBe(openclawAdapter.getHookConfigPath(ctx));
    expect(existsSync(pluginPath)).toBe(true);

    // Half (b): plugins.entries.<id> reference written into openclaw.json.
    const cfg = readJson(configPath);
    expect(cfg.plugins?.entries?.[CONNECTOR_ID]).toBeTruthy();
    expect(cfg.plugins.entries[CONNECTOR_ID].enabled).toBe(true);
    // `openclaw config validate` REJECTS a per-entry `module` field, so the entry
    // is { enabled: true } ONLY — discovery is via plugins.load.paths instead.
    expect(cfg.plugins.entries[CONNECTOR_ID].module).toBeUndefined();
    const pluginDir = join(projectDir, ".openclaw", "extensions", CONNECTOR_ID);
    expect(Array.isArray(cfg.plugins.load?.paths)).toBe(true);
    expect(cfg.plugins.load.paths).toContain(pluginDir);

    // The plugin dir also carries an openclaw.plugin.json manifest beside the
    // module so the gateway's dir scan can load it.
    const manifestPath = join(pluginDir, "openclaw.plugin.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = readJson(manifestPath);
    expect(manifest.id).toBe(CONNECTOR_ID);
    expect(manifest.main).toBe("index.mjs");
    // configSchema is REQUIRED — `openclaw config validate` rejects a manifest
    // without it ("plugin manifest requires configSchema"). Our plugin takes no
    // user config → the empty closed object schema (openclaw's minimal example).
    expect(manifest.configSchema).toEqual({
      type: "object",
      additionalProperties: false,
    });

    // The generated module is the self-contained bridge: it imports NOTHING from
    // agent-connector (the only allowed import is node:child_process). The string
    // "agent-connector" may appear in the AUTO-GENERATED header comment — what
    // must be absent is an actual import/require of the package.
    const src = readFileSync(pluginPath, "utf8");
    expect(src).not.toMatch(/from\s+["'][^"']*agent-connector/);
    expect(src).not.toMatch(/require\(\s*["'][^"']*agent-connector/);
    expect(src).toContain('import { execFileSync, execSync } from "node:child_process"');
    expect(src).toContain("execFileSync");
    expect(src).toContain('"hook"');
    expect(src).toContain('"openclaw"');
    expect(src).toContain("--connector");
    expect(src).toContain(CONNECTOR_ID);
    expect(src).toContain(HOME_BIN);
    // The OpenClaw plugin definition shape + register(api) + the typed hook.
    expect(src).toContain("export default plugin");
    expect(src).toContain("register(api)");
    expect(src).toContain("before_tool_call");
  });

  it("installHooks is idempotent — a second full install (server + hooks) yields only skips", () => {
    openclawAdapter.installServer(ctx);
    openclawAdapter.installHooks(ctx);
    const secondServer = openclawAdapter.installServer(ctx);
    const secondHooks = openclawAdapter.installHooks(ctx);
    expect(secondServer.every((c) => c.action === "skip")).toBe(true);
    expect(secondHooks.every((c) => c.action === "skip")).toBe(true);
  });

  it("getHealthChecks PASSES when both registrations are present", () => {
    openclawAdapter.installServer(ctx);
    openclawAdapter.installHooks(ctx);

    const dual = openclawAdapter
      .getHealthChecks!(ctx)
      .find((c) => /dual registration/.test(c.name))!;
    expect(dual).toBeTruthy();
    expect(dual.check().status).toBe("OK");
  });

  it("getHealthChecks FAILS if you remove one side (entries-only → no MCP tools reach the agent)", () => {
    // Full install (both halves present)...
    openclawAdapter.installServer(ctx);
    openclawAdapter.installHooks(ctx);

    // ...then SIMULATE entries-only by surgically deleting the mcp.servers half,
    // leaving plugins.entries.<id> in place.
    const cfg = readJson(configPath);
    delete cfg.mcp.servers[CONNECTOR_ID];
    writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");

    // Sanity: entries still present, mcp.servers half gone.
    const reread = readJson(configPath);
    expect(reread.plugins.entries[CONNECTOR_ID]).toBeTruthy();
    expect(reread.mcp.servers[CONNECTOR_ID]).toBeUndefined();

    const dual = openclawAdapter
      .getHealthChecks!(ctx)
      .find((c) => /dual registration/.test(c.name))!;
    const result = dual.check();
    expect(result.status).toBe("FAIL");
    // The FAIL must name the exact inconsistency (plugin loads but no tools).
    expect(result.detail).toMatch(/mcp\.servers/);
  });

  it("getHealthChecks FAILS the mirror case too (mcp.servers-only → plugin never loads)", () => {
    openclawAdapter.installServer(ctx);
    openclawAdapter.installHooks(ctx);

    // Remove the plugins.entries half, leaving mcp.servers in place.
    const cfg = readJson(configPath);
    delete cfg.plugins.entries[CONNECTOR_ID];
    writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");

    const dual = openclawAdapter
      .getHealthChecks!(ctx)
      .find((c) => /dual registration/.test(c.name))!;
    const result = dual.check();
    expect(result.status).toBe("FAIL");
    expect(result.detail).toMatch(/plugins\.entries/);
  });

  it("uninstallHooks removes the plugins.entries reference, drops the dir from plugins.load.paths, AND removes the module + manifest on disk", () => {
    openclawAdapter.installServer(ctx);
    openclawAdapter.installHooks(ctx);

    const pluginPath = openclawAdapter.getHookConfigPath(ctx);
    const pluginDir = join(projectDir, ".openclaw", "extensions", CONNECTOR_ID);
    const manifestPath = join(pluginDir, "openclaw.plugin.json");
    expect(existsSync(pluginPath)).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);
    expect(readJson(configPath).plugins.entries[CONNECTOR_ID]).toBeTruthy();
    expect(readJson(configPath).plugins.load.paths).toContain(pluginDir);

    openclawAdapter.uninstallHooks(ctx);

    expect(existsSync(pluginPath)).toBe(false);
    expect(existsSync(manifestPath)).toBe(false);
    const cfg = readJson(configPath);
    expect(cfg.plugins?.entries?.[CONNECTOR_ID]).toBeUndefined();
    expect(Array.isArray(cfg.plugins?.load?.paths) ? cfg.plugins.load.paths : []).not.toContain(
      pluginDir,
    );
  });

  it("tolerates a JSON5/JSONC openclaw.json with a // comment — install still works", () => {
    // Pre-author a commented config (strict JSON.parse would throw on this).
    ensureDir(dirname(configPath));
    const commented = [
      "{",
      '  // user-authored openclaw config (JSON5 — comments allowed)',
      '  "logLevel": "info",',
      "  /* block comment */",
      '  "mcp": {',
      '    "servers": {}, // trailing comma below is also tolerated',
      "  },",
      "}",
      "",
    ].join("\n");
    writeFileSync(configPath, commented, "utf8");

    // Install both halves over the commented file. A strict parse would have
    // false-failed (returned null → silent data loss); the tolerant parse reads it.
    const serverChanges = openclawAdapter.installServer(ctx);
    const hookChanges = openclawAdapter.installHooks(ctx);
    expect(serverChanges[0]?.action).toBe("create");
    expect(hookChanges.some((c) => c.action === "create")).toBe(true);

    // The pre-existing user key SURVIVED the merge (the comment was stripped, but
    // real data is preserved).
    const cfg = readJson(configPath);
    expect(cfg.logLevel).toBe("info");
    expect(cfg.mcp.servers[CONNECTOR_ID]).toBeTruthy();
    expect(cfg.plugins.entries[CONNECTOR_ID]).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// remote MCP transport literal (http → "streamable-http", sse → "sse")
//
// OpenClaw's config validator accepts a remote `transport` of "sse" |
// "streamable-http" and REJECTS a bare "http" (verified against OpenClaw 2026.6.1
// + docs.openclaw.ai/gateway/configuration-reference). AC's canonical "http"
// (streamable HTTP) must therefore render as the literal "streamable-http", not
// "http". Remote servers are never telemetry-wrapped (shouldWrapForTelemetry is
// stdio-only), so the remote branch always runs.
// ─────────────────────────────────────────────────────────────────────────

describe("openclaw adapter — remote MCP transport literal", () => {
  it("renders canonical http as OpenClaw's accepted literal 'streamable-http' (NOT 'http')", () => {
    const entry = installRemoteAndRead("http", "ac-openclaw-http-");
    expect(entry.transport).toBe("streamable-http");
    expect(entry.transport).not.toBe("http");
    expect(entry.url).toBe("https://mcp.acme.example/endpoint");
    // headers carried + env ref resolved to a literal (no native ${env:} token).
    expect(entry.headers.Authorization).toBe("Bearer tok-123");
    // remote sidecar is NOT telemetry-wrapped → no stdio command shape.
    expect("command" in entry).toBe(false);
  });

  it("renders sse as 'sse'", () => {
    const entry = installRemoteAndRead("sse", "ac-openclaw-sse-");
    expect(entry.transport).toBe("sse");
    expect(entry.url).toBe("https://mcp.acme.example/endpoint");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// skills content surface (AgentSkills dir-per-skill SKILL.md + resources)
// ─────────────────────────────────────────────────────────────────────────

describe("openclaw adapter — skills content surface (AgentSkills dir-per-skill SKILL.md)", () => {
  let projectDir: string;
  let ctx: InstallContext;
  let skillDir: string;
  let skillMd: string;

  beforeEach(() => {
    projectDir = freshProject("ac-w4-oclaw-skills-");
    ctx = buildCtx(projectDir, buildSkillsConnector());
    // Project scope with no agents.defaults.workspace set → the workspace
    // resolves to <stateDir>/workspace = ~/.openclaw/workspace, and the skill
    // root is <workspace>/skills/<name> (the highest-priority documented root).
    skillDir = join(projectDir, ".openclaw", "workspace", "skills", "db-explain");
    skillMd = join(skillDir, "SKILL.md");
  });

  it("installSkills writes the SKILL.md (+ bundled resource) at the resolved <workspace>/skills/<name> path, stamped platform=openclaw", () => {
    const changes = openclawAdapter.installSkills(ctx);
    // Every record is stamped with this host's id.
    expect(changes.every((c) => c.platform === "openclaw")).toBe(true);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    expect(existsSync(skillMd)).toBe(true);
    // The resource lands beside SKILL.md, inside the skill dir.
    expect(existsSync(join(skillDir, "scripts", "run.sh"))).toBe(true);

    const src = readFileSync(skillMd, "utf8");
    // AgentSkills frontmatter: single-line name + description keys + body.
    expect(src.startsWith("---\n")).toBe(true);
    expect(src).toMatch(/^name: db-explain$/m);
    expect(src).toMatch(/^description: Explain a SQL query plan\./m);
    expect(src).toContain("# DB Explain");
  });

  it("installSkills is idempotent — a second call yields only skips", () => {
    openclawAdapter.installSkills(ctx);
    const second = openclawAdapter.installSkills(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
    expect(existsSync(skillMd)).toBe(true);
  });

  it("installSkills honors platforms['openclaw'].skills === false (skip, no write)", () => {
    const off = defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme DB Tools",
      version: "1.2.3",
      skills: [
        {
          name: "db-explain",
          description: "Explain a SQL query plan. Use when the user asks why a query is slow.",
          body: "x",
        },
      ],
      platforms: { openclaw: { skills: false } },
    });
    const offCtx = buildCtx(projectDir, off);
    const changes = openclawAdapter.installSkills(offCtx);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(skillMd)).toBe(false);
  });

  it("uninstallSkills removes SKILL.md, the resource, and the now-empty skill dir (re-read confirms gone)", () => {
    openclawAdapter.installSkills(ctx);
    expect(existsSync(skillMd)).toBe(true);

    const changes = openclawAdapter.uninstallSkills(ctx);
    expect(changes.every((c) => c.platform === "openclaw")).toBe(true);
    expect(changes.some((c) => c.action === "remove")).toBe(true);

    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(join(skillDir, "scripts", "run.sh"))).toBe(false);
    // The skill dir itself is dropped (we owned its full contents).
    expect(existsSync(skillDir)).toBe(false);
  });

  it("user scope targets ~/.openclaw/skills/<name>/SKILL.md (the `--global` install target)", () => {
    const userCtx: InstallContext = { ...ctx, scope: "user" };
    openclawAdapter.installSkills(userCtx);
    // user scope resolves the config dir to ~/.openclaw (HOME is pinned to the
    // temp project dir), so the skill root is ~/.openclaw/skills/<name>.
    const userSkillMd = join(projectDir, ".openclaw", "skills", "db-explain", "SKILL.md");
    expect(existsSync(userSkillMd)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// generated plugin — THE BRIDGE WORKS (live, child_process mocked)
// ─────────────────────────────────────────────────────────────────────────

describe("openclaw generated plugin — THE BRIDGE WORKS (live, child_process mocked)", () => {
  let projectDir: string;
  let ctx: InstallContext;
  let pluginPath: string;

  beforeEach(() => {
    projectDir = freshProject("ac-w4-oclaw-bridge-");
    process.env[ENV_VAR] = ENV_LITERAL;
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.OPENCLAW_STATE_DIR;
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

  it("default export is the plugin definition { id, name, register }; register wires before_tool_call via api.on", async () => {
    const mod = await loadPlugin();
    expect(mod.default).toBeTruthy();
    expect(mod.default.id).toBe(CONNECTOR_ID);
    expect(typeof mod.default.register).toBe("function");

    const api = fakeApi();
    mod.default.register(api);
    expect(typeof api.handlers["before_tool_call"]).toBe("function");
  });

  it("a 'deny' decision from the bridge returns OpenClaw's native { block:true, blockReason }", async () => {
    execFileSyncImpl = () => JSON.stringify({ decision: "deny", reason: "nope" });

    const mod = await loadPlugin();
    const api = fakeApi();
    mod.default.register(api);

    const result = await api.handlers["before_tool_call"]!({
      toolName: "acme_write",
      params: { sql: "DELETE" },
    });

    expect(result).toEqual({ block: true, blockReason: "nope" });

    // The bridge actually shelled out to the universal entrypoint with our argv.
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [bin, argv] = execFileSyncMock.mock.calls[0]!;
    expect(bin).toBe(HOME_BIN);
    expect(argv).toEqual([
      "hook",
      "openclaw",
      "PreToolUse",
      "--connector",
      CONNECTOR_ID,
    ]);
  });

  it("a 'modify' decision with updatedInput mutates event.params in place", async () => {
    execFileSyncImpl = () =>
      JSON.stringify({ decision: "modify", updatedInput: { x: 1 } });

    const mod = await loadPlugin();
    const api = fakeApi();
    mod.default.register(api);

    const event: { toolName: string; params: Record<string, unknown> } = {
      toolName: "acme_write",
      params: {},
    };
    const result = await api.handlers["before_tool_call"]!(event);

    expect(result).toBeUndefined();
    // event.params was mutated in place to carry the rewritten input.
    expect(event.params).toEqual({ x: 1 });
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it("a bridge error fails OPEN — the before_tool_call handler swallows it and does not block", async () => {
    execFileSyncImpl = () => {
      throw new Error("home bin missing");
    };

    const mod = await loadPlugin();
    const api = fakeApi();
    mod.default.register(api);

    const event = { toolName: "acme_query", params: { sql: "SELECT 1" } };
    const result = await api.handlers["before_tool_call"]!(event);
    // Fail-open: a bridge exception degrades to a no-op (no block, no mutation).
    expect(result).toBeUndefined();
    expect(event.params).toEqual({ sql: "SELECT 1" });
  });
});

describe("openclaw adapter runtime dispatch — parseEvent + formatReply round-trip", () => {
  it("formatReply returns exit 0 and stdout that JSON-parses to the normalized response", () => {
    const deny: HookResponse = { decision: "deny", reason: "x" };
    const reply = openclawAdapter.formatReply!("PreToolUse", deny);

    expect(reply.exitCode).toBe(0);
    const out = JSON.parse(reply.stdout!);
    expect(out).toEqual({ decision: "deny", reason: "x" });
  });

  it("parseEvent maps a sent bridge payload to a normalized PreToolUse event", () => {
    const evt = openclawAdapter.parseEvent!("PreToolUse", {
      toolName: "acme_write",
      toolInput: { sql: "DELETE" },
      sessionId: "oc-1",
      projectDir: "/some/proj",
    });

    expect(evt).toMatchObject({
      hostPlatform: "openclaw",
      toolName: "acme_write",
      toolInput: { sql: "DELETE" },
      sessionId: "oc-1",
      projectDir: "/some/proj",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// extended events (E1): subagent lifecycle wired; permission/failure unsupported
// ─────────────────────────────────────────────────────────────────────────

describe("openclaw — extended-event install (generated plugin)", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-ext-events2-");
    ctx = buildCtx(projectDir, buildExtConnector());
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
    projectDir = freshProject("ac-ext-events2-");
    ctx = buildCtx(projectDir, buildExtConnector());
    openclawAdapter.installHooks(ctx);
    pluginPath = openclawAdapter.getHookConfigPath(ctx);
    expect(existsSync(pluginPath)).toBe(true);
  });

  /** Import the freshly-written generated module (cache-busted per test). */
  async function loadPlugin(): Promise<any> {
    const url = `${pathToFileURL(pluginPath).href}?t=${Date.now()}-${Math.random()}`;
    return import(/* @vite-ignore */ url);
  }

  // WIRE-CONTRACT REGRESSION. The native subagent_spawned event (openclaw/openclaw
  // src/plugins/hook-types.ts:720-806 + wired-hooks-subagent.test.ts:73-81) carries
  // `agentId` (real identity) + an OPTIONAL human `label`, and NOTHING named
  // subagentId/subagentType/agent/agentType. So the bridge must read e.agentId +
  // e.label — feeding the OLD false-friend fields must NOT populate the payload.
  it("subagent_spawned reads the REAL native fields (agentId + label); false-friend fields do NOT resurface", async () => {
    execFileSyncImpl = () => JSON.stringify({ decision: "context", additionalContext: "x" });

    const mod = await loadPlugin();
    const api = fakeApi();
    mod.default.register(api);
    expect(typeof api.handlers["subagent_spawned"]).toBe("function");
    expect(typeof api.handlers["subagent_ended"]).toBe("function");

    const result = await api.handlers["subagent_spawned"]!({
      // Real host event shape (hook-types.ts PluginHookSubagentSpawnedEvent).
      agentId: "main",
      label: "research",
      // Fields the host NEVER emits — must be ignored, never mapped.
      subagentId: "ghost",
      subagentType: "ghost-type",
      agentType: "ghost-type",
      agent: "ghost-agent",
    });
    // Observe-only: the bridge reply is ignored, the handler never blocks.
    expect(result).toBeUndefined();

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [bin, argv, opts] = execFileSyncMock.mock.calls[0]!;
    expect(bin).toBe(HOME_BIN);
    expect(argv).toEqual(["hook", "openclaw", "SubagentStart", "--connector", CONNECTOR_ID]);
    const payload = JSON.parse(opts.input);
    // Real identity comes from e.agentId; the type slot from the real e.label.
    expect(payload.agentId).toBe("main");
    expect(payload.agentType).toBe("research");
    // The false-friend native values never leaked into the bridge payload.
    expect(payload.agentId).not.toBe("ghost");
    expect(payload.agentType).not.toBe("ghost-type");
  });

  // WIRE-CONTRACT REGRESSION — the spec's confirmed bug. The native subagent_ended
  // event (openclaw/openclaw src/plugins/hook-types.ts:808-818 +
  // wired-hooks-subagent.test.ts:118-126) has its ONLY identity in
  // `targetSessionKey` — NO agentId/subagentId, NO agentType/subagentType/agent,
  // and NO result/output. So the bridge must read e.targetSessionKey for agentId,
  // and must NOT post agentType / lastAssistantMessage (the host never sends them).
  it("subagent_ended reads e.targetSessionKey as agentId; the removed result/agentType reads do NOT resurface", async () => {
    const mod = await loadPlugin();
    const api = fakeApi();
    mod.default.register(api);

    const result = await api.handlers["subagent_ended"]!({
      // Real host event shape (hook-types.ts PluginHookSubagentEndedEvent).
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      reason: "subagent-complete",
      outcome: "ok",
      // Fields the host NEVER emits — must be ignored, never mapped.
      agentId: "ghost",
      subagentId: "ghost",
      agentType: "ghost-type",
      subagentType: "ghost-type",
      result: "ghost result",
      output: "ghost output",
    });
    expect(result).toBeUndefined();

    const [, argv, opts] = execFileSyncMock.mock.calls[0]!;
    expect(argv).toEqual(["hook", "openclaw", "SubagentStop", "--connector", CONNECTOR_ID]);
    const payload = JSON.parse(opts.input);
    // The real identity is targetSessionKey (NOT the false-friend agentId/subagentId).
    expect(payload.agentId).toBe("agent:main:subagent:child");
    expect(payload.agentId).not.toBe("ghost");
    // The host emits no type and no message on subagent_ended: those keys are gone.
    expect("agentType" in payload).toBe(false);
    expect("lastAssistantMessage" in payload).toBe(false);
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

  it("subagent_ended with ONLY targetSessionKey posts agentId and nothing invented", async () => {
    const mod = await loadPlugin();
    const api = fakeApi();
    mod.default.register(api);

    await api.handlers["subagent_ended"]!({
      targetSessionKey: "agent:main:subagent:solo",
    });

    const [, , opts] = execFileSyncMock.mock.calls[0]!;
    const payload = JSON.parse(opts.input);
    expect(payload.agentId).toBe("agent:main:subagent:solo");
    expect("agentType" in payload).toBe(false);
    expect("lastAssistantMessage" in payload).toBe(false);
  });
});

describe("openclaw — extended-event parse + reply", () => {
  // parseEvent reads OUR generated bridge payload (OpenClawBridgePayload), NOT the
  // host-native event — so input.agentId is correct BY CONSTRUCTION (the bridge
  // already projected the host's real field into agentId). This asserts the
  // straight-through map + the empty-string drop.
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
// UserPromptSubmit (before_prompt_build) + supportsNativeHooks
//
// OpenClaw's before_prompt_build fires PER TURN and can ONLY inject context — it
// has NO blocking ability. ONE before_prompt_build handler COEXISTS for BOTH
// SessionStart (inject ONCE) AND UserPromptSubmit (inject EVERY turn).
// ─────────────────────────────────────────────────────────────────────────

describe("openclaw adapter — userPromptSubmit + supportsNativeHooks capabilities", () => {
  it("declares userPromptSubmit && supportsNativeHooks", () => {
    expect(openclawAdapter.capabilities.userPromptSubmit).toBe(true);
    expect(openclawAdapter.capabilities.supportsNativeHooks).toBe(true);
  });
});

describe("openclaw adapter — UserPromptSubmit maps to before_prompt_build", () => {
  it("a UserPromptSubmit-only connector emits a before_prompt_build handler bridging UserPromptSubmit", () => {
    const projectDir = freshProject("ac-openclaw-ups-");
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
    const projectDir = freshProject("ac-openclaw-ups-");
    const ctx = buildCtx(projectDir, connectorPromptOnly());
    const changes = openclawAdapter.installHooks(ctx);
    const moduleChange = changes.find((c) => c.path?.endsWith("index.mjs"));
    expect(moduleChange?.detail).toContain("UserPromptSubmit");
    expect(moduleChange?.detail).not.toContain("unsupported here");
  });
});

describe("openclaw adapter — before_prompt_build COEXISTENCE (SessionStart once + UserPromptSubmit per-turn)", () => {
  it("THE BRIDGE WORKS — SessionStart context injects ONCE, UserPromptSubmit context EVERY turn", async () => {
    const projectDir = freshProject("ac-openclaw-ups-");
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
      UPS_CONNECTOR_ID,
    ]);
    expect(JSON.parse(upsCalls[0]![2].input).prompt).toBe("first turn");
    expect(JSON.parse(upsCalls[1]![2].input).prompt).toBe("second turn");
  });

  it("a UserPromptSubmit deny/block decision DEGRADES to a no-op (before_prompt_build cannot block)", async () => {
    const projectDir = freshProject("ac-openclaw-ups-");
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

describe("openclaw adapter — nativeHooks passthrough", () => {
  it("a nativeHooks event registers an on(...) bridge in the generated plugin", () => {
    const projectDir = freshProject("ac-openclaw-ups-");
    const ctx = buildCtx(projectDir, connectorNative("openclaw", false));
    openclawAdapter.installHooks(ctx);
    const src = readFileSync(openclawAdapter.getHookConfigPath(ctx), "utf8");
    expect(src).toContain('on("agent_turn"');
    expect(src).toContain('bridge("agent_turn"');
  });

  it("nativeHooks SURVIVE hooks:false while canonical handlers are suppressed", () => {
    const projectDir = freshProject("ac-openclaw-ups-");
    const ctx = buildCtx(projectDir, connectorNative("openclaw", true));
    openclawAdapter.installHooks(ctx);
    const src = readFileSync(openclawAdapter.getHookConfigPath(ctx), "utf8");
    // Native passthrough was written despite hooks:false.
    expect(src).toContain('on("agent_turn"');
    // Canonical handlers suppressed by the canonicalOff guard.
    expect(src).not.toContain('on("before_tool_call"');
  });
});

describe("openclaw adapter — parseEvent(UserPromptSubmit)", () => {
  it("normalizes the bridge payload to a prompt-carrying event", () => {
    const evt = openclawAdapter.parseEvent("UserPromptSubmit", {
      prompt: "do the thing",
      sessionId: "uc-9",
      projectDir: "/some/proj",
    });
    expect(evt).toMatchObject({
      hostPlatform: "openclaw",
      prompt: "do the thing",
      sessionId: "uc-9",
      projectDir: "/some/proj",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// hooks:false must NOT leak canonical handlers via installActions
//
// The generated module is synthesized by BOTH installHooks AND installActions (a
// connector with actions but hooks:false still writes the module — for the
// actions). buildPluginSource must honor `platforms[host].hooks === false` and
// emit NO canonical before_tool_call/after_tool_call handler.
// ─────────────────────────────────────────────────────────────────────────

describe("openclaw adapter — hooks:false does not leak canonical handlers via installActions", () => {
  it("installActions writes the plugin for the action but OMITS the canonical before_tool_call handler under hooks:false", () => {
    const projectDir = freshProject("ac-openclaw-leak-");
    const ctx = buildCtx(projectDir, leakConnector(true));
    openclawAdapter.installActions!(ctx);
    const src = readFileSync(openclawAdapter.getHookConfigPath!(ctx), "utf8");
    // Canonical handlers register via on("<native_event>", …) — MUST be
    // suppressed by hooks:false (omitted from the generated source entirely).
    expect(src).not.toContain('on("before_tool_call"');
    expect(src).not.toContain('on("after_tool_call"');
    // The plugin WAS written (for the action) — registerCommand present.
    expect(src).toContain("reindex");
  });

  it("CONTROL: with hooks enabled, the same connector DOES emit the canonical before_tool_call handler", () => {
    const projectDir = freshProject("ac-openclaw-leak-");
    const ctx = buildCtx(projectDir, leakConnector(false));
    openclawAdapter.installActions!(ctx);
    const src = readFileSync(openclawAdapter.getHookConfigPath!(ctx), "utf8");
    expect(src).toContain('on("before_tool_call"');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Action surface — slash commands embedded in the SHARED plugin module.
//
// The action trigger is a registerCommand INSIDE the generated plugin
// (api.registerCommand), NOT a standalone file.
// ─────────────────────────────────────────────────────────────────────────

describe("openclaw adapter — action surface (slash commands in the shared plugin)", () => {
  let projectDir: string;
  let ctx: InstallContext;
  let configPath: string;

  beforeEach(() => {
    projectDir = freshProject("ac-w4-oc-act-");
    ctx = buildCtx(projectDir, actionsOnlyConnector());
    configPath = join(projectDir, "openclaw.json");
  });

  it("advertises supportsActions", () => {
    expect(openclawAdapter.capabilities.supportsActions).toBe(true);
  });

  it("installActions writes the plugin (api.registerCommand `action openclaw <id>`) + the dual-registration entry, NO hook handlers", () => {
    const changes = openclawAdapter.installActions!(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);
    expect(changes.every((c) => c.platform === "openclaw")).toBe(true);

    const pluginPath = openclawAdapter.getHookConfigPath(ctx);
    expect(existsSync(pluginPath)).toBe(true);
    const src = readFileSync(pluginPath, "utf8");

    expect(src).toContain("api.registerCommand(");
    expect(src).toContain('["action", "openclaw", "reindex", "--connector", CONNECTOR_ID]');
    expect(src).toContain('["action", "openclaw", "purge", "--connector", CONNECTOR_ID]');
    // Actions-only → NO hook handler is wired in register(api).
    expect(src).not.toContain('on("before_tool_call"');
    expect(src).not.toContain('on("session_start"');
    expect(src).toContain("register(api)");

    // plugins.load.paths + plugins.entries half (a) is written even for actions.
    const cfg = readJson(configPath);
    expect(cfg.plugins?.entries?.[CONNECTOR_ID]?.enabled).toBe(true);
    const pluginDir = join(projectDir, ".openclaw", "extensions", CONNECTOR_ID);
    expect(cfg.plugins.load.paths).toContain(pluginDir);
  });

  it("JSON-escapes a description containing a double-quote (the module still parses)", async () => {
    openclawAdapter.installActions!(ctx);
    const pluginPath = openclawAdapter.getHookConfigPath(ctx);
    const src = readFileSync(pluginPath, "utf8");
    expect(src).toContain('description: "Purge the \\"stale\\" cache."');
    const mod = await import(`${pathToFileURL(pluginPath).href}?ocesc=${Date.now()}`);
    expect(typeof mod.default).toBe("object");
    expect(typeof mod.default.register).toBe("function");
  });

  it("the registerCommand handler shells out to the home bin and returns its trimmed text (live, mocked)", async () => {
    openclawAdapter.installActions!(ctx);
    const pluginPath = openclawAdapter.getHookConfigPath(ctx);
    const mod = await import(`${pathToFileURL(pluginPath).href}?ocrun=${Date.now()}`);

    const registered: Record<string, any> = {};
    mod.default.register({
      registerCommand: (def: any) => { registered[def.name] = def; },
    });
    expect(Object.keys(registered).sort()).toEqual(["purge", "reindex"]);

    execFileSyncImpl = () => "  reindexed 42 docs  \n";
    const res = await registered.reindex.handler({});
    expect(res).toEqual({ text: "reindexed 42 docs" });
    const call = execFileSyncMock.mock.calls.at(-1)!;
    expect(call[0]).toBe(HOME_BIN);
    expect(call[1]).toEqual(["action", "openclaw", "reindex", "--connector", CONNECTOR_ID]);
  });

  it("installActions is idempotent — a second call yields skip for every change", () => {
    openclawAdapter.installActions!(ctx);
    const second = openclawAdapter.installActions!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallActions is an informational skip; uninstallHooks removes the shared plugin + entry", () => {
    openclawAdapter.installActions!(ctx);
    const changes = openclawAdapter.uninstallActions!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toContain("removed by uninstallHooks");
    expect(existsSync(openclawAdapter.getHookConfigPath(ctx))).toBe(true);

    openclawAdapter.uninstallHooks(ctx);
    expect(existsSync(openclawAdapter.getHookConfigPath(ctx))).toBe(false);
    const cfg = readJson(configPath);
    expect(cfg.plugins?.entries?.[CONNECTOR_ID]).toBeUndefined();
    const pluginDir = join(projectDir, ".openclaw", "extensions", CONNECTOR_ID);
    expect(cfg.plugins?.load?.paths ?? []).not.toContain(pluginDir);
  });

  it("honors platforms.openclaw.actions === false (opt-out, never writes)", () => {
    const ctxOff = buildCtx(
      projectDir,
      defineConnector({
        id: CONNECTOR_ID,
        actions: [{ id: "reindex", run: () => undefined }],
        platforms: { openclaw: { actions: false } },
      }),
    );
    const changes = openclawAdapter.installActions!(ctxOff);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toContain("disabled for openclaw");
    expect(existsSync(openclawAdapter.getHookConfigPath(ctxOff))).toBe(false);
  });

  it("hooks+actions install writes the plugin ONCE — the second surface skips (no double write)", () => {
    const ctxBoth = buildCtx(projectDir, hooksAndActionsConnector());
    const hookChanges = openclawAdapter.installHooks(ctxBoth);
    expect(hookChanges.some((c) => c.action === "create")).toBe(true);
    const actionChanges = openclawAdapter.installActions!(ctxBoth);
    expect(actionChanges.every((c) => c.action === "skip")).toBe(true);
    const src = readFileSync(openclawAdapter.getHookConfigPath(ctxBoth), "utf8");
    expect(src).toContain('on("before_tool_call"');
    expect(src).toContain("api.registerCommand(");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// regression — shared parseJsonc tolerance + dual registration
//
// parseJsonc tolerates a // comment AND an in-string comma-before-bracket
// without corruption (the exact pattern the old regex-based stripJsonish
// corrupted); dual registration still works.
// ─────────────────────────────────────────────────────────────────────────

describe("openclaw shared parseJsonc tolerance + dual registration", () => {
  it("tolerates a // comment AND an in-string comma-before-bracket without corruption", () => {
    const projectDir = freshProject("ac-rf-openclaw-");
    const ctx = buildCtx(projectDir, buildConnector());
    const configPath = openclawAdapter.getServerConfigPath(ctx);

    // A // comment, a trailing comma, AND a string value containing ",]" — the
    // exact pattern the old regex-based stripJsonish corrupted.
    writeFileSync(
      configPath,
      `{
        // openclaw user config
        "displayName": "list a,] literal",
        "mcp": { "servers": { "user-owned": { "command": "/bin/echo" } } },
      }`,
      "utf8",
    );

    const serverChanges = openclawAdapter.installServer(ctx);
    expect(serverChanges[0]?.action).not.toBe("warn");

    const cfg = readJson(configPath);
    // The in-string ",]" survived verbatim (no corruption).
    expect(cfg.displayName).toBe("list a,] literal");
    // The user's own server survived.
    expect(cfg.mcp.servers["user-owned"]).toBeTruthy();
    // Our nested server entry was added.
    expect(cfg.mcp.servers[CONNECTOR_ID]).toBeTruthy();
  });

  it("dual registration still works (plugins.entries + mcp.servers both written)", () => {
    const projectDir = freshProject("ac-rf-openclaw2-");
    const ctx = buildCtx(projectDir, buildConnector());
    const configPath = openclawAdapter.getServerConfigPath(ctx);

    openclawAdapter.installServer(ctx);
    openclawAdapter.installHooks(ctx);

    const cfg = readJson(configPath);
    expect(cfg.mcp.servers[CONNECTOR_ID]).toBeTruthy();
    expect(cfg.plugins.entries[CONNECTOR_ID]).toBeTruthy();

    // Doctor agrees the dual registration is consistent.
    const dual = openclawAdapter
      .getHealthChecks!(ctx)
      .find((c) => c.name.includes("dual registration"))!
      .check();
    expect(dual.status).toBe("OK");
  });
});
