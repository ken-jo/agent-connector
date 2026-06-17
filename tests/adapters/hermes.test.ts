/**
 * adapters/hermes.test.ts — the ONE per-host file for the Hermes Agent adapter.
 *
 * hermes is a json-stdio host whose ENTIRE configuration — both the MCP servers
 * AND the lifecycle hooks AND the quick_commands action surface — lives in a
 * single user-scope YAML file: ~/.hermes/config.yaml. Skills are auto-discovered
 * dir-per-skill SKILL.md under ~/.hermes/skills.
 *
 *   • MCP servers → mcp_servers.<id>: stdio { command, args, env } OR remote HTTP
 *                   { url, headers? } under the SAME key (no transport key); env
 *                   refs resolve to LITERALS (no ${env:VAR} support); no SSE.
 *   • Hooks       → top-level "hooks" map keyed by hermes' NATIVE snake_case event
 *                   names (pre_tool_call / on_session_start / subagent_stop …); the
 *                   command keeps the canonical event token. nativeHooks file
 *                   host-specific event-name keys VERBATIM.
 *   • Skills      → ~/.hermes/skills/<name>/SKILL.md (user scope only).
 *   • Actions     → quick_commands.<id>: { type: "exec", command }.
 *
 * This file consolidates what used to be split across hermes-http-mcp.test.ts,
 * hermes-native-hooks.test.ts, hermes-skills.test.ts, wave3.test.ts,
 * extended-events-batch2.test.ts, actions-emit.test.ts, and review-fixes.test.ts.
 * It uses the shared harness (tests/support/env + adapter-suite + fs) per
 * tests/README.md — ONE file per host.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parse as parseYaml } from "yaml";
import { beforeEach, describe, expect, it } from "vitest";

import { ensureDir } from "../../src/core/paths.js";
import { defineConnector } from "../../src/core/define-connector.js";
import { readYaml, writeYaml } from "../../src/core/yaml.js";
import { buildHomeBinActionCommand } from "../../src/core/spawn.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  ActionDef,
  ConnectorConfig,
  PreToolUseEvent,
  ResolvedConnector,
  SubagentStopEvent,
  Transport,
} from "../../src/core/types.js";

import hermesAdapter from "../../src/adapters/hermes/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { splitFrontmatter } from "../support/fs.js";

// ── shared fixtures ──────────────────────────────────────────────────────────

// render/round-trip + extended-event + review-fix slices share this connector id
// (the env-ref var resolves to a literal so the on-disk value is known).
const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const SERVER_CWD = "/srv/acme";
const PRE_MATCHER = "acme_query|acme_write";
const AGENT_MATCHER = "code-reviewer|explore";

// Per-slice connector ids preserved verbatim from their source files.
const HTTP_CONNECTOR_ID = "acme-hermes-http";
const NATIVE_CONNECTOR_ID = "acme-hermes-native";
const SKILLS_CONNECTOR_ID = "acme-hermes-skills";
const ACTIONS_CONNECTOR_ID = "acme";

// The serve-wrapper args also bake the install TARGET platform as `--host <id>`
// (before `--`) so the proxy stamps hostPlatform under a headless spawn.
const wrappedArgs = (host: string): string[] =>
  ["serve", "--connector", CONNECTOR_ID, "--scope", "user", "--host", host, "--", "npx", "-y", "@x/y"];

function configPath(projectDir: string): string {
  return join(projectDir, ".hermes", "config.yaml");
}

/** Read + parse a YAML file from disk (independent of the adapter's readYaml). */
function readYamlFile(path: string): Record<string, any> {
  return parseYaml(readFileSync(path, "utf8")) as Record<string, any>;
}

/**
 * A connector with a stdio server (env-ref) + PreToolUse and SessionStart hooks.
 * hermes supports PreToolUse + SessionStart, so both register; the deny
 * round-trip exercises PreToolUse.
 */
function buildConnector(id = CONNECTOR_ID): ResolvedConnector {
  return defineConnector({
    id,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@x/y"],
      env: { [ENV_VAR]: `\${env:${ENV_VAR}}` },
      cwd: SERVER_CWD,
      tools: { include: ["*"] },
    },
    hooks: {
      PreToolUse: {
        matcher: PRE_MATCHER,
        handler() {
          return { decision: "allow" };
        },
      },
      SessionStart: {
        handler() {
          return { decision: "context", additionalContext: "hello" };
        },
      },
    },
  });
}

