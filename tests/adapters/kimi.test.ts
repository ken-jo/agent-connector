/**
 * adapters/kimi.test.ts — the ONE per-host file for the Kimi CLI (Moonshot) adapter.
 *
 * kimi is a json-stdio host. Config surfaces:
 *   • MCP servers → <baseDir>/mcp.json, ROOT KEY "mcpServers"; stdio entry
 *                   { command, args, env } (env-refs resolve to LITERALS — Kimi has
 *                   no native ${env:VAR}); remote → { url } (bare = HTTP) or
 *                   { url, transport:"sse" } (legacy HTTP+SSE).
 *   • Hooks       → <baseDir>/config.toml, `[[hooks]]` array-of-tables (TOML), each
 *                   table { event, matcher, command }; every canonical event wired
 *                   1:1 (PascalCase); nativeHooks event-name entries written VERBATIM.
 *   • Skills      → <baseDir>/skills/<name>/SKILL.md + resources (user scope) and
 *                   <projectDir>/.kimi-code/skills/<name>/SKILL.md (project scope).
 *   • Reply       → PreToolUse deny → EXIT 0 + hookSpecificOutput permissionDecision
 *                   (Claude/Codex shape); Stop/UserPromptSubmit/SubagentStop deny →
 *                   EXIT 2 + stderr; PostToolUseFailure/SubagentStart context rides
 *                   PLAIN stdout (exit 0); observation-only events degrade to allow.
 *   • base dir    → $KIMI_CODE_HOME || ~/.kimi-code (NO $KIMI_HOME; primary-doc-verified).
 *
 * This file consolidates what used to be split across kimi-native-hooks.test.ts
 * (nativeHooks passthrough), extended-events-hosts.test.ts (E1 + lifecycle/prompt
 * events), wave2.test.ts (render/round-trip), and review-fixes.test.ts (deny
 * protocol + base dir + parseEvent). It uses the shared harness (tests/support/env
 * + adapter-suite + fs) per tests/README.md — ONE file per host. TOML is parsed
 * with @iarna/toml (the source's choice — readJson is JSON only); JSON files use
 * readJson.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import TOML from "@iarna/toml";
import { beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  PostToolUseEvent,
  PostToolUseFailureEvent,
  PreToolUseEvent,
  ResolvedConnector,
  SubagentStartEvent,
  SubagentStopEvent,
  UserPromptSubmitEvent,
} from "../../src/core/types.js";

import kimiAdapter from "../../src/adapters/kimi/index.js";
import {
  buildCtx,
  freshHomeProject,
  freshProject,
  isolateEnv,
  HOME_BIN,
} from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson, splitFrontmatter } from "../support/fs.js";

// ── shared fixtures ──────────────────────────────────────────────────────────

// render/round-trip (wave2) + E1 slices share the canonical "acme-db" id; the
// review-fixes deny/base-dir slice reuses it too.
const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const SERVER_CWD = "/srv/acme";
const PRE_MATCHER = "acme_query|acme_write";
// E1 (extended-events) slice uses its own id.
const E1_CONNECTOR_ID = "acme-db";
// nativeHooks slice uses its own id.
const NATIVE_CONNECTOR_ID = "acme-kimi-native";
// skills surface slice uses its own id.
const SKILLS_CONNECTOR_ID = "acme-skills";

// The serve-wrapper args bake the install TARGET platform as `--host <id>` (before
// `--`). kimi render is exercised at USER scope, so `--scope user`.
const wrappedArgsUser = (host: string): string[] => [
  "serve",
  "--connector",
  CONNECTOR_ID,
  "--scope",
  "user",
  "--host",
  host,
  "--",
  "npx",
  "-y",
  "@x/y",
];

const SKILL = {
  name: "pdf-tools",
  description: "Extract and summarize text from PDF files when the user asks.",
  body: "# PDF Tools\n\nUse the bundled script to extract text.",
  model: "haiku",
  tools: { allow: ["Bash"] },
  disableModelInvocation: false,
  resources: { "scripts/extract.sh": "#!/bin/sh\necho extracting\n" },
} as const;

/**
 * render (wave2): a stdio server (env-ref + cwd) + PreToolUse and SessionStart
 * hooks. Kimi supports every canonical event, so both register (PascalCase 1:1).
 */
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

/** review-fixes: a stdio server + PreToolUse/SessionStart for the base-dir tests. */
function buildBaseDirConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@x/y"],
    },
    hooks: {
      PreToolUse: { handler: () => ({ decision: "allow" }) },
      SessionStart: { handler: () => ({ decision: "allow" }) },
    },
  });
}

/** MCP transports: a server-only connector for the http/sse/ws transport tests. */
function serverConnector(transport: "http" | "sse" | "ws"): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Remote",
    version: "1.0.0",
    server: { transport, url: "https://mcp.example.com/v1" },
  });
}

