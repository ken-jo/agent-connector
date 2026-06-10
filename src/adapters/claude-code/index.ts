/**
 * adapters/claude-code — Claude Code platform adapter for agent-connector.
 *
 * Generalized from context-mode's proven 15-platform Claude adapter: the served
 * identity is now `ctx.connector` (not a hardcoded "context-mode"), and every
 * hook command points at the single stable home binary
 * (`buildHomeBinHookCommand`) so one framework update propagates everywhere.
 *
 * Claude Code is a json-stdio host:
 *   - MCP servers: user scope → ~/.claude.json ("mcpServers"); project scope →
 *     <projectDir>/.mcp.json ("mcpServers").
 *   - Hooks: <configDir>/settings.json under "hooks", keyed by event name, each
 *     value an array of { matcher, hooks:[{ type:"command", command }] }.
 *   - Reply: a `hookSpecificOutput` object (allow|deny|ask + reason,
 *     additionalContext, updatedInput) on stdout with exit 0.
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
  SessionEndEvent,
  SessionStartEvent,
  ServerDef,
  SkillDef,
  StopEvent,
  SubagentDef,
  Transport,
  UserPromptSubmitEvent,
} from "../../core/types.js";
import { resolveEnvRefsDeep, rewriteEnvRefs } from "../../core/interpolate.js";
import {
  buildHomeBinHookCommand,
  buildServeWrapperCommand,
  isHomeBinHookCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";
import {
  type ClaudeHookEvent,
  type ClaudeWireInput,
  extractSessionId,
  toolResponseToString,
} from "./wire.js";
import { renderCommandMd, renderSkillMd, renderSubagentMd } from "./render.js";

const HOST: PlatformId = "claude-code";
const MCP_ROOT_KEY = "mcpServers";

/** A single hook registration entry as Claude Code stores it in settings.json. */
interface ClaudeHookEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string }>;
}

