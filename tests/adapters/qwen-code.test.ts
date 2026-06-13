/**
 * adapters/qwen-code.test.ts — skills surface tests for the qwen-code adapter.
 *
 * This file covers the skills gap closed in the skills-gap batch:
 *   supportsSkills: true (confirmed dir: .qwen/skills/<name>/SKILL.md project scope;
 *   ~/.qwen/skills/<name>/SKILL.md user scope — kilo-pi-ground-truth.md).
 *
 * MCP/hooks/commands/subagents are covered by wave2.test.ts and surfaces-s1.test.ts.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import qwenAdapter from "../../src/adapters/qwen-code/index.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-skills";

const SKILL = {
  name: "pdf-tools",
  description: "Extract and summarize text from PDF files when the user asks.",
  body: "# PDF Tools\n\nUse the bundled script to extract text.",
  model: "haiku",
  tools: { allow: ["Bash"] },
  disableModelInvocation: false,
  resources: { "scripts/extract.sh": "#!/bin/sh\necho extracting\n" },
} as const;

function buildConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Skills",
    version: "1.0.0",
    skills: [
      {
        ...SKILL,
        tools: { allow: [...SKILL.tools.allow] },
        resources: { ...SKILL.resources },
      },
    ],
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

beforeEach(() => {
  savedHome = process.env.HOME;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-qwen-skills-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return dir;
}

// ── qwen-code skills surface ───────────────────────────────────────────────

describe("qwen-code adapter — skills surface", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = freshProject();
  });

  it("declares supportsSkills: true", () => {
    expect(qwenAdapter.capabilities.supportsSkills).toBe(true);
  });

  it("installSkills (project scope) writes SKILL.md at .qwen/skills/<name>/SKILL.md", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const changes = qwenAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");

    const skillMd = join(projectDir, ".qwen", "skills", "pdf-tools", "SKILL.md");
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
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    qwenAdapter.installSkills!(ctx);

    const resource = join(projectDir, ".qwen", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills (user scope) writes SKILL.md at ~/.qwen/skills/<name>/SKILL.md", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = qwenAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");

    const skillMd = join(projectDir, ".qwen", "skills", "pdf-tools", "SKILL.md");
    expect(existsSync(skillMd)).toBe(true);
  });

  it("installSkills is idempotent — second install yields skip", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    qwenAdapter.installSkills!(ctx);
    const second = qwenAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md and resource", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    qwenAdapter.installSkills!(ctx);

    const skillMd = join(projectDir, ".qwen", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".qwen", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    qwenAdapter.uninstallSkills!(ctx);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(resource)).toBe(false);
  });

  it("skills disabled via platforms opt-out → skip", () => {
    const connector = defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme Skills",
      version: "1.0.0",
      skills: [{ ...SKILL, tools: { allow: [...SKILL.tools.allow] } }],
      platforms: { "qwen-code": { skills: false } },
    });
    const ctx = buildCtx(projectDir, connector, "project");
    const changes = qwenAdapter.installSkills!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
  });

  it("no skills declared → skip", () => {
    const connector = defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme Skills",
      version: "1.0.0",
      // Use a subagent so the connector has at least one surface (skills omitted).
      subagents: [{ name: "a", description: "d", prompt: "p" }],
    });
    const ctx = buildCtx(projectDir, connector, "project");
    const changes = qwenAdapter.installSkills!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
  });
});
