/**
 * adapters/wave2 — render + parse/format round-trip tests for the Wave-2
 * json-stdio adapters: jetbrains-copilot.
 *
 * (qwen-code's render/round-trip slice was migrated to
 * tests/adapters/qwen-code.test.ts, kimi's to tests/adapters/kimi.test.ts,
 * crush's to tests/adapters/crush.test.ts, and kiro's to
 * tests/adapters/kiro.test.ts, per the ONE-file-per-host convention —
 * see tests/README.md.)
 *
 * Each adapter is exercised end-to-end against REAL files on disk, mirroring the
 * established phase2/wave1 pattern, plus a runtime parse/format round-trip:
 *   • installServer  → native MCP registration under the CORRECT root key
 *                      (jetbrains-copilot writes NOTHING and returns a WARN).
 *   • installHooks   → native hook registration in the right FILE + SHAPE:
 *       jetbrains   → .github/hooks/<id>.json with version:1 + FLAT {type,command}.
 *     Every hook command references the home-bin + connector id.
 *   • idempotency    → second installHooks/installServer → skip, no duplicates.
 *   • uninstall      → entries removed (re-read from disk confirms gone) for the
 *                      file-writing surfaces.
 *   • parseEvent/formatReply round-trip → a native PreToolUse stdin payload maps
 *     to a normalized PreToolUse event; formatReply({decision:"deny"}) yields the
 *     platform-native deny (exit 2 or a stdout decision per platform).
 *
 * Filesystem isolation: every test gets a fresh os.tmpdir mkdtemp project dir,
 * with HOME + AGENT_CONNECTOR_DATA_DIR redirected there so any user-scope path
 * (resolved from homedir()) lands in the sandbox. All mutated env is restored in
 * afterEach so the suite never leaks state.
 */

import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { PreToolUseEvent, ResolvedConnector } from "../../src/core/types.js";

import jetbrainsCopilotAdapter from "../../src/adapters/jetbrains-copilot/index.js";

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const SERVER_CWD = "/srv/acme";
const PRE_MATCHER = "acme_query|acme_write";

/**
 * A connector with a stdio server (env-ref + cwd) + PreToolUse and SessionStart
 * hooks. The PreToolUse + SessionStart pair lets a host that supports SessionStart
 * (jetbrains) register both.
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
    dataRoot: join(projectDir, ".agent-connector"),
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

/**
 * Fresh temp project dir + redirect HOME / data-root there so nothing escapes the
 * sandbox. The env-ref var is set so literal-resolution produces a known value.
 */
function freshProject(prefix = "ac-wave2-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  process.env[ENV_VAR] = ENV_LITERAL;
  return dir;
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
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
