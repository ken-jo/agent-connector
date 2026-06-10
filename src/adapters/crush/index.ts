/**
 * adapters/crush — Crush (Charm) platform adapter for agentconnect.
 *
 * Crush is a json-stdio host. A single JSON config file holds BOTH the MCP
 * server registrations and the hook registrations, and agentconnect MERGES
 * into it (never replaces it — unrelated keys are preserved verbatim):
 *   - User scope:    ~/.config/crush/crush.json
 *                    (Windows: %LOCALAPPDATA%\crush\crush.json)
 *   - Project scope: ./.crush.json  (preferred)  or  ./crush.json
 *
 * MCP servers live under the ROOT KEY "mcp" (NOT "mcpServers"). A stdio entry is
 *   { type:"stdio", command, args, env, timeout:120, disabled:false }.
 * Hooks live under the top-level "hooks" key. Crush supports PreToolUse ONLY;
 * the hook reads the host's JSON on stdin and writes a JSON object on stdout
 * carrying a `decision` field. A deny is `{ decision:"deny", reason }` on
 * stdout (exit 0); an allow is an empty stdout (exit 0). Crush cannot rewrite
 * tool args/output nor inject session context — every non-deny decision (and
 * every non-PreToolUse event) degrades to a silent allow.
 *
 * SECURITY NOTE: Crush expands `$(...)` command substitution in its config file
 * at load time. We therefore NEVER emit shell-substitution syntax into the
 * command/args/env we write — every value is a literal path/string built by the
 * spawn helpers (which quote, not interpolate). Connector ids are kebab-case and
 * the home-bin path is an absolute literal, so nothing we write can be coerced
 * into a `$(...)` substitution.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
  PreToolUseEvent,
  ServerDef,
  Transport,
} from "../../core/types.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  buildHomeBinHookCommand,
  buildServeWrapperCommand,
  isHomeBinHookCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";

const HOST: PlatformId = "crush";
/** Crush registers MCP servers under "mcp" — NOT the "mcpServers" of Claude/Gemini. */
const MCP_ROOT_KEY = "mcp";
/** Default per-server timeout (seconds) Crush expects on a stdio entry. */
const STDIO_TIMEOUT_SECONDS = 120;

/**
 * Crush hook events agentconnect can register. Crush honors PreToolUse ONLY,
 * and only its deny decision is meaningful; every other normalized event has no
 * Crush equivalent and is skipped at install time.
 */
const CRUSH_HOOK_EVENTS = ["PreToolUse"] as const;
type CrushHookEventName = (typeof CRUSH_HOOK_EVENTS)[number];

// ─────────────────────────────────────────────────────────────────────────
// Native config shapes (only the parts we touch; rest preserved verbatim)
// ─────────────────────────────────────────────────────────────────────────

/** One hook registration entry as Crush stores it under top-level "hooks". */
interface CrushHookEntry {
  matcher?: string;
  command: string;
  [key: string]: unknown;
}

/** Crush's crush.json shape — only the keys we read/merge. */
interface CrushConfigFile {
  mcp?: Record<string, unknown>;
  hooks?: Record<string, CrushHookEntry[]>;
  [key: string]: unknown;
}

/** Native stdio MCP server entry under "mcp". */
interface CrushStdioServer {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeout: number;
  disabled: boolean;
}

/** Native HTTP MCP server entry under "mcp". */
interface CrushHttpServer {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  timeout: number;
  disabled: boolean;
}

/** Raw Crush hook stdin payload (Claude-style: PascalCase event, snake_case fields). */
interface CrushHookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  connector?: unknown;
}

