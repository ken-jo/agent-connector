/**
 * adapters/copilot-cli.test.ts — the ONE per-host file for the GitHub Copilot CLI adapter.
 *
 * copilot-cli is a json-stdio host, user/global scope only (no project-scoped
 * config). Config surfaces:
 *   • MCP servers → ~/.copilot/mcp-config.json, ROOT KEY "mcpServers"; stdio entry
 *                   written as type "local" + tools:["*"]; remote → type "http"
 *                   (Streamable) or "sse" (legacy). No native ${env:VAR} interp →
 *                   env/header/url refs resolve to LITERALS at install time.
 *   • Hooks       → a dedicated ~/.copilot/hooks/agent-connector.json shaped
 *                   { version: 1, hooks: { <camelCaseWireKey>: [ { matcher, hooks:
 *                   [ { type:"command", command } ] } ] } }. The CLI loader honors
 *                   ONLY lowerCamelCase keys (verified Set in app.js) and silently
 *                   drops PascalCase, so events are written via EVENT_WIRE_KEY
 *                   (Stop→agentStop, UserPromptSubmit→userPromptSubmitted, rest
 *                   first-letter-lowercased). The home-bin command token stays
 *                   PascalCase (the AC router event). nativeHooks (e.g.
 *                   errorOccurred) are filed VERBATIM as a sibling declaration.
 *   • Content     → skills + subagents (NO command surface — commands inherit the
 *                   BaseAdapter skip/warn default). user scope → ~/.copilot; project
 *                   scope → the shared <projectDir>/.github tree. skills are
 *                   <dir>/skills/<name>/SKILL.md + resources; subagents are
 *                   md+fm .agent.md (tools as CSV).
 *   • Reply       → JSON on stdout (exit 0): PreToolUse deny/ask via
 *                   hookSpecificOutput.permissionDecision; PermissionRequest uses
 *                   the nested decision{behavior} envelope (allow is an ACTIVE
 *                   grant); PostToolUseFailure/SubagentStart are context-only (deny
 *                   degrades to additionalContext); SubagentStop deny → TOP-LEVEL
 *                   {decision:"block", reason} (Stop semantics); context →
 *                   additionalContext.
 *
 * This file consolidates what used to be split across copilot-cli-native-hooks.test.ts
 * (nativeHooks passthrough), copilot-cli-sse-mcp.test.ts (remote transport type),
 * extended-events-batch.test.ts (E1 extension events — copilot-cli was the last
 * remaining host), phase2-render.test.ts (render/round-trip), and surfaces-s2.test.ts
 * (content surfaces). It uses the shared harness (tests/support/env + adapter-suite
 * + fs) per tests/README.md — ONE file per host.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  PermissionRequestEvent,
  PostToolUseEvent,
  PostToolUseFailureEvent,
  PreToolUseEvent,
  ResolvedConnector,
  StopEvent,
  SubagentStartEvent,
  SubagentStopEvent,
  Transport,
} from "../../src/core/types.js";

import copilotCliAdapter from "../../src/adapters/copilot-cli/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson, splitFrontmatter } from "../support/fs.js";

// ── shared fixtures ──────────────────────────────────────────────────────────

// The render/round-trip + extended-events slices share the canonical stdio
// connector id; the env-ref var feeds the LITERAL-resolution assertion.
const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const SERVER_CWD = "/srv/acme";
const AGENT_MATCHER = "code-reviewer|explore";

// The remote-transport slice uses its own connector id.
const REMOTE_CONNECTOR_ID = "acme-copilot-remote";

// The nativeHooks slice uses its own connector id.
const NATIVE_CONNECTOR_ID = "acme-copilot-native";

// The content-surfaces slice uses its own connector id + fixtures.
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

const SUBAGENT = {
  name: "reviewer",
  description: "Reviews code diffs for correctness bugs.",
  prompt: "You are a meticulous code reviewer. Find correctness bugs.",
  tools: { allow: ["Read", "Grep"] },
  model: "opus",
  readonly: true,
} as const;

/** A connector with a stdio server (env-ref + cwd) + PreToolUse and SessionStart hooks. */
function buildConnector(): ResolvedConnector {
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

/**
 * A connector declaring the four E1 extension events. On the installed CLI
 * 1.0.63 surface only SubagentStop is in the file-hook validator Set; the other
 * three are demoted (not in the Set) and warn-skip at install.
 */
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

/** A connector exercising the two NON-trivial wire mappings (Stop, UserPromptSubmit). */
function buildWireMapConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    hooks: {
      UserPromptSubmit: {
        handler() {
          return { decision: "context", additionalContext: "ups" };
        },
      },
      Stop: {
        handler() {
          return { decision: "allow" };
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

/** A remote (http/sse) connector. */
function remoteConnector(transport: Transport): ResolvedConnector {
  return defineConnector({
    id: REMOTE_CONNECTOR_ID,
    server: { transport, url: "https://mcp.acme.example/endpoint", tools: { include: ["*"] } },
    telemetry: { enabled: false },
  });
}

/** A normalized PreToolUse hook + a copilot-native ErrorOccurred hook. */
function nativeConnector(): ResolvedConnector {
  return defineConnector({
    id: NATIVE_CONNECTOR_ID,
    displayName: "Acme Copilot",
    version: "1.0.0",
    hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
    platforms: {
      "copilot-cli": {
        nativeHooks: {
          ErrorOccurred: { matcher: "Bash", handler: () => ({}) },
        },
      },
    },
  });
}

/** A connector declaring ONLY the supported surfaces (skills + subagents). */
function buildSurfacesConnector(extra?: { commands?: boolean }): ResolvedConnector {
  return defineConnector({
    id: SURFACES_CONNECTOR_ID,
    displayName: "Acme Surfaces",
    version: "1.0.0",
    ...(extra?.commands
      ? { commands: [{ ...COMMAND, tools: { allow: [...COMMAND.tools.allow] } }] }
      : {}),
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

function hooksFile(projectDir: string): string {
  return join(projectDir, ".copilot", "hooks", "agent-connector.json");
}

function serverFile(projectDir: string): string {
  return join(projectDir, ".copilot", "mcp-config.json");
}

function parseStdout(reply: { exitCode: number; stdout?: string }): any {
  expect(reply.stdout).toBeTruthy();
  return JSON.parse(reply.stdout!);
}

/**
 * The serve-wrapper args bake the install TARGET platform as `--host <id>` (before
 * the `--` separator) so the proxy stamps hostPlatform correctly under a headless
 * spawn. copilot-cli is user-scoped, so the wrapper stamps `--scope user`.
 */
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

// Shared env isolation + the same-rules-for-every-host baseline contract.
// extraKeys: the render/round-trip slice mutates ACME_DB_DSN (the env-ref the
// LITERAL-resolution assertion reads). HOME/USERPROFILE/AGENT_CONNECTOR_DATA_DIR
// are covered by isolateEnv's defaults.
isolateEnv([ENV_VAR]);
createAdapterSuite({ adapter: copilotCliAdapter, paradigm: "json-stdio" });

// ── render + round-trip (mcpServers type:"local" + ~/.copilot/hooks PascalCase) ──
// Copilot CLI is user/global scope only → resolves from homedir(); freshProject
// redirects HOME into the sandbox so ~/.copilot/* lands under the temp dir.

describe("copilot-cli adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-p2-render-");
    // Set the env-ref var so literal-resolution produces a known value.
    process.env[ENV_VAR] = ENV_LITERAL;
    ctx = buildCtx(projectDir, buildConnector(), "user");
  });

  it("installServer writes mcpServers.<id> with type 'local' into ~/.copilot/mcp-config.json, env as LITERAL", () => {
    const changes = copilotCliAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = serverFile(projectDir);
    expect(serverPath).toBe(copilotCliAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry).toBeTruthy();

    // stdio is registered as type "local" with a tools allow-list.
    expect(entry.type).toBe("local");
    expect(entry.tools).toEqual(["*"]);

    // Telemetry serve-wrapper: command points at the home binary.
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedArgsUser("copilot-cli"));

    // No native interpolation → env-ref resolves to a LITERAL value.
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installHooks writes ~/.copilot/hooks/agent-connector.json with version 1 + camelCase wire keys", () => {
    const changes = copilotCliAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const hooksPath = hooksFile(projectDir);
    expect(hooksPath).toBe(copilotCliAdapter.getHookConfigPath(ctx));
    expect(existsSync(hooksPath)).toBe(true);

    const cfg = readJson(hooksPath);
    expect(cfg.version).toBe(1);

    // camelCase WIRE keys (NOT PascalCase — the CLI loader drops unknown keys);
    // nested { matcher, hooks: [{ type, command }] } shape.
    const pre = cfg.hooks.preToolUse;
    expect(Array.isArray(pre)).toBe(true);
    // PascalCase key must NOT be present — it would never fire.
    expect(cfg.hooks.PreToolUse).toBeUndefined();
    // A declared matcher is written through as-is (non-empty → key PRESENT).
    expect(pre[0].matcher).toBe("acme_query|acme_write");
    const cmd = pre[0].hooks[0].command;
    expect(cmd).toContain(HOME_BIN);
    // The home-bin command token stays PascalCase (the AC router event).
    expect(cmd).toContain("hook copilot-cli PreToolUse");
    expect(cmd).toContain(`--connector ${CONNECTOR_ID}`);

    // SessionStart → wire key sessionStart, but the command token is PascalCase.
    expect(cfg.hooks.SessionStart).toBeUndefined();
    expect(cfg.hooks.sessionStart[0].hooks[0].command).toContain(
      "hook copilot-cli SessionStart",
    );
    // SessionStart has NO matcher → the key must be ABSENT, never `matcher: ""`.
    // Copilot CLI's schema is `matcher: z.string().min(1).optional()`: an empty
    // string FAILS validation and the loader DISCARDS THE ENTIRE hooks file, so
    // every hook silently stops firing. The key is omitted, not empty.
    expect("matcher" in cfg.hooks.sessionStart[0]).toBe(false);
    expect(cfg.hooks.sessionStart[0].matcher).toBeUndefined();
  });

  it("REGRESSION: never writes `matcher: \"\"` — an empty string discards the whole hooks file", () => {
    // The bug: writing `matcher ?? ""` produced `matcher: ""` on every key, which
    // Copilot CLI rejects ("matcher cannot be empty") → it drops the ENTIRE file
    // and registers ZERO hooks. Drive every supported event (most with NO matcher)
    // and assert no entry anywhere carries an empty-string matcher.
    const connector = defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme DB Tools",
      version: "1.2.3",
      hooks: {
        SessionStart: { handler: () => ({ decision: "allow" }) },
        SessionEnd: { handler: () => ({ decision: "allow" }) },
        UserPromptSubmit: { handler: () => ({ decision: "allow" }) },
        // PreToolUse keeps a real matcher → must still be present + non-empty.
        PreToolUse: { matcher: "acme_query", handler: () => ({ decision: "allow" }) },
        PostToolUse: { handler: () => ({ decision: "allow" }) },
        PreCompact: { handler: () => ({ decision: "allow" }) },
        Stop: { handler: () => ({ decision: "allow" }) },
        SubagentStop: { handler: () => ({ decision: "allow" }) },
      },
    });
    const ctx = buildCtx(projectDir, connector, "user");
    copilotCliAdapter.installHooks(ctx);

    const written = readJson(hooksFile(projectDir));
    // The empty-matcher token must appear NOWHERE in the file.
    const raw = JSON.stringify(written);
    expect(raw).not.toContain('"matcher":""');
    expect(raw).not.toContain('"matcher": ""');

    for (const [key, entries] of Object.entries(written.hooks as Record<string, any[]>)) {
      for (const entry of entries) {
        if ("matcher" in entry) {
          // When present, the matcher is a real non-empty string (never "").
          expect(typeof entry.matcher).toBe("string");
          expect(entry.matcher.length).toBeGreaterThan(0);
        }
      }
      // preToolUse keeps its real matcher; every other event omits the key.
      if (key === "preToolUse") {
        expect(entries[0].matcher).toBe("acme_query");
      } else {
        expect("matcher" in entries[0]).toBe(false);
      }
    }
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    copilotCliAdapter.installServer(ctx);
    const second = copilotCliAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(serverFile(projectDir));
    expect(Object.keys(cfg.mcpServers)).toEqual([CONNECTOR_ID]);
  });

  it("installHooks is idempotent — second call yields skip and does not duplicate entries", () => {
    copilotCliAdapter.installHooks(ctx);
    const second = copilotCliAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    const cfg = readJson(hooksFile(projectDir));
    expect(cfg.hooks.preToolUse).toHaveLength(1);
    expect(cfg.hooks.sessionStart).toHaveLength(1);
  });

  it("uninstallServer + uninstallHooks remove the entries (re-read confirms gone)", () => {
    copilotCliAdapter.installServer(ctx);
    copilotCliAdapter.installHooks(ctx);

    copilotCliAdapter.uninstallServer(ctx);
    const serverCfg = readJson(serverFile(projectDir));
    expect(serverCfg.mcpServers?.[CONNECTOR_ID]).toBeUndefined();

    copilotCliAdapter.uninstallHooks(ctx);
    // Full teardown empties the hooks map → the dedicated file is DELETED, not
    // left as an inert `{version:1,hooks:{}}` stub.
    expect(existsSync(hooksFile(projectDir))).toBe(false);
  });
});

