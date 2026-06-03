/**
 * adapters/qwen-code — Qwen Code (Qwen CLI) platform adapter for agent-connector.
 *
 * Qwen Code is a Gemini-CLI-derived host, but — unlike Gemini CLI — its hook
 * WIRE PROTOCOL is Claude-compatible (verified against context-mode's proven
 * qwen-code adapter, which extends the shared ClaudeCodeBaseAdapter):
 *
 *   - Hook event names are PascalCase, identical to Claude Code:
 *       PreToolUse, PostToolUse, PreCompact, SessionStart, SessionEnd,
 *       UserPromptSubmit, Stop, Notification.
 *     (NOT Gemini's BeforeTool/AfterTool/PreCompress vocabulary.)
 *   - Hook stdin JSON carries snake_case fields: session_id, transcript_path,
 *     cwd, tool_name, tool_input, tool_response, source, reason, prompt,
 *     trigger, stop_hook_active, message.
 *   - Reply is exit-code 0 + a `hookSpecificOutput` JSON object on stdout
 *     (permissionDecision allow|deny|ask, updatedInput, additionalContext) —
 *     the Claude reply shape. Qwen additionally honors `updatedMCPToolOutput`
 *     on PostToolUse, so this host CAN rewrite already-emitted tool output
 *     (capabilities.canModifyOutput = true; Claude Code cannot).
 *   - Native tool names are Qwen/Gemini-flavored (run_shell_command, read_file,
 *     write_file, grep_search, …) — used only inside matcher strings; the wire
 *     field names are unchanged from Claude.
 *
 * Native config (JSONC — Qwen shares Gemini's tolerant settings loader; we write
 * strict JSON and MERGE into any existing settings so user keys survive):
 *   - MCP servers: user → ~/.qwen/settings.json; project → <projectDir>/.qwen/
 *     settings.json. Root key "mcpServers". Transport selected by the `type`
 *     field (stdio {command,args,env}; http {url}) — Claude-style, NOT Gemini's
 *     key-selected transport.
 *   - Hooks: the SAME settings.json, top-level sibling "hooks" key, keyed by the
 *     PascalCase event name, each value an array of
 *     `{ matcher, hooks:[{ type:"command", command }] }`.
 *
 * Env handling: Qwen's settings loader has no `${env:VAR}` interpolation of our
 * framework's dialect, so env / header / url refs resolve to literals at install
 * time via resolveEnvRefsDeep — the safe default shared with the Gemini / Codex
 * adapters.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  ServerDef,
  SessionEndEvent,
  SessionStartEvent,
  StopEvent,
  Transport,
  UserPromptSubmitEvent,
} from "../../core/types.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  buildHomeBinHookCommand,
  buildServeWrapperCommand,
  isHomeBinHookCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";

const HOST: PlatformId = "qwen-code";
const MCP_ROOT_KEY = "mcpServers";

/** A single hook registration entry as Qwen stores it (Claude-shaped, nested). */
interface QwenHookEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string }>;
}

/** Shape of Qwen's settings.json (only the parts we touch). */
interface QwenSettingsFile {
  mcpServers?: Record<string, unknown>;
  hooks?: Record<string, QwenHookEntry[]>;
  [key: string]: unknown;
}

/**
 * Native MCP server entry shapes Qwen accepts under `mcpServers`. Qwen carries
 * Claude-style `type`-tagged entries (it is a Gemini fork but its settings
 * schema accepts the `type` discriminator), so we render stdio with
 * type:"stdio" and remote transports with type:"http".
 */
interface QwenStdioServer {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}
interface QwenHttpServer {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

/** Raw Qwen hook stdin payload (Claude-compatible snake_case wire fields). */
interface QwenWireInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;

  // tool events
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** PostToolUse result payload (string or structured). */
  tool_response?: unknown;

