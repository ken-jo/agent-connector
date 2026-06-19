/**
 * adapters/vscode-copilot.test.ts — the ONE per-host file for the VS Code Copilot adapter.
 *
 * vscode-copilot is a json-stdio host. Config surfaces:
 *   • MCP servers → <configDir>/mcp.json, ROOT KEY "servers" (NOT "mcpServers" —
 *                   the single most common VS Code footgun); stdio entry { type:
 *                   "stdio", command, args?, env?, cwd? }; remote → { type:
 *                   "http"|"sse", url }; env-refs keep VS Code's NATIVE ${env:VAR}
 *                   token.
 *   • Hooks       → <projectDir>/.github/hooks/<connector-id>.json, shape {
 *                   version: 1, hooks: { <PascalCaseEvent>: [ { type:"command",
 *                   command } ] } } — FLAT command objects (no { matcher, hooks:[…] }
 *                   wrapper). The top-level version:1 is REQUIRED. Events map 1:1
 *                   to PascalCase keys; unsupported events warn-skip.
 *   • Content     → <projectDir>/.github/{prompts,skills,agents}: commands are
 *                   md+fm .prompt.md (tools as ARRAY); skills are <name>/SKILL.md +
 *                   resources; subagents are md+fm .agent.md (tools as CSV).
 *   • Reply       → JSON on stdout (exit 0): PreToolUse deny/ask flow through
 *                   hookSpecificOutput.permissionDecision; the post-execution /
 *                   turn-control events (PostToolUse, Stop, UserPromptSubmit,
 *                   SubagentStop) block via the TOP-LEVEL { decision:"block", reason }
 *                   shape; context → hookSpecificOutput.additionalContext;
 *                   SubagentStart is observe/context-only.
 *
 * This file consolidates what used to be split across vscode-copilot-events.test.ts
 * (UserPromptSubmit + Stop), extended-events-batch.test.ts (E1 extension events),
 * phase2-render.test.ts (render/round-trip), and surfaces-s2.test.ts (content
 * surfaces). It uses the shared harness (tests/support/env + adapter-suite + fs)
 * per tests/README.md — ONE file per host.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  ResolvedConnector,
  StopEvent,
  SubagentStartEvent,
  SubagentStopEvent,
  UserPromptSubmitEvent,
} from "../../src/core/types.js";

import vscodeCopilotAdapter from "../../src/adapters/vscode-copilot/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson, splitFrontmatter } from "../support/fs.js";

// ── shared fixtures ──────────────────────────────────────────────────────────

// The render/round-trip slice declares a stdio server with an env-ref so the
// native ${env:VAR} passthrough produces a known value.
const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const SERVER_CWD = "/srv/acme";
const AGENT_MATCHER = "code-reviewer|explore";

// The UserPromptSubmit + Stop slice uses its own connector id.
const EVENTS_CONNECTOR_ID = "acme-vsc";

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

/** A connector declaring the UserPromptSubmit + Stop events. */
function buildEventsConnector(): ResolvedConnector {
  return defineConnector({
    id: EVENTS_CONNECTOR_ID,
    displayName: "Acme VSC",
    version: "1.0.0",
    hooks: {
      UserPromptSubmit: { handler: () => ({ decision: "allow" }) },
      Stop: { handler: () => ({ decision: "allow" }) },
    },
  });
}

/** A connector declaring a command + skill (with a resource) + subagent. */
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

function hooksFile(projectDir: string, connectorId: string): string {
  return join(projectDir, ".github", "hooks", `${connectorId}.json`);
}

function parseStdout(reply: { exitCode: number; stdout?: string }): any {
  expect(reply.stdout).toBeTruthy();
  return JSON.parse(reply.stdout!);
}

/**
 * The serve-wrapper args bake the install TARGET platform as `--host <id>` (before
 * the `--` separator) so the proxy stamps hostPlatform correctly under a headless
 * spawn. (Render slice for vscode-copilot — project scope.)
 */
const wrappedArgs = (host: string): string[] => [
  "serve",
  "--connector",
  CONNECTOR_ID,
  "--scope",
  "project",
  "--host",
  host,
  "--",
  "npx",
  "-y",
  "@x/y",
];

