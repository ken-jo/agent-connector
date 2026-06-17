/**
 * adapters/wave4 — render + ts-plugin bridge tests for the OMP (Oh My Pi)
 * ts-plugin adapter.
 *
 * OMP is a `ts-plugin` host that — exactly like the reference OpenCode adapter —
 * SYNTHESIZES a self-contained ESM module that imports nothing from
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
 *     • action surface — slash commands embedded in the shared plugin module.
 *
 * (OpenClaw, the other former Wave-4 ts-plugin host, now lives in its own per-host
 * file adapters/openclaw.test.ts per tests/README.md.)
 *
 * The node:child_process mock MUST be in place before the generated module is
 * imported. vi.mock is hoisted to the top of the file, and the generated module
 * is imported lazily (dynamic import) AFTER it has been written — so the mock is
 * already registered when node:child_process is resolved by the module runner.
 *
 * Filesystem isolation: every test gets a fresh os.tmpdir mkdtemp project dir, and
 * HOME + AGENT_CONNECTOR_DATA_DIR are redirected there and restored in afterEach so
 * nothing escapes the sandbox. We use PROJECT scope throughout for deterministic
 * paths (the user-scope OMP root resolves from env vars we also pin).
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { HookResponse, ResolvedConnector } from "../../src/core/types.js";

import ompAdapter from "../../src/adapters/omp/index.js";

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

// The generated bridge uses execFileSync on POSIX and execSync on Windows (a .cmd
// launcher needs a shell). Route BOTH to the same mock so the bridge tests pass
// on either platform.
vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  execSync: execFileSyncMock,
}));

// Pin process.platform to a POSIX value for the whole file so the generated
// bridge takes its execFileSync(HOME_BIN, [args]) path (on Windows it would use
// execSync(one quoted string) — correct in production, proven separately, but it
// would not match these bridges' execFileSync(bin, argv) call-shape assertions).
// node:path is already bound at import and os.homedir() is native, so neither is
// affected by this string override.
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
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";

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
let savedPiAgentDir: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
  savedEnvVar = process.env[ENV_VAR];
  savedPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  execFileSyncMock.mockClear();
  execFileSyncImpl = () => "";
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
  restore(ENV_VAR, savedEnvVar);
  restore("PI_CODING_AGENT_DIR", savedPiAgentDir);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/**
 * Fresh temp project dir + redirect HOME/data-root there so nothing escapes.
 * Also pins the env vars OMP consults for its user-scope root so a stray env on
 * the host machine can never leak into a project-scoped test.
 */
