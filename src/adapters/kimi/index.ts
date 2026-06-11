/**
 * adapters/kimi — Kimi CLI (Moonshot) platform adapter for agent-connector.
 *
 * Kimi CLI is a json-stdio host: the runner pipes a JSON payload to a command on
 * stdin and reads an exit code (and optional reason) back. Two native config
 * files live under the Kimi base dir (`$KIMI_HOME` || `$KIMI_CODE_HOME` || `~/.kimi`):
 *   - mcp.json     → `mcpServers.<id>` MCP registration (JSON, stdio shape:
 *     {command,args,env}). Handled via BaseAdapter's JSON helpers.
 *   - config.toml  → `[[hooks]]` array-of-tables (TOML), each table
 *     { event, matcher, command }. Parsed/serialized with @iarna/toml: every
 *     config VALUE (unrelated sections, sibling hooks, scalars) is preserved,
 *     but a parse→stringify round-trip does NOT preserve user COMMENTS or the
 *     original key ordering/formatting in config.toml (values survive; comments
 *     and layout do not).
 *
 * Hook surface is intentionally narrow: Kimi CLI only honors a PreToolUse DENY.
 * It cannot rewrite tool args, rewrite tool output, or inject session context —
 * so every other decision degrades to a silent allow (exit 0). Kimi Code uses
 * the Claude/Codex reply shape: a PreToolUse deny is signalled with EXIT 0 plus
 * a `hookSpecificOutput` JSON object on stdout carrying
 * permissionDecision:"deny" + permissionDecisionReason — that is how Kimi's
 * runner blocks the pending tool call. An allow is exit 0 with empty stdout.
 *
 * E1 extension events (verified against moonshotai.github.io/kimi-cli hooks):
 *   - PostToolUseFailure — native (tool_name, tool_input, error; tool-name
 *     matcher). Feedback-only: Kimi's exit-0 protocol adds non-empty stdout to
 *     context, so "context" (and a degraded "deny") emit plain-text stdout.
 *   - SubagentStart / SubagentStop — native, but with Kimi-specific wire
 *     fields: agent_name (→ normalized agentType; there is no agent_id) plus
 *     prompt (start) / response (stop → lastAssistantMessage). SubagentStop
 *     deny uses Kimi's generic block protocol: EXIT 2 with the reason on
 *     stderr (fed back to the model as correction).
 *   - PermissionRequest — NO Kimi analog (the permission prompt is only
 *     observable as a Notification); declared hooks for it warn-skip at
 *     install and the capability flag stays unset.
 *
 * Path confidence: the `~/.kimi` base + mcp.json (`mcpServers`) layout is
 * LIVE-CONFIRMED against the real Moonshot Kimi CLI (v1.46.0, `pip install
 * kimi-cli`) via a `kimi mcp` probe. We still install + doctor-report presence
 * so a future path move surfaces as a FAIL rather than silently misbehaving.
 *
 * FUTURE COVERAGE (non-functional note — no behavior change here): beyond the
 * wired PreToolUse + PostToolUseFailure + SubagentStart/SubagentStop, Kimi CLI
 * supports a wider event surface — Stop, StopFailure, UserPromptSubmit,
 * PostToolUse, SessionStart, SessionEnd, PreCompact, PostCompact and
 * Notification. Kimi also has a PLUGIN system (plugins live at
 * `<base>/plugins/<name>/kimi.plugin.json`) and a SKILLS surface
 * (`~/.kimi/skills/`). None of these are covered yet; they are flagged here
 * as candidates for a future events/plugins/skills expansion of the adapter.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import TOML from "@iarna/toml";

import { BaseAdapter } from "../base.js";
import type { Adapter, HookReply, InstallContext, NormalizedEvent } from "../spi.js";
import type {
  ChangeRecord,
  DetectedPlatform,
  HealthCheck,
  HookEventName,
  HookParadigm,
  HookResponse,
  NotificationEvent,
  PermissionRequestEvent,
  PlatformCapabilities,
  PlatformId,
  PostToolUseEvent,
  PostToolUseFailureEvent,
  PreCompactEvent,
  PreToolUseEvent,
  SessionEndEvent,
  SessionStartEvent,
  ServerDef,
  StopEvent,
  SubagentStartEvent,
  SubagentStopEvent,
  Transport,
  UserPromptSubmitEvent,
} from "../../core/types.js";
import { ensureDir } from "../../core/paths.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  buildHomeBinHookCommand,
  buildServeWrapperCommand,
  isHomeBinHookCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";

const HOST: PlatformId = "kimi";
const MCP_ROOT_KEY = "mcpServers";

// ─────────────────────────────────────────────────────────────────────────
// Native shapes
// ─────────────────────────────────────────────────────────────────────────

/** Raw Kimi CLI hook payload (Claude-style: PascalCase event, snake_case fields). */
interface KimiHookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  prompt?: string;
  is_error?: boolean;
  stop_hook_active?: boolean;
  trigger?: string;
  message?: string;
  reason?: string;
  // PostToolUseFailure — the failure message.
  error?: string;
  // SubagentStart / SubagentStop — Kimi sends agent_name (NOT agent_id /
  // agent_type) plus prompt (start) / response (stop).
  agent_name?: string;
  response?: string;
  connector?: string;
}

