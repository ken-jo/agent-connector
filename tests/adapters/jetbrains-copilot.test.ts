/**
 * adapters/jetbrains-copilot.test.ts — the ONE per-host file for the JetBrains
 * Copilot adapter.
 *
 * jetbrains-copilot is a json-stdio host that shares the Copilot reply contract
 * and the .github content tree with vscode-copilot, but diverges on MCP
 * registration (UI-managed → installServer writes NOTHING and WARNs). Surfaces:
 *   • MCP servers → UI-managed; installServer returns a WARN ChangeRecord and
 *                   writes no file (getServerConfigPath aliases the hooks path).
 *   • Hooks       → <projectDir>/.github/hooks/<connector-id>.json, shape {
 *                   version: 1, hooks: { <PascalCaseEvent>: [ { type:"command",
 *                   command } ] } } — FLAT command objects (no { matcher, hooks:[…] }
 *                   wrapper). The top-level version:1 is REQUIRED. Supported events
 *                   map 1:1 to PascalCase keys; unsupported events warn-skip;
 *                   jetbrains-native event-name keys (e.g. ErrorOccurred) file
 *                   VERBATIM via platforms["jetbrains-copilot"].nativeHooks.
 *   • Content     → <projectDir>/.github/{prompts,skills}: commands are md+fm
 *                   .prompt.md (tools as ARRAY); skills are <name>/SKILL.md +
 *                   resources. NO subagent surface (BaseAdapter skip/warn).
 *                   ALIAS of the vscode-copilot writer — byte-identical content on
 *                   the shared .github tree.
 *   • Reply       → JSON on stdout (exit 0): PreToolUse deny/ask flow through
 *                   hookSpecificOutput.permissionDecision; the post-execution /
 *                   turn-control events (PostToolUse, UserPromptSubmit, Stop,
 *                   SubagentStop) block via the TOP-LEVEL { decision:"block", reason }
 *                   shape; modify degrades to allow (canModifyArgs:false). The four
 *                   E1 events (PermissionRequest/PostToolUseFailure/SubagentStart/
 *                   SubagentStop) have NO JetBrains analog — install warn-skips and
 *                   parseEvent throws the explicit unsupported error.
 *
 * This file consolidates what used to be split across
 * jetbrains-copilot-block-contract.test.ts (turn-control deny shape),
 * jetbrains-copilot-surfaces.test.ts (SessionEnd + nativeHooks + transports),
 * extended-events-degrade.test.ts (E1 degradation — jetbrains was its last host),
 * wave2.test.ts (render/round-trip — jetbrains was its last host), and the
 * content-surface slice (incl. the byte-identical-vs-vscode comparison) from
 * surfaces-s2.test.ts. It uses the shared harness (tests/support/env +
 * adapter-suite + fs) per tests/README.md — ONE file per host.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  HookEventName,
  PostToolUseEvent,
  PreToolUseEvent,
  ResolvedConnector,
} from "../../src/core/types.js";

import jetbrainsCopilotAdapter from "../../src/adapters/jetbrains-copilot/index.js";
import vscodeAdapter from "../../src/adapters/vscode-copilot/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson, splitFrontmatter } from "../support/fs.js";

// ── shared fixtures ──────────────────────────────────────────────────────────

// Distinct connector ids per slice (the migrated suites each used their own).
const BLOCK_CONNECTOR_ID = "acme-jb-block"; // turn-control block-contract slice
const SURFACES_CONNECTOR_ID = "acme-jb"; // SessionEnd + nativeHooks + transports slice
const RENDER_CONNECTOR_ID = "acme-db"; // E1-degrade + wave2 render/round-trip slices
const CONTENT_CONNECTOR_ID = "acme-surfaces"; // content-surface slice (vs vscode)

// The render/round-trip slice declares a stdio server with an env-ref so the
// native ${env:VAR} passthrough produces a known value.
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const SERVER_CWD = "/srv/acme";
const PRE_MATCHER = "acme_query|acme_write";

const E1_EVENTS = [
  "PermissionRequest",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
] as const;

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

/**
 * A connector with a stdio server (env-ref + cwd) + PreToolUse and SessionStart
 * hooks (render/round-trip slice). The PreToolUse + SessionStart pair lets
 * jetbrains register both supported events.
 */
