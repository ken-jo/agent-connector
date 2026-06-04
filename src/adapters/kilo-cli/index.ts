/**
 * adapters/kilo-cli — Kilo CLI platform adapter for agent-connector.
 *
 * The Kilo CLI (the `kilo` binary) is a **live-confirmed OpenCode fork**: a
 * SQLite-backed command-line agent (storage `~/.local/share/kilo/kilo.db`) that
 * loads `@kilocode/plugin` modules. It is DISTINCT from the Kilo Code VS Code
 * extension (adapter id "kilo", a Roo/Cline fork) — the two products carry
 * different platformIds so their config and usage never merge.
 *
 * Paradigm — **ts-plugin** (mirrors the OpenCode adapter):
 *   The fork has no JSON hook table. Instead it loads JS/TS plugin modules whose
 *   default export is a `@kilocode/plugin` PluginModule:
 *     { id?, server: async (input) => Hooks }
 *   where the returned `Hooks` object is keyed by the fork's event names
 *   ("tool.execute.before", "tool.execute.after", a session/system event). The
 *   `server` factory runs in-process inside Kilo and is handed mutable args/output
 *   objects; it throws to block a tool call.
 *
 * Why we BRIDGE instead of importing handlers (identical rationale to OpenCode):
 *   the connector's hook handlers are arbitrary developer code we must not import
 *   into Kilo's runtime (wrong cwd, wrong deps, version skew). So instead of
 *   importing handlers we synthesize a tiny, fully self-contained ESM plugin
 *   module that imports NOTHING from agent-connector and, on each hook firing,
 *   shells out to the ONE stable home binary's universal entrypoint
 *     <homeBin> hook kilo-cli <event> --connector <id>
 *   feeding the event payload on stdin and JSON.parsing the normalized
 *   HookResponse back from stdout. Fail-open: any bridge error → no-op.
 *
 * Registration (the key difference from OpenCode):
 *   OpenCode auto-discovers every file in its plugin dir, so writing the file is
 *   enough. This fork does NOT auto-discover by directory — it reads an explicit
 *   `plugin` ARRAY in kilo.jsonc (module file paths). So installHooks must BOTH
 *   synthesize the module AND register its path in that `plugin` array; uninstall
 *   reverses both.
 *
 * Plugin module location (project | user):
 *   user    → ~/.config/kilo/plugin/<id>.js
 *   project → <projectDir>/.kilo/plugin/<id>.js
 *
 * MCP config (the CLI's new-gen dialect — already correct, KEPT verbatim):
 *   - user scope    → ~/.config/kilo/kilo.jsonc
 *   - project scope → <projectDir>/.kilo/kilo.jsonc   (project overrides global)
 *   Both are JSON/JSONC; we write plain JSON, which is valid JSONC. The root key
 *   is "mcp" (NOT the extension's "mcpServers").
 *
 * Server entry shape (mirrors OpenCode's new-gen dialect):
 *   - stdio  → { type: "local",  command: [exe, ...args], environment: {...} }
 *              NOTE the command is a single ARRAY (exe + args together), unlike
 *              Claude/Cursor's scalar `command` + `args[]` split.
 *   - remote → { type: "remote", url }
 *
 * The Kilo CLI documents no native `${env:VAR}` interpolation token, so env/url
 * refs are resolved to literals at install time (the no-native-token path).
 *
 * Content surfaces: the Kilo CLI exposes no confirmed writable command/skill/
 * subagent dir (the `.kilocode/` tree belongs to the VS Code extension, served
 * by the "kilo" adapter), so those inherit the BaseAdapter warn/skip.
 *
 * Capability degradations (documented, never thrown):
 *   - The fork has no "ask" gate. A decision of "ask" degrades to a block (throw
 *     with the reason) in tool.execute.before — the safe direction.
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
import { dirname, join } from "node:path";

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
  Transport,
} from "../../core/types.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  buildServeWrapperCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";

const HOST: PlatformId = "kilo-cli";
/** New-generation root key for MCP servers — "mcp", not the extension's "mcpServers". */
const MCP_ROOT_KEY = "mcp";
/** kilo.jsonc array of plugin module paths the fork loads (NOT auto-discovery). */
const PLUGIN_ARRAY_KEY = "plugin";
/** New-generation config filename (JSON/JSONC). */
const CONFIG_FILE = "kilo.jsonc";
/** The Kilo CLI's SQLite session store — a CLI-exclusive detection marker. */
const CLI_DB_RELPATH = [".local", "share", "kilo", "kilo.db"] as const;