// ── remote MCP transport type (http + sse) ────────────────────────────────────

describe("copilot-cli adapter — remote MCP transport type (http + sse)", () => {
  function readEntry(projectDir: string): Record<string, any> {
    return readJson(serverFile(projectDir)).mcpServers[REMOTE_CONNECTOR_ID];
  }

  it("advertises sse alongside stdio + http", () => {
    expect(copilotCliAdapter.capabilities.transports).toContain("sse");
    expect(copilotCliAdapter.capabilities.transports).toContain("http");
  });

  it('renders an sse server as type:"sse"', () => {
    const projectDir = freshProject("ac-copilot-sse-");
    copilotCliAdapter.installServer(buildCtx(projectDir, remoteConnector("sse"), "user"));
    const entry = readEntry(projectDir);
    expect(entry.type).toBe("sse");
    expect(entry.url).toBe("https://mcp.acme.example/endpoint");
  });

  it('still renders an http server as type:"http" (regression)', () => {
    const projectDir = freshProject("ac-copilot-sse-");
    copilotCliAdapter.installServer(buildCtx(projectDir, remoteConnector("http"), "user"));
    expect(readEntry(projectDir).type).toBe("http");
  });
});

// ── nativeHooks passthrough (ErrorOccurred filed verbatim) ────────────────────

