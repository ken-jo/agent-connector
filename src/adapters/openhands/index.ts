/**
 * adapters/openhands — OpenHands (All-Hands-AI, ex-OpenDevin) platform adapter.
 *
 * OpenHands is a **json-stdio** host (the `openhands` CLI, installed via
 * `uv tool install openhands`). It exposes TWO native config surfaces that live
 * in DIFFERENT files, so getServerConfigPath ≠ getHookConfigPath:
 *
 *   1. MCP servers — `mcp.json` (root key `mcpServers`), in the CLI persistence
 *      dir, which is USER-scoped only:
 *        - persistence dir → ~/.openhands  (override: $OPENHANDS_PERSISTENCE_DIR)
 *        - file            → <persistence>/mcp.json
 *      Byte-confirmed from openhands_cli/locations.py (MCP_CONFIG_FILE="mcp.json",
 *      get_persistence_dir() → ~/.openhands, env $OPENHANDS_PERSISTENCE_DIR) and
 *      openhands_cli/mcp/mcp_utils.py (MCPConfig.from_dict({"mcpServers": {}}),
 *      config.mcpServers[name]; the error path literally suggests "create
 *      ~/.openhands/mcp.json manually"). Native server entry shape is FastMCP's
 *      StdioMCPServer { command, args, env, transport:"stdio", cwd? } and
 *      RemoteMCPServer { url, transport, headers } (fastmcp.mcp_config).
 *      There is NO project-scoped mcp.json for the CLI — it reads the single
 *      persistence-dir file — so installServer ALWAYS targets the user file.
 *
 *   2. Hooks — a SEPARATE `.openhands/hooks.json` (root key `hooks`, the
 *      Claude-Code-plugin-compatible wrapper). OpenHands ships a hook system
 *      that the SDK explicitly documents as honoring "Claude Code plugin hook
 *      files" (openhands-sdk/openhands/sdk/hooks/config.py — the
 *      `_normalize_hooks_input` validator unwraps {"hooks": {...}} and accepts
 *      PascalCase keys). HookConfig.load() searches, in order:
 *        - <working_dir>/.openhands/hooks.json   (project scope)
 *        - ~/.openhands/hooks.json               (user scope)
 *      first-found wins, so BOTH scopes are valid; project takes precedence.
 *      Registrations use the Claude NESTED-rule shape:
 *        { hooks: { <Event>: [ { matcher?, hooks:[{ type:"command", command }] } ] } }
 *      which is exactly what the shared hook-merge engine writes.
 *
 * Supported events (Claude-compatible, byte-confirmed from
 * openhands-sdk/openhands/sdk/hooks/types.py HookEventType): PreToolUse,
 * PostToolUse, UserPromptSubmit, SessionStart, SessionEnd, Stop. OpenHands has
 * NO Notification / PreCompact / SubagentStop / PermissionRequest /
 * PostToolUseFailure / SubagentStart, so those degrade to a warn/skip at install.
 *
 * Runtime wire DIVERGES from Claude (do NOT assume Claude field names — verified
 * against HookEvent.model_dump_json() with use_enum_values=True in types.py):
 *   - `event_type`  (PascalCase string)   — NOT `hook_event_name`
 *   - `tool_name`, `tool_input`           — Claude-identical
 *   - `tool_response` is a DICT           — Claude-identical key, object value
 *   - `message`     (the prompt text)     — NOT `prompt`
 *   - `session_id`                        — Claude-identical
 *   - `working_dir` (the cwd)             — NOT `cwd`
 *   - `metadata`    (free dict)           — no normalized field
 *
 * Reply protocol (byte-confirmed from hooks/executor.py + the 33_hooks example):
 *   exit 0 → success; stdout is parsed as a FLAT JSON object with keys
 *   `decision` ("allow"|"deny"), `reason`, `additionalContext`. There is NO
 *   `hookSpecificOutput` envelope and NO "ask" decision (HookDecision is
 *   allow|deny; ASK is commented-out/future). exit 2 also blocks. So:
 *     - deny    → {"decision":"deny","reason":...}     (exit 0)
 *     - context → {"additionalContext":...}            (exit 0)
 *     - ask     → unsupported; degrades to a deny-style block with the reason
 *                 (OpenHands has no native confirm dialog on the hook wire)
 *   canModifyOutput is false (it cannot rewrite already-emitted tool output);
 *   canInjectSessionContext is true (additionalContext is honored).
 *
 * Env handling: env/header/url refs are resolved to literals at install time via
 * resolveEnvRefsDeep — the safe default matching the Droid/Kiro/Qwen adapters.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { BaseAdapter, type HookMergeDescriptor } from "../base.js";
import type { Adapter, HookReply, InstallContext, NormalizedEvent } from "../spi.js";
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
  SessionEndEvent,
  SessionStartEvent,
  StopEvent,
  Transport,
  UserPromptSubmitEvent,
} from "../../core/types.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  buildWrappedStdio,
  isHomeBinHookCommand,
} from "../../core/spawn.js";
import { normalizeSessionSource } from "../claude-code/wire.js";

const HOST: PlatformId = "openhands";
const MCP_ROOT_KEY = "mcpServers";

/**
 * Resolve the OpenHands CLI persistence dir. Byte-confirmed from
 * openhands_cli/locations.py: `os.environ.get("OPENHANDS_PERSISTENCE_DIR",
 * os.path.expanduser("~/.openhands"))`. The MCP `mcp.json` lives here regardless
 * of install scope (the CLI has no project-scoped mcp.json).
 */
