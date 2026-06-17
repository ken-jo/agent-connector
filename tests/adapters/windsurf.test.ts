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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import windsurfAdapter from "../../src/adapters/windsurf/index.js";
import { buildCtx, freshHomeProject, isolateEnv } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";

const CONNECTOR_ID = "acme-windsurf";

const SERVER = {
  transport: "stdio",
  command: "acme-mcp",
  args: ["--port", "0"],
  // Disable the transparent telemetry serve-wrapper so the rendered entry holds
  // the literal command/args (the wrap behavior is covered by spawn/render tests).
  wrapForTelemetry: false,
} as const;

/** A minimal valid server to satisfy defineConnector's "declare ≥1 surface" rule
 * in the zero-commands / zero-skills cases (no MCP behavior is exercised). */
const SERVER_DEF = {
  transport: "stdio",
  command: "acme-mcp",
  wrapForTelemetry: false,
} as const;

const COMMAND = {
  name: "deploy",
  description: "Deploy the app to an environment.",
  prompt: "Deploy to $ARGUMENTS and report the result.",
  argumentHint: "[environment]",
  tools: { allow: ["Bash", "Read"] },
  model: "sonnet",
} as const;

const SKILL = {
  name: "pdf-tools",
  description: "Extract and summarize text from PDF files.",
  body: "# PDF Tools\n\nUse the bundled script to extract text.",
  model: "haiku",
  tools: { allow: ["Bash"] },
  disableModelInvocation: false,
  resources: { "scripts/extract.sh": "#!/bin/sh\necho extracting\n" },
} as const;

function command() {
  return { ...COMMAND, tools: { allow: [...COMMAND.tools.allow] } };
}
function skill() {
  return {
    ...SKILL,
    tools: { allow: [...SKILL.tools.allow] },
    resources: { ...SKILL.resources },
  };
}

function buildConnector(cfg: Partial<ConnectorConfig> = {}): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Windsurf",
    version: "1.0.0",
    server: { ...SERVER, args: [...SERVER.args] },
    ...cfg,
  });
}

// ── native path helpers ──────────────────────────────────────────────────────
/** The user-scope MCP config path under the isolated HOME. */
function userMcpPath(home: string): string {
  return join(home, ".codeium", "windsurf", "mcp_config.json");
}
function workflowPath(projectDir: string, name: string): string {
  return join(projectDir, ".windsurf", "workflows", `${name}.md`);
}
function skillMdPath(projectDir: string, name: string): string {
  return join(projectDir, ".windsurf", "skills", name, "SKILL.md");
}
// User/global-scope: the user workflows dir is `global_workflows`, the user
// skills dir is `skills`.
function userWorkflowPath(home: string, name: string): string {
  return join(home, ".codeium", "windsurf", "global_workflows", `${name}.md`);
}
function userSkillMdPath(home: string, name: string): string {
  return join(home, ".codeium", "windsurf", "skills", name, "SKILL.md");
}

/** Split a md+frontmatter document into { frontmatter, body }. */
function splitFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  if (!m) throw new Error(`not a frontmatter doc:\n${text}`);
  return { frontmatter: parseYaml(m[1]!) as Record<string, unknown>, body: m[2]! };
}

// Shared env isolation + the same-rules-for-every-host baseline contract.
isolateEnv();
createAdapterSuite({ adapter: windsurfAdapter, paradigm: "mcp-only" });

// ── identity + capabilities ──────────────────────────────────────────────────

