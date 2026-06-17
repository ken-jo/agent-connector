/**
 * tests/adapters/droid — the ONE per-host file for the Droid (Factory AI) adapter.
 *
 * Droid is a json-stdio host with TWO native config surfaces in DIFFERENT files:
 *   • MCP servers  → .factory/mcp.json (root key "mcpServers"; { type:"stdio",
 *                    command, args, env, disabled }).
 *   • Hooks        → a SEPARATE .factory/hooks.json (root key "hooks"; Claude
 *                    NESTED-rule shape). Full Claude-compatible lifecycle set.
 * Plus the content surfaces (getConfigDir → ~/.factory user / <projectDir>/.factory
 * project):
 *   • commands  → <configDir>/commands/<name>.md     (md+frontmatter: description, argument-hint)
 *   • skills    → <configDir>/skills/<name>/SKILL.md  (+ resources)
 *   • subagents → <configDir>/droids/<name>.md        (MARKDOWN — folder droids/, NOT agents/)
 *   • actions   → an OWNED executable file at <cfg>/commands/<id> (no .md ext):
 *                 shebang + `exec <verb> "$@"`, mode 0o755. win32 → skip-warn.
 *
 * This file consolidates what used to be split across droid.test.ts (content
 * surfaces) + wave1-render.test.ts (MCP render/round-trip + hooks) +
 * actions-emit.test.ts (action emitter) + extended-events-batch2.test.ts (E1
 * extension events + lifecycle events). It uses the shared harness
 * (tests/support/env + adapter-suite + fs) per tests/README.md — ONE file per host.
 */

import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import { buildHomeBinActionCommand } from "../../src/core/spawn.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  ActionDef,
  ConnectorConfig,
  ResolvedConnector,
  SubagentStopEvent,
} from "../../src/core/types.js";

import droidAdapter from "../../src/adapters/droid/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson, splitFrontmatter } from "../support/fs.js";

// ── shared fixtures ──────────────────────────────────────────────────────────

// Distinct connector ids per slice (kept verbatim from the source files):
//   content surfaces → acme-droid; actions → acme; render/events → acme-db.
const CONTENT_CONNECTOR_ID = "acme-droid";
const ACTIONS_CONNECTOR_ID = "acme";
const DB_CONNECTOR_ID = "acme-db";

// The render/round-trip + extension-event slices declare a stdio server with an
// env-ref so literal-resolution produces a known value.
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const AGENT_MATCHER = "code-reviewer|explore";

// The serve-wrapper args also bake the install TARGET platform as `--host <id>`
// (before `--`) so the proxy stamps hostPlatform under a headless spawn.
const wrappedArgs = (host: string): string[] => [
  "serve",
  "--connector",
  DB_CONNECTOR_ID,
  "--scope",
  "project",
  "--host",
  host,
  "--",
  "npx",
  "-y",
  "@x/y",
];

// ── content-surface fixtures (commands / skills / subagents) ──────────────────

const COMMAND = {
  name: "deploy",
  description: "Deploy the app to an environment.",
  prompt: "Deploy to $ARGUMENTS and report the result.",
  argumentHint: "[environment]",
  // tools/model are declared but droid commands carry ONLY description +
  // argument-hint, so they must NOT appear in the rendered frontmatter.
  tools: { allow: ["Bash", "Read"] },
  model: "sonnet",
} as const;

const SKILL = {
  name: "pdf-tools",
  description: "Extract and summarize text from PDF files.",
  body: "# PDF Tools\n\nUse the bundled script to extract text.",
  // model/tools are declared but droid skills carry ONLY name + description
  // (+ disable-model-invocation), so model/allowed-tools must NOT be emitted.
  model: "haiku",
  tools: { allow: ["Bash"] },
  disableModelInvocation: false,
  resources: { "scripts/extract.sh": "#!/bin/sh\necho extracting\n" },
} as const;

const SUBAGENT = {
  name: "reviewer",
  description: "Reviews code diffs for correctness bugs.",
  prompt: "You are a meticulous code reviewer. Find correctness bugs.",
  model: "opus",
  // tools declared but droid subagent frontmatter is name/description/model only.
  tools: { allow: ["Read", "Grep"] },
} as const;

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