  // SessionStart
  source?: string;
  // SessionEnd
  reason?: string;
  // UserPromptSubmit
  prompt?: string;
  // PreCompact
  trigger?: string;
  // Stop
  stop_hook_active?: boolean;
  // Notification
  message?: string;

  /** Injected by the entrypoint so the runtime knows which connector to dispatch. */
  connector?: unknown;
}

export class QwenCodeAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Qwen CLI";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    preCompact: true,
    sessionStart: true,
    sessionEnd: true,
    userPromptSubmit: true,
    stop: true,
    notification: true,
    // Qwen's PreToolUse can rewrite input (updatedInput) AND — unlike the
    // Claude-family hosts — its PostToolUse can rewrite already-emitted tool
    // output via `updatedMCPToolOutput` (confirmed by context-mode's qwen-code
    // adapter formatPostToolUseResponse).
    canModifyArgs: true,
    canModifyOutput: true,
    canInjectSessionContext: true,
    transports: ["stdio", "sse", "http"],
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".qwen");
    const userSettings = join(userDir, "settings.json");
    const projectDirQwen = join(projectDir, ".qwen");
    const projectSettings = join(projectDirQwen, "settings.json");
    const userInstalled = existsSync(userDir) || existsSync(userSettings);
    const projInstalled = existsSync(projectDirQwen) || existsSync(projectSettings);
    const installed = userInstalled || projInstalled;
    // Report the scope/path that actually matched, so a project-only install
    // isn't misreported as a (non-existent) user install.
    const scope = projInstalled && !userInstalled ? "project" : "user";
    const configPath = scope === "project" ? projectSettings : userSettings;
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
          ? `found project Qwen CLI config at ${projectSettings}`
          : `found Qwen CLI config under ${userDir}`
        : `no Qwen CLI config at ${userDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".qwen")
      : join(homedir(), ".qwen");
  }

  /** MCP servers live in settings.json under `mcpServers`. */
  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "settings.json");
  }

  /** Hooks live in the SAME settings.json under the sibling `hooks` key. */
  getHookConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "settings.json");
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
            ? "server registration disabled for qwen-code"
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

  /** Render a normalized ServerDef into Qwen's native mcpServers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): QwenStdioServer | QwenHttpServer {
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

      const entry: QwenStdioServer = {
        type: "stdio",
        command: resolveEnvRefsDeep(command),
        args: args.map((a) => resolveEnvRefsDeep(a)),
      };
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      if (server.cwd) entry.cwd = resolveEnvRefsDeep(server.cwd);
      return entry;
    }

    // http / sse (and any other remote transport) — Qwen registers a URL entry.
    const entry: QwenHttpServer = {
      type: "http",
      url: resolveEnvRefsDeep(server.url ?? ""),
    };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Qwen's settings loader does not interpret our
   * `${env:VAR}` dialect, so refs resolve to literals at install time — the safe
   * default shared with the Gemini / Codex adapters.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Hook install / uninstall ─────────────────────────────────────────────

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.hooks === false) {
      return [{ platform: this.id, action: "skip", detail: "hooks disabled for qwen-code" }];
    }
    if (connector.hookEvents.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no hooks" }];
    }

    const settingsPath = this.getHookConfigPath(ctx);
    // MERGE into any existing settings (JSONC written as strict JSON) so the
    // user's own mcpServers / theme / other keys are preserved.
    const settings = this.readJson<QwenSettingsFile>(settingsPath) ?? {};
    const hooks = (settings.hooks ??= {});

    const changes: ChangeRecord[] = [];
    let mutated = false;

    for (const event of connector.hookEvents) {
      // Qwen's hook event names are Claude-identical (PascalCase) — register the
      // canonical event name directly.
      const command = buildHomeBinHookCommand(ctx.homeBinPath, HOST, event, connector.id);
      const matcher = connector.hooks[event]?.matcher ?? "";
      const entry: QwenHookEntry = {
        matcher,
        hooks: [{ type: "command", command }],
      };

      const bucket = (hooks[event] ??= []);
      const existingIdx = bucket.findIndex((e) => this.entryHasOurCommand(e, ctx));

      if (existingIdx >= 0) {
        if (JSON.stringify(bucket[existingIdx]) === JSON.stringify(entry)) {
          changes.push({
            platform: this.id,
            action: "skip",
            path: settingsPath,
            detail: `hooks.${event} already registered`,
          });
          continue;
        }
        bucket[existingIdx] = entry;
        changes.push({
          platform: this.id,
          action: "update",
          path: settingsPath,
          detail: `hooks.${event}`,
        });
      } else {
        bucket.push(entry);
        changes.push({
          platform: this.id,
          action: "create",
          path: settingsPath,
          detail: `hooks.${event}`,
        });
      }
      mutated = true;
    }

    if (mutated) this.writeJson(settingsPath, settings, ctx.dryRun);
    return changes;
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const settingsPath = this.getHookConfigPath(ctx);
    const settings = this.readJson<QwenSettingsFile>(settingsPath);
    const hooks = settings?.hooks;
    if (!settings || !hooks) {
      return [
        {
          platform: this.id,
          action: "skip",
          path: settingsPath,
          detail: "no hooks section present",
        },
      ];
    }

    const changes: ChangeRecord[] = [];
    let mutated = false;

    for (const event of Object.keys(hooks)) {
      const bucket = hooks[event];
      if (!Array.isArray(bucket)) continue;

      // Strip our hook command from each entry; drop entries left empty so we
      // never remove another connector's (or the user's own) hook commands. The
      // id token is anchored (isHomeBinHookCommand) so a shared-prefix connector
      // id is never affected.
      const next: QwenHookEntry[] = [];
      let removed = 0;
      for (const e of bucket) {
        const innerBefore = e.hooks?.length ?? 0;
        const inner = (e.hooks ?? []).filter((h) => !this.isOurCommand(h.command, ctx));
        removed += innerBefore - inner.length;
        if (inner.length > 0) next.push({ matcher: e.matcher ?? "", hooks: inner });
      }

      if (removed > 0) {
        if (next.length > 0) hooks[event] = next;
        else delete hooks[event];
        changes.push({
          platform: this.id,
          action: "remove",
          path: settingsPath,
          detail: `hooks.${event} (${removed})`,
        });
        mutated = true;
      }
    }

    if (mutated) this.writeJson(settingsPath, settings, ctx.dryRun);
    if (changes.length === 0) {
      changes.push({
        platform: this.id,
        action: "skip",
        path: settingsPath,
        detail: "no matching hook entries",
      });
    }
    return changes;
  }

  private entryHasOurCommand(entry: QwenHookEntry, ctx: InstallContext): boolean {
    return (entry.hooks ?? []).some((h) => this.isOurCommand(h.command, ctx));
  }

  /** True when a hook command references our home binary AND this connector id
   *  (anchored so a shared-prefix id can't collide — see isHomeBinHookCommand). */
  private isOurCommand(command: string | undefined, ctx: InstallContext): boolean {
    return isHomeBinHookCommand(command, ctx.homeBinPath, ctx.connector.id);
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const settingsPath = this.getHookConfigPath(ctx);
    const connectorId = ctx.connector.id;
    const homeBin = ctx.homeBinPath;
    const hookEvents = ctx.connector.hookEvents;
    return [
      {
        name: `${this.name}: settings.json present`,
        check: () =>
          existsSync(settingsPath)
            ? { status: "OK", detail: settingsPath }
            : { status: "FAIL", detail: `not found: ${settingsPath}` },
      },
      {
        name: `${this.name}: hook command registered`,
        check: () => {
          if (hookEvents.length === 0) {
            return { status: "OK", detail: "no hooks declared" };
          }
          const settings = this.readJson<QwenSettingsFile>(settingsPath);
          if (!settings) return { status: "FAIL", detail: `cannot read ${settingsPath}` };
          const hooks = settings.hooks ?? {};
          const registered = Object.values(hooks).some((entries) =>
            (entries ?? []).some((e) =>
              (e.hooks ?? []).some((h) =>
                isHomeBinHookCommand(h.command, homeBin, connectorId),
              ),
            ),
          );
          return registered
            ? { status: "OK", detail: "hook command present" }
            : { status: "FAIL", detail: `no hook for ${connectorId} in ${settingsPath}` };
        },
      },
    ];
  }

  // ── Runtime: parse Qwen stdin JSON → normalized event ────────────────────

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as QwenWireInput;
    const connectorId = typeof input.connector === "string" ? input.connector : "";
    const sessionId = extractSessionId(input);
    const projectDir = typeof input.cwd === "string" ? input.cwd : undefined;

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
      default: {
        // Exhaustive guard — every HookEventName is handled above.
        const _never: never = event;
        throw new Error(`unsupported qwen-code hook event: ${String(_never)}`);
      }
    }
  }

  // ── Runtime: normalized response → Qwen native hook reply ────────────────

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    const hookEventName = event;
    const decision = response.decision ?? "allow";

    // deny → block the action with a reason (exit 0; JSON carries the decision).
    if (decision === "deny") {
      return this.stdout({
        hookSpecificOutput: {
          hookEventName,
          permissionDecision: "deny",
          permissionDecisionReason: response.reason ?? "Blocked by hook",
        },
      });
    }

    // ask → prompt the user to confirm.
    if (decision === "ask") {
      return this.stdout({
        hookSpecificOutput: {
          hookEventName,
          permissionDecision: "ask",
          permissionDecisionReason: response.reason ?? "Confirmation required by hook",
        },
      });
    }

    // modify → rewrite PreToolUse input, or (Qwen-only) PostToolUse output.
    if (decision === "modify") {
      if (event === "PreToolUse" && response.updatedInput) {
        return this.stdout({
          hookSpecificOutput: { hookEventName, updatedInput: response.updatedInput },
        });
      }
      if (event === "PostToolUse" && response.updatedOutput !== undefined) {
        // Qwen honors `updatedMCPToolOutput` to replace already-emitted output.
        return this.stdout({
          hookSpecificOutput: {
            hookEventName,
            updatedMCPToolOutput: response.updatedOutput,
          },
        });
      }
      // Nothing applicable on this event; fall through to allow.
    }

    // context → inject soft guidance (also the SessionStart context path).
    if (decision === "context" && response.additionalContext) {
      return this.stdout({
        hookSpecificOutput: { hookEventName, additionalContext: response.additionalContext },
      });
    }

    // allow / void / unsupported-degradation → pass through with exit 0.
    return { exitCode: 0 };
  }

  private stdout(payload: unknown): HookReply {
    return { exitCode: 0, stdout: JSON.stringify(payload) };
  }
}

/**
 * Extract a stable session id from a Qwen wire payload. Unlike Claude (which
 * prefers the transcript UUID), Qwen Code surfaces `session_id` directly and
 * prioritizes it — matching context-mode's QwenCodeAdapter.extractSessionId.
 * Falls back to the transcript UUID, then "" (no ppid fabrication — the
 * normalized event uses "" when the host provides no id).
 */
function extractSessionId(input: QwenWireInput): string {
  if (typeof input.session_id === "string" && input.session_id !== "") {
    return input.session_id;
  }
  if (typeof input.transcript_path === "string") {
    const m = input.transcript_path.match(/([a-f0-9-]{36})\.jsonl$/);
    if (m && m[1]) return m[1];
  }
  return "";
}

/** Coerce a Qwen PostToolUse `tool_response` into a string for the normalized event. */
function toolResponseToString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
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

export const adapter = new QwenCodeAdapter();
export default adapter;
