/**
 * adapters/goose.test.ts — the ONE per-host file for Block's Goose adapter.
 *
 * goose is a json-stdio host. Config surfaces:
 *   • MCP servers  → ~/.config/goose/config.yaml, ROOT KEY "extensions", a native
 *                    Goose stdio entry { type:"stdio", cmd, args, envs } — `cmd`
 *                    (NOT `command`), `envs` (NOT `env`); env-refs resolve to
 *                    LITERALS (no ${env:VAR} support).
 *   • Hooks        → <projectDir>/.agents/plugins/<id>/hooks/hooks.json
 *                    (JSON Open-Plugins file, nested-rule shape, NO version key).
 *   • Skills       → cross-agent .agents dir (NOT ~/.config/goose):
 *                    project scope → <projectDir>/.agents/skills/<name>/SKILL.md
 *                    user scope    → ~/.agents/skills/<name>/SKILL.md
 *
 * This file consolidates what used to be split across goose.test.ts (skills) +
 * wave3.test.ts (render/round-trip) + extended-events-batch2.test.ts (E1
 * extension events). It uses the shared harness (tests/support/env +
 * adapter-suite) per tests/README.md — ONE file per host.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { parse as parseYaml } from "yaml";
import { beforeEach, describe, expect, it } from "vitest";

import { ensureDir } from "../../src/core/paths.js";
import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type {
  ConnectorConfig,
  PostToolUseFailureEvent,
  PreToolUseEvent,
  ResolvedConnector,
} from "../../src/core/types.js";

import gooseAdapter from "../../src/adapters/goose/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN, tempDir } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";

// ── shared fixtures ──────────────────────────────────────────────────────────

// The render/round-trip + extension-event slices declare a stdio server with an
// env-ref so literal-resolution produces a known value.
const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const SERVER_CWD = "/srv/acme";
const PRE_MATCHER = "acme_query|acme_write";
const AGENT_MATCHER = "code-reviewer|explore";

// The skills slice uses its own connector id + fixture.
const SKILLS_CONNECTOR_ID = "acme-goose-skills";

// The serve-wrapper args also bake the install TARGET platform as `--host <id>`
// (before `--`) so the proxy stamps hostPlatform under a headless spawn.
const wrappedArgs = (host: string): string[] =>
  ["serve", "--connector", CONNECTOR_ID, "--scope", "user", "--host", host, "--", "npx", "-y", "@x/y"];

/**
 * A connector with a stdio server (env-ref) + PreToolUse and SessionStart hooks.
 * goose supports PreToolUse + SessionStart; the deny round-trip exercises
 * PreToolUse.
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

// ── skills fixture ───────────────────────────────────────────────────────────

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
    displayName: "Acme Goose Skills",
    version: "1.0.0",
    skills: [skill()],
    ...cfg,
  });
}

// ── local helpers ────────────────────────────────────────────────────────────

/** Read + parse a YAML file from disk (independent of the adapter's readYaml). */
function readYamlFile(path: string): Record<string, any> {
  return parseYaml(readFileSync(path, "utf8")) as Record<string, any>;
}

/** Read + parse a JSON file from disk (small local helper; fs.ts lives on a
 * different branch and importing it here would not resolve). */
function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
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

function splitFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  if (!m) throw new Error(`not a frontmatter doc:\n${text}`);
  return {
    frontmatter: parseYaml(m[1]!) as Record<string, unknown>,
    body: m[2]!,
  };
}

// Shared env isolation + the same-rules-for-every-host baseline contract.
// extraKeys: the render/round-trip slice mutates APPDATA/LOCALAPPDATA (to sandbox
// Goose's Windows %APPDATA%/Block/goose path) and the ACME_DB_DSN env-ref var.
isolateEnv(["LOCALAPPDATA", ENV_VAR]);
createAdapterSuite({ adapter: gooseAdapter, paradigm: "json-stdio" });

