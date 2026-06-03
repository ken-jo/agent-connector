/**
 * adapters/wave1-render — render + round-trip tests for the eight Wave-1
 * `mcp-only` adapters: droid, roo-code, trae, antigravity, zed, amp, codebuff, mux.
 *
 * Each is exercised end-to-end against REAL files on disk, mirroring the
 * established phase2/phase3 pattern:
 *   • installServer  → native MCP registration under the CORRECT root key,
 *                      with the command/args routed through the home-bin serve
 *                      wrapper (telemetry on by default).
 *   • installHooks   → exactly ONE skip ChangeRecord, and NO hook file written
 *                      (mcp-only hosts have no hook layer).
 *   • idempotency    → second installServer → "skip", no duplicate entries.
 *   • uninstallServer → entry removed (re-read from disk confirms gone).
 *
 * Per-adapter root-key contract asserted here:
 *   droid / roo-code / trae / antigravity / codebuff → "mcpServers"
 *   zed       → "context_servers"
 *   amp       → dotted FLAT key "amp.mcpServers"
 *   mux       → "servers", value is a STRING (space-joined shell command)
 *
 * zed + amp additionally assert pre-existing unrelated settings keys SURVIVE the
 * merge (the settings.json is a shared, user-owned file).
 *
 * Filesystem isolation: every test gets a fresh os.tmpdir mkdtemp project dir,
 * and HOME + AGENT_CONNECTOR_DATA_DIR are redirected there so any user-scope path
 * (resolved from homedir()) lands inside the sandbox. Both are restored in
 * afterEach so the suite never leaks state.
 */

import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import droidAdapter from "../../src/adapters/droid/index.js";
import rooCodeAdapter from "../../src/adapters/roo-code/index.js";
import traeAdapter from "../../src/adapters/trae/index.js";
import antigravityAdapter from "../../src/adapters/antigravity/index.js";
import zedAdapter from "../../src/adapters/zed/index.js";
import ampAdapter from "../../src/adapters/amp/index.js";
import codebuffAdapter from "../../src/adapters/codebuff/index.js";
import muxAdapter from "../../src/adapters/mux/index.js";

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
 * Fresh temp project dir + redirect HOME/data-root there so nothing escapes.
 * Critical for user-scope paths resolved from homedir() — pointing HOME at a
 * temp dir keeps every write in the sandbox. The env-ref var is set so
 * literal-resolution produces a known value.
 */
