/**
 * adapters/openclaw — OpenClaw (Gateway) platform adapter for agent-connector.
 *
 * OpenClaw is a **ts-plugin** host, but with a twist no other ts-plugin host
 * has: a plugin only delivers its MCP tools to the agent when it is registered
 * in TWO places at once (DUAL REGISTRATION):
 *
 *   (a) plugins.entries.<id> = { enabled: true }  + plugins.load.paths: [dir]
 *                                — so the gateway DISCOVERS and LOADS the plugin
 *                                module (runs register(api), wiring the hooks).
 *                                NOTE: the entry is { enabled } only — a per-entry
 *                                `module` field is rejected by `openclaw config
 *                                validate`, so discovery goes through the
 *                                plugins.load.paths dir scan instead; and
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
 *   first via the shared core/jsonc parseJsonc. writes are strict JSON
 *   (idempotent, comment-free).
 *
 * Plugin module location (project | user):
 *   user    → <stateDir>/extensions/<id>/index.mjs    (stateDir = dir of openclaw.json)
 *   project → <projectDir>/.openclaw/extensions/<id>/index.mjs
 *   Beside index.mjs we also emit an openclaw.plugin.json manifest. The plugin's
 *   DIRECTORY (not the file) is added to plugins.load.paths so the gateway scans
 *   it and loads the module; the plugins.entries.<id> = { enabled: true } half
 *   then activates it. (There is no per-entry "module" field — validate rejects it.)
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
import { parseJsonc } from "../../core/jsonc.js";
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
 * The gateway discovers a synthesized plugin module by scanning the directories
 * listed in plugins.load.paths — it does NOT take a per-entry `module` field
 * (that fails `openclaw config validate`). We add the plugin's own dir here.
 */
const PLUGINS_LOAD_KEY = "load";
const PLUGINS_LOAD_PATHS_KEY = "paths";
/** Manifest the gateway reads inside a plugins.load.paths directory. */
const PLUGIN_MANIFEST_FILE = "openclaw.plugin.json";

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

/**
 * plugins.entries.<id> reference shape.
 *
 * `openclaw config validate` REJECTS a `module` field here (it is not part of
 * the entry schema), so the entry is `{ enabled: true }` ONLY. Discovery of the
 * synthesized module is wired separately via `plugins.load.paths` (the dir that
 * holds the module + its openclaw.plugin.json manifest).
 */