function buildContentConnector(surfaces: {
  commands?: boolean;
  skills?: boolean;
  subagents?: boolean;
}): ResolvedConnector {
  const cfg: ConnectorConfig = {
    id: CONTENT_CONNECTOR_ID,
    displayName: "Acme Droid",
    version: "1.0.0",
  };
  if (surfaces.commands) cfg.commands = [command()];
  if (surfaces.skills) cfg.skills = [skill()];
  if (surfaces.subagents) cfg.subagents = [subagent()];
  return defineConnector(cfg);
}

// ── render / hook fixtures (stdio server env-ref + hooks) ─────────────────────

/** A connector with a stdio server (env-ref) + a PreToolUse hook. */
function buildRenderConnector(): ResolvedConnector {
  return defineConnector({
    id: DB_CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@x/y"],
      env: { [ENV_VAR]: `\${env:${ENV_VAR}}` },
      tools: { include: ["*"] },
    },
    hooks: {
      PreToolUse: {
        matcher: "acme_query|acme_write",
        handler() {
          return { decision: "allow" };
        },
      },
    },
  });
}

/** A connector declaring exactly the four E1 extension events. */
function buildExtConnector(): ResolvedConnector {
  return defineConnector({
    id: DB_CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    hooks: {
      PermissionRequest: {
        matcher: "acme_query",
        handler() {
          return { decision: "ask" };
        },
      },
      PostToolUseFailure: {
        matcher: "acme_query",
        handler() {
          return { decision: "context", additionalContext: "retry hint" };
        },
      },
      SubagentStart: {
        matcher: AGENT_MATCHER,
        handler() {
          return { decision: "context", additionalContext: "subagent ctx" };
        },
      },
      SubagentStop: {
        matcher: AGENT_MATCHER,
        handler() {
          return { decision: "deny", reason: "keep going" };
        },
      },
    },
  });
}

/** A connector declaring exactly the four droid lifecycle events. */
function buildLifecycleConnector(): ResolvedConnector {
  return defineConnector({
    id: DB_CONNECTOR_ID,
    displayName: "Acme Lifecycle",
    version: "1.2.3",
    hooks: {
      Notification: {
        handler() {
          return {};
        },
      },
      PreCompact: {
        handler() {
          return {};
        },
      },
      SessionStart: {
        handler() {
          return { decision: "context", additionalContext: "session ctx" };
        },
      },
      SessionEnd: {
        handler() {
          return {};
        },
      },
    },
  });
}

// ── actions fixtures ──────────────────────────────────────────────────────────

// The REAL host OS, captured before any per-test process.platform stub. Used to
// gate POSIX-only filesystem assertions (Windows cannot represent the Unix exec
// bit, so `chmod 0o755` is a no-op there).
const REAL_PLATFORM = process.platform;

function actionsConnector(
  actions: ActionDef[],
  platforms: ResolvedConnector["platforms"] = {},
): ResolvedConnector {
  return defineConnector({ id: ACTIONS_CONNECTOR_ID, actions, platforms });
}

const DEPLOY: ActionDef = {
  id: "deploy",
  description: "Deploy the app.",
  run: () => ({ message: "deployed" }),
};
const ROLLBACK: ActionDef = { id: "rollback", run: () => undefined };

function verb(host: string, id: string): string {
  return buildHomeBinActionCommand(HOME_BIN, host, id, ACTIONS_CONNECTOR_ID);
}

// ── local helpers ────────────────────────────────────────────────────────────

function parseStdout(reply: { exitCode: number; stdout?: string }): any {
  expect(reply.stdout).toBeTruthy();
  return JSON.parse(reply.stdout!);
}

// Shared env isolation + the same-rules-for-every-host baseline contract.
// extraKeys: the render/round-trip slice mutates the ACME_DB_DSN env-ref var.
isolateEnv([ENV_VAR]);
createAdapterSuite({ adapter: droidAdapter, paradigm: "json-stdio" });

// ── Capabilities ──────────────────────────────────────────────────────────────

describe("droid adapter — capabilities", () => {
  it("declares all three content surfaces as supported", () => {
    expect(droidAdapter.capabilities.supportsCommands).toBe(true);
    expect(droidAdapter.capabilities.supportsSkills).toBe(true);
    expect(droidAdapter.capabilities.supportsSubagents).toBe(true);
  });
});

// ── Commands ──────────────────────────────────────────────────────────────────

