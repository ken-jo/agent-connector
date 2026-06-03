/**
 * adapters/surfaces-claude — content-surface (commands/skills/subagents) tests
 * for the claude-code reference adapter.
 *
 * Exercises the full content-only path end-to-end against REAL files on disk in
 * an isolated temp project dir:
 *   • installCommands  → <configDir>/commands/<name>.md (md + frontmatter)
 *   • installSkills    → <configDir>/skills/<name>/SKILL.md (+ a resource file)
 *   • installSubagents → <configDir>/agents/<name>.md (md + frontmatter)
 *   • frontmatter correctness (description/argument-hint/allowed-tools/model;
 *     name/description for skills; name/description/tools/model for subagents)
 *   • body correctness (prompt / skill body written verbatim after the fm block)
 *   • idempotency (second install → "skip")
 *   • uninstall (files/dirs removed; re-read from disk confirms gone)
 *
 * Filesystem isolation: a fresh os.tmpdir mkdtemp project dir per test; config
 * lands under <tempDir>/.claude only. HOME + AGENT_CONNECTOR_DATA_DIR point at
 * temp and are restored in afterEach.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import claudeAdapter from "../../src/adapters/claude-code/index.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-surfaces";

/** A connector declaring a command + a skill (with a resource) + a subagent. */
function buildConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Surfaces",
    version: "1.0.0",
    commands: [
      {
        name: "deploy",
        description: "Deploy the app to an environment.",
        prompt: "Deploy to $ARGUMENTS and report the result.",
        argumentHint: "[environment]",
        tools: { allow: ["Bash", "Read"] },
        model: "sonnet",
      },
    ],
    skills: [
      {
        name: "pdf-tools",
        description: "Extract and summarize text from PDF files when the user asks.",
        body: "# PDF Tools\n\nUse the bundled script to extract text.",
        model: "haiku",
        tools: { allow: ["Bash"] },
        disableModelInvocation: false,
        resources: {
          "scripts/extract.sh": "#!/bin/sh\necho extracting\n",
        },
      },
    ],
    subagents: [
      {
        name: "reviewer",
        description: "Reviews code diffs for correctness bugs.",
        prompt: "You are a meticulous code reviewer. Find correctness bugs.",
        tools: { allow: ["Read", "Grep"] },
        model: "opus",
      },
    ],
  });
}

/** Build an InstallContext scoped to a fresh temp project dir. */
function buildCtx(projectDir: string, connector: ResolvedConnector): InstallContext {
  return {
    connector,
    scope: "project",
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
  const dir = mkdtempSync(join(tmpdir(), "ac-surfaces-"));
  process.env.HOME = dir;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(dir, ".agent-connector");
  return dir;
}

/** Split a md+frontmatter document into { frontmatter, body }. */
function splitFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  if (!m) throw new Error(`not a frontmatter doc:\n${text}`);
  return {
    frontmatter: parseYaml(m[1]!) as Record<string, unknown>,
    body: m[2]!,
  };
}

