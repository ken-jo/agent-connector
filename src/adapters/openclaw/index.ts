/**
 * adapters/openclaw — OpenClaw (Gateway) platform adapter for agent-connector.
 *
 * OpenClaw is a **ts-plugin** host, but with a twist no other ts-plugin host
 * has: a plugin only delivers its MCP tools to the agent when it is registered
 * in TWO places at once (DUAL REGISTRATION):
 *
 *   (a) plugins.entries.<id>   — so the gateway actually LOADS the plugin module
 *                                (runs register(api), wiring the hooks); and
 *   (b) mcp.servers.<id>       — nested under a top-level "mcp" object, so the
 *                                plugin's MCP tools SURFACE to the agent.
 *
 *   If only (a) is present, the plugin loads but ZERO tools reach the agent.
 *   If only (b) is present, the tools are declared but the hook bridge never
 *   loads. context-mode's own adapter proved this empirically against OpenClaw
 *   2026.4.22 (src/adapters/openclaw/index.ts checkPluginRegistration: "in
 *   plugins.entries but missing from mcp.servers — plugin loads but no ctx_*
 *   tools reach the agent"). So getHealthChecks() FAILS when the two are
 *   inconsistent (entries XOR mcp.servers).
 *
 * Why we BRIDGE instead of importing handlers (mirrors the OpenCode adapter):
 *   context-mode could load ITS OWN plugin in-process because the handler code
 *   shipped with the package. agent-connector cannot: the connector's hook
 *   handlers are arbitrary developer code we must not import into the gateway's
 *   runtime (wrong cwd, wrong deps, version skew). So installHooks synthesizes a
 *   tiny, fully self-contained ESM plugin module — { id, name, configSchema,
 *   register(api) } — that imports NOTHING from agent-connector and, on each
 *   hook firing, shells out to the ONE stable home binary's universal entrypoint
 *     <homeBin> hook openclaw <event> --connector <id>
 *   feeding the event payload on stdin and JSON.parsing the normalized
 *   HookResponse back from stdout. Fail-open: any bridge error → no-op. The same
 *   universal json-stdio dispatcher every other host uses thus serves OpenClaw.
 *
 * Plugin module shape (grounded in context-mode build/adapters/openclaw/plugin.js):
 *   export default { id, name, configSchema, register(api) }
 *   register(api) wires typed lifecycle hooks via api.on(event, handler):
 *     before_tool_call → block (return { block, blockReason }) / rewrite args
 *                        (mutate event.params in place); deny+ask both block.
 *     after_tool_call  → observe (capture result/output).
 *     session_start    → record the real session id.
 *     before_prompt_build → inject SessionStart additionalContext via
 *                        { appendSystemContext } (the verified context-injection
 *                        point; session_start itself returns no context payload).
 *   api.on() is the correct API for typed lifecycle hooks; api.registerHook() is
 *   for generic command hooks. We register defensively (api.on present check).
 *
 * Config file (JSON5 / JSONC — PARSE TOLERANTLY):
 *   user scope    → resolveOpenClawConfigPath():
 *                     $OPENCLAW_CONFIG_PATH
 *                     else $OPENCLAW_STATE_DIR/openclaw.json
 *                     else ~/.openclaw/openclaw.json
 *                   (mirrors context-mode openclawConfigPath — the file the
 *                    gateway actually loads, NOT process.cwd()).
 *   project scope → <projectDir>/openclaw.json (also supported).
 *   openclaw.json may contain comments + trailing commas (JSON5), so we NEVER
 *   use strict JSON.parse — readJson is overridden to strip comments/commas
 *   first (parseJsonish). writes are strict JSON (idempotent, comment-free).
 *
 * Plugin module location (project | user):
 *   user    → <stateDir>/extensions/<id>/index.mjs    (stateDir = dir of openclaw.json)
 *   project → <projectDir>/.openclaw/extensions/<id>/index.mjs
 *   The plugins.entries.<id> reference points at this module via its "module"
 *   field so the gateway loads it regardless of discovery defaults.
 *
 * The gateway hot-reloads its config on SIGUSR1 — no action needed here; the
 * next reload (or restart) picks up our entries/servers/module.
 *
 * Capabilities (per OpenClaw hook API):
 *   preToolUse / postToolUse / sessionStart true; transports ["stdio"].
 *   before_tool_call mutates event.params → canModifyArgs true.
 *   after_tool_call cannot rewrite the tool result → canModifyOutput false.
 *   before_prompt_build injects context → canInjectSessionContext true.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { BaseAdapter } from "../base.js";
import type {
  Adapter,
  GeneratedPluginFile,
  HookReply,
  InstallContext,
  NormalizedEvent,
} from "../spi.js";
import type {
  ChangeRecord,
  DetectedPlatform,
  HealthCheck,
  HookEventName,
  HookParadigm,
  HookResponse,
  PlatformCapabilities,
  PlatformId,
  PostToolUseEvent,
  PreToolUseEvent,
  ServerDef,
  SessionStartEvent,
} from "../../core/types.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  buildServeWrapperCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";

const HOST: PlatformId = "openclaw";

/**
 * MCP servers live nested under the top-level "mcp" object: mcp.servers.<id>
 * (NOT a top-level "mcpServers" key). plugins.entries.<id> is the second half of
 * the dual registration.
 */
