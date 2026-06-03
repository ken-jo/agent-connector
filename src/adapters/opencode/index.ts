/**
 * adapters/opencode — OpenCode (SST) platform adapter for agent-connector.
 *
 * OpenCode is the reference **ts-plugin** host: it has no JSON hook table.
 * Instead it auto-loads JS/TS modules from a plugin directory; each module
 * default-exports an async factory that returns an object keyed by OpenCode
 * event names ("tool.execute.before", "tool.execute.after", …). The factory
 * runs in-process inside OpenCode, mutates the args/output objects it is handed,
 * and throws to block a tool call.
 *
 * The novel part — why this PROVES the ts-plugin paradigm:
 *   context-mode could load ITS OWN plugin module in-process because the handler
 *   code shipped with the package. agent-connector cannot: the connector's hook
 *   handlers are arbitrary developer code we must not import into OpenCode's
 *   runtime (wrong cwd, wrong deps, version skew, the cache-heal bug class).
 *   So instead of importing handlers, we synthesize a tiny, fully self-contained
 *   bridge module that shells out to the ONE stable home binary
 *   (`<homeBin> hook opencode <event> --connector <id>`) over child_process,
 *   feeds it the OpenCode payload as JSON on stdin, and JSON.parses the
 *   normalized HookResponse back from stdout. The same universal json-stdio
 *   dispatcher every other host uses (runtime/hook-entrypoint) thus serves the
 *   ts-plugin host too — one entrypoint, every paradigm.
 *
 * MCP registration:
 *   - config file: opencode.json
 *       user scope    → ~/.config/opencode/opencode.json
 *       project scope → <projectDir>/opencode.json
 *   - root key: "mcp" (NOT "mcpServers").
 *   - stdio server  → { type: "local", command: [exe, ...args], environment }
 *     (command is an ARRAY, env key is "environment").
 *   - remote server → { type: "remote", url }.
 *   OpenCode documents no native ${env:VAR} interpolation token, so env/url refs
 *   are resolved to literals at install time (resolveEnvRefsDeep).
 *
 * Hooks (ts-plugin):
 *   - synthesizePlugin(ctx) builds one self-contained ESM bridge module.
 *   - installHooks(ctx) writes it into the OpenCode plugin dir
 *       user scope    → ~/.config/opencode/plugin/<id>.js
 *       project scope → <projectDir>/.opencode/plugin/<id>.js
 *     OpenCode auto-loads every file in the plugin dir, so writing the file is
 *     sufficient — we do NOT also edit the opencode.json "plugin" array.
 *
 * Event mapping (only the events the connector declares are emitted):
 *   PreToolUse   → "tool.execute.before"  (can mutate output.args; throw to deny)
 *   PostToolUse  → "tool.execute.after"   (can mutate output.output)
 *   SessionStart → "experimental.chat.system.transform"  (no real SessionStart
 *     hook upstream — #14808/#5409; this is the verified surrogate context-mode
 *     uses; we inject additionalContext into output.system).
 *
 * Capability degradations (documented, never thrown):
 *   - OpenCode has no "ask" gate. A decision of "ask" degrades to a block (throw
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

const HOST: PlatformId = "opencode";
const MCP_ROOT_KEY = "mcp";

/**
 * Canonical → OpenCode event name map. A connector hook event is only emitted
 * by the generated plugin when it appears here AND is declared by the connector.
 */
const EVENT_TO_OPENCODE: Partial<Record<HookEventName, string>> = {
  PreToolUse: "tool.execute.before",
  PostToolUse: "tool.execute.after",
  // OpenCode lacks a real SessionStart hook (#14808 / #5409). The verified
  // surrogate is experimental.chat.system.transform, which receives the system
  // prompt array; we inject additionalContext there.
  SessionStart: "experimental.chat.system.transform",
};