describe("copilot-cli adapter — nativeHooks passthrough", () => {
  function readHooks(projectDir: string): Record<string, any[]> {
    const file = readJson(hooksFile(projectDir));
    return (file.hooks ?? {}) as Record<string, any[]>;
  }

  it("declares supportsNativeHooks true", () => {
    expect(copilotCliAdapter.capabilities.supportsNativeHooks).toBe(true);
  });

  it("installHooks files the native ErrorOccurred key VERBATIM beside the canonical PreToolUse", () => {
    const projectDir = freshProject("ac-copilot-native-");
    copilotCliAdapter.installHooks(buildCtx(projectDir, nativeConnector(), "user"));
    const hooks = readHooks(projectDir);

    // Normalized PreToolUse → camelCase wire key preToolUse (command token stays PascalCase).
    expect(hooks.preToolUse[0].hooks[0].command).toContain("hook copilot-cli PreToolUse");
    // Native key filed verbatim (no EVENT_MAP) — the author supplies the exact key.
    expect(hooks.ErrorOccurred[0].hooks[0].command).toContain("hook copilot-cli ErrorOccurred");
    expect(hooks.ErrorOccurred[0].hooks[0].command).toContain(`--connector ${NATIVE_CONNECTOR_ID}`);
    expect(hooks.ErrorOccurred[0].matcher).toBe("Bash");
  });

  it("nativeHooks install even when normalized hooks are disabled (hooks:false sibling)", () => {
    const projectDir = freshProject("ac-copilot-native-");
    const connector = defineConnector({
      id: NATIVE_CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: {
        "copilot-cli": { hooks: false, nativeHooks: { ErrorOccurred: { handler: () => ({}) } } },
      },
    });
    copilotCliAdapter.installHooks(buildCtx(projectDir, connector, "user"));
    const hooks = readHooks(projectDir);
    expect(hooks.ErrorOccurred[0].hooks[0].command).toContain("hook copilot-cli ErrorOccurred");
    expect(hooks.preToolUse).toBeUndefined(); // normalized disabled by hooks:false
  });

  it("is idempotent (second install → skip) and uninstall removes the native entry", () => {
    const projectDir = freshProject("ac-copilot-native-");
    const ctx = buildCtx(projectDir, nativeConnector(), "user");
    copilotCliAdapter.installHooks(ctx);
    const second = copilotCliAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    copilotCliAdapter.uninstallHooks(ctx);
    // Only AC entries existed → the dedicated file is removed entirely.
    expect(existsSync(hooksFile(projectDir))).toBe(false);
  });

  it("uninstall strips only OUR native entry, leaving a foreign hook intact", () => {
    const projectDir = freshProject("ac-copilot-native-");
    const ctx = buildCtx(projectDir, nativeConnector(), "user");
    copilotCliAdapter.installHooks(ctx);
    // Seed a foreign (non-AC) hook under the same native key.
    const path = hooksFile(projectDir);
    const file = JSON.parse(readFileSync(path, "utf8"));
    file.hooks.ErrorOccurred.push({ matcher: "", hooks: [{ type: "command", command: "/usr/bin/other run" }] });
    writeFileSync(path, JSON.stringify(file));

    copilotCliAdapter.uninstallHooks(ctx);
    const hooks = readHooks(projectDir);
    const flat = JSON.stringify(hooks);
    expect(flat).toContain("other run"); // foreign survives
    expect(flat).not.toContain(HOME_BIN); // every AC command gone
    // Rewriting the surviving foreign entry must NOT re-introduce `matcher: ""`
    // (the seed carried an empty matcher; uninstall drops the key, not keeps "").
    expect(flat).not.toContain('"matcher":""');
    expect("matcher" in hooks.ErrorOccurred[0]).toBe(false);
  });
});