describe("droid adapter — commands", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-droid-");
    ctx = buildCtx(projectDir, buildContentConnector({ commands: true }));
  });

  it("installCommands writes .factory/commands/<name>.md (project scope)", () => {
    const changes = droidAdapter.installCommands!(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.platform).toBe("droid");

    const cmdPath = join(projectDir, ".factory", "commands", "deploy.md");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(cmdPath, "utf8"));
    expect(frontmatter.description).toBe("Deploy the app to an environment.");
    expect(frontmatter["argument-hint"]).toBe("[environment]");
    // Droid commands carry ONLY description + argument-hint.
    expect(frontmatter["allowed-tools"]).toBeUndefined();
    expect(frontmatter.model).toBeUndefined();
    expect(body.trim()).toBe(COMMAND.prompt);
  });

  it("installCommands writes ~/.factory/commands/<name>.md (user scope)", () => {
    const userCtx = buildCtx(projectDir, buildContentConnector({ commands: true }), "user");
    const changes = droidAdapter.installCommands!(userCtx);
    expect(changes[0]?.action).toBe("create");

    // HOME is redirected to projectDir, so ~/.factory → projectDir/.factory
    const cmdPath = join(projectDir, ".factory", "commands", "deploy.md");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);
  });

  it("is idempotent — second install yields skip", () => {
    droidAdapter.installCommands!(ctx);
    const second = droidAdapter.installCommands!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallCommands removes the command file", () => {
    droidAdapter.installCommands!(ctx);
    droidAdapter.uninstallCommands!(ctx);
    expect(existsSync(join(projectDir, ".factory", "commands", "deploy.md"))).toBe(false);
  });

  it("honors platforms['droid'].commands === false", () => {
    const disabled = defineConnector({
      id: CONTENT_CONNECTOR_ID,
      commands: [{ name: "deploy", prompt: "do it" }],
      platforms: { droid: { commands: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    expect(droidAdapter.installCommands!(c2)[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".factory", "commands", "deploy.md"))).toBe(false);
  });
});

// ── Skills ────────────────────────────────────────────────────────────────────

describe("droid adapter — skills", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-droid-");
    ctx = buildCtx(projectDir, buildContentConnector({ skills: true }));
  });

  it("installSkills writes .factory/skills/<name>/SKILL.md (project scope)", () => {
    const changes = droidAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.platform).toBe("droid");

    const skillMd = join(projectDir, ".factory", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
    expect(frontmatter["disable-model-invocation"]).toBe(false);
    // Droid skills carry NO model / allowed-tools field.
    expect(frontmatter.model).toBeUndefined();
    expect(frontmatter["allowed-tools"]).toBeUndefined();
    expect(body).toContain("# PDF Tools");
  });

  it("installSkills also writes resource files beside SKILL.md", () => {
    droidAdapter.installSkills!(ctx);
    const resource = join(projectDir, ".factory", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills (user scope) writes ~/.factory/skills/<name>/SKILL.md", () => {
    const userCtx = buildCtx(projectDir, buildContentConnector({ skills: true }), "user");
    const changes = droidAdapter.installSkills!(userCtx);
    expect(changes[0]?.action).toBe("create");

    const skillMd = join(projectDir, ".factory", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);
  });

  it("is idempotent — second install yields skip", () => {
    droidAdapter.installSkills!(ctx);
    const second = droidAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource, and empty skill dir", () => {
    droidAdapter.installSkills!(ctx);
    droidAdapter.uninstallSkills!(ctx);
    const skillDir = join(projectDir, ".factory", "skills", "pdf-tools");
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(false);
    expect(existsSync(skillDir)).toBe(false);
  });

  it("honors platforms['droid'].skills === false", () => {
    const disabled = defineConnector({
      id: CONTENT_CONNECTOR_ID,
      skills: [{ name: "pdf-tools", description: SKILL.description, body: "x" }],
      platforms: { droid: { skills: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    expect(droidAdapter.installSkills!(c2)[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".factory", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });
});

// ── Subagents (droids/ folder, MARKDOWN) ────────────────────────────────────────

describe("droid adapter — subagents", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-droid-");
    ctx = buildCtx(projectDir, buildContentConnector({ subagents: true }));
  });

  it("installSubagents writes .factory/droids/<name>.md MARKDOWN (project scope)", () => {
    const changes = droidAdapter.installSubagents!(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.platform).toBe("droid");

    // Folder is droids/, NOT agents/.
    const agentPath = join(projectDir, ".factory", "droids", "reviewer.md");
    expect(changes[0]?.path).toBe(agentPath);
    expect(existsSync(agentPath)).toBe(true);
    expect(existsSync(join(projectDir, ".factory", "agents", "reviewer.md"))).toBe(false);

    const { frontmatter, body } = splitFrontmatter(readFileSync(agentPath, "utf8"));
    expect(frontmatter.name).toBe("reviewer");
    expect(frontmatter.description).toBe(SUBAGENT.description);
    expect(frontmatter.model).toBe("opus");
    expect(body.trim()).toBe(SUBAGENT.prompt);
  });

  it("installSubagents (user scope) writes ~/.factory/droids/<name>.md", () => {
    const userCtx = buildCtx(projectDir, buildContentConnector({ subagents: true }), "user");
    const changes = droidAdapter.installSubagents!(userCtx);
    expect(changes[0]?.action).toBe("create");

    const agentPath = join(projectDir, ".factory", "droids", "reviewer.md");
    expect(changes[0]?.path).toBe(agentPath);
    expect(existsSync(agentPath)).toBe(true);
  });

  it("is idempotent — second install yields skip", () => {
    droidAdapter.installSubagents!(ctx);
    const second = droidAdapter.installSubagents!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSubagents removes the droid file", () => {
    droidAdapter.installSubagents!(ctx);
    droidAdapter.uninstallSubagents!(ctx);
    expect(existsSync(join(projectDir, ".factory", "droids", "reviewer.md"))).toBe(false);
  });

  it("honors platforms['droid'].subagents === false", () => {
    const disabled = defineConnector({
      id: CONTENT_CONNECTOR_ID,
      subagents: [{ name: "reviewer", description: SUBAGENT.description, prompt: "x" }],
      platforms: { droid: { subagents: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    expect(droidAdapter.installSubagents!(c2)[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".factory", "droids", "reviewer.md"))).toBe(false);
  });
});

// ── Full round-trip (all three content surfaces) ──────────────────────────────

describe("droid adapter — full round-trip (project scope)", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-droid-");
    ctx = buildCtx(
      projectDir,
      buildContentConnector({ commands: true, skills: true, subagents: true }),
    );
  });

  it("install then uninstall leaves no content files behind", () => {
    droidAdapter.installCommands!(ctx);
    droidAdapter.installSkills!(ctx);
    droidAdapter.installSubagents!(ctx);

    droidAdapter.uninstallCommands!(ctx);
    droidAdapter.uninstallSkills!(ctx);
    droidAdapter.uninstallSubagents!(ctx);

    expect(existsSync(join(projectDir, ".factory", "commands", "deploy.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".factory", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".factory", "skills", "pdf-tools"))).toBe(false);
    expect(existsSync(join(projectDir, ".factory", "droids", "reviewer.md"))).toBe(false);
  });
});

// ── MCP render + hook round-trip (mcp.json server + SEPARATE hooks.json) ───────
// (root key "mcpServers"; { type:"stdio", ..., disabled })

describe("droid adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave1-droid-");
    // The env-ref var is set so literal-resolution produces a known value.
    process.env[ENV_VAR] = ENV_LITERAL;
    ctx = buildCtx(projectDir, buildRenderConnector());
  });

  it("installServer writes mcpServers.<id> into .factory/mcp.json, wrapped, env LITERAL", () => {
    const changes = droidAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".factory", "mcp.json");
    expect(serverPath).toBe(droidAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[DB_CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.type).toBe("stdio");
    expect(entry.disabled).toBe(false);

    // Telemetry serve-wrapper: command points at the home binary.
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedArgs("droid"));

    // No native interpolation token → env-ref resolves to a LITERAL value.
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installHooks writes a SEPARATE .factory/hooks.json (nested-rule) with the PreToolUse entry", () => {
    const changes = droidAdapter.installHooks(ctx);
    expect(changes[0]?.action).toBe("create");

    const hooksPath = droidAdapter.getHookConfigPath(ctx);
    // Hook file is SEPARATE from the MCP config file (hooks.json, not mcp.json).
    expect(hooksPath).not.toBe(droidAdapter.getServerConfigPath(ctx));
    expect(hooksPath).toBe(join(projectDir, ".factory", "hooks.json"));
    expect(existsSync(hooksPath)).toBe(true);

    const file = readJson(hooksPath);
    const entry = file.hooks?.PreToolUse?.[0];
    expect(entry).toBeTruthy();
    expect(entry.matcher).toBe("acme_query|acme_write");
    expect(entry.hooks[0].type).toBe("command");
    expect(entry.hooks[0].command).toContain(HOME_BIN);
    expect(entry.hooks[0].command).toContain("hook droid PreToolUse");
    expect(entry.hooks[0].command).toContain(`--connector ${DB_CONNECTOR_ID}`);
  });

  it("uninstallHooks removes our droid hook entry (re-read confirms gone)", () => {
    droidAdapter.installHooks(ctx);
    droidAdapter.uninstallHooks(ctx);
    const file = readJson(droidAdapter.getHookConfigPath(ctx));
    expect(file.hooks?.PreToolUse).toBeUndefined();
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    droidAdapter.installServer(ctx);
    const second = droidAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".factory", "mcp.json"));
    expect(Object.keys(cfg.mcpServers)).toEqual([DB_CONNECTOR_ID]);
  });

  it("uninstallServer removes the entry (re-read confirms gone)", () => {
    droidAdapter.installServer(ctx);
    droidAdapter.uninstallServer(ctx);
    const cfg = readJson(join(projectDir, ".factory", "mcp.json"));
    expect(cfg.mcpServers?.[DB_CONNECTOR_ID]).toBeUndefined();
  });
});

