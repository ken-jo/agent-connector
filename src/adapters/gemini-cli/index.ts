/**
 * adapters/gemini-cli — Gemini CLI platform adapter for agent-connector.
 *
 * Gemini CLI (Google) is a json-stdio host: the host pipes a JSON payload to a
 * hook command on stdin and reads a JSON control object / exit code back — the
 * same paradigm as Claude Code. Two things make Gemini distinct, and both are
 * handled below:
 *
 *   1. TRANSPORT IS SELECTED BY KEY (not a `type` field). Under `mcpServers`, a
 *      stdio server is `{ command, args, env }`; an SSE server is `{ url }`; a
 *      streamable-HTTP server is `{ httpUrl }`. We render stdio with
 *      command/args/env and remote transports with the matching key.
 *   2. Gemini's hook EVENT VOCABULARY differs from the Claude-compatible hosts,
 *      so our normalized event names are mapped to Gemini's:
 *        PreToolUse  → BeforeTool
 *        PostToolUse → AfterTool
 *        PreCompact  → PreCompress
 *        SessionStart→ SessionStart
 *        UserPromptSubmit → BeforeAgent   (BeforeAgent fires on prompt submit;
 *                                          additionalContext is appended)
 *        SessionEnd  → SessionEnd
 *        Notification→ Notification
 *      `Stop` has no Gemini equivalent and is reported as a warn/skip at install.
 *
 * Native config (JSON):
 *   - MCP servers: user → ~/.gemini/settings.json; project → .gemini/settings.json
 *     (system scope is /etc/gemini-cli/settings.json — not a target we write).
 *     Root key "mcpServers".
 *   - Hooks: the SAME settings.json, top-level "hooks" key, keyed by the Gemini
 *     event name, each value an array of `{ matcher, hooks: [{ type:"command",
 *     command }] }` (the nested shape; Gemini accepts ONLY type "command").
 *   - Reply (stdout, exit 0):
 *       deny    → { decision:"deny", reason }
 *       modify  → { hookSpecificOutput:{ tool_input } }   (merged with original)
 *       context → { hookSpecificOutput:{ additionalContext } }
 *       PostToolUse output rewrite → { decision:"deny", reason:<newOutput> }
 *         (Gemini replaces tool output via a deny+reason on AfterTool).
 *       ask     → no native "ask"; degrade to deny to stay fail-safe.
 *
 * NOTE: Gemini's AfterModel hook payload carries `usageMetadata.totalTokenCount`
 * (per-LLM-call real token usage — the one host-native usage signal in the
 * matrix). This is the OPT-IN host-native usage enricher (4a): when host-native
 * capture is enabled (telemetry.hostNativeUsage, or AGENT_CONNECTOR_HOST_NATIVE=1
 * at install), installHooks ALSO writes an AfterModel hook whose command is the
 * hidden `<homeBin> usage-event gemini-cli --connector <id>` entrypoint. That
 * records a DISTINCT `model_turn` telemetry row (confidence host-native) covering
 * the whole conversation turn — never summed with the per-MCP `serve`-proxy rows.
 * AfterModel is NOT a normalized connector event (no handler dispatch); it is a
 * host-native-only sink. When the opt-in is OFF, the hook is NOT installed and
 * telemetry continues to flow only through the `serve` proxy.
 *
 * Env handling: Gemini's native settings interpolation token is `${VAR}`/`$VAR`,
 * not the framework's `${env:VAR}` syntax. Rather than depend on that, env /
 * header / url refs are resolved to literals at install time via
 * resolveEnvRefsDeep — the safe default for a host without `${env:VAR}` support
 * (matching the Codex / Copilot CLI adapters).
 *
 * Grounded in docs/research/understand-report.md §2 (Platform Integration
 * Matrix, "Gemini CLI" row) and context-mode's proven gemini-cli adapter.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { BaseAdapter } from "../base.js";
import type { Adapter, HookReply, InstallContext, NormalizedEvent } from "../spi.js";
import type {
  ChangeRecord,
  CommandDef,
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
  SkillDef,
  SubagentDef,
  Transport,
  UserPromptSubmitEvent,
} from "../../core/types.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import { writeTomlString } from "../../core/toml.js";
import {
  buildHomeBinHookCommand,
  buildServeWrapperCommand,
  buildUsageEventCommand,
  isHomeBinHookCommand,
  isHostNativeUsageEnabled,
  isUsageEventCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";

const HOST: PlatformId = "gemini-cli";
const MCP_ROOT_KEY = "mcpServers";

/**
 * Gemini-native hook event names (settings.json top-level `hooks` keys).
 * Only the events Gemini fires for the JSON-stdio command paradigm we use.
 */