/**
 * Canonical → Kilo (OpenCode-fork) event name map. A connector hook event is
 * only emitted by the generated plugin when it appears here AND is declared by
 * the connector.
 *
 * The fork inherits OpenCode's tool-execution events; like OpenCode it has no
 * real SessionStart hook, so SessionStart maps to the same system-prompt
 * transform surrogate (the verified context-injection point) — we inject
 * additionalContext into the system prompt there.
 */
const EVENT_TO_KILO: Partial<Record<HookEventName, string>> = {
  PreToolUse: "tool.execute.before",
  PostToolUse: "tool.execute.after",
  SessionStart: "experimental.chat.system.transform",
};

/** Raw payload the generated plugin posts to the universal hook entrypoint. */
interface KiloBridgePayload {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  isError?: boolean;
  sessionId?: string;
  projectDir?: string;
}

/**
 * Native MCP server entry shapes the Kilo CLI's new-gen config accepts under
 * `mcp`. QUIRK: a local (stdio) server keys its whole invocation as
 * `command: [...]` — a single array of [executable, ...args] — and env as
 * `environment`.
 */
interface KiloLocalServer {
  type: "local";
  command: string[];
  environment?: Record<string, string>;
}
interface KiloRemoteServer {
  type: "remote";
  url: string;
}

