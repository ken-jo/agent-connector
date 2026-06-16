/**
 * adapters/windsurf.test.ts — Windsurf (Cascade) adapter tests.
 *
 * Windsurf is an mcp-only host. It registers MCP servers in USER/GLOBAL scope
 * ONLY → ~/.codeium/windsurf/mcp_config.json (root key "mcpServers" is a
 * Claude-Desktop-style OBJECT map keyed by server name, like cursor). The docs
 * document no project/workspace config path, so a project-scope install returns
 * a skip. Remote servers use `serverUrl` (NOT `url`); no `type`/`disabled`.
 *
 * All tests are HOME-isolated (mkdtemp + redirected HOME/USERPROFILE/APPDATA/
 * XDG) and deterministic. Mirrors tests/adapters/amazon-q.test.ts for the
 * mcp-only harness + the cursor object-map server pattern.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import windsurfAdapter from "../../src/adapters/windsurf/index.js";

const CONNECTOR_ID = "acme-windsurf";

const SERVER = {
  transport: "stdio",
  command: "acme-mcp",
  args: ["--port", "0"],
  // Disable the transparent telemetry serve-wrapper so the rendered entry holds
  // the literal command/args (the wrap behavior is covered by spawn/render tests).
  wrapForTelemetry: false,
} as const;

function buildConnector(cfg: Partial<ConnectorConfig> = {}): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Windsurf",
    version: "1.0.0",
    server: { ...SERVER, args: [...SERVER.args] },
    ...cfg,
  });
}

function buildCtx(
  projectDir: string,
  connector: ResolvedConnector,
  scope: "project" | "user" = "user",
): InstallContext {
  return {
    connector,
    scope,
    projectDir,
    homeBinPath: "/fake/bin/agent-connector",
    dataRoot: projectDir,
    dryRun: false,
  };
}

let saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "XDG_CONFIG_HOME",
  "AGENT_CONNECTOR_DATA_DIR",
] as const;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Fresh isolated HOME + project dir. HOME drives ~/.codeium/windsurf (user). */
function freshProject(): { home: string; projectDir: string } {
  const home = mkdtempSync(join(tmpdir(), "ac-windsurf-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.AGENT_CONNECTOR_DATA_DIR = join(home, ".agent-connector");
  const projectDir = join(home, "project");
  mkdirSync(projectDir, { recursive: true });
  return { home, projectDir };
}

/** The user-scope MCP config path under the isolated HOME. */
function userMcpPath(home: string): string {
  return join(home, ".codeium", "windsurf", "mcp_config.json");
}

// ── identity + capabilities ──────────────────────────────────────────────────

describe("windsurf adapter — identity + capabilities", () => {
  it("is an mcp-only host with the right identity and surface flags", () => {
    expect(windsurfAdapter.id).toBe("windsurf");
    expect(windsurfAdapter.name).toBe("Windsurf");
    expect(windsurfAdapter.paradigm).toBe("mcp-only");
    // Memory is DEFERRED (Windsurf reads .windsurfrules, not AGENTS.md): the
    // adapter must NOT declare supportsMemory → it stays an honest host-gap.
    expect(windsurfAdapter.capabilities.supportsMemory ?? false).toBe(false);
    // mcp-only: no hooks
    expect(windsurfAdapter.capabilities.preToolUse).toBe(false);
    expect(windsurfAdapter.capabilities.postToolUse).toBe(false);
    expect(windsurfAdapter.capabilities.canModifyArgs).toBe(false);
    expect(windsurfAdapter.capabilities.canModifyOutput).toBe(false);
    expect(windsurfAdapter.capabilities.canInjectSessionContext).toBe(false);
    // No unverified content surfaces
    expect(windsurfAdapter.capabilities.supportsCommands ?? false).toBe(false);
    expect(windsurfAdapter.capabilities.supportsSkills ?? false).toBe(false);
    expect(windsurfAdapter.capabilities.supportsSubagents ?? false).toBe(false);
    // Transports: stdio + remote
    expect(windsurfAdapter.capabilities.transports).toContain("stdio");
    expect(windsurfAdapter.capabilities.transports).toContain("http");
  });
});

// ── path resolution ──────────────────────────────────────────────────────────

describe("windsurf adapter — path resolution", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
  });

  it("user scope resolves to ~/.codeium/windsurf/mcp_config.json", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    expect(windsurfAdapter.getServerConfigPath(ctx)).toBe(userMcpPath(home));
  });

  it("getConfigDir = ~/.codeium/windsurf (homedir-based, covers Windows USERPROFILE)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    expect(windsurfAdapter.getConfigDir(ctx)).toBe(join(home, ".codeium", "windsurf"));
  });

  it("project scope still resolves the USER config dir (no project path exists)", () => {
    // getConfigDir is user-only regardless of scope; the project-scope INSTALL
    // is what returns a skip (covered below) — the path resolution never points
    // into the project tree.
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    expect(windsurfAdapter.getServerConfigPath(ctx)).toBe(userMcpPath(home));
    expect(windsurfAdapter.getServerConfigPath(ctx)).not.toContain(projectDir);
  });

  it("getHookConfigPath aliases the server config path (no separate hook file)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    expect(windsurfAdapter.getHookConfigPath(ctx)).toBe(
      windsurfAdapter.getServerConfigPath(ctx),
    );
  });
});

