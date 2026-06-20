/**
 * adapters/crush.test.ts — the ONE per-host file for the Crush (Charm) adapter.
 *
 * crush is a json-stdio host. A single JSON config file holds BOTH the MCP server
 * registrations and the hook registrations; agent-connector MERGES into it.
 * Config surfaces:
 *   • MCP servers → .crush.json (project) / ~/.config/crush/crush.json (user),
 *                   ROOT KEY "mcp" (NOT "mcpServers"); stdio entry { type:"stdio",
 *                   command, args, env?, timeout, disabled }; NO native ${env:VAR}
 *                   support (and $(...) is expanded at load) → env-refs resolve to
 *                   LITERALS at install time.
 *   • Hooks       → the SAME crush.json top-level "hooks" key. Crush honors
 *                   PreToolUse ONLY; every other normalized event has no analog.
 *                   The four newer E1 events (PermissionRequest / PostToolUseFailure
 *                   / SubagentStart / SubagentStop) warn-skip (action `warn`, exit-1)
 *                   per the registry-wide convention; every OTHER unsupported event
 *                   (SessionStart, Stop, …) reports a VISIBLE `skip` (exit-0
 *                   preserving) — nothing Crush cannot fire is ever silently dropped.
 *   • Content     → skills only: <projectDir>/.crush/skills/<name>/SKILL.md
 *                   (project) / ~/.config/crush/skills/<name>/SKILL.md (user). Paths
 *                   are HARD-CODED — no crush.json entry is written.
 *   • Reply       → Crush deny → stdout JSON { decision:"deny", reason } at exit 0;
 *                   every non-deny decision (and non-PreToolUse event) degrades to a
 *                   silent allow (exit 0, empty stdout).
 *
 * This file consolidates what used to be split across crush-skills.test.ts (the
 * skills surface), the crush slice of wave2.test.ts (render/round-trip), and the
 * crush slice of extended-events-degrade.test.ts (E1 degradation). It uses the
 * shared harness (tests/support/env + adapter-suite + fs) per tests/README.md —
 * ONE file per host.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { Adapter, InstallContext } from "../../src/adapters/spi.js";
import type {
  ConnectorConfig,
  PreToolUseEvent,
  ResolvedConnector,
} from "../../src/core/types.js";

import crushAdapter from "../../src/adapters/crush/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson, splitFrontmatter } from "../support/fs.js";

// ── shared fixtures ──────────────────────────────────────────────────────────

// The skills slice uses its own connector id + fixture.
const SKILLS_CONNECTOR_ID = "acme-crush-skills";

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
    displayName: "Acme Crush Skills",
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

// The serve-wrapper args also bake the install TARGET platform as `--host <id>`
// (before `--`) so the proxy stamps hostPlatform under a headless spawn.
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

/**
 * render: a connector with a stdio server (env-ref + cwd) + PreToolUse and
 * SessionStart hooks. The PreToolUse + SessionStart pair lets the deny-only host
 * (crush) register PreToolUse only while reporting SessionStart as a visible skip.
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

/** A connector declaring ONLY the four E1 events (pure warn-skip path). */
function buildE1OnlyConnector(id = CONNECTOR_ID): ResolvedConnector {
  return defineConnector({
    id,
    hooks: {
      PermissionRequest: { handler() {} },
      PostToolUseFailure: { handler() {} },
      SubagentStart: { handler() {} },
      SubagentStop: { handler() {} },
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

/** Common assertions for a normalized PreToolUse event from crush. */
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
// extraKeys: the render/E1 slices mutate ACME_DB_DSN (the env-ref → literal
// value); the skills slice isolates the Windows user-config root LOCALAPPDATA
// (and the POSIX XDG_CONFIG_HOME, which isolateEnv already snapshots). HOME/
// USERPROFILE/AGENT_CONNECTOR_DATA_DIR are covered by isolateEnv's defaults.
isolateEnv([ENV_VAR, "LOCALAPPDATA"]);
createAdapterSuite({ adapter: crushAdapter, paradigm: "json-stdio" });

// ── skills surface ───────────────────────────────────────────────────────────

describe("crush adapter — skills surface", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-crush-skills-");
    // Crush's user dir is home.Config()/crush = ~/.config/crush; pin XDG into the
    // sandbox so the test never reads or writes the real user config dir.
    delete process.env.XDG_CONFIG_HOME;
    // Windows: crush's user dir is %LOCALAPPDATA%\crush — isolate it into the
    // sandbox too, or the adapter writes to the real user AppData/Local.
    process.env.LOCALAPPDATA = join(projectDir, "AppData", "Local");
    ctx = buildCtx(projectDir, buildSkillsConnector());
  });

  it("declares supportsSkills true", () => {
    expect(crushAdapter.capabilities.supportsSkills).toBe(true);
  });

  it("installSkills (project scope) writes .crush/skills/<n>/SKILL.md with correct frontmatter", () => {
    const changes = crushAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.platform).toBe("crush");

    const skillMd = join(projectDir, ".crush", "skills", "pdf-tools", "SKILL.md");
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
    crushAdapter.installSkills!(ctx);
    const resource = join(projectDir, ".crush", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills (user scope) writes ~/.config/crush/skills/<n>/SKILL.md", () => {
    const userCtx = buildCtx(projectDir, buildSkillsConnector(), "user");
    const changes = crushAdapter.installSkills!(userCtx);
    expect(changes[0]?.action).toBe("create");

    // crush user dir: POSIX ~/.config/crush, Windows %LOCALAPPDATA%\crush — both
    // isolated into projectDir via the HOME + LOCALAPPDATA redirects.
    const userCrushDir =
      process.platform === "win32"
        ? join(projectDir, "AppData", "Local", "crush")
        : join(projectDir, ".config", "crush");
    const skillMd = join(userCrushDir, "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);
    // It must NOT leak into the project .crush tree.
    expect(existsSync(join(projectDir, ".crush", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("installSkills is idempotent — second call yields skip", () => {
    crushAdapter.installSkills!(ctx);
    const second = crushAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource, and the empty skill dir", () => {
    crushAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".crush", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".crush", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);

    const changes = crushAdapter.uninstallSkills!(ctx);
    expect(changes.every((c) => c.platform === "crush")).toBe(true);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(resource)).toBe(false);
    expect(existsSync(join(projectDir, ".crush", "skills", "pdf-tools"))).toBe(false);
  });

  it("skips-warns when the skills path is a FILE (no ENOTDIR crash)", () => {
    // Plant .crush/skills as a regular FILE where we need a directory.
    const skillsDir = join(projectDir, ".crush", "skills");
    mkdirSync(dirname(skillsDir), { recursive: true });
    writeFileSync(skillsDir, "not a dir", "utf8");

    const changes = crushAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("is a file, not a directory");
    // No SKILL.md was written under the file.
    expect(existsSync(join(skillsDir, "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("honors platforms['crush'].skills === false", () => {
    const disabled = defineConnector({
      id: SKILLS_CONNECTOR_ID,
      skills: [skill()],
      platforms: { crush: { skills: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    const changes = crushAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".crush", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("installSkills with no skills declared returns skip", () => {
    const noSkills = defineConnector({ id: SKILLS_CONNECTOR_ID, memory: [{ content: "placeholder" }] });
    const c2 = buildCtx(projectDir, noSkills);
    const changes = crushAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
  });
});

// ── User config dir XDG resolution ────────────────────────────────────────────
// Crush resolves its user config dir via `home.Config()` =
// `cmp.Or(XDG_CONFIG_HOME, ~/.config)` (charmbracelet/crush internal/home/home.go),
// so the same logic applies on Linux AND macOS. Every user-scope surface (the
// shared crush.json for servers + hooks, the skills dir, and the detection probe)
// must flow through $XDG_CONFIG_HOME/crush when set — NOT a hardcoded ~/.config/crush
// — or crush (which reads the XDG dir) never sees what agent-connector wrote.
//
// POSIX-only: this PR fixes the non-win32 branch. On Windows the adapter keeps its
// documented `%LOCALAPPDATA%\crush` path (see userConfigDir win32 branch) and does
// NOT consult $XDG_CONFIG_HOME, so these XDG assertions are skipped there. (Whether
// crush's own home.Config() honors XDG on Windows too is a separately-flagged
// follow-up, not this change.)
describe.skipIf(process.platform === "win32")("crush adapter — user config dir XDG resolution", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = freshProject("ac-crush-xdg-");
  });

  function userCtx(): InstallContext {
    return buildCtx(projectDir, buildSkillsConnector(), "user");
  }

  it("resolves user-scope paths under $XDG_CONFIG_HOME/crush when XDG is set", () => {
    const xdg = join(projectDir, "xdg-root");
    process.env.XDG_CONFIG_HOME = xdg; // restored by isolateEnv's afterEach
    const ctx = userCtx();

    const expectedDir = join(xdg, "crush");
    // Server + hooks share ONE crush.json — both resolve under the XDG dir.
    expect(crushAdapter.getServerConfigPath(ctx)).toBe(join(expectedDir, "crush.json"));
    expect(crushAdapter.getHookConfigPath(ctx)).toBe(join(expectedDir, "crush.json"));
    expect(crushAdapter.getConfigDir(ctx)).toBe(expectedDir);

    // Skills surface (skillsDir is private — exercised via the install path).
    const changes = crushAdapter.installSkills!(ctx);
    expect(changes[0]?.path).toBe(join(expectedDir, "skills", "pdf-tools", "SKILL.md"));

    // Detection probes the XDG dir (NOT ~/.config/crush). A config there is a
    // recognized user install.
    mkdirSync(expectedDir, { recursive: true });
    writeFileSync(join(expectedDir, "crush.json"), "{}", "utf8");
    const detected = crushAdapter.detectInstalled(projectDir);
    expect(detected.installed).toBe(true);
    expect(detected.scope).toBe("user");
    expect(detected.configPath).toBe(join(expectedDir, "crush.json"));

    // Nothing landed under the hardcoded ~/.config/crush fallback.
    expect(existsSync(join(projectDir, ".config", "crush"))).toBe(false);
  });

  it("falls back to ~/.config/crush when XDG is unset (default-case parity)", () => {
    delete process.env.XDG_CONFIG_HOME; // restored by isolateEnv's afterEach
    const ctx = userCtx();

    // HOME is redirected to projectDir, so ~/.config/crush → projectDir/.config/crush.
    const expectedDir = join(projectDir, ".config", "crush");
    expect(crushAdapter.getServerConfigPath(ctx)).toBe(join(expectedDir, "crush.json"));
    expect(crushAdapter.getHookConfigPath(ctx)).toBe(join(expectedDir, "crush.json"));
    expect(crushAdapter.getConfigDir(ctx)).toBe(expectedDir);

    const changes = crushAdapter.installSkills!(ctx);
    expect(changes[0]?.path).toBe(join(expectedDir, "skills", "pdf-tools", "SKILL.md"));
  });
});

// ── render + round-trip (root key "mcp" + top-level "hooks" in one crush.json) ─

describe("crush adapter render + round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave2-crush-");
    // Set the env-ref var so literal-resolution produces a known value.
    process.env[ENV_VAR] = ENV_LITERAL;
    ctx = buildCtx(projectDir, buildConnector());
  });

  it('installServer writes the entry under ROOT KEY "mcp" (NOT "mcpServers") into .crush.json, wrapped, env LITERAL', () => {
    const changes = crushAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = join(projectDir, ".crush.json");
    expect(serverPath).toBe(crushAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    // ROOT KEY is "mcp" — Crush's quirk vs. the "mcpServers" of Claude/Gemini.
    expect(cfg).toHaveProperty("mcp");
    expect(cfg).not.toHaveProperty("mcpServers");

    const entry = cfg.mcp[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.type).toBe("stdio");
    expect(entry.disabled).toBe(false);
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedArgs("crush"));
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installHooks writes the top-level 'hooks' key in crush.json; SessionStart → visible skip (PreToolUse only written)", () => {
    const changes = crushAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const hookPath = join(projectDir, ".crush.json");
    expect(hookPath).toBe(crushAdapter.getHookConfigPath(ctx));

    const cfg = readJson(hookPath);
    const pre = cfg.hooks.PreToolUse;
    expect(Array.isArray(pre)).toBe(true);
    expect(pre[0].matcher).toBe(PRE_MATCHER);
    expect(pre[0].command).toContain(HOME_BIN);
    expect(pre[0].command).toContain("hook crush PreToolUse");
    expect(pre[0].command).toContain(`--connector ${CONNECTOR_ID}`);

    // Crush honors PreToolUse ONLY — SessionStart is reported as a visible skip
    // (never silent) but must NOT be registered into the file.
    const sess = changes.find((c) => c.detail?.startsWith("SessionStart "));
    expect(sess?.action).toBe("skip");
    expect(cfg.hooks.SessionStart).toBeUndefined();
  });

  it("server + hooks coexist in ONE crush.json; both idempotent; uninstall removes both", () => {
    crushAdapter.installServer(ctx);
    crushAdapter.installHooks(ctx);

    const both = readJson(join(projectDir, ".crush.json"));
    expect(both.mcp?.[CONNECTOR_ID]).toBeTruthy();
    expect(both.hooks?.PreToolUse).toBeTruthy();

    expect(crushAdapter.installServer(ctx)[0]?.action).toBe("skip");
    expect(
      crushAdapter.installHooks(ctx).every((c) => c.action === "skip"),
    ).toBe(true);

    crushAdapter.uninstallServer(ctx);
    const afterServer = readJson(join(projectDir, ".crush.json"));
    expect(afterServer.mcp?.[CONNECTOR_ID]).toBeUndefined();
    // Removing the server must not disturb the hooks section.
    expect(afterServer.hooks?.PreToolUse).toBeTruthy();

    crushAdapter.uninstallHooks(ctx);
    const afterHooks = readJson(join(projectDir, ".crush.json"));
    expect(JSON.stringify(afterHooks.hooks ?? {})).not.toContain(HOME_BIN);
  });

  it("parseEvent yields a normalized PreToolUse; formatReply(deny) → stdout {decision:'deny'}, exit 0", () => {
    const ev = crushAdapter.parseEvent!("PreToolUse", preToolUsePayload()) as PreToolUseEvent;
    assertPreToolUse(ev, "crush");
    expect(ev.sessionId).toBe("sess-123");

    // Crush deny → stdout JSON { decision:"deny", reason } at exit 0.
    const reply = crushAdapter.formatReply!("PreToolUse", {
      decision: "deny",
      reason: "blocked by policy",
    });
    expect(reply.exitCode).toBe(0);
    const out = JSON.parse(reply.stdout!);
    expect(out.decision).toBe("deny");
    expect(out.reason).toBe("blocked by policy");
  });
});

// ── E1 extension-event degradation (no Crush analog → warn-skip) ──────────────

describe("crush E1 capability flags stay unset (no native analog)", () => {
  it("leaves permissionRequest/postToolUseFailure/subagentStart/subagentStop falsy", () => {
    expect(crushAdapter.capabilities.permissionRequest ?? false).toBe(false);
    expect(crushAdapter.capabilities.postToolUseFailure ?? false).toBe(false);
    expect(crushAdapter.capabilities.subagentStart ?? false).toBe(false);
    expect(crushAdapter.capabilities.subagentStop ?? false).toBe(false);
  });
});

describe("crush E1 degradation", () => {
  it("installHooks warn-skips all four (NEW convention) while still wiring PreToolUse", () => {
    const projectDir = freshProject("ac-e1-crush-");
    const ctx = buildCtx(projectDir, buildE1Connector());

    const changes = crushAdapter.installHooks!(ctx);
    expectE1WarnSkips(changes, "crush", "Crush");
    expect(changes.some((c) => c.action === "create" && c.detail === "hooks.PreToolUse")).toBe(
      true,
    );

    const cfg = readJson(join(projectDir, ".crush.json"));
    expect(Object.keys(cfg.hooks)).toEqual(["PreToolUse"]);
  });

  it("a connector declaring ONLY E1 events → four warns and NO file write", () => {
    const projectDir = freshProject("ac-e1-crush-only-");
    const ctx = buildCtx(projectDir, buildE1OnlyConnector());

    const changes = crushAdapter.installHooks!(ctx);
    expectE1WarnSkips(changes, "crush", "Crush");
    expect(changes.every((c) => c.action === "warn")).toBe(true);
    // No registrable event → crush.json must not be created at all.
    expect(existsSync(join(projectDir, ".crush.json"))).toBe(false);
  });

  it("a host-unwired NON-E1 event (SessionStart) emits a VISIBLE skip, never silent", () => {
    const projectDir = freshProject("ac-e1-crush-legacy-");
    const legacy = defineConnector({
      id: CONNECTOR_ID,
      hooks: {
        PreToolUse: { handler() {} },
        SessionStart: { handler() {} },
      },
    });
    const changes = crushAdapter.installHooks!(buildCtx(projectDir, legacy));
    // SessionStart has no Crush equivalent → a VISIBLE `skip` record (NOT silent,
    // NOT a `warn`, so the install exit code is unchanged for the legacy event).
    const sess = changes.find((c) => c.detail?.startsWith("SessionStart "));
    expect(sess, "expected a visible record for SessionStart").toBeTruthy();
    expect(sess!.action).toBe("skip");
    expect(sess!.detail).toBe("SessionStart has no Crush hook equivalent — skipped");
    // No `warn` (a legacy drop must not start tripping exit-1)…
    expect(changes.some((c) => c.action === "warn")).toBe(false);
    // …and PreToolUse is still the only event actually written to the file.
    const cfg = readJson(join(projectDir, ".crush.json"));
    expect(Object.keys(cfg.hooks)).toEqual(["PreToolUse"]);
  });
});
