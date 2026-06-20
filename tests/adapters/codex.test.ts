/**
 * adapters/codex.test.ts — the ONE per-host file for the Codex CLI adapter.
 *
 * codex is a json-stdio host (same wire protocol as Claude Code: PascalCase
 * events, `hookSpecificOutput` reply wrapper). Config surfaces:
 *   • MCP servers → <configDir>/config.toml, TABLE [mcp_servers.<id>] (TOML, NO
 *                   native interpolation → env-refs resolve to LITERALS at install
 *                   time); stdio as { command, args, env }, streamable-HTTP as
 *                   { url, bearer_token_env_var?, http_headers? } (transport
 *                   inferred from `url`, no explicit transport key).
 *   • Hooks       → <configDir>/hooks.json, Claude-compatible { matcher, hooks:[
 *                   { type:"command", command } ] } per PascalCase event.
 *   • Content     → command  → ~/.codex/prompts/<name>.md md+fm, USER SCOPE ONLY
 *                              (project scope → single warn);
 *                   skill    → project: <projectDir>/.codex/skills/<name>/SKILL.md ·
 *                              user: ~/.agents/skills/<name>/SKILL.md (the older
 *                              ~/.codex/skills is deprecated-but-still-read);
 *                   subagent → <configDir>/agents/<name>.toml (TOML).
 *   • config dir  → user scope: $CODEX_HOME || ~/.codex; project: <projectDir>/.codex.
 *   • Reply       → JSON on stdout (exit 0): PreToolUse deny → permissionDecision;
 *                   PreToolUse modify → permissionDecision:"allow" + updatedInput
 *                   (Codex requires the pair; stable since 0.131.0);
 *                   SessionStart/PostToolUse/PreToolUse context → additionalContext;
 *                   PermissionRequest uses the nested decision{behavior} envelope
 *                   (modify/ask fall through — Codex fails CLOSED on updatedInput
 *                   for PermissionRequest specifically);
 *                   SubagentStart context/deny → additionalContext; SubagentStop
 *                   deny → TOP-LEVEL { decision:"block" }; PostCompact observe-only.
 *
 * This file consolidates what used to be split across codex-http-mcp.test.ts
 * (remote streamable-HTTP MCP), codex-skills.test.ts (skills surface),
 * extended-events-hosts.test.ts (E1 events + PostCompact), render.test.ts
 * (render/round-trip), and surfaces-s1.test.ts (content surfaces). It uses the
 * shared harness (tests/support/env + adapter-suite + fs) per tests/README.md —
 * ONE file per host. config.toml / agent.toml are parsed with @iarna/toml (the
 * source's choice — readJson is JSON only); JSON files use readJson.
 */

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import TOML from "@iarna/toml";
import { beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  ConnectorConfig,
  PermissionRequestEvent,
  PostCompactEvent,
  PostToolUseEvent,
  ResolvedConnector,
  ServerDef,
  SubagentStopEvent,
  Transport,
} from "../../src/core/types.js";

import codexAdapter from "../../src/adapters/codex/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson, splitFrontmatter } from "../support/fs.js";

// ── shared fixtures ──────────────────────────────────────────────────────────

// render/round-trip + E1 slices share the canonical "acme-db" id.
const CONNECTOR_ID = "acme-db";
// render's env-ref → TOML literal resolution.
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
// remote-HTTP slice uses its own id + bearer-token env var.
const HTTP_CONNECTOR_ID = "acme-codex-http";
// skills slice uses its own id.
const SKILLS_CONNECTOR_ID = "acme-codex-skills";
// content-surfaces slice uses its own id + fixtures.
const SURFACES_CONNECTOR_ID = "acme-surfaces";

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

// The skills slice's SKILL fixture has a slightly different description string.
const SKILLS_SKILL = {
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

/** render: a stdio server (env-ref) + a PreToolUse and SessionStart hook. */
function buildRenderConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
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
      SessionStart: {
        handler() {
          return { decision: "context", additionalContext: "hello" };
        },
      },
    },
  });
}

/** remote-HTTP: a server-only connector with telemetry off. */
function connectorWith(server: ServerDef): ResolvedConnector {
  return defineConnector({
    id: HTTP_CONNECTOR_ID,
    displayName: "Acme Codex HTTP",
    version: "1.0.0",
    server,
    telemetry: { enabled: false },
  });
}

function readHttpServers(projectDir: string, c: ResolvedConnector): Record<string, any> {
  const path = codexAdapter.getServerConfigPath!(buildCtx(projectDir, c, "user"));
  const cfg = TOML.parse(readFileSync(path, "utf8")) as Record<string, any>;
  return (cfg.mcp_servers ?? {}) as Record<string, any>;
}