// ── detection ────────────────────────────────────────────────────────────────

describe("windsurf adapter — detection", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
  });

  it("not installed on a bare box", () => {
    const d = windsurfAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(false);
    expect(d.confidence).toBe("low");
    expect(d.scope).toBe("user");
  });

  it("detects ~/.codeium/windsurf dir (user scope)", () => {
    mkdirSync(join(home, ".codeium", "windsurf"), { recursive: true });
    const d = windsurfAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(true);
    expect(d.scope).toBe("user");
    expect(d.confidence).toBe("high");
    expect(d.configPath).toBe(userMcpPath(home));
  });

  it("detects ~/.codeium/windsurf/mcp_config.json (file only)", () => {
    const dir = join(home, ".codeium", "windsurf");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mcp_config.json"), JSON.stringify({ mcpServers: {} }));
    const d = windsurfAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(true);
    expect(d.scope).toBe("user");
  });

  it("does NOT collide with a bare ~/.codeium dir (windsurf subdir must be present)", () => {
    // .codeium is shared with other Codeium products — only the windsurf subdir
    // counts. (No other adapter probes .codeium — see registry grep.)
    mkdirSync(join(home, ".codeium"), { recursive: true });
    const d = windsurfAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(false);
  });
});

// ── MCP server install (user scope, object map) ──────────────────────────────

