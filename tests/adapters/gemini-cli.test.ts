/**
 * adapters/gemini-cli.test.ts — the ONE per-host file for the Gemini CLI adapter.
 *
 * gemini-cli is a json-stdio host. Config surfaces:
 *   • MCP servers → <projectDir>/.gemini/settings.json, ROOT KEY "mcpServers"
 *                   (object map keyed by connector id); stdio selected BY KEY
 *                   (command/args, no `type` field); NO native ${env:VAR} support
 *                   → env-refs resolve to LITERALS at install time.
 *   • Hooks       → the SAME .gemini/settings.json top-level "hooks" key, shape
 *                   { <geminiEvent>: [ { matcher?, hooks:[ { type:"command",
 *                   command } ] } ] }. Normalized events map to Gemini's distinct
 *                   vocabulary (PreToolUse → BeforeTool, SessionStart → SessionStart);
 *                   nativeHooks lifecycle keys (BeforeModel, BeforeToolSelection, …)
 *                   are written VERBATIM (no EVENT_MAP).
 *   • Host-native → the OPT-IN AfterModel usage hook (telemetry.hostNativeUsage or
 *                   AGENT_CONNECTOR_HOST_NATIVE=1), routed to the hidden
 *                   `usage-event` entrypoint with an empty matcher.
 *   • Content     → <projectDir>/.gemini/{commands,skills,agents}: commands are
 *                   TOML (@iarna/toml); skills are <name>/SKILL.md + resources;
 *                   subagents are md+frontmatter.
 *   • E1 events   → PermissionRequest / PostToolUseFailure / SubagentStart /
 *                   SubagentStop have no Gemini analog → the standard per-event
 *                   warn-skip; the native file never references them.
 *
 * This file consolidates what used to be split across
 * gemini-cli-native-hooks.test.ts (nativeHooks passthrough), host-native-hooks.test.ts
 * (the opt-in AfterModel usage hook — gemini-cli was its last host), phase2-render.test.ts
 * (render/round-trip — gemini-cli was its last host), surfaces-s1.test.ts (content
 * surfaces — gemini-cli was its last host), and the gemini-cli slice of
 * extended-events-degrade.test.ts (E1 degradation). It uses the shared harness
 * (tests/support/env + adapter-suite + fs) per tests/README.md — ONE file per host.
 * TOML commands are parsed with @iarna/toml (readJson is JSON only); md+fm docs use
 * splitFrontmatter; JSON files use readJson.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseToml } from "@iarna/toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { Adapter, InstallContext } from "../../src/adapters/spi.js";
import type { PostToolUseEvent, ResolvedConnector } from "../../src/core/types.js";

import geminiAdapter from "../../src/adapters/gemini-cli/index.js";
import { buildCtx, freshProject, isolateEnv, HOME_BIN } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson, splitFrontmatter } from "../support/fs.js";

// ── shared fixtures ──────────────────────────────────────────────────────────

// nativeHooks slice id.
const NATIVE_CONNECTOR_ID = "acme-gem";
// render/round-trip + host-native usage + E1 slices share the canonical "acme-db" id.
const CONNECTOR_ID = "acme-db";
// render's env-ref → literal resolution.
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const SERVER_CWD = "/srv/acme";
// content-surfaces slice id.
const SURFACES_CONNECTOR_ID = "acme-surfaces";

// host-native usage-hook slice: the native event-bucket key the AfterModel usage
// hook lands under (the Gemini-family adapter uses the "AfterModel" key).
const USAGE_EVENT_KEY = "AfterModel";

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

/** nativeHooks: a normalized PreToolUse hook + two gemini-native lifecycle hooks. */
function nativeConnector(): ResolvedConnector {
  return defineConnector({
    id: NATIVE_CONNECTOR_ID,
    displayName: "Acme Gemini",
    version: "1.0.0",
    hooks: { PreToolUse: { matcher: "acme_query", handler: () => ({ decision: "allow" }) } },
    platforms: {
      "gemini-cli": {
        nativeHooks: {
          BeforeModel: { handler: () => ({}) },
          BeforeToolSelection: { matcher: "Shell", handler: () => ({}) },
        },
      },
    },
  });
}

