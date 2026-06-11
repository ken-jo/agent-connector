/**
 * adapters/droid — Droid (Factory AI) platform adapter for agent-connector.
 *
 * Droid is a **json-stdio** host with TWO native config surfaces that live in
 * DIFFERENT files (so getServerConfigPath ≠ getHookConfigPath):
 *
 *   1. MCP servers — `mcp.json` (root key `mcpServers`):
 *        - user scope    → ~/.factory/mcp.json
 *        - project scope → <projectDir>/.factory/mcp.json
 *      Native stdio entry shape: { type:"stdio", command, args, env, disabled };
 *      a remote server registers a URL ({ type:"http", url, headers, disabled }).
 *
 *   2. Hooks — a SEPARATE `hooks.json` (root key `hooks`) under the same
 *      `.factory` dir. Droid ships a FULL Claude-compatible lifecycle hook
 *      system (live-confirmed): PascalCase event names, Claude snake_case stdin
 *      wire fields, and a Claude-shaped `hookSpecificOutput` reply. Hook
 *      registrations use the Claude NESTED-rule shape:
 *        { hooks: { <Event>: [ { matcher?, hooks:[{ type:"command", command }] } ] } }
 *
 * Supported events (Claude-compatible): PreToolUse, PostToolUse,
 * UserPromptSubmit, Stop, SubagentStop (stop-only — no SubagentStart). Droid
 * exposes no PreCompact / SessionStart / SessionEnd / Notification /
 * PermissionRequest / PostToolUseFailure / SubagentStart, so those degrade to
 * a warn/skip at install time.
 *
 * Reply protocol is Claude-shaped JSON on stdout (exit 0 + `hookSpecificOutput`
 * with permissionDecision allow|deny|ask, plus additionalContext). Droid cannot
 * rewrite already-emitted tool output, so canModifyOutput is false; it CAN
 * inject session context (additionalContext) so canInjectSessionContext is true.
 *
 * Env handling: env/header/url refs are resolved to literals at install time via
 * resolveEnvRefsDeep — the safe default matching the Kiro/Qwen adapters. Droid
 * also accepts native ${VAR}, but resolve-to-literal avoids surprises.
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
  PlatformCapabilities,
  PlatformId,
  PostToolUseEvent,
  PreToolUseEvent,
  ServerDef,
  StopEvent,
  SubagentStopEvent,
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

const HOST: PlatformId = "droid";
const MCP_ROOT_KEY = "mcpServers";

/**
 * Canonical events Droid actually fires. Droid's hook event names are
 * Claude-identical (PascalCase), so the canonical name is registered directly.
 * PreCompact / SessionStart / SessionEnd / Notification have no Droid equivalent
 * and are reported as a warn/skip at install time.
 *
 * Droid is a STOP-ONLY subagent host: its live hooks-reference lists
 * SubagentStop but NO SubagentStart, and it has no permission-dialog
 * (PermissionRequest) or tool-failure (PostToolUseFailure) events — those
 * three warn/skip as well.
 */
const SUPPORTED_EVENTS: ReadonlySet<HookEventName> = new Set<HookEventName>([
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
]);

/**
 * Native MCP server entry shapes Droid accepts under `mcpServers`.
 * A stdio entry carries an explicit `type: "stdio"` discriminator and a
 * `disabled` flag; remote transports register a URL.
 */
interface DroidStdioServer {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled: boolean;
}
interface DroidHttpServer {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  disabled: boolean;
}

/** A single Droid native hook registration entry (Claude-shaped, nested). */
interface DroidHookEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string }>;
}

/** The shape of Droid's hooks.json (only the parts we touch). */
interface DroidHooksFile {
  hooks?: Record<string, DroidHookEntry[]>;
  [key: string]: unknown;
}

/** Raw Droid CLI hook stdin payload (Claude-compatible snake_case wire fields). */
interface DroidWireInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  prompt?: string;
  /** Stop / SubagentStop loop guard. */
  stop_hook_active?: boolean;
  // SubagentStop — Claude-compatible snake_case fields. agent_type is
  // unreliable on SubagentStop across hosts; treat both as optional.
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
  last_assistant_message?: string;
  /** Injected by the entrypoint so the runtime knows which connector to dispatch. */
  connector?: unknown;
}