describe("windsurf adapter — MCP install (user scope)", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
  });

  it("writes mcpServers.<id> at ~/.codeium/windsurf/mcp_config.json (create when absent)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = windsurfAdapter.installServer(ctx);
    expect(changes.every((c) => c.platform === "windsurf")).toBe(true);
    expect(changes[0]?.action).toBe("create");

    const mcpPath = userMcpPath(home);
    expect(changes[0]?.path).toBe(mcpPath);
    expect(existsSync(mcpPath)).toBe(true);

    const cfg = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };
    // Object map keyed by connector id (NOT an array).
    expect(Array.isArray(cfg.mcpServers)).toBe(false);
    expect(cfg.mcpServers[CONNECTOR_ID]).toBeTruthy();
    expect(cfg.mcpServers[CONNECTOR_ID]!.command).toBe("acme-mcp");
    expect(cfg.mcpServers[CONNECTOR_ID]!.args).toEqual(["--port", "0"]);
  });

  it("stdio entry shape: { command, args } — no type/disabled/serverUrl", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    windsurfAdapter.installServer(ctx);
    const cfg = JSON.parse(readFileSync(userMcpPath(home), "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    const entry = cfg.mcpServers[CONNECTOR_ID]!;
    expect("type" in entry).toBe(false);
    expect("disabled" in entry).toBe(false);
    expect("serverUrl" in entry).toBe(false);
  });

  it("preserves a pre-seeded sibling server on install", () => {
    const mcpPath = userMcpPath(home);
    mkdirSync(join(home, ".codeium", "windsurf"), { recursive: true });
    writeFileSync(
      mcpPath,
      JSON.stringify({ mcpServers: { "other-tool": { command: "other" } } }),
    );

    const ctx = buildCtx(projectDir, buildConnector(), "user");
    windsurfAdapter.installServer(ctx);

    const cfg = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect("other-tool" in cfg.mcpServers).toBe(true);
    expect(cfg.mcpServers["other-tool"]!.command).toBe("other");
    expect(CONNECTOR_ID in cfg.mcpServers).toBe(true);
  });

  it("install is idempotent: second install returns skip", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    windsurfAdapter.installServer(ctx);
    const second = windsurfAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");
  });

  it("update: second install with changed server writes update", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    windsurfAdapter.installServer(ctx);

    const changed = buildConnector({ server: { ...SERVER, args: ["--port", "9999"] } });
    const ctx2 = buildCtx(projectDir, changed, "user");
    const result = windsurfAdapter.installServer(ctx2);
    expect(result[0]?.action).toBe("update");
  });

  it("uninstall removes only our key and preserves siblings", () => {
    const mcpPath = userMcpPath(home);
    mkdirSync(join(home, ".codeium", "windsurf"), { recursive: true });
    writeFileSync(
      mcpPath,
      JSON.stringify({ mcpServers: { "other-tool": { command: "other" } } }),
    );

    const ctx = buildCtx(projectDir, buildConnector(), "user");
    windsurfAdapter.installServer(ctx);
    const removed = windsurfAdapter.uninstallServer(ctx);
    expect(removed[0]?.action).toBe("remove");

    const cfg = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect("other-tool" in cfg.mcpServers).toBe(true);
    expect(CONNECTOR_ID in cfg.mcpServers).toBe(false);
  });

  it("skips when connector declares no server", () => {
    // A serverless connector still needs ANOTHER surface to be valid — declare a
    // memory entry so defineConnector accepts it; windsurf then skip-warns the
    // absent server (and skip-warns the unsupported memory surface elsewhere).
    const connector = buildConnector({
      server: undefined,
      memory: [{ content: "Guidance for Windsurf." }],
    });
    const ctx = buildCtx(projectDir, connector, "user");
    const changes = windsurfAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("no MCP server");
  });

  it("skips when platform override is false", () => {
    const connector = buildConnector({ platforms: { windsurf: { server: false } } });
    const ctx = buildCtx(projectDir, connector, "user");
    const changes = windsurfAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("disabled for windsurf");
  });

  it("NEVER clobbers a malformed (non-object) mcpServers — skip-warn", () => {
    const mcpPath = userMcpPath(home);
    mkdirSync(join(home, ".codeium", "windsurf"), { recursive: true });
    // mcpServers present but an ARRAY (a hand-edit mistake) — must not be touched.
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: [] }));

    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = windsurfAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("not an object");

    // The file is left byte-untouched (still an array, no connector key bolted on).
    const cfg = JSON.parse(readFileSync(mcpPath, "utf8")) as { mcpServers: unknown };
    expect(Array.isArray(cfg.mcpServers)).toBe(true);
    expect((cfg.mcpServers as unknown[]).length).toBe(0);
  });

  it("uninstall NEVER clobbers a malformed (non-object) mcpServers — skip-warn (symmetric)", () => {
    const mcpPath = userMcpPath(home);
    mkdirSync(join(home, ".codeium", "windsurf"), { recursive: true });
    const original = JSON.stringify({ mcpServers: [] });
    writeFileSync(mcpPath, original);

    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = windsurfAdapter.uninstallServer(ctx);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("not an object");
    // Byte-for-byte untouched.
    expect(readFileSync(mcpPath, "utf8")).toBe(original);
  });
});