export class KiloCliAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Kilo CLI";
  readonly paradigm: HookParadigm = "ts-plugin";

  readonly capabilities: PlatformCapabilities = {
    // Matches the OpenCode capability surface — the fork inherits its plugin
    // event model.
    preToolUse: true,
    postToolUse: true,
    // The fork's compaction hook is experimental and not wired here.
    preCompact: false,
    sessionStart: true,
    sessionEnd: false,
    userPromptSubmit: false,
    stop: false,
    notification: false,
    // tool.execute.before mutates output.args → input rewrite supported.
    canModifyArgs: true,
    // tool.execute.after mutates output.output → output rewrite supported.
    canModifyOutput: true,
    // injected via the system-prompt transform at session start.
    canInjectSessionContext: true,
    // The Kilo CLI registers stdio (local), SSE, and Streamable HTTP MCP servers.
    transports: ["stdio", "sse", "http"],
    // No confirmed CLI content surface — these inherit the BaseAdapter warn/skip.
    supportsCommands: false,
    supportsSkills: false,
    supportsSubagents: false,
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".config", "kilo");
    const userConfig = join(userDir, CONFIG_FILE);
    const projectConfig = join(projectDir, ".kilo", CONFIG_FILE);
    // The SQLite session DB is a CLI-exclusive marker (the VS Code extension
    // never writes it), so it disambiguates the CLI from the "kilo" extension
    // even when neither writes a kilo.jsonc yet.
    const cliDb = join(homedir(), ...CLI_DB_RELPATH);
    const userInstalled = existsSync(userDir) || existsSync(cliDb);
    const projInstalled = existsSync(projectConfig);
    const installed = userInstalled || projInstalled;
    // Report the scope/path/reason for the marker that actually matched, so a
    // project-only install isn't misreported as a (non-existent) user install.
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
          ? `found project Kilo CLI config at ${projectConfig}`
          : existsSync(cliDb)
            ? `found Kilo CLI session store at ${cliDb}`
            : `found Kilo CLI config under ${userDir}`
        : `no Kilo CLI config at ${userDir} or session store at ${cliDb}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".kilo")
      : join(homedir(), ".config", "kilo");
  }

  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), CONFIG_FILE);
  }

  /**
   * For ts-plugin hosts the "hook config path" is the generated plugin FILE.
   * Unlike OpenCode, writing the file is NOT sufficient: the fork loads only the
   * module paths listed in kilo.jsonc's `plugin` array, so installHooks also
   * registers this path there.
   */
  getHookConfigPath(ctx: InstallContext): string {
    return join(this.pluginDir(ctx), this.pluginFileName(ctx));
  }

  /** Plugin directory the synthesized module is written into, per scope. */
  private pluginDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".kilo", "plugin")
      : join(homedir(), ".config", "kilo", "plugin");
  }

  /** Plugin module file name (one per connector, kebab-case id). */
  private pluginFileName(ctx: InstallContext): string {
    return `${ctx.connector.id}.js`;
  }

  // ── MCP server install / uninstall ───────────────────────────────────────

  installServer(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    const override = connector.platforms[HOST]?.server;
    if (!connector.server || override === false) {
      return [
        {
          platform: this.id,
          action: "skip",
          detail: connector.server
            ? "server registration disabled for kilo-cli"
            : "connector declares no MCP server",
        },
      ];
    }

    // Shallow-merge any per-platform server override into the base ServerDef.
    const server: ServerDef =
      override && typeof override === "object"
        ? { ...connector.server, ...override }
        : connector.server;

    const serverPath = this.getServerConfigPath(ctx);
    const entry = this.renderServerEntry(ctx, server);

    return [
      this.upsertServerInJson(serverPath, MCP_ROOT_KEY, connector.id, entry, ctx.dryRun),
    ];
  }

  uninstallServer(ctx: InstallContext): ChangeRecord[] {
    const serverPath = this.getServerConfigPath(ctx);
    return [
      this.removeServerFromJson(serverPath, MCP_ROOT_KEY, ctx.connector.id, ctx.dryRun),
    ];
  }

  /** Render a normalized ServerDef into the Kilo CLI's new-gen `mcp` entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): KiloLocalServer | KiloRemoteServer {
    const transport: Transport = server.transport;

    if (transport === "stdio") {
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
          this.id,
        );
        command = wrapped.command;
        args = wrapped.args;
      }

      // QUIRK: the Kilo CLI's new-gen local server keys its whole invocation as
      // a single `command` ARRAY (executable + args together), like OpenCode.
      // The CLI has no documented native interpolation token, so resolve every
      // ${env:VAR} to a literal at install time.
      const entry: KiloLocalServer = {
        type: "local",
        command: resolveEnvRefsDeep([command, ...args]),
      };
      const env = this.renderEnv(server.env);
      if (env) entry.environment = env;
      return entry;
    }

    // sse / http (and any other remote transport) — the Kilo CLI registers a URL.
    const entry: KiloRemoteServer = {
      type: "remote",
      url: resolveEnvRefsDeep(server.url ?? ""),
    };
    return entry;
  }

  /**
   * Render env values. The Kilo CLI documents no native interpolation token, so
   * resolve `${env:VAR}` references to literals at install time.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Hook install / uninstall (ts-plugin + explicit `plugin` array) ────────

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const pluginPath = this.getHookConfigPath(ctx);
    const configPath = this.getServerConfigPath(ctx);

    if (ctx.connector.platforms[HOST]?.hooks === false) {
      return [
        { platform: this.id, action: "skip", path: pluginPath, detail: "hooks disabled for kilo-cli" },
      ];
    }
    if (ctx.connector.hookEvents.length === 0) {
      return [
        { platform: this.id, action: "skip", path: pluginPath, detail: "connector declares no hooks" },
      ];
    }

    const changes: ChangeRecord[] = [];

    // 1. Write the synthesized plugin module.
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
        detail: `kilo plugin module (${this.hookDetail(ctx)})`,
      });
    }

    // 2. Register the module path in kilo.jsonc's `plugin` array (the fork does
    //    NOT auto-discover by directory — it reads this array).
    changes.push(this.upsertPluginInArray(configPath, pluginPath, ctx.dryRun));

    return changes;
  }

  /**
   * Human-facing summary of which declared events the synthesized module ACTUALLY
   * wires. Only events present in EVENT_TO_KILO are mapped/wired; any declared
   * event with no Kilo mapping is reported separately as "unsupported here" so
   * the detail never overstates coverage.
   */
  private hookDetail(ctx: InstallContext): string {
    const declared = ctx.connector.hookEvents;
    const mapped = declared.filter((e) => EVENT_TO_KILO[e] !== undefined);
    const unsupported = declared.filter((e) => EVENT_TO_KILO[e] === undefined);
    const base = mapped.join(",");
    return unsupported.length > 0
      ? `${base}; unsupported here: ${unsupported.join(",")}`
      : base;
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const pluginPath = this.getHookConfigPath(ctx);
    const configPath = this.getServerConfigPath(ctx);
    const changes: ChangeRecord[] = [];

    // 1. Deregister the module path from kilo.jsonc's `plugin` array.
    changes.push(this.removePluginFromArray(configPath, pluginPath, ctx.dryRun));

    // 2. Remove the plugin module on disk.
    if (existsSync(pluginPath)) {
      if (!ctx.dryRun) rmSync(pluginPath, { force: true });
      changes.push({
        platform: this.id,
        action: "remove",
        path: pluginPath,
        detail: "kilo plugin module",
      });
    } else {
      changes.push({
        platform: this.id,
        action: "skip",
        path: pluginPath,
        detail: "no kilo plugin module present",
      });
    }

    // 3. Drop the now-empty plugin dir (only if WE own its full contents).
    changes.push(this.removeDirIfEmpty(this.pluginDir(ctx), ctx.dryRun));

    return changes;
  }

  /** Upsert the module path into kilo.jsonc's top-level `plugin` array (idempotent). */
  private upsertPluginInArray(
    configPath: string,
    modulePath: string,
    dryRun: boolean,
  ): ChangeRecord {
    // OVERWRITE GUARD: never blank a present-but-unparseable kilo.jsonc.
    if (this.isPresentButUnparseable(configPath)) {
      return {
        platform: this.id,
        action: "warn",
        path: configPath,
        detail: `existing ${configPath} is not parseable; left untouched (back it up / fix it, then re-run)`,
      };
    }
    const cfg = this.readJson<Record<string, unknown>>(configPath) ?? {};
    const plugins = this.pluginArrayBucket(cfg);
    if (plugins.includes(modulePath)) {
      return {
        platform: this.id,
        action: "skip",
        path: configPath,
        detail: `${PLUGIN_ARRAY_KEY}[] already includes module`,
      };
    }
    plugins.push(modulePath);
    this.writeJson(configPath, cfg, dryRun);
    return {
      platform: this.id,
      action: "create",
      path: configPath,
      detail: `${PLUGIN_ARRAY_KEY}[] += module`,
    };
  }

  /** Remove the module path from kilo.jsonc's `plugin` array. */
  private removePluginFromArray(
    configPath: string,
    modulePath: string,
    dryRun: boolean,
  ): ChangeRecord {
    // OVERWRITE GUARD: a present-but-unparseable file would round-trip to `{}`.
    if (this.isPresentButUnparseable(configPath)) {
      return {
        platform: this.id,
        action: "warn",
        path: configPath,
        detail: `existing ${configPath} is not parseable; left untouched (back it up / fix it, then re-run)`,
      };
    }
    const cfg = this.readJson<Record<string, unknown>>(configPath);
    const raw = cfg?.[PLUGIN_ARRAY_KEY];
    const plugins = Array.isArray(raw) ? (raw as unknown[]) : undefined;
    const idx = plugins ? plugins.indexOf(modulePath) : -1;
    if (!cfg || !plugins || idx < 0) {
      return {
        platform: this.id,
        action: "skip",
        path: configPath,
        detail: `${PLUGIN_ARRAY_KEY}[] does not include module`,
      };
    }
    plugins.splice(idx, 1);
    this.writeJson(configPath, cfg, dryRun);
    return {
      platform: this.id,
      action: "remove",
      path: configPath,
      detail: `${PLUGIN_ARRAY_KEY}[] -= module`,
    };
  }

  /** Get-or-create the top-level `plugin` array as a mutable string array. */
  private pluginArrayBucket(cfg: Record<string, unknown>): string[] {
    const existing = cfg[PLUGIN_ARRAY_KEY];
    // Normalize to a fresh string[] (drop any non-string a user may have placed
    // here) and write it back so the caller mutates the live array.
    const plugins = Array.isArray(existing)
      ? existing.filter((p): p is string => typeof p === "string")
      : [];
    cfg[PLUGIN_ARRAY_KEY] = plugins;
    return plugins;
  }

  // ── ts-plugin synthesis ────────────────────────────────────────────────

  /**
   * Build ONE self-contained ESM plugin module for the Kilo CLI fork.
   *
   * The module imports nothing from agent-connector. It embeds two constants
   * (the absolute home-bin path and the connector id) and a `bridge()` helper
   * that shells out to the universal hook entrypoint via execFileSync, feeding
   * the Kilo payload on stdin and JSON.parsing the normalized HookResponse back
   * from stdout (fail-open: any error → null). Its default export is the
   * `@kilocode/plugin` PluginModule shape — { id, server: async (input) =>
   * ({ "tool.execute.before": …, "tool.execute.after": …, … }) } — keyed only by
   * the fork event names for the events this connector actually declares.
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

    // The Kilo event keys this connector declares (and that we can map).
    const events = ctx.connector.hookEvents.filter(
      (e): e is HookEventName => EVENT_TO_KILO[e] !== undefined,
    );
    const has = (e: HookEventName) => events.includes(e);

    const header = `/**
 * AUTO-GENERATED by agent-connector — DO NOT EDIT.
 *
 * Self-contained Kilo CLI plugin bridge for connector ${ctx.connector.id}.
 * It imports nothing from agent-connector: every hook invocation shells out to
 * the stable home binary's universal entrypoint and JSON-parses the normalized
 * response. Fail-open: any bridge error degrades to "allow".
 *
 * Default export is the @kilocode/plugin PluginModule shape
 * ({ id, server: async (input) => Hooks }); the fork loads it because its path
 * is registered in kilo.jsonc's "plugin" array.
 */
