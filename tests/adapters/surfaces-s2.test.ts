/**
 * adapters/surfaces-s2 — content-surface (commands/skills/subagents) render +
 * round-trip tests for the third wave of supporting adapters:
 *
 *   • vscode-copilot    — md+fm prompt files (.github/prompts/<n>.prompt.md),
 *                          uniform SKILL.md skills, md+fm agent files
 *                          (.github/agents/<n>.agent.md). All three surfaces.
 *   • copilot-cli       — NO command surface (warn/skip), uniform SKILL.md
 *                          skills, md+fm subagents (.agent.md). user scope →
 *                          ~/.copilot; project scope → shared .github tree.
 *   • jetbrains-copilot — md+fm prompt files + uniform SKILL.md skills under the
 *                          SHARED project .github tree; NO subagent surface
 *                          (BaseAdapter skip).
 *   • kilo              — Kilo Code VS Code extension. md+fm commands
 *                          (.kilocode/commands/<n>.md) + md+fm subagents
 *                          (.kilocode/agents/<n>.md, mode:subagent); NO skill
 *                          surface (BaseAdapter skip).
 *   • pi                — uniform SKILL.md skills only (.pi/skills/<n>/SKILL.md);
 *                          NO command/subagent surface (BaseAdapter skip).
 *
 * Each platform is exercised end-to-end against REAL files on disk in an
 * isolated temp project dir. For each connector we declare ONLY the surfaces the
 * platform supports (per the CONTRACT), so the unsupported surfaces resolve to a
 * "connector declares no <surface>" skip via the BaseAdapter default rather than
 * a warn.
 *
 * The .github tree (prompts/skills/agents) is shared across vscode-copilot,
 * copilot-cli, and jetbrains-copilot: those connectors write byte-identical,
 * idempotent content and uninstall removes only the files THIS connector wrote.
 *
 * Filesystem isolation: a fresh os.tmpdir mkdtemp project dir per test. HOME and
 * AGENT_CONNECTOR_DATA_DIR point at temp and are restored in afterEach so the
 * user-scope copilot-cli subagent / pi skill paths resolve under the temp HOME.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import vscodeAdapter from "../../src/adapters/vscode-copilot/index.js";
import copilotCliAdapter from "../../src/adapters/copilot-cli/index.js";
import jetbrainsAdapter from "../../src/adapters/jetbrains-copilot/index.js";
import kiloAdapter from "../../src/adapters/kilo/index.js";
import piAdapter from "../../src/adapters/pi/index.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-surfaces";

const COMMAND = {
  name: "deploy",
  description: "Deploy the app to an environment.",
  prompt: "Deploy to {{args}} / $ARGUMENTS and report the result.",
  argumentHint: "[environment]",
  tools: { allow: ["Bash", "Read"] },
  model: "sonnet",
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

const SUBAGENT = {
  name: "reviewer",
  description: "Reviews code diffs for correctness bugs.",
  prompt: "You are a meticulous code reviewer. Find correctness bugs.",
  tools: { allow: ["Read", "Grep"] },
  model: "opus",
  readonly: true,
} as const;

/** Deep-clone the shared command fixture (fresh arrays so adapters never alias). */
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

