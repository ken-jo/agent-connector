/**
 * tests/adapters/opencode.test.ts — the ONE per-host file for OpenCode (SST).
 *
 * OpenCode is the reference **ts-plugin** host: it has no JSON hook table, instead
 * auto-loading JS/TS modules from a plugin dir. agent-connector synthesizes a
 * self-contained ESM bridge module that imports nothing from agent-connector and,
 * on each in-process hook firing, shells out to the ONE stable home binary's
 * universal entrypoint
 *     <homeBin> hook opencode <event> --connector <id>
 * over child_process, feeds the OpenCode-shaped payload on stdin, and JSON.parses
 * the normalized HookResponse back from stdout (fail-open). This file consolidates
 * EVERY opencode surface (the per-host convention in tests/README.md — one file
 * per host):
 *
 *   • capabilities + docs-matrix wiring — permissionRequest / supportsNativeHooks
 *     true; the docs hooks-matrix PermissionRequest cell is permission.ask.
 *   • permission.ask handler — PermissionRequest → "permission.ask" MUTATES
 *     output.status ("ask"|"deny"|"allow") rather than returning a value; LIVE
 *     round-trip of a deny / allow.
 *   • nativeHooks passthrough — an OpenCode-native event declared on
 *     platforms["opencode"].nativeHooks emits a fire-and-forget bridge
 *     registration; install synthesizes the plugin for a native-only connector;
 *     hooks:false keeps native passthrough; LIVE native-event firing.
 *   • MCP server + hooks render (former phase3) → opencode.json "mcp" entry
 *     (type local, command ARRAY); idempotency + uninstall; installHooks writes a
 *     plugin .js module; THE BRIDGE WORKS (dynamic import of the generated module:
 *     deny → throw, modify → args rewrite, allow/empty → no-op, bridge error →
 *     fail-open); parseEvent + formatReply round-trip.
 *   • content surfaces (former surfaces-s1) → md+fm commands, uniform SKILL.md
 *     skills (+ resource), md+fm subagents under the SINGULAR agent/ dir;
 *     idempotency + uninstall.
 *   • E1 degrade (former extended-events-degrade) → PermissionRequest IS wired
 *     (permission.ask); the other three E1 events (PostToolUseFailure /
 *     SubagentStart / SubagentStop) have no opencode analog → "unsupported here"
 *     detail and never leak into the generated bridge.
 *
 * Migrated to the shared harness (tests/support/env + adapter-suite). The
 * capabilities / permission.ask / nativeHooks blocks were the base opencode file;
 * the MCP/hooks/bridge render slice came from the former phase3 suite; the
 * content-surface slice from the former surfaces-s1 suite; the E1-degrade slice
 * from the former extended-events-degrade batch suite.
 *
 * The generated bridge is exercised LIVE with node:child_process mocked so a
 * "deny" round-trips through output.status / throws. The render / content-surface
 * / E1-degrade slices only inspect the written bytes / install detail and never
 * spawn — but they share this file's ONE hoisted mock.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { HookResponse, ResolvedConnector } from "../../src/core/types.js";
import { platforms as matrixPlatforms } from "../../site/src/components/docs/hooks-matrix.js";

import ocAdapter from "../../src/adapters/opencode/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { readJson, splitFrontmatter } from "../support/fs.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { symlinkOrSkipTest } from "../support/symlink.js";

// ─────────────────────────────────────────────────────────────────────────
// node:child_process mock — hoisted above every import by vitest.
//
// The generated OpenCode plugin imports `execFileSync` (POSIX) / `execSync`
// (Windows) at top-level. The permission.ask / nativeHooks / render BRIDGE
// slices dynamically import the freshly-written module and fire its handlers, so
// the mock must be in place before that module resolves node:child_process. Each
// test reprograms what the mock returns via execFileSyncImpl. (The base opencode
// file already carried this mock for its LIVE bridge tests; the phase3 render
// slice needs the same one — reconciled to this ONE hoisted mock. The
// content-surface / E1-degrade slices only inspect the written bytes / install
// detail and never spawn, but they share this file's one mock.)
// ─────────────────────────────────────────────────────────────────────────

let execFileSyncImpl: (...args: any[]) => string = () => "";
const execFileSyncMock = vi.fn((...args: any[]) => execFileSyncImpl(...args));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  execSync: execFileSyncMock,
}));

// Pin process.platform to a POSIX value for the whole file so the generated
// bridge takes its execFileSync(HOME_BIN, [args]) path (on Windows it would use
// execSync(one quoted string) — correct in production, proven separately, but it
// would not match these bridges' execFileSync(bin, argv) call-shape assertions).
const REAL_PLATFORM = process.platform;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  execFileSyncMock.mockClear();
  execFileSyncImpl = () => "";
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
});

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures — capabilities / permission.ask / nativeHooks (base file)
// ─────────────────────────────────────────────────────────────────────────

const CONNECTOR_ID = "acme-db";

/** Connector declaring PermissionRequest + an OpenCode-native passthrough event. */
function buildConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    hooks: {
      PreToolUse: {
        matcher: "acme_write",
        handler: () => ({ decision: "allow" }),
      },
      PermissionRequest: {
        matcher: "acme_write",
        handler: () => ({ decision: "deny", reason: "blocked" }),
      },
    },
    platforms: {
      opencode: {
        nativeHooks: { "session.idle": { handler: () => undefined } },
      },
    },
  });
}

