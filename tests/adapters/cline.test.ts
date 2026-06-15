/**
 * adapters/cline.test.ts — Cline (VS Code extension) adapter tests.
 *
 * Cline (`saoudrizwan.claude-dev`) is the PARENT that roo-code and kilo forked.
 * It is mcp-only and exposes:
 *   MCP      → <vscodeUserDir>/globalStorage/saoudrizwan.claude-dev/settings/
 *              cline_mcp_settings.json  (root "mcpServers"), USER SCOPE ONLY.
 *   memory   → project <projectDir>/.clinerules/agent-connector.md (DIRECTORY
 *              form; a pre-existing single-FILE .clinerules is never clobbered).
 *   command  → project <projectDir>/.clinerules/workflows/<name>.md
 *              (Cline "Workflows" — the slash-command equivalent).
 *   skill    → project <projectDir>/.clinerules/skills/<name>/SKILL.md.
 *
 * All tests are HOME-isolated (mkdtemp + redirected HOME/USERPROFILE/APPDATA/
 * XDG) and deterministic. Mirrors tests/adapters/roo-code.test.ts.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform as osPlatform, tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import clineAdapter from "../../src/adapters/cline/index.js";

const CONNECTOR_ID = "acme-cline";

const SERVER = {
  transport: "stdio",
  command: "acme-mcp",
  args: ["--port", "0"],
  // Disable the transparent telemetry serve-wrapper so the rendered entry holds
  // the literal command/args (the wrap behavior is covered by spawn/render tests).
  wrapForTelemetry: false,
} as const;

const SKILL = {
  name: "pdf-tools",
  description: "Extract and summarize text from PDF files when the user asks.",
  body: "# PDF Tools\n\nUse the bundled script to extract text.",
  model: "haiku",
  tools: { allow: ["Bash"] },
  disableModelInvocation: false,
  resources: { "scripts/extract.sh": "#!/bin/sh\necho extracting\n" },
} as const;

const COMMAND = {
  name: "deploy",
  description: "Deploy the current branch to staging.",
  prompt: "# Deploy\n\nRun the staging deploy.",
  argumentHint: "[environment]",
} as const;

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
    displayName: "Acme Cline",
    version: "1.0.0",
    server: { ...SERVER, args: [...SERVER.args] },
    commands: [{ ...COMMAND }],
    skills: [skill()],
    memory: [{ content: "Project guidance for Cline." }],
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

/** The cross-OS VS Code globalStorage cline_mcp_settings.json path under HOME. */
function clineMcpSettingsPath(home: string): string {
  let userDir: string;
  switch (osPlatform()) {
    case "darwin":
      userDir = join(home, "Library", "Application Support", "Code", "User");
      break;
    case "win32":
      userDir = join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Code", "User");
      break;
    default:
      userDir = join(home, ".config", "Code", "User");
  }
  return join(
    userDir,
    "globalStorage",
    "saoudrizwan.claude-dev",
    "settings",
    "cline_mcp_settings.json",
  );
}

/** Split a md+frontmatter document into { frontmatter, body }. */
function splitFrontmatter(text: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const m = text.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  if (!m) throw new Error(`not a frontmatter doc:\n${text}`);
  return {
    frontmatter: parseYaml(m[1]!) as Record<string, unknown>,
    body: m[2]!,
  };
}

let saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DOCUMENTS_DIR",
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
 * Fresh isolated HOME + project dir. HOME drives every user-scope path (VS Code
 * globalStorage + ~/Documents/Cline), so nothing touches the real home.
 */
