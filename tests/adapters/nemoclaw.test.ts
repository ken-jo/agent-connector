/**
 * adapters/nemoclaw.test.ts — the ONE per-host file for NVIDIA NemoClaw.
 *
 * NemoClaw is a thin FORK of the OpenClaw adapter (it extends OpenClawAdapter,
 * overriding only id / name / detectInstalled). It is a `ts-plugin` host: it
 * REUSES every render / hook / parse / surface path from OpenClaw unchanged, and
 * the config the wrapped agent actually loads is the SAME `~/.openclaw/openclaw.json`
 * the OpenClaw adapter targets (a NemoClaw box has BOTH `~/.nemoclaw/` AND
 * `~/.openclaw/` markers on disk — it DRIVES the wrapped config). The openclaw
 * paths referenced below are therefore CORRECT for nemoclaw: they exercise the
 * fork's wrapping behaviour, not an openclaw dependency.
 *
 * This file consolidates EVERY nemoclaw surface (the per-host convention in
 * tests/README.md — one file per host):
 *   • identity + detection → keys on the NemoClaw marker `~/.nemoclaw/`, does NOT
 *                   collide with openclaw (a `~/.openclaw/`-only box is NOT
 *                   nemoclaw; a both-markers box is nemoclaw-ONLY, openclaw bows out).
 *   • MCP server  → install lands in the WRAPPED openclaw.json (NESTED
 *                   mcp.servers.<id>), stamped platform=nemoclaw; remote http →
 *                   the accepted literal "streamable-http", sse → "sse".
 *   • skills      → INHERITED AgentSkills dir-per-skill SKILL.md, stamped nemoclaw.
 *   • hooks       → the generated plugin bridge bakes `["hook", "nemoclaw", …]`
 *                   (HOST binding, not openclaw); UserPromptSubmit maps to
 *                   before_prompt_build; nativeHooks passthrough survives
 *                   hooks:false while canonical handlers are suppressed.
 *   • actions     → the generated registerCommand bakes `["action", "nemoclaw", …]`.
 *
 * Migrated to the shared harness (tests/support/env + adapter-suite). The
 * identity/MCP/skills/hooks/action blocks came from the old nemoclaw base file;
 * the remote-transport, hooks:false-leak, and UserPromptSubmit / nativeHooks /
 * parseEvent blocks were absorbed from the three former nemoclaw-only openclaw
 * sibling files (now deleted — this file is the SINGLE nemoclaw file).
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { Adapter, InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector, Transport } from "../../src/core/types.js";

import nemoclawAdapter from "../../src/adapters/nemoclaw/index.js";
import openclawAdapter from "../../src/adapters/openclaw/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { readJson } from "../support/fs.js";
import { createAdapterSuite } from "../support/adapter-suite.js";

// ─────────────────────────────────────────────────────────────────────────
// node:child_process mock — hoisted above every import by vitest. The inherited
// OpenClaw generated-plugin bridge imports `execFileSync` (POSIX) / `execSync`
// (Windows) at top-level; the bridge tests reprogram what the mock returns via
// execFileSyncImpl, then read the freshly-written module. (Carried from the
// absorbed UserPromptSubmit slice.)
// ─────────────────────────────────────────────────────────────────────────

let execFileSyncImpl: (...args: any[]) => string = () => "";
const execFileSyncMock = vi.fn((...args: any[]) => execFileSyncImpl(...args));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  execSync: execFileSyncMock,
}));

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";

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
      tools: { include: ["*"] },
    },
  });
}

/** Same connector, plus one skill (drives the inherited installSkills). */
function buildSkillsConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    skills: [
      {
        name: "db-explain",
        description: "Explain a SQL query plan. Use when the user asks why a query is slow.",
        body: "# DB Explain\n\nRun EXPLAIN on the query and summarize the plan.",
      },
    ],
  });
}

/** Same connector, plus PreToolUse + SessionStart hooks (drives installHooks). */
function buildHooksConnector(): ResolvedConnector {
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
          return { decision: "allow" };
        },
      },
    },
  });
}

/** Same connector, plus one action (drives the inherited installActions). */
function buildActionsConnector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.2.3",
    actions: [
      { id: "reindex", description: "Rebuild the search index.", run: () => undefined },
    ],
  });
}

// ── remote transport fixtures (absorbed remote-transport slice) ─────────────────
const REMOTE_CONNECTOR_ID = "acme-remote";

