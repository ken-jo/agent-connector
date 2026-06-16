/**
 * adapters/continue-hooks.test.ts — Continue's Claude-Code-COMPATIBLE hooks
 * layer (continuedev/continue PR #11029, extensions/cli/src/hooks/*).
 *
 * Continue is now a json-stdio host: its `cn` CLI ships a hooks system whose
 * settings.json shape and HookOutput contract are BYTE-IDENTICAL to Claude Code.
 * These tests pin:
 *   - the flipped capability flags (the events continue actually fires);
 *   - installHooks writing the home-bin command + matcher into the SEPARATE
 *     settings.json `hooks.<Event>` (NOT the YAML config.yaml that holds MCP);
 *   - warn-skip for the events continue lacks (PreCompact);
 *   - parseEvent for a couple of events;
 *   - formatReply mapping each decision to Continue's (== Claude's) exact shape;
 *   - idempotency + uninstall;
 *   - a REGRESSION proof that the MCP install path (config.yaml mcpServers YAML
 *     ARRAY) is completely untouched by the hooks work.
 *
 * All tests are HOME-isolated (mkdtemp + redirected HOME/USERPROFILE/etc.) and
 * deterministic.
 */

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ConnectorConfig, ResolvedConnector } from "../../src/core/types.js";

import continueAdapter from "../../src/adapters/continue/index.js";

const CONNECTOR_ID = "acme-continue";
const HOME_BIN = "/fake/bin/agent-connector";

const SERVER = {
  transport: "stdio",
  command: "acme-mcp",
  args: ["--port", "0"],
  wrapForTelemetry: false,
} as const;

/** A connector wiring every event Continue supports + a matcher on PreToolUse. */
function buildConnector(cfg: Partial<ConnectorConfig> = {}): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Continue",
    version: "1.0.0",
    server: { ...SERVER, args: [...SERVER.args] },
    hooks: {
      PreToolUse: { matcher: "Bash", handler: () => ({ decision: "allow" }) },
      PostToolUse: { handler: () => ({ decision: "allow" }) },
      Stop: { handler: () => ({ decision: "allow" }) },
      UserPromptSubmit: { handler: () => ({ decision: "allow" }) },
      PermissionRequest: { handler: () => ({ decision: "allow" }) },
    },
    ...cfg,
  });
}

function buildCtx(
  projectDir: string,
  connector: ResolvedConnector,
  scope: "project" | "user" = "user",
): InstallContext {
  return {
    connector,
    scope,
    projectDir,
    homeBinPath: HOME_BIN,
    dataRoot: projectDir,
    dryRun: false,
  };
}

interface ContinueHookEntry {
  matcher: string;
  hooks: Array<{ type: string; command: string }>;
}

/** Read settings.json and return its `hooks` map. */
function readHooks(path: string): Record<string, ContinueHookEntry[]> {
  const file = JSON.parse(readFileSync(path, "utf8")) as {
    hooks?: Record<string, ContinueHookEntry[]>;
  };
  return file.hooks ?? {};
}

let saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "XDG_CONFIG_HOME",
  "AGENT_CONNECTOR_DATA_DIR",
  "CONTINUE_GLOBAL_DIR",
] as const;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function freshProject(): { home: string; projectDir: string } {
  const home = mkdtempSync(join(tmpdir(), "ac-continue-hooks-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.AGENT_CONNECTOR_DATA_DIR = join(home, ".agent-connector");
  delete process.env.CONTINUE_GLOBAL_DIR;
  const projectDir = join(home, "project");
  mkdirSync(projectDir, { recursive: true });
  return { home, projectDir };
}

// ── capability flags ─────────────────────────────────────────────────────────

describe("continue hooks — capability flags", () => {
  it("declares every event Continue fires and none it does not", () => {
    const c = continueAdapter.capabilities;
    expect(continueAdapter.paradigm).toBe("json-stdio");
    // Supported (continue's HOOK_EVENT_NAMES ∩ canonical).
    expect(c.preToolUse).toBe(true);
    expect(c.postToolUse).toBe(true);
    expect(c.postToolUseFailure).toBe(true);
    expect(c.userPromptSubmit).toBe(true);
    expect(c.sessionStart).toBe(true);
    expect(c.sessionEnd).toBe(true);
    expect(c.stop).toBe(true);
    expect(c.notification).toBe(true);
    expect(c.subagentStart).toBe(true);
    expect(c.subagentStop).toBe(true);
    expect(c.permissionRequest).toBe(true);
    // PreCompact IS in continue's HOOK_EVENT_NAMES (PreCompactInput).
    expect(c.preCompact).toBe(true);
    // NOT supported — only PostCompact is absent from continue's set.
    expect(c.postCompact ?? false).toBe(false);
    // Native passthrough surface (the 5 host-specific events).
    expect(c.supportsNativeHooks).toBe(true);
    // Capability triad.
    expect(c.canModifyArgs).toBe(true);
    expect(c.canModifyOutput).toBe(false);
    expect(c.canInjectSessionContext).toBe(true);
  });
});

// ── path resolution (settings.json honoring CONTINUE_GLOBAL_DIR) ──────────────

describe("continue hooks — config path", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
  });

  it("user scope → ~/.continue/settings.json (separate from config.yaml)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    expect(continueAdapter.getHookConfigPath(ctx)).toBe(
      join(home, ".continue", "settings.json"),
    );
  });

  it("project scope → <projectDir>/.continue/settings.json", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    expect(continueAdapter.getHookConfigPath(ctx)).toBe(
      join(projectDir, ".continue", "settings.json"),
    );
  });

  it("user scope honors CONTINUE_GLOBAL_DIR for the hook file (not the MCP file)", () => {
    const customDir = join(home, "custom-continue");
    process.env.CONTINUE_GLOBAL_DIR = customDir;
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    expect(continueAdapter.getHookConfigPath(ctx)).toBe(
      join(customDir, "settings.json"),
    );
    // The MCP server path is INTENTIONALLY independent of CONTINUE_GLOBAL_DIR.
    expect(continueAdapter.getServerConfigPath(ctx)).toBe(
      join(home, ".continue", "config.yaml"),
    );
  });
});

// ── installHooks writes the home-bin command + matcher ───────────────────────