function freshProject(): { home: string; projectDir: string } {
  const home = mkdtempSync(join(tmpdir(), "ac-cline-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.XDG_DOCUMENTS_DIR = join(home, "Documents");
  process.env.AGENT_CONNECTOR_DATA_DIR = join(home, ".agent-connector");
  const projectDir = join(home, "project");
  mkdirSync(projectDir, { recursive: true });
  return { home, projectDir };
}

// ── capability flags ────────────────────────────────────────────────────────

describe("cline adapter — identity + capabilities", () => {
  it("is an mcp-only host named Cline with the right surface flags", () => {
    expect(clineAdapter.id).toBe("cline");
    expect(clineAdapter.name).toBe("Cline");
    expect(clineAdapter.paradigm).toBe("mcp-only");
    expect(clineAdapter.capabilities.supportsMemory).toBe(true);
    expect(clineAdapter.capabilities.supportsCommands).toBe(true);
    expect(clineAdapter.capabilities.supportsSkills).toBe(true);
    // mcp-only: no hooks, no subagents.
    expect(clineAdapter.capabilities.supportsSubagents ?? false).toBe(false);
    expect(clineAdapter.capabilities.preToolUse).toBe(false);
  });
});

// ── detection ─────────────────────────────────────────────────────────────

describe("cline adapter — detection", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
  });

  it("not installed on a bare box", () => {
    const d = clineAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(false);
    expect(d.confidence).toBe("low");
  });

  it("detects the globalStorage extension dir (user scope)", () => {
    const extDir = join(
      clineMcpSettingsPath(home),
      "..", // settings/cline_mcp_settings.json → settings
      "..", // settings → saoudrizwan.claude-dev
    );
    mkdirSync(extDir, { recursive: true });
    const d = clineAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(true);
    expect(d.scope).toBe("user");
    expect(d.confidence).toBe("high");
  });

  it("detects the project .clinerules marker (project scope)", () => {
    mkdirSync(join(projectDir, ".clinerules"), { recursive: true });
    const d = clineAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(true);
    expect(d.scope).toBe("project");
    expect(d.configPath).toBe(join(projectDir, ".clinerules"));
  });

  it("does NOT collide with a roo-code-only box (.roo / rooveterinaryinc.roo-cline)", () => {
    // A box that has ONLY roo-code markers must NOT register as cline.
    mkdirSync(join(projectDir, ".roo"), { recursive: true });
    const rooExtDir = join(
      home,
      ".config",
      "Code",
      "User",
      "globalStorage",
      "rooveterinaryinc.roo-cline",
    );
    mkdirSync(rooExtDir, { recursive: true });
    const d = clineAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(false);
  });

  it("does NOT collide with a kilo-only box (.kilo / kilocode.kilo-code)", () => {
    mkdirSync(join(projectDir, ".kilo"), { recursive: true });
    const kiloExtDir = join(
      home,
      ".config",
      "Code",
      "User",
      "globalStorage",
      "kilocode.kilo-code",
    );
    mkdirSync(kiloExtDir, { recursive: true });
    const d = clineAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(false);
  });
});

// ── MCP server install ──────────────────────────────────────────────────────

describe("cline adapter — MCP install (globalStorage cline_mcp_settings.json)", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
  });

  it("writes mcpServers.<id> at the cross-OS globalStorage path, stamped platform=cline", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = clineAdapter.installServer(ctx);
    expect(changes.every((c) => c.platform === "cline")).toBe(true);
    expect(changes[0]?.action).toBe("create");

    const settingsPath = clineMcpSettingsPath(home);
    expect(changes[0]?.path).toBe(settingsPath);
    expect(existsSync(settingsPath)).toBe(true);

    const cfg = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      mcpServers: Record<string, { command: string; args?: string[]; disabled: boolean }>;
    };
    expect(cfg.mcpServers[CONNECTOR_ID]).toBeTruthy();
    expect(cfg.mcpServers[CONNECTOR_ID]!.command).toBe("acme-mcp");
    expect(cfg.mcpServers[CONNECTOR_ID]!.args).toEqual(["--port", "0"]);
    expect(cfg.mcpServers[CONNECTOR_ID]!.disabled).toBe(false);
  });

  it("project scope ALSO targets the global settings file (no project MCP file)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    clineAdapter.installServer(ctx);
    expect(existsSync(clineMcpSettingsPath(home))).toBe(true);
    // No `.clinerules/mcp.json` or any project-scope MCP file is written.
    expect(existsSync(join(projectDir, ".clinerules", "mcp.json"))).toBe(false);
  });

  it("remote (http) server writes type:streamableHttp explicitly", () => {
    const connector = buildConnector({
      server: { transport: "http", url: "https://mcp.example.com/sse" },
    });
    const ctx = buildCtx(projectDir, connector, "user");
    clineAdapter.installServer(ctx);
    const cfg = JSON.parse(readFileSync(clineMcpSettingsPath(home), "utf8")) as {
      mcpServers: Record<string, { url: string; type: string; disabled: boolean }>;
    };
    expect(cfg.mcpServers[CONNECTOR_ID]!.type).toBe("streamableHttp");
    expect(cfg.mcpServers[CONNECTOR_ID]!.url).toBe("https://mcp.example.com/sse");
  });

  it("install is idempotent and uninstall reverses it", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    clineAdapter.installServer(ctx);
    const second = clineAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const removed = clineAdapter.uninstallServer(ctx);
    expect(removed[0]?.action).toBe("remove");
    const cfg = JSON.parse(readFileSync(clineMcpSettingsPath(home), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(CONNECTOR_ID in cfg.mcpServers).toBe(false);
  });
});

