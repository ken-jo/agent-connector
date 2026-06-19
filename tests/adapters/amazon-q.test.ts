/**
 * adapters/amazon-q.test.ts — Amazon Q Developer CLI adapter tests.
 *
 * Amazon Q Developer CLI (`q` / `qchat`) is a json-stdio host. It registers MCP
 * servers in:
 *   user scope    → ~/.aws/amazonq/mcp.json   (root key "mcpServers")
 *   project scope → <projectDir>/.amazonq/mcp.json
 * and registers hooks in a per-agent file (NO global hooks.json) — AC targets the
 * built-in `q_cli_default` agent file at the install scope (a bare `default.json`
 * would be an inactive custom agent the user must select; q_cli_default is the
 * built-in default the CLI auto-loads):
 *   user scope    → ~/.aws/amazonq/cli-agents/q_cli_default.json
 *   project scope → <projectDir>/.amazonq/cli-agents/q_cli_default.json
 * The `hooks` field is an OBJECT keyed by trigger; each entry is { command,
 * matcher? } (FLAT — no `type`). STDIN+exit contract is identical to kiro.
 *
 * All tests are HOME-isolated (mkdtemp + redirected HOME/USERPROFILE/APPDATA/
 * XDG) and deterministic.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type {
  ConnectorConfig,
  PreToolUseEvent,
  ResolvedConnector,
} from "../../src/core/types.js";

import amazonQAdapter from "../../src/adapters/amazon-q/index.js";
import { buildCtx, freshHomeProject, HOME_BIN, isolateEnv } from "../support/env.js";
import { createAdapterSuite } from "../support/adapter-suite.js";
import { readJson } from "../support/fs.js";

const CONNECTOR_ID = "acme-amazon-q";
const PRE_MATCHER = "Bash";

const SERVER = {
  transport: "stdio",
  command: "acme-mcp",
  args: ["--port", "0"],
  // Disable the transparent telemetry serve-wrapper so the rendered entry holds
  // the literal command/args (the wrap behavior is covered by spawn/render tests).
  wrapForTelemetry: false,
} as const;

function buildConnector(cfg: Partial<ConnectorConfig> = {}): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Amazon Q",
    version: "1.0.0",
    server: { ...SERVER, args: [...SERVER.args] },
    memory: [{ content: "Project guidance for Amazon Q." }],
    ...cfg,
  });
}

/**
 * A connector declaring the full mapped event set plus the four unmapped/E1
 * events (so warn-skip is exercised). PreToolUse carries a matcher.
 */
function buildHookConnector(cfg: Partial<ConnectorConfig> = {}): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme Amazon Q",
    version: "1.0.0",
    hooks: {
      SessionStart: { handler: () => ({ decision: "context", additionalContext: "hi" }) },
      UserPromptSubmit: { handler: () => ({ decision: "allow" }) },
      PreToolUse: { matcher: PRE_MATCHER, handler: () => ({ decision: "allow" }) },
      PostToolUse: { handler: () => ({ decision: "allow" }) },
      Stop: { handler: () => ({ decision: "allow" }) },
    },
    ...cfg,
  });
}

// Shared env isolation + the same-rules-for-every-host baseline contract.
isolateEnv();
createAdapterSuite({ adapter: amazonQAdapter, paradigm: "json-stdio" });

// ── capability flags ────────────────────────────────────────────────────────

