/**
 * adapters/roo-code.test.ts — content-surface tests for the Roo Code adapter.
 *
 * Roo Code gained two native content surfaces (host-native gap-closing):
 *   command → <rooDir>/commands/<name>.md   md + OPTIONAL frontmatter
 *             {description?, argument-hint?, mode?} (mode only via cmd.extra)
 *   skill   → <rooDir>/skills/<name>/SKILL.md (+ resources), AgentSkills format
 * The `.roo` content root is ~/.roo (user) or <projectDir>/.roo (project) — both
 * scopes are supported. (MCP/render/round-trip is covered by wave1-render.test.ts;
 * memory by tests/core/memory-surface.test.ts.)
 *
 * Tests:
 *   - supportsCommands / supportsSkills capability flags are true
 *   - installCommands writes <rooDir>/commands/<name>.md with correct frontmatter
 *     (project + user scope), `mode` passes through only via cmd.extra
 *   - installSkills writes <rooDir>/skills/<name>/SKILL.md + resources (both scopes)
 *   - install is idempotent (second call → skip)
 *   - uninstall removes the files (and the empty skill dir)
 *   - every ChangeRecord.platform === "roo-code"
 *   - platforms['roo-code'].<surface> === false disables the surface
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import rooCodeAdapter from "../../src/adapters/roo-code/index.js";

const CONNECTOR_ID = "acme-roo-code";

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
    displayName: "Acme Roo Code",
    version: "1.0.0",
    commands: [{ ...COMMAND }],
    skills: [skill()],
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
let savedUserProfile: string | undefined;
let savedDataDir: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("USERPROFILE", savedUserProfile);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/**
 * Fresh isolated HOME + project dir. HOME drives the ~/.roo user-scope root, so
 * user-scope content lands under <tmp>/.roo and never touches the real home.
 */
function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-roo-code-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  return dir;
}

// ── capability flags ────────────────────────────────────────────────────────

describe("roo-code adapter — content-surface capabilities", () => {
  it("declares supportsCommands and supportsSkills true", () => {
    expect(rooCodeAdapter.capabilities.supportsCommands).toBe(true);
    expect(rooCodeAdapter.capabilities.supportsSkills).toBe(true);
  });
});

// ── commands surface ────────────────────────────────────────────────────────

describe("roo-code adapter — commands surface", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = freshProject();
  });

  it("installCommands (project scope) writes .roo/commands/<name>.md with frontmatter", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const changes = rooCodeAdapter.installCommands(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes.every((c) => c.platform === "roo-code")).toBe(true);

    const cmdMd = join(projectDir, ".roo", "commands", "deploy.md");
    expect(changes[0]?.path).toBe(cmdMd);
    expect(existsSync(cmdMd)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(cmdMd, "utf8"));
    expect(frontmatter.description).toBe(COMMAND.description);
    expect(frontmatter["argument-hint"]).toBe("[environment]");
    expect(frontmatter.mode).toBeUndefined();
    expect(body).toContain("# Deploy");
  });

  it("installCommands (user scope) writes ~/.roo/commands/<name>.md", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = rooCodeAdapter.installCommands(ctx);
    expect(changes[0]?.action).toBe("create");

    // HOME is the isolated tmp dir, so ~/.roo === <projectDir>/.roo here.
    const cmdMd = join(projectDir, ".roo", "commands", "deploy.md");
    expect(changes[0]?.path).toBe(cmdMd);
    expect(existsSync(cmdMd)).toBe(true);
  });

  it("passes `mode` through only when cmd.extra carries it", () => {
    const connector = buildConnector({
      commands: [{ ...COMMAND, extra: { mode: "architect" } }],
    });
    const ctx = buildCtx(projectDir, connector, "project");
    rooCodeAdapter.installCommands(ctx);

    const cmdMd = join(projectDir, ".roo", "commands", "deploy.md");
    const { frontmatter } = splitFrontmatter(readFileSync(cmdMd, "utf8"));
    expect(frontmatter.mode).toBe("architect");
    expect(frontmatter.description).toBe(COMMAND.description);
  });

  it("installCommands is idempotent — second call yields skip", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    rooCodeAdapter.installCommands(ctx);
    const second = rooCodeAdapter.installCommands(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallCommands removes the .md file", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    rooCodeAdapter.installCommands(ctx);
    const cmdMd = join(projectDir, ".roo", "commands", "deploy.md");
    expect(existsSync(cmdMd)).toBe(true);

    const changes = rooCodeAdapter.uninstallCommands(ctx);
    expect(changes.every((c) => c.platform === "roo-code")).toBe(true);
    expect(existsSync(cmdMd)).toBe(false);
  });

  it("honors platforms['roo-code'].commands === false", () => {
    const connector = buildConnector({ platforms: { "roo-code": { commands: false } } });
    const ctx = buildCtx(projectDir, connector, "project");
    const changes = rooCodeAdapter.installCommands(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".roo", "commands", "deploy.md"))).toBe(false);
  });

  it("no commands declared → skip", () => {
    const connector = defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme Roo Code",
      version: "1.0.0",
      skills: [skill()],
    });
    const ctx = buildCtx(projectDir, connector, "project");
    const changes = rooCodeAdapter.installCommands(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
  });
});

// ── skills surface ──────────────────────────────────────────────────────────

describe("roo-code adapter — skills surface", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = freshProject();
  });

  it("installSkills (project scope) writes .roo/skills/<name>/SKILL.md with frontmatter", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const changes = rooCodeAdapter.installSkills(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes.every((c) => c.platform === "roo-code")).toBe(true);

    const skillMd = join(projectDir, ".roo", "skills", "pdf-tools", "SKILL.md");
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

  it("installSkills writes resource files beside SKILL.md", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    rooCodeAdapter.installSkills(ctx);
    const resource = join(projectDir, ".roo", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills (user scope) writes ~/.roo/skills/<name>/SKILL.md", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = rooCodeAdapter.installSkills(ctx);
    expect(changes[0]?.action).toBe("create");

    // HOME is the isolated tmp dir, so ~/.roo === <projectDir>/.roo here.
    const skillMd = join(projectDir, ".roo", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);
  });

  it("installSkills is idempotent — second call yields skip", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    rooCodeAdapter.installSkills(ctx);
    const second = rooCodeAdapter.installSkills(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource, and the empty skill dir", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    rooCodeAdapter.installSkills(ctx);
    const skillMd = join(projectDir, ".roo", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".roo", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    const changes = rooCodeAdapter.uninstallSkills(ctx);
    expect(changes.every((c) => c.platform === "roo-code")).toBe(true);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(resource)).toBe(false);
    expect(existsSync(join(projectDir, ".roo", "skills", "pdf-tools"))).toBe(false);
  });

  it("honors platforms['roo-code'].skills === false", () => {
    const connector = buildConnector({ platforms: { "roo-code": { skills: false } } });
    const ctx = buildCtx(projectDir, connector, "project");
    const changes = rooCodeAdapter.installSkills(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".roo", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("no skills declared → skip", () => {
    const connector = defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme Roo Code",
      version: "1.0.0",
      commands: [{ ...COMMAND }],
    });
    const ctx = buildCtx(projectDir, connector, "project");
    const changes = rooCodeAdapter.installSkills(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
  });
});