/** Raw payload the generated plugin posts to the universal hook entrypoint. */
interface OpenCodeBridgePayload {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  isError?: boolean;
  sessionId?: string;
  projectDir?: string;
}

/** Native MCP server entry shapes OpenCode accepts under the "mcp" key. */
interface OpenCodeLocalServer {
  type: "local";
  command: string[];
  environment?: Record<string, string>;
  enabled?: boolean;
}
interface OpenCodeRemoteServer {
  type: "remote";
  url: string;
  enabled?: boolean;
}

export class OpenCodeAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "OpenCode";
  readonly paradigm: HookParadigm = "ts-plugin";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    // OpenCode's compaction hook is experimental and not wired here.
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
    // injected via experimental.chat.system.transform at session start.
    canInjectSessionContext: true,
    transports: ["stdio", "sse", "http"],
  };

  // ── Detection ──────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userConfigDir = join(homedir(), ".config", "opencode");
    const userConfig = join(userConfigDir, "opencode.json");
    const projectConfig = join(projectDir, "opencode.json");

    const userInstalled = existsSync(userConfigDir) || existsSync(userConfig);
    const projInstalled = existsSync(projectConfig);
    const installed = userInstalled || projInstalled;

    // Report the marker that actually matched so a project-only install isn't
    // misreported as a (non-existent) user install.
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
          ? `found project OpenCode config at ${projectConfig}`
          : `found OpenCode config under ${userConfigDir}`
        : `no OpenCode config at ${userConfigDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ───────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? ctx.projectDir
      : join(homedir(), ".config", "opencode");
  }

  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "opencode.json");
  }

  /**
   * For ts-plugin hosts the "hook config path" is the generated plugin FILE.
   * OpenCode auto-loads every file in the plugin dir; writing this file IS the
   * registration.
   */
  getHookConfigPath(ctx: InstallContext): string {
    return join(this.pluginDir(ctx), this.pluginFileName(ctx));
  }

  /** Plugin directory OpenCode auto-loads modules from, per scope. */
  private pluginDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".opencode", "plugin")
      : join(homedir(), ".config", "opencode", "plugin");
  }

  /** Plugin module file name (one per connector, kebab-case id). */
  private pluginFileName(ctx: InstallContext): string {
    return `${ctx.connector.id}.js`;
  }

  // ── MCP server install / uninstall ─────────────────────────────────────

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
            ? "server registration disabled for opencode"
            : "connector declares no MCP server",
        },
      ];
    }

    const entry = this.renderServerEntry(ctx, server);
    return [
      this.upsertServerInJson(
        serverPath,
        MCP_ROOT_KEY,
        ctx.connector.id,
        entry,
        ctx.dryRun,
      ),
    ];
  }

  uninstallServer(ctx: InstallContext): ChangeRecord[] {
    const serverPath = this.getServerConfigPath(ctx);
    return [
      this.removeServerFromJson(
        serverPath,
        MCP_ROOT_KEY,
        ctx.connector.id,
        ctx.dryRun,
      ),
    ];
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
   * Render a normalized ServerDef into OpenCode's native "mcp" entry.
   *
   * stdio  → { type: "local", command: [exe, ...args], environment }
   * remote → { type: "remote", url }
   *
   * OpenCode flattens command+args into a single ARRAY. When telemetry wrapping
   * applies, the wrapper's command+args (which already include the real command
   * tail after `--`) become the head of that array.
   */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): OpenCodeLocalServer | OpenCodeRemoteServer {
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
        );
        command = wrapped.command;
        args = wrapped.args;
      }

      // OpenCode has no native interpolation token → resolve to literals.
      const commandArray = resolveEnvRefsDeep([command, ...args]).filter(
        (s) => s !== "",
      );
      const entry: OpenCodeLocalServer = {
        type: "local",
        command: commandArray,
      };
      const environment = this.renderEnv(server.env);
      if (environment) entry.environment = environment;
      if (server.enabled === false) entry.enabled = false;
      return entry;
    }

    // sse / http / ws (any remote transport) — OpenCode registers a URL.
    const entry: OpenCodeRemoteServer = {
      type: "remote",
      url: resolveEnvRefsDeep(server.url ?? ""),
    };
    if (server.enabled === false) entry.enabled = false;
    return entry;
  }

  /**
   * Render env values. OpenCode documents no native interpolation token, so
   * resolve every ${env:VAR} reference to a literal at install time.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Hook install / uninstall (ts-plugin) ───────────────────────────────

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const pluginPath = this.getHookConfigPath(ctx);

    if (ctx.connector.platforms[HOST]?.hooks === false) {
      return [
        {
          platform: this.id,
          action: "skip",
          path: pluginPath,
          detail: "hooks disabled for opencode",
        },
      ];
    }
    if (ctx.connector.hookEvents.length === 0) {
      return [
        {
          platform: this.id,
          action: "skip",
          path: pluginPath,
          detail: "connector declares no hooks",
        },
      ];
    }

    const files = this.synthesizePlugin(ctx);
    const changes: ChangeRecord[] = [];

    for (const file of files) {
      // Idempotent: compare existing contents before writing.
      const before = existsSync(file.path)
        ? this.safeRead(file.path)
        : undefined;
      let action: ChangeRecord["action"];
      if (before === undefined) action = "create";
      else if (before === file.contents) action = "skip";
      else action = "update";

      if (action !== "skip" && !ctx.dryRun) {
        ensureDir(dirname(file.path));
        writeFileSync(file.path, file.contents, "utf8");
        // 0644 — readable plugin module; the executable bit is irrelevant for an
        // imported ESM module, but honor the SPI flag if a host ever needs it.
        chmodSync(file.path, file.executable ? 0o755 : 0o644);
      }

      changes.push({
        platform: this.id,
        action,
        path: file.path,
        detail: `opencode plugin module (${ctx.connector.hookEvents.join(",")})`,
      });
    }

    return changes;
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const pluginPath = this.getHookConfigPath(ctx);
    if (!existsSync(pluginPath)) {
      return [
        {
          platform: this.id,
          action: "skip",
          path: pluginPath,
          detail: "no opencode plugin module present",
        },
      ];
    }
    if (!ctx.dryRun) rmSync(pluginPath, { force: true });
    return [
      {
        platform: this.id,
        action: "remove",
        path: pluginPath,
        detail: "opencode plugin module",
      },
    ];
  }

  // ── ts-plugin synthesis ────────────────────────────────────────────────

  /**
   * Build ONE self-contained ESM bridge module for OpenCode.
   *
   * The module imports nothing from agent-connector. It embeds two constants
   * (the absolute home-bin path and the connector id) and a `bridge()` helper
   * that shells out to the universal hook entrypoint via execFileSync, feeding
   * the OpenCode payload on stdin and JSON.parsing the normalized HookResponse
   * back from stdout (fail-open: any error → null). Its default export is the
   * OpenCode plugin factory returning an object keyed only by the OpenCode event
   * names for the events this connector actually declares.
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

    // The OpenCode event keys this connector declares (and that we can map).
    const events = ctx.connector.hookEvents.filter(
      (e): e is HookEventName => EVENT_TO_OPENCODE[e] !== undefined,
    );
    const has = (e: HookEventName) => events.includes(e);

    const header = `/**
 * AUTO-GENERATED by agent-connector — DO NOT EDIT.
 *
 * Self-contained OpenCode plugin bridge for connector ${ctx.connector.id}.
 * It imports nothing from agent-connector: every hook invocation shells out to
 * the stable home binary's universal entrypoint and JSON-parses the normalized
 * response. Fail-open: any bridge error degrades to "allow".
 */