describe("amazon-q adapter — identity + capabilities", () => {
  it("is a json-stdio host with the right identity and surface flags", () => {
    expect(amazonQAdapter.id).toBe("amazon-q");
    expect(amazonQAdapter.name).toBe("Amazon Q Developer CLI");
    expect(amazonQAdapter.paradigm).toBe("json-stdio");
    // Memory is WIRED (Amazon Q reads .amazonq/rules, not AGENTS.md): the adapter
    // declares supportsMemory and writes a dedicated .amazonq/rules file.
    expect(amazonQAdapter.capabilities.supportsMemory).toBe(true);
    // json-stdio: the five mapped events are supported.
    expect(amazonQAdapter.capabilities.sessionStart).toBe(true);
    expect(amazonQAdapter.capabilities.userPromptSubmit).toBe(true);
    expect(amazonQAdapter.capabilities.preToolUse).toBe(true);
    expect(amazonQAdapter.capabilities.postToolUse).toBe(true);
    expect(amazonQAdapter.capabilities.stop).toBe(true);
    // No PreCompact / SessionEnd / Notification analog.
    expect(amazonQAdapter.capabilities.preCompact).toBe(false);
    expect(amazonQAdapter.capabilities.sessionEnd).toBe(false);
    expect(amazonQAdapter.capabilities.notification).toBe(false);
    // No E1 extension events.
    expect(amazonQAdapter.capabilities.permissionRequest ?? false).toBe(false);
    expect(amazonQAdapter.capabilities.postToolUseFailure ?? false).toBe(false);
    expect(amazonQAdapter.capabilities.subagentStart ?? false).toBe(false);
    expect(amazonQAdapter.capabilities.subagentStop ?? false).toBe(false);
    // Exit-code protocol: cannot rewrite args/output; CAN inject agentSpawn context.
    expect(amazonQAdapter.capabilities.canModifyArgs).toBe(false);
    expect(amazonQAdapter.capabilities.canModifyOutput).toBe(false);
    expect(amazonQAdapter.capabilities.canInjectSessionContext).toBe(true);
    // No unverified content surfaces
    expect(amazonQAdapter.capabilities.supportsCommands ?? false).toBe(false);
    expect(amazonQAdapter.capabilities.supportsSkills ?? false).toBe(false);
    expect(amazonQAdapter.capabilities.supportsSubagents ?? false).toBe(false);
    // Transports: stdio + http
    expect(amazonQAdapter.capabilities.transports).toContain("stdio");
    expect(amazonQAdapter.capabilities.transports).toContain("http");
  });
});

// ── path resolution ─────────────────────────────────────────────────────────

describe("amazon-q adapter — path resolution", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject());
  });

  it("user scope resolves to ~/.aws/amazonq/mcp.json", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const serverPath = amazonQAdapter.getServerConfigPath(ctx);
    expect(serverPath).toBe(join(home, ".aws", "amazonq", "mcp.json"));
  });

  it("project scope resolves to <projectDir>/.amazonq/mcp.json", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const serverPath = amazonQAdapter.getServerConfigPath(ctx);
    expect(serverPath).toBe(join(projectDir, ".amazonq", "mcp.json"));
  });

  it("getHookConfigPath targets the default agent file (user scope)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    expect(amazonQAdapter.getHookConfigPath(ctx)).toBe(
      join(home, ".aws", "amazonq", "cli-agents", "q_cli_default.json"),
    );
    // Hooks live in a DIFFERENT file from the MCP server config.
    expect(amazonQAdapter.getHookConfigPath(ctx)).not.toBe(
      amazonQAdapter.getServerConfigPath(ctx),
    );
  });

  it("getHookConfigPath targets the default agent file (project scope)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    expect(amazonQAdapter.getHookConfigPath(ctx)).toBe(
      join(projectDir, ".amazonq", "cli-agents", "q_cli_default.json"),
    );
  });

  it("user scope getConfigDir = ~/.aws/amazonq (NOT ~/.amazonq — two segments)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const configDir = amazonQAdapter.getConfigDir(ctx);
    expect(configDir).toBe(join(home, ".aws", "amazonq"));
    // Guard against the single-segment mistake
    expect(configDir).not.toBe(join(home, ".amazonq"));
  });

  it("project scope getConfigDir = <projectDir>/.amazonq (NO .aws)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const configDir = amazonQAdapter.getConfigDir(ctx);
    expect(configDir).toBe(join(projectDir, ".amazonq"));
  });
});

// ── detection ──────────────────────────────────────────────────────────────

