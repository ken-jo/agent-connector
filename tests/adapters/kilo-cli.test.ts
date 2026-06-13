/**
 * tests/adapters/kilo-cli — content-surface tests for the kilo-cli adapter.
 *
 * Verifies that commands, skills, and subagents write to the correct kilo-cli
 * native dirs and that uninstall removes the files.
 *
 * Dirs (live-confirmed kilo v7.3.16):
 *   commands  → .kilo/command/<name>.md          (project)
 *               ~/.config/kilo/command/<name>.md  (user)
 *   skills    → .kilo/skills/<name>/SKILL.md      (project)
 *               ~/.config/kilo/skills/<name>/SKILL.md (user)
 *   subagents → .kilo/agent/<name>.md             (project, frontmatter mode:subagent)
 *               ~/.config/kilo/agent/<name>.md    (user)
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import kiloCliAdapter from "../../src/adapters/kilo-cli/index.js";

const HOME_BIN = "/fake/home/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-kilo";

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

const SUBAGENT = {
  name: "reviewer",
  description: "Reviews code diffs for correctness bugs.",
  prompt: "You are a meticulous code reviewer. Find correctness bugs.",
  tools: { allow: ["Read", "Grep"] },
  model: "opus",
  readonly: true,
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
function subagent() {
  return { ...SUBAGENT, tools: { allow: [...SUBAGENT.tools.allow] } };
}

function buildConnector(surfaces: {
  commands?: boolean;
  skills?: boolean;
  subagents?: boolean;
}): ResolvedConnector {
  const cfg: ConnectorConfig = {
    id: CONNECTOR_ID,
    displayName: "Acme Kilo CLI",
    version: "1.0.0",
  };
  if (surfaces.commands) cfg.commands = [command()];
  if (surfaces.skills) cfg.skills = [skill()];
  if (surfaces.subagents) cfg.subagents = [subagent()];
  return defineConnector(cfg);
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
    homeBinPath: HOME_BIN,
    dataRoot: projectDir,
    dryRun: false,
  };
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

let savedHome: string | undefined;
let savedDataDir: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("USERPROFILE", savedHome);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-kilo-cli-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  return dir;
}

// ── Capabilities ──────────────────────────────────────────────────────────────

describe("kilo-cli adapter — capabilities", () => {
  it("declares all three content surfaces as supported", () => {
    expect(kiloCliAdapter.capabilities.supportsCommands).toBe(true);
    expect(kiloCliAdapter.capabilities.supportsSkills).toBe(true);
    expect(kiloCliAdapter.capabilities.supportsSubagents).toBe(true);
  });
});

// ── Commands ──────────────────────────────────────────────────────────────────

describe("kilo-cli adapter — commands", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector({ commands: true }));
  });

  it("installCommands writes .kilo/command/<name>.md (project scope)", () => {
    const changes = kiloCliAdapter.installCommands!(ctx);
    expect(changes[0]?.action).toBe("create");

    const cmdPath = join(projectDir, ".kilo", "command", "deploy.md");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(cmdPath, "utf8"));
    expect(frontmatter.description).toBe("Deploy the app to an environment.");
    expect(frontmatter["argument-hint"]).toBe("[environment]");
    expect(frontmatter["allowed-tools"]).toBe("Bash, Read");
    expect(frontmatter.model).toBe("sonnet");
    expect(body.trim()).toBe(COMMAND.prompt);
  });

  it("installCommands writes ~/.config/kilo/command/<name>.md (user scope)", () => {
    const userCtx = buildCtx(projectDir, buildConnector({ commands: true }), "user");
    const changes = kiloCliAdapter.installCommands!(userCtx);
    expect(changes[0]?.action).toBe("create");

    // HOME is redirected to projectDir, so ~/.config/kilo → projectDir/.config/kilo
    const cmdPath = join(projectDir, ".config", "kilo", "command", "deploy.md");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);
  });

  it("is idempotent — second install yields skip", () => {
    kiloCliAdapter.installCommands!(ctx);
    const second = kiloCliAdapter.installCommands!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallCommands removes the command file", () => {
    kiloCliAdapter.installCommands!(ctx);
    kiloCliAdapter.uninstallCommands!(ctx);
    expect(existsSync(join(projectDir, ".kilo", "command", "deploy.md"))).toBe(false);
  });

  it("honors platforms['kilo-cli'].commands === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      commands: [{ name: "deploy", prompt: "do it" }],
      platforms: { "kilo-cli": { commands: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    expect(kiloCliAdapter.installCommands!(c2)[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".kilo", "command", "deploy.md"))).toBe(false);
  });
});

// ── Skills ────────────────────────────────────────────────────────────────────

describe("kilo-cli adapter — skills", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector({ skills: true }));
  });

  it("installSkills writes .kilo/skills/<name>/SKILL.md (project scope)", () => {
    const changes = kiloCliAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");

    const skillMd = join(projectDir, ".kilo", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
    expect(frontmatter.model).toBe("haiku");
    expect(frontmatter["allowed-tools"]).toBe("Bash");
    expect(frontmatter["disable-model-invocation"]).toBe(false);
    expect(body).toContain("# PDF Tools");
  });

  it("installSkills also writes resource files beside SKILL.md", () => {
    kiloCliAdapter.installSkills!(ctx);
    const resource = join(projectDir, ".kilo", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills (user scope) writes ~/.config/kilo/skills/<name>/SKILL.md", () => {
    const userCtx = buildCtx(projectDir, buildConnector({ skills: true }), "user");
    const changes = kiloCliAdapter.installSkills!(userCtx);
    expect(changes[0]?.action).toBe("create");

    const skillMd = join(projectDir, ".config", "kilo", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);
  });

  it("is idempotent — second install yields skip", () => {
    kiloCliAdapter.installSkills!(ctx);
    const second = kiloCliAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource, and empty skill dir", () => {
    kiloCliAdapter.installSkills!(ctx);
    kiloCliAdapter.uninstallSkills!(ctx);
    const skillDir = join(projectDir, ".kilo", "skills", "pdf-tools");
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(false);
    expect(existsSync(skillDir)).toBe(false);
  });

  it("honors platforms['kilo-cli'].skills === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      skills: [{ name: "pdf-tools", description: SKILL.description, body: "x" }],
      platforms: { "kilo-cli": { skills: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    expect(kiloCliAdapter.installSkills!(c2)[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".kilo", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });
});

// ── Subagents ─────────────────────────────────────────────────────────────────

describe("kilo-cli adapter — subagents", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector({ subagents: true }));
  });

  it("installSubagents writes .kilo/agent/<name>.md (project scope)", () => {
    const changes = kiloCliAdapter.installSubagents!(ctx);
    expect(changes[0]?.action).toBe("create");

    const agentPath = join(projectDir, ".kilo", "agent", "reviewer.md");
    expect(changes[0]?.path).toBe(agentPath);
    expect(existsSync(agentPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(agentPath, "utf8"));
    expect(frontmatter.description).toBe(SUBAGENT.description);
    expect(frontmatter.mode).toBe("subagent");
    expect(frontmatter.model).toBe("opus");
    // readonly:true → deny map
    expect(frontmatter.permission).toEqual({ edit: "deny", bash: "deny" });
    expect(body.trim()).toBe(SUBAGENT.prompt);
  });

  it("installSubagents (user scope) writes ~/.config/kilo/agent/<name>.md", () => {
    const userCtx = buildCtx(projectDir, buildConnector({ subagents: true }), "user");
    const changes = kiloCliAdapter.installSubagents!(userCtx);
    expect(changes[0]?.action).toBe("create");

    const agentPath = join(projectDir, ".config", "kilo", "agent", "reviewer.md");
    expect(changes[0]?.path).toBe(agentPath);
    expect(existsSync(agentPath)).toBe(true);
  });

  it("is idempotent — second install yields skip", () => {
    kiloCliAdapter.installSubagents!(ctx);
    const second = kiloCliAdapter.installSubagents!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSubagents removes the agent file", () => {
    kiloCliAdapter.installSubagents!(ctx);
    kiloCliAdapter.uninstallSubagents!(ctx);
    expect(existsSync(join(projectDir, ".kilo", "agent", "reviewer.md"))).toBe(false);
  });

  it("honors platforms['kilo-cli'].subagents === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      subagents: [{ name: "reviewer", description: SUBAGENT.description, prompt: "x" }],
      platforms: { "kilo-cli": { subagents: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    expect(kiloCliAdapter.installSubagents!(c2)[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".kilo", "agent", "reviewer.md"))).toBe(false);
  });
});

// ── Full round-trip (all three surfaces) ──────────────────────────────────────

describe("kilo-cli adapter — full round-trip (project scope)", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(
      projectDir,
      buildConnector({ commands: true, skills: true, subagents: true }),
    );
  });

  it("install then uninstall leaves no content files behind", () => {
    kiloCliAdapter.installCommands!(ctx);
    kiloCliAdapter.installSkills!(ctx);
    kiloCliAdapter.installSubagents!(ctx);

    kiloCliAdapter.uninstallCommands!(ctx);
    kiloCliAdapter.uninstallSkills!(ctx);
    kiloCliAdapter.uninstallSubagents!(ctx);

    expect(existsSync(join(projectDir, ".kilo", "command", "deploy.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".kilo", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".kilo", "skills", "pdf-tools"))).toBe(false);
    expect(existsSync(join(projectDir, ".kilo", "agent", "reviewer.md"))).toBe(false);
  });
});