/** E1: a hooks-only connector declaring ALL FOUR E1 events (plus PreToolUse). */
function buildE1Connector(id = CONNECTOR_ID): ResolvedConnector {
  return defineConnector({
    id,
    hooks: {
      PreToolUse: {
        handler() {
          return { decision: "allow" };
        },
      },
      PermissionRequest: {
        matcher: "Bash",
        handler() {
          return { decision: "ask" };
        },
      },
      PostToolUseFailure: {
        handler() {
          return { decision: "context", additionalContext: "failure noted" };
        },
      },
      SubagentStart: {
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

/** E1: a connector declaring ONLY one hook event (single-event install path). */
function buildSingleEventConnector(
  id: string,
  event: "PostToolUseFailure" | "PermissionRequest",
): ResolvedConnector {
  return defineConnector({
    id,
    hooks: {
      [event]: {
        handler() {
          return undefined;
        },
      },
    },
  });
}

/** PostCompact: a connector declaring both PreCompact and PostCompact. */
function buildCompactionConnector(id = "acme-compact"): ResolvedConnector {
  return defineConnector({
    id,
    hooks: {
      PreCompact: {
        handler() {
          return {};
        },
      },
      PostCompact: {
        handler() {
          return {};
        },
      },
    },
  });
}

/** skills: the skills-slice SKILL fixture, deep-cloned. */
function skillsSkill() {
  return {
    ...SKILLS_SKILL,
    tools: { allow: [...SKILLS_SKILL.tools.allow] },
    resources: { ...SKILLS_SKILL.resources },
  };
}

/** skills: a connector declaring exactly the skills-slice skill. */
function buildSkillsConnector(cfg: Partial<ConnectorConfig> = {}): ResolvedConnector {
  return defineConnector({
    id: SKILLS_CONNECTOR_ID,
    displayName: "Acme Codex Skills",
    version: "1.0.0",
    skills: [skillsSkill()],
    ...cfg,
  });
}

/** surfaces: a connector declaring a command + skill (resource) + subagent. */
function buildSurfacesConnector(): ResolvedConnector {
  return defineConnector({
    id: SURFACES_CONNECTOR_ID,
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

// ── local helpers ────────────────────────────────────────────────────────────

function readToml(path: string): Record<string, any> {
  return TOML.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

function parsed(reply: { stdout?: string }): Record<string, any> {
  return JSON.parse(reply.stdout ?? "{}");
}

// Shared env isolation + the same-rules-for-every-host baseline contract.
// extraKeys: CODEX_HOME (skills + content-surface scope resolution), ACME_DB_DSN
// (render's ${env:VAR} → TOML literal), ACME_TOKEN (remote-HTTP header/bearer
// resolution). HOME/USERPROFILE/AGENT_CONNECTOR_DATA_DIR are isolateEnv defaults.
isolateEnv(["CODEX_HOME", ENV_VAR, "ACME_TOKEN"]);
createAdapterSuite({ adapter: codexAdapter, paradigm: "json-stdio" });

// ── render + round-trip (config.toml TOML table + hooks.json) ─────────────────

describe("codex adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-render-codex-");
    // Set the env-ref var so codex literal-resolution produces a known value.
    process.env[ENV_VAR] = ENV_LITERAL;
    ctx = buildCtx(projectDir, buildRenderConnector());
  });

  it("installServer writes [mcp_servers.<id>] TOML table, wrapped for telemetry, env as a LITERAL (no native interpolation)", () => {
    const changes = codexAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const tomlPath = join(projectDir, ".codex", "config.toml");
    expect(tomlPath).toBe(codexAdapter.getServerConfigPath(ctx));
    expect(existsSync(tomlPath)).toBe(true);

    const cfg = TOML.parse(readFileSync(tomlPath, "utf8")) as any;
    expect(cfg.mcp_servers).toBeTruthy();
    const entry = cfg.mcp_servers[CONNECTOR_ID];
    expect(entry).toBeTruthy();

    // Serve-wrapper points at the home binary.
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual([
      "serve",
      "--connector",
      CONNECTOR_ID,
      "--scope",
      "project",
      "--host",
      "codex",
      "--",
      "npx",
      "-y",
      "@x/y",
    ]);

    // TOML cannot interpolate → the env-ref is resolved to a LITERAL value.
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installServer warn-skips a symlinked config.toml without touching the target", () => {
    const tomlPath = join(projectDir, ".codex", "config.toml");
    const outside = join(projectDir, "outside-config.toml");
    const before = "[outside]\nkeep = true\n";
    mkdirSync(join(projectDir, ".codex"), { recursive: true });
    writeFileSync(outside, before, "utf8");
    symlinkSync(outside, tomlPath);

    const changes = codexAdapter.installServer(ctx);

    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.path).toBe(tomlPath);
    expect(changes[0]?.detail).toMatch(/symbolic link/i);
    expect(readFileSync(outside, "utf8")).toBe(before);
  });

  it("installHooks writes hooks.json entries referencing the home binary + codex platform token", () => {
    const changes = codexAdapter.installHooks(ctx);
    expect(changes.length).toBeGreaterThan(0);

    const hooksPath = join(projectDir, ".codex", "hooks.json");
    expect(hooksPath).toBe(codexAdapter.getHookConfigPath(ctx));

    const cfg = readJson(hooksPath);
    const pre = cfg.hooks.PreToolUse;
    expect(Array.isArray(pre)).toBe(true);
    const cmd = pre[0].hooks[0].command;
    expect(cmd).toContain(HOME_BIN);
    expect(cmd).toContain("hook codex PreToolUse");
    expect(cmd).toContain(`--connector ${CONNECTOR_ID}`);
    // PreToolUse carries the charset-clean Codex matcher.
    expect(pre[0].matcher).toContain("mcp__");

    // SessionStart is registered too (it is in CODEX_HOOK_EVENTS).
    expect(cfg.hooks.SessionStart[0].hooks[0].command).toContain(
      "hook codex SessionStart",
    );
  });

  it("installServer is idempotent — second call yields skip, no duplicate table", () => {
    codexAdapter.installServer(ctx);
    const second = codexAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = TOML.parse(
      readFileSync(join(projectDir, ".codex", "config.toml"), "utf8"),
    ) as any;
    expect(Object.keys(cfg.mcp_servers)).toEqual([CONNECTOR_ID]);
  });

  it("installHooks is idempotent — second call yields skip and does not duplicate entries", () => {
    codexAdapter.installHooks(ctx);
    const second = codexAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    const cfg = readJson(join(projectDir, ".codex", "hooks.json"));
    expect(cfg.hooks.PreToolUse).toHaveLength(1);
    expect(cfg.hooks.SessionStart).toHaveLength(1);
  });

  // ── PINNED detail strings (hook-engine migration safety net) ──────────────
  // codex hook install/uninstall emit DIVERGENT detail strings vs other hosts;
  // these exact-match assertions characterize the CURRENT behavior so a future
  // hook-engine migration must reproduce them byte-identically.
  it("installHooks: create detail is the bare `hooks.<event>` form", () => {
    const changes = codexAdapter.installHooks(ctx);
    const pre = changes.find((c) => c.detail?.startsWith("hooks.PreToolUse"));
    expect(pre?.action).toBe("create");
    // Bare event form — NOT "hooks.PreToolUse created" or similar.
    expect(pre?.detail).toBe("hooks.PreToolUse");
    const sess = changes.find((c) => c.detail?.startsWith("hooks.SessionStart"));
    expect(sess?.detail).toBe("hooks.SessionStart");
  });

  it("installHooks idempotent skip detail is the BARE `hooks.<event>` (no 'already registered')", () => {
    codexAdapter.installHooks(ctx);
    const second = codexAdapter.installHooks(ctx);
    const pre = second.find((c) => c.detail?.includes("PreToolUse"));
    expect(pre?.action).toBe("skip");
    // Codex does NOT append "already registered" — bare event form is the pin.
    expect(pre?.detail).toBe("hooks.PreToolUse");
    expect(pre?.detail).not.toContain("already registered");
  });

  it("installHooks with NO hooks declared → single skip detail `no hooks declared`", () => {
    const noHooks = defineConnector({
      id: CONNECTOR_ID,
      server: { transport: "stdio", command: "npx", args: ["-y", "@x/y"], tools: { include: ["*"] } },
    });
    const changes = codexAdapter.installHooks(buildCtx(projectDir, noHooks));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    // Exact wording — NOT "connector declares no hooks".
    expect(changes[0]?.detail).toBe("no hooks declared");
  });

  it("uninstallHooks with no hooks.json present → skip detail `no hooks.json`", () => {
    const changes = codexAdapter.uninstallHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toBe("no hooks.json");
  });

  it("uninstallHooks removing our entries → remove detail is the BARE `hooks.<event>` (no count)", () => {
    codexAdapter.installHooks(ctx);
    const changes = codexAdapter.uninstallHooks(ctx);
    const pre = changes.find((c) => c.detail?.includes("PreToolUse"));
    expect(pre?.action).toBe("remove");
    // Codex does NOT include a `(<n>)` count — bare event form is the pin.
    expect(pre?.detail).toBe("hooks.PreToolUse");
    expect(pre?.detail).not.toMatch(/\(\d+\)/);
  });

  it("uninstallHooks when hooks.json has none of ours → skip detail `no agent-connector hooks present`", () => {
    // Seed a hooks.json with only a foreign hook (no AC home-bin command).
    mkdirSync(join(projectDir, ".codex"), { recursive: true });
    writeFileSync(
      join(projectDir, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "/usr/bin/other run" }] }],
        },
      }),
      "utf8",
    );
    const changes = codexAdapter.uninstallHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toBe("no agent-connector hooks present");
  });

  it("uninstallServer + uninstallHooks remove the entries (re-read confirms gone)", () => {
    codexAdapter.installServer(ctx);
    codexAdapter.installHooks(ctx);

    codexAdapter.uninstallServer(ctx);
    const cfg = TOML.parse(
      readFileSync(join(projectDir, ".codex", "config.toml"), "utf8"),
    ) as any;
    expect(cfg.mcp_servers?.[CONNECTOR_ID]).toBeUndefined();

    codexAdapter.uninstallHooks(ctx);
    const hooks = readJson(join(projectDir, ".codex", "hooks.json"));
    expect(JSON.stringify(hooks.hooks ?? {})).not.toContain(HOME_BIN);
  });

  it("parseEvent + formatReply round-trip: PreToolUse deny → native hookSpecificOutput", () => {
    const evt = codexAdapter.parseEvent!("PreToolUse", {
      tool_name: "acme_write",
      tool_input: { sql: "DROP" },
      cwd: projectDir,
      session_id: "cx-1",
    });
    expect(evt).toMatchObject({
      hostPlatform: "codex",
      toolName: "acme_write",
      toolInput: { sql: "DROP" },
      sessionId: "cx-1",
    });

    const reply = codexAdapter.formatReply!("PreToolUse", {
      decision: "deny",
      reason: "blocked",
    });
    expect(reply.exitCode).toBe(0);
    const out = JSON.parse(reply.stdout!);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("blocked");
  });

  // ── PostToolUse hook-stdin wire contract (primary-source verified) ────────
  // Codex serializes PostToolUseCommandInput (#[serde(deny_unknown_fields)]):
  // it has NO top-level is_error, and tool_response is serde_json::Value — a
  // bare STRING for shell/apply_patch but an OBJECT for MCP tools. These guard
  // against the false-friend reads (top-level is_error; tool_response-as-string).
  // Source: openai/codex codex-rs/hooks/src/schema.rs PostToolUseCommandInput
  // (no is_error; tool_response:Value) + core/src/tools/handlers/{mcp.rs,shell_tests.rs}.

  it("parseEvent PostToolUse: shell tool_response is a bare string → toolOutput verbatim, isError false", () => {
    const evt = codexAdapter.parseEvent!("PostToolUse", {
      tool_name: "shell",
      tool_input: { command: "ls" },
      tool_response: "shell output",
      cwd: projectDir,
      session_id: "cx-pt-shell",
    }) as PostToolUseEvent;
    expect(evt.toolName).toBe("shell");
    expect(evt.toolOutput).toBe("shell output");
    // shell carries no boolean error signal in tool_response → false.
    expect(evt.isError).toBe(false);
  });

  it("parseEvent PostToolUse: MCP tool_response is an OBJECT → JSON-stringified into toolOutput (never a raw object)", () => {
    const responseObj = {
      content: [{ type: "text", text: "notes" }],
      structuredContent: { bytes: 5 },
    };
    const evt = codexAdapter.parseEvent!("PostToolUse", {
      tool_name: "mcp__filesystem__read_file",
      tool_input: { path: "/tmp/notes.txt" },
      tool_response: responseObj,
      cwd: projectDir,
      session_id: "cx-pt-mcp",
    }) as PostToolUseEvent;
    // toolOutput is typed string — an object MUST be coerced, not passed raw.
    expect(typeof evt.toolOutput).toBe("string");
    expect(evt.toolOutput).toBe(JSON.stringify(responseObj));
    expect(evt.isError).toBe(false);
  });

  it("parseEvent PostToolUse: isError derives from the NESTED CallToolResult.isError, not a top-level is_error", () => {
    const failing = codexAdapter.parseEvent!("PostToolUse", {
      tool_name: "mcp__db__query",
      tool_input: {},
      tool_response: { content: [{ type: "text", text: "boom" }], isError: true },
      session_id: "cx-pt-err",
    }) as PostToolUseEvent;
    expect(failing.isError).toBe(true);

    const ok = codexAdapter.parseEvent!("PostToolUse", {
      tool_name: "mcp__db__query",
      tool_input: {},
      tool_response: { content: [], isError: false },
      session_id: "cx-pt-ok",
    }) as PostToolUseEvent;
    expect(ok.isError).toBe(false);
  });

  it("parseEvent PostToolUse: a top-level is_error is IGNORED (dead read removed — host never emits it)", () => {
    // The host's deny_unknown_fields struct can't carry is_error; were it ever
    // present (or hand-forged), the adapter must NOT resurrect the old read.
    const evt = codexAdapter.parseEvent!("PostToolUse", {
      tool_name: "shell",
      tool_input: {},
      tool_response: "ok",
      // is_error is not part of the Codex wire (deny_unknown_fields). A forged
      // top-level flag must be ignored — the dead read must not resurface.
      is_error: true,
      session_id: "cx-pt-deadread",
    }) as PostToolUseEvent;
    // tool_response carries no nested isError → false, despite the bogus top-level flag.
    expect(evt.isError).toBe(false);
  });

  it("parseEvent PostToolUse: missing tool_response → toolOutput undefined, isError false (no invented signal)", () => {
    const evt = codexAdapter.parseEvent!("PostToolUse", {
      tool_name: "apply_patch",
      tool_input: {},
      session_id: "cx-pt-empty",
    }) as PostToolUseEvent;
    expect(evt.toolOutput).toBeUndefined();
    expect(evt.isError).toBe(false);
  });

  it("capability: canModifyArgs is true (updatedInput rewrite shipped upstream), canModifyOutput stays false", () => {
    expect(codexAdapter.capabilities.canModifyArgs).toBe(true);
    expect(codexAdapter.capabilities.canModifyOutput).toBe(false);
  });

  it("formatReply: PreToolUse modify → permissionDecision:'allow' PAIRED with updatedInput", () => {
    const reply = codexAdapter.formatReply!("PreToolUse", {
      decision: "modify",
      updatedInput: { command: "ls", limit: 50 },
    });
    expect(reply.exitCode).toBe(0);
    const out = JSON.parse(reply.stdout!);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    // Codex's output_parser.rs rejects updatedInput unless paired with allow.
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.updatedInput).toEqual({ command: "ls", limit: 50 });
  });

  it("formatReply: PreToolUse modify WITHOUT updatedInput → passthrough (no bare allow)", () => {
    // A bare allow without updatedInput is itself invalid on Codex; emit nothing.
    const reply = codexAdapter.formatReply!("PreToolUse", { decision: "modify" });
    expect(reply.exitCode).toBe(0);
    expect(reply.stdout).toBeUndefined();
  });

  it("formatReply: PreToolUse context → additionalContext (PR #20692, stable since 0.130.0)", () => {
    const reply = codexAdapter.formatReply!("PreToolUse", {
      decision: "context",
      additionalContext: "budget: cap reads at 50 lines",
    });
    const out = JSON.parse(reply.stdout!);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.additionalContext).toBe("budget: cap reads at 50 lines");
  });

  it("formatReply: SessionStart context → additionalContext native wrapper", () => {
    const evt = codexAdapter.parseEvent!("SessionStart", {
      source: "startup",
      cwd: projectDir,
      session_id: "cx-2",
    });
    expect(evt).toMatchObject({ hostPlatform: "codex", source: "startup" });

    const reply = codexAdapter.formatReply!("SessionStart", {
      decision: "context",
      additionalContext: "codex ctx",
    });
    const out = JSON.parse(reply.stdout!);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toBe("codex ctx");
  });

  it("formatReply: ask is unsupported on Codex → passthrough (no stdout decision)", () => {
    const reply = codexAdapter.formatReply!("PreToolUse", {
      decision: "ask",
      reason: "confirm",
    });
    // Codex does not honor ask; it fails open (exit 0, no permission payload).
    expect(reply.exitCode).toBe(0);
    expect(reply.stdout).toBeUndefined();
  });
});

