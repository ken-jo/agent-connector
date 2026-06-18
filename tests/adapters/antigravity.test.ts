/**
 * adapters/antigravity.test.ts — the ONE per-host file for the Antigravity IDE
 * (`antigravity`) adapter.
 *
 * Antigravity is fast-moving and its docs render JS-only, so the adapter is
 * MEDIUM-confidence + PATH-PROBE (prefer-existing-else-canonical) with doctor
 * warnings. It is a `json-stdio` host (a real lifecycle-hook system on top of MCP).
 * This file asserts every antigravity-surface concern:
 *
 *   1. MCP render — remote uses "serverUrl" (NOT "url"); stdio omits serverUrl;
 *      CONFIRMED USER-scope path (antigravity/ default, with config/ and
 *      antigravity-cli/ as probed fallbacks); telemetry serve-wrap; env LITERAL.
 *      NOTE: the references to the `antigravity-cli/` DIRECTORY here are this
 *      IDE adapter's OWN getServerConfigPath probe-fallback resolution — not the
 *      CLI adapter (which has its own file). One it() genuinely compares BOTH
 *      adapters' fresh defaults to prove they DIFFER; it stays here (flagged).
 *   2. hooks.json round-trip + parseEvent/formatReply for PreToolUse / PostToolUse
 *      / SessionStart / Stop; warn-skip for unsupported events.
 *   3. Workflows .md + SKILL.md write / idempotent / uninstall (uninstall PRESERVES
 *      a user file in the skill dir via removeDirIfEmpty); subagents warn-skip.
 *   4. Path-probing prefer-existing-else-canonical for the user MCP config,
 *      hooks.json, workflows (.agent vs .agents), and the global skills dir.
 *   5. The OPT-IN AfterModel host-native usage hook (4a) — install only when
 *      opted in, reversible, preserves foreign + sibling hooks.
 *   6. E1 extension-event DEGRADATION (PermissionRequest / PostToolUseFailure /
 *      SubagentStart / SubagentStop) — capability flags stay falsy + per-event
 *      warn-skip while PreToolUse still wires.
 *
 * Migrated to the shared harness (tests/support/env + adapter-suite + fs) per
 * tests/README.md — ONE file per host. The host-native usage block was absorbed
 * from the former host-native-hooks.test.ts; the render/round-trip block from
 * wave1-render.test.ts; the E1 degradation block from extended-events-degrade.test.ts.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

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
import antigravityCliAdapter from "../../src/adapters/antigravity-cli/index.js";
import { buildCtx, freshProject, isolateEnv, tempDir, HOME_BIN } from "../support/env.js";
import { readJson } from "../support/fs.js";
import { createAdapterSuite } from "../support/adapter-suite.js";

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

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

// ── E1 extension-event fixtures (absorbed from extended-events-degrade) ──────────

const E1_EVENTS = [
  "PermissionRequest",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
] as const;

/** PreToolUse (universally wired here) + ALL FOUR E1 extension events. */
function e1Connector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
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

// ── host-native usage hook fixtures (absorbed from host-native-hooks) ────────────

const USAGE_EVENT_KEY = "AfterModel";

/**
 * A connector that declares NO normalized hook events. host-native capture is a
 * host-native-only sink (no handler), so the usage hook may be installed for such
 * a connector when opted in — and must NOT be installed when opted out.
 */
function noHooksConnector(hostNativeUsage: boolean): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.0.0",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@acme/db-mcp"],
      tools: { include: ["*"] },
    },
    telemetry: { hostNativeUsage },
  });
}

/**
 * A connector that ALSO declares a normalized PreToolUse hook — used to prove the
 * usage hook is added alongside (and removed without touching) a real hook.
 */
function withPreToolUse(hostNativeUsage: boolean): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.0.0",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@acme/db-mcp"],
      tools: { include: ["*"] },
    },
    hooks: {
      PreToolUse: { matcher: "acme_query", handler: () => ({ decision: "allow" }) },
    },
    telemetry: { hostNativeUsage },
  });
}

/** All hook command strings under the given native event bucket. */
function commandsUnder(file: any, eventKey: string): string[] {
  const bucket = file?.hooks?.[eventKey];
  if (!Array.isArray(bucket)) return [];
  return bucket.flatMap((e: any) => (e.hooks ?? []).map((h: any) => h.command));
}

