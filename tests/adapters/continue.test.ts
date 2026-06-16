/**
 * adapters/continue.test.ts — Continue (the `cn` terminal agent / Continue.dev)
 * adapter tests.
 *
 * Continue is an mcp-only host. It registers MCP servers in a YAML config:
 *   user scope    → ~/.continue/config.yaml
 *   project scope → <projectDir>/.continue/config.yaml
 * Root key `mcpServers` is a YAML ARRAY of { name, command, type?, args?, env?,
 * cwd?, url } entries (NOT a keyed map). Entries are keyed by `name` (= the
 * connector id): set-if-absent on install (append/leave/update), remove-by-name
 * on uninstall, siblings always preserved.
 *
 * All tests are HOME-isolated (mkdtemp + redirected HOME/USERPROFILE/APPDATA/
 * XDG) and deterministic. The written file is parsed back with the repo's `yaml`
 * lib and asserted as structured data.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse, stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import continueAdapter from "../../src/adapters/continue/index.js";

const CONNECTOR_ID = "acme-continue";

const SERVER = {
  transport: "stdio",
  command: "acme-mcp",
  args: ["--port", "0"],
  // Disable the transparent telemetry serve-wrapper so the rendered entry holds
  // the literal command/args (the wrap behavior is covered by spawn/render tests).
  wrapForTelemetry: false,
} as const;

interface ContinueEntry {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  type?: string;
  url?: string;
}

function buildConnector(cfg: Partial<ConnectorConfig> = {}): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Continue",
    version: "1.0.0",
    server: { ...SERVER, args: [...SERVER.args] },
    memory: [{ content: "Project guidance for Continue." }],
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

/** Parse a Continue config.yaml and return its mcpServers array. */
function readMcpServers(path: string): ContinueEntry[] {
  const cfg = parse(readFileSync(path, "utf8")) as { mcpServers?: ContinueEntry[] };
  return cfg.mcpServers ?? [];
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

/** Fresh isolated HOME + project dir. HOME drives ~/.continue (user scope). */
function freshProject(): { home: string; projectDir: string } {
  const home = mkdtempSync(join(tmpdir(), "ac-continue-"));
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

describe("continue adapter — identity + capabilities", () => {
  it("is a json-stdio host with the right identity and surface flags", () => {
    expect(continueAdapter.id).toBe("continue");
    expect(continueAdapter.name).toBe("Continue");
    // json-stdio: the `cn` CLI ships a Claude-Code-compatible hooks system (PR #11029).
    expect(continueAdapter.paradigm).toBe("json-stdio");
    // Memory is WIRED (Continue reads .continue/rules, not AGENTS.md): the
    // adapter declares supportsMemory and writes a dedicated always-on rule file.
    expect(continueAdapter.capabilities.supportsMemory).toBe(true);
    // hooks WIRED (Claude-compatible).
    expect(continueAdapter.capabilities.preToolUse).toBe(true);
    expect(continueAdapter.capabilities.postToolUse).toBe(true);
    expect(continueAdapter.capabilities.canModifyArgs).toBe(true);
    expect(continueAdapter.capabilities.canModifyOutput).toBe(false);
    expect(continueAdapter.capabilities.canInjectSessionContext).toBe(true);
    // No unverified content surfaces
    expect(continueAdapter.capabilities.supportsCommands ?? false).toBe(false);
    expect(continueAdapter.capabilities.supportsSkills ?? false).toBe(false);
    expect(continueAdapter.capabilities.supportsSubagents ?? false).toBe(false);
    // Transports: stdio + remote (sse + http=streamable-http)
    expect(continueAdapter.capabilities.transports).toContain("stdio");
    expect(continueAdapter.capabilities.transports).toContain("sse");
    expect(continueAdapter.capabilities.transports).toContain("http");
  });
});

// ── path resolution ─────────────────────────────────────────────────────────

describe("continue adapter — path resolution", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
  });

  it("user scope resolves to ~/.continue/config.yaml", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    expect(continueAdapter.getServerConfigPath(ctx)).toBe(
      join(home, ".continue", "config.yaml"),
    );
  });

  it("project scope resolves to <projectDir>/.continue/config.yaml", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    expect(continueAdapter.getServerConfigPath(ctx)).toBe(
      join(projectDir, ".continue", "config.yaml"),
    );
  });

  it("getHookConfigPath is a SEPARATE settings.json (not the MCP config.yaml)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    // Hooks live in settings.json, distinct from the YAML config.yaml MCP file.
    expect(continueAdapter.getHookConfigPath(ctx)).toBe(
      join(home, ".continue", "settings.json"),
    );
    expect(continueAdapter.getHookConfigPath(ctx)).not.toBe(
      continueAdapter.getServerConfigPath(ctx),
    );
  });

  it("user scope getConfigDir = ~/.continue", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    expect(continueAdapter.getConfigDir(ctx)).toBe(join(home, ".continue"));
  });

  it("project scope getConfigDir = <projectDir>/.continue", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    expect(continueAdapter.getConfigDir(ctx)).toBe(join(projectDir, ".continue"));
  });
});

