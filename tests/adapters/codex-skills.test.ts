/**
 * adapters/codex-skills — skills surface tests for the Codex adapter.
 *
 * Codex reads SKILL.md from (codex-rs/core-skills/src/loader.rs):
 *   project scope → <projectDir>/.codex/skills/<name>/SKILL.md   (Project config layer)
 *   user scope    → ~/.agents/skills/<name>/SKILL.md             (current user root)
 *
 * The older ~/.codex/skills (= $CODEX_HOME/skills) is STILL read but the loader
 * labels it a "Deprecated user skills location, kept for backward compatibility",
 * so user-scope installs must target ~/.agents/skills. Two regression guards below
 * pin the fix: user scope must NOT write to ~/.codex/skills, and the .agents path
 * is anchored to the OS home (home_dir) NOT $CODEX_HOME — so a custom CODEX_HOME
 * must not move it.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import codexAdapter from "../../src/adapters/codex/index.js";

const CONNECTOR_ID = "acme-codex-skills";

const SKILL = {
  name: "pdf-tools",
  description: "Extract and summarize text from PDF files.",
  body: "# PDF Tools\n\nUse the bundled script to extract text.",
  model: "haiku",
  tools: { allow: ["Bash"] },
  disableModelInvocation: false,
  resources: { "scripts/extract.sh": "#!/bin/sh\necho extracting\n" },
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
    displayName: "Acme Codex Skills",
    version: "1.0.0",
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

let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let savedCodexHome: string | undefined;
let savedDataDir: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  savedCodexHome = process.env.CODEX_HOME;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("USERPROFILE", savedUserProfile);
  restore("CODEX_HOME", savedCodexHome);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-codex-skills-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  // Default: CODEX_HOME unset → userConfigDir() falls back to ~/.codex.
  delete process.env.CODEX_HOME;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  return dir;
}

function splitFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  if (!m) throw new Error(`not a frontmatter doc:\n${text}`);
  return {
    frontmatter: parseYaml(m[1]!) as Record<string, unknown>,
    body: m[2]!,
  };
}

describe("codex adapter — skills surface", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("declares supportsSkills true", () => {
    expect(codexAdapter.capabilities.supportsSkills).toBe(true);
  });

  it("installSkills (project scope) writes .codex/skills/<n>/SKILL.md with correct frontmatter", () => {
    const changes = codexAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");

    const skillMd = join(projectDir, ".codex", "skills", "pdf-tools", "SKILL.md");
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

  it("installSkills (project scope) writes resource files beside SKILL.md", () => {
    codexAdapter.installSkills!(ctx);
    const resource = join(projectDir, ".codex", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills (user scope) writes ~/.agents/skills/<n>/SKILL.md (the current user root)", () => {
    const userCtx = buildCtx(projectDir, buildConnector(), "user");
    const changes = codexAdapter.installSkills!(userCtx);
    expect(changes[0]?.action).toBe("create");

    // HOME redirected to projectDir → ~/.agents === projectDir/.agents
    const skillMd = join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);

    const { frontmatter } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
  });

  it("user-scope skill does NOT write to the deprecated ~/.codex/skills location", () => {
    const userCtx = buildCtx(projectDir, buildConnector(), "user");
    codexAdapter.installSkills!(userCtx);
    // The deprecated $CODEX_HOME/skills tree must stay empty.
    expect(existsSync(join(projectDir, ".codex", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("user-scope .agents path is anchored to the OS home, NOT $CODEX_HOME", () => {
    // A custom CODEX_HOME must move ~/.codex/* but NOT the .agents skills root,
    // which the loader anchors to home_dir (loader.rs:322-324).
    const codexHome = join(projectDir, "custom-codex-home");
    process.env.CODEX_HOME = codexHome;

    const userCtx = buildCtx(projectDir, buildConnector(), "user");
    codexAdapter.installSkills!(userCtx);

    // Lands under HOME/.agents, independent of CODEX_HOME.
    expect(existsSync(join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md"))).toBe(true);
    // Never under CODEX_HOME (neither the deprecated skills dir nor a .agents there).
    expect(existsSync(join(codexHome, "skills", "pdf-tools", "SKILL.md"))).toBe(false);
    expect(existsSync(join(codexHome, ".agents", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("installSkills is idempotent — second call yields skip", () => {
    codexAdapter.installSkills!(ctx);
    const second = codexAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills (user scope) removes SKILL.md, resource, and the empty skill dir", () => {
    const userCtx = buildCtx(projectDir, buildConnector(), "user");
    codexAdapter.installSkills!(userCtx);
    const skillMd = join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".agents", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    codexAdapter.uninstallSkills!(userCtx);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(resource)).toBe(false);
    expect(existsSync(join(projectDir, ".agents", "skills", "pdf-tools"))).toBe(false);
  });

  it("honors platforms['codex'].skills === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      skills: [skill()],
      platforms: { codex: { skills: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    const changes = codexAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".codex", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("installSkills with no skills declared returns skip", () => {
    const noSkills = defineConnector({ id: CONNECTOR_ID, memory: [{ content: "placeholder" }] });
    const c2 = buildCtx(projectDir, noSkills);
    const changes = codexAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
  });
});
