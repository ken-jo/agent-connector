/**
 * adapters/wave2 — render + parse/format round-trip tests for the five Wave-2
 * json-stdio adapters: qwen-code, kiro, jetbrains-copilot, kimi, crush.
 *
 * Each adapter is exercised end-to-end against REAL files on disk, mirroring the
 * established phase2/wave1 pattern, plus a runtime parse/format round-trip:
 *   • installServer  → native MCP registration under the CORRECT root key
 *                      (mcpServers for qwen-code/kiro/kimi; "mcp" for crush;
 *                      jetbrains-copilot writes NOTHING and returns a WARN).
 *   • installHooks   → native hook registration in the right FILE + SHAPE:
 *       qwen-code   → sibling "hooks" key in the SAME settings.json (PascalCase).
 *       kiro        → "hooks" in the agent file kiro_default.json (SessionStart
 *                     → native "agentSpawn").
 *       jetbrains   → .github/hooks/<id>.json with version:1 + FLAT {type,command}.
 *       kimi        → [[hooks]] array-of-tables in config.toml (TOML).
 *       crush       → top-level "hooks" key in crush.json.
 *     Every hook command references the home-bin + connector id.
 *   • idempotency    → second installHooks/installServer → skip, no duplicates.
 *   • uninstall      → entries removed (re-read from disk confirms gone) for the
 *                      file-writing surfaces; anchored-match uninstall (acme vs.
 *                      acme-db) verified for qwen-code.
 *   • parseEvent/formatReply round-trip → a native PreToolUse stdin payload maps
 *     to a normalized PreToolUse event; formatReply({decision:"deny"}) yields the
 *     platform-native deny (exit 2 or a stdout decision per platform).
 *
 * Filesystem isolation: every test gets a fresh os.tmpdir mkdtemp project dir,
 * with HOME + KIMI_CODE_HOME + AGENTCONNECT_DATA_DIR redirected there so any
 * user-scope path (resolved from homedir()/$KIMI_CODE_HOME) lands in the sandbox.
 * All mutated env is restored in afterEach so the suite never leaks state.
 */

import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import TOML from "@iarna/toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { PreToolUseEvent, ResolvedConnector } from "../../src/core/types.js";

import qwenCodeAdapter from "../../src/adapters/qwen-code/index.js";
import kiroAdapter from "../../src/adapters/kiro/index.js";
import jetbrainsCopilotAdapter from "../../src/adapters/jetbrains-copilot/index.js";
import kimiAdapter from "../../src/adapters/kimi/index.js";
import crushAdapter from "../../src/adapters/crush/index.js";

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

const HOME_BIN = "/fake/stable/.agentconnect/bin/agentconnect";
const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const SERVER_CWD = "/srv/acme";
const PRE_MATCHER = "acme_query|acme_write";

// The serve-wrapper args also bake the install TARGET platform as `--host <id>`
// (before `--`) so the proxy stamps hostPlatform under a headless spawn.
const wrappedArgs = (host: string): string[] =>
  ["serve", "--connector", CONNECTOR_ID, "--scope", "project", "--host", host, "--", "npx", "-y", "@x/y"];
// User-scoped adapters (kimi, qwen-code, kiro) stamp `--scope user` instead.
const wrappedArgsUser = (host: string): string[] =>
  ["serve", "--connector", CONNECTOR_ID, "--scope", "user", "--host", host, "--", "npx", "-y", "@x/y"];