import { execFileSync } from "node:child_process";

const HOME_BIN = ${homeBin};
const CONNECTOR_ID = ${connectorId};

/**
 * Invoke the universal hook entrypoint for one event.
 * @param {string} event canonical event name (PreToolUse|PostToolUse|SessionStart)
 * @param {object} payload OpenCode-shaped payload posted on stdin
 * @returns {object|null} normalized HookResponse, or null on any failure
 */
function bridge(event, payload) {
  try {
    const stdout = execFileSync(
      HOME_BIN,
      ["hook", "opencode", event, "--connector", CONNECTOR_ID],
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
      // OpenCode has no "ask" gate — degrade "ask" to a block (safe direction).
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
    // OpenCode has no real SessionStart hook (#14808 / #5409); the
    // experimental.chat.system.transform hook is the verified injection point.
    "experimental.chat.system.transform": async (input, output) => {
      const payload = {
        sessionId: (input && input.sessionID) ?? "",
        projectDir: PROJECT_DIR,
      };
      const res = bridge("SessionStart", payload);
      if (!res) return;
      if (res.additionalContext && output && Array.isArray(output.system)) {
        // Insert at index 1 (after the header) to preserve OpenCode's
        // prompt-cache fold (header must remain system[0]).
        output.system.splice(1, 0, res.additionalContext);
      }
    },`);
    }

    const factory = `
export default async function (ctx) {
  // ctx.directory is the OpenCode project root; fall back to cwd.
  const PROJECT_DIR =
    (ctx && (ctx.directory || (ctx.worktree && ctx.worktree.path))) ||
    process.cwd();

  return {
${handlers.join("\n")}
  };
}
`;

    return header + factory;
  }

  // ── Runtime: parse OUR bridge payload → normalized event ───────────────

  /**
   * `raw` is the payload OUR generated plugin posts (NOT a host-native shape):
   *   { toolName, toolInput, toolOutput?, isError?, sessionId, projectDir }
   * so this maps straight through.
   */
  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as OpenCodeBridgePayload;
    const base = {
      hostPlatform: HOST,
      connectorId: "",
      sessionId: typeof input.sessionId === "string" ? input.sessionId : "",
      raw,
      ...(typeof input.projectDir === "string"
        ? { projectDir: input.projectDir }
        : {}),
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
          ...(typeof input.toolOutput === "string"
            ? { toolOutput: input.toolOutput }
            : {}),
          ...(typeof input.isError === "boolean"
            ? { isError: input.isError }
            : {}),
        };
        return ev;
      }
      case "SessionStart": {
        const ev: SessionStartEvent = { ...base, source: "startup" };
        return ev;
      }
      default:
        // Other canonical events are not surfaced by OpenCode; treat as a
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

  // ── Diagnostics ────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const serverPath = this.getServerConfigPath(ctx);
    const pluginPath = this.getHookConfigPath(ctx);
    const connectorId = ctx.connector.id;
    const hasHooks = ctx.connector.hookEvents.length > 0;

    return [
      {
        name: `${this.name}: opencode.json present`,
        check: () =>
          existsSync(serverPath)
            ? { status: "OK", detail: serverPath }
            : { status: "FAIL", detail: `not found: ${serverPath}` },
      },
      {
        name: `${this.name}: mcp.${connectorId} registered`,
        check: () => {
          if (!ctx.connector.server) {
            return { status: "OK", detail: "no MCP server declared" };
          }
          const cfg = this.readJson<{ [k: string]: Record<string, unknown> }>(
            serverPath,
          );
          const bucket = cfg?.[MCP_ROOT_KEY];
          if (!cfg || !bucket) {
            return { status: "FAIL", detail: `no ${MCP_ROOT_KEY} in ${serverPath}` };
          }
          return connectorId in bucket
            ? { status: "OK", detail: `${MCP_ROOT_KEY}.${connectorId} present` }
            : {
                status: "FAIL",
                detail: `no ${MCP_ROOT_KEY}.${connectorId} in ${serverPath}`,
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

export const adapter = new OpenCodeAdapter();
export default adapter;