describe("amazon-q adapter — detection", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject());
  });

  it("not installed on a bare box", () => {
    const d = amazonQAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(false);
    expect(d.confidence).toBe("low");
  });

  it("detects ~/.aws/amazonq dir (user scope)", () => {
    mkdirSync(join(home, ".aws", "amazonq"), { recursive: true });
    const d = amazonQAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(true);
    expect(d.scope).toBe("user");
    expect(d.confidence).toBe("high");
    expect(d.configPath).toBe(join(home, ".aws", "amazonq", "mcp.json"));
  });

  it("detects ~/.aws/amazonq/mcp.json (user scope, file only)", () => {
    const dir = join(home, ".aws", "amazonq");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
    const d = amazonQAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(true);
    expect(d.scope).toBe("user");
  });

  it("detects .amazonq dir at project scope", () => {
    mkdirSync(join(projectDir, ".amazonq"), { recursive: true });
    const d = amazonQAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(true);
    expect(d.scope).toBe("project");
    expect(d.configPath).toBe(join(projectDir, ".amazonq", "mcp.json"));
  });

  it("detects .amazonq/mcp.json at project scope (file only)", () => {
    const dir = join(projectDir, ".amazonq");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
    const d = amazonQAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(true);
    expect(d.scope).toBe("project");
  });

  it("prefers user scope when both user and project markers are present", () => {
    mkdirSync(join(home, ".aws", "amazonq"), { recursive: true });
    mkdirSync(join(projectDir, ".amazonq"), { recursive: true });
    const d = amazonQAdapter.detectInstalled(projectDir);
    expect(d.scope).toBe("user");
    expect(d.configPath).toBe(join(home, ".aws", "amazonq", "mcp.json"));
  });

  it("does NOT collide with a bare ~/.aws dir (amazonq subdir must be present)", () => {
    mkdirSync(join(home, ".aws"), { recursive: true });
    const d = amazonQAdapter.detectInstalled(projectDir);
    expect(d.installed).toBe(false);
  });
});

// ── MCP server install ──────────────────────────────────────────────────────

