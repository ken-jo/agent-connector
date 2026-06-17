/**
 * adapters/continue.test.ts — Continue (the `cn` terminal agent / Continue.dev)
 * adapter tests.
 *
 * Continue is a **json-stdio** host. Two surfaces live in two SEPARATE files
 * under the per-scope `.continue` dir:
 *   - MCP servers → config.yaml `mcpServers` (a YAML ARRAY of { name, command,
 *     type?, args?, env?, cwd?, url } entries keyed by `name` = the connector id):
 *       user scope    → ~/.continue/config.yaml
 *       project scope → <projectDir>/.continue/config.yaml
 *   - Hooks → settings.json under `hooks`, keyed by PascalCase event name, each
 *     value an array of { matcher?, hooks:[{ type:"command", command }] } —
 *     BYTE-IDENTICAL to Claude Code (continuedev/continue PR #11029). The
 *     user-scope hook dir honors CONTINUE_GLOBAL_DIR (independent of the MCP path).
 *   - Memory → .continue/rules/agent-connector.md with leading `alwaysApply: true`
 *     frontmatter (project scope only; user scope skip-warns).
 *
 * All tests are HOME-isolated via the shared harness (`freshHomeProject` = a
 * separate HOME + project/ subdir + APPDATA/XDG roots) and deterministic.
 *
 * This file is the single per-host home for Continue (tests/README.md: ONE file
 * per host). It merges the former continue.test.ts (MCP / memory / identity) and
 * continue-hooks.test.ts (the Claude-compatible hooks layer).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parse, stringify } from "yaml";
import { beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import continueAdapter from "../../src/adapters/continue/index.js";
import { buildCtx, freshHomeProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { splitFrontmatter } from "../support/fs.js";

// The MCP/memory connector id (former continue.test.ts) and the hooks connector
// id (former continue-hooks.test.ts) are the same literal; kept as one constant.
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

/** MCP/memory connector: a server + a memory entry, no hooks. */
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

/** A connector wiring every event Continue supports + a matcher on PreToolUse. */
function buildHooksConnector(cfg: Partial<ConnectorConfig> = {}): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Continue",
    version: "1.0.0",
    server: { ...SERVER, args: [...SERVER.args] },
    hooks: {
      PreToolUse: { matcher: "Bash", handler: () => ({ decision: "allow" }) },
      PostToolUse: { handler: () => ({ decision: "allow" }) },
      Stop: { handler: () => ({ decision: "allow" }) },
      UserPromptSubmit: { handler: () => ({ decision: "allow" }) },
      PermissionRequest: { handler: () => ({ decision: "allow" }) },
    },
    ...cfg,
  });
}

/** Parse a Continue config.yaml and return its mcpServers array. */
function readMcpServers(path: string): ContinueEntry[] {
  const cfg = parse(readFileSync(path, "utf8")) as { mcpServers?: ContinueEntry[] };
  return cfg.mcpServers ?? [];
}

interface ContinueHookEntry {
  matcher: string;
  hooks: Array<{ type: string; command: string }>;
}

/** Read settings.json and return its `hooks` map. */
function readHooks(path: string): Record<string, ContinueHookEntry[]> {
  const file = JSON.parse(readFileSync(path, "utf8")) as {
    hooks?: Record<string, ContinueHookEntry[]>;
  };
  return file.hooks ?? {};
}

// Shared env isolation + the same-rules-for-every-host baseline contract.
// extraKeys: CONTINUE_GLOBAL_DIR (the hook-dir override) and MY_MCP_SECRET (the
// env-interpolation fixture) are mutated by the blocks below — snapshot/restore
// them too so a test never leaks into the next.
isolateEnv(["CONTINUE_GLOBAL_DIR", "MY_MCP_SECRET"]);
createAdapterSuite({ adapter: continueAdapter, paradigm: "json-stdio" });

// ── identity + capabilities ──────────────────────────────────────────────────

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