/** Native MCP server entry shapes Claude Code accepts under `mcpServers`. */
interface ClaudeStdioServer {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}
interface ClaudeHttpServer {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

export class ClaudeCodeAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Claude Code";
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
    // Claude Code can rewrite PreToolUse input (updatedInput) but does NOT let a
    // PostToolUse hook rewrite already-emitted tool output.
    canModifyArgs: true,
    canModifyOutput: false,
    canInjectSessionContext: true,
    transports: ["stdio", "http"],
    // Content surfaces: Claude Code is the reference implementation for all three.
    supportsCommands: true,
    supportsSkills: true,
    supportsSubagents: true,
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".claude");
    const userSettings = join(userDir, "settings.json");
    const userServers = join(homedir(), ".claude.json");
    const projectServers = join(projectDir, ".mcp.json");
    const userInstalled =
      existsSync(userDir) || existsSync(userSettings) || existsSync(userServers);
    const projInstalled = existsSync(projectServers);
    const installed = userInstalled || projInstalled;
    // Report the scope/path/reason for the marker that actually matched, so a
    // project-only install isn't misreported as a (non-existent) user install.
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
          ? `found project Claude Code config at ${projectServers}`
          : `found Claude Code config under ${userDir}`
        : `no Claude Code config at ${userDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".claude")
      : join(homedir(), ".claude");
  }

  getServerConfigPath(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".mcp.json")
      : join(homedir(), ".claude.json");
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
            ? "server registration disabled for claude-code"
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

  /** Render a normalized ServerDef into Claude Code's native mcpServers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): ClaudeStdioServer | ClaudeHttpServer {
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

      const entry: ClaudeStdioServer = { type: "stdio", command, args };
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      if (server.cwd) entry.cwd = resolveEnvRefsDeep(server.cwd);
      return entry;
    }

    // http (and any other remote transport we surface) — Claude registers a URL.
    const entry: ClaudeHttpServer = {
      type: "http",
      url: rewriteEnvRefs(server.url ?? "", claudeEnvToken),
    };
    if (server.headers) {
      entry.headers = this.renderEnv(server.headers) ?? {};
    }
    return entry;
  }

  /**
   * Render env/header values. Claude Code supports its own `${VAR}` native
   * interpolation, so translate `${env:VAR}` refs to that native token rather
   * than baking secrets into the file. Literals pass through unchanged.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      out[k] = rewriteEnvRefs(v, claudeEnvToken);
    }
    return out;
  }

  // ── Hook install / uninstall ─────────────────────────────────────────────

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.hooks === false) {
      return [
        { platform: this.id, action: "skip", detail: "hooks disabled for claude-code" },
      ];
    }
    if (connector.hookEvents.length === 0) {
      return [
        { platform: this.id, action: "skip", detail: "connector declares no hooks" },
      ];
    }

    const settingsPath = this.getHookConfigPath(ctx);
    const settings = this.readJson<Record<string, unknown>>(settingsPath) ?? {};
    const hooks = (settings.hooks ??= {}) as Record<string, ClaudeHookEntry[]>;

    const changes: ChangeRecord[] = [];
    let mutated = false;

    for (const event of connector.hookEvents) {
      const command = buildHomeBinHookCommand(ctx.homeBinPath, HOST, event, connector.id);
      const matcher = connector.hooks[event]?.matcher ?? "";
      const entry: ClaudeHookEntry = {
        matcher,
        hooks: [{ type: "command", command }],
      };

      const bucket = (hooks[event] ??= []);
      const existingIdx = bucket.findIndex((e) => this.entryHasCommand(e, command));

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
    const settings = this.readJson<Record<string, unknown>>(settingsPath);
    const hooks = settings?.hooks as Record<string, ClaudeHookEntry[]> | undefined;
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

      // Strip our hook command from each entry; drop entries left empty.
      const next: ClaudeHookEntry[] = [];
      let removed = 0;
      for (const e of bucket) {
        const innerBefore = e.hooks?.length ?? 0;
        const inner = (e.hooks ?? []).filter(
          (h) => !this.isOurCommand(h.command, ctx),
        );
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

  private entryHasCommand(entry: ClaudeHookEntry, command: string): boolean {
    return (entry.hooks ?? []).some((h) => h.command === command);
  }

  // ── Content surfaces: commands / skills / subagents ──────────────────────
  // CONTENT-ONLY: pure native-file writers under <configDir>/{commands,skills,
  // agents}. No runtime dispatch, no home-bin pointer, no telemetry wrap. Each
  // method is idempotent (byte-identical → skip) via BaseAdapter.writeContentFile
  // and reversible via removeContentFile. Honors platforms["claude-code"]
  // per-surface false to skip.

  private commandsDir(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "commands");
  }
  private skillsDir(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "skills");
  }
  private agentsDir(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "agents");
  }

  /** Native command file path: <configDir>/commands/<name>.md. */
  private commandPath(ctx: InstallContext, name: string): string {
    return join(this.commandsDir(ctx), `${name}.md`);
  }
  /** Native skill dir: <configDir>/skills/<name>. */
  private skillDir(ctx: InstallContext, name: string): string {
    return join(this.skillsDir(ctx), name);
  }
  /** Native subagent file path: <configDir>/agents/<name>.md. */
  private subagentPath(ctx: InstallContext, name: string): string {
    return join(this.agentsDir(ctx), `${name}.md`);
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  override installCommands(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.commands === false) {
      return [{ platform: this.id, action: "skip", detail: "commands disabled for claude-code" }];
    }
    if (connector.commands.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no commands" }];
    }
    return connector.commands.map((cmd) =>
      this.writeContentFile(
        this.commandPath(ctx, cmd.name),
        this.renderCommand(cmd),
        ctx.dryRun,
      ),
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

  /** Render a command to md+frontmatter (delegates to the shared renderer). */
  private renderCommand(cmd: CommandDef): string {
    return renderCommandMd(cmd);
  }

  // ── Skills ────────────────────────────────────────────────────────────────

  override installSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.skills === false) {
      return [{ platform: this.id, action: "skip", detail: "skills disabled for claude-code" }];
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

  /** Render a skill's SKILL.md (delegates to the shared renderer). */
  private renderSkill(skill: SkillDef): string {
    return renderSkillMd(skill);
  }

  // ── Subagents ───────────────────────────────────────────────────────────────

  override installSubagents(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.subagents === false) {
      return [{ platform: this.id, action: "skip", detail: "subagents disabled for claude-code" }];
    }
    if (connector.subagents.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no subagents" }];
    }
    return connector.subagents.map((agent) =>
      this.writeContentFile(
        this.subagentPath(ctx, agent.name),
        this.renderSubagent(agent),
        ctx.dryRun,
      ),
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

  /** Render a subagent to md+frontmatter (delegates to the shared renderer). */
  private renderSubagent(agent: SubagentDef): string {
    return renderSubagentMd(agent);
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
          const settings = this.readJson<{ hooks?: Record<string, ClaudeHookEntry[]> }>(
            settingsPath,
          );
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
            : {
                status: "FAIL",
                detail: `no hook for ${connectorId} in ${settingsPath}`,
              };
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

  // ── Runtime: parse Claude stdin JSON → normalized event ──────────────────

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
        throw new Error(`unsupported claude-code hook event: ${String(_never)}`);
      }
    }
  }

  // ── Runtime: normalized response → Claude native hook reply ──────────────

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    const hookEventName = event as ClaudeHookEvent;
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
          permissionDecisionReason:
            response.reason ?? "Confirmation required by hook",
        },
      });
    }

    // modify → rewrite PreToolUse input (only where Claude supports it).
    if (decision === "modify") {
      if (event === "PreToolUse" && response.updatedInput) {
        return this.stdout({
          hookSpecificOutput: { hookEventName, updatedInput: response.updatedInput },
        });
      }
      // Output rewrite is unsupported on Claude; fall through to allow.
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

/** Claude Code native interpolation token: `${env:VAR}` → `${VAR}`. */
function claudeEnvToken(name: string): string {
  return `\${${name}}`;
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

export const adapter = new ClaudeCodeAdapter();
export default adapter;