describe("continue hooks — install", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
  });

  function settingsPath(): string {
    return join(home, ".continue", "settings.json");
  }

  it("writes hooks.<Event> with the home-bin command and PascalCase keys", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = continueAdapter.installHooks(ctx);
    expect(changes.every((c) => c.platform === "continue")).toBe(true);
    expect(changes.some((c) => c.action === "create")).toBe(true);
    expect(existsSync(settingsPath())).toBe(true);

    const hooks = readHooks(settingsPath());
    expect(Object.keys(hooks).sort()).toEqual(
      ["PermissionRequest", "PostToolUse", "PreToolUse", "Stop", "UserPromptSubmit"].sort(),
    );

    const entry = hooks.PreToolUse![0]!;
    // Matcher carried through from the hook definition.
    expect(entry.matcher).toBe("Bash");
    expect(entry.hooks[0]!.type).toBe("command");
    // Claude-shaped home-bin command anchored at the host + event + connector id.
    expect(entry.hooks[0]!.command).toContain(HOME_BIN);
    expect(entry.hooks[0]!.command).toContain("continue");
    expect(entry.hooks[0]!.command).toContain("PreToolUse");
    expect(entry.hooks[0]!.command).toContain(CONNECTOR_ID);

    // Events with no matcher write an empty-string matcher.
    expect(hooks.Stop![0]!.matcher).toBe("");
  });

  it("installs PreCompact (now in continue's HOOK_EVENT_NAMES)", () => {
    const connector = buildConnector({
      hooks: {
        PreToolUse: { handler: () => ({ decision: "allow" }) },
        PreCompact: { handler: () => ({ decision: "allow" }) },
      },
    });
    const ctx = buildCtx(projectDir, connector, "user");
    continueAdapter.installHooks(ctx);
    const hooks = readHooks(settingsPath());
    expect(hooks.PreCompact).toBeDefined();
    const cmd = hooks.PreCompact![0]!.hooks[0]!.command;
    expect(cmd).toContain(HOME_BIN);
    expect(cmd).toContain("continue");
    expect(cmd).toContain("PreCompact");
    expect(cmd).toContain(CONNECTOR_ID);
  });

  it("warn-skips an event Continue has no equivalent for (PostCompact)", () => {
    const connector = buildConnector({
      hooks: {
        PreToolUse: { handler: () => ({ decision: "allow" }) },
        PostCompact: { handler: () => ({ decision: "allow" }) },
      },
    });
    const ctx = buildCtx(projectDir, connector, "user");
    const changes = continueAdapter.installHooks(ctx);
    const warn = changes.find((c) => c.action === "warn");
    expect(warn?.detail).toContain("PostCompact");
    expect(warn?.detail).toContain("no Continue hook equivalent");
    // PostCompact must NOT land in the file.
    expect(Object.keys(readHooks(settingsPath()))).not.toContain("PostCompact");
  });

  it("is idempotent: a second install reports skip and writes no duplicate", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    continueAdapter.installHooks(ctx);
    const second = continueAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);
    expect(readHooks(settingsPath()).PreToolUse).toHaveLength(1);
  });

  it("preserves a user's pre-existing hook on the same event", () => {
    mkdirSync(join(home, ".continue"), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "user-tool" }] }],
        },
      }),
    );
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    continueAdapter.installHooks(ctx);

    const bucket = readHooks(settingsPath()).PreToolUse!;
    expect(bucket).toHaveLength(2);
    expect(bucket.some((e) => e.hooks[0]!.command === "user-tool")).toBe(true);
    expect(bucket.some((e) => e.hooks[0]!.command.includes(HOME_BIN))).toBe(true);
  });

  it("honors platforms['continue'].hooks === false", () => {
    const connector = buildConnector({ platforms: { continue: { hooks: false } } });
    const ctx = buildCtx(projectDir, connector, "user");
    const changes = continueAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("hooks disabled for continue");
    expect(existsSync(settingsPath())).toBe(false);
  });

  it("uninstall strips ONLY our command and leaves the user's hook in place", () => {
    mkdirSync(join(home, ".continue"), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "user-tool" }] }],
        },
      }),
    );
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    continueAdapter.installHooks(ctx);
    const removed = continueAdapter.uninstallHooks(ctx);
    expect(removed.some((c) => c.action === "remove")).toBe(true);

    const hooks = readHooks(settingsPath());
    const bucket = hooks.PreToolUse!;
    expect(bucket).toHaveLength(1);
    expect(bucket[0]!.hooks[0]!.command).toBe("user-tool");
    // Events that held ONLY our command are dropped entirely.
    expect(hooks.Stop).toBeUndefined();
  });
});

// ── parseEvent ───────────────────────────────────────────────────────────────