function freshProject(prefix: string): string {
  // realpathSync.native expands the Windows 8.3 short tmpdir (C:\Users\RUNNER~1\…)
  // to its long form so the later pathToFileURL() import of the generated bridge
  // doesn't break on the "~" (round-trips as %7E and fails to load).
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  process.env[ENV_VAR] = ENV_LITERAL;
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
    expect(entry.args).toEqual(wrappedTail("omp"));
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
    expect(src).toContain('import { execFileSync, execSync } from "node:child_process"');
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
// Action surface — slash commands embedded in the SHARED plugin module.
//
// On omp the action trigger is a registerCommand INSIDE the generated plugin
// (pi.registerCommand), NOT a standalone file. These tests guard the load-bearing
// risks: the registerCommand block is present (and, for an actions-only
// connector, no hook handlers are); the `action <host>` token is host-correct
// (omp literal "omp"); a description containing a `"` is JSON-escaped so the
// module still PARSES; install writes the plugin and uninstall removes it; and a
// hooks+actions install writes the plugin exactly once (the second surface skips).
// ─────────────────────────────────────────────────────────────────────────

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

describe("omp adapter — action surface (slash commands in the shared plugin)", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-w4-omp-act-");
    ctx = buildCtx(projectDir, actionsOnlyConnector());
  });

  it("advertises supportsActions", () => {
    expect(ompAdapter.capabilities.supportsActions).toBe(true);
  });

  it("installActions writes the plugin whose source embeds pi.registerCommand running `action omp <id>` and NO hook handlers", () => {
    const changes = ompAdapter.installActions!(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);
    expect(changes.every((c) => c.platform === "omp")).toBe(true);

    const entryPath = ompAdapter.getHookConfigPath(ctx);
    expect(existsSync(entryPath)).toBe(true);
    const src = readFileSync(entryPath, "utf8");

    // The registerCommand block, host token literal "omp", both action ids.
    expect(src).toContain("pi.registerCommand(");
    expect(src).toContain('["action", "omp", "reindex", "--connector", CONNECTOR_ID]');
    expect(src).toContain('["action", "omp", "purge", "--connector", CONNECTOR_ID]');
    // Actions-only → NO hook handler is wired into the factory.
    expect(src).not.toContain('pi.on("tool_call"');
    expect(src).not.toContain('pi.on("session_start"');
    // The factory is still a valid module with the default export.
    expect(src).toContain("export default function");
  });

  it("JSON-escapes a description containing a double-quote (the module still parses)", async () => {
    ompAdapter.installActions!(ctx);
    const entryPath = ompAdapter.getHookConfigPath(ctx);
    const src = readFileSync(entryPath, "utf8");
    // The raw quote is escaped, never emitted bare.
    expect(src).toContain('description: "Purge the \\"stale\\" cache."');
    // The proof it parses: dynamically import the freshly-written module.
    const mod = await import(`${pathToFileURL(entryPath).href}?actesc=${Date.now()}`);
    expect(typeof mod.default).toBe("function");
  });

  it("the registerCommand handler shells out to the home bin (live, child_process mocked)", async () => {
    ompAdapter.installActions!(ctx);
    const entryPath = ompAdapter.getHookConfigPath(ctx);
    const mod = await import(`${pathToFileURL(entryPath).href}?actrun=${Date.now()}`);

    // Capture the registered commands by passing a fake `pi`.
    const registered: Record<string, any> = {};
    mod.default({ registerCommand: (name: string, def: any) => { registered[name] = def; } });
    expect(Object.keys(registered).sort()).toEqual(["purge", "reindex"]);

    execFileSyncImpl = () => "";
    await registered.reindex.handler({}, {});
    const call = execFileSyncMock.mock.calls.at(-1)!;
    expect(call[0]).toBe(HOME_BIN);
    expect(call[1]).toEqual(["action", "omp", "reindex", "--connector", CONNECTOR_ID]);
  });

  it("installActions is idempotent — a second call yields skip for every file", () => {
    ompAdapter.installActions!(ctx);
    const second = ompAdapter.installActions!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallActions is an informational skip (the plugin is removed by uninstallHooks)", () => {
    ompAdapter.installActions!(ctx);
    const changes = ompAdapter.uninstallActions!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toContain("removed by uninstallHooks");
    // The plugin file is NOT touched by uninstallActions.
    expect(existsSync(ompAdapter.getHookConfigPath(ctx))).toBe(true);
    // uninstallHooks is the SOLE teardown — it removes the shared module.
    ompAdapter.uninstallHooks(ctx);
    expect(existsSync(ompAdapter.getHookConfigPath(ctx))).toBe(false);
  });

  it("honors platforms.omp.actions === false (opt-out, never writes)", () => {
    const ctxOff = buildCtx(
      projectDir,
      defineConnector({
        id: CONNECTOR_ID,
        actions: [{ id: "reindex", run: () => undefined }],
        platforms: { omp: { actions: false } },
      }),
    );
    const changes = ompAdapter.installActions!(ctxOff);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toContain("disabled for omp");
    expect(existsSync(ompAdapter.getHookConfigPath(ctxOff))).toBe(false);
  });

  it("installHooks on an actions-only connector skips honestly (plugin written for actions)", () => {
    const changes = ompAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toContain("plugin written for actions");
  });

  it("hooks+actions install writes the plugin ONCE — the second surface skips (no double write)", () => {
    const ctxBoth = buildCtx(projectDir, hooksAndActionsConnector());
    const hookChanges = ompAdapter.installHooks(ctxBoth);
    expect(hookChanges.some((c) => c.action === "create")).toBe(true);
    // The action surface ensures the SAME plugin — byte-identical → all skips.
    const actionChanges = ompAdapter.installActions!(ctxBoth);
    expect(actionChanges.every((c) => c.action === "skip")).toBe(true);
    // The generated module carries BOTH the hook handler AND the action command.
    const src = readFileSync(ompAdapter.getHookConfigPath(ctxBoth), "utf8");
    expect(src).toContain('pi.on("tool_call"');
    expect(src).toContain("pi.registerCommand(");
  });

  it("getHealthChecks for an actions-only connector asserts the extension package is present", () => {
    ompAdapter.installActions!(ctx);
    const ext = ompAdapter
      .getHealthChecks!(ctx)
      .find((c) => /extension package present/.test(c.name))!;
    expect(ext.check().status).toBe("OK");
  });
});
