/**
 * adapters/omp.test.ts — the ONE per-host file for Oh My Pi (OMP).
 *
 * OMP is a `ts-plugin` host with NATIVE MCP. Like the reference OpenCode adapter
 * it SYNTHESIZES a self-contained ESM extension module that imports nothing from
 * agent-connector and, on each in-process hook firing, shells out to the ONE
 * stable home binary's universal entrypoint
 *     <homeBin> hook omp <event> --connector <id>
 * over child_process, feeds the OMP-shaped payload on stdin, and JSON.parses the
 * normalized HookResponse back from stdout (fail-open). This file consolidates
 * EVERY omp surface (the per-host convention in tests/README.md — one file per
 * host):
 *   • MCP server   → <projectDir>/.omp/mcp.json, ROOT KEY "mcpServers"; a portable
 *                    stdio entry { command, args, env }; remote URL servers carry
 *                    the REQUIRED `type` discriminator (http/sse); an unadvertised
 *                    transport is WARNED, not silently downgraded.
 *   • hooks        → an extension PACKAGE (package.json manifest carrying the
 *                    `omp.extensions` field + index.js plugin module). The
 *                    generated index.js default-exports the OMP HookFactory
 *                    `(pi) => void` containing the execFileSync bridge; the BRIDGE
 *                    WORKS (deny → { block:true, reason }; fail-open).
 *   • nativeHooks  → OMP's main-loop events (agent_start/turn_end/…) have NO
 *                    canonical analog: declared via platforms.omp.nativeHooks, the
 *                    generated module registers pi.on(<native>) + bridge(<native>).
 *   • actions      → slash commands embedded in the SHARED plugin module
 *                    (pi.registerCommand running `action omp <id>`).
 *   • E1 degrade   → the four extension events (PermissionRequest /
 *                    PostToolUseFailure / SubagentStart / SubagentStop) have no OMP
 *                    analog; install reports them "unsupported here" and the bridge
 *                    never references them.
 *   • review-fix   → the generated tool_call handler degrades "modify" to allow.
 *
 * The generated bridge is exercised LIVE (the freshly-written module is
 * dynamically imported with node:child_process mocked, the wave4 idiom). Migrated
 * to the shared harness (tests/support/env + adapter-suite); the render / bridge /
 * action blocks came from the old wave4 suite, the nativeHooks block from the
 * omp-native-hooks suite, the remote `type` block from the omp-remote-transport
 * suite, the E1 degrade block from the extended-events-degrade batch suite, and
 * the modify-degrades-to-allow block from the review-fixes suite.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  HookResponse,
  ResolvedConnector,
  Transport,
} from "../../src/core/types.js";

import ompAdapter from "../../src/adapters/omp/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { readJson } from "../support/fs.js";
import { createAdapterSuite } from "../support/adapter-suite.js";

// ─────────────────────────────────────────────────────────────────────────
// node:child_process mock — hoisted above every import by vitest.
//
// The omp generated plugin imports `execFileSync` (POSIX) / `execSync` (Windows)
// at top-level; the bridge + action-surface tests dynamically import the
// freshly-written module and fire its handlers, so the mock must be in place
// before that module resolves node:child_process. Each test reprograms what the
// mock returns via execFileSyncImpl. (Carried from the former wave4 suite. The
// render / nativeHooks / remote / E1 / review-fix slices only inspect the
// returned source STRING and never spawn — but they share this file's one mock.)
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

// ── nativeHooks fixtures ───────────────────────────────────────────────────────
const NATIVE_CONNECTOR_ID = "acme-omp-native";

/** Path of the generated ts-plugin module (project scope) for a given connector id. */
function nativeEntryPath(projectDir: string): string {
  return join(projectDir, ".omp", "extensions", NATIVE_CONNECTOR_ID, "index.js");
}

