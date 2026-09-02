/**
 * adapters/grok-build — focused tests for the Grok Build (xAI) adapter.
 *
 * Grok Build is xai-org/grok-build (Apache-2.0), the OFFICIAL xAI coding agent —
 * a different product from the community `superagent-ai/grok-cli` behind adapter
 * id `grok-cli`. The two share the DEFAULT `~/.grok` directory but never a file,
 * which makes detection the highest-risk surface here. These tests prove:
 *   1. Identity + the source-verified capability flags (including the two
 *      deliberate FALSE flags: permissionRequest and canInjectSessionContext).
 *   2. Detection keys on config.toml and BOWS OUT of a ~/.grok that carries only
 *      grok-cli's user-settings.json — asserted in BOTH directions, so neither
 *      Grok product can ever report the other as installed.
 *   3. installServer writes TOML `[mcp_servers.<id>]` into config.toml with the
 *      telemetry wrap and env-refs resolved to LITERALS (TOML cannot interpolate),
 *      and renders remote servers with Grok's OWN `${VAR}` header syntax.
 *   4. installHooks writes the Claude-compatible object into hooks/<file>.json,
 *      derives the PreToolUse matcher, and warn-skips PermissionRequest (the one
 *      canonical event Grok cannot fire).
 *   5. Content surfaces land at .grok/{commands,skills,agents} and memory at
 *      AGENTS.md (project) / rules (user).
 *   6. parseEvent honors the TWO false-friend fields that motivated reading the
 *      Rust source: PostToolUse `toolResult` and PreCompact/PostCompact `source`.
 *   7. formatReply emits each event's real native envelope.
 *   8. uninstall reverses every surface.
 *
 * Filesystem isolation: every test gets a fresh mkdtemp dir with HOME +
 * AGENT_CONNECTOR_DATA_DIR redirected there, restored in afterEach.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import TOML from "@iarna/toml";
import { describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import grokAdapter from "../../src/adapters/grok-build/index.js";
import grokCliAdapter from "../../src/adapters/grok-cli/index.js";
import {
  buildCtx,
  freshHomeProject,
  freshProject,
  isolateEnv,
  HOME_BIN,
} from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";

const CONNECTOR_ID = "acme-db";
const ENV_VAR = "ACME_DB_DSN";
const ENV_LITERAL = "postgres://acme/db";
const TOKEN_VAR = "ACME_DB_TOKEN";

function buildConnector(
  overrides: Parameters<typeof defineConnector>[0] extends infer T ? Partial<T> : never = {},
): ResolvedConnector {
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
      PreToolUse: { matcher: "acme_query", handler: () => ({ decision: "allow" }) },
      SessionStart: { handler: () => ({ decision: "allow" }) },
    },
    ...(overrides as object),
  });
}

/** User-scope ctx: Grok Build's primary surface is $GROK_HOME (default ~/.grok). */
function userCtx(projectDir: string, connector: ResolvedConnector): InstallContext {
  return buildCtx(projectDir, connector, "user");
}

function freshGrokProject(prefix: string): string {
  const dir = freshProject(prefix);
  process.env[ENV_VAR] = ENV_LITERAL;
  delete process.env.GROK_HOME;
  return dir;
}

/**
 * Detection needs HOME and the project dir to be DISTINCT: the shared ~/.grok
 * bow-out is about the USER dir, and the default shape (HOME === projectDir)
 * would make `<project>/.grok` and `~/.grok` the same directory — collapsing the
 * very distinction under test.
 */
function freshGrokHomeProject(prefix: string): { home: string; projectDir: string } {
  const dirs = freshHomeProject(prefix);
  process.env[ENV_VAR] = ENV_LITERAL;
  delete process.env.GROK_HOME;
  return dirs;
}

/** Create `<home>/.grok/<file>` with empty-ish contents. */
function writeUserMarker(home: string, file: string, body = ""): void {
  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(join(home, ".grok", file), body, "utf8");
}