/** A representative native PreToolUse hook stdin payload (Claude-style fields). */
function preToolUsePayload(): Record<string, unknown> {
  return {
    session_id: "sess-123",
    cwd: "/work/proj",
    hook_event_name: "PreToolUse",
    tool_name: "acme_query",
    tool_input: { sql: "SELECT 1" },
    connector: CONNECTOR_ID,
  };
}

function assertPreToolUse(ev: PreToolUseEvent, hostPlatform: string): void {
  expect(ev.hostPlatform).toBe(hostPlatform);
  expect(ev.connectorId).toBe(CONNECTOR_ID);
  expect(ev.toolName).toBe("acme_query");
  expect(ev.toolInput).toEqual({ sql: "SELECT 1" });
}

/** Plant a YAML file at `path` with an unrelated user-authored key (MERGE test). */
function seedUnrelatedYaml(path: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, "user_setting: keep-me\nother:\n  nested: true\n", "utf8");
}

// ── HTTP MCP fixtures ─────────────────────────────────────────────────────────

function httpConnector(transport: Transport): ResolvedConnector {
  return defineConnector({
    id: HTTP_CONNECTOR_ID,
    displayName: "Acme Hermes HTTP",
    version: "1.0.0",
    server:
      transport === "stdio"
        ? { transport, command: "npx", args: ["-y", "@x/y"], tools: { include: ["*"] } }
        : {
            transport,
            url: "https://mcp.acme.example/mcp",
            headers: { Authorization: "Bearer ${env:ACME_TOKEN}" },
            tools: { include: ["*"] },
          },
    telemetry: { enabled: false },
  });
}

function readServers(projectDir: string): Record<string, any> {
  const cfg = readYaml<Record<string, any>>(configPath(projectDir)) ?? {};
  return (cfg.mcp_servers ?? {}) as Record<string, any>;
}

// ── nativeHooks fixtures ────────────────────────────────────────────────────

function readHooks(projectDir: string): Record<string, any[]> {
  const cfg = readYaml<Record<string, any>>(configPath(projectDir)) ?? {};
  return (cfg.hooks ?? {}) as Record<string, any[]>;
}

/** A normalized PreToolUse hook + two hermes-native lifecycle hooks. */
function nativeConnector(): ResolvedConnector {
  return defineConnector({
    id: NATIVE_CONNECTOR_ID,
    displayName: "Acme Hermes",
    version: "1.0.0",
    hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
    platforms: {
      hermes: {
        nativeHooks: {
          pre_llm_call: { handler: () => ({}) },
          transform_tool_result: { matcher: "Shell", handler: () => ({}) },
        },
      },
    },
  });
}

// ── skills fixtures ──────────────────────────────────────────────────────────

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

function buildSkillsConnector(cfg: Partial<ConnectorConfig> = {}): ResolvedConnector {
  return defineConnector({
    id: SKILLS_CONNECTOR_ID,
    displayName: "Acme Hermes Skills",
    version: "1.0.0",
    skills: [skill()],
    ...cfg,
  });
}

// ── extended-events fixtures ──────────────────────────────────────────────────

/** A connector declaring exactly the four E1 extension events. */
function buildExtConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
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

function parseStdout(reply: { exitCode: number; stdout?: string }): any {
  expect(reply.stdout).toBeTruthy();
  return JSON.parse(reply.stdout!);
}

// ── actions fixtures ──────────────────────────────────────────────────────────

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

// ── shared env isolation + the same-rules-for-every-host baseline contract ─────
// extraKeys: the render/round-trip slice mutates the ACME_DB_DSN env-ref var; the
// HTTP MCP slice mutates ACME_TOKEN (resolved to a literal in the header).
isolateEnv([ENV_VAR, "ACME_TOKEN"]);
createAdapterSuite({ adapter: hermesAdapter, paradigm: "json-stdio" });

// ── render + round-trip (mcp_servers + hooks both in ONE config.yaml) ──────────