/** E1: a hooks-only connector declaring ALL FOUR E1 events (plus PreToolUse). */
function buildE1Connector(id = E1_CONNECTOR_ID): ResolvedConnector {
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

/** E1: a connector declaring ONLY one hook event — single-event install path. */
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

/** nativeHooks: a normalized PreToolUse hook + two kimi-native observation hooks. */
function nativeConnector(): ResolvedConnector {
  return defineConnector({
    id: NATIVE_CONNECTOR_ID,
    displayName: "Acme Kimi",
    version: "1.0.0",
    hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
    platforms: {
      kimi: {
        nativeHooks: {
          StopFailure: { handler: () => ({}) },
          Interrupt: { matcher: "esc", handler: () => ({}) },
        },
      },
    },
  });
}

/** skills: a connector whose only payload is the SKILL fixture. */
function buildSkillsConnector(): ResolvedConnector {
  return defineConnector({
    id: SKILLS_CONNECTOR_ID,
    displayName: "Acme Skills",
    version: "1.0.0",
    skills: [
      {
        ...SKILL,
        tools: { allow: [...SKILL.tools.allow] },
        resources: { ...SKILL.resources },
      },
    ],
  });
}

// ── local helpers ────────────────────────────────────────────────────────────

function readToml(path: string): Record<string, any> {
  return TOML.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

function configPath(projectDir: string): string {
  return join(projectDir, ".kimi-code", "config.toml");
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

// Shared env isolation + the same-rules-for-every-host baseline contract.
// extraKeys: the kimi base dir is resolved from KIMI_CODE_HOME (KIMI_HOME is NOT a
// real Kimi Code env var, but we still isolate it so a stray real-env value can
// never leak in), and the render/round-trip slice mutates ACME_DB_DSN (the
// ${env:VAR} → mcp.json literal). HOME/USERPROFILE/AGENT_CONNECTOR_DATA_DIR are
// isolateEnv defaults.
isolateEnv(["KIMI_HOME", "KIMI_CODE_HOME", ENV_VAR]);
createAdapterSuite({ adapter: kimiAdapter, paradigm: "json-stdio" });

/**
 * Drop the kimi base-dir env override so baseDir() resolves to ~/.kimi-code (i.e.
 * <HOME>/.kimi-code under the freshProject temp HOME). KIMI_HOME is cleared too in
 * case a stray value lingers, though the adapter no longer honors it. Each
 * describe's beforeEach calls this after freshProject(), reproducing the
 * per-source freshProject behaviour.
 */
function unsetKimiBase(): void {
  delete process.env.KIMI_HOME;
  delete process.env.KIMI_CODE_HOME;
}

// ── render + round-trip (mcpServers in mcp.json; [[hooks]] in config.toml) ─────

describe("kimi adapter render + round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave2-kimi-");
    // user scope → <baseDir>/mcp.json resolves into the HOME sandbox (~/.kimi-code).
    unsetKimiBase();
    // Set the env-ref var so kimi literal-resolution produces a known value.
    process.env[ENV_VAR] = ENV_LITERAL;
    ctx = buildCtx(projectDir, buildRenderConnector(), "user");
  });

  it("installServer writes mcpServers.<id> into ~/.kimi-code/mcp.json, wrapped, env LITERAL", () => {
    const changes = kimiAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".kimi-code", "mcp.json");
    expect(serverPath).toBe(kimiAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedArgsUser("kimi"));
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installHooks writes a [[hooks]] table in config.toml (TOML); PreToolUse + SessionStart both registered", () => {
    const changes = kimiAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const hookPath = join(projectDir, ".kimi-code", "config.toml");
    expect(hookPath).toBe(kimiAdapter.getHookConfigPath(ctx));
    expect(existsSync(hookPath)).toBe(true);

    const cfg = readToml(hookPath);
    expect(Array.isArray(cfg.hooks)).toBe(true);
    // Kimi now supports every canonical event — both register (PascalCase 1:1).
    expect(cfg.hooks).toHaveLength(2);
    const byEvent = new Map(cfg.hooks.map((h: any) => [h.event, h]));
    const pre = byEvent.get("PreToolUse") as any;
    expect(pre, "PreToolUse entry").toBeDefined();
    expect(pre.command).toContain(HOME_BIN);
    expect(pre.command).toContain("hook kimi PreToolUse");
    expect(pre.command).toContain(`--connector ${CONNECTOR_ID}`);
    expect((byEvent.get("SessionStart") as any)?.command).toContain("hook kimi SessionStart");
  });

  it("installHooks is idempotent (skip on second run); uninstallHooks removes the [[hooks]] table", () => {
    kimiAdapter.installHooks(ctx);
    const second = kimiAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    const hookPath = join(projectDir, ".kimi-code", "config.toml");
    expect(readToml(hookPath).hooks).toHaveLength(2);

    kimiAdapter.uninstallHooks(ctx);
    const after = readToml(hookPath);
    // The hooks key is dropped entirely once our entries are removed.
    expect(after.hooks).toBeUndefined();
  });

  it("installServer idempotent; uninstallServer removes the entry (re-read confirms gone)", () => {
    kimiAdapter.installServer(ctx);
    expect(kimiAdapter.installServer(ctx)[0]?.action).toBe("skip");

    kimiAdapter.uninstallServer(ctx);
    const cfg = readJson(join(projectDir, ".kimi-code", "mcp.json"));
    expect(cfg.mcpServers?.[CONNECTOR_ID]).toBeUndefined();
  });

  it("parseEvent yields a normalized PreToolUse; formatReply(deny) → exit 0 + hookSpecificOutput deny on stdout", () => {
    const ev = kimiAdapter.parseEvent!("PreToolUse", preToolUsePayload()) as PreToolUseEvent;
    expect(ev.hostPlatform).toBe("kimi");
    expect(ev.connectorId).toBe(CONNECTOR_ID);
    expect(ev.toolName).toBe("acme_query");
    expect(ev.toolInput).toEqual({ sql: "SELECT 1" });
    expect(ev.sessionId).toBe("sess-123");

    // Kimi Code uses the Claude/Codex deny shape: exit 0 + hookSpecificOutput
    // permissionDecision:"deny" on stdout (NOT exit 2 + bare reason).
    const reply = kimiAdapter.formatReply!("PreToolUse", {
      decision: "deny",
      reason: "blocked by policy",
    });
    expect(reply.exitCode).toBe(0);
    const out = JSON.parse(reply.stdout ?? "{}");
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("blocked by policy");
  });
});