/**
 * A connector with a stdio server (env-ref + cwd) + PreToolUse and SessionStart
 * hooks. The PreToolUse + SessionStart pair lets a host that supports SessionStart
 * (qwen-code, kiro, jetbrains) register both, while deny-only hosts (kimi, crush)
 * register PreToolUse only and prove SessionStart is correctly dropped.
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

/** A hooks-only connector (no server) — used for the anchored-uninstall test. */
function buildHooksOnlyConnector(id: string): ResolvedConnector {
  return defineConnector({
    id,
    hooks: {
      PreToolUse: {
        handler() {
          return { decision: "allow" };
        },
      },
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
    dataRoot: join(projectDir, ".agentconnect"),
    dryRun: false,
  };
}

// Track + restore mutated env so the suite never leaks state.
let savedHome: string | undefined;
let savedKimiHome: string | undefined;
let savedDataDir: string | undefined;
let savedEnvVar: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedKimiHome = process.env.KIMI_CODE_HOME;
  savedDataDir = process.env.AGENTCONNECT_DATA_DIR;
  savedEnvVar = process.env[ENV_VAR];
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("KIMI_CODE_HOME", savedKimiHome);
  restore("AGENTCONNECT_DATA_DIR", savedDataDir);
  restore(ENV_VAR, savedEnvVar);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/**
 * Fresh temp project dir + redirect HOME / KIMI_CODE_HOME / data-root there so
 * nothing escapes the sandbox. KIMI_CODE_HOME is pointed at a `.kimi` subdir so
 * the Kimi adapter's user-scope paths resolve inside the temp tree. The env-ref
 * var is set so literal-resolution produces a known value.
 */
function freshProject(prefix = "ac-wave2-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.KIMI_CODE_HOME = join(dir, ".kimi");
  process.env.AGENTCONNECT_DATA_DIR = join(dir, ".agentconnect");
  process.env[ENV_VAR] = ENV_LITERAL;
  return dir;
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readToml(path: string): Record<string, any> {
  return TOML.parse(readFileSync(path, "utf8")) as Record<string, any>;
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

/** Common assertions for a normalized PreToolUse event from a given host. */
function assertPreToolUse(
  ev: PreToolUseEvent,
  hostPlatform: string,
): void {
  expect(ev.hostPlatform).toBe(hostPlatform);
  expect(ev.connectorId).toBe(CONNECTOR_ID);
  expect(ev.toolName).toBe("acme_query");
  expect(ev.toolInput).toEqual({ sql: "SELECT 1" });
}

// ─────────────────────────────────────────────────────────────────────────
// qwen-code  (mcpServers + sibling "hooks" in the SAME settings.json)
// ─────────────────────────────────────────────────────────────────────────

describe("qwen-code adapter render + round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave2-qwen-");
    // user scope → ~/.qwen/settings.json resolves into the HOME sandbox.
    ctx = buildCtx(projectDir, buildConnector(), "user");
  });

  it("installServer writes mcpServers.<id> (type stdio) into ~/.qwen/settings.json, wrapped, env LITERAL", () => {
    const changes = qwenCodeAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".qwen", "settings.json");
    expect(serverPath).toBe(qwenCodeAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.type).toBe("stdio");

    // Telemetry serve-wrapper: command points at the home binary.
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedArgsUser("qwen-code"));

    // Qwen has no ${env:VAR} support → env-ref resolves to a LITERAL value.
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
    expect(entry.cwd).toBe(SERVER_CWD);
  });

  it("installHooks writes the sibling 'hooks' key in the SAME settings.json (PascalCase, nested shape)", () => {
    const changes = qwenCodeAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const settingsPath = join(projectDir, ".qwen", "settings.json");
    expect(settingsPath).toBe(qwenCodeAdapter.getHookConfigPath(ctx));

    const cfg = readJson(settingsPath);
    // PascalCase event keys, identical to Claude — NOT Gemini's BeforeTool.
    const pre = cfg.hooks.PreToolUse;
    expect(Array.isArray(pre)).toBe(true);
    expect(pre[0].matcher).toBe(PRE_MATCHER);
    const cmd = pre[0].hooks[0].command;
    expect(cmd).toContain(HOME_BIN);
    expect(cmd).toContain("hook qwen-code PreToolUse");
    expect(cmd).toContain(`--connector ${CONNECTOR_ID}`);

    // SessionStart is supported and registered under the canonical PascalCase name.
    expect(cfg.hooks.SessionStart[0].hooks[0].command).toContain(
      "hook qwen-code SessionStart",
    );
  });

  it("installServer + installHooks coexist in ONE settings.json; idempotent on a second run", () => {
    qwenCodeAdapter.installServer(ctx);
    qwenCodeAdapter.installHooks(ctx);

    const both = readJson(join(projectDir, ".qwen", "settings.json"));
    expect(both.mcpServers?.[CONNECTOR_ID]).toBeTruthy();
    expect(both.hooks?.PreToolUse).toBeTruthy();

    const secondServer = qwenCodeAdapter.installServer(ctx);
    expect(secondServer[0]?.action).toBe("skip");
    const secondHooks = qwenCodeAdapter.installHooks(ctx);
    expect(secondHooks.every((c) => c.action === "skip")).toBe(true);

    const cfg = readJson(join(projectDir, ".qwen", "settings.json"));
    expect(Object.keys(cfg.mcpServers)).toEqual([CONNECTOR_ID]);
    expect(cfg.hooks.PreToolUse).toHaveLength(1);
    expect(cfg.hooks.SessionStart).toHaveLength(1);
  });

  it("uninstallServer + uninstallHooks remove the entries (re-read confirms gone)", () => {
    qwenCodeAdapter.installServer(ctx);
    qwenCodeAdapter.installHooks(ctx);

    qwenCodeAdapter.uninstallServer(ctx);
    const afterServer = readJson(join(projectDir, ".qwen", "settings.json"));
    expect(afterServer.mcpServers?.[CONNECTOR_ID]).toBeUndefined();
    // Removing the server must not disturb the hooks section.
    expect(afterServer.hooks?.PreToolUse).toBeTruthy();

    qwenCodeAdapter.uninstallHooks(ctx);
    const afterHooks = readJson(join(projectDir, ".qwen", "settings.json"));
    expect(JSON.stringify(afterHooks.hooks ?? {})).not.toContain(HOME_BIN);
  });

  it("uninstallHooks removes via ANCHORED match — uninstalling 'acme' leaves 'acme-db' intact", () => {
    const acme = buildCtx(projectDir, buildHooksOnlyConnector("acme"), "user");
    const acmedb = buildCtx(projectDir, buildHooksOnlyConnector("acme-db"), "user");

    qwenCodeAdapter.installHooks(acme);
    qwenCodeAdapter.installHooks(acmedb);

    const settingsPath = qwenCodeAdapter.getHookConfigPath(acmedb);
    let text = readFileSync(settingsPath, "utf8");
    expect(text).toContain("--connector acme-db");
    expect(text).toContain("--connector acme");

    // Remove only 'acme' — its id is a prefix of 'acme-db'.
    qwenCodeAdapter.uninstallHooks(acme);

    text = readFileSync(settingsPath, "utf8");
    // acme-db must survive; the standalone 'acme' token must be gone.
    expect(text).toContain("--connector acme-db");
    expect(text).not.toContain('--connector acme"');

    // Doctor agrees: acme-db still registered, acme no longer.
    const acmedbHealthy = qwenCodeAdapter
      .getHealthChecks!(acmedb)
      .find((c) => c.name.includes("hook command registered"))!
      .check();
    const acmeHealthy = qwenCodeAdapter
      .getHealthChecks!(acme)
      .find((c) => c.name.includes("hook command registered"))!
      .check();
    expect(acmedbHealthy.status).toBe("OK");
    expect(acmeHealthy.status).toBe("FAIL");
  });

  it("parseEvent yields a normalized PreToolUse; formatReply(deny) → stdout hookSpecificOutput deny, exit 0", () => {
    const ev = qwenCodeAdapter.parseEvent!("PreToolUse", preToolUsePayload()) as PreToolUseEvent;
    assertPreToolUse(ev, "qwen-code");
    expect(ev.sessionId).toBe("sess-123");

    const reply = qwenCodeAdapter.formatReply!("PreToolUse", {
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

// ─────────────────────────────────────────────────────────────────────────
// kiro  (mcpServers in .kiro/settings/mcp.json; hooks in the agent file)
// ─────────────────────────────────────────────────────────────────────────

describe("kiro adapter render + round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave2-kiro-");
    ctx = buildCtx(projectDir, buildConnector(), "user");
  });

  it("installServer writes mcpServers.<id> into ~/.kiro/settings/mcp.json, wrapped, env LITERAL", () => {
    const changes = kiroAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".kiro", "settings", "mcp.json");
    expect(serverPath).toBe(kiroAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    // Kiro stdio entry is { command, args, env, cwd } — no `type` discriminator.
    expect(entry).not.toHaveProperty("type");
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedArgsUser("kiro"));
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.cwd).toBe(SERVER_CWD);
  });

  it("installHooks writes hooks into the agent file kiro_default.json; SessionStart → native 'agentSpawn'", () => {
    const changes = kiroAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const agentPath = join(projectDir, ".kiro", "agents", "kiro_default.json");
    expect(agentPath).toBe(kiroAdapter.getHookConfigPath(ctx));
    expect(existsSync(agentPath)).toBe(true);

    const agent = readJson(agentPath);
    // PreToolUse → native "preToolUse".
    const pre = agent.hooks.preToolUse;
    expect(Array.isArray(pre)).toBe(true);
    expect(pre[0].matcher).toBe(PRE_MATCHER);
    expect(pre[0].hooks[0].command).toContain("hook kiro PreToolUse");
    expect(pre[0].hooks[0].command).toContain(`--connector ${CONNECTOR_ID}`);

    // SessionStart maps to Kiro's native session-start event "agentSpawn".
    expect(agent.hooks.agentSpawn[0].hooks[0].command).toContain(
      "hook kiro SessionStart",
    );
    // The canonical name must NOT leak through as a Kiro hook key.
    expect(agent.hooks.SessionStart).toBeUndefined();
  });

  it("installServer + installHooks idempotent (skip on a second run); uninstall removes both", () => {
    kiroAdapter.installServer(ctx);
    kiroAdapter.installHooks(ctx);

    expect(kiroAdapter.installServer(ctx)[0]?.action).toBe("skip");
    expect(
      kiroAdapter.installHooks(ctx).every((c) => c.action === "skip"),
    ).toBe(true);

    kiroAdapter.uninstallServer(ctx);
    const mcp = readJson(join(projectDir, ".kiro", "settings", "mcp.json"));
    expect(mcp.mcpServers?.[CONNECTOR_ID]).toBeUndefined();

    kiroAdapter.uninstallHooks(ctx);
    const agent = readJson(join(projectDir, ".kiro", "agents", "kiro_default.json"));
    expect(JSON.stringify(agent.hooks ?? {})).not.toContain(HOME_BIN);
  });

  it("parseEvent yields a normalized PreToolUse; formatReply(deny) → exit 2 + reason on stderr", () => {
    const ev = kiroAdapter.parseEvent!("PreToolUse", preToolUsePayload()) as PreToolUseEvent;
    assertPreToolUse(ev, "kiro");
    expect(ev.sessionId).toBe("sess-123");

    // Kiro is exit-code based: deny → exit 2 with the reason on stderr.
    const reply = kiroAdapter.formatReply!("PreToolUse", {
      decision: "deny",
      reason: "blocked by policy",
    });
    expect(reply.exitCode).toBe(2);
    expect(reply.stderr).toBe("blocked by policy");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// jetbrains-copilot  (installServer WARN + writes nothing; hooks .github/hooks)
// ─────────────────────────────────────────────────────────────────────────

describe("jetbrains-copilot adapter render + round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave2-jetbrains-");
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("installServer returns a WARN ChangeRecord and writes NO MCP file (UI-managed)", () => {
    const changes = jetbrainsCopilotAdapter.installServer(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("Settings");

    // No bogus MCP file is created anywhere under the project tree.
    expect(existsSync(join(projectDir, ".vscode", "mcp.json"))).toBe(false);
    expect(existsSync(join(projectDir, "mcp.json"))).toBe(false);
    // getServerConfigPath aliases the hooks path; installServer never wrote there.
    expect(existsSync(jetbrainsCopilotAdapter.getServerConfigPath(ctx))).toBe(false);
  });

  it("installHooks writes .github/hooks/<id>.json with version:1 + FLAT { type, command }", () => {
    const changes = jetbrainsCopilotAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const hooksPath = join(projectDir, ".github", "hooks", `${CONNECTOR_ID}.json`);
    expect(hooksPath).toBe(jetbrainsCopilotAdapter.getHookConfigPath(ctx));
    expect(existsSync(hooksPath)).toBe(true);

    const cfg = readJson(hooksPath);
    // The required top-level version — a version-less file is rejected by Copilot.
    expect(cfg.version).toBe(1);

    // FLAT { type, command } entries (no Claude-style { matcher, hooks:[...] }).
    const pre = cfg.hooks.PreToolUse;
    expect(Array.isArray(pre)).toBe(true);
    expect(pre[0].type).toBe("command");
    expect(pre[0]).not.toHaveProperty("matcher");
    expect(pre[0].command).toContain(HOME_BIN);
    expect(pre[0].command).toContain("hook jetbrains-copilot PreToolUse");
    expect(pre[0].command).toContain(`--connector ${CONNECTOR_ID}`);

    // SessionStart is in JetBrains' supported event set and is registered too.
    expect(cfg.hooks.SessionStart[0].command).toContain(
      "hook jetbrains-copilot SessionStart",
    );
  });

  it("installHooks is idempotent; uninstallHooks removes our entries (re-read confirms gone)", () => {
    jetbrainsCopilotAdapter.installHooks(ctx);
    const second = jetbrainsCopilotAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    const hooksPath = join(projectDir, ".github", "hooks", `${CONNECTOR_ID}.json`);
    const cfg = readJson(hooksPath);
    expect(cfg.hooks.PreToolUse).toHaveLength(1);

    jetbrainsCopilotAdapter.uninstallHooks(ctx);
    // The connector-owned file is DELETED (not left as an empty shell), so it
    // no longer exists to re-read.
    expect(existsSync(hooksPath)).toBe(false);
  });

  // CLEAN-UNINSTALL (D2): the hook file is connector-OWNED
  // (<connector-id>.json). When uninstall empties it, the whole file must be
  // DELETED — NOT rewritten as a `{ "hooks": {}, "version": 1 }` orphan shell.
  it("install then uninstall leaves NO file at .github/hooks/<id>.json (no empty shell)", () => {
    const hooksPath = join(projectDir, ".github", "hooks", `${CONNECTOR_ID}.json`);

    jetbrainsCopilotAdapter.installHooks(ctx);
    expect(existsSync(hooksPath)).toBe(true);

    const changes = jetbrainsCopilotAdapter.uninstallHooks(ctx);
    // The file is gone entirely — not an empty shell.
    expect(existsSync(hooksPath)).toBe(false);
    // A remove ChangeRecord for the file was emitted.
    expect(
      changes.some((c) => c.action === "remove" && c.path === hooksPath),
    ).toBe(true);
  });

  it("dryRun uninstall reports the would-be remove but leaves the file in place", () => {
    const hooksPath = join(projectDir, ".github", "hooks", `${CONNECTOR_ID}.json`);
    jetbrainsCopilotAdapter.installHooks(ctx);
    expect(existsSync(hooksPath)).toBe(true);

    const dryCtx: InstallContext = { ...ctx, dryRun: true };
    const changes = jetbrainsCopilotAdapter.uninstallHooks(dryCtx);
    // Reports the remove…
    expect(
      changes.some((c) => c.action === "remove" && c.path === hooksPath),
    ).toBe(true);
    // …but the filesystem is untouched.
    expect(existsSync(hooksPath)).toBe(true);
  });

  it("parseEvent yields a normalized PreToolUse; formatReply(deny) → stdout hookSpecificOutput deny, exit 0", () => {
    const ev = jetbrainsCopilotAdapter.parseEvent!(
      "PreToolUse",
      preToolUsePayload(),
    ) as PreToolUseEvent;
    assertPreToolUse(ev, "jetbrains-copilot");

    const reply = jetbrainsCopilotAdapter.formatReply!("PreToolUse", {
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

// ─────────────────────────────────────────────────────────────────────────
// kimi  (mcpServers in mcp.json; [[hooks]] array-of-tables in config.toml)
// ─────────────────────────────────────────────────────────────────────────

describe("kimi adapter render + round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave2-kimi-");
    // Kimi is user-scoped via $KIMI_CODE_HOME (set by freshProject to <dir>/.kimi).
    ctx = buildCtx(projectDir, buildConnector(), "user");
  });

  it("installServer writes mcpServers.<id> into $KIMI_CODE_HOME/mcp.json, wrapped, env LITERAL", () => {
    const changes = kimiAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".kimi", "mcp.json");
    expect(serverPath).toBe(kimiAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedArgsUser("kimi"));
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installHooks writes a [[hooks]] table in config.toml (TOML); SessionStart dropped (PreToolUse only)", () => {
    const changes = kimiAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const hookPath = join(projectDir, ".kimi", "config.toml");
    expect(hookPath).toBe(kimiAdapter.getHookConfigPath(ctx));
    expect(existsSync(hookPath)).toBe(true);

    const cfg = readToml(hookPath);
    expect(Array.isArray(cfg.hooks)).toBe(true);
    // Kimi honors PreToolUse ONLY — SessionStart must not be registered.
    expect(cfg.hooks).toHaveLength(1);
    const entry = cfg.hooks[0];
    expect(entry.event).toBe("PreToolUse");
    expect(entry.command).toContain(HOME_BIN);
    expect(entry.command).toContain("hook kimi PreToolUse");
    expect(entry.command).toContain(`--connector ${CONNECTOR_ID}`);
  });

  it("installHooks is idempotent (skip on second run); uninstallHooks removes the [[hooks]] table", () => {
    kimiAdapter.installHooks(ctx);
    const second = kimiAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    const hookPath = join(projectDir, ".kimi", "config.toml");
    expect(readToml(hookPath).hooks).toHaveLength(1);

    kimiAdapter.uninstallHooks(ctx);
    const after = readToml(hookPath);
    // The hooks key is dropped entirely once our only entry is removed.
    expect(after.hooks).toBeUndefined();
  });

  it("installServer idempotent; uninstallServer removes the entry (re-read confirms gone)", () => {
    kimiAdapter.installServer(ctx);
    expect(kimiAdapter.installServer(ctx)[0]?.action).toBe("skip");

    kimiAdapter.uninstallServer(ctx);
    const cfg = readJson(join(projectDir, ".kimi", "mcp.json"));
    expect(cfg.mcpServers?.[CONNECTOR_ID]).toBeUndefined();
  });

  it("parseEvent yields a normalized PreToolUse; formatReply(deny) → exit 2 + reason on stdout", () => {
    const ev = kimiAdapter.parseEvent!("PreToolUse", preToolUsePayload()) as PreToolUseEvent;
    assertPreToolUse(ev, "kimi");
    expect(ev.sessionId).toBe("sess-123");

    // Kimi Code uses the Claude/Codex deny shape: exit 0 + hookSpecificOutput
    // permissionDecision:"deny" on stdout (NOT exit 2 + bare reason).
    const reply = kimiAdapter.formatReply!("PreToolUse", {
      decision: "deny",
      reason: "blocked by policy",
    });
    expect(reply.exitCode).toBe(0);
    const out = JSON.parse(reply.stdout ?? "{}");
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("blocked by policy");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// crush  (root key "mcp" in crush.json; top-level "hooks" key in the same file)
// ─────────────────────────────────────────────────────────────────────────

describe("crush adapter render + round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave2-crush-");
    ctx = buildCtx(projectDir, buildConnector());
  });

  it('installServer writes the entry under ROOT KEY "mcp" (NOT "mcpServers") into .crush.json, wrapped, env LITERAL', () => {
    const changes = crushAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".crush.json");
    expect(serverPath).toBe(crushAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    // ROOT KEY is "mcp" — Crush's quirk vs. the "mcpServers" of Claude/Gemini.
    expect(cfg).toHaveProperty("mcp");
    expect(cfg).not.toHaveProperty("mcpServers");

    const entry = cfg.mcp[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.type).toBe("stdio");
    expect(entry.disabled).toBe(false);
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedArgs("crush"));
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installHooks writes the top-level 'hooks' key in crush.json; SessionStart dropped (PreToolUse only)", () => {
    const changes = crushAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const hookPath = join(projectDir, ".crush.json");
    expect(hookPath).toBe(crushAdapter.getHookConfigPath(ctx));

    const cfg = readJson(hookPath);
    const pre = cfg.hooks.PreToolUse;
    expect(Array.isArray(pre)).toBe(true);
    expect(pre[0].matcher).toBe(PRE_MATCHER);
    expect(pre[0].command).toContain(HOME_BIN);
    expect(pre[0].command).toContain("hook crush PreToolUse");
    expect(pre[0].command).toContain(`--connector ${CONNECTOR_ID}`);

    // Crush honors PreToolUse ONLY — SessionStart must not be registered.
    expect(cfg.hooks.SessionStart).toBeUndefined();
  });

  it("server + hooks coexist in ONE crush.json; both idempotent; uninstall removes both", () => {
    crushAdapter.installServer(ctx);
    crushAdapter.installHooks(ctx);

    const both = readJson(join(projectDir, ".crush.json"));
    expect(both.mcp?.[CONNECTOR_ID]).toBeTruthy();
    expect(both.hooks?.PreToolUse).toBeTruthy();

    expect(crushAdapter.installServer(ctx)[0]?.action).toBe("skip");
    expect(
      crushAdapter.installHooks(ctx).every((c) => c.action === "skip"),
    ).toBe(true);

    crushAdapter.uninstallServer(ctx);
    const afterServer = readJson(join(projectDir, ".crush.json"));
    expect(afterServer.mcp?.[CONNECTOR_ID]).toBeUndefined();
    // Removing the server must not disturb the hooks section.
    expect(afterServer.hooks?.PreToolUse).toBeTruthy();

    crushAdapter.uninstallHooks(ctx);
    const afterHooks = readJson(join(projectDir, ".crush.json"));
    expect(JSON.stringify(afterHooks.hooks ?? {})).not.toContain(HOME_BIN);
  });

  it("parseEvent yields a normalized PreToolUse; formatReply(deny) → stdout {decision:'deny'}, exit 0", () => {
    const ev = crushAdapter.parseEvent!("PreToolUse", preToolUsePayload()) as PreToolUseEvent;
    assertPreToolUse(ev, "crush");
    expect(ev.sessionId).toBe("sess-123");

    // Crush deny → stdout JSON { decision:"deny", reason } at exit 0.
    const reply = crushAdapter.formatReply!("PreToolUse", {
      decision: "deny",
      reason: "blocked by policy",
    });
    expect(reply.exitCode).toBe(0);
    const out = JSON.parse(reply.stdout!);
    expect(out.decision).toBe("deny");
    expect(out.reason).toBe("blocked by policy");
  });
});