function freshProject(prefix = "ac-wave1-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.HOME = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  process.env[ENV_VAR] = ENV_LITERAL;
  return dir;
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Seed a JSON settings file on disk with arbitrary contents (creating dirs). */
function seedJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

const WRAPPED_ARGS = ["serve", "--connector", CONNECTOR_ID, "--scope", "project", "--", "npx", "-y", "@x/y"];

// ─────────────────────────────────────────────────────────────────────────
// droid (root key "mcpServers"; { type:"stdio", ..., disabled })
// ─────────────────────────────────────────────────────────────────────────

describe("droid adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave1-droid-");
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("installServer writes mcpServers.<id> into .factory/mcp.json, wrapped, env LITERAL", () => {
    const changes = droidAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".factory", "mcp.json");
    expect(serverPath).toBe(droidAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.type).toBe("stdio");
    expect(entry.disabled).toBe(false);

    // Telemetry serve-wrapper: command points at the home binary.
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(WRAPPED_ARGS);

    // No native interpolation token → env-ref resolves to a LITERAL value.
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installHooks returns a single skip ChangeRecord and writes NO hook file", () => {
    const changes = droidAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");

    const hooksPath = droidAdapter.getHookConfigPath(ctx);
    expect(hooksPath).toBe(droidAdapter.getServerConfigPath(ctx));
    expect(existsSync(hooksPath)).toBe(false);
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    droidAdapter.installServer(ctx);
    const second = droidAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".factory", "mcp.json"));
    expect(Object.keys(cfg.mcpServers)).toEqual([CONNECTOR_ID]);
  });

  it("uninstallServer removes the entry (re-read confirms gone)", () => {
    droidAdapter.installServer(ctx);
    droidAdapter.uninstallServer(ctx);
    const cfg = readJson(join(projectDir, ".factory", "mcp.json"));
    expect(cfg.mcpServers?.[CONNECTOR_ID]).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// roo-code (root key "mcpServers"; project → .roo/mcp.json)
// ─────────────────────────────────────────────────────────────────────────

describe("roo-code adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave1-roo-");
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("installServer writes mcpServers.<id> into .roo/mcp.json, wrapped, env LITERAL", () => {
    const changes = rooCodeAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".roo", "mcp.json");
    expect(serverPath).toBe(rooCodeAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.disabled).toBe(false);

    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(WRAPPED_ARGS);

    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installHooks returns a single skip ChangeRecord and writes NO hook file", () => {
    const changes = rooCodeAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");

    const hooksPath = rooCodeAdapter.getHookConfigPath(ctx);
    expect(hooksPath).toBe(rooCodeAdapter.getServerConfigPath(ctx));
    expect(existsSync(hooksPath)).toBe(false);
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    rooCodeAdapter.installServer(ctx);
    const second = rooCodeAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".roo", "mcp.json"));
    expect(Object.keys(cfg.mcpServers)).toEqual([CONNECTOR_ID]);
  });

  it("uninstallServer removes the entry (re-read confirms gone)", () => {
    rooCodeAdapter.installServer(ctx);
    rooCodeAdapter.uninstallServer(ctx);
    const cfg = readJson(join(projectDir, ".roo", "mcp.json"));
    expect(cfg.mcpServers?.[CONNECTOR_ID]).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// trae (root key "mcpServers"; .trae/mcp.json)
// ─────────────────────────────────────────────────────────────────────────

describe("trae adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave1-trae-");
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("installServer writes mcpServers.<id> into .trae/mcp.json, wrapped, env LITERAL", () => {
    const changes = traeAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".trae", "mcp.json");
    expect(serverPath).toBe(traeAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry).toBeTruthy();

    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(WRAPPED_ARGS);

    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installHooks returns a single skip ChangeRecord and writes NO hook file", () => {
    const changes = traeAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");

    const hooksPath = traeAdapter.getHookConfigPath(ctx);
    expect(hooksPath).toBe(traeAdapter.getServerConfigPath(ctx));
    expect(existsSync(hooksPath)).toBe(false);
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    traeAdapter.installServer(ctx);
    const second = traeAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".trae", "mcp.json"));
    expect(Object.keys(cfg.mcpServers)).toEqual([CONNECTOR_ID]);
  });

  it("uninstallServer removes the entry (re-read confirms gone)", () => {
    traeAdapter.installServer(ctx);
    traeAdapter.uninstallServer(ctx);
    const cfg = readJson(join(projectDir, ".trae", "mcp.json"));
    expect(cfg.mcpServers?.[CONNECTOR_ID]).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// antigravity (root key "mcpServers"; project → .agents/mcp_config.json)
// ─────────────────────────────────────────────────────────────────────────

describe("antigravity adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave1-antig-");
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("installServer writes mcpServers.<id> into .agents/mcp_config.json, wrapped, env LITERAL", () => {
    const changes = antigravityAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".agents", "mcp_config.json");
    expect(serverPath).toBe(antigravityAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry).toBeTruthy();

    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(WRAPPED_ARGS);

    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installHooks returns a single skip ChangeRecord and writes NO hook file", () => {
    const changes = antigravityAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");

    const hooksPath = antigravityAdapter.getHookConfigPath(ctx);
    expect(hooksPath).toBe(antigravityAdapter.getServerConfigPath(ctx));
    expect(existsSync(hooksPath)).toBe(false);
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    antigravityAdapter.installServer(ctx);
    const second = antigravityAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".agents", "mcp_config.json"));
    expect(Object.keys(cfg.mcpServers)).toEqual([CONNECTOR_ID]);
  });

  it("uninstallServer removes the entry (re-read confirms gone)", () => {
    antigravityAdapter.installServer(ctx);
    antigravityAdapter.uninstallServer(ctx);
    const cfg = readJson(join(projectDir, ".agents", "mcp_config.json"));
    expect(cfg.mcpServers?.[CONNECTOR_ID]).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// zed (root key "context_servers"; FLAT stdio shape; merge-preserving)
// ─────────────────────────────────────────────────────────────────────────

describe("zed adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave1-zed-");
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("installServer writes context_servers.<id> (NOT mcpServers) into .zed/settings.json, FLAT command, env LITERAL", () => {
    const changes = zedAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".zed", "settings.json");
    expect(serverPath).toBe(zedAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    // ROOT KEY is "context_servers", never "mcpServers".
    expect(cfg).toHaveProperty("context_servers");
    expect(cfg).not.toHaveProperty("mcpServers");

    const entry = cfg.context_servers[CONNECTOR_ID];
    expect(entry).toBeTruthy();

    // FLAT shape — `command` is a STRING (the home bin), not a nested object.
    expect(typeof entry.command).toBe("string");
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(WRAPPED_ARGS);

    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installHooks returns a single skip ChangeRecord and writes NO hook file", () => {
    const changes = zedAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");

    const hooksPath = zedAdapter.getHookConfigPath(ctx);
    expect(hooksPath).toBe(zedAdapter.getServerConfigPath(ctx));
    expect(existsSync(hooksPath)).toBe(false);
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    zedAdapter.installServer(ctx);
    const second = zedAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".zed", "settings.json"));
    expect(Object.keys(cfg.context_servers)).toEqual([CONNECTOR_ID]);
  });

  it("uninstallServer removes the entry (re-read confirms gone)", () => {
    zedAdapter.installServer(ctx);
    zedAdapter.uninstallServer(ctx);
    const cfg = readJson(join(projectDir, ".zed", "settings.json"));
    expect(cfg.context_servers?.[CONNECTOR_ID]).toBeUndefined();
  });

  it("preserves pre-existing unrelated settings keys (shared settings.json merge)", () => {
    const serverPath = join(projectDir, ".zed", "settings.json");
    seedJson(serverPath, {
      theme: "One Dark",
      buffer_font_size: 14,
      context_servers: { "other-server": { command: "other" } },
    });

    zedAdapter.installServer(ctx);

    const cfg = readJson(serverPath);
    // Unrelated top-level keys survive.
    expect(cfg.theme).toBe("One Dark");
    expect(cfg.buffer_font_size).toBe(14);
    // A sibling context server survives, and ours is added alongside it.
    expect(cfg.context_servers["other-server"]).toEqual({ command: "other" });
    expect(cfg.context_servers[CONNECTOR_ID]).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// amp (dotted FLAT root key "amp.mcpServers"; native ${VAR}; merge-preserving)
// ─────────────────────────────────────────────────────────────────────────

describe("amp adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave1-amp-");
    ctx = buildCtx(projectDir, buildConnector());
  });

  it('installServer writes the FLAT dotted key "amp.mcpServers".<id> into .amp/settings.json, wrapped, env as native ${VAR}', () => {
    const changes = ampAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".amp", "settings.json");
    expect(serverPath).toBe(ampAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    // QUIRK: a single FLAT dotted key, NOT a nested { amp: { mcpServers } }.
    expect(cfg).toHaveProperty(["amp.mcpServers"]);
    expect(cfg).not.toHaveProperty("mcpServers");
    expect(cfg.amp).toBeUndefined();

    const entry = cfg["amp.mcpServers"][CONNECTOR_ID];
    expect(entry).toBeTruthy();

    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(WRAPPED_ARGS);

    // Amp expands ${VAR} natively → ref rewritten to Amp's token, NOT a literal.
    expect(entry.env[ENV_VAR]).toBe(`\${${ENV_VAR}}`);
    expect(entry.env[ENV_VAR]).not.toBe(ENV_LITERAL);
  });

  it("installHooks returns a single skip ChangeRecord and writes NO hook file", () => {
    const changes = ampAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");

    const hooksPath = ampAdapter.getHookConfigPath(ctx);
    expect(hooksPath).toBe(ampAdapter.getServerConfigPath(ctx));
    expect(existsSync(hooksPath)).toBe(false);
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    ampAdapter.installServer(ctx);
    const second = ampAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".amp", "settings.json"));
    expect(Object.keys(cfg["amp.mcpServers"])).toEqual([CONNECTOR_ID]);
  });

  it("uninstallServer removes the entry (re-read confirms gone)", () => {
    ampAdapter.installServer(ctx);
    ampAdapter.uninstallServer(ctx);
    const cfg = readJson(join(projectDir, ".amp", "settings.json"));
    expect(cfg["amp.mcpServers"]?.[CONNECTOR_ID]).toBeUndefined();
  });

  it("preserves pre-existing unrelated settings keys (shared settings.json merge)", () => {
    const serverPath = join(projectDir, ".amp", "settings.json");
    seedJson(serverPath, {
      "amp.notifications.enabled": true,
      "amp.url": "https://ampcode.com",
    });

    ampAdapter.installServer(ctx);

    const cfg = readJson(serverPath);
    // Unrelated dotted settings survive the merge.
    expect(cfg["amp.notifications.enabled"]).toBe(true);
    expect(cfg["amp.url"]).toBe("https://ampcode.com");
    // Our entry is added under the dotted MCP key.
    expect(cfg["amp.mcpServers"][CONNECTOR_ID]).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// codebuff (root key "mcpServers"; native $VAR; .agents/mcp.json)
// ─────────────────────────────────────────────────────────────────────────

describe("codebuff adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave1-codebuff-");
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("installServer writes mcpServers.<id> with type 'stdio' into .agents/mcp.json, wrapped, env as native $VAR", () => {
    const changes = codebuffAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".agents", "mcp.json");
    expect(serverPath).toBe(codebuffAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.type).toBe("stdio");

    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(WRAPPED_ARGS);

    // Codebuff expands $VAR natively → ref rewritten to $VAR, NOT a literal.
    expect(entry.env[ENV_VAR]).toBe(`$${ENV_VAR}`);
    expect(entry.env[ENV_VAR]).not.toBe(ENV_LITERAL);
  });

  it("installHooks returns a single skip ChangeRecord and writes NO hook file", () => {
    const changes = codebuffAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");

    const hooksPath = codebuffAdapter.getHookConfigPath(ctx);
    expect(hooksPath).toBe(codebuffAdapter.getServerConfigPath(ctx));
    expect(existsSync(hooksPath)).toBe(false);
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    codebuffAdapter.installServer(ctx);
    const second = codebuffAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".agents", "mcp.json"));
    expect(Object.keys(cfg.mcpServers)).toEqual([CONNECTOR_ID]);
  });

  it("uninstallServer removes the entry (re-read confirms gone)", () => {
    codebuffAdapter.installServer(ctx);
    codebuffAdapter.uninstallServer(ctx);
    const cfg = readJson(join(projectDir, ".agents", "mcp.json"));
    expect(cfg.mcpServers?.[CONNECTOR_ID]).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// mux (root key "servers"; value is a STRING shell command; .mux/mcp.jsonc)
// ─────────────────────────────────────────────────────────────────────────

describe("mux adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave1-mux-");
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("installServer writes servers.<id> as a STRING (space-joined home-bin serve wrapper) into .mux/mcp.jsonc", () => {
    const changes = muxAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".mux", "mcp.jsonc");
    expect(serverPath).toBe(muxAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    // ROOT KEY is "servers", NOT "mcpServers".
    expect(cfg).toHaveProperty("servers");
    expect(cfg).not.toHaveProperty("mcpServers");

    const entry = cfg.servers[CONNECTOR_ID];
    // QUIRK: the entry value is a single shell-command STRING, not an object.
    expect(typeof entry).toBe("string");

    // The command routes through the home-bin serve wrapper:
    //   "<homeBin> serve --connector <id> -- npx -y @x/y"
    expect(entry).toBe([HOME_BIN, ...WRAPPED_ARGS].join(" "));
    expect(entry.startsWith(HOME_BIN)).toBe(true);
    expect(entry).toContain("serve --connector acme-db --scope project --");
  });

  it("installHooks returns a single skip ChangeRecord and writes NO hook file", () => {
    const changes = muxAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");

    const hooksPath = muxAdapter.getHookConfigPath(ctx);
    expect(hooksPath).toBe(muxAdapter.getServerConfigPath(ctx));
    expect(existsSync(hooksPath)).toBe(false);
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    muxAdapter.installServer(ctx);
    const second = muxAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".mux", "mcp.jsonc"));
    expect(Object.keys(cfg.servers)).toEqual([CONNECTOR_ID]);
  });

  it("uninstallServer removes the entry (re-read confirms gone)", () => {
    muxAdapter.installServer(ctx);
    muxAdapter.uninstallServer(ctx);
    const cfg = readJson(join(projectDir, ".mux", "mcp.jsonc"));
    expect(cfg.servers?.[CONNECTOR_ID]).toBeUndefined();
  });
});
