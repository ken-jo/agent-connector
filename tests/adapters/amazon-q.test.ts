/**
 * adapters/amazon-q.test.ts — Amazon Q Developer CLI adapter tests.
 *
 * Amazon Q Developer CLI (`q` / `qchat`) is an mcp-only host. It registers MCP
 * servers in:
 *   user scope    → ~/.aws/amazonq/mcp.json   (root key "mcpServers")
 *   project scope → <projectDir>/.amazonq/mcp.json
 *
 * All tests are HOME-isolated (mkdtemp + redirected HOME/USERPROFILE/APPDATA/
 * XDG) and deterministic. Mirrors tests/adapters/roo-code.test.ts for the
 * mcp-only pattern.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import amazonQAdapter from "../../src/adapters/amazon-q/index.js";

const CONNECTOR_ID = "acme-amazon-q";

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
    displayName: "Acme Amazon Q",
    version: "1.0.0",
    server: { ...SERVER, args: [...SERVER.args] },
    memory: [{ content: "Project guidance for Amazon Q." }],
    ...cfg,
  });
}

function buildCtx(
  projectDir: string,
  connector: ResolvedConnector,
  scope: "project" | "user" = "project",
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

/**
 * Fresh isolated HOME + project dir. HOME drives ~/.aws/amazonq (user scope).
 */
function freshProject(): { home: string; projectDir: string } {
  const home = mkdtempSync(join(tmpdir(), "ac-amazon-q-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.AGENT_CONNECTOR_DATA_DIR = join(home, ".agent-connector");
  const projectDir = join(home, "project");
  mkdirSync(projectDir, { recursive: true });
  return { home, projectDir };
}

// ── capability flags ────────────────────────────────────────────────────────

describe("amazon-q adapter — identity + capabilities", () => {
  it("is an mcp-only host with the right identity and surface flags", () => {
    expect(amazonQAdapter.id).toBe("amazon-q");
    expect(amazonQAdapter.name).toBe("Amazon Q Developer CLI");
    expect(amazonQAdapter.paradigm).toBe("mcp-only");
    // Memory is WIRED (Amazon Q reads .amazonq/rules, not AGENTS.md): the adapter
    // declares supportsMemory and writes a dedicated .amazonq/rules file.
    expect(amazonQAdapter.capabilities.supportsMemory).toBe(true);
    // mcp-only: no hooks
    expect(amazonQAdapter.capabilities.preToolUse).toBe(false);
    expect(amazonQAdapter.capabilities.postToolUse).toBe(false);
    expect(amazonQAdapter.capabilities.canModifyArgs).toBe(false);
    expect(amazonQAdapter.capabilities.canModifyOutput).toBe(false);
    expect(amazonQAdapter.capabilities.canInjectSessionContext).toBe(false);
    // No unverified content surfaces
    expect(amazonQAdapter.capabilities.supportsCommands ?? false).toBe(false);
    expect(amazonQAdapter.capabilities.supportsSkills ?? false).toBe(false);
    expect(amazonQAdapter.capabilities.supportsSubagents ?? false).toBe(false);
    // Transports: stdio + http
    expect(amazonQAdapter.capabilities.transports).toContain("stdio");
    expect(amazonQAdapter.capabilities.transports).toContain("http");
  });
});

// ── path resolution ─────────────────────────────────────────────────────────

describe("amazon-q adapter — path resolution", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
  });

  it("user scope resolves to ~/.aws/amazonq/mcp.json", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const serverPath = amazonQAdapter.getServerConfigPath(ctx);
    expect(serverPath).toBe(join(home, ".aws", "amazonq", "mcp.json"));
  });

  it("project scope resolves to <projectDir>/.amazonq/mcp.json", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const serverPath = amazonQAdapter.getServerConfigPath(ctx);
    expect(serverPath).toBe(join(projectDir, ".amazonq", "mcp.json"));
  });

  it("getHookConfigPath aliases the server config path (no separate hook file)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    expect(amazonQAdapter.getHookConfigPath(ctx)).toBe(
      amazonQAdapter.getServerConfigPath(ctx),
    );
  });

  it("user scope getConfigDir = ~/.aws/amazonq (NOT ~/.amazonq — two segments)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const configDir = amazonQAdapter.getConfigDir(ctx);
    expect(configDir).toBe(join(home, ".aws", "amazonq"));
    // Guard against the single-segment mistake
    expect(configDir).not.toBe(join(home, ".amazonq"));
  });

  it("project scope getConfigDir = <projectDir>/.amazonq (NO .aws)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const configDir = amazonQAdapter.getConfigDir(ctx);
    expect(configDir).toBe(join(projectDir, ".amazonq"));
  });
});

