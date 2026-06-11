/**
 * adapters/hermes — Hermes Agent platform adapter for agent-connector.
 *
 * Hermes is a json-stdio host whose ENTIRE configuration — both the MCP servers
 * and the lifecycle hooks — lives in a single user-scope YAML file:
 *
 *     ~/.hermes/config.yaml
 *
 * Because the file is YAML, the BaseAdapter JSON helpers do not apply; this
 * adapter merges via core/yaml's readYaml/writeYaml, preserving any unrelated
 * config the user has authored.
 *
 *   - MCP servers: top-level snake_case root key `mcp_servers`. The stdio entry
 *     uses the portable field names { command, args, env } (unlike Goose's
 *     cmd/envs). Hermes has no native env interpolation, so `${env:VAR}` refs are
 *     resolved to literals at install time.
 *
 *   - Hooks: a top-level `hooks` map keyed by Hermes' NATIVE snake_case event
 *     names (pre_tool_call / post_tool_call / on_session_start / on_session_end /
 *     subagent_stop — NOT the canonical PascalCase names; see EVENT_TO_HERMES).
 *     Each value is a
 *     list of shell-hook entries { matcher, command:"<homeBin> hook …", timeout }.
 *     The command keeps the canonical event token so the runtime dispatcher
 *     (parseEvent/formatReply) stays consistent. Hermes shell hooks pipe the
 *     event JSON to the command on stdin and read the reply JSON from stdout —
 *     the same wire protocol as Claude Code, so the runtime parse/format mirror
 *     the Claude adapter (a Claude-like JSON shape; the exact Hermes field map is
 *     documented inline where it could vary).
 *
 * Since hooks are external shell commands (not an in-process plugin), Hermes
 * cannot let a hook rewrite tool arguments — canModifyArgs is false. Hermes has
 * no SSE transport, so only stdio + http are advertised.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
  PlatformCapabilities,
  PlatformId,
  PostToolUseEvent,
  PreCompactEvent,
  PreToolUseEvent,
  SessionEndEvent,
  SessionStartEvent,
  ServerDef,
  StopEvent,
  SubagentStopEvent,
  UserPromptSubmitEvent,
} from "../../core/types.js";
import { readYaml, writeYaml } from "../../core/yaml.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  buildHomeBinHookCommand,
  buildServeWrapperCommand,
  isHomeBinHookCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";

const HOST: PlatformId = "hermes";
/** Root key under which Hermes stores MCP servers in config.yaml (snake_case). */
const MCP_ROOT_KEY = "mcp_servers";
/** Top-level key under which Hermes stores shell hooks in config.yaml. */
const HOOKS_KEY = "hooks";
/** Default per-hook timeout (seconds) when the connector declares none. */
const DEFAULT_HOOK_TIMEOUT = 60;

/**
 * Canonical → Hermes native hook event name. Hermes keys its `hooks:` block by
 * its OWN snake_case lifecycle names (pre_tool_call / post_tool_call /
 * on_session_start / on_session_end — see docs/research/platform-research.json),
 * NOT the canonical PascalCase names. A connector event is only wired when it
 * appears here AND is declared by the connector; everything else is reported as
 * a warn/skip at install time.
 */
const EVENT_TO_HERMES: Partial<Record<HookEventName, string>> = {
  PreToolUse: "pre_tool_call",
  PostToolUse: "post_tool_call",
  SessionStart: "on_session_start",
  SessionEnd: "on_session_end",
  // Hermes is a STOP-ONLY subagent host: subagent_stop fires when a
  // delegate_task child exits (child_status ∈ completed/failed/interrupted/
  // error); there is NO subagent_start analog. PermissionRequest is also
  // deliberately ABSENT: Hermes' pre_approval_request/post_approval_response
  // hooks OBSERVE the approval prompt but carry no decision control, so a
  // PermissionRequest handler could never be honored — install skip-warns it.
  SubagentStop: "subagent_stop",
};

/** Hermes stdio MCP entry — portable field names (command/args/env). */
interface HermesStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** One Hermes shell-hook entry. */
interface HermesHookEntry {
  /** Tool-name matcher (empty = all). Tool events only; "" elsewhere. */
  matcher: string;
  /** The home-bin hook command Hermes invokes (event JSON on stdin). */
  command: string;
  /** Hook timeout in seconds. */
  timeout: number;
}

