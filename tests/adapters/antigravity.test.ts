/**
 * adapters/antigravity — dedicated suite for the Antigravity IDE (`antigravity`)
 * and Antigravity CLI (`antigravity-cli`) adapters.
 *
 * Antigravity is fast-moving and its docs render JS-only, so the adapters are
 * MEDIUM-confidence + PATH-PROBE (prefer-existing-else-canonical) with doctor
 * warnings. This file asserts the four adapter-surface concerns the plan calls
 * out, with NO collision against the wave1-render / surfaces tests (which cover
 * project-scope round-trips):
 *
 *   1. MCP render — remote uses "serverUrl" (NOT "url"); stdio omits serverUrl;
 *      corrected USER-scope path order (config/ first, then legacy / CLI-only);
 *      telemetry serve-wrap; env resolved to a LITERAL.
 *   2. hooks.json round-trip + parseEvent/formatReply for PreToolUse / PostToolUse
 *      / SessionStart / Stop; warn-skip for unsupported events.
 *   3. Workflows .md + SKILL.md write / idempotent / uninstall (uninstall PRESERVES
 *      a user file in the skill dir via removeDirIfEmpty); subagents warn-skip.
 *   4. Path-probing prefer-existing-else-canonical for the user MCP config,
 *      hooks.json, workflows (.agent vs .agents), and the global skills dir.
 *
 * Isolation: every test gets a fresh os.tmpdir mkdtemp dir and redirects HOME
 * there so user-scope path resolution stays in the sandbox; env is restored in
 * afterEach.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  HookResponse,
  PostToolUseEvent,
  PreToolUseEvent,
  ResolvedConnector,
  SessionStartEvent,
  StopEvent,
} from "../../src/core/types.js";

import antigravityAdapter, {
  AntigravityAdapter,
} from "../../src/adapters/antigravity/index.js";
import antigravityCliAdapter, {
  AntigravityCliAdapter,
} from "../../src/adapters/antigravity-cli/index.js";

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";

/** A connector with a stdio server + all four supported hooks + an unsupported one. */
function stdioConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@acme/db-mcp"],
      env: { [ENV_VAR]: `\${env:${ENV_VAR}}` },
      tools: { include: ["*"] },
    },
    hooks: {
      PreToolUse: { matcher: "acme_query", handler: () => ({ decision: "allow" }) },
      PostToolUse: { handler: () => ({ decision: "allow" }) },
      SessionStart: { handler: () => ({ decision: "context", additionalContext: "hi" }) },
      Stop: { handler: () => ({ decision: "allow" }) },
      // UserPromptSubmit has no Antigravity equivalent → must warn-skip.
      UserPromptSubmit: { handler: () => ({ decision: "allow" }) },
    },
  });
}

/** A connector with a REMOTE (sse) server — exercises the serverUrl render. */
function remoteConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Remote",
    version: "1.0.0",
    server: {
      transport: "sse",
      url: "https://acme.example/mcp",
      headers: { Authorization: `\${env:${ENV_VAR}}` },
      tools: { include: ["*"] },
    },
  });
}

/** A connector declaring a command (Workflow) + a skill (with a resource) + a subagent. */
function surfaceConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Surfaces",
    version: "1.0.0",
    commands: [
      { name: "acme-report", description: "Generate a report", prompt: "Do the report." },
    ],
    skills: [
      {
        name: "acme-skill",
        description: "Acme helper skill for testing.",
        body: "# Acme\nUse the tools.",
        resources: { "scripts/run.sh": "echo hi\n" },
      },
    ],
    subagents: [
      { name: "acme-agent", description: "Acme agent.", prompt: "You are Acme." },
    ],
  });
}

/** Build an InstallContext at the given scope. */
function buildCtx(
  projectDir: string,
  connector: ResolvedConnector,
  scope: InstallContext["scope"],
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

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Track + restore mutated env so the suite never leaks state.
let savedHome: string | undefined;
let savedDataDir: string | undefined;
let savedEnvVar: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedDataDir = process.env.AGENT_CONNECTOR_DATA_DIR;
  savedEnvVar = process.env[ENV_VAR];
  process.env[ENV_VAR] = ENV_LITERAL;
});

