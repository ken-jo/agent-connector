/**
 * adapters/phase3 — render + ts-plugin bridge tests for the two Phase-3 adapters.
 *
 * Covers the genuinely hard `ts-plugin` paradigm (OpenCode + the Kilo CLI fork)
 * and the `mcp-only` Kilo Code VS Code extension, end-to-end against REAL files
 * on disk in an isolated temp dir:
 *
 *   KILO CLI (ts-plugin — an OpenCode fork loading @kilocode/plugin modules):
 *     • installServer writes kilo.jsonc under the top-level "mcp" key, with a
 *       { type:"local", command:[...] } entry whose command array starts with the
 *       home binary and carries serve --connector <id>.
 *     • idempotency (second installServer → "skip"); uninstallServer removes it.
 *     • installHooks synthesizes a self-contained plugin .js module into the
 *       .kilo/plugin/ dir AND registers its path in kilo.jsonc's "plugin" array
 *       (the fork does NOT auto-discover by dir). uninstallHooks reverses both.
 *
 *   KILO CODE (VS Code extension, mcp-only — vsix 7.3.28 delegates MCP to the
 *   shared kilo backend):
 *     • installServer writes .kilo/kilo.json under the "mcp" key, with a
 *       { type:"local", command:[...], environment } entry — the SAME backend
 *       dialect as the CLI (command ARRAY), NOT the legacy "mcpServers"/scalar.
 *     • the two products never collide: same dir + "mcp" key, but DIFFERENT
 *       filenames (ext kilo.json vs CLI kilo.jsonc) and the CLI also carries a
 *       "plugin" array the ext does not.
 *
 *   OPENCODE (ts-plugin — the important one):
 *     • installServer writes the opencode.json "mcp" entry (type local, command
 *       array). idempotency + uninstall.
 *     • installHooks writes a self-contained plugin .js module into the project
 *       .opencode/plugin/ dir. The file exists.
 *     • THE BRIDGE WORKS — we dynamically import the GENERATED module, call its
 *       default async factory, and exercise the returned "tool.execute.before"
 *       function with child_process mocked: a "deny" decision THROWS (blocks), and
 *       a "modify" + updatedInput mutates output.args in place. This proves the
 *       synthesized bridge shells out to the universal entrypoint and honors the
 *       normalized HookResponse — the novel claim of the ts-plugin paradigm.
 *     • parseEvent + formatReply round-trip for a PreToolUse deny.
 *
 * The mock MUST be in place before the generated module is imported. vi.mock is
 * hoisted to the top of the file, and the generated module is imported lazily
 * (dynamic import inside the test) AFTER the file has been written — so the mock
 * is already registered when node:child_process is resolved by the module runner.
 *
 * Filesystem isolation: every test gets a fresh os.tmpdir mkdtemp project dir, and
 * HOME + AGENT_CONNECTOR_DATA_DIR are redirected there and restored in afterEach so
 * nothing escapes the sandbox.
 */

import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { HookResponse, ResolvedConnector } from "../../src/core/types.js";

import opencodeAdapter from "../../src/adapters/opencode/index.js";
import kiloAdapter from "../../src/adapters/kilo/index.js";
import kiloCliAdapter from "../../src/adapters/kilo-cli/index.js";

// ─────────────────────────────────────────────────────────────────────────
// node:child_process mock — hoisted above every import by vitest.
//
// The generated OpenCode plugin imports `execFileSync` from node:child_process
// at top-level. Each test reprograms what the mocked execFileSync returns via
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

