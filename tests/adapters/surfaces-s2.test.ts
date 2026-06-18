/**
 * adapters/surfaces-s2 — content-surface (commands/skills/subagents) render +
 * round-trip tests for the third wave of supporting adapters:
 *
 *   • pi                — uniform SKILL.md skills only (.pi/skills/<n>/SKILL.md);
 *                          NO command/subagent surface (BaseAdapter skip).
 *
 * (The kilo content-surface slice migrated to its per-host file
 * tests/adapters/kilo.test.ts per the ONE-file-per-host convention — see
 * tests/README.md.)
 *
 * (vscode-copilot's, copilot-cli's, and jetbrains-copilot's content-surface
 * slices were migrated to their per-host files tests/adapters/vscode-copilot.test.ts,
 * tests/adapters/copilot-cli.test.ts, and tests/adapters/jetbrains-copilot.test.ts
 * per the ONE-file-per-host convention — see tests/README.md. jetbrains-copilot
 * also took with it the byte-identical-vs-vscode comparison test, so this file no
 * longer imports the vscode-copilot adapter.)
 *
 * Each platform is exercised end-to-end against REAL files on disk in an
 * isolated temp project dir. For each connector we declare ONLY the surfaces the
 * platform supports (per the CONTRACT), so the unsupported surfaces resolve to a
 * "connector declares no <surface>" skip via the BaseAdapter default rather than
 * a warn.
 *
 * Filesystem isolation: a fresh os.tmpdir mkdtemp project dir per test. HOME and
 * AGENT_CONNECTOR_DATA_DIR point at temp and are restored in afterEach so the
 * user-scope pi skill paths resolve under the temp HOME.
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
  // Redirect HOME so user-scope writes (pi) land under the temp dir.
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