interface OpenClawPluginEntry {
  enabled: boolean;
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
    try {
      // Shared, string-aware JSONC stripper (the local stripJsonish whose
      // trailing-comma regex corrupted in-string ",]"/",}"-like values is gone).
      return parseJsonc<T>(raw);
    } catch {
      return null;
    }
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
          ctx.scope,
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
    // OVERWRITE GUARD: never blank a present-but-unparseable openclaw.json.
    if (this.isPresentButUnparseable(path)) {
      return {
        platform: this.id,
        action: "warn",
        path,
        detail: `existing ${path} is not parseable; left untouched (back it up / fix it, then re-run)`,
      };
    }
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
        detail: `openclaw plugin module (${this.hookDetail(ctx)})`,
      });
    }

    // 2. DUAL REGISTRATION half (a): enable plugins.entries.<id> AND add the
    //    plugin DIR to plugins.load.paths so the gateway discovers + loads the
    //    module. (half (b), mcp.servers.<id>, is written by installServer — both
    //    are required for tools to reach the agent.)
    changes.push(this.upsertPluginEntry(configPath, ctx, this.pluginDir(ctx)));

    return changes;
  }

  /**
   * Human-facing summary of which declared events the synthesized module ACTUALLY
   * wires. Only events present in EVENT_TO_OPENCLAW are mapped/wired; any declared
   * event with no OpenClaw mapping (e.g. UserPromptSubmit) is reported separately
   * as "unsupported here" so the detail never overstates coverage.
   */
  private hookDetail(ctx: InstallContext): string {
    const declared = ctx.connector.hookEvents;
    const mapped = declared.filter((e) => EVENT_TO_OPENCLAW[e] !== undefined);
    const unsupported = declared.filter((e) => EVENT_TO_OPENCLAW[e] === undefined);
    const base = mapped.join(",");
    return unsupported.length > 0
      ? `${base}; unsupported here: ${unsupported.join(",")}`
      : base;
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const pluginPath = this.getHookConfigPath(ctx);
    const configPath = this.getServerConfigPath(ctx);
    const changes: ChangeRecord[] = [];

    // 1. Remove the plugins.entries.<id> reference AND drop the plugin dir from
    //    plugins.load.paths.
    changes.push(
      this.removePluginEntry(configPath, ctx.connector.id, this.pluginDir(ctx), ctx.dryRun),
    );

    // 2. Remove the plugin module + its manifest on disk.
    const manifestPath = join(this.pluginDir(ctx), PLUGIN_MANIFEST_FILE);
    for (const [path, label] of [
      [pluginPath, "openclaw plugin module"],
      [manifestPath, "openclaw plugin manifest"],
    ] as const) {
      if (existsSync(path)) {
        if (!ctx.dryRun) rmSync(path, { force: true });
        changes.push({ platform: this.id, action: "remove", path, detail: label });
      } else {
        changes.push({
          platform: this.id,
          action: "skip",
          path,
          detail: `no ${label} present`,
        });
      }
    }

    // 3. Drop the now-empty plugin dir (only if WE own its full contents).
    changes.push(this.removeDirIfEmpty(this.pluginDir(ctx), ctx.dryRun));

    return changes;
  }

  /**
   * Upsert plugins.entries.<id> = { enabled: true } AND add `pluginDir` to
   * plugins.load.paths idempotently.
   *
   * `openclaw config validate` rejects a per-entry `module` field, so the entry
   * carries ONLY `{ enabled: true }`. The gateway discovers the synthesized
   * module by scanning the directories in plugins.load.paths (the dir holding
   * index.mjs + openclaw.plugin.json), so the dir is added there.
   */
  private upsertPluginEntry(
    configPath: string,
    ctx: InstallContext,
    pluginDir: string,
  ): ChangeRecord {
    // OVERWRITE GUARD: never blank a present-but-unparseable openclaw.json.
    if (this.isPresentButUnparseable(configPath)) {
      return {
        platform: this.id,
        action: "warn",
        path: configPath,
        detail: `existing ${configPath} is not parseable; left untouched (back it up / fix it, then re-run)`,
      };
    }
    const cfg = this.readJson<Record<string, unknown>>(configPath) ?? {};
    const entries = this.pluginEntriesBucket(cfg);
    const id = ctx.connector.id;
    const desired: OpenClawPluginEntry = { enabled: true };
    const entryBefore = JSON.stringify(entries[id]);
    const entryAfter = JSON.stringify(desired);

    // plugins.load.paths: add the plugin dir if absent.
    const loadPaths = this.pluginLoadPathsBucket(cfg);
    const pathPresent = loadPaths.includes(pluginDir);

    const entryChanged = entryBefore !== entryAfter;
    const pathChanged = !pathPresent;
    let action: ChangeRecord["action"];
    if (entryBefore === undefined) action = "create";
    else if (!entryChanged && !pathChanged) action = "skip";
    else action = "update";

    if (action !== "skip") {
      entries[id] = desired;
      if (!pathPresent) loadPaths.push(pluginDir);
      this.writeJson(configPath, cfg, ctx.dryRun);
    }
    return {
      platform: this.id,
      action,
      path: configPath,
      detail: `${PLUGINS_KEY}.${PLUGINS_ENTRIES_KEY}.${id} + ${PLUGINS_KEY}.${PLUGINS_LOAD_KEY}.${PLUGINS_LOAD_PATHS_KEY}`,
    };
  }

  /** Remove plugins.entries.<id> AND drop `pluginDir` from plugins.load.paths. */
  private removePluginEntry(
    configPath: string,
    id: string,
    pluginDir: string,
    dryRun: boolean,
  ): ChangeRecord {
    const cfg = this.readJson<Record<string, unknown>>(configPath);
    const plugins = cfg?.[PLUGINS_KEY];
    const pluginsObj =
      plugins && typeof plugins === "object" && !Array.isArray(plugins)
        ? (plugins as Record<string, unknown>)
        : undefined;
    const entries = pluginsObj?.[PLUGINS_ENTRIES_KEY] as
      | Record<string, unknown>
      | undefined;
    const load = pluginsObj?.[PLUGINS_LOAD_KEY] as Record<string, unknown> | undefined;
    const loadPaths =
      load && Array.isArray(load[PLUGINS_LOAD_PATHS_KEY])
        ? (load[PLUGINS_LOAD_PATHS_KEY] as unknown[])
        : undefined;

    const entryPresent = Boolean(entries && id in entries);
    const pathIdx = loadPaths ? loadPaths.indexOf(pluginDir) : -1;

    if (!cfg || (!entryPresent && pathIdx < 0)) {
      return {
        platform: this.id,
        action: "skip",
        path: configPath,
        detail: `${PLUGINS_KEY}.${PLUGINS_ENTRIES_KEY}.${id} absent`,
      };
    }
    if (entryPresent && entries) delete entries[id];
    if (loadPaths && pathIdx >= 0) loadPaths.splice(pathIdx, 1);
    this.writeJson(configPath, cfg, dryRun);
    return {
      platform: this.id,
      action: "remove",
      path: configPath,
      detail: `${PLUGINS_KEY}.${PLUGINS_ENTRIES_KEY}.${id} + ${PLUGINS_KEY}.${PLUGINS_LOAD_KEY}.${PLUGINS_LOAD_PATHS_KEY}`,
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

  /** Get-or-create config.plugins.load.paths as a mutable string array. */
  private pluginLoadPathsBucket(cfg: Record<string, unknown>): string[] {
    let plugins = cfg[PLUGINS_KEY];
    if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) {
      plugins = {};
      cfg[PLUGINS_KEY] = plugins;
    }
    const pluginsObj = plugins as Record<string, unknown>;
    let load = pluginsObj[PLUGINS_LOAD_KEY];
    if (!load || typeof load !== "object" || Array.isArray(load)) {
      load = {};
      pluginsObj[PLUGINS_LOAD_KEY] = load;
    }
    const loadObj = load as Record<string, unknown>;
    const existing = loadObj[PLUGINS_LOAD_PATHS_KEY];
    // Normalize to a fresh string[] (drop any non-string a user may have placed
    // here) and write it back so the caller mutates the live array.
    const paths = Array.isArray(existing)
      ? existing.filter((p): p is string => typeof p === "string")
      : [];
    loadObj[PLUGINS_LOAD_PATHS_KEY] = paths;
    return paths;
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
    // The gateway scans plugins.load.paths dirs for a manifest, so emit an
    // openclaw.plugin.json beside index.mjs pointing at the module entry.
    const manifestPath = join(this.pluginDir(ctx), PLUGIN_MANIFEST_FILE);
    const manifest = this.buildPluginManifest(ctx);
    return [
      { path, contents, executable: false },
      { path: manifestPath, contents: manifest, executable: false },
    ];
  }

  /**
   * Build the openclaw.plugin.json manifest the gateway reads inside a
   * plugins.load.paths directory. It names the plugin and points at the ESM
   * module entry (index.mjs) so the loader knows what to import.
   */
  private buildPluginManifest(ctx: InstallContext): string {
    const manifest = {
      id: ctx.connector.id,
      name: ctx.connector.displayName || ctx.connector.id,
      main: this.pluginFileName(),
      enabled: true,
    };
    return `${JSON.stringify(manifest, null, 2)}\n`;
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
    const pluginDir = this.pluginDir(ctx);
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
        // delivers tools when it is LOADED (plugins.entries.<id> enabled AND its
        // dir in plugins.load.paths) AND in mcp.servers. A config with one half
        // but not the other is a tool-less (or never-loaded) install, so FAIL on
        // loaded XOR mcp.servers. (We assert plugins.load.paths — NOT a per-entry
        // `module` field, which openclaw config validate rejects.)
        name: `${this.name}: dual registration (plugins.entries+load.paths + mcp.servers.${id})`,
        check: () => {
          const cfg = this.readJson<Record<string, unknown>>(configPath);
          if (!cfg) return { status: "FAIL", detail: `cannot read ${configPath}` };

          const inEntries = this.hasPluginEntry(cfg, id) && this.hasLoadPath(cfg, pluginDir);
          const inMcp = this.hasMcpServer(cfg, id);

          // A hooks-only connector (no MCP server declared) does not need the
          // mcp.servers half — the load half alone is correct and complete.
          if (!hasServer) {
            return inEntries || !hasHooks
              ? { status: "OK", detail: "hooks-only connector (no MCP server)" }
              : {
                  status: "FAIL",
                  detail: `${id} not enabled in ${PLUGINS_KEY}.${PLUGINS_ENTRIES_KEY} + ${PLUGINS_KEY}.${PLUGINS_LOAD_KEY}.${PLUGINS_LOAD_PATHS_KEY} (plugin will not load)`,
                };
          }

          if (inEntries && inMcp) {
            return {
              status: "OK",
              detail: `${PLUGINS_KEY}.${PLUGINS_ENTRIES_KEY}.${id}+${PLUGINS_KEY}.${PLUGINS_LOAD_KEY}.${PLUGINS_LOAD_PATHS_KEY} + ${MCP_ROOT_KEY}.${MCP_SERVERS_KEY}.${id}`,
            };
          }
          if (inEntries && !inMcp) {
            return {
              status: "FAIL",
              detail: `loaded (${PLUGINS_KEY}.${PLUGINS_ENTRIES_KEY}+${PLUGINS_LOAD_KEY}.${PLUGINS_LOAD_PATHS_KEY}) but missing from ${MCP_ROOT_KEY}.${MCP_SERVERS_KEY} — plugin loads but no tools reach the agent`,
            };
          }
          if (!inEntries && inMcp) {
            return {
              status: "FAIL",
              detail: `in ${MCP_ROOT_KEY}.${MCP_SERVERS_KEY} but not loaded (missing ${PLUGINS_KEY}.${PLUGINS_ENTRIES_KEY} or ${PLUGINS_LOAD_KEY}.${PLUGINS_LOAD_PATHS_KEY}) — tools declared but plugin never loads`,
            };
          }
          return {
            status: "FAIL",
            detail: `not loaded (${PLUGINS_KEY}.${PLUGINS_ENTRIES_KEY}+${PLUGINS_LOAD_KEY}.${PLUGINS_LOAD_PATHS_KEY}) and not in ${MCP_ROOT_KEY}.${MCP_SERVERS_KEY}`,
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

  /** True when config.plugins.entries.<id> exists (and is not disabled). */
  private hasPluginEntry(cfg: Record<string, unknown>, id: string): boolean {
    const plugins = cfg[PLUGINS_KEY];
    if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return false;
    const entries = (plugins as Record<string, unknown>)[PLUGINS_ENTRIES_KEY];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return false;
    const entry = (entries as Record<string, unknown>)[id];
    if (entry === undefined) return false;
    // An explicit { enabled: false } means the gateway will not load it.
    return !(
      entry &&
      typeof entry === "object" &&
      (entry as Record<string, unknown>).enabled === false
    );
  }

  /** True when config.plugins.load.paths includes `pluginDir`. */
  private hasLoadPath(cfg: Record<string, unknown>, pluginDir: string): boolean {
    const plugins = cfg[PLUGINS_KEY];
    if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return false;
    const load = (plugins as Record<string, unknown>)[PLUGINS_LOAD_KEY];
    if (!load || typeof load !== "object" || Array.isArray(load)) return false;
    const paths = (load as Record<string, unknown>)[PLUGINS_LOAD_PATHS_KEY];
    return Array.isArray(paths) && paths.includes(pluginDir);
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

/** Create a directory (recursive) if it does not already exist. */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export const adapter = new OpenClawAdapter();
export default adapter;
