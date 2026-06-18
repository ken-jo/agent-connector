/**
 * tests/adapters/kilo-cli.test.ts — the ONE per-host file for the Kilo CLI.
 *
 * The Kilo CLI (the `kilo` binary) is a **live-confirmed OpenCode fork** that
 * loads @kilocode/plugin modules. Paradigm: **ts-plugin** (a generated
 * @kilocode/plugin bridge module that imports nothing from agent-connector and
 * shells out to the ONE stable home binary's universal entrypoint
 *     <homeBin> hook kilo-cli <event> --connector <id>
 * over child_process, fail-open). It is DISTINCT from the Kilo Code VS Code
 * extension (adapter id "kilo") — the two products carry different platformIds so
 * their config never merges. This file consolidates EVERY kilo-cli surface (the
 * per-host convention in tests/README.md — one file per host):
 *
 *   • content surfaces → md+fm commands (.kilo/command/<n>.md), uniform
 *     SKILL.md skills (.kilo/skills/<n>/SKILL.md + resources), md+fm subagents
 *     (.kilo/agent/<n>.md, mode:subagent); user scope under ~/.config/kilo;
 *     idempotency + uninstall + full round-trip; per-surface false opt-outs.
 *   • MCP server (render slice, former phase3) → <projectDir>/.kilo/kilo.jsonc,
 *     root key "mcp", a stdio entry { type:"local", command:[...] } whose command
 *     array starts with the home bin and carries the serve-wrapper tail (the
 *     OpenCode-fork command-array dialect). idempotency + uninstall.
 *   • hooks (ts-plugin, former phase3) → .kilo/plugin/<id>.js plugin module +
 *     kilo.jsonc plugin[] registration; idempotency + uninstall; THE BRIDGE WORKS
 *     (dynamic import of the generated module: deny → throw, modify → args
 *     rewrite, bridges to "kilo-cli").
 *   • new canonical events → UserPromptSubmit (chat.message), PermissionRequest
 *     (permission.ask), Stop (session.idle via the generic `event` hook);
 *     capabilities + wiring + parseEvent + live handler exercise.
 *   • E1 degrade (former extended-events-degrade) → PermissionRequest is wired
 *     (permission.ask); the other three E1 events (PostToolUseFailure /
 *     SubagentStart / SubagentStop) have no kilo analog → "unsupported here"
 *     detail and never leak into the bridge.
 *
 * Migrated to the shared harness (tests/support/env + adapter-suite): the
 * content-surface + new-event blocks were the base kilo-cli file; the MCP/hooks/
 * bridge render slice came from the former phase3 suite; the E1-degrade slice
 * came from the former extended-events-degrade batch suite.
 *
 * Dirs (live-confirmed kilo v7.3.16):
 *   commands  → .kilo/command/<name>.md          (project)
 *               ~/.config/kilo/command/<name>.md  (user)
 *   skills    → .kilo/skills/<name>/SKILL.md      (project)
 *               ~/.config/kilo/skills/<name>/SKILL.md (user)
 *   subagents → .kilo/agent/<name>.md             (project, frontmatter mode:subagent)
 *               ~/.config/kilo/agent/<name>.md    (user)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  ConnectorConfig,
  HookResponse,
  ResolvedConnector,
} from "../../src/core/types.js";

import kiloCliAdapter from "../../src/adapters/kilo-cli/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { readJson, splitFrontmatter } from "../support/fs.js";
import { createAdapterSuite } from "../support/adapter-suite.js";

// ─────────────────────────────────────────────────────────────────────────
// node:child_process mock — hoisted above every import by vitest. The kilo-cli
// generated-plugin bridge imports `execFileSync` (POSIX) / `execSync` (Windows)
// at top-level; the new-event + render BRIDGE slices dynamically import the
// freshly-written module and fire its handlers, so the mock must be in place
// before that module resolves node:child_process. Each test reprograms what the
// mock returns via execFileSyncImpl. (The content-surface / E1-degrade slices
// only inspect the written bytes / install detail and never spawn — but they
// share this file's one mock.)
// ─────────────────────────────────────────────────────────────────────────

let execFileSyncImpl: (...args: any[]) => string = () => "";
const execFileSyncMock = vi.fn((...args: any[]) => execFileSyncImpl(...args));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  execSync: execFileSyncMock,
}));

// Pin process.platform to a POSIX value for the whole file so the generated
// bridge takes its execFileSync(HOME_BIN, [args]) path (on Windows it would use
// execSync(one quoted string) — correct in production, proven separately, but it
// would not match these bridges' execFileSync(bin, argv) call-shape assertions).
const REAL_PLATFORM = process.platform;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  execFileSyncMock.mockClear();
  execFileSyncImpl = () => "";
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
});

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures — content surfaces + new events (base kilo-cli)
// ─────────────────────────────────────────────────────────────────────────

const CONNECTOR_ID = "acme-kilo";

const COMMAND = {
  name: "deploy",
  description: "Deploy the app to an environment.",
  prompt: "Deploy to $ARGUMENTS and report the result.",
  argumentHint: "[environment]",
  tools: { allow: ["Bash", "Read"] },
  model: "sonnet",
} as const;

const SKILL = {
  name: "pdf-tools",
  description: "Extract and summarize text from PDF files.",
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

function buildConnector(surfaces: {
  commands?: boolean;
  skills?: boolean;
  subagents?: boolean;
}): ResolvedConnector {
  const cfg: ConnectorConfig = {
    id: CONNECTOR_ID,
    displayName: "Acme Kilo CLI",
    version: "1.0.0",
  };
  if (surfaces.commands) cfg.commands = [command()];
  if (surfaces.skills) cfg.skills = [skill()];
  if (surfaces.subagents) cfg.subagents = [subagent()];
  return defineConnector(cfg);
}

// ── render slice fixtures (former phase3) ──────────────────────────────────
// The phase3 render/bridge slice declared a SECOND connector id (acme-db) with
// its own env-ref var and asserted the full serve-wrapper command array. Kept
// distinct from the base acme-kilo fixtures above.
const RENDER_CONNECTOR_ID = "acme-db";
const RENDER_ENV_VAR = "ACME_DB_DSN";
const RENDER_ENV_LITERAL = "postgres://acme/db";

/** A connector with a stdio server (env-ref) + a PreToolUse hook (render slice). */
function buildRenderConnector(): ResolvedConnector {
  return defineConnector({
    id: RENDER_CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@x/y"],
      env: { [RENDER_ENV_VAR]: `\${env:${RENDER_ENV_VAR}}` },
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

/** Fresh project dir + the render-slice env var. */
function freshRenderProject(prefix: string): string {
  const dir = freshProject(prefix);
  process.env[RENDER_ENV_VAR] = RENDER_ENV_LITERAL;
  return dir;
}

// The serve-wrapper tail also bakes the install TARGET platform as `--host <id>`
// (before `--`) so the proxy stamps hostPlatform under a headless spawn.
const wrappedTail = (host: string): string[] => [
  "serve",
  "--connector",
  RENDER_CONNECTOR_ID,
  "--scope",
  "project",
  "--host",
  host,
  "--",
  "npx",
  "-y",
  "@x/y",
];

// ── E1-degrade fixtures (former extended-events-degrade) ───────────────────
// A connector declaring PreToolUse + ALL FOUR E1 extension events. kilo-cli
// wires PreToolUse + PermissionRequest (permission.ask) and reports the other
// three as "unsupported here".
function buildE1Connector(): ResolvedConnector {
  return defineConnector({
    id: RENDER_CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    hooks: {
      PreToolUse: {
        matcher: "acme_query",
        handler() {
          return { decision: "allow" };
        },
      },
      PermissionRequest: {
        matcher: "acme_query",
        handler() {
          return { decision: "ask" };
        },
      },
      PostToolUseFailure: {
        handler() {
          return { decision: "context", additionalContext: "retry hint" };
        },
      },
      SubagentStart: {
        matcher: "code-reviewer",
        handler() {
          return { decision: "context", additionalContext: "subagent ctx" };
        },
      },
      SubagentStop: {
        matcher: "code-reviewer",
        handler() {
          return { decision: "deny", reason: "keep going" };
        },
      },
    },
  });
}

// Shared env isolation (default keys + the env-ref var the render slice mutates)
// + the same-rules-for-every-host baseline contract.
isolateEnv([RENDER_ENV_VAR]);
createAdapterSuite({ adapter: kiloCliAdapter, paradigm: "ts-plugin" });

// ── Capabilities ──────────────────────────────────────────────────────────────

describe("kilo-cli adapter — capabilities", () => {
  it("declares all three content surfaces as supported", () => {
    expect(kiloCliAdapter.capabilities.supportsCommands).toBe(true);
    expect(kiloCliAdapter.capabilities.supportsSkills).toBe(true);
    expect(kiloCliAdapter.capabilities.supportsSubagents).toBe(true);
  });
});

// ── Commands ──────────────────────────────────────────────────────────────────

describe("kilo-cli adapter — commands", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-kilo-cli-");
    ctx = buildCtx(projectDir, buildConnector({ commands: true }));
  });

  it("installCommands writes .kilo/command/<name>.md (project scope)", () => {
    const changes = kiloCliAdapter.installCommands!(ctx);
    expect(changes[0]?.action).toBe("create");

    const cmdPath = join(projectDir, ".kilo", "command", "deploy.md");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(cmdPath, "utf8"));
    expect(frontmatter.description).toBe("Deploy the app to an environment.");
    expect(frontmatter["argument-hint"]).toBe("[environment]");
    expect(frontmatter["allowed-tools"]).toBe("Bash, Read");
    expect(frontmatter.model).toBe("sonnet");
    expect(body.trim()).toBe(COMMAND.prompt);
  });

  it("installCommands writes ~/.config/kilo/command/<name>.md (user scope)", () => {
    const userCtx = buildCtx(projectDir, buildConnector({ commands: true }), "user");
    const changes = kiloCliAdapter.installCommands!(userCtx);
    expect(changes[0]?.action).toBe("create");

    // HOME is redirected to projectDir, so ~/.config/kilo → projectDir/.config/kilo
    const cmdPath = join(projectDir, ".config", "kilo", "command", "deploy.md");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);
  });

  it("is idempotent — second install yields skip", () => {
    kiloCliAdapter.installCommands!(ctx);
    const second = kiloCliAdapter.installCommands!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallCommands removes the command file", () => {
    kiloCliAdapter.installCommands!(ctx);
    kiloCliAdapter.uninstallCommands!(ctx);
    expect(existsSync(join(projectDir, ".kilo", "command", "deploy.md"))).toBe(false);
  });

  it("honors platforms['kilo-cli'].commands === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      commands: [{ name: "deploy", prompt: "do it" }],
      platforms: { "kilo-cli": { commands: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    expect(kiloCliAdapter.installCommands!(c2)[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".kilo", "command", "deploy.md"))).toBe(false);
  });
});