/** render: a stdio server (env-ref + cwd) + PreToolUse and SessionStart hooks. */
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
 * host-native usage: a connector that declares NO normalized hook events.
 * host-native capture is a host-native-only sink (no handler), so the usage hook
 * may be installed for such a connector when opted in — and must NOT be installed
 * when opted out.
 */
function noHooksConnector(hostNativeUsage: boolean): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.0.0",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@acme/db-mcp"],
      tools: { include: ["*"] },
    },
    telemetry: { hostNativeUsage },
  });
}

/**
 * host-native usage: a connector that ALSO declares a normalized PreToolUse hook —
 * used to prove the usage hook is added alongside (and removed without touching) a
 * real hook.
 */
function withPreToolUse(hostNativeUsage: boolean): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme DB Tools",
    version: "1.0.0",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@acme/db-mcp"],
      tools: { include: ["*"] },
    },
    hooks: {
      PreToolUse: { matcher: "acme_query", handler: () => ({ decision: "allow" }) },
    },
    telemetry: { hostNativeUsage },
  });
}

/** E1: PreToolUse (universally wired) + ALL FOUR E1 extension events. */
function buildE1Connector(): ResolvedConnector {
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

/** content surfaces: a connector declaring a command + skill (resource) + subagent. */
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

function settingsFile(projectDir: string): string {
  return join(projectDir, ".gemini", "settings.json");
}

/** All hook command strings under the given native event bucket. */
function commandsUnder(cfg: any, key: string): string[] {
  const bucket = cfg?.hooks?.[key];
  if (!Array.isArray(bucket)) return [];
  return bucket.flatMap((e: any) => (e.hooks ?? []).map((h: any) => h.command));
}

/**
 * The serve-wrapper args bake the install TARGET platform as `--host <id>` (before
 * the `--` separator) so the proxy stamps hostPlatform correctly under a headless
 * spawn.
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
// extraKeys: the host-native slice toggles AGENT_CONNECTOR_HOST_NATIVE; the render
// slice mutates ACME_DB_DSN (the env-ref → literal value). HOME/USERPROFILE/
// AGENT_CONNECTOR_DATA_DIR are covered by isolateEnv's defaults.
isolateEnv(["AGENT_CONNECTOR_HOST_NATIVE", ENV_VAR]);
createAdapterSuite({ adapter: geminiAdapter, paradigm: "json-stdio" });

// ── render + round-trip (mcpServers object map + hooks in one settings.json) ──

describe("gemini-cli adapter render/round-trip", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-p2-render-");
    // Set the env-ref var so literal-resolution produces a known value.
    process.env[ENV_VAR] = ENV_LITERAL;
    ctx = buildCtx(projectDir, buildRenderConnector());
  });

  it("installServer writes mcpServers.<id> with command/args (stdio by key, no `type`), env as LITERAL", () => {
    const changes = geminiAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const serverPath = settingsFile(projectDir);
    expect(serverPath).toBe(geminiAdapter.getServerConfigPath(ctx));
    expect(existsSync(serverPath)).toBe(true);

    const cfg = readJson(serverPath);
    expect(cfg).toHaveProperty("mcpServers");
    const entry = cfg.mcpServers[CONNECTOR_ID];
    expect(entry).toBeTruthy();

    // Gemini selects transport BY KEY (command/args), not a `type` field.
    expect(entry).not.toHaveProperty("type");
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toEqual(wrappedArgs("gemini-cli"));

    // No native ${env:VAR} support → env-ref resolves to a LITERAL value.
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(entry.env[ENV_VAR]).not.toContain("${");
  });

  it("installHooks writes the top-level `hooks` key in the SAME settings.json using Gemini event names", () => {
    const changes = geminiAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);

    const settingsPath = settingsFile(projectDir);
    expect(settingsPath).toBe(geminiAdapter.getHookConfigPath(ctx));

    const cfg = readJson(settingsPath);

    // PreToolUse → BeforeTool (Gemini's distinct event vocabulary).
    const before = cfg.hooks.BeforeTool;
    expect(Array.isArray(before)).toBe(true);
    expect(before[0].matcher).toBe("acme_query|acme_write");
    const cmd = before[0].hooks[0].command;
    expect(cmd).toContain(HOME_BIN);
    expect(cmd).toContain("hook gemini-cli PreToolUse");
    expect(cmd).toContain(`--connector ${CONNECTOR_ID}`);

    // SessionStart maps 1:1 to Gemini's SessionStart.
    expect(cfg.hooks.SessionStart[0].hooks[0].command).toContain(
      "hook gemini-cli SessionStart",
    );
    // The Claude-style PreToolUse key must NOT appear (renamed to BeforeTool).
    expect(cfg.hooks.PreToolUse).toBeUndefined();
  });

  it("installServer is idempotent — second call yields skip and does not duplicate", () => {
    geminiAdapter.installServer(ctx);
    const second = geminiAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");

    const cfg = readJson(settingsFile(projectDir));
    expect(Object.keys(cfg.mcpServers)).toEqual([CONNECTOR_ID]);
  });

  it("installHooks is idempotent — second call yields skip and does not duplicate entries", () => {
    geminiAdapter.installHooks(ctx);
    const second = geminiAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    const cfg = readJson(settingsFile(projectDir));
    expect(cfg.hooks.BeforeTool).toHaveLength(1);
    expect(cfg.hooks.SessionStart).toHaveLength(1);
  });

  it("server + hooks coexist in the SAME settings.json; uninstall removes both (re-read confirms gone)", () => {
    geminiAdapter.installServer(ctx);
    geminiAdapter.installHooks(ctx);

    // Both sections live in one file.
    const both = readJson(settingsFile(projectDir));
    expect(both.mcpServers?.[CONNECTOR_ID]).toBeTruthy();
    expect(both.hooks?.BeforeTool).toBeTruthy();

    geminiAdapter.uninstallServer(ctx);
    const afterServer = readJson(settingsFile(projectDir));
    expect(afterServer.mcpServers?.[CONNECTOR_ID]).toBeUndefined();
    // Removing the server must not disturb the hooks section.
    expect(afterServer.hooks?.BeforeTool).toBeTruthy();

    geminiAdapter.uninstallHooks(ctx);
    const afterHooks = readJson(settingsFile(projectDir));
    expect(JSON.stringify(afterHooks.hooks ?? {})).not.toContain(HOME_BIN);
  });
});

// ── nativeHooks passthrough (verbatim event-name keys) ───────────────────────

describe("gemini-cli adapter — nativeHooks passthrough", () => {
  it("declares supportsNativeHooks true", () => {
    expect(geminiAdapter.capabilities.supportsNativeHooks).toBe(true);
  });

  it("installHooks writes native event-name keys VERBATIM beside the normalized (mapped) hook", () => {
    const projectDir = freshProject("ac-gem-native-");
    geminiAdapter.installHooks(buildCtx(projectDir, nativeConnector()));
    const cfg = readJson(settingsFile(projectDir));

    // Normalized PreToolUse is mapped to Gemini's native BeforeTool key.
    expect(cfg.hooks.BeforeTool[0].hooks[0].command).toContain("hook gemini-cli PreToolUse");
    // Native keys are written VERBATIM (NOT routed through EVENT_MAP).
    expect(cfg.hooks.BeforeModel[0].hooks[0].command).toContain("hook gemini-cli BeforeModel");
    expect(cfg.hooks.BeforeToolSelection[0].matcher).toBe("Shell");
    expect(cfg.hooks.BeforeToolSelection[0].hooks[0].command).toContain(
      "hook gemini-cli BeforeToolSelection",
    );
  });

  it("is idempotent (second install → skip) and uninstall removes the native entries", () => {
    const projectDir = freshProject("ac-gem-native-");
    const ctx = buildCtx(projectDir, nativeConnector());
    geminiAdapter.installHooks(ctx);
    const second = geminiAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    geminiAdapter.uninstallHooks(ctx);
    const after = readJson(settingsFile(projectDir));
    expect(JSON.stringify(after.hooks ?? {})).not.toContain(HOME_BIN);
  });

  it("nativeHooks install even when normalized hooks are disabled (hooks: false sibling)", () => {
    const projectDir = freshProject("ac-gem-native-");
    const connector = defineConnector({
      id: NATIVE_CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: {
        "gemini-cli": { hooks: false, nativeHooks: { BeforeModel: { handler: () => ({}) } } },
      },
    });
    geminiAdapter.installHooks(buildCtx(projectDir, connector));
    const cfg = readJson(settingsFile(projectDir));
    // Native installed; the normalized PreToolUse (→ BeforeTool) is NOT.
    expect(cfg.hooks.BeforeModel[0].hooks[0].command).toContain("hook gemini-cli BeforeModel");
    expect(cfg.hooks.BeforeTool).toBeUndefined();
  });

  it("hooks: false suppresses the host-native usage hook even with telemetry opt-in (parity)", () => {
    // Regression guard: pre-change, `hooks: false` returned early before the usage
    // sink was ever computed. The refactor preserves that — `hostNative` is gated on
    // `!hooksDisabled`, so a hooks:false connector never installs the AfterModel sink,
    // even with telemetry opt-in. nativeHooks (the sibling) still install.
    const projectDir = freshProject("ac-gem-native-");
    const connector = defineConnector({
      id: NATIVE_CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      telemetry: { hostNativeUsage: true },
      platforms: {
        "gemini-cli": { hooks: false, nativeHooks: { BeforeModel: { handler: () => ({}) } } },
      },
    });
    geminiAdapter.installHooks(buildCtx(projectDir, connector));
    const cfg = readJson(settingsFile(projectDir));
    expect(cfg.hooks.BeforeModel).toBeDefined(); // sibling native still installs
    expect(cfg.hooks.AfterModel).toBeUndefined(); // usage sink suppressed by hooks:false
  });

  it("a native key coinciding with a normalized event's mapped key does NOT clobber it", () => {
    // Normalized PreToolUse maps to "BeforeTool"; also declare a native "BeforeTool".
    const projectDir = freshProject("ac-gem-native-");
    const connector = defineConnector({
      id: NATIVE_CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: { "gemini-cli": { nativeHooks: { BeforeTool: { handler: () => ({}) } } } },
    });
    geminiAdapter.installHooks(buildCtx(projectDir, connector));
    const commands = commandsUnder(readJson(settingsFile(projectDir)), "BeforeTool");
    // BOTH commands coexist (distinct event tokens) — neither was clobbered.
    expect(commands.some((c) => c.includes("hook gemini-cli PreToolUse"))).toBe(true);
    expect(commands.some((c) => c.includes("hook gemini-cli BeforeTool"))).toBe(true);
  });
});

// ── host-native opt-in usage hook (AfterModel `usage-event`) ──────────────────

describe("gemini-cli host-native usage hook (opt-in only)", () => {
  let project: string;

  beforeEach(() => {
    // The opt-in env switch is restored by isolateEnv; start each test with it OFF.
    delete process.env.AGENT_CONNECTOR_HOST_NATIVE;
    project = freshProject("ac-hn-gemini-cli-");
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("does NOT install the AfterModel usage hook when the opt-in is OFF", () => {
    const ctx = buildCtx(project, noHooksConnector(false));
    const changes = geminiAdapter.installHooks(ctx);

    // A no-hooks connector with the opt-in off has nothing to install → skip.
    expect(changes.every((c) => c.action === "skip")).toBe(true);
    const hooksPath = geminiAdapter.getHookConfigPath(ctx);
    // No usage-event command anywhere (file may not even exist).
    if (existsSync(hooksPath)) {
      const file = readJson(hooksPath);
      expect(commandsUnder(file, USAGE_EVENT_KEY)).toHaveLength(0);
    }
  });

  it("installs the AfterModel usage-event hook when telemetry.hostNativeUsage is ON", () => {
    const ctx = buildCtx(project, noHooksConnector(true));
    const changes = geminiAdapter.installHooks(ctx);

    const created = changes.find(
      (c) => c.action === "create" && c.detail.includes("host-native usage"),
    );
    expect(created).toBeTruthy();

    const file = readJson(geminiAdapter.getHookConfigPath(ctx));
    const cmds = commandsUnder(file, USAGE_EVENT_KEY);
    expect(cmds).toHaveLength(1);
    // Routes to the hidden `usage-event` entrypoint (NOT the `hook` dispatcher).
    expect(cmds[0]).toContain(" usage-event ");
    expect(cmds[0]).toContain(HOME_BIN);
    expect(cmds[0]).toContain(`--connector ${CONNECTOR_ID}`);
    expect(cmds[0]).not.toContain(" hook ");
    // The usage hook is not a tool event → empty matcher.
    const entry = file.hooks[USAGE_EVENT_KEY].find((e: any) =>
      (e.hooks ?? []).some((h: any) => h.command.includes(" usage-event ")),
    );
    expect(entry.matcher).toBe("");
  });

  it("installs the usage hook when AGENT_CONNECTOR_HOST_NATIVE=1 forces it on at install", () => {
    process.env.AGENT_CONNECTOR_HOST_NATIVE = "1";
    const ctx = buildCtx(project, noHooksConnector(false)); // config opt-in OFF
    geminiAdapter.installHooks(ctx);

    const file = readJson(geminiAdapter.getHookConfigPath(ctx));
    expect(commandsUnder(file, USAGE_EVENT_KEY)).toHaveLength(1);
  });

  it("is idempotent: a second install skips the already-registered usage hook", () => {
    const ctx = buildCtx(project, noHooksConnector(true));
    geminiAdapter.installHooks(ctx);
    const second = geminiAdapter.installHooks(ctx);
    const usageChange = second.find((c) => c.detail.includes("host-native usage"));
    expect(usageChange?.action).toBe("skip");
    // Still exactly one usage-event command (no duplicate appended).
    const file = readJson(geminiAdapter.getHookConfigPath(ctx));
    expect(commandsUnder(file, USAGE_EVENT_KEY)).toHaveLength(1);
  });

  it("uninstall removes the AfterModel usage hook (and leaves the bucket clean)", () => {
    const ctx = buildCtx(project, noHooksConnector(true));
    geminiAdapter.installHooks(ctx);
    expect(commandsUnder(readJson(geminiAdapter.getHookConfigPath(ctx)), USAGE_EVENT_KEY))
      .toHaveLength(1);

    geminiAdapter.uninstallHooks(ctx);
    const after = existsSync(geminiAdapter.getHookConfigPath(ctx))
      ? readJson(geminiAdapter.getHookConfigPath(ctx))
      : { hooks: {} };
    expect(commandsUnder(after, USAGE_EVENT_KEY)).toHaveLength(0);
    // Our anchored cleanup empties the bucket entirely (no orphan entry left).
    expect(after.hooks?.[USAGE_EVENT_KEY]).toBeUndefined();
  });

  it("uninstall PRESERVES a foreign hook command in the same AfterModel bucket", () => {
    const ctx = buildCtx(project, noHooksConnector(true));
    geminiAdapter.installHooks(ctx);

    // Inject a foreign hook command into the SAME bucket.
    const hooksPath = geminiAdapter.getHookConfigPath(ctx);
    const file = readJson(hooksPath);
    file.hooks[USAGE_EVENT_KEY].push({
      matcher: "",
      hooks: [{ type: "command", command: "/usr/local/bin/someone-elses-tool" }],
    });
    writeFileSync(hooksPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");

    geminiAdapter.uninstallHooks(ctx);
    const after = readJson(hooksPath);
    const cmds = commandsUnder(after, USAGE_EVENT_KEY);
    // Ours is gone; the foreign one survives.
    expect(cmds).toContain("/usr/local/bin/someone-elses-tool");
    expect(cmds.some((c) => c.includes(" usage-event "))).toBe(false);
  });

  it("uninstall removes the usage hook WITHOUT touching a sibling normalized hook", () => {
    const ctx = buildCtx(project, withPreToolUse(true));
    geminiAdapter.installHooks(ctx);

    const hooksPath = geminiAdapter.getHookConfigPath(ctx);
    // Both present after install: the usage hook AND the PreToolUse dispatcher.
    let file = readJson(hooksPath);
    expect(commandsUnder(file, USAGE_EVENT_KEY)).toHaveLength(1);

    // Locate the PreToolUse bucket key (gemini maps PreToolUse → "BeforeTool").
    const preKey = Object.keys(file.hooks).find((k) =>
      commandsUnder(file, k).some((c) => c.includes(" hook ")),
    );
    expect(preKey).toBeTruthy();

    geminiAdapter.uninstallHooks(ctx);
    file = existsSync(hooksPath) ? readJson(hooksPath) : { hooks: {} };
    // Both of OUR hooks are gone after a full uninstall (anchored on our id).
    expect(commandsUnder(file, USAGE_EVENT_KEY)).toHaveLength(0);
    expect(commandsUnder(file, preKey!)).toHaveLength(0);
  });
});

// ── E1 extension-event degradation (no Gemini analog → warn-skip) ─────────────

describe("gemini-cli E1 capability flags stay unset (no native analog)", () => {
  it("leaves permissionRequest/postToolUseFailure/subagentStart/subagentStop falsy", () => {
    expect(geminiAdapter.capabilities.permissionRequest ?? false).toBe(false);
    expect(geminiAdapter.capabilities.postToolUseFailure ?? false).toBe(false);
    expect(geminiAdapter.capabilities.subagentStart ?? false).toBe(false);
    expect(geminiAdapter.capabilities.subagentStop ?? false).toBe(false);
  });
});

// ── PostToolUse stdin parse: gemini-cli emits `tool_response`, not `tool_output` ──
// Source: google-gemini/gemini-cli fireAfterToolEvent serializes the result under
// `tool_response` (object { llmContent, returnDisplay, error? }) — there is no
// `tool_output` and no `is_error` on the wire (hookEventHandler.ts:107-111,
// types.ts:518-521, tools.ts:742-768, docs/hooks/reference.md:114-123). Reading the
// non-existent fields silently dropped all real tool output (the kimi #189 bug class).

describe("gemini-cli PostToolUse parseEvent reads tool_response (not tool_output)", () => {
  it("lifts tool_response.llmContent into toolOutput", () => {
    const ev = geminiAdapter.parseEvent("PostToolUse", {
      tool_name: "Read",
      tool_input: { path: "a.ts" },
      tool_response: { llmContent: "out", returnDisplay: "shown" },
    }) as PostToolUseEvent;
    expect(ev.toolOutput).toBe("out");
    expect(ev.isError ?? false).toBe(false);
  });

  it("falls back to tool_response.returnDisplay when llmContent is absent", () => {
    const ev = geminiAdapter.parseEvent("PostToolUse", {
      tool_name: "Read",
      tool_response: { returnDisplay: "shown" },
    }) as PostToolUseEvent;
    expect(ev.toolOutput).toBe("shown");
  });

  it("JSON-stringifies a non-string llmContent (PartListUnion can be an object/array)", () => {
    const ev = geminiAdapter.parseEvent("PostToolUse", {
      tool_name: "Glob",
      tool_response: { llmContent: [{ text: "x" }] },
    }) as PostToolUseEvent;
    expect(ev.toolOutput).toBe(JSON.stringify([{ text: "x" }]));
  });

  it("derives isError from tool_response.error (no top-level is_error)", () => {
    const ev = geminiAdapter.parseEvent("PostToolUse", {
      tool_name: "Read",
      tool_response: { llmContent: "boom", error: { message: "FILE_NOT_FOUND" } },
    }) as PostToolUseEvent;
    expect(ev.isError).toBe(true);
    expect(ev.toolOutput).toBe("boom");
  });

  it("leaves toolOutput unset when tool_response carries no usable content", () => {
    const ev = geminiAdapter.parseEvent("PostToolUse", {
      tool_name: "Read",
      tool_response: {},
    }) as PostToolUseEvent;
    expect(ev.toolOutput).toBeUndefined();
    expect(ev.isError ?? false).toBe(false);
  });
});

describe("gemini-cli E1 degradation", () => {
  it("installHooks warn-skips all four; settings.json wires BeforeTool only", () => {
    const projectDir = freshProject("ac-e1-gemini-");
    const ctx = buildCtx(projectDir, buildE1Connector());

    const changes = geminiAdapter.installHooks!(ctx);
    expectE1WarnSkips(changes, "gemini-cli", "Gemini CLI");

    const settingsPath = geminiAdapter.getHookConfigPath!(ctx);
    const cfg = readJson(settingsPath);
    expect(Object.keys(cfg.hooks)).toEqual(["BeforeTool"]);
    const text = readFileSync(settingsPath, "utf8");
    for (const token of FORBIDDEN_NATIVE_TOKENS) {
      expect(text).not.toContain(token);
    }
  });
});

// ── content surfaces: TOML commands / SKILL.md skills / md+fm subagents ───────

describe("gemini-cli adapter — content surfaces", () => {
  let projectDir: string;
  let ctx: InstallContext;

  beforeEach(() => {
    projectDir = freshProject("ac-surfaces-s1-");
    ctx = buildCtx(projectDir, buildSurfacesConnector());
  });

  it("declares support for all three content surfaces", () => {
    expect(geminiAdapter.capabilities.supportsCommands).toBe(true);
    expect(geminiAdapter.capabilities.supportsSkills).toBe(true);
    expect(geminiAdapter.capabilities.supportsSubagents).toBe(true);
  });

  it("installCommands writes a TOML command (description + prompt, args preserved)", () => {
    const changes = geminiAdapter.installCommands!(ctx);
    expect(changes[0]?.action).toBe("create");

    const cmdPath = join(projectDir, ".gemini", "commands", "deploy.toml");
    expect(changes[0]?.path).toBe(cmdPath);
    expect(existsSync(cmdPath)).toBe(true);

    const toml = parseToml(readFileSync(cmdPath, "utf8")) as Record<string, unknown>;
    expect(toml.description).toBe("Deploy the app to an environment.");
    expect(toml.prompt).toBe(COMMAND.prompt);
  });

  it("installSkills writes uniform SKILL.md + resource with correct frontmatter", () => {
    geminiAdapter.installSkills!(ctx);
    const skillMd = join(projectDir, ".gemini", "skills", "pdf-tools", "SKILL.md");
    const resource = join(projectDir, ".gemini", "skills", "pdf-tools", "scripts", "extract.sh");
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

  it("installSubagents writes md+fm agents/<name>.md (name, description, tools, model)", () => {
    geminiAdapter.installSubagents!(ctx);
    const agentPath = join(projectDir, ".gemini", "agents", "reviewer.md");
    expect(existsSync(agentPath)).toBe(true);

    const { frontmatter, body } = splitFrontmatter(readFileSync(agentPath, "utf8"));
    expect(frontmatter.name).toBe("reviewer");
    expect(frontmatter.description).toBe(SUBAGENT.description);
    expect(frontmatter.tools).toBe("Read, Grep");
    expect(frontmatter.model).toBe("opus");
    expect(body.trim()).toBe(SUBAGENT.prompt);
  });

  it("is idempotent — second install yields skip across all surfaces", () => {
    geminiAdapter.installCommands!(ctx);
    geminiAdapter.installSkills!(ctx);
    geminiAdapter.installSubagents!(ctx);
    expect(geminiAdapter.installCommands!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(geminiAdapter.installSkills!(ctx).every((c) => c.action === "skip")).toBe(true);
    expect(geminiAdapter.installSubagents!(ctx).every((c) => c.action === "skip")).toBe(true);
  });

  it("uninstall removes all written files", () => {
    geminiAdapter.installCommands!(ctx);
    geminiAdapter.installSkills!(ctx);
    geminiAdapter.installSubagents!(ctx);

    geminiAdapter.uninstallCommands!(ctx);
    geminiAdapter.uninstallSkills!(ctx);
    geminiAdapter.uninstallSubagents!(ctx);

    expect(existsSync(join(projectDir, ".gemini", "commands", "deploy.toml"))).toBe(false);
    expect(existsSync(join(projectDir, ".gemini", "skills", "pdf-tools", "SKILL.md"))).toBe(false);
    expect(existsSync(join(projectDir, ".gemini", "skills", "pdf-tools"))).toBe(false);
    expect(existsSync(join(projectDir, ".gemini", "agents", "reviewer.md"))).toBe(false);
  });

  it("honors platforms['gemini-cli'].commands === false", () => {
    const disabled = defineConnector({
      id: SURFACES_CONNECTOR_ID,
      commands: [{ name: "deploy", prompt: "do it" }],
      platforms: { "gemini-cli": { commands: false } },
    });
    const c2 = buildCtx(projectDir, disabled);
    expect(geminiAdapter.installCommands!(c2)[0]?.action).toBe("skip");
    expect(existsSync(join(projectDir, ".gemini", "commands", "deploy.toml"))).toBe(false);
  });
});