// ── project scope (user-only host) ───────────────────────────────────────────

describe("windsurf adapter — project scope returns skip (user-only host)", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
  });

  it("project-scope install returns skip and writes nothing", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const changes = windsurfAdapter.installServer(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("no project-level MCP config");
    expect(changes[0]?.detail).toContain("user scope only");

    // Neither the user file nor any project file was created.
    expect(existsSync(userMcpPath(home))).toBe(false);
  });
});

// ── remote (http) server ─────────────────────────────────────────────────────

describe("windsurf adapter — remote (http) server", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
  });

  it("remote server writes { serverUrl } (NOT url), no type/disabled/command", () => {
    const connector = buildConnector({
      server: { transport: "http", url: "https://mcp.example.com/mcp" },
    });
    const ctx = buildCtx(projectDir, connector, "user");
    windsurfAdapter.installServer(ctx);

    const cfg = JSON.parse(readFileSync(userMcpPath(home), "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    const entry = cfg.mcpServers[CONNECTOR_ID]!;
    // Documented remote shape: `serverUrl` (NOT `url`).
    expect(entry.serverUrl).toBe("https://mcp.example.com/mcp");
    expect("url" in entry).toBe(false);
    expect("type" in entry).toBe(false);
    expect("disabled" in entry).toBe(false);
    expect("command" in entry).toBe(false);
  });

  it("emits headers when the remote server provides them", () => {
    const connector = buildConnector({
      server: {
        transport: "http",
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer literal-token" },
      },
    });
    const ctx = buildCtx(projectDir, connector, "user");
    windsurfAdapter.installServer(ctx);

    const cfg = JSON.parse(readFileSync(userMcpPath(home), "utf8")) as {
      mcpServers: Record<string, { serverUrl: string; headers?: Record<string, string> }>;
    };
    const entry = cfg.mcpServers[CONNECTOR_ID]!;
    expect(entry.serverUrl).toBe("https://mcp.example.com/mcp");
    expect(entry.headers).toEqual({ Authorization: "Bearer literal-token" });
  });

  it("omits headers when the remote server provides none", () => {
    const connector = buildConnector({
      server: { transport: "http", url: "https://mcp.example.com/mcp" },
    });
    const ctx = buildCtx(projectDir, connector, "user");
    windsurfAdapter.installServer(ctx);

    const cfg = JSON.parse(readFileSync(userMcpPath(home), "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect("headers" in cfg.mcpServers[CONNECTOR_ID]!).toBe(false);
  });
});

// ── hooks (unavailable) ──────────────────────────────────────────────────────

describe("windsurf adapter — hooks (mcp-only)", () => {
  let projectDir: string;

  beforeEach(() => {
    ({ projectDir } = freshProject());
  });

  it("installHooks returns a single skip record", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = windsurfAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("hooks unavailable");
    expect(changes[0]?.platform).toBe("windsurf");
  });

  it("uninstallHooks returns a single skip record", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = windsurfAdapter.uninstallHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
  });
});

// ── env interpolation (resolve to literal) ───────────────────────────────────

describe("windsurf adapter — env interpolation (resolve to literal)", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
    process.env.MY_MCP_SECRET = "actual-secret-value";
  });

  afterEach(() => {
    delete process.env.MY_MCP_SECRET;
  });

  it("resolves ${env:VAR} in env values to literals at install time", () => {
    const connector = buildConnector({
      server: {
        ...SERVER,
        args: [...SERVER.args],
        env: { MY_VAR: "${env:MY_MCP_SECRET}" },
      },
    });
    const ctx = buildCtx(projectDir, connector, "user");
    windsurfAdapter.installServer(ctx);

    const cfg = JSON.parse(readFileSync(userMcpPath(home), "utf8")) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    expect(cfg.mcpServers[CONNECTOR_ID]!.env?.MY_VAR).toBe("actual-secret-value");
  });
});