// ── detection ──────────────────────────────────────────────────────────────

describe("amazon-q adapter — detection", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
  });

  it("not installed on a bare box", () => {
    const d = amazonQAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(false);
    expect(d.confidence).toBe("low");
  });

  it("detects ~/.aws/amazonq dir (user scope)", () => {
    mkdirSync(join(home, ".aws", "amazonq"), { recursive: true });
    const d = amazonQAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(true);
    expect(d.scope).toBe("user");
    expect(d.confidence).toBe("high");
    expect(d.configPath).toBe(join(home, ".aws", "amazonq", "mcp.json"));
  });

  it("detects ~/.aws/amazonq/mcp.json (user scope, file only)", () => {
    const dir = join(home, ".aws", "amazonq");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
    const d = amazonQAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(true);
    expect(d.scope).toBe("user");
  });

  it("detects .amazonq dir at project scope", () => {
    mkdirSync(join(projectDir, ".amazonq"), { recursive: true });
    const d = amazonQAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(true);
    expect(d.scope).toBe("project");
    expect(d.configPath).toBe(join(projectDir, ".amazonq", "mcp.json"));
  });

  it("detects .amazonq/mcp.json at project scope (file only)", () => {
    const dir = join(projectDir, ".amazonq");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
    const d = amazonQAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(true);
    expect(d.scope).toBe("project");
  });

  it("prefers user scope when both user and project markers are present", () => {
    mkdirSync(join(home, ".aws", "amazonq"), { recursive: true });
    mkdirSync(join(projectDir, ".amazonq"), { recursive: true });
    const d = amazonQAdapter.detectInstalled(projectDir);
    expect(d.scope).toBe("user");
    expect(d.configPath).toBe(join(home, ".aws", "amazonq", "mcp.json"));
  });

  it("does NOT collide with a bare ~/.aws dir (amazonq subdir must be present)", () => {
    mkdirSync(join(home, ".aws"), { recursive: true });
    const d = amazonQAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(false);
  });
});

// ── MCP server install ──────────────────────────────────────────────────────