beforeEach(() => {
  savedHome = process.env.HOME;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
  savedEnvVar = process.env[ENV_VAR];
  execFileSyncMock.mockClear();
  execFileSyncImpl = () => "";
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
  restore(ENV_VAR, savedEnvVar);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Fresh temp project dir + redirect HOME/data-root there so nothing escapes. */
function freshProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.HOME = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  process.env[ENV_VAR] = ENV_LITERAL;
  return dir;
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

// The serve-wrapper tail also bakes the install TARGET platform as `--host <id>`
// (before `--`) so the proxy stamps hostPlatform under a headless spawn.
const wrappedTail = (host: string): string[] => [
  "serve",
  "--connector",
  CONNECTOR_ID,
  "--scope",
  "project",
  "--host",
  host,
  "--",
  "npx",
  "-y",
  "@x/y",
];

// ─────────────────────────────────────────────────────────────────────────
// Kilo CLI (ts-plugin) — the SQLite-backed OpenCode FORK loading @kilocode/plugin
// ─────────────────────────────────────────────────────────────────────────

describe("kilo-cli adapter (ts-plugin) render", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-p3-kilo-cli-");
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("has the CLI identity (id kilo-cli / name Kilo CLI / ts-plugin)", () => {
    expect(kiloCliAdapter.id).toBe("kilo-cli");
    expect(kiloCliAdapter.name).toBe("Kilo CLI");
    expect(kiloCliAdapter.paradigm).toBe("ts-plugin");
  });

  it("installServer writes the entry under top-level 'mcp' with type 'local' and a command ARRAY starting at the home bin", () => {
    const changes = kiloCliAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".kilo", "kilo.jsonc");
    expect(serverPath).toBe(kiloCliAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    // New-gen root key is "mcp", NOT the extension's "mcpServers".
    expect(cfg).toHaveProperty("mcp");
    expect(cfg).not.toHaveProperty("mcpServers");

    const entry = cfg.mcp[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.type).toBe("local");

    // The CLI keys the whole invocation as a single ARRAY (exe + args together).
    expect(Array.isArray(entry.command)).toBe(true);
    expect(entry.command[0]).toBe(HOME_BIN);
    // The telemetry serve-wrapper tail is flattened into the same array.
    expect(entry.command).toEqual([HOME_BIN, ...wrappedTail("kilo-cli")]);
    expect(entry.command).toContain("serve");
    expect(entry.command).toContain("--connector");
    expect(entry.command).toContain(CONNECTOR_ID);

    // No native interpolation token → env resolves to a LITERAL value.
    expect(entry.environment[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.environment[ENV_VAR]).not.toContain("${");
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    kiloCliAdapter.installServer(ctx);
    const second = kiloCliAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".kilo", "kilo.jsonc"));
    expect(Object.keys(cfg.mcp)).toEqual([CONNECTOR_ID]);
  });

  it("uninstallServer removes the entry (re-read confirms gone)", () => {
    kiloCliAdapter.installServer(ctx);
    kiloCliAdapter.uninstallServer(ctx);

    const cfg = readJson(join(projectDir, ".kilo", "kilo.jsonc"));
    expect(cfg.mcp?.[CONNECTOR_ID]).toBeUndefined();
  });

  it("installHooks writes the plugin .js module into .kilo/plugin/ AND registers its path in kilo.jsonc's 'plugin' array", () => {
    const changes = kiloCliAdapter.installHooks(ctx);

    // The hook config path is the generated module FILE (ts-plugin), under the
    // dedicated plugin dir — NOT the server config path.
    const pluginPath = kiloCliAdapter.getHookConfigPath(ctx);
    expect(pluginPath).toBe(join(projectDir, ".kilo", "plugin", `${CONNECTOR_ID}.js`));
    expect(pluginPath).not.toBe(kiloCliAdapter.getServerConfigPath(ctx));
    expect(existsSync(pluginPath)).toBe(true);

    // The module is self-contained: it imports NOTHING from agent-connector (the
    // only allowed import is node:child_process). The string "agent-connector"
    // may appear in the AUTO-GENERATED header comment — what must be absent is an
    // actual import/require of the package. It shells out to the home bin's
    // universal `hook kilo-cli` entrypoint.
    const src = readFileSync(pluginPath, "utf8");
    expect(src).not.toMatch(/from\s+["'][^"']*agent-connector/);
    expect(src).not.toMatch(/require\(\s*["'][^"']*agent-connector/);
    expect(src).toContain('import { execFileSync, execSync } from "node:child_process"');
    expect(src).toContain('"hook", "kilo-cli"');
    expect(src).toContain(HOME_BIN);
    // @kilocode/plugin PluginModule shape: default export with a server factory.
    expect(src).toContain("server: async (input)");
    expect(src).toContain('"tool.execute.before"');

    // The module path is registered in kilo.jsonc's top-level "plugin" array.
    const cfg = readJson(kiloCliAdapter.getServerConfigPath(ctx));
    expect(Array.isArray(cfg.plugin)).toBe(true);
    expect(cfg.plugin).toContain(pluginPath);

    // A create for the module + a create for the array registration.
    expect(changes.some((c) => c.action === "create")).toBe(true);
  });

  it("installHooks is idempotent — second call does not duplicate the plugin-array entry", () => {
    kiloCliAdapter.installHooks(ctx);
    kiloCliAdapter.installHooks(ctx);
    const cfg = readJson(kiloCliAdapter.getServerConfigPath(ctx));
    const pluginPath = kiloCliAdapter.getHookConfigPath(ctx);
    expect(cfg.plugin.filter((p: string) => p === pluginPath)).toHaveLength(1);
  });

  it("uninstallHooks removes the module AND deregisters it from the 'plugin' array", () => {
    kiloCliAdapter.installHooks(ctx);
    const pluginPath = kiloCliAdapter.getHookConfigPath(ctx);
    expect(existsSync(pluginPath)).toBe(true);

    kiloCliAdapter.uninstallHooks(ctx);
    expect(existsSync(pluginPath)).toBe(false);

    const cfg = readJson(kiloCliAdapter.getServerConfigPath(ctx));
    expect(Array.isArray(cfg.plugin) ? cfg.plugin : []).not.toContain(pluginPath);
  });

  it("THE BRIDGE WORKS — the synthesized @kilocode/plugin server() blocks on a deny and rewrites args on a modify", async () => {
    kiloCliAdapter.installHooks(ctx);
    const pluginPath = kiloCliAdapter.getHookConfigPath(ctx);

    // Import the freshly-written module (cache-busted) with child_process mocked.
    const mod = await import(`${pathToFileURL(pluginPath).href}?t=${Date.now()}`);
    const plugin = mod.default;
    expect(typeof plugin.server).toBe("function");

    const hooks = await plugin.server({ directory: projectDir });
    const before = hooks["tool.execute.before"];
    expect(typeof before).toBe("function");

    // deny → the handler throws (blocks the tool call).
    execFileSyncImpl = () => JSON.stringify({ decision: "deny", reason: "nope" } satisfies HookResponse);
    await expect(
      before({ tool: "acme_write", sessionID: "s1" }, { args: { a: 1 } }),
    ).rejects.toThrow("nope");

    // modify → updatedInput is merged into output.args in place.
    execFileSyncImpl = () =>
      JSON.stringify({ decision: "modify", updatedInput: { a: 2, b: 3 } } satisfies HookResponse);
    const output = { args: { a: 1 } as Record<string, unknown> };
    await before({ tool: "acme_write", sessionID: "s1" }, output);
    expect(output.args).toEqual({ a: 2, b: 3 });

    // The bridge shelled out to the kilo-cli universal entrypoint.
    expect(execFileSyncMock).toHaveBeenCalled();
    const call = execFileSyncMock.mock.calls.at(-1);
    expect(call?.[0]).toBe(HOME_BIN);
    expect(call?.[1]).toEqual(["hook", "kilo-cli", "PreToolUse", "--connector", CONNECTOR_ID]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Kilo Code (VS Code extension, mcp-only) — Roo/Cline-fork dialect
// ─────────────────────────────────────────────────────────────────────────

describe("kilo adapter (Kilo Code VS Code extension, mcp-only) render", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-p3-kilo-ext-");
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("has the extension identity (id kilo / name Kilo Code)", () => {
    expect(kiloAdapter.id).toBe("kilo");
    expect(kiloAdapter.name).toBe("Kilo Code");
    expect(kiloAdapter.paradigm).toBe("mcp-only");
  });

  it("installServer writes .kilo/kilo.json under 'mcp' with type 'local' and a command ARRAY (delegated kilo backend), NOT the legacy 'mcpServers'", () => {
    const changes = kiloAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".kilo", "kilo.json");
    expect(serverPath).toBe(kiloAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    // vsix 7.3.28 root key is "mcp" (kilo backend), NOT the legacy "mcpServers".
    expect(cfg).toHaveProperty("mcp");
    expect(cfg).not.toHaveProperty("mcpServers");

    const entry = cfg.mcp[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.type).toBe("local");
    // Backend dialect: a single command ARRAY (exe + args folded together).
    expect(Array.isArray(entry.command)).toBe(true);
    expect(entry.command[0]).toBe(HOME_BIN);
    expect(entry.command).toEqual([HOME_BIN, ...wrappedTail("kilo")]);

    // No native interpolation token → env resolves to a LITERAL value.
    expect(entry.environment[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.environment[ENV_VAR]).not.toContain("${");
  });

  it("installServer is idempotent — second call yields skip; uninstall removes it", () => {
    kiloAdapter.installServer(ctx);
    expect(kiloAdapter.installServer(ctx)[0]?.action).toBe("skip");
    kiloAdapter.uninstallServer(ctx);
    const cfg = readJson(join(projectDir, ".kilo", "kilo.json"));
    expect(cfg.mcp?.[CONNECTOR_ID]).toBeUndefined();
  });

  it("installHooks returns exactly ONE skip ChangeRecord and writes NO hook file", () => {
    const changes = kiloAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    const hooksPath = kiloAdapter.getHookConfigPath(ctx);
    expect(hooksPath).toBe(kiloAdapter.getServerConfigPath(ctx));
    expect(existsSync(hooksPath)).toBe(false);
  });

  it("does NOT collide with kilo-cli: same dir + 'mcp' key but DISTINCT filenames for the same connector", () => {
    kiloAdapter.installServer(ctx);
    kiloCliAdapter.installServer(ctx);

    const extPath = join(projectDir, ".kilo", "kilo.json");
    const cliPath = join(projectDir, ".kilo", "kilo.jsonc");
    // Same backend dir, DIFFERENT filenames — they must not converge on one file.
    expect(extPath).not.toBe(cliPath);
    expect(existsSync(extPath)).toBe(true);
    expect(existsSync(cliPath)).toBe(true);

    const ext = readJson(extPath);
    const cli = readJson(cliPath);
    // Both now share the "mcp" key + command-array dialect (the shared backend).
    expect(Array.isArray(ext.mcp[CONNECTOR_ID].command)).toBe(true);
    expect(Array.isArray(cli.mcp[CONNECTOR_ID].command)).toBe(true);
    // But the CLI carries a "plugin" array the extension never writes.
    expect(ext).not.toHaveProperty("plugin");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// OpenCode (ts-plugin) — render + the live bridge
// ─────────────────────────────────────────────────────────────────────────

describe("opencode adapter (ts-plugin) render", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-p3-oc-");
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("installServer writes the opencode.json 'mcp' entry with type 'local' + command ARRAY at the home bin", () => {
    const changes = opencodeAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, "opencode.json");
    expect(serverPath).toBe(opencodeAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    // Root key is "mcp", NOT "mcpServers".
    expect(cfg).toHaveProperty("mcp");
    expect(cfg).not.toHaveProperty("mcpServers");

    const entry = cfg.mcp[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.type).toBe("local");
    expect(Array.isArray(entry.command)).toBe(true);
    expect(entry.command).toEqual([HOME_BIN, ...wrappedTail("opencode")]);

    // No native interpolation token → env resolves to a LITERAL value.
    expect(entry.environment[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.environment[ENV_VAR]).not.toContain("${");
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    opencodeAdapter.installServer(ctx);
    const second = opencodeAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, "opencode.json"));
    expect(Object.keys(cfg.mcp)).toEqual([CONNECTOR_ID]);
  });

  it("uninstallServer removes the entry (re-read confirms gone)", () => {
    opencodeAdapter.installServer(ctx);
    opencodeAdapter.uninstallServer(ctx);

    const cfg = readJson(join(projectDir, "opencode.json"));
    expect(cfg.mcp?.[CONNECTOR_ID]).toBeUndefined();
  });

  it("installHooks writes a plugin .js module into the project .opencode/plugin/ dir", () => {
    const changes = opencodeAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const pluginPath = join(
      projectDir,
      ".opencode",
      "plugin",
      `${CONNECTOR_ID}.js`,
    );
    expect(pluginPath).toBe(opencodeAdapter.getHookConfigPath(ctx));
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
    opencodeAdapter.installHooks(ctx);
    const second = opencodeAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallHooks removes the plugin module (re-read confirms gone)", () => {
    opencodeAdapter.installHooks(ctx);
    const pluginPath = opencodeAdapter.getHookConfigPath(ctx);
    expect(existsSync(pluginPath)).toBe(true);

    opencodeAdapter.uninstallHooks(ctx);
    expect(existsSync(pluginPath)).toBe(false);
  });
});

describe("opencode generated plugin — THE BRIDGE WORKS (live, child_process mocked)", () => {
  let projectDir: string;
  let ctx: InstallContext;
  let pluginPath: string;

  beforeEach(() => {
    projectDir = freshProject("ac-p3-bridge-");
    ctx = buildCtx(projectDir, buildConnector());
    // Write the generated plugin to disk for THIS connector.
    opencodeAdapter.installHooks(ctx);
    pluginPath = opencodeAdapter.getHookConfigPath(ctx);
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

// ─────────────────────────────────────────────────────────────────────────
// OpenCode runtime dispatch — parseEvent + formatReply round-trip
// ─────────────────────────────────────────────────────────────────────────

describe("opencode adapter runtime dispatch", () => {
  it("formatReply returns exit 0 and stdout that JSON-parses to the normalized response", () => {
    const deny: HookResponse = { decision: "deny", reason: "x" };
    const reply = opencodeAdapter.formatReply!("PreToolUse", deny);

    expect(reply.exitCode).toBe(0);
    // Unlike json-stdio hosts, OUR generated bridge consumes this directly — the
    // reply body IS the normalized HookResponse (the bridge JSON.parses it).
    const out = JSON.parse(reply.stdout!);
    expect(out).toEqual({ decision: "deny", reason: "x" });
  });

  it("parseEvent maps a sent bridge payload to a normalized PreToolUse event", () => {
    const evt = opencodeAdapter.parseEvent!("PreToolUse", {
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
