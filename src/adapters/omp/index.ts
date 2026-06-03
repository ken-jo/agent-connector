/**
 * adapters/omp — Oh My Pi (OMP) platform adapter for agent-connector.
 *
 * OMP is a ts-plugin host with NATIVE MCP. The two surfaces are split:
 *
 *   • MCP (native, real file) — OMP reads a real `mcp.json`:
 *       user scope    → <agentDir>/mcp.json   (agentDir = ~/.omp/agent)
 *       project scope → <projectDir>/.omp/mcp.json
 *     JSON, root key "mcpServers", stdio entry { command, args, env } — the
 *     portable field names. Verified against can1357/oh-my-pi
 *     (packages/utils/src/dirs.ts getMCPConfigPath + docs/mcp-config.md). OMP
 *     documents no native ${env:VAR} token, so env refs resolve to literals at
 *     install time (resolveEnvRefsDeep).
 *
 *   • Hooks (ts-plugin, in-process) — OMP loads EXTENSION PACKAGES. Its plugin
 *     loader reads a package whose package.json carries an `omp` (or `pi`)
 *     manifest field; the manifest's `extensions` array points at the plugin
 *     module, whose DEFAULT export is a HookFactory `(pi) => void` that calls
 *     `pi.on(event, handler)` (upstream loader.ts:75
 *     `pluginPkg.omp || pluginPkg.pi`; hook factory types.ts:809). context-mode
 *     proved this by dropping an extension under
 *     `<agentDir>/extensions/<name>/{package.json,index.js}` whose index.js
 *     default-exports the OMP plugin factory (src/setup.ts applyPlatformInstall
 *     "omp"; src/adapters/omp/plugin.ts).
 *
 * Why we SYNTHESIZE instead of importing context-mode's plugin:
 *   context-mode could load its own plugin module in-process because the handler
 *   code shipped with the package. agent-connector cannot — the connector's hook
 *   handlers are arbitrary developer code we must not import into OMP's runtime
 *   (wrong cwd, wrong deps, version skew, the cache-heal bug class). So, exactly
 *   like the OpenCode adapter, we generate a tiny self-contained ESM extension
 *   that imports NOTHING from agent-connector: each `pi.on(...)` handler shells
 *   out to the ONE stable home binary's universal entrypoint
 *   (`<homeBin> hook omp <event> --connector <id>`) over child_process, feeds it
 *   the OMP-shaped payload as JSON on stdin, and JSON.parses the normalized
 *   HookResponse back from stdout. Fail-open: any bridge error → no-op. One
 *   entrypoint, every paradigm.
 *
 * Event mapping (only events the connector declares are subscribed):
 *   PreToolUse   → pi.on("tool_call",  …)  block via { block:true, reason }
 *                  (OMP tool_call cannot mutate args → canModifyArgs:false)
 *   PostToolUse  → pi.on("tool_result", …) observe-only (no output rewrite hook)
 *   SessionStart → pi.on("session_start", …) (no context-injection surface)
 *   PreCompact   → pi.on("session_before_compact", …) observe-only
 *
 * Distinct storage root from Pi: OMP lives under ~/.omp (NOT ~/.pi); the
 * PI_CODING_AGENT_DIR env var (the only OMP runtime dir override — OMP mirrors
 * any .env `OMP_*` keys to `PI_*` before process.env is read) takes precedence.
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
  PreCompactEvent,
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

const HOST: PlatformId = "omp";
const MCP_ROOT_KEY = "mcpServers";

/**
 * Canonical → OMP event name map. A connector hook event is only subscribed by
 * the generated plugin when it appears here AND is declared by the connector.
 * Names verified against the proven context-mode OMP plugin (pi.on targets).
 */
const EVENT_TO_OMP: Partial<Record<HookEventName, string>> = {
  PreToolUse: "tool_call",
  PostToolUse: "tool_result",
  SessionStart: "session_start",
  PreCompact: "session_before_compact",
};