// Shared env isolation (default keys + the env-ref var the render slices mutate +
// the host-native opt-in switch the usage-hook slice toggles) + the
// same-rules-for-every-host baseline contract.
isolateEnv([ENV_VAR, "AGENT_CONNECTOR_HOST_NATIVE"]);
createAdapterSuite({ adapter: antigravityAdapter, paradigm: "json-stdio" });

// ─────────────────────────────────────────────────────────────────────────
// 1. MCP render — serverUrl (not url) + user-path order + telemetry wrap
// ─────────────────────────────────────────────────────────────────────────

describe("antigravity MCP render", () => {
  it("REMOTE server uses `serverUrl` (NOT `url`) with resolved-literal headers", () => {
    const home = freshProject("ac-antig-remote-");
    process.env[ENV_VAR] = ENV_LITERAL;
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
    const home = freshProject("ac-antig-stdio-");
    process.env[ENV_VAR] = ENV_LITERAL;
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

  it("USER-scope MCP path: fresh install resolves to the CONFIRMED ~/.gemini/antigravity/ FIRST", () => {
    const home = freshProject("ac-antig-userorder-");
    const ctx = buildCtx(home, stdioConnector(), "user");

    // Nothing on disk yet → prefer-existing-else-candidate[0] = antigravity/
    // (CONFIRMED canonical on a real install).
    const resolved = antigravityAdapter.getServerConfigPath(ctx);
    expect(resolved).toBe(join(home, ".gemini", "antigravity", "mcp_config.json"));

    antigravityAdapter.installServer(ctx);
    expect(existsSync(resolved)).toBe(true);
    // The config/ path must NOT be written for a fresh install (it is a probed
    // fallback only, never the default).
    expect(existsSync(join(home, ".gemini", "config", "mcp_config.json"))).toBe(false);
  });

  it("USER-scope MCP path: an existing config/ or antigravity-cli/ candidate is still PREFERRED when present", () => {
    // Seed an existing config/ candidate → prefer-existing must honor it.
    const home1 = freshProject("ac-antig-prefer-config-");
    const ctx1 = buildCtx(home1, stdioConnector(), "user");
    const configPath = join(home1, ".gemini", "config", "mcp_config.json");
    mkdirSync(join(home1, ".gemini", "config"), { recursive: true });
    writeFileSync(configPath, "{}\n");
    expect(antigravityAdapter.getServerConfigPath(ctx1)).toBe(configPath);

    // Seed only the antigravity-cli/ fallback (no antigravity/, no config/) →
    // prefer-existing must honor it over the default. (This `antigravity-cli/`
    // DIR is the IDE adapter's OWN probe fallback, not the CLI adapter.)
    const home2 = freshProject("ac-antig-prefer-cli-");
    const ctx2 = buildCtx(home2, stdioConnector(), "user");
    const cliPath = join(home2, ".gemini", "antigravity-cli", "mcp_config.json");
    mkdirSync(join(home2, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(cliPath, "{}\n");
    expect(antigravityAdapter.getServerConfigPath(ctx2)).toBe(cliPath);
  });

  // GENUINELY-BOTH it(): compares the IDE adapter's fresh user default against the
  // CLI adapter's to prove they DIFFER (antigravity/ vs config/). Kept in the IDE
  // file per the migration rule for compare-both assertions; the CLI side's own
  // install + prefer-existing behaviour is exercised in antigravity-cli.test.ts.
  it("IDE adapter's fresh USER default (antigravity/) DIFFERS from the CLI adapter's (config/)", () => {
    const home = freshProject("ac-antig-vscli-userorder-");
    const ctx = buildCtx(home, stdioConnector(), "user");

    const ideDefault = join(home, ".gemini", "antigravity", "mcp_config.json");
    const cliCanonical = join(home, ".gemini", "config", "mcp_config.json");
    expect(antigravityAdapter.getServerConfigPath(ctx)).toBe(ideDefault);
    expect(antigravityCliAdapter.getServerConfigPath(ctx)).toBe(cliCanonical);
    expect(antigravityAdapter.getServerConfigPath(ctx)).not.toBe(
      antigravityCliAdapter.getServerConfigPath(ctx),
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
    home = freshProject("ac-antig-hooks-");
    process.env[ENV_VAR] = ENV_LITERAL;
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
    home = freshProject("ac-antig-surf-");
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
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Path-probing: prefer-existing-else-canonical
// ─────────────────────────────────────────────────────────────────────────

describe("antigravity path-probing (prefer-existing-else-canonical)", () => {
  it("user MCP config: an EXISTING ~/.gemini/config/ fallback is honored over the antigravity/ default", () => {
    const home = freshProject("ac-antig-probe-mcp-");
    const ctx = buildCtx(home, stdioConnector(), "user");

    // Seed the config/ fallback; prefer-existing must pick it over the default.
    const configPath = join(home, ".gemini", "config", "mcp_config.json");
    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
    writeFileSync(configPath, "{}\n");
    expect(antigravityAdapter.getServerConfigPath(ctx)).toBe(configPath);
  });

  it("hooks.json sits in the SAME probed customization dir as the resolved user MCP config", () => {
    const home = freshProject("ac-antig-probe-hooks-");
    const ctx = buildCtx(home, stdioConnector(), "user");

    // Fresh → CONFIRMED antigravity/ dir for both mcp_config.json and hooks.json.
    expect(antigravityAdapter.getHookConfigPath(ctx)).toBe(
      join(home, ".gemini", "antigravity", "hooks.json"),
    );

    // Seed a config/ mcp_config → hooks.json must follow into that same dir.
    const home2 = freshProject("ac-antig-probe-hooks2-");
    const ctx2 = buildCtx(home2, stdioConnector(), "user");
    mkdirSync(join(home2, ".gemini", "config"), { recursive: true });
    writeFileSync(join(home2, ".gemini", "config", "mcp_config.json"), "{}\n");
    expect(antigravityAdapter.getHookConfigPath(ctx2)).toBe(
      join(home2, ".gemini", "config", "hooks.json"),
    );
  });

  it("workflows dir: prefers an existing project .agents/workflows over the default .agent/workflows", () => {
    const proj = freshProject("ac-antig-probe-wf-");
    const ctx = buildCtx(proj, surfaceConnector(), "project");

    // Default (nothing seeded) → singular `.agent/workflows`.
    antigravityAdapter.installCommands(ctx);
    expect(existsSync(join(proj, ".agent", "workflows", "acme-report.md"))).toBe(true);

    // Now seed a plural `.agents/workflows` dir in a SECOND project → preferred.
    const proj2 = tempDir("ac-antig-probe-wf2-");
    mkdirSync(join(proj2, ".agents", "workflows"), { recursive: true });
    const ctx2 = buildCtx(proj2, surfaceConnector(), "project");
    antigravityAdapter.installCommands(ctx2);
    expect(existsSync(join(proj2, ".agents", "workflows", "acme-report.md"))).toBe(true);
    expect(existsSync(join(proj2, ".agent", "workflows", "acme-report.md"))).toBe(false);
  });

  it("global skills dir: prefers existing ~/.gemini/antigravity-cli/skills, then ~/.gemini/skills; NEVER ~/.gemini/antigravity/skills", () => {
    const home = freshProject("ac-antig-probe-skills-");
    const ctx = buildCtx(home, surfaceConnector(), "user");

    // Fresh → default canonical CLI skills dir (never the broken antigravity/skills).
    antigravityAdapter.installSkills(ctx);
    const cliSkills = join(home, ".gemini", "antigravity-cli", "skills", "acme-skill", "SKILL.md");
    expect(existsSync(cliSkills)).toBe(true);
    expect(
      existsSync(join(home, ".gemini", "antigravity", "skills", "acme-skill", "SKILL.md")),
    ).toBe(false);

    // Seed ~/.gemini/skills in a fresh home → it is preferred over the (absent) CLI dir.
    const home2 = freshProject("ac-antig-probe-skills2-");
    mkdirSync(join(home2, ".gemini", "skills"), { recursive: true });
    const ctx2 = buildCtx(home2, surfaceConnector(), "user");
    antigravityAdapter.installSkills(ctx2);
    expect(
      existsSync(join(home2, ".gemini", "skills", "acme-skill", "SKILL.md")),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. OPT-IN AfterModel host-native usage hook (4a)
//
// The AfterModel `usage-event` hook is installed ONLY when host-native capture is
// opted in (telemetry.hostNativeUsage === true OR AGENT_CONNECTOR_HOST_NATIVE=1 at
// install). It routes to the hidden `usage-event` entrypoint with an empty matcher,
// and uninstall reverses it while preserving foreign + sibling hooks.
// (Absorbed from the former host-native-hooks.test.ts.)
// ─────────────────────────────────────────────────────────────────────────

describe("antigravity host-native usage hook (opt-in only)", () => {
  let project: string;

  beforeEach(() => {
    project = freshProject("ac-hn-antigravity-");
  });

  it("does NOT install the AfterModel usage hook when the opt-in is OFF", () => {
    const ctx = buildCtx(project, noHooksConnector(false));
    const changes = antigravityAdapter.installHooks(ctx);

    // A no-hooks connector with the opt-in off has nothing to install → skip.
    expect(changes.every((c) => c.action === "skip")).toBe(true);
    const hooksPath = antigravityAdapter.getHookConfigPath(ctx);
    // No usage-event command anywhere (file may not even exist).
    if (existsSync(hooksPath)) {
      const file = readJson(hooksPath);
      expect(commandsUnder(file, USAGE_EVENT_KEY)).toHaveLength(0);
    }
  });

  it("installs the AfterModel usage-event hook when telemetry.hostNativeUsage is ON", () => {
    const ctx = buildCtx(project, noHooksConnector(true));
    const changes = antigravityAdapter.installHooks(ctx);

    const created = changes.find(
      (c) => c.action === "create" && c.detail.includes("host-native usage"),
    );
    expect(created).toBeTruthy();

    const file = readJson(antigravityAdapter.getHookConfigPath(ctx));
    const cmds = commandsUnder(file, USAGE_EVENT_KEY);
    expect(cmds).toHaveLength(1);
    // Routes to the hidden `usage-event` entrypoint (NOT the `hook` dispatcher).
    expect(cmds[0]).toContain(" usage-event ");
    expect(cmds[0]).toContain(HOME_BIN);
    expect(cmds[0]).toContain(`--connector ${CONNECTOR_ID}`);
    expect(cmds[0]).not.toContain(" hook ");
    // The usage hook is not a tool event → empty matcher.
    const entry = file.hooks[USAGE_EVENT_KEY].find((e: any) =>
      (e.hooks ?? []).some((h: any) => h.command.includes(" usage-event ")),
    );
    expect(entry.matcher).toBe("");
  });

  it("installs the usage hook when AGENT_CONNECTOR_HOST_NATIVE=1 forces it on at install", () => {
    process.env.AGENT_CONNECTOR_HOST_NATIVE = "1";
    const ctx = buildCtx(project, noHooksConnector(false)); // config opt-in OFF
    antigravityAdapter.installHooks(ctx);

    const file = readJson(antigravityAdapter.getHookConfigPath(ctx));
    expect(commandsUnder(file, USAGE_EVENT_KEY)).toHaveLength(1);
  });

  it("is idempotent: a second install skips the already-registered usage hook", () => {
    const ctx = buildCtx(project, noHooksConnector(true));
    antigravityAdapter.installHooks(ctx);
    const second = antigravityAdapter.installHooks(ctx);
    const usageChange = second.find((c) => c.detail.includes("host-native usage"));
    expect(usageChange?.action).toBe("skip");
    // Still exactly one usage-event command (no duplicate appended).
    const file = readJson(antigravityAdapter.getHookConfigPath(ctx));
    expect(commandsUnder(file, USAGE_EVENT_KEY)).toHaveLength(1);
  });

  it("uninstall removes the AfterModel usage hook (and leaves the bucket clean)", () => {
    const ctx = buildCtx(project, noHooksConnector(true));
    antigravityAdapter.installHooks(ctx);
    expect(commandsUnder(readJson(antigravityAdapter.getHookConfigPath(ctx)), USAGE_EVENT_KEY))
      .toHaveLength(1);

    antigravityAdapter.uninstallHooks(ctx);
    const after = existsSync(antigravityAdapter.getHookConfigPath(ctx))
      ? readJson(antigravityAdapter.getHookConfigPath(ctx))
      : { hooks: {} };
    expect(commandsUnder(after, USAGE_EVENT_KEY)).toHaveLength(0);
    // Our anchored cleanup empties the bucket entirely (no orphan entry left).
    expect(after.hooks?.[USAGE_EVENT_KEY]).toBeUndefined();
  });

  it("uninstall PRESERVES a foreign hook command in the same AfterModel bucket", () => {
    const ctx = buildCtx(project, noHooksConnector(true));
    antigravityAdapter.installHooks(ctx);

    // Inject a foreign hook command into the SAME bucket.
    const hooksPath = antigravityAdapter.getHookConfigPath(ctx);
    const file = readJson(hooksPath);
    file.hooks[USAGE_EVENT_KEY].push({
      matcher: "",
      hooks: [{ type: "command", command: "/usr/local/bin/someone-elses-tool" }],
    });
    writeFileSync(hooksPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");

    antigravityAdapter.uninstallHooks(ctx);
    const after = readJson(hooksPath);
    const cmds = commandsUnder(after, USAGE_EVENT_KEY);
    // Ours is gone; the foreign one survives.
    expect(cmds).toContain("/usr/local/bin/someone-elses-tool");
    expect(cmds.some((c) => c.includes(" usage-event "))).toBe(false);
  });

  it("uninstall removes the usage hook WITHOUT touching a sibling normalized hook", () => {
    const ctx = buildCtx(project, withPreToolUse(true));
    antigravityAdapter.installHooks(ctx);

    const hooksPath = antigravityAdapter.getHookConfigPath(ctx);
    // Both present after install: the usage hook AND the PreToolUse dispatcher.
    let file = readJson(hooksPath);
    expect(commandsUnder(file, USAGE_EVENT_KEY)).toHaveLength(1);

    // Locate the PreToolUse bucket key.
    const preKey = Object.keys(file.hooks).find((k) =>
      commandsUnder(file, k).some((c) => c.includes(" hook ")),
    );
    expect(preKey).toBeTruthy();

    antigravityAdapter.uninstallHooks(ctx);
    file = existsSync(hooksPath) ? readJson(hooksPath) : { hooks: {} };
    // Both of OUR hooks are gone after a full uninstall (anchored on our id).
    expect(commandsUnder(file, USAGE_EVENT_KEY)).toHaveLength(0);
    expect(commandsUnder(file, preKey!)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. E1 extension-event DEGRADATION (no native analog for the four new events)
// (Absorbed from the former extended-events-degrade.test.ts.)
// ─────────────────────────────────────────────────────────────────────────

describe("antigravity E1 extension-event degradation", () => {
  it("leaves permissionRequest/postToolUseFailure/subagentStart/subagentStop falsy", () => {
    expect(antigravityAdapter.capabilities.permissionRequest ?? false).toBe(false);
    expect(antigravityAdapter.capabilities.postToolUseFailure ?? false).toBe(false);
    expect(antigravityAdapter.capabilities.subagentStart ?? false).toBe(false);
    expect(antigravityAdapter.capabilities.subagentStop ?? false).toBe(false);
  });

  it("installHooks warn-skips all four E1 events; hooks.json wires PreToolUse only", () => {
    const projectDir = freshProject("ac-e1-antigravity-");
    const ctx = buildCtx(projectDir, e1Connector());

    const changes = antigravityAdapter.installHooks!(ctx);
    const warns = changes.filter((c) => c.action === "warn");
    for (const event of E1_EVENTS) {
      const warn = warns.find((c) => c.detail?.startsWith(`${event} `));
      expect(warn, `expected a warn-skip record for ${event}`).toBeTruthy();
      expect(warn!.platform).toBe("antigravity");
      expect(warn!.detail).toBe(`${event} has no Antigravity hook equivalent — skipped`);
    }
    expect(warns).toHaveLength(E1_EVENTS.length);

    const hooksPath = antigravityAdapter.getHookConfigPath!(ctx);
    const file = readJson(hooksPath);
    expect(Object.keys(file.hooks)).toEqual(["PreToolUse"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Identity / wiring sanity
// ─────────────────────────────────────────────────────────────────────────

describe("antigravity adapter identity + paradigm", () => {
  it("is a json-stdio adapter with the correct id/class", () => {
    expect(antigravityAdapter).toBeInstanceOf(AntigravityAdapter);
    expect(antigravityAdapter.id).toBe("antigravity");
    expect(antigravityAdapter.paradigm).toBe("json-stdio");
  });
});