// Shared env isolation + the same-rules-for-every-host baseline contract.
// extraKeys: the render/round-trip slice mutates ACME_DB_DSN (the ${env:VAR}
// passthrough ref). HOME/USERPROFILE/AGENT_CONNECTOR_DATA_DIR are covered by
// isolateEnv's defaults.
isolateEnv([ENV_VAR]);
createAdapterSuite({ adapter: vscodeCopilotAdapter, paradigm: "json-stdio" });

// ── render + round-trip (servers root key + .github/hooks PascalCase) ─────────

describe("vscode-copilot adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-p2-render-");
    // Set the env-ref var so the native ${env:VAR} passthrough has a known value.
    process.env[ENV_VAR] = ENV_LITERAL;
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("installServer writes the entry under ROOT KEY 'servers' (NOT 'mcpServers'), wrapped, env as native ${env:VAR}", () => {
    const changes = vscodeCopilotAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".vscode", "mcp.json");
    expect(serverPath).toBe(vscodeCopilotAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    // The single most common VS Code footgun: root key is "servers", not "mcpServers".
    expect(cfg).toHaveProperty("servers");
    expect(cfg).not.toHaveProperty("mcpServers");

    const entry = cfg.servers[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.type).toBe("stdio");

    // Telemetry serve-wrapper: command points at the home binary.
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedArgs("vscode-copilot"));

    // VS Code keeps a NATIVE interpolation token (${env:VAR}) — secret not baked in.
    expect(entry.env[ENV_VAR]).toBe(`\${env:${ENV_VAR}}`);
    expect(entry.env[ENV_VAR]).not.toBe(ENV_LITERAL);

    // cwd flows through as the native `cwd` key (VS Code stdio shape).
    expect(entry.cwd).toBe(SERVER_CWD);
  });

  it("remote transports: sse → type:'sse', http → type:'http' (URL entry, no command)", () => {
    const mk = (transport: "sse" | "http", url: string) =>
      defineConnector({
        id: CONNECTOR_ID,
        displayName: "Remote",
        version: "1.0.0",
        server: { transport, url, tools: { include: ["*"] } },
      });

    // SSE → explicit type:"sse" (forces SSE-only, no Streamable-HTTP attempt).
    const ssePd = freshProject("ac-p2-render-");
    vscodeCopilotAdapter.installServer(buildCtx(ssePd, mk("sse", "https://ex.com/sse")));
    const sse = readJson(join(ssePd, ".vscode", "mcp.json")).servers[CONNECTOR_ID];
    expect(sse.type).toBe("sse");
    expect(sse.url).toBe("https://ex.com/sse");
    expect("command" in sse).toBe(false);

    // HTTP → type:"http".
    const httpPd = freshProject("ac-p2-render-");
    vscodeCopilotAdapter.installServer(buildCtx(httpPd, mk("http", "https://ex.com/mcp")));
    const http = readJson(join(httpPd, ".vscode", "mcp.json")).servers[CONNECTOR_ID];
    expect(http.type).toBe("http");
    expect(http.url).toBe("https://ex.com/mcp");
  });

  it("installHooks writes a .github/hooks/<id>.json with PascalCase event names + version 1, command at the home bin", () => {
    const changes = vscodeCopilotAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const hooksPath = join(projectDir, ".github", "hooks", `${CONNECTOR_ID}.json`);
    expect(hooksPath).toBe(vscodeCopilotAdapter.getHookConfigPath(ctx));
    expect(existsSync(hooksPath)).toBe(true);

    const cfg = readJson(hooksPath);
    // The required top-level version — a version-less file is rejected by Copilot.
    expect(cfg.version).toBe(1);

    // PascalCase event keys + FLAT { type, command } entries.
    const pre = cfg.hooks.PreToolUse;
    expect(Array.isArray(pre)).toBe(true);
    expect(pre[0].type).toBe("command");
    expect(pre[0].command).toContain(HOME_BIN);
    expect(pre[0].command).toContain("hook vscode-copilot PreToolUse");
    expect(pre[0].command).toContain(`--connector ${CONNECTOR_ID}`);

    // SessionStart is registered too (PascalCase, in the VS Code event map).
    expect(cfg.hooks.SessionStart[0].command).toContain(
      "hook vscode-copilot SessionStart",
    );
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    vscodeCopilotAdapter.installServer(ctx);
    const second = vscodeCopilotAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(join(projectDir, ".vscode", "mcp.json"));
    expect(Object.keys(cfg.servers)).toEqual([CONNECTOR_ID]);
  });

  it("installHooks is idempotent — second call yields skip and does not duplicate entries", () => {
    vscodeCopilotAdapter.installHooks(ctx);
    const second = vscodeCopilotAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    const cfg = readJson(
      join(projectDir, ".github", "hooks", `${CONNECTOR_ID}.json`),
    );
    expect(cfg.hooks.PreToolUse).toHaveLength(1);
    expect(cfg.hooks.SessionStart).toHaveLength(1);
  });

  it("uninstallServer + uninstallHooks remove the entries (re-read confirms gone)", () => {
    vscodeCopilotAdapter.installServer(ctx);
    vscodeCopilotAdapter.installHooks(ctx);

    vscodeCopilotAdapter.uninstallServer(ctx);
    const serverCfg = readJson(join(projectDir, ".vscode", "mcp.json"));
    expect(serverCfg.servers?.[CONNECTOR_ID]).toBeUndefined();

    vscodeCopilotAdapter.uninstallHooks(ctx);
    // The hooks file is connector-OWNED, so stripping our last hook DELETES the
    // whole file rather than leaving an empty { version, hooks:{} } shell.
    expect(
      existsSync(join(projectDir, ".github", "hooks", `${CONNECTOR_ID}.json`)),
    ).toBe(false);
  });

  it("install then uninstall leaves NO file at .github/hooks/<id>.json and removes the empty dir (no orphan shell)", () => {
    const hooksPath = join(projectDir, ".github", "hooks", `${CONNECTOR_ID}.json`);
    const hooksDir = join(projectDir, ".github", "hooks");

    vscodeCopilotAdapter.installHooks(ctx);
    expect(existsSync(hooksPath)).toBe(true);

    const changes = vscodeCopilotAdapter.uninstallHooks(ctx);
    // The file is gone entirely — not an empty shell…
    expect(existsSync(hooksPath)).toBe(false);
    // …and the now-empty per-connector hooks dir is removed (NO_RESIDUE).
    expect(existsSync(hooksDir)).toBe(false);
    // A remove ChangeRecord for the file was emitted.
    expect(
      changes.some((c) => c.action === "remove" && c.path === hooksPath),
    ).toBe(true);
  });

  it("uninstall PRESERVES .github/hooks when another connector's file sits beside ours", () => {
    const hooksPath = join(projectDir, ".github", "hooks", `${CONNECTOR_ID}.json`);
    const hooksDir = join(projectDir, ".github", "hooks");
    const siblingPath = join(hooksDir, "other-connector.json");

    vscodeCopilotAdapter.installHooks(ctx);
    expect(existsSync(hooksPath)).toBe(true);
    // A foreign connector's hook file lives in the shared .github/hooks tree.
    writeFileSync(siblingPath, JSON.stringify({ version: 1, hooks: {} }), "utf8");

    vscodeCopilotAdapter.uninstallHooks(ctx);
    // Our file is gone…
    expect(existsSync(hooksPath)).toBe(false);
    // …but the dir + the foreign file are left in place.
    expect(existsSync(hooksDir)).toBe(true);
    expect(existsSync(siblingPath)).toBe(true);
  });

  it("dryRun uninstall reports the would-be remove but leaves the file in place", () => {
    const hooksPath = join(projectDir, ".github", "hooks", `${CONNECTOR_ID}.json`);
    vscodeCopilotAdapter.installHooks(ctx);
    expect(existsSync(hooksPath)).toBe(true);

    const dryCtx: InstallContext = { ...ctx, dryRun: true };
    const changes = vscodeCopilotAdapter.uninstallHooks(dryCtx);
    // Reports the remove…
    expect(
      changes.some((c) => c.action === "remove" && c.path === hooksPath),
    ).toBe(true);
    // …but the filesystem is untouched.
    expect(existsSync(hooksPath)).toBe(true);
  });
});

