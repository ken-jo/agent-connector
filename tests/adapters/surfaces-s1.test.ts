/**
 * adapters/surfaces-s1 — content-surface (commands/skills/subagents) render +
 * round-trip tests for the second wave of supporting adapters:
 *
 *   • gemini-cli  — TOML commands, uniform SKILL.md skills, md+fm subagents
 *   • qwen-code   — TOML commands, NO skill surface (warn/skip), md+fm subagents
 *   • cursor      — body-only commands (no frontmatter), SKILL.md skills, md+fm subagents
 *   • opencode    — md+fm commands, SKILL.md skills, md+fm subagents under the
 *                   SINGULAR agent/ dir
 *   • codex       — md+fm commands at ~/.codex/prompts (USER scope only; project
 *                   scope → warn), SKILL.md skills, TOML subagents
 *
 * Each platform is exercised end-to-end against REAL files on disk in an
 * isolated temp project dir:
 *   • install* writes the native file at the right path in the right format
 *     (TOML parsed with @iarna/toml; md+fm split + parsed with `yaml`; cursor
 *     command asserted as raw body with no frontmatter delimiter)
 *   • idempotency (second install → "skip")
 *   • uninstall (files removed; re-read from disk confirms gone)
 *   • capability gating: qwen skills route through the BaseAdapter warn/skip path
 *   • codex command scope: user scope writes to ~/.codex/prompts (HOME temp);
 *     project scope yields a single "warn"
 *
 * Filesystem isolation: a fresh os.tmpdir mkdtemp project dir per test. HOME,
 * AGENT_CONNECTOR_DATA_DIR, and CODEX_HOME point at temp and are restored in
 * afterEach so the codex user-scope path resolves under the temp HOME.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { parse as parseToml } from "@iarna/toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import geminiAdapter from "../../src/adapters/gemini-cli/index.js";
import qwenAdapter from "../../src/adapters/qwen-code/index.js";
import cursorAdapter from "../../src/adapters/cursor/index.js";
import opencodeAdapter from "../../src/adapters/opencode/index.js";
import codexAdapter from "../../src/adapters/codex/index.js";

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

/** A connector declaring a command + skill (with a resource) + subagent. */
function buildConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Surfaces",
    version: "1.0.0",
    commands: [{ ...COMMAND, tools: { allow: [...COMMAND.tools.allow] } }],
    skills: [
      {
        ...SKILL,
        tools: { allow: [...SKILL.tools.allow] },
        resources: { ...SKILL.resources },
      },
    ],
    subagents: [{ ...SUBAGENT, tools: { allow: [...SUBAGENT.tools.allow] } }],
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

let savedHome: string | undefined;
let savedDataDir: string | undefined;
let savedCodexHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
  savedCodexHome = process.env.CODEX_HOME;
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
  restore("CODEX_HOME", savedCodexHome);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-surfaces-s1-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  // Unset CODEX_HOME so codex user scope resolves under the temp HOME (~/.codex).
  delete process.env.CODEX_HOME;
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

// ── gemini-cli ──────────────────────────────────────────────────────────────

