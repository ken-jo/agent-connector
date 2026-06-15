/**
 * adapters/nemoclaw — focused tests for the NVIDIA NemoClaw adapter.
 *
 * NemoClaw is a thin FORK of the OpenClaw adapter (it extends OpenClawAdapter,
 * overriding only id / name / detectInstalled). These tests prove the three
 * things the fork must get right:
 *   1. Detection keys on the NemoClaw-specific marker `~/.nemoclaw/` and does NOT
 *      collide with OpenClaw — a `~/.nemoclaw/` box is nemoclaw; a `~/.openclaw/`-
 *      only box is NOT nemoclaw (it falls through to the openclaw adapter).
 *   2. installServer writes the MCP server into the WRAPPED OpenClaw config
 *      (~/.openclaw/openclaw.json, NESTED mcp.servers.<id>), stamped with the
 *      nemoclaw platform id.
 *   3. uninstallServer reverses it.
 *
 * Filesystem isolation: every test gets a fresh mkdtemp project dir; HOME +
 * AGENT_CONNECTOR_DATA_DIR are redirected there and restored in afterEach so
 * nothing escapes the sandbox. User scope is used for detection (the ~/.nemoclaw/
 * marker lives under HOME); project scope is used for the deterministic
 * openclaw.json server-write path.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import nemoclawAdapter from "../../src/adapters/nemoclaw/index.js";
import openclawAdapter from "../../src/adapters/openclaw/index.js";

const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";

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
  });
}

/** Same connector, plus PreToolUse + SessionStart hooks (drives installHooks). */
function buildHooksConnector(): ResolvedConnector {
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

let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let savedDataDir: string | undefined;
let savedEnvVar: string | undefined;
let savedOpenClawConfig: string | undefined;
let savedOpenClawState: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
  savedEnvVar = process.env[ENV_VAR];
  savedOpenClawConfig = process.env.OPENCLAW_CONFIG_PATH;
  savedOpenClawState = process.env.OPENCLAW_STATE_DIR;
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("USERPROFILE", savedUserProfile);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
  restore(ENV_VAR, savedEnvVar);
  restore("OPENCLAW_CONFIG_PATH", savedOpenClawConfig);
  restore("OPENCLAW_STATE_DIR", savedOpenClawState);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function freshHome(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  process.env[ENV_VAR] = ENV_LITERAL;
  delete process.env.OPENCLAW_CONFIG_PATH;
  delete process.env.OPENCLAW_STATE_DIR;
  return dir;
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("nemoclaw adapter — identity + detection (does NOT collide with openclaw)", () => {
  it("has the nemoclaw identity but inherits OpenClaw's ts-plugin paradigm", () => {
    expect(nemoclawAdapter.id).toBe("nemoclaw");
    expect(nemoclawAdapter.name).toBe("NVIDIA NemoClaw");
    expect(nemoclawAdapter.paradigm).toBe("ts-plugin");
    // Paradigm + capabilities are inherited from OpenClawAdapter verbatim.
    expect(nemoclawAdapter.paradigm).toBe(openclawAdapter.paradigm);
  });

  it("detects ONLY when the ~/.nemoclaw/ marker is present", () => {
    const home = freshHome("ac-nemoclaw-detect-");
    // No ~/.nemoclaw/ yet → not installed.
    expect(nemoclawAdapter.detectInstalled(home).installed).toBe(false);

    // Create the NemoClaw marker dir → installed, high confidence.
    mkdirSync(join(home, ".nemoclaw"), { recursive: true });
    const det = nemoclawAdapter.detectInstalled(home);
    expect(det.installed).toBe(true);
    expect(det.id).toBe("nemoclaw");
    expect(det.confidence).toBe("high");
    expect(det.reason).toMatch(/NemoClaw/);
  });

  it("a ~/.openclaw/-only box is NOT detected as nemoclaw (no collision)", () => {
    const home = freshHome("ac-nemoclaw-noco-");
    // Only the OpenClaw marker exists — NOT NemoClaw.
    mkdirSync(join(home, ".openclaw"), { recursive: true });

    expect(nemoclawAdapter.detectInstalled(home).installed).toBe(false);
    // ...while the openclaw adapter DOES see it (the fork-ordering payoff).
    expect(openclawAdapter.detectInstalled(home).installed).toBe(true);
  });

  it("a REAL NemoClaw box (BOTH ~/.nemoclaw/ AND ~/.openclaw/) is nemoclaw-ONLY — openclaw bows out", () => {
    const home = freshHome("ac-nemoclaw-both-");
    // A NemoClaw install DRIVES the wrapped OpenClaw config, so a real NemoClaw
    // box has BOTH markers on disk. nemoclaw must claim it; openclaw must DEFER —
    // its detectInstalled bows out when ~/.nemoclaw/ is present so the planner
    // does not double-target the shared ~/.openclaw/openclaw.json as two
    // platforms (an `uninstall openclaw` would otherwise strip nemoclaw's entries).
    mkdirSync(join(home, ".nemoclaw"), { recursive: true });
    mkdirSync(join(home, ".openclaw"), { recursive: true });

    expect(nemoclawAdapter.detectInstalled(home).installed).toBe(true);
    // The bow-out: openclaw sees its own ~/.openclaw/ marker but defers because
    // ~/.nemoclaw/ is present. Without the bow-out this would be `true` and the
    // shared config would be double-targeted.
    expect(openclawAdapter.detectInstalled(home).installed).toBe(false);
  });
});

describe("nemoclaw adapter — MCP install lands in the WRAPPED openclaw.json", () => {
  let projectDir: string;
  let ctx: InstallContext;
  let configPath: string;

  beforeEach(() => {
    projectDir = freshHome("ac-nemoclaw-mcp-");
    ctx = buildCtx(projectDir, buildConnector());
    // Project scope → <projectDir>/openclaw.json (inherited resolution).
    configPath = join(projectDir, "openclaw.json");
    expect(configPath).toBe(nemoclawAdapter.getServerConfigPath(ctx));
  });

  it("installServer writes the NESTED mcp.servers.<id> entry, stamped platform=nemoclaw", () => {
    const changes = nemoclawAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");
    // The ChangeRecord carries the nemoclaw identity (this.id), not openclaw.
    expect(changes[0]?.platform).toBe("nemoclaw");
    expect(existsSync(configPath)).toBe(true);

    const cfg = readJson(configPath);
    // The wrapped OpenClaw shape: nested under top-level "mcp", key "servers"
    // (NOT a top-level mcpServers key).
    expect(cfg).toHaveProperty("mcp");
    expect(cfg).not.toHaveProperty("mcpServers");
    expect(cfg.mcp).toHaveProperty("servers");

    const entry = cfg.mcp.servers[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    // stdio sidecar: no transport key (inferred from command), telemetry-wrapped
    // through the home bin, env resolved to a literal.
    expect("transport" in entry).toBe(false);
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toContain("serve");
    expect(entry.args).toContain("--connector");
    expect(entry.args).toContain(CONNECTOR_ID);
    // The serve-wrapper bakes the install target as `--host nemoclaw`.
    expect(entry.args).toContain("--host");
    expect(entry.args).toContain("nemoclaw");
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installServer is idempotent — second call yields skip, no duplicate", () => {
    nemoclawAdapter.installServer(ctx);
    const second = nemoclawAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");
    const cfg = readJson(configPath);
    expect(Object.keys(cfg.mcp.servers)).toEqual([CONNECTOR_ID]);
  });

  it("uninstallServer removes the nested entry (re-read confirms gone)", () => {
    nemoclawAdapter.installServer(ctx);
    const removed = nemoclawAdapter.uninstallServer(ctx);
    expect(removed[0]?.platform).toBe("nemoclaw");
    const cfg = readJson(configPath);
    expect(cfg.mcp?.servers?.[CONNECTOR_ID]).toBeUndefined();
  });
});

describe("nemoclaw adapter — hooks bridge dispatches `hook nemoclaw` (HOST binding, not openclaw)", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshHome("ac-nemoclaw-hooks-");
    ctx = buildCtx(projectDir, buildHooksConnector());
  });

  it("the synthesized plugin module bakes `[\"hook\", \"nemoclaw\", …]` (NOT openclaw)", () => {
    const changes = nemoclawAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);
    // Every ChangeRecord carries the nemoclaw identity (this.id), not openclaw.
    expect(changes.every((c) => c.platform === "nemoclaw")).toBe(true);

    // The plugin lands in the WRAPPED openclaw workspace (inherited path) — that
    // is correct: nemoclaw runs the openclaw agent, which loads from .openclaw/.
    const pluginPath = nemoclawAdapter.getHookConfigPath(ctx);
    expect(existsSync(pluginPath)).toBe(true);

    const src = readFileSync(pluginPath, "utf8");
    // THE host-binding fix: the bridge bakes the install target into the hook
    // dispatch so events route back to THIS adapter. A plain `"openclaw"` token
    // here (the pre-fix bug from the module-const HOST binding) would mis-route
    // every nemoclaw hook to the openclaw adapter.
    expect(src).toContain('["hook", "nemoclaw", event');
    expect(src).not.toContain('["hook", "openclaw", event');
    expect(src).toContain("--connector");
    expect(src).toContain(CONNECTOR_ID);
    expect(src).toContain(HOME_BIN);
  });

  it("parseEvent stamps hostPlatform=nemoclaw (dispatched events route to THIS adapter)", () => {
    const evt = nemoclawAdapter.parseEvent!("PreToolUse", {
      toolName: "acme_write",
      toolInput: { sql: "DELETE" },
      sessionId: "nc-1",
      projectDir: "/some/proj",
    });
    expect(evt).toMatchObject({
      hostPlatform: "nemoclaw",
      toolName: "acme_write",
      toolInput: { sql: "DELETE" },
      sessionId: "nc-1",
      projectDir: "/some/proj",
    });
  });
});
