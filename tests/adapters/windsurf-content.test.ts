/**
 * adapters/windsurf-content.test.ts — Windsurf content surfaces (commands + skills).
 *
 * Windsurf is mcp-only but reads two WORKSPACE-scope content trees:
 *   - workflows → <projectDir>/.windsurf/workflows/<name>.md (each a /<name>
 *     slash command), rendered with the shared claude-code renderCommandMd.
 *   - skills    → <projectDir>/.windsurf/skills/<name>/SKILL.md, rendered with
 *     the shared claude-code renderSkillMd (the same SKILL.md convention
 *     cline/claude-code/qwen-code use).
 *
 * Both are WORKSPACE/PROJECT scope only (Windsurf documents no user/global dir),
 * so a user-scope install skip-warns exactly like installMemory. Tests are
 * HOME-isolated (mkdtemp + redirected HOME/USERPROFILE/APPDATA/XDG) and
 * deterministic. Mirrors tests/adapters/kilo-cli.test.ts for the content fixtures.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import windsurfAdapter from "../../src/adapters/windsurf/index.js";

const CONNECTOR_ID = "acme-windsurf";

/** A minimal valid server, used to satisfy defineConnector's "declare ≥1 surface"
 * rule in the zero-commands / zero-skills cases (no MCP behavior is exercised). */
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

/** Fresh isolated HOME + project dir. */
function freshProject(): { home: string; projectDir: string } {
  const home = mkdtempSync(join(tmpdir(), "ac-windsurf-content-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.AGENT_CONNECTOR_DATA_DIR = join(home, ".agent-connector");
  const projectDir = join(home, "project");
  mkdirSync(projectDir, { recursive: true });
  return { home, projectDir };
}

// Project-scope native paths.
function workflowPath(projectDir: string, name: string): string {
  return join(projectDir, ".windsurf", "workflows", `${name}.md`);
}
function skillMdPath(projectDir: string, name: string): string {
  return join(projectDir, ".windsurf", "skills", name, "SKILL.md");
}
// User/global-scope native paths (HOME is redirected to the temp dir, so these
// resolve under it). NOTE: the user workflows dir is `global_workflows`, the user
// skills dir is `skills`.
function userWorkflowPath(home: string, name: string): string {
  return join(home, ".codeium", "windsurf", "global_workflows", `${name}.md`);
}
function userSkillMdPath(home: string, name: string): string {
  return join(home, ".codeium", "windsurf", "skills", name, "SKILL.md");
}

// ── capability flags ──────────────────────────────────────────────────────────

describe("windsurf content — capability flags", () => {
  it("declares supportsCommands and supportsSkills", () => {
    expect(windsurfAdapter.capabilities.supportsCommands).toBe(true);
    expect(windsurfAdapter.capabilities.supportsSkills).toBe(true);
    // mcp-only paradigm is unchanged — these are content surfaces, not hooks.
    expect(windsurfAdapter.paradigm).toBe("mcp-only");
    expect(windsurfAdapter.capabilities.supportsSubagents ?? false).toBe(false);
  });
});

// ── commands (workflows) ──────────────────────────────────────────────────────

describe("windsurf content — commands (workflows)", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
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
    // A surface-less connector is rejected by defineConnector, so declare a
    // minimal server: it makes the config valid while declaring zero commands.
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

// ── skills ─────────────────────────────────────────────────────────────────────

describe("windsurf content — skills", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
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