describe("windsurf adapter — identity + capabilities", () => {
  it("is an mcp-only host with the right identity and surface flags", () => {
    expect(windsurfAdapter.id).toBe("windsurf");
    expect(windsurfAdapter.name).toBe("Windsurf");
    expect(windsurfAdapter.paradigm).toBe("mcp-only");
    // Memory is WIRED (Windsurf reads .windsurf/rules, not AGENTS.md): the
    // adapter declares supportsMemory and writes a dedicated always-on rule file.
    expect(windsurfAdapter.capabilities.supportsMemory).toBe(true);
    // mcp-only: no hooks
    expect(windsurfAdapter.capabilities.preToolUse).toBe(false);
    expect(windsurfAdapter.capabilities.postToolUse).toBe(false);
    expect(windsurfAdapter.capabilities.canModifyArgs).toBe(false);
    expect(windsurfAdapter.capabilities.canModifyOutput).toBe(false);
    expect(windsurfAdapter.capabilities.canInjectSessionContext).toBe(false);
    // Content surfaces: commands (workflows) + skills are WIRED (workspace
    // scope); subagents stay unverified. See windsurf-content.test.ts for the
    // install/uninstall behavior.
    expect(windsurfAdapter.capabilities.supportsCommands ?? false).toBe(true);
    expect(windsurfAdapter.capabilities.supportsSkills ?? false).toBe(true);
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
    ({ home, projectDir } = freshHomeProject());
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
    ({ home, projectDir } = freshHomeProject());
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
    ({ home, projectDir } = freshHomeProject());
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
    ({ home, projectDir } = freshHomeProject());
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
    ({ home, projectDir } = freshHomeProject());
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

// ── memory surface (.windsurf/rules — dedicated always-on file) ──────────────

describe("windsurf adapter — memory (.windsurf/rules/agent-connector.md)", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject());
  });

  function memConnector(cfg: Partial<ConnectorConfig> = {}): ResolvedConnector {
    return buildConnector({ memory: [{ content: "Project guidance for Windsurf." }], ...cfg });
  }

  function memFile(): string {
    return join(projectDir, ".windsurf", "rules", "agent-connector.md");
  }

  it("writes .windsurf/rules/agent-connector.md with `trigger: always_on` frontmatter", () => {
    const ctx = buildCtx(projectDir, memConnector(), "project");
    const changes = windsurfAdapter.installMemory(ctx);
    expect(changes.every((c) => c.platform === "windsurf")).toBe(true);
    expect(changes[0]?.action).toBe("create");

    expect(existsSync(memFile())).toBe(true);
    const { frontmatter, body } = splitFrontmatter(readFileSync(memFile(), "utf8"));
    // Exact always-on activation directive from the Windsurf rules docs.
    expect(frontmatter.trigger).toBe("always_on");
    expect(body).toContain("Project guidance for Windsurf.");
  });

  it("is idempotent and uninstall deletes the dedicated file", () => {
    const ctx = buildCtx(projectDir, memConnector(), "project");
    windsurfAdapter.installMemory(ctx);
    const second = windsurfAdapter.installMemory(ctx);
    expect(second[0]?.action).toBe("skip");

    windsurfAdapter.uninstallMemory(ctx);
    expect(existsSync(memFile())).toBe(false);
  });

  it("user scope skip-warns (global_rules.md is a shared file, not an AC-owned dir)", () => {
    const ctx = buildCtx(projectDir, memConnector(), "user");
    const changes = windsurfAdapter.installMemory(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
    expect(existsSync(join(home, ".windsurf", "rules"))).toBe(false);
  });

  it("does NOT clobber a pre-existing .windsurf/rules FILE (collision guard)", () => {
    mkdirSync(join(projectDir, ".windsurf"), { recursive: true });
    const rulesFile = join(projectDir, ".windsurf", "rules");
    writeFileSync(rulesFile, "# hand-written rules file\n", "utf8");

    const ctx = buildCtx(projectDir, memConnector(), "project");
    const changes = windsurfAdapter.installMemory(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
    expect(readFileSync(rulesFile, "utf8")).toBe("# hand-written rules file\n");
  });

  it("honors platforms['windsurf'].memory === false", () => {
    const connector = memConnector({ platforms: { windsurf: { memory: false } } });
    const ctx = buildCtx(projectDir, connector, "project");
    const changes = windsurfAdapter.installMemory(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(memFile())).toBe(false);
  });
});

// ── hooks (unavailable) ──────────────────────────────────────────────────────

describe("windsurf adapter — hooks (mcp-only)", () => {
  let projectDir: string;

  beforeEach(() => {
    ({ projectDir } = freshHomeProject());
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
    ({ home, projectDir } = freshHomeProject());
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

// ── content surfaces: capability flags ───────────────────────────────────────

describe("windsurf content — capability flags", () => {
  it("declares supportsCommands and supportsSkills", () => {
    expect(windsurfAdapter.capabilities.supportsCommands).toBe(true);
    expect(windsurfAdapter.capabilities.supportsSkills).toBe(true);
    // mcp-only paradigm is unchanged — these are content surfaces, not hooks.
    expect(windsurfAdapter.paradigm).toBe("mcp-only");
    expect(windsurfAdapter.capabilities.supportsSubagents ?? false).toBe(false);
  });
});

// ── content surfaces: commands (workflows) ───────────────────────────────────

describe("windsurf content — commands (workflows)", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject());
  });

  it("installCommands writes .windsurf/workflows/<name>.md (project scope)", () => {
    const ctx = buildCtx(projectDir, buildConnector({ commands: [command()] }));
    const records = windsurfAdapter.installCommands(ctx);
    const file = workflowPath(projectDir, COMMAND.name);
    expect(existsSync(file)).toBe(true);
    expect(records.some((r) => r.action === "create" && r.path === file)).toBe(true);

    const content = readFileSync(file, "utf8");
    // Shared claude-code renderer: YAML frontmatter + the verbatim prompt body.
    expect(content).toContain("description: Deploy the app to an environment.");
    expect(content).toContain("argument-hint:");
    expect(content).toContain("[environment]");
    expect(content).toContain("allowed-tools: Bash, Read");
    expect(content).toContain("model: sonnet");
    expect(content).toContain(COMMAND.prompt);
  });

  it("is idempotent: a second install is a skip", () => {
    const ctx = buildCtx(projectDir, buildConnector({ commands: [command()] }));
    windsurfAdapter.installCommands(ctx);
    const records = windsurfAdapter.installCommands(ctx);
    expect(records.every((r) => r.action === "skip")).toBe(true);
  });

  it("user scope writes ~/.codeium/windsurf/global_workflows/<name>.md", () => {
    const ctx = buildCtx(projectDir, buildConnector({ commands: [command()] }), "user");
    const records = windsurfAdapter.installCommands(ctx);
    const file = userWorkflowPath(home, COMMAND.name);
    expect(existsSync(file)).toBe(true);
    expect(records.some((r) => r.action === "create" && r.path === file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain(COMMAND.prompt);
    // The user dir is `global_workflows`, NOT a project-style `.windsurf/workflows`.
    expect(existsSync(join(projectDir, ".windsurf", "workflows"))).toBe(false);
  });

  it("warns (but still writes) when a rendered workflow exceeds 12,000 chars", () => {
    const big = { name: "huge", prompt: "x".repeat(13000) };
    const ctx = buildCtx(projectDir, buildConnector({ commands: [big] }));
    const records = windsurfAdapter.installCommands(ctx);
    const file = workflowPath(projectDir, big.name);
    // File is written despite the overflow.
    expect(existsSync(file)).toBe(true);
    expect(records.some((r) => r.action === "create" && r.path === file)).toBe(true);
    // An additional warn flags the cap.
    const warn = records.find((r) => r.action === "warn");
    expect(warn).toBeTruthy();
    expect(warn!.detail).toContain("12000");
  });

  it("does not warn for a workflow comfortably under 12,000 chars", () => {
    const ctx = buildCtx(projectDir, buildConnector({ commands: [command()] }));
    const records = windsurfAdapter.installCommands(ctx);
    expect(records.some((r) => r.action === "warn")).toBe(false);
  });

  it("honors platforms['windsurf'].commands === false", () => {
    const ctx = buildCtx(
      projectDir,
      buildConnector({
        commands: [command()],
        platforms: { windsurf: { commands: false } },
      }),
    );
    const records = windsurfAdapter.installCommands(ctx);
    expect(records).toHaveLength(1);
    expect(records[0]!.action).toBe("skip");
    expect(existsSync(workflowPath(projectDir, COMMAND.name))).toBe(false);
  });

  it("skips when the connector declares no commands", () => {
    const ctx = buildCtx(projectDir, buildConnector({ server: SERVER_DEF }));
    const records = windsurfAdapter.installCommands(ctx);
    expect(records).toHaveLength(1);
    expect(records[0]!.action).toBe("skip");
  });

  it("uninstallCommands removes only the AC-written workflow file", () => {
    const ctx = buildCtx(projectDir, buildConnector({ commands: [command()] }));
    windsurfAdapter.installCommands(ctx);
    const file = workflowPath(projectDir, COMMAND.name);
    expect(existsSync(file)).toBe(true);

    const records = windsurfAdapter.uninstallCommands(ctx);
    expect(existsSync(file)).toBe(false);
    expect(records.some((r) => r.action === "remove" && r.path === file)).toBe(true);
  });

  it("uninstallCommands (user scope) removes the global_workflows file", () => {
    const ctx = buildCtx(projectDir, buildConnector({ commands: [command()] }), "user");
    windsurfAdapter.installCommands(ctx);
    const file = userWorkflowPath(home, COMMAND.name);
    expect(existsSync(file)).toBe(true);

    const records = windsurfAdapter.uninstallCommands(ctx);
    expect(existsSync(file)).toBe(false);
    expect(records.some((r) => r.action === "remove" && r.path === file)).toBe(true);
  });
});

// ── content surfaces: skills ─────────────────────────────────────────────────

describe("windsurf content — skills", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject());
  });

  it("installSkills writes .windsurf/skills/<name>/SKILL.md + resources (project scope)", () => {
    const ctx = buildCtx(projectDir, buildConnector({ skills: [skill()] }));
    const records = windsurfAdapter.installSkills(ctx);

    const file = skillMdPath(projectDir, SKILL.name);
    expect(existsSync(file)).toBe(true);
    expect(records.some((r) => r.action === "create" && r.path === file)).toBe(true);

    const content = readFileSync(file, "utf8");
    // Shared claude-code renderSkillMd: name + description frontmatter + body.
    expect(content).toContain(`name: ${SKILL.name}`);
    expect(content).toContain("description: Extract and summarize text from PDF files.");
    expect(content).toContain(SKILL.body);

    // Nested resource lands inside the skill dir.
    const resource = join(projectDir, ".windsurf", "skills", SKILL.name, "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("user scope writes ~/.codeium/windsurf/skills/<name>/SKILL.md + resources", () => {
    const ctx = buildCtx(projectDir, buildConnector({ skills: [skill()] }), "user");
    const records = windsurfAdapter.installSkills(ctx);
    const file = userSkillMdPath(home, SKILL.name);
    expect(existsSync(file)).toBe(true);
    expect(records.some((r) => r.action === "create" && r.path === file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain(SKILL.body);

    const resource = join(home, ".codeium", "windsurf", "skills", SKILL.name, "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
    // Nothing written into the project tree at user scope.
    expect(existsSync(join(projectDir, ".windsurf", "skills"))).toBe(false);
  });

  it("honors platforms['windsurf'].skills === false", () => {
    const ctx = buildCtx(
      projectDir,
      buildConnector({
        skills: [skill()],
        platforms: { windsurf: { skills: false } },
      }),
    );
    const records = windsurfAdapter.installSkills(ctx);
    expect(records).toHaveLength(1);
    expect(records[0]!.action).toBe("skip");
    expect(existsSync(skillMdPath(projectDir, SKILL.name))).toBe(false);
  });

  it("skips when the connector declares no skills", () => {
    const ctx = buildCtx(projectDir, buildConnector({ server: SERVER_DEF }));
    const records = windsurfAdapter.installSkills(ctx);
    expect(records).toHaveLength(1);
    expect(records[0]!.action).toBe("skip");
  });

  it("uninstallSkills removes the SKILL.md, resources, and the empty skill dir", () => {
    const ctx = buildCtx(projectDir, buildConnector({ skills: [skill()] }));
    windsurfAdapter.installSkills(ctx);
    const file = skillMdPath(projectDir, SKILL.name);
    expect(existsSync(file)).toBe(true);

    const records = windsurfAdapter.uninstallSkills(ctx);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(projectDir, ".windsurf", "skills", SKILL.name))).toBe(false);
    expect(records.some((r) => r.action === "remove" && r.path === file)).toBe(true);
  });

  it("uninstallSkills (user scope) removes the ~/.codeium/windsurf skill dir", () => {
    const ctx = buildCtx(projectDir, buildConnector({ skills: [skill()] }), "user");
    windsurfAdapter.installSkills(ctx);
    const file = userSkillMdPath(home, SKILL.name);
    expect(existsSync(file)).toBe(true);

    const records = windsurfAdapter.uninstallSkills(ctx);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(home, ".codeium", "windsurf", "skills", SKILL.name))).toBe(false);
    expect(records.some((r) => r.action === "remove" && r.path === file)).toBe(true);
  });
});