// ── extended events (E1): only SubagentStop is loadable; the other three are demoted ──

describe("copilot-cli — extended-event install", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-ext-events-");
    ctx = buildCtx(projectDir, buildExtConnector(), "user");
  });

  it("writes ONLY SubagentStop (→subagentStop); warn-skips the three demoted events", () => {
    const changes = copilotCliAdapter.installHooks(ctx);

    // The three events absent from the CLI 1.0.63 file-hook Set warn-skip.
    for (const event of ["PermissionRequest", "PostToolUseFailure", "SubagentStart"]) {
      const warn = changes.find(
        (c) => c.action === "warn" && c.detail === `${event} unsupported on copilot-cli — skipped`,
      );
      expect(warn).toBeTruthy();
    }

    const hooksPath = hooksFile(projectDir);
    expect(existsSync(hooksPath)).toBe(true);
    const cfg = readJson(hooksPath);
    expect(cfg.version).toBe(1);

    // SubagentStop is in the Set → written under its camelCase wire key.
    expect(cfg.hooks.subagentStop[0].matcher).toBe(AGENT_MATCHER);
    expect(cfg.hooks.subagentStop[0].hooks[0].command).toContain(
      "hook copilot-cli SubagentStop",
    );

    // None of the demoted events — nor any PascalCase key — landed on disk.
    for (const key of [
      "PermissionRequest",
      "permissionRequest",
      "PostToolUseFailure",
      "postToolUseFailure",
      "SubagentStart",
      "subagentStart",
      "SubagentStop",
    ]) {
      expect(cfg.hooks[key]).toBeUndefined();
    }
  });
});

// ── REGRESSION: pin the exact lowerCamelCase wire-key casing ──────────────────
// The installed GitHub Copilot CLI 1.0.63 loader honors ONLY these camelCase
// keys (hardcoded validator Set in app.js) and SILENTLY DROPS any other key, so
// a PascalCase key means the hook NEVER FIRES. This test pins the byte-level
// wire keys (incl. the two non-trivial maps Stop→agentStop and
// UserPromptSubmit→userPromptSubmitted) so a regression to PascalCase fails CI.

describe("copilot-cli — hook wire-key casing (regression pin)", () => {
  it("Stop→agentStop and UserPromptSubmit→userPromptSubmitted (NOT a naive lowercase)", () => {
    const projectDir = freshProject("ac-wire-key-");
    const ctx = buildCtx(projectDir, buildWireMapConnector(), "user");
    copilotCliAdapter.installHooks(ctx);
    const cfg = readJson(hooksFile(projectDir));

    // The two NON-trivial mappings.
    expect(cfg.hooks.agentStop).toBeDefined();
    expect(cfg.hooks.userPromptSubmitted).toBeDefined();
    // Their PascalCase / naive-lowercase forms must be ABSENT.
    expect(cfg.hooks.Stop).toBeUndefined();
    expect(cfg.hooks.stop).toBeUndefined();
    expect(cfg.hooks.UserPromptSubmit).toBeUndefined();
    expect(cfg.hooks.userPromptSubmit).toBeUndefined();

    // The command token stays the PascalCase AC router event.
    expect(cfg.hooks.agentStop[0].hooks[0].command).toContain("hook copilot-cli Stop");
    expect(cfg.hooks.userPromptSubmitted[0].hooks[0].command).toContain(
      "hook copilot-cli UserPromptSubmit",
    );
  });

  it("every written hooks key is a member of the CLI's camelCase validator Set", () => {
    // The exact Set hardcoded in GitHub Copilot CLI 1.0.63 (app.js).
    const VALID_WIRE_KEYS = new Set([
      "sessionStart",
      "sessionEnd",
      "userPromptSubmitted",
      "preToolUse",
      "postToolUse",
      "errorOccurred",
      "agentStop",
      "subagentStop",
      "preCompact",
    ]);
    const projectDir = freshProject("ac-wire-key-set-");
    // Drive the full set of supported normalized events at once.
    const connector = defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme DB Tools",
      version: "1.2.3",
      hooks: {
        SessionStart: { handler: () => ({ decision: "allow" }) },
        SessionEnd: { handler: () => ({ decision: "allow" }) },
        UserPromptSubmit: { handler: () => ({ decision: "allow" }) },
        PreToolUse: { handler: () => ({ decision: "allow" }) },
        PostToolUse: { handler: () => ({ decision: "allow" }) },
        PreCompact: { handler: () => ({ decision: "allow" }) },
        Stop: { handler: () => ({ decision: "allow" }) },
        SubagentStop: { handler: () => ({ decision: "allow" }) },
      },
    });
    copilotCliAdapter.installHooks(buildCtx(projectDir, connector, "user"));
    const cfg = readJson(hooksFile(projectDir));
    for (const key of Object.keys(cfg.hooks)) {
      expect(VALID_WIRE_KEYS.has(key)).toBe(true);
    }
    // All eight supported events made it onto disk under their wire keys.
    expect(Object.keys(cfg.hooks).sort()).toEqual(
      [
        "agentStop",
        "preCompact",
        "preToolUse",
        "postToolUse",
        "sessionEnd",
        "sessionStart",
        "subagentStop",
        "userPromptSubmitted",
      ].sort(),
    );
  });
});