describe("continue hooks — parseEvent", () => {
  it("PreToolUse normalizes tool_name + tool_input (+ connector id, cwd)", () => {
    const ev = continueAdapter.parseEvent!("PreToolUse", {
      connector: CONNECTOR_ID,
      cwd: "/work/proj",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    expect(ev.hostPlatform).toBe("continue");
    expect(ev.connectorId).toBe(CONNECTOR_ID);
    expect(ev.projectDir).toBe("/work/proj");
    expect((ev as { toolName: string }).toolName).toBe("Bash");
    expect((ev as { toolInput: unknown }).toolInput).toEqual({ command: "ls" });
  });

  it("UserPromptSubmit normalizes the prompt", () => {
    const ev = continueAdapter.parseEvent!("UserPromptSubmit", {
      connector: CONNECTOR_ID,
      prompt: "hello there",
    });
    expect((ev as { prompt: string }).prompt).toBe("hello there");
  });

  it("PreCompact normalizes the trigger (auto|manual)", () => {
    const ev = continueAdapter.parseEvent!("PreCompact", {
      connector: CONNECTOR_ID,
      cwd: "/work/proj",
      trigger: "auto",
    });
    expect(ev.hostPlatform).toBe("continue");
    expect((ev as { trigger?: string }).trigger).toBe("auto");
  });

  it("throws on an event Continue never delivers (PostCompact)", () => {
    expect(() => continueAdapter.parseEvent!("PostCompact", {})).toThrow(
      /unsupported continue hook event/,
    );
  });
});

// ── formatReply (Claude-identical shapes) ────────────────────────────────────

describe("continue hooks — formatReply", () => {
  it("PreToolUse deny → hookSpecificOutput.permissionDecision:'deny'", () => {
    const reply = continueAdapter.formatReply!("PreToolUse", {
      decision: "deny",
      reason: "blocked cmd",
    });
    expect(reply.exitCode).toBe(0);
    const out = JSON.parse(reply.stdout!);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("blocked cmd");
  });

  it("PreToolUse modify → hookSpecificOutput.updatedInput (canModifyArgs)", () => {
    const reply = continueAdapter.formatReply!("PreToolUse", {
      decision: "modify",
      updatedInput: { command: "ls -la" },
    });
    const out = JSON.parse(reply.stdout!);
    expect(out.hookSpecificOutput.updatedInput).toEqual({ command: "ls -la" });
  });

  it("PostToolUse deny → TOP-LEVEL { decision:'block', reason }", () => {
    const reply = continueAdapter.formatReply!("PostToolUse", {
      decision: "deny",
      reason: "bad output",
    });
    const out = JSON.parse(reply.stdout!);
    expect(out.decision).toBe("block");
    expect(out.reason).toBe("bad output");
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it("Stop deny → TOP-LEVEL { decision:'block', reason }", () => {
    const reply = continueAdapter.formatReply!("Stop", {
      decision: "deny",
      reason: "keep going",
    });
    const out = JSON.parse(reply.stdout!);
    expect(out.decision).toBe("block");
    expect(out.reason).toBe("keep going");
  });

  it("UserPromptSubmit deny → TOP-LEVEL { decision:'block', reason }", () => {
    const reply = continueAdapter.formatReply!("UserPromptSubmit", {
      decision: "deny",
      reason: "rejected",
    });
    const out = JSON.parse(reply.stdout!);
    expect(out.decision).toBe("block");
    expect(out.reason).toBe("rejected");
  });

  it("PermissionRequest deny → nested decision{ behavior:'deny', message }", () => {
    const reply = continueAdapter.formatReply!("PermissionRequest", {
      decision: "deny",
      reason: "no",
    });
    const out = JSON.parse(reply.stdout!);
    expect(out.hookSpecificOutput.decision.behavior).toBe("deny");
    expect(out.hookSpecificOutput.decision.message).toBe("no");
  });

  it("PermissionRequest allow → nested decision{ behavior:'allow' } (active grant)", () => {
    const reply = continueAdapter.formatReply!("PermissionRequest", {
      decision: "allow",
    });
    const out = JSON.parse(reply.stdout!);
    expect(out.hookSpecificOutput.decision.behavior).toBe("allow");
  });

  it("context → hookSpecificOutput.additionalContext", () => {
    const reply = continueAdapter.formatReply!("SessionStart", {
      decision: "context",
      additionalContext: "remember X",
    });
    const out = JSON.parse(reply.stdout!);
    expect(out.hookSpecificOutput.additionalContext).toBe("remember X");
  });

  it("allow → exit 0 with no stdout payload", () => {
    const reply = continueAdapter.formatReply!("PreToolUse", { decision: "allow" });
    expect(reply.exitCode).toBe(0);
    expect(reply.stdout).toBeUndefined();
  });
});

// ── nativeHooks passthrough (the 5 host-specific events) ─────────────────────

describe("continue hooks — nativeHooks passthrough", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
  });

  function settingsPath(): string {
    return join(home, ".continue", "settings.json");
  }

  /** Normalized PreToolUse + a continue-native WorktreeCreate (no canonical analog). */
  function nativeConnector(): ResolvedConnector {
    return defineConnector({
      id: CONNECTOR_ID,
      displayName: "Acme Continue",
      version: "1.0.0",
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: {
        continue: {
          nativeHooks: {
            WorktreeCreate: { matcher: "main", handler: () => ({}) },
          },
        },
      },
    });
  }

  it("declares supportsNativeHooks true", () => {
    expect(continueAdapter.capabilities.supportsNativeHooks).toBe(true);
  });

  it("files the native WorktreeCreate key VERBATIM beside the canonical PreToolUse", () => {
    const ctx = buildCtx(projectDir, nativeConnector(), "user");
    continueAdapter.installHooks(ctx);
    const hooks = readHooks(settingsPath());

    expect(hooks.PreToolUse![0]!.hooks[0]!.command).toContain("hook continue PreToolUse");
    // Native key filed verbatim (no SUPPORTED_EVENTS gate) with the native token.
    const native = hooks.WorktreeCreate![0]!;
    expect(native.hooks[0]!.command).toContain("hook continue WorktreeCreate");
    expect(native.hooks[0]!.command).toContain(HOME_BIN);
    expect(native.hooks[0]!.command).toContain(`--connector ${CONNECTOR_ID}`);
    // The native matcher rides through verbatim.
    expect(native.matcher).toBe("main");
  });

  it("installs the native event even when normalized hooks are disabled (hooks:false sibling)", () => {
    const connector = defineConnector({
      id: CONNECTOR_ID,
      hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
      platforms: {
        continue: { hooks: false, nativeHooks: { WorktreeCreate: { handler: () => ({}) } } },
      },
    });
    const ctx = buildCtx(projectDir, connector, "user");
    continueAdapter.installHooks(ctx);
    const hooks = readHooks(settingsPath());
    expect(hooks.WorktreeCreate![0]!.hooks[0]!.command).toContain("hook continue WorktreeCreate");
    // Normalized events suppressed by hooks:false.
    expect(hooks.PreToolUse).toBeUndefined();
  });

  it("is idempotent (second install → skip) and uninstall strips the native key", () => {
    const ctx = buildCtx(projectDir, nativeConnector(), "user");
    continueAdapter.installHooks(ctx);
    const second = continueAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    continueAdapter.uninstallHooks(ctx);
    const hooks = readHooks(settingsPath());
    // The native key held ONLY our command → dropped entirely on uninstall.
    expect(hooks.WorktreeCreate).toBeUndefined();
    expect(JSON.stringify(hooks)).not.toContain(HOME_BIN);
  });
});

// ── regression: the MCP install path stays untouched ─────────────────────────

describe("continue hooks — MCP regression (config.yaml mcpServers untouched)", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshProject());
  });

  it("installServer still writes the mcpServers YAML ARRAY to config.yaml", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    // Installing hooks must NOT disturb the MCP file.
    continueAdapter.installHooks(ctx);
    const changes = continueAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const cfgPath = join(home, ".continue", "config.yaml");
    expect(changes[0]?.path).toBe(cfgPath);
    const cfg = parse(readFileSync(cfgPath, "utf8")) as {
      mcpServers?: Array<Record<string, unknown>>;
    };
    expect(Array.isArray(cfg.mcpServers)).toBe(true);
    expect(cfg.mcpServers).toHaveLength(1);
    const entry = cfg.mcpServers![0]!;
    expect(entry.name).toBe(CONNECTOR_ID);
    expect(entry.command).toBe("acme-mcp");
    // The MCP file must carry NO hooks key — hooks live in settings.json.
    expect("hooks" in cfg).toBe(false);

    // And the settings.json (hooks) must carry NO mcpServers key.
    const settings = JSON.parse(
      readFileSync(join(home, ".continue", "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect("mcpServers" in settings).toBe(false);
    expect("hooks" in settings).toBe(true);
  });
});