describe("amazon-q adapter — MCP install (user scope)", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
  });

  it("writes mcpServers.<id> at ~/.aws/amazonq/mcp.json", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = amazonQAdapter.installServer(ctx);
    expect(changes.every((c) => c.platform === "amazon-q")).toBe(true);
    expect(changes[0]?.action).toBe("create");

    const mcpPath = join(home, ".aws", "amazonq", "mcp.json");
    expect(changes[0]?.path).toBe(mcpPath);
    expect(existsSync(mcpPath)).toBe(true);

    const cfg = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };
    expect(cfg.mcpServers[CONNECTOR_ID]).toBeTruthy();
    expect(cfg.mcpServers[CONNECTOR_ID]!.command).toBe("acme-mcp");
    expect(cfg.mcpServers[CONNECTOR_ID]!.args).toEqual(["--port", "0"]);
  });

  it("BARE entry shape: no `type` discriminator and no `disabled` flag", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    amazonQAdapter.installServer(ctx);
    const mcpPath = join(home, ".aws", "amazonq", "mcp.json");
    const cfg = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    const entry = cfg.mcpServers[CONNECTOR_ID]!;
    expect("type" in entry).toBe(false);
    expect("disabled" in entry).toBe(false);
  });

  it("writes mcpServers.<id> at <projectDir>/.amazonq/mcp.json (project scope)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const changes = amazonQAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const mcpPath = join(projectDir, ".amazonq", "mcp.json");
    expect(changes[0]?.path).toBe(mcpPath);
    expect(existsSync(mcpPath)).toBe(true);
    // User path must NOT be written
    expect(existsSync(join(home, ".aws", "amazonq", "mcp.json"))).toBe(false);
  });

  it("install is idempotent: second install returns skip", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    amazonQAdapter.installServer(ctx);
    const second = amazonQAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");
  });

  it("uninstall removes the entry and returns remove", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    amazonQAdapter.installServer(ctx);
    const removed = amazonQAdapter.uninstallServer(ctx);
    expect(removed[0]?.action).toBe("remove");

    const mcpPath = join(home, ".aws", "amazonq", "mcp.json");
    const cfg = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(CONNECTOR_ID in cfg.mcpServers).toBe(false);
  });

  it("preserves other servers on uninstall", () => {
    const mcpPath = join(home, ".aws", "amazonq", "mcp.json");
    mkdirSync(join(home, ".aws", "amazonq"), { recursive: true });
    writeFileSync(
      mcpPath,
      JSON.stringify({ mcpServers: { "other-tool": { command: "other" } } }),
    );

    const ctx = buildCtx(projectDir, buildConnector(), "user");
    amazonQAdapter.installServer(ctx);
    amazonQAdapter.uninstallServer(ctx);

    const cfg = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect("other-tool" in cfg.mcpServers).toBe(true);
    expect(CONNECTOR_ID in cfg.mcpServers).toBe(false);
  });

  it("update: second install with changed server writes update", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    amazonQAdapter.installServer(ctx);

    // Rebuild with different args
    const changed = buildConnector({
      server: { ...SERVER, args: ["--port", "9999"] },
    });
    const ctx2 = buildCtx(projectDir, changed, "user");
    const result = amazonQAdapter.installServer(ctx2);
    expect(result[0]?.action).toBe("update");
  });

  it("skips when connector declares no server", () => {
    const connector = buildConnector({ server: undefined });
    const ctx = buildCtx(projectDir, connector, "user");
    const changes = amazonQAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("no MCP server");
  });

  it("skips when platform override is false", () => {
    const connector = buildConnector({ platforms: { "amazon-q": { server: false } } });
    const ctx = buildCtx(projectDir, connector, "user");
    const changes = amazonQAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("disabled for amazon-q");
  });
});

// ── remote (http) server ───────────────────────────────────────────────────

describe("amazon-q adapter — remote (http) server", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
  });

  it("http server writes { type: \"http\", url } entry (no headers, no disabled)", () => {
    const connector = buildConnector({
      server: { transport: "http", url: "https://mcp.example.com/mcp" },
    });
    const ctx = buildCtx(projectDir, connector, "user");
    amazonQAdapter.installServer(ctx);

    const mcpPath = join(home, ".aws", "amazonq", "mcp.json");
    const cfg = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    const entry = cfg.mcpServers[CONNECTOR_ID]!;
    // Remote/HTTP shape is primary-verified as { type: "http", url }.
    expect(entry.type).toBe("http");
    expect(entry.url).toBe("https://mcp.example.com/mcp");
    // No invented headers field (Amazon Q remote auth is OAuth, not headers).
    expect("headers" in entry).toBe(false);
    expect("disabled" in entry).toBe(false);
    expect("command" in entry).toBe(false);
  });
});

// ── timeout handling ───────────────────────────────────────────────────────

describe("amazon-q adapter — timeout field", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
  });

  it("emits timeout in MILLISECONDS when timeoutMs is set (no division)", () => {
    const connector = buildConnector({
      server: { ...SERVER, args: [...SERVER.args], timeoutMs: 60000 },
    });
    const ctx = buildCtx(projectDir, connector, "user");
    amazonQAdapter.installServer(ctx);

    const mcpPath = join(home, ".aws", "amazonq", "mcp.json");
    const cfg = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers: Record<string, { timeout?: number }>;
    };
    // Must pass 60000 through unchanged (milliseconds) — NOT divide to 60 (seconds)
    expect(cfg.mcpServers[CONNECTOR_ID]!.timeout).toBe(60000);
  });

  it("omits timeout when timeoutMs is not set", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    amazonQAdapter.installServer(ctx);

    const mcpPath = join(home, ".aws", "amazonq", "mcp.json");
    const cfg = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect("timeout" in cfg.mcpServers[CONNECTOR_ID]!).toBe(false);
  });
});