/** Connector with NO canonical hooks — only an OpenCode-native passthrough. */
function buildNativeOnlyConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    platforms: {
      opencode: {
        nativeHooks: { "session.idle": { handler: () => undefined } },
      },
    },
  });
}

// ── render slice fixtures (former phase3) ──────────────────────────────────
// The phase3 render/bridge slice reuses the acme-db connector id but adds a
// stdio server with an env-ref var + a PreToolUse hook, and asserts the full
// serve-wrapper command array. Kept distinct from the base PermissionRequest +
// nativeHooks fixtures above.
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";

/** A connector with a stdio server (env-ref) + a PreToolUse hook (render slice). */
function buildRenderConnector(): ResolvedConnector {
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
    },
  });
}

/** Fresh project dir + the render-slice env var. */
function freshRenderProject(prefix: string): string {
  const dir = freshProject(prefix);
  process.env[ENV_VAR] = ENV_LITERAL;
  return dir;
}

// The serve-wrapper tail also bakes the install TARGET platform as `--host <id>`
// (before `--`) so the proxy stamps hostPlatform under a headless spawn. When the
// ctx uses a NON-DEFAULT data-root (the render fixture sets `dataRoot:
// projectDir`), the wrap also bakes `--data-dir <root>` so an env-stripping host
// (codex) resolves the connector record from the right root.
const wrappedTail = (host: string, dataDir: string): string[] => [
  "serve",
  "--connector",
  CONNECTOR_ID,
  "--scope",
  "project",
  "--host",
  host,
  "--data-dir",
  dataDir,
  "--",
  "npx",
  "-y",
  "@x/y",
];

// ── content-surface fixtures (former surfaces-s1) ──────────────────────────
const SURFACE_CONNECTOR_ID = "acme-surfaces";

const COMMAND = {
  name: "deploy",
  description: "Deploy the app to an environment.",
  prompt: "Deploy to {{args}} / $ARGUMENTS and report the result.",
  argumentHint: "[environment]",
  tools: { allow: ["Bash", "Read"] },
  model: "sonnet",
} as const;

const SKILL = {
  name: "pdf-tools",
  description: "Extract and summarize text from PDF files when the user asks.",
  body: "# PDF Tools\n\nUse the bundled script to extract text.",
  model: "haiku",
  tools: { allow: ["Bash"] },
  disableModelInvocation: false,
  resources: { "scripts/extract.sh": "#!/bin/sh\necho extracting\n" },
} as const;

const SUBAGENT = {
  name: "reviewer",
  description: "Reviews code diffs for correctness bugs.",
  prompt: "You are a meticulous code reviewer. Find correctness bugs.",
  tools: { allow: ["Read", "Grep"] },
  model: "opus",
  readonly: true,
} as const;

/** A connector declaring a command + skill (with a resource) + subagent. */
function buildSurfaceConnector(): ResolvedConnector {
  return defineConnector({
    id: SURFACE_CONNECTOR_ID,
    displayName: "Acme Surfaces",
    version: "1.0.0",
    commands: [{ ...COMMAND, tools: { allow: [...COMMAND.tools.allow] } }],
    skills: [
      {
        ...SKILL,
        tools: { allow: [...SKILL.tools.allow] },
        resources: { ...SKILL.resources },
      },
    ],
    subagents: [{ ...SUBAGENT, tools: { allow: [...SUBAGENT.tools.allow] } }],
  });
}

