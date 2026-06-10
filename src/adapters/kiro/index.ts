/**
 * adapters/kiro — Kiro (AWS) platform adapter for agent-connector.
 *
 * Kiro is a json-stdio host with TWO native config surfaces that live in
 * DIFFERENT files (so getServerConfigPath ≠ getHookConfigPath):
 *
 *   1. MCP servers — `mcp.json` under `~/.kiro/settings/` (user) or
 *      `<projectDir>/.kiro/settings/` (project). The file is JSONC; we WRITE
 *      plain JSON (valid JSONC), mirroring the other JSON-config adapters. Root
 *      key `mcpServers`; a stdio server is `{ command, args, env }`.
 *      Ref: https://kiro.dev/docs/mcp/configuration/
 *
 *   2. Hooks — NOT a settings file but an AGENT file:
 *      `~/.kiro/agents/kiro_default.json`. Kiro auto-loads the built-in default
 *      agent `kiro_default` for a new chat session, so hooks must register on
 *      THAT agent (a file literally named `default.json` would define an inactive
 *      custom agent the user must `/agent`-swap to). We merge a `hooks` key into
 *      the existing agent JSON, creating a minimal agent object if absent.
 *      Ref: kiro.dev/docs/cli/custom-agents/configuration-reference#hooks-field
 *
 * Hook protocol is EXIT-CODE based (unlike Claude's JSON-decision wrapper):
 *   - exit 0  → allow the action.
 *   - exit 2  → block the action; the reason is written to stderr.
 *   - agentSpawn (≈ SessionStart) context injection → exit 0 + stdout JSON
 *     `{ hookSpecificOutput: { additionalContext } }`.
 * Kiro CANNOT rewrite tool arguments or output (exit codes only), so
 * canModifyArgs / canModifyOutput are false; `modify` degrades to allow.
 *
 * Native hook event vocabulary differs from the canonical names and is mapped:
 *   PreToolUse       → preToolUse
 *   PostToolUse      → postToolUse
 *   SessionStart     → agentSpawn        (Kiro's session-start equivalent)
 *   UserPromptSubmit → userPromptSubmit
 *   Stop             → stop              (documented Kiro hook)
 * Kiro has no equivalent for PreCompact / SessionEnd / Notification; those are
 * reported as a warn/skip at install time.
 *
 * Env handling: Kiro documents no `${env:VAR}` token of the framework's syntax,
 * so env/header/url refs are resolved to literals at install time via
 * resolveEnvRefsDeep — the safe default matching the Gemini/Codex adapters.
 *
 * Grounded in context-mode's proven Kiro adapter (src/adapters/kiro/*).
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

const HOST: PlatformId = "kiro";
const MCP_ROOT_KEY = "mcpServers";

/** The built-in agent Kiro auto-loads for a new chat session. */
const DEFAULT_AGENT_FILE = "kiro_default.json";

/**
 * Kiro-native hook event names (the keys under an agent file's `hooks` object).
 * Only the events Kiro actually fires for the json-stdio command paradigm.
 */
const KIRO_EVENT = {
  preToolUse: "preToolUse",
  postToolUse: "postToolUse",
  agentSpawn: "agentSpawn",
  userPromptSubmit: "userPromptSubmit",
  stop: "stop",
} as const;

/**
 * Map canonical event names → Kiro's native hook event names. Only the events
 * Kiro supports are present; PreCompact / SessionEnd / Notification have no Kiro
 * equivalent and are reported as a warn/skip at install time.
 */
const EVENT_MAP: Partial<Record<HookEventName, string>> = {
  PreToolUse: KIRO_EVENT.preToolUse,
  PostToolUse: KIRO_EVENT.postToolUse,
  SessionStart: KIRO_EVENT.agentSpawn,
  UserPromptSubmit: KIRO_EVENT.userPromptSubmit,
  Stop: KIRO_EVENT.stop,
};