// ── capability gate: unsupported events warn-skip, never written to hooks.json ──
// Copilot CLI delivers every canonical event EXCEPT PostCompact (no post-
// compaction hook → postCompact unset on `capabilities`). installHooks must
// filter declared events against capabilities BEFORE writing — a connector that
// declares PostCompact must get only a graceful warn ChangeRecord, never a dead
// hooks.PostCompact the host never fires. Mirrors goose's equivalent gate test.

describe("copilot-cli — capability gate (unsupported PostCompact warn-skips)", () => {
  function gateConnector(): ResolvedConnector {
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
        PostCompact: {
          handler() {
            return { decision: "allow" };
          },
        },
      },
    });
  }

  it("SKIPS PostCompact with a warn but still writes PreToolUse", () => {
    const projectDir = freshProject("ac-copilot-gate-");
    const ctx = buildCtx(projectDir, gateConnector(), "user");

    const changes = copilotCliAdapter.installHooks(ctx);

    // PostCompact is unsupported on copilot-cli → a warn ChangeRecord, never written.
    const warn = changes.find(
      (c) => c.action === "warn" && c.detail?.includes("PostCompact"),
    );
    expect(warn).toBeTruthy();
    expect(warn?.detail).toBe("PostCompact unsupported on copilot-cli — skipped");

    // PreToolUse IS supported → created under its camelCase wire key.
    expect(
      changes.some((c) => c.action === "create" && c.detail === "hooks.preToolUse"),
    ).toBe(true);

    // No change record wrote a PostCompact key (any casing).
    expect(
      changes.some(
        (c) =>
          c.action !== "warn" &&
          (c.detail === "hooks.PostCompact" || c.detail === "hooks.postCompact"),
      ),
    ).toBe(false);

    // The on-disk file carries preToolUse but NOT the unsupported PostCompact.
    const cfg = readJson(hooksFile(projectDir));
    expect(cfg.hooks.preToolUse).toBeTruthy();
    expect(cfg.hooks.preToolUse[0].hooks[0].command).toContain(
      "hook copilot-cli PreToolUse",
    );
    expect(cfg.hooks.PostCompact).toBeUndefined();
    expect(cfg.hooks.postCompact).toBeUndefined();
  });
});