// ── remote streamable-HTTP MCP (config.toml { url, … }, no transport key) ─────

describe("codex adapter — remote streamable-HTTP MCP", () => {
  // Each test sets up its own fresh project dir (the original http-mcp file had
  // no shared beforeEach); ACME_TOKEN is set where a bearer/header env-ref needs it.
  it("installServer writes a streamable-HTTP entry { url, bearer_token_env_var } (no command/transport key)", () => {
    const projectDir = freshProject("ac-codex-http-");
    process.env.ACME_TOKEN = "tok-123";
    const c = connectorWith({
      transport: "http",
      url: "https://mcp.acme.example/mcp",
      auth: { type: "bearerEnv", bearerEnvVar: "ACME_TOKEN" },
      tools: { include: ["*"] },
    });
    const changes = codexAdapter.installServer(buildCtx(projectDir, c, "user"));
    expect(changes[0]?.action).toBe("create");
    const entry = readHttpServers(projectDir, c)[HTTP_CONNECTOR_ID];
    expect(entry.url).toBe("https://mcp.acme.example/mcp");
    expect(entry.bearer_token_env_var).toBe("ACME_TOKEN");
    expect("command" in entry).toBe(false);
    expect("transport" in entry).toBe(false);
    expect("type" in entry).toBe(false);
  });

  it("http headers render as http_headers with env refs resolved to literals", () => {
    const projectDir = freshProject("ac-codex-http-");
    process.env.ACME_TOKEN = "tok-123";
    const c = connectorWith({
      transport: "http",
      url: "https://mcp.acme.example/mcp",
      headers: { "X-Acme": "Bearer ${env:ACME_TOKEN}" },
      tools: { include: ["*"] },
    });
    codexAdapter.installServer(buildCtx(projectDir, c, "user"));
    const entry = readHttpServers(projectDir, c)[HTTP_CONNECTOR_ID];
    expect(entry.http_headers["X-Acme"]).toBe("Bearer tok-123");
    expect("bearer_token_env_var" in entry).toBe(false);
  });

  it("a bare http server renders just { url } (no empty headers/bearer keys)", () => {
    const projectDir = freshProject("ac-codex-http-");
    const c = connectorWith({ transport: "http", url: "https://mcp.acme.example/mcp", tools: { include: ["*"] } });
    codexAdapter.installServer(buildCtx(projectDir, c, "user"));
    const entry = readHttpServers(projectDir, c)[HTTP_CONNECTOR_ID];
    expect(entry.url).toBe("https://mcp.acme.example/mcp");
    expect("http_headers" in entry).toBe(false);
    expect("bearer_token_env_var" in entry).toBe(false);
  });

  it("stdio servers still render as { command, args } (regression)", () => {
    const projectDir = freshProject("ac-codex-http-");
    const c = connectorWith({ transport: "stdio", command: "npx", args: ["-y", "@x/y"], tools: { include: ["*"] } });
    codexAdapter.installServer(buildCtx(projectDir, c, "user"));
    const entry = readHttpServers(projectDir, c)[HTTP_CONNECTOR_ID];
    expect(entry.command).toBe("npx");
    expect("url" in entry).toBe(false);
  });

  it("an unsupported transport (sse — codex has no streamable-http analog) is skip-warned, not written", () => {
    const projectDir = freshProject("ac-codex-http-");
    const c = connectorWith({ transport: "sse" as Transport, url: "https://mcp.acme.example/sse", tools: { include: ["*"] } });
    const changes = codexAdapter.installServer(buildCtx(projectDir, c, "user"));
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toMatch(/transport "sse" not registrable/);
  });
});