describe("claude-code adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject();
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("declares support for all three content surfaces", () => {
    expect(claudeAdapter.capabilities.supportsCommands).toBe(true);
    expect(claudeAdapter.capabilities.supportsSkills).toBe(true);
    expect(claudeAdapter.capabilities.supportsSubagents).toBe(true);
  });

  // ── Commands ──────────────────────────────────────────────────────────────

  it("installCommands writes <configDir>/commands/<name>.md with correct frontmatter + body", () => {
    const changes = claudeAdapter.installCommands!(ctx);
    expect(changes[0]?.action).toBe("create");

    const cmdPath = join(projectDir, ".claude", "commands", "deploy.md");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(cmdPath, "utf8"));
    expect(frontmatter.description).toBe("Deploy the app to an environment.");
    expect(frontmatter["argument-hint"]).toBe("[environment]");
    expect(frontmatter["allowed-tools"]).toBe("Bash, Read");
    expect(frontmatter.model).toBe("sonnet");
    expect(body.trim()).toBe("Deploy to $ARGUMENTS and report the result.");
  });

  it("installCommands is idempotent — second call yields skip", () => {
    claudeAdapter.installCommands!(ctx);
    const second = claudeAdapter.installCommands!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("installCommands honors platforms['claude-code'].commands === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      commands: [{ name: "deploy", prompt: "do it" }],
      platforms: { "claude-code": { commands: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    const changes = claudeAdapter.installCommands!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".claude", "commands", "deploy.md"))).toBe(false);
  });

  it("uninstallCommands removes the command file (re-read confirms gone)", () => {
    claudeAdapter.installCommands!(ctx);
    const cmdPath = join(projectDir, ".claude", "commands", "deploy.md");
    expect(existsSync(cmdPath)).toBe(true);

    const changes = claudeAdapter.uninstallCommands!(ctx);
    expect(changes[0]?.action).toBe("remove");
    expect(existsSync(cmdPath)).toBe(false);
  });

  // ── Skills ──────────────────────────────────────────────────────────────

  it("installSkills writes SKILL.md + resource with correct frontmatter + body", () => {
    const changes = claudeAdapter.installSkills!(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const skillMd = join(projectDir, ".claude", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".claude", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(
      "Extract and summarize text from PDF files when the user asks.",
    );
    expect(frontmatter.model).toBe("haiku");
    expect(frontmatter["allowed-tools"]).toBe("Bash");
    expect(frontmatter["disable-model-invocation"]).toBe(false);
    expect(body).toContain("# PDF Tools");

    // Resource written verbatim.
    expect(readFileSync(resource, "utf8")).toBe("#!/bin/sh\necho extracting\n");
  });

  it("installSkills is idempotent — second call yields skip", () => {
    claudeAdapter.installSkills!(ctx);
    const second = claudeAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes the skill dir contents (re-read confirms gone)", () => {
    claudeAdapter.installSkills!(ctx);
    const skillDir = join(projectDir, ".claude", "skills", "pdf-tools");
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);

    claudeAdapter.uninstallSkills!(ctx);
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(false);
    expect(existsSync(join(skillDir, "scripts", "extract.sh"))).toBe(false);
    expect(existsSync(skillDir)).toBe(false);
  });

  // ── Subagents ───────────────────────────────────────────────────────────────

  it("installSubagents writes <configDir>/agents/<name>.md with correct frontmatter + body", () => {
    const changes = claudeAdapter.installSubagents!(ctx);
    expect(changes[0]?.action).toBe("create");

    const agentPath = join(projectDir, ".claude", "agents", "reviewer.md");
    expect(changes[0]?.path).toBe(agentPath);
    expect(existsSync(agentPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(agentPath, "utf8"));
    expect(frontmatter.name).toBe("reviewer");
    expect(frontmatter.description).toBe("Reviews code diffs for correctness bugs.");
    expect(frontmatter.tools).toBe("Read, Grep");
    expect(frontmatter.model).toBe("opus");
    expect(body.trim()).toBe(
      "You are a meticulous code reviewer. Find correctness bugs.",
    );
  });

  it("installSubagents is idempotent — second call yields skip", () => {
    claudeAdapter.installSubagents!(ctx);
    const second = claudeAdapter.installSubagents!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSubagents removes the subagent file (re-read confirms gone)", () => {
    claudeAdapter.installSubagents!(ctx);
    const agentPath = join(projectDir, ".claude", "agents", "reviewer.md");
    expect(existsSync(agentPath)).toBe(true);

    const changes = claudeAdapter.uninstallSubagents!(ctx);
    expect(changes[0]?.action).toBe("remove");
    expect(existsSync(agentPath)).toBe(false);
  });

  // ── User scope path resolution ──────────────────────────────────────────

  it("user scope resolves surfaces under ~/.claude (HOME redirected to temp)", () => {
    const userCtx: InstallContext = { ...ctx, scope: "user" };
    claudeAdapter.installCommands!(userCtx);
    // freshProject points HOME at projectDir, so ~/.claude === projectDir/.claude
    expect(existsSync(join(projectDir, ".claude", "commands", "deploy.md"))).toBe(true);
  });

  // ── Health checks ──────────────────────────────────────────────────────

  it("getHealthChecks reports surface presence after install", () => {
    claudeAdapter.installCommands!(ctx);
    claudeAdapter.installSkills!(ctx);
    claudeAdapter.installSubagents!(ctx);

    const checks = claudeAdapter.getHealthChecks!(ctx);
    const byName = new Map(checks.map((c) => [c.name, c.check()]));
    expect(byName.get("Claude Code: command deploy present")?.status).toBe("OK");
    expect(byName.get("Claude Code: skill pdf-tools present")?.status).toBe("OK");
    expect(byName.get("Claude Code: subagent reviewer present")?.status).toBe("OK");
  });
});