// ── Actions emitter (OWNED executable command file, no .md ext) ────────────────
// shebang + exec, 0o755; win32 → skip-warn (unverified).

describe("droid — actions emitter", () => {
  let projectDir: string;
  const filePath = (id: string) => join(projectDir, ".factory", "commands", id);

  // Pin a POSIX platform so the exec-file (shebang) path runs deterministically
  // on ANY CI host (incl. the native Windows runner) — the win32 skip-warn is
  // exercised by its own test below that stubs "win32" explicitly.
  let platformSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    projectDir = freshProject("ac-actemit-");
    platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  });
  afterEach(() => platformSpy.mockRestore());

  it("advertises supportsActions", () => {
    expect(droidAdapter.capabilities.supportsActions).toBe(true);
  });

  it("installActions writes an executable shebang exec-file with the verb (mode 0o755)", () => {
    const ctx = buildCtx(projectDir, actionsConnector([DEPLOY]), "project");
    const changes = droidAdapter.installActions!(ctx);
    expect(changes.every((c) => c.platform === "droid")).toBe(true);
    expect(changes[0]!.action).toBe("create");

    const body = readFileSync(filePath("deploy"), "utf8");
    expect(body).toBe(`#!/usr/bin/env sh\nexec ${verb("droid", "deploy")} "$@"\n`);
    // Executable bit set (POSIX only — a real Windows host cannot represent the
    // exec bit, and production skip-warns droid actions on win32 anyway).
    if (REAL_PLATFORM !== "win32") {
      expect(statSync(filePath("deploy")).mode & 0o777).toBe(0o755);
    }
    // NO .md extension is written (it would collide with the command surface).
    expect(existsSync(`${filePath("deploy")}.md`)).toBe(false);
  });

  it("is idempotent (second install → skip, bytes unchanged)", () => {
    const ctx = buildCtx(projectDir, actionsConnector([DEPLOY]), "project");
    droidAdapter.installActions!(ctx);
    const before = readFileSync(filePath("deploy"), "utf8");
    const changes = droidAdapter.installActions!(ctx);
    expect(changes[0]!.action).toBe("skip");
    expect(readFileSync(filePath("deploy"), "utf8")).toBe(before);
  });

  it("uninstallActions removes the owned file", () => {
    const ctx = buildCtx(projectDir, actionsConnector([DEPLOY]), "project");
    droidAdapter.installActions!(ctx);
    expect(existsSync(filePath("deploy"))).toBe(true);
    const changes = droidAdapter.uninstallActions!(ctx);
    expect(changes[0]!.action).toBe("remove");
    expect(existsSync(filePath("deploy"))).toBe(false);
  });

  it("skip-warns and writes NOTHING on win32 (exec-file interp unverified)", () => {
    const spy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const ctx = buildCtx(projectDir, actionsConnector([DEPLOY, ROLLBACK]), "project");
      const changes = droidAdapter.installActions!(ctx);
      expect(changes).toHaveLength(1);
      expect(changes[0]!.action).toBe("warn");
      expect(changes[0]!.detail).toContain("unverified on Windows");
      expect(changes[0]!.detail).toContain("2 skipped");
      expect(existsSync(filePath("deploy"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("honors platforms.droid.actions === false (opt-out)", () => {
    const ctx = buildCtx(projectDir, actionsConnector([DEPLOY], { droid: { actions: false } }), "project");
    const changes = droidAdapter.installActions!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toContain("disabled for droid");
    expect(existsSync(filePath("deploy"))).toBe(false);
  });

  it("skips silently when no actions are declared", () => {
    const ctx = buildCtx(projectDir, defineConnector({ id: ACTIONS_CONNECTOR_ID, commands: [{ name: "n", prompt: "p" }] }), "project");
    const changes = droidAdapter.installActions!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toContain("declares no actions");
  });
});

// ── Extended events (E1) — stop-only subagent host ─────────────────────────────

describe("droid — extended-event install", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-ext-events2-");
    ctx = buildCtx(projectDir, buildExtConnector());
  });

  it("registers hooks.SubagentStop (PascalCase, nested rule + agent matcher); the other three warn-skip", () => {
    const changes = droidAdapter.installHooks(ctx);

    const hooksPath = join(projectDir, ".factory", "hooks.json");
    expect(existsSync(hooksPath)).toBe(true);
    const cfg = readJson(hooksPath);

    const bucket = cfg.hooks.SubagentStop;
    expect(Array.isArray(bucket)).toBe(true);
    expect(bucket[0].matcher).toBe(AGENT_MATCHER);
    expect(bucket[0].hooks[0].command).toContain("hook droid SubagentStop");

    for (const event of ["PermissionRequest", "PostToolUseFailure", "SubagentStart"]) {
      const warn = changes.find((c) => c.action === "warn" && c.detail?.includes(event));
      expect(warn).toBeTruthy();
      expect(warn!.detail).toContain("no Droid hook equivalent");
      expect(cfg.hooks[event]).toBeUndefined();
    }
  });
});