describe("continue hooks — capability flags", () => {
  it("declares every event Continue fires and none it does not", () => {
    const c = continueAdapter.capabilities;
    expect(continueAdapter.paradigm).toBe("json-stdio");
    // Supported (continue's HOOK_EVENT_NAMES ∩ canonical).
    expect(c.preToolUse).toBe(true);
    expect(c.postToolUse).toBe(true);
    expect(c.postToolUseFailure).toBe(true);
    expect(c.userPromptSubmit).toBe(true);
    expect(c.sessionStart).toBe(true);
    expect(c.sessionEnd).toBe(true);
    expect(c.stop).toBe(true);
    expect(c.notification).toBe(true);
    expect(c.subagentStart).toBe(true);
    expect(c.subagentStop).toBe(true);
    expect(c.permissionRequest).toBe(true);
    // PreCompact IS in continue's HOOK_EVENT_NAMES (PreCompactInput).
    expect(c.preCompact).toBe(true);
    // NOT supported — only PostCompact is absent from continue's set.
    expect(c.postCompact ?? false).toBe(false);
    // Native passthrough surface (the 5 host-specific events).
    expect(c.supportsNativeHooks).toBe(true);
    // Capability triad.
    expect(c.canModifyArgs).toBe(true);
    expect(c.canModifyOutput).toBe(false);
    expect(c.canInjectSessionContext).toBe(true);
  });
});

// ── path resolution ─────────────────────────────────────────────────────────

describe("continue adapter — path resolution", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject());
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

// ── hook config path (settings.json honoring CONTINUE_GLOBAL_DIR) ────────────

describe("continue hooks — config path", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject());
    // The shared harness does not touch CONTINUE_GLOBAL_DIR; clear it so each
    // test starts from the unset default (isolateEnv restores it afterEach).
    delete process.env.CONTINUE_GLOBAL_DIR;
  });

  it("user scope → ~/.continue/settings.json (separate from config.yaml)", () => {
    const ctx = buildCtx(projectDir, buildHooksConnector(), "user");
    expect(continueAdapter.getHookConfigPath(ctx)).toBe(
      join(home, ".continue", "settings.json"),
    );
  });

  it("project scope → <projectDir>/.continue/settings.json", () => {
    const ctx = buildCtx(projectDir, buildHooksConnector(), "project");
    expect(continueAdapter.getHookConfigPath(ctx)).toBe(
      join(projectDir, ".continue", "settings.json"),
    );
  });

  it("user scope honors CONTINUE_GLOBAL_DIR for the hook file (not the MCP file)", () => {
    const customDir = join(home, "custom-continue");
    process.env.CONTINUE_GLOBAL_DIR = customDir;
    const ctx = buildCtx(projectDir, buildHooksConnector(), "user");
    expect(continueAdapter.getHookConfigPath(ctx)).toBe(
      join(customDir, "settings.json"),
    );
    // The MCP server path is INTENTIONALLY independent of CONTINUE_GLOBAL_DIR.
    expect(continueAdapter.getServerConfigPath(ctx)).toBe(
      join(home, ".continue", "config.yaml"),
    );
  });
});

// ── detection ──────────────────────────────────────────────────────────────

