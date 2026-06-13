/**
 * tests/adapters/pi — Pi adapter unit tests.
 *
 * Covers:
 *   1. Capability flags: supportsCommands=true, supportsSkills=true,
 *      supportsSubagents=false, mcp=false (transports=[]).
 *   2. Paradigm label: NOT "mcp-only" in a misleading sense — mcp=false is the
 *      truth; the adapter sets paradigm="mcp-only" only because HookParadigm has
 *      no "no-mcp" variant, and that's accepted; we verify transports=[].
 *   3. Commands (prompt templates):
 *        project scope → <projectDir>/.pi/prompts/<name>.md
 *        user scope    → ~/.pi/agent/prompts/<name>.md  (NOT ~/.pi/prompts/)
 *      Idempotent, reversible, disabled-opt-out honored.
 *   4. Skills USER-SCOPE PATH BUG (regression guard):
 *        user scope    → ~/.pi/agent/skills/<name>/SKILL.md  (NOT ~/.pi/skills/)
 *        project scope → <projectDir>/.pi/skills/<name>/SKILL.md  (unchanged)
 *   5. allowed-tools rendering: SPACE-delimited for pi (not ", ").
 *   6. Skill full round-trip: install/idempotent/uninstall (project + user scope).
 *   7. platforms["pi"].commands/skills === false opt-outs.
 *   8. installServer / installHooks always skip (no MCP config, no hook layer).
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";
import piAdapter from "../../src/adapters/pi/index.js";

const HOME_BIN = "/fake/home/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-pi";

const COMMAND = {
  name: "deploy",
  description: "Deploy the app to an environment.",
  prompt: "Deploy to $ARGUMENTS and report the result.",
  argumentHint: "[environment]",
  model: "sonnet",
} as const;

const SKILL = {
  name: "pdf-tools",
  description: "Extract and summarize text from PDF files when the user asks.",
  body: "# PDF Tools\n\nUse the bundled script to extract text.",
  model: "haiku",
  tools: { allow: ["Bash", "Read"] },
  disableModelInvocation: false,
  resources: { "scripts/extract.sh": "#!/bin/sh\necho extracting\n" },
} as const;

function buildConnector(surfaces: {
  commands?: boolean;
  skills?: boolean;
  platforms?: ConnectorConfig["platforms"];
}): ResolvedConnector {
  const cfg: ConnectorConfig = { id: CONNECTOR_ID, displayName: "Acme Pi", version: "1.0.0" };
  if (surfaces.commands)
    cfg.commands = [{ ...COMMAND }];
  if (surfaces.skills)
    cfg.skills = [{ ...SKILL, tools: { allow: [...SKILL.tools.allow] }, resources: { ...SKILL.resources } }];
  if (surfaces.platforms) cfg.platforms = surfaces.platforms;
  return defineConnector(cfg);
}

function buildCtx(
  projectDir: string,
  connector: ResolvedConnector,
  scope: "project" | "user" = "project",
): InstallContext {
  return { connector, scope, projectDir, homeBinPath: HOME_BIN, dataRoot: projectDir, dryRun: false };
}

/** Split md+frontmatter into { frontmatter, body }. */
function splitFm(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  if (!m) throw new Error(`not a frontmatter doc:\n${text}`);
  return { frontmatter: parseYaml(m[1]!) as Record<string, unknown>, body: m[2]! };
}

let savedHome: string | undefined;
let savedDataDir: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedDataDir === undefined) delete process.env.AGENT_CONNECTOR_DATA_DIR;
  else process.env.AGENT_CONNECTOR_DATA_DIR = savedDataDir;
});

function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-pi-test-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  return dir;
}

// ── 1. Capability flags ───────────────────────────────────────────────────────

describe("pi adapter — capabilities", () => {
  it("declares commands + skills but NOT subagents", () => {
    expect(piAdapter.capabilities.supportsCommands).toBe(true);
    expect(piAdapter.capabilities.supportsSkills).toBe(true);
    expect(piAdapter.capabilities.supportsSubagents).toBe(false);
  });

  it("has no MCP transports (transports=[])", () => {
    expect(piAdapter.capabilities.transports).toEqual([]);
  });

  it("has no hook capabilities", () => {
    expect(piAdapter.capabilities.preToolUse).toBe(false);
    expect(piAdapter.capabilities.postToolUse).toBe(false);
    expect(piAdapter.capabilities.sessionStart).toBe(false);
  });
});

