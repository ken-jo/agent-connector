/**
 * adapters/hermes-skills.test.ts — skills surface tests for the hermes adapter.
 *
 * Hermes auto-discovers dir-per-skill SKILL.md from its LOCAL, read-write
 * "single source of truth" root (hermes-agent.nousresearch.com docs):
 *   user scope    → ~/.hermes/skills/<name>/SKILL.md
 * There is no documented hermes-owned PROJECT skills dir, so a project-scope
 * install skip-warns rather than guessing a path.
 *
 * Tests:
 *   - supportsSkills capability is true
 *   - installSkills (user scope) writes ~/.hermes/skills/<n>/SKILL.md with
 *     correct frontmatter + body + resource files; ChangeRecord.platform "hermes"
 *   - installSkills (project scope) → skip-warn (no project skills dir)
 *   - installSkills is idempotent (second call → skip)
 *   - uninstallSkills removes SKILL.md + resource + the empty skill dir
 *   - a skills dir that is a FILE → skip-warn (no crash)
 *   - platforms['hermes'].skills === false disables the surface
 *   - no skills declared → skip
 *
 * MCP/hooks/parse/formatReply are covered by wave3.test.ts.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import hermesAdapter from "../../src/adapters/hermes/index.js";

const CONNECTOR_ID = "acme-hermes-skills";

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
    displayName: "Acme Hermes Skills",
    version: "1.0.0",
    skills: [skill()],
    ...cfg,
  });
}

function buildCtx(
  projectDir: string,
  connector: ResolvedConnector,
  scope: "project" | "user" = "user",
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

beforeEach(() => {
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("USERPROFILE", savedUserProfile);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-hermes-skills-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
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

// ── hermes skills surface ───────────────────────────────────────────────────

describe("hermes adapter — skills surface", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector(), "user");
  });

  it("declares supportsSkills true", () => {
    expect(hermesAdapter.capabilities.supportsSkills).toBe(true);
  });

  it("installSkills (user scope) writes ~/.hermes/skills/<n>/SKILL.md with correct frontmatter", () => {
    const changes = hermesAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.platform).toBe("hermes");

    // HOME redirected to projectDir → ~/.hermes === projectDir/.hermes
    const skillMd = join(projectDir, ".hermes", "skills", "pdf-tools", "SKILL.md");
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

  it("installSkills (user scope) writes resource files beside SKILL.md", () => {
    hermesAdapter.installSkills!(ctx);
    const resource = join(projectDir, ".hermes", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills (project scope) skip-warns — no hermes-owned project skills dir", () => {
    const projCtx = buildCtx(projectDir, buildConnector(), "project");
    const changes = hermesAdapter.installSkills!(projCtx);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("user-scope only");
    // Nothing was written anywhere.
    expect(existsSync(join(projectDir, ".hermes", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("installSkills is idempotent — second call yields skip", () => {
    hermesAdapter.installSkills!(ctx);
    const second = hermesAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource, and the empty skill dir", () => {
    hermesAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".hermes", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".hermes", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);

    const changes = hermesAdapter.uninstallSkills!(ctx);
    expect(changes.every((c) => c.platform === "hermes")).toBe(true);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(resource)).toBe(false);
    expect(existsSync(join(projectDir, ".hermes", "skills", "pdf-tools"))).toBe(false);
  });

  it("skips-warns when the skills path is a FILE (no ENOTDIR crash)", () => {
    // Plant ~/.hermes/skills as a regular FILE where we need a directory.
    const skillsDir = join(projectDir, ".hermes", "skills");
    mkdirSync(dirname(skillsDir), { recursive: true });
    writeFileSync(skillsDir, "not a dir", "utf8");

    const changes = hermesAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("is a file, not a directory");
    expect(existsSync(join(skillsDir, "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("honors platforms['hermes'].skills === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      skills: [skill()],
      platforms: { hermes: { skills: false } },
    });
    const c2 = buildCtx(projectDir, disabled, "user");
    const changes = hermesAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".hermes", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("installSkills with no skills declared returns skip", () => {
    const noSkills = defineConnector({ id: CONNECTOR_ID, memory: [{ content: "placeholder" }] });
    const c2 = buildCtx(projectDir, noSkills, "user");
    const changes = hermesAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
  });
});
