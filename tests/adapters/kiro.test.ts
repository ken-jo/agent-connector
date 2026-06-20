/**
 * adapters/kiro.test.ts — the ONE per-host file for the Kiro (AWS) adapter.
 *
 * Kiro is a json-stdio host with TWO native config surfaces in DIFFERENT files
 * (so getServerConfigPath ≠ getHookConfigPath):
 *   • MCP servers → mcp.json under .kiro/settings/ (project) or
 *                   ~/.kiro/settings/ (user); root key "mcpServers"; a stdio
 *                   entry is { command, args, env, cwd } (NO `type` field). Kiro
 *                   documents no ${env:VAR} token → env-refs resolve to LITERALS
 *                   at install time.
 *   • Hooks       → an AGENT file, NOT a settings file: ~/.kiro/agents/
 *                   kiro_default.json (the built-in agent Kiro auto-loads). We
 *                   merge a "hooks" key in. Native event names are mapped from the
 *                   canonical ones (SessionStart → agentSpawn, PreToolUse →
 *                   preToolUse, …). Kiro fires preToolUse / postToolUse /
 *                   agentSpawn / userPromptSubmit / stop only; the four newer E1
 *                   events (PermissionRequest / PostToolUseFailure / SubagentStart
 *                   / SubagentStop) warn-skip per the registry-wide convention.
 *   • Content     → skills only: .kiro/skills/<name>/SKILL.md (project) /
 *                   ~/.kiro/skills/<name>/SKILL.md (user). Paths are hard-coded —
 *                   no mcp.json/agent entry is written.
 *   • Reply       → Kiro is exit-code based: deny → exit 2 + reason on stderr;
 *                   context → exit 0 + the guidance as PLAIN STDOUT, but ONLY on
 *                   the agentSpawn / userPromptSubmit events (the two that add a
 *                   hook's STDOUT to the agent's context per kiro.dev/docs/cli/
 *                   hooks); a context decision on preToolUse / postToolUse / stop
 *                   degrades to a plain exit-0 pass-through (no context channel);
 *                   allow/modify → exit 0 (Kiro cannot rewrite args/output).
 *
 * This file consolidates what used to be split across kiro-skills.test.ts (the
 * skills surface), the kiro slice of wave2.test.ts (render/round-trip), and the
 * kiro slice of extended-events-degrade.test.ts (E1 degradation). It uses the
 * shared harness (tests/support/env + adapter-suite + fs) per tests/README.md —
 * ONE file per host.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { Adapter, InstallContext } from "../../src/adapters/spi.js";
import type {
  ConnectorConfig,
  PreToolUseEvent,
  ResolvedConnector,
  StopEvent,
} from "../../src/core/types.js";

import kiroAdapter from "../../src/adapters/kiro/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson, splitFrontmatter } from "../support/fs.js";

// ── shared fixtures ──────────────────────────────────────────────────────────

// The skills slice uses its own connector id + fixture.
const SKILLS_CONNECTOR_ID = "acme-kiro-skills";

// render/round-trip + E1 slices share the canonical "acme-db" id.
const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const SERVER_CWD = "/srv/acme";
const PRE_MATCHER = "acme_query|acme_write";

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
    displayName: "Acme Kiro Skills",
    version: "1.0.0",
    skills: [skill()],
    ...cfg,
  });
}

const E1_EVENTS = [
  "PermissionRequest",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
] as const;

/** Substrings that must never leak into a native hook file / generated bridge. */
const FORBIDDEN_NATIVE_TOKENS = [
  ...E1_EVENTS,
  // host-native analog spellings (camelCase / snake_case families)
  "permissionRequest",
  "postToolUseFailure",
  "subagentStart",
  "subagentStop",
  "permission.ask",
  "subagent_spawned",
  "subagent_ended",
  "subagent_stop",
];

// The serve-wrapper args also bake the install TARGET platform as `--host <id>`
// (before `--`) so the proxy stamps hostPlatform under a headless spawn. Kiro is
// installed at user scope, so the wrapper stamps `--scope user`.
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