describe("hermes adapter render + round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave3-hermes-");
    // The env-ref var is set so literal-resolution produces a known value.
    process.env[ENV_VAR] = ENV_LITERAL;
    ctx = buildCtx(projectDir, buildConnector(), "user");
  });

  it('installServer writes ROOT KEY "mcp_servers".<id> into ~/.hermes/config.yaml (YAML, portable command/args/env)', () => {
    const changes = hermesAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".hermes", "config.yaml");
    expect(serverPath).toBe(hermesAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    // The on-disk file is valid YAML (independent parse).
    const cfg = readYamlFile(serverPath);
    expect(cfg).toHaveProperty("mcp_servers");
    expect(cfg).not.toHaveProperty("mcpServers");

    const entry = cfg.mcp_servers[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    // Hermes uses the portable field names (command/args/env), unlike Goose.
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedArgs("hermes"));
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it('installHooks writes the top-level "hooks" map into the SAME config.yaml (YAML, {matcher,command,timeout})', () => {
    const changes = hermesAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const hookPath = join(projectDir, ".hermes", "config.yaml");
    expect(hookPath).toBe(hermesAdapter.getHookConfigPath(ctx));
    expect(existsSync(hookPath)).toBe(true);

    const cfg = readYamlFile(hookPath);
    // Hermes keys its hooks map by NATIVE snake_case event names (pre_tool_call /
    // on_session_start), NOT the canonical PascalCase names; the command keeps
    // the canonical event token so the runtime dispatcher stays consistent.
    const pre = cfg.hooks.pre_tool_call;
    expect(Array.isArray(pre)).toBe(true);
    expect(cfg.hooks.PreToolUse).toBeUndefined();
    expect(pre[0].matcher).toBe(PRE_MATCHER);
    expect(pre[0].command).toContain(HOME_BIN);
    expect(pre[0].command).toContain("hook hermes PreToolUse");
    expect(pre[0].command).toContain(`--connector ${CONNECTOR_ID}`);
    expect(typeof pre[0].timeout).toBe("number");

    // SessionStart is supported and registered under the native on_session_start key.
    expect(cfg.hooks.on_session_start[0].command).toContain("hook hermes SessionStart");
  });

  it("server + hooks coexist in ONE config.yaml; both idempotent; uninstall removes both", () => {
    hermesAdapter.installServer(ctx);
    hermesAdapter.installHooks(ctx);

    const serverPath = join(projectDir, ".hermes", "config.yaml");
    const both = readYamlFile(serverPath);
    expect(both.mcp_servers?.[CONNECTOR_ID]).toBeTruthy();
    expect(both.hooks?.pre_tool_call).toBeTruthy();

    expect(hermesAdapter.installServer(ctx)[0]?.action).toBe("skip");
    expect(hermesAdapter.installHooks(ctx).every((c) => c.action === "skip")).toBe(true);

    // No duplicate entries after the second run.
    const cfg = readYamlFile(serverPath);
    expect(Object.keys(cfg.mcp_servers)).toEqual([CONNECTOR_ID]);
    expect(cfg.hooks.pre_tool_call).toHaveLength(1);
    expect(cfg.hooks.on_session_start).toHaveLength(1);

    hermesAdapter.uninstallServer(ctx);
    const afterServer = readYamlFile(serverPath);
    expect(afterServer.mcp_servers?.[CONNECTOR_ID]).toBeUndefined();
    // Removing the server must not disturb the hooks section.
    expect(afterServer.hooks?.pre_tool_call).toBeTruthy();

    hermesAdapter.uninstallHooks(ctx);
    const afterHooks = readYamlFile(serverPath);
    expect(JSON.stringify(afterHooks.hooks ?? {})).not.toContain(HOME_BIN);
  });

  it("MERGE: a pre-authored unrelated YAML key survives installServer + installHooks", () => {
    const serverPath = join(projectDir, ".hermes", "config.yaml");
    seedUnrelatedYaml(serverPath);

    hermesAdapter.installServer(ctx);
    hermesAdapter.installHooks(ctx);

    const cfg = readYamlFile(serverPath);
    expect(cfg.mcp_servers?.[CONNECTOR_ID]).toBeTruthy();
    expect(cfg.hooks?.pre_tool_call).toBeTruthy();
    // The user's unrelated keys are untouched.
    expect(cfg.user_setting).toBe("keep-me");
    expect(cfg.other).toEqual({ nested: true });
  });

  it("parseEvent yields a normalized PreToolUse; formatReply(deny) → stdout hookSpecificOutput deny, exit 0", () => {
    const ev = hermesAdapter.parseEvent!("PreToolUse", preToolUsePayload()) as PreToolUseEvent;
    assertPreToolUse(ev, "hermes");
    expect(ev.sessionId).toBe("sess-123");

    const reply = hermesAdapter.formatReply!("PreToolUse", {
      decision: "deny",
      reason: "blocked by policy",
    });
    expect(reply.exitCode).toBe(0);
    const out = JSON.parse(reply.stdout!);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("blocked by policy");
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  });
});