describe("amazon-q adapter — MCP install (user scope)", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject());
  });

  it("writes mcpServers.<id> at ~/.aws/amazonq/mcp.json", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = amazonQAdapter.installServer(ctx);
    expect(changes.every((c) => c.platform === "amazon-q")).toBe(true);
    expect(changes[0]?.action).toBe("create");

    const mcpPath = join(home, ".aws", "amazonq", "mcp.json");
    expect(changes[0]?.path).toBe(mcpPath);
    expect(existsSync(mcpPath)).toBe(true);

    const cfg = readJson(mcpPath) as {
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };
    expect(cfg.mcpServers[CONNECTOR_ID]).toBeTruthy();
    expect(cfg.mcpServers[CONNECTOR_ID]!.command).toBe("acme-mcp");
    expect(cfg.mcpServers[CONNECTOR_ID]!.args).toEqual(["--port", "0"]);
  });

  it("BARE entry shape: no `type` discriminator and no `disabled` flag", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    amazonQAdapter.installServer(ctx);
    const mcpPath = join(home, ".aws", "amazonq", "mcp.json");
    const cfg = readJson(mcpPath) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    const entry = cfg.mcpServers[CONNECTOR_ID]!;
    expect("type" in entry).toBe(false);
    expect("disabled" in entry).toBe(false);
  });

  it("writes mcpServers.<id> at <projectDir>/.amazonq/mcp.json (project scope)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const changes = amazonQAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("create");

    const mcpPath = join(projectDir, ".amazonq", "mcp.json");
    expect(changes[0]?.path).toBe(mcpPath);
    expect(existsSync(mcpPath)).toBe(true);
    // User path must NOT be written
    expect(existsSync(join(home, ".aws", "amazonq", "mcp.json"))).toBe(false);
  });

  it("install is idempotent: second install returns skip", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    amazonQAdapter.installServer(ctx);
    const second = amazonQAdapter.installServer(ctx);
    expect(second[0]?.action).toBe("skip");
  });

  it("uninstall removes the entry and returns remove", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    amazonQAdapter.installServer(ctx);
    const removed = amazonQAdapter.uninstallServer(ctx);
    expect(removed[0]?.action).toBe("remove");

    const mcpPath = join(home, ".aws", "amazonq", "mcp.json");
    const cfg = readJson(mcpPath) as {
      mcpServers: Record<string, unknown>;
    };
    expect(CONNECTOR_ID in cfg.mcpServers).toBe(false);
  });

  it("preserves other servers on uninstall", () => {
    const mcpPath = join(home, ".aws", "amazonq", "mcp.json");
    mkdirSync(join(home, ".aws", "amazonq"), { recursive: true });
    writeFileSync(
      mcpPath,
      JSON.stringify({ mcpServers: { "other-tool": { command: "other" } } }),
    );

    const ctx = buildCtx(projectDir, buildConnector(), "user");
    amazonQAdapter.installServer(ctx);
    amazonQAdapter.uninstallServer(ctx);

    const cfg = readJson(mcpPath) as {
      mcpServers: Record<string, unknown>;
    };
    expect("other-tool" in cfg.mcpServers).toBe(true);
    expect(CONNECTOR_ID in cfg.mcpServers).toBe(false);
  });

  it("update: second install with changed server writes update", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    amazonQAdapter.installServer(ctx);

    // Rebuild with different args
    const changed = buildConnector({
      server: { ...SERVER, args: ["--port", "9999"] },
    });
    const ctx2 = buildCtx(projectDir, changed, "user");
    const result = amazonQAdapter.installServer(ctx2);
    expect(result[0]?.action).toBe("update");
  });

  it("skips when connector declares no server", () => {
    const connector = buildConnector({ server: undefined });
    const ctx = buildCtx(projectDir, connector, "user");
    const changes = amazonQAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("no MCP server");
  });

  it("skips when platform override is false", () => {
    const connector = buildConnector({ platforms: { "amazon-q": { server: false } } });
    const ctx = buildCtx(projectDir, connector, "user");
    const changes = amazonQAdapter.installServer(ctx);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("disabled for amazon-q");
  });
});

// ── remote (http) server ───────────────────────────────────────────────────

describe("amazon-q adapter — remote (http) server", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject());
  });

  it("http server writes { type: \"http\", url } entry (no headers, no disabled)", () => {
    const connector = buildConnector({
      server: { transport: "http", url: "https://mcp.example.com/mcp" },
    });
    const ctx = buildCtx(projectDir, connector, "user");
    amazonQAdapter.installServer(ctx);

    const mcpPath = join(home, ".aws", "amazonq", "mcp.json");
    const cfg = readJson(mcpPath) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    const entry = cfg.mcpServers[CONNECTOR_ID]!;
    // Remote/HTTP shape is primary-verified as { type: "http", url }.
    expect(entry.type).toBe("http");
    expect(entry.url).toBe("https://mcp.example.com/mcp");
    // No invented headers field (Amazon Q remote auth is OAuth, not headers).
    expect("headers" in entry).toBe(false);
    expect("disabled" in entry).toBe(false);
    expect("command" in entry).toBe(false);
  });
});

// ── timeout handling ───────────────────────────────────────────────────────

describe("amazon-q adapter — timeout field", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject());
  });

  it("emits timeout in MILLISECONDS when timeoutMs is set (no division)", () => {
    const connector = buildConnector({
      server: { ...SERVER, args: [...SERVER.args], timeoutMs: 60000 },
    });
    const ctx = buildCtx(projectDir, connector, "user");
    amazonQAdapter.installServer(ctx);

    const mcpPath = join(home, ".aws", "amazonq", "mcp.json");
    const cfg = readJson(mcpPath) as {
      mcpServers: Record<string, { timeout?: number }>;
    };
    // Must pass 60000 through unchanged (milliseconds) — NOT divide to 60 (seconds)
    expect(cfg.mcpServers[CONNECTOR_ID]!.timeout).toBe(60000);
  });

  it("omits timeout when timeoutMs is not set", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    amazonQAdapter.installServer(ctx);

    const mcpPath = join(home, ".aws", "amazonq", "mcp.json");
    const cfg = readJson(mcpPath) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect("timeout" in cfg.mcpServers[CONNECTOR_ID]!).toBe(false);
  });
});