/** A normalized PreToolUse hook + an omp-native main-loop hook. */
function nativeConnector(): ResolvedConnector {
  return defineConnector({
    id: NATIVE_CONNECTOR_ID,
    displayName: "Acme OMP",
    version: "1.0.0",
    hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
    platforms: {
      omp: {
        nativeHooks: {
          agent_start: { handler: () => ({}) },
          turn_end: { handler: () => ({}) },
        },
      },
    },
  });
}

// ── remote transport fixtures ──────────────────────────────────────────────────
const REMOTE_CONNECTOR_ID = "acme-remote";

function remoteConnector(transport: Transport, withCommand = false): ResolvedConnector {
  return defineConnector({
    id: REMOTE_CONNECTOR_ID,
    displayName: "Acme Remote",
    version: "1.0.0",
    server: withCommand
      ? { transport, command: "npx", args: ["-y", "@x/y"], tools: { include: ["*"] } }
      : {
          transport,
          url: "https://mcp.acme.example/endpoint",
          headers: { Authorization: "Bearer ${env:ACME_TOKEN}" },
          tools: { include: ["*"] },
        },
    telemetry: { enabled: false },
  });
}

/** Fresh HOME for the remote slice: pins ACME_TOKEN, clears OMP_PROFILE / PI_PROFILE. */
function freshRemoteHome(prefix: string): string {
  const dir = freshProject(prefix);
  process.env.ACME_TOKEN = "tok-123";
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  return dir;
}

/** Install a remote (or stdio) server and return the written native entry. */
function installRemoteAndRead(transport: Transport, prefix: string, withCommand = false): Record<string, any> {
  const projectDir = freshRemoteHome(prefix);
  const ctx = buildCtx(projectDir, remoteConnector(transport, withCommand));
  ompAdapter.installServer!(ctx);
  const cfg = JSON.parse(readFileSync(ompAdapter.getServerConfigPath!(ctx), "utf8"));
  return cfg.mcpServers[REMOTE_CONNECTOR_ID];
}

// ── E1 degrade fixtures ─────────────────────────────────────────────────────────
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
function buildE1Connector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
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

// Pin process.platform to a POSIX value for the whole file so the generated
// bridge takes its execFileSync(HOME_BIN, [args]) path (on Windows it would use
// execSync(one quoted string) — correct in production, proven separately, but it
// would not match these bridges' execFileSync(bin, argv) call-shape assertions).
// node:path is already bound at import and os.homedir() is native, so neither is
// affected by this string override.
const REAL_PLATFORM = process.platform;
beforeEach(() => {
  execFileSyncMock.mockClear();
  execFileSyncImpl = () => "";
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
});

// Shared env isolation (default keys + the env-ref / OMP root + remote vars the
// slices mutate) + the same-rules-for-every-host baseline contract.
isolateEnv([
  ENV_VAR,
  "PI_CODING_AGENT_DIR",
  "PI_PROJECT_DIR",
  "ACME_TOKEN",
  "OMP_PROFILE",
  "PI_PROFILE",
]);
createAdapterSuite({ adapter: ompAdapter, paradigm: "ts-plugin" });

// ─────────────────────────────────────────────────────────────────────────
// OMP (ts-plugin extension package + native MCP) — render
// ─────────────────────────────────────────────────────────────────────────