function readToml(path: string): Record<string, any> {
  return TOML.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

isolateEnv([ENV_VAR, TOKEN_VAR, "GROK_HOME"]);
createAdapterSuite({ adapter: grokAdapter, paradigm: "json-stdio" });

// ── Identity + capabilities ────────────────────────────────────────────────

describe("grok-build adapter — identity + source-verified capabilities", () => {
  it("has the grok-build identity and the json-stdio paradigm", () => {
    expect(grokAdapter.id).toBe("grok-build");
    expect(grokAdapter.name).toBe("Grok Build");
    expect(grokAdapter.paradigm).toBe("json-stdio");
  });

  it("declares every canonical event Grok Build natively fires", () => {
    const c = grokAdapter.capabilities;
    expect(c.sessionStart).toBe(true);
    expect(c.sessionEnd).toBe(true);
    expect(c.userPromptSubmit).toBe(true);
    expect(c.preToolUse).toBe(true);
    expect(c.postToolUse).toBe(true);
    expect(c.postToolUseFailure).toBe(true);
    expect(c.stop).toBe(true);
    expect(c.notification).toBe(true);
    expect(c.subagentStart).toBe(true);
    expect(c.subagentStop).toBe(true);
    expect(c.preCompact).toBe(true);
    expect(c.postCompact).toBe(true);
  });

  it("leaves permissionRequest UNSET — Grok's PermissionDenied is a passive post-denial event", () => {
    // Grok has no decision-capable pre-dialog gate; PermissionDenied fires AFTER
    // the permission system denied a call and is documented "Blocking? No".
    expect(grokAdapter.capabilities.permissionRequest ?? false).toBe(false);
  });

  it("sets canModifyArgs + canModifyOutput true and canInjectSessionContext FALSE", () => {
    const c = grokAdapter.capabilities;
    // updatedInput (PreToolUse) and updatedToolOutput (PostToolUse) are native.
    expect(c.canModifyArgs).toBe(true);
    expect(c.canModifyOutput).toBe(true);
    // Grok ignores stdout on SessionStart and discards it on an allowing
    // UserPromptSubmit, so there is no session-context injection surface.
    expect(c.canInjectSessionContext).toBe(false);
  });

  it("registers stdio + http + sse transports and all three content surfaces + memory", () => {
    const c = grokAdapter.capabilities;
    expect(c.transports).toEqual(["stdio", "http", "sse"]);
    expect(c.supportsCommands).toBe(true);
    expect(c.supportsSkills).toBe(true);
    expect(c.supportsSubagents).toBe(true);
    expect(c.supportsMemory).toBe(true);
    // Not wired: the host HAS [ui.status_line] and no shell-exec slash surface.
    expect(c.supportsStatusline ?? false).toBe(false);
    expect(c.supportsActions ?? false).toBe(false);
    // Grok's own interpolation is `${VAR}`, NOT our `${env:VAR}` token, so refs
    // must resolve to literals rather than passing through.
    expect(c.nativeServerEnvInterpolation ?? false).toBe(false);
  });
});

// ── Detection + the ~/.grok collision with grok-cli ────────────────────────

describe("grok-build adapter — detection and the shared ~/.grok bow-out", () => {
  it("does not detect on an empty HOME", () => {
    const { projectDir } = freshGrokHomeProject("ac-gb-detect-");
    expect(grokAdapter.detectInstalled(projectDir).installed).toBe(false);
  });

  it("detects on its own marker file ~/.grok/config.toml", () => {
    const { home, projectDir } = freshGrokHomeProject("ac-gb-detect-cfg-");
    writeUserMarker(home, "config.toml");
    const detected = grokAdapter.detectInstalled(projectDir);
    expect(detected.installed).toBe(true);
    expect(detected.scope).toBe("user");
    expect(detected.configPath).toBe(join(home, ".grok", "config.toml"));
  });

  it("BOWS OUT of a ~/.grok that holds only the community grok-cli's user-settings.json", () => {
    const { home, projectDir } = freshGrokHomeProject("ac-gb-detect-sibling-");
    writeUserMarker(home, "user-settings.json", "{}");
    const detected = grokAdapter.detectInstalled(projectDir);
    expect(detected.installed).toBe(false);
    expect(detected.reason).toContain("community Grok CLI");
  });

  it("grok-cli BOWS OUT of a ~/.grok that holds only Grok Build's config.toml", () => {
    // The reciprocal guard: without it, installing Grok Build would make the
    // unrelated community CLI report as installed and receive a config it never reads.
    const { home, projectDir } = freshGrokHomeProject("ac-gb-detect-reciprocal-");
    writeUserMarker(home, "config.toml");
    expect(grokCliAdapter.detectInstalled(projectDir).installed).toBe(false);
    expect(grokAdapter.detectInstalled(projectDir).installed).toBe(true);
  });

  it("detects BOTH products when both marker files are present", () => {
    const { home, projectDir } = freshGrokHomeProject("ac-gb-detect-both-");
    writeUserMarker(home, "config.toml");
    writeUserMarker(home, "user-settings.json", "{}");
    expect(grokAdapter.detectInstalled(projectDir).installed).toBe(true);
    expect(grokCliAdapter.detectInstalled(projectDir).installed).toBe(true);
  });

  it("honors $GROK_HOME for the user config dir", () => {
    const { home, projectDir } = freshGrokHomeProject("ac-gb-home-");
    const custom = join(home, "custom-grok");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "config.toml"), "", "utf8");
    process.env.GROK_HOME = custom;
    const detected = grokAdapter.detectInstalled(projectDir);
    expect(detected.installed).toBe(true);
    expect(detected.configPath).toBe(join(custom, "config.toml"));
  });
});