import { execFileSync } from "node:child_process";

const HOME_BIN = ${homeBin};
const CONNECTOR_ID = ${connectorId};

/**
 * Invoke the universal hook entrypoint for one event.
 * @param {string} event canonical event name (PreToolUse|PostToolUse|SessionStart)
 * @param {object} payload Kilo-shaped payload posted on stdin
 * @returns {object|null} normalized HookResponse, or null on any failure
 */
function bridge(event, payload) {
  try {
    const stdout = execFileSync(
      HOME_BIN,
      ["hook", "kilo-cli", event, "--connector", CONNECTOR_ID],
      { input: JSON.stringify(payload), encoding: "utf8" },
    );
    const text = (stdout || "").trim();
    if (text === "") return { decision: "allow" };
    return JSON.parse(text);
  } catch {
    // Fail-open — never wedge a tool call on a bridge error.
    return null;
  }
}
`;

    const handlers: string[] = [];

    if (has("PreToolUse")) {
      handlers.push(`    // PreToolUse → block (throw) / rewrite args (mutate output.args).
    "tool.execute.before": async (input, output) => {
      const payload = {
        toolName: input.tool ?? "",
        toolInput: (output && output.args) ?? {},
        sessionId: input.sessionID ?? "",
        projectDir: PROJECT_DIR,
      };
      const res = bridge("PreToolUse", payload);
      if (!res) return;
      // Kilo has no "ask" gate — degrade "ask" to a block (safe direction).
      if (res.decision === "deny" || res.decision === "ask") {
        throw new Error(res.reason || "Blocked by ${ctx.connector.id}");
      }
      if (res.updatedInput && output && output.args) {
        Object.assign(output.args, res.updatedInput);
      }
    },`);
    }

    if (has("PostToolUse")) {
      handlers.push(`    // PostToolUse → observe / rewrite tool output (mutate output.output).
    "tool.execute.after": async (input, output) => {
      const payload = {
        toolName: input.tool ?? "",
        toolInput: input.args ?? {},
        toolOutput: output ? output.output : undefined,
        sessionId: input.sessionID ?? "",
        projectDir: PROJECT_DIR,
      };
      const res = bridge("PostToolUse", payload);
      if (!res) return;
      if (typeof res.updatedOutput === "string" && output) {
        output.output = res.updatedOutput;
      }
    },`);
    }

    if (has("SessionStart")) {
      handlers.push(`    // SessionStart surrogate → inject context into the system prompt.
    // The fork has no real SessionStart hook; the system-prompt transform is the
    // verified injection point (mirrors OpenCode).
    "experimental.chat.system.transform": async (input, output) => {
      const payload = {
        sessionId: (input && input.sessionID) ?? "",
        projectDir: PROJECT_DIR,
      };
      const res = bridge("SessionStart", payload);
      if (!res) return;
      if (res.additionalContext && output && Array.isArray(output.system)) {
        // Insert at index 1 (after the header) to preserve the prompt-cache fold
        // (header must remain system[0]).
        output.system.splice(1, 0, res.additionalContext);
      }
    },`);
    }

    const definition = `
