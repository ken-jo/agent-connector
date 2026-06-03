/**
 * adapters/wave4 — render + ts-plugin bridge tests for the two Wave-4 ts-plugin
 * adapters: OMP (Oh My Pi) and OpenClaw (Gateway).
 *
 * Both are `ts-plugin` hosts that — exactly like the reference OpenCode adapter —
 * SYNTHESIZE a self-contained ESM module that imports nothing from
 * agent-connector and, on each in-process hook firing, shells out to the ONE
 * stable home binary's universal entrypoint
 *     <homeBin> hook <platformId> <event> --connector <id>
 * over child_process, feeds the host-shaped payload on stdin, and JSON.parses the
 * normalized HookResponse back from stdout (fail-open). These tests exercise that
 * bridge LIVE — the generated module is dynamically imported with
 * node:child_process mocked — plus the render surfaces against REAL files on disk.
 *
 *   OMP (native MCP + extension package):
 *     • installServer  → <projectDir>/.omp/mcp.json, ROOT KEY "mcpServers", a
 *       portable stdio entry { command, args, env } whose command IS the home bin
 *       (telemetry serve-wrapper). idempotency + uninstall.
 *     • installHooks   → an extension PACKAGE: package.json manifest (carrying the
 *       `omp.extensions` field) + index.js plugin module. The generated index.js
 *       default-exports the OMP HookFactory `(pi) => void` and contains the
 *       execFileSync bridge to the home bin + connector id.
 *     • THE BRIDGE WORKS — import the generated module, call the factory with a
 *       fake `pi`, fire the registered pi.on("tool_call") handler; a "deny"
 *       returns OMP's native { block:true, reason }. parseEvent/formatReply
 *       round-trip a PreToolUse deny.
 *
 *   OpenClaw (DUAL REGISTRATION ts-plugin, JSON5 config):
 *     • installServer  → <projectDir>/openclaw.json, NESTED mcp.servers.<id>.
 *     • installHooks   → writes the plugin module (index.mjs) AND adds the
 *       plugins.entries.<id> reference — BOTH halves of the dual registration must
 *       be present.
 *     • getHealthChecks FAILS when the two registrations are inconsistent: an
 *       entries-only config (mcp.servers removed) → health FAIL.
 *     • uninstall removes BOTH halves + the module on disk.
 *     • TOLERANT PARSE — install still works against an openclaw.json that carries
 *       a // comment (JSON5/JSONC), proving the adapter never strict-JSON.parses.
 *     • THE BRIDGE WORKS — import the generated module, call register(api) with a
 *       fake api, fire the before_tool_call handler; a "deny" returns OpenClaw's
 *       native { block:true, blockReason }. parseEvent/formatReply round-trip.
 *
 * The node:child_process mock MUST be in place before the generated module is
 * imported. vi.mock is hoisted to the top of the file, and the generated module
 * is imported lazily (dynamic import) AFTER it has been written — so the mock is
 * already registered when node:child_process is resolved by the module runner.
 *
 * Filesystem isolation: every test gets a fresh os.tmpdir mkdtemp project dir, and
 * HOME + AGENT_CONNECTOR_DATA_DIR are redirected there and restored in afterEach so
 * nothing escapes the sandbox. We use PROJECT scope throughout for deterministic
 * paths (the user-scope OMP/OpenClaw roots resolve from env vars we also pin).
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDir } from "../../src/core/paths.js";
import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { HookResponse, ResolvedConnector } from "../../src/core/types.js";

import ompAdapter from "../../src/adapters/omp/index.js";
import openclawAdapter from "../../src/adapters/openclaw/index.js";

// ─────────────────────────────────────────────────────────────────────────
// node:child_process mock — hoisted above every import by vitest.
//
// Both generated plugins import `execFileSync` from node:child_process at
// top-level. Each test reprograms what the mocked execFileSync returns via
// `execFileSyncImpl`, then dynamically imports the freshly-written module so the
// bridge calls into this mock.
// ─────────────────────────────────────────────────────────────────────────

let execFileSyncImpl: (...args: any[]) => string = () => "";
const execFileSyncMock = vi.fn((...args: any[]) => execFileSyncImpl(...args));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";

const WRAPPED_TAIL = ["serve", "--connector", CONNECTOR_ID, "--scope", "project", "--", "npx", "-y", "@x/y"];

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

/** Build an InstallContext scoped to a fresh temp project dir. */
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