export class CrushAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Crush";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    // PreToolUse deny is the only hook decision Crush honors.
    preToolUse: true,
    postToolUse: false,
    preCompact: false,
    sessionStart: false,
    sessionEnd: false,
    userPromptSubmit: false,
    stop: false,
    notification: false,
    // Crush is deny-only: it cannot rewrite tool args/output nor inject context.
    canModifyArgs: false,
    canModifyOutput: false,
    canInjectSessionContext: false,
    transports: ["stdio", "http"],
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = this.userConfigDir();
    const userConfig = join(userDir, "crush.json");
    const projectDot = join(projectDir, ".crush.json");
    const projectBare = join(projectDir, "crush.json");
    const userInstalled = existsSync(userDir) || existsSync(userConfig);
    const projInstalled = existsSync(projectDot) || existsSync(projectBare);
    const installed = userInstalled || projInstalled;
    // Report the scope/path that actually matched so a project-only install is
    // not misreported as a (non-existent) user install.
    const scope = projInstalled && !userInstalled ? "project" : "user";
    const projectPath = existsSync(projectBare) && !existsSync(projectDot) ? projectBare : projectDot;
    const configPath = scope === "project" ? projectPath : userConfig;
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
          ? `found project Crush config at ${configPath}`
          : `found Crush config under ${userDir}`
        : `no Crush config at ${userConfig}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project" ? ctx.projectDir : this.userConfigDir();
  }

  /** MCP servers and hooks share ONE crush.json file. */
  getServerConfigPath(ctx: InstallContext): string {
    if (ctx.scope === "project") {
      // Prefer ./.crush.json, but MERGE into an existing ./crush.json if that is
      // the file already present (so we don't fork the user's config in two).
      const dot = join(ctx.projectDir, ".crush.json");
      const bare = join(ctx.projectDir, "crush.json");
      if (existsSync(bare) && !existsSync(dot)) return bare;
      return dot;
    }
    return join(this.userConfigDir(), "crush.json");
  }

  /** Hooks live in the SAME crush.json under the top-level "hooks" key. */
  getHookConfigPath(ctx: InstallContext): string {
    return this.getServerConfigPath(ctx);
  }

  /**
   * Crush's user config dir:
   *   - Windows: %LOCALAPPDATA%\crush  (Local; falls back to AppData/Local)
   *   - macOS / Linux: ~/.config/crush
   */
  private userConfigDir(): string {
    if (process.platform === "win32") {
      const localAppData =
        process.env.LOCALAPPDATA && process.env.LOCALAPPDATA.trim() !== ""
          ? process.env.LOCALAPPDATA
          : resolve(homedir(), "AppData", "Local");
      return join(localAppData, "crush");
    }
    return join(homedir(), ".config", "crush");
  }

  // ── MCP server install / uninstall (crush.json → mcp.<id>) ───────────────

  installServer(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    const override = connector.platforms[HOST]?.server;
    if (!connector.server || override === false) {
      return [
        {
          platform: this.id,
          action: "skip",
          detail: connector.server
            ? "server registration disabled for crush"
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

  /**
   * Render a normalized ServerDef into Crush's native "mcp" entry. Crush has no
   * documented native `${env:VAR}` interpolation — and it expands `$(...)` at
   * load time — so refs are resolved to LITERALS at install time (the safe
   * posture for a host without native interpolation, matching Codex/Kimi).
   */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): CrushStdioServer | CrushHttpServer {
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

      // Resolve to literals — never emit `$(...)` Crush would expand at load.
      command = resolveEnvRefsDeep(command);
      args = resolveEnvRefsDeep(args);

      const entry: CrushStdioServer = {
        type: "stdio",
        command,
        args,
        timeout: STDIO_TIMEOUT_SECONDS,
        disabled,
      };
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      return entry;
    }

    // http (and any other remote transport we surface) — Crush registers a URL.
    const entry: CrushHttpServer = {
      type: "http",
      url: resolveEnvRefsDeep(server.url ?? ""),
      timeout: STDIO_TIMEOUT_SECONDS,
      disabled,
    };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /** Resolve env/header values to literals (no native interpolation on Crush). */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(resolveEnvRefsDeep({ ...env }))) {
      out[k] = String(v);
    }
    return out;
  }

  // ── Hook install / uninstall (crush.json → hooks.PreToolUse[]) ───────────

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.hooks === false) {
      return [{ platform: this.id, action: "skip", detail: "hooks disabled for crush" }];
    }

    const events = this.effectiveHookEvents(ctx);
    const path = this.getHookConfigPath(ctx);

    if (events.length === 0) {
      return [{ platform: this.id, action: "skip", path, detail: "no hooks declared" }];
    }

    const cfg = this.readJson<CrushConfigFile>(path) ?? {};
    const hooks = (cfg.hooks ??= {});

    const changes: ChangeRecord[] = [];
    let mutated = false;

    for (const event of events) {
      const command = buildHomeBinHookCommand(ctx.homeBinPath, HOST, event, connector.id);
      const matcher = connector.hooks[event]?.matcher ?? "";
      const entry: CrushHookEntry = { matcher, command };

      const bucket = (hooks[event] ??= []);
      const existingIdx = bucket.findIndex((e) => this.isOurHook(e, ctx));

      if (existingIdx >= 0) {
        if (JSON.stringify(bucket[existingIdx]) === JSON.stringify(entry)) {
          changes.push({
            platform: this.id,
            action: "skip",
            path,
            detail: `hooks.${event} already registered`,
          });
          continue;
        }
        bucket[existingIdx] = entry;
        changes.push({ platform: this.id, action: "update", path, detail: `hooks.${event}` });
      } else {
        bucket.push(entry);
        changes.push({ platform: this.id, action: "create", path, detail: `hooks.${event}` });
      }
      mutated = true;
    }

    if (mutated) this.writeJson(path, cfg, ctx.dryRun);
    return changes;
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const path = this.getHookConfigPath(ctx);
    const cfg = this.readJson<CrushConfigFile>(path);
    const hooks = cfg?.hooks;
    if (!cfg || !hooks) {
      return [
        { platform: this.id, action: "skip", path, detail: "no hooks section present" },
      ];
    }

    const changes: ChangeRecord[] = [];
    let mutated = false;

    for (const event of Object.keys(hooks)) {
      const bucket = hooks[event];
      if (!Array.isArray(bucket)) continue;

      // Keep every entry that is NOT ours (anchored match) so a shared-prefix
      // connector id — or the user's own hook — is never stripped.
      const kept = bucket.filter((e) => !this.isOurHook(e, ctx));
      const removed = bucket.length - kept.length;
      if (removed > 0) {
        if (kept.length > 0) hooks[event] = kept;
        else delete hooks[event];
        changes.push({
          platform: this.id,
          action: "remove",
          path,
          detail: `hooks.${event} (${removed})`,
        });
        mutated = true;
      }
    }

    if (mutated) this.writeJson(path, cfg, ctx.dryRun);
    if (changes.length === 0) {
      changes.push({
        platform: this.id,
        action: "skip",
        path,
        detail: "no matching hook entries",
      });
    }
    return changes;
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  /** Which canonical hook events to register for Crush, honoring overrides. */
  private effectiveHookEvents(ctx: InstallContext): CrushHookEventName[] {
    if (ctx.connector.platforms[HOST]?.hooks === false) return [];
    return CRUSH_HOOK_EVENTS.filter((e) => ctx.connector.hookEvents.includes(e));
  }

  /**
   * Does this hook entry belong to this connector? Anchored on the home-bin +
   * connector-id token (isHomeBinHookCommand) so uninstalling a shared-prefix
   * connector id never strips a sibling's hook.
   */
  private isOurHook(entry: CrushHookEntry | undefined, ctx: InstallContext): boolean {
    if (!entry || typeof entry !== "object") return false;
    return isHomeBinHookCommand(entry.command, ctx.homeBinPath, ctx.connector.id);
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const configPath = this.getServerConfigPath(ctx);
    const connectorId = ctx.connector.id;
    const homeBin = ctx.homeBinPath;
    const hookEvents = this.effectiveHookEvents(ctx);
    return [
      {
        name: `${this.name}: crush.json present`,
        check: () =>
          existsSync(configPath)
            ? { status: "OK", detail: configPath }
            : { status: "FAIL", detail: `not found: ${configPath}` },
      },
      {
        name: `${this.name}: mcp.${connectorId} registered`,
        check: () => {
          if (!ctx.connector.server) return { status: "OK", detail: "no MCP server declared" };
          const cfg = this.readJson<CrushConfigFile>(configPath);
          const bucket = cfg?.[MCP_ROOT_KEY];
          const present =
            typeof bucket === "object" && bucket !== null && connectorId in bucket;
          return present
            ? { status: "OK", detail: `mcp.${connectorId}` }
            : { status: "FAIL", detail: `mcp.${connectorId} not found in ${configPath}` };
        },
      },
      {
        name: `${this.name}: hook command registered`,
        check: () => {
          if (hookEvents.length === 0) {
            return { status: "OK", detail: "no hooks declared" };
          }
          const cfg = this.readJson<CrushConfigFile>(configPath);
          if (!cfg) return { status: "FAIL", detail: `cannot read ${configPath}` };
          const hooks = cfg.hooks ?? {};
          const registered = Object.values(hooks).some((entries) =>
            (entries ?? []).some((e) => isHomeBinHookCommand(e?.command, homeBin, connectorId)),
          );
          return registered
            ? { status: "OK", detail: "hook command present" }
            : { status: "FAIL", detail: `no hook for ${connectorId} in ${configPath}` };
        },
      },
    ];
  }

  // ── Runtime: parse Crush stdin JSON → normalized event ───────────────────

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as CrushHookInput;
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

    if (event === "PreToolUse") {
      const ev: PreToolUseEvent = {
        ...base,
        toolName: input.tool_name ?? "",
        toolInput: input.tool_input ?? {},
      };
      return ev;
    }

    // Crush only ever delivers PreToolUse. Surface anything else loudly rather
    // than silently mis-parsing a payload the host cannot actually produce.
    throw new Error(`unsupported crush hook event: ${String(event)}`);
  }

  // ── Runtime: normalized response → Crush native hook reply ───────────────

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    const decision = response.decision ?? "allow";

    // deny → Crush blocks the pending tool call via a stdout JSON object with a
    // `decision:"deny"` (+ reason). Only PreToolUse is honored; every other
    // event/decision degrades to a silent allow.
    if (decision === "deny" && event === "PreToolUse") {
      return this.stdout({
        decision: "deny",
        reason: response.reason ?? "Blocked by hook",
      });
    }

    // allow / modify / context / ask / unsupported → pass through (exit 0, empty
    // stdout). Crush cannot rewrite args/output or inject context, so those are
    // dropped fail-open here (the deny path above is the only fail-safe lever).
    return { exitCode: 0 };
  }

  private stdout(payload: unknown): HookReply {
    return { exitCode: 0, stdout: JSON.stringify(payload) };
  }
}

export const adapter = new CrushAdapter();
export default adapter;