/** Raw payload the generated plugin posts to the universal hook entrypoint. */
interface OmpBridgePayload {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  isError?: boolean;
  sessionId?: string;
  projectDir?: string;
}

/** Native MCP server entry shapes OMP accepts under "mcpServers". */
interface OmpStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
interface OmpRemoteServer {
  url: string;
  headers?: Record<string, string>;
}

export class OMPAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Oh My Pi (OMP)";
  readonly paradigm: HookParadigm = "ts-plugin";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    // session_before_compact is wired as an observe-only PreCompact surface.
    preCompact: true,
    sessionStart: true,
    sessionEnd: false,
    userPromptSubmit: false,
    stop: false,
    notification: false,
    // OMP tool_call gates via { block, reason } only — it does not hand the
    // handler a mutable args object, so input rewrite is unsupported.
    canModifyArgs: false,
    // No tool_result output-rewrite surface upstream.
    canModifyOutput: false,
    // No session_start context-injection surface upstream.
    canInjectSessionContext: false,
    // OMP registers stdio and remote (http) MCP servers.
    transports: ["stdio", "http"],
  };

  // ── Native paths ───────────────────────────────────────────────────────

  /**
   * Resolve the OMP agent dir, honoring the PI_CODING_AGENT_DIR override (the
   * only OMP runtime dir env), else ~/.omp/agent. This is the user-scope root.
   */
  private agentDir(): string {
    const override = process.env.PI_CODING_AGENT_DIR;
    return override && override !== ""
      ? override
      : join(homedir(), ".omp", "agent");
  }

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".omp")
      : this.agentDir();
  }

  /** Native MCP file: <agentDir>/mcp.json (user) or <projectDir>/.omp/mcp.json. */
  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "mcp.json");
  }

  /**
   * For this ts-plugin host the "hook config path" is the generated extension
   * entrypoint module (index.js). OMP loads the extension package by reading its
   * package.json manifest, so the package.json is written alongside (see
   * synthesizePlugin); this returns the entry module the manifest points at.
   */
  getHookConfigPath(ctx: InstallContext): string {
    return join(this.extensionDir(ctx), "index.js");
  }

  /** Extension package directory OMP loads the plugin from, per scope. */
  private extensionDir(ctx: InstallContext): string {
    const base =
      ctx.scope === "project"
        ? join(ctx.projectDir, ".omp")
        : this.agentDir();
    return join(base, "extensions", ctx.connector.id);
  }

  // ── Detection ──────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userAgentDir = this.agentDir();
    const userConfig = join(userAgentDir, "mcp.json");
    const projectConfig = join(projectDir, ".omp", "mcp.json");

    const userInstalled = existsSync(userAgentDir) || existsSync(userConfig);
    const projInstalled =
      existsSync(join(projectDir, ".omp")) || existsSync(projectConfig);
    const installed = userInstalled || projInstalled;

    // Report the marker that actually matched.
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
          ? `found project OMP dir at ${join(projectDir, ".omp")}`
          : `found OMP agent dir at ${userAgentDir}`
        : `no OMP agent dir at ${userAgentDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── MCP server install / uninstall (native mcp.json) ────────────────────

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
            ? "server registration disabled for omp"
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
    return override && typeof override === "object"
      ? { ...base, ...override }
      : base;
  }

  /**
   * Render a normalized ServerDef into OMP's native "mcpServers" entry.
   *
   * stdio  → { command, args, env }  (portable field names)
   * remote → { url, headers? }
   *
   * Telemetry wrapping routes the real command through
   * `<homeBin> serve --connector <id> -- <command> <args...>`. OMP has no native
   * env interpolation token, so every ${env:VAR} ref resolves to a literal.
   */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): OmpStdioServer | OmpRemoteServer {
    const transport: Transport = server.transport;

    if (transport === "stdio") {
      let command = server.command ?? "";
      let args = [...(server.args ?? [])];

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

      const entry: OmpStdioServer = {
        command: resolveEnvRefsDeep(command),
      };
      const resolvedArgs = resolveEnvRefsDeep(args).filter((s) => s !== "");
      if (resolvedArgs.length > 0) entry.args = resolvedArgs;
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      return entry;
    }

    // remote (http / sse / ws) — OMP registers a URL.
    const entry: OmpRemoteServer = {
      url: resolveEnvRefsDeep(server.url ?? ""),
    };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /** Resolve every ${env:VAR} ref to a literal (OMP has no native token). */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Hook install / uninstall (ts-plugin extension package) ──────────────

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const entryPath = this.getHookConfigPath(ctx);

    if (ctx.connector.platforms[HOST]?.hooks === false) {
      return [
        {
          platform: this.id,
          action: "skip",
          path: entryPath,
          detail: "hooks disabled for omp",
        },
      ];
    }
    if (ctx.connector.hookEvents.length === 0) {
      return [
        {
          platform: this.id,
          action: "skip",
          path: entryPath,
          detail: "connector declares no hooks",
        },
      ];
    }

    const files = this.synthesizePlugin(ctx);
    const changes: ChangeRecord[] = [];

    for (const file of files) {
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
        chmodSync(file.path, file.executable ? 0o755 : 0o644);
      }

      changes.push({
        platform: this.id,
        action,
        path: file.path,
        detail: file.path.endsWith("package.json")
          ? "omp extension manifest"
          : `omp plugin module (${ctx.connector.hookEvents.join(",")})`,
      });
    }

    return changes;
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const entryPath = this.getHookConfigPath(ctx);
    const manifestPath = join(this.extensionDir(ctx), "package.json");
    const present = [entryPath, manifestPath].filter((p) => existsSync(p));

    if (present.length === 0) {
      return [
        {
          platform: this.id,
          action: "skip",
          path: entryPath,
          detail: "no omp extension present",
        },
      ];
    }

    const changes: ChangeRecord[] = [];
    for (const p of present) {
      if (!ctx.dryRun) rmSync(p, { force: true });
      changes.push({
        platform: this.id,
        action: "remove",
        path: p,
        detail: p.endsWith("package.json")
          ? "omp extension manifest"
          : "omp plugin module",
      });
    }
    return changes;
  }

  // ── ts-plugin synthesis ────────────────────────────────────────────────

  /**
   * Build the OMP extension package: TWO files.
   *
   *   1. package.json — the manifest OMP's loader reads. It carries the `omp`
   *      field (`pluginPkg.omp || pluginPkg.pi`) whose `extensions` array points
   *      at the entry module, plus `type:"module"` and `main:"index.js"`.
   *   2. index.js — a self-contained ESM plugin that imports nothing from
   *      agent-connector. Its default export is the OMP HookFactory `(pi)=>void`;
   *      each declared event registers a `pi.on(...)` handler that bridges to the
   *      home binary via execFileSync (fail-open) and applies the normalized
   *      response.
   */
  synthesizePlugin(ctx: InstallContext): GeneratedPluginFile[] {
    const dir = this.extensionDir(ctx);
    return [
      {
        path: join(dir, "package.json"),
        contents: this.buildManifest(ctx),
        executable: false,
      },
      {
        path: join(dir, "index.js"),
        contents: this.buildPluginSource(ctx),
        executable: false,
      },
    ];
  }

  /** The extension package.json manifest OMP's plugin loader reads. */
  private buildManifest(ctx: InstallContext): string {
    const manifest = {
      name: ctx.connector.id,
      version: ctx.connector.version || "0.0.0",
      description: `${ctx.connector.displayName} OMP extension (generated by agent-connector)`,
      type: "module",
      main: "index.js",
      // pluginPkg.omp || pluginPkg.pi → manifest. extensions points at the entry.
      omp: {
        extensions: ["./index.js"],
      },
    };
    return `${JSON.stringify(manifest, null, 2)}\n`;
  }

  /** Compose the generated plugin source with plain string concatenation. */
  private buildPluginSource(ctx: InstallContext): string {
    const homeBin = JSON.stringify(ctx.homeBinPath);
    const connectorId = JSON.stringify(ctx.connector.id);

    const events = ctx.connector.hookEvents.filter(
      (e): e is HookEventName => EVENT_TO_OMP[e] !== undefined,
    );
    const has = (e: HookEventName) => events.includes(e);

    const header = `/**
 * AUTO-GENERATED by agent-connector — DO NOT EDIT.
 *
 * Self-contained Oh My Pi (OMP) plugin extension for connector ${ctx.connector.id}.
 * It imports nothing from agent-connector: every hook invocation shells out to
 * the stable home binary's universal entrypoint and JSON-parses the normalized
 * response. Fail-open: any bridge error degrades to a no-op (never wedges OMP).
 *
 * OMP loads this module via the sibling package.json "omp" manifest field; the
 * default export is the HookFactory (pi) => void called once at load time.
 */
