/**
 * adapters/devin — Devin CLI (Cognition) platform adapter for agent-connector.
 *
 * Devin CLI is a Rust binary (`devin`, installed via `curl cli.devin.ai/install.sh`
 * → symlinked at `~/.local/bin/devin`; XDG namespace `devin`). It is a
 * **json-stdio** host: it ships a FULL Claude-Code-compatible lifecycle hook
 * system alongside MCP server registration. Both surfaces live in ONE JSON
 * config file per scope:
 *
 *   - user scope    → ~/.config/devin/config.json
 *                     (%APPDATA%\devin\config.json on Windows)
 *   - project scope → <projectDir>/.devin/config.json
 *
 * MCP servers — root key `mcpServers` (object map keyed by server name; the
 * Claude-Desktop dialect). Native stdio entry { command, args?, env? } (NO
 * `type`/`disabled` discriminator); remote entry { url, transport?, headers?,
 * oauthClientId?, oauthClientSecret? } where transport is "http" (Streamable
 * HTTP, the URL default) or "sse" (legacy). Devin natively interpolates
 * `${env:VAR}` and `${file:/path}` in secret-bearing fields, so we PASS the
 * ${env:VAR} token THROUGH (nativeServerEnvInterpolation) rather than baking a
 * literal at install time. Primary source:
 * docs.devin.ai/cli/extensibility/mcp/configuration.
 *
 * Hooks — the `"hooks"` key IN the same config.json (root key `hooks`,
 * Claude NESTED-rule shape). Devin's hook format is documented as
 * "compatible with Claude Code hooks" — PascalCase event names, Claude
 * snake_case stdin wire fields. We deliberately write the `"hooks"` key in
 * config.json (a first-party-documented hook location whose object-map shape
 * fits the shared hook-merge engine exactly) rather than the alternative
 * standalone `.devin/hooks.v1.json` (whose event map is the WHOLE file with NO
 * `hooks` wrapper — incompatible with the engine's `file.hooks` contract). Both
 * are documented; config.json keeps us on the shared, Windows-safe engine with
 * zero hand-rolled file handling. Primary source:
 * docs.devin.ai/cli/extensibility/hooks/overview ("Where Hooks Live").
 *
 * Supported events (docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks):
 * PreToolUse, PostToolUse, PermissionRequest, UserPromptSubmit, Stop,
 * PostCompaction (canonical PostCompact), SessionStart, SessionEnd. Devin
 * exposes no Notification / PreCompact / SubagentStart / SubagentStop /
 * PostToolUseFailure, so those degrade to a warn/skip at install time.
 *
 * Reply protocol — Devin's stdout reply is the SIMPLE top-level
 * { "decision": "approve"|"block"|"deny", "reason" } form (NOT Claude's
 * `hookSpecificOutput.permissionDecision` envelope). exit 0 = success,
 * exit 2 = block. "block" denies a tool/stop with a reason; on PermissionRequest
 * "approve"/"deny" are the grant/refuse verbs. Devin documents no
 * output-rewrite or context-injection reply channel, so canModifyOutput /
 * canInjectSessionContext stay false. Primary source:
 * docs.devin.ai/cli/extensibility/hooks/overview ("Command Hooks" output +
 * "Exit Codes") + lifecycle-hooks (PermissionRequest / Stop examples).
 */

import { existsSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";

import { BaseAdapter, type HookMergeDescriptor } from "../base.js";
import type { Adapter, HookReply, InstallContext, MemoryTarget, NormalizedEvent } from "../spi.js";
import type {
  ChangeRecord,
  DetectedPlatform,
  HealthCheck,
  HookEventName,
  HookParadigm,
  HookResponse,
  PermissionRequestEvent,
  PlatformCapabilities,
  PlatformId,
  PostCompactEvent,
  PostToolUseEvent,
  PreToolUseEvent,
  ServerDef,
  SessionEndEvent,
  SessionStartEvent,
  SkillDef,
  StopEvent,
  Transport,
  UserPromptSubmitEvent,
} from "../../core/types.js";
import { rewriteEnvRefs } from "../../core/interpolate.js";
import {
  buildWrappedStdio,
  isHomeBinHookCommand,
} from "../../core/spawn.js";
import { normalizeSessionSource } from "../claude-code/wire.js";

const HOST: PlatformId = "devin";
const MCP_ROOT_KEY = "mcpServers";

/**
 * Resolve the Devin user config directory: ~/.config/devin (POSIX) or
 * %APPDATA%\devin (Windows). Mirrors the documented user-scope path in
 * docs.devin.ai/cli/extensibility/mcp/configuration.
 */
function devinUserConfigDir(): string {
  if (osPlatform() === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "devin");
  }
  return join(homedir(), ".config", "devin");
}

