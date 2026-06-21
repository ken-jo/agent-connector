/**
 * adapters/codebuddy — Tencent CodeBuddy Code platform adapter for agent-connector.
 *
 * CodeBuddy Code (`@tencent-ai/codebuddy-code`, bin `codebuddy`) is Tencent's
 * terminal AI assistant and a CLOSE Claude Code fork: same json-stdio hook
 * paradigm, same hook event names, same snake_case stdin fields, and the same
 * `hookSpecificOutput` reply envelope — so it reuses claude-code's wire module
 * (parseEvent/formatReply contract) verbatim. The fork rebrands every storage
 * path from `.claude*` to `.codebuddy*`:
 *   - MCP servers: user scope → `~/.codebuddy.json` ("mcpServers"); project
 *     scope → `<projectDir>/.mcp.json` ("mcpServers").
 *   - Hooks: `<configDir>/settings.json` under "hooks", keyed by event name,
 *     each value an array of { matcher, hooks:[{ type:"command", command }] }.
 *   - Config dir: `~/.codebuddy` (override `$CODEBUDDY_CONFIG_DIR`); project
 *     `<projectDir>/.codebuddy`. Content surfaces live under
 *     `<configDir>/{commands,skills,agents}`.
 *   - Memory: `CODEBUDDY.md` (the fork renames CLAUDE.md; it does NOT read
 *     AGENTS.md by default — verified against the v2.109.0 bundle, which lists
 *     `.codebuddy/settings*.json`, `CODEBUDDY.md`, `CODEBUDDY.local.md`,
 *     `.codebuddy.json`, `.codebuddy/rules/`, `.codebuddy/hooks`).
 *   - Reply: a `hookSpecificOutput` object (permissionDecision allow|deny|ask +
 *     reason, additionalContext, updatedInput) on stdout with exit 0; Stop-class
 *     blocks use the top-level {"decision":"block","reason"} — identical to
 *     Claude Code.
 *
 * Every fact above is BYTE-CONFIRMED against the official npm bundle
 * `@tencent-ai/codebuddy-code@2.109.0` (dist/codebuddy.js): bin `codebuddy`,
 * `.codebuddy.json`/`.mcp.json` + root key `mcpServers`, `.codebuddy/settings.json`
 * hooks, the 13 Claude hook event names, the snake_case stdin fields, and the
 * `hookSpecificOutput`/`permissionDecision` reply shape. CodeBuddy needs Tencent
 * auth, so this is NOT live-verifiable locally — placement + byte-oracle ceiling.
 *
 * SCOPE: the byte-confirmed core surfaces (MCP stdio+http, the 13 normalized
 * hooks + nativeHooks passthrough, commands/skills/subagents, CODEBUDDY.md
 * memory). The claude-code-v1-only surfaces (configPatch sensitive-key denylist,
 * statusLine wiring, the agents-import bridge) are NOT ported — their CodeBuddy
 * behavior is not byte-confirmed, and the instruction is to enable only
 * byte-confirmed flags.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { BaseAdapter, type HookMergeDescriptor } from "../base.js";
import type { Adapter, HookReply, InstallContext, MemoryTarget, NormalizedEvent } from "../spi.js";
import type {
  ChangeRecord,
  CommandDef,
  DetectedPlatform,
  HealthCheck,
  HookEventName,
  HookParadigm,
  HookResponse,
  NotificationEvent,
  PermissionRequestEvent,
  PlatformCapabilities,
  PlatformId,
  PostCompactEvent,
  PostToolUseEvent,
  PostToolUseFailureEvent,
  PreCompactEvent,
  PreToolUseEvent,
  SessionEndEvent,
  SessionStartEvent,
  ServerDef,
  SkillDef,
  StopEvent,
  SubagentDef,
  SubagentStartEvent,
  SubagentStopEvent,
  Transport,
  UserPromptSubmitEvent,
} from "../../core/types.js";
import { resolveEnvRefsDeep, rewriteEnvRefs } from "../../core/interpolate.js";
import { buildWrappedStdio, isHomeBinHookCommand } from "../../core/spawn.js";
import {
  type ClaudeHookEvent,
  type ClaudeWireInput,
  extractSessionId,
  normalizeSessionSource,
  toolResponseToString,
} from "../claude-code/wire.js";
import { renderCommandMd, renderSkillMd, renderSubagentMd } from "../claude-code/render.js";

const HOST: PlatformId = "codebuddy";
const MCP_ROOT_KEY = "mcpServers";

/** The config-dir env override CodeBuddy honors (verified in the bundle). */
const CONFIG_DIR_ENV = "CODEBUDDY_CONFIG_DIR";