// ── memory surface (.amazonq/rules — dedicated owned file) ───────────────────

describe("amazon-q adapter — memory (.amazonq/rules/agent-connector.md)", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject());
  });

  function memFile(): string {
    return join(projectDir, ".amazonq", "rules", "agent-connector.md");
  }

  it("writes .amazonq/rules/agent-connector.md at project scope (plain Markdown)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const changes = amazonQAdapter.installMemory(ctx);
    expect(changes.every((c) => c.platform === "amazon-q")).toBe(true);

    expect(existsSync(memFile())).toBe(true);
    const text = readFileSync(memFile(), "utf8");
    expect(text).toContain("Project guidance for Amazon Q.");
    // No frontmatter is added (Amazon Q auto-applies plain Markdown rules files).
    expect(text.startsWith("---")).toBe(false);
  });

  it("is idempotent and uninstall removes the dedicated block/file", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "project");
    amazonQAdapter.installMemory(ctx);
    const second = amazonQAdapter.installMemory(ctx);
    expect(second.every((c) => c.action === "skip")).toBe(true);

    amazonQAdapter.uninstallMemory(ctx);
    // AC created the file, so removing its only block deletes the file.
    expect(existsSync(memFile())).toBe(false);
  });

  it("user scope skip-warns (no verified user/global rules dir)", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = amazonQAdapter.installMemory(ctx);
    expect(changes.some((c) => c.action === "warn")).toBe(true);
    // Nothing is written under HOME.
    expect(existsSync(join(home, ".aws", "amazonq", "rules"))).toBe(false);
  });

  it("does NOT clobber a pre-existing .amazonq/rules FILE (collision guard)", () => {
    // Legacy/odd form: .amazonq/rules is a FILE, not a directory.
    mkdirSync(join(projectDir, ".amazonq"), { recursive: true });
    const rulesFile = join(projectDir, ".amazonq", "rules");
    writeFileSync(rulesFile, "# hand-written single-file rules\n", "utf8");

    const ctx = buildCtx(projectDir, buildConnector(), "project");
    const changes = amazonQAdapter.installMemory(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
    // The user's file is untouched.
    expect(readFileSync(rulesFile, "utf8")).toBe("# hand-written single-file rules\n");
  });

  it("honors platforms['amazon-q'].memory === false", () => {
    const connector = buildConnector({ platforms: { "amazon-q": { memory: false } } });
    const ctx = buildCtx(projectDir, connector, "project");
    const changes = amazonQAdapter.installMemory(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(existsSync(memFile())).toBe(false);
  });
});

// ── hooks (json-stdio: trigger-keyed object-of-arrays in the default agent) ──