function persistenceDir(): string {
  return process.env.OPENHANDS_PERSISTENCE_DIR ?? join(homedir(), ".openhands");
}

/**
 * Canonical events OpenHands actually fires (HookEventType in types.py). Event
 * names are Claude-identical PascalCase, so each canonical name registers 1:1.
 * OpenHands has no Notification / PreCompact / SubagentStop / PermissionRequest /
 * PostToolUseFailure / SubagentStart — those warn/skip at install time.
 */
const SUPPORTED_EVENTS: ReadonlySet<HookEventName> = new Set<HookEventName>([
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
]);

/**
 * Native MCP server entry shapes OpenHands accepts under `mcpServers` (FastMCP
 * StdioMCPServer / RemoteMCPServer). A stdio entry carries an explicit
 * `transport:"stdio"` discriminator; remote transports register a URL.
 */
interface OpenHandsStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  transport: "stdio";
}
interface OpenHandsRemoteServer {
  url: string;
  transport: "http" | "sse";
  headers?: Record<string, string>;
}

/** A single OpenHands native hook registration entry (Claude-shaped, nested). */
interface OpenHandsHookEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string }>;
}

/** The shape of OpenHands' hooks.json (only the parts we touch). */
interface OpenHandsHooksFile {
  hooks?: Record<string, OpenHandsHookEntry[]>;
  [key: string]: unknown;
}

/**
 * Raw OpenHands CLI hook stdin payload. These are the EXACT serialized field
 * names of the SDK's HookEvent (use_enum_values=True), NOT Claude's wire —
 * see the header note on the divergences (`event_type`, `working_dir`,
 * `message`, `tool_response` dict).
 */
interface OpenHandsWireInput {
  /** PascalCase event string ("PreToolUse", …). */
  event_type?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Tool result is a dict on the OpenHands wire (Claude sends it too). */
  tool_response?: Record<string, unknown> | null;
  /** UserPromptSubmit text rides on `message` (NOT `prompt`). */
  message?: string;
  session_id?: string;
  /** The cwd rides on `working_dir` (NOT `cwd`). */
  working_dir?: string;
  /** Free-form dict; no normalized field. */
  metadata?: Record<string, unknown>;
  /** Injected by the entrypoint so the runtime knows which connector to dispatch. */
  connector?: unknown;
}