describe("gemini-cli adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("declares support for all three content surfaces", () => {
    expect(geminiAdapter.capabilities.supportsCommands).toBe(true);
    expect(geminiAdapter.capabilities.supportsSkills).toBe(true);
    expect(geminiAdapter.capabilities.supportsSubagents).toBe(true);
  });

  it("installCommands writes a TOML command (description + prompt, args preserved)", () => {
    const changes = geminiAdapter.installCommands!(ctx);
    expect(changes[0]?.action).toBe("create");

    const cmdPath = join(projectDir, ".gemini", "commands", "deploy.toml");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);

    const toml = parseToml(readFileSync(cmdPath, "utf8")) as Record<string, unknown>;
    expect(toml.description).toBe("Deploy the app to an environment.");
    expect(toml.prompt).toBe(COMMAND.prompt);
  });

  it("installSkills writes uniform SKILL.md + resource with correct frontmatter", () => {
    geminiAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".gemini", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".gemini", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
    expect(frontmatter.model).toBe("haiku");
    expect(frontmatter["allowed-tools"]).toBe("Bash");
    expect(frontmatter["disable-model-invocation"]).toBe(false);
    expect(body).toContain("# PDF Tools");
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSubagents writes md+fm agents/<name>.md (name, description, tools, model)", () => {
    geminiAdapter.installSubagents!(ctx);
    const agentPath = join(projectDir, ".gemini", "agents", "reviewer.md");
    expect(existsSync(agentPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(agentPath, "utf8"));
    expect(frontmatter.name).toBe("reviewer");
    expect(frontmatter.description).toBe(SUBAGENT.description);
    expect(frontmatter.tools).toBe("Read, Grep");
    expect(frontmatter.model).toBe("opus");
    expect(body.trim()).toBe(SUBAGENT.prompt);
  });

  it("is idempotent — second install yields skip across all surfaces", () => {
    geminiAdapter.installCommands!(ctx);
    geminiAdapter.installSkills!(ctx);
    geminiAdapter.installSubagents!(ctx);
    expect(geminiAdapter.installCommands!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(geminiAdapter.installSkills!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(geminiAdapter.installSubagents!(ctx).every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall removes all written files", () => {
    geminiAdapter.installCommands!(ctx);
    geminiAdapter.installSkills!(ctx);
    geminiAdapter.installSubagents!(ctx);

    geminiAdapter.uninstallCommands!(ctx);
    geminiAdapter.uninstallSkills!(ctx);
    geminiAdapter.uninstallSubagents!(ctx);

    expect(existsSync(join(projectDir, ".gemini", "commands", "deploy.toml"))).toBe(false);
    expect(existsSync(join(projectDir, ".gemini", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".gemini", "skills", "pdf-tools"))).toBe(false);
    expect(existsSync(join(projectDir, ".gemini", "agents", "reviewer.md"))).toBe(false);
  });

  it("honors platforms['gemini-cli'].commands === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      commands: [{ name: "deploy", prompt: "do it" }],
      platforms: { "gemini-cli": { commands: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    expect(geminiAdapter.installCommands!(c2)[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".gemini", "commands", "deploy.toml"))).toBe(false);
  });
});

// ── qwen-code ─────────────────────────────────────────────────────────────

describe("qwen-code adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("declares commands + skills + subagents", () => {
    expect(qwenAdapter.capabilities.supportsCommands).toBe(true);
    expect(qwenAdapter.capabilities.supportsSkills).toBe(true);
    expect(qwenAdapter.capabilities.supportsSubagents).toBe(true);
  });

  it("installCommands writes a TOML command (description + prompt)", () => {
    const changes = qwenAdapter.installCommands!(ctx);
    expect(changes[0]?.action).toBe("create");
    const cmdPath = join(projectDir, ".qwen", "commands", "deploy.toml");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);

    const toml = parseToml(readFileSync(cmdPath, "utf8")) as Record<string, unknown>;
    expect(toml.description).toBe("Deploy the app to an environment.");
    expect(toml.prompt).toBe(COMMAND.prompt);
  });

  it("installSubagents writes md+fm agents/<name>.md", () => {
    qwenAdapter.installSubagents!(ctx);
    const agentPath = join(projectDir, ".qwen", "agents", "reviewer.md");
    expect(existsSync(agentPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(agentPath, "utf8"));
    expect(frontmatter.name).toBe("reviewer");
    expect(frontmatter.tools).toBe("Read, Grep");
    expect(frontmatter.model).toBe("opus");
    expect(body.trim()).toBe(SUBAGENT.prompt);
  });

  it("installSkills writes SKILL.md under .qwen/skills/<name>/SKILL.md", () => {
    const changes = qwenAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");
    const skillMd = join(projectDir, ".qwen", "skills", "pdf-tools", "SKILL.md");
    expect(existsSync(skillMd)).toBe(true);
    const { frontmatter, body } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
    expect(frontmatter.model).toBe("haiku");
    expect(frontmatter["allowed-tools"]).toBe("Bash");
    expect(body).toContain("# PDF Tools");
  });

  it("installSkills is idempotent — second install yields skip", () => {
    qwenAdapter.installSkills!(ctx);
    expect(qwenAdapter.installSkills!(ctx).every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md", () => {
    qwenAdapter.installSkills!(ctx);
    qwenAdapter.uninstallSkills!(ctx);
    expect(existsSync(join(projectDir, ".qwen", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("is idempotent — second install yields skip (commands + subagents)", () => {
    qwenAdapter.installCommands!(ctx);
    qwenAdapter.installSubagents!(ctx);
    expect(qwenAdapter.installCommands!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(qwenAdapter.installSubagents!(ctx).every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall removes command + subagent files", () => {
    qwenAdapter.installCommands!(ctx);
    qwenAdapter.installSubagents!(ctx);
    qwenAdapter.uninstallCommands!(ctx);
    qwenAdapter.uninstallSubagents!(ctx);
    expect(existsSync(join(projectDir, ".qwen", "commands", "deploy.toml"))).toBe(false);
    expect(existsSync(join(projectDir, ".qwen", "agents", "reviewer.md"))).toBe(false);
  });
});

// ── cursor ────────────────────────────────────────────────────────────────

describe("cursor adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("declares support for all three content surfaces", () => {
    expect(cursorAdapter.capabilities.supportsCommands).toBe(true);
    expect(cursorAdapter.capabilities.supportsSkills).toBe(true);
    expect(cursorAdapter.capabilities.supportsSubagents).toBe(true);
  });

  it("installCommands writes a BODY-ONLY .md command with NO frontmatter delimiter", () => {
    const changes = cursorAdapter.installCommands!(ctx);
    expect(changes[0]?.action).toBe("create");
    const cmdPath = join(projectDir, ".cursor", "commands", "deploy.md");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);

    const text = readFileSync(cmdPath, "utf8");
    // No YAML frontmatter block: the file must not open with the `---` delimiter.
    expect(text.startsWith("---\n")).toBe(false);
    // The prompt body is present verbatim.
    expect(text).toContain(COMMAND.prompt);
  });

  it("installSkills writes uniform SKILL.md + resource", () => {
    cursorAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".cursor", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".cursor", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    const { frontmatter } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
  });

  it("installSubagents writes md+fm agents/<name>.md (name, description, model, readonly)", () => {
    cursorAdapter.installSubagents!(ctx);
    const agentPath = join(projectDir, ".cursor", "agents", "reviewer.md");
    expect(existsSync(agentPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(agentPath, "utf8"));
    expect(frontmatter.name).toBe("reviewer");
    expect(frontmatter.description).toBe(SUBAGENT.description);
    expect(frontmatter.model).toBe("opus");
    expect(frontmatter.readonly).toBe(true);
    expect(body.trim()).toBe(SUBAGENT.prompt);
  });

  it("is idempotent — second install yields skip across all surfaces", () => {
    cursorAdapter.installCommands!(ctx);
    cursorAdapter.installSkills!(ctx);
    cursorAdapter.installSubagents!(ctx);
    expect(cursorAdapter.installCommands!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(cursorAdapter.installSkills!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(cursorAdapter.installSubagents!(ctx).every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall removes all written files", () => {
    cursorAdapter.installCommands!(ctx);
    cursorAdapter.installSkills!(ctx);
    cursorAdapter.installSubagents!(ctx);

    cursorAdapter.uninstallCommands!(ctx);
    cursorAdapter.uninstallSkills!(ctx);
    cursorAdapter.uninstallSubagents!(ctx);

    expect(existsSync(join(projectDir, ".cursor", "commands", "deploy.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".cursor", "skills", "pdf-tools"))).toBe(false);
    expect(existsSync(join(projectDir, ".cursor", "agents", "reviewer.md"))).toBe(false);
  });
});

// ── opencode ────────────────────────────────────────────────────────────────

describe("opencode adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("declares support for all three content surfaces", () => {
    expect(opencodeAdapter.capabilities.supportsCommands).toBe(true);
    expect(opencodeAdapter.capabilities.supportsSkills).toBe(true);
    expect(opencodeAdapter.capabilities.supportsSubagents).toBe(true);
  });

  it("installCommands writes md+fm commands/<name>.md (description, model)", () => {
    const changes = opencodeAdapter.installCommands!(ctx);
    expect(changes[0]?.action).toBe("create");
    // Project scope: opencode getConfigDir === projectDir (no dot-dir wrapper).
    const cmdPath = join(projectDir, ".opencode", "commands", "deploy.md");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(cmdPath, "utf8"));
    expect(frontmatter.description).toBe("Deploy the app to an environment.");
    expect(frontmatter.model).toBe("sonnet");
    expect(body.trim()).toBe(COMMAND.prompt);
  });

  it("installSkills writes uniform SKILL.md + resource", () => {
    opencodeAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".opencode", "skills", "pdf-tools", "SKILL.md");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(join(projectDir, ".opencode", "skills", "pdf-tools", "scripts", "extract.sh"))).toBe(true);

    const { frontmatter } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
  });

  it("installSubagents writes md+fm under the SINGULAR agent/ dir (mode:subagent)", () => {
    opencodeAdapter.installSubagents!(ctx);
    // SINGULAR "agent" dir, not "agents".
    const agentPath = join(projectDir, ".opencode", "agent", "reviewer.md");
    expect(existsSync(agentPath)).toBe(true);
    expect(existsSync(join(projectDir, "agents", "reviewer.md"))).toBe(false);

    const { frontmatter, body } = splitFrontmatter(readFileSync(agentPath, "utf8"));
    expect(frontmatter.description).toBe(SUBAGENT.description);
    expect(frontmatter.mode).toBe("subagent");
    expect(frontmatter.model).toBe("opus");
    expect(body.trim()).toBe(SUBAGENT.prompt);
  });

  it("is idempotent — second install yields skip across all surfaces", () => {
    opencodeAdapter.installCommands!(ctx);
    opencodeAdapter.installSkills!(ctx);
    opencodeAdapter.installSubagents!(ctx);
    expect(opencodeAdapter.installCommands!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(opencodeAdapter.installSkills!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(opencodeAdapter.installSubagents!(ctx).every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall removes all written files", () => {
    opencodeAdapter.installCommands!(ctx);
    opencodeAdapter.installSkills!(ctx);
    opencodeAdapter.installSubagents!(ctx);

    opencodeAdapter.uninstallCommands!(ctx);
    opencodeAdapter.uninstallSkills!(ctx);
    opencodeAdapter.uninstallSubagents!(ctx);

    expect(existsSync(join(projectDir, ".opencode", "commands", "deploy.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".opencode", "skills", "pdf-tools"))).toBe(false);
    expect(existsSync(join(projectDir, ".opencode", "agent", "reviewer.md"))).toBe(false);
  });
});

// ── codex ─────────────────────────────────────────────────────────────────

describe("codex adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("declares support for all three content surfaces", () => {
    expect(codexAdapter.capabilities.supportsCommands).toBe(true);
    expect(codexAdapter.capabilities.supportsSkills).toBe(true);
    expect(codexAdapter.capabilities.supportsSubagents).toBe(true);
  });

  it("installSkills writes uniform SKILL.md + resource (project scope under .codex)", () => {
    codexAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".codex", "skills", "pdf-tools", "SKILL.md");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(join(projectDir, ".codex", "skills", "pdf-tools", "scripts", "extract.sh"))).toBe(true);

    const { frontmatter } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
  });

  it("installSubagents writes a TOML agent (name, description, developer_instructions, model)", () => {
    const changes = codexAdapter.installSubagents!(ctx);
    expect(changes[0]?.action).toBe("create");
    const agentPath = join(projectDir, ".codex", "agents", "reviewer.toml");
    expect(changes[0]?.path).toBe(agentPath);
    expect(existsSync(agentPath)).toBe(true);

    const toml = parseToml(readFileSync(agentPath, "utf8")) as Record<string, unknown>;
    expect(toml.name).toBe("reviewer");
    expect(toml.description).toBe(SUBAGENT.description);
    expect(toml.developer_instructions).toBe(SUBAGENT.prompt);
    expect(toml.model).toBe("opus");
  });

  it("commands are USER-scope only: project scope yields a single warn (no file)", () => {
    const changes = codexAdapter.installCommands!(ctx); // ctx scope === "project"
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
    expect(existsSync(join(projectDir, ".codex", "prompts", "deploy.md"))).toBe(false);
  });

  it("installCommands at USER scope writes md+fm to ~/.codex/prompts (HOME temp)", () => {
    const userCtx = buildCtx(projectDir, buildConnector(), "user");
    const changes = codexAdapter.installCommands!(userCtx);
    expect(changes[0]?.action).toBe("create");

    // HOME redirected to projectDir; CODEX_HOME unset → ~/.codex === projectDir/.codex.
    const cmdPath = join(projectDir, ".codex", "prompts", "deploy.md");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(cmdPath, "utf8"));
    expect(frontmatter.description).toBe("Deploy the app to an environment.");
    expect(frontmatter["argument-hint"]).toBe("[environment]");
    expect(body.trim()).toBe(COMMAND.prompt);
  });

  it("is idempotent — second install yields skip (skills + subagents + user commands)", () => {
    const userCtx = buildCtx(projectDir, buildConnector(), "user");
    codexAdapter.installSkills!(ctx);
    codexAdapter.installSubagents!(ctx);
    codexAdapter.installCommands!(userCtx);
    expect(codexAdapter.installSkills!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(codexAdapter.installSubagents!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(codexAdapter.installCommands!(userCtx).every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall removes skills, subagents, and user-scope command files", () => {
    const userCtx = buildCtx(projectDir, buildConnector(), "user");
    codexAdapter.installSkills!(ctx);
    codexAdapter.installSubagents!(ctx);
    codexAdapter.installCommands!(userCtx);

    codexAdapter.uninstallSkills!(ctx);
    codexAdapter.uninstallSubagents!(ctx);
    codexAdapter.uninstallCommands!(userCtx);

    expect(existsSync(join(projectDir, ".codex", "skills", "pdf-tools"))).toBe(false);
    expect(existsSync(join(projectDir, ".codex", "agents", "reviewer.toml"))).toBe(false);
    expect(existsSync(join(projectDir, ".codex", "prompts", "deploy.md"))).toBe(false);
  });
});