// ── UserPromptSubmit + Stop (blockable turn-control events) ───────────────────

describe("vscode-copilot adapter — UserPromptSubmit + Stop", () => {
  it("capabilities: userPromptSubmit + stop are now true", () => {
    expect(vscodeCopilotAdapter.capabilities.userPromptSubmit).toBe(true);
    expect(vscodeCopilotAdapter.capabilities.stop).toBe(true);
  });

  it("installHooks writes UserPromptSubmit + Stop PascalCase keys", () => {
    const projectDir = freshProject("ac-vsc-events-");
    vscodeCopilotAdapter.installHooks(buildCtx(projectDir, buildEventsConnector()));
    const cfg = readJson(hooksFile(projectDir, EVENTS_CONNECTOR_ID));
    expect(cfg.version).toBe(1);
    expect(cfg.hooks.UserPromptSubmit[0].command).toContain("hook vscode-copilot UserPromptSubmit");
    expect(cfg.hooks.UserPromptSubmit[0].type).toBe("command");
    expect(cfg.hooks.Stop[0].command).toContain("hook vscode-copilot Stop");
  });

  it("parseEvent normalizes UserPromptSubmit (prompt) and Stop (stop_hook_active)", () => {
    const up = vscodeCopilotAdapter.parseEvent!("UserPromptSubmit", {
      session_id: "s1",
      cwd: "/w",
      prompt: "do the thing",
      connector: EVENTS_CONNECTOR_ID,
    }) as UserPromptSubmitEvent;
    expect(up.prompt).toBe("do the thing");

    const st = vscodeCopilotAdapter.parseEvent!("Stop", {
      session_id: "s1",
      cwd: "/w",
      stop_hook_active: true,
      connector: EVENTS_CONNECTOR_ID,
    }) as StopEvent;
    expect(st.stopHookActive).toBe(true);
  });

  it("formatReply: UserPromptSubmit + Stop deny -> TOP-LEVEL {decision:block} (not permissionDecision)", () => {
    const up = JSON.parse(
      vscodeCopilotAdapter.formatReply!("UserPromptSubmit", { decision: "deny", reason: "blocked prompt" }).stdout ?? "{}",
    );
    expect(up.decision).toBe("block");
    expect(up.reason).toBe("blocked prompt");
    expect(up.hookSpecificOutput).toBeUndefined();

    const st = JSON.parse(
      vscodeCopilotAdapter.formatReply!("Stop", { decision: "deny", reason: "keep going" }).stdout ?? "{}",
    );
    expect(st.decision).toBe("block");
    expect(st.reason).toBe("keep going");
    expect(st.hookSpecificOutput).toBeUndefined();
  });

  it("formatReply: PostToolUse deny -> TOP-LEVEL {decision:block} but PreToolUse keeps permissionDecision", () => {
    // hooks.md Output Contract: permissionDecision is read ONLY for PreToolUse
    // (pre-execution). PostToolUse "can block further processing with decision:
    // block" — the post-execution event uses the top-level shape, and emitting a
    // permissionDecision there is a silent no-op (the bug this guards against).
    const post = JSON.parse(
      vscodeCopilotAdapter.formatReply!("PostToolUse", { decision: "deny", reason: "bad output" }).stdout ?? "{}",
    );
    expect(post.decision).toBe("block");
    expect(post.reason).toBe("bad output");
    expect(post.hookSpecificOutput).toBeUndefined();

    // PreToolUse is the permission event — it MUST still use permissionDecision.
    const pre = JSON.parse(
      vscodeCopilotAdapter.formatReply!("PreToolUse", { decision: "deny", reason: "no" }).stdout ?? "{}",
    );
    expect(pre.decision).toBeUndefined();
    expect(pre.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(pre.hookSpecificOutput.permissionDecisionReason).toBe("no");
  });

  it("formatReply: UserPromptSubmit context -> hookSpecificOutput.additionalContext", () => {
    const out = JSON.parse(
      vscodeCopilotAdapter.formatReply!("UserPromptSubmit", {
        decision: "context",
        additionalContext: "extra context",
      }).stdout ?? "{}",
    );
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toBe("extra context");
  });
});

// ── extended events (E1): subagentStart/subagentStop + warn-skips ─────────────

describe("vscode-copilot — extended-event install", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-ext-events-");
    ctx = buildCtx(projectDir, buildExtConnector());
  });

  it("registers SubagentStart/SubagentStop (PascalCase); PermissionRequest + PostToolUseFailure warn-skip", () => {
    const changes = vscodeCopilotAdapter.installHooks(ctx);

    const hooksPath = join(projectDir, ".github", "hooks", `${CONNECTOR_ID}.json`);
    expect(existsSync(hooksPath)).toBe(true);
    const cfg = readJson(hooksPath);
    expect(cfg.version).toBe(1);

    expect(cfg.hooks.SubagentStart[0].command).toContain(
      "hook vscode-copilot SubagentStart",
    );
    expect(cfg.hooks.SubagentStop[0].command).toContain(
      "hook vscode-copilot SubagentStop",
    );

    for (const event of ["PermissionRequest", "PostToolUseFailure"]) {
      const warn = changes.find(
        (c) => c.action === "warn" && c.detail?.includes(event),
      );
      expect(warn).toBeTruthy();
      expect(warn!.detail).toContain("no VS Code Copilot hook equivalent");
      expect(cfg.hooks[event]).toBeUndefined();
    }
  });
});

