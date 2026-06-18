/**
 * adapters/review-fixes — regression tests for the independent-review defect fixes.
 *
 * Each describe block pins one ROOT-CAUSE fix so a regression re-breaks loudly:
 *   • JSONC clobber — zed preserves sibling keys when the settings file
 *     carries a // comment (the data-loss bug before the parseJsonc fix).
 *   • overwrite guard — a present, non-empty, TRULY-malformed settings file is
 *     left untouched (a "warn"), never blanked to {}.
 *   • kimi — deny uses the Claude/Codex hookSpecificOutput shape (exit 0); the
 *     base dir defaults to ~/.kimi (live-confirmed), honoring $KIMI_HOME / $KIMI_CODE_HOME.
 *
 * (The openclaw parseJsonc-tolerance + dual-registration block has moved to the
 * per-host file adapters/openclaw.test.ts, the omp modify-degrades-to-allow block
 * to adapters/omp.test.ts, and the qwen-code remote-transport-key block to
 * adapters/qwen-code.test.ts, per tests/README.md.)
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDir } from "../../src/core/paths.js";
import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { PreToolUseEvent, ResolvedConnector } from "../../src/core/types.js";

import zedAdapter from "../../src/adapters/zed/index.js";
import codebuffAdapter from "../../src/adapters/codebuff/index.js";
import kimiAdapter from "../../src/adapters/kimi/index.js";
import rooCodeAdapter from "../../src/adapters/roo-code/index.js";

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-db";

function buildConnector(
  overrides: Partial<Parameters<typeof defineConnector>[0]> = {},
): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@x/y"],
    },
    hooks: {
      PreToolUse: { handler: () => ({ decision: "allow" }) },
      SessionStart: { handler: () => ({ decision: "allow" }) },
    },
    ...overrides,
  });
}

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

let savedHome: string | undefined;
let savedDataDir: string | undefined;
let savedKimiHome: string | undefined;
let savedKimiHomeNew: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
  savedKimiHome = process.env.KIMI_CODE_HOME;
  savedKimiHomeNew = process.env.KIMI_HOME;
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
  restore("KIMI_CODE_HOME", savedKimiHome);
  restore("KIMI_HOME", savedKimiHomeNew);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function freshProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  delete process.env.KIMI_CODE_HOME;
  delete process.env.KIMI_HOME;
  return dir;
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ─────────────────────────────────────────────────────────────────────────
// JSONC clobber — sibling keys must SURVIVE when the file has comments
// ─────────────────────────────────────────────────────────────────────────

describe("JSONC clobber: zed settings.json with a // comment + sibling key", () => {
  it("preserves the sibling key and adds our entry (no data loss)", () => {
    const projectDir = freshProject("ac-rf-zed-");
    const ctx = buildCtx(projectDir, buildConnector());
    const settingsPath = zedAdapter.getServerConfigPath(ctx);

    // Pre-write a JSONC file: a // comment + an UNRELATED sibling key.
    ensureDir(join(projectDir, ".zed"));
    writeFileSync(
      settingsPath,
      `{
        // user's editor theme — must survive our merge
        "theme": "Ayu Dark",
        "context_servers": {
          "user-owned": { "command": "/bin/echo" }
        },
      }`,
      "utf8",
    );

    const changes = zedAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const cfg = readJson(settingsPath);
    // The unrelated sibling key SURVIVES (before the fix it was clobbered to {}).
    expect(cfg.theme).toBe("Ayu Dark");
    // The user's own context server SURVIVES.
    expect(cfg.context_servers["user-owned"]).toBeTruthy();
    // Our entry was added.
    expect(cfg.context_servers[CONNECTOR_ID]).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Overwrite guard — a TRULY-malformed file is NOT blanked
// ─────────────────────────────────────────────────────────────────────────

describe("overwrite guard: present, non-empty, TRULY-malformed settings file", () => {
  it("installServer returns a 'warn' and does NOT blank the file", () => {
    const projectDir = freshProject("ac-rf-guard-");
    const ctx = buildCtx(projectDir, buildConnector());
    const settingsPath = zedAdapter.getServerConfigPath(ctx);

    // Not just JSONC — genuinely broken JSON that even stripping cannot rescue.
    const malformed = `{ "theme": "dark", this is broken <<<< not json`;
    ensureDir(join(projectDir, ".zed"));
    writeFileSync(settingsPath, malformed, "utf8");

    const changes = zedAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("not parseable");

    // The original bytes are UNTOUCHED — never replaced with {}-based output.
    expect(readFileSync(settingsPath, "utf8")).toBe(malformed);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// kimi — deny protocol + base dir
// ─────────────────────────────────────────────────────────────────────────

describe("kimi deny protocol + base dir", () => {
  it("formatReply(deny) yields exit 0 + hookSpecificOutput permissionDecision 'deny'", () => {
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

  it("allow → exit 0 with empty stdout", () => {
    const reply = kimiAdapter.formatReply!("PreToolUse", { decision: "allow" });
    expect(reply.exitCode).toBe(0);
    expect(reply.stdout).toBeUndefined();
  });

  it("baseDir defaults to ~/.kimi (live-confirmed real Kimi CLI path, NOT ~/.kimi-code) when no env override is set", () => {
    const projectDir = freshProject("ac-rf-kimi-");
    delete process.env.KIMI_HOME;
    delete process.env.KIMI_CODE_HOME;
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    // HOME is redirected to projectDir, so the base dir resolves into the sandbox.
    const serverPath = kimiAdapter.getServerConfigPath(ctx);
    expect(serverPath).toBe(join(projectDir, ".kimi", "mcp.json"));
    expect(serverPath).not.toContain(".kimi-code");
  });

  it("baseDir honors $KIMI_CODE_HOME when set", () => {
    const projectDir = freshProject("ac-rf-kimi2-");
    const custom = join(projectDir, "custom-kimi");
    process.env.KIMI_CODE_HOME = custom;
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    expect(kimiAdapter.getServerConfigPath(ctx)).toBe(join(custom, "mcp.json"));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// codebuff — ${env:VAR:-fallback} default must NOT be dropped
// ─────────────────────────────────────────────────────────────────────────

describe("codebuff env-ref default is preserved (not dropped)", () => {
  const VAR = "AC_RF_CB_VAR";
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[VAR];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[VAR];
    else process.env[VAR] = saved;
  });

  it("resolves to the fallback literal when unset; native $VAR token when no default", () => {
    const projectDir = freshProject("ac-rf-cbdef-");
    delete process.env[VAR];
    const connector = buildConnector({
      server: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@x/y"],
        env: {
          ENDPOINT: `\${env:${VAR}:-https://fallback.example}`,
          TOKEN: `\${env:${VAR}}`,
        },
        wrapForTelemetry: false,
      },
      hooks: {},
    });
    const ctx = buildCtx(projectDir, connector, "user");

    codebuffAdapter.installServer(ctx);
    const cfg = readJson(codebuffAdapter.getServerConfigPath(ctx));
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry.env.ENDPOINT).toBe("https://fallback.example");
    expect(entry.env.TOKEN).toBe(`$${VAR}`);
  });
});

describe("kimi parseEvent normalizes a PreToolUse payload", () => {
  it("maps a native payload to a normalized PreToolUse event", () => {
    const ev = kimiAdapter.parseEvent!("PreToolUse", {
      tool_name: "acme_query",
      tool_input: { sql: "select 1" },
      session_id: "sess-1",
      cwd: "/work",
    }) as PreToolUseEvent;
    expect(ev.toolName).toBe("acme_query");
    expect(ev.sessionId).toBe("sess-1");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// roo-code — `disabled` reflects the per-call server's enabled flag
// ─────────────────────────────────────────────────────────────────────────

describe("roo-code disabled reflects server.enabled", () => {
  it("disabled:false when the server is enabled (default)", () => {
    const projectDir = freshProject("ac-rf-roo-");
    const ctx = buildCtx(projectDir, buildConnector());
    rooCodeAdapter.installServer(ctx);
    const cfg = readJson(rooCodeAdapter.getServerConfigPath(ctx));
    expect(cfg.mcpServers[CONNECTOR_ID].disabled).toBe(false);
  });

  it("disabled:true when the server is explicitly enabled:false", () => {
    const projectDir = freshProject("ac-rf-roo2-");
    const connector = buildConnector({
      server: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@x/y"],
        enabled: false,
      },
      hooks: {},
    });
    const ctx = buildCtx(projectDir, connector);
    rooCodeAdapter.installServer(ctx);
    const cfg = readJson(rooCodeAdapter.getServerConfigPath(ctx));
    expect(cfg.mcpServers[CONNECTOR_ID].disabled).toBe(true);
  });
});