// ── remote HTTP MCP (mcp_servers, { url, headers? }, no transport key) ─────────

describe("hermes adapter — remote HTTP MCP", () => {
  beforeEach(() => {
    // The header env-ref resolves to this literal at install time.
    process.env.ACME_TOKEN = "tok-123";
  });

  it("installServer writes a remote HTTP entry { url, headers } (no command/transport key)", () => {
    const projectDir = freshProject("ac-hermes-http-");
    process.env.ACME_TOKEN = "tok-123";
    const changes = hermesAdapter.installServer(
      buildCtx(projectDir, httpConnector("http"), "user"),
    );
    expect(changes[0]?.action).toBe("create");
    const entry = readServers(projectDir)[HTTP_CONNECTOR_ID];
    expect(entry.url).toBe("https://mcp.acme.example/mcp");
    expect(entry.headers.Authorization).toBe("Bearer tok-123"); // env ref resolved to a literal
    expect("command" in entry).toBe(false);
    expect("transport" in entry).toBe(false);
    expect("type" in entry).toBe(false);
  });

  it("a headerless http server renders just { url } (no empty headers key)", () => {
    const projectDir = freshProject("ac-hermes-http-");
    const c = defineConnector({
      id: HTTP_CONNECTOR_ID,
      server: { transport: "http", url: "https://mcp.acme.example/mcp", tools: { include: ["*"] } },
      telemetry: { enabled: false },
    });
    hermesAdapter.installServer(buildCtx(projectDir, c, "user"));
    const entry = readServers(projectDir)[HTTP_CONNECTOR_ID];
    expect(entry.url).toBe("https://mcp.acme.example/mcp");
    expect("headers" in entry).toBe(false);
  });

  it("stdio servers still render as { command, args } (regression)", () => {
    const projectDir = freshProject("ac-hermes-http-");
    hermesAdapter.installServer(buildCtx(projectDir, httpConnector("stdio"), "user"));
    const entry = readServers(projectDir)[HTTP_CONNECTOR_ID];
    expect(entry.command).toBeTruthy();
    expect("url" in entry).toBe(false);
  });

  it("an unsupported transport (sse — Hermes has none) is skip-warned, not written", () => {
    const projectDir = freshProject("ac-hermes-http-");
    const changes = hermesAdapter.installServer(
      buildCtx(projectDir, httpConnector("sse"), "user"),
    );
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toMatch(/transport "sse" not registrable/);
    expect(readServers(projectDir)[HTTP_CONNECTOR_ID]).toBeUndefined();
  });
});

// ── nativeHooks passthrough (host-specific event-name keys, VERBATIM) ──────────