export class OpenHandsAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "OpenHands";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: AGENTS.md-first managed block via the BaseAdapter default.
    supportsMemory: true,
    preToolUse: true,
    postToolUse: true,
    userPromptSubmit: true,
    sessionStart: true,
    sessionEnd: true,
    stop: true,
    // OpenHands fires NONE of these on its hook wire (HookEventType has only the
    // six above) — install reports the standard skip-warn for any of them.
    // The two REQUIRED PlatformCapabilities flags below are explicitly false;
    // subagentStop / permissionRequest / postToolUseFailure / subagentStart are
    // optional and stay unset (read as ?? false) — no OpenHands analog.
    preCompact: false,
    notification: false,

    // PreToolUse/UserPromptSubmit/Stop can block (exit 2 or {"decision":"deny"}),
    // but the hook wire cannot rewrite tool ARGS or already-emitted tool OUTPUT.
    canModifyArgs: false,
    canModifyOutput: false,
    // additionalContext on the stdout reply is honored (executor.py parses it).
    canInjectSessionContext: true,
    // OpenHands registers stdio + remote (Streamable HTTP / SSE) MCP servers.
    transports: ["stdio", "http"],
    // Content surfaces (commands/skills/subagents/statusline/actions) are NOT
    // wired: OpenHands' CLI uses microagents + an interactive TUI rather than a
    // Claude-style file-per-command/skill/subagent tree, and no first-party
    // file layout for those was byte-confirmed. Left unset (honest CEILING).
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = persistenceDir();
    const userMcp = join(userDir, "mcp.json");
    const projDir = join(projectDir, ".openhands");
    const projHooks = join(projDir, "hooks.json");

    const userInstalled = existsSync(userDir) || existsSync(userMcp);
    const projInstalled = existsSync(projDir) || existsSync(projHooks);
    const installed = userInstalled || projInstalled;
    // MCP only lives at the user persistence dir; project scope only carries
    // hooks. Default the reported scope to user (where the MCP config lives).
    const scope = userInstalled || !projInstalled ? "user" : "project";
    const configPath = scope === "user" ? userMcp : projHooks;

    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath,
      scope,
      reason: installed
        ? `found OpenHands config (${scope}) at ${configPath}`
        : `no OpenHands config at ${userDir} or ${projDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".openhands")
      : persistenceDir();
  }

  /**
   * MCP `mcp.json` lives in the CLI persistence dir, which is USER-scoped only —
   * the CLI reads exactly one `<persistence>/mcp.json` and has no project
   * variant. So this ALWAYS resolves to the user persistence dir regardless of
   * ctx.scope (writing a project `.openhands/mcp.json` the CLI never reads would
   * be a silent no-op).
   */
  getServerConfigPath(_ctx: InstallContext): string {
    return join(persistenceDir(), "mcp.json");
  }

  /**
   * Hooks live in a SEPARATE `.openhands/hooks.json`. HookConfig.load searches
   * <working_dir>/.openhands/hooks.json then ~/.openhands/hooks.json, so both
   * scopes are honored — project scope → <projectDir>/.openhands, user scope →
   * the persistence dir.
   */
  getHookConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "hooks.json");
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
            ? "server registration disabled for openhands"
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

  /** Render a normalized ServerDef into OpenHands' native mcpServers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): OpenHandsStdioServer | OpenHandsRemoteServer {
    const transport: Transport = server.transport;

    if (transport === "stdio") {
      let command = server.command ?? "";
      let args = [...(server.args ?? [])];

      // Transparent telemetry wrapping: route the real command through
      // `<homeBin> serve --connector <id> -- <command> <args...>`.
      ({ command, args } = buildWrappedStdio(ctx, server, this.id, command, args));

      // Resolve every ${env:VAR} to a literal at install time (safe path).
      const entry: OpenHandsStdioServer = {
        command: resolveEnvRefsDeep(command),
        transport: "stdio",
      };
      if (args.length > 0) entry.args = resolveEnvRefsDeep(args);
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      return entry;
    }

    // http / sse — OpenHands registers a URL (FastMCP RemoteMCPServer). Default
    // a non-stdio transport to "http" (the recommended Streamable HTTP form);
    // honor an explicit "sse".
    const entry: OpenHandsRemoteServer = {
      url: resolveEnvRefsDeep(server.url ?? ""),
      transport: transport === "sse" ? "sse" : "http",
    };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Resolve `${env:VAR}` references to literals at
   * install time (the safe path matching Droid).
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Hook install / uninstall (separate hooks.json, nested-rule shape) ─────

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.hooks === false) {
      return [{ platform: this.id, action: "skip", detail: "hooks disabled for openhands" }];
    }
    if (connector.hookEvents.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no hooks" }];
    }

    const pending = connector.hookEvents.map((event) => ({
      event,
      matcher: connector.hooks[event]?.matcher ?? "",
    }));
    return this.upsertHookEntries(
      ctx,
      this.getHookConfigPath(ctx),
      pending,
      this.hookDescriptor(ctx),
    );
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    return this.removeHookEntries(ctx, this.getHookConfigPath(ctx), this.hookDescriptor(ctx));
  }

  /**
   * OpenHands' hook-merge descriptor (NESTED shape `{ matcher, hooks: [...] }`).
   * Ownership is CONNECTOR-GENERIC (ANY of our commands in the entry's inner
   * `hooks`, not a specific-command match), identical to Droid:
   *  - mapEvent = drop events outside SUPPORTED_EVENTS; supported event names are
   *    Claude-identical, so they map 1:1.
   *  - entryOwnsCommand reuses isOurCommand over the inner commands.
   *  - uninstall = inner-strip ONLY (ownsEntryForRemove never-true).
   */
  private hookDescriptor(ctx: InstallContext): HookMergeDescriptor<OpenHandsHookEntry> {
    return {
      mapEvent: (e) => (SUPPORTED_EVENTS.has(e as HookEventName) ? e : undefined),
      unmappedWarnDetail: (e) => `${e} has no OpenHands hook equivalent — skipped`,
      renderEntry: (_event, matcher, command) => ({
        matcher,
        hooks: [{ type: "command", command }],
      }),
      entryOwnsCommand: (entry, _command) =>
        (entry.hooks ?? []).some((h) => this.isOurCommand(h.command, ctx)),
      ownsEntryForRemove: () => () => false,
      stripInner: (c) => (entry) => {
        const innerBefore = entry.hooks?.length ?? 0;
        const inner = (entry.hooks ?? []).filter((h) => !this.isOurCommand(h.command, c));
        return {
          next: inner.length > 0 ? { matcher: entry.matcher ?? "", hooks: inner } : null,
          removed: innerBefore - inner.length,
        };
      },
      skipDetail: (event) => `hooks.${event} already registered`,
      removeDetail: (event, removed) => `hooks.${event} (${removed})`,
      absentDetail: "no hooks section present",
      noMatchDetail: "no matching hook entries",
    };
  }

  /** True when a hook command references our home binary AND this connector id
   *  (anchored so a shared-prefix id can't collide — see isHomeBinHookCommand). */
  private isOurCommand(command: string | undefined, ctx: InstallContext): boolean {
    return isHomeBinHookCommand(command, ctx.homeBinPath, ctx.connector.id);
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const mcpPath = this.getServerConfigPath(ctx);
    const hookPath = this.getHookConfigPath(ctx);
    const connectorId = ctx.connector.id;
    const homeBin = ctx.homeBinPath;
    const hookEvents = ctx.connector.hookEvents;
    return [
      {
        name: `${this.name}: mcp.json present`,
        check: () =>
          existsSync(mcpPath)
            ? { status: "OK", detail: mcpPath }
            : { status: "FAIL", detail: `not found: ${mcpPath}` },
      },
      {
        name: `${this.name}: server entry registered`,
        check: () => {
          if (!ctx.connector.server) {
            return { status: "OK", detail: "no MCP server declared" };
          }
          const cfg = this.readJson<{ [k: string]: Record<string, unknown> }>(mcpPath);
          const bucket = cfg?.[MCP_ROOT_KEY];
          if (!cfg || !bucket) {
            return { status: "FAIL", detail: `no ${MCP_ROOT_KEY} in ${mcpPath}` };
          }
          return connectorId in bucket
            ? { status: "OK", detail: `${MCP_ROOT_KEY}.${connectorId} present` }
            : {
                status: "FAIL",
                detail: `no ${MCP_ROOT_KEY}.${connectorId} in ${mcpPath}`,
              };
        },
      },
      {
        name: `${this.name}: hook command registered`,
        check: () => {
          if (hookEvents.length === 0) {
            return { status: "OK", detail: "no hooks declared" };
          }
          const file = this.readJson<OpenHandsHooksFile>(hookPath);
          if (!file) return { status: "FAIL", detail: `cannot read ${hookPath}` };
          const hooks = file.hooks ?? {};
          const registered = Object.values(hooks).some((entries) =>
            (entries ?? []).some((e) =>
              (e.hooks ?? []).some((h) =>
                isHomeBinHookCommand(h.command, homeBin, connectorId),
              ),
            ),
          );
          return registered
            ? { status: "OK", detail: "hook command present" }
            : { status: "FAIL", detail: `no hook for ${connectorId} in ${hookPath}` };
        },
      },
    ];
  }

  // ── Runtime: parse OpenHands stdin JSON → normalized event ─────────────────
  // The wire field names DIVERGE from Claude (event_type / working_dir / message
  // / tool_response-dict) — see the header. Reading Claude's names here would be
  // a silent false-friend (the kimi-code bug class).

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as OpenHandsWireInput;
    const connectorId = typeof input.connector === "string" ? input.connector : "";
    const sessionId = typeof input.session_id === "string" ? input.session_id : "";
    const projectDir =
      typeof input.working_dir === "string" ? input.working_dir : undefined;

    const base = {
      hostPlatform: HOST,
      connectorId,
      sessionId,
      raw,
      ...(projectDir !== undefined ? { projectDir } : {}),
    } as const;

    switch (event) {
      case "PreToolUse": {
        const ev: PreToolUseEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
        };
        return ev;
      }
      case "PostToolUse": {
        const ev: PostToolUseEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          ...(toolResponseToString(input.tool_response) !== undefined
            ? { toolOutput: toolResponseToString(input.tool_response) }
            : {}),
        };
        return ev;
      }
      case "UserPromptSubmit": {
        // The prompt text rides on `message` (NOT `prompt`).
        const ev: UserPromptSubmitEvent = {
          ...base,
          prompt: typeof input.message === "string" ? input.message : "",
        };
        return ev;
      }
      case "SessionStart": {
        // OpenHands SessionStart carries no documented `source` discriminator on
        // the HookEvent wire; normalizeSessionSource(undefined) → the safe
        // "startup" default.
        const ev: SessionStartEvent = {
          ...base,
          source: normalizeSessionSource(undefined),
        };
        return ev;
      }
      case "SessionEnd": {
        // No documented `reason` enum on the HookEvent wire — omit the field.
        const ev: SessionEndEvent = { ...base };
        return ev;
      }
      case "Stop": {
        // No stop_hook_active loop-guard field on the OpenHands wire.
        const ev: StopEvent = { ...base };
        return ev;
      }
      default: {
        // OpenHands never delivers Notification / PreCompact / SubagentStop /
        // PermissionRequest / PostToolUseFailure / SubagentStart (no native
        // equivalent — see SUPPORTED_EVENTS). Surface it loudly rather than
        // silently mis-parse.
        throw new Error(`unsupported openhands hook event: ${String(event)}`);
      }
    }
  }

  // ── Runtime: normalized response → OpenHands native (FLAT JSON) hook reply ──
  // Reply is a FLAT top-level object (NO hookSpecificOutput envelope) parsed by
  // hooks/executor.py: keys `decision` (allow|deny), `reason`, `additionalContext`.
  // There is NO "ask" decision (HookDecision is allow|deny only).

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    const decision = response.decision ?? "allow";

    // SessionStart / SessionEnd are observe-only (cannot block); they carry no
    // block surface. SessionStart still honors additionalContext, so it falls
    // through to the `context` branch; SessionEnd is an unconditional no-op.
    if (event === "SessionEnd") {
      return { exitCode: 0 };
    }

    // deny → block with a reason. OpenHands has no "ask" on the hook wire, so an
    // "ask" decision degrades to a deny-style block carrying the reason (the
    // closest honest mapping — a hook that wants confirmation blocks and tells
    // the agent why, rather than silently passing through).
    if (decision === "deny" || decision === "ask") {
      return this.stdout({
        decision: "deny",
        reason:
          response.reason ??
          (decision === "ask" ? "Confirmation required by hook" : "Blocked by hook"),
      });
    }

    // context → inject soft guidance (OpenHands honors additionalContext).
    if (decision === "context" && response.additionalContext) {
      return this.stdout({ additionalContext: response.additionalContext });
    }

    // allow / modify (unsupported — exit-code/decision protocol only) / void →
    // pass through with exit 0.
    return { exitCode: 0 };
  }

  private stdout(payload: unknown): HookReply {
    return { exitCode: 0, stdout: JSON.stringify(payload) };
  }
}

/** Coerce an OpenHands PostToolUse `tool_response` (a dict) into a string. */
function toolResponseToString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const adapter = new OpenHandsAdapter();
export default adapter;