// ── E1 extension events (PermissionRequest / SubagentStart / SubagentStop) ────

describe("codex E1 events", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-ext-codex-");
    ctx = buildCtx(projectDir, buildE1Connector());
  });

  it("capabilities: PermissionRequest + Subagent* native; postToolUseFailure unset", () => {
    expect(codexAdapter.capabilities.permissionRequest).toBe(true);
    expect(codexAdapter.capabilities.subagentStart).toBe(true);
    expect(codexAdapter.capabilities.subagentStop).toBe(true);
    expect(codexAdapter.capabilities.postToolUseFailure ?? false).toBe(false);
  });

  it("installHooks registers the 3 native events; PostToolUseFailure warn-skips (never silent)", () => {
    const changes = codexAdapter.installHooks(ctx);

    const warns = changes.filter((c) => c.action === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.detail).toContain("PostToolUseFailure");
    expect(warns[0]?.detail).toContain("skipped");

    const cfg = readJson(join(projectDir, ".codex", "hooks.json"));
    expect(cfg.hooks.PermissionRequest).toHaveLength(1);
    expect(cfg.hooks.SubagentStart).toHaveLength(1);
    expect(cfg.hooks.SubagentStop).toHaveLength(1);
    expect(cfg.hooks.PostToolUseFailure).toBeUndefined();

    // PermissionRequest matches tool names like PreToolUse → same charset-clean
    // matcher; Subagent* match agent_type → register all ("").
    expect(cfg.hooks.PermissionRequest[0].matcher).toContain("mcp__");
    expect(cfg.hooks.SubagentStart[0].matcher).toBe("");
    expect(cfg.hooks.SubagentStop[0].matcher).toBe("");
    expect(cfg.hooks.SubagentStop[0].hooks[0].command).toContain(
      "hook codex SubagentStop",
    );
  });

  it("installHooks stays idempotent (second run: no create/update, warn repeats)", () => {
    codexAdapter.installHooks(ctx);
    const before = readFileSync(join(projectDir, ".codex", "hooks.json"), "utf8");
    const second = codexAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip" || c.action === "warn")).toBe(true);
    expect(readFileSync(join(projectDir, ".codex", "hooks.json"), "utf8")).toBe(before);
  });

  it("a PostToolUseFailure-only connector warns WITHOUT creating hooks.json", () => {
    const only = buildCtx(projectDir, buildSingleEventConnector("acme-fail", "PostToolUseFailure"));
    const changes = codexAdapter.installHooks(only);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
    expect(existsSync(join(projectDir, ".codex", "hooks.json"))).toBe(false);
  });

  // ── PINNED detail strings (hook-engine migration safety net) ──────────────
  it("unsupported-event warn detail is the EXACT `<event> has no Codex hook equivalent — skipped`", () => {
    const only = buildCtx(projectDir, buildSingleEventConnector("acme-fail2", "PostToolUseFailure"));
    const changes = codexAdapter.installHooks(only);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toBe("PostToolUseFailure has no Codex hook equivalent — skipped");
  });

  it("write-gate: a pure warn/skip run writes NOTHING to disk", () => {
    // First install creates the file (PermissionRequest/Subagent* + 1 warn).
    codexAdapter.installHooks(ctx);
    const before = readFileSync(join(projectDir, ".codex", "hooks.json"), "utf8");
    // A second run is all-skip (+ the same warn) → no create/update → no rewrite.
    const second = codexAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip" || c.action === "warn")).toBe(true);
    expect(readFileSync(join(projectDir, ".codex", "hooks.json"), "utf8")).toBe(before);
  });

  it("uninstallHooks removes the new-event entries too", () => {
    codexAdapter.installHooks(ctx);
    codexAdapter.uninstallHooks(ctx);
    const cfg = readJson(join(projectDir, ".codex", "hooks.json"));
    expect(JSON.stringify(cfg.hooks ?? {})).not.toContain(HOME_BIN);
  });

  it("parseEvent: PermissionRequest + SubagentStop (incl. missing-agent_type tolerance)", () => {
    const perm = codexAdapter.parseEvent!("PermissionRequest", {
      session_id: "cx-9",
      cwd: projectDir,
      tool_name: "Bash",
      tool_input: { command: "rm -rf /tmp/x" },
    }) as PermissionRequestEvent;
    expect(perm.hostPlatform).toBe("codex");
    expect(perm.toolName).toBe("Bash");
    expect(perm.toolInput).toEqual({ command: "rm -rf /tmp/x" });
    expect(perm.permissionSuggestions).toBeUndefined();

    const stop = codexAdapter.parseEvent!("SubagentStop", {
      session_id: "cx-9",
      agent_id: "agent-3",
      agent_type: "code-reviewer",
      agent_transcript_path: "/tmp/t.jsonl",
      last_assistant_message: "done",
      stop_hook_active: true,
    }) as SubagentStopEvent;
    expect(stop.agentId).toBe("agent-3");
    expect(stop.agentType).toBe("code-reviewer");
    expect(stop.agentTranscriptPath).toBe("/tmp/t.jsonl");
    expect(stop.lastAssistantMessage).toBe("done");
    expect(stop.stopHookActive).toBe(true);

    const bare = codexAdapter.parseEvent!("SubagentStop", {
      session_id: "cx-9",
    }) as SubagentStopEvent;
    expect(bare.agentId).toBeUndefined();
    expect(bare.agentType).toBeUndefined();
  });

  it("formatReply PermissionRequest: deny/allow use the nested decision envelope", () => {
    const deny = parsed(
      codexAdapter.formatReply!("PermissionRequest", {
        decision: "deny",
        reason: "secrets stay local",
      }),
    );
    expect(deny.hookSpecificOutput.hookEventName).toBe("PermissionRequest");
    expect(deny.hookSpecificOutput.decision).toEqual({
      behavior: "deny",
      message: "secrets stay local",
    });

    const allow = parsed(codexAdapter.formatReply!("PermissionRequest", { decision: "allow" }));
    expect(allow.hookSpecificOutput.decision).toEqual({ behavior: "allow" });
  });

  it("formatReply PermissionRequest: modify falls through (Codex fails CLOSED on updatedInput)", () => {
    const reply = codexAdapter.formatReply!("PermissionRequest", {
      decision: "modify",
      updatedInput: { command: "ls" },
    });
    expect(reply.exitCode).toBe(0);
    expect(reply.stdout).toBeUndefined();

    // ask / void-normalized {} also fall through to the native approval prompt.
    expect(codexAdapter.formatReply!("PermissionRequest", { decision: "ask" }).stdout).toBeUndefined();
    expect(codexAdapter.formatReply!("PermissionRequest", {}).stdout).toBeUndefined();
  });

  it("formatReply SubagentStart: context (and deny-degrade) → additionalContext", () => {
    const out = parsed(
      codexAdapter.formatReply!("SubagentStart", {
        decision: "context",
        additionalContext: "use the repo test conventions",
      }),
    );
    expect(out.hookSpecificOutput.hookEventName).toBe("SubagentStart");
    expect(out.hookSpecificOutput.additionalContext).toBe("use the repo test conventions");

    const degraded = parsed(
      codexAdapter.formatReply!("SubagentStart", { decision: "deny", reason: "not blockable" }),
    );
    expect(degraded.hookSpecificOutput.additionalContext).toBe("not blockable");
    expect(degraded.decision).toBeUndefined();
  });

  it("formatReply SubagentStop: deny → TOP-LEVEL block; context unsupported → passthrough", () => {
    const out = parsed(
      codexAdapter.formatReply!("SubagentStop", {
        decision: "deny",
        reason: "one more pass",
      }),
    );
    expect(out.decision).toBe("block");
    expect(out.reason).toBe("one more pass");
    expect(out.hookSpecificOutput).toBeUndefined();

    const ctxReply = codexAdapter.formatReply!("SubagentStop", {
      decision: "context",
      additionalContext: "ignored on codex",
    });
    expect(ctxReply.exitCode).toBe(0);
    expect(ctxReply.stdout).toBeUndefined();
  });
});

