/**
 * adapters/crush-skills.test.ts — skills surface tests for the crush adapter.
 *
 * Crush auto-discovers Agent-Skills dirs (paths hard-coded in
 * charmbracelet/crush internal/config/load.go — no crush.json entry needed):
 *   project scope → <projectDir>/.crush/skills/<name>/SKILL.md
 *   user scope    → ~/.config/crush/skills/<name>/SKILL.md
 *
 * Tests:
 *   - supportsSkills capability is true
 *   - installSkills (project scope) writes .crush/skills/<n>/SKILL.md with
 *     correct frontmatter + body + resource files; ChangeRecord.platform "crush"
 *   - installSkills (user scope) writes ~/.config/crush/skills/<n>/SKILL.md
 *   - installSkills is idempotent (second call → skip)
 *   - uninstallSkills removes SKILL.md + resource + the empty skill dir
 *   - a skills dir that is a FILE → skip-warn (no crash)
 *   - platforms['crush'].skills === false disables the surface
 *   - no skills declared → skip
 *
 * MCP/hooks/parse/formatReply are covered by wave2.test.ts.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import crushAdapter from "../../src/adapters/crush/index.js";

const CONNECTOR_ID = "acme-crush-skills";

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
    displayName: "Acme Crush Skills",
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
let savedXdg: string | undefined;
let savedLocalAppData: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  savedXdg = process.env.XDG_CONFIG_HOME;
  savedLocalAppData = process.env.LOCALAPPDATA;
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("USERPROFILE", savedUserProfile);
  restore("XDG_CONFIG_HOME", savedXdg);
  restore("LOCALAPPDATA", savedLocalAppData);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-crush-skills-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  // Crush's user dir is home.Config()/crush = ~/.config/crush; pin XDG into the
  // sandbox so the test never reads or writes the real user config dir.
  delete process.env.XDG_CONFIG_HOME;
  // Windows: crush's user dir is %LOCALAPPDATA%\crush — isolate it into the
  // sandbox too, or the adapter writes to the real user AppData/Local.
  process.env.LOCALAPPDATA = join(dir, "AppData", "Local");
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

// ── crush skills surface ────────────────────────────────────────────────────

describe("crush adapter — skills surface", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("declares supportsSkills true", () => {
    expect(crushAdapter.capabilities.supportsSkills).toBe(true);
  });

  it("installSkills (project scope) writes .crush/skills/<n>/SKILL.md with correct frontmatter", () => {
    const changes = crushAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.platform).toBe("crush");

    const skillMd = join(projectDir, ".crush", "skills", "pdf-tools", "SKILL.md");
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
    crushAdapter.installSkills!(ctx);
    const resource = join(projectDir, ".crush", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills (user scope) writes ~/.config/crush/skills/<n>/SKILL.md", () => {
    const userCtx = buildCtx(projectDir, buildConnector(), "user");
    const changes = crushAdapter.installSkills!(userCtx);
    expect(changes[0]?.action).toBe("create");

    // crush user dir: POSIX ~/.config/crush, Windows %LOCALAPPDATA%\crush — both
    // isolated into projectDir via the HOME + LOCALAPPDATA redirects.
    const userCrushDir =
      process.platform === "win32"
        ? join(projectDir, "AppData", "Local", "crush")
        : join(projectDir, ".config", "crush");
    const skillMd = join(userCrushDir, "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);
    // It must NOT leak into the project .crush tree.
    expect(existsSync(join(projectDir, ".crush", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("installSkills is idempotent — second call yields skip", () => {
    crushAdapter.installSkills!(ctx);
    const second = crushAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource, and the empty skill dir", () => {
    crushAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".crush", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".crush", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);

    const changes = crushAdapter.uninstallSkills!(ctx);
    expect(changes.every((c) => c.platform === "crush")).toBe(true);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(resource)).toBe(false);
    expect(existsSync(join(projectDir, ".crush", "skills", "pdf-tools"))).toBe(false);
  });

  it("skips-warns when the skills path is a FILE (no ENOTDIR crash)", () => {
    // Plant .crush/skills as a regular FILE where we need a directory.
    const skillsDir = join(projectDir, ".crush", "skills");
    mkdirSync(dirname(skillsDir), { recursive: true });
    writeFileSync(skillsDir, "not a dir", "utf8");

    const changes = crushAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("is a file, not a directory");
    // No SKILL.md was written under the file.
    expect(existsSync(join(skillsDir, "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("honors platforms['crush'].skills === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      skills: [skill()],
      platforms: { crush: { skills: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    const changes = crushAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".crush", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("installSkills with no skills declared returns skip", () => {
    const noSkills = defineConnector({ id: CONNECTOR_ID, memory: [{ content: "placeholder" }] });
    const c2 = buildCtx(projectDir, noSkills);
    const changes = crushAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
  });
});