// ── E1-degrade fixtures (former extended-events-degrade) ───────────────────
// A connector declaring PreToolUse + ALL FOUR E1 extension events. opencode
// wires PreToolUse + PermissionRequest (permission.ask) and reports the other
// three as "unsupported here".
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

// Shared env isolation (default keys + the env-ref var the render slice mutates)
// + the same-rules-for-every-host baseline contract.
isolateEnv([ENV_VAR]);
createAdapterSuite({ adapter: ocAdapter, paradigm: "ts-plugin" });

// ─────────────────────────────────────────────────────────────────────────
// Fix A: PermissionRequest → permission.ask
// ─────────────────────────────────────────────────────────────────────────

describe("opencode — capabilities + docs-matrix wiring", () => {
  it("declares permissionRequest === true", () => {
    expect(ocAdapter.capabilities.permissionRequest).toBe(true);
  });

  it("declares supportsNativeHooks === true", () => {
    expect(ocAdapter.capabilities.supportsNativeHooks).toBe(true);
  });

  it("the docs hooks-matrix opencode PermissionRequest cell is permission.ask", () => {
    const entry = matrixPlatforms.find((p) => p.platform === "opencode")!;
    expect(entry.events.PermissionRequest).toBe("permission.ask");
  });
});

describe("opencode — generated plugin: permission.ask handler", () => {
  let projectDir: string;
  let ctx: InstallContext;
  let pluginPath: string;

  beforeEach(() => {
    projectDir = freshProject("ac-oc-perm-");
    ctx = buildCtx(projectDir, buildConnector(), { dataRoot: projectDir });
    pluginPath = ocAdapter.getHookConfigPath(ctx);
  });

  it("source contains a permission.ask handler that mutates output.status to 'deny'", () => {
    ocAdapter.installHooks(ctx);
    const src = readFileSync(pluginPath, "utf8");
    expect(src).toContain('"permission.ask": async (input, output) =>');
    expect(src).toContain('bridge("PermissionRequest"');
    // MUTATES output.status — never returns a value.
    expect(src).toContain('if (res.decision === "deny") output.status = "deny";');
    expect(src).toContain('else if (res.decision === "ask") output.status = "ask";');
  });

  it("LIVE: a 'deny' mutates output.status to 'deny' (no return value)", async () => {
    ocAdapter.installHooks(ctx);
    execFileSyncImpl = () => JSON.stringify({ decision: "deny", reason: "blocked" });

    const url = `${pathToFileURL(pluginPath).href}?t=${Date.now()}-${Math.random()}`;
    const mod = await import(/* @vite-ignore */ url);
    const hooks = await mod.default({ directory: projectDir });
    const permissionAsk = hooks["permission.ask"];
    expect(typeof permissionAsk).toBe("function");

    const output = { status: "ask" as "ask" | "deny" | "allow" };
    const ret = await permissionAsk({ type: "acme_write", sessionID: "s1" }, output);

    expect(ret).toBeUndefined(); // mutates, does NOT return
    expect(output.status).toBe("deny");

    const [bin, argv] = execFileSyncMock.mock.calls[0]!;
    expect(bin).toBe(HOME_BIN);
    expect(argv).toEqual(["hook", "opencode", "PermissionRequest", "--connector", CONNECTOR_ID]);
  });

  it("LIVE: an 'allow' decision leaves output.status untouched", async () => {
    ocAdapter.installHooks(ctx);
    execFileSyncImpl = () => JSON.stringify({ decision: "allow" });

    const url = `${pathToFileURL(pluginPath).href}?t=${Date.now()}-${Math.random()}`;
    const mod = await import(/* @vite-ignore */ url);
    const hooks = await mod.default({ directory: projectDir });

    const output = { status: "ask" as "ask" | "deny" | "allow" };
    await hooks["permission.ask"]({ type: "acme_write", sessionID: "s1" }, output);
    expect(output.status).toBe("ask"); // default/allow left alone
  });

  it("parseEvent normalizes PermissionRequest from the bridge payload", () => {
    const evt = ocAdapter.parseEvent!("PermissionRequest", {
      toolName: "acme_write",
      toolInput: { sql: "DELETE" },
      sessionId: "oc-1",
      projectDir: "/some/proj",
    });
    expect(evt).toMatchObject({
      hostPlatform: "opencode",
      toolName: "acme_write",
      toolInput: { sql: "DELETE" },
      sessionId: "oc-1",
      projectDir: "/some/proj",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Fix B: nativeHooks opt-in
// ─────────────────────────────────────────────────────────────────────────

describe("opencode — generated plugin: native passthrough events", () => {
  it("a nativeHooks event appears as a bridge registration in the generated plugin", () => {
    const projectDir = freshProject("ac-oc-native-");
    const ctx = buildCtx(projectDir, buildConnector(), { dataRoot: projectDir });
    ocAdapter.installHooks(ctx);
    const src = readFileSync(ocAdapter.getHookConfigPath(ctx), "utf8");
    // Computed (quoted) key + a bridge() call with the verbatim native name.
    expect(src).toContain('["session.idle"]: async (input, output) =>');
    expect(src).toContain('bridge("session.idle"');
    expect(src).toContain("raw: input,");
  });

  it("install synthesizes the plugin for a native-only connector (no canonical hooks)", () => {
    const projectDir = freshProject("ac-oc-native-only-");
    const ctx = buildCtx(projectDir, buildNativeOnlyConnector(), { dataRoot: projectDir });
    const changes = ocAdapter.installHooks(ctx);
    const pluginPath = ocAdapter.getHookConfigPath(ctx);

    expect(changes.some((c) => c.action === "create")).toBe(true);
    expect(existsSync(pluginPath)).toBe(true);

    const src = readFileSync(pluginPath, "utf8");
    expect(src).toContain('bridge("session.idle"');
    // No canonical handlers were emitted.
    expect(src).not.toContain("tool.execute.before");
    expect(src).not.toContain('"permission.ask"');
  });

  it("LIVE: a native event fires the bridge with `hook opencode session.idle`", async () => {
    const projectDir = freshProject("ac-oc-native-live-");
    const ctx = buildCtx(projectDir, buildConnector(), { dataRoot: projectDir });
    ocAdapter.installHooks(ctx);

    const pluginPath = ocAdapter.getHookConfigPath(ctx);
    const url = `${pathToFileURL(pluginPath).href}?t=${Date.now()}-${Math.random()}`;
    const mod = await import(/* @vite-ignore */ url);
    const hooks = await mod.default({ directory: projectDir });

    const idle = hooks["session.idle"];
    expect(typeof idle).toBe("function");
    await idle({ sessionID: "s1", foo: "bar" }, {});

    const [bin, argv] = execFileSyncMock.mock.calls[0]!;
    expect(bin).toBe(HOME_BIN);
    expect(argv).toEqual(["hook", "opencode", "session.idle", "--connector", CONNECTOR_ID]);
  });

  it("`hooks: false` disables canonical handlers but keeps native passthrough", () => {
    const projectDir = freshProject("ac-oc-hooks-false-");
    const connector = defineConnector({
      id: CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: {
        opencode: {
          hooks: false,
          nativeHooks: { "session.idle": { handler: () => undefined } },
        },
      },
    });
    const ctx = buildCtx(projectDir, connector, { dataRoot: projectDir });
    ocAdapter.installHooks(ctx);
    const src = readFileSync(ocAdapter.getHookConfigPath(ctx), "utf8");
    expect(src).not.toContain("tool.execute.before");
    expect(src).toContain('bridge("session.idle"');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// MCP server + hooks render slice (former phase3) — the ts-plugin paradigm,
// end-to-end against REAL files on disk.
// ─────────────────────────────────────────────────────────────────────────

describe("opencode adapter (ts-plugin) render", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshRenderProject("ac-p3-oc-");
    ctx = buildCtx(projectDir, buildRenderConnector(), { dataRoot: projectDir });
  });

  it("installServer writes the opencode.json 'mcp' entry with type 'local' + command ARRAY at the home bin", () => {
    const changes = ocAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, "opencode.json");
    expect(serverPath).toBe(ocAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    // Root key is "mcp", NOT "mcpServers".
    expect(cfg).toHaveProperty("mcp");
    expect(cfg).not.toHaveProperty("mcpServers");

    const entry = cfg.mcp[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.type).toBe("local");
    expect(Array.isArray(entry.command)).toBe(true);
    expect(entry.command).toEqual([HOME_BIN, ...wrappedTail("opencode", projectDir)]);

    // No native interpolation token → env resolves to a LITERAL value.
    expect(entry.environment[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.environment[ENV_VAR]).not.toContain("${");
  });

  it("installServer warn-skips a symlinked opencode.json without touching the target", () => {
    const outside = join(projectDir, "outside.json");
    const serverPath = join(projectDir, "opencode.json");
    const before = `${JSON.stringify({ outside: true }, null, 2)}\n`;
    writeFileSync(outside, before, "utf8");
    if (!symlinkOrSkipTest(outside, serverPath)) return;

    const changes = ocAdapter.installServer(ctx);

    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.path).toBe(serverPath);
    expect(changes[0]?.detail).toMatch(/symbolic link/i);
    expect(readFileSync(outside, "utf8")).toBe(before);
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    ocAdapter.installServer(ctx);
    const second = ocAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, "opencode.json"));
    expect(Object.keys(cfg.mcp)).toEqual([CONNECTOR_ID]);
  });

  it("uninstallServer removes the entry (re-read confirms gone)", () => {
    ocAdapter.installServer(ctx);
    ocAdapter.uninstallServer(ctx);

    const cfg = readJson(join(projectDir, "opencode.json"));
    expect(cfg.mcp?.[CONNECTOR_ID]).toBeUndefined();
  });

  it("installHooks writes a plugin .js module into the project .opencode/plugin/ dir", () => {
    const changes = ocAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const pluginPath = join(
      projectDir,
      ".opencode",
      "plugin",
      `${CONNECTOR_ID}.js`,
    );
    expect(pluginPath).toBe(ocAdapter.getHookConfigPath(ctx));
    expect(existsSync(pluginPath)).toBe(true);

    // The generated module is the self-contained bridge (no agent-connector import).
    const src = readFileSync(pluginPath, "utf8");
    expect(src).toContain("execFileSync");
    expect(src).toContain('"hook"');
    expect(src).toContain('"opencode"');
    expect(src).toContain("--connector");
    expect(src).toContain(CONNECTOR_ID);
    expect(src).toContain("tool.execute.before");
  });

  it("installHooks is idempotent — second call yields skip", () => {
    ocAdapter.installHooks(ctx);
    const second = ocAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallHooks removes the plugin module (re-read confirms gone)", () => {
    ocAdapter.installHooks(ctx);
    const pluginPath = ocAdapter.getHookConfigPath(ctx);
    expect(existsSync(pluginPath)).toBe(true);

    ocAdapter.uninstallHooks(ctx);
    expect(existsSync(pluginPath)).toBe(false);
  });
});

describe("opencode generated plugin — THE BRIDGE WORKS (live, child_process mocked)", () => {
  let projectDir: string;
  let ctx: InstallContext;
  let pluginPath: string;

  beforeEach(() => {
    projectDir = freshRenderProject("ac-p3-bridge-");
    ctx = buildCtx(projectDir, buildRenderConnector(), { dataRoot: projectDir });
    // Write the generated plugin to disk for THIS connector.
    ocAdapter.installHooks(ctx);
    pluginPath = ocAdapter.getHookConfigPath(ctx);
    expect(existsSync(pluginPath)).toBe(true);
  });

  /**
   * Import the freshly-written generated module. A cache-busting query keeps each
   * test importing the exact bytes just written (the module is identical across
   * tests here, but the query guards against any future per-test divergence).
   */
  async function loadPlugin(): Promise<any> {
    const url = `${pathToFileURL(pluginPath).href}?t=${Date.now()}-${Math.random()}`;
    return import(/* @vite-ignore */ url);
  }

  it("default export is an async factory returning a hooks object with tool.execute.before", async () => {
    const mod = await loadPlugin();
    expect(typeof mod.default).toBe("function");

    // Minimal fake ctx — the factory only reads ctx.directory / ctx.worktree.
    const hooks = await mod.default({});
    expect(hooks).toBeTruthy();
    expect(typeof hooks["tool.execute.before"]).toBe("function");
  });

  it("a 'deny' decision from the bridge THROWS (blocks the tool call)", async () => {
    execFileSyncImpl = () =>
      JSON.stringify({ decision: "deny", reason: "nope" });

    const mod = await loadPlugin();
    const hooks = await mod.default({ directory: projectDir });
    const before = hooks["tool.execute.before"];

    const input = { tool: "acme_write", sessionID: "s1" };
    const output = { args: { sql: "DELETE" } };

    await expect(before(input, output)).rejects.toThrow("nope");

    // The bridge actually shelled out to the universal entrypoint.
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [bin, argv] = execFileSyncMock.mock.calls[0]!;
    expect(bin).toBe(HOME_BIN);
    expect(argv).toEqual([
      "hook",
      "opencode",
      "PreToolUse",
      "--connector",
      CONNECTOR_ID,
    ]);
  });

  it("a 'modify' decision with updatedInput mutates output.args in place", async () => {
    execFileSyncImpl = () =>
      JSON.stringify({ decision: "modify", updatedInput: { x: 1 } });

    const mod = await loadPlugin();
    const hooks = await mod.default({ directory: projectDir });
    const before = hooks["tool.execute.before"];

    const input = { tool: "acme_write", sessionID: "s2" };
    const output: { args: Record<string, unknown> } = { args: {} };

    await expect(before(input, output)).resolves.toBeUndefined();

    // output.args was mutated in place to carry the rewritten input.
    expect(output.args).toEqual({ x: 1 });
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it("an 'allow' (or empty) decision neither throws nor mutates", async () => {
    execFileSyncImpl = () => JSON.stringify({ decision: "allow" });

    const mod = await loadPlugin();
    const hooks = await mod.default({ directory: projectDir });
    const before = hooks["tool.execute.before"];

    const output = { args: { sql: "SELECT 1" } };
    await expect(before({ tool: "acme_query" }, output)).resolves.toBeUndefined();
    expect(output.args).toEqual({ sql: "SELECT 1" });
  });

  it("a bridge error fails OPEN — the handler swallows it and does not block", async () => {
    execFileSyncImpl = () => {
      throw new Error("home bin missing");
    };

    const mod = await loadPlugin();
    const hooks = await mod.default({ directory: projectDir });
    const before = hooks["tool.execute.before"];

    const output = { args: { sql: "SELECT 1" } };
    // Fail-open: a bridge exception degrades to "allow" (no throw, no mutation).
    await expect(before({ tool: "acme_query" }, output)).resolves.toBeUndefined();
    expect(output.args).toEqual({ sql: "SELECT 1" });
  });
});

describe("opencode adapter runtime dispatch", () => {
  it("formatReply returns exit 0 and stdout that JSON-parses to the normalized response", () => {
    const deny: HookResponse = { decision: "deny", reason: "x" };
    const reply = ocAdapter.formatReply!("PreToolUse", deny);

    expect(reply.exitCode).toBe(0);
    // Unlike json-stdio hosts, OUR generated bridge consumes this directly — the
    // reply body IS the normalized HookResponse (the bridge JSON.parses it).
    const out = JSON.parse(reply.stdout!);
    expect(out).toEqual({ decision: "deny", reason: "x" });
  });

  it("parseEvent maps a sent bridge payload to a normalized PreToolUse event", () => {
    const evt = ocAdapter.parseEvent!("PreToolUse", {
      toolName: "acme_write",
      toolInput: { sql: "DELETE" },
      sessionId: "oc-1",
      projectDir: "/some/proj",
    });

    expect(evt).toMatchObject({
      hostPlatform: "opencode",
      toolName: "acme_write",
      toolInput: { sql: "DELETE" },
      sessionId: "oc-1",
      projectDir: "/some/proj",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Content surfaces (former surfaces-s1) — md+fm commands, SKILL.md skills,
// md+fm subagents under the SINGULAR agent/ dir.
// ─────────────────────────────────────────────────────────────────────────

describe("opencode adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-surfaces-s1-");
    ctx = buildCtx(projectDir, buildSurfaceConnector(), { dataRoot: projectDir });
  });

  it("declares support for all three content surfaces", () => {
    expect(ocAdapter.capabilities.supportsCommands).toBe(true);
    expect(ocAdapter.capabilities.supportsSkills).toBe(true);
    expect(ocAdapter.capabilities.supportsSubagents).toBe(true);
  });

  it("installCommands writes md+fm commands/<name>.md (description, model)", () => {
    const changes = ocAdapter.installCommands!(ctx);
    expect(changes[0]?.action).toBe("create");
    // Project scope: opencode getConfigDir === projectDir (no dot-dir wrapper).
    const cmdPath = join(projectDir, ".opencode", "commands", "deploy.md");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(cmdPath, "utf8"));
    expect(frontmatter.description).toBe("Deploy the app to an environment.");
    expect(frontmatter.model).toBe("sonnet");
    expect(body.trim()).toBe(COMMAND.prompt);
  });

  it("installSkills writes uniform SKILL.md + resource", () => {
    ocAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".opencode", "skills", "pdf-tools", "SKILL.md");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(join(projectDir, ".opencode", "skills", "pdf-tools", "scripts", "extract.sh"))).toBe(true);

    const { frontmatter } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
  });

  it("installSubagents writes md+fm under the SINGULAR agent/ dir (mode:subagent)", () => {
    ocAdapter.installSubagents!(ctx);
    // SINGULAR "agent" dir, not "agents".
    const agentPath = join(projectDir, ".opencode", "agent", "reviewer.md");
    expect(existsSync(agentPath)).toBe(true);
    expect(existsSync(join(projectDir, "agents", "reviewer.md"))).toBe(false);

    const { frontmatter, body } = splitFrontmatter(readFileSync(agentPath, "utf8"));
    expect(frontmatter.description).toBe(SUBAGENT.description);
    expect(frontmatter.mode).toBe("subagent");
    expect(frontmatter.model).toBe("opus");
    expect(body.trim()).toBe(SUBAGENT.prompt);
  });

  it("is idempotent — second install yields skip across all surfaces", () => {
    ocAdapter.installCommands!(ctx);
    ocAdapter.installSkills!(ctx);
    ocAdapter.installSubagents!(ctx);
    expect(ocAdapter.installCommands!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(ocAdapter.installSkills!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(ocAdapter.installSubagents!(ctx).every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall removes all written files", () => {
    ocAdapter.installCommands!(ctx);
    ocAdapter.installSkills!(ctx);
    ocAdapter.installSubagents!(ctx);

    ocAdapter.uninstallCommands!(ctx);
    ocAdapter.uninstallSkills!(ctx);
    ocAdapter.uninstallSubagents!(ctx);

    expect(existsSync(join(projectDir, ".opencode", "commands", "deploy.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".opencode", "skills", "pdf-tools"))).toBe(false);
    expect(existsSync(join(projectDir, ".opencode", "agent", "reviewer.md"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// E1 extension-event degradation (former extended-events-degrade) — opencode
// wires PermissionRequest -> permission.ask (its native decision-capable gate)
// but leaves the other three E1 events unsupported, never leaking them into the
// generated bridge.
// ─────────────────────────────────────────────────────────────────────────

describe("opencode adapter — E1 extension-event degradation", () => {
  // opencode wires PermissionRequest -> permission.ask (its native decision-
  // capable gate), so it supports permissionRequest but still leaves the other
  // three E1 flags falsy (no Stop/subagent/tool-failure analog).
  it("supports permissionRequest but leaves the other three E1 flags falsy", () => {
    expect(ocAdapter.capabilities.permissionRequest ?? false).toBe(true);
    expect(ocAdapter.capabilities.postToolUseFailure ?? false).toBe(false);
    expect(ocAdapter.capabilities.subagentStart ?? false).toBe(false);
    expect(ocAdapter.capabilities.subagentStop ?? false).toBe(false);
  });

  // opencode wires PermissionRequest -> permission.ask, so it is NOT in the
  // "never reference E1" group: its bridge legitimately carries permission.ask.
  // Only the OTHER three E1 events stay unsupported here.
  it("install detail reports only THREE as unsupported; bridge wires tool.execute.before + permission.ask", () => {
    const projectDir = freshProject("ac-e1-opencode-");
    const ctx = buildCtx(projectDir, buildE1Connector(), { dataRoot: projectDir });

    const changes = ocAdapter.installHooks!(ctx);
    const moduleChange = changes.find((c) => c.detail?.startsWith("opencode plugin module"));
    expect(moduleChange?.detail).toBe(
      "opencode plugin module (PreToolUse,PermissionRequest; " +
        "unsupported here: PostToolUseFailure,SubagentStart,SubagentStop)",
    );

    const source = readFileSync(ocAdapter.getHookConfigPath!(ctx), "utf8");
    expect(source).toContain("tool.execute.before");
    expect(source).toContain('"permission.ask"');
    expect(source).toContain('bridge("PermissionRequest"');
    // The remaining three E1 events still never leak into the bridge.
    const stillForbidden = [
      "PostToolUseFailure",
      "SubagentStart",
      "SubagentStop",
      "postToolUseFailure",
      "subagentStart",
      "subagentStop",
      "subagent_spawned",
      "subagent_ended",
      "subagent_stop",
    ];
    for (const token of stillForbidden) {
      expect(source).not.toContain(token);
    }
  });
});