/** One `[[hooks]]` array-of-tables entry as Kimi stores it in config.toml. */
interface KimiTomlHook {
  event: string;
  matcher?: string;
  command: string;
  [key: string]: unknown;
}

/** Parsed config.toml shape we care about (rest preserved verbatim). */
interface KimiConfigToml {
  hooks?: KimiTomlHook[];
  [key: string]: unknown;
}

/** Native stdio MCP server entry under `mcpServers`. */
interface KimiStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Native remote MCP server entry under `mcpServers`. */
interface KimiHttpServer {
  url: string;
  headers?: Record<string, string>;
}

/**
 * Kimi CLI hook events agent-connector registers: the PreToolUse deny gate plus
 * the E1 extension events Kimi fires natively (PostToolUseFailure +
 * SubagentStart/SubagentStop). The matcher below is charset-clean (Rust-regex
 * safe: no look-around) so Kimi's matcher accepts it. Copied in spirit from the
 * Codex/context-mode matchers.
 */
const KIMI_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
] as const;
type KimiHookEventName = (typeof KIMI_HOOK_EVENTS)[number];

/**
 * Newer canonical events with NO Kimi analog: there is no permission-dialog
 * hook (the prompt is only observable via Notification). Declared hooks for
 * these warn-skip at install so the degradation is reported, never silent.
 * (The legacy silent drop of host-supported-but-unwired events — SessionStart,
 * Stop, … — predates this convention and is deliberately left untouched; see
 * the FUTURE COVERAGE header note.)
 */
const WARN_SKIP_EVENTS: ReadonlySet<HookEventName> = new Set(["PermissionRequest"]);

const PRE_TOOL_USE_MATCHER =
  "Bash|Shell|shell|exec_command|Read|Edit|Write|WebFetch|Agent|mcp__";

// ─────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────