// ── render + round-trip (extensions in YAML config.yaml; hooks in JSON) ───────

describe("goose adapter render + round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-wave3-goose-");
    // Goose uses %APPDATA%/Block/goose on Windows — isolate it (and LOCALAPPDATA)
    // into the sandbox so the test never reads or pollutes the real user AppData.
    process.env.APPDATA = join(projectDir, "AppData", "Roaming");
    process.env.LOCALAPPDATA = join(projectDir, "AppData", "Local");
    // The env-ref var is set so literal-resolution produces a known value.
    process.env[ENV_VAR] = ENV_LITERAL;
    ctx = buildCtx(projectDir, buildConnector(), "user");
  });

  it('installServer writes ROOT KEY "extensions".<id> as a Goose stdio entry (YAML, cmd not command, envs not env)', () => {
    const changes = gooseAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = gooseAdapter.getServerConfigPath(ctx);
    // Goose config is config.yaml under a goose dir (~/.config/goose on POSIX,
    // %APPDATA%/Block/goose/config on Windows) — assert the shape portably.
    const norm = serverPath.replace(/\\/g, "/");
    expect(norm).toContain("goose/");
    expect(norm.endsWith("config.yaml")).toBe(true);
    expect(existsSync(serverPath)).toBe(true);

    // The on-disk file is valid YAML (independent parse).
    const cfg = readYamlFile(serverPath);
    expect(cfg).toHaveProperty("extensions");
    expect(cfg).not.toHaveProperty("mcpServers");

    const entry = cfg.extensions[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    expect(entry.type).toBe("stdio");

    // Goose-specific field names: `cmd` (NOT `command`), `envs` (NOT `env`).
    expect(entry).toHaveProperty("cmd");
    expect(entry).not.toHaveProperty("command");
    expect(entry).toHaveProperty("envs");
    expect(entry).not.toHaveProperty("env");

    // Telemetry serve-wrapper: cmd points at the home binary, wrapped args.
    expect(entry.cmd).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedArgs("goose"));

    // Goose has no ${env:VAR} support → env-ref resolves to a LITERAL value.
    expect(entry.envs[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.envs[ENV_VAR]).not.toContain("${");
    expect(entry.enabled).toBe(true);
    expect(typeof entry.timeout).toBe("number");
  });

  it("installHooks writes .agents/plugins/<id>/hooks/hooks.json (nested-rule, NO version key)", () => {
    const changes = gooseAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const hookPath = join(
      projectDir,
      ".agents",
      "plugins",
      CONNECTOR_ID,
      "hooks",
      "hooks.json",
    );
    expect(hookPath).toBe(gooseAdapter.getHookConfigPath(ctx));
    expect(existsSync(hookPath)).toBe(true);

    const file = readJson(hookPath);
    // Open-Plugins spec has NO top-level `version` key (corrected).
    expect(file.version).toBeUndefined();

    // Nested-rule shape: { hooks: { <Event>: [ { matcher?, hooks:[{type,command}] } ] } }.
    const pre = file.hooks.PreToolUse;
    expect(Array.isArray(pre)).toBe(true);
    const preCmd = pre[0].hooks[0];
    expect(preCmd.type).toBe("command");
    expect(preCmd.command).toContain(HOME_BIN);
    expect(preCmd.command).toContain("hook goose PreToolUse");
    expect(preCmd.command).toContain(`--connector ${CONNECTOR_ID}`);

    // SessionStart is supported and registered too.
    expect(file.hooks.SessionStart[0].hooks[0].command).toContain("hook goose SessionStart");
  });

  it("installServer + installHooks idempotent (skip on a second run); uninstall removes both", () => {
    gooseAdapter.installServer(ctx);
    gooseAdapter.installHooks(ctx);

    expect(gooseAdapter.installServer(ctx)[0]?.action).toBe("skip");
    expect(gooseAdapter.installHooks(ctx).every((c) => c.action === "skip")).toBe(true);

    const serverPath = gooseAdapter.getServerConfigPath(ctx);
    const hookPath = gooseAdapter.getHookConfigPath(ctx);

    // No duplicate extension entries / hook entries after the second run.
    const cfg = readYamlFile(serverPath);
    expect(Object.keys(cfg.extensions)).toEqual([CONNECTOR_ID]);
    expect(readJson(hookPath).hooks.PreToolUse).toHaveLength(1);

    gooseAdapter.uninstallServer(ctx);
    const afterServer = readYamlFile(serverPath);
    expect(afterServer.extensions?.[CONNECTOR_ID]).toBeUndefined();

    gooseAdapter.uninstallHooks(ctx);
    const afterHooks = readJson(hookPath);
    expect(JSON.stringify(afterHooks.hooks ?? {})).not.toContain(HOME_BIN);
  });

  it("MERGE: a pre-authored unrelated YAML key survives installServer", () => {
    const serverPath = gooseAdapter.getServerConfigPath(ctx);
    seedUnrelatedYaml(serverPath);

    gooseAdapter.installServer(ctx);

    const cfg = readYamlFile(serverPath);
    // Our extension was added…
    expect(cfg.extensions?.[CONNECTOR_ID]).toBeTruthy();
    // …and the user's unrelated keys are untouched.
    expect(cfg.user_setting).toBe("keep-me");
    expect(cfg.other).toEqual({ nested: true });
  });

  it("parseEvent yields a normalized PreToolUse; formatReply(deny) → stdout {decision:block}, exit 0", () => {
    const ev = gooseAdapter.parseEvent!("PreToolUse", preToolUsePayload()) as PreToolUseEvent;
    assertPreToolUse(ev, "goose");
    expect(ev.sessionId).toBe("sess-123");

    const reply = gooseAdapter.formatReply!("PreToolUse", {
      decision: "deny",
      reason: "blocked by policy",
    });
    expect(reply.exitCode).toBe(0);
    const out = JSON.parse(reply.stdout!);
    // Goose deny shape is `{ decision: "block", reason }` (NOT Claude's
    // hookSpecificOutput.permissionDecision) — corrected.
    expect(out.decision).toBe("block");
    expect(out.reason).toBe("blocked by policy");
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  // CAPABILITY-CONTRACT (D1): Goose declares userPromptSubmit:false and only
  // delivers PreToolUse/PostToolUse/SessionStart. installHooks must filter
  // declared events against the adapter capabilities BEFORE writing — a
  // connector that declares an UNSUPPORTED event (UserPromptSubmit) must NOT
  // get that event written into hooks.json, only a graceful warn ChangeRecord.
  it("installHooks SKIPS an unsupported event (PreCompact) with a warn but still writes PreToolUse", () => {
    const upsConnector = defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme DB Tools",
      version: "1.2.3",
      hooks: {
        PreToolUse: {
          matcher: PRE_MATCHER,
          handler() {
            return { decision: "allow" };
          },
        },
        PreCompact: {
          handler() {
            return { decision: "allow" };
          },
        },
      },
    });
    const upsCtx = buildCtx(projectDir, upsConnector, "user");

    const changes = gooseAdapter.installHooks(upsCtx);

    // PreCompact is unsupported on goose → a warn ChangeRecord, never written.
    const warn = changes.find(
      (c) => c.action === "warn" && c.detail?.includes("PreCompact"),
    );
    expect(warn).toBeTruthy();
    expect(warn?.detail).toContain("unsupported on goose");
    // PreToolUse IS supported → created.
    expect(
      changes.some((c) => c.action === "create" && c.detail === "hooks.PreToolUse"),
    ).toBe(true);
    // No change record was emitted that would write hooks.PreCompact.
    expect(
      changes.some(
        (c) =>
          c.action !== "warn" && c.detail === "hooks.PreCompact",
      ),
    ).toBe(false);

    const hookPath = gooseAdapter.getHookConfigPath(upsCtx);
    const file = readJson(hookPath);
    // The on-disk file carries PreToolUse but NOT the unsupported UserPromptSubmit.
    expect(file.hooks.PreToolUse).toBeTruthy();
    expect(file.hooks.UserPromptSubmit).toBeUndefined();
  });
});