// Track + restore mutated env so the suite never leaks state.
let savedHome: string | undefined;
let savedDataDir: string | undefined;
let savedEnvVar: string | undefined;
let savedOpenClawConfig: string | undefined;
let savedOpenClawState: string | undefined;
let savedPiAgentDir: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
  savedEnvVar = process.env[ENV_VAR];
  savedOpenClawConfig = process.env.OPENCLAW_CONFIG_PATH;
  savedOpenClawState = process.env.OPENCLAW_STATE_DIR;
  savedPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  execFileSyncMock.mockClear();
  execFileSyncImpl = () => "";
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
  restore(ENV_VAR, savedEnvVar);
  restore("OPENCLAW_CONFIG_PATH", savedOpenClawConfig);
  restore("OPENCLAW_STATE_DIR", savedOpenClawState);
  restore("PI_CODING_AGENT_DIR", savedPiAgentDir);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/**
 * Fresh temp project dir + redirect HOME/data-root there so nothing escapes.
 * Also pins the env vars OMP / OpenClaw consult for user-scope roots so a stray
 * env on the host machine can never leak into a project-scoped test.
 */
function freshProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.HOME = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  process.env[ENV_VAR] = ENV_LITERAL;
  delete process.env.OPENCLAW_CONFIG_PATH;
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  return dir;
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ─────────────────────────────────────────────────────────────────────────
// OMP (ts-plugin extension package + native MCP) — render
// ─────────────────────────────────────────────────────────────────────────