// ── MCP transports (stdio / http / sse) ───────────────────────────────────────
// Kimi docs: "supports three MCP server connection methods: stdio, HTTP, SSE".
// A bare `url` (no transport) is HTTP; a legacy HTTP+SSE endpoint needs
// transport:"sse". These pin the http-stays-bare / sse-gets-the-field contract.

describe("kimi adapter — MCP transports", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = freshProject("ac-kimi-transports-");
    unsetKimiBase();
  });

  function readServerEntry(): Record<string, unknown> {
    const cfg = JSON.parse(
      readFileSync(join(projectDir, ".kimi-code", "mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, Record<string, unknown>> };
    return cfg.mcpServers[CONNECTOR_ID]!;
  }

  it("declares sse among supported transports", () => {
    expect(kimiAdapter.capabilities.transports).toContain("sse");
  });

  it("http server → bare { url } entry (NO transport field, per docs)", () => {
    const ctx = buildCtx(projectDir, serverConnector("http"));
    kimiAdapter.installServer(ctx);
    const entry = readServerEntry();
    expect(entry.url).toBe("https://mcp.example.com/v1");
    expect(entry.transport).toBeUndefined();
    expect(entry.command).toBeUndefined();
  });

  it("sse server → { url, transport: 'sse' } entry (legacy HTTP+SSE)", () => {
    const ctx = buildCtx(projectDir, serverConnector("sse"));
    kimiAdapter.installServer(ctx);
    const entry = readServerEntry();
    expect(entry.url).toBe("https://mcp.example.com/v1");
    expect(entry.transport).toBe("sse");
  });

  it("unsupported transport (ws) → best-effort bare { url } + a reported warn (never silent)", () => {
    const ctx = buildCtx(projectDir, serverConnector("ws"));
    const changes = kimiAdapter.installServer(ctx);
    // Degradation is reported, not silent.
    const warn = changes.find((c) => c.action === "warn");
    expect(warn, "expected a warn for the unsupported ws transport").toBeDefined();
    expect(warn?.detail).toContain("ws");
    // Still written best-effort as a bare url (no bogus transport field).
    const entry = readServerEntry();
    expect(entry.url).toBe("https://mcp.example.com/v1");
    expect(entry.transport).toBeUndefined();
  });
});

// ── deny protocol + base dir ──────────────────────────────────────────────────
// Kimi deny uses the Claude/Codex hookSpecificOutput shape (exit 0); the base dir
// defaults to ~/.kimi-code (primary-doc-verified), overridable ONLY by
// $KIMI_CODE_HOME (there is NO $KIMI_HOME).

describe("kimi deny protocol + base dir", () => {
  it("formatReply(deny) yields exit 0 + hookSpecificOutput permissionDecision 'deny'", () => {
    const reply = kimiAdapter.formatReply!("PreToolUse", {
      decision: "deny",
      reason: "blocked by policy",
    });
    expect(reply.exitCode).toBe(0);
    const out = JSON.parse(reply.stdout ?? "{}");
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("blocked by policy");
  });

  it("allow → exit 0 with empty stdout", () => {
    const reply = kimiAdapter.formatReply!("PreToolUse", { decision: "allow" });
    expect(reply.exitCode).toBe(0);
    expect(reply.stdout).toBeUndefined();
  });

  it("baseDir defaults to ~/.kimi-code (primary-doc-verified Kimi Code config dir) when no env override is set", () => {
    const projectDir = freshProject("ac-rf-kimi-");
    unsetKimiBase();
    const ctx = buildCtx(projectDir, buildBaseDirConnector(), "user");
    // HOME is redirected to projectDir, so the base dir resolves into the sandbox.
    const serverPath = kimiAdapter.getServerConfigPath(ctx);
    expect(serverPath).toBe(join(projectDir, ".kimi-code", "mcp.json"));
    // The legacy ~/.kimi base (and the non-existent $KIMI_HOME) are gone.
    expect(serverPath).toContain(".kimi-code");
  });

  it("baseDir honors $KIMI_CODE_HOME when set", () => {
    const projectDir = freshProject("ac-rf-kimi2-");
    unsetKimiBase();
    const custom = join(projectDir, "custom-kimi");
    process.env.KIMI_CODE_HOME = custom;
    const ctx = buildCtx(projectDir, buildBaseDirConnector(), "user");
    expect(kimiAdapter.getServerConfigPath(ctx)).toBe(join(custom, "mcp.json"));
  });

  it("baseDir IGNORES $KIMI_HOME (not a real Kimi Code env var) → still defaults to ~/.kimi-code", () => {
    const projectDir = freshProject("ac-rf-kimi3-");
    unsetKimiBase();
    // $KIMI_HOME is NOT a Kimi Code env var; setting it must NOT redirect the
    // adapter (the original bug honored it first, writing where Kimi never reads).
    process.env.KIMI_HOME = join(projectDir, "stray-kimi-home");
    const ctx = buildCtx(projectDir, buildBaseDirConnector(), "user");
    const serverPath = kimiAdapter.getServerConfigPath(ctx);
    expect(serverPath).toBe(join(projectDir, ".kimi-code", "mcp.json"));
    expect(serverPath).not.toContain("stray-kimi-home");
  });
});

describe("kimi parseEvent normalizes a PreToolUse payload", () => {
  beforeEach(() => {
    freshProject("ac-rf-kimi-parse-");
    unsetKimiBase();
  });

  it("maps a native payload to a normalized PreToolUse event", () => {
    const ev = kimiAdapter.parseEvent!("PreToolUse", {
      tool_name: "acme_query",
      tool_input: { sql: "select 1" },
      session_id: "sess-1",
      cwd: "/work",
    }) as PreToolUseEvent;
    expect(ev.toolName).toBe("acme_query");
    expect(ev.sessionId).toBe("sess-1");
  });
});

// ── nativeHooks passthrough (verbatim kimi-native event-name entries) ──────────
// Kimi's observation-only single-host events (StopFailure, PermissionResult,
// Interrupt) have NO normalized HookEventName — below the >=3-host core bar
// (docs/research/host-specific-hook-events-design.md). A connector reaches them
// via platforms["kimi"].nativeHooks; installHooks writes the event-name [[hooks]]
// entries VERBATIM into config.toml, and the generic uninstall reverses them.

describe("kimi adapter — nativeHooks passthrough", () => {
  beforeEach(() => {
    unsetKimiBase();
  });

  it("declares supportsNativeHooks true", () => {
    expect(kimiAdapter.capabilities.supportsNativeHooks).toBe(true);
  });

  it("installHooks writes native event-name [[hooks]] entries VERBATIM beside the canonical one", () => {
    const projectDir = freshProject("ac-kimi-native-");
    unsetKimiBase();
    kimiAdapter.installHooks(buildCtx(projectDir, nativeConnector()));
    const hooks = readToml(configPath(projectDir)).hooks as any[];
    const byEvent = new Map(hooks.map((h) => [h.event, h]));

    expect(byEvent.get("PreToolUse")?.command).toContain("hook kimi PreToolUse");
    expect(byEvent.get("StopFailure")?.command).toContain("hook kimi StopFailure");
    expect(byEvent.get("StopFailure")?.command).toContain(`--connector ${NATIVE_CONNECTOR_ID}`);
    expect(byEvent.get("Interrupt")?.command).toContain("hook kimi Interrupt");
    expect(byEvent.get("Interrupt")?.matcher).toBe("esc");
  });

  it("is idempotent (second install → skip) and uninstall removes the native entries", () => {
    const projectDir = freshProject("ac-kimi-native-");
    unsetKimiBase();
    const ctx = buildCtx(projectDir, nativeConnector());
    kimiAdapter.installHooks(ctx);
    const second = kimiAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    kimiAdapter.uninstallHooks(ctx);
    expect(readToml(configPath(projectDir)).hooks).toBeUndefined();
  });

  it("nativeHooks install even when normalized hooks are disabled (hooks: false sibling)", () => {
    const projectDir = freshProject("ac-kimi-native-");
    unsetKimiBase();
    const connector = defineConnector({
      id: NATIVE_CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: { kimi: { hooks: false, nativeHooks: { StopFailure: { handler: () => ({}) } } } },
    });
    kimiAdapter.installHooks(buildCtx(projectDir, connector));
    const events = ((readToml(configPath(projectDir)).hooks ?? []) as any[]).map((h) => h.event);
    expect(events).toContain("StopFailure"); // native installed (sibling)
    expect(events).not.toContain("PreToolUse"); // normalized disabled by hooks:false
  });
});

// ── E1 extension events (PermissionRequest / PostToolUseFailure / Subagent*) ───
// Per-host native truth: Kimi-specific wire fields — agent_name (NOT agent_id /
// agent_type) + response; context rides PLAIN stdout on exit 0; SubagentStop deny
// blocks via EXIT 2 + stderr. PermissionRequest is wired (observation only).

describe("kimi E1 events", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-ext-kimi-");
    // Kimi is user-scoped; baseDir resolves to ~/.kimi-code under the temp HOME.
    unsetKimiBase();
    ctx = buildCtx(projectDir, buildE1Connector(), "user");
  });

  it("capabilities: every canonical event wired (full coverage incl. permissionRequest)", () => {
    const c = kimiAdapter.capabilities;
    expect(c.preToolUse).toBe(true);
    expect(c.postToolUse).toBe(true);
    expect(c.userPromptSubmit).toBe(true);
    expect(c.stop).toBe(true);
    expect(c.sessionStart).toBe(true);
    expect(c.sessionEnd).toBe(true);
    expect(c.preCompact).toBe(true);
    expect(c.postCompact ?? false).toBe(true);
    expect(c.notification).toBe(true);
    expect(c.permissionRequest ?? false).toBe(true);
    expect(c.postToolUseFailure).toBe(true);
    expect(c.subagentStart).toBe(true);
    expect(c.subagentStop).toBe(true);
  });

  it("installHooks writes one [[hooks]] entry PER declared event (no clobber); no warn now PermissionRequest is supported", () => {
    const changes = kimiAdapter.installHooks(ctx);

    // PermissionRequest is now a supported (observation-only) event → no warn-skip.
    expect(changes.filter((c) => c.action === "warn")).toHaveLength(0);

    const cfg = readToml(join(projectDir, ".kimi-code", "config.toml"));
    // The connector declares 5 events (PreToolUse, PermissionRequest,
    // PostToolUseFailure, SubagentStart, SubagentStop) — all wired now.
    expect(cfg.hooks).toHaveLength(5);
    const byEvent = new Map(cfg.hooks.map((h: any) => [h.event, h]));
    for (const event of [
      "PreToolUse",
      "PermissionRequest",
      "PostToolUseFailure",
      "SubagentStart",
      "SubagentStop",
    ]) {
      const entry = byEvent.get(event) as any;
      expect(entry, `missing [[hooks]] entry for ${event}`).toBeDefined();
      expect(entry.command).toContain(`hook kimi ${event}`);
      expect(entry.command).toContain(`--connector ${E1_CONNECTOR_ID}`);
    }
    // Only the PreToolUse deny gate carries the native tool matcher.
    expect((byEvent.get("PreToolUse") as any).matcher).toContain("mcp__");
    expect((byEvent.get("SubagentStop") as any).matcher).toBe("");
    expect((byEvent.get("PermissionRequest") as any).matcher).toBe("");
  });

  it("installHooks is idempotent across multiple events; uninstall removes them all", () => {
    kimiAdapter.installHooks(ctx);
    const second = kimiAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
    expect(readToml(join(projectDir, ".kimi-code", "config.toml")).hooks).toHaveLength(5);

    kimiAdapter.uninstallHooks(ctx);
    expect(readToml(join(projectDir, ".kimi-code", "config.toml")).hooks).toBeUndefined();
  });

  it("a PermissionRequest-only connector now installs a hook + creates config.toml (gap closed)", () => {
    const only = buildCtx(
      projectDir,
      buildSingleEventConnector("acme-perm", "PermissionRequest"),
      "user",
    );
    const changes = kimiAdapter.installHooks(only);
    expect(changes.filter((c) => c.action === "warn")).toHaveLength(0);
    expect(changes.some((c) => c.action === "create")).toBe(true);
    const cfg = readToml(join(projectDir, ".kimi-code", "config.toml"));
    expect(cfg.hooks).toHaveLength(1);
    expect(cfg.hooks[0].event).toBe("PermissionRequest");
  });

  it("parseEvent maps Kimi's wire: agent_name → agentType, response → lastAssistantMessage", () => {
    const fail = kimiAdapter.parseEvent!("PostToolUseFailure", {
      session_id: "km-1",
      cwd: "/work/proj",
      tool_name: "Shell",
      tool_input: { command: "make" },
      error: "exit status 2",
      connector: E1_CONNECTOR_ID,
    }) as PostToolUseFailureEvent;
    expect(fail.hostPlatform).toBe("kimi");
    expect(fail.toolName).toBe("Shell");
    expect(fail.error).toBe("exit status 2");
    expect(fail.toolUseId).toBeUndefined();

    const start = kimiAdapter.parseEvent!("SubagentStart", {
      session_id: "km-1",
      agent_name: "coder",
      prompt: "fix the tests",
    }) as SubagentStartEvent;
    expect(start.agentType).toBe("coder");
    expect(start.agentId).toBeUndefined();

    const stop = kimiAdapter.parseEvent!("SubagentStop", {
      session_id: "km-1",
      agent_name: "coder",
      response: "all green",
    }) as SubagentStopEvent;
    expect(stop.agentType).toBe("coder");
    expect(stop.lastAssistantMessage).toBe("all green");
  });

  // Regression: kimi's REAL hook stdin wire contract (source-verified against
  // MoonshotAI/kimi-code turn/index.ts) — UserPromptSubmit sends prompt as a
  // ContentPart[] array, PostToolUse(success) sends tool_output (NOT
  // tool_response), PostToolUseFailure sends error as a KimiErrorPayload object.
  it("parseEvent wire-shape: UserPromptSubmit ContentPart[] → text; PostToolUse tool_output; PostToolUseFailure error object → message", () => {
    // UserPromptSubmit: prompt is `readonly ContentPart[]` (turn/index.ts:571),
    // a text prompt is [{type:'text', text}] (kosong message.ts:3-6).
    const prompt = kimiAdapter.parseEvent!("UserPromptSubmit", {
      session_id: "km-1",
      prompt: [{ type: "text", text: "hi" }],
      connector: E1_CONNECTOR_ID,
    }) as UserPromptSubmitEvent;
    expect(prompt.prompt).toBe("hi");

    // Defensive: a plain string prompt (e.g. SubagentStart) still works.
    const stringPrompt = kimiAdapter.parseEvent!("UserPromptSubmit", {
      session_id: "km-1",
      prompt: "plain",
    }) as UserPromptSubmitEvent;
    expect(stringPrompt.prompt).toBe("plain");

    // PostToolUse(success): tool output rides `tool_output` as a string
    // (turn/index.ts:739) — NOT `tool_response` (0 hits in kimi source).
    const post = kimiAdapter.parseEvent!("PostToolUse", {
      session_id: "km-1",
      tool_name: "Shell",
      tool_input: { command: "ls" },
      tool_output: "out",
      connector: E1_CONNECTOR_ID,
    }) as PostToolUseEvent;
    expect(post.toolOutput).toBe("out");
    expect(post.isError).toBe(false);

    // PostToolUseFailure: error is a KimiErrorPayload OBJECT
    // {code, message, ...} (turn/index.ts:738) — use its `message`.
    const fail = kimiAdapter.parseEvent!("PostToolUseFailure", {
      session_id: "km-1",
      tool_name: "Shell",
      tool_input: { command: "make" },
      error: { code: "E", message: "boom" },
      connector: E1_CONNECTOR_ID,
    }) as PostToolUseFailureEvent;
    expect(fail.error).toBe("boom");

    // Defensive helper branches → "" (never throws; mirrors the parser's
    // empty-string fallback for every other string field).
    // Empty content-part array, and a non-text part (image/audio/think):
    expect(
      (kimiAdapter.parseEvent!("UserPromptSubmit", { session_id: "km-1", prompt: [] }) as UserPromptSubmitEvent)
        .prompt,
    ).toBe("");
    expect(
      (
        kimiAdapter.parseEvent!("UserPromptSubmit", {
          session_id: "km-1",
          prompt: [{ type: "image" }],
        }) as UserPromptSubmitEvent
      ).prompt,
    ).toBe("");
    // null error, and an error object with no `message`:
    expect(
      (kimiAdapter.parseEvent!("PostToolUseFailure", { session_id: "km-1", error: null }) as PostToolUseFailureEvent)
        .error,
    ).toBe("");
    expect(
      (
        kimiAdapter.parseEvent!("PostToolUseFailure", {
          session_id: "km-1",
          error: { code: "E" },
        }) as PostToolUseFailureEvent
      ).error,
    ).toBe("");
  });

  it("formatReply: context rides PLAIN stdout on exit 0 (Kimi protocol), deny degrades", () => {
    const failCtx = kimiAdapter.formatReply!("PostToolUseFailure", {
      decision: "context",
      additionalContext: "retry with --force",
    });
    expect(failCtx.exitCode).toBe(0);
    expect(failCtx.stdout).toBe("retry with --force");

    const failDeny = kimiAdapter.formatReply!("PostToolUseFailure", {
      decision: "deny",
      reason: "not blockable — degrade",
    });
    expect(failDeny.exitCode).toBe(0);
    expect(failDeny.stdout).toBe("not blockable — degrade");

    const startCtx = kimiAdapter.formatReply!("SubagentStart", {
      decision: "context",
      additionalContext: "subagent conventions",
    });
    expect(startCtx.exitCode).toBe(0);
    expect(startCtx.stdout).toBe("subagent conventions");
  });

  it("formatReply SubagentStop: deny → EXIT 2 + stderr (block); context → stdout", () => {
    const deny = kimiAdapter.formatReply!("SubagentStop", {
      decision: "deny",
      reason: "verify before stopping",
    });
    expect(deny.exitCode).toBe(2);
    expect(deny.stderr).toBe("verify before stopping");
    expect(deny.stdout).toBeUndefined();

    const ctxReply = kimiAdapter.formatReply!("SubagentStop", {
      decision: "context",
      additionalContext: "wrap-up notes",
    });
    expect(ctxReply.exitCode).toBe(0);
    expect(ctxReply.stdout).toBe("wrap-up notes");
  });

  it("formatReply PermissionRequest degrades to silent allow (fired, but observation-only)", () => {
    // Kimi fires PermissionRequest but it is NOT blockable, so a deny degrades.
    const reply = kimiAdapter.formatReply!("PermissionRequest", {
      decision: "deny",
      reason: "would block if it could",
    });
    expect(reply.exitCode).toBe(0);
    expect(reply.stdout).toBeUndefined();
    expect(reply.stderr).toBeUndefined();
  });

  it("formatReply Stop: deny → EXIT 2 + stderr (continue); context → exit-0 stdout", () => {
    const deny = kimiAdapter.formatReply!("Stop", {
      decision: "deny",
      reason: "keep going — task incomplete",
    });
    expect(deny.exitCode).toBe(2);
    expect(deny.stderr).toBe("keep going — task incomplete");
    expect(deny.stdout).toBeUndefined();

    const ctxReply = kimiAdapter.formatReply!("Stop", {
      decision: "context",
      additionalContext: "remaining checklist",
    });
    expect(ctxReply.exitCode).toBe(0);
    expect(ctxReply.stdout).toBe("remaining checklist");
  });

  it("formatReply UserPromptSubmit: deny → EXIT 2 + stderr (block turn); context → exit-0 stdout", () => {
    const deny = kimiAdapter.formatReply!("UserPromptSubmit", {
      decision: "deny",
      reason: "prompt rejected by policy",
    });
    expect(deny.exitCode).toBe(2);
    expect(deny.stderr).toBe("prompt rejected by policy");
    expect(deny.stdout).toBeUndefined();

    const ctxReply = kimiAdapter.formatReply!("UserPromptSubmit", {
      decision: "context",
      additionalContext: "appended preamble",
    });
    expect(ctxReply.exitCode).toBe(0);
    expect(ctxReply.stdout).toBe("appended preamble");
  });

  it("formatReply observation-only events (PostToolUse/SessionStart/etc.) degrade to exit-0 allow", () => {
    for (const ev of ["PostToolUse", "SessionStart", "SessionEnd", "PreCompact", "PostCompact", "Notification"] as const) {
      const reply = kimiAdapter.formatReply!(ev, { decision: "deny", reason: "x" });
      expect(reply.exitCode, `${ev} should degrade to allow`).toBe(0);
      expect(reply.stderr).toBeUndefined();
    }
  });
});