/**
 * Canonical events Devin actually fires. Devin's hook event names are
 * Claude-identical PascalCase, so each canonical name is registered directly
 * EXCEPT PostCompaction, which Devin spells "PostCompaction" on the wire while
 * agent-connector's canonical name is "PostCompact" — handled by the descriptor
 * mapEvent / parseEvent so the home binary still dispatches on the canonical
 * "PostCompact" command.
 */
const SUPPORTED_EVENTS: ReadonlySet<HookEventName> = new Set<HookEventName>([
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "UserPromptSubmit",
  "Stop",
  "PostCompact",
  "SessionStart",
  "SessionEnd",
]);

/** Devin's on-the-wire event name for the canonical PostCompact event. */
const DEVIN_POSTCOMPACT = "PostCompaction";

/**
 * Native MCP server entry shapes Devin accepts under `mcpServers`.
 * A stdio entry is { command, args?, env? } — no type/disabled discriminator;
 * remote transports register a URL with an optional `transport` ("http"|"sse").
 */
interface DevinStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
interface DevinHttpServer {
  url: string;
  transport?: "http" | "sse";
  headers?: Record<string, string>;
}

/** A single Devin native hook registration entry (Claude-shaped, nested). */
interface DevinHookEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string }>;
}

/** The shape of Devin's config.json hooks section (only the parts we touch). */
interface DevinHooksFile {
  hooks?: Record<string, DevinHookEntry[]>;
  [key: string]: unknown;
}

/** Raw Devin CLI hook stdin payload (Claude-compatible snake_case wire fields). */
interface DevinWireInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** PostToolUse — object { success, output, error }. */
  tool_response?: unknown;
  /** UserPromptSubmit — the user's message text. */
  prompt?: string;
  /** SessionStart — how the session was started. */
  source?: string;
  /** SessionEnd — why the session ended. */
  reason?: string;
  /** Stop loop guard. */
  stop_hook_active?: boolean;
  /** PostCompaction — compactor summary (may be null). Rides on raw; no normalized field. */
  summary?: unknown;
  /** Injected by the entrypoint so the runtime knows which connector to dispatch. */
  connector?: unknown;
  /** Session/cwd are not documented Devin wire fields; read defensively. */
  session_id?: string;
  cwd?: string;
}