describe("continue adapter — detection", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject());
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
    // NOTE: the `.config/goose` dir here is an INCIDENTAL sibling-marker seed for
    // a continue negative-detection assertion — it is not a goose-owned test.
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
    ({ home, projectDir } = freshHomeProject());
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
    ({ home, projectDir } = freshHomeProject());
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
    ({ home, projectDir } = freshHomeProject());
    process.env.MY_MCP_SECRET = "actual-secret-value";
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
    ({ home, projectDir } = freshHomeProject());
  });

  function memFile(): string {
    return join(projectDir, ".continue", "rules", "agent-connector.md");
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

// ── hooks (json-stdio — basic skip paths) ────────────────────────────────────

describe("continue adapter — hooks (json-stdio, skip paths)", () => {
  let projectDir: string;

  beforeEach(() => {
    ({ projectDir } = freshHomeProject());
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

// ── installHooks writes the home-bin command + matcher ───────────────────────

describe("continue hooks — install", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject());
    delete process.env.CONTINUE_GLOBAL_DIR;
  });

  function settingsPath(): string {
    return join(home, ".continue", "settings.json");
  }

  it("writes hooks.<Event> with the home-bin command and PascalCase keys", () => {
    const ctx = buildCtx(projectDir, buildHooksConnector(), "user");
    const changes = continueAdapter.installHooks(ctx);
    expect(changes.every((c) => c.platform === "continue")).toBe(true);
    expect(changes.some((c) => c.action === "create")).toBe(true);
    expect(existsSync(settingsPath())).toBe(true);

    const hooks = readHooks(settingsPath());
    expect(Object.keys(hooks).sort()).toEqual(
      ["PermissionRequest", "PostToolUse", "PreToolUse", "Stop", "UserPromptSubmit"].sort(),
    );

    const entry = hooks.PreToolUse![0]!;
    // Matcher carried through from the hook definition.
    expect(entry.matcher).toBe("Bash");
    expect(entry.hooks[0]!.type).toBe("command");
    // Claude-shaped home-bin command anchored at the host + event + connector id.
    expect(entry.hooks[0]!.command).toContain(HOME_BIN);
    expect(entry.hooks[0]!.command).toContain("continue");
    expect(entry.hooks[0]!.command).toContain("PreToolUse");
    expect(entry.hooks[0]!.command).toContain(CONNECTOR_ID);

    // Events with no matcher write an empty-string matcher.
    expect(hooks.Stop![0]!.matcher).toBe("");
  });

  it("installs PreCompact (now in continue's HOOK_EVENT_NAMES)", () => {
    const connector = buildHooksConnector({
      hooks: {
        PreToolUse: { handler: () => ({ decision: "allow" }) },
        PreCompact: { handler: () => ({ decision: "allow" }) },
      },
    });
    const ctx = buildCtx(projectDir, connector, "user");
    continueAdapter.installHooks(ctx);
    const hooks = readHooks(settingsPath());
    expect(hooks.PreCompact).toBeDefined();
    const cmd = hooks.PreCompact![0]!.hooks[0]!.command;
    expect(cmd).toContain(HOME_BIN);
    expect(cmd).toContain("continue");
    expect(cmd).toContain("PreCompact");
    expect(cmd).toContain(CONNECTOR_ID);
  });

  it("warn-skips an event Continue has no equivalent for (PostCompact)", () => {
    const connector = buildHooksConnector({
      hooks: {
        PreToolUse: { handler: () => ({ decision: "allow" }) },
        PostCompact: { handler: () => ({ decision: "allow" }) },
      },
    });
    const ctx = buildCtx(projectDir, connector, "user");
    const changes = continueAdapter.installHooks(ctx);
    const warn = changes.find((c) => c.action === "warn");
    expect(warn?.detail).toContain("PostCompact");
    expect(warn?.detail).toContain("no Continue hook equivalent");
    // PostCompact must NOT land in the file.
    expect(Object.keys(readHooks(settingsPath()))).not.toContain("PostCompact");
  });

  it("is idempotent: a second install reports skip and writes no duplicate", () => {
    const ctx = buildCtx(projectDir, buildHooksConnector(), "user");
    continueAdapter.installHooks(ctx);
    const second = continueAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
    expect(readHooks(settingsPath()).PreToolUse).toHaveLength(1);
  });

  it("preserves a user's pre-existing hook on the same event", () => {
    mkdirSync(join(home, ".continue"), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "user-tool" }] }],
        },
      }),
    );
    const ctx = buildCtx(projectDir, buildHooksConnector(), "user");
    continueAdapter.installHooks(ctx);

    const bucket = readHooks(settingsPath()).PreToolUse!;
    expect(bucket).toHaveLength(2);
    expect(bucket.some((e) => e.hooks[0]!.command === "user-tool")).toBe(true);
    expect(bucket.some((e) => e.hooks[0]!.command.includes(HOME_BIN))).toBe(true);
  });

  it("honors platforms['continue'].hooks === false", () => {
    const connector = buildHooksConnector({ platforms: { continue: { hooks: false } } });
    const ctx = buildCtx(projectDir, connector, "user");
    const changes = continueAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("hooks disabled for continue");
    expect(existsSync(settingsPath())).toBe(false);
  });

  it("uninstall strips ONLY our command and leaves the user's hook in place", () => {
    mkdirSync(join(home, ".continue"), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "user-tool" }] }],
        },
      }),
    );
    const ctx = buildCtx(projectDir, buildHooksConnector(), "user");
    continueAdapter.installHooks(ctx);
    const removed = continueAdapter.uninstallHooks(ctx);
    expect(removed.some((c) => c.action === "remove")).toBe(true);

    const hooks = readHooks(settingsPath());
    const bucket = hooks.PreToolUse!;
    expect(bucket).toHaveLength(1);
    expect(bucket[0]!.hooks[0]!.command).toBe("user-tool");
    // Events that held ONLY our command are dropped entirely.
    expect(hooks.Stop).toBeUndefined();
  });
});

// ── parseEvent ───────────────────────────────────────────────────────────────