describe("hermes adapter — nativeHooks passthrough", () => {
  it("declares supportsNativeHooks true", () => {
    expect(hermesAdapter.capabilities.supportsNativeHooks).toBe(true);
  });

  it("installHooks files native event-name keys VERBATIM beside the canonical (mapped) hook", () => {
    const projectDir = freshProject("ac-hermes-native-");
    hermesAdapter.installHooks(buildCtx(projectDir, nativeConnector(), "user"));
    const hooks = readHooks(projectDir);

    // Normalized PreToolUse maps to hermes' native pre_tool_call key.
    expect(hooks.pre_tool_call[0].command).toContain("hook hermes PreToolUse");
    // Native keys filed VERBATIM (no EVENT_TO_HERMES mapping).
    expect(hooks.pre_llm_call[0].command).toContain("hook hermes pre_llm_call");
    expect(hooks.pre_llm_call[0].command).toContain(`--connector ${NATIVE_CONNECTOR_ID}`);
    expect(hooks.transform_tool_result[0].command).toContain("hook hermes transform_tool_result");
    expect(hooks.transform_tool_result[0].matcher).toBe("Shell");
  });

  it("is idempotent (second install → skip) and uninstall removes the native entries", () => {
    const projectDir = freshProject("ac-hermes-native-");
    const ctx = buildCtx(projectDir, nativeConnector(), "user");
    hermesAdapter.installHooks(ctx);
    const second = hermesAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    hermesAdapter.uninstallHooks(ctx);
    expect(JSON.stringify(readHooks(projectDir))).not.toContain(HOME_BIN);
  });

  it("nativeHooks install even when normalized hooks are disabled (hooks: false sibling)", () => {
    const projectDir = freshProject("ac-hermes-native-");
    const connector = defineConnector({
      id: NATIVE_CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: { hermes: { hooks: false, nativeHooks: { pre_llm_call: { handler: () => ({}) } } } },
    });
    hermesAdapter.installHooks(buildCtx(projectDir, connector, "user"));
    const hooks = readHooks(projectDir);
    expect(hooks.pre_llm_call[0].command).toContain("hook hermes pre_llm_call");
    expect(hooks.pre_tool_call).toBeUndefined(); // normalized disabled by hooks:false
  });

  it("a native key coinciding with a mapped canonical key does NOT clobber it", () => {
    // Normalized PreToolUse maps to "pre_tool_call"; also declare a native
    // "pre_tool_call" (snake_case — NOT a canonical HookEventName, so defineConnector
    // permits it, unlike kimi where native names can't collide).
    const projectDir = freshProject("ac-hermes-native-");
    const connector = defineConnector({
      id: NATIVE_CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: { hermes: { nativeHooks: { pre_tool_call: { handler: () => ({}) } } } },
    });
    hermesAdapter.installHooks(buildCtx(projectDir, connector, "user"));
    const commands = (readHooks(projectDir).pre_tool_call ?? []).map((e: any) => e.command);
    // BOTH commands coexist (distinct event tokens) — neither was clobbered.
    expect(commands).toHaveLength(2);
    expect(commands.some((c: string) => c.includes("hook hermes PreToolUse"))).toBe(true);
    expect(commands.some((c: string) => c.includes("hook hermes pre_tool_call"))).toBe(true);
  });

  it("uninstall strips only OUR native entries, leaving a foreign hook intact", () => {
    const projectDir = freshProject("ac-hermes-native-");
    const ctx = buildCtx(projectDir, nativeConnector(), "user");
    hermesAdapter.installHooks(ctx);
    // Seed a foreign (non-AC) hook under the same native key our install used.
    const cfg = readYaml<Record<string, any>>(configPath(projectDir))!;
    (cfg.hooks.pre_llm_call as any[]).push({ matcher: "", command: "/usr/bin/other-tool run", timeout: 30 });
    writeYaml(configPath(projectDir), cfg, false);

    hermesAdapter.uninstallHooks(ctx);
    const hooks = readHooks(projectDir);
    // Foreign survives; every AC (HOME_BIN) command is gone.
    expect((hooks.pre_llm_call ?? []).some((e: any) => e.command.includes("other-tool"))).toBe(true);
    expect(JSON.stringify(hooks)).not.toContain(HOME_BIN);
  });
});

// ── skills surface (~/.hermes/skills, user scope only) ─────────────────────────