/**
 * render: a connector with a stdio server (env-ref + cwd) + PreToolUse and
 * SessionStart hooks. Kiro supports SessionStart (→ native agentSpawn), so both
 * register.
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

/** E1: PreToolUse (universally wired) + ALL FOUR E1 extension events. */
function buildE1Connector(id = CONNECTOR_ID): ResolvedConnector {
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

// ── local helpers ────────────────────────────────────────────────────────────

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

/** Common assertions for a normalized PreToolUse event from kiro. */
function assertPreToolUse(ev: PreToolUseEvent, hostPlatform: string): void {
  expect(ev.hostPlatform).toBe(hostPlatform);
  expect(ev.connectorId).toBe(CONNECTOR_ID);
  expect(ev.toolName).toBe("acme_query");
  expect(ev.toolInput).toEqual({ sql: "SELECT 1" });
}

/** The warn records for exactly the four E1 events, with the standard detail. */
function expectE1WarnSkips(
  changes: ReturnType<NonNullable<Adapter["installHooks"]>>,
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
// extraKeys: the render/round-trip slice mutates ACME_DB_DSN (the env-ref →
// literal value). HOME/USERPROFILE/AGENT_CONNECTOR_DATA_DIR are covered by
// isolateEnv's defaults (kiro user-scope paths resolve under the HOME sandbox).
isolateEnv([ENV_VAR]);
createAdapterSuite({ adapter: kiroAdapter, paradigm: "json-stdio" });

// ── skills surface ───────────────────────────────────────────────────────────
// Kiro reads SKILL.md from .kiro/skills/<name>/SKILL.md (project) and
// ~/.kiro/skills/<name>/SKILL.md (user). In this fixture HOME === projectDir, so
// the user/project paths coincide.

describe("kiro adapter — skills surface", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-kiro-skills-");
    ctx = buildCtx(projectDir, buildSkillsConnector());
  });

  it("declares supportsSkills true", () => {
    expect(kiroAdapter.capabilities.supportsSkills).toBe(true);
  });

  it("installSkills (project scope) writes .kiro/skills/<n>/SKILL.md with correct frontmatter", () => {
    const changes = kiroAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");

    const skillMd = join(projectDir, ".kiro", "skills", "pdf-tools", "SKILL.md");
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

  it("installSkills (project scope) writes resource files beside SKILL.md", () => {
    kiroAdapter.installSkills!(ctx);
    const resource = join(projectDir, ".kiro", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills (user scope) writes ~/.kiro/skills/<n>/SKILL.md", () => {
    const userCtx = buildCtx(projectDir, buildSkillsConnector(), "user");
    const changes = kiroAdapter.installSkills!(userCtx);
    expect(changes[0]?.action).toBe("create");

    // HOME redirected to projectDir → ~/.kiro === projectDir/.kiro
    const skillMd = join(projectDir, ".kiro", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);

    // HOME === projectDir in this fixture, so the user/project paths coincide;
    // just verify the written content.
    const { frontmatter } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
  });

  it("installSkills is idempotent — second call yields skip", () => {
    kiroAdapter.installSkills!(ctx);
    const second = kiroAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource, and the empty skill dir", () => {
    kiroAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".kiro", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".kiro", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    kiroAdapter.uninstallSkills!(ctx);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(resource)).toBe(false);
    expect(existsSync(join(projectDir, ".kiro", "skills", "pdf-tools"))).toBe(false);
  });

  it("honors platforms['kiro'].skills === false", () => {
    const disabled = defineConnector({
      id: SKILLS_CONNECTOR_ID,
      skills: [skill()],
      platforms: { kiro: { skills: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    const changes = kiroAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".kiro", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("installSkills with no skills declared returns skip", () => {
    const noSkills = defineConnector({ id: SKILLS_CONNECTOR_ID, memory: [{ content: "placeholder" }] });
    const c2 = buildCtx(projectDir, noSkills);
    const changes = kiroAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
  });
});

// ── render + round-trip (mcpServers in .kiro/settings/mcp.json; hooks in agent) ─

describe("kiro adapter render + round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave2-kiro-");
    // Set the env-ref var so literal-resolution produces a known value.
    process.env[ENV_VAR] = ENV_LITERAL;
    ctx = buildCtx(projectDir, buildConnector(), "user");
  });

  it("installServer writes mcpServers.<id> into ~/.kiro/settings/mcp.json, wrapped, env LITERAL", () => {
    const changes = kiroAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".kiro", "settings", "mcp.json");
    expect(serverPath).toBe(kiroAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    // Kiro stdio entry is { command, args, env, cwd } — no `type` discriminator.
    expect(entry).not.toHaveProperty("type");
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedArgsUser("kiro"));
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.cwd).toBe(SERVER_CWD);
  });

  it("installHooks writes hooks into the agent file kiro_default.json; SessionStart → native 'agentSpawn'", () => {
    const changes = kiroAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const agentPath = join(projectDir, ".kiro", "agents", "kiro_default.json");
    expect(agentPath).toBe(kiroAdapter.getHookConfigPath(ctx));
    expect(existsSync(agentPath)).toBe(true);

    const agent = readJson(agentPath);
    // PreToolUse → native "preToolUse".
    const pre = agent.hooks.preToolUse;
    expect(Array.isArray(pre)).toBe(true);
    expect(pre[0].matcher).toBe(PRE_MATCHER);
    expect(pre[0].hooks[0].command).toContain("hook kiro PreToolUse");
    expect(pre[0].hooks[0].command).toContain(`--connector ${CONNECTOR_ID}`);

    // SessionStart maps to Kiro's native session-start event "agentSpawn".
    expect(agent.hooks.agentSpawn[0].hooks[0].command).toContain(
      "hook kiro SessionStart",
    );
    // The canonical name must NOT leak through as a Kiro hook key.
    expect(agent.hooks.SessionStart).toBeUndefined();
  });

  it("installServer + installHooks idempotent (skip on a second run); uninstall removes both", () => {
    kiroAdapter.installServer(ctx);
    kiroAdapter.installHooks(ctx);

    expect(kiroAdapter.installServer(ctx)[0]?.action).toBe("skip");
    expect(
      kiroAdapter.installHooks(ctx).every((c) => c.action === "skip"),
    ).toBe(true);

    kiroAdapter.uninstallServer(ctx);
    const mcp = readJson(join(projectDir, ".kiro", "settings", "mcp.json"));
    expect(mcp.mcpServers?.[CONNECTOR_ID]).toBeUndefined();

    kiroAdapter.uninstallHooks(ctx);
    const agent = readJson(join(projectDir, ".kiro", "agents", "kiro_default.json"));
    expect(JSON.stringify(agent.hooks ?? {})).not.toContain(HOME_BIN);
  });

  it("parseEvent yields a normalized PreToolUse; formatReply(deny) → exit 2 + reason on stderr", () => {
    const ev = kiroAdapter.parseEvent!("PreToolUse", preToolUsePayload()) as PreToolUseEvent;
    assertPreToolUse(ev, "kiro");
    expect(ev.sessionId).toBe("sess-123");

    // Kiro is exit-code based: deny → exit 2 with the reason on stderr.
    const reply = kiroAdapter.formatReply!("PreToolUse", {
      decision: "deny",
      reason: "blocked by policy",
    });
    expect(reply.exitCode).toBe(2);
    expect(reply.stderr).toBe("blocked by policy");
  });
});

// ── formatReply context channel (plain STDOUT, gated to context-supporting events) ─
// Kiro adds a hook's STDOUT to the agent's context ONLY for agentSpawn
// (≈ SessionStart) and userPromptSubmit; preToolUse / postToolUse / stop have no
// context channel (STDOUT is "captured but not shown"). So a context decision
// emits the raw guidance as plain stdout on the two context events and degrades
// to a bare exit-0 pass-through everywhere else — never a mislabeled payload.
// Ref: https://kiro.dev/docs/cli/hooks
describe("kiro formatReply — context decision", () => {
  const CTX = "remember: run the migration first";

  it("SessionStart context → exit 0 + the guidance as PLAIN STDOUT (no JSON envelope)", () => {
    const reply = kiroAdapter.formatReply!("SessionStart", {
      decision: "context",
      additionalContext: CTX,
    });
    expect(reply.exitCode).toBe(0);
    expect(reply.stdout).toBe(CTX);
    // The fabricated Claude-shaped envelope must NOT be emitted.
    expect(reply.stdout).not.toContain("hookSpecificOutput");
    expect(reply.stdout).not.toContain("hookEventName");
    expect(reply.stdout).not.toContain("agentSpawn");
  });

  it("UserPromptSubmit context → exit 0 + the guidance as PLAIN STDOUT", () => {
    const reply = kiroAdapter.formatReply!("UserPromptSubmit", {
      decision: "context",
      additionalContext: CTX,
    });
    expect(reply.exitCode).toBe(0);
    expect(reply.stdout).toBe(CTX);
    expect(reply.stdout).not.toContain("hookSpecificOutput");
  });

  it("PreToolUse context → exit 0 pass-through (Kiro has no context channel there)", () => {
    const reply = kiroAdapter.formatReply!("PreToolUse", {
      decision: "context",
      additionalContext: CTX,
    });
    expect(reply.exitCode).toBe(0);
    // No mislabeled agentSpawn payload, and the guidance is not (silently) emitted
    // where Kiro would never surface it.
    expect(reply.stdout).toBeUndefined();
  });

  it("PostToolUse context → exit 0 pass-through (STDOUT captured but not shown)", () => {
    const reply = kiroAdapter.formatReply!("PostToolUse", {
      decision: "context",
      additionalContext: CTX,
    });
    expect(reply.exitCode).toBe(0);
    expect(reply.stdout).toBeUndefined();
  });

  it("Stop context → exit 0 pass-through (Stop branch precedes context; no context channel)", () => {
    const reply = kiroAdapter.formatReply!("Stop", {
      decision: "context",
      additionalContext: CTX,
    });
    expect(reply.exitCode).toBe(0);
    expect(reply.stdout).toBeUndefined();
  });
});

// ── Stop hook stdin wire contract (false-friend field fixes) ─────────────────
// Kiro's stop hook stdin is EXACTLY { hook_event_name, cwd, session_id,
// assistant_response } — verified against the primary source
// (kiro.dev/docs/cli/hooks → "Stop Hook" → Hook Event). There is NO
// `stop_hook_active` flag, so the old `stopHookActive` read was a dead read
// (always undefined) and the real `assistant_response` was never surfaced. These
// regressions pin the remapped field and assert the removed read can't resurface.
describe("kiro Stop hook — real stdin fields (assistant_response, no stop_hook_active)", () => {
  /** The exact Kiro stop stdin per kiro.dev/docs/cli/hooks. */
  function stopPayload(): Record<string, unknown> {
    return {
      hook_event_name: "stop",
      cwd: "/work/proj",
      session_id: "sess-stop-1",
      assistant_response: "All tests pass; nothing left to do.",
      connector: CONNECTOR_ID,
    };
  }

  it("reads assistant_response into lastAssistantMessage", () => {
    const ev = kiroAdapter.parseEvent!("Stop", stopPayload()) as StopEvent & {
      lastAssistantMessage?: string;
    };
    expect(ev.hostPlatform).toBe("kiro");
    expect(ev.sessionId).toBe("sess-stop-1");
    expect(ev.lastAssistantMessage).toBe("All tests pass; nothing left to do.");
    // The never-emitted re-entrancy flag must NOT appear on the normalized event.
    expect(ev.stopHookActive).toBeUndefined();
  });

  it("omits lastAssistantMessage when assistant_response is absent (no fabricated empty string)", () => {
    const ev = kiroAdapter.parseEvent!("Stop", {
      hook_event_name: "stop",
      cwd: "/work/proj",
      session_id: "sess-stop-2",
    }) as StopEvent & { lastAssistantMessage?: string };
    expect("lastAssistantMessage" in ev).toBe(false);
    expect(ev.stopHookActive).toBeUndefined();
  });

  it("does NOT resurface stop_hook_active even if a stray flag is present on stdin", () => {
    // Defensive: Kiro never sends stop_hook_active, but if a future/stray payload
    // carried one, the dead read must stay removed — we never read it back.
    const ev = kiroAdapter.parseEvent!("Stop", {
      hook_event_name: "stop",
      session_id: "sess-stop-3",
      stop_hook_active: true,
      assistant_response: "done",
    } as Record<string, unknown>) as StopEvent & { lastAssistantMessage?: string };
    expect(ev.stopHookActive).toBeUndefined();
    expect(ev.lastAssistantMessage).toBe("done");
  });
});

// ── E1 extension-event degradation (no Kiro analog → warn-skip) ───────────────

describe("kiro E1 capability flags stay unset (no native analog)", () => {
  it("leaves permissionRequest/postToolUseFailure/subagentStart/subagentStop falsy", () => {
    expect(kiroAdapter.capabilities.permissionRequest ?? false).toBe(false);
    expect(kiroAdapter.capabilities.postToolUseFailure ?? false).toBe(false);
    expect(kiroAdapter.capabilities.subagentStart ?? false).toBe(false);
    expect(kiroAdapter.capabilities.subagentStop ?? false).toBe(false);
  });
});

describe("kiro E1 degradation", () => {
  it("installHooks warn-skips all four; agent file gains no E1 keys", () => {
    const projectDir = freshProject("ac-e1-kiro-");
    const ctx = buildCtx(projectDir, buildE1Connector(), "user");

    const changes = kiroAdapter.installHooks!(ctx);
    expectE1WarnSkips(changes, "kiro", "Kiro");

    // User-scope agent file resolves under the HOME sandbox.
    const agentPath = kiroAdapter.getHookConfigPath!(ctx);
    expect(agentPath.startsWith(projectDir)).toBe(true);
    const agent = readJson(agentPath);
    expect(Object.keys(agent.hooks)).toEqual(["preToolUse"]);
    const text = readFileSync(agentPath, "utf8");
    for (const token of FORBIDDEN_NATIVE_TOKENS) {
      expect(text).not.toContain(token);
    }
  });
});