import { execFileSync } from "node:child_process";

const HOME_BIN = ${homeBin};
const CONNECTOR_ID = ${connectorId};

/**
 * Invoke the universal hook entrypoint for one event.
 * @param {string} event canonical event name
 * @param {object} payload OMP-shaped payload posted on stdin
 * @returns {object|null} normalized HookResponse, or null on any failure
 */
function bridge(event, payload) {
  try {
    const stdout = execFileSync(
      HOME_BIN,
      ["hook", "omp", event, "--connector", CONNECTOR_ID],
      { input: JSON.stringify(payload), encoding: "utf8" },
    );
    const text = (stdout || "").trim();
    if (text === "") return { decision: "allow" };
    return JSON.parse(text);
  } catch {
    // Fail-open — never break an OMP tool call / lifecycle event.
    return null;
  }
}

// OMP exposes the project dir via PI_PROJECT_DIR (PI_*-prefixed only); fall
// through to cwd. The plugin process is long-lived, so resolve once at load.
const PROJECT_DIR = process.env.PI_PROJECT_DIR || process.cwd();

// Derive a stable session id from OMP's session manager when available
// (ctx.sessionManager.getSessionFile()), else a wall-clock token. The id is
// rebound on each session_start so multi-session reuse stays attributed.
let SESSION_ID = "";
function deriveSessionId(ctx) {
  try {
    const f = ctx && ctx.sessionManager && typeof ctx.sessionManager.getSessionFile === "function"
      ? ctx.sessionManager.getSessionFile()
      : "";
    if (f && typeof f === "string") return f;
  } catch {
    // best effort
  }
  return "omp-" + Date.now();
}
`;

    const handlers: string[] = [];

    if (has("SessionStart")) {
      handlers.push(`  // SessionStart → rebind the session id and notify the connector.
  pi.on("session_start", (_event, ctx) => {
    SESSION_ID = deriveSessionId(ctx);
    bridge("SessionStart", { sessionId: SESSION_ID, projectDir: PROJECT_DIR });
    return undefined;
  });`);
    }

    if (has("PreToolUse")) {
      handlers.push(`  // PreToolUse → block via { block, reason }. OMP tool_call cannot mutate
  // args, so "ask" degrades to a block (the safe direction); "modify" degrades
  // to ALLOW (no-block), matching opencode/claude-code — only deny/ask block.
  pi.on("tool_call", (event) => {
    const payload = {
      toolName: (event && event.toolName) || "",
      toolInput: (event && event.input) || {},
      sessionId: SESSION_ID,
      projectDir: PROJECT_DIR,
    };
    const res = bridge("PreToolUse", payload);
    if (!res) return undefined;
    if (res.decision === "deny" || res.decision === "ask") {
      return { block: true, reason: res.reason || "Blocked by ${ctx.connector.id}" };
    }
    return undefined;
  });`);
    }

    if (has("PostToolUse")) {
      handlers.push(`  // PostToolUse → observe tool results (no output-rewrite surface upstream).
  pi.on("tool_result", (event) => {
    const content = (event && Array.isArray(event.content)) ? event.content : [];
    const toolOutput = content
      .filter((c) => c && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\\n");
    const payload = {
      toolName: (event && event.toolName) || "",
      toolInput: (event && event.input) || {},
      toolOutput,
      isError: !!(event && event.isError),
      sessionId: SESSION_ID,
      projectDir: PROJECT_DIR,
    };
    bridge("PostToolUse", payload);
    return undefined;
  });`);
    }

    if (has("PreCompact")) {
      handlers.push(`  // PreCompact → notify before OMP compacts the context window.
  pi.on("session_before_compact", () => {
    bridge("PreCompact", { sessionId: SESSION_ID, projectDir: PROJECT_DIR });
    return undefined;
  });`);
    }

    const factory = `
export default function plugin(pi) {
${handlers.join("\n\n")}
}
`;

    return header + factory;
  }

  // ── Runtime: parse OUR bridge payload → normalized event ───────────────

  /**
   * `raw` is the payload OUR generated plugin posts (NOT a host-native shape):
   *   { toolName?, toolInput?, toolOutput?, isError?, sessionId?, projectDir? }
   * so this maps straight through.
   */
  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as OmpBridgePayload;
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
      case "PreCompact": {
        const ev: PreCompactEvent = { ...base };
        return ev;
      }
      case "SessionStart": {
        const ev: SessionStartEvent = { ...base, source: "startup" };
        return ev;
      }
      default:
        // Other canonical events are not surfaced by OMP; treat as a
        // session-start-shaped no-op so the dispatcher fails open gracefully.
        return { ...base, source: "startup" } satisfies SessionStartEvent;
    }
  }

  // ── Runtime: normalized response → reply the generated bridge parses ───

  /**
   * Unlike json-stdio hosts (whose reply is the host's NATIVE control payload),
   * OUR generated bridge consumes this stdout directly. So the reply body is the
   * NORMALIZED HookResponse itself — the bridge JSON.parses it and maps decision
   * → OMP's { block, reason } for tool_call (and ignores it otherwise).
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
    const entryPath = this.getHookConfigPath(ctx);
    const manifestPath = join(this.extensionDir(ctx), "package.json");
    const connectorId = ctx.connector.id;
    const hasHooks = ctx.connector.hookEvents.length > 0;

    return [
      {
        name: `${this.name}: mcp.json present`,
        check: () =>
          existsSync(serverPath)
            ? { status: "OK", detail: serverPath }
            : { status: "FAIL", detail: `not found: ${serverPath}` },
      },
      {
        name: `${this.name}: ${MCP_ROOT_KEY}.${connectorId} registered`,
        check: () => {
          if (!ctx.connector.server) {
            return { status: "OK", detail: "no MCP server declared" };
          }
          const cfg = this.readJson<{ [k: string]: Record<string, unknown> }>(
            serverPath,
          );
          const bucket = cfg?.[MCP_ROOT_KEY];
          if (!cfg || !bucket) {
            return {
              status: "FAIL",
              detail: `no ${MCP_ROOT_KEY} in ${serverPath}`,
            };
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
        name: `${this.name}: extension package present`,
        check: () => {
          if (!hasHooks) return { status: "OK", detail: "no hooks declared" };
          if (!existsSync(manifestPath)) {
            return { status: "FAIL", detail: `not found: ${manifestPath}` };
          }
          return existsSync(entryPath)
            ? { status: "OK", detail: entryPath }
            : { status: "FAIL", detail: `not found: ${entryPath}` };
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

export const adapter = new OMPAdapter();
export default adapter;