// ── extended events (E1): dedicated PostToolUseFailure; no permission/subagent ──

describe("goose — extended-event install", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-ext-events2-goose-");
    ctx = buildCtx(projectDir, buildExtConnector());
  });

  it("registers hooks.PostToolUseFailure (capability-filtered); permission/subagent events warn-skip", () => {
    const changes = gooseAdapter.installHooks(ctx);

    const hooksPath = join(
      projectDir,
      ".agents",
      "plugins",
      CONNECTOR_ID,
      "hooks",
      "hooks.json",
    );
    expect(existsSync(hooksPath)).toBe(true);
    const cfg = readJson(hooksPath);

    const bucket = cfg.hooks.PostToolUseFailure;
    expect(Array.isArray(bucket)).toBe(true);
    expect(bucket[0].matcher).toBe("acme_query");
    expect(bucket[0].hooks[0].command).toContain("hook goose PostToolUseFailure");

    for (const event of ["PermissionRequest", "SubagentStart", "SubagentStop"]) {
      const warn = changes.find((c) => c.action === "warn" && c.detail?.includes(event));
      expect(warn).toBeTruthy();
      expect(warn!.detail).toContain("unsupported on goose");
      expect(cfg.hooks[event]).toBeUndefined();
    }
  });
});

describe("goose — extended-event parse + replies", () => {
  it("PostToolUseFailure maps error/tool_use_id/is_interrupt/duration_ms (+ working_dir → projectDir)", () => {
    const evt = gooseAdapter.parseEvent!("PostToolUseFailure", {
      session_id: "sess-1",
      working_dir: "/home/dev/acme",
      tool_name: "shell",
      tool_input: { command: "make test" },
      tool_use_id: "call_01",
      error: "exit status 2",
      is_interrupt: false,
      duration_ms: 450,
    }) as PostToolUseFailureEvent;
    expect(evt.hostPlatform).toBe("goose");
    expect(evt.toolName).toBe("shell");
    expect(evt.toolInput).toEqual({ command: "make test" });
    expect(evt.error).toBe("exit status 2");
    expect(evt.toolUseId).toBe("call_01");
    expect(evt.isInterrupt).toBe(false);
    expect(evt.durationMs).toBe(450);
    expect(evt.projectDir).toBe("/home/dev/acme");

    const minimal = gooseAdapter.parseEvent!("PostToolUseFailure", {
      tool_name: "write",
    }) as PostToolUseFailureEvent;
    expect(minimal.error).toBe("");
  });

  it("PermissionRequest / SubagentStart / SubagentStop throw (no Goose analog)", () => {
    for (const event of ["PermissionRequest", "SubagentStart", "SubagentStop"] as const) {
      expect(() => gooseAdapter.parseEvent!(event, {})).toThrow(
        /unsupported goose hook event/,
      );
    }
  });

  it("PostToolUseFailure is feedback-only: context → {additionalContext}; deny DEGRADES (never {decision:'block'}); void → exit 0", () => {
    const context = JSON.parse(
      gooseAdapter.formatReply!("PostToolUseFailure", {
        decision: "context",
        additionalContext: "retry with -j1",
      }).stdout!,
    );
    expect(context).toEqual({ additionalContext: "retry with -j1" });

    const denied = JSON.parse(
      gooseAdapter.formatReply!("PostToolUseFailure", {
        decision: "deny",
        reason: "not blockable",
      }).stdout!,
    );
    expect(denied).toEqual({ additionalContext: "not blockable" });
    expect(denied.decision).toBeUndefined();

    const noop = gooseAdapter.formatReply!("PostToolUseFailure", {});
    expect(noop).toEqual({ exitCode: 0 });
  });

  it("PreToolUse deny still renders Goose's {decision:'block', reason} (regression guard)", () => {
    const reply = JSON.parse(
      gooseAdapter.formatReply!("PreToolUse", { decision: "deny", reason: "nope" }).stdout!,
    );
    expect(reply).toEqual({ decision: "block", reason: "nope" });
  });
});

