/**
 * adapters/grok-cli — Grok CLI (the community superagent-ai/grok-cli, npm
 * `grok-dev`, bin `grok`, MIT) platform adapter for agent-connector.
 *
 * Disambiguation: id is `grok-cli` (NOT `grok`) to keep it distinct from xAI's
 * separate "Grok Build" product. This adapter targets the OPEN-SOURCE community
 * CLI only — byte-confirmed against its source on 2026-06-21:
 *   - package.json → name "grok-dev", bin { "grok": "dist/index.js" }, MIT.
 *   - src/utils/settings.ts → USER settings at ~/.grok/user-settings.json
 *     (USER_SETTINGS_PATH = join(homedir(), ".grok", "user-settings.json")).
 *
 * Grok CLI is a **json-stdio** host. Its native surfaces are USER-SCOPE ONLY and
 * BOTH live in the SAME file (~/.grok/user-settings.json):
 *
 *   1. MCP servers — under the NESTED key `mcp.servers`, which is a JSON **ARRAY**
 *      of McpServerConfig objects (NOT a top-level `mcpServers` keyed object map —
 *      the README's casual "(mcpServers)" wording is misleading; the source reads
 *      `loadUserSettings().mcp?.servers`). Each entry:
 *        { id, label, enabled, transport: "stdio"|"http"|"sse",
 *          url?, headers?, command?, args?, env?, cwd? }
 *      (src/utils/settings.ts `McpServerConfig`). We key entries on `id` =
 *      connector id (mirrors continue's array-by-name merge, but JSON not YAML).
 *      Project `.grok/settings.json` holds ONLY { model, sandboxMode, sandbox,
 *      lsp } — NO mcp, NO hooks — so this adapter is user-scope.
 *
 *   2. Hooks — under the top-level `hooks` key (Claude NESTED-rule shape:
 *        { hooks: { <Event>: [ { matcher?, hooks:[{ type:"command", command,
 *        timeout? }] } ] } }), loaded from user-settings.json ONLY (project-level
 *        hooks are DELIBERATELY excluded by Grok for security — a committed repo
 *        file must not execute unsandboxed host commands). So `hooks` is wired
 *        through the SAME shared object-map hook-merge engine droid/claude use.
 *
 * Supported hook events (byte-confirmed src/hooks/types.ts HOOK_EVENTS): the
 * Grok set is a SUPERSET of our canonical names plus host-specific ones. We wire
 * the canonical events Grok fires (PascalCase, 1:1): PreToolUse, PostToolUse,
 * PostToolUseFailure, UserPromptSubmit, SessionStart, SessionEnd, Stop,
 * SubagentStart, SubagentStop, PreCompact, PostCompact, Notification. Grok also
 * fires StopFailure, TaskCreated, TaskCompleted, InstructionsLoaded, CwdChanged
 * (no canonical analog — they ride the nativeHooks passthrough) and has no
 * PermissionRequest event (warn/skip at install).
 *
 * Stdin wire field names DIFFER from Claude's in two false-friend spots
 * (byte-confirmed src/hooks/types.ts): UserPromptSubmit carries `user_prompt`
 * (NOT `prompt`), and PostToolUse carries `tool_output` (NOT `tool_response`).
 * PostToolUseFailure/StopFailure carry `error` (string); SubagentStart/Stop carry
 * `agent_type` + `description`; SessionStart carries `source`; PreCompact/
 * PostCompact carry `trigger`; Notification carries `message`. `session_id` is
 * optional; `cwd` is always present.
 *
 * Reply protocol (byte-confirmed src/hooks/executor.ts aggregateHookResults):
 * stdout is parsed as JSON when it starts with `{`. A hook BLOCKS via either
 * exit code 2 OR a stdout `{ "decision": "block" }`; `{ "decision": "approve" }`
 * explicitly approves; `additionalContext` is injected as context; `continue:
 * false` + `stopReason` prevents continuation. We emit exit 0 + a structured
 * stdout object (so the JSON is always parsed): deny → {decision:"block",reason};
 * context → {additionalContext}. Grok has no "ask"/"modify" reply path — those
 * degrade to a plain exit-0 passthrough (canModifyArgs/Output stay false).
 *
 * Env handling: Grok documents no native ${VAR} server interpolation, so env/
 * header/url refs resolve to literals at install time via resolveEnvRefsDeep
 * (the safe default matching continue/droid).
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
  NotificationEvent,
  PlatformCapabilities,
  PlatformId,
  PostCompactEvent,
  PostToolUseEvent,
  PostToolUseFailureEvent,
  PreCompactEvent,
  PreToolUseEvent,
  ServerDef,
  SessionEndEvent,
  SessionStartEvent,
  StopEvent,
  SubagentStartEvent,
  SubagentStopEvent,
  Transport,
  UserPromptSubmitEvent,
} from "../../core/types.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import { buildWrappedStdio, isHomeBinHookCommand } from "../../core/spawn.js";
import { normalizeSessionSource } from "../claude-code/wire.js";

const HOST: PlatformId = "grok-cli";

/**
 * Canonical events Grok fires (PascalCase, 1:1 with our names). PermissionRequest
 * is absent from Grok's HOOK_EVENTS, so it warn/skips at install. The host-only
 * events (StopFailure, TaskCreated, TaskCompleted, InstructionsLoaded, CwdChanged)
 * have no canonical analog and ride the nativeHooks passthrough.
 */