export class DevinAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Devin CLI (Cognition)";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: AGENTS.md-first managed block — project <projectDir>/AGENTS.md
    // via the base default; user scope → ~/.config/devin/AGENTS.md (override below).
    // Devin reads AGENTS.md / AGENT.md / CLAUDE.md identically as always-on rules
    // (docs.devin.ai/cli/extensibility/rules).
    supportsMemory: true,
    preToolUse: true,
    postToolUse: true,
    userPromptSubmit: true,
    stop: true,
    sessionStart: true,
    sessionEnd: true,
    // PermissionRequest is a documented Devin hook event (decision-capable).
    permissionRequest: true,
    // PostCompaction (canonical PostCompact) — observe-only post-compaction hook.
    postCompact: true,
    // Devin documents NO Notification / PreCompact / SubagentStart / SubagentStop /
    // PostToolUseFailure event — those stay unset (install reports the skip-warn).
    notification: false,
    preCompact: false,
    // Devin's PreToolUse/PermissionRequest can block/deny via the simple
    // {decision} reply, but it documents no tool-arg/-output rewrite and no
    // context-injection reply channel.
    canModifyArgs: false,
    canModifyOutput: false,
    canInjectSessionContext: false,
    // Devin registers stdio and remote MCP servers. Remote is Streamable HTTP
    // ("http", the URL default) with a legacy "sse" fallback — both map to our
    // remote-transport handling; advertise both.
    transports: ["stdio", "http", "sse"],
    // Devin natively interpolates ${env:VAR} / ${file:/path} in secret-bearing
    // server fields, so the token survives into the host config (pass-through).
    nativeServerEnvInterpolation: true,
    // Content surfaces. Devin reads Agent Skills from its `.devin` config tree
    // at <configDir>/skills/<name>/SKILL.md — the SKILL.md format + frontmatter
    // are byte-confirmed (docs.devin.ai/cli/extensibility/skills/creating-skills),
    // so skills IS wired.
    supportsSkills: true,
    // Devin ALSO documents native slash commands (/cli/reference/commands) and
    // subagents (/cli/subagents), but their exact on-disk dir names are NOT
    // byte-confirmed from a first-party config reference — to avoid fabricating a
    // path, commands/subagents stay unset (BaseAdapter skip-warn) in v1. See the
    // module header CEILING note.
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = devinUserConfigDir();
    const userCfg = join(userDir, "config.json");
    const projDir = join(projectDir, ".devin");
    const projCfg = join(projDir, "config.json");
    // The installed binary symlink (~/.local/bin/devin) is a strong marker even
    // before any config file is written.
    const binMarker = join(homedir(), ".local", "bin", "devin");

    const userInstalled = existsSync(userDir) || existsSync(userCfg) || existsSync(binMarker);
    const projInstalled = existsSync(projDir) || existsSync(projCfg);
    const installed = userInstalled || projInstalled;
    const scope = projInstalled && !userInstalled ? "project" : "user";
    const configPath = scope === "project" ? projCfg : userCfg;

    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath,
      scope,
      reason: installed
        ? `found Devin CLI config (${scope}) at ${configPath}`
        : `no Devin CLI config at ${userDir} or ${projDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".devin")
      : devinUserConfigDir();
  }

  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "config.json");
  }

  /** Hooks live under the `"hooks"` key in the SAME config.json. */
  getHookConfigPath(ctx: InstallContext): string {
    return this.getServerConfigPath(ctx);
  }

  // ── Memory surface: user-scope AGENTS.md ─────────────────────────────────
  // Project scope rides on the AGENTS.md base default (project root). User scope
  // targets ~/.config/devin/AGENTS.md (%APPDATA%\devin\AGENTS.md on Windows) —
  // Devin's documented global-rules file (docs.devin.ai/cli/extensibility/rules).
  protected override memoryTargets(ctx: InstallContext): MemoryTarget[] {
    if (this.memoryOverride(ctx)?.path || ctx.scope !== "user") {
      return super.memoryTargets(ctx);
    }
    return [
      {
        path: join(devinUserConfigDir(), "AGENTS.md"),
        reason: "Devin CLI global rules file (~/.config/devin/AGENTS.md)",
      },
    ];
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
            ? "server registration disabled for devin"
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

  /** Render a normalized ServerDef into Devin's native mcpServers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): DevinStdioServer | DevinHttpServer {
    const transport: Transport = server.transport;

    if (transport === "stdio") {
      let command = server.command ?? "";
      let args = [...(server.args ?? [])];

      // Transparent telemetry wrapping: route the real command through
      // `<homeBin> serve --connector <id> -- <command> <args...>`.
      ({ command, args } = buildWrappedStdio(ctx, server, this.id, command, args));

      // command/args are passed verbatim (mirrors claude-code — they route
      // through the serve wrapper and rarely carry secrets).
      const entry: DevinStdioServer = { command };
      if (args.length > 0) entry.args = args;
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      return entry;
    }

    // http / sse (and any other remote transport) — Devin registers a URL.
    // Map our "http" transport to Streamable HTTP (the URL default) and "sse" to
    // legacy SSE; omit `transport` for the default-http case to keep the entry
    // minimal (Devin infers http from a URL). ${env:VAR} survives into the
    // config via Devin's native interpolation (rewriteEnvRefs/devinEnvToken).
    const entry: DevinHttpServer = {
      url: rewriteEnvRefs(server.url ?? "", devinEnvToken),
    };
    if (transport === "sse") entry.transport = "sse";
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Devin interpolates ${env:VAR} natively, so each
   * ${env:VAR} token is passed THROUGH (rewriteEnvRefs/devinEnvToken) rather
   * than baked to a literal — secrets never land in the committed config.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      out[k] = rewriteEnvRefs(v, devinEnvToken);
    }
    return out;
  }

  // ── Hook install / uninstall (config.json "hooks" key, nested-rule shape) ──

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.hooks === false) {
      return [{ platform: this.id, action: "skip", detail: "hooks disabled for devin" }];
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
   * Devin's hook-merge descriptor (NESTED shape `{ matcher, hooks: [...] }`).
   * Bound to `ctx` because Devin's ownership is CONNECTOR-GENERIC (ANY of our
   * commands in the entry's inner `hooks`):
   *  - mapEvent = drop events outside SUPPORTED_EVENTS; the canonical
   *    PostCompact is rewritten to Devin's on-wire "PostCompaction" key while
   *    all other supported events map 1:1.
   *  - entryOwnsCommand reuses isOurCommand over the inner commands.
   *  - uninstall = inner-strip ONLY (ownsEntryForRemove never-true).
   */
  private hookDescriptor(ctx: InstallContext): HookMergeDescriptor<DevinHookEntry> {
    return {
      mapEvent: (e) => {
        if (!SUPPORTED_EVENTS.has(e as HookEventName)) return undefined;
        return e === "PostCompact" ? DEVIN_POSTCOMPACT : e;
      },
      unmappedWarnDetail: (e) => `${e} has no Devin hook equivalent — skipped`,
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

  // ── Content surfaces: skills ──────────────────────────────────────────────
  // CEILING (v1): only the byte-confirmed SKILL.md layout is wired. Devin
  // documents the SKILL.md format + frontmatter
  // (docs.devin.ai/cli/extensibility/skills/creating-skills) under the `.devin`
  // tree (<configDir>/skills/<name>/SKILL.md). Commands/subagents on-disk dir
  // names are NOT byte-confirmed from a first-party config reference, so they
  // stay on the BaseAdapter skip-warn rather than guessing a path.

  /** Native skill dir: <configDir>/skills/<name>. */
  private skillDir(ctx: InstallContext, name: string): string {
    return join(this.getConfigDir(ctx), "skills", name);
  }

  override installSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.skills === false) {
      return [{ platform: this.id, action: "skip", detail: "skills disabled for devin" }];
    }
    if (connector.skills.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no skills" }];
    }
    const changes: ChangeRecord[] = [];
    for (const skill of connector.skills) {
      const dir = this.skillDir(ctx, skill.name);
      changes.push(
        this.writeContentFile(join(dir, "SKILL.md"), this.renderSkill(skill), ctx.dryRun),
      );
      // Bundle any resource files beside SKILL.md (relative path → contents).
      // Defense-in-depth: skip+warn on any key that escapes the skill dir.
      for (const [rel, contents] of Object.entries(skill.resources ?? {})) {
        const target = this.resolveWithin(dir, rel);
        if (target === null) {
          changes.push({
            platform: this.id,
            action: "warn",
            detail: `skill resource "${rel}" escapes the skill dir; skipped`,
          });
          continue;
        }
        changes.push(this.writeContentFile(target, contents, ctx.dryRun));
      }
    }
    return changes;
  }

  override uninstallSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.skills.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no skills" }];
    }
    const changes: ChangeRecord[] = [];
    for (const skill of connector.skills) {
      const dir = this.skillDir(ctx, skill.name);
      changes.push(this.removeContentFile(join(dir, "SKILL.md"), ctx.dryRun));
      for (const rel of Object.keys(skill.resources ?? {})) {
        const target = this.resolveWithin(dir, rel);
        if (target === null) continue; // never delete outside the skill dir
        changes.push(this.removeContentFile(target, ctx.dryRun));
      }
      // Only remove the skill dir when WE own its full contents.
      changes.push(this.removeDirIfEmpty(dir, ctx.dryRun));
    }
    return changes;
  }

  /**
   * Render a skill's SKILL.md: frontmatter (name, description) + body. Devin's
   * SKILL.md frontmatter documents name/description; extra keys pass through
   * verbatim. No model/allowed-tools skill field is emitted.
   */
  private renderSkill(skill: SkillDef): string {
    const frontmatter: Record<string, unknown> = {
      name: skill.name,
      description: skill.description,
    };
    if (skill.extra) Object.assign(frontmatter, skill.extra);
    return this.renderFrontmatterMd(frontmatter, skill.body);
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const cfgPath = this.getServerConfigPath(ctx);
    const connectorId = ctx.connector.id;
    const homeBin = ctx.homeBinPath;
    const hookEvents = ctx.connector.hookEvents;
    return [
      {
        name: `${this.name}: config.json present`,
        check: () =>
          existsSync(cfgPath)
            ? { status: "OK", detail: cfgPath }
            : { status: "FAIL", detail: `not found: ${cfgPath}` },
      },
      {
        name: `${this.name}: server entry registered`,
        check: () => {
          if (!ctx.connector.server) {
            return { status: "OK", detail: "no MCP server declared" };
          }
          const cfg = this.readJson<{ [k: string]: Record<string, unknown> }>(cfgPath);
          const bucket = cfg?.[MCP_ROOT_KEY];
          if (!cfg || !bucket) {
            return { status: "FAIL", detail: `no ${MCP_ROOT_KEY} in ${cfgPath}` };
          }
          return connectorId in bucket
            ? { status: "OK", detail: `${MCP_ROOT_KEY}.${connectorId} present` }
            : {
                status: "FAIL",
                detail: `no ${MCP_ROOT_KEY}.${connectorId} in ${cfgPath}`,
              };
        },
      },
      {
        name: `${this.name}: hook command registered`,
        check: () => {
          if (hookEvents.length === 0) {
            return { status: "OK", detail: "no hooks declared" };
          }
          const file = this.readJson<DevinHooksFile>(cfgPath);
          if (!file) return { status: "FAIL", detail: `cannot read ${cfgPath}` };
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
            : { status: "FAIL", detail: `no hook for ${connectorId} in ${cfgPath}` };
        },
      },
    ];
  }

  // ── Runtime: parse Devin stdin JSON → normalized event ─────────────────────

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as DevinWireInput;
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
      case "PermissionRequest": {
        // Devin PermissionRequest stdin: { tool_name, tool_input }. No
        // permission-suggestion entries are documented.
        const ev: PermissionRequestEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
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
      case "PostCompact": {
        // Devin's PostCompaction wire carries { summary } (no trigger enum);
        // summary rides on base.raw (no normalized field).
        const ev: PostCompactEvent = { ...base };
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
      default: {
        // Devin never delivers Notification / PreCompact / SubagentStart /
        // SubagentStop / PostToolUseFailure (see SUPPORTED_EVENTS). Surface it
        // loudly rather than silently mis-parse.
        throw new Error(`unsupported devin hook event: ${String(event)}`);
      }
    }
  }

  // ── Runtime: normalized response → Devin native (simple {decision}) reply ──

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    const decision = response.decision ?? "allow";

    // PostCompaction / SessionEnd are observe-only — no Decision Control. Every
    // decision is an unconditional no-op passthrough.
    if (event === "PostCompact" || event === "SessionEnd") {
      return { exitCode: 0 };
    }

    // PermissionRequest: an explicit allow is an active GRANT (Devin's "approve"
    // verb); deny refuses the tool. ask/context/void fall through to the native
    // dialog (exit 0, no decision output).
    if (event === "PermissionRequest") {
      if (decision === "deny") {
        return this.stdout({
          decision: "deny",
          reason: response.reason ?? "Denied by hook",
        });
      }
      if (decision === "allow") {
        return this.stdout({ decision: "approve" });
      }
      return { exitCode: 0 };
    }

    // deny → block the action with a reason (Devin's top-level {decision:"block"}
    // form, NOT Claude's hookSpecificOutput envelope). Covers PreToolUse and
    // Stop (Stop-block keeps the agent running with `reason` as guidance).
    if (decision === "deny") {
      return this.stdout({
        decision: "block",
        reason: response.reason ?? "Blocked by hook",
      });
    }

    // ask is not a distinct Devin reply verb (only approve/block/deny) — fall
    // through to allow. allow / modify (no rewrite channel) / context (no
    // injection channel) / void → pass through with exit 0.
    return { exitCode: 0 };
  }

  private stdout(payload: unknown): HookReply {
    return { exitCode: 0, stdout: JSON.stringify(payload) };
  }
}

/**
 * Devin's native interpolation token reconstructor. Devin reads the SAME
 * `${env:VAR}` (and `${env:VAR:-default}`) form the connector author writes, so
 * the rewrite is a faithful round-trip of the token (Devin resolves it at
 * runtime — the secret never lands in the committed config).
 */
function devinEnvToken(name: string, def?: string): string {
  return def !== undefined ? `\${env:${name}:-${def}}` : `\${env:${name}}`;
}

/** Coerce a Devin PostToolUse `tool_response` into a string for the normalized event. */
function toolResponseToString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const adapter = new DevinAdapter();
export default adapter;
