/**
 * adapters/mux-skills.test.ts — skills surface tests for the mux adapter.
 *
 * Mux auto-discovers dir-per-skill SKILL.md from its workspace-local and global
 * roots (mux.coder.com/agents/agent-skills):
 *   project scope → <projectDir>/.mux/skills/<name>/SKILL.md
 *   user scope    → ~/.mux/skills/<name>/SKILL.md
 * The skill directory name MUST match ^[a-z0-9]+(?:-[a-z0-9]+)*$ (1–64 chars)
 * and the SKILL.md `name` field must equal it — a name that cannot be
 * represented is skip-warned.
 *
 * Tests:
 *   - supportsSkills capability is true
 *   - installSkills (project scope) writes .mux/skills/<n>/SKILL.md with correct
 *     frontmatter + body + resource files; ChangeRecord.platform "mux"
 *   - installSkills (user scope) writes ~/.mux/skills/<n>/SKILL.md
 *   - a name that violates the Mux dir-name regex → skip-warn (no write)
 *   - installSkills is idempotent (second call → skip)
 *   - uninstallSkills removes SKILL.md + resource + the empty skill dir
 *   - a skills dir that is a FILE → skip-warn (no crash)
 *   - platforms['mux'].skills === false disables the surface
 *   - no skills declared → skip
 *
 * MCP/hooks are covered by wave1-render.test.ts.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import muxAdapter from "../../src/adapters/mux/index.js";

const CONNECTOR_ID = "acme-mux-skills";

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
    displayName: "Acme Mux Skills",
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
  const dir = mkdtempSync(join(tmpdir(), "ac-mux-skills-"));
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

// ── mux skills surface ──────────────────────────────────────────────────────

describe("mux adapter — skills surface", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("declares supportsSkills true", () => {
    expect(muxAdapter.capabilities.supportsSkills).toBe(true);
  });

  it("installSkills (project scope) writes .mux/skills/<n>/SKILL.md with correct frontmatter", () => {
    const changes = muxAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.platform).toBe("mux");

    const skillMd = join(projectDir, ".mux", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    // Mux requires the `name` field to equal the directory name.
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
    expect(frontmatter.model).toBe("haiku");
    expect(frontmatter["allowed-tools"]).toBe("Bash");
    expect(frontmatter["disable-model-invocation"]).toBe(false);
    expect(body).toContain("# PDF Tools");
  });

  it("installSkills (project scope) writes resource files beside SKILL.md", () => {
    muxAdapter.installSkills!(ctx);
    const resource = join(projectDir, ".mux", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills (user scope) writes ~/.mux/skills/<n>/SKILL.md", () => {
    const userCtx = buildCtx(projectDir, buildConnector(), "user");
    const changes = muxAdapter.installSkills!(userCtx);
    expect(changes[0]?.action).toBe("create");

    // HOME redirected to projectDir → ~/.mux === projectDir/.mux
    const skillMd = join(projectDir, ".mux", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);
  });

  it("skip-warns a skill name that violates the Mux dir-name regex", () => {
    // A TRAILING dash passes the connector's broader kebab regex
    // (^[a-z0-9][a-z0-9-]*$) but FAILS Mux's stricter
    // ^[a-z0-9]+(?:-[a-z0-9]+)*$ — exactly the gap this guard covers.
    const bad = defineConnector({
      id: CONNECTOR_ID,
      skills: [{ ...skill(), name: "pdf-tools-" }],
    });
    const c2 = buildCtx(projectDir, bad);
    const changes = muxAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("cannot be represented");
    // Nothing was written for the unrepresentable name.
    expect(existsSync(join(projectDir, ".mux", "skills"))).toBe(false);
  });

  it("installSkills is idempotent — second call yields skip", () => {
    muxAdapter.installSkills!(ctx);
    const second = muxAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource, and the empty skill dir", () => {
    muxAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".mux", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".mux", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);

    const changes = muxAdapter.uninstallSkills!(ctx);
    expect(changes.every((c) => c.platform === "mux")).toBe(true);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(resource)).toBe(false);
    expect(existsSync(join(projectDir, ".mux", "skills", "pdf-tools"))).toBe(false);
  });

  it("skips-warns when the skills path is a FILE (no ENOTDIR crash)", () => {
    // Plant .mux/skills as a regular FILE where we need a directory.
    const skillsDir = join(projectDir, ".mux", "skills");
    mkdirSync(dirname(skillsDir), { recursive: true });
    writeFileSync(skillsDir, "not a dir", "utf8");

    const changes = muxAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("is a file, not a directory");
    expect(existsSync(join(skillsDir, "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("honors platforms['mux'].skills === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      skills: [skill()],
      platforms: { mux: { skills: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    const changes = muxAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".mux", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("installSkills with no skills declared returns skip", () => {
    const noSkills = defineConnector({ id: CONNECTOR_ID, memory: [{ content: "placeholder" }] });
    const c2 = buildCtx(projectDir, noSkills);
    const changes = muxAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
  });
});