const SUPPORTED_EVENTS: ReadonlySet<HookEventName> = new Set<HookEventName>([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Notification",
]);

/**
 * Native MCP server entry shape (src/utils/settings.ts `McpServerConfig`). The
 * array lives at `mcp.servers`. `id`/`label`/`enabled`/`transport` are required;
 * stdio carries command/args/env/cwd, remote carries url/headers.
 */
interface GrokMcpServer {
  id: string;
  label: string;
  enabled: boolean;
  transport: Transport;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** The shape of user-settings.json (only the parts this adapter touches). */
interface GrokUserSettings {
  mcp?: { servers?: GrokMcpServer[] };
  hooks?: Record<string, GrokHookEntry[]>;
  [key: string]: unknown;
}

/** A single Grok native hook registration entry (Claude-shaped, nested). */
interface GrokHookEntry {
  matcher?: string;
  hooks: Array<{ type: "command"; command: string; timeout?: number }>;
}

/** Raw Grok CLI hook stdin payload (snake_case; field names per src/hooks/types.ts). */
interface GrokWireInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** PostToolUse — NOTE Grok sends `tool_output` (NOT Claude's `tool_response`). */
  tool_output?: unknown;
  /** PostToolUseFailure / StopFailure — the captured error message (string). */
  error?: unknown;
  /** UserPromptSubmit — NOTE Grok sends `user_prompt` (NOT Claude's `prompt`). */
  user_prompt?: unknown;
  /** SessionStart — startup | resume | clear. */
  source?: string;
  /** PreCompact / PostCompact — auto | manual. */
  trigger?: "auto" | "manual";
  /** Notification — the user-facing message. */
  message?: unknown;
  /** SubagentStart / SubagentStop / TaskCreated / TaskCompleted. */
  agent_type?: unknown;
  description?: unknown;
  /** Injected by the entrypoint so the runtime knows which connector to dispatch. */
  connector?: unknown;
}

export class GrokCliAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Grok CLI";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: Grok reads AGENTS.md ("merged from git root down to your
    // cwd; AGENTS.override.md wins per directory" — README). The BaseAdapter
    // AGENTS.md-first default handles it.
    supportsMemory: true,
    preToolUse: true,
    postToolUse: true,
    postToolUseFailure: true,
    userPromptSubmit: true,
    sessionStart: true,
    sessionEnd: true,
    stop: true,
    notification: true,
    preCompact: true,
    // Grok fires PostCompact (its HOOK_EVENTS lists it beside PreCompact).
    postCompact: true,
    // Grok fires SubagentStart AND SubagentStop (both in HOOK_EVENTS).
    subagentStart: true,
    subagentStop: true,
    // No PermissionRequest event in Grok's HOOK_EVENTS → warn/skip at install.
    // Grok's reply protocol is block/approve/context only — it cannot rewrite
    // tool args or already-emitted output.
    canModifyArgs: false,
    canModifyOutput: false,
    // Grok injects `additionalContext` from a hook's stdout JSON.
    canInjectSessionContext: true,
    // Grok's settings.json hook keys are free-form event names (its HOOK_EVENTS
    // superset includes StopFailure/TaskCreated/TaskCompleted/InstructionsLoaded/
    // CwdChanged with no canonical analog), so any host event declared under
    // platforms["grok-cli"].nativeHooks installs verbatim.
    supportsNativeHooks: true,
    // MCP entry supports stdio + remote (http / sse) per McpServerConfig.transport.
    transports: ["stdio", "http", "sse"],
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(_projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".grok");
    const userSettings = join(userDir, "user-settings.json");
    // SIBLING BOW-OUT: xAI's Grok Build (adapter id `grok-build`) is an
    // UNRELATED product that also defaults to ~/.grok, so the bare directory no
    // longer proves this community CLI is installed. Each adapter owns an
    // exclusive marker file — grok-cli `user-settings.json`, Grok Build
    // `config.toml` — and claims the shared dir only when the sibling's marker
    // is not the sole occupant. Without this, a Grok-Build-only machine would
    // report Grok CLI as installed and install into a config it never reads.
    const siblingOnly = existsSync(join(userDir, "config.toml")) && !existsSync(userSettings);
    const installed = existsSync(userSettings) || (existsSync(userDir) && !siblingOnly);
    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      // MCP + hooks both live in user-settings.json (user scope only).
      configPath: userSettings,
      scope: "user",
      reason: installed
        ? `found Grok CLI config at ${userSettings}`
        : siblingOnly
          ? `${userDir} holds only Grok Build's config.toml`
          : `no Grok CLI config at ${userDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ───────────────────────────────────────────────────────────
  // BOTH MCP servers (mcp.servers array) and hooks (top-level hooks map) live in
  // the SAME user-settings.json. Project .grok/settings.json holds neither, so
  // every scope resolves to the user file.

  getConfigDir(_ctx: InstallContext): string {
    return join(homedir(), ".grok");
  }

  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "user-settings.json");
  }

  getHookConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "user-settings.json");
  }

  // ── MCP server install / uninstall (JSON — nested mcp.servers ARRAY) ───────

  installServer(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    const path = this.getServerConfigPath(ctx);
    const override = connector.platforms[HOST]?.server;
    if (!connector.server || override === false) {
      return [
        {
          platform: this.id,
          action: "skip",
          path,
          detail: connector.server
            ? "server registration disabled for grok-cli"
            : "connector declares no MCP server",
        },
      ];
    }

    const symlink = this.symlinkPathWarning(path);
    if (symlink) return [symlink];

    // Shallow-merge any per-platform server override into the base ServerDef.
    const server: ServerDef =
      override && typeof override === "object"
        ? { ...connector.server, ...override }
        : connector.server;
    const entry = this.renderServerEntry(ctx, server);

    // OVERWRITE GUARD: never round-trip a present-but-unparseable file into `{}`.
    if (this.isPresentButUnparseable(path)) {
      return [
        {
          platform: this.id,
          action: "warn",
          path,
          detail: `existing ${path} is not parseable; left untouched (back it up / fix it, then re-run)`,
        },
      ];
    }
    const cfg = this.readJson<GrokUserSettings>(path) ?? {};

    // NEVER clobber a malformed mcp.servers: if `mcp` exists but is not an object,
    // or `mcp.servers` exists but is not an array, WARN + write nothing (leave the
    // user's hand-edited value) rather than silently replacing it.
    const existingMcp = cfg.mcp;
    if (existingMcp !== undefined && (typeof existingMcp !== "object" || Array.isArray(existingMcp))) {
      return [{ platform: this.id, action: "warn", path, detail: "mcp is not an object — left untouched (manual fix needed)" }];
    }
    const existingServers = existingMcp?.servers;
    if (existingServers !== undefined && !Array.isArray(existingServers)) {
      return [{ platform: this.id, action: "warn", path, detail: "mcp.servers is not an array — left untouched (manual fix needed)" }];
    }

    const list: GrokMcpServer[] = Array.isArray(existingServers) ? [...existingServers] : [];
    const idx = list.findIndex((e) => e?.id === connector.id);

    let action: ChangeRecord["action"];
    if (idx < 0) {
      list.push(entry);
      action = "create";
    } else if (JSON.stringify(list[idx]) === JSON.stringify(entry)) {
      action = "skip";
    } else {
      list[idx] = entry;
      action = "update";
    }

    if (action !== "skip") {
      cfg.mcp = { ...(existingMcp ?? {}), servers: list };
      this.writeJson(path, cfg, dryRun);
    }
    return [{ platform: this.id, action, path, detail: `mcp.servers[id=${connector.id}]` }];
  }

  uninstallServer(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    const path = this.getServerConfigPath(ctx);
    const symlink = this.symlinkPathWarning(path);
    if (symlink) return [symlink];

    const cfg = this.readJson<GrokUserSettings>(path);
    const rawList = cfg?.mcp?.servers;
    if (!cfg || !Array.isArray(rawList)) {
      return [{ platform: this.id, action: "skip", path, detail: `mcp.servers[id=${connector.id}] absent` }];
    }

    const list = rawList as GrokMcpServer[];
    const kept = list.filter((e) => e?.id !== connector.id);
    if (kept.length === list.length) {
      return [{ platform: this.id, action: "skip", path, detail: `mcp.servers[id=${connector.id}] absent` }];
    }

    cfg.mcp = { ...cfg.mcp, servers: kept };
    this.writeJson(path, cfg, dryRun);
    return [{ platform: this.id, action: "remove", path, detail: `mcp.servers[id=${connector.id}]` }];
  }

  /** Render a normalized ServerDef into Grok's native McpServerConfig entry. */
  private renderServerEntry(ctx: InstallContext, server: ServerDef): GrokMcpServer {
    const transport: Transport = server.transport;
    const enabled = server.enabled !== false;
    const id = ctx.connector.id;
    // `label` is a required display field; reuse the connector displayName.
    const label = ctx.connector.displayName?.trim() || id;

    if (transport === "stdio") {
      let command = server.command ?? "";
      let args = [...(server.args ?? [])];

      // Transparent telemetry wrapping: route the real command through
      // `<homeBin> serve --connector <id> -- <command> <args...>`.
      ({ command, args } = buildWrappedStdio(ctx, server, this.id, command, args));

      const entry: GrokMcpServer = {
        id,
        label,
        enabled,
        transport: "stdio",
        command: resolveEnvRefsDeep(command),
      };
      if (args.length > 0) entry.args = resolveEnvRefsDeep(args);
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      if (typeof server.cwd === "string" && server.cwd.length > 0) {
        entry.cwd = resolveEnvRefsDeep(server.cwd);
      }
      return entry;
    }

    // Remote (http / sse) — Grok registers a URL (+ optional headers). `ws` has no
    // Grok analog; fall back to http (the closest remote shape Grok validates).
    const entry: GrokMcpServer = {
      id,
      label,
      enabled,
      transport: transport === "sse" ? "sse" : "http",
      url: resolveEnvRefsDeep(server.url ?? ""),
    };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Grok documents no native ${VAR} server
   * interpolation, so resolve `${env:VAR}` references to literals at install
   * time (the safe path; matches continue/droid).
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Hook install / uninstall (top-level hooks, Claude nested-rule shape) ───

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    const override = connector.platforms[HOST];

    // `hooks: false` disables only the NORMALIZED hooks; nativeHooks is a
    // sibling grok-cli-scoped declaration that installs regardless.
    const normalizedEvents = override?.hooks === false ? [] : connector.hookEvents;
    const nativeHooks = override?.nativeHooks ?? {};
    const nativeEvents = Object.keys(nativeHooks);

    if (normalizedEvents.length === 0 && nativeEvents.length === 0) {
      return [
        {
          platform: this.id,
          action: "skip",
          detail:
            override?.hooks === false
              ? "hooks disabled for grok-cli"
              : "connector declares no hooks",
        },
      ];
    }

    const pending = normalizedEvents.map((event) => ({
      event: event as string,
      matcher: connector.hooks[event]?.matcher ?? "",
    }));
    const native = nativeEvents.map((event) => ({
      event,
      matcher: nativeHooks[event]?.matcher ?? "",
    }));

    return this.upsertHookEntries(
      ctx,
      this.getHookConfigPath(ctx),
      pending,
      this.hookDescriptor(ctx),
      native,
    );
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    return this.removeHookEntries(ctx, this.getHookConfigPath(ctx), this.hookDescriptor(ctx));
  }

  /**
   * Grok's hook-merge descriptor (NESTED shape `{ matcher?, hooks: [...] }`).
   * Connector-generic ownership (any of our home-bin commands in the inner
   * `hooks`), matching droid:
   *  - mapEvent drops events outside SUPPORTED_EVENTS (Grok has no
   *    PermissionRequest); supported events map 1:1 (PascalCase identical);
   *  - the native pass installs free-form host-only event keys verbatim;
   *  - uninstall = inner-strip ONLY (ownsEntryForRemove never-true).
   */
  private hookDescriptor(ctx: InstallContext): HookMergeDescriptor<GrokHookEntry> {
    const stripInner = (c: InstallContext) => (entry: GrokHookEntry) => {
      const innerBefore = entry.hooks?.length ?? 0;
      const inner = (entry.hooks ?? []).filter((h) => !this.isOurCommand(h.command, c));
      return {
        next: inner.length > 0 ? { matcher: entry.matcher ?? "", hooks: inner } : null,
        removed: innerBefore - inner.length,
      };
    };
    return {
      mapEvent: (e) => (SUPPORTED_EVENTS.has(e as HookEventName) ? e : undefined),
      unmappedWarnDetail: (e) => `${e} has no Grok CLI hook equivalent — skipped`,
      renderEntry: (_event, matcher, command) => ({
        matcher,
        hooks: [{ type: "command", command }],
      }),
      entryOwnsCommand: (entry, _command) =>
        (entry.hooks ?? []).some((h) => this.isOurCommand(h.command, ctx)),
      nativeOwnsCommand: (entry, command) =>
        (entry.hooks ?? []).some((h) => h.command === command),
      ownsEntryForRemove: () => () => false,
      stripInner,
      skipDetail: (event) => `hooks.${event} already registered`,
      removeDetail: (event, removed) => `hooks.${event} (${removed})`,
      nativeSkipDetail: (event) => `hooks.${event} already registered (native)`,
      nativeMutateDetail: (event) => `hooks.${event} (native)`,
      absentDetail: "no hooks section present",
      noMatchDetail: "no matching hook entries",
    };
  }

  /** True when a hook command references our home binary AND this connector id. */
  private isOurCommand(command: string | undefined, ctx: InstallContext): boolean {
    return isHomeBinHookCommand(command, ctx.homeBinPath, ctx.connector.id);
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const path = this.getServerConfigPath(ctx);
    const connectorId = ctx.connector.id;
    const homeBin = ctx.homeBinPath;
    const hookEvents = ctx.connector.hookEvents;
    return [
      {
        name: `${this.name}: user-settings.json present`,
        check: () =>
          existsSync(path)
            ? { status: "OK", detail: path }
            : { status: "FAIL", detail: `not found: ${path}` },
      },
      {
        name: `${this.name}: server entry registered`,
        check: () => {
          if (!ctx.connector.server) {
            return { status: "OK", detail: "no MCP server declared" };
          }
          const cfg = this.readJson<GrokUserSettings>(path);
          const list = cfg?.mcp?.servers;
          if (!cfg || !Array.isArray(list)) {
            return { status: "FAIL", detail: `no mcp.servers array in ${path}` };
          }
          return list.some((e) => e?.id === connectorId)
            ? { status: "OK", detail: `mcp.servers[id=${connectorId}] present` }
            : { status: "FAIL", detail: `no mcp.servers[id=${connectorId}] in ${path}` };
        },
      },
      {
        name: `${this.name}: hook command registered`,
        check: () => {
          if (hookEvents.length === 0) {
            return { status: "OK", detail: "no hooks declared" };
          }
          const cfg = this.readJson<GrokUserSettings>(path);
          const hooks = cfg?.hooks ?? {};
          const registered = Object.values(hooks).some((entries) =>
            (entries ?? []).some((e) =>
              (e.hooks ?? []).some((h) => isHomeBinHookCommand(h.command, homeBin, connectorId)),
            ),
          );
          return registered
            ? { status: "OK", detail: "hook command present" }
            : { status: "FAIL", detail: `no hook for ${connectorId} in ${path}` };
        },
      },
    ];
  }

  // ── Runtime: parse Grok stdin JSON → normalized event ──────────────────────

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as GrokWireInput;
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
          toolName: typeof input.tool_name === "string" ? input.tool_name : "",
          toolInput: input.tool_input ?? {},
        };
        return ev;
      }
      case "PostToolUse": {
        // Grok sends `tool_output` (NOT Claude's `tool_response`).
        const ev: PostToolUseEvent = {
          ...base,
          toolName: typeof input.tool_name === "string" ? input.tool_name : "",
          toolInput: input.tool_input ?? {},
          ...(toolOutputToString(input.tool_output) !== undefined
            ? { toolOutput: toolOutputToString(input.tool_output) }
            : {}),
        };
        return ev;
      }
      case "PostToolUseFailure": {
        const ev: PostToolUseFailureEvent = {
          ...base,
          toolName: typeof input.tool_name === "string" ? input.tool_name : "",
          toolInput: input.tool_input ?? {},
          error: typeof input.error === "string" ? input.error : "",
        };
        return ev;
      }
      case "UserPromptSubmit": {
        // Grok sends `user_prompt` (NOT Claude's `prompt`).
        const ev: UserPromptSubmitEvent = {
          ...base,
          prompt: typeof input.user_prompt === "string" ? input.user_prompt : "",
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
        const ev: SessionEndEvent = { ...base };
        return ev;
      }
      case "Stop": {
        const ev: StopEvent = { ...base };
        return ev;
      }
      case "Notification": {
        const ev: NotificationEvent = {
          ...base,
          message: typeof input.message === "string" ? input.message : "",
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
      case "PostCompact": {
        const ev: PostCompactEvent = {
          ...base,
          ...(input.trigger === "auto" || input.trigger === "manual"
            ? { trigger: input.trigger }
            : {}),
        };
        return ev;
      }
      case "SubagentStart": {
        const ev: SubagentStartEvent = {
          ...base,
          ...(typeof input.agent_type === "string" ? { agentType: input.agent_type } : {}),
        };
        return ev;
      }
      case "SubagentStop": {
        const ev: SubagentStopEvent = {
          ...base,
          ...(typeof input.agent_type === "string" ? { agentType: input.agent_type } : {}),
        };
        return ev;
      }
      default: {
        // Grok never delivers PermissionRequest (no native equivalent — see
        // SUPPORTED_EVENTS). Surface a dispatch of one loudly rather than
        // silently mis-parse.
        throw new Error(`unsupported grok-cli hook event: ${String(event)}`);
      }
    }
  }

  // ── Runtime: normalized response → Grok native hook reply ──────────────────
  // Grok parses stdout as JSON when it starts with `{` and aggregates:
  //   decision:"block" (or exit 2) → block; decision:"approve" → approve;
  //   additionalContext → injected context; continue:false + stopReason → halt.
  // We emit exit 0 + a structured stdout object so the JSON is always parsed.

  formatReply(_event: HookEventName, response: HookResponse): HookReply {
    const decision = response.decision ?? "allow";

    // deny → block the action with a reason (decision:"block").
    if (decision === "deny") {
      return this.stdout({ decision: "block", reason: response.reason ?? "Blocked by hook" });
    }

    // context → inject soft guidance (Grok honors additionalContext).
    if (decision === "context" && response.additionalContext) {
      return this.stdout({ additionalContext: response.additionalContext });
    }

    // allow / modify (unsupported) / ask (no Grok analog) / void → passthrough.
    return { exitCode: 0 };
  }

  private stdout(payload: unknown): HookReply {
    return { exitCode: 0, stdout: JSON.stringify(payload) };
  }
}

/** Coerce a Grok PostToolUse `tool_output` into a string for the normalized event. */
function toolOutputToString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const adapter = new GrokCliAdapter();
export default adapter;