describe("droid — extended-event parse + replies", () => {
  const COMMON = { session_id: "sess-1", cwd: "/home/dev/acme" };

  it("SubagentStop maps the Claude-compatible fields and tolerates missing agent_type", () => {
    const evt = droidAdapter.parseEvent!("SubagentStop", {
      ...COMMON,
      agent_id: "agent-7",
      agent_transcript_path: "/x/subagents/agent-7.jsonl",
      last_assistant_message: "review complete",
      stop_hook_active: true,
    }) as SubagentStopEvent;
    expect(evt.hostPlatform).toBe("droid");
    expect(evt.agentId).toBe("agent-7");
    expect(evt.agentType).toBeUndefined();
    expect(evt.agentTranscriptPath).toBe("/x/subagents/agent-7.jsonl");
    expect(evt.lastAssistantMessage).toBe("review complete");
    expect(evt.stopHookActive).toBe(true);
    expect(evt.projectDir).toBe("/home/dev/acme");
  });

  it("PermissionRequest / PostToolUseFailure / SubagentStart throw (no Droid analog)", () => {
    for (const event of ["PermissionRequest", "PostToolUseFailure", "SubagentStart"] as const) {
      expect(() => droidAdapter.parseEvent!(event, COMMON)).toThrow(
        /unsupported droid hook event/,
      );
    }
  });

  it("SubagentStop deny → TOP-LEVEL {decision:'block', reason}; Stop deny is unchanged (regression guard)", () => {
    const subagentReply = parseStdout(
      droidAdapter.formatReply!("SubagentStop", { decision: "deny", reason: "keep going" }),
    );
    expect(subagentReply).toEqual({ decision: "block", reason: "keep going" });
    expect(subagentReply.hookSpecificOutput).toBeUndefined();

    const stop = parseStdout(
      droidAdapter.formatReply!("Stop", { decision: "deny", reason: "halt" }),
    );
    expect(stop.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("SubagentStop context → hookSpecificOutput.additionalContext (generic context path)", () => {
    const reply = parseStdout(
      droidAdapter.formatReply!("SubagentStop", {
        decision: "context",
        additionalContext: "wrap up",
      }),
    );
    expect(reply.hookSpecificOutput).toEqual({
      hookEventName: "SubagentStop",
      additionalContext: "wrap up",
    });
  });
});

// ── Lifecycle events Notification/PreCompact/SessionStart/SessionEnd ────────────
// (docs.factory.ai/reference/hooks-reference — Claude-shaped 1:1)

describe("droid — lifecycle-event install", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-ext-events2-");
    ctx = buildCtx(projectDir, buildLifecycleConnector());
  });

  it("writes hooks.{Notification,PreCompact,SessionStart,SessionEnd} natively (no longer skip-warns)", () => {
    const changes = droidAdapter.installHooks(ctx);

    const hooksPath = join(projectDir, ".factory", "hooks.json");
    expect(existsSync(hooksPath)).toBe(true);
    const cfg = readJson(hooksPath);

    for (const event of ["Notification", "PreCompact", "SessionStart", "SessionEnd"]) {
      const bucket = cfg.hooks[event];
      expect(Array.isArray(bucket), `${event} bucket`).toBe(true);
      expect(bucket[0].hooks[0].command).toContain(`hook droid ${event}`);
      // The event must NOT surface a warn-skip anymore.
      const warn = changes.find((c) => c.action === "warn" && c.detail?.includes(event));
      expect(warn, `${event} should not warn-skip`).toBeUndefined();
    }
  });
});