describe("hermes adapter — skills surface", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-hermes-skills-");
    ctx = buildCtx(projectDir, buildSkillsConnector(), "user");
  });

  it("declares supportsSkills true", () => {
    expect(hermesAdapter.capabilities.supportsSkills).toBe(true);
  });

  it("installSkills (user scope) writes ~/.hermes/skills/<n>/SKILL.md with correct frontmatter", () => {
    const changes = hermesAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.platform).toBe("hermes");

    // HOME redirected to projectDir → ~/.hermes === projectDir/.hermes
    const skillMd = join(projectDir, ".hermes", "skills", "pdf-tools", "SKILL.md");
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

  it("installSkills (user scope) writes resource files beside SKILL.md", () => {
    hermesAdapter.installSkills!(ctx);
    const resource = join(projectDir, ".hermes", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills (project scope) skip-warns — no hermes-owned project skills dir", () => {
    const projCtx = buildCtx(projectDir, buildSkillsConnector(), "project");
    const changes = hermesAdapter.installSkills!(projCtx);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("user-scope only");
    // Nothing was written anywhere.
    expect(existsSync(join(projectDir, ".hermes", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("installSkills is idempotent — second call yields skip", () => {
    hermesAdapter.installSkills!(ctx);
    const second = hermesAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource, and the empty skill dir", () => {
    hermesAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".hermes", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".hermes", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);

    const changes = hermesAdapter.uninstallSkills!(ctx);
    expect(changes.every((c) => c.platform === "hermes")).toBe(true);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(resource)).toBe(false);
    expect(existsSync(join(projectDir, ".hermes", "skills", "pdf-tools"))).toBe(false);
  });

  it("skips-warns when the skills path is a FILE (no ENOTDIR crash)", () => {
    // Plant ~/.hermes/skills as a regular FILE where we need a directory.
    const skillsDir = join(projectDir, ".hermes", "skills");
    mkdirSync(dirname(skillsDir), { recursive: true });
    writeFileSync(skillsDir, "not a dir", "utf8");

    const changes = hermesAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("is a file, not a directory");
    expect(existsSync(join(skillsDir, "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("honors platforms['hermes'].skills === false", () => {
    const disabled = defineConnector({
      id: SKILLS_CONNECTOR_ID,
      skills: [skill()],
      platforms: { hermes: { skills: false } },
    });
    const c2 = buildCtx(projectDir, disabled, "user");
    const changes = hermesAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".hermes", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("installSkills with no skills declared returns skip", () => {
    const noSkills = defineConnector({ id: SKILLS_CONNECTOR_ID, memory: [{ content: "placeholder" }] });
    const c2 = buildCtx(projectDir, noSkills, "user");
    const changes = hermesAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
  });
});

// ── actions emitter (quick_commands.<id>: { type: "exec", command }) ───────────

describe("hermes — actions emitter", () => {
  let tmpHome: string;
  let tmpProject: string;

  const cfgPath = () => join(tmpHome, ".hermes", "config.yaml");

  function readCfg(): Record<string, unknown> {
    return parseYaml(readFileSync(cfgPath(), "utf8")) as Record<string, unknown>;
  }

  // The actions slice uses a SEPARATE home + project dir (HOME != projectDir) so
  // the user-scope quick_commands write and the project dir stay distinct.
  function actionsCtx(connector: ResolvedConnector, scope: "project" | "user"): InstallContext {
    return buildCtx(tmpProject, connector, {
      scope,
      homeBinPath: HOME_BIN,
      dataRoot: join(tmpHome, ".agent-connector"),
    });
  }

  beforeEach(() => {
    tmpHome = freshProject("ac-actemit-home-");
    tmpProject = mkdtempSync(join(tmpdir(), "ac-actemit-proj-"));
  });

  it("advertises supportsActions", () => {
    expect(hermesAdapter.capabilities.supportsActions).toBe(true);
  });

  it("installActions writes quick_commands.<id> exec entries with the action verb", () => {
    const ctx = actionsCtx(actionsConnector([DEPLOY, ROLLBACK]), "user");
    const changes = hermesAdapter.installActions!(ctx);
    expect(changes.every((c) => c.platform === "hermes")).toBe(true);
    expect(changes.map((c) => c.action)).toEqual(["create", "create"]);

    const qc = readCfg().quick_commands as Record<string, unknown>;
    expect(qc.deploy).toEqual({ type: "exec", command: verb("hermes", "deploy") });
    expect(qc.rollback).toEqual({ type: "exec", command: verb("hermes", "rollback") });
  });

  it("is idempotent (a second install reports skip, bytes unchanged)", () => {
    const ctx = actionsCtx(actionsConnector([DEPLOY]), "user");
    hermesAdapter.installActions!(ctx);
    const before = readFileSync(cfgPath(), "utf8");
    const changes = hermesAdapter.installActions!(ctx);
    expect(changes.every((c) => c.action === "skip")).toBe(true);
    expect(readFileSync(cfgPath(), "utf8")).toBe(before);
  });

  it("MERGE-preserves a foreign quick_commands entry and unrelated user keys", () => {
    // Seed a config with a foreign quick_command + an unrelated top-level key.
    mkdirSync(dirname(cfgPath()), { recursive: true });
    writeFileSync(
      cfgPath(),
      "model: nous-hermes\nquick_commands:\n  mine:\n    type: exec\n    command: echo hi\n",
      "utf8",
    );
    const ctx = actionsCtx(actionsConnector([DEPLOY]), "user");
    hermesAdapter.installActions!(ctx);

    const cfg = readCfg();
    expect(cfg.model).toBe("nous-hermes");
    const qc = cfg.quick_commands as Record<string, unknown>;
    expect(qc.mine).toEqual({ type: "exec", command: "echo hi" });
    expect(qc.deploy).toEqual({ type: "exec", command: verb("hermes", "deploy") });
  });

  it("skip-warns when quick_commands.<id> exists and is NOT ours", () => {
    mkdirSync(dirname(cfgPath()), { recursive: true });
    writeFileSync(
      cfgPath(),
      "quick_commands:\n  deploy:\n    type: exec\n    command: my-own-deploy.sh\n",
      "utf8",
    );
    const ctx = actionsCtx(actionsConnector([DEPLOY]), "user");
    const changes = hermesAdapter.installActions!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("warn");
    expect(changes[0]!.detail).toContain("not ours");
    // The user's entry is untouched.
    const qc = readCfg().quick_commands as Record<string, unknown>;
    expect(qc.deploy).toEqual({ type: "exec", command: "my-own-deploy.sh" });
  });

  it("uninstallActions removes ONLY our entries, leaving foreign ones + the map", () => {
    mkdirSync(dirname(cfgPath()), { recursive: true });
    writeFileSync(
      cfgPath(),
      "quick_commands:\n  mine:\n    type: exec\n    command: echo hi\n",
      "utf8",
    );
    const ctx = actionsCtx(actionsConnector([DEPLOY]), "user");
    hermesAdapter.installActions!(ctx);
    const changes = hermesAdapter.uninstallActions!(ctx);
    expect(changes.some((c) => c.action === "remove")).toBe(true);

    const qc = readCfg().quick_commands as Record<string, unknown>;
    expect(qc.mine).toEqual({ type: "exec", command: "echo hi" });
    expect(qc.deploy).toBeUndefined();
  });

  it("uninstallActions drops the map when no entries remain", () => {
    const ctx = actionsCtx(actionsConnector([DEPLOY]), "user");
    hermesAdapter.installActions!(ctx);
    hermesAdapter.uninstallActions!(ctx);
    expect(readCfg().quick_commands).toBeUndefined();
  });

  it("honors platforms.hermes.actions === false (opt-out, never writes)", () => {
    const ctx = actionsCtx(actionsConnector([DEPLOY], { hermes: { actions: false } }), "user");
    const changes = hermesAdapter.installActions!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toContain("disabled for hermes");
    expect(existsSync(cfgPath())).toBe(false);
  });

  it("skips silently when no actions are declared", () => {
    const ctx = actionsCtx(
      defineConnector({ id: ACTIONS_CONNECTOR_ID, commands: [{ name: "n", prompt: "p" }] }),
      "user",
    );
    const changes = hermesAdapter.installActions!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe("skip");
    expect(changes[0]!.detail).toContain("declares no actions");
  });
});

// ── extended events (E1): subagent_stop only; observe-only approvals warn-skip ──
// NOTE: hermes writes native snake_case keys to YAML and tests parse/format
// directly — it never imports a generated plugin or spawns, so (unlike openclaw)
// it does NOT depend on a node:child_process mock; none is needed here.

describe("hermes — extended-event install", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-ext-events2-hermes-");
    ctx = buildCtx(projectDir, buildExtConnector(), "user");
  });

  it("registers the native snake_case 'subagent_stop' key with the agent matcher; the other three warn-skip", () => {
    const changes = hermesAdapter.installHooks(ctx);

    const cfgFile = join(projectDir, ".hermes", "config.yaml");
    expect(existsSync(cfgFile)).toBe(true);
    const cfg = readYaml<Record<string, any>>(cfgFile)!;

    const bucket = cfg.hooks.subagent_stop;
    expect(Array.isArray(bucket)).toBe(true);
    expect(bucket[0].matcher).toBe(AGENT_MATCHER);
    // The command keeps the CANONICAL event token; only the YAML key is native.
    expect(bucket[0].command).toContain("hook hermes SubagentStop");
    expect(cfg.hooks.SubagentStop).toBeUndefined();

    // PermissionRequest is the deliberate exclusion: pre_approval_request is
    // observe-only (no decision control), so the event warn-skips — as do
    // PostToolUseFailure (merged into post_tool_call) and SubagentStart.
    for (const event of ["PermissionRequest", "PostToolUseFailure", "SubagentStart"]) {
      const warn = changes.find((c) => c.action === "warn" && c.detail?.includes(event));
      expect(warn).toBeTruthy();
      expect(warn!.detail).toContain("no Hermes hook equivalent");
    }
  });
});

describe("hermes — extended-event parse + replies", () => {
  const COMMON = { session_id: "sess-1", cwd: "/home/dev/acme" };

  it("SubagentStop maps agent fields (child_id fallback) and tolerates missing agent_type", () => {
    const evt = hermesAdapter.parseEvent!("SubagentStop", {
      ...COMMON,
      agent_id: "agent-7",
      agent_type: "code-reviewer",
      last_assistant_message: "done",
    }) as SubagentStopEvent;
    expect(evt.hostPlatform).toBe("hermes");
    expect(evt.agentId).toBe("agent-7");
    expect(evt.agentType).toBe("code-reviewer");
    expect(evt.lastAssistantMessage).toBe("done");

    // Hermes-native child_* names: child_id backs agentId; child_status stays
    // accessible via raw.
    const native = hermesAdapter.parseEvent!("SubagentStop", {
      ...COMMON,
      child_id: "child-3",
      child_status: "completed",
    }) as SubagentStopEvent;
    expect(native.agentId).toBe("child-3");
    expect(native.agentType).toBeUndefined();
    expect((native.raw as any).child_status).toBe("completed");
  });

  it("PermissionRequest / PostToolUseFailure / SubagentStart throw (no decision-capable analog)", () => {
    for (const event of ["PermissionRequest", "PostToolUseFailure", "SubagentStart"] as const) {
      expect(() => hermesAdapter.parseEvent!(event, COMMON)).toThrow(
        /unsupported hermes hook event/,
      );
    }
  });

  it("SubagentStop deny → TOP-LEVEL {decision:'block', reason}; PreToolUse deny is unchanged (regression guard)", () => {
    const subagent = parseStdout(
      hermesAdapter.formatReply!("SubagentStop", { decision: "deny", reason: "keep going" }),
    );
    expect(subagent).toEqual({ decision: "block", reason: "keep going" });
    expect(subagent.hookSpecificOutput).toBeUndefined();

    const pre = parseStdout(
      hermesAdapter.formatReply!("PreToolUse", { decision: "deny", reason: "nope" }),
    );
    expect(pre.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

// ── native event-name regression (review-fixes) ───────────────────────────────

describe("hermes native event names", () => {
  it("installHooks writes the native 'pre_tool_call' key, NOT 'PreToolUse'", () => {
    const projectDir = freshProject("ac-rf-hermes-");
    const ctx = buildCtx(projectDir, buildConnector(), "user");

    hermesAdapter.installHooks(ctx);
    const raw = readFileSync(hermesAdapter.getHookConfigPath(ctx), "utf8");
    expect(raw).toContain("pre_tool_call");
    expect(raw).toContain("on_session_start");
    // The canonical PascalCase key must NOT appear as a hooks-map key.
    expect(raw).not.toMatch(/^\s*PreToolUse:/m);
    // The command itself still carries the canonical event token (YAML may wrap
    // long scalars across lines, so compare with whitespace collapsed).
    const collapsed = raw.replace(/\s+/g, " ");
    expect(collapsed).toContain("hook hermes PreToolUse");
    expect(collapsed).toContain("hook hermes SessionStart");
  });
});