const MCP_ROOT_KEY = "mcp";
const MCP_SERVERS_KEY = "servers";
const PLUGINS_KEY = "plugins";
const PLUGINS_ENTRIES_KEY = "entries";

/**
 * Canonical → OpenClaw event name map. A connector hook event is only emitted by
 * the generated plugin when it appears here AND is declared by the connector.
 *
 * SessionStart maps to OpenClaw's session_start (to learn the real session id)
 * plus before_prompt_build (the verified context-injection point — session_start
 * itself returns no context payload upstream).
 */
const EVENT_TO_OPENCLAW: Partial<Record<HookEventName, string>> = {
  PreToolUse: "before_tool_call",
  PostToolUse: "after_tool_call",
  SessionStart: "session_start",
};

/** Raw payload the generated plugin posts to the universal hook entrypoint. */
interface OpenClawBridgePayload {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  isError?: boolean;
  sessionId?: string;
  source?: string;
  projectDir?: string;
}

/** Native MCP server entry shapes OpenClaw accepts under mcp.servers.<id>. */
interface OpenClawStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** OpenClaw stdio sidecar transport (explicit for clarity). */
  transport?: "stdio";
  enabled?: boolean;
}
interface OpenClawRemoteServer {
  url: string;
  transport: "sse" | "http";
  headers?: Record<string, string>;
  enabled?: boolean;
}

/** plugins.entries.<id> reference shape. */
interface OpenClawPluginEntry {
  enabled: boolean;
  /** Absolute path to the synthesized plugin module the gateway should load. */
  module: string;
}