// ── memory surface (.clinerules) ────────────────────────────────────────────

describe("cline adapter — memory (.clinerules directory form)", () => {
  let projectDir: string;

  beforeEach(() => {
    ({ projectDir } = freshProject());
  });

  it("writes .clinerules/agent-connector.md at project scope", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const changes = clineAdapter.installMemory(ctx);
    expect(changes.every((c) => c.platform === "cline")).toBe(true);

    const memFile = join(projectDir, ".clinerules", "agent-connector.md");
    expect(existsSync(memFile)).toBe(true);
    expect(readFileSync(memFile, "utf8")).toContain("Project guidance for Cline.");
  });

  it("does NOT clobber a pre-existing single-FILE .clinerules (skip-warn)", () => {
    // Legacy single-file form: .clinerules is a FILE, not a directory.
    const rulesFile = join(projectDir, ".clinerules");
    writeFileSync(rulesFile, "# my hand-written cline rules\n", "utf8");

    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const changes = clineAdapter.installMemory(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");

    // The user's file is untouched, and no directory was created under it.
    expect(readFileSync(rulesFile, "utf8")).toBe("# my hand-written cline rules\n");
  });
});

// ── commands surface (Workflows) ────────────────────────────────────────────

describe("cline adapter — commands (Workflows)", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
  });

  it("project scope writes .clinerules/workflows/<name>.md with frontmatter", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const changes = clineAdapter.installCommands(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes.every((c) => c.platform === "cline")).toBe(true);

    const cmdMd = join(projectDir, ".clinerules", "workflows", "deploy.md");
    expect(changes[0]?.path).toBe(cmdMd);
    expect(existsSync(cmdMd)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(cmdMd, "utf8"));
    expect(frontmatter.description).toBe(COMMAND.description);
    expect(frontmatter["argument-hint"]).toBe("[environment]");
    expect(body).toContain("# Deploy");
  });

  it("user scope writes ~/Documents/Cline/Workflows/<name>.md", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = clineAdapter.installCommands(ctx);
    expect(changes[0]?.action).toBe("create");

    const cmdMd = join(home, "Documents", "Cline", "Workflows", "deploy.md");
    expect(changes[0]?.path).toBe(cmdMd);
    expect(existsSync(cmdMd)).toBe(true);
  });

  it("is idempotent and uninstall removes the file", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    clineAdapter.installCommands(ctx);
    const second = clineAdapter.installCommands(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    clineAdapter.uninstallCommands(ctx);
    expect(existsSync(join(projectDir, ".clinerules", "workflows", "deploy.md"))).toBe(false);
  });

  it("honors platforms['cline'].commands === false", () => {
    const connector = buildConnector({ platforms: { cline: { commands: false } } });
    const ctx = buildCtx(projectDir, connector, "project");
    const changes = clineAdapter.installCommands(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
  });
});

// ── skills surface ──────────────────────────────────────────────────────────

describe("cline adapter — skills (.clinerules/skills)", () => {
  let projectDir: string;

  beforeEach(() => {
    ({ projectDir } = freshProject());
  });

  it("project scope writes .clinerules/skills/<name>/SKILL.md + resources", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const changes = clineAdapter.installSkills(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes.every((c) => c.platform === "cline")).toBe(true);

    const skillMd = join(projectDir, ".clinerules", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
    expect(body).toContain("# PDF Tools");

    const resource = join(projectDir, ".clinerules", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
  });

  it("user scope skips with a warn (undocumented for the VS Code ext)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = clineAdapter.installSkills(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
  });

  it("is idempotent and uninstall removes SKILL.md, resource, and the empty dir", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    clineAdapter.installSkills(ctx);
    const second = clineAdapter.installSkills(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    clineAdapter.uninstallSkills(ctx);
    expect(existsSync(join(projectDir, ".clinerules", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".clinerules", "skills", "pdf-tools"))).toBe(false);
  });

  it("honors platforms['cline'].skills === false", () => {
    const connector = buildConnector({ platforms: { cline: { skills: false } } });
    const ctx = buildCtx(projectDir, connector, "project");
    const changes = clineAdapter.installSkills(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
  });
});