// ── detection ──────────────────────────────────────────────────────────────

describe("continue adapter — detection", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
  });

  it("not installed on a bare box", () => {
    const d = continueAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(false);
    expect(d.confidence).toBe("low");
  });

  it("detects ~/.continue dir (user scope)", () => {
    mkdirSync(join(home, ".continue"), { recursive: true });
    const d = continueAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(true);
    expect(d.scope).toBe("user");
    expect(d.confidence).toBe("high");
    expect(d.configPath).toBe(join(home, ".continue", "config.yaml"));
  });

  it("detects ~/.continue/config.yaml (user scope, file only)", () => {
    const dir = join(home, ".continue");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), stringify({ mcpServers: [] }));
    const d = continueAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(true);
    expect(d.scope).toBe("user");
  });

  it("detects <projectDir>/.continue/config.yaml at project scope", () => {
    const dir = join(projectDir, ".continue");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), stringify({ mcpServers: [] }));
    const d = continueAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(true);
    expect(d.scope).toBe("project");
    expect(d.configPath).toBe(join(projectDir, ".continue", "config.yaml"));
  });

  it("prefers user scope when both user and project markers are present", () => {
    mkdirSync(join(home, ".continue"), { recursive: true });
    mkdirSync(join(projectDir, ".continue"), { recursive: true });
    const d = continueAdapter.detectInstalled(projectDir);
    expect(d.scope).toBe("user");
    expect(d.configPath).toBe(join(home, ".continue", "config.yaml"));
  });

  it("does NOT collide with other adapters' dirs (.continue must be present)", () => {
    // Seed sibling adapter markers; none should make Continue detect as installed.
    mkdirSync(join(home, ".aws", "amazonq"), { recursive: true });
    mkdirSync(join(home, ".hermes"), { recursive: true });
    mkdirSync(join(home, ".config", "goose"), { recursive: true });
    const d = continueAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(false);
  });
});

// ── MCP server install (the YAML ARRAY) ─────────────────────────────────────