describe("amazon-q adapter — hook install (default agent file)", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject());
  });

  function userAgentPath(): string {
    return join(home, ".aws", "amazonq", "cli-agents", "q_cli_default.json");
  }
  function projectAgentPath(): string {
    return join(projectDir, ".amazonq", "cli-agents", "q_cli_default.json");
  }

  it("writes the trigger-keyed hooks object with AC's command (user scope)", () => {
    const ctx = buildCtx(projectDir, buildHookConnector(), "user");
    const changes = amazonQAdapter.installHooks(ctx);
    expect(changes.some((c) => c.action === "create")).toBe(true);
    expect(changes.every((c) => c.platform === "amazon-q")).toBe(true);

    const agentPath = userAgentPath();
    expect(agentPath).toBe(amazonQAdapter.getHookConfigPath(ctx));
    expect(existsSync(agentPath)).toBe(true);

    const agent = readJson(agentPath) as { hooks: Record<string, Array<Record<string, unknown>>> };
    // Canonical events map to Amazon Q triggers; canonical names must NOT leak.
    expect(agent.hooks.SessionStart).toBeUndefined();
    expect(agent.hooks.agentSpawn[0]!.command).toContain("hook amazon-q SessionStart");
    expect(agent.hooks.userPromptSubmit[0]!.command).toContain("hook amazon-q UserPromptSubmit");
    expect(agent.hooks.preToolUse[0]!.command).toContain("hook amazon-q PreToolUse");
    expect(agent.hooks.postToolUse[0]!.command).toContain("hook amazon-q PostToolUse");
    expect(agent.hooks.stop[0]!.command).toContain("hook amazon-q Stop");
    // Every command anchors this connector id.
    expect(agent.hooks.preToolUse[0]!.command).toContain(`--connector ${CONNECTOR_ID}`);
  });

  it("FLAT entry shape: no `type` field; matcher only on preToolUse/postToolUse", () => {
    const ctx = buildCtx(projectDir, buildHookConnector(), "user");
    amazonQAdapter.installHooks(ctx);
    const agent = readJson(userAgentPath()) as {
      hooks: Record<string, Array<Record<string, unknown>>>;
    };
    // No nested `hooks` / `type` (that is kiro's shape, not Amazon Q's).
    expect("type" in agent.hooks.preToolUse[0]!).toBe(false);
    expect("hooks" in agent.hooks.preToolUse[0]!).toBe(false);
    // PreToolUse declared a matcher → present.
    expect(agent.hooks.preToolUse[0]!.matcher).toBe(PRE_MATCHER);
    // agentSpawn/userPromptSubmit/stop are not matcher-meaningful → matcher omitted.
    expect("matcher" in agent.hooks.agentSpawn[0]!).toBe(false);
    expect("matcher" in agent.hooks.userPromptSubmit[0]!).toBe(false);
    expect("matcher" in agent.hooks.stop[0]!).toBe(false);
    // PostToolUse declared no matcher (all tools) → matcher omitted.
    expect("matcher" in agent.hooks.postToolUse[0]!).toBe(false);
  });

  it("project scope writes <projectDir>/.amazonq/cli-agents/q_cli_default.json", () => {
    const ctx = buildCtx(projectDir, buildHookConnector(), "project");
    amazonQAdapter.installHooks(ctx);
    expect(existsSync(projectAgentPath())).toBe(true);
    // The user agent file must NOT be written.
    expect(existsSync(userAgentPath())).toBe(false);
  });

  it("MERGE preserves pre-existing user hooks AND other agent fields", () => {
    const agentPath = userAgentPath();
    mkdirSync(join(home, ".aws", "amazonq", "cli-agents"), { recursive: true });
    writeFileSync(
      agentPath,
      JSON.stringify({
        name: "default",
        description: "my agent",
        mcpServers: { other: { command: "other-mcp" } },
        tools: ["fs_read"],
        hooks: {
          preToolUse: [{ command: "my-own-hook" }],
          stop: [{ command: "another-user-hook" }],
        },
      }),
    );

    const ctx = buildCtx(projectDir, buildHookConnector(), "user");
    amazonQAdapter.installHooks(ctx);

    const agent = readJson(agentPath) as {
      name: string;
      description: string;
      mcpServers: Record<string, unknown>;
      tools: string[];
      hooks: Record<string, Array<Record<string, unknown>>>;
    };
    // Other agent fields untouched.
    expect(agent.name).toBe("default");
    expect(agent.description).toBe("my agent");
    expect(agent.mcpServers.other).toBeTruthy();
    expect(agent.tools).toEqual(["fs_read"]);
    // Pre-existing user hooks survive alongside AC's command.
    expect(agent.hooks.preToolUse.some((e) => e.command === "my-own-hook")).toBe(true);
    expect(agent.hooks.preToolUse.some((e) => String(e.command).includes("hook amazon-q"))).toBe(
      true,
    );
    expect(agent.hooks.stop.some((e) => e.command === "another-user-hook")).toBe(true);
  });

  it("idempotent re-install: second run is a deep-equal skip (no duplicate)", () => {
    const ctx = buildCtx(projectDir, buildHookConnector(), "user");
    amazonQAdapter.installHooks(ctx);
    const second = amazonQAdapter.installHooks(ctx);
    expect(second.every((c) => c.action === "skip" || c.action === "warn")).toBe(true);
    expect(second.some((c) => c.action === "create" || c.action === "update")).toBe(false);

    const agent = readJson(userAgentPath()) as { hooks: Record<string, unknown[]> };
    expect(agent.hooks.preToolUse).toHaveLength(1);
  });

  it("wires only the events a subset connector declares", () => {
    const subset = defineConnector({
      id: CONNECTOR_ID,
      hooks: {
        PreToolUse: { handler: () => ({ decision: "allow" }) },
        Stop: { handler: () => ({ decision: "allow" }) },
      },
    });
    const ctx = buildCtx(projectDir, subset, "user");
    amazonQAdapter.installHooks(ctx);
    const agent = readJson(userAgentPath()) as { hooks: Record<string, unknown[]> };
    expect(agent.hooks.preToolUse).toBeTruthy();
    expect(agent.hooks.stop).toBeTruthy();
    expect(agent.hooks.agentSpawn).toBeUndefined();
    expect(agent.hooks.userPromptSubmit).toBeUndefined();
    expect(agent.hooks.postToolUse).toBeUndefined();
  });

  it("an event with no Amazon Q trigger warn-skips (PreCompact / E1)", () => {
    const connector = defineConnector({
      id: CONNECTOR_ID,
      hooks: {
        PreToolUse: { handler: () => ({ decision: "allow" }) },
        PreCompact: { handler: () => ({ decision: "allow" }) },
        SubagentStart: { handler: () => ({ decision: "allow" }) },
      },
    });
    const ctx = buildCtx(projectDir, connector, "user");
    const changes = amazonQAdapter.installHooks(ctx);
    const warns = changes.filter((c) => c.action === "warn");
    expect(warns.some((c) => c.detail === "PreCompact has no Amazon Q hook equivalent — skipped")).toBe(
      true,
    );
    expect(
      warns.some((c) => c.detail === "SubagentStart has no Amazon Q hook equivalent — skipped"),
    ).toBe(true);
    // The unmapped events never appear as agent file keys.
    const agent = readJson(userAgentPath()) as { hooks: Record<string, unknown[]> };
    expect(agent.hooks.PreCompact).toBeUndefined();
    expect(agent.hooks.SubagentStart).toBeUndefined();
  });

  it("skips when platforms['amazon-q'].hooks === false", () => {
    const connector = buildHookConnector({ platforms: { "amazon-q": { hooks: false } } });
    const ctx = buildCtx(projectDir, connector, "user");
    const changes = amazonQAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("disabled for amazon-q");
  });

  it("skips when the connector declares no hooks", () => {
    const ctx = buildCtx(projectDir, buildConnector(), "user");
    const changes = amazonQAdapter.installHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("no hooks");
  });
});