// ── skills surface ─────────────────────────────────────────────────────────────
// Verified dirs: ~/.kimi-code/skills/<name>/SKILL.md (user scope);
// <projectDir>/.kimi-code/skills/<name>/SKILL.md (project scope) —
// kilo-pi-ground-truth.md § "Already-known skills gaps".

describe("kimi adapter — skills surface", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = freshProject("ac-kimi-skills-");
    // Unset the kimi base-dir env override so baseDir() resolves to ~/.kimi-code
    // (i.e. <dir>/.kimi-code under the temp HOME).
    unsetKimiBase();
  });

  it("declares supportsSkills: true", () => {
    expect(kimiAdapter.capabilities.supportsSkills).toBe(true);
  });

  it("installSkills (user scope) writes SKILL.md at ~/.kimi-code/skills/<name>/SKILL.md", () => {
    const ctx = buildCtx(projectDir, buildSkillsConnector(), "user");
    const changes = kimiAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");

    // user scope baseDir() → ~/.kimi-code (temp HOME/.kimi-code)
    const skillMd = join(projectDir, ".kimi-code", "skills", "pdf-tools", "SKILL.md");
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
    const ctx = buildCtx(projectDir, buildSkillsConnector(), "user");
    kimiAdapter.installSkills!(ctx);

    const resource = join(
      projectDir,
      ".kimi-code",
      "skills",
      "pdf-tools",
      "scripts",
      "extract.sh",
    );
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills (project scope) writes SKILL.md at <projectDir>/.kimi-code/skills/<name>/SKILL.md", () => {
    const ctx = buildCtx(projectDir, buildSkillsConnector(), "project");
    const changes = kimiAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");

    const skillMd = join(projectDir, ".kimi-code", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);
  });

  it("installSkills is idempotent — second install yields skip", () => {
    const ctx = buildCtx(projectDir, buildSkillsConnector(), "user");
    kimiAdapter.installSkills!(ctx);
    const second = kimiAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md and resource", () => {
    const ctx = buildCtx(projectDir, buildSkillsConnector(), "user");
    kimiAdapter.installSkills!(ctx);

    const skillMd = join(projectDir, ".kimi-code", "skills", "pdf-tools", "SKILL.md");
    const resource = join(
      projectDir,
      ".kimi-code",
      "skills",
      "pdf-tools",
      "scripts",
      "extract.sh",
    );
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    kimiAdapter.uninstallSkills!(ctx);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(resource)).toBe(false);
  });

  it("skills disabled via platforms opt-out → skip", () => {
    const connector = defineConnector({
      id: SKILLS_CONNECTOR_ID,
      displayName: "Acme Skills",
      version: "1.0.0",
      skills: [{ ...SKILL, tools: { allow: [...SKILL.tools.allow] } }],
      platforms: { kimi: { skills: false } },
    });
    const ctx = buildCtx(projectDir, connector, "user");
    const changes = kimiAdapter.installSkills!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
  });

  it("no skills declared → skip", () => {
    const connector = defineConnector({
      id: SKILLS_CONNECTOR_ID,
      displayName: "Acme Skills",
      version: "1.0.0",
      // Use a subagent so the connector has at least one surface (skills omitted).
      subagents: [{ name: "a", description: "d", prompt: "p" }],
    });
    const ctx = buildCtx(projectDir, connector, "user");
    const changes = kimiAdapter.installSkills!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
  });

  it("KIMI_CODE_HOME env var overrides the base dir for skill path", () => {
    const customBase = join(projectDir, "custom-kimi");
    process.env.KIMI_CODE_HOME = customBase;
    const ctx = buildCtx(projectDir, buildSkillsConnector(), "user");
    const changes = kimiAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");

    const skillMd = join(customBase, "skills", "pdf-tools", "SKILL.md");
    expect(existsSync(skillMd)).toBe(true);
  });
});