export class OpenClawAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "OpenClaw";
  readonly paradigm: HookParadigm = "ts-plugin";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    // OpenClaw compaction is owned by a context engine, not wired through the
    // universal bridge here.
    preCompact: false,
    sessionStart: true,
    sessionEnd: false,
    userPromptSubmit: false,
    stop: false,
    notification: false,
    // before_tool_call mutates event.params in place → input rewrite supported.
    canModifyArgs: true,
    // after_tool_call observes but cannot rewrite the tool result upstream.
    canModifyOutput: false,
    // injected via before_prompt_build at prompt assembly.
    canInjectSessionContext: true,
    // OpenClaw's MCP sidecar registration is stdio-only in practice.
    transports: ["stdio"],
  };

  // ── Tolerant JSON5/JSONC read (override base strict JSON.parse) ──────────

  /**
   * openclaw.json is officially JSON5 (comments + trailing commas allowed). A
   * strict JSON.parse false-fails a perfectly valid commented file, so we strip
   * comments and trailing commas before parsing. Writes remain strict JSON
   * (writeJson in BaseAdapter), which is itself valid JSON5 — so round-trips
   * stay safe and idempotent.
   */
  protected override readJson<T = Record<string, unknown>>(path: string): T | null {
    if (!existsSync(path)) return null;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return null;
    }
    return parseJsonish<T>(raw);
  }

  // ── Detection ──────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userConfig = resolveOpenClawConfigPath();
    const userDir = join(homedir(), ".openclaw");
    const projectConfig = join(projectDir, "openclaw.json");

    const userInstalled = existsSync(userConfig) || existsSync(userDir);
    const projInstalled = existsSync(projectConfig);
    const installed = userInstalled || projInstalled;

    const scope = projInstalled && !userInstalled ? "project" : "user";
    const configPath = scope === "project" ? projectConfig : userConfig;

    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath,
      scope,
      reason: installed
        ? scope === "project"
          ? `found project OpenClaw config at ${projectConfig}`
          : `found OpenClaw config at ${configPath}`
        : `no OpenClaw config at ${userConfig} or ${userDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ───────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? ctx.projectDir
      : dirname(resolveOpenClawConfigPath());
  }

  getServerConfigPath(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, "openclaw.json")
      : resolveOpenClawConfigPath();
  }

  /**
   * For ts-plugin hosts the "hook config path" is the generated plugin FILE.
   * OpenClaw additionally needs the plugins.entries reference written into
   * openclaw.json (handled in installHooks); this is the module on disk.
   */
  getHookConfigPath(ctx: InstallContext): string {
    return join(this.pluginDir(ctx), this.pluginFileName());
  }

  /** Extensions directory the synthesized plugin module is written into. */
  private pluginDir(ctx: InstallContext): string {
    const base =
      ctx.scope === "project"
        ? join(ctx.projectDir, ".openclaw")
        : dirname(resolveOpenClawConfigPath());
    return join(base, "extensions", ctx.connector.id);
  }

  /** Plugin module file name (ESM so the gateway loads it without a loader). */
  private pluginFileName(): string {
    return "index.mjs";
  }

  // ── MCP server install / uninstall (mcp.servers.<id>) ───────────────────

  installServer(ctx: InstallContext): ChangeRecord[] {
    const server = this.effectiveServer(ctx);
    const serverPath = this.getServerConfigPath(ctx);

    if (!server) {
      return [
        {
          platform: this.id,
          action: "skip",
          path: serverPath,
          detail: ctx.connector.server
            ? "server registration disabled for openclaw"
            : "connector declares no MCP server",
        },
      ];
    }

    const entry = this.renderServerEntry(ctx, server);
    return [this.upsertNestedServer(serverPath, ctx.connector.id, entry, ctx.dryRun)];
  }

  uninstallServer(ctx: InstallContext): ChangeRecord[] {
    const serverPath = this.getServerConfigPath(ctx);
    return [this.removeNestedServer(serverPath, ctx.connector.id, ctx.dryRun)];
  }

  /** Resolve the per-platform server override into an effective ServerDef. */
  private effectiveServer(ctx: InstallContext): ServerDef | undefined {
    const override = ctx.connector.platforms[HOST]?.server;
    if (override === false) return undefined;
    const base = ctx.connector.server;
    if (!base) return undefined;
    return override && typeof override === "object" ? { ...base, ...override } : base;
  }

  /**
   * Render a normalized ServerDef into OpenClaw's native mcp.servers.<id> entry.
   *
   * stdio  → { command, args?, env?, transport: "stdio" }
   * remote → { url, transport: "sse"|"http", headers? }
   *
   * OpenClaw documents no native ${env:VAR} token, so refs resolve to literals.
   */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): OpenClawStdioServer | OpenClawRemoteServer {
    if (server.transport === "stdio") {
      let command = server.command ?? "";
      let args = [...(server.args ?? [])];

      // Transparent telemetry wrapping: route the real command through
      // `<homeBin> serve --connector <id> -- <command> <args...>`.
      if (shouldWrapForTelemetry(server, ctx.connector.telemetry)) {
        const wrapped = buildServeWrapperCommand(
          ctx.homeBinPath,
          ctx.connector.id,
          command,
          args,
        );
        command = wrapped.command;
        args = wrapped.args;
      }

      const entry: OpenClawStdioServer = {
        command: resolveEnvRefsDeep(command),
        transport: "stdio",
      };
      const resolvedArgs = resolveEnvRefsDeep(args).filter((s) => s !== "");
      if (resolvedArgs.length > 0) entry.args = resolvedArgs;
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      if (server.enabled === false) entry.enabled = false;
      return entry;
    }

    // sse / http / ws → OpenClaw registers a remote URL sidecar.
    const transport: "sse" | "http" = server.transport === "http" ? "http" : "sse";
    const entry: OpenClawRemoteServer = {
      url: resolveEnvRefsDeep(server.url ?? ""),
      transport,
    };
    if (server.headers && Object.keys(server.headers).length > 0) {
      entry.headers = resolveEnvRefsDeep({ ...server.headers });
    }
    if (server.enabled === false) entry.enabled = false;
    return entry;
  }

  /** Resolve every ${env:VAR} in env values to literals (no native token). */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  /** Upsert config.mcp.servers.<id> idempotently. */
  private upsertNestedServer(
    path: string,
    id: string,
    entry: unknown,
    dryRun: boolean,
  ): ChangeRecord {
    const cfg = this.readJson<Record<string, unknown>>(path) ?? {};
    const servers = this.nestedServersBucket(cfg);
    const before = JSON.stringify(servers[id]);
    const after = JSON.stringify(entry);
    let action: ChangeRecord["action"];
    if (before === undefined) action = "create";
    else if (before === after) action = "skip";
    else action = "update";
    if (action !== "skip") {
      servers[id] = entry;
      this.writeJson(path, cfg, dryRun);
    }
    return {
      platform: this.id,
      action,
      path,
      detail: `${MCP_ROOT_KEY}.${MCP_SERVERS_KEY}.${id}`,
    };
  }

  /** Remove config.mcp.servers.<id>. */
  private removeNestedServer(path: string, id: string, dryRun: boolean): ChangeRecord {
    const cfg = this.readJson<Record<string, unknown>>(path);
    const mcp = cfg?.[MCP_ROOT_KEY];
    const servers =
      mcp && typeof mcp === "object" && !Array.isArray(mcp)
        ? ((mcp as Record<string, unknown>)[MCP_SERVERS_KEY] as
            | Record<string, unknown>
            | undefined)
        : undefined;
    if (!cfg || !servers || !(id in servers)) {
      return {
        platform: this.id,
        action: "skip",
        path,
        detail: `${MCP_ROOT_KEY}.${MCP_SERVERS_KEY}.${id} absent`,
      };
    }
    delete servers[id];
    this.writeJson(path, cfg, dryRun);
    return {
      platform: this.id,
      action: "remove",
      path,
      detail: `${MCP_ROOT_KEY}.${MCP_SERVERS_KEY}.${id}`,
    };
  }

  /** Get-or-create config.mcp.servers as a mutable object. */
  private nestedServersBucket(cfg: Record<string, unknown>): Record<string, unknown> {
    let mcp = cfg[MCP_ROOT_KEY];
    if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) {
      mcp = {};
      cfg[MCP_ROOT_KEY] = mcp;
    }
    const mcpObj = mcp as Record<string, unknown>;
    let servers = mcpObj[MCP_SERVERS_KEY];
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      servers = {};
      mcpObj[MCP_SERVERS_KEY] = servers;
    }
    return servers as Record<string, unknown>;
  }

  // ── Hook install / uninstall (ts-plugin + DUAL REGISTRATION) ────────────

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const pluginPath = this.getHookConfigPath(ctx);
    const configPath = this.getServerConfigPath(ctx);

    if (ctx.connector.platforms[HOST]?.hooks === false) {
      return [
        { platform: this.id, action: "skip", path: pluginPath, detail: "hooks disabled for openclaw" },
      ];
    }
    if (ctx.connector.hookEvents.length === 0) {
      return [
        { platform: this.id, action: "skip", path: pluginPath, detail: "connector declares no hooks" },
      ];
    }

    const changes: ChangeRecord[] = [];

    // 1. Write the synthesized plugin module(s).
    for (const file of this.synthesizePlugin(ctx)) {
      const before = existsSync(file.path) ? this.safeRead(file.path) : undefined;
      let action: ChangeRecord["action"];
      if (before === undefined) action = "create";
      else if (before === file.contents) action = "skip";
      else action = "update";

      if (action !== "skip" && !ctx.dryRun) {
        ensureDir(dirname(file.path));
        writeFileSync(file.path, file.contents, "utf8");
        chmodSync(file.path, file.executable ? 0o755 : 0o644);
      }
      changes.push({
        platform: this.id,
        action,
        path: file.path,
        detail: `openclaw plugin module (${ctx.connector.hookEvents.join(",")})`,
      });
    }

    // 2. DUAL REGISTRATION half (a): add plugins.entries.<id> so the gateway
    //    loads the module. (half (b), mcp.servers.<id>, is written by
    //    installServer — both are required for tools to reach the agent.)
    changes.push(this.upsertPluginEntry(configPath, ctx, pluginPath));

    return changes;
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const pluginPath = this.getHookConfigPath(ctx);
    const configPath = this.getServerConfigPath(ctx);
    const changes: ChangeRecord[] = [];

    // 1. Remove the plugins.entries.<id> reference.
    changes.push(this.removePluginEntry(configPath, ctx.connector.id, ctx.dryRun));

    // 2. Remove the plugin module on disk.
    if (existsSync(pluginPath)) {
      if (!ctx.dryRun) rmSync(pluginPath, { force: true });
      changes.push({
        platform: this.id,
        action: "remove",
        path: pluginPath,
        detail: "openclaw plugin module",
      });
    } else {
      changes.push({
        platform: this.id,
        action: "skip",
        path: pluginPath,
        detail: "no openclaw plugin module present",
      });
    }

    return changes;
  }

  /** Upsert plugins.entries.<id> = { enabled, module } idempotently. */
  private upsertPluginEntry(
    configPath: string,
    ctx: InstallContext,
    modulePath: string,
  ): ChangeRecord {
    const cfg = this.readJson<Record<string, unknown>>(configPath) ?? {};
    const entries = this.pluginEntriesBucket(cfg);
    const id = ctx.connector.id;
    const desired: OpenClawPluginEntry = { enabled: true, module: modulePath };
    const before = JSON.stringify(entries[id]);
    const after = JSON.stringify(desired);
    let action: ChangeRecord["action"];
    if (before === undefined) action = "create";
    else if (before === after) action = "skip";
    else action = "update";
    if (action !== "skip") {
      entries[id] = desired;
      this.writeJson(configPath, cfg, ctx.dryRun);
    }
    return {
      platform: this.id,
      action,
      path: configPath,
      detail: `${PLUGINS_KEY}.${PLUGINS_ENTRIES_KEY}.${id}`,
    };
  }

  /** Remove plugins.entries.<id>. */
  private removePluginEntry(configPath: string, id: string, dryRun: boolean): ChangeRecord {
    const cfg = this.readJson<Record<string, unknown>>(configPath);
    const plugins = cfg?.[PLUGINS_KEY];
    const entries =
      plugins && typeof plugins === "object" && !Array.isArray(plugins)
        ? ((plugins as Record<string, unknown>)[PLUGINS_ENTRIES_KEY] as
            | Record<string, unknown>
            | undefined)
        : undefined;
    if (!cfg || !entries || !(id in entries)) {
      return {
        platform: this.id,
        action: "skip",
        path: configPath,
        detail: `${PLUGINS_KEY}.${PLUGINS_ENTRIES_KEY}.${id} absent`,
      };
    }
    delete entries[id];
    this.writeJson(configPath, cfg, dryRun);
    return {
      platform: this.id,
      action: "remove",
      path: configPath,
      detail: `${PLUGINS_KEY}.${PLUGINS_ENTRIES_KEY}.${id}`,
    };
  }

  /** Get-or-create config.plugins.entries as a mutable object. */
  private pluginEntriesBucket(cfg: Record<string, unknown>): Record<string, unknown> {
    let plugins = cfg[PLUGINS_KEY];
    if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) {
      plugins = {};
      cfg[PLUGINS_KEY] = plugins;
    }
    const pluginsObj = plugins as Record<string, unknown>;
    let entries = pluginsObj[PLUGINS_ENTRIES_KEY];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      entries = {};
      pluginsObj[PLUGINS_ENTRIES_KEY] = entries;
    }
    return entries as Record<string, unknown>;
  }

  // ── ts-plugin synthesis ────────────────────────────────────────────────

  /**
   * Build ONE self-contained ESM plugin module for OpenClaw.
   *
   * The module imports nothing from agent-connector. It embeds two constants
   * (the absolute home-bin path and the connector id) and a `bridge()` helper
   * that shells out to the universal hook entrypoint via execFileSync, feeding
   * the OpenClaw event payload on stdin and JSON.parsing the normalized
   * HookResponse back from stdout (fail-open: any error → null). Its default
   * export is the OpenClaw plugin definition { id, name, configSchema,
   * register(api) }; register wires api.on(...) handlers for the events this
   * connector actually declares.
   */
  synthesizePlugin(ctx: InstallContext): GeneratedPluginFile[] {
    const path = this.getHookConfigPath(ctx);
    const contents = this.buildPluginSource(ctx);
    return [{ path, contents, executable: false }];
  }

  /** Compose the generated plugin source with plain string concatenation. */
  private buildPluginSource(ctx: InstallContext): string {
    const homeBin = JSON.stringify(ctx.homeBinPath);
    const connectorId = JSON.stringify(ctx.connector.id);
    const connectorName = JSON.stringify(ctx.connector.displayName || ctx.connector.id);

    const events = ctx.connector.hookEvents.filter(
      (e): e is HookEventName => EVENT_TO_OPENCLAW[e] !== undefined,
    );
    const has = (e: HookEventName) => events.includes(e);

    const header =
      "/**\n" +
      " * AUTO-GENERATED by agent-connector — DO NOT EDIT.\n" +
      " *\n" +
      " * Self-contained OpenClaw plugin bridge for connector " +
      ctx.connector.id +
      ".\n" +
      " * It imports nothing from agent-connector: every hook invocation shells out\n" +
      " * to the stable home binary's universal entrypoint and JSON-parses the\n" +
      " * normalized response. Fail-open: any bridge error degrades to a no-op.\n" +
      " *\n" +
      " * Registered via DUAL REGISTRATION in openclaw.json: plugins.entries.<id>\n" +
      " * (loads this module) + mcp.servers.<id> (surfaces the MCP tools). The\n" +
      " * gateway hot-reloads its config on SIGUSR1.\n" +
      " */\n" +
      'import { execFileSync } from "node:child_process";\n\n' +
      "const HOME_BIN = " +
      homeBin +
      ";\n" +
      "const CONNECTOR_ID = " +
      connectorId +
      ";\n\n" +
      "/**\n" +
      " * Invoke the universal hook entrypoint for one canonical event.\n" +
      " * @param {string} event canonical event name (PreToolUse|PostToolUse|SessionStart)\n" +
      " * @param {object} payload OpenClaw-shaped payload posted on stdin\n" +
      " * @returns {object|null} normalized HookResponse, or null on any failure\n" +
      " */\n" +
      "function bridge(event, payload) {\n" +
      "  try {\n" +
      "    const stdout = execFileSync(\n" +
      "      HOME_BIN,\n" +
      '      ["hook", "openclaw", event, "--connector", CONNECTOR_ID],\n' +
      '      { input: JSON.stringify(payload), encoding: "utf8" },\n' +
      "    );\n" +
      '    const text = (stdout || "").trim();\n' +
      '    if (text === "") return { decision: "allow" };\n' +
      "    return JSON.parse(text);\n" +
      "  } catch {\n" +
      "    // Fail-open — never wedge a tool call on a bridge error.\n" +
      "    return null;\n" +
      "  }\n" +
      "}\n\n" +
      "// Module-scoped context the prompt-build hook injects at session start.\n" +
      "// before_prompt_build is the verified injection point (session_start itself\n" +
      "// returns no context payload). The flag prevents double-injection.\n" +
      "let PROJECT_DIR = process.cwd();\n" +
      "let SESSION_ID = \"\";\n" +
      "let pendingContext = null;\n" +
      "let contextInjected = false;\n\n";

    // register(api) body — wire only the handlers this connector declares.
    const reg: string[] = [];

    reg.push(
      "  register(api) {\n" +
        "    PROJECT_DIR = process.cwd();\n" +
        "    const on = (event, handler) => {\n" +
        '      if (typeof api?.on === "function") {\n' +
        "        try { api.on(event, handler); return; } catch { /* fall through */ }\n" +
        "      }\n" +
        '      if (typeof api?.registerHook === "function") {\n' +
        "        try {\n" +
        '          api.registerHook(event, handler, { name: CONNECTOR_ID + ":" + event, description: "agent-connector bridge" });\n' +
        "        } catch { /* best effort */ }\n" +
        "      }\n" +
        "    };\n",
    );

    if (has("PreToolUse")) {
      reg.push(
        "\n" +
          "    // PreToolUse → before_tool_call: block (return { block, blockReason })\n" +
          "    // for deny/ask; rewrite args by mutating event.params in place for modify.\n" +
          '    on("before_tool_call", async (event) => {\n' +
          "      const e = event || {};\n" +
          "      const toolInput = e.params || {};\n" +
          "      const res = bridge(\"PreToolUse\", {\n" +
          '        toolName: e.toolName || "",\n' +
          "        toolInput,\n" +
          "        sessionId: SESSION_ID,\n" +
          "        projectDir: PROJECT_DIR,\n" +
          "      });\n" +
          "      if (!res) return undefined;\n" +
          "      // OpenClaw has no separate ask gate — deny and ask both block (safe).\n" +
          '      if (res.decision === "deny" || res.decision === "ask") {\n' +
          '        return { block: true, blockReason: res.reason || ("Blocked by " + CONNECTOR_ID) };\n' +
          "      }\n" +
          '      if (res.decision === "modify" && res.updatedInput && typeof toolInput === "object") {\n' +
          "        Object.assign(toolInput, res.updatedInput);\n" +
          "      }\n" +
          "      return undefined;\n" +
          "    });\n",
      );
    }

    if (has("PostToolUse")) {
      reg.push(
        "\n" +
          "    // PostToolUse → after_tool_call: observe the completed tool call.\n" +
          "    // OpenClaw exposes the result (v2+) or output (older builds); it cannot\n" +
          "    // rewrite the tool result, so updatedOutput is intentionally dropped.\n" +
          '    on("after_tool_call", async (event) => {\n' +
          "      const e = event || {};\n" +
          "      const rawResult = e.result !== undefined ? e.result : e.output;\n" +
          "      const toolOutput =\n" +
          '        typeof rawResult === "string"\n' +
          "          ? rawResult\n" +
          "          : rawResult != null\n" +
          "            ? JSON.stringify(rawResult)\n" +
          "            : undefined;\n" +
          "      bridge(\"PostToolUse\", {\n" +
          '        toolName: e.toolName || "",\n' +
          "        toolInput: e.params || {},\n" +
          "        toolOutput,\n" +
          "        isError: Boolean(e.error || e.isError),\n" +
          "        sessionId: SESSION_ID,\n" +
          "        projectDir: PROJECT_DIR,\n" +
          "      });\n" +
          "      return undefined;\n" +
          "    });\n",
      );
    }

    if (has("SessionStart")) {
      reg.push(
        "\n" +
          "    // SessionStart → session_start records the real session id and fetches\n" +
          "    // the additionalContext to inject; before_prompt_build performs the\n" +
          "    // injection (the verified context-injection point upstream).\n" +
          '    on("session_start", async (event) => {\n' +
          "      const e = event || {};\n" +
          "      SESSION_ID = e.sessionId || e.sessionKey || SESSION_ID;\n" +
          "      const res = bridge(\"SessionStart\", {\n" +
          "        sessionId: SESSION_ID,\n" +
          '        source: e.resumedFrom ? "resume" : "startup",\n' +
          "        projectDir: PROJECT_DIR,\n" +
          "      });\n" +
          "      contextInjected = false;\n" +
          "      pendingContext =\n" +
          '        res && typeof res.additionalContext === "string" && res.additionalContext\n' +
          "          ? res.additionalContext\n" +
          "          : null;\n" +
          "      return undefined;\n" +
          "    });\n" +
          "\n" +
          "    // Inject the session-start context once, at prompt-build time.\n" +
          '    on("before_prompt_build", () => {\n' +
          "      if (contextInjected || !pendingContext) return undefined;\n" +
          "      contextInjected = true;\n" +
          "      return { appendSystemContext: pendingContext };\n" +
          "    });\n",
      );
    }

    reg.push("  },\n");

    const definition =
      "const plugin = {\n" +
      "  id: CONNECTOR_ID,\n" +
      "  name: " +
      connectorName +
      ",\n" +
      "  configSchema: {\n" +
      '    type: "object",\n' +
      "    properties: {\n" +
      "      enabled: {\n" +
      '        type: "boolean",\n' +
      "        default: true,\n" +
      '        description: "Enable or disable the " + CONNECTOR_ID + " plugin.",\n' +
      "      },\n" +
      "    },\n" +
      "    additionalProperties: false,\n" +
      "  },\n" +
      reg.join("") +
      "};\n\n" +
      "export default plugin;\n";

    return header + definition;
  }

  // ── Runtime: parse OUR bridge payload → normalized event ───────────────

  /**
   * `raw` is the payload OUR generated plugin posts (NOT a host-native shape):
   *   { toolName, toolInput, toolOutput?, isError?, sessionId, source?, projectDir }
   * so this maps straight through.
   */
  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as OpenClawBridgePayload;
    const base = {
      hostPlatform: HOST,
      connectorId: "",
      sessionId: typeof input.sessionId === "string" ? input.sessionId : "",
      raw,
      ...(typeof input.projectDir === "string" ? { projectDir: input.projectDir } : {}),
    } as const;

    switch (event) {
      case "PreToolUse": {
        const ev: PreToolUseEvent = {
          ...base,
          toolName: input.toolName ?? "",
          toolInput: input.toolInput ?? {},
        };
        return ev;
      }
      case "PostToolUse": {
        const ev: PostToolUseEvent = {
          ...base,
          toolName: input.toolName ?? "",
          toolInput: input.toolInput ?? {},
          ...(typeof input.toolOutput === "string" ? { toolOutput: input.toolOutput } : {}),
          ...(typeof input.isError === "boolean" ? { isError: input.isError } : {}),
        };
        return ev;
      }
      case "SessionStart": {
        const source: SessionStartEvent["source"] =
          input.source === "resume"
            ? "resume"
            : input.source === "compact"
              ? "compact"
              : input.source === "clear"
                ? "clear"
                : "startup";
        const ev: SessionStartEvent = { ...base, source };
        return ev;
      }
      default:
        // Other canonical events are not surfaced by OpenClaw; treat as a
        // session-start-shaped no-op so the dispatcher fails open gracefully.
        return { ...base, source: "startup" } satisfies SessionStartEvent;
    }
  }

  // ── Runtime: normalized response → reply the generated bridge parses ───

  /**
   * Unlike json-stdio hosts (whose reply is the host's NATIVE control payload),
   * OUR generated bridge consumes this stdout directly. So the reply body is the
   * NORMALIZED HookResponse itself — the bridge JSON.parses it and reads
   * decision / updatedInput / additionalContext.
   */
  formatReply(_event: HookEventName, response: HookResponse): HookReply {
    return {
      exitCode: 0,
      stdout: JSON.stringify(response ?? { decision: "allow" }),
    };
  }

  // ── Diagnostics ────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const configPath = this.getServerConfigPath(ctx);
    const pluginPath = this.getHookConfigPath(ctx);
    const id = ctx.connector.id;
    const hasHooks = ctx.connector.hookEvents.length > 0;
    const hasServer = Boolean(ctx.connector.server);

    return [
      {
        name: `${this.name}: openclaw.json present`,
        check: () =>
          existsSync(configPath)
            ? { status: "OK", detail: configPath }
            : { status: "FAIL", detail: `not found: ${configPath}` },
      },
      {
        // HARDEST PART — dual registration must be CONSISTENT. The plugin only
        // delivers tools when it is in BOTH plugins.entries AND mcp.servers. A
        // config with one but not the other is a tool-less (or never-loaded)
        // install, so FAIL on entries XOR mcp.servers.
        name: `${this.name}: dual registration (plugins.entries + mcp.servers.${id})`,
        check: () => {
          const cfg = this.readJson<Record<string, unknown>>(configPath);
          if (!cfg) return { status: "FAIL", detail: `cannot read ${configPath}` };

          const inEntries = this.hasPluginEntry(cfg, id);
          const inMcp = this.hasMcpServer(cfg, id);

          // A hooks-only connector (no MCP server declared) does not need the
          // mcp.servers half — entries alone is correct and complete.
          if (!hasServer) {
            return inEntries || !hasHooks
              ? { status: "OK", detail: "hooks-only connector (no MCP server)" }
              : {
                  status: "FAIL",
                  detail: `no ${PLUGINS_KEY}.${PLUGINS_ENTRIES_KEY}.${id} (plugin will not load)`,
                };
          }

          if (inEntries && inMcp) {
            return {
              status: "OK",
              detail: `${PLUGINS_KEY}.${PLUGINS_ENTRIES_KEY}.${id} + ${MCP_ROOT_KEY}.${MCP_SERVERS_KEY}.${id}`,
            };
          }
          if (inEntries && !inMcp) {
            return {
              status: "FAIL",
              detail: `in ${PLUGINS_KEY}.${PLUGINS_ENTRIES_KEY} but missing from ${MCP_ROOT_KEY}.${MCP_SERVERS_KEY} — plugin loads but no tools reach the agent`,
            };
          }
          if (!inEntries && inMcp) {
            return {
              status: "FAIL",
              detail: `in ${MCP_ROOT_KEY}.${MCP_SERVERS_KEY} but missing from ${PLUGINS_KEY}.${PLUGINS_ENTRIES_KEY} — tools declared but plugin never loads`,
            };
          }
          return {
            status: "FAIL",
            detail: `not registered in ${PLUGINS_KEY}.${PLUGINS_ENTRIES_KEY} or ${MCP_ROOT_KEY}.${MCP_SERVERS_KEY}`,
          };
        },
      },
      {
        name: `${this.name}: plugin module present`,
        check: () => {
          if (!hasHooks) return { status: "OK", detail: "no hooks declared" };
          return existsSync(pluginPath)
            ? { status: "OK", detail: pluginPath }
            : { status: "FAIL", detail: `not found: ${pluginPath}` };
        },
      },
    ];
  }

  /** True when config.plugins.entries.<id> exists. */
  private hasPluginEntry(cfg: Record<string, unknown>, id: string): boolean {
    const plugins = cfg[PLUGINS_KEY];
    if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return false;
    const entries = (plugins as Record<string, unknown>)[PLUGINS_ENTRIES_KEY];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return false;
    return id in (entries as Record<string, unknown>);
  }

  /** True when config.mcp.servers.<id> exists. */
  private hasMcpServer(cfg: Record<string, unknown>, id: string): boolean {
    const mcp = cfg[MCP_ROOT_KEY];
    if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return false;
    const servers = (mcp as Record<string, unknown>)[MCP_SERVERS_KEY];
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return false;
    return id in (servers as Record<string, unknown>);
  }

  /** Read a file, returning undefined on any error (idempotency compare). */
  private safeRead(path: string): string | undefined {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  }
}

/**
 * Resolve the openclaw.json the gateway actually loads (mirrors context-mode's
 * openclawConfigPath): $OPENCLAW_CONFIG_PATH, else $OPENCLAW_STATE_DIR/openclaw.json,
 * else ~/.openclaw/openclaw.json. The gateway never loads a CWD/project-local
 * openclaw.json for user scope, so this is the canonical user-scope path.
 */
function resolveOpenClawConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCLAW_CONFIG_PATH) return resolve(env.OPENCLAW_CONFIG_PATH);
  const stateDir = env.OPENCLAW_STATE_DIR
    ? resolve(env.OPENCLAW_STATE_DIR)
    : resolve(homedir(), ".openclaw");
  return resolve(stateDir, "openclaw.json");
}

/**
 * Tolerant JSON5/JSONC parse: strip // and /* *\/ comments and trailing commas,
 * skipping anything inside string literals, then JSON.parse. Returns null on any
 * failure. openclaw.json is officially JSON5, so strict JSON.parse must never be
 * used on it.
 */
function parseJsonish<T>(raw: string): T | null {
  try {
    return JSON.parse(stripJsonish(raw)) as T;
  } catch {
    return null;
  }
}

/** Remove comments and trailing commas from JSONC/JSON5 text (string-aware). */
function stripJsonish(input: string): string {
  let out = "";
  let i = 0;
  const n = input.length;
  let inString = false;
  let quote = "";

  while (i < n) {
    const ch = input[i] as string;
    const next = i + 1 < n ? (input[i + 1] as string) : "";

    if (inString) {
      out += ch;
      if (ch === "\\") {
        // Copy the escaped char verbatim.
        if (i + 1 < n) {
          out += input[i + 1] as string;
          i += 2;
          continue;
        }
      } else if (ch === quote) {
        inString = false;
      }
      i += 1;
      continue;
    }

    // Not in a string.
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      // Line comment — skip to end of line.
      i += 2;
      while (i < n && input[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      // Block comment — skip to closing */.
      i += 2;
      while (i < n && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }

  // Remove trailing commas before } or ] (JSON5 allows them; strict JSON does not).
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Create a directory (recursive) if it does not already exist. */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export const adapter = new OpenClawAdapter();
export default adapter;