/** Raw Hermes hook stdin payload. Hermes uses snake_case pre_tool_call /
 *  post_tool_call event tokens; field names below cover both its tool-call and
 *  session payloads. Shape kept Claude-like where Hermes does not document it. */
interface HermesWireInput {
  session_id?: string;
  cwd?: string;
  event?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_output?: unknown;
  source?: string;
  reason?: string;
  prompt?: string;
  trigger?: string;
  stop_hook_active?: boolean;
  message?: string;
  is_error?: boolean;
  // subagent_stop — fires when a delegate_task child exits. agent_* are the
  // Claude-compatible names, child_* the Hermes-native ones (child_status ∈
  // completed/failed/interrupted/error stays accessible via `raw`).
  agent_id?: string;
  agent_type?: string;
  child_id?: string;
  child_status?: string;
  last_assistant_message?: string;
  /** Injected by the entrypoint so the runtime knows which connector to dispatch. */
  connector?: string;
}

export class HermesAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Hermes Agent";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    preCompact: false,
    // Hermes exposes on_session_start / on_session_end lifecycle hooks.
    sessionStart: true,
    sessionEnd: true,
    userPromptSubmit: false,
    stop: false,
    notification: false,
    // Newer events: Hermes ships subagent_stop (stop-only — no subagent_start
    // analog). permissionRequest stays unset because pre_approval_request is
    // observe-only (no decision control); postToolUseFailure stays unset (a
    // tool failure arrives merged into post_tool_call's result, not as a
    // dedicated event). Install reports the standard skip-warn for those.
    subagentStop: true,
    // Shell hooks cannot rewrite tool args/output in-process.
    canModifyArgs: false,
    canModifyOutput: false,
    canInjectSessionContext: true,
    // Hermes has no SSE transport.
    transports: ["stdio", "http"],
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(_projectDir: string): DetectedPlatform {
    const configPath = this.userConfigPath();
    const configDir = dirname(configPath);
    const installed = existsSync(configDir) || existsSync(configPath);
    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath,
      scope: "user",
      reason: installed
        ? `found Hermes config at ${configPath}`
        : `no Hermes config at ${configPath}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths (server + hooks share the SAME file) ─────────────────────

  override getConfigDir(_ctx: InstallContext): string {
    return dirname(this.userConfigPath());
  }

  override getServerConfigPath(_ctx: InstallContext): string {
    return this.userConfigPath();
  }

  /** Same file as the server config — Hermes hooks live in config.yaml. */
  override getHookConfigPath(_ctx: InstallContext): string {
    return this.userConfigPath();
  }

  private userConfigPath(): string {
    return join(homedir(), ".hermes", "config.yaml");
  }

  // ── MCP server install / uninstall (YAML mcp_servers) ─────────────────────

  override installServer(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    const path = this.getServerConfigPath(ctx);
    const server = this.effectiveServer(ctx);

    if (!server) {
      return [
        {
          platform: this.id,
          action: "skip",
          path,
          detail: connector.server
            ? "server registration disabled for hermes"
            : "connector declares no MCP server",
        },
      ];
    }
    if (server.transport !== "stdio" || !server.command) {
      return [
        {
          platform: this.id,
          action: "skip",
          path,
          detail: `transport "${server.transport}" not registrable in ${MCP_ROOT_KEY} (stdio only)`,
        },
      ];
    }

    const entry = this.renderServerEntry(ctx, server);

    const cfg = readYaml<Record<string, unknown>>(path) ?? {};
    const bucket = this.objectBucket(cfg, MCP_ROOT_KEY);
    const before = JSON.stringify(bucket[connector.id]);
    const after = JSON.stringify(entry);
    let action: ChangeRecord["action"];
    if (before === undefined) action = "create";
    else if (before === after) action = "skip";
    else action = "update";

    if (action !== "skip") {
      bucket[connector.id] = entry;
      writeYaml(path, cfg, dryRun);
    }
    return [{ platform: this.id, action, path, detail: `${MCP_ROOT_KEY}.${connector.id}` }];
  }

  override uninstallServer(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    const path = this.getServerConfigPath(ctx);
    const cfg = readYaml<Record<string, unknown>>(path);
    const bucketRaw = cfg?.[MCP_ROOT_KEY];
    if (
      !cfg ||
      !bucketRaw ||
      typeof bucketRaw !== "object" ||
      Array.isArray(bucketRaw) ||
      !(connector.id in (bucketRaw as Record<string, unknown>))
    ) {
      return [
        {
          platform: this.id,
          action: "skip",
          path,
          detail: `${MCP_ROOT_KEY}.${connector.id} absent`,
        },
      ];
    }
    delete (bucketRaw as Record<string, unknown>)[connector.id];
    writeYaml(path, cfg, dryRun);
    return [
      { platform: this.id, action: "remove", path, detail: `${MCP_ROOT_KEY}.${connector.id}` },
    ];
  }

  /**
   * Render the stdio MCP entry. Hermes has no native interpolation, so env-refs
   * resolve to literals here. Honors the telemetry serve-wrapper.
   */
  private renderServerEntry(ctx: InstallContext, server: ServerDef): HermesStdioServer {
    let command = server.command as string;
    let args = [...(server.args ?? [])];

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

    const entry: HermesStdioServer = { command };
    if (args.length > 0) entry.args = args;
    if (server.env && Object.keys(server.env).length > 0) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(resolveEnvRefsDeep(server.env))) {
        env[k] = String(v);
      }
      entry.env = env;
    }
    return entry;
  }

  // ── Hook install / uninstall (YAML hooks map in the SAME config.yaml) ─────

  override installHooks(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    const path = this.getHookConfigPath(ctx);

    if (connector.platforms[HOST]?.hooks === false) {
      return [{ platform: this.id, action: "skip", path, detail: "hooks disabled for hermes" }];
    }
    const events = connector.hookEvents;
    if (events.length === 0) {
      return [{ platform: this.id, action: "skip", path, detail: "connector declares no hooks" }];
    }

    const cfg = readYaml<Record<string, unknown>>(path) ?? {};
    const hooks = this.hooksBucket(cfg);
    const changes: ChangeRecord[] = [];
    let mutated = false;

    for (const event of events) {
      const hermesEvent = EVENT_TO_HERMES[event];
      if (!hermesEvent) {
        // No Hermes equivalent for this canonical event — report and skip.
        changes.push({
          platform: this.id,
          action: "warn",
          path,
          detail: `${event} has no Hermes hook equivalent — skipped`,
        });
        continue;
      }

      // The hook command keeps the CANONICAL event token so the runtime
      // dispatcher (parseEvent/formatReply) stays consistent; only the YAML KEY
      // the entry is filed under is the native Hermes name.
      const command = buildHomeBinHookCommand(ctx.homeBinPath, HOST, event, connector.id);
      const matcher = connector.hooks[event]?.matcher ?? "";
      const timeout = this.hookTimeout(connector.server);
      const desired: HermesHookEntry = { matcher, command, timeout };

      const bucket = Array.isArray(hooks[hermesEvent])
        ? (hooks[hermesEvent] as HermesHookEntry[])
        : (hooks[hermesEvent] = [] as HermesHookEntry[]);
      const idx = bucket.findIndex((e) => this.isOurCommand(e?.command, ctx));

      if (idx >= 0) {
        if (JSON.stringify(bucket[idx]) === JSON.stringify(desired)) {
          changes.push({ platform: this.id, action: "skip", path, detail: `${HOOKS_KEY}.${hermesEvent}` });
          continue;
        }
        bucket[idx] = desired;
        changes.push({ platform: this.id, action: "update", path, detail: `${HOOKS_KEY}.${hermesEvent}` });
      } else {
        bucket.push(desired);
        changes.push({ platform: this.id, action: "create", path, detail: `${HOOKS_KEY}.${hermesEvent}` });
      }
      mutated = true;
    }

    if (mutated) writeYaml(path, cfg, dryRun);
    return changes;
  }

  override uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const path = this.getHookConfigPath(ctx);
    const cfg = readYaml<Record<string, unknown>>(path);
    const hooksRaw = cfg?.[HOOKS_KEY];
    if (
      !cfg ||
      !hooksRaw ||
      typeof hooksRaw !== "object" ||
      Array.isArray(hooksRaw)
    ) {
      return [{ platform: this.id, action: "skip", path, detail: "no hooks section present" }];
    }
    const hooks = hooksRaw as Record<string, unknown>;

    const changes: ChangeRecord[] = [];
    let mutated = false;
    for (const event of Object.keys(hooks)) {
      const bucket = hooks[event];
      if (!Array.isArray(bucket)) continue;
      const kept = (bucket as HermesHookEntry[]).filter(
        (e) => !this.isOurCommand(e?.command, ctx),
      );
      if (kept.length === bucket.length) continue;
      mutated = true;
      if (kept.length > 0) hooks[event] = kept;
      else delete hooks[event];
      changes.push({
        platform: this.id,
        action: "remove",
        path,
        detail: `${HOOKS_KEY}.${event} (${bucket.length - kept.length})`,
      });
    }

    if (mutated) writeYaml(path, cfg, ctx.dryRun);
    if (changes.length === 0) {
      return [{ platform: this.id, action: "skip", path, detail: "no matching hook entries" }];
    }
    return changes;
  }

  /** True when a hook command is ours (anchored home-bin + connector id). */
  private isOurCommand(command: string | undefined, ctx: InstallContext): boolean {
    return isHomeBinHookCommand(command, ctx.homeBinPath, ctx.connector.id);
  }

  private hookTimeout(server: ServerDef | undefined): number {
    const ms = server?.timeoutMs;
    if (typeof ms === "number" && ms > 0) return Math.round(ms / 1000);
    return DEFAULT_HOOK_TIMEOUT;
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const path = this.getServerConfigPath(ctx);
    const id = ctx.connector.id;
    const homeBin = ctx.homeBinPath;
    const hookEvents = ctx.connector.hookEvents;
    return [
      {
        name: `${this.name}: config.yaml present`,
        check: () =>
          existsSync(path)
            ? { status: "OK", detail: path }
            : { status: "FAIL", detail: `not found: ${path}` },
      },
      {
        name: `${this.name}: ${MCP_ROOT_KEY}.${id} registered`,
        check: () => {
          // Only assert what the connector declares: a server-less connector
          // never writes an mcp entry, so its absence is healthy.
          if (!ctx.connector.server) return { status: "OK", detail: "no MCP server declared" };
          const cfg = readYaml<Record<string, unknown>>(path);
          const bucket = cfg?.[MCP_ROOT_KEY];
          const present =
            typeof bucket === "object" &&
            bucket !== null &&
            !Array.isArray(bucket) &&
            id in (bucket as Record<string, unknown>);
          return present
            ? { status: "OK", detail: `${MCP_ROOT_KEY}.${id}` }
            : { status: "FAIL", detail: `${MCP_ROOT_KEY}.${id} not found in ${path}` };
        },
      },
      {
        name: `${this.name}: hook command registered`,
        check: () => {
          if (hookEvents.length === 0) return { status: "OK", detail: "no hooks declared" };
          const cfg = readYaml<Record<string, unknown>>(path);
          const hooks = cfg?.[HOOKS_KEY];
          if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
            return { status: "FAIL", detail: `no ${HOOKS_KEY} section in ${path}` };
          }
          const registered = Object.values(hooks as Record<string, unknown>).some(
            (bucket) =>
              Array.isArray(bucket) &&
              (bucket as HermesHookEntry[]).some((e) =>
                isHomeBinHookCommand(e?.command, homeBin, id),
              ),
          );
          return registered
            ? { status: "OK", detail: "hook command present" }
            : { status: "FAIL", detail: `no hook for ${id} in ${path}` };
        },
      },
    ];
  }

  // ── Runtime: parse Hermes stdin JSON → normalized event ──────────────────

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as HermesWireInput;
    const base = {
      hostPlatform: HOST,
      connectorId: typeof input.connector === "string" ? input.connector : "",
      sessionId: typeof input.session_id === "string" ? input.session_id : "",
      ...(typeof input.cwd === "string" ? { projectDir: input.cwd } : {}),
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
        // Hermes may carry the result under tool_output or tool_response.
        const out = toStringOrUndefined(input.tool_output ?? input.tool_response);
        const ev: PostToolUseEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          ...(out !== undefined ? { toolOutput: out } : {}),
          ...(typeof input.is_error === "boolean" ? { isError: input.is_error } : {}),
        };
        return ev;
      }
      case "SessionStart": {
        const ev: SessionStartEvent = { ...base, source: normalizeSource(input.source) };
        return ev;
      }
      case "SessionEnd": {
        const ev: SessionEndEvent = {
          ...base,
          ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
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
      case "SubagentStop": {
        // agent_id/agent_type stay optional (some hosts never populate them);
        // Hermes' native child_id is accepted as the id fallback. child_status
        // is host-specific and stays accessible via `raw`.
        const agentId = input.agent_id ?? input.child_id;
        const ev: SubagentStopEvent = {
          ...base,
          ...(typeof agentId === "string" ? { agentId } : {}),
          ...(typeof input.agent_type === "string"
            ? { agentType: input.agent_type }
            : {}),
          ...(typeof input.last_assistant_message === "string"
            ? { lastAssistantMessage: input.last_assistant_message }
            : {}),
          ...(typeof input.stop_hook_active === "boolean"
            ? { stopHookActive: input.stop_hook_active }
            : {}),
        };
        return ev;
      }
      case "PermissionRequest":
      case "PostToolUseFailure":
      case "SubagentStart": {
        // No Hermes analog: pre_approval_request is observe-only (no decision
        // control), tool failures arrive merged into post_tool_call, and there
        // is no subagent_start. Install already skip-warns these; a runtime
        // dispatch is a mis-route — fail loudly.
        throw new Error(`unsupported hermes hook event: ${String(event)}`);
      }
      default: {
        const _never: never = event;
        throw new Error(`unsupported hermes hook event: ${String(_never)}`);
      }
    }
  }

  // ── Runtime: normalized response → Hermes native hook reply ──────────────
  // Hermes shell hooks read a JSON reply from stdout (exit 0 = allow). We emit a
  // Claude-like `hookSpecificOutput` wrapper; if Hermes' exact reply schema
  // differs, this is the single place to adjust the mapping.

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    const decision = response.decision ?? "allow";

    if (decision === "deny") {
      // SubagentStop deny carries Stop semantics — it keeps the subagent
      // running with `reason` as its next instruction — and (like Claude's
      // Stop class) is honored only as the TOP-LEVEL {"decision":"block",
      // "reason"}, not as a permissionDecision envelope.
      if (event === "SubagentStop") {
        return this.stdout({
          decision: "block",
          reason: response.reason ?? "Blocked by hook",
        });
      }
      return this.stdout({
        hookSpecificOutput: {
          hookEventName: event,
          permissionDecision: "deny",
          permissionDecisionReason: response.reason ?? "Blocked by hook",
        },
      });
    }

    if (decision === "ask") {
      return this.stdout({
        hookSpecificOutput: {
          hookEventName: event,
          permissionDecision: "ask",
          permissionDecisionReason: response.reason ?? "Confirmation required by hook",
        },
      });
    }

    if (decision === "context" && response.additionalContext) {
      return this.stdout({
        hookSpecificOutput: { hookEventName: event, additionalContext: response.additionalContext },
      });
    }

    // allow / modify (unsupported — shell hooks can't rewrite args) / void.
    return { exitCode: 0 };
  }

  private stdout(payload: unknown): HookReply {
    return { exitCode: 0, stdout: JSON.stringify(payload) };
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /** Resolve the per-platform server override into an effective ServerDef. */
  private effectiveServer(ctx: InstallContext): ServerDef | undefined {
    const override = ctx.connector.platforms[this.id]?.server;
    if (override === false) return undefined;
    const base = ctx.connector.server;
    if (!base) return undefined;
    return override && typeof override === "object" ? { ...base, ...override } : base;
  }

  /** Get-or-create an object bucket (map) at `cfg[key]`. */
  private objectBucket(cfg: Record<string, unknown>, key: string): Record<string, unknown> {
    const existing = cfg[key];
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      return existing as Record<string, unknown>;
    }
    const fresh: Record<string, unknown> = {};
    cfg[key] = fresh;
    return fresh;
  }

  /** Get-or-create the hooks map at `cfg.hooks`. */
  private hooksBucket(cfg: Record<string, unknown>): Record<string, unknown> {
    return this.objectBucket(cfg, HOOKS_KEY);
  }
}

/** Coerce an unknown value into a string for the normalized event. */
function toStringOrUndefined(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeSource(raw: string | undefined): SessionStartEvent["source"] {
  switch (raw) {
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

export const adapter = new HermesAdapter();
export default adapter;