/** A single hook registration entry as CodeBuddy stores it in settings.json. */
interface CodeBuddyHookEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string }>;
}

/** Native MCP server entry shapes CodeBuddy accepts under `mcpServers`. */
interface CodeBuddyStdioServer {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}
interface CodeBuddyHttpServer {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

export class CodeBuddyAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "CodeBuddy";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    // CodeBuddy ships the full Claude hook set (bundle-confirmed event names).
    preToolUse: true,
    postToolUse: true,
    preCompact: true,
    sessionStart: true,
    sessionEnd: true,
    userPromptSubmit: true,
    stop: true,
    notification: true,
    permissionRequest: true,
    postToolUseFailure: true,
    subagentStart: true,
    subagentStop: true,
    // Claude-fork reply envelope: PreToolUse can rewrite input (updatedInput);
    // a PostToolUse hook cannot rewrite already-emitted output.
    canModifyArgs: true,
    canModifyOutput: false,
    canInjectSessionContext: true,
    // settings.json hook keys are free-form event names, so any host event
    // declared under platforms["codebuddy"].nativeHooks installs verbatim.
    supportsNativeHooks: true,
    transports: ["stdio", "http"],
    // CodeBuddy preserves Claude's native ${VAR} interpolation in mcpServers
    // env/url, so secret-bearing fields survive into the config (never baked).
    nativeServerEnvInterpolation: true,
    // Content surfaces under <configDir>/{commands,skills,agents}.
    supportsCommands: true,
    supportsSkills: true,
    supportsSubagents: true,
    // Memory surface — EXCEPTION host: CodeBuddy reads CODEBUDDY.md (the fork's
    // CLAUDE.md rename), NOT AGENTS.md, so memoryTargets below overrides the base
    // AGENTS.md-first default.
    supportsMemory: true,
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = this.userConfigDir();
    const userSettings = join(userDir, "settings.json");
    const userServers = join(homedir(), ".codebuddy.json");
    const projectServers = join(projectDir, ".mcp.json");
    const userInstalled =
      existsSync(userDir) || existsSync(userSettings) || existsSync(userServers);
    const projInstalled = existsSync(projectServers);
    const installed = userInstalled || projInstalled;
    const scope = projInstalled && !userInstalled ? "project" : "user";
    const configPath = scope === "project" ? projectServers : userSettings;
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
          ? `found project CodeBuddy config at ${projectServers}`
          : `found CodeBuddy config under ${userDir}`
        : `no CodeBuddy config at ${userDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  /** User config dir: `$CODEBUDDY_CONFIG_DIR` || `~/.codebuddy`. */
  private userConfigDir(): string {
    const override = process.env[CONFIG_DIR_ENV];
    return override && override.trim() !== "" ? override : join(homedir(), ".codebuddy");
  }

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".codebuddy")
      : this.userConfigDir();
  }

  getServerConfigPath(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".mcp.json")
      : join(homedir(), ".codebuddy.json");
  }

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
            ? "server registration disabled for codebuddy"
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

  /** Render a normalized ServerDef into CodeBuddy's native mcpServers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): CodeBuddyStdioServer | CodeBuddyHttpServer {
    const transport: Transport = server.transport;

    if (transport === "stdio") {
      let command = server.command ?? "";
      let args = [...(server.args ?? [])];

      // Transparent telemetry wrapping: route the real command through
      // `<homeBin> serve --connector <id> -- <command> <args...>`.
      ({ command, args } = buildWrappedStdio(ctx, server, this.id, command, args));

      const entry: CodeBuddyStdioServer = { type: "stdio", command, args };
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      if (server.cwd) entry.cwd = resolveEnvRefsDeep(server.cwd);
      return entry;
    }

    // http (and any other remote transport we surface) — register a URL.
    const entry: CodeBuddyHttpServer = {
      type: "http",
      url: rewriteEnvRefs(server.url ?? "", codebuddyEnvToken),
    };
    if (server.headers) {
      entry.headers = this.renderEnv(server.headers) ?? {};
    }
    return entry;
  }

  /**
   * Render env/header values using CodeBuddy's native `${VAR}` interpolation
   * (inherited from Claude Code), so `${env:VAR}` refs survive into the config
   * rather than baking a secret. Literals pass through unchanged.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      out[k] = rewriteEnvRefs(v, codebuddyEnvToken);
    }
    return out;
  }

  // ── Hook install / uninstall ─────────────────────────────────────────────

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    const override = connector.platforms[HOST];

    // `hooks: false` disables only the NORMALIZED hooks; nativeHooks is a
    // sibling declaration that installs regardless.
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
              ? "hooks disabled for codebuddy"
              : "connector declares no hooks",
        },
      ];
    }

    const settingsPath = this.getHookConfigPath(ctx);

    const pending: Array<{ event: string; matcher: string }> = [
      ...normalizedEvents.map((event) => ({
        event: event as string,
        matcher: connector.hooks[event]?.matcher ?? "",
      })),
      ...nativeEvents.map((event) => ({
        event,
        matcher: nativeHooks[event]?.matcher ?? "",
      })),
    ];

    return this.upsertHookEntries(ctx, settingsPath, pending, this.hookDescriptor());
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    return this.removeHookEntries(ctx, this.getHookConfigPath(ctx), this.hookDescriptor());
  }

  /**
   * CodeBuddy's hook-merge descriptor — the Claude NESTED shape
   * `{ matcher, hooks: [...] }`: install find = THIS command present in the
   * entry's inner `hooks`; uninstall is inner-strip only (drop entries left
   * empty); never remove a whole entry by ownership.
   */
  private hookDescriptor(): HookMergeDescriptor<CodeBuddyHookEntry> {
    return {
      renderEntry: (_event, matcher, command) => ({
        matcher,
        hooks: [{ type: "command", command }],
      }),
      entryOwnsCommand: (entry, command) =>
        (entry.hooks ?? []).some((h) => h.command === command),
      ownsEntryForRemove: () => () => false,
      stripInner: (ctx) => (entry) => {
        const innerBefore = entry.hooks?.length ?? 0;
        const inner = (entry.hooks ?? []).filter((h) => !this.isOurCommand(h.command, ctx));
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

  /** True when a hook command references our home binary AND this connector id. */
  private isOurCommand(command: string | undefined, ctx: InstallContext): boolean {
    return isHomeBinHookCommand(command, ctx.homeBinPath, ctx.connector.id);
  }

  // ── Content surfaces: commands / skills / subagents ──────────────────────
  // Pure native-file writers under <configDir>/{commands,skills,agents}, the
  // fork's confirmed surface dirs. Idempotent (byte-identical → skip) and
  // reversible. Honors platforms["codebuddy"] per-surface `false` to skip.

  private commandsDir(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "commands");
  }
  private skillsDir(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "skills");
  }
  private agentsDir(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "agents");
  }

  private commandPath(ctx: InstallContext, name: string): string {
    return join(this.commandsDir(ctx), `${name}.md`);
  }
  private skillDir(ctx: InstallContext, name: string): string {
    return join(this.skillsDir(ctx), name);
  }
  private subagentPath(ctx: InstallContext, name: string): string {
    return join(this.agentsDir(ctx), `${name}.md`);
  }

  override installCommands(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.commands === false) {
      return [{ platform: this.id, action: "skip", detail: "commands disabled for codebuddy" }];
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

  private renderCommand(cmd: CommandDef): string {
    return renderCommandMd(cmd);
  }

  override installSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.skills === false) {
      return [{ platform: this.id, action: "skip", detail: "skills disabled for codebuddy" }];
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
        if (target === null) continue;
        changes.push(this.removeContentFile(target, ctx.dryRun));
      }
      changes.push(this.removeDirIfEmpty(dir, ctx.dryRun));
    }
    return changes;
  }

  private renderSkill(skill: SkillDef): string {
    return renderSkillMd(skill);
  }

  override installSubagents(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.subagents === false) {
      return [{ platform: this.id, action: "skip", detail: "subagents disabled for codebuddy" }];
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

  private renderSubagent(agent: SubagentDef): string {
    return renderSubagentMd(agent);
  }

  // ── Memory surface: CODEBUDDY.md managed block ────────────────────────────
  // EXCEPTION host. CodeBuddy reads CODEBUDDY.md (the fork's CLAUDE.md rename),
  // NOT AGENTS.md (bundle-confirmed path list), so the base AGENTS.md-first
  // default is overridden. HTML-comment markers are correct here for the same
  // reason as Claude Code (comment-stripped before context injection). Unlike
  // claude-code this adapter does NOT ship the opt-in agents-import bridge —
  // only the canonical block in the host's own memory file.

  private memoryFilePath(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, "CODEBUDDY.md")
      : join(this.userConfigDir(), "CODEBUDDY.md");
  }

  protected override memoryTargets(ctx: InstallContext): MemoryTarget[] {
    // An explicit path override keeps the base resolution (escape hatch wins).
    if (this.memoryOverride(ctx)?.path) return super.memoryTargets(ctx);
    if (ctx.scope !== "project" && ctx.scope !== "user") return [];
    return [
      {
        path: this.memoryFilePath(ctx),
        reason:
          "CODEBUDDY.md (CodeBuddy reads CODEBUDDY.md, not AGENTS.md; " +
          "HTML-comment markers are stripped from the model's context)",
      },
    ];
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const settingsPath = this.getHookConfigPath(ctx);
    const connectorId = ctx.connector.id;
    const homeBin = ctx.homeBinPath;
    const declaredHookCount =
      ctx.connector.hookEvents.length +
      Object.keys(ctx.connector.platforms[HOST]?.nativeHooks ?? {}).length;
    const checks: HealthCheck[] = [
      {
        name: `${this.name}: settings.json present`,
        check: () => {
          if (declaredHookCount === 0) {
            return { status: "OK", detail: "no hooks declared" };
          }
          return existsSync(settingsPath)
            ? { status: "OK", detail: settingsPath }
            : { status: "FAIL", detail: `not found: ${settingsPath}` };
        },
      },
      {
        name: `${this.name}: hook command registered`,
        check: () => {
          if (declaredHookCount === 0) {
            return { status: "OK", detail: "no hooks declared" };
          }
          const settings = this.readJson<{ hooks?: Record<string, CodeBuddyHookEntry[]> }>(
            settingsPath,
          );
          if (!settings) return { status: "FAIL", detail: `cannot read ${settingsPath}` };
          const hooks = settings.hooks ?? {};
          const registered = Object.values(hooks).some((entries) =>
            (entries ?? []).some((e) =>
              (e.hooks ?? []).some((h) => isHomeBinHookCommand(h.command, homeBin, connectorId)),
            ),
          );
          return registered
            ? { status: "OK", detail: "hook command present" }
            : { status: "FAIL", detail: `no hook for ${connectorId} in ${settingsPath}` };
        },
      },
    ];

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

  // ── Runtime: parse CodeBuddy stdin JSON → normalized event ────────────────
  // CodeBuddy's wire is the Claude shape (snake_case fields, PascalCase events),
  // so the claude-code/wire helpers (extractSessionId, toolResponseToString,
  // normalizeSessionSource) apply 1:1.

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as ClaudeWireInput;
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
        const ev: SessionStartEvent = { ...base, source: normalizeSessionSource(input.source) };
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
      case "PermissionRequest": {
        const ev: PermissionRequestEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          ...(Array.isArray(input.permission_suggestions)
            ? { permissionSuggestions: input.permission_suggestions }
            : {}),
        };
        return ev;
      }
      case "PostToolUseFailure": {
        const ev: PostToolUseFailureEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          error: typeof input.error === "string" ? input.error : "",
          ...(typeof input.tool_use_id === "string" ? { toolUseId: input.tool_use_id } : {}),
          ...(typeof input.is_interrupt === "boolean" ? { isInterrupt: input.is_interrupt } : {}),
          ...(typeof input.duration_ms === "number" ? { durationMs: input.duration_ms } : {}),
        };
        return ev;
      }
      case "SubagentStart": {
        const ev: SubagentStartEvent = {
          ...base,
          ...(typeof input.agent_id === "string" ? { agentId: input.agent_id } : {}),
          ...(typeof input.agent_type === "string" ? { agentType: input.agent_type } : {}),
        };
        return ev;
      }
      case "SubagentStop": {
        const ev: SubagentStopEvent = {
          ...base,
          ...(typeof input.agent_id === "string" ? { agentId: input.agent_id } : {}),
          ...(typeof input.agent_type === "string" ? { agentType: input.agent_type } : {}),
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
      case "PostCompact": {
        // Not wired as a normalized lifecycle hook (capabilities.postCompact is
        // unset), but the exhaustive guard requires an arm; mirror PreCompact.
        const ev: PostCompactEvent = {
          ...base,
          ...(input.trigger === "auto" || input.trigger === "manual"
            ? { trigger: input.trigger }
            : {}),
        };
        return ev;
      }
      default: {
        const _never: never = event;
        throw new Error(`unsupported codebuddy hook event: ${String(_never)}`);
      }
    }
  }

  // ── Runtime: normalized response → CodeBuddy native hook reply ────────────
  // Identical envelope to Claude Code (bundle-confirmed: hookSpecificOutput,
  // permissionDecision/permissionDecisionReason, additionalContext,
  // updatedInput; Stop-class blocks use the top-level decision:"block").

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    const hookEventName = event as ClaudeHookEvent;
    const decision = response.decision ?? "allow";

    if (event === "PermissionRequest") {
      if (response.decision === "deny") {
        return this.stdout({
          hookSpecificOutput: {
            hookEventName,
            decision: { behavior: "deny", message: response.reason ?? "Blocked by hook" },
          },
        });
      }
      if (
        response.decision === "allow" ||
        (response.decision === "modify" && response.updatedInput)
      ) {
        return this.stdout({
          hookSpecificOutput: {
            hookEventName,
            decision: {
              behavior: "allow",
              ...(response.updatedInput ? { updatedInput: response.updatedInput } : {}),
            },
          },
        });
      }
      return { exitCode: 0 };
    }

    // PostToolUseFailure / SubagentStart are observe/context-only.
    if (event === "PostToolUseFailure" || event === "SubagentStart") {
      const context =
        decision === "context"
          ? response.additionalContext
          : decision === "deny"
            ? response.reason ?? response.additionalContext
            : undefined;
      if (context) {
        return this.stdout({ hookSpecificOutput: { hookEventName, additionalContext: context } });
      }
      return { exitCode: 0 };
    }

    // deny → block. Stop-class events honor only the TOP-LEVEL decision:"block".
    if (decision === "deny") {
      if (
        event === "Stop" ||
        event === "SubagentStop" ||
        event === "UserPromptSubmit" ||
        event === "PostToolUse"
      ) {
        return this.stdout({ decision: "block", reason: response.reason ?? "Blocked by hook" });
      }
      return this.stdout({
        hookSpecificOutput: {
          hookEventName,
          permissionDecision: "deny",
          permissionDecisionReason: response.reason ?? "Blocked by hook",
        },
      });
    }

    if (decision === "ask") {
      return this.stdout({
        hookSpecificOutput: {
          hookEventName,
          permissionDecision: "ask",
          permissionDecisionReason: response.reason ?? "Confirmation required by hook",
        },
      });
    }

    if (decision === "modify") {
      if (event === "PreToolUse" && response.updatedInput) {
        return this.stdout({
          hookSpecificOutput: { hookEventName, updatedInput: response.updatedInput },
        });
      }
      // Output rewrite is unsupported; fall through to allow.
    }

    if (decision === "context" && response.additionalContext) {
      return this.stdout({
        hookSpecificOutput: { hookEventName, additionalContext: response.additionalContext },
      });
    }

    return { exitCode: 0 };
  }

  private stdout(payload: unknown): HookReply {
    return { exitCode: 0, stdout: JSON.stringify(payload) };
  }
}

/** CodeBuddy native interpolation token: `${env:VAR}` → `${VAR}`. */
function codebuddyEnvToken(name: string): string {
  return `\${${name}}`;
}

export const adapter = new CodeBuddyAdapter();
export default adapter;