const plugin = {
  id: CONNECTOR_ID,
  // @kilocode/plugin PluginModule: server(input) returns the Hooks object keyed
  // by the fork's event names. ctx.directory is the project root; fall back to cwd.
  server: async (input) => {
    const PROJECT_DIR =
      (input && (input.directory || (input.worktree && input.worktree.path))) ||
      process.cwd();

    return {
${handlers.join("\n")}
    };
  },
};

export default plugin;
`;

    return header + definition;
  }

  // ── Runtime: parse OUR bridge payload → normalized event ───────────────

  /**
   * `raw` is the payload OUR generated plugin posts (NOT a host-native shape):
   *   { toolName, toolInput, toolOutput?, isError?, sessionId, projectDir }
   * so this maps straight through.
   */
  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as KiloBridgePayload;
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
        const ev: SessionStartEvent = { ...base, source: "startup" };
        return ev;
      }
      default:
        // Other canonical events are not surfaced by Kilo; treat as a
        // session-start-shaped no-op so the dispatcher fails open gracefully.
        return { ...base, source: "startup" } satisfies SessionStartEvent;
    }
  }

  // ── Runtime: normalized response → reply the generated bridge parses ───

  /**
   * Unlike json-stdio hosts (whose reply is the host's NATIVE control payload),
   * OUR generated bridge consumes this stdout directly. So the reply body is the
   * NORMALIZED HookResponse itself — the bridge JSON.parses it and reads
   * decision / updatedInput / updatedOutput / additionalContext.
   */
  formatReply(_event: HookEventName, response: HookResponse): HookReply {
    return {
      exitCode: 0,
      stdout: JSON.stringify(response ?? { decision: "allow" }),
    };
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const configPath = this.getServerConfigPath(ctx);
    const pluginPath = this.getHookConfigPath(ctx);
    const connectorId = ctx.connector.id;
    const hasHooks = ctx.connector.hookEvents.length > 0;

    return [
      {
        name: `${this.name}: ${CONFIG_FILE} present`,
        check: () =>
          existsSync(configPath)
            ? { status: "OK", detail: configPath }
            : { status: "FAIL", detail: `not found: ${configPath}` },
      },
      {
        name: `${this.name}: server entry registered`,
        check: () => {
          if (!ctx.connector.server) {
            return { status: "OK", detail: "no MCP server declared" };
          }
          const cfg = this.readJson<{ [k: string]: Record<string, unknown> }>(configPath);
          const bucket = cfg?.[MCP_ROOT_KEY];
          if (!cfg || !bucket) {
            return { status: "FAIL", detail: `no ${MCP_ROOT_KEY} in ${configPath}` };
          }
          return connectorId in bucket
            ? { status: "OK", detail: `${MCP_ROOT_KEY}.${connectorId} present` }
            : {
                status: "FAIL",
                detail: `no ${MCP_ROOT_KEY}.${connectorId} in ${configPath}`,
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
      {
        name: `${this.name}: plugin registered in ${PLUGIN_ARRAY_KEY}[]`,
        check: () => {
          if (!hasHooks) return { status: "OK", detail: "no hooks declared" };
          const cfg = this.readJson<Record<string, unknown>>(configPath);
          const raw = cfg?.[PLUGIN_ARRAY_KEY];
          const plugins = Array.isArray(raw) ? (raw as unknown[]) : undefined;
          return plugins && plugins.includes(pluginPath)
            ? { status: "OK", detail: `${PLUGIN_ARRAY_KEY}[] includes module` }
            : {
                status: "FAIL",
                detail: `module not in ${PLUGIN_ARRAY_KEY}[] of ${configPath} (fork will not load it)`,
              };
        },
      },
    ];
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

/** Create a directory (recursive) if it does not already exist. */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export const adapter = new KiloCliAdapter();
export default adapter;
