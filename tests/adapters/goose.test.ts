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
  PostToolUseEvent,
  PostToolUseFailureEvent,
  PreToolUseEvent,
  ResolvedConnector,
  SessionEndEvent,
  SessionStartEvent,
  StopEvent,
  Transport,
  UserPromptSubmitEvent,
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

  // ── PINNED detail strings (hook-engine migration safety net) ──────────────
  // goose hook install/uninstall emit DIVERGENT detail strings vs other hosts
  // (notably the `(<n>)` count on remove, which codex omits); these exact-match
  // assertions characterize the CURRENT behavior so a future hook-engine
  // migration must reproduce them byte-identically.
  it("installHooks with NO hooks declared → skip detail `connector declares no hooks`", () => {
    const noHooks = defineConnector({
      id: CONNECTOR_ID,
      server: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@x/y"],
        tools: { include: ["*"] },
      },
    });
    const changes = gooseAdapter.installHooks(buildCtx(projectDir, noHooks, "user"));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toBe("connector declares no hooks");
  });

  it("installHooks create detail is the bare `hooks.<event>` form", () => {
    const changes = gooseAdapter.installHooks(ctx);
    const pre = changes.find((c) => c.detail === "hooks.PreToolUse");
    expect(pre?.action).toBe("create");
    expect(pre?.detail).toBe("hooks.PreToolUse");
  });

  it("installHooks idempotent skip detail is the BARE `hooks.<event>` (no 'already registered')", () => {
    gooseAdapter.installHooks(ctx);
    const second = gooseAdapter.installHooks(ctx);
    const pre = second.find((c) => c.detail?.includes("PreToolUse"));
    expect(pre?.action).toBe("skip");
    // goose does NOT append "already registered" — bare event form is the pin.
    expect(pre?.detail).toBe("hooks.PreToolUse");
    expect(pre?.detail).not.toContain("already registered");
  });

  it("unsupported-event warn detail is the EXACT `<event> unsupported on goose — skipped`", () => {
    const upsConnector = defineConnector({
      id: CONNECTOR_ID,
      hooks: {
        PreCompact: {
          handler() {
            return { decision: "allow" };
          },
        },
      },
    });
    const changes = gooseAdapter.installHooks(buildCtx(projectDir, upsConnector, "user"));
    const warn = changes.find((c) => c.action === "warn");
    expect(warn?.detail).toBe("PreCompact unsupported on goose — skipped");
  });

  it("uninstallHooks with no hooks.json present → skip detail `no hooks.json`", () => {
    const changes = gooseAdapter.uninstallHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toBe("no hooks.json");
  });

  it("uninstallHooks remove detail INCLUDES the `(<n>)` count: `hooks.<event> (1)` for a single removal", () => {
    gooseAdapter.installHooks(ctx);
    const changes = gooseAdapter.uninstallHooks(ctx);
    const pre = changes.find((c) => c.detail?.startsWith("hooks.PreToolUse"));
    expect(pre?.action).toBe("remove");
    // goose DOES include the count — exactly `(1)` for one removed inner command.
    expect(pre?.detail).toBe("hooks.PreToolUse (1)");
  });

  it("uninstallHooks when hooks.json has none of ours → skip detail `no matching hook entries`", () => {
    const hookPath = gooseAdapter.getHookConfigPath(ctx);
    ensureDir(dirname(hookPath));
    writeFileSync(
      hookPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "/usr/bin/other run" }] }],
        },
      }),
      "utf8",
    );
    const changes = gooseAdapter.uninstallHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toBe("no matching hook entries");
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

// ── MCP transports (stdio / http=streamable_http; sse/ws warn-skip) ───────────
//
// Goose's ExtensionConfig is a tagged enum: `type:"stdio"` (local) and
// `type:"streamable_http"` (remote, field `uri` NOT `url`). The legacy
// `type:"sse"` variant still parses for old-config compatibility but Goose
// REJECTS it at connect time ("SSE is unsupported, migrate to streamable_http"),
// so the adapter advertises only ["stdio","http"] and warn-skips an sse/ws
// server rather than writing a broken empty-cmd stdio entry.

const REMOTE_URL = "https://mcp.acme.example/streamable";

/** A server-only connector for the http/sse/ws transport tests. */
function remoteConnector(transport: Transport): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: {
      transport,
      url: REMOTE_URL,
      headers: { Authorization: "Bearer abc" },
    },
  });
}

