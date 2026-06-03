/**
 * adapters/cursor — Cursor platform adapter for agent-connector.
 *
 * Generalized from context-mode's proven Cursor adapter: the served identity is
 * now `ctx.connector` (not a hardcoded "context-mode"), and every hook command
 * points at the single stable home binary (`buildHomeBinHookCommand`) so one
 * framework update propagates everywhere.
 *
 * Cursor is a json-stdio host:
 *   - MCP servers: user scope → ~/.cursor/mcp.json ("mcpServers"); project scope
 *     → <projectDir>/.cursor/mcp.json ("mcpServers").
 *   - Hooks: <configDir>/hooks.json with shape `{ version, hooks: { <cursorEvent>:
 *     [ { command, matcher? } ] } }`. Unlike Claude, each entry is a FLAT command
 *     object (no `{ matcher, hooks:[...] }` wrapper).
 *   - Reply: a JSON object on stdout (exit 0). deny/ask carry `permission` +
 *     `user_message`; modify carries `updated_input`; context injects via
 *     `agent_message` (PreToolUse) or `additional_context` (Post/SessionStart).
 *
 * Cursor supports its own `${env:VAR}` native interpolation, so env/header/url
 * values are rewritten to that native token rather than baked into the file.
 */

import { existsSync, readFileSync } from "node:fs";
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
  PlatformCapabilities,
  PlatformId,
  PostToolUseEvent,
  PreToolUseEvent,
  ServerDef,
  SessionStartEvent,
  StopEvent,
  Transport,
} from "../../core/types.js";
import { rewriteEnvRefs } from "../../core/interpolate.js";
import {
  buildHomeBinHookCommand,
  buildServeWrapperCommand,
  isHomeBinHookCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";

const HOST: PlatformId = "cursor";
const MCP_ROOT_KEY = "mcpServers";

/** Native hooks.json version Cursor expects. */
const CURSOR_HOOKS_VERSION = 1;

/**
 * Cursor-native hook event names, in the lower-camel form Cursor reads from
 * hooks.json. These are the events the proven context-mode adapter registers.
 */
const CURSOR_EVENT = {
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  SessionStart: "sessionStart",
  Stop: "stop",
} as const;

/**
 * Map our normalized event names to Cursor's native hook event names. Only the
 * events Cursor actually supports are present; everything else has no Cursor
 * equivalent and is reported as a skip/warn at install time.
 */
const EVENT_MAP: Partial<Record<HookEventName, string>> = {
  PreToolUse: CURSOR_EVENT.PreToolUse,
  PostToolUse: CURSOR_EVENT.PostToolUse,
  SessionStart: CURSOR_EVENT.SessionStart,
  Stop: CURSOR_EVENT.Stop,
};

/** A single Cursor native hook entry — a flat command object. */
interface CursorHookEntry {
  command: string;
  matcher?: string;
}

/** The shape of Cursor's hooks.json. */
interface CursorHooksFile {
  version?: number;
  hooks?: Record<string, CursorHookEntry[]>;
}

/** Native MCP server entry shapes Cursor accepts under `mcpServers`. */
interface CursorStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}
interface CursorHttpServer {
  url: string;
  headers?: Record<string, string>;
}

/** Raw Cursor hook stdin payload (snake_case wire fields). */
interface CursorWireInput {
  connector?: unknown;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  error_message?: string;
  cwd?: string;
  workspace_roots?: string[];
  conversation_id?: string;
  session_id?: string;
  generation_id?: string;
  source?: string;
  trigger?: string;
  status?: string;
  loop_count?: number;
  stop_hook_active?: boolean;
}