// ── MCP server: config.toml → [mcp_servers.<id>] ───────────────────────────

describe("grok-build adapter — MCP server in config.toml", () => {
  it("writes [mcp_servers.<id>] with the telemetry wrap and LITERAL env refs", () => {
    const dir = freshGrokProject("ac-gb-server-");
    const ctx = userCtx(dir, buildConnector());
    const changes = grokAdapter.installServer(ctx);
    expect(changes[0]!.action).toBe("create");

    const cfgPath = join(dir, ".grok", "config.toml");
    expect(grokAdapter.getServerConfigPath(ctx)).toBe(cfgPath);
    const entry = readToml(cfgPath).mcp_servers[CONNECTOR_ID];

    // Telemetry wrap: the home binary fronts the real command.
    expect(entry.command).toBe(HOME_BIN);
    expect(entry.args).toContain("npx");
    // TOML has NO interpolation, so `${env:VAR}` must be a resolved literal.
    expect(entry.env[ENV_VAR]).toBe(ENV_LITERAL);
    expect(JSON.stringify(entry)).not.toContain("${env:");
  });

  it("is idempotent and reversible", () => {
    const dir = freshGrokProject("ac-gb-server-idem-");
    const ctx = userCtx(dir, buildConnector());
    grokAdapter.installServer(ctx);
    expect(grokAdapter.installServer(ctx)[0]!.action).toBe("skip");

    grokAdapter.uninstallServer(ctx);
    const cfg = readToml(join(dir, ".grok", "config.toml"));
    expect(cfg.mcp_servers?.[CONNECTOR_ID]).toBeUndefined();
  });

  it("renders a remote http server as `url` + a ${VAR} Authorization header", () => {
    const dir = freshGrokProject("ac-gb-server-http-");
    const connector = defineConnector({
      id: CONNECTOR_ID,
      server: {
        transport: "http",
        url: "https://mcp.example.com/mcp",
        auth: { type: "bearerEnv", bearerEnvVar: TOKEN_VAR },
      },
    });
    const ctx = userCtx(dir, connector);
    expect(grokAdapter.installServer(ctx)[0]!.action).toBe("create");

    const entry = readToml(join(dir, ".grok", "config.toml")).mcp_servers[CONNECTOR_ID];
    expect(entry.url).toBe("https://mcp.example.com/mcp");
    // Grok expands `${VAR}` in header values at load time, so the SECRET never
    // lands in the config file (07-mcp-servers.md §Example Configurations).
    expect(entry.headers.Authorization).toBe(`Bearer \${${TOKEN_VAR}}`);
    expect(entry.command).toBeUndefined();
    // No Codex-ism: Grok has no bearer_token_env_var key.
    expect(entry.bearer_token_env_var).toBeUndefined();
  });

  it("skips a transport config.toml cannot express", () => {
    const dir = freshGrokProject("ac-gb-server-ws-");
    const connector = defineConnector({
      id: CONNECTOR_ID,
      server: { transport: "ws", url: "wss://example.com/mcp" },
    });
    const change = grokAdapter.installServer(userCtx(dir, connector))[0]!;
    expect(change.action).toBe("skip");
    expect(change.detail).toContain("not registrable");
  });
});

// ── Hooks: $GROK_HOME/hooks/agent-connector.json ────────────────────────────