// ── skills surface (.agents/skills, cross-agent dir) ──────────────────────────

describe("goose adapter — skills surface", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-goose-skills-");
    ctx = buildCtx(projectDir, buildSkillsConnector());
  });

  it("declares supportsSkills true", () => {
    expect(gooseAdapter.capabilities.supportsSkills).toBe(true);
  });

  it("installSkills (project scope) writes .agents/skills/<n>/SKILL.md with correct frontmatter", () => {
    const changes = gooseAdapter.installSkills!(ctx);
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.platform).toBe("goose");

    const skillMd = join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md");
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
    gooseAdapter.installSkills!(ctx);
    const resource = join(projectDir, ".agents", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(resource)).toBe(true);
    expect(readFileSync(resource, "utf8")).toBe(SKILL.resources["scripts/extract.sh"]);
  });

  it("installSkills (user scope) writes ~/.agents/skills/<n>/SKILL.md", () => {
    const userCtx = buildCtx(projectDir, buildSkillsConnector(), "user");
    const changes = gooseAdapter.installSkills!(userCtx);
    expect(changes[0]?.action).toBe("create");
    expect(changes[0]?.platform).toBe("goose");

    // HOME redirected to projectDir → ~/.agents === projectDir/.agents
    const skillMd = join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md");
    expect(changes[0]?.path).toBe(skillMd);
    expect(existsSync(skillMd)).toBe(true);

    const { frontmatter } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    expect(frontmatter.name).toBe("pdf-tools");
  });

  it("user-scope skill does NOT write into the project .agents tree", () => {
    // Write user-scope into one dir, project-scope into another — no overlap.
    const userDir = freshProject("ac-goose-skills-");
    const projDir = tempDir("ac-goose-skills-proj-");
    const userCtx = buildCtx(projDir, buildSkillsConnector(), "user");
    gooseAdapter.installSkills!(userCtx);

    // The project dir's .agents tree must be empty (user wrote to HOME/.agents).
    expect(existsSync(join(projDir, ".agents", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
    // The user HOME/.agents tree got the file.
    expect(existsSync(join(userDir, ".agents", "skills", "pdf-tools", "SKILL.md"))).toBe(true);
  });

  it("installSkills is idempotent — second call yields skip", () => {
    gooseAdapter.installSkills!(ctx);
    const second = gooseAdapter.installSkills!(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstallSkills removes SKILL.md, resource, and the empty skill dir", () => {
    gooseAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".agents", "skills", "pdf-tools", "scripts", "extract.sh");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(resource)).toBe(true);

    const changes = gooseAdapter.uninstallSkills!(ctx);
    expect(changes.every((c) => c.platform === "goose")).toBe(true);
    expect(existsSync(skillMd)).toBe(false);
    expect(existsSync(resource)).toBe(false);
    expect(existsSync(join(projectDir, ".agents", "skills", "pdf-tools"))).toBe(false);
  });

  it("honors platforms['goose'].skills === false", () => {
    const disabled = defineConnector({
      id: SKILLS_CONNECTOR_ID,
      skills: [skill()],
      platforms: { goose: { skills: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    const changes = gooseAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".agents", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
  });

  it("installSkills with no skills declared returns skip", () => {
    const noSkills = defineConnector({ id: SKILLS_CONNECTOR_ID, memory: [{ content: "placeholder" }] });
    const c2 = buildCtx(projectDir, noSkills);
    const changes = gooseAdapter.installSkills!(c2);
    expect(changes[0]?.action).toBe("skip");
  });
});