describe("continue hooks — parseEvent", () => {
  it("PreToolUse normalizes tool_name + tool_input (+ connector id, cwd)", () => {
    const ev = continueAdapter.parseEvent!("PreToolUse", {
      connector: CONNECTOR_ID,
      cwd: "/work/proj",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    expect(ev.hostPlatform).toBe("continue");
    expect(ev.connectorId).toBe(CONNECTOR_ID);
    expect(ev.projectDir).toBe("/work/proj");
    expect((ev as { toolName: string }).toolName).toBe("Bash");
    expect((ev as { toolInput: unknown }).toolInput).toEqual({ command: "ls" });
  });

  it("UserPromptSubmit normalizes the prompt", () => {
    const ev = continueAdapter.parseEvent!("UserPromptSubmit", {
      connector: CONNECTOR_ID,
      prompt: "hello there",
    });
    expect((ev as { prompt: string }).prompt).toBe("hello there");
  });

  it("PreCompact normalizes the trigger (auto|manual)", () => {
    const ev = continueAdapter.parseEvent!("PreCompact", {
      connector: CONNECTOR_ID,
      cwd: "/work/proj",
      trigger: "auto",
    });
    expect(ev.hostPlatform).toBe("continue");
    expect((ev as { trigger?: string }).trigger).toBe("auto");
  });

  it("throws on an event Continue never delivers (PostCompact)", () => {
    expect(() => continueAdapter.parseEvent!("PostCompact", {})).toThrow(
      /unsupported continue hook event/,
    );
  });
});

// ── formatReply (Claude-identical shapes) ────────────────────────────────────

describe("continue hooks — formatReply", () => {
  it("PreToolUse deny → hookSpecificOutput.permissionDecision:'deny'", () => {
    const reply = continueAdapter.formatReply!("PreToolUse", {
      decision: "deny",
      reason: "blocked cmd",
    });
    expect(reply.exitCode).toBe(0);
    const out = JSON.parse(reply.stdout!);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("blocked cmd");
  });

  it("PreToolUse modify → hookSpecificOutput.updatedInput (canModifyArgs)", () => {
    const reply = continueAdapter.formatReply!("PreToolUse", {
      decision: "modify",
      updatedInput: { command: "ls -la" },
    });
    const out = JSON.parse(reply.stdout!);
    expect(out.hookSpecificOutput.updatedInput).toEqual({ command: "ls -la" });
  });

  it("PostToolUse deny → TOP-LEVEL { decision:'block', reason }", () => {
    const reply = continueAdapter.formatReply!("PostToolUse", {
      decision: "deny",
      reason: "bad output",
    });
    const out = JSON.parse(reply.stdout!);
    expect(out.decision).toBe("block");
    expect(out.reason).toBe("bad output");
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it("Stop deny → TOP-LEVEL { decision:'block', reason }", () => {
    const reply = continueAdapter.formatReply!("Stop", {
      decision: "deny",
      reason: "keep going",
    });
    const out = JSON.parse(reply.stdout!);
    expect(out.decision).toBe("block");
    expect(out.reason).toBe("keep going");
  });

  it("UserPromptSubmit deny → TOP-LEVEL { decision:'block', reason }", () => {
    const reply = continueAdapter.formatReply!("UserPromptSubmit", {
      decision: "deny",
      reason: "rejected",
    });
    const out = JSON.parse(reply.stdout!);
    expect(out.decision).toBe("block");
    expect(out.reason).toBe("rejected");
  });

  it("PermissionRequest deny → nested decision{ behavior:'deny', message }", () => {
    const reply = continueAdapter.formatReply!("PermissionRequest", {
      decision: "deny",
      reason: "no",
    });
    const out = JSON.parse(reply.stdout!);
    expect(out.hookSpecificOutput.decision.behavior).toBe("deny");
    expect(out.hookSpecificOutput.decision.message).toBe("no");
  });

  it("PermissionRequest allow → nested decision{ behavior:'allow' } (active grant)", () => {
    const reply = continueAdapter.formatReply!("PermissionRequest", {
      decision: "allow",
    });
    const out = JSON.parse(reply.stdout!);
    expect(out.hookSpecificOutput.decision.behavior).toBe("allow");
  });

  it("context → hookSpecificOutput.additionalContext", () => {
    const reply = continueAdapter.formatReply!("SessionStart", {
      decision: "context",
      additionalContext: "remember X",
    });
    const out = JSON.parse(reply.stdout!);
    expect(out.hookSpecificOutput.additionalContext).toBe("remember X");
  });

  it("allow → exit 0 with no stdout payload", () => {
    const reply = continueAdapter.formatReply!("PreToolUse", { decision: "allow" });
    expect(reply.exitCode).toBe(0);
    expect(reply.stdout).toBeUndefined();
  });
});

// ── nativeHooks passthrough (the 5 host-specific events) ─────────────────────

describe("continue hooks — nativeHooks passthrough", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject());
    delete process.env.CONTINUE_GLOBAL_DIR;
  });

  function settingsPath(): string {
    return join(home, ".continue", "settings.json");
  }

  /** Normalized PreToolUse + a continue-native WorktreeCreate (no canonical analog). */
  function nativeConnector(): ResolvedConnector {
    return defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme Continue",
      version: "1.0.0",
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: {
        continue: {
          nativeHooks: {
            WorktreeCreate: { matcher: "main", handler: () => ({}) },
          },
        },
      },
    });
  }

  it("declares supportsNativeHooks true", () => {
    expect(continueAdapter.capabilities.supportsNativeHooks).toBe(true);
  });

  it("files the native WorktreeCreate key VERBATIM beside the canonical PreToolUse", () => {
    const ctx = buildCtx(projectDir, nativeConnector(), "user");
    continueAdapter.installHooks(ctx);
    const hooks = readHooks(settingsPath());

    expect(hooks.PreToolUse![0]!.hooks[0]!.command).toContain("hook continue PreToolUse");
    // Native key filed verbatim (no SUPPORTED_EVENTS gate) with the native token.
    const native = hooks.WorktreeCreate![0]!;
    expect(native.hooks[0]!.command).toContain("hook continue WorktreeCreate");
    expect(native.hooks[0]!.command).toContain(HOME_BIN);
    expect(native.hooks[0]!.command).toContain(`--connector ${CONNECTOR_ID}`);
    // The native matcher rides through verbatim.
    expect(native.matcher).toBe("main");
  });

  it("installs the native event even when normalized hooks are disabled (hooks:false sibling)", () => {
    const connector = defineConnector({
      id: CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: {
        continue: { hooks: false, nativeHooks: { WorktreeCreate: { handler: () => ({}) } } },
      },
    });
    const ctx = buildCtx(projectDir, connector, "user");
    continueAdapter.installHooks(ctx);
    const hooks = readHooks(settingsPath());
    expect(hooks.WorktreeCreate![0]!.hooks[0]!.command).toContain("hook continue WorktreeCreate");
    // Normalized events suppressed by hooks:false.
    expect(hooks.PreToolUse).toBeUndefined();
  });

  it("is idempotent (second install → skip) and uninstall strips the native key", () => {
    const ctx = buildCtx(projectDir, nativeConnector(), "user");
    continueAdapter.installHooks(ctx);
    const second = continueAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    continueAdapter.uninstallHooks(ctx);
    const hooks = readHooks(settingsPath());
    // The native key held ONLY our command → dropped entirely on uninstall.
    expect(hooks.WorktreeCreate).toBeUndefined();
    expect(JSON.stringify(hooks)).not.toContain(HOME_BIN);
  });
});