// ── malformed `hooks` guard (inverse: array-of-tables expected) ──────────────
// kimi's `hooks` is a TOML array-of-tables, so it carries a LOCAL inverse guard
// (not BaseAdapter.malformedHookRootSkip, which is for object-map roots). The
// registry contract (tests/contracts/hook-root-malformed) auto-skips kimi
// because its config is TOML, not JSON — so this is the ONLY place kimi's guard
// is exercised: a present-but-non-array `hooks` (hand-edited to an object /
// primitive) must warn-skip and leave the user's value byte-for-byte untouched,
// never reaching the `.push`/`.findIndex` that would throw on a non-array.
describe("kimi malformed `hooks` guard (non-array → warn-skip, file untouched)", () => {
  let projectDir: string;
  let ctx: InstallContext;
  beforeEach(() => {
    projectDir = freshProject("ac-kimi-malformed-hooks-");
    ctx = buildCtx(projectDir, buildRenderConnector(), "user");
  });

  for (const [label, seed] of [
    ["inline-table object", 'hooks = { event = "PreToolUse" }\n'],
    ["primitive string", 'hooks = "oops"\n'],
  ] as const) {
    it(`warn-skips a present-but-non-array hooks (${label}); file left untouched`, () => {
      const hookPath = kimiAdapter.getHookConfigPath(ctx);
      mkdirSync(dirname(hookPath), { recursive: true });
      writeFileSync(hookPath, seed, "utf8");
      const before = readFileSync(hookPath, "utf8");

      let changes!: ReturnType<typeof kimiAdapter.installHooks>;
      expect(() => {
        changes = kimiAdapter.installHooks(ctx);
      }).not.toThrow();

      const warns = changes.filter((c) => c.action === "warn" && c.path === hookPath);
      expect(warns).toHaveLength(1);
      expect(warns[0]?.detail).toContain("is not an array");
      // Nothing wired, and the user's malformed file is byte-for-byte preserved.
      expect(changes.some((c) => c.action === "create" || c.action === "update")).toBe(false);
      expect(readFileSync(hookPath, "utf8")).toBe(before);
    });
  }
});