export class CursorAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Cursor";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    // Cursor natively supports pre/post tool-use, session start, and stop.
    preToolUse: true,
    postToolUse: true,
    preCompact: false,
    sessionStart: true,
    sessionEnd: false,
    userPromptSubmit: false,
    stop: true,
    notification: false,
    // Cursor's preToolUse can rewrite tool input (updated_input) but cannot
    // rewrite already-emitted tool output.
    canModifyArgs: true,
    canModifyOutput: false,
    canInjectSessionContext: true,
    transports: ["stdio", "http"],
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".cursor");
    const userMcp = join(userDir, "mcp.json");
    const userHooks = join(userDir, "hooks.json");
    const projectDirCursor = join(projectDir, ".cursor");
    const installed =
      existsSync(userDir) ||
      existsSync(userMcp) ||
      existsSync(userHooks) ||
      existsSync(projectDirCursor);
    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath: userMcp,
      scope: "user",
      reason: installed
        ? `found Cursor config under ${userDir}`
        : `no Cursor config at ${userDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".cursor")
      : join(homedir(), ".cursor");
  }

  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "mcp.json");
  }

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
            ? "server registration disabled for cursor"
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

  /** Render a normalized ServerDef into Cursor's native mcpServers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): CursorStdioServer | CursorHttpServer {
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

      const entry: CursorStdioServer = { command: this.rewrite(command) };
      if (args.length > 0) entry.args = args.map((a) => this.rewrite(a));
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      if (server.cwd) entry.cwd = this.rewrite(server.cwd);
      return entry;
    }

    // http (and any other remote transport we surface) — Cursor registers a URL.
    const entry: CursorHttpServer = { url: this.rewrite(server.url ?? "") };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Cursor supports its own `${env:VAR}` native
   * interpolation, so translate `${env:VAR}` refs to that native token rather
   * than baking secrets into the file. Literals pass through unchanged.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) out[k] = this.rewrite(v);
    return out;
  }

  /** Translate `${env:VAR(:-default)}` to Cursor's native `${env:VAR}` token. */
  private rewrite(value: string): string {
    return rewriteEnvRefs(value, cursorEnvToken);
  }

  // ── Hook install / uninstall ─────────────────────────────────────────────

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.hooks === false) {
      return [{ platform: this.id, action: "skip", detail: "hooks disabled for cursor" }];
    }
    if (connector.hookEvents.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no hooks" }];
    }

    const hooksPath = this.getHookConfigPath(ctx);
    const file = this.readJson<CursorHooksFile>(hooksPath) ?? {};
    const hooks = (file.hooks ??= {});

    const changes: ChangeRecord[] = [];
    let mutated = false;

    for (const event of connector.hookEvents) {
      const cursorEvent = EVENT_MAP[event];
      if (!cursorEvent) {
        // No Cursor equivalent for this normalized event — report and skip.
        changes.push({
          platform: this.id,
          action: "warn",
          path: hooksPath,
          detail: `${event} has no Cursor hook equivalent — skipped`,
        });
        continue;
      }

      const command = buildHomeBinHookCommand(ctx.homeBinPath, HOST, event, connector.id);
      const matcher = connector.hooks[event]?.matcher;
      const entry: CursorHookEntry = matcher ? { command, matcher } : { command };

      const bucket = (hooks[cursorEvent] ??= []);
      const existingIdx = bucket.findIndex((e) => this.isOurCommand(e.command, ctx));

      if (existingIdx >= 0) {
        if (JSON.stringify(bucket[existingIdx]) === JSON.stringify(entry)) {
          changes.push({
            platform: this.id,
            action: "skip",
            path: hooksPath,
            detail: `hooks.${cursorEvent} already registered`,
          });
          continue;
        }
        bucket[existingIdx] = entry;
        changes.push({
          platform: this.id,
          action: "update",
          path: hooksPath,
          detail: `hooks.${cursorEvent}`,
        });
      } else {
        bucket.push(entry);
        changes.push({
          platform: this.id,
          action: "create",
          path: hooksPath,
          detail: `hooks.${cursorEvent}`,
        });
      }
      mutated = true;
    }

    if (mutated) {
      file.version = CURSOR_HOOKS_VERSION;
      this.writeJson(hooksPath, file, ctx.dryRun);
    }
    return changes;
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const hooksPath = this.getHookConfigPath(ctx);
    const file = this.readJson<CursorHooksFile>(hooksPath);
    const hooks = file?.hooks;
    if (!file || !hooks) {
      return [
        {
          platform: this.id,
          action: "skip",
          path: hooksPath,
          detail: "no hooks section present",
        },
      ];
    }

    const changes: ChangeRecord[] = [];
    let mutated = false;

    for (const cursorEvent of Object.keys(hooks)) {
      const bucket = hooks[cursorEvent];
      if (!Array.isArray(bucket)) continue;

      const before = bucket.length;
      const next = bucket.filter((e) => !this.isOurCommand(e.command, ctx));
      const removed = before - next.length;
      if (removed > 0) {
        if (next.length > 0) hooks[cursorEvent] = next;
        else delete hooks[cursorEvent];
        changes.push({
          platform: this.id,
          action: "remove",
          path: hooksPath,
          detail: `hooks.${cursorEvent} (${removed})`,
        });
        mutated = true;
      }
    }

    if (mutated) this.writeJson(hooksPath, file, ctx.dryRun);
    if (changes.length === 0) {
      changes.push({
        platform: this.id,
        action: "skip",
        path: hooksPath,
        detail: "no matching hook entries",
      });
    }
    return changes;
  }

  /** True when a hook command references our home binary AND this connector id
   *  (anchored so a shared-prefix id can't collide — see isHomeBinHookCommand). */
  private isOurCommand(command: string | undefined, ctx: InstallContext): boolean {
    return isHomeBinHookCommand(command, ctx.homeBinPath, ctx.connector.id);
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const mcpPath = this.getServerConfigPath(ctx);
    const hooksPath = this.getHookConfigPath(ctx);
    return [
      {
        name: `${this.name}: mcp.json present`,
        check: () =>
          existsSync(mcpPath)
            ? { status: "OK", detail: mcpPath }
            : { status: "FAIL", detail: `not found: ${mcpPath}` },
      },
      {
        name: `${this.name}: hooks.json present`,
        check: () =>
          existsSync(hooksPath)
            ? { status: "OK", detail: hooksPath }
            : { status: "FAIL", detail: `not found: ${hooksPath}` },
      },
    ];
  }

  // ── Runtime: parse Cursor stdin JSON → normalized event ──────────────────

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as CursorWireInput;
    const connectorId = typeof input.connector === "string" ? input.connector : "";
    const sessionId = extractSessionId(input);
    const projectDir = this.getProjectDir(input);

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
        const toolOutput = input.tool_output ?? input.error_message;
        const ev: PostToolUseEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          ...(toolOutput !== undefined ? { toolOutput } : {}),
          ...(input.error_message ? { isError: true } : {}),
        };
        return ev;
      }
      case "SessionStart": {
        const ev: SessionStartEvent = {
          ...base,
          source: normalizeSessionSource(input.source ?? input.trigger),
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
      default: {
        // Cursor never delivers SessionEnd / UserPromptSubmit / PreCompact /
        // Notification (no native equivalent). If the runtime dispatches one
        // anyway, surface a base event of the requested kind so it stays inert.
        throw new Error(`unsupported cursor hook event: ${String(event)}`);
      }
    }
  }

  private getProjectDir(input: CursorWireInput): string | undefined {
    return input.cwd ?? input.workspace_roots?.[0] ?? undefined;
  }

  // ── Runtime: normalized response → Cursor native hook reply ──────────────

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    const decision = response.decision ?? "allow";

    // deny → block the action with a user-facing message.
    if (decision === "deny") {
      return this.stdout({
        permission: "deny",
        user_message: response.reason ?? "Blocked by hook",
      });
    }

    // ask → prompt the user to confirm.
    if (decision === "ask") {
      return this.stdout({
        permission: "ask",
        user_message: response.reason ?? "Confirmation required by hook",
      });
    }

    // modify → rewrite PreToolUse input (only where Cursor supports it).
    if (decision === "modify") {
      if (event === "PreToolUse" && response.updatedInput) {
        return this.stdout({ updated_input: response.updatedInput });
      }
      // Output rewrite is unsupported on Cursor; fall through to allow.
    }

    // context → inject soft guidance. PreToolUse uses `agent_message`; Post and
    // SessionStart use `additional_context`.
    if (decision === "context" && response.additionalContext) {
      return event === "PreToolUse"
        ? this.stdout({ agent_message: response.additionalContext })
        : this.stdout({ additional_context: response.additionalContext });
    }

    // SessionStart always emits valid JSON even on a no-op (Cursor rejects empty
    // stdout as "no valid response").
    if (event === "SessionStart") {
      return this.stdout({ additional_context: response.additionalContext ?? "" });
    }

    // allow / void → minimal no-op payload (Cursor rejects empty stdout).
    if (event === "PreToolUse") return this.stdout({ agent_message: "" });
    if (event === "PostToolUse") return this.stdout({ additional_context: "" });
    return { exitCode: 0 };
  }

  private stdout(payload: unknown): HookReply {
    return { exitCode: 0, stdout: JSON.stringify(payload) };
  }
}

/** Cursor native interpolation token: `${env:VAR}` → `${env:VAR}` (passthrough). */
function cursorEnvToken(name: string): string {
  return `\${env:${name}}`;
}

function extractSessionId(input: CursorWireInput): string {
  if (typeof input.conversation_id === "string") return input.conversation_id;
  if (typeof input.session_id === "string") return input.session_id;
  return "";
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

export const adapter = new CursorAdapter();
export default adapter;