describe("omp adapter (ts-plugin) render", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-w4-omp-");
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("installServer writes a real mcp.json with ROOT KEY 'mcpServers' and a portable stdio entry at the home bin", () => {
    const changes = ompAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".omp", "mcp.json");
    expect(serverPath).toBe(ompAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    // New-gen root key is "mcpServers".
    expect(cfg).toHaveProperty("mcpServers");
    expect(cfg).not.toHaveProperty("mcp");

    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    // OMP uses the PORTABLE field names: command (string) + args (array) + env.
    expect(entry.command).toBe(HOME_BIN);
    expect(Array.isArray(entry.args)).toBe(true);
    expect(entry.args).toEqual(WRAPPED_TAIL);
    expect(entry.args).toContain("serve");
    expect(entry.args).toContain("--connector");
    expect(entry.args).toContain(CONNECTOR_ID);

    // No native interpolation token → env resolves to a LITERAL value.
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    ompAdapter.installServer(ctx);
    const second = ompAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".omp", "mcp.json"));
    expect(Object.keys(cfg.mcpServers)).toEqual([CONNECTOR_ID]);
  });

  it("uninstallServer removes the entry (re-read confirms gone)", () => {
    ompAdapter.installServer(ctx);
    ompAdapter.uninstallServer(ctx);

    const cfg = readJson(join(projectDir, ".omp", "mcp.json"));
    expect(cfg.mcpServers?.[CONNECTOR_ID]).toBeUndefined();
  });

  it("installHooks writes the extension package (package.json manifest + index.js plugin module) containing the execFileSync bridge to the home bin + connector id", () => {
    const changes = ompAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const extDir = join(projectDir, ".omp", "extensions", CONNECTOR_ID);
    const manifestPath = join(extDir, "package.json");
    const entryPath = join(extDir, "index.js");
    expect(entryPath).toBe(ompAdapter.getHookConfigPath(ctx));
    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(entryPath)).toBe(true);

    // The manifest carries the `omp` field OMP's loader reads (pluginPkg.omp).
    const manifest = readJson(manifestPath);
    expect(manifest.type).toBe("module");
    expect(manifest.main).toBe("index.js");
    expect(manifest.omp?.extensions).toEqual(["./index.js"]);

    // The generated module is the self-contained bridge: it imports NOTHING from
    // agent-connector (the only allowed import is node:child_process). The string
    // "agent-connector" may appear in the AUTO-GENERATED header comment — what
    // must be absent is an actual import/require of the package.
    const src = readFileSync(entryPath, "utf8");
    expect(src).not.toMatch(/from\s+["'][^"']*agent-connector/);
    expect(src).not.toMatch(/require\(\s*["'][^"']*agent-connector/);
    expect(src).toContain('import { execFileSync } from "node:child_process"');
    expect(src).toContain("execFileSync");
    expect(src).toContain('"hook"');
    expect(src).toContain('"omp"');
    expect(src).toContain("--connector");
    expect(src).toContain(CONNECTOR_ID);
    expect(src).toContain(HOME_BIN);
    // The OMP HookFactory shape + the tool_call event subscription.
    expect(src).toContain("export default function");
    expect(src).toContain('pi.on("tool_call"');
  });

  it("installHooks is idempotent — second call yields skip for every file", () => {
    ompAdapter.installHooks(ctx);
    const second = ompAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallHooks removes BOTH the manifest and the plugin module (re-read confirms gone)", () => {
    ompAdapter.installHooks(ctx);
    const extDir = join(projectDir, ".omp", "extensions", CONNECTOR_ID);
    const manifestPath = join(extDir, "package.json");
    const entryPath = join(extDir, "index.js");
    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(entryPath)).toBe(true);

    ompAdapter.uninstallHooks(ctx);
    expect(existsSync(manifestPath)).toBe(false);
    expect(existsSync(entryPath)).toBe(false);
  });
});

describe("omp generated plugin — THE BRIDGE WORKS (live, child_process mocked)", () => {
  let projectDir: string;
  let ctx: InstallContext;
  let entryPath: string;

  beforeEach(() => {
    projectDir = freshProject("ac-w4-omp-bridge-");
    ctx = buildCtx(projectDir, buildConnector());
    ompAdapter.installHooks(ctx);
    entryPath = ompAdapter.getHookConfigPath(ctx);
    expect(existsSync(entryPath)).toBe(true);
  });

  /** Import the freshly-written generated module (cache-busted per test). */
  async function loadPlugin(): Promise<any> {
    const url = `${pathToFileURL(entryPath).href}?t=${Date.now()}-${Math.random()}`;
    return import(/* @vite-ignore */ url);
  }

  /** Build a fake `pi` that records every pi.on(event, handler) registration. */
  function fakePi(): { on: (e: string, h: (...a: any[]) => any) => void; handlers: Record<string, (...a: any[]) => any> } {
    const handlers: Record<string, (...a: any[]) => any> = {};
    return {
      handlers,
      on(event: string, handler: (...a: any[]) => any) {
        handlers[event] = handler;
      },
    };
  }

  it("default export is the OMP HookFactory; calling it registers a pi.on('tool_call') handler", async () => {
    const mod = await loadPlugin();
    expect(typeof mod.default).toBe("function");

    const pi = fakePi();
    mod.default(pi);
    expect(typeof pi.handlers["tool_call"]).toBe("function");
  });

  it("a 'deny' decision from the bridge returns OMP's native { block:true, reason }", async () => {
    execFileSyncImpl = () => JSON.stringify({ decision: "deny", reason: "nope" });

    const mod = await loadPlugin();
    const pi = fakePi();
    mod.default(pi);

    const result = pi.handlers["tool_call"]!({
      toolName: "acme_write",
      input: { sql: "DELETE" },
    });

    expect(result).toEqual({ block: true, reason: "nope" });

    // The bridge actually shelled out to the universal entrypoint with our argv.
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [bin, argv] = execFileSyncMock.mock.calls[0]!;
    expect(bin).toBe(HOME_BIN);
    expect(argv).toEqual([
      "hook",
      "omp",
      "PreToolUse",
      "--connector",
      CONNECTOR_ID,
    ]);
  });

  it("an 'allow' (or empty) decision does not block", async () => {
    execFileSyncImpl = () => JSON.stringify({ decision: "allow" });

    const mod = await loadPlugin();
    const pi = fakePi();
    mod.default(pi);

    const result = pi.handlers["tool_call"]!({ toolName: "acme_query", input: {} });
    expect(result).toBeUndefined();
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it("a bridge error fails OPEN — the tool_call handler swallows it and does not block", async () => {
    execFileSyncImpl = () => {
      throw new Error("home bin missing");
    };

    const mod = await loadPlugin();
    const pi = fakePi();
    mod.default(pi);

    const result = pi.handlers["tool_call"]!({ toolName: "acme_query", input: {} });
    // Fail-open: a bridge exception degrades to a no-op (no block).
    expect(result).toBeUndefined();
  });
});

describe("omp adapter runtime dispatch — parseEvent + formatReply round-trip", () => {
  it("formatReply returns exit 0 and stdout that JSON-parses to the normalized response", () => {
    const deny: HookResponse = { decision: "deny", reason: "x" };
    const reply = ompAdapter.formatReply!("PreToolUse", deny);

    expect(reply.exitCode).toBe(0);
    // OUR generated bridge consumes this directly — the reply body IS the
    // normalized HookResponse (the bridge JSON.parses it).
    const out = JSON.parse(reply.stdout!);
    expect(out).toEqual({ decision: "deny", reason: "x" });
  });

  it("parseEvent maps a sent bridge payload to a normalized PreToolUse event", () => {
    const evt = ompAdapter.parseEvent!("PreToolUse", {
      toolName: "acme_write",
      toolInput: { sql: "DELETE" },
      sessionId: "omp-1",
      projectDir: "/some/proj",
    });

    expect(evt).toMatchObject({
      hostPlatform: "omp",
      toolName: "acme_write",
      toolInput: { sql: "DELETE" },
      sessionId: "omp-1",
      projectDir: "/some/proj",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// OpenClaw (ts-plugin DUAL REGISTRATION, JSON5 config) — render
// ─────────────────────────────────────────────────────────────────────────

describe("openclaw adapter (ts-plugin) render + dual registration", () => {
  let projectDir: string;
  let ctx: InstallContext;
  let configPath: string;

  beforeEach(() => {
    projectDir = freshProject("ac-w4-oclaw-");
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
    expect(entry.transport).toBe("stdio");
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(WRAPPED_TAIL);
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
    // The entry points the gateway at the absolute module path.
    expect(cfg.plugins.entries[CONNECTOR_ID].module).toBe(pluginPath);

    // The generated module is the self-contained bridge: it imports NOTHING from
    // agent-connector (the only allowed import is node:child_process). The string
    // "agent-connector" may appear in the AUTO-GENERATED header comment — what
    // must be absent is an actual import/require of the package.
    const src = readFileSync(pluginPath, "utf8");
    expect(src).not.toMatch(/from\s+["'][^"']*agent-connector/);
    expect(src).not.toMatch(/require\(\s*["'][^"']*agent-connector/);
    expect(src).toContain('import { execFileSync } from "node:child_process"');
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

  it("uninstallHooks removes BOTH the plugins.entries reference AND the module on disk", () => {
    openclawAdapter.installServer(ctx);
    openclawAdapter.installHooks(ctx);

    const pluginPath = openclawAdapter.getHookConfigPath(ctx);
    expect(existsSync(pluginPath)).toBe(true);
    expect(readJson(configPath).plugins.entries[CONNECTOR_ID]).toBeTruthy();

    openclawAdapter.uninstallHooks(ctx);

    expect(existsSync(pluginPath)).toBe(false);
    const cfg = readJson(configPath);
    expect(cfg.plugins?.entries?.[CONNECTOR_ID]).toBeUndefined();
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

describe("openclaw generated plugin — THE BRIDGE WORKS (live, child_process mocked)", () => {
  let projectDir: string;
  let ctx: InstallContext;
  let pluginPath: string;

  beforeEach(() => {
    projectDir = freshProject("ac-w4-oclaw-bridge-");
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

  /** Build a fake `api` that records every api.on(event, handler) registration. */
  function fakeApi(): { on: (e: string, h: (...a: any[]) => any) => void; handlers: Record<string, (...a: any[]) => any> } {
    const handlers: Record<string, (...a: any[]) => any> = {};
    return {
      handlers,
      on(event: string, handler: (...a: any[]) => any) {
        handlers[event] = handler;
      },
    };
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