// ── PostCompact (post-compaction sibling of PreCompact, observe-only) ─────────

describe("codex PostCompact", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-ext-codex-pc-");
    ctx = buildCtx(projectDir, buildCompactionConnector());
  });

  it("capabilities: postCompact native (sibling of preCompact)", () => {
    expect(codexAdapter.capabilities.postCompact ?? false).toBe(true);
    expect(codexAdapter.capabilities.preCompact).toBe(true);
  });

  it("installHooks writes hooks.PostCompact (and PreCompact) with the codex command + empty matcher", () => {
    const changes = codexAdapter.installHooks(ctx);
    // No warn-skip: both compaction events are native to codex.
    expect(changes.some((c) => c.action === "warn")).toBe(false);

    const cfg = readJson(join(projectDir, ".codex", "hooks.json"));
    expect(cfg.hooks.PostCompact).toHaveLength(1);
    expect(cfg.hooks.PreCompact).toHaveLength(1);
    expect(cfg.hooks.PostCompact[0].matcher).toBe("");
    expect(cfg.hooks.PostCompact[0].hooks[0].command).toContain("hook codex PostCompact");
  });

  it("uninstallHooks removes the PostCompact entry", () => {
    codexAdapter.installHooks(ctx);
    codexAdapter.uninstallHooks(ctx);
    const cfg = readJson(join(projectDir, ".codex", "hooks.json"));
    expect(JSON.stringify(cfg.hooks ?? {})).not.toContain("PostCompact");
  });

  it("parseEvent maps the `trigger` enum (manual|auto); unknown/missing coerces to auto", () => {
    const manual = codexAdapter.parseEvent!("PostCompact", {
      session_id: "cx-pc",
      cwd: projectDir,
      trigger: "manual",
    }) as PostCompactEvent;
    expect(manual.hostPlatform).toBe("codex");
    expect(manual.trigger).toBe("manual");

    const auto = codexAdapter.parseEvent!("PostCompact", {
      session_id: "cx-pc",
      trigger: "auto",
    }) as PostCompactEvent;
    expect(auto.trigger).toBe("auto");

    // Codex's compaction events default an unknown/missing trigger to "auto"
    // (same normalization the PreCompact case uses).
    const unknown = codexAdapter.parseEvent!("PostCompact", {
      session_id: "cx-pc",
      trigger: "nonsense",
    }) as PostCompactEvent;
    expect(unknown.trigger).toBe("auto");
    const none = codexAdapter.parseEvent!("PostCompact", { session_id: "cx-pc" }) as PostCompactEvent;
    expect(none.trigger).toBe("auto");
  });

  it("formatReply is an observe-only passthrough (any decision → exit 0, no stdout)", () => {
    for (const response of [
      {},
      { decision: "deny" as const, reason: "cannot block a completed compaction" },
      { decision: "context" as const, additionalContext: "ignored on PostCompact" },
    ]) {
      const reply = codexAdapter.formatReply!("PostCompact", response);
      expect(reply.exitCode).toBe(0);
      expect(reply.stdout).toBeUndefined();
    }
  });
});