describe("grok-build adapter — hooks in the hooks/ directory", () => {
  it("writes the Claude-compatible object into hooks/agent-connector.json", () => {
    const dir = freshGrokProject("ac-gb-hooks-");
    const ctx = userCtx(dir, buildConnector());
    const hookPath = join(dir, ".grok", "hooks", "agent-connector.json");
    expect(grokAdapter.getHookConfigPath(ctx)).toBe(hookPath);

    grokAdapter.installHooks(ctx);
    const written = JSON.parse(readFileSync(hookPath, "utf8"));

    // { hooks: { <Event>: [ { matcher, hooks: [ { type:"command", command } ] } ] } }
    const pre = written.hooks.PreToolUse[0];
    expect(pre.hooks[0].type).toBe("command");
    expect(pre.hooks[0].command).toContain("hook grok-build PreToolUse");
    expect(pre.hooks[0].command).toContain(`--connector ${CONNECTOR_ID}`);
    // EVENT-derived matcher: Grok's own tool names + the Claude aliases it maps.
    expect(pre.matcher).toContain("run_terminal_command");
    expect(pre.matcher).toContain("Bash");
    expect(pre.matcher).toContain("search_replace");
    // Charset-clean so the host's Rust regex engine needs no look-around.
    expect(pre.matcher).toMatch(/^[A-Za-z0-9_|]+$/);

    // A non-tool event registers the match-everything empty matcher.
    expect(written.hooks.SessionStart[0].matcher).toBe("");
  });

  it("warn-skips PermissionRequest — the one canonical event Grok cannot fire", () => {
    const dir = freshGrokProject("ac-gb-hooks-permreq-");
    const connector = defineConnector({
      id: CONNECTOR_ID,
      hooks: { PermissionRequest: { handler: () => ({ decision: "allow" }) } },
    });
    const changes = grokAdapter.installHooks(userCtx(dir, connector));
    const warn = changes.find((c) => c.action === "warn");
    expect(warn, "PermissionRequest must be reported, never silently dropped").toBeTruthy();
    expect(warn!.detail).toContain("PermissionRequest");
  });

  it("is idempotent and uninstall removes only our entries", () => {
    const dir = freshGrokProject("ac-gb-hooks-idem-");
    const ctx = userCtx(dir, buildConnector());
    const hookPath = join(dir, ".grok", "hooks", "agent-connector.json");

    grokAdapter.installHooks(ctx);
    expect(grokAdapter.installHooks(ctx).every((c) => c.action === "skip")).toBe(true);

    grokAdapter.uninstallHooks(ctx);
    const written = JSON.parse(readFileSync(hookPath, "utf8"));
    expect(written.hooks.PreToolUse ?? []).toHaveLength(0);
    expect(written.hooks.SessionStart ?? []).toHaveLength(0);
  });
});

// ── Content surfaces + memory ──────────────────────────────────────────────