describe("amazon-q adapter — hook uninstall (remove only AC entries)", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject());
  });

  function userAgentPath(): string {
    return join(home, ".aws", "amazonq", "cli-agents", "q_cli_default.json");
  }

  it("removes only AC's entries; user hooks survive + empty trigger keys are dropped", () => {
    const agentPath = userAgentPath();
    mkdirSync(join(home, ".aws", "amazonq", "cli-agents"), { recursive: true });
    writeFileSync(
      agentPath,
      JSON.stringify({
        name: "default",
        hooks: { preToolUse: [{ command: "my-own-hook" }] },
      }),
    );

    const ctx = buildCtx(projectDir, buildHookConnector(), "user");
    amazonQAdapter.installHooks(ctx);
    amazonQAdapter.uninstallHooks(ctx);

    const agent = readJson(agentPath) as {
      name: string;
      hooks: Record<string, Array<Record<string, unknown>>>;
    };
    // No AC command remains anywhere.
    expect(JSON.stringify(agent.hooks)).not.toContain(HOME_BIN);
    // The user's own hook survives.
    expect(agent.hooks.preToolUse.some((e) => e.command === "my-own-hook")).toBe(true);
    // Triggers AC created (agentSpawn/userPromptSubmit/postToolUse/stop) are dropped
    // once emptied — only the user-populated preToolUse key remains.
    expect(agent.hooks.agentSpawn).toBeUndefined();
    expect(agent.hooks.userPromptSubmit).toBeUndefined();
    expect(agent.hooks.postToolUse).toBeUndefined();
    expect(agent.hooks.stop).toBeUndefined();
    // Other agent fields untouched.
    expect(agent.name).toBe("default");
  });

  it("uninstall on an absent agent file returns a single skip", () => {
    const ctx = buildCtx(projectDir, buildHookConnector(), "user");
    const changes = amazonQAdapter.uninstallHooks(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
  });
});