// ── skills surface (project: .codex/skills · user: ~/.agents/skills) ──────────

describe("codex adapter — skills surface", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-codex-skills-");
    // Default: CODEX_HOME unset → userConfigDir() falls back to ~/.codex.
    delete process.env.CODEX_HOME;
    ctx = buildCtx(projectDir, buildSkillsConnector());
  });

  it("declares supportsSkills true", () => {
    expect(codexAdapter.capabilities.supportsSkills).toBe(true);
  });

  it("installSkills (project scope) writes .codex/skills/<n>/SKILL.md with correct frontmatter", () => {
    const changes = codexAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");

    const skillMd = join(projectDir, ".codex", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILLS_SKILL.description);
    expect(frontmatter.model).toBe("haiku");
    expect(frontmatter["allowed-tools"]).toBe("Bash");
    expect(frontmatter["disable-model-invocation"]).toBe(false);
    expect(body).toContain("# PDF Tools");
  });

  it("installSkills (project scope) writes resource files beside SKILL.md", () => {
    codexAdapter.installSkills!(ctx);
    const resource = join(projectDir, ".codex", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILLS_SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills (user scope) writes ~/.agents/skills/<n>/SKILL.md (the current user root)", () => {
    const userCtx = buildCtx(projectDir, buildSkillsConnector(), "user");
    const changes = codexAdapter.installSkills!(userCtx);
    expect(changes[0]?.action).toBe("create");

    // HOME redirected to projectDir → ~/.agents === projectDir/.agents
    const skillMd = join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);

    const { frontmatter } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
  });

  it("user-scope skill does NOT write to the deprecated ~/.codex/skills location", () => {
    const userCtx = buildCtx(projectDir, buildSkillsConnector(), "user");
    codexAdapter.installSkills!(userCtx);
    // The deprecated $CODEX_HOME/skills tree must stay empty.
    expect(existsSync(join(projectDir, ".codex", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("user-scope .agents path is anchored to the OS home, NOT $CODEX_HOME", () => {
    // A custom CODEX_HOME must move ~/.codex/* but NOT the .agents skills root:
    // loader.rs `skill_roots_from_layer_stack_inner` (ConfigLayerSource::User arm)
    // anchors .agents to home_dir, not the config folder ($CODEX_HOME).
    const codexHome = join(projectDir, "custom-codex-home");
    process.env.CODEX_HOME = codexHome;

    const userCtx = buildCtx(projectDir, buildSkillsConnector(), "user");
    codexAdapter.installSkills!(userCtx);

    // Lands under HOME/.agents, independent of CODEX_HOME.
    expect(existsSync(join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md"))).toBe(true);
    // Never under CODEX_HOME (neither the deprecated skills dir nor a .agents there).
    expect(existsSync(join(codexHome, "skills", "pdf-tools", "SKILL.md"))).toBe(false);
    expect(existsSync(join(codexHome, ".agents", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("migrates an AC-owned skill away from the deprecated ~/.codex/skills on user install", () => {
    const userCtx = buildCtx(projectDir, buildSkillsConnector(), "user");
    // Seed the deprecated user root with the EXACT rendered SKILL.md, as a prior
    // AC version's user-scope install would have left it (AC-owned).
    codexAdapter.installSkills!(userCtx);
    const newPath = join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md");
    const rendered = readFileSync(newPath, "utf8");
    const deprecatedDir = join(projectDir, ".codex", "skills", "pdf-tools");
    mkdirSync(deprecatedDir, { recursive: true });
    writeFileSync(join(deprecatedDir, "SKILL.md"), rendered, "utf8");
    expect(existsSync(join(deprecatedDir, "SKILL.md"))).toBe(true);

    // Re-install: new root already current (skip), AC-owned deprecated copy removed
    // so codex won't double-register the skill across two user roots.
    const changes = codexAdapter.installSkills!(userCtx);
    expect(existsSync(join(deprecatedDir, "SKILL.md"))).toBe(false);
    expect(existsSync(deprecatedDir)).toBe(false); // empty dir cleaned up too
    expect(existsSync(newPath)).toBe(true); // current copy untouched
    expect(changes.some((c) => c.action === "remove")).toBe(true);
  });

  it("does NOT remove a hand-authored skill at the deprecated path (content differs)", () => {
    const userCtx = buildCtx(projectDir, buildSkillsConnector(), "user");
    const deprecatedDir = join(projectDir, ".codex", "skills", "pdf-tools");
    mkdirSync(deprecatedDir, { recursive: true });
    const handAuthored = "---\nname: pdf-tools\ndescription: hand-edited\n---\n\n# Mine\n";
    writeFileSync(join(deprecatedDir, "SKILL.md"), handAuthored, "utf8");

    codexAdapter.installSkills!(userCtx);
    // Untouched — not byte-identical to our render, so it was never AC-owned.
    expect(existsSync(join(deprecatedDir, "SKILL.md"))).toBe(true);
    expect(readFileSync(join(deprecatedDir, "SKILL.md"), "utf8")).toBe(handAuthored);
  });

  it("installSkills is idempotent — second call yields skip", () => {
    codexAdapter.installSkills!(ctx);
    const second = codexAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills (user scope) removes SKILL.md, resource, and the empty skill dir", () => {
    const userCtx = buildCtx(projectDir, buildSkillsConnector(), "user");
    codexAdapter.installSkills!(userCtx);
    const skillMd = join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".agents", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    codexAdapter.uninstallSkills!(userCtx);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(resource)).toBe(false);
    expect(existsSync(join(projectDir, ".agents", "skills", "pdf-tools"))).toBe(false);
  });

  it("honors platforms['codex'].skills === false", () => {
    const disabled = defineConnector({
      id: SKILLS_CONNECTOR_ID,
      skills: [skillsSkill()],
      platforms: { codex: { skills: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    const changes = codexAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".codex", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("installSkills with no skills declared returns skip", () => {
    const noSkills = defineConnector({ id: SKILLS_CONNECTOR_ID, memory: [{ content: "placeholder" }] });
    const c2 = buildCtx(projectDir, noSkills);
    const changes = codexAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
  });
});

// ── content surfaces: commands (USER scope only) / skills / subagents (TOML) ──

describe("codex adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-surfaces-codex-");
    // Unset CODEX_HOME so codex user scope resolves under the temp HOME (~/.codex).
    delete process.env.CODEX_HOME;
    ctx = buildCtx(projectDir, buildSurfacesConnector());
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

    const toml = readToml(agentPath);
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
    const userCtx = buildCtx(projectDir, buildSurfacesConnector(), "user");
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
    const userCtx = buildCtx(projectDir, buildSurfacesConnector(), "user");
    codexAdapter.installSkills!(ctx);
    codexAdapter.installSubagents!(ctx);
    codexAdapter.installCommands!(userCtx);
    expect(codexAdapter.installSkills!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(codexAdapter.installSubagents!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(codexAdapter.installCommands!(userCtx).every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall removes skills, subagents, and user-scope command files", () => {
    const userCtx = buildCtx(projectDir, buildSurfacesConnector(), "user");
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