describe("copilot-cli — extended-event parse", () => {
  const COMMON = {
    session_id: "sess-1",
    transcript_path:
      "/home/dev/.copilot/history/0a1b2c3d-0a1b-4c3d-8e5f-0a1b2c3d4e5f.jsonl",
    cwd: "/home/dev/acme",
  };

  // ── Source: github/docs content/copilot/reference/hooks-reference.md ──
  // false-friend fixes (kimi #189 class): the VS Code-compatible dialect the
  // host actually writes carries different field names than the adapter once
  // read. Each assertion below mirrors the per-event input section cited.

  it("PostToolUse reads tool_result.text_result_for_llm into toolOutput (ref 397-400)", () => {
    const evt = copilotCliAdapter.parseEvent!("PostToolUse", {
      ...COMMON,
      tool_name: "bash",
      tool_input: { command: "echo hi" },
      tool_result: { result_type: "success", text_result_for_llm: "out" },
    }) as PostToolUseEvent;
    expect(evt.toolName).toBe("bash");
    expect(evt.toolOutput).toBe("out");
    // PostToolUse is success-only; failures come via PostToolUseFailure.
    expect(evt.isError).toBeUndefined();
  });

  it("PostToolUse ignores the phantom tool_response field (toolOutput stays unset)", () => {
    const evt = copilotCliAdapter.parseEvent!("PostToolUse", {
      ...COMMON,
      tool_name: "bash",
      tool_input: { command: "echo hi" },
      // Field the host never emits — must NOT surface as toolOutput.
      tool_response: "legacy-output",
    } as Record<string, unknown>) as PostToolUseEvent;
    expect(evt.toolOutput).toBeUndefined();
  });

  it("PermissionRequest maps tool_name/tool_input only — no permission_suggestions (ref 218,627-649)", () => {
    const evt = copilotCliAdapter.parseEvent!("PermissionRequest", {
      ...COMMON,
      tool_name: "bash",
      tool_input: { command: "rm -rf /tmp/x" },
      // Phantom field — the host uses the PreToolUse shape; must be ignored.
      permission_suggestions: [{ behavior: "allow" }],
    } as Record<string, unknown>) as PermissionRequestEvent;
    expect(evt.hostPlatform).toBe("copilot-cli");
    expect(evt.toolName).toBe("bash");
    expect(evt.toolInput).toEqual({ command: "rm -rf /tmp/x" });
    expect(evt.permissionSuggestions).toBeUndefined();
    expect(evt.sessionId).toBe("0a1b2c3d-0a1b-4c3d-8e5f-0a1b2c3d4e5f");
  });

  it("PostToolUseFailure maps {tool_name,tool_input,error}; ignores phantom correlation fields (ref 421-430)", () => {
    const evt = copilotCliAdapter.parseEvent!("PostToolUseFailure", {
      ...COMMON,
      tool_name: "bash",
      tool_input: { command: "make test" },
      error: "exit status 2",
      // None of these are in the host payload — must NOT surface.
      tool_use_id: "call_01",
      is_interrupt: false,
      duration_ms: 1234,
    } as Record<string, unknown>) as PostToolUseFailureEvent;
    expect(evt.error).toBe("exit status 2");
    expect(evt.toolUseId).toBeUndefined();
    expect(evt.isInterrupt).toBeUndefined();
    expect(evt.durationMs).toBeUndefined();

    const minimal = copilotCliAdapter.parseEvent!("PostToolUseFailure", {
      tool_name: "write",
    }) as PostToolUseFailureEvent;
    expect(minimal.error).toBe("");
  });

  it("SubagentStart maps agent_name → agentId; no agent_type (ref 467-476)", () => {
    const start = copilotCliAdapter.parseEvent!("SubagentStart", {
      ...COMMON,
      agent_name: "code-reviewer",
      agent_display_name: "Code Reviewer",
      // Phantom legacy fields — must be ignored.
      agent_id: "agent-7",
      agent_type: "reviewer",
    } as Record<string, unknown>) as SubagentStartEvent;
    expect(start.agentId).toBe("code-reviewer");
    expect(start.agentType).toBeUndefined();
  });

  it("SubagentStop maps agent_name → agentId and base transcript_path → agentTranscriptPath; drops phantom reads (ref 497-507)", () => {
    const stop = copilotCliAdapter.parseEvent!("SubagentStop", {
      ...COMMON,
      agent_name: "code-reviewer",
      agent_display_name: "Code Reviewer",
      stop_reason: "end_turn",
      // Phantom fields the host never emits — must NOT surface.
      agent_id: "agent-7",
      agent_type: "reviewer",
      agent_transcript_path: "/x/subagents/agent-7.jsonl",
      last_assistant_message: "review complete",
      stop_hook_active: true,
    } as Record<string, unknown>) as SubagentStopEvent;
    expect(stop.agentId).toBe("code-reviewer");
    expect(stop.agentType).toBeUndefined();
    // The subagent transcript is the BASE transcript_path (from COMMON).
    expect(stop.agentTranscriptPath).toBe(COMMON.transcript_path);
    expect(stop.lastAssistantMessage).toBeUndefined();
    expect(stop.stopHookActive).toBeUndefined();
  });

  it("Stop drops stop_hook_active — host signals via stop_reason (ref 449-457)", () => {
    const stop = copilotCliAdapter.parseEvent!("Stop", {
      ...COMMON,
      stop_reason: "end_turn",
      // Phantom field — must NOT surface.
      stop_hook_active: true,
    } as Record<string, unknown>) as StopEvent;
    expect(stop.stopHookActive).toBeUndefined();
    expect(stop.sessionId).toBe("0a1b2c3d-0a1b-4c3d-8e5f-0a1b2c3d4e5f");
  });
});