describe("droid — lifecycle-event parse + replies", () => {
  const COMMON = { session_id: "sess-1", cwd: "/home/dev/acme" };

  it("Notification maps `message`", () => {
    const evt = droidAdapter.parseEvent!("Notification", {
      ...COMMON,
      hook_event_name: "Notification",
      message: "Task completed successfully",
    }) as any;
    expect(evt.hostPlatform).toBe("droid");
    expect(evt.message).toBe("Task completed successfully");
    expect(evt.projectDir).toBe("/home/dev/acme");
    // missing message → empty string
    expect((droidAdapter.parseEvent!("Notification", COMMON) as any).message).toBe("");
  });

  it("PreCompact maps the `trigger` enum (manual|auto); unknown trigger is omitted", () => {
    const manual = droidAdapter.parseEvent!("PreCompact", {
      ...COMMON,
      trigger: "manual",
      custom_instructions: "",
    }) as any;
    expect(manual.trigger).toBe("manual");
    const auto = droidAdapter.parseEvent!("PreCompact", { ...COMMON, trigger: "auto" }) as any;
    expect(auto.trigger).toBe("auto");
    const none = droidAdapter.parseEvent!("PreCompact", COMMON) as any;
    expect("trigger" in none).toBe(false);
  });

  it("SessionStart coerces `source` onto the normalized enum (default startup)", () => {
    expect((droidAdapter.parseEvent!("SessionStart", { ...COMMON, source: "resume" }) as any).source).toBe("resume");
    expect((droidAdapter.parseEvent!("SessionStart", { ...COMMON, source: "clear" }) as any).source).toBe("clear");
    expect((droidAdapter.parseEvent!("SessionStart", { ...COMMON, source: "compact" }) as any).source).toBe("compact");
    expect((droidAdapter.parseEvent!("SessionStart", { ...COMMON, source: "startup" }) as any).source).toBe("startup");
    // unknown/missing source → startup
    expect((droidAdapter.parseEvent!("SessionStart", COMMON) as any).source).toBe("startup");
  });

  it("SessionEnd maps `reason` when present", () => {
    expect((droidAdapter.parseEvent!("SessionEnd", { ...COMMON, reason: "other" }) as any).reason).toBe("other");
    expect("reason" in (droidAdapter.parseEvent!("SessionEnd", COMMON) as any)).toBe(false);
  });

  it("SessionStart context → hookSpecificOutput.additionalContext (injection honored)", () => {
    const reply = parseStdout(
      droidAdapter.formatReply!("SessionStart", {
        decision: "context",
        additionalContext: "load issues",
      }),
    );
    expect(reply.hookSpecificOutput).toEqual({
      hookEventName: "SessionStart",
      additionalContext: "load issues",
    });
  });

  it("Notification / PreCompact / SessionEnd are observe-only: any decision → passthrough exit 0", () => {
    for (const event of ["Notification", "PreCompact", "SessionEnd"] as const) {
      // a deny that other events would render as a block is a no-op here
      expect(droidAdapter.formatReply!(event, { decision: "deny", reason: "x" })).toEqual({
        exitCode: 0,
      });
      // a context decision can't inject on these events either
      expect(
        droidAdapter.formatReply!(event, { decision: "context", additionalContext: "y" }),
      ).toEqual({ exitCode: 0 });
      expect(droidAdapter.formatReply!(event, {})).toEqual({ exitCode: 0 });
    }
  });
});