describe("omp adapter (ts-plugin) render", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-w4-omp-");
    process.env[ENV_VAR] = ENV_LITERAL;
    delete process.env.PI_CODING_AGENT_DIR;
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
    process.env[ENV_VAR] = ENV_LITERAL;
    delete process.env.PI_CODING_AGENT_DIR;
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
// nativeHooks passthrough (OMP main-loop events with no canonical analog)
//
// OMP's main-loop lifecycle events — agent_start, agent_end, turn_start,
// turn_end — have NO canonical HookEventName analog (verified in oh-my-pi
// shared-events.ts), so they are not in EVENT_TO_OMP. A connector reaches them
// via platforms["omp"].nativeHooks; the generated ts-plugin index.js REGISTERS a
// pi.on(<native_event>, …) handler that bridges the native event name verbatim to
// the home-bin → runNativeHook dispatches it host-generically.
// ─────────────────────────────────────────────────────────────────────────

describe("omp adapter — nativeHooks passthrough", () => {
  it("declares supportsNativeHooks true", () => {
    expect(ompAdapter.capabilities.supportsNativeHooks).toBe(true);
  });

  it("generated index.js registers + bridges each declared native event verbatim", () => {
    const projectDir = freshProject("ac-omp-native-");
    delete process.env.PI_CODING_AGENT_DIR;
    ompAdapter.installHooks(buildCtx(projectDir, nativeConnector()));
    const src = readFileSync(nativeEntryPath(projectDir), "utf8");

    // native registrations present, by the native event name (not a canonical one)
    expect(src).toContain('pi.on("agent_start"');
    expect(src).toContain('bridge("agent_start"');
    expect(src).toContain('pi.on("turn_end"');
    expect(src).toContain('bridge("turn_end"');
    // the canonical handler still wired alongside (no regression)
    expect(src).toContain('pi.on("tool_call"');
  });

  it("native-only connector (no canonical hooks) STILL synthesizes the plugin", () => {
    const projectDir = freshProject("ac-omp-native-");
    delete process.env.PI_CODING_AGENT_DIR;
    const connector = defineConnector({
      id: NATIVE_CONNECTOR_ID,
      displayName: "Acme OMP Native Only",
      version: "1.0.0",
      platforms: { omp: { nativeHooks: { agent_start: { handler: () => ({}) } } } },
    });

    const changes = ompAdapter.installHooks(buildCtx(projectDir, connector));
    // not a skip — the module is written for the native event
    expect(changes.some((c) => c.action === "skip")).toBe(false);

    const src = readFileSync(nativeEntryPath(projectDir), "utf8");
    expect(src).toContain('pi.on("agent_start"');
    expect(src).toContain('bridge("agent_start"');
    // no canonical handler, but the factory + bridge scaffolding is still valid
    expect(src).not.toContain('pi.on("tool_call"');
    expect(src).toContain("export default function plugin(pi)");
  });

  it("hooks:false disables canonical events but a nativeHook STILL registers the plugin", () => {
    const projectDir = freshProject("ac-omp-native-");
    delete process.env.PI_CODING_AGENT_DIR;
    const connector = defineConnector({
      id: NATIVE_CONNECTOR_ID,
      displayName: "Acme OMP Hooks Off",
      version: "1.0.0",
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: {
        omp: { hooks: false, nativeHooks: { turn_start: { handler: () => ({}) } } },
      },
    });

    const changes = ompAdapter.installHooks(buildCtx(projectDir, connector));
    expect(changes.some((c) => c.action === "skip")).toBe(false);

    const src = readFileSync(nativeEntryPath(projectDir), "utf8");
    expect(src).toContain('pi.on("turn_start"'); // native installed (sibling)
    expect(src).toContain('bridge("turn_start"');
    expect(src).not.toContain('pi.on("tool_call"'); // canonical disabled by hooks:false
  });

  it("idempotent second install → skip; uninstall removes the extension", () => {
    const projectDir = freshProject("ac-omp-native-");
    delete process.env.PI_CODING_AGENT_DIR;
    const ctx = buildCtx(projectDir, nativeConnector());
    ompAdapter.installHooks(ctx);
    const second = ompAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    ompAdapter.uninstallHooks(ctx);
    const removed = ompAdapter.uninstallHooks(ctx);
    expect(removed.every((c) => c.action === "skip")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// remote MCP `type` discriminator
//
// OMP's mcp.json schema (docs/mcp-config.md) requires an explicit `type` on a
// URL server — `type: "http"` (streamable HTTP) or `type: "sse"` — and treats an
// entry with NO `type` as stdio ("stdio is the default when type is omitted").
// These tests lock the discriminator (http → "http", sse → "sse") and confirm a
// stdio entry stays type-less (it correctly relies on OMP's default).
// ─────────────────────────────────────────────────────────────────────────

describe("omp adapter — remote MCP type discriminator", () => {
  it("renders canonical http with the REQUIRED type:\"http\" discriminator", () => {
    const entry = installRemoteAndRead("http", "ac-omp-http-");
    expect(entry.type).toBe("http");
    expect(entry.url).toBe("https://mcp.acme.example/endpoint");
    expect(entry.headers.Authorization).toBe("Bearer tok-123");
    expect("command" in entry).toBe(false);
  });

  it("renders sse with type:\"sse\"", () => {
    const entry = installRemoteAndRead("sse", "ac-omp-sse-");
    expect(entry.type).toBe("sse");
    expect(entry.url).toBe("https://mcp.acme.example/endpoint");
  });

  it("stdio entry stays type-less (relies on OMP's documented stdio default)", () => {
    const entry = installRemoteAndRead("stdio", "ac-omp-stdio-", true);
    expect("type" in entry).toBe(false);
    expect(entry.command).toBeTruthy();
  });

  it("an unadvertised transport (ws) is WARNED, not silently downgraded, and renders best-effort as http", () => {
    const projectDir = freshRemoteHome("ac-omp-ws-");
    const ctx = buildCtx(projectDir, remoteConnector("ws"));
    const changes = ompAdapter.installServer!(ctx);
    expect(changes.some((c) => c.action === "warn" && /transport "ws" is not an OMP/.test(c.detail ?? ""))).toBe(true);
    const cfg = JSON.parse(readFileSync(ompAdapter.getServerConfigPath!(ctx), "utf8"));
    expect(cfg.mcpServers[REMOTE_CONNECTOR_ID].type).toBe("http"); // best-effort (OMP rejects an unknown type)
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

describe("omp adapter — action surface (slash commands in the shared plugin)", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-w4-omp-act-");
    delete process.env.PI_CODING_AGENT_DIR;
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

// ─────────────────────────────────────────────────────────────────────────
// E1 extension-event DEGRADATION — the four new canonical events
// (PermissionRequest, PostToolUseFailure, SubagentStart, SubagentStop) have NO
// OMP analog. The four capability flags stay unset; install reports them
// "unsupported here" and the generated bridge never references any of them.
// (Carried from the shared extended-events-degrade batch suite.)
// ─────────────────────────────────────────────────────────────────────────

describe("omp E1 extension-event degradation", () => {
  it("leaves permissionRequest/postToolUseFailure/subagentStart/subagentStop falsy", () => {
    expect(ompAdapter.capabilities.permissionRequest ?? false).toBe(false);
    expect(ompAdapter.capabilities.postToolUseFailure ?? false).toBe(false);
    expect(ompAdapter.capabilities.subagentStart ?? false).toBe(false);
    expect(ompAdapter.capabilities.subagentStop ?? false).toBe(false);
  });

  it("install detail reports the four as unsupported; bridge wires tool_call only", () => {
    const UNSUPPORTED_DETAIL =
      "unsupported here: PermissionRequest,PostToolUseFailure,SubagentStart,SubagentStop";
    const projectDir = freshProject("ac-e1-omp-");
    delete process.env.PI_CODING_AGENT_DIR;
    const ctx = buildCtx(projectDir, buildE1Connector());

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

// ─────────────────────────────────────────────────────────────────────────
// review-fix — the generated plugin degrades "modify" to allow (no modify-block)
// (Carried from the shared review-fixes suite.)
// ─────────────────────────────────────────────────────────────────────────

describe("omp generated plugin: modify degrades to allow", () => {
  it("the generated tool_call handler does NOT block on modify", () => {
    const projectDir = freshProject("ac-rf-omp-");
    delete process.env.PI_CODING_AGENT_DIR;
    const ctx = buildCtx(projectDir, buildConnector());

    const files = ompAdapter.synthesizePlugin!(ctx);
    const indexJs = files.find((f) => f.path.endsWith("index.js"));
    expect(indexJs).toBeTruthy();
    const src = indexJs!.contents;

    // The block condition must gate on deny || ask only — never modify.
    expect(src).toContain('res.decision === "deny" || res.decision === "ask"');
    expect(src).not.toContain('res.decision === "modify"');
  });
});
