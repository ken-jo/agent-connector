/**
 * adapters/warp-skills — skills surface tests for the Warp adapter.
 *
 * Warp reads SKILL.md from .agents/skills/<name>/SKILL.md (project scope only).
 * Skills double as slash-commands in Warp's UI (/name).
 * No user-scope skills dir is documented — user-scope install warns and skips.
 *
 * Tests:
 *   - supportsSkills capability is true
 *   - installSkills (project scope) writes .agents/skills/<n>/SKILL.md with
 *     correct frontmatter + body + resource files
 *   - installSkills is idempotent (second call → skip)
 *   - uninstallSkills removes SKILL.md + resource + empty dir
 *   - user-scope installSkills returns a warn (no documented user dir)
 *   - platforms['warp'].skills === false disables the surface
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import warpAdapter from "../../src/adapters/warp/index.js";

const CONNECTOR_ID = "acme-warp-skills";

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
    displayName: "Acme Warp Skills",
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
  const dir = mkdtempSync(join(tmpdir(), "ac-warp-skills-"));
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

describe("warp adapter — skills surface", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("declares supportsSkills true", () => {
    expect(warpAdapter.capabilities.supportsSkills).toBe(true);
  });

  it("installSkills (project scope) writes .agents/skills/<n>/SKILL.md with correct frontmatter", () => {
    const changes = warpAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");

    const skillMd = join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md");
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
    warpAdapter.installSkills!(ctx);
    const resource = join(projectDir, ".agents", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills is idempotent — second call yields skip", () => {
    warpAdapter.installSkills!(ctx);
    const second = warpAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource, and the empty skill dir", () => {
    warpAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".agents", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    warpAdapter.uninstallSkills!(ctx);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(resource)).toBe(false);
    expect(existsSync(join(projectDir, ".agents", "skills", "pdf-tools"))).toBe(false);
  });

  it("user-scope installSkills returns a warn (no documented user-scope skills dir)", () => {
    const userCtx = buildCtx(projectDir, buildConnector(), "user");
    const changes = warpAdapter.installSkills!(userCtx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
    // No file written
    expect(existsSync(join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("honors platforms['warp'].skills === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      skills: [skill()],
      platforms: { warp: { skills: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    const changes = warpAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("installSkills with no skills declared returns skip", () => {
    const noSkills = defineConnector({ id: CONNECTOR_ID, memory: [{ content: "placeholder" }] });
    const c2 = buildCtx(projectDir, noSkills);
    const changes = warpAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
  });
});