// ── memory surface (.amazonq/rules — dedicated owned file) ───────────────────

describe("amazon-q adapter — memory (.amazonq/rules/agent-connector.md)", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
  });

  function memFile(): string {
    return join(projectDir, ".amazonq", "rules", "agent-connector.md");
  }

  it("writes .amazonq/rules/agent-connector.md at project scope (plain Markdown)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const changes = amazonQAdapter.installMemory(ctx);
    expect(changes.every((c) => c.platform === "amazon-q")).toBe(true);

    expect(existsSync(memFile())).toBe(true);
    const text = readFileSync(memFile(), "utf8");
    expect(text).toContain("Project guidance for Amazon Q.");
    // No frontmatter is added (Amazon Q auto-applies plain Markdown rules files).
    expect(text.startsWith("---")).toBe(false);
  });

  it("is idempotent and uninstall removes the dedicated block/file", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    amazonQAdapter.installMemory(ctx);
    const second = amazonQAdapter.installMemory(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    amazonQAdapter.uninstallMemory(ctx);
    // AC created the file, so removing its only block deletes the file.
    expect(existsSync(memFile())).toBe(false);
  });

  it("user scope skip-warns (no verified user/global rules dir)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = amazonQAdapter.installMemory(ctx);
    expect(changes.some((c) => c.action === "warn")).toBe(true);
    // Nothing is written under HOME.
    expect(existsSync(join(home, ".aws", "amazonq", "rules"))).toBe(false);
  });

  it("does NOT clobber a pre-existing .amazonq/rules FILE (collision guard)", () => {
    // Legacy/odd form: .amazonq/rules is a FILE, not a directory.
    mkdirSync(join(projectDir, ".amazonq"), { recursive: true });
    const rulesFile = join(projectDir, ".amazonq", "rules");
    writeFileSync(rulesFile, "# hand-written single-file rules\n", "utf8");

    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const changes = amazonQAdapter.installMemory(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
    // The user's file is untouched.
    expect(readFileSync(rulesFile, "utf8")).toBe("# hand-written single-file rules\n");
  });

  it("honors platforms['amazon-q'].memory === false", () => {
    const connector = buildConnector({ platforms: { "amazon-q": { memory: false } } });
    const ctx = buildCtx(projectDir, connector, "project");
    const changes = amazonQAdapter.installMemory(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(memFile())).toBe(false);
  });
});

// ── hooks (unavailable) ────────────────────────────────────────────────────

describe("amazon-q adapter — hooks (mcp-only)", () => {
  let projectDir: string;

  beforeEach(() => {
    ({ projectDir } = freshProject());
  });

  it("installHooks returns a single skip record", () => {
    const connector = buildConnector();
    const ctx = buildCtx(projectDir, connector, "user");
    const changes = amazonQAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("hooks unavailable");
    expect(changes[0]?.platform).toBe("amazon-q");
  });

  it("uninstallHooks returns a single skip record", () => {
    const connector = buildConnector();
    const ctx = buildCtx(projectDir, connector, "user");
    const changes = amazonQAdapter.uninstallHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
  });
});

// ── env interpolation ──────────────────────────────────────────────────────

describe("amazon-q adapter — env interpolation (resolve to literal)", () => {
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
    amazonQAdapter.installServer(ctx);

    const mcpPath = join(home, ".aws", "amazonq", "mcp.json");
    const cfg = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    // Must be resolved to literal, NOT left as ${env:MY_MCP_SECRET}
    expect(cfg.mcpServers[CONNECTOR_ID]!.env?.MY_VAR).toBe("actual-secret-value");
  });
});