/** A single Kiro native hook registration entry (Claude-shaped, nested). */
interface KiroHookEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string }>;
}

/** The shape of a Kiro agent file (only the parts we touch). */
interface KiroAgentFile {
  hooks?: Record<string, KiroHookEntry[]>;
  [key: string]: unknown;
}

/** The shape of Kiro's mcp.json (only the parts we touch). */
interface KiroMcpFile {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Native MCP server entry shapes Kiro accepts under `mcpServers`. */
interface KiroStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}
interface KiroHttpServer {
  url: string;
  headers?: Record<string, string>;
}

/** Raw Kiro CLI hook stdin payload (snake_case wire fields). */
interface KiroWireInput {
  connector?: unknown;
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  source?: string;
  prompt?: string;
  stop_hook_active?: boolean;
}

export class KiroAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Kiro";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    preCompact: false,
    sessionStart: true,
    sessionEnd: false,
    // Kiro fires userPromptSubmit and stop, but it has no PreCompact /
    // SessionEnd / Notification equivalent.
    userPromptSubmit: true,
    stop: true,
    notification: false,
    // Kiro's hook protocol is exit-code only — a hook can allow (0), block (2),
    // or inject agentSpawn context, but it CANNOT rewrite tool args or output.
    canModifyArgs: false,
    canModifyOutput: false,
    // agentSpawn returns additionalContext via JSON stdout.
    canInjectSessionContext: true,
    transports: ["stdio", "http"],
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".kiro");
    const userMcp = this.userMcpPath();
    const projectDirKiro = join(projectDir, ".kiro");
    const projectMcp = this.projectMcpPath(projectDir);

    const userInstalled = existsSync(userDir) || existsSync(userMcp);
    const projInstalled = existsSync(projectDirKiro) || existsSync(projectMcp);
    const installed = userInstalled || projInstalled;
    // Report the scope/path that actually matched, so a project-only install
    // isn't misreported as a (non-existent) user install.
    const scope = projInstalled && !userInstalled ? "project" : "user";
    const configPath = scope === "project" ? projectMcp : userMcp;
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
          ? `found project Kiro config at ${projectMcp}`
          : `found Kiro config under ${userDir}`
        : `no Kiro config at ${userDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".kiro")
      : join(homedir(), ".kiro");
  }

  /** MCP servers live in mcp.json under the scope's `.kiro/settings/`. */
  getServerConfigPath(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? this.projectMcpPath(ctx.projectDir)
      : this.userMcpPath();
  }

  /**
   * Hooks live in an AGENT file, NOT a settings file. Kiro auto-loads the
   * built-in default agent (`kiro_default`) for a new chat session, so we always
   * register hooks on the user-scope default agent — that is the agent Kiro
   * actually loads regardless of install scope.
   */
  getHookConfigPath(_ctx: InstallContext): string {
    return join(homedir(), ".kiro", "agents", DEFAULT_AGENT_FILE);
  }

  private userMcpPath(): string {
    return join(homedir(), ".kiro", "settings", "mcp.json");
  }

  private projectMcpPath(projectDir: string): string {
    return join(projectDir, ".kiro", "settings", "mcp.json");
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
            ? "server registration disabled for kiro"
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

  /** Render a normalized ServerDef into Kiro's native mcpServers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): KiroStdioServer | KiroHttpServer {
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

      // Kiro documents no native interpolation token, so resolve every
      // ${env:VAR} to a literal at install time.
      const entry: KiroStdioServer = { command: resolveEnvRefsDeep(command) };
      if (args.length > 0) entry.args = resolveEnvRefsDeep(args);
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      if (server.cwd) entry.cwd = resolveEnvRefsDeep(server.cwd);
      return entry;
    }

    // http (and any other remote transport) — Kiro registers a URL.
    const entry: KiroHttpServer = { url: resolveEnvRefsDeep(server.url ?? "") };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Kiro documents no native interpolation token, so
   * resolve `${env:VAR}` references to literals at install time.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Hook install / uninstall (merge into the agent file) ─────────────────

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.hooks === false) {
      return [{ platform: this.id, action: "skip", detail: "hooks disabled for kiro" }];
    }
    if (connector.hookEvents.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no hooks" }];
    }

    const agentPath = this.getHookConfigPath(ctx);
    // Merge into the existing agent JSON; create a minimal agent object if absent.
    const agent = this.readJson<KiroAgentFile>(agentPath) ?? {};
    const hooks = (agent.hooks ??= {});

    const changes: ChangeRecord[] = [];
    let mutated = false;

    for (const event of connector.hookEvents) {
      const kiroEvent = EVENT_MAP[event];
      if (!kiroEvent) {
        // No Kiro equivalent for this canonical event — report and continue.
        changes.push({
          platform: this.id,
          action: "warn",
          path: agentPath,
          detail: `${event} has no Kiro hook equivalent — skipped`,
        });
        continue;
      }

      const command = buildHomeBinHookCommand(ctx.homeBinPath, HOST, event, connector.id);
      const matcher = connector.hooks[event]?.matcher ?? "";
      const entry: KiroHookEntry = {
        matcher,
        hooks: [{ type: "command", command }],
      };

      const bucket = (hooks[kiroEvent] ??= []);
      const existingIdx = bucket.findIndex((e) => this.entryHasOurCommand(e, ctx));

      if (existingIdx >= 0) {
        if (JSON.stringify(bucket[existingIdx]) === JSON.stringify(entry)) {
          changes.push({
            platform: this.id,
            action: "skip",
            path: agentPath,
            detail: `hooks.${kiroEvent} already registered`,
          });
          continue;
        }
        bucket[existingIdx] = entry;
        changes.push({
          platform: this.id,
          action: "update",
          path: agentPath,
          detail: `hooks.${kiroEvent}`,
        });
      } else {
        bucket.push(entry);
        changes.push({
          platform: this.id,
          action: "create",
          path: agentPath,
          detail: `hooks.${kiroEvent}`,
        });
      }
      mutated = true;
    }

    if (mutated) this.writeJson(agentPath, agent, ctx.dryRun);
    return changes;
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const agentPath = this.getHookConfigPath(ctx);
    const agent = this.readJson<KiroAgentFile>(agentPath);
    const hooks = agent?.hooks;
    if (!agent || !hooks) {
      return [
        {
          platform: this.id,
          action: "skip",
          path: agentPath,
          detail: "no hooks section present",
        },
      ];
    }

    const changes: ChangeRecord[] = [];
    let mutated = false;

    for (const kiroEvent of Object.keys(hooks)) {
      const bucket = hooks[kiroEvent];
      if (!Array.isArray(bucket)) continue;

      // Strip our hook command from each entry; drop entries left empty so we
      // never remove another connector's (or the user's own) hook commands.
      const next: KiroHookEntry[] = [];
      let removed = 0;
      for (const e of bucket) {
        const innerBefore = e.hooks?.length ?? 0;
        const inner = (e.hooks ?? []).filter((h) => !this.isOurCommand(h.command, ctx));
        removed += innerBefore - inner.length;
        if (inner.length > 0) next.push({ matcher: e.matcher ?? "", hooks: inner });
      }

      if (removed > 0) {
        if (next.length > 0) hooks[kiroEvent] = next;
        else delete hooks[kiroEvent];
        changes.push({
          platform: this.id,
          action: "remove",
          path: agentPath,
          detail: `hooks.${kiroEvent} (${removed})`,
        });
        mutated = true;
      }
    }

    if (mutated) this.writeJson(agentPath, agent, ctx.dryRun);
    if (changes.length === 0) {
      changes.push({
        platform: this.id,
        action: "skip",
        path: agentPath,
        detail: "no matching hook entries",
      });
    }
    return changes;
  }

  private entryHasOurCommand(entry: KiroHookEntry, ctx: InstallContext): boolean {
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
    const agentPath = this.getHookConfigPath(ctx);
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
          // Only assert what the connector declares (same rule as the hook
          // check below): a server-less connector never writes an mcpServers
          // entry, so its absence is healthy.
          if (!ctx.connector.server) {
            return { status: "OK", detail: "no MCP server declared" };
          }
          const cfg = this.readJson<KiroMcpFile>(mcpPath);
          const bucket = cfg?.mcpServers;
          if (!cfg || !bucket) {
            return { status: "FAIL", detail: `no ${MCP_ROOT_KEY} in ${mcpPath}` };
          }
          return connectorId in bucket
            ? { status: "OK", detail: `${MCP_ROOT_KEY}.${connectorId} present` }
            : { status: "FAIL", detail: `no ${MCP_ROOT_KEY}.${connectorId} in ${mcpPath}` };
        },
      },
      {
        name: `${this.name}: hook command registered`,
        check: () => {
          if (hookEvents.length === 0) {
            return { status: "OK", detail: "no hooks declared" };
          }
          const agent = this.readJson<KiroAgentFile>(agentPath);
          if (!agent) return { status: "FAIL", detail: `cannot read ${agentPath}` };
          const hooks = agent.hooks ?? {};
          const registered = Object.values(hooks).some((entries) =>
            (entries ?? []).some((e) =>
              (e.hooks ?? []).some((h) =>
                isHomeBinHookCommand(h.command, homeBin, connectorId),
              ),
            ),
          );
          return registered
            ? { status: "OK", detail: "hook command present" }
            : { status: "FAIL", detail: `no hook for ${connectorId} in ${agentPath}` };
        },
      },
    ];
  }

  // ── Runtime: parse Kiro stdin JSON → normalized event ────────────────────

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as KiroWireInput;
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
      case "SessionStart": {
        const ev: SessionStartEvent = {
          ...base,
          source: normalizeSessionSource(input.source),
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
      default: {
        // Kiro never delivers PreCompact / SessionEnd / Notification (no native
        // equivalent). If the runtime dispatches one anyway, surface it loudly
        // rather than silently mis-parse.
        throw new Error(`unsupported kiro hook event: ${String(event)}`);
      }
    }
  }

  // ── Runtime: normalized response → Kiro native (exit-code) hook reply ─────

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    const decision = response.decision ?? "allow";

    // deny → block the action: exit 2 with the reason on stderr.
    if (decision === "deny") {
      return { exitCode: 2, stderr: response.reason ?? "Blocked by hook" };
    }

    // ask → Kiro has no native "ask"; degrade to deny (exit 2) to stay fail-safe.
    if (decision === "ask") {
      return {
        exitCode: 2,
        stderr: response.reason ?? "Action requires user confirmation (security policy)",
      };
    }

    // Stop → exit-code only (deny already handled above as exit 2). There is no
    // context/additionalContext channel on a Stop hook, so anything non-deny
    // passes through with exit 0 (do not fall into the agentSpawn branch).
    if (event === "Stop") {
      return { exitCode: 0 };
    }

    // context → inject soft guidance. Kiro reads agentSpawn additionalContext
    // from stdout JSON (mirrors the Claude SessionStart shape). exit 0 = allow.
    if (decision === "context" && response.additionalContext) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: KIRO_EVENT.agentSpawn,
            additionalContext: response.additionalContext,
          },
        }),
      };
    }

    // modify is unsupported on Kiro (exit-code protocol — cannot rewrite
    // args/output); allow / void → pass through with exit 0.
    return { exitCode: 0 };
  }
}

/** Coerce a Kiro PostToolUse `tool_response` into a string for the normalized event. */
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

export const adapter = new KiroAdapter();
export default adapter;