describe("amazon-q adapter — runtime wire (stdin → event, exit-code reply)", () => {
  it("parseEvent yields a normalized PreToolUse from snake_case stdin", () => {
    const ev = amazonQAdapter.parseEvent!("PreToolUse", {
      session_id: "sess-1",
      cwd: "/work/proj",
      hook_event_name: "PreToolUse",
      tool_name: "fs_write",
      tool_input: { path: "/tmp/x" },
      connector: CONNECTOR_ID,
    }) as PreToolUseEvent;
    expect(ev.hostPlatform).toBe("amazon-q");
    expect(ev.connectorId).toBe(CONNECTOR_ID);
    expect(ev.sessionId).toBe("sess-1");
    expect(ev.toolName).toBe("fs_write");
    expect(ev.toolInput).toEqual({ path: "/tmp/x" });
  });

  it("formatReply: allow → exit 0; deny → exit 2 with reason on stderr", () => {
    const allow = amazonQAdapter.formatReply!("PreToolUse", { decision: "allow" });
    expect(allow.exitCode).toBe(0);

    const deny = amazonQAdapter.formatReply!("PreToolUse", {
      decision: "deny",
      reason: "blocked by policy",
    });
    expect(deny.exitCode).toBe(2);
    expect(deny.stderr).toBe("blocked by policy");
  });

  it("formatReply: SessionStart context → exit 0 + agentSpawn additionalContext JSON", () => {
    const reply = amazonQAdapter.formatReply!("SessionStart", {
      decision: "context",
      additionalContext: "remember the rules",
    });
    expect(reply.exitCode).toBe(0);
    const out = JSON.parse(reply.stdout!) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe("agentSpawn");
    expect(out.hookSpecificOutput.additionalContext).toBe("remember the rules");
  });
});

// ── env interpolation ──────────────────────────────────────────────────────

describe("amazon-q adapter — env interpolation (resolve to literal)", () => {
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    ({ home, projectDir } = freshHomeProject());
    process.env.MY_MCP_SECRET = "actual-secret-value";
  });

  afterEach(() => {
    delete process.env.MY_MCP_SECRET;
  });

  it("resolves ${env:VAR} in env values to literals at install time", () => {
    const connector = buildConnector({
      server: {
        ...SERVER,
        args: [...SERVER.args],
        env: { MY_VAR: "${env:MY_MCP_SECRET}" },
      },
    });
    const ctx = buildCtx(projectDir, connector, "user");
    amazonQAdapter.installServer(ctx);

    const mcpPath = join(home, ".aws", "amazonq", "mcp.json");
    const cfg = readJson(mcpPath) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    // Must be resolved to literal, NOT left as ${env:MY_MCP_SECRET}
    expect(cfg.mcpServers[CONNECTOR_ID]!.env?.MY_VAR).toBe("actual-secret-value");
  });
});