afterEach(() => {
  restore("HOME", savedHome);
  restore("AGENT_CONNECTOR_DATA_DIR", savedDataDir);
  restore(ENV_VAR, savedEnvVar);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Fresh temp dir; HOME redirected there so homedir()-based paths stay sandboxed. */
function freshHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.HOME = dir;
  return dir;
}

// ─────────────────────────────────────────────────────────────────────────
// 1. MCP render — serverUrl (not url) + user-path order + telemetry wrap
// ─────────────────────────────────────────────────────────────────────────

describe("antigravity + antigravity-cli MCP render", () => {
  it("REMOTE server uses `serverUrl` (NOT `url`) with resolved-literal headers", () => {
    const home = freshHome("ac-antig-remote-");
    const ctx = buildCtx(home, remoteConnector(), "project");

    antigravityAdapter.installServer(ctx);
    const cfg = readJson(join(home, ".agents", "mcp_config.json"));
    const entry = cfg.mcpServers[CONNECTOR_ID];

    expect(entry.serverUrl).toBe("https://acme.example/mcp");
    expect(entry).not.toHaveProperty("url"); // BUG-1 guard: never the bare `url` key
    expect(entry.headers.Authorization).toBe(ENV_LITERAL);
    expect(entry.headers.Authorization).not.toContain("${");
    // A remote server is not telemetry-wrappable → no command/args.
    expect(entry).not.toHaveProperty("command");
  });

  it("STDIO server has NO serverUrl, is telemetry-wrapped through the home bin, env LITERAL", () => {
    const home = freshHome("ac-antig-stdio-");
    const ctx = buildCtx(home, stdioConnector(), "project");

    antigravityAdapter.installServer(ctx);
    const entry = readJson(join(home, ".agents", "mcp_config.json")).mcpServers[CONNECTOR_ID];

    expect(entry).not.toHaveProperty("serverUrl"); // stdio never emits serverUrl
    expect(entry.command).toBe(HOME_BIN); // telemetry serve-wrap
    expect(entry.args).toContain("serve");
    expect(entry.args).toContain("--connector");
    expect(entry.args).toContain(CONNECTOR_ID);
    // serve-wrap must pass the install scope (ctx.scope) through.
    expect(entry.args).toContain("--scope");
    expect(entry.args).toContain("project");
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("USER-scope MCP path order: fresh install resolves to ~/.gemini/config/ FIRST", () => {
    const home = freshHome("ac-antig-userorder-");
    const ctx = buildCtx(home, stdioConnector(), "user");

    // Nothing on disk yet → prefer-existing-else-candidate[0] = config/.
    const resolved = antigravityAdapter.getServerConfigPath(ctx);
    expect(resolved).toBe(join(home, ".gemini", "config", "mcp_config.json"));

    antigravityAdapter.installServer(ctx);
    expect(existsSync(resolved)).toBe(true);
    // The legacy launch-era path must NOT be written for a fresh install (BUG-2).
    expect(existsSync(join(home, ".gemini", "antigravity", "mcp_config.json"))).toBe(false);
  });

  it("antigravity-cli USER-scope candidates exclude the IDE legacy path, include the CLI dir", () => {
    const home = freshHome("ac-antigcli-userorder-");
    const ctx = buildCtx(home, stdioConnector(), "user");

    // Fresh → config/ first.
    expect(antigravityCliAdapter.getServerConfigPath(ctx)).toBe(
      join(home, ".gemini", "config", "mcp_config.json"),
    );

    // Seed the CLI-only candidate so prefer-existing picks it (and NOT the IDE legacy).
    const cliPath = join(home, ".gemini", "antigravity-cli", "mcp_config.json");
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(cliPath, "{}\n");
    expect(antigravityCliAdapter.getServerConfigPath(ctx)).toBe(cliPath);

    // Even if the IDE legacy path exists, the CLI must never resolve to it.
    mkdirSync(join(home, ".gemini", "antigravity"), { recursive: true });
    writeFileSync(join(home, ".gemini", "antigravity", "mcp_config.json"), "{}\n");
    expect(antigravityCliAdapter.getServerConfigPath(ctx)).not.toBe(
      join(home, ".gemini", "antigravity", "mcp_config.json"),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. hooks.json round-trip + parseEvent / formatReply + warn-skip
// ─────────────────────────────────────────────────────────────────────────

describe("antigravity hooks.json round-trip + runtime parse/format", () => {
  let home: string;
  let ctx: InstallContext;

  beforeEach(() => {
    home = freshHome("ac-antig-hooks-");
    ctx = buildCtx(home, stdioConnector(), "project");
  });

  it("installHooks writes the four supported events to a SEPARATE hooks.json; warn-skips UserPromptSubmit", () => {
    const changes = antigravityAdapter.installHooks(ctx);

    const hooksPath = antigravityAdapter.getHookConfigPath(ctx);
    expect(hooksPath).toBe(join(home, ".agents", "hooks.json"));
    expect(hooksPath).not.toBe(antigravityAdapter.getServerConfigPath(ctx));

    const file = readJson(hooksPath);
    for (const ev of ["PreToolUse", "PostToolUse", "SessionStart", "Stop"]) {
      const entry = file.hooks?.[ev]?.[0];
      expect(entry, ev).toBeTruthy();
      expect(entry.hooks[0].type).toBe("command");
      expect(entry.hooks[0].command).toContain(HOME_BIN);
      expect(entry.hooks[0].command).toContain(`--connector ${CONNECTOR_ID}`);
    }
    // Matcher preserved for PreToolUse; absent (empty) for the others.
    expect(file.hooks.PreToolUse[0].matcher).toBe("acme_query");
    // Unsupported event has no hooks.json entry AND yields a warn ChangeRecord.
    expect(file.hooks).not.toHaveProperty("UserPromptSubmit");
    const warn = changes.find((c) => c.action === "warn");
    expect(warn?.detail).toContain("UserPromptSubmit");
  });

  it("installHooks is idempotent and uninstallHooks removes only our entries", () => {
    antigravityAdapter.installHooks(ctx);
    const second = antigravityAdapter.installHooks(ctx);
    expect(second.filter((c) => c.action !== "warn").every((c) => c.action === "skip")).toBe(true);

    antigravityAdapter.uninstallHooks(ctx);
    const file = readJson(antigravityAdapter.getHookConfigPath(ctx));
    for (const ev of ["PreToolUse", "PostToolUse", "SessionStart", "Stop"]) {
      expect(file.hooks?.[ev]).toBeUndefined();
    }
  });

  it("uninstallHooks preserves a foreign hook command in the same event bucket", () => {
    antigravityAdapter.installHooks(ctx);
    const hooksPath = antigravityAdapter.getHookConfigPath(ctx);
    const file = readJson(hooksPath);
    // Add an unrelated user hook to the PreToolUse bucket.
    file.hooks.PreToolUse.push({
      matcher: "",
      hooks: [{ type: "command", command: "/usr/bin/my-own-hook" }],
    });
    writeFileSync(hooksPath, JSON.stringify(file));

    antigravityAdapter.uninstallHooks(ctx);
    const after = readJson(hooksPath);
    const remaining = after.hooks.PreToolUse;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].hooks[0].command).toBe("/usr/bin/my-own-hook");
  });

  it("parseEvent maps camelCase stdin → normalized for all four events", () => {
    const pre = antigravityAdapter.parseEvent("PreToolUse", {
      connector: CONNECTOR_ID,
      sessionId: "s1",
      cwd: "/proj",
      toolName: "acme_query",
      toolInput: { sql: "select 1" },
    }) as PreToolUseEvent;
    expect(pre.hostPlatform).toBe("antigravity");
    expect(pre.connectorId).toBe(CONNECTOR_ID);
    expect(pre.sessionId).toBe("s1");
    expect(pre.projectDir).toBe("/proj");
    expect(pre.toolName).toBe("acme_query");
    expect(pre.toolInput).toEqual({ sql: "select 1" });

    const post = antigravityAdapter.parseEvent("PostToolUse", {
      toolName: "acme_query",
      toolInput: {},
      toolOutput: "rows: 1",
      isError: true,
    }) as PostToolUseEvent;
    expect(post.toolOutput).toBe("rows: 1");
    expect(post.isError).toBe(true);

    const ss = antigravityAdapter.parseEvent("SessionStart", {
      source: "resume",
    }) as SessionStartEvent;
    expect(ss.source).toBe("resume");

    const stop = antigravityAdapter.parseEvent("Stop", {
      stopHookActive: true,
    }) as StopEvent;
    expect(stop.stopHookActive).toBe(true);
  });

  it("parseEvent on antigravity-cli stamps hostPlatform = antigravity-cli", () => {
    const ev = antigravityCliAdapter.parseEvent("PreToolUse", {
      connector: CONNECTOR_ID,
      toolName: "t",
      toolInput: {},
    }) as PreToolUseEvent;
    expect(ev.hostPlatform).toBe("antigravity-cli");
  });

  it("formatReply renders deny / modify-input / modify-output / context / allow (camelCase)", () => {
    const deny: HookResponse = { decision: "deny", reason: "nope" };
    const r1 = antigravityAdapter.formatReply("PreToolUse", deny);
    expect(JSON.parse(r1.stdout!)).toEqual({ decision: "deny", reason: "nope" });

    const modIn: HookResponse = { decision: "modify", updatedInput: { sql: "select 2" } };
    const r2 = antigravityAdapter.formatReply("PreToolUse", modIn);
    expect(JSON.parse(r2.stdout!)).toEqual({ updatedInput: { sql: "select 2" } });

    const modOut: HookResponse = { decision: "modify", updatedOutput: "redacted" };
    const r3 = antigravityAdapter.formatReply("PostToolUse", modOut);
    expect(JSON.parse(r3.stdout!)).toEqual({ updatedOutput: "redacted" });

    const inject: HookResponse = { decision: "context", additionalContext: "ctx" };
    const r4 = antigravityAdapter.formatReply("SessionStart", inject);
    expect(JSON.parse(r4.stdout!)).toEqual({ additionalContext: "ctx" });

    const allow: HookResponse = { decision: "allow" };
    const r5 = antigravityAdapter.formatReply("PreToolUse", allow);
    expect(r5.exitCode).toBe(0);
    expect(r5.stdout).toBeUndefined();

    // ask has no native equivalent → degrades to a fail-safe deny.
    const r6 = antigravityAdapter.formatReply("PreToolUse", { decision: "ask" });
    expect(JSON.parse(r6.stdout!).decision).toBe("deny");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Workflows .md + SKILL.md write / idempotent / uninstall; subagents warn-skip
// ─────────────────────────────────────────────────────────────────────────

describe("antigravity content surfaces (Workflows / Skills / Subagents)", () => {
  let home: string;
  let ctx: InstallContext;

  beforeEach(() => {
    home = freshHome("ac-antig-surf-");
    ctx = buildCtx(home, surfaceConnector(), "project");
  });

  it("installCommands writes a markdown Workflow .md (NOT TOML) with the prompt body", () => {
    const changes = antigravityAdapter.installCommands(ctx);
    expect(changes[0]?.action).toBe("create");

    // Default project workflows dir is the launch-era singular `.agent/workflows`.
    const wfPath = join(home, ".agent", "workflows", "acme-report.md");
    expect(existsSync(wfPath)).toBe(true);
    const body = readFileSync(wfPath, "utf8");
    expect(body).toContain("Generate a report");
    expect(body).toContain("Do the report.");
    // Markdown Workflow, never TOML.
    expect(body).not.toContain("prompt =");
    expect(body).not.toContain("[command]");

    // Idempotent.
    expect(antigravityAdapter.installCommands(ctx)[0]?.action).toBe("skip");

    // Uninstall removes it.
    antigravityAdapter.uninstallCommands(ctx);
    expect(existsSync(wfPath)).toBe(false);
  });

  it("installSkills writes SKILL.md + resource; idempotent; uninstall PRESERVES a user file via removeDirIfEmpty", () => {
    const changes = antigravityAdapter.installSkills(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const skillDir = join(home, ".agents", "skills", "acme-skill");
    const skillMd = join(skillDir, "SKILL.md");
    const resource = join(skillDir, "scripts", "run.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    const fm = readFileSync(skillMd, "utf8");
    expect(fm).toContain("name: acme-skill");
    expect(fm).toContain("Acme helper skill for testing.");

    // Idempotent.
    expect(antigravityAdapter.installSkills(ctx).every((c) => c.action === "skip")).toBe(true);

    // Drop a user-owned file into the skill dir; uninstall must NOT rm the dir.
    const userFile = join(skillDir, "MY_NOTES.md");
    writeFileSync(userFile, "keep me\n");

    antigravityAdapter.uninstallSkills(ctx);
    expect(existsSync(skillMd)).toBe(false); // our file removed
    expect(existsSync(resource)).toBe(false); // our resource removed
    expect(existsSync(userFile)).toBe(true); // user file preserved
    expect(existsSync(skillDir)).toBe(true); // dir kept (removeDirIfEmpty no-op)
  });

  it("subagents are unsupported → warn-skip (no files), and capability flag is false", () => {
    expect(antigravityAdapter.capabilities.supportsSubagents).toBe(false);
    const changes = antigravityAdapter.installSubagents(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("subagents");
    // No subagent dir was created.
    expect(existsSync(join(home, ".agents", "agents"))).toBe(false);
  });

  it("antigravity-cli writes the same surfaces (project scope identical to IDE)", () => {
    const cliCtx = buildCtx(home, surfaceConnector(), "project");
    antigravityCliAdapter.installCommands(cliCtx);
    antigravityCliAdapter.installSkills(cliCtx);
    expect(existsSync(join(home, ".agent", "workflows", "acme-report.md"))).toBe(true);
    expect(existsSync(join(home, ".agents", "skills", "acme-skill", "SKILL.md"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Path-probing: prefer-existing-else-canonical
// ─────────────────────────────────────────────────────────────────────────

describe("antigravity path-probing (prefer-existing-else-canonical)", () => {
  it("user MCP config: an EXISTING legacy ~/.gemini/antigravity/ path is honored over the default", () => {
    const home = freshHome("ac-antig-probe-mcp-");
    const ctx = buildCtx(home, stdioConnector(), "user");

    // Seed the legacy launch-era path; prefer-existing must pick it.
    const legacy = join(home, ".gemini", "antigravity", "mcp_config.json");
    mkdirSync(join(home, ".gemini", "antigravity"), { recursive: true });
    writeFileSync(legacy, "{}\n");
    expect(antigravityAdapter.getServerConfigPath(ctx)).toBe(legacy);
  });

  it("hooks.json sits in the SAME probed customization dir as the resolved user MCP config", () => {
    const home = freshHome("ac-antig-probe-hooks-");
    const ctx = buildCtx(home, stdioConnector(), "user");

    // Fresh → config/ dir for both mcp_config.json and hooks.json.
    expect(antigravityAdapter.getHookConfigPath(ctx)).toBe(
      join(home, ".gemini", "config", "hooks.json"),
    );

    // Seed legacy mcp_config → hooks.json must follow into the same dir.
    mkdirSync(join(home, ".gemini", "antigravity"), { recursive: true });
    writeFileSync(join(home, ".gemini", "antigravity", "mcp_config.json"), "{}\n");
    expect(antigravityAdapter.getHookConfigPath(ctx)).toBe(
      join(home, ".gemini", "antigravity", "hooks.json"),
    );
  });

  it("workflows dir: prefers an existing project .agents/workflows over the default .agent/workflows", () => {
    const proj = freshHome("ac-antig-probe-wf-");
    const ctx = buildCtx(proj, surfaceConnector(), "project");

    // Default (nothing seeded) → singular `.agent/workflows`.
    antigravityAdapter.installCommands(ctx);
    expect(existsSync(join(proj, ".agent", "workflows", "acme-report.md"))).toBe(true);

    // Now seed a plural `.agents/workflows` dir in a SECOND project → preferred.
    const proj2 = mkdtempSync(join(tmpdir(), "ac-antig-probe-wf2-"));
    mkdirSync(join(proj2, ".agents", "workflows"), { recursive: true });
    const ctx2 = buildCtx(proj2, surfaceConnector(), "project");
    antigravityAdapter.installCommands(ctx2);
    expect(existsSync(join(proj2, ".agents", "workflows", "acme-report.md"))).toBe(true);
    expect(existsSync(join(proj2, ".agent", "workflows", "acme-report.md"))).toBe(false);
  });

  it("global skills dir: prefers existing ~/.gemini/antigravity-cli/skills, then ~/.gemini/skills; NEVER ~/.gemini/antigravity/skills", () => {
    const home = freshHome("ac-antig-probe-skills-");
    const ctx = buildCtx(home, surfaceConnector(), "user");

    // Fresh → default canonical CLI skills dir (never the broken antigravity/skills).
    antigravityAdapter.installSkills(ctx);
    const cliSkills = join(home, ".gemini", "antigravity-cli", "skills", "acme-skill", "SKILL.md");
    expect(existsSync(cliSkills)).toBe(true);
    expect(
      existsSync(join(home, ".gemini", "antigravity", "skills", "acme-skill", "SKILL.md")),
    ).toBe(false);

    // Seed ~/.gemini/skills in a fresh home → it is preferred over the (absent) CLI dir.
    const home2 = freshHome("ac-antig-probe-skills2-");
    mkdirSync(join(home2, ".gemini", "skills"), { recursive: true });
    const ctx2 = buildCtx(home2, surfaceConnector(), "user");
    antigravityAdapter.installSkills(ctx2);
    expect(
      existsSync(join(home2, ".gemini", "skills", "acme-skill", "SKILL.md")),
    ).toBe(true);
  });

  it("antigravity-cli global skills dir is its OWN store (~/.gemini/antigravity-cli/skills), not the shared one", () => {
    const home = freshHome("ac-antigcli-probe-skills-");
    // Seed the shared ~/.gemini/skills; the CLI must STILL use its own dir.
    mkdirSync(join(home, ".gemini", "skills"), { recursive: true });
    const ctx = buildCtx(home, surfaceConnector(), "user");
    antigravityCliAdapter.installSkills(ctx);
    expect(
      existsSync(join(home, ".gemini", "antigravity-cli", "skills", "acme-skill", "SKILL.md")),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Identity / wiring sanity
// ─────────────────────────────────────────────────────────────────────────

describe("antigravity adapter identity + paradigm", () => {
  it("both adapters are json-stdio with the correct ids/classes", () => {
    expect(antigravityAdapter).toBeInstanceOf(AntigravityAdapter);
    expect(antigravityCliAdapter).toBeInstanceOf(AntigravityCliAdapter);
    expect(antigravityAdapter.id).toBe("antigravity");
    expect(antigravityCliAdapter.id).toBe("antigravity-cli");
    expect(antigravityAdapter.paradigm).toBe("json-stdio");
    expect(antigravityCliAdapter.paradigm).toBe("json-stdio");
    // The CLI is a fork of the IDE adapter.
    expect(antigravityCliAdapter).toBeInstanceOf(AntigravityAdapter);
  });
});