// ── 2. MCP server + hooks always skip ────────────────────────────────────────

describe("pi adapter — server + hooks skip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector({ skills: true }));
  });

  it("installServer returns skip (no writable MCP config)", () => {
    const changes = piAdapter.installServer(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("no writable MCP config");
  });

  it("uninstallServer returns skip", () => {
    const changes = piAdapter.uninstallServer(ctx);
    expect(changes[0]?.action).toBe("skip");
  });

  it("installHooks returns skip (no hook layer)", () => {
    const changes = piAdapter.installHooks(ctx);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("no hook layer");
  });

  it("uninstallHooks returns skip", () => {
    const changes = piAdapter.uninstallHooks(ctx);
    expect(changes[0]?.action).toBe("skip");
  });
});

// ── 3. Commands (prompt templates) — project scope ───────────────────────────

describe("pi adapter — commands (project scope)", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector({ commands: true }));
  });

  it("installCommands writes <projectDir>/.pi/prompts/<name>.md", () => {
    const changes = piAdapter.installCommands!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("create");

    const cmdPath = join(projectDir, ".pi", "prompts", "deploy.md");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);
  });

  it("rendered command file has correct frontmatter + body", () => {
    piAdapter.installCommands!(ctx);
    const cmdPath = join(projectDir, ".pi", "prompts", "deploy.md");
    const { frontmatter, body } = splitFm(readFileSync(cmdPath, "utf8"));
    expect(frontmatter.description).toBe(COMMAND.description);
    expect(frontmatter.model).toBe(COMMAND.model);
    expect(frontmatter["argument-hint"]).toBe(COMMAND.argumentHint);
    expect(body.trim()).toBe(COMMAND.prompt);
  });

  it("installCommands is idempotent — second call returns skip", () => {
    piAdapter.installCommands!(ctx);
    const second = piAdapter.installCommands!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallCommands removes the prompt file", () => {
    piAdapter.installCommands!(ctx);
    const cmdPath = join(projectDir, ".pi", "prompts", "deploy.md");
    expect(existsSync(cmdPath)).toBe(true);
    piAdapter.uninstallCommands!(ctx);
    expect(existsSync(cmdPath)).toBe(false);
  });

  it("returns skip when connector declares no commands", () => {
    // Use a connector that declares only skills (no commands) to get the "no commands" skip.
    const ctx2 = buildCtx(projectDir, buildConnector({ skills: true }));
    const changes = piAdapter.installCommands!(ctx2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".pi", "prompts"))).toBe(false);
  });

  it("honors platforms['pi'].commands === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      commands: [{ name: "deploy", prompt: "do it" }],
      platforms: { pi: { commands: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    const changes = piAdapter.installCommands!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".pi", "prompts", "deploy.md"))).toBe(false);
  });
});

// ── 4. Commands — user scope path (regression guard) ─────────────────────────

describe("pi adapter — commands USER scope path", () => {
  it("user-scope command lands under ~/.pi/agent/prompts/ (NOT ~/.pi/prompts/)", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, buildConnector({ commands: true }), "user");

    const changes = piAdapter.installCommands!(ctx);
    expect(changes[0]?.action).toBe("create");

    // HOME is redirected to projectDir, so ~/.pi === projectDir/.pi
    const expectedPath = join(projectDir, ".pi", "agent", "prompts", "deploy.md");
    expect(changes[0]?.path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    // Must NOT write to ~/.pi/prompts/ (old wrong path)
    const wrongPath = join(projectDir, ".pi", "prompts", "deploy.md");
    expect(existsSync(wrongPath)).toBe(false);
  });
});

// ── 5. Skills — project scope ─────────────────────────────────────────────────