describe("vscode-copilot — extended-event parse + replies", () => {
  const COMMON = { session_id: "sess-1", cwd: "/home/dev/acme" };

  it("SubagentStart/SubagentStop parse the Claude-compatible snake_case fields", () => {
    const start = vscodeCopilotAdapter.parseEvent!("SubagentStart", {
      ...COMMON,
      agent_id: "agent-7",
      agent_type: "code-reviewer",
    }) as SubagentStartEvent;
    expect(start.hostPlatform).toBe("vscode-copilot");
    expect(start.agentId).toBe("agent-7");
    expect(start.agentType).toBe("code-reviewer");

    const stop = vscodeCopilotAdapter.parseEvent!("SubagentStop", {
      ...COMMON,
      agent_id: "agent-7",
      agent_transcript_path: "/x/subagents/agent-7.jsonl",
      last_assistant_message: "done",
      stop_hook_active: false,
    }) as SubagentStopEvent;
    // The missing-agent_type quirk stays tolerated.
    expect(stop.agentType).toBeUndefined();
    expect(stop.agentId).toBe("agent-7");
    expect(stop.agentTranscriptPath).toBe("/x/subagents/agent-7.jsonl");
    expect(stop.lastAssistantMessage).toBe("done");
    expect(stop.stopHookActive).toBe(false);
  });

  it("PermissionRequest / PostToolUseFailure throw (no VS Code analog)", () => {
    expect(() =>
      vscodeCopilotAdapter.parseEvent!("PermissionRequest", COMMON),
    ).toThrow(/unsupported vscode-copilot hook event/);
    expect(() =>
      vscodeCopilotAdapter.parseEvent!("PostToolUseFailure", COMMON),
    ).toThrow(/unsupported vscode-copilot hook event/);
  });

  it("SubagentStop deny → TOP-LEVEL {decision:'block', reason} (Stop semantics, NOT permissionDecision)", () => {
    const reply = parseStdout(
      vscodeCopilotAdapter.formatReply!("SubagentStop", {
        decision: "deny",
        reason: "keep going",
      }),
    );
    expect(reply).toEqual({ decision: "block", reason: "keep going" });
    expect(reply.hookSpecificOutput).toBeUndefined();
  });

  it("PreToolUse deny still uses hookSpecificOutput.permissionDecision (regression guard)", () => {
    const reply = parseStdout(
      vscodeCopilotAdapter.formatReply!("PreToolUse", {
        decision: "deny",
        reason: "nope",
      }),
    );
    expect(reply.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("SubagentStart: context → additionalContext; deny degrades to context+reason; void → exit 0", () => {
    const context = parseStdout(
      vscodeCopilotAdapter.formatReply!("SubagentStart", {
        decision: "context",
        additionalContext: "subagent ctx",
      }),
    );
    expect(context.hookSpecificOutput).toEqual({
      hookEventName: "SubagentStart",
      additionalContext: "subagent ctx",
    });

    const denied = parseStdout(
      vscodeCopilotAdapter.formatReply!("SubagentStart", {
        decision: "deny",
        reason: "spawn is not blockable",
      }),
    );
    expect(denied.hookSpecificOutput.additionalContext).toBe(
      "spawn is not blockable",
    );
    expect(denied.hookSpecificOutput.permissionDecision).toBeUndefined();

    const noop = vscodeCopilotAdapter.formatReply!("SubagentStart", {});
    expect(noop).toEqual({ exitCode: 0 });
  });
});

// ── content surfaces: commands (md+fm) / skills / subagents ───────────────────

describe("vscode-copilot adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-surfaces-s2-");
    ctx = buildCtx(projectDir, buildSurfacesConnector());
  });

  it("declares support for all three content surfaces", () => {
    expect(vscodeCopilotAdapter.capabilities.supportsCommands).toBe(true);
    expect(vscodeCopilotAdapter.capabilities.supportsSkills).toBe(true);
    expect(vscodeCopilotAdapter.capabilities.supportsSubagents).toBe(true);
  });

  it("installCommands writes a md+fm prompt file at .github/prompts/<n>.prompt.md", () => {
    const changes = vscodeCopilotAdapter.installCommands!(ctx);
    expect(changes[0]?.action).toBe("create");

    const cmdPath = join(projectDir, ".github", "prompts", "deploy.prompt.md");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(cmdPath, "utf8"));
    expect(frontmatter.description).toBe("Deploy the app to an environment.");
    // VS Code prompt files express tools as an ARRAY (not CSV).
    expect(frontmatter.tools).toEqual(["Bash", "Read"]);
    expect(frontmatter.model).toBe("sonnet");
    expect(frontmatter["argument-hint"]).toBe("[environment]");
    expect(body.trim()).toBe(COMMAND.prompt);
  });

  it("installSkills writes uniform SKILL.md + resource with correct frontmatter", () => {
    vscodeCopilotAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".github", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".github", "skills", "pdf-tools", "scripts", "extract.sh");
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

  it("installSubagents writes md+fm .github/agents/<n>.agent.md (name, description, tools, model)", () => {
    const changes = vscodeCopilotAdapter.installSubagents!(ctx);
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

  it("is idempotent — second install yields skip across all surfaces", () => {
    vscodeCopilotAdapter.installCommands!(ctx);
    vscodeCopilotAdapter.installSkills!(ctx);
    vscodeCopilotAdapter.installSubagents!(ctx);
    expect(vscodeCopilotAdapter.installCommands!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(vscodeCopilotAdapter.installSkills!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(vscodeCopilotAdapter.installSubagents!(ctx).every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall removes all written files", () => {
    vscodeCopilotAdapter.installCommands!(ctx);
    vscodeCopilotAdapter.installSkills!(ctx);
    vscodeCopilotAdapter.installSubagents!(ctx);

    vscodeCopilotAdapter.uninstallCommands!(ctx);
    vscodeCopilotAdapter.uninstallSkills!(ctx);
    vscodeCopilotAdapter.uninstallSubagents!(ctx);

    expect(existsSync(join(projectDir, ".github", "prompts", "deploy.prompt.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".github", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".github", "skills", "pdf-tools"))).toBe(false);
    expect(existsSync(join(projectDir, ".github", "agents", "reviewer.agent.md"))).toBe(false);
  });

  it("honors platforms['vscode-copilot'].commands === false", () => {
    const disabled = defineConnector({
      id: SURFACES_CONNECTOR_ID,
      commands: [{ name: "deploy", prompt: "do it" }],
      platforms: { "vscode-copilot": { commands: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    expect(vscodeCopilotAdapter.installCommands!(c2)[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".github", "prompts", "deploy.prompt.md"))).toBe(false);
  });
});