// ── scope coherence (per-surface scope resolution) ──────────────────────────
// Regression for the install-path scope incoherence: skillsDir branched on scope
// but getConfigDir ignored it, so a PROJECT-scope install wrote skills into the
// project yet MCP/hooks into the user home. Verified against the kimi-code source:
//   - mcp.json → project-local SUPPORTED (config-loader.ts: project mcp.json wins)
//   - skills   → project-local SUPPORTED (docs/en/customization/skills.md)
//   - config.toml/hooks → USER-ONLY (config/path.ts resolveConfigPath →
//     resolveKimiHome; loadRuntimeConfigSafe reads a single file, no project merge)
// These tests use freshHomeProject (HOME ≠ projectDir) so the project-local root
// is DISTINCT from the user base — the existing freshProject suite (HOME ==
// projectDir) collapses both to one path and so could not catch the bug.
describe("kimi scope coherence", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject("ac-kimi-scope-"));
    unsetKimiBase();
  });

  it("user scope: server + hook + skills all resolve under the user base dir (~/.kimi-code)", () => {
    const ctx = buildCtx(projectDir, buildSkillsConnector(), "user");
    const userBase = join(home, ".kimi-code");
    expect(kimiAdapter.getServerConfigPath(ctx)).toBe(join(userBase, "mcp.json"));
    expect(kimiAdapter.getHookConfigPath(ctx)).toBe(join(userBase, "config.toml"));
    // skillsDir is private; assert via the install change path.
    const change = kimiAdapter.installSkills!(ctx)[0];
    expect(change?.path).toBe(join(userBase, "skills", "pdf-tools", "SKILL.md"));
  });

  it("project scope: server + skills go to <projectDir>/.kimi-code, but hooks STAY in the user base (Kimi reads no project config.toml)", () => {
    const ctx = buildCtx(projectDir, buildSkillsConnector(), "project");
    const projBase = join(projectDir, ".kimi-code");
    const userBase = join(home, ".kimi-code");
    // Distinct roots — the whole point of this regression.
    expect(projBase).not.toBe(userBase);

    // MCP + skills become project-local (Kimi reads them there).
    expect(kimiAdapter.getServerConfigPath(ctx)).toBe(join(projBase, "mcp.json"));
    const skillChange = kimiAdapter.installSkills!(ctx)[0];
    expect(skillChange?.path).toBe(join(projBase, "skills", "pdf-tools", "SKILL.md"));

    // Hooks stay user-only: config.toml has no project-local variant, so a
    // project-scope install must write here or Kimi never fires the hooks.
    expect(kimiAdapter.getHookConfigPath(ctx)).toBe(join(userBase, "config.toml"));
    expect(kimiAdapter.getHookConfigPath(ctx)).not.toContain(projectDir);
  });

  it("project scope: an actual installServer/installHooks run lands MCP project-local and hooks in the user base", () => {
    const ctx = buildCtx(projectDir, buildBaseDirConnector(), "project");
    kimiAdapter.installServer(ctx);
    kimiAdapter.installHooks(ctx);

    const projMcp = join(projectDir, ".kimi-code", "mcp.json");
    const userToml = join(home, ".kimi-code", "config.toml");
    expect(existsSync(projMcp)).toBe(true);
    expect(existsSync(userToml)).toBe(true);
    // The incoherent pre-fix behavior would have written mcp.json to the user
    // base; assert it did NOT land there.
    expect(existsSync(join(home, ".kimi-code", "mcp.json"))).toBe(false);
    // ...and hooks did NOT leak into the project dir.
    expect(existsSync(join(projectDir, ".kimi-code", "config.toml"))).toBe(false);

    const mcp = readJson(projMcp);
    expect(mcp.mcpServers?.[CONNECTOR_ID]).toBeTruthy();
    const toml = readToml(userToml);
    expect(Array.isArray(toml.hooks)).toBe(true);
  });

  it("KIMI_CODE_HOME redirects the user base for hooks even under project scope", () => {
    const custom = join(home, "custom-kimi");
    process.env.KIMI_CODE_HOME = custom;
    const ctx = buildCtx(projectDir, buildBaseDirConnector(), "project");
    // Hooks follow the override (user base), MCP stays project-local.
    expect(kimiAdapter.getHookConfigPath(ctx)).toBe(join(custom, "config.toml"));
    expect(kimiAdapter.getServerConfigPath(ctx)).toBe(
      join(projectDir, ".kimi-code", "mcp.json"),
    );
  });
});