function buildConnector(id = RENDER_CONNECTOR_ID): ResolvedConnector {
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

/** PreToolUse (universally wired) + ALL FOUR E1 extension events (degrade slice). */
function buildExtConnector(id = RENDER_CONNECTOR_ID): ResolvedConnector {
  return defineConnector({
    id,
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

/** Normalized SessionEnd hook + a jetbrains-native ErrorOccurred hook. */
function buildSurfacesConnector(): ResolvedConnector {
  return defineConnector({
    id: SURFACES_CONNECTOR_ID,
    displayName: "Acme JB",
    version: "1.0.0",
    hooks: { SessionEnd: { handler: () => ({ decision: "allow" }) } },
    platforms: {
      "jetbrains-copilot": { nativeHooks: { ErrorOccurred: { handler: () => ({}) } } },
    },
  });
}

/** Build a content connector declaring ONLY the surfaces given. */
function buildContentConnector(surfaces: {
  commands?: boolean;
  skills?: boolean;
  subagents?: boolean;
}): ResolvedConnector {
  return defineConnector({
    id: CONTENT_CONNECTOR_ID,
    displayName: "Acme Surfaces",
    version: "1.0.0",
    ...(surfaces.commands
      ? { commands: [{ ...COMMAND, tools: { allow: [...COMMAND.tools.allow] } }] }
      : {}),
    ...(surfaces.skills
      ? {
          skills: [
            {
              ...SKILL,
              tools: { allow: [...SKILL.tools.allow] },
              resources: { ...SKILL.resources },
            },
          ],
        }
      : {}),
    ...(surfaces.subagents
      ? { subagents: [{ ...SUBAGENT, tools: { allow: [...SUBAGENT.tools.allow] } }] }
      : {}),
  });
}

// ── local helpers ────────────────────────────────────────────────────────────

function readHooks(ctx: InstallContext): Record<string, any[]> {
  const file = readJson(jetbrainsCopilotAdapter.getHookConfigPath!(ctx));
  return (file.hooks ?? {}) as Record<string, any[]>;
}

/** A representative native PreToolUse hook stdin payload (Claude-style fields). */
function preToolUsePayload(): Record<string, unknown> {
  return {
    session_id: "sess-123",
    cwd: "/work/proj",
    hook_event_name: "PreToolUse",
    tool_name: "acme_query",
    tool_input: { sql: "SELECT 1" },
    connector: RENDER_CONNECTOR_ID,
  };
}

/** Common assertions for a normalized PreToolUse event. */
function assertPreToolUse(ev: PreToolUseEvent, hostPlatform: string): void {
  expect(ev.hostPlatform).toBe(hostPlatform);
  expect(ev.connectorId).toBe(RENDER_CONNECTOR_ID);
  expect(ev.toolName).toBe("acme_query");
  expect(ev.toolInput).toEqual({ sql: "SELECT 1" });
}

/** The warn records for exactly the four E1 events, with the standard detail. */
function expectE1WarnSkips(
  changes: { action: string; platform: string; detail?: string }[],
  platformId: string,
  hostLabel: string,
): void {
  const warns = changes.filter((c) => c.action === "warn");
  for (const event of E1_EVENTS) {
    const warn = warns.find((c) => c.detail?.startsWith(`${event} `));
    expect(warn, `expected a warn-skip record for ${event}`).toBeTruthy();
    expect(warn!.platform).toBe(platformId);
    expect(warn!.detail).toBe(`${event} has no ${hostLabel} hook equivalent — skipped`);
  }
  expect(warns).toHaveLength(E1_EVENTS.length);
}

// Shared env isolation + the same-rules-for-every-host baseline contract.
// extraKeys: the render/round-trip slice mutates ACME_DB_DSN (the ${env:VAR}
// passthrough ref). HOME/USERPROFILE/AGENT_CONNECTOR_DATA_DIR are covered by
// isolateEnv's defaults.
isolateEnv([ENV_VAR]);
createAdapterSuite({ adapter: jetbrainsCopilotAdapter, paradigm: "json-stdio" });

// ── render + round-trip (installServer WARN + .github/hooks PascalCase) ────────

describe("jetbrains-copilot adapter render + round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave2-jetbrains-");
    // Set the env-ref var so the native ${env:VAR} passthrough has a known value.
    process.env[ENV_VAR] = ENV_LITERAL;
    ctx = buildCtx(projectDir, buildConnector());
  });

  it("installServer returns a WARN ChangeRecord and writes NO MCP file (UI-managed)", () => {
    const changes = jetbrainsCopilotAdapter.installServer(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("Settings");

    // No bogus MCP file is created anywhere under the project tree.
    expect(existsSync(join(projectDir, ".vscode", "mcp.json"))).toBe(false);
    expect(existsSync(join(projectDir, "mcp.json"))).toBe(false);
    // getServerConfigPath aliases the hooks path; installServer never wrote there.
    expect(existsSync(jetbrainsCopilotAdapter.getServerConfigPath(ctx))).toBe(false);
  });

  it("installHooks writes .github/hooks/<id>.json with version:1 + FLAT { type, command }", () => {
    const changes = jetbrainsCopilotAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const hooksPath = join(projectDir, ".github", "hooks", `${RENDER_CONNECTOR_ID}.json`);
    expect(hooksPath).toBe(jetbrainsCopilotAdapter.getHookConfigPath(ctx));
    expect(existsSync(hooksPath)).toBe(true);

    const cfg = readJson(hooksPath);
    // The required top-level version — a version-less file is rejected by Copilot.
    expect(cfg.version).toBe(1);

    // FLAT { type, command } entries (no Claude-style { matcher, hooks:[...] }).
    const pre = cfg.hooks.PreToolUse;
    expect(Array.isArray(pre)).toBe(true);
    expect(pre[0].type).toBe("command");
    expect(pre[0]).not.toHaveProperty("matcher");
    expect(pre[0].command).toContain(HOME_BIN);
    expect(pre[0].command).toContain("hook jetbrains-copilot PreToolUse");
    expect(pre[0].command).toContain(`--connector ${RENDER_CONNECTOR_ID}`);

    // SessionStart is in JetBrains' supported event set and is registered too.
    expect(cfg.hooks.SessionStart[0].command).toContain(
      "hook jetbrains-copilot SessionStart",
    );
  });

  it("installHooks is idempotent; uninstallHooks removes our entries (re-read confirms gone)", () => {
    jetbrainsCopilotAdapter.installHooks(ctx);
    const second = jetbrainsCopilotAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    const hooksPath = join(projectDir, ".github", "hooks", `${RENDER_CONNECTOR_ID}.json`);
    const cfg = readJson(hooksPath);
    expect(cfg.hooks.PreToolUse).toHaveLength(1);

    jetbrainsCopilotAdapter.uninstallHooks(ctx);
    // The connector-owned file is DELETED (not left as an empty shell), so it
    // no longer exists to re-read.
    expect(existsSync(hooksPath)).toBe(false);
  });

  // CLEAN-UNINSTALL (D2): the hook file is connector-OWNED
  // (<connector-id>.json). When uninstall empties it, the whole file must be
  // DELETED — NOT rewritten as a `{ "hooks": {}, "version": 1 }` orphan shell.
  it("install then uninstall leaves NO file at .github/hooks/<id>.json (no empty shell)", () => {
    const hooksPath = join(projectDir, ".github", "hooks", `${RENDER_CONNECTOR_ID}.json`);

    jetbrainsCopilotAdapter.installHooks(ctx);
    expect(existsSync(hooksPath)).toBe(true);

    const changes = jetbrainsCopilotAdapter.uninstallHooks(ctx);
    // The file is gone entirely — not an empty shell.
    expect(existsSync(hooksPath)).toBe(false);
    // A remove ChangeRecord for the file was emitted.
    expect(
      changes.some((c) => c.action === "remove" && c.path === hooksPath),
    ).toBe(true);
  });

  it("dryRun uninstall reports the would-be remove but leaves the file in place", () => {
    const hooksPath = join(projectDir, ".github", "hooks", `${RENDER_CONNECTOR_ID}.json`);
    jetbrainsCopilotAdapter.installHooks(ctx);
    expect(existsSync(hooksPath)).toBe(true);

    const dryCtx: InstallContext = { ...ctx, dryRun: true };
    const changes = jetbrainsCopilotAdapter.uninstallHooks(dryCtx);
    // Reports the remove…
    expect(
      changes.some((c) => c.action === "remove" && c.path === hooksPath),
    ).toBe(true);
    // …but the filesystem is untouched.
    expect(existsSync(hooksPath)).toBe(true);
  });

  it("parseEvent(PostToolUse) reads tool_response → toolOutput (no isError)", () => {
    // VS Code `.github/hooks` dialect (this host ALIASES vscode-copilot): the
    // success-only PostToolUse result rides under tool_response — NOT
    // copilot-cli's tool_result.text_result_for_llm. isError is never inferred.
    const ev = jetbrainsCopilotAdapter.parseEvent!("PostToolUse", {
      session_id: "sess-123",
      cwd: "/work/proj",
      hook_event_name: "PostToolUse",
      tool_name: "acme_query",
      tool_input: { sql: "SELECT 1" },
      tool_response: "out",
      connector: RENDER_CONNECTOR_ID,
    }) as PostToolUseEvent;
    expect(ev.toolName).toBe("acme_query");
    expect(ev.toolInput).toEqual({ sql: "SELECT 1" });
    expect(ev.toolOutput).toBe("out");
    expect(ev.isError).toBeUndefined();
  });

  it("parseEvent(PostToolUse) ignores the dead tool_output/error_message/tool_result fields", () => {
    // Only tool_response is read on this surface. A payload carrying the
    // host-nonexistent tool_output / error_message (copilot-cli's tool_result
    // too) surfaces neither toolOutput nor isError.
    const ev = jetbrainsCopilotAdapter.parseEvent!("PostToolUse", {
      session_id: "sess-123",
      cwd: "/work/proj",
      hook_event_name: "PostToolUse",
      tool_name: "acme_query",
      tool_input: { sql: "SELECT 1" },
      tool_output: "legacy ignored",
      error_message: "legacy ignored",
      tool_result: { result_type: "success", text_result_for_llm: "legacy ignored" },
      connector: RENDER_CONNECTOR_ID,
    }) as PostToolUseEvent;
    expect(ev.toolOutput).toBeUndefined();
    expect(ev.isError).toBeUndefined();
  });

  it("parseEvent yields a normalized PreToolUse; formatReply(deny) → stdout hookSpecificOutput deny, exit 0", () => {
    const ev = jetbrainsCopilotAdapter.parseEvent!(
      "PreToolUse",
      preToolUsePayload(),
    ) as PreToolUseEvent;
    assertPreToolUse(ev, "jetbrains-copilot");

    const reply = jetbrainsCopilotAdapter.formatReply!("PreToolUse", {
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

// ── turn-control block contract (PostToolUse / UserPromptSubmit deny shape) ────

describe("jetbrains-copilot adapter — turn-control block contract", () => {
  it("capabilities: userPromptSubmit now true", () => {
    expect(jetbrainsCopilotAdapter.capabilities.userPromptSubmit).toBe(true);
  });

  it("installHooks wires UserPromptSubmit (PascalCase)", () => {
    const projectDir = freshProject("ac-jb-block-");
    const ctx = buildCtx(
      projectDir,
      defineConnector({
        id: BLOCK_CONNECTOR_ID,
        hooks: { UserPromptSubmit: { handler: () => ({ decision: "allow" }) } },
      }),
    );
    jetbrainsCopilotAdapter.installHooks(ctx);
    const file = readJson(jetbrainsCopilotAdapter.getHookConfigPath!(ctx));
    expect(file.hooks.UserPromptSubmit[0].command).toContain("hook jetbrains-copilot UserPromptSubmit");
  });

  it("formatReply: PostToolUse + UserPromptSubmit deny → TOP-LEVEL {decision:block} (not permissionDecision)", () => {
    for (const event of ["PostToolUse", "UserPromptSubmit"] as const) {
      const out = JSON.parse(
        jetbrainsCopilotAdapter.formatReply!(event, { decision: "deny", reason: "blocked" }).stdout ?? "{}",
      );
      expect(out.decision).toBe("block");
      expect(out.reason).toBe("blocked");
      expect(out.hookSpecificOutput).toBeUndefined();
    }
  });

  it("formatReply: PreToolUse deny still uses permissionDecision (no regression)", () => {
    const out = JSON.parse(
      jetbrainsCopilotAdapter.formatReply!("PreToolUse", { decision: "deny", reason: "no" }).stdout ?? "{}",
    );
    expect(out.decision).toBeUndefined();
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("no");
  });
});

// ── SessionEnd + nativeHooks (ErrorOccurred) + remote MCP transports ──────────

describe("jetbrains-copilot adapter — SessionEnd + nativeHooks + transports", () => {
  it("capabilities: sessionEnd + supportsNativeHooks true; transports advertise remote http/sse", () => {
    expect(jetbrainsCopilotAdapter.capabilities.sessionEnd).toBe(true);
    expect(jetbrainsCopilotAdapter.capabilities.supportsNativeHooks).toBe(true);
    expect(jetbrainsCopilotAdapter.capabilities.transports).toEqual(["stdio", "http", "sse"]);
  });

  it("installHooks wires SessionEnd (PascalCase) and files ErrorOccurred VERBATIM as native", () => {
    const projectDir = freshProject("ac-jb-");
    const ctx = buildCtx(projectDir, buildSurfacesConnector());
    jetbrainsCopilotAdapter.installHooks(ctx);
    const hooks = readHooks(ctx);
    expect(hooks.SessionEnd[0].command).toContain("hook jetbrains-copilot SessionEnd");
    expect(hooks.ErrorOccurred[0].command).toContain("hook jetbrains-copilot ErrorOccurred");
    expect(hooks.ErrorOccurred[0].command).toContain(`--connector ${SURFACES_CONNECTOR_ID}`);
    expect(hooks.ErrorOccurred[0].type).toBe("command");
  });

  it("nativeHooks install even when normalized hooks are disabled (hooks:false sibling)", () => {
    const projectDir = freshProject("ac-jb-");
    const c = defineConnector({
      id: SURFACES_CONNECTOR_ID,
      hooks: { SessionEnd: { handler: () => ({ decision: "allow" }) } },
      platforms: { "jetbrains-copilot": { hooks: false, nativeHooks: { ErrorOccurred: { handler: () => ({}) } } } },
    });
    const ctx = buildCtx(projectDir, c);
    jetbrainsCopilotAdapter.installHooks(ctx);
    const hooks = readHooks(ctx);
    expect(hooks.ErrorOccurred[0].command).toContain("hook jetbrains-copilot ErrorOccurred");
    expect(hooks.SessionEnd).toBeUndefined();
  });

  it("idempotent + uninstall strips our native entry, leaving a foreign hook intact", () => {
    const projectDir = freshProject("ac-jb-");
    const ctx = buildCtx(projectDir, buildSurfacesConnector());
    jetbrainsCopilotAdapter.installHooks(ctx);
    expect(jetbrainsCopilotAdapter.installHooks(ctx).every((c) => c.action === "skip")).toBe(true);

    const path = jetbrainsCopilotAdapter.getHookConfigPath!(ctx);
    const file = readJson(path);
    file.hooks.ErrorOccurred.push({ type: "command", command: "/usr/bin/other run" });
    writeFileSync(path, JSON.stringify(file));

    jetbrainsCopilotAdapter.uninstallHooks(ctx);
    const flat = JSON.stringify(readHooks(ctx));
    expect(flat).toContain("other run");
    expect(flat).not.toContain(HOME_BIN);
  });
});

// ── E1 extension-event degradation (no native analog) ─────────────────────────

// NOTE: the generic "E1 capability flags stay unset on hosts without a native
// analog" invariant was absorbed here as a jetbrains-specific assertion when
// jetbrains-copilot became the last host of extended-events-degrade.test.ts. The
// fleet-wide registry-driven contract for this invariant is US-026's job.
describe("jetbrains-copilot E1 degradation", () => {
  it("leaves permissionRequest/postToolUseFailure/subagentStart/subagentStop falsy", () => {
    const adapter = jetbrainsCopilotAdapter;
    expect(adapter.capabilities.permissionRequest ?? false).toBe(false);
    expect(adapter.capabilities.postToolUseFailure ?? false).toBe(false);
    expect(adapter.capabilities.subagentStart ?? false).toBe(false);
    expect(adapter.capabilities.subagentStop ?? false).toBe(false);
  });

  it("installHooks warn-skips all four; hooks file wires PreToolUse only", () => {
    const projectDir = freshProject("ac-e1-jetbrains-");
    const ctx = buildCtx(projectDir, buildExtConnector());

    const changes = jetbrainsCopilotAdapter.installHooks!(ctx);
    expectE1WarnSkips(changes, "jetbrains-copilot", "JetBrains Copilot");

    const hooksPath = join(projectDir, ".github", "hooks", `${RENDER_CONNECTOR_ID}.json`);
    const file = readJson(hooksPath);
    expect(Object.keys(file.hooks)).toEqual(["PreToolUse"]);
  });

  it("parseEvent throws the explicit unsupported error for each E1 event (degrade case)", () => {
    for (const event of E1_EVENTS) {
      expect(() =>
        jetbrainsCopilotAdapter.parseEvent!(event as HookEventName, {
          session_id: "s1",
          cwd: "/work",
          connector: RENDER_CONNECTOR_ID,
        }),
      ).toThrow(`unsupported jetbrains-copilot hook event: ${event}`);
    }
  });
});

// ── content surfaces: commands (md+fm) / skills / NO subagents ────────────────

describe("jetbrains-copilot adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-surfaces-s2-");
    // Declare ONLY the supported surfaces (commands + skills). Subagents are
    // unsupported here; with none declared they resolve to a skip.
    ctx = buildCtx(projectDir, buildContentConnector({ commands: true, skills: true }));
  });

  it("declares commands + skills but NOT subagents", () => {
    expect(jetbrainsCopilotAdapter.capabilities.supportsCommands).toBe(true);
    expect(jetbrainsCopilotAdapter.capabilities.supportsSkills).toBe(true);
    expect(jetbrainsCopilotAdapter.capabilities.supportsSubagents).toBe(false);
  });

  it("installCommands writes a md+fm prompt file at .github/prompts/<n>.prompt.md", () => {
    const changes = jetbrainsCopilotAdapter.installCommands!(ctx);
    expect(changes[0]?.action).toBe("create");
    const cmdPath = join(projectDir, ".github", "prompts", "deploy.prompt.md");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(cmdPath, "utf8"));
    expect(frontmatter.description).toBe("Deploy the app to an environment.");
    expect(frontmatter.tools).toEqual(["Bash", "Read"]);
    expect(frontmatter.model).toBe("sonnet");
    expect(frontmatter["argument-hint"]).toBe("[environment]");
    expect(body.trim()).toBe(COMMAND.prompt);
  });

  it("installSkills writes uniform SKILL.md + resource under the shared .github tree", () => {
    jetbrainsCopilotAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".github", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".github", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    const { frontmatter } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
    expect(frontmatter.description).toBe(SKILL.description);
  });

  it("installSubagents routes through BaseAdapter (unsupported) and writes nothing", () => {
    // Declare a subagent so the BaseAdapter default takes the "warn" branch
    // (declared but unsupported); no agent file is created.
    const withAgent = buildCtx(
      projectDir,
      buildContentConnector({ commands: true, skills: true, subagents: true }),
    );
    const changes = jetbrainsCopilotAdapter.installSubagents!(withAgent);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
    expect(existsSync(join(projectDir, ".github", "agents", "reviewer.agent.md"))).toBe(false);
  });

  it("renders byte-identical command + skill to the vscode-copilot writer (shared .github)", () => {
    // The .github tree is shared; both writers must produce identical bytes so a
    // shared folder never thrashes. Render both into separate temp trees and
    // compare the on-disk content.
    const vsDir = freshProject("ac-surfaces-s2-");
    const vsCtx = buildCtx(vsDir, buildContentConnector({ commands: true, skills: true }));
    jetbrainsCopilotAdapter.installCommands!(ctx);
    jetbrainsCopilotAdapter.installSkills!(ctx);
    vscodeAdapter.installCommands!(vsCtx);
    vscodeAdapter.installSkills!(vsCtx);

    const jbCmd = readFileSync(join(projectDir, ".github", "prompts", "deploy.prompt.md"), "utf8");
    const vsCmd = readFileSync(join(vsDir, ".github", "prompts", "deploy.prompt.md"), "utf8");
    expect(jbCmd).toBe(vsCmd);

    const jbSkill = readFileSync(join(projectDir, ".github", "skills", "pdf-tools", "SKILL.md"), "utf8");
    const vsSkill = readFileSync(join(vsDir, ".github", "skills", "pdf-tools", "SKILL.md"), "utf8");
    expect(jbSkill).toBe(vsSkill);
  });

  it("is idempotent — second install yields skip (commands + skills)", () => {
    jetbrainsCopilotAdapter.installCommands!(ctx);
    jetbrainsCopilotAdapter.installSkills!(ctx);
    expect(jetbrainsCopilotAdapter.installCommands!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(jetbrainsCopilotAdapter.installSkills!(ctx).every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall removes command + skill files", () => {
    jetbrainsCopilotAdapter.installCommands!(ctx);
    jetbrainsCopilotAdapter.installSkills!(ctx);
    jetbrainsCopilotAdapter.uninstallCommands!(ctx);
    jetbrainsCopilotAdapter.uninstallSkills!(ctx);
    expect(existsSync(join(projectDir, ".github", "prompts", "deploy.prompt.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".github", "skills", "pdf-tools"))).toBe(false);
  });
});