const GEMINI_EVENT = {
  BeforeTool: "BeforeTool",
  AfterTool: "AfterTool",
  PreCompress: "PreCompress",
  SessionStart: "SessionStart",
  SessionEnd: "SessionEnd",
  BeforeAgent: "BeforeAgent",
  Notification: "Notification",
  /** Fires AFTER each model turn; payload carries `usageMetadata` (opt-in 4a). */
  AfterModel: "AfterModel",
} as const;

/**
 * Map our normalized event names to Gemini's native hook event names. Only the
 * events Gemini actually supports are present; `Stop` has no Gemini equivalent
 * and is reported as a warn/skip at install time.
 */
const EVENT_MAP: Partial<Record<HookEventName, string>> = {
  PreToolUse: GEMINI_EVENT.BeforeTool,
  PostToolUse: GEMINI_EVENT.AfterTool,
  PreCompact: GEMINI_EVENT.PreCompress,
  SessionStart: GEMINI_EVENT.SessionStart,
  SessionEnd: GEMINI_EVENT.SessionEnd,
  UserPromptSubmit: GEMINI_EVENT.BeforeAgent,
  Notification: GEMINI_EVENT.Notification,
};

/** A single Gemini native hook registration entry (nested, Claude-shaped). */
interface GeminiHookEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string }>;
}

/** The shape of Gemini's settings.json (only the parts we touch). */
interface GeminiSettingsFile {
  mcpServers?: Record<string, unknown>;
  hooks?: Record<string, GeminiHookEntry[]>;
  [key: string]: unknown;
}

/**
 * Native MCP server entry shapes Gemini accepts under `mcpServers`. Gemini
 * selects the transport by which key is present (NOT a `type` field):
 *   stdio          → command / args / env
 *   SSE            → url
 *   streamable-HTTP→ httpUrl
 */
interface GeminiStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}
interface GeminiSseServer {
  url: string;
  headers?: Record<string, string>;
}
interface GeminiHttpServer {
  httpUrl: string;
  headers?: Record<string, string>;
}

/** Raw Gemini CLI hook stdin payload (snake_case wire fields). */
interface GeminiWireInput {
  connector?: unknown;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  is_error?: boolean;
  session_id?: string;
  cwd?: string;
  source?: string;
  trigger?: string;
  reason?: string;
  prompt?: string;
  message?: string;
}