export class KimiAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Kimi CLI";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    // PreToolUse deny is the only honored hook decision on Kimi CLI.
    preToolUse: true,
    postToolUse: false,
    preCompact: false,
    sessionStart: false,
    sessionEnd: false,
    userPromptSubmit: false,
    stop: false,
    notification: false,
    // E1 events Kimi fires natively. permissionRequest stays unset — Kimi has
    // no permission-dialog hook, so a declared hook for it warn-skips at install.
    postToolUseFailure: true,
    subagentStart: true,
    subagentStop: true,
    // Kimi cannot rewrite args/output nor inject session context — deny-only.
    canModifyArgs: false,
    canModifyOutput: false,
    canInjectSessionContext: false,
    transports: ["stdio", "http"],
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(_projectDir: string): DetectedPlatform {
    const baseDir = this.baseDir();
    const mcpPath = join(baseDir, "mcp.json");
    const configPath = join(baseDir, "config.toml");
    const installed = existsSync(baseDir) || existsSync(mcpPath) || existsSync(configPath);
    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath: mcpPath,
      scope: "user",
      reason: installed
        ? `found Kimi CLI config under ${baseDir}`
        : `no Kimi CLI config at ${baseDir}`,
      // Path confidence is medium even when present: the ~/.kimi-code layout is the
      // documented shape but less battle-tested than Claude/Codex.
      confidence: "medium",
    };
  }

  // ── Native paths ───────────────────────────────────────────────────────

  getConfigDir(_ctx: InstallContext): string {
    return this.baseDir();
  }

  /** MCP registration file (JSON). */
  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "mcp.json");
  }

  /** Hook registration file (TOML) — distinct from the MCP file. */
  getHookConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "config.toml");
  }

  /**
   * `$KIMI_HOME` || `$KIMI_CODE_HOME` (with `~` expansion) || `~/.kimi`.
   * The real Moonshot Kimi CLI (v1.46.0) keeps its config under `~/.kimi`
   * (mcp.json · mcpServers) — verified by a live `kimi mcp` probe; the legacy
   * `~/.kimi-code` guess was wrong. `$KIMI_CODE_HOME` is still honored as an
   * override for back-compat alongside the newer `$KIMI_HOME`.
   */
  private baseDir(): string {
    const env = process.env.KIMI_HOME ?? process.env.KIMI_CODE_HOME;
    if (env && env.trim() !== "") {
      if (env.startsWith("~")) {
        return join(homedir(), env.replace(/^~[/\\]?/, ""));
      }
      return env;
    }
    return join(homedir(), ".kimi");
  }

  // ── MCP server install / uninstall (mcp.json → mcpServers.<id>) ──────────

  installServer(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    const override = connector.platforms[HOST]?.server;
    if (!connector.server || override === false) {
      return [
        {
          platform: this.id,
          action: "skip",
          detail: connector.server
            ? "server registration disabled for kimi"
            : "connector declares no MCP server",
        },
      ];
    }

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

  /**
   * Render a normalized ServerDef into Kimi's native mcpServers entry. Kimi's
   * mcp.json has no documented native interpolation, so `${env:VAR}` refs are
   * resolved to literals at install time (same posture as the TOML hosts).
   */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): KimiStdioServer | KimiHttpServer {
    const transport: Transport = server.transport;

    if (transport === "stdio") {
      let command = server.command ?? "";
      let args = [...(server.args ?? [])];

      // Transparent telemetry wrapping: route through
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

      command = resolveEnvRefsDeep(command);
      args = resolveEnvRefsDeep(args);

      const entry: KimiStdioServer = { command };
      if (args.length > 0) entry.args = args;
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      return entry;
    }

    // http (and any other remote transport) — Kimi registers a URL entry.
    const entry: KimiHttpServer = { url: resolveEnvRefsDeep(server.url ?? "") };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /** Resolve env/header values to literals (no native interpolation on Kimi). */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(resolveEnvRefsDeep(env))) {
      out[k] = String(v);
    }
    return out;
  }

  // ── Hook install / uninstall (config.toml → [[hooks]]) ───────────────────

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.hooks === false) {
      return [{ platform: this.id, action: "skip", detail: "hooks disabled for kimi" }];
    }

    const events = this.effectiveHookEvents(ctx);
    const dropped = this.warnSkipHookEvents(ctx);
    const path = this.getHookConfigPath(ctx);

    if (events.length === 0 && dropped.length === 0) {
      return [{ platform: this.id, action: "skip", path, detail: "no hooks declared" }];
    }

    const cfg = this.readToml(path);
    const hooks = (cfg.hooks ??= []);
    const changes: ChangeRecord[] = [];
    let mutated = false;

    // Declared events Kimi cannot fire are reported, never silently dropped.
    for (const event of dropped) {
      changes.push({
        platform: this.id,
        action: "warn",
        path,
        detail: `${event} has no Kimi CLI hook equivalent — skipped`,
      });
    }

    for (const event of events) {
      const desired = this.renderHook(ctx, event);
      // Match our entry FOR THIS EVENT — isOurHook alone would find whichever
      // of our entries comes first and clobber a sibling event's registration.
      const idx = hooks.findIndex((h) => this.isOurHook(ctx, h) && h?.event === event);
      if (idx < 0) {
        hooks.push(desired);
        changes.push({ platform: this.id, action: "create", path, detail: `hooks.${event}` });
        mutated = true;
      } else if (JSON.stringify(hooks[idx]) !== JSON.stringify(desired)) {
        hooks[idx] = desired;
        changes.push({ platform: this.id, action: "update", path, detail: `hooks.${event}` });
        mutated = true;
      } else {
        changes.push({ platform: this.id, action: "skip", path, detail: `hooks.${event}` });
      }
    }

    if (mutated) this.writeToml(path, cfg, ctx.dryRun);
    return changes;
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const path = this.getHookConfigPath(ctx);
    if (!existsSync(path)) {
      return [{ platform: this.id, action: "skip", path, detail: "no config.toml" }];
    }
    const cfg = this.readToml(path);
    const hooks = cfg.hooks;
    if (!Array.isArray(hooks) || hooks.length === 0) {
      return [{ platform: this.id, action: "skip", path, detail: "no hooks present" }];
    }

    const kept = hooks.filter((h) => !this.isOurHook(ctx, h));
    const removed = hooks.length - kept.length;
    if (removed === 0) {
      return [{ platform: this.id, action: "skip", path, detail: "no agent-connector hooks present" }];
    }

    if (kept.length > 0) cfg.hooks = kept;
    else delete cfg.hooks;
    this.writeToml(path, cfg, ctx.dryRun);
    return [{ platform: this.id, action: "remove", path, detail: `hooks (${removed})` }];
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const serverPath = this.getServerConfigPath(ctx);
    const hookPath = this.getHookConfigPath(ctx);
    const connectorId = ctx.connector.id;
    const homeBin = ctx.homeBinPath;
    const hookEvents = this.effectiveHookEvents(ctx);
    return [
      {
        name: `${this.name}: mcp.json present`,
        check: () =>
          existsSync(serverPath)
            ? { status: "OK", detail: serverPath }
            : { status: "FAIL", detail: `not found: ${serverPath}` },
      },
      {
        name: `${this.name}: mcpServers.${connectorId} registered`,
        check: () => {
          if (!ctx.connector.server) {
            return { status: "OK", detail: "no MCP server declared" };
          }
          const cfg = this.readJson<Record<string, Record<string, unknown>>>(serverPath);
          const bucket = cfg?.[MCP_ROOT_KEY];
          const present =
            typeof bucket === "object" && bucket !== null && connectorId in bucket;
          return present
            ? { status: "OK", detail: `mcpServers.${connectorId}` }
            : { status: "FAIL", detail: `mcpServers.${connectorId} not found in ${serverPath}` };
        },
      },
      {
        name: `${this.name}: hook command registered`,
        check: () => {
          if (hookEvents.length === 0) {
            return { status: "OK", detail: "no hooks declared" };
          }
          if (!existsSync(hookPath)) {
            return { status: "FAIL", detail: `not found: ${hookPath}` };
          }
          const cfg = this.readToml(hookPath);
          const registered = (cfg.hooks ?? []).some((h) =>
            isHomeBinHookCommand(h?.command, homeBin, connectorId),
          );
          return registered
            ? { status: "OK", detail: "hook command present" }
            : { status: "FAIL", detail: `no hook for ${connectorId} in ${hookPath}` };
        },
      },
    ];
  }

  // ── Runtime: parse Kimi stdin JSON → normalized event ────────────────────

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as KimiHookInput;
    const connectorId = typeof input.connector === "string" ? input.connector : "";
    const sessionId = input.session_id ?? `pid-${process.ppid}`;
    const projectDir = input.cwd ?? process.env.KIMI_PROJECT_DIR ?? process.cwd();

    const base = {
      hostPlatform: HOST,
      connectorId,
      sessionId,
      projectDir,
      raw,
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
          isError: input.is_error ?? false,
        };
        return ev;
      }
      case "SessionStart": {
        const ev: SessionStartEvent = {
          ...base,
          source: normalizeSessionSource(input.source),
        };
        return ev;
      }
      case "SessionEnd": {
        const ev: SessionEndEvent = {
          ...base,
          ...(typeof input.message === "string" ? { reason: input.message } : {}),
        };
        return ev;
      }
      case "UserPromptSubmit": {
        const ev: UserPromptSubmitEvent = {
          ...base,
          prompt: typeof input.prompt === "string" ? input.prompt : "",
        };
        return ev;
      }
      case "PreCompact": {
        const ev: PreCompactEvent = {
          ...base,
          ...(input.trigger === "auto" || input.trigger === "manual"
            ? { trigger: input.trigger }
            : {}),
        };
        return ev;
      }
      case "Stop": {
        const ev: StopEvent = {
          ...base,
          ...(typeof input.stop_hook_active === "boolean"
            ? { stopHookActive: input.stop_hook_active }
            : {}),
        };
        return ev;
      }
      case "Notification": {
        const ev: NotificationEvent = {
          ...base,
          message: typeof input.message === "string" ? input.message : "",
        };
        return ev;
      }
      case "PermissionRequest": {
        // No Kimi analog — never fired natively (install warn-skips it). Parsed
        // generically so a manual dispatch still normalizes instead of throwing.
        const ev: PermissionRequestEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
        };
        return ev;
      }
      case "PostToolUseFailure": {
        // Kimi documents tool_name/tool_input/error only (no tool_use_id /
        // is_interrupt / duration_ms) — the optionals stay unset.
        const ev: PostToolUseFailureEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          error: typeof input.error === "string" ? input.error : "",
        };
        return ev;
      }
      case "SubagentStart": {
        // Kimi sends agent_name (the matcher subject) — normalize it as
        // agentType; there is no agent_id. The start prompt rides in `raw`.
        const ev: SubagentStartEvent = {
          ...base,
          ...(typeof input.agent_name === "string"
            ? { agentType: input.agent_name }
            : {}),
        };
        return ev;
      }
      case "SubagentStop": {
        const ev: SubagentStopEvent = {
          ...base,
          ...(typeof input.agent_name === "string"
            ? { agentType: input.agent_name }
            : {}),
          ...(typeof input.response === "string"
            ? { lastAssistantMessage: input.response }
            : {}),
        };
        return ev;
      }
      default: {
        const _never: never = event;
        throw new Error(`unsupported kimi hook event: ${String(_never)}`);
      }
    }
  }

  // ── Runtime: normalized response → Kimi native hook reply ────────────────

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    const decision = response.decision ?? "allow";

    // deny → block the pending tool call. Kimi Code uses the Claude/Codex reply
    // shape: EXIT 0 + a `hookSpecificOutput` JSON object on stdout carrying
    // permissionDecision:"deny". Only PreToolUse deny is honored; every other
    // event (or decision) degrades to a silent allow.
    if (decision === "deny" && event === "PreToolUse") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: response.reason ?? "Blocked by hook",
          },
        }),
      };
    }

    // PostToolUseFailure (feedback beside the error) and SubagentStart (context
    // for the subagent) are observe/context-only: Kimi's documented protocol
    // adds non-empty stdout on exit 0 to context, so "context" emits the text
    // PLAIN (no JSON envelope) and a "deny" DEGRADES to the same shape carrying
    // the reason (the tool already failed / the spawn is not blockable).
    if (event === "PostToolUseFailure" || event === "SubagentStart") {
      const context =
        decision === "context"
          ? response.additionalContext
          : decision === "deny"
            ? response.reason ?? response.additionalContext
            : undefined;
      if (context) return { exitCode: 0, stdout: context };
      return { exitCode: 0 };
    }

    // SubagentStop = Stop semantics via Kimi's generic block protocol: EXIT 2
    // with the reason on stderr keeps the subagent going (stderr is fed back to
    // the model as correction). "context" rides the exit-0 stdout channel.
    if (event === "SubagentStop") {
      if (decision === "deny") {
        return { exitCode: 2, stderr: response.reason ?? "Blocked by hook" };
      }
      if (decision === "context" && response.additionalContext) {
        return { exitCode: 0, stdout: response.additionalContext };
      }
      return { exitCode: 0 };
    }

    // allow / modify / context / ask / unsupported-event → passthrough (exit 0,
    // empty stdout). Kimi cannot rewrite args/output or inject context, so those
    // are dropped.
    return { exitCode: 0 };
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  /** Which canonical hook events to register for Kimi, honoring overrides. */
  private effectiveHookEvents(ctx: InstallContext): KimiHookEventName[] {
    if (ctx.connector.platforms[HOST]?.hooks === false) return [];
    return KIMI_HOOK_EVENTS.filter((e) => ctx.connector.hookEvents.includes(e));
  }

  /** Declared events Kimi has no analog for — install reports a warn-skip. */
  private warnSkipHookEvents(ctx: InstallContext): HookEventName[] {
    if (ctx.connector.platforms[HOST]?.hooks === false) return [];
    return ctx.connector.hookEvents.filter((e) => WARN_SKIP_EVENTS.has(e));
  }

  /**
   * Render one `[[hooks]]` entry pointing at the stable home binary. Only the
   * PreToolUse deny gate carries the native tool matcher; the E1 events register
   * "" (match every tool failure / agent name) and the universal entrypoint
   * applies the connector's own matcher at runtime.
   */
  private renderHook(ctx: InstallContext, event: KimiHookEventName): KimiTomlHook {
    const command = buildHomeBinHookCommand(ctx.homeBinPath, HOST, event, ctx.connector.id);
    return {
      event,
      matcher: event === "PreToolUse" ? PRE_TOOL_USE_MATCHER : "",
      command,
    };
  }

  /**
   * Does this `[[hooks]]` entry belong to this connector? Anchored on the
   * home-bin + connector-id token (isHomeBinHookCommand) so uninstalling a
   * shared-prefix connector id never strips a sibling's hook.
   */
  private isOurHook(ctx: InstallContext, hook: KimiTomlHook | undefined): boolean {
    if (!hook || typeof hook !== "object") return false;
    return isHomeBinHookCommand(hook.command, ctx.homeBinPath, ctx.connector.id);
  }

  // ── TOML config IO (config.toml is TOML; MCP stays JSON via BaseAdapter) ──

  private readToml(path: string): KimiConfigToml {
    if (!existsSync(path)) return {};
    try {
      return TOML.parse(readFileSync(path, "utf8")) as unknown as KimiConfigToml;
    } catch {
      return {};
    }
  }

  private writeToml(path: string, data: KimiConfigToml, dryRun: boolean): void {
    if (dryRun) return;
    ensureDir(dirname(path));
    // NOTE: a @iarna/toml parse→stringify round-trip preserves config VALUES but
    // NOT user comments or the original key ordering/formatting in config.toml.
    // Values are safe; comments authored by the user are not preserved.
    writeFileSync(path, TOML.stringify(data as never), "utf8");
  }
}

/** Best-effort stringify of Kimi's tool_response into a normalized toolOutput. */
function toolResponseToString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function normalizeSessionSource(source: string | undefined): SessionStartEvent["source"] {
  switch (source) {
    case "compact":
      return "compact";
    case "resume":
      return "resume";
    case "clear":
      return "clear";
    default:
      return "startup";
  }
}

export const adapter = new KimiAdapter();
export default adapter;