describe("pi adapter — skills (project scope)", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector({ skills: true }));
  });

  it("installSkills writes <projectDir>/.pi/skills/<name>/SKILL.md", () => {
    const changes = piAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");
    const skillMd = join(projectDir, ".pi", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);
  });

  it("rendered SKILL.md has correct frontmatter with SPACE-delimited allowed-tools", () => {
    piAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".pi", "skills", "pdf-tools", "SKILL.md");
    const { frontmatter, body } = splitFm(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
    expect(frontmatter.model).toBe("haiku");
    // Pi uses SPACE-delimited allowed-tools — NOT ", "
    expect(frontmatter["allowed-tools"]).toBe("Bash Read");
    expect(frontmatter["disable-model-invocation"]).toBe(false);
    expect(body).toContain("# PDF Tools");
  });

  it("resource file is written beside SKILL.md", () => {
    piAdapter.installSkills!(ctx);
    const resource = join(projectDir, ".pi", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills is idempotent — second call returns skip", () => {
    piAdapter.installSkills!(ctx);
    const second = piAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource, and empty skill dir", () => {
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

// ── 6. Skills USER-SCOPE PATH BUG regression guard ───────────────────────────

describe("pi adapter — skills USER scope path (regression guard)", () => {
  it("user-scope skill lands under ~/.pi/agent/skills/ (NOT ~/.pi/skills/)", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, buildConnector({ skills: true }), "user");

    const changes = piAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");

    // HOME is redirected to projectDir, so ~/.pi === projectDir/.pi
    const expectedPath = join(projectDir, ".pi", "agent", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    // Must NOT write to ~/.pi/skills/ (old bug path)
    const bugPath = join(projectDir, ".pi", "skills", "pdf-tools", "SKILL.md");
    expect(existsSync(bugPath)).toBe(false);
  });

  it("user-scope skill uninstall cleans up from ~/.pi/agent/skills/", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, buildConnector({ skills: true }), "user");

    piAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".pi", "agent", "skills", "pdf-tools", "SKILL.md");
    expect(existsSync(skillMd)).toBe(true);

    piAdapter.uninstallSkills!(ctx);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(join(projectDir, ".pi", "agent", "skills", "pdf-tools"))).toBe(false);
  });
});

// ── 7. allowed-tools: space-delimited ────────────────────────────────────────

describe("pi adapter — allowed-tools space-delimited", () => {
  it("multi-tool allowed-tools is space-joined (not comma-joined)", () => {
    const projectDir = freshProject();
    const connector = defineConnector({
      id: CONNECTOR_ID,
      skills: [
        {
          name: "multi-tool",
          description: "Uses many tools.",
          body: "body",
          tools: { allow: ["Bash", "Read", "Grep"] },
        },
      ],
    });
    const ctx = buildCtx(projectDir, connector);
    piAdapter.installSkills!(ctx);

    const skillMd = join(projectDir, ".pi", "skills", "multi-tool", "SKILL.md");
    const { frontmatter } = splitFm(readFileSync(skillMd, "utf8"));
    // Must be space-delimited
    expect(frontmatter["allowed-tools"]).toBe("Bash Read Grep");
    // Must NOT be comma-delimited
    expect(frontmatter["allowed-tools"]).not.toContain(",");
  });

  it("single-tool allowed-tools has no trailing separator", () => {
    const projectDir = freshProject();
    const connector = defineConnector({
      id: CONNECTOR_ID,
      skills: [
        {
          name: "single-tool",
          description: "Uses one tool.",
          body: "body",
          tools: { allow: ["Bash"] },
        },
      ],
    });
    const ctx = buildCtx(projectDir, connector);
    piAdapter.installSkills!(ctx);

    const skillMd = join(projectDir, ".pi", "skills", "single-tool", "SKILL.md");
    const { frontmatter } = splitFm(readFileSync(skillMd, "utf8"));
    expect(frontmatter["allowed-tools"]).toBe("Bash");
  });
});

// ── 8. Subagents unsupported ──────────────────────────────────────────────────

describe("pi adapter — subagents unsupported", () => {
  it("installSubagents with no subagents declared returns skip", () => {
    const projectDir = freshProject();
    // Use a skills-only connector so defineConnector doesn't reject it.
    const ctx = buildCtx(projectDir, buildConnector({ skills: true }));
    const changes = piAdapter.installSubagents!(ctx);
    expect(changes[0]?.action).toBe("skip");
  });

  it("installSubagents with a declared subagent returns warn (unsupported surface)", () => {
    const projectDir = freshProject();
    const connector = defineConnector({
      id: CONNECTOR_ID,
      subagents: [{ name: "reviewer", description: "Reviews code.", prompt: "You are a reviewer." }],
    });
    const ctx = buildCtx(projectDir, connector);
    const changes = piAdapter.installSubagents!(ctx);
    // BaseAdapter default: declared-but-unsupported → warn
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
  });
});