// ── regression: the MCP install path stays untouched ─────────────────────────

describe("continue hooks — MCP regression (config.yaml mcpServers untouched)", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject());
    delete process.env.CONTINUE_GLOBAL_DIR;
  });

  it("installServer still writes the mcpServers YAML ARRAY to config.yaml", () => {
    const ctx = buildCtx(projectDir, buildHooksConnector(), "user");
    // Installing hooks must NOT disturb the MCP file.
    continueAdapter.installHooks(ctx);
    const changes = continueAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const cfgPath = join(home, ".continue", "config.yaml");
    expect(changes[0]?.path).toBe(cfgPath);
    const cfg = parse(readFileSync(cfgPath, "utf8")) as {
      mcpServers?: Array<Record<string, unknown>>;
    };
    expect(Array.isArray(cfg.mcpServers)).toBe(true);
    expect(cfg.mcpServers).toHaveLength(1);
    const entry = cfg.mcpServers![0]!;
    expect(entry.name).toBe(CONNECTOR_ID);
    expect(entry.command).toBe("acme-mcp");
    // The MCP file must carry NO hooks key — hooks live in settings.json.
    expect("hooks" in cfg).toBe(false);

    // And the settings.json (hooks) must carry NO mcpServers key.
    const settings = JSON.parse(
      readFileSync(join(home, ".continue", "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect("mcpServers" in settings).toBe(false);
    expect("hooks" in settings).toBe(true);
  });
});