describe("continue adapter — MCP install (array, user scope)", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
  });

  function userCfgPath(): string {
    return join(home, ".continue", "config.yaml");
  }

  it("appends an entry to the mcpServers ARRAY at ~/.continue/config.yaml", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = continueAdapter.installServer(ctx);
    expect(changes.every((c) => c.platform === "continue")).toBe(true);
    expect(changes[0]?.action).toBe("create");

    const path = userCfgPath();
    expect(changes[0]?.path).toBe(path);
    expect(existsSync(path)).toBe(true);

    const list = readMcpServers(path);
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(1);
    const entry = list[0]!;
    expect(entry.name).toBe(CONNECTOR_ID);
    expect(entry.command).toBe("acme-mcp");
    expect(entry.args).toEqual(["--port", "0"]);
  });

  it("stdio entry omits `type` and never emits apiKey/requestOptions/connectionTimeout", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    continueAdapter.installServer(ctx);
    const entry = readMcpServers(userCfgPath())[0]! as unknown as Record<string, unknown>;
    // stdio: default transport → no `type` key.
    expect("type" in entry).toBe(false);
    // Never-verified fields must NOT appear.
    expect("apiKey" in entry).toBe(false);
    expect("requestOptions" in entry).toBe(false);
    expect("connectionTimeout" in entry).toBe(false);
  });

  it("preserves a pre-seeded sibling entry when appending ours", () => {
    const path = userCfgPath();
    mkdirSync(join(home, ".continue"), { recursive: true });
    writeFileSync(
      path,
      stringify({
        mcpServers: [{ name: "other-tool", command: "other" }],
      }),
    );

    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = continueAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const list = readMcpServers(path);
    expect(list.map((e) => e.name).sort()).toEqual([CONNECTOR_ID, "other-tool"].sort());
    const other = list.find((e) => e.name === "other-tool")!;
    expect(other.command).toBe("other");
  });

  it("skip-and-warn on a malformed (non-array) mcpServers — never clobbers it", () => {
    const path = userCfgPath();
    mkdirSync(join(home, ".continue"), { recursive: true });
    // A hand-written non-array mcpServers (e.g. a JSON-style map). Install must
    // NOT silently replace it.
    const original = stringify({ mcpServers: { "other-tool": { command: "x" } } });
    writeFileSync(path, original);

    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = continueAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("skip");
    // File is byte-for-byte untouched.
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("install is idempotent: second install returns skip", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    continueAdapter.installServer(ctx);
    const second = continueAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");
    // No duplicate entry appended.
    expect(readMcpServers(userCfgPath())).toHaveLength(1);
  });

  it("update: second install with changed server writes update (entry replaced in place)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    continueAdapter.installServer(ctx);

    const changed = buildConnector({ server: { ...SERVER, args: ["--port", "9999"] } });
    const ctx2 = buildCtx(projectDir, changed, "user");
    const result = continueAdapter.installServer(ctx2);
    expect(result[0]?.action).toBe("update");

    const list = readMcpServers(userCfgPath());
    expect(list).toHaveLength(1);
    expect(list[0]!.args).toEqual(["--port", "9999"]);
  });

  it("writes the array at <projectDir>/.continue/config.yaml (project scope)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const changes = continueAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const path = join(projectDir, ".continue", "config.yaml");
    expect(changes[0]?.path).toBe(path);
    expect(existsSync(path)).toBe(true);
    // User path must NOT be written.
    expect(existsSync(userCfgPath())).toBe(false);
  });

  it("uninstall removes ONLY our entry and preserves siblings", () => {
    const path = userCfgPath();
    mkdirSync(join(home, ".continue"), { recursive: true });
    writeFileSync(
      path,
      stringify({ mcpServers: [{ name: "other-tool", command: "other" }] }),
    );

    const ctx = buildCtx(projectDir, buildConnector(), "user");
    continueAdapter.installServer(ctx);
    const removed = continueAdapter.uninstallServer(ctx);
    expect(removed[0]?.action).toBe("remove");

    const list = readMcpServers(path);
    expect(list.map((e) => e.name)).toEqual(["other-tool"]);
  });

  it("uninstall on an absent entry returns skip", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const removed = continueAdapter.uninstallServer(ctx);
    expect(removed[0]?.action).toBe("skip");
  });

  it("skips when connector declares no server", () => {
    const connector = buildConnector({ server: undefined });
    const ctx = buildCtx(projectDir, connector, "user");
    const changes = continueAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("no MCP server");
  });

  it("skips when platform override is false", () => {
    const connector = buildConnector({ platforms: { continue: { server: false } } });
    const ctx = buildCtx(projectDir, connector, "user");
    const changes = continueAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("disabled for continue");
  });
});

// ── remote (sse / streamable-http) server ───────────────────────────────────

describe("continue adapter — remote server (type + url)", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
  });

  function userCfgPath(): string {
    return join(home, ".continue", "config.yaml");
  }

  it("http server writes { name, type: \"streamable-http\", url } (no command)", () => {
    const connector = buildConnector({
      server: { transport: "http", url: "https://mcp.example.com/mcp" },
    });
    const ctx = buildCtx(projectDir, connector, "user");
    continueAdapter.installServer(ctx);

    const entry = readMcpServers(userCfgPath())[0]! as unknown as Record<string, unknown>;
    expect(entry.name).toBe(CONNECTOR_ID);
    expect(entry.type).toBe("streamable-http");
    expect(entry.url).toBe("https://mcp.example.com/mcp");
    expect("command" in entry).toBe(false);
    expect("apiKey" in entry).toBe(false);
  });

  it("sse server writes { name, type: \"sse\", url }", () => {
    const connector = buildConnector({
      server: { transport: "sse", url: "https://mcp.example.com/sse" },
    });
    const ctx = buildCtx(projectDir, connector, "user");
    continueAdapter.installServer(ctx);

    const entry = readMcpServers(userCfgPath())[0]! as unknown as Record<string, unknown>;
    expect(entry.type).toBe("sse");
    expect(entry.url).toBe("https://mcp.example.com/sse");
    expect("command" in entry).toBe(false);
  });
});

