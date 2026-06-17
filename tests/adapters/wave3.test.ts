/**
 * adapters/wave3 — render + parse/format round-trip tests for the Wave-3
 * YAML-native adapter hermes. (goose now lives in adapters/goose.test.ts.)
 *
 * hermes stores config in YAML (not JSON), so it bypasses BaseAdapter's JSON
 * helpers and merges through core/yaml's readYaml/writeYaml — mirroring how the
 * Codex adapter layers its upsert over @iarna/toml. The adapter is exercised
 * end-to-end against REAL files on disk:
 *
 *   hermes:
 *     • installServer  → ~/.hermes/config.yaml, ROOT KEY "mcp_servers", portable
 *                        { command, args, env } entry (assert YAML parse).
 *     • installHooks   → the SAME config.yaml, top-level "hooks" map (assert YAML
 *                        parse); each entry { matcher, command, timeout }.
 *     • idempotency    → a second install → skip, no duplicate entries.
 *     • uninstall      → entries removed (re-read from disk confirms gone).
 *     • MERGE          → an unrelated, pre-authored YAML key survives install.
 *     • parseEvent/formatReply → a native PreToolUse stdin payload normalizes to a
 *       PreToolUse event; formatReply({decision:"deny"}) → stdout hookSpecificOutput
 *       deny at exit 0.
 *
 * Filesystem isolation: each test gets a fresh os.tmpdir mkdtemp dir, with HOME
 * redirected there so every user-scope path (resolved from homedir()) lands in
 * the sandbox. All mutated env is restored in afterEach so the suite never leaks.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parse as parseYaml } from "yaml";
import { ensureDir } from "../../src/core/paths.js";
import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { PreToolUseEvent, ResolvedConnector } from "../../src/core/types.js";

import hermesAdapter from "../../src/adapters/hermes/index.js";

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const SERVER_CWD = "/srv/acme";
const PRE_MATCHER = "acme_query|acme_write";

// The serve-wrapper args also bake the install TARGET platform as `--host <id>`
// (before `--`) so the proxy stamps hostPlatform under a headless spawn.
const wrappedArgs = (host: string): string[] =>
  ["serve", "--connector", CONNECTOR_ID, "--scope", "user", "--host", host, "--", "npx", "-y", "@x/y"];

/**
 * A connector with a stdio server (env-ref) + PreToolUse and SessionStart hooks.
 * Both goose and hermes support PreToolUse + SessionStart, so both register the
 * pair; the deny round-trip exercises PreToolUse.
 */
function buildConnector(id = CONNECTOR_ID): ResolvedConnector {
  return defineConnector({
    id,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@x/y"],
      env: { [ENV_VAR]: `\${env:${ENV_VAR}}` },
      cwd: SERVER_CWD,
      tools: { include: ["*"] },
    },
    hooks: {
      PreToolUse: {
        matcher: PRE_MATCHER,
        handler() {
          return { decision: "allow" };
        },
      },
      SessionStart: {
        handler() {
          return { decision: "context", additionalContext: "hello" };
        },
      },
    },
  });
}