// ── Skills ────────────────────────────────────────────────────────────────────

describe("kilo-cli adapter — skills", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-kilo-cli-");
    ctx = buildCtx(projectDir, buildConnector({ skills: true }));
  });

  it("installSkills writes .kilo/skills/<name>/SKILL.md (project scope)", () => {
    const changes = kiloCliAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");

    const skillMd = join(projectDir, ".kilo", "skills", "pdf-tools", "SKILL.md");
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

  it("installSkills also writes resource files beside SKILL.md", () => {
    kiloCliAdapter.installSkills!(ctx);
    const resource = join(projectDir, ".kilo", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills (user scope) writes ~/.config/kilo/skills/<name>/SKILL.md", () => {
    const userCtx = buildCtx(projectDir, buildConnector({ skills: true }), "user");
    const changes = kiloCliAdapter.installSkills!(userCtx);
    expect(changes[0]?.action).toBe("create");

    const skillMd = join(projectDir, ".config", "kilo", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);
  });

  it("is idempotent — second install yields skip", () => {
    kiloCliAdapter.installSkills!(ctx);
    const second = kiloCliAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource, and empty skill dir", () => {
    kiloCliAdapter.installSkills!(ctx);
    kiloCliAdapter.uninstallSkills!(ctx);
    const skillDir = join(projectDir, ".kilo", "skills", "pdf-tools");
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(false);
    expect(existsSync(skillDir)).toBe(false);
  });

  it("honors platforms['kilo-cli'].skills === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      skills: [{ name: "pdf-tools", description: SKILL.description, body: "x" }],
      platforms: { "kilo-cli": { skills: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    expect(kiloCliAdapter.installSkills!(c2)[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".kilo", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });
});

// ── Subagents ─────────────────────────────────────────────────────────────────

describe("kilo-cli adapter — subagents", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-kilo-cli-");
    ctx = buildCtx(projectDir, buildConnector({ subagents: true }));
  });

  it("installSubagents writes .kilo/agent/<name>.md (project scope)", () => {
    const changes = kiloCliAdapter.installSubagents!(ctx);
    expect(changes[0]?.action).toBe("create");

    const agentPath = join(projectDir, ".kilo", "agent", "reviewer.md");
    expect(changes[0]?.path).toBe(agentPath);
    expect(existsSync(agentPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(agentPath, "utf8"));
    expect(frontmatter.description).toBe(SUBAGENT.description);
    expect(frontmatter.mode).toBe("subagent");
    expect(frontmatter.model).toBe("opus");
    // readonly:true → deny map
    expect(frontmatter.permission).toEqual({ edit: "deny", bash: "deny" });
    expect(body.trim()).toBe(SUBAGENT.prompt);
  });

  it("installSubagents (user scope) writes ~/.config/kilo/agent/<name>.md", () => {
    const userCtx = buildCtx(projectDir, buildConnector({ subagents: true }), "user");
    const changes = kiloCliAdapter.installSubagents!(userCtx);
    expect(changes[0]?.action).toBe("create");

    const agentPath = join(projectDir, ".config", "kilo", "agent", "reviewer.md");
    expect(changes[0]?.path).toBe(agentPath);
    expect(existsSync(agentPath)).toBe(true);
  });

  it("is idempotent — second install yields skip", () => {
    kiloCliAdapter.installSubagents!(ctx);
    const second = kiloCliAdapter.installSubagents!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSubagents removes the agent file", () => {
    kiloCliAdapter.installSubagents!(ctx);
    kiloCliAdapter.uninstallSubagents!(ctx);
    expect(existsSync(join(projectDir, ".kilo", "agent", "reviewer.md"))).toBe(false);
  });

  it("honors platforms['kilo-cli'].subagents === false", () => {
    const disabled = defineConnector({
      id: CONNECTOR_ID,
      subagents: [{ name: "reviewer", description: SUBAGENT.description, prompt: "x" }],
      platforms: { "kilo-cli": { subagents: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    expect(kiloCliAdapter.installSubagents!(c2)[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".kilo", "agent", "reviewer.md"))).toBe(false);
  });
});

// ── Full round-trip (all three surfaces) ──────────────────────────────────────

describe("kilo-cli adapter — full round-trip (project scope)", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-kilo-cli-");
    ctx = buildCtx(
      projectDir,
      buildConnector({ commands: true, skills: true, subagents: true }),
    );
  });

  it("install then uninstall leaves no content files behind", () => {
    kiloCliAdapter.installCommands!(ctx);
    kiloCliAdapter.installSkills!(ctx);
    kiloCliAdapter.installSubagents!(ctx);

    kiloCliAdapter.uninstallCommands!(ctx);
    kiloCliAdapter.uninstallSkills!(ctx);
    kiloCliAdapter.uninstallSubagents!(ctx);

    expect(existsSync(join(projectDir, ".kilo", "command", "deploy.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".kilo", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".kilo", "skills", "pdf-tools"))).toBe(false);
    expect(existsSync(join(projectDir, ".kilo", "agent", "reviewer.md"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// MCP server + hooks render slice (former phase3) — the SQLite-backed OpenCode
// FORK loading @kilocode/plugin modules.
// ─────────────────────────────────────────────────────────────────────────

describe("kilo-cli adapter (ts-plugin) render", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshRenderProject("ac-p3-kilo-cli-");
    ctx = buildCtx(projectDir, buildRenderConnector());
  });

  it("has the CLI identity (id kilo-cli / name Kilo CLI / ts-plugin)", () => {
    expect(kiloCliAdapter.id).toBe("kilo-cli");
    expect(kiloCliAdapter.name).toBe("Kilo CLI");
    expect(kiloCliAdapter.paradigm).toBe("ts-plugin");
  });

  it("installServer writes the entry under top-level 'mcp' with type 'local' and a command ARRAY starting at the home bin", () => {
    const changes = kiloCliAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".kilo", "kilo.jsonc");
    expect(serverPath).toBe(kiloCliAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    // New-gen root key is "mcp", NOT the extension's "mcpServers".
    expect(cfg).toHaveProperty("mcp");
    expect(cfg).not.toHaveProperty("mcpServers");

    const entry = cfg.mcp[RENDER_CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.type).toBe("local");

    // The CLI keys the whole invocation as a single ARRAY (exe + args together).
    expect(Array.isArray(entry.command)).toBe(true);
    expect(entry.command[0]).toBe(HOME_BIN);
    // The telemetry serve-wrapper tail is flattened into the same array.
    expect(entry.command).toEqual([HOME_BIN, ...wrappedTail("kilo-cli")]);
    expect(entry.command).toContain("serve");
    expect(entry.command).toContain("--connector");
    expect(entry.command).toContain(RENDER_CONNECTOR_ID);

    // No native interpolation token → env resolves to a LITERAL value.
    expect(entry.environment[RENDER_ENV_VAR]).toBe(RENDER_ENV_LITERAL);
    expect(entry.environment[RENDER_ENV_VAR]).not.toContain("${");
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    kiloCliAdapter.installServer(ctx);
    const second = kiloCliAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".kilo", "kilo.jsonc"));
    expect(Object.keys(cfg.mcp)).toEqual([RENDER_CONNECTOR_ID]);
  });

  it("uninstallServer removes the entry (re-read confirms gone)", () => {
    kiloCliAdapter.installServer(ctx);
    kiloCliAdapter.uninstallServer(ctx);

    const cfg = readJson(join(projectDir, ".kilo", "kilo.jsonc"));
    expect(cfg.mcp?.[RENDER_CONNECTOR_ID]).toBeUndefined();
  });

  it("installHooks writes the plugin .js module into .kilo/plugin/ AND registers its path in kilo.jsonc's 'plugin' array", () => {
    const changes = kiloCliAdapter.installHooks(ctx);

    // The hook config path is the generated module FILE (ts-plugin), under the
    // dedicated plugin dir — NOT the server config path.
    const pluginPath = kiloCliAdapter.getHookConfigPath(ctx);
    expect(pluginPath).toBe(join(projectDir, ".kilo", "plugin", `${RENDER_CONNECTOR_ID}.js`));
    expect(pluginPath).not.toBe(kiloCliAdapter.getServerConfigPath(ctx));
    expect(existsSync(pluginPath)).toBe(true);

    // The module is self-contained: it imports NOTHING from agent-connector (the
    // only allowed import is node:child_process). The string "agent-connector"
    // may appear in the AUTO-GENERATED header comment — what must be absent is an
    // actual import/require of the package. It shells out to the home bin's
    // universal `hook kilo-cli` entrypoint.
    const src = readFileSync(pluginPath, "utf8");
    expect(src).not.toMatch(/from\s+["'][^"']*agent-connector/);
    expect(src).not.toMatch(/require\(\s*["'][^"']*agent-connector/);
    expect(src).toContain('import { execFileSync, execSync } from "node:child_process"');
    expect(src).toContain('"hook", "kilo-cli"');
    expect(src).toContain(HOME_BIN);
    // @kilocode/plugin PluginModule shape: default export with a server factory.
    expect(src).toContain("server: async (input)");
    expect(src).toContain('"tool.execute.before"');

    // The module path is registered in kilo.jsonc's top-level "plugin" array.
    const cfg = readJson(kiloCliAdapter.getServerConfigPath(ctx));
    expect(Array.isArray(cfg.plugin)).toBe(true);
    expect(cfg.plugin).toContain(pluginPath);

    // A create for the module + a create for the array registration.
    expect(changes.some((c) => c.action === "create")).toBe(true);
  });

  it("installHooks is idempotent — second call does not duplicate the plugin-array entry", () => {
    kiloCliAdapter.installHooks(ctx);
    kiloCliAdapter.installHooks(ctx);
    const cfg = readJson(kiloCliAdapter.getServerConfigPath(ctx));
    const pluginPath = kiloCliAdapter.getHookConfigPath(ctx);
    expect(cfg.plugin.filter((p: string) => p === pluginPath)).toHaveLength(1);
  });

  it("uninstallHooks removes the module AND deregisters it from the 'plugin' array", () => {
    kiloCliAdapter.installHooks(ctx);
    const pluginPath = kiloCliAdapter.getHookConfigPath(ctx);
    expect(existsSync(pluginPath)).toBe(true);

    kiloCliAdapter.uninstallHooks(ctx);
    expect(existsSync(pluginPath)).toBe(false);

    const cfg = readJson(kiloCliAdapter.getServerConfigPath(ctx));
    expect(Array.isArray(cfg.plugin) ? cfg.plugin : []).not.toContain(pluginPath);
  });

  it("THE BRIDGE WORKS — the synthesized @kilocode/plugin server() blocks on a deny and rewrites args on a modify", async () => {
    kiloCliAdapter.installHooks(ctx);
    const pluginPath = kiloCliAdapter.getHookConfigPath(ctx);

    // Import the freshly-written module (cache-busted) with child_process mocked.
    const mod = await import(`${pathToFileURL(pluginPath).href}?t=${Date.now()}`);
    const plugin = mod.default;
    expect(typeof plugin.server).toBe("function");

    const hooks = await plugin.server({ directory: projectDir });
    const before = hooks["tool.execute.before"];
    expect(typeof before).toBe("function");

    // deny → the handler throws (blocks the tool call).
    execFileSyncImpl = () => JSON.stringify({ decision: "deny", reason: "nope" } satisfies HookResponse);
    await expect(
      before({ tool: "acme_write", sessionID: "s1" }, { args: { a: 1 } }),
    ).rejects.toThrow("nope");

    // modify → updatedInput is merged into output.args in place.
    execFileSyncImpl = () =>
      JSON.stringify({ decision: "modify", updatedInput: { a: 2, b: 3 } } satisfies HookResponse);
    const output = { args: { a: 1 } as Record<string, unknown> };
    await before({ tool: "acme_write", sessionID: "s1" }, output);
    expect(output.args).toEqual({ a: 2, b: 3 });

    // The bridge shelled out to the kilo-cli universal entrypoint.
    expect(execFileSyncMock).toHaveBeenCalled();
    const call = execFileSyncMock.mock.calls.at(-1);
    expect(call?.[0]).toBe(HOME_BIN);
    expect(call?.[1]).toEqual(["hook", "kilo-cli", "PreToolUse", "--connector", RENDER_CONNECTOR_ID]);
  });
});

// ── Hooks: new canonical events (UserPromptSubmit/PermissionRequest/Stop) ──────

/** A connector declaring the three newly-wired canonical hook events. */
function buildNewEventsConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Kilo CLI New Events",
    version: "1.0.0",
    hooks: {
      UserPromptSubmit: { handler: () => ({ decision: "allow" }) },
      PermissionRequest: { handler: () => ({ decision: "allow" }) },
      Stop: { handler: () => ({ decision: "allow" }) },
    },
  });
}

describe("kilo-cli adapter — new canonical events (capabilities + wiring)", () => {
  it("capability flags for the three new events are true", () => {
    expect(kiloCliAdapter.capabilities.userPromptSubmit).toBe(true);
    expect(kiloCliAdapter.capabilities.permissionRequest).toBe(true);
    expect(kiloCliAdapter.capabilities.stop).toBe(true);
  });

  it("generated plugin registers chat.message, permission.ask, and an event-hook session.idle branch", () => {
    const projectDir = freshProject("ac-kilo-cli-");
    const ctx = buildCtx(projectDir, buildNewEventsConnector());
    kiloCliAdapter.installHooks(ctx);
    const src = readFileSync(kiloCliAdapter.getHookConfigPath(ctx), "utf8");

    expect(src).toContain('"chat.message": async (input, output) =>');
    expect(src).toContain('"permission.ask": async (input, output) =>');
    expect(src).toContain("event: async ({ event }) =>");
    expect(src).toContain('event.type !== "session.idle"');
    // The bridge dispatches each new canonical event by name, routed to kilo-cli.
    expect(src).toContain('"hook", "kilo-cli",');
    expect(src).toContain('bridge("UserPromptSubmit"');
    expect(src).toContain('bridge("PermissionRequest"');
    expect(src).toContain('bridge("Stop"');
  });

  it("parseEvent maps UserPromptSubmit / PermissionRequest / Stop payloads", () => {
    const up = kiloCliAdapter.parseEvent!("UserPromptSubmit", {
      prompt: "hello",
      sessionId: "c-up",
    });
    expect(up).toMatchObject({ hostPlatform: "kilo-cli", prompt: "hello" });

    const pr = kiloCliAdapter.parseEvent!("PermissionRequest", {
      toolName: "bash",
      toolInput: { command: "ls" },
      sessionId: "c-pr",
    });
    expect(pr).toMatchObject({
      hostPlatform: "kilo-cli",
      toolName: "bash",
      toolInput: { command: "ls" },
    });

    const stop = kiloCliAdapter.parseEvent!("Stop", { sessionId: "c-stop" });
    expect(stop).toMatchObject({ hostPlatform: "kilo-cli", sessionId: "c-stop" });
  });
});

describe("kilo-cli generated plugin — new event handlers (live, child_process mocked)", () => {
  let projectDir: string;
  let pluginPath: string;

  beforeEach(() => {
    projectDir = freshProject("ac-kilo-cli-");
    const ctx = buildCtx(projectDir, buildNewEventsConnector());
    kiloCliAdapter.installHooks(ctx);
    pluginPath = kiloCliAdapter.getHookConfigPath(ctx);
    expect(existsSync(pluginPath)).toBe(true);
  });

  async function loadPlugin(): Promise<any> {
    const url = `${pathToFileURL(pluginPath).href}?t=${Date.now()}-${Math.random()}`;
    return import(/* @vite-ignore */ url);
  }

  it("permission.ask mutates output.status to 'deny' on a deny decision", async () => {
    execFileSyncImpl = () => JSON.stringify({ decision: "deny", reason: "no" });
    const mod = await loadPlugin();
    const hooks = await mod.default.server({ directory: projectDir });

    const output: any = { status: "ask" };
    await hooks["permission.ask"]({ type: "bash", sessionID: "s1" }, output);
    expect(output.status).toBe("deny");

    const [, argv] = execFileSyncMock.mock.calls[0]!;
    expect(argv).toEqual(["hook", "kilo-cli", "PermissionRequest", "--connector", CONNECTOR_ID]);
  });

  it("the event hook bridges Stop only for session.idle and throws on a deny decision", async () => {
    execFileSyncImpl = () => JSON.stringify({ decision: "deny", reason: "stay" });
    const mod = await loadPlugin();
    const hooks = await mod.default.server({ directory: projectDir });

    await expect(
      hooks.event({ event: { type: "session.updated", properties: {} } }),
    ).resolves.toBeUndefined();
    expect(execFileSyncMock).not.toHaveBeenCalled();

    await expect(
      hooks.event({ event: { type: "session.idle", properties: { sessionID: "s2" } } }),
    ).rejects.toThrow();
    const [, argv] = execFileSyncMock.mock.calls[0]!;
    expect(argv).toEqual(["hook", "kilo-cli", "Stop", "--connector", CONNECTOR_ID]);
  });

  it("chat.message pushes additionalContext as a text part on output.parts", async () => {
    execFileSyncImpl = () => JSON.stringify({ additionalContext: "INJECTED" });
    const mod = await loadPlugin();
    const hooks = await mod.default.server({ directory: projectDir });

    const output: any = { parts: [{ type: "text", text: "hi" }] };
    await hooks["chat.message"]({ sessionID: "s3" }, output);
    expect(output.parts).toContainEqual({ type: "text", text: "INJECTED" });

    const [, argv] = execFileSyncMock.mock.calls[0]!;
    expect(argv).toEqual(["hook", "kilo-cli", "UserPromptSubmit", "--connector", CONNECTOR_ID]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// E1 extension-event degradation (former extended-events-degrade) — kilo-cli
// wires PermissionRequest -> permission.ask but leaves the other three E1
// events unsupported, never leaking them into the generated bridge.
// ─────────────────────────────────────────────────────────────────────────

describe("kilo-cli adapter — E1 extension-event degradation", () => {
  // kilo-cli (OpenCode fork) wires PermissionRequest -> permission.ask (its
  // native decision-capable gate), so it supports permissionRequest but leaves
  // the other three E1 flags falsy (no Stop/subagent/tool-failure analog).
  it("supports permissionRequest but leaves the other three E1 flags falsy", () => {
    expect(kiloCliAdapter.capabilities.permissionRequest ?? false).toBe(true);
    expect(kiloCliAdapter.capabilities.postToolUseFailure ?? false).toBe(false);
    expect(kiloCliAdapter.capabilities.subagentStart ?? false).toBe(false);
    expect(kiloCliAdapter.capabilities.subagentStop ?? false).toBe(false);
  });

  it("PreToolUse + PermissionRequest wired (permission.ask); the other three E1 events unsupported", () => {
    const projectDir = freshProject("ac-e1-kilo-");
    const ctx = buildCtx(projectDir, buildE1Connector());

    const changes = kiloCliAdapter.installHooks!(ctx);
    const moduleChange = changes.find((c) => c.detail?.startsWith("kilo plugin module"));
    expect(moduleChange?.detail).toBe(
      "kilo plugin module (PreToolUse,PermissionRequest; unsupported here: PostToolUseFailure,SubagentStart,SubagentStop)",
    );

    const source = readFileSync(kiloCliAdapter.getHookConfigPath!(ctx), "utf8");
    expect(source).toContain("tool.execute.before");
    expect(source).toContain("permission.ask"); // PermissionRequest IS wired now
    // The three E1 events with NO kilo analog must still never leak into the bridge.
    for (const token of [
      "PostToolUseFailure",
      "postToolUseFailure",
      "SubagentStart",
      "subagentStart",
      "SubagentStop",
      "subagentStop",
      "subagent_spawned",
      "subagent_ended",
      "subagent_stop",
    ]) {
      expect(source).not.toContain(token);
    }
  });
});