export class GeminiCliAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Gemini CLI";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    // Gemini fires Before/AfterTool, PreCompress, SessionStart/End, BeforeAgent
    // (≈ UserPromptSubmit), and Notification. It has no `Stop` equivalent.
    preToolUse: true,
    postToolUse: true,
    preCompact: true,
    sessionStart: true,
    sessionEnd: true,
    userPromptSubmit: true,
    stop: false,
    notification: true,
    // Newer events: Gemini has no subagent lifecycle hooks, its permission
    // surface is observe-only (Notification with notification_type
    // "ToolPermission" — no decision control), and tool failure is merged into
    // AfterTool's tool_response.error rather than a dedicated event. None of
    // those analogs are wired, so permissionRequest / postToolUseFailure /
    // subagentStart / subagentStop stay unset — install reports the standard
    // skip-warn for them.
    // BeforeTool can rewrite tool input (hookSpecificOutput.tool_input); unlike
    // the Claude-family hosts, AfterTool CAN replace already-emitted tool output
    // (via a deny + reason), so output modification is supported here.
    canModifyArgs: true,
    canModifyOutput: true,
    canInjectSessionContext: true,
    // Transport is selected by key: command/args (stdio), url (sse), httpUrl (http).
    transports: ["stdio", "sse", "http"],
    // Content surfaces: Gemini CLI supports all three. Commands are authored as
    // TOML (description + prompt with {{args}} placeholders); skills follow the
    // uniform <geminiDir>/skills/<name>/SKILL.md layout; subagents are md+fm.
    supportsCommands: true,
    supportsSkills: true,
    supportsSubagents: true,
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".gemini");
    const userSettings = join(userDir, "settings.json");
    const projectDirGemini = join(projectDir, ".gemini");
    const projectSettings = join(projectDirGemini, "settings.json");
    const userInstalled = existsSync(userDir) || existsSync(userSettings);
    const projInstalled = existsSync(projectDirGemini) || existsSync(projectSettings);
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
          ? `found project Gemini CLI config at ${projectSettings}`
          : `found Gemini CLI config under ${userDir}`
        : `no Gemini CLI config at ${userDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".gemini")
      : join(homedir(), ".gemini");
  }

  /** MCP servers live in settings.json under `mcpServers`. */
  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "settings.json");
  }

  /** Hooks live in the SAME settings.json under the top-level `hooks` key. */
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
            ? "server registration disabled for gemini-cli"
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
   * Render a normalized ServerDef into Gemini's native mcpServers entry. The
   * transport is encoded by WHICH KEY is present, not a `type` field.
   */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): GeminiStdioServer | GeminiSseServer | GeminiHttpServer {
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

      const entry: GeminiStdioServer = { command: resolveEnvRefsDeep(command) };
      if (args.length > 0) entry.args = args.map((a) => resolveEnvRefsDeep(a));
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      if (server.cwd) entry.cwd = resolveEnvRefsDeep(server.cwd);
      return entry;
    }

    // SSE transport → `url` key.
    if (transport === "sse") {
      const entry: GeminiSseServer = { url: resolveEnvRefsDeep(server.url ?? "") };
      const headers = this.renderEnv(server.headers);
      if (headers) entry.headers = headers;
      return entry;
    }

    // http (streamable-HTTP) and any other remote transport → `httpUrl` key.
    const entry: GeminiHttpServer = { httpUrl: resolveEnvRefsDeep(server.url ?? "") };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Gemini's native settings token is `${VAR}` (not
   * the framework's `${env:VAR}`), so refs resolve to literals at install time —
   * the safe default for a host without `${env:VAR}` interpolation.
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
      return [{ platform: this.id, action: "skip", detail: "hooks disabled for gemini-cli" }];
    }
    // The opt-in host-native usage hook (4a) is a host-native-only sink that does
    // NOT need a connector handler — so it may be installed even for a connector
    // that declares no normalized hook events.
    const hostNative = isHostNativeUsageEnabled(connector.telemetry);
    if (connector.hookEvents.length === 0 && !hostNative) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no hooks" }];
    }

    const settingsPath = this.getHookConfigPath(ctx);
    const settings = this.readJson<GeminiSettingsFile>(settingsPath) ?? {};
    const hooks = (settings.hooks ??= {});

    const changes: ChangeRecord[] = [];
    let mutated = false;

    for (const event of connector.hookEvents) {
      const geminiEvent = EVENT_MAP[event];
      if (!geminiEvent) {
        // No Gemini equivalent for this normalized event (e.g. Stop) — report.
        changes.push({
          platform: this.id,
          action: "warn",
          path: settingsPath,
          detail: `${event} has no Gemini CLI hook equivalent — skipped`,
        });
        continue;
      }

      const command = buildHomeBinHookCommand(ctx.homeBinPath, HOST, event, connector.id);
      const matcher = connector.hooks[event]?.matcher ?? "";
      const entry: GeminiHookEntry = {
        matcher,
        hooks: [{ type: "command", command }],
      };

      const bucket = (hooks[geminiEvent] ??= []);
      const existingIdx = bucket.findIndex((e) => this.entryHasOurCommand(e, ctx));

      if (existingIdx >= 0) {
        if (JSON.stringify(bucket[existingIdx]) === JSON.stringify(entry)) {
          changes.push({
            platform: this.id,
            action: "skip",
            path: settingsPath,
            detail: `hooks.${geminiEvent} already registered`,
          });
          continue;
        }
        bucket[existingIdx] = entry;
        changes.push({
          platform: this.id,
          action: "update",
          path: settingsPath,
          detail: `hooks.${geminiEvent}`,
        });
      } else {
        bucket.push(entry);
        changes.push({
          platform: this.id,
          action: "create",
          path: settingsPath,
          detail: `hooks.${geminiEvent}`,
        });
      }
      mutated = true;
    }

    // OPT-IN host-native usage hook (4a): when enabled, register an AfterModel
    // hook whose command is the hidden `usage-event` entrypoint. It carries no
    // matcher (it is not a tool event) and records a DISTINCT `model_turn` row.
    if (hostNative) {
      if (this.installUsageHook(hooks, ctx, settingsPath, changes)) mutated = true;
    }

    if (mutated) this.writeJson(settingsPath, settings, ctx.dryRun);
    return changes;
  }

  /**
   * Register the opt-in AfterModel host-native usage hook (4a) into `hooks`.
   * Idempotent: a byte-identical entry skips, a drifted one updates. Returns true
   * when the file was mutated. The command is the hidden `usage-event` entrypoint
   * (NOT a connector hook), so it carries an empty matcher.
   */
  private installUsageHook(
    hooks: Record<string, GeminiHookEntry[]>,
    ctx: InstallContext,
    settingsPath: string,
    changes: ChangeRecord[],
  ): boolean {
    const command = buildUsageEventCommand(ctx.homeBinPath, HOST, ctx.connector.id);
    const entry: GeminiHookEntry = {
      matcher: "",
      hooks: [{ type: "command", command }],
    };
    const bucket = (hooks[GEMINI_EVENT.AfterModel] ??= []);
    const existingIdx = bucket.findIndex((e) =>
      (e.hooks ?? []).some((h) => isUsageEventCommand(h.command, ctx.homeBinPath, ctx.connector.id)),
    );

    if (existingIdx >= 0) {
      if (JSON.stringify(bucket[existingIdx]) === JSON.stringify(entry)) {
        changes.push({
          platform: this.id,
          action: "skip",
          path: settingsPath,
          detail: `hooks.${GEMINI_EVENT.AfterModel} (host-native usage) already registered`,
        });
        return false;
      }
      bucket[existingIdx] = entry;
      changes.push({
        platform: this.id,
        action: "update",
        path: settingsPath,
        detail: `hooks.${GEMINI_EVENT.AfterModel} (host-native usage)`,
      });
    } else {
      bucket.push(entry);
      changes.push({
        platform: this.id,
        action: "create",
        path: settingsPath,
        detail: `hooks.${GEMINI_EVENT.AfterModel} (host-native usage)`,
      });
    }
    return true;
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const settingsPath = this.getHookConfigPath(ctx);
    const settings = this.readJson<GeminiSettingsFile>(settingsPath);
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

    for (const geminiEvent of Object.keys(hooks)) {
      const bucket = hooks[geminiEvent];
      if (!Array.isArray(bucket)) continue;

      // Strip our hook command from each entry; drop entries left empty so we
      // never remove another connector's (or the user's own) hook commands.
      const next: GeminiHookEntry[] = [];
      let removed = 0;
      for (const e of bucket) {
        const innerBefore = e.hooks?.length ?? 0;
        const inner = (e.hooks ?? []).filter((h) => !this.isOurCommand(h.command, ctx));
        removed += innerBefore - inner.length;
        if (inner.length > 0) next.push({ matcher: e.matcher ?? "", hooks: inner });
      }

      if (removed > 0) {
        if (next.length > 0) hooks[geminiEvent] = next;
        else delete hooks[geminiEvent];
        changes.push({
          platform: this.id,
          action: "remove",
          path: settingsPath,
          detail: `hooks.${geminiEvent} (${removed})`,
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

  private entryHasOurCommand(entry: GeminiHookEntry, ctx: InstallContext): boolean {
    return (entry.hooks ?? []).some((h) => this.isOurCommand(h.command, ctx));
  }

  /**
   * True when a hook command is ONE OF OURS for this connector — either the
   * universal `hook` dispatcher OR the opt-in `usage-event` sink. Both are
   * anchored on the connector id (see isHomeBinHookCommand) so a shared-prefix id
   * can't collide, and so uninstall reverses the AfterModel usage hook too.
   */
  private isOurCommand(command: string | undefined, ctx: InstallContext): boolean {
    return (
      isHomeBinHookCommand(command, ctx.homeBinPath, ctx.connector.id) ||
      isUsageEventCommand(command, ctx.homeBinPath, ctx.connector.id)
    );
  }

  // ── Content surfaces: commands / skills / subagents ──────────────────────
  // CONTENT-ONLY: pure native-file writers under <geminiDir>/{commands,skills,
  // agents}. No runtime dispatch, no home-bin pointer, no telemetry wrap. Each
  // method is idempotent (byte-identical → skip) via BaseAdapter.writeContentFile
  // and reversible via removeContentFile. Honors platforms["gemini-cli"]
  // per-surface false to skip. Commands are TOML (Gemini's native format, with
  // {{args}} placeholders preserved verbatim); skills/subagents mirror the
  // Claude reference (uniform SKILL.md + md+frontmatter subagents).

  private commandsDir(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "commands");
  }
  private skillsDir(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "skills");
  }
  private agentsDir(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "agents");
  }

  /** Native command file path: <geminiDir>/commands/<name>.toml. */
  private commandPath(ctx: InstallContext, name: string): string {
    return join(this.commandsDir(ctx), `${name}.toml`);
  }
  /** Native skill dir: <geminiDir>/skills/<name>. */
  private skillDir(ctx: InstallContext, name: string): string {
    return join(this.skillsDir(ctx), name);
  }
  /** Native subagent file path: <geminiDir>/agents/<name>.md. */
  private subagentPath(ctx: InstallContext, name: string): string {
    return join(this.agentsDir(ctx), `${name}.md`);
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  override installCommands(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.commands === false) {
      return [{ platform: this.id, action: "skip", detail: "commands disabled for gemini-cli" }];
    }
    if (connector.commands.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no commands" }];
    }
    return connector.commands.map((cmd) =>
      this.writeContentFile(this.commandPath(ctx, cmd.name), this.renderCommand(cmd), ctx.dryRun),
    );
  }

  override uninstallCommands(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.commands.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no commands" }];
    }
    return connector.commands.map((cmd) =>
      this.removeContentFile(this.commandPath(ctx, cmd.name), ctx.dryRun),
    );
  }

  /**
   * Render a command to Gemini's native TOML: { description, prompt }. Gemini
   * uses `{{args}}` placeholders in the prompt; the prompt body is passed
   * through verbatim so any placeholders are preserved.
   */
  private renderCommand(cmd: CommandDef): string {
    const obj: Record<string, unknown> = {};
    if (cmd.description !== undefined) obj.description = cmd.description;
    obj.prompt = cmd.prompt;
    return writeTomlString(obj);
  }

  // ── Skills ────────────────────────────────────────────────────────────────

  override installSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.skills === false) {
      return [{ platform: this.id, action: "skip", detail: "skills disabled for gemini-cli" }];
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
      // Defense-in-depth: skip+warn on any key that escapes the skill dir
      // (config-time validation already rejects these, but never trust input).
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
      // Remove only the files we wrote (SKILL.md + declared resources), then the
      // skill dir itself when we own its full contents.
      changes.push(this.removeContentFile(join(dir, "SKILL.md"), ctx.dryRun));
      for (const rel of Object.keys(skill.resources ?? {})) {
        const target = this.resolveWithin(dir, rel);
        if (target === null) continue; // never delete outside the skill dir
        changes.push(this.removeContentFile(target, ctx.dryRun));
      }
      // Only remove the skill dir when WE own its full contents — never rm -rf a
      // dir that still holds user-added / sibling-tool / shared files.
      changes.push(this.removeDirIfEmpty(dir, ctx.dryRun));
    }
    return changes;
  }

  /**
   * Render a skill's SKILL.md: frontmatter (name, description + optional model,
   * allowed-tools, disable-model-invocation) + body. Uniform across platforms.
   */
  private renderSkill(skill: SkillDef): string {
    const frontmatter: Record<string, unknown> = {
      name: skill.name,
      description: skill.description,
    };
    if (skill.model !== undefined) frontmatter.model = skill.model;
    const allow = skill.tools?.allow;
    if (allow && allow.length > 0) frontmatter["allowed-tools"] = allow.join(", ");
    if (skill.disableModelInvocation !== undefined) {
      frontmatter["disable-model-invocation"] = skill.disableModelInvocation;
    }
    if (skill.extra) Object.assign(frontmatter, skill.extra);
    return this.renderFrontmatterMd(frontmatter, skill.body);
  }

  // ── Subagents ───────────────────────────────────────────────────────────────

  override installSubagents(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.subagents === false) {
      return [{ platform: this.id, action: "skip", detail: "subagents disabled for gemini-cli" }];
    }
    if (connector.subagents.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no subagents" }];
    }
    return connector.subagents.map((agent) =>
      this.writeContentFile(this.subagentPath(ctx, agent.name), this.renderSubagent(agent), ctx.dryRun),
    );
  }

  override uninstallSubagents(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.subagents.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no subagents" }];
    }
    return connector.subagents.map((agent) =>
      this.removeContentFile(this.subagentPath(ctx, agent.name), ctx.dryRun),
    );
  }

  /** Render a subagent to md+frontmatter (name, description, tools, model) + prompt body. */
  private renderSubagent(agent: SubagentDef): string {
    const frontmatter: Record<string, unknown> = {
      name: agent.name,
      description: agent.description,
    };
    const allow = agent.tools?.allow;
    if (allow && allow.length > 0) frontmatter.tools = allow.join(", ");
    if (agent.model !== undefined) frontmatter.model = agent.model;
    if (agent.extra) Object.assign(frontmatter, agent.extra);
    return this.renderFrontmatterMd(frontmatter, agent.prompt);
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const settingsPath = this.getServerConfigPath(ctx);
    const connectorId = ctx.connector.id;
    const homeBin = ctx.homeBinPath;
    const hookEvents = ctx.connector.hookEvents;
    const checks: HealthCheck[] = [
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
          const settings = this.readJson<GeminiSettingsFile>(settingsPath);
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

    // Content-surface checks: only assert presence of the files this connector
    // declares (skip silently for surfaces it never asked for).
    for (const cmd of ctx.connector.commands) {
      const p = this.commandPath(ctx, cmd.name);
      checks.push({
        name: `${this.name}: command ${cmd.name} present`,
        check: () =>
          existsSync(p) ? { status: "OK", detail: p } : { status: "FAIL", detail: `not found: ${p}` },
      });
    }
    for (const skill of ctx.connector.skills) {
      const p = join(this.skillDir(ctx, skill.name), "SKILL.md");
      checks.push({
        name: `${this.name}: skill ${skill.name} present`,
        check: () =>
          existsSync(p) ? { status: "OK", detail: p } : { status: "FAIL", detail: `not found: ${p}` },
      });
    }
    for (const agent of ctx.connector.subagents) {
      const p = this.subagentPath(ctx, agent.name);
      checks.push({
        name: `${this.name}: subagent ${agent.name} present`,
        check: () =>
          existsSync(p) ? { status: "OK", detail: p } : { status: "FAIL", detail: `not found: ${p}` },
      });
    }
    return checks;
  }

  // ── Runtime: parse Gemini stdin JSON → normalized event ──────────────────

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as GeminiWireInput;
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
          ...(input.tool_output !== undefined ? { toolOutput: input.tool_output } : {}),
          ...(input.is_error === true ? { isError: true } : {}),
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
      case "Notification": {
        const ev: NotificationEvent = {
          ...base,
          message: typeof input.message === "string" ? input.message : "",
        };
        return ev;
      }
      default: {
        // Gemini never delivers `Stop`, `PermissionRequest`, `PostToolUseFailure`,
        // `SubagentStart`, or `SubagentStop` (no native equivalents wired). If
        // the runtime dispatches one anyway, surface it as an explicit
        // unsupported error so the mismatch is loud rather than silently
        // mis-parsed.
        throw new Error(`unsupported gemini-cli hook event: ${String(event)}`);
      }
    }
  }

  // ── Runtime: normalized response → Gemini native hook reply ──────────────

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    const decision = response.decision ?? "allow";

    // deny → Gemini blocks via a top-level `decision:"deny"` + reason (NOT the
    // Claude-style permissionDecision wrapper).
    if (decision === "deny") {
      return this.stdout({
        decision: "deny",
        reason: response.reason ?? "Blocked by hook",
      });
    }

    // ask → Gemini has no native "ask"; degrade to deny to stay fail-safe.
    if (decision === "ask") {
      return this.stdout({
        decision: "deny",
        reason: response.reason ?? "Action requires user confirmation (security policy)",
      });
    }

    // modify → rewrite BeforeTool input. Gemini merges tool_input with the
    // original; output rewrite on AfterTool is expressed as deny + reason.
    if (decision === "modify") {
      if (event === "PreToolUse" && response.updatedInput) {
        return this.stdout({
          hookSpecificOutput: { tool_input: response.updatedInput },
        });
      }
      if (event === "PostToolUse" && response.updatedOutput !== undefined) {
        return this.stdout({ decision: "deny", reason: response.updatedOutput });
      }
      // Nothing to apply; fall through to allow.
    }

    // context → inject soft guidance via hookSpecificOutput.additionalContext
    // (also the SessionStart / BeforeAgent context-injection path).
    if (decision === "context" && response.additionalContext) {
      return this.stdout({
        hookSpecificOutput: { additionalContext: response.additionalContext },
      });
    }

    // allow / void / unsupported-degradation → pass through with exit 0.
    return { exitCode: 0 };
  }

  private stdout(payload: unknown): HookReply {
    return { exitCode: 0, stdout: JSON.stringify(payload) };
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

export const adapter = new GeminiCliAdapter();
export default adapter;