function remoteConnector(transport: Transport): ResolvedConnector {
  return defineConnector({
    id: REMOTE_CONNECTOR_ID,
    displayName: "Acme Remote",
    version: "1.0.0",
    server: {
      transport,
      url: "https://mcp.acme.example/endpoint",
      headers: { Authorization: "Bearer ${env:ACME_TOKEN}" },
      tools: { include: ["*"] },
    },
  });
}

/** Install a remote server and return the written native entry. */
function installRemoteAndRead(
  adapter: Adapter,
  transport: Transport,
  prefix: string,
): Record<string, any> {
  const projectDir = freshRemoteHome(prefix);
  const ctx = buildCtx(projectDir, remoteConnector(transport));
  adapter.installServer!(ctx);
  const cfg = JSON.parse(readFileSync(adapter.getServerConfigPath!(ctx), "utf8"));
  return cfg.mcp.servers[REMOTE_CONNECTOR_ID];
}

/** Fresh HOME for the remote-transport slice: pins ACME_TOKEN, clears OPENCLAW_*. */
function freshRemoteHome(prefix: string): string {
  const dir = freshProject(prefix);
  process.env.ACME_TOKEN = "tok-123";
  delete process.env.OPENCLAW_CONFIG_PATH;
  delete process.env.OPENCLAW_STATE_DIR;
  return dir;
}

// ── hooks:false leak fixtures (absorbed hooks:false-leak slice) ─────────────────
const LEAK_CONNECTOR_ID = "acme-leak";

/** A connector with a canonical PreToolUse hook + an action, hooks toggled per arg. */
function leakConnector(hooksDisabled: boolean): ResolvedConnector {
  return defineConnector({
    id: LEAK_CONNECTOR_ID,
    hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
    actions: [{ id: "reindex", description: "Rebuild the search index.", run: () => undefined }],
    platforms: hooksDisabled ? { nemoclaw: { hooks: false } } : {},
  });
}

// ── UserPromptSubmit / nativeHooks fixtures (absorbed UserPromptSubmit slice) ────
const UPS_CONNECTOR_ID = "acme-ups";

/** Declares BOTH SessionStart and UserPromptSubmit (global hooks, host-agnostic). */
function connectorBoth(): ResolvedConnector {
  return defineConnector({
    id: UPS_CONNECTOR_ID,
    hooks: {
      SessionStart: { handler: () => ({ decision: "allow" }) },
      UserPromptSubmit: { handler: () => ({ decision: "allow" }) },
    },
  });
}

/** A canonical PreToolUse hook + a host-native passthrough hook, hooks toggled. */
function connectorNative(host: string, hooksDisabled: boolean): ResolvedConnector {
  return defineConnector({
    id: UPS_CONNECTOR_ID,
    hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
    platforms: {
      [host]: {
        nativeHooks: { agent_turn: { handler: () => undefined } },
        ...(hooksDisabled ? { hooks: false } : {}),
      },
    },
  });
}

// Pin process.platform to a POSIX value for the whole file so the generated
// bridge takes its execFileSync(HOME_BIN, [args]) path (on Windows it would use
// execSync(one quoted string) — correct in production, proven separately, but it
// would not match these bridges' execFileSync(bin, argv) call-shape assertions).
const REAL_PLATFORM = process.platform;
beforeEach(() => {
  execFileSyncMock.mockClear();
  execFileSyncImpl = () => "";
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
});

// Shared env isolation (default keys + the env-ref / OpenClaw root vars the
// render/remote slices mutate) + the same-rules-for-every-host baseline contract.
isolateEnv([ENV_VAR, "ACME_TOKEN", "OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"]);
createAdapterSuite({ adapter: nemoclawAdapter, paradigm: "ts-plugin" });

// ─────────────────────────────────────────────────────────────────────────
// identity + detection (does NOT collide with openclaw)
// ─────────────────────────────────────────────────────────────────────────

