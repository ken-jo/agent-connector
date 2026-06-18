/**
 * adapters/phase2-render — render + round-trip tests for gemini-cli.
 *
 * Exercises the full install/uninstall path end-to-end against REAL files on disk:
 *   • installServer  → native MCP registration (correct ROOT KEY / fields / shape)
 *   • installHooks   → native hook registration (per-dialect event names + shape)
 *   • env-ref handling per platform (native ${env:VAR} token vs. resolved literal)
 *   • telemetry serve-wrapper command points at the stable home binary
 *   • idempotency (second installServer → "skip", no duplicates)
 *   • uninstall (entries removed; re-read from disk confirms gone)
 *
 * (warp — the mcp-only host — now lives in its own per-host file
 * tests/adapters/warp.test.ts; vscode-copilot's and copilot-cli's slices were
 * migrated to their per-host files tests/adapters/vscode-copilot.test.ts and
 * tests/adapters/copilot-cli.test.ts.)
 *
 * Filesystem isolation: every test gets a fresh os.tmpdir mkdtemp project dir, and
 * HOME is redirected there so homedir()-based path resolution stays in the sandbox
 * — never the real home. HOME and AGENT_CONNECTOR_DATA_DIR are restored in afterEach.
 */

import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import geminiCliAdapter from "../../src/adapters/gemini-cli/index.js";

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const SERVER_CWD = "/srv/acme";

/** A connector with a stdio server (env-ref + cwd) + PreToolUse and SessionStart hooks. */
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
      cwd: SERVER_CWD,
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
 * Fresh temp project dir + redirect HOME/data-root there so nothing escapes —
 * pointing HOME at a temp dir keeps any homedir()-based resolution in the sandbox.
 */
function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-p2-render-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  // Set the env-ref var so literal-resolution produces a known value.
  process.env[ENV_VAR] = ENV_LITERAL;
  return dir;
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * The serve-wrapper args also bake the install TARGET platform as `--host <id>`
 * (before the `--` separator) so the proxy stamps hostPlatform correctly under a
 * headless spawn. The id differs per adapter, so build it per call.
 */
const wrappedArgs = (host: string): string[] => [
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
// Gemini CLI
// ─────────────────────────────────────────────────────────────────────────

describe("gemini-cli adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("installServer writes mcpServers.<id> with command/args (stdio by key, no `type`), env as LITERAL", () => {
    const changes = geminiCliAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".gemini", "settings.json");
    expect(serverPath).toBe(geminiCliAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry).toBeTruthy();

    // Gemini selects transport BY KEY (command/args), not a `type` field.
    expect(entry).not.toHaveProperty("type");
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedArgs("gemini-cli"));

    // No native ${env:VAR} support → env-ref resolves to a LITERAL value.
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installHooks writes the top-level `hooks` key in the SAME settings.json using Gemini event names", () => {
    const changes = geminiCliAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const settingsPath = join(projectDir, ".gemini", "settings.json");
    expect(settingsPath).toBe(geminiCliAdapter.getHookConfigPath(ctx));

    const cfg = readJson(settingsPath);

    // PreToolUse → BeforeTool (Gemini's distinct event vocabulary).
    const before = cfg.hooks.BeforeTool;
    expect(Array.isArray(before)).toBe(true);
    expect(before[0].matcher).toBe("acme_query|acme_write");
    const cmd = before[0].hooks[0].command;
    expect(cmd).toContain(HOME_BIN);
    expect(cmd).toContain("hook gemini-cli PreToolUse");
    expect(cmd).toContain(`--connector ${CONNECTOR_ID}`);

    // SessionStart maps 1:1 to Gemini's SessionStart.
    expect(cfg.hooks.SessionStart[0].hooks[0].command).toContain(
      "hook gemini-cli SessionStart",
    );
    // The Claude-style PreToolUse key must NOT appear (renamed to BeforeTool).
    expect(cfg.hooks.PreToolUse).toBeUndefined();
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    geminiCliAdapter.installServer(ctx);
    const second = geminiCliAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".gemini", "settings.json"));
    expect(Object.keys(cfg.mcpServers)).toEqual([CONNECTOR_ID]);
  });

  it("installHooks is idempotent — second call yields skip and does not duplicate entries", () => {
    geminiCliAdapter.installHooks(ctx);
    const second = geminiCliAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    const cfg = readJson(join(projectDir, ".gemini", "settings.json"));
    expect(cfg.hooks.BeforeTool).toHaveLength(1);
    expect(cfg.hooks.SessionStart).toHaveLength(1);
  });

  it("server + hooks coexist in the SAME settings.json; uninstall removes both (re-read confirms gone)", () => {
    geminiCliAdapter.installServer(ctx);
    geminiCliAdapter.installHooks(ctx);

    // Both sections live in one file.
    const both = readJson(join(projectDir, ".gemini", "settings.json"));
    expect(both.mcpServers?.[CONNECTOR_ID]).toBeTruthy();
    expect(both.hooks?.BeforeTool).toBeTruthy();

    geminiCliAdapter.uninstallServer(ctx);
    const afterServer = readJson(join(projectDir, ".gemini", "settings.json"));
    expect(afterServer.mcpServers?.[CONNECTOR_ID]).toBeUndefined();
    // Removing the server must not disturb the hooks section.
    expect(afterServer.hooks?.BeforeTool).toBeTruthy();

    geminiCliAdapter.uninstallHooks(ctx);
    const afterHooks = readJson(join(projectDir, ".gemini", "settings.json"));
    expect(JSON.stringify(afterHooks.hooks ?? {})).not.toContain(HOME_BIN);
  });
});