describe("goose adapter — MCP transports", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-goose-transport-");
    process.env.APPDATA = join(projectDir, "AppData", "Roaming");
    process.env.LOCALAPPDATA = join(projectDir, "AppData", "Local");
    ctx = buildCtx(projectDir, remoteConnector("http"), "user");
  });

  it('advertises exactly ["stdio","http"] — the legacy "sse" transport is NOT advertised', () => {
    expect(gooseAdapter.capabilities.transports).toEqual(["stdio", "http"]);
    expect(gooseAdapter.capabilities.transports).not.toContain("sse");
  });

  it('http server → { type:"streamable_http", uri, headers } (uri NOT url; NO empty cmd)', () => {
    const changes = gooseAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = gooseAdapter.getServerConfigPath(ctx);
    const cfg = readYamlFile(serverPath);
    const entry = cfg.extensions[CONNECTOR_ID];
    expect(entry).toBeTruthy();

    // Goose's CURRENT remote transport is Streamable HTTP, keyed `uri` (NOT `url`).
    expect(entry.type).toBe("streamable_http");
    expect(entry.uri).toBe(REMOTE_URL);
    expect(entry).not.toHaveProperty("url");

    // A remote server must NOT degrade to a broken empty-cmd stdio entry.
    expect(entry).not.toHaveProperty("cmd");
    expect(entry.type).not.toBe("stdio");

    // headers carry through (env-refs would resolve to literals); timeout/enabled set.
    expect(entry.headers).toEqual({ Authorization: "Bearer abc" });
    expect(entry.enabled).toBe(true);
    expect(typeof entry.timeout).toBe("number");
  });

  it("http server resolves ${env:VAR} in uri + headers to LITERALS (goose has no native env support)", () => {
    // Goose can't interpolate ${env:VAR} itself, so AC must resolve it at install
    // time — an unresolved placeholder in a remote URL / auth header silently breaks
    // the connection. Lock that the remote path resolves like the stdio path does.
    const prevHost = process.env.AC_GOOSE_HOST;
    const prevTok = process.env.AC_GOOSE_TOKEN;
    process.env.AC_GOOSE_HOST = "mcp.live.example";
    process.env.AC_GOOSE_TOKEN = "tok-live-123";
    try {
      const c = defineConnector({
        id: CONNECTOR_ID,
        displayName: "Acme DB Tools",
        version: "1.2.3",
        server: {
          transport: "http",
          url: "https://${env:AC_GOOSE_HOST}/mcp",
          headers: { Authorization: "Bearer ${env:AC_GOOSE_TOKEN}" },
        },
      });
      const envCtx = buildCtx(projectDir, c, "user");
      gooseAdapter.installServer(envCtx);
      const entry = readYamlFile(gooseAdapter.getServerConfigPath(envCtx)).extensions[CONNECTOR_ID];
      expect(entry.uri).toBe("https://mcp.live.example/mcp");
      expect(entry.uri).not.toContain("${env:");
      expect(entry.headers.Authorization).toBe("Bearer tok-live-123");
    } finally {
      if (prevHost === undefined) delete process.env.AC_GOOSE_HOST;
      else process.env.AC_GOOSE_HOST = prevHost;
      if (prevTok === undefined) delete process.env.AC_GOOSE_TOKEN;
      else process.env.AC_GOOSE_TOKEN = prevTok;
    }
  });

  it('sse server → warn-skip (no broken empty-cmd stdio entry written), points at streamable_http', () => {
    const sseCtx = buildCtx(projectDir, remoteConnector("sse"), "user");
    const changes = gooseAdapter.installServer(sseCtx);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain('transport "sse" not registrable');
    expect(changes[0]?.detail).toContain("streamable_http");

    // Nothing was written — no broken empty-cmd stdio entry on disk.
    const serverPath = gooseAdapter.getServerConfigPath(sseCtx);
    expect(existsSync(serverPath)).toBe(false);
  });

  it("ws server → warn-skip too (only stdio + http registrable)", () => {
    const wsCtx = buildCtx(projectDir, remoteConnector("ws"), "user");
    const changes = gooseAdapter.installServer(wsCtx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain('transport "ws" not registrable');
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
  // SOURCE-VERIFIED (kimi #189 false-friend class): goose builds the failure
  // HookContext with ONLY with_tool + with_working_dir (agent.rs:526-537); its
  // struct (hooks/mod.rs:162-176) has no error/tool_use_id/is_interrupt/
  // duration_ms field, so NONE of those are on the wire. The adapter no longer
  // reads them — even a synthetic payload that (wrongly) includes them must not
  // surface them on the normalized event, and `error` is always "" (host gap).
  it("PostToolUseFailure: maps tool_name/tool_input + working_dir→projectDir; error always '' and no phantom failure fields", () => {
    const evt = gooseAdapter.parseEvent!("PostToolUseFailure", {
      session_id: "sess-1",
      working_dir: "/home/dev/acme",
      tool_name: "shell",
      tool_input: { command: "make test" },
      // Fields goose NEVER serializes — present here only to prove the adapter
      // ignores them (false-friend reads removed).
      tool_use_id: "call_01",
      error: "exit status 2",
      is_interrupt: false,
      duration_ms: 450,
    }) as PostToolUseFailureEvent;
    expect(evt.hostPlatform).toBe("goose");
    expect(evt.toolName).toBe("shell");
    expect(evt.toolInput).toEqual({ command: "make test" });
    expect(evt.projectDir).toBe("/home/dev/acme");
    // error is a HOST GAP — goose carries no failure text on stdin → always "".
    expect(evt.error).toBe("");
    // The removed false-friend reads must not resurface from a stray payload.
    expect(evt.toolUseId).toBeUndefined();
    expect(evt.isInterrupt).toBeUndefined();
    expect(evt.durationMs).toBeUndefined();

    // A bare failure ctx (what goose actually sends) parses without throwing and
    // still yields error === "".
    const minimal = gooseAdapter.parseEvent!("PostToolUseFailure", {
      tool_name: "write",
    }) as PostToolUseFailureEvent;
    expect(minimal.error).toBe("");
    expect(minimal.toolUseId).toBeUndefined();
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

// ── wire false-friend fixes (kimi #189 class — read fields goose ACTUALLY emits) ─
//
// goose's stdin payload is the serialized `HookContext` struct
// (crates/goose/src/hooks/mod.rs:162-176): ONLY event/session_id/matcher_context/
// tool_name?/tool_input?/tool_output?/message?/working_dir?. The adapter formerly
// read Claude-style fields goose never sends (prompt, tool_response, is_error,
// source, reason, stop_hook_active, error, tool_use_id, is_interrupt,
// duration_ms). These assert the corrected reads + that the dead-read removals
// don't crash on a bare/real-shaped payload.
describe("goose — wire false-friend fixes (HookContext struct)", () => {
  it("UserPromptSubmit: reads the prompt from `message` (goose has no `prompt` field) → prompt === 'hi'", () => {
    const ev = gooseAdapter.parseEvent!("UserPromptSubmit", {
      session_id: "sess-9",
      working_dir: "/work/proj",
      message: "hi",
      connector: CONNECTOR_ID,
    }) as UserPromptSubmitEvent;
    expect(ev.hostPlatform).toBe("goose");
    expect(ev.prompt).toBe("hi");

    // The OLD wire field `prompt` is a false friend — it must be ignored now.
    const stray = gooseAdapter.parseEvent!("UserPromptSubmit", {
      prompt: "should-be-ignored",
    }) as UserPromptSubmitEvent;
    expect(stray.prompt).toBe("");
  });

  it("PostToolUse: reads `tool_output` (NOT `tool_response`) and never emits isError", () => {
    const ev = gooseAdapter.parseEvent!("PostToolUse", {
      tool_name: "shell",
      tool_input: { command: "ls" },
      tool_output: "file-a\nfile-b",
    }) as PostToolUseEvent;
    expect(ev.toolName).toBe("shell");
    expect(ev.toolOutput).toBe("file-a\nfile-b");
    // No `is_error` field exists on HookContext → isError is never set.
    expect(ev.isError).toBeUndefined();

    // The OLD `tool_response` field is a false friend — ignored now.
    const stray = gooseAdapter.parseEvent!("PostToolUse", {
      tool_name: "shell",
      tool_input: {},
      tool_response: "should-be-ignored",
      is_error: true,
    }) as PostToolUseEvent;
    expect(stray.toolOutput).toBeUndefined();
    expect(stray.isError).toBeUndefined();
  });

  it("SessionStart: bare HookContext has no source → defaults to 'startup' (any stray source ignored)", () => {
    const ev = gooseAdapter.parseEvent!("SessionStart", {
      session_id: "sess-2",
    }) as SessionStartEvent;
    expect(ev.source).toBe("startup");

    // goose has no `source` field; a stray one must NOT change the result.
    const stray = gooseAdapter.parseEvent!("SessionStart", {
      source: "resume",
    }) as SessionStartEvent;
    expect(stray.source).toBe("startup");
  });

  it("SessionEnd: dead-read `reason` removed → bare payload parses, no reason surfaced", () => {
    const ev = gooseAdapter.parseEvent!("SessionEnd", {
      session_id: "sess-3",
    }) as SessionEndEvent;
    expect(ev.hostPlatform).toBe("goose");
    expect(ev.reason).toBeUndefined();

    // goose has no `reason` field on input; a stray one is ignored.
    const stray = gooseAdapter.parseEvent!("SessionEnd", {
      reason: "should-be-ignored",
    }) as SessionEndEvent;
    expect(stray.reason).toBeUndefined();
  });

  it("Stop: dead-read `stop_hook_active` removed → bare payload parses, no stopHookActive surfaced", () => {
    const ev = gooseAdapter.parseEvent!("Stop", {
      session_id: "sess-4",
    }) as StopEvent;
    expect(ev.hostPlatform).toBe("goose");
    expect(ev.stopHookActive).toBeUndefined();

    // goose has no `stop_hook_active` field; a stray one is ignored.
    const stray = gooseAdapter.parseEvent!("Stop", {
      stop_hook_active: true,
    }) as StopEvent;
    expect(stray.stopHookActive).toBeUndefined();
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