/** Build an InstallContext scoped to a fresh temp project dir (user scope). */
function buildCtx(
  projectDir: string,
  connector: ResolvedConnector,
  scope: InstallContext["scope"] = "user",
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
let savedEnvVar: string | undefined;
let savedAppData: string | undefined;
let savedLocalAppData: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
  savedEnvVar = process.env[ENV_VAR];
  savedAppData = process.env.APPDATA;
  savedLocalAppData = process.env.LOCALAPPDATA;
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("USERPROFILE", savedUserProfile);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
  restore(ENV_VAR, savedEnvVar);
  restore("APPDATA", savedAppData);
  restore("LOCALAPPDATA", savedLocalAppData);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/**
 * Fresh temp project dir + redirect HOME (and USERPROFILE for homedir() on some
 * platforms) + data-root there so nothing escapes the sandbox. The env-ref var is
 * set so literal-resolution produces a known value.
 */
function freshProject(prefix = "ac-wave3-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  // Goose uses %APPDATA%/Block/goose on Windows — isolate it (and LOCALAPPDATA)
  // into the sandbox so the test never reads or pollutes the real user AppData.
  process.env.APPDATA = join(dir, "AppData", "Roaming");
  process.env.LOCALAPPDATA = join(dir, "AppData", "Local");
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  process.env[ENV_VAR] = ENV_LITERAL;
  return dir;
}

/** Read + parse a YAML file from disk (independent of the adapter's readYaml). */
function readYamlFile(path: string): Record<string, any> {
  return parseYaml(readFileSync(path, "utf8")) as Record<string, any>;
}

/** A representative native PreToolUse hook stdin payload (Claude-style fields). */
function preToolUsePayload(): Record<string, unknown> {
  return {
    session_id: "sess-123",
    cwd: "/work/proj",
    hook_event_name: "PreToolUse",
    tool_name: "acme_query",
    tool_input: { sql: "SELECT 1" },
    connector: CONNECTOR_ID,
  };
}

function assertPreToolUse(ev: PreToolUseEvent, hostPlatform: string): void {
  expect(ev.hostPlatform).toBe(hostPlatform);
  expect(ev.connectorId).toBe(CONNECTOR_ID);
  expect(ev.toolName).toBe("acme_query");
  expect(ev.toolInput).toEqual({ sql: "SELECT 1" });
}

/** Plant a YAML file at `path` with an unrelated user-authored key (MERGE test). */
function seedUnrelatedYaml(path: string): void {
  ensureDir(dirname(path));
  writeFileSync(
    path,
    "user_setting: keep-me\nother:\n  nested: true\n",
    "utf8",
  );
}

// ─────────────────────────────────────────────────────────────────────────
// hermes  (mcp_servers + hooks both in the SAME YAML ~/.hermes/config.yaml)
// ─────────────────────────────────────────────────────────────────────────

describe("hermes adapter render + round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave3-hermes-");
    ctx = buildCtx(projectDir, buildConnector(), "user");
  });

  it('installServer writes ROOT KEY "mcp_servers".<id> into ~/.hermes/config.yaml (YAML, portable command/args/env)', () => {
    const changes = hermesAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".hermes", "config.yaml");
    expect(serverPath).toBe(hermesAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    // The on-disk file is valid YAML (independent parse).
    const cfg = readYamlFile(serverPath);
    expect(cfg).toHaveProperty("mcp_servers");
    expect(cfg).not.toHaveProperty("mcpServers");

    const entry = cfg.mcp_servers[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    // Hermes uses the portable field names (command/args/env), unlike Goose.
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedArgs("hermes"));
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it('installHooks writes the top-level "hooks" map into the SAME config.yaml (YAML, {matcher,command,timeout})', () => {
    const changes = hermesAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const hookPath = join(projectDir, ".hermes", "config.yaml");
    expect(hookPath).toBe(hermesAdapter.getHookConfigPath(ctx));
    expect(existsSync(hookPath)).toBe(true);

    const cfg = readYamlFile(hookPath);
    // Hermes keys its hooks map by NATIVE snake_case event names (pre_tool_call /
    // on_session_start), NOT the canonical PascalCase names; the command keeps
    // the canonical event token so the runtime dispatcher stays consistent.
    const pre = cfg.hooks.pre_tool_call;
    expect(Array.isArray(pre)).toBe(true);
    expect(cfg.hooks.PreToolUse).toBeUndefined();
    expect(pre[0].matcher).toBe(PRE_MATCHER);
    expect(pre[0].command).toContain(HOME_BIN);
    expect(pre[0].command).toContain("hook hermes PreToolUse");
    expect(pre[0].command).toContain(`--connector ${CONNECTOR_ID}`);
    expect(typeof pre[0].timeout).toBe("number");

    // SessionStart is supported and registered under the native on_session_start key.
    expect(cfg.hooks.on_session_start[0].command).toContain("hook hermes SessionStart");
  });

  it("server + hooks coexist in ONE config.yaml; both idempotent; uninstall removes both", () => {
    hermesAdapter.installServer(ctx);
    hermesAdapter.installHooks(ctx);

    const serverPath = join(projectDir, ".hermes", "config.yaml");
    const both = readYamlFile(serverPath);
    expect(both.mcp_servers?.[CONNECTOR_ID]).toBeTruthy();
    expect(both.hooks?.pre_tool_call).toBeTruthy();

    expect(hermesAdapter.installServer(ctx)[0]?.action).toBe("skip");
    expect(hermesAdapter.installHooks(ctx).every((c) => c.action === "skip")).toBe(true);

    // No duplicate entries after the second run.
    const cfg = readYamlFile(serverPath);
    expect(Object.keys(cfg.mcp_servers)).toEqual([CONNECTOR_ID]);
    expect(cfg.hooks.pre_tool_call).toHaveLength(1);
    expect(cfg.hooks.on_session_start).toHaveLength(1);

    hermesAdapter.uninstallServer(ctx);
    const afterServer = readYamlFile(serverPath);
    expect(afterServer.mcp_servers?.[CONNECTOR_ID]).toBeUndefined();
    // Removing the server must not disturb the hooks section.
    expect(afterServer.hooks?.pre_tool_call).toBeTruthy();

    hermesAdapter.uninstallHooks(ctx);
    const afterHooks = readYamlFile(serverPath);
    expect(JSON.stringify(afterHooks.hooks ?? {})).not.toContain(HOME_BIN);
  });

  it("MERGE: a pre-authored unrelated YAML key survives installServer + installHooks", () => {
    const serverPath = join(projectDir, ".hermes", "config.yaml");
    seedUnrelatedYaml(serverPath);

    hermesAdapter.installServer(ctx);
    hermesAdapter.installHooks(ctx);

    const cfg = readYamlFile(serverPath);
    expect(cfg.mcp_servers?.[CONNECTOR_ID]).toBeTruthy();
    expect(cfg.hooks?.pre_tool_call).toBeTruthy();
    // The user's unrelated keys are untouched.
    expect(cfg.user_setting).toBe("keep-me");
    expect(cfg.other).toEqual({ nested: true });
  });

  it("parseEvent yields a normalized PreToolUse; formatReply(deny) → stdout hookSpecificOutput deny, exit 0", () => {
    const ev = hermesAdapter.parseEvent!("PreToolUse", preToolUsePayload()) as PreToolUseEvent;
    assertPreToolUse(ev, "hermes");
    expect(ev.sessionId).toBe("sess-123");

    const reply = hermesAdapter.formatReply!("PreToolUse", {
      decision: "deny",
      reason: "blocked by policy",
    });
    expect(reply.exitCode).toBe(0);
    const out = JSON.parse(reply.stdout!);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("blocked by policy");
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  });
});