export class DroidAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Droid (Factory)";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: AGENTS.md-first managed block via the BaseAdapter default
    // (memoryTargets: project <projectDir>/AGENTS.md; user scope where documented).
    supportsMemory: true,
    preToolUse: true,
    postToolUse: true,
    preCompact: false,
    sessionStart: false,
    sessionEnd: false,
    userPromptSubmit: true,
    stop: true,
    notification: false,
    // Newer events: Droid ships SubagentStop (stop-only — no SubagentStart).
    // permissionRequest / postToolUseFailure / subagentStart stay unset (no
    // Droid analog); install reports the standard skip-warn for them.
    subagentStop: true,
    // Droid's PreToolUse can deny/ask (Claude-shaped), but it cannot rewrite
    // already-emitted tool output. canModifyArgs left false until confirmed.
    canModifyArgs: false,
    canModifyOutput: false,
    // Droid honors additionalContext on the stdout reply.
    canInjectSessionContext: true,
    // Droid registers stdio and Streamable HTTP MCP servers.
    transports: ["stdio", "http"],
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".factory");
    const userMcp = join(userDir, "mcp.json");
    const projDir = join(projectDir, ".factory");
    const projMcp = join(projDir, "mcp.json");

    const userInstalled = existsSync(userDir) || existsSync(userMcp);
    const projInstalled = existsSync(projDir) || existsSync(projMcp);
    const installed = userInstalled || projInstalled;
    const scope = projInstalled && !userInstalled ? "project" : "user";
    const configPath = scope === "project" ? projMcp : userMcp;

    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath,
      scope,
      reason: installed
        ? `found Droid config (${scope}) at ${configPath}`
        : `no .factory config at ${userDir} or ${projDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".factory")
      : join(homedir(), ".factory");
  }

  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "mcp.json");
  }

  /** Hooks live in a SEPARATE hooks.json under the same `.factory` dir. */
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
            ? "server registration disabled for droid"
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

  /** Render a normalized ServerDef into Droid's native mcpServers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): DroidStdioServer | DroidHttpServer {
    const transport: Transport = server.transport;
    const disabled = server.enabled === false;

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

      // Resolve every ${env:VAR} to a literal at install time (safe path).
      const entry: DroidStdioServer = {
        type: "stdio",
        command: resolveEnvRefsDeep(command),
        disabled,
      };
      if (args.length > 0) entry.args = resolveEnvRefsDeep(args);
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      return entry;
    }

    // http (and any other remote transport) — Droid registers a URL.
    const entry: DroidHttpServer = {
      type: "http",
      url: resolveEnvRefsDeep(server.url ?? ""),
      disabled,
    };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Resolve `${env:VAR}` references to literals at
   * install time (the safe path; Droid would also accept native ${VAR}).
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
      return [{ platform: this.id, action: "skip", detail: "hooks disabled for droid" }];
    }
    if (connector.hookEvents.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no hooks" }];
    }

    const hookPath = this.getHookConfigPath(ctx);
    // Merge into any existing hooks.json so the user's own hooks survive.
    const file = this.readJson<DroidHooksFile>(hookPath) ?? {};
    const hooks = (file.hooks ??= {});

    const changes: ChangeRecord[] = [];
    let mutated = false;

    for (const event of connector.hookEvents) {
      if (!SUPPORTED_EVENTS.has(event)) {
        changes.push({
          platform: this.id,
          action: "warn",
          path: hookPath,
          detail: `${event} has no Droid hook equivalent — skipped`,
        });
        continue;
      }

      // Droid's event names are Claude-identical (PascalCase) — register the
      // canonical event name directly.
      const command = buildHomeBinHookCommand(ctx.homeBinPath, HOST, event, connector.id);
      const matcher = connector.hooks[event]?.matcher ?? "";
      const entry: DroidHookEntry = {
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
            path: hookPath,
            detail: `hooks.${event} already registered`,
          });
          continue;
        }
        bucket[existingIdx] = entry;
        changes.push({
          platform: this.id,
          action: "update",
          path: hookPath,
          detail: `hooks.${event}`,
        });
      } else {
        bucket.push(entry);
        changes.push({
          platform: this.id,
          action: "create",
          path: hookPath,
          detail: `hooks.${event}`,
        });
      }
      mutated = true;
    }

    if (mutated) this.writeJson(hookPath, file, ctx.dryRun);
    return changes;
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const hookPath = this.getHookConfigPath(ctx);
    const file = this.readJson<DroidHooksFile>(hookPath);
    const hooks = file?.hooks;
    if (!file || !hooks) {
      return [
        {
          platform: this.id,
          action: "skip",
          path: hookPath,
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
      const next: DroidHookEntry[] = [];
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
          path: hookPath,
          detail: `hooks.${event} (${removed})`,
        });
        mutated = true;
      }
    }

    if (mutated) this.writeJson(hookPath, file, ctx.dryRun);
    if (changes.length === 0) {
      changes.push({
        platform: this.id,
        action: "skip",
        path: hookPath,
        detail: "no matching hook entries",
      });
    }
    return changes;
  }

  private entryHasOurCommand(entry: DroidHookEntry, ctx: InstallContext): boolean {
    return (entry.hooks ?? []).some((h) => this.isOurCommand(h.command, ctx));
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
          const file = this.readJson<DroidHooksFile>(hookPath);
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

  // ── Runtime: parse Droid stdin JSON → normalized event ────────────────────

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as DroidWireInput;
    const connectorId = typeof input.connector === "string" ? input.connector : "";
    const sessionId = typeof input.session_id === "string" ? input.session_id : "";
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
      case "UserPromptSubmit": {
        const ev: UserPromptSubmitEvent = {
          ...base,
          prompt: typeof input.prompt === "string" ? input.prompt : "",
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
      case "SubagentStop": {
        // agent_id/agent_type stay optional — hosts do not reliably populate
        // agent_type on SubagentStop (Claude-compatible quirk).
        const ev: SubagentStopEvent = {
          ...base,
          ...(typeof input.agent_id === "string" ? { agentId: input.agent_id } : {}),
          ...(typeof input.agent_type === "string"
            ? { agentType: input.agent_type }
            : {}),
          ...(typeof input.agent_transcript_path === "string"
            ? { agentTranscriptPath: input.agent_transcript_path }
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
      default: {
        // Droid never delivers PreCompact / SessionStart / SessionEnd /
        // Notification / PermissionRequest / PostToolUseFailure / SubagentStart
        // (no native equivalent). If the runtime dispatches one anyway, surface
        // it loudly rather than silently mis-parse.
        throw new Error(`unsupported droid hook event: ${String(event)}`);
      }
    }
  }

  // ── Runtime: normalized response → Droid native (Claude-shaped) hook reply ─

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    const hookEventName = event;
    const decision = response.decision ?? "allow";

    // deny → block the action with a reason (exit 0; JSON carries the decision).
    if (decision === "deny") {
      // SubagentStop deny carries Stop semantics — it keeps the subagent
      // running with `reason` as its next instruction — and (Claude-compatible)
      // is honored only as the TOP-LEVEL {"decision":"block","reason"}, not as
      // a permissionDecision envelope.
      if (event === "SubagentStop") {
        return this.stdout({
          decision: "block",
          reason: response.reason ?? "Blocked by hook",
        });
      }
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

    // context → inject soft guidance (Droid honors additionalContext).
    if (decision === "context" && response.additionalContext) {
      return this.stdout({
        hookSpecificOutput: { hookEventName, additionalContext: response.additionalContext },
      });
    }

    // allow / modify (unsupported — exit-code/decision protocol only) / void →
    // pass through with exit 0.
    return { exitCode: 0 };
  }

  private stdout(payload: unknown): HookReply {
    return { exitCode: 0, stdout: JSON.stringify(payload) };
  }
}

/** Coerce a Droid PostToolUse `tool_response` into a string for the normalized event. */
function toolResponseToString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const adapter = new DroidAdapter();
export default adapter;