/** Build a connector declaring ONLY the surfaces a platform supports. */
function buildConnector(surfaces: {
  commands?: boolean;
  skills?: boolean;
  subagents?: boolean;
}): ResolvedConnector {
  const cfg: ConnectorConfig = {
    id: CONNECTOR_ID,
    displayName: "Acme Surfaces",
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

let savedHome: string | undefined;
let savedDataDir: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-surfaces-s2-"));
  // Redirect HOME so user-scope writes (copilot-cli, pi) land under the temp dir.
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  return dir;
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

// ── vscode-copilot ────────────────────────────────────────────────────────

describe("vscode-copilot adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(
      projectDir,
      buildConnector({ commands: true, skills: true, subagents: true }),
    );
  });

  it("declares support for all three content surfaces", () => {
    expect(vscodeAdapter.capabilities.supportsCommands).toBe(true);
    expect(vscodeAdapter.capabilities.supportsSkills).toBe(true);
    expect(vscodeAdapter.capabilities.supportsSubagents).toBe(true);
  });

  it("installCommands writes a md+fm prompt file at .github/prompts/<n>.prompt.md", () => {
    const changes = vscodeAdapter.installCommands!(ctx);
    expect(changes[0]?.action).toBe("create");

    const cmdPath = join(projectDir, ".github", "prompts", "deploy.prompt.md");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(cmdPath, "utf8"));
    expect(frontmatter.description).toBe("Deploy the app to an environment.");
    // VS Code prompt files express tools as an ARRAY (not CSV).
    expect(frontmatter.tools).toEqual(["Bash", "Read"]);
    expect(frontmatter.model).toBe("sonnet");
    expect(frontmatter["argument-hint"]).toBe("[environment]");
    expect(body.trim()).toBe(COMMAND.prompt);
  });

  it("installSkills writes uniform SKILL.md + resource with correct frontmatter", () => {
    vscodeAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".github", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".github", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
    expect(frontmatter.model).toBe("haiku");
    expect(frontmatter["allowed-tools"]).toBe("Bash");
    expect(frontmatter["disable-model-invocation"]).toBe(false);
    expect(body).toContain("# PDF Tools");
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSubagents writes md+fm .github/agents/<n>.agent.md (name, description, tools, model)", () => {
    const changes = vscodeAdapter.installSubagents!(ctx);
    expect(changes[0]?.action).toBe("create");
    const agentPath = join(projectDir, ".github", "agents", "reviewer.agent.md");
    expect(changes[0]?.path).toBe(agentPath);
    expect(existsSync(agentPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(agentPath, "utf8"));
    expect(frontmatter.name).toBe("reviewer");
    expect(frontmatter.description).toBe(SUBAGENT.description);
    expect(frontmatter.tools).toBe("Read, Grep");
    expect(frontmatter.model).toBe("opus");
    expect(body.trim()).toBe(SUBAGENT.prompt);
  });

  it("is idempotent — second install yields skip across all surfaces", () => {
    vscodeAdapter.installCommands!(ctx);
    vscodeAdapter.installSkills!(ctx);
    vscodeAdapter.installSubagents!(ctx);
    expect(vscodeAdapter.installCommands!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(vscodeAdapter.installSkills!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(vscodeAdapter.installSubagents!(ctx).every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall removes all written files", () => {
    vscodeAdapter.installCommands!(ctx);
    vscodeAdapter.installSkills!(ctx);
    vscodeAdapter.installSubagents!(ctx);

    vscodeAdapter.uninstallCommands!(ctx);
    vscodeAdapter.uninstallSkills!(ctx);
    vscodeAdapter.uninstallSubagents!(ctx);

    expect(existsSync(join(projectDir, ".github", "prompts", "deploy.prompt.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".github", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".github", "skills", "pdf-tools"))).toBe(false);
    expect(existsSync(join(projectDir, ".github", "agents", "reviewer.agent.md"))).toBe(false);
  });

  it("honors platforms['vscode-copilot'].commands === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      commands: [{ name: "deploy", prompt: "do it" }],
      platforms: { "vscode-copilot": { commands: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    expect(vscodeAdapter.installCommands!(c2)[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".github", "prompts", "deploy.prompt.md"))).toBe(false);
  });
});

// ── copilot-cli ─────────────────────────────────────────────────────────────

describe("copilot-cli adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    // Declare ONLY the supported surfaces (skills + subagents). Commands are
    // unsupported on Copilot CLI; with none declared they resolve to a skip.
    ctx = buildCtx(projectDir, buildConnector({ skills: true, subagents: true }));
  });

  it("declares skills + subagents but NOT commands", () => {
    expect(copilotCliAdapter.capabilities.supportsCommands).toBe(false);
    expect(copilotCliAdapter.capabilities.supportsSkills).toBe(true);
    expect(copilotCliAdapter.capabilities.supportsSubagents).toBe(true);
  });

  it("installCommands is unsupported → BaseAdapter skip/warn, writes no prompt file", () => {
    // Even when a command IS declared, Copilot CLI has no command surface: the
    // BaseAdapter default routes it through warn (declared) without writing any
    // native file. The CONTRACT permits warn OR skip here.
    const withCmd = buildCtx(
      projectDir,
      buildConnector({ commands: true, skills: true, subagents: true }),
    );
    const changes = copilotCliAdapter.installCommands!(withCmd);
    expect(changes).toHaveLength(1);
    expect(["warn", "skip"]).toContain(changes[0]?.action);
    expect(existsSync(join(projectDir, ".github", "prompts", "deploy.prompt.md"))).toBe(false);
  });

  it("installSkills writes uniform SKILL.md + resource (project scope under .github)", () => {
    copilotCliAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".github", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".github", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    const { frontmatter } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
  });

  it("installSubagents (project scope) writes md+fm .github/agents/<n>.agent.md", () => {
    const changes = copilotCliAdapter.installSubagents!(ctx);
    expect(changes[0]?.action).toBe("create");
    const agentPath = join(projectDir, ".github", "agents", "reviewer.agent.md");
    expect(changes[0]?.path).toBe(agentPath);
    expect(existsSync(agentPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(agentPath, "utf8"));
    expect(frontmatter.name).toBe("reviewer");
    expect(frontmatter.description).toBe(SUBAGENT.description);
    expect(frontmatter.tools).toBe("Read, Grep");
    expect(frontmatter.model).toBe("opus");
    expect(body.trim()).toBe(SUBAGENT.prompt);
  });

  it("installSubagents (USER scope) writes to ~/.copilot/agents (HOME temp)", () => {
    const userCtx = buildCtx(
      projectDir,
      buildConnector({ skills: true, subagents: true }),
      "user",
    );
    const changes = copilotCliAdapter.installSubagents!(userCtx);
    expect(changes[0]?.action).toBe("create");

    // HOME redirected to projectDir → ~/.copilot === projectDir/.copilot.
    const agentPath = join(projectDir, ".copilot", "agents", "reviewer.agent.md");
    expect(changes[0]?.path).toBe(agentPath);
    expect(existsSync(agentPath)).toBe(true);
    // Must NOT have written into the shared project .github tree at user scope.
    expect(existsSync(join(projectDir, ".github", "agents", "reviewer.agent.md"))).toBe(false);
  });

  it("is idempotent — second install yields skip (skills + subagents)", () => {
    copilotCliAdapter.installSkills!(ctx);
    copilotCliAdapter.installSubagents!(ctx);
    expect(copilotCliAdapter.installSkills!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(copilotCliAdapter.installSubagents!(ctx).every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall removes skill + subagent files (project scope)", () => {
    copilotCliAdapter.installSkills!(ctx);
    copilotCliAdapter.installSubagents!(ctx);
    copilotCliAdapter.uninstallSkills!(ctx);
    copilotCliAdapter.uninstallSubagents!(ctx);
    expect(existsSync(join(projectDir, ".github", "skills", "pdf-tools"))).toBe(false);
    expect(existsSync(join(projectDir, ".github", "agents", "reviewer.agent.md"))).toBe(false);
  });
});

// ── jetbrains-copilot ───────────────────────────────────────────────────────

describe("jetbrains-copilot adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    // Declare ONLY the supported surfaces (commands + skills). Subagents are
    // unsupported here; with none declared they resolve to a skip.
    ctx = buildCtx(projectDir, buildConnector({ commands: true, skills: true }));
  });

  it("declares commands + skills but NOT subagents", () => {
    expect(jetbrainsAdapter.capabilities.supportsCommands).toBe(true);
    expect(jetbrainsAdapter.capabilities.supportsSkills).toBe(true);
    expect(jetbrainsAdapter.capabilities.supportsSubagents).toBe(false);
  });

  it("installCommands writes a md+fm prompt file at .github/prompts/<n>.prompt.md", () => {
    const changes = jetbrainsAdapter.installCommands!(ctx);
    expect(changes[0]?.action).toBe("create");
    const cmdPath = join(projectDir, ".github", "prompts", "deploy.prompt.md");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(cmdPath, "utf8"));
    expect(frontmatter.description).toBe("Deploy the app to an environment.");
    expect(frontmatter.tools).toEqual(["Bash", "Read"]);
    expect(frontmatter.model).toBe("sonnet");
    expect(frontmatter["argument-hint"]).toBe("[environment]");
    expect(body.trim()).toBe(COMMAND.prompt);
  });

  it("installSkills writes uniform SKILL.md + resource under the shared .github tree", () => {
    jetbrainsAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".github", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".github", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    const { frontmatter } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
  });

  it("installSubagents routes through BaseAdapter (unsupported) and writes nothing", () => {
    // Declare a subagent so the BaseAdapter default takes the "warn" branch
    // (declared but unsupported); no agent file is created.
    const withAgent = buildCtx(
      projectDir,
      buildConnector({ commands: true, skills: true, subagents: true }),
    );
    const changes = jetbrainsAdapter.installSubagents!(withAgent);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
    expect(existsSync(join(projectDir, ".github", "agents", "reviewer.agent.md"))).toBe(false);
  });

  it("renders byte-identical command + skill to the vscode-copilot writer (shared .github)", () => {
    // The .github tree is shared; both writers must produce identical bytes so a
    // shared folder never thrashes. Render both into separate temp trees and
    // compare the on-disk content.
    const vsDir = freshProject();
    const vsCtx = buildCtx(vsDir, buildConnector({ commands: true, skills: true }));
    jetbrainsAdapter.installCommands!(ctx);
    jetbrainsAdapter.installSkills!(ctx);
    vscodeAdapter.installCommands!(vsCtx);
    vscodeAdapter.installSkills!(vsCtx);

    const jbCmd = readFileSync(join(projectDir, ".github", "prompts", "deploy.prompt.md"), "utf8");
    const vsCmd = readFileSync(join(vsDir, ".github", "prompts", "deploy.prompt.md"), "utf8");
    expect(jbCmd).toBe(vsCmd);

    const jbSkill = readFileSync(join(projectDir, ".github", "skills", "pdf-tools", "SKILL.md"), "utf8");
    const vsSkill = readFileSync(join(vsDir, ".github", "skills", "pdf-tools", "SKILL.md"), "utf8");
    expect(jbSkill).toBe(vsSkill);
  });

  it("is idempotent — second install yields skip (commands + skills)", () => {
    jetbrainsAdapter.installCommands!(ctx);
    jetbrainsAdapter.installSkills!(ctx);
    expect(jetbrainsAdapter.installCommands!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(jetbrainsAdapter.installSkills!(ctx).every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall removes command + skill files", () => {
    jetbrainsAdapter.installCommands!(ctx);
    jetbrainsAdapter.installSkills!(ctx);
    jetbrainsAdapter.uninstallCommands!(ctx);
    jetbrainsAdapter.uninstallSkills!(ctx);
    expect(existsSync(join(projectDir, ".github", "prompts", "deploy.prompt.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".github", "skills", "pdf-tools"))).toBe(false);
  });
});

// ── kilo ────────────────────────────────────────────────────────────────────

describe("kilo adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    // Declare ONLY the supported surfaces (commands + subagents). Skills are
    // unsupported on Kilo; with none declared they resolve to a skip.
    ctx = buildCtx(projectDir, buildConnector({ commands: true, subagents: true }));
  });

  it("declares commands + subagents + skills (OpenCode-fork backend)", () => {
    expect(kiloAdapter.capabilities.supportsCommands).toBe(true);
    expect(kiloAdapter.capabilities.supportsSubagents).toBe(true);
    expect(kiloAdapter.capabilities.supportsSkills).toBe(true);
  });

  it("installCommands writes md+fm command at .kilocode/commands/<n>.md", () => {
    const changes = kiloAdapter.installCommands!(ctx);
    expect(changes[0]?.action).toBe("create");
    const cmdPath = join(projectDir, ".kilocode", "commands", "deploy.md");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(cmdPath, "utf8"));
    expect(frontmatter.description).toBe("Deploy the app to an environment.");
    expect(frontmatter["argument-hint"]).toBe("[environment]");
    expect(frontmatter.model).toBe("sonnet");
    expect(body.trim()).toBe(COMMAND.prompt);
  });

  it("installSubagents writes md+fm subagent at .kilocode/agents/<n>.md (mode:subagent, permission)", () => {
    const changes = kiloAdapter.installSubagents!(ctx);
    expect(changes[0]?.action).toBe("create");
    const agentPath = join(projectDir, ".kilocode", "agents", "reviewer.md");
    expect(changes[0]?.path).toBe(agentPath);
    expect(existsSync(agentPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(agentPath, "utf8"));
    expect(frontmatter.description).toBe(SUBAGENT.description);
    expect(frontmatter.mode).toBe("subagent");
    expect(frontmatter.model).toBe("opus");
    // readonly → per-tool deny permission map.
    expect(frontmatter.permission).toEqual({ edit: "deny", bash: "deny" });
    expect(body.trim()).toBe(SUBAGENT.prompt);
  });

  it("installSkills writes uniform SKILL.md at .kilo/skills/<n>/SKILL.md", () => {
    const withSkill = buildCtx(
      projectDir,
      buildConnector({ commands: true, skills: true, subagents: true }),
    );
    const changes = kiloAdapter.installSkills!(withSkill);
    expect(changes[0]?.action).toBe("create");
    const skillMd = join(projectDir, ".kilo", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);
    // NOT the legacy .kilocode tree (commands/subagents live there; skills do not).
    expect(existsSync(join(projectDir, ".kilocode", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("is idempotent — second install yields skip (commands + subagents)", () => {
    kiloAdapter.installCommands!(ctx);
    kiloAdapter.installSubagents!(ctx);
    expect(kiloAdapter.installCommands!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(kiloAdapter.installSubagents!(ctx).every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall removes command + subagent files", () => {
    kiloAdapter.installCommands!(ctx);
    kiloAdapter.installSubagents!(ctx);
    kiloAdapter.uninstallCommands!(ctx);
    kiloAdapter.uninstallSubagents!(ctx);
    expect(existsSync(join(projectDir, ".kilocode", "commands", "deploy.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".kilocode", "agents", "reviewer.md"))).toBe(false);
  });
});

// ── pi ──────────────────────────────────────────────────────────────────────

describe("pi adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    // Declare ONLY the supported surface (skills). Commands/subagents are
    // unsupported on Pi; with none declared they resolve to a skip.
    ctx = buildCtx(projectDir, buildConnector({ skills: true }));
  });

  it("declares commands + skills (prompt templates + Agent Skills), no subagents", () => {
    expect(piAdapter.capabilities.supportsSkills).toBe(true);
    expect(piAdapter.capabilities.supportsCommands).toBe(true);
    expect(piAdapter.capabilities.supportsSubagents).toBe(false);
  });

  it("installSkills writes uniform SKILL.md + resource at .pi/skills/<n>/SKILL.md", () => {
    const changes = piAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");
    const skillMd = join(projectDir, ".pi", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(join(projectDir, ".pi", "skills", "pdf-tools", "scripts", "extract.sh"))).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
    expect(frontmatter.model).toBe("haiku");
    expect(frontmatter["allowed-tools"]).toBe("Bash");
    expect(frontmatter["disable-model-invocation"]).toBe(false);
    expect(body).toContain("# PDF Tools");
  });

  it("installCommands skips when none declared; installSubagents (unsupported) skips — no files", () => {
    // ctx declares only skills, so commands resolve to a skip ("none declared");
    // subagents are unsupported on pi and also skip. Neither writes a file.
    expect(piAdapter.installCommands!(ctx)[0]?.action).toBe("skip");
    expect(piAdapter.installSubagents!(ctx)[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".pi", "prompts"))).toBe(false);
    expect(existsSync(join(projectDir, ".pi", "agents"))).toBe(false);
  });

  it("is idempotent — second install yields skip", () => {
    piAdapter.installSkills!(ctx);
    expect(piAdapter.installSkills!(ctx).every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall removes the skill dir", () => {
    piAdapter.installSkills!(ctx);
    piAdapter.uninstallSkills!(ctx);
    expect(existsSync(join(projectDir, ".pi", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".pi", "skills", "pdf-tools"))).toBe(false);
  });

  it("honors platforms['pi'].skills === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      skills: [{ name: "pdf-tools", description: SKILL.description, body: "x" }],
      platforms: { pi: { skills: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    expect(piAdapter.installSkills!(c2)[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".pi", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });
});