// ── env map ──────────────────────────────────────────────────────────────────

describe("continue adapter — env interpolation (resolve to literal)", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
    process.env.MY_MCP_SECRET = "actual-secret-value";
  });

  afterEach(() => {
    delete process.env.MY_MCP_SECRET;
  });

  it("emits an env map and resolves ${env:VAR} to a literal at install time", () => {
    const connector = buildConnector({
      server: {
        ...SERVER,
        args: [...SERVER.args],
        env: { MY_VAR: "${env:MY_MCP_SECRET}", LITERAL: "plain" },
      },
    });
    const ctx = buildCtx(projectDir, connector, "user");
    continueAdapter.installServer(ctx);

    const entry = readMcpServers(join(home, ".continue", "config.yaml"))[0]!;
    expect(entry.env?.MY_VAR).toBe("actual-secret-value");
    expect(entry.env?.LITERAL).toBe("plain");
  });
});

// ── memory surface (.continue/rules — dedicated always-on file) ──────────────

describe("continue adapter — memory (.continue/rules/agent-connector.md)", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
  });

  function memFile(): string {
    return join(projectDir, ".continue", "rules", "agent-connector.md");
  }

  /** Split a md+frontmatter document into { frontmatter, body }. */
  function splitFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
    const m = text.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
    if (!m) throw new Error(`not a frontmatter doc:\n${text}`);
    return { frontmatter: parse(m[1]!) as Record<string, unknown>, body: m[2]! };
  }

  it("writes .continue/rules/agent-connector.md with `alwaysApply: true` frontmatter", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const changes = continueAdapter.installMemory(ctx);
    expect(changes.every((c) => c.platform === "continue")).toBe(true);
    expect(changes[0]?.action).toBe("create");

    expect(existsSync(memFile())).toBe(true);
    const { frontmatter, body } = splitFrontmatter(readFileSync(memFile(), "utf8"));
    // Always-on directive must be a real YAML boolean (not the string "true").
    expect(frontmatter.alwaysApply).toBe(true);
    expect(body).toContain("Project guidance for Continue.");
  });

  it("is idempotent and uninstall deletes the dedicated file", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    continueAdapter.installMemory(ctx);
    const second = continueAdapter.installMemory(ctx);
    expect(second[0]?.action).toBe("skip");

    continueAdapter.uninstallMemory(ctx);
    expect(existsSync(memFile())).toBe(false);
  });

  it("user scope skip-warns (no verified user/global rules dir)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = continueAdapter.installMemory(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
    expect(existsSync(join(home, ".continue", "rules"))).toBe(false);
  });

  it("does NOT clobber a pre-existing .continue/rules FILE (collision guard)", () => {
    mkdirSync(join(projectDir, ".continue"), { recursive: true });
    const rulesFile = join(projectDir, ".continue", "rules");
    writeFileSync(rulesFile, "# hand-written rules file\n", "utf8");

    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const changes = continueAdapter.installMemory(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
    expect(readFileSync(rulesFile, "utf8")).toBe("# hand-written rules file\n");
  });

  it("honors platforms['continue'].memory === false", () => {
    const connector = buildConnector({ platforms: { continue: { memory: false } } });
    const ctx = buildCtx(projectDir, connector, "project");
    const changes = continueAdapter.installMemory(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(memFile())).toBe(false);
  });
});

// ── hooks (json-stdio — basic skip behavior; full coverage in continue-hooks) ─

describe("continue adapter — hooks (json-stdio, skip paths)", () => {
  let projectDir: string;

  beforeEach(() => {
    ({ projectDir } = freshProject());
  });

  it("installHooks skips when the connector declares no hooks", () => {
    // buildConnector declares no `hooks` → connector.hookEvents is empty.
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = continueAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("no hooks");
    expect(changes[0]?.platform).toBe("continue");
  });

  it("uninstallHooks skips when no settings.json hooks section is present", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = continueAdapter.uninstallHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
  });
});