describe("grok-build adapter — content surfaces under .grok", () => {
  const contentConnector = (): ResolvedConnector =>
    defineConnector({
      id: CONNECTOR_ID,
      commands: [{ name: "acme-run", description: "Run it", prompt: "Do the thing" }],
      skills: [{ name: "acme-skill", description: "A skill", body: "Steps here" }],
      subagents: [
        { name: "acme-agent", description: "An agent", prompt: "You are an agent" },
      ],
    });

  it("writes commands/<n>.md, skills/<n>/SKILL.md and agents/<n>.md", () => {
    const dir = freshGrokProject("ac-gb-content-");
    const ctx = userCtx(dir, contentConnector());
    grokAdapter.installCommands(ctx);
    grokAdapter.installSkills(ctx);
    grokAdapter.installSubagents(ctx);

    const root = join(dir, ".grok");
    const cmd = join(root, "commands", "acme-run.md");
    const skill = join(root, "skills", "acme-skill", "SKILL.md");
    const agent = join(root, "agents", "acme-agent.md");
    expect(existsSync(cmd)).toBe(true);
    expect(existsSync(skill)).toBe(true);
    expect(existsSync(agent)).toBe(true);

    // Skills are Anthropic-format: name + description frontmatter.
    const skillMd = readFileSync(skill, "utf8");
    expect(skillMd).toMatch(/^---\n/);
    expect(skillMd).toContain("name: acme-skill");
    expect(skillMd).toContain("description: A skill");

    // Agent frontmatter is name/description (+ tools/model when declared).
    expect(readFileSync(agent, "utf8")).toContain("name: acme-agent");
  });

  it("uninstall removes every content file it wrote", () => {
    const dir = freshGrokProject("ac-gb-content-rm-");
    const ctx = userCtx(dir, contentConnector());
    grokAdapter.installCommands(ctx);
    grokAdapter.installSkills(ctx);
    grokAdapter.installSubagents(ctx);
    grokAdapter.uninstallCommands(ctx);
    grokAdapter.uninstallSkills(ctx);
    grokAdapter.uninstallSubagents(ctx);

    const root = join(dir, ".grok");
    expect(existsSync(join(root, "commands", "acme-run.md"))).toBe(false);
    expect(existsSync(join(root, "skills", "acme-skill", "SKILL.md"))).toBe(false);
    expect(existsSync(join(root, "agents", "acme-agent.md"))).toBe(false);
  });

  it("memory targets AGENTS.md in project scope and $GROK_HOME/rules in user scope", () => {
    const dir = freshGrokProject("ac-gb-memory-");
    const connector = defineConnector({ id: CONNECTOR_ID, memory: [{ content: "Rules here" }] });

    grokAdapter.installMemory(buildCtx(dir, connector, "project"));
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);

    grokAdapter.installMemory(userCtx(dir, connector));
    expect(existsSync(join(dir, ".grok", "rules", "agent-connector.md"))).toBe(true);
  });
});

// ── Runtime dispatch: parseEvent ───────────────────────────────────────────

describe("grok-build adapter — parseEvent (camelCase envelope + false friends)", () => {
  it("reads the camelCase envelope and falls back to the additive snake aliases", () => {
    const camel = grokAdapter.parseEvent("PreToolUse", {
      sessionId: "sess-1",
      cwd: "/work",
      toolName: "run_terminal_command",
      toolInput: { command: "npm test" },
    }) as any;
    expect(camel.sessionId).toBe("sess-1");
    expect(camel.projectDir).toBe("/work");
    expect(camel.toolName).toBe("run_terminal_command");
    expect(camel.toolInput).toEqual({ command: "npm test" });

    // to_hook_json injects snake_case twins; a client reading only those still works.
    const snake = grokAdapter.parseEvent("PreToolUse", {
      session_id: "sess-2",
      cwd: "/work",
      tool_name: "read_file",
      tool_input: { path: "a.ts" },
    }) as any;
    expect(snake.sessionId).toBe("sess-2");
    expect(snake.toolName).toBe("read_file");
  });

  it("PostToolUse reads `toolResult` (NOT toolOutput) and never invents isError", () => {
    // FALSE FRIEND #1: the upstream field is `toolResult`.
    const obj = grokAdapter.parseEvent("PostToolUse", {
      toolName: "run_terminal_command",
      toolInput: { command: "ls" },
      toolResult: { type: "Bash", output_for_prompt: "a.ts" },
    }) as any;
    expect(obj.toolOutput).toBe(JSON.stringify({ type: "Bash", output_for_prompt: "a.ts" }));
    // Grok routes real failures to PostToolUseFailure, so isError is always false.
    expect(obj.isError).toBe(false);

    const str = grokAdapter.parseEvent("PostToolUse", { toolResult: "plain text" }) as any;
    expect(str.toolOutput).toBe("plain text");
  });

  it("PreCompact/PostCompact read `source` (NOT `trigger`)", () => {
    // FALSE FRIEND #2: the prose calls it "the compaction trigger" but the
    // struct field is `source` (event.rs PreCompact/PostCompact { source }).
    expect((grokAdapter.parseEvent("PreCompact", { source: "manual" }) as any).trigger).toBe(
      "manual",
    );
    expect((grokAdapter.parseEvent("PostCompact", { source: "auto" }) as any).trigger).toBe("auto");
    // A payload carrying only the WRONG key must not produce "manual".
    expect((grokAdapter.parseEvent("PreCompact", { trigger: "manual" }) as any).trigger).toBe(
      "auto",
    );
  });

  it("normalizes the remaining per-event payloads", () => {
    expect((grokAdapter.parseEvent("UserPromptSubmit", { prompt: "hi" }) as any).prompt).toBe("hi");
    expect((grokAdapter.parseEvent("SessionEnd", { reason: "shutdown" }) as any).reason).toBe(
      "shutdown",
    );
    expect((grokAdapter.parseEvent("Stop", { stopHookActive: true }) as any).stopHookActive).toBe(
      true,
    );
    // `message` is optional upstream; notificationType is always present.
    expect(
      (grokAdapter.parseEvent("Notification", { notificationType: "idle_prompt" }) as any).message,
    ).toBe("idle_prompt");

    const start = grokAdapter.parseEvent("SubagentStart", {
      subagentId: "sub-1",
      subagentType: "explore",
    }) as any;
    expect(start.agentId).toBe("sub-1");
    expect(start.agentType).toBe("explore");

    const fail = grokAdapter.parseEvent("PostToolUseFailure", {
      toolName: "use_tool",
      error: "boom",
      toolUseId: "call-1",
      isInterrupt: false,
    }) as any;
    expect(fail.error).toBe("boom");
    expect(fail.toolUseId).toBe("call-1");
  });
});