describe("copilot-cli — extended-event replies", () => {
  it("PermissionRequest deny → nested decision{behavior:'deny', message}", () => {
    const reply = parseStdout(
      copilotCliAdapter.formatReply!("PermissionRequest", {
        decision: "deny",
        reason: "not on my watch",
      }),
    );
    expect(reply.hookSpecificOutput).toEqual({
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "not on my watch" },
    });
  });

  it("PermissionRequest explicit allow → ACTIVE grant; modify carries updatedInput", () => {
    const allowed = parseStdout(
      copilotCliAdapter.formatReply!("PermissionRequest", { decision: "allow" }),
    );
    expect(allowed.hookSpecificOutput.decision).toEqual({ behavior: "allow" });

    const modified = parseStdout(
      copilotCliAdapter.formatReply!("PermissionRequest", {
        decision: "modify",
        updatedInput: { command: "ls" },
      }),
    );
    expect(modified.hookSpecificOutput.decision).toEqual({
      behavior: "allow",
      updatedInput: { command: "ls" },
    });
  });

  it("PermissionRequest ask/void emit NO decision (fall through to the native dialog)", () => {
    expect(
      copilotCliAdapter.formatReply!("PermissionRequest", { decision: "ask" }),
    ).toEqual({ exitCode: 0 });
    expect(copilotCliAdapter.formatReply!("PermissionRequest", {})).toEqual({
      exitCode: 0,
    });
  });

  it("PostToolUseFailure + SubagentStart: deny DEGRADES to additionalContext+reason", () => {
    for (const event of ["PostToolUseFailure", "SubagentStart"] as const) {
      const reply = parseStdout(
        copilotCliAdapter.formatReply!(event, {
          decision: "deny",
          reason: "not blockable",
        }),
      );
      expect(reply.hookSpecificOutput).toEqual({
        hookEventName: event,
        additionalContext: "not blockable",
      });
    }
  });

  it("SubagentStop deny → TOP-LEVEL {decision:'block', reason}; Stop deny is unchanged (regression guard)", () => {
    const subagent = parseStdout(
      copilotCliAdapter.formatReply!("SubagentStop", {
        decision: "deny",
        reason: "keep going",
      }),
    );
    expect(subagent).toEqual({ decision: "block", reason: "keep going" });

    const stop = parseStdout(
      copilotCliAdapter.formatReply!("Stop", { decision: "deny", reason: "halt" }),
    );
    expect(stop.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

// ── PreToolUse: FLAT permission reply + camelCase stdin (live 1.0.63 wire) ────
// Two LIVE-VERIFIED bugs on GitHub Copilot CLI 1.0.63 (deep hook-reply verify):
//   1. formatReply emitted a NESTED hookSpecificOutput.permissionDecision, but
//      the bundle (app.js) reads the decision FLAT at the TOP LEVEL — there is
//      NO hookSpecificOutput wrapper in 1.0.63 — so the deny was SILENTLY
//      IGNORED and the tool ran. The fix emits the flat shape the host honors.
//   2. parseEvent read snake_case tool_name/tool_input/session_id, but the
//      PreToolUse stdin is camelCase { sessionId, cwd, toolName, toolArgs } where
//      toolArgs is a JSON-STRING. The fix parses the camelCase wire.
// These tests are the byte oracle pinning both fixes against regression.

describe("copilot-cli — PreToolUse FLAT permission reply (1.0.63 bug-1 regression)", () => {
  it("deny → FLAT { permissionDecision:'deny', permissionDecisionReason } (NO hookSpecificOutput wrapper)", () => {
    const reply = parseStdout(
      copilotCliAdapter.formatReply!("PreToolUse", {
        decision: "deny",
        reason: "blocked tool",
      }),
    );
    // FLAT top-level keys — exactly what the bundle's reply reader consumes.
    expect(reply).toEqual({
      permissionDecision: "deny",
      permissionDecisionReason: "blocked tool",
    });
    // The nested wrapper that 1.0.63 ignores must be ABSENT.
    expect(reply.hookSpecificOutput).toBeUndefined();
  });

  it("deny with no reason → FLAT deny with a default reason (still top-level)", () => {
    const reply = parseStdout(
      copilotCliAdapter.formatReply!("PreToolUse", { decision: "deny" }),
    );
    expect(reply.permissionDecision).toBe("deny");
    expect(typeof reply.permissionDecisionReason).toBe("string");
    expect(reply.permissionDecisionReason.length).toBeGreaterThan(0);
    expect(reply.hookSpecificOutput).toBeUndefined();
  });

  it("ask → FLAT { permissionDecision:'ask', permissionDecisionReason }", () => {
    const reply = parseStdout(
      copilotCliAdapter.formatReply!("PreToolUse", {
        decision: "ask",
        reason: "confirm please",
      }),
    );
    expect(reply).toEqual({
      permissionDecision: "ask",
      permissionDecisionReason: "confirm please",
    });
    expect(reply.hookSpecificOutput).toBeUndefined();
  });

  it("modify → FLAT { modifiedArgs } (the host reads top-level modifiedArgs, not updatedInput)", () => {
    const reply = parseStdout(
      copilotCliAdapter.formatReply!("PreToolUse", {
        decision: "modify",
        updatedInput: { command: "ls -la" },
      }),
    );
    expect(reply).toEqual({ modifiedArgs: { command: "ls -la" } });
    expect(reply.hookSpecificOutput).toBeUndefined();
    // The old nested updatedInput key must NOT be emitted.
    expect(reply.updatedInput).toBeUndefined();
  });

  it("allow / void / context → pass through with exit 0 (no honored reply on 1.0.63)", () => {
    expect(copilotCliAdapter.formatReply!("PreToolUse", { decision: "allow" })).toEqual({
      exitCode: 0,
    });
    expect(copilotCliAdapter.formatReply!("PreToolUse", {})).toEqual({ exitCode: 0 });
    // context has no additionalContext mechanism on 1.0.63 → no-op, exit 0.
    expect(
      copilotCliAdapter.formatReply!("PreToolUse", {
        decision: "context",
        additionalContext: "hint",
      }),
    ).toEqual({ exitCode: 0 });
  });
});

describe("copilot-cli — PreToolUse camelCase stdin (1.0.63 bug-2 regression)", () => {
  it("reads camelCase toolName + toolArgs (JSON-STRING) into toolName/toolInput", () => {
    const evt = copilotCliAdapter.parseEvent!("PreToolUse", {
      sessionId: "sess-camel",
      cwd: "/home/dev/acme",
      toolName: "bash",
      // The live wire serializes toolArgs as a JSON STRING.
      toolArgs: JSON.stringify({ command: "rm -rf /tmp/x" }),
    }) as PreToolUseEvent;
    expect(evt.toolName).toBe("bash");
    expect(evt.toolInput).toEqual({ command: "rm -rf /tmp/x" });
    // sessionId (camelCase) flows through (no transcript_path here).
    expect(evt.sessionId).toBe("sess-camel");
    expect(evt.projectDir).toBe("/home/dev/acme");
  });

  it("accepts an already-object toolArgs as-is", () => {
    const evt = copilotCliAdapter.parseEvent!("PreToolUse", {
      toolName: "write",
      toolArgs: { path: "/a", content: "x" },
    }) as PreToolUseEvent;
    expect(evt.toolName).toBe("write");
    expect(evt.toolInput).toEqual({ path: "/a", content: "x" });
  });

  it("a non-JSON toolArgs string degrades to an empty tool input (no throw)", () => {
    const evt = copilotCliAdapter.parseEvent!("PreToolUse", {
      toolName: "bash",
      toolArgs: "not json",
    }) as PreToolUseEvent;
    expect(evt.toolName).toBe("bash");
    expect(evt.toolInput).toEqual({});
  });

  it("snake_case tool_name/tool_input remain a tolerant fallback (no regression)", () => {
    const evt = copilotCliAdapter.parseEvent!("PreToolUse", {
      session_id: "sess-snake",
      tool_name: "grep",
      tool_input: { pattern: "TODO" },
    }) as PreToolUseEvent;
    expect(evt.toolName).toBe("grep");
    expect(evt.toolInput).toEqual({ pattern: "TODO" });
    expect(evt.sessionId).toBe("sess-snake");
  });

  it("PostToolUse reads camelCase toolResult.textResultForLlm (live wire) + keeps snake_case fallback", () => {
    // Live 1.0.63 camelCase dialect.
    const camel = copilotCliAdapter.parseEvent!("PostToolUse", {
      sessionId: "s",
      toolName: "bash",
      toolArgs: JSON.stringify({ command: "echo hi" }),
      toolResult: { resultType: "success", textResultForLlm: "out-camel" },
    }) as PostToolUseEvent;
    expect(camel.toolName).toBe("bash");
    expect(camel.toolInput).toEqual({ command: "echo hi" });
    expect(camel.toolOutput).toBe("out-camel");

    // snake_case fallback still parses (prior PRs' fixture shape).
    const snake = copilotCliAdapter.parseEvent!("PostToolUse", {
      tool_name: "bash",
      tool_input: { command: "echo hi" },
      tool_result: { result_type: "success", text_result_for_llm: "out-snake" },
    }) as PostToolUseEvent;
    expect(snake.toolOutput).toBe("out-snake");
  });
});

// ── capability: no additionalContext mechanism on 1.0.63 ──────────────────────

describe("copilot-cli — canInjectSessionContext demoted (no additionalContext on 1.0.63)", () => {
  it("declares canInjectSessionContext false (fail-safe; bundle has no additionalContext)", () => {
    expect(copilotCliAdapter.capabilities.canInjectSessionContext).toBe(false);
  });
});

// ── content surfaces: NO commands / skills / subagents (shared .github tree) ──

describe("copilot-cli adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-surfaces-s2-");
    // Declare ONLY the supported surfaces (skills + subagents). Commands are
    // unsupported on Copilot CLI; with none declared they resolve to a skip.
    ctx = buildCtx(projectDir, buildSurfacesConnector());
  });

  it("declares skills + subagents but NOT commands", () => {
    expect(copilotCliAdapter.capabilities.supportsCommands).toBe(false);
    expect(copilotCliAdapter.capabilities.supportsSkills).toBe(true);
    expect(copilotCliAdapter.capabilities.supportsSubagents).toBe(true);
  });

  it("installCommands is unsupported → BaseAdapter skip/warn, writes no prompt file", () => {
    // Even when a command IS declared, Copilot CLI has no command surface: the
    // BaseAdapter default routes it through warn (declared) without writing any
    // native file. The CONTRACT permits warn OR skip here.
    const withCmd = buildCtx(projectDir, buildSurfacesConnector({ commands: true }));
    const changes = copilotCliAdapter.installCommands!(withCmd);
    expect(changes).toHaveLength(1);
    expect(["warn", "skip"]).toContain(changes[0]?.action);
    expect(existsSync(join(projectDir, ".github", "prompts", "deploy.prompt.md"))).toBe(false);
  });

  it("installSkills writes uniform SKILL.md + resource (project scope under .github)", () => {
    copilotCliAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".github", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".github", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    const { frontmatter } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
  });

  it("installSubagents (project scope) writes md+fm .github/agents/<n>.agent.md", () => {
    const changes = copilotCliAdapter.installSubagents!(ctx);
    expect(changes[0]?.action).toBe("create");
    const agentPath = join(projectDir, ".github", "agents", "reviewer.agent.md");
    expect(changes[0]?.path).toBe(agentPath);
    expect(existsSync(agentPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(agentPath, "utf8"));
    expect(frontmatter.name).toBe("reviewer");
    expect(frontmatter.description).toBe(SUBAGENT.description);
    expect(frontmatter.tools).toBe("Read, Grep");
    expect(frontmatter.model).toBe("opus");
    expect(body.trim()).toBe(SUBAGENT.prompt);
  });

  it("installSubagents (USER scope) writes to ~/.copilot/agents (HOME temp)", () => {
    const userCtx = buildCtx(projectDir, buildSurfacesConnector(), "user");
    const changes = copilotCliAdapter.installSubagents!(userCtx);
    expect(changes[0]?.action).toBe("create");

    // HOME redirected to projectDir → ~/.copilot === projectDir/.copilot.
    const agentPath = join(projectDir, ".copilot", "agents", "reviewer.agent.md");
    expect(changes[0]?.path).toBe(agentPath);
    expect(existsSync(agentPath)).toBe(true);
    // Must NOT have written into the shared project .github tree at user scope.
    expect(existsSync(join(projectDir, ".github", "agents", "reviewer.agent.md"))).toBe(false);
  });

  it("is idempotent — second install yields skip (skills + subagents)", () => {
    copilotCliAdapter.installSkills!(ctx);
    copilotCliAdapter.installSubagents!(ctx);
    expect(copilotCliAdapter.installSkills!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(copilotCliAdapter.installSubagents!(ctx).every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall removes skill + subagent files (project scope)", () => {
    copilotCliAdapter.installSkills!(ctx);
    copilotCliAdapter.installSubagents!(ctx);
    copilotCliAdapter.uninstallSkills!(ctx);
    copilotCliAdapter.uninstallSubagents!(ctx);
    expect(existsSync(join(projectDir, ".github", "skills", "pdf-tools"))).toBe(false);
    expect(existsSync(join(projectDir, ".github", "agents", "reviewer.agent.md"))).toBe(false);
  });
});