describe("nemoclaw adapter — identity + detection (does NOT collide with openclaw)", () => {
  it("has the nemoclaw identity but inherits OpenClaw's ts-plugin paradigm", () => {
    expect(nemoclawAdapter.id).toBe("nemoclaw");
    expect(nemoclawAdapter.name).toBe("NVIDIA NemoClaw");
    expect(nemoclawAdapter.paradigm).toBe("ts-plugin");
    // Paradigm + capabilities are inherited from OpenClawAdapter verbatim.
    expect(nemoclawAdapter.paradigm).toBe(openclawAdapter.paradigm);
  });

  it("detects ONLY when the ~/.nemoclaw/ marker is present", () => {
    const home = freshProject("ac-nemoclaw-detect-");
    // No ~/.nemoclaw/ yet → not installed.
    expect(nemoclawAdapter.detectInstalled(home).installed).toBe(false);

    // Create the NemoClaw marker dir → installed, high confidence.
    mkdirSync(join(home, ".nemoclaw"), { recursive: true });
    const det = nemoclawAdapter.detectInstalled(home);
    expect(det.installed).toBe(true);
    expect(det.id).toBe("nemoclaw");
    expect(det.confidence).toBe("high");
    expect(det.reason).toMatch(/NemoClaw/);
  });

  it("a ~/.openclaw/-only box is NOT detected as nemoclaw (no collision)", () => {
    const home = freshProject("ac-nemoclaw-noco-");
    // Only the OpenClaw marker exists — NOT NemoClaw.
    mkdirSync(join(home, ".openclaw"), { recursive: true });

    expect(nemoclawAdapter.detectInstalled(home).installed).toBe(false);
    // ...while the openclaw adapter DOES see it (the fork-ordering payoff).
    expect(openclawAdapter.detectInstalled(home).installed).toBe(true);
  });

  it("a REAL NemoClaw box (BOTH ~/.nemoclaw/ AND ~/.openclaw/) is nemoclaw-ONLY — openclaw bows out", () => {
    const home = freshProject("ac-nemoclaw-both-");
    // A NemoClaw install DRIVES the wrapped OpenClaw config, so a real NemoClaw
    // box has BOTH markers on disk. nemoclaw must claim it; openclaw must DEFER —
    // its detectInstalled bows out when ~/.nemoclaw/ is present so the planner
    // does not double-target the shared ~/.openclaw/openclaw.json as two
    // platforms (an `uninstall openclaw` would otherwise strip nemoclaw's entries).
    mkdirSync(join(home, ".nemoclaw"), { recursive: true });
    mkdirSync(join(home, ".openclaw"), { recursive: true });

    expect(nemoclawAdapter.detectInstalled(home).installed).toBe(true);
    // The bow-out: openclaw sees its own ~/.openclaw/ marker but defers because
    // ~/.nemoclaw/ is present. Without the bow-out this would be `true` and the
    // shared config would be double-targeted.
    expect(openclawAdapter.detectInstalled(home).installed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// MCP install lands in the WRAPPED openclaw.json
// ─────────────────────────────────────────────────────────────────────────

describe("nemoclaw adapter — MCP install lands in the WRAPPED openclaw.json", () => {
  let projectDir: string;
  let ctx: InstallContext;
  let configPath: string;

  beforeEach(() => {
    projectDir = freshProject("ac-nemoclaw-mcp-");
    process.env[ENV_VAR] = ENV_LITERAL;
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.OPENCLAW_STATE_DIR;
    ctx = buildCtx(projectDir, buildConnector());
    // Project scope → <projectDir>/openclaw.json (inherited resolution).
    configPath = join(projectDir, "openclaw.json");
    expect(configPath).toBe(nemoclawAdapter.getServerConfigPath(ctx));
  });

  it("installServer writes the NESTED mcp.servers.<id> entry, stamped platform=nemoclaw", () => {
    const changes = nemoclawAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");
    // The ChangeRecord carries the nemoclaw identity (this.id), not openclaw.
    expect(changes[0]?.platform).toBe("nemoclaw");
    expect(existsSync(configPath)).toBe(true);

    const cfg = readJson(configPath);
    // The wrapped OpenClaw shape: nested under top-level "mcp", key "servers"
    // (NOT a top-level mcpServers key).
    expect(cfg).toHaveProperty("mcp");
    expect(cfg).not.toHaveProperty("mcpServers");
    expect(cfg.mcp).toHaveProperty("servers");

    const entry = cfg.mcp.servers[CONNECTOR_ID];
    expect(entry).toBeTruthy();
    // stdio sidecar: no transport key (inferred from command), telemetry-wrapped
    // through the home bin, env resolved to a literal.
    expect("transport" in entry).toBe(false);
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toContain("serve");
    expect(entry.args).toContain("--connector");
    expect(entry.args).toContain(CONNECTOR_ID);
    // The serve-wrapper bakes the install target as `--host nemoclaw`.
    expect(entry.args).toContain("--host");
    expect(entry.args).toContain("nemoclaw");
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installServer is idempotent — second call yields skip, no duplicate", () => {
    nemoclawAdapter.installServer(ctx);
    const second = nemoclawAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");
    const cfg = readJson(configPath);
    expect(Object.keys(cfg.mcp.servers)).toEqual([CONNECTOR_ID]);
  });

  it("uninstallServer removes the nested entry (re-read confirms gone)", () => {
    nemoclawAdapter.installServer(ctx);
    const removed = nemoclawAdapter.uninstallServer(ctx);
    expect(removed[0]?.platform).toBe("nemoclaw");
    const cfg = readJson(configPath);
    expect(cfg.mcp?.servers?.[CONNECTOR_ID]).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// remote MCP transport literal (http → "streamable-http", sse → "sse")
//
// NemoClaw is a fork that inherits renderServerEntry unchanged. OpenClaw's config
// validator accepts a remote `transport` of "sse" | "streamable-http" and REJECTS
// a bare "http", so AC's canonical "http" must render as "streamable-http".
// (Absorbed remote-transport slice.)
// ─────────────────────────────────────────────────────────────────────────

describe("nemoclaw adapter — remote MCP transport literal", () => {
  it("renders canonical http as OpenClaw's accepted literal 'streamable-http' (NOT 'http')", () => {
    const entry = installRemoteAndRead(nemoclawAdapter as Adapter, "http", "ac-nemoclaw-http-");
    expect(entry.transport).toBe("streamable-http");
    expect(entry.transport).not.toBe("http");
    expect(entry.url).toBe("https://mcp.acme.example/endpoint");
    // headers carried + env ref resolved to a literal (no native ${env:} token).
    expect(entry.headers.Authorization).toBe("Bearer tok-123");
    // remote sidecar is NOT telemetry-wrapped → no stdio command shape.
    expect("command" in entry).toBe(false);
  });

  it("renders sse as 'sse'", () => {
    const entry = installRemoteAndRead(nemoclawAdapter as Adapter, "sse", "ac-nemoclaw-sse-");
    expect(entry.transport).toBe("sse");
    expect(entry.url).toBe("https://mcp.acme.example/endpoint");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// INHERITS OpenClaw's installSkills (does NOT override it)
// ─────────────────────────────────────────────────────────────────────────

describe("nemoclaw adapter — INHERITS OpenClaw's installSkills (does NOT override it)", () => {
  let projectDir: string;
  let ctx: InstallContext;
  let skillMd: string;

  beforeEach(() => {
    projectDir = freshProject("ac-nemoclaw-skills-");
    ctx = buildCtx(projectDir, buildSkillsConnector());
    // Project scope resolves the workspace to <stateDir>/workspace
    // (~/.openclaw/workspace) — the inherited OpenClaw path, unchanged by the fork.
    skillMd = join(projectDir, ".openclaw", "workspace", "skills", "db-explain", "SKILL.md");
  });

  it("nemoclawAdapter.installSkills writes a SKILL.md too (inheritance), stamped platform=nemoclaw", () => {
    const changes = nemoclawAdapter.installSkills(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);
    // The inherited method stamps the ChangeRecord with the FORK's id (this.id),
    // so nemoclaw stamps "nemoclaw" — not "openclaw".
    expect(changes.every((c) => c.platform === "nemoclaw")).toBe(true);

    expect(existsSync(skillMd)).toBe(true);
    const src = readFileSync(skillMd, "utf8");
    expect(src).toMatch(/^name: db-explain$/m);
    expect(src).toContain("# DB Explain");
  });

  it("uninstallSkills (inherited) removes the SKILL.md, stamped platform=nemoclaw", () => {
    nemoclawAdapter.installSkills(ctx);
    expect(existsSync(skillMd)).toBe(true);

    const changes = nemoclawAdapter.uninstallSkills(ctx);
    expect(changes.every((c) => c.platform === "nemoclaw")).toBe(true);
    expect(existsSync(skillMd)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// hooks bridge dispatches `hook nemoclaw` (HOST binding, not openclaw)
// ─────────────────────────────────────────────────────────────────────────

describe("nemoclaw adapter — hooks bridge dispatches `hook nemoclaw` (HOST binding, not openclaw)", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-nemoclaw-hooks-");
    ctx = buildCtx(projectDir, buildHooksConnector());
  });

  it("the synthesized plugin module bakes `[\"hook\", \"nemoclaw\", …]` (NOT openclaw)", () => {
    const changes = nemoclawAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);
    // Every ChangeRecord carries the nemoclaw identity (this.id), not openclaw.
    expect(changes.every((c) => c.platform === "nemoclaw")).toBe(true);

    // The plugin lands in the WRAPPED openclaw workspace (inherited path) — that
    // is correct: nemoclaw runs the openclaw agent, which loads from .openclaw/.
    const pluginPath = nemoclawAdapter.getHookConfigPath(ctx);
    expect(existsSync(pluginPath)).toBe(true);

    const src = readFileSync(pluginPath, "utf8");
    // THE host-binding fix: the bridge bakes the install target into the hook
    // dispatch so events route back to THIS adapter. A plain `"openclaw"` token
    // here (the pre-fix bug from the module-const HOST binding) would mis-route
    // every nemoclaw hook to the openclaw adapter.
    expect(src).toContain('["hook", "nemoclaw", event');
    expect(src).not.toContain('["hook", "openclaw", event');
    expect(src).toContain("--connector");
    expect(src).toContain(CONNECTOR_ID);
    expect(src).toContain(HOME_BIN);
  });

  it("parseEvent stamps hostPlatform=nemoclaw (dispatched events route to THIS adapter)", () => {
    const evt = nemoclawAdapter.parseEvent!("PreToolUse", {
      toolName: "acme_write",
      toolInput: { sql: "DELETE" },
      sessionId: "nc-1",
      projectDir: "/some/proj",
    });
    expect(evt).toMatchObject({
      hostPlatform: "nemoclaw",
      toolName: "acme_write",
      toolInput: { sql: "DELETE" },
      sessionId: "nc-1",
      projectDir: "/some/proj",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// UserPromptSubmit (before_prompt_build) + supportsNativeHooks
//
// NemoClaw INHERITS the whole machinery, host-bound to "nemoclaw". OpenClaw's
// before_prompt_build fires PER TURN and can ONLY inject context (no blocking).
// (Absorbed UserPromptSubmit slice.)
// ─────────────────────────────────────────────────────────────────────────

describe("nemoclaw adapter — userPromptSubmit + supportsNativeHooks capabilities", () => {
  it("declares userPromptSubmit && supportsNativeHooks", () => {
    expect(nemoclawAdapter.capabilities.userPromptSubmit).toBe(true);
    expect(nemoclawAdapter.capabilities.supportsNativeHooks).toBe(true);
  });
});

describe("nemoclaw adapter — nativeHooks passthrough", () => {
  it("a nativeHooks event registers an on(...) bridge in the generated plugin", () => {
    const projectDir = freshProject("ac-nemoclaw-ups-");
    const ctx = buildCtx(projectDir, connectorNative("nemoclaw", false));
    nemoclawAdapter.installHooks(ctx);
    const src = readFileSync(nemoclawAdapter.getHookConfigPath(ctx), "utf8");
    expect(src).toContain('on("agent_turn"');
    expect(src).toContain('bridge("agent_turn"');
  });

  it("nativeHooks SURVIVE hooks:false while canonical handlers are suppressed", () => {
    const projectDir = freshProject("ac-nemoclaw-ups-");
    const ctx = buildCtx(projectDir, connectorNative("nemoclaw", true));
    nemoclawAdapter.installHooks(ctx);
    const src = readFileSync(nemoclawAdapter.getHookConfigPath(ctx), "utf8");
    // Native passthrough was written despite hooks:false.
    expect(src).toContain('on("agent_turn"');
    // Canonical handlers suppressed by the canonicalOff guard.
    expect(src).not.toContain('on("before_tool_call"');
  });
});

describe("nemoclaw adapter — inherits UserPromptSubmit, host-bound to nemoclaw", () => {
  it("generates the same before_prompt_build + UserPromptSubmit bridge, dispatched to nemoclaw", () => {
    const projectDir = freshProject("ac-nemoclaw-ups-");
    const ctx = buildCtx(projectDir, connectorBoth());
    nemoclawAdapter.installHooks(ctx);
    const src = readFileSync(nemoclawAdapter.getHookConfigPath(ctx), "utf8");

    expect(src).toContain('on("before_prompt_build"');
    expect(src).toContain('bridge("UserPromptSubmit"');
    // The generated bridge command is HOST-BOUND to nemoclaw (NOT openclaw).
    expect(src).toContain('["hook", "nemoclaw", event');
    expect(src).not.toContain('["hook", "openclaw", event');
  });
});

describe("nemoclaw adapter — parseEvent(UserPromptSubmit)", () => {
  it("normalizes the bridge payload to a prompt-carrying event", () => {
    const evt = nemoclawAdapter.parseEvent("UserPromptSubmit", {
      prompt: "do the thing",
      sessionId: "uc-9",
      projectDir: "/some/proj",
    });
    expect(evt).toMatchObject({
      hostPlatform: "nemoclaw",
      prompt: "do the thing",
      sessionId: "uc-9",
      projectDir: "/some/proj",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// action commands dispatch `action nemoclaw` (HOST binding, not openclaw)
// ─────────────────────────────────────────────────────────────────────────

describe("nemoclaw adapter — action commands dispatch `action nemoclaw` (HOST binding, not openclaw)", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-nemoclaw-act-");
    ctx = buildCtx(projectDir, buildActionsConnector());
  });

  it("inherits installActions (does NOT override it) and advertises supportsActions", () => {
    expect(nemoclawAdapter.capabilities.supportsActions).toBe(true);
    // The fork does not override installActions — it is the inherited OpenClaw one.
    expect(nemoclawAdapter.installActions).toBe(openclawAdapter.installActions);
  });

  it("the generated registerCommand bakes `[\"action\", \"nemoclaw\", …]` (NOT openclaw) — the this.id binding guard", () => {
    const changes = nemoclawAdapter.installActions!(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);
    // Every ChangeRecord carries the nemoclaw identity (this.id), not openclaw.
    expect(changes.every((c) => c.platform === "nemoclaw")).toBe(true);

    const pluginPath = nemoclawAdapter.getHookConfigPath(ctx);
    expect(existsSync(pluginPath)).toBe(true);
    const src = readFileSync(pluginPath, "utf8");

    // THE binding fix: the action verb bakes the install target (this.id) as the
    // host token, so the command routes back to THIS adapter. A plain
    // `"openclaw"` here (the pre-fix module-const HOST bug) would mis-route every
    // nemoclaw action to the openclaw adapter.
    expect(src).toContain("api.registerCommand(");
    expect(src).toContain('["action", "nemoclaw", "reindex", "--connector"');
    expect(src).not.toContain('["action", "openclaw", "reindex", "--connector"');
    expect(src).toContain(CONNECTOR_ID);
    expect(src).toContain(HOME_BIN);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// hooks:false must NOT leak canonical handlers via installActions
//
// The generated module is synthesized by BOTH installHooks AND installActions (a
// connector with actions but hooks:false still writes the module — for the
// actions). NemoClaw inherits buildPluginSource from OpenClaw; it must honor
// `platforms[host].hooks === false` and emit NO canonical handler.
// (Absorbed hooks:false-leak slice.)
// ─────────────────────────────────────────────────────────────────────────

describe("nemoclaw adapter — hooks:false does not leak canonical handlers via installActions", () => {
  it("installActions writes the plugin for the action but OMITS the canonical before_tool_call handler under hooks:false", () => {
    const projectDir = freshProject("ac-nemoclaw-leak-");
    const ctx = buildCtx(projectDir, leakConnector(true));
    nemoclawAdapter.installActions!(ctx);
    const src = readFileSync(nemoclawAdapter.getHookConfigPath!(ctx), "utf8");
    // Canonical handlers register via on("<native_event>", …) — MUST be
    // suppressed by hooks:false (omitted from the generated source entirely).
    expect(src).not.toContain('on("before_tool_call"');
    expect(src).not.toContain('on("after_tool_call"');
    // The plugin WAS written (for the action) — registerCommand present.
    expect(src).toContain("reindex");
  });

  it("CONTROL: with hooks enabled, the same connector DOES emit the canonical before_tool_call handler", () => {
    const projectDir = freshProject("ac-nemoclaw-leak-");
    const ctx = buildCtx(projectDir, leakConnector(false));
    nemoclawAdapter.installActions!(ctx);
    const src = readFileSync(nemoclawAdapter.getHookConfigPath!(ctx), "utf8");
    expect(src).toContain('on("before_tool_call"');
  });
});