// ── Runtime dispatch: formatReply ──────────────────────────────────────────

describe("grok-build adapter — formatReply native envelopes", () => {
  const out = (event: any, response: any) => {
    const reply = grokAdapter.formatReply(event, response);
    return { reply, json: reply.stdout ? JSON.parse(reply.stdout) : undefined };
  };

  it("PreToolUse deny uses hookSpecificOutput.permissionDecision + permissionDecisionReason", () => {
    const { reply, json } = out("PreToolUse", { decision: "deny", reason: "unsafe" });
    expect(reply.exitCode).toBe(0); // Grok honors a stdout deny at any exit code
    expect(json.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "unsafe",
    });
  });

  it("PreToolUse ask routes to Grok's NATIVE ask decision", () => {
    const { json } = out("PreToolUse", { decision: "ask", reason: "confirm deploy" });
    expect(json.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(json.hookSpecificOutput.permissionDecisionReason).toBe("confirm deploy");
  });

  it("PreToolUse modify emits a BARE updatedInput (no paired allow — unlike Codex)", () => {
    const { json } = out("PreToolUse", {
      decision: "modify",
      updatedInput: { command: "npm test" },
    });
    expect(json.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      updatedInput: { command: "npm test" },
    });
    // "Omitting `decision` while returning `updatedInput` allows the call and
    // applies the rewrite" — a bare allow would mean only "not blocked".
    expect(json.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  it("PostToolUse modify replaces the model's copy via updatedToolOutput", () => {
    const { json } = out("PostToolUse", { decision: "modify", updatedOutput: "[redacted]" });
    expect(json.hookSpecificOutput).toEqual({
      hookEventName: "PostToolUse",
      updatedToolOutput: "[redacted]",
    });
  });

  it("Stop / SubagentStop / UserPromptSubmit deny use the top-level block protocol", () => {
    for (const event of ["Stop", "SubagentStop", "UserPromptSubmit"]) {
      const { json } = out(event, { decision: "deny", reason: "tests not run" });
      expect(json).toEqual({ decision: "block", reason: "tests not run" });
    }
  });

  it("injects additionalContext only where Grok reads stdout", () => {
    for (const event of ["PreToolUse", "PostToolUse", "Stop", "SubagentStop"]) {
      const { json } = out(event, { decision: "context", additionalContext: "note" });
      expect(json.hookSpecificOutput.additionalContext).toBe("note");
    }
    // Passive events ignore stdout entirely — emit nothing rather than a payload
    // the host would silently drop.
    for (const event of ["SessionStart", "Notification", "PreCompact", "PostCompact", "SubagentStart"]) {
      const { reply } = out(event, { decision: "context", additionalContext: "note" });
      expect(reply.exitCode).toBe(0);
      expect(reply.stdout).toBeUndefined();
    }
    // An ALLOWING UserPromptSubmit has its stdout discarded (no additionalContext).
    expect(
      out("UserPromptSubmit", { decision: "context", additionalContext: "note" }).reply.stdout,
    ).toBeUndefined();
  });

  it("allow is a bare exit-0 passthrough", () => {
    const { reply } = out("PreToolUse", { decision: "allow" });
    expect(reply.exitCode).toBe(0);
    expect(reply.stdout).toBeUndefined();
  });
});
