/**
 * adapters/kiro-skills — skills surface tests for the Kiro adapter.
 *
 * Kiro reads SKILL.md from:
 *   project scope → <projectDir>/.kiro/skills/<name>/SKILL.md
 *   user scope    → ~/.kiro/skills/<name>/SKILL.md
 *
 * Tests:
 *   - supportsSkills capability is true
 *   - installSkills (project scope) writes .kiro/skills/<n>/SKILL.md with
 *     correct frontmatter + body + resource files
 *   - installSkills (user scope) writes ~/.kiro/skills/<n>/SKILL.md
 *   - installSkills is idempotent (second call → skip)
 *   - uninstallSkills removes SKILL.md + resource + empty dir
 *   - platforms['kiro'].skills === false disables the surface
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import kiroAdapter from "../../src/adapters/kiro/index.js";

const CONNECTOR_ID = "acme-kiro-skills";

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
    displayName: "Acme Kiro Skills",
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
  const dir = mkdtempSync(join(tmpdir(), "ac-kiro-skills-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
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

describe("kiro adapter — skills surface", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("declares supportsSkills true", () => {
    expect(kiroAdapter.capabilities.supportsSkills).toBe(true);
  });

  it("installSkills (project scope) writes .kiro/skills/<n>/SKILL.md with correct frontmatter", () => {
    const changes = kiroAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");

    const skillMd = join(projectDir, ".kiro", "skills", "pdf-tools", "SKILL.md");
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
    kiroAdapter.installSkills!(ctx);
    const resource = join(projectDir, ".kiro", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills (user scope) writes ~/.kiro/skills/<n>/SKILL.md", () => {
    const userCtx = buildCtx(projectDir, buildConnector(), "user");
    const changes = kiroAdapter.installSkills!(userCtx);
    expect(changes[0]?.action).toBe("create");

    // HOME redirected to projectDir → ~/.kiro === projectDir/.kiro
    const skillMd = join(projectDir, ".kiro", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);

    // HOME === projectDir in this fixture, so the user/project paths coincide;
    // just verify the written content.
    const { frontmatter } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
  });

  it("installSkills is idempotent — second call yields skip", () => {
    kiroAdapter.installSkills!(ctx);
    const second = kiroAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource, and the empty skill dir", () => {
    kiroAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".kiro", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".kiro", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    kiroAdapter.uninstallSkills!(ctx);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(resource)).toBe(false);
    expect(existsSync(join(projectDir, ".kiro", "skills", "pdf-tools"))).toBe(false);
  });

  it("honors platforms['kiro'].skills === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      skills: [skill()],
      platforms: { kiro: { skills: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    const changes = kiroAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".kiro", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("installSkills with no skills declared returns skip", () => {
    const noSkills = defineConnector({ id: CONNECTOR_ID, memory: [{ content: "placeholder" }] });
    const c2 = buildCtx(projectDir, noSkills);
    const changes = kiroAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
  });
});
