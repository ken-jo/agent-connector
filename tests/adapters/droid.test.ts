/**
 * tests/adapters/droid — content-surface tests for the droid (Factory) adapter.
 *
 * Verifies that commands, skills, and subagents write to the EXACT verified
 * Factory native dirs and that uninstall removes the files.
 *
 * Dirs (getConfigDir → ~/.factory user / <projectDir>/.factory project):
 *   commands  → <configDir>/commands/<name>.md     (md+frontmatter: description, argument-hint)
 *   skills    → <configDir>/skills/<name>/SKILL.md  (+ resources)
 *   subagents → <configDir>/droids/<name>.md        (MARKDOWN — folder droids/, NOT agents/)
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import droidAdapter from "../../src/adapters/droid/index.js";

const HOME_BIN = "/fake/home/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-droid";

const COMMAND = {
  name: "deploy",
  description: "Deploy the app to an environment.",
  prompt: "Deploy to $ARGUMENTS and report the result.",
  argumentHint: "[environment]",
  // tools/model are declared but droid commands carry ONLY description +
  // argument-hint, so they must NOT appear in the rendered frontmatter.
  tools: { allow: ["Bash", "Read"] },
  model: "sonnet",
} as const;

const SKILL = {
  name: "pdf-tools",
  description: "Extract and summarize text from PDF files.",
  body: "# PDF Tools\n\nUse the bundled script to extract text.",
  // model/tools are declared but droid skills carry ONLY name + description
  // (+ disable-model-invocation), so model/allowed-tools must NOT be emitted.
  model: "haiku",
  tools: { allow: ["Bash"] },
  disableModelInvocation: false,
  resources: { "scripts/extract.sh": "#!/bin/sh\necho extracting\n" },
} as const;

const SUBAGENT = {
  name: "reviewer",
  description: "Reviews code diffs for correctness bugs.",
  prompt: "You are a meticulous code reviewer. Find correctness bugs.",
  model: "opus",
  // tools declared but droid subagent frontmatter is name/description/model only.
  tools: { allow: ["Read", "Grep"] },
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
    displayName: "Acme Droid",
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
  const dir = mkdtempSync(join(tmpdir(), "ac-droid-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  return dir;
}

// ── Capabilities ──────────────────────────────────────────────────────────────

describe("droid adapter — capabilities", () => {
  it("declares all three content surfaces as supported", () => {
    expect(droidAdapter.capabilities.supportsCommands).toBe(true);
    expect(droidAdapter.capabilities.supportsSkills).toBe(true);
    expect(droidAdapter.capabilities.supportsSubagents).toBe(true);
  });
});

// ── Commands ──────────────────────────────────────────────────────────────────

describe("droid adapter — commands", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector({ commands: true }));
  });

  it("installCommands writes .factory/commands/<name>.md (project scope)", () => {
    const changes = droidAdapter.installCommands!(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.platform).toBe("droid");

    const cmdPath = join(projectDir, ".factory", "commands", "deploy.md");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(cmdPath, "utf8"));
    expect(frontmatter.description).toBe("Deploy the app to an environment.");
    expect(frontmatter["argument-hint"]).toBe("[environment]");
    // Droid commands carry ONLY description + argument-hint.
    expect(frontmatter["allowed-tools"]).toBeUndefined();
    expect(frontmatter.model).toBeUndefined();
    expect(body.trim()).toBe(COMMAND.prompt);
  });

  it("installCommands writes ~/.factory/commands/<name>.md (user scope)", () => {
    const userCtx = buildCtx(projectDir, buildConnector({ commands: true }), "user");
    const changes = droidAdapter.installCommands!(userCtx);
    expect(changes[0]?.action).toBe("create");

    // HOME is redirected to projectDir, so ~/.factory → projectDir/.factory
    const cmdPath = join(projectDir, ".factory", "commands", "deploy.md");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);
  });

  it("is idempotent — second install yields skip", () => {
    droidAdapter.installCommands!(ctx);
    const second = droidAdapter.installCommands!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallCommands removes the command file", () => {
    droidAdapter.installCommands!(ctx);
    droidAdapter.uninstallCommands!(ctx);
    expect(existsSync(join(projectDir, ".factory", "commands", "deploy.md"))).toBe(false);
  });

  it("honors platforms['droid'].commands === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      commands: [{ name: "deploy", prompt: "do it" }],
      platforms: { droid: { commands: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    expect(droidAdapter.installCommands!(c2)[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".factory", "commands", "deploy.md"))).toBe(false);
  });
});

// ── Skills ────────────────────────────────────────────────────────────────────

describe("droid adapter — skills", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector({ skills: true }));
  });

  it("installSkills writes .factory/skills/<name>/SKILL.md (project scope)", () => {
    const changes = droidAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.platform).toBe("droid");

    const skillMd = join(projectDir, ".factory", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
    expect(frontmatter["disable-model-invocation"]).toBe(false);
    // Droid skills carry NO model / allowed-tools field.
    expect(frontmatter.model).toBeUndefined();
    expect(frontmatter["allowed-tools"]).toBeUndefined();
    expect(body).toContain("# PDF Tools");
  });

  it("installSkills also writes resource files beside SKILL.md", () => {
    droidAdapter.installSkills!(ctx);
    const resource = join(projectDir, ".factory", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills (user scope) writes ~/.factory/skills/<name>/SKILL.md", () => {
    const userCtx = buildCtx(projectDir, buildConnector({ skills: true }), "user");
    const changes = droidAdapter.installSkills!(userCtx);
    expect(changes[0]?.action).toBe("create");

    const skillMd = join(projectDir, ".factory", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);
  });

  it("is idempotent — second install yields skip", () => {
    droidAdapter.installSkills!(ctx);
    const second = droidAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource, and empty skill dir", () => {
    droidAdapter.installSkills!(ctx);
    droidAdapter.uninstallSkills!(ctx);
    const skillDir = join(projectDir, ".factory", "skills", "pdf-tools");
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(false);
    expect(existsSync(skillDir)).toBe(false);
  });

  it("honors platforms['droid'].skills === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      skills: [{ name: "pdf-tools", description: SKILL.description, body: "x" }],
      platforms: { droid: { skills: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    expect(droidAdapter.installSkills!(c2)[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".factory", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });
});

// ── Subagents (droids/ folder, MARKDOWN) ────────────────────────────────────────

describe("droid adapter — subagents", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector({ subagents: true }));
  });

  it("installSubagents writes .factory/droids/<name>.md MARKDOWN (project scope)", () => {
    const changes = droidAdapter.installSubagents!(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.platform).toBe("droid");

    // Folder is droids/, NOT agents/.
    const agentPath = join(projectDir, ".factory", "droids", "reviewer.md");
    expect(changes[0]?.path).toBe(agentPath);
    expect(existsSync(agentPath)).toBe(true);
    expect(existsSync(join(projectDir, ".factory", "agents", "reviewer.md"))).toBe(false);

    const { frontmatter, body } = splitFrontmatter(readFileSync(agentPath, "utf8"));
    expect(frontmatter.name).toBe("reviewer");
    expect(frontmatter.description).toBe(SUBAGENT.description);
    expect(frontmatter.model).toBe("opus");
    expect(body.trim()).toBe(SUBAGENT.prompt);
  });

  it("installSubagents (user scope) writes ~/.factory/droids/<name>.md", () => {
    const userCtx = buildCtx(projectDir, buildConnector({ subagents: true }), "user");
    const changes = droidAdapter.installSubagents!(userCtx);
    expect(changes[0]?.action).toBe("create");

    const agentPath = join(projectDir, ".factory", "droids", "reviewer.md");
    expect(changes[0]?.path).toBe(agentPath);
    expect(existsSync(agentPath)).toBe(true);
  });

  it("is idempotent — second install yields skip", () => {
    droidAdapter.installSubagents!(ctx);
    const second = droidAdapter.installSubagents!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSubagents removes the droid file", () => {
    droidAdapter.installSubagents!(ctx);
    droidAdapter.uninstallSubagents!(ctx);
    expect(existsSync(join(projectDir, ".factory", "droids", "reviewer.md"))).toBe(false);
  });

  it("honors platforms['droid'].subagents === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      subagents: [{ name: "reviewer", description: SUBAGENT.description, prompt: "x" }],
      platforms: { droid: { subagents: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    expect(droidAdapter.installSubagents!(c2)[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".factory", "droids", "reviewer.md"))).toBe(false);
  });
});

// ── Full round-trip (all three surfaces) ──────────────────────────────────────

describe("droid adapter — full round-trip (project scope)", () => {
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
    droidAdapter.installCommands!(ctx);
    droidAdapter.installSkills!(ctx);
    droidAdapter.installSubagents!(ctx);

    droidAdapter.uninstallCommands!(ctx);
    droidAdapter.uninstallSkills!(ctx);
    droidAdapter.uninstallSubagents!(ctx);

    expect(existsSync(join(projectDir, ".factory", "commands", "deploy.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".factory", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".factory", "skills", "pdf-tools"))).toBe(false);
    expect(existsSync(join(projectDir, ".factory", "droids", "reviewer.md"))).toBe(false);
  });
});
