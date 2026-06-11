/**
 * adapters/copilot-cli — GitHub Copilot CLI platform adapter for agent-connector.
 *
 * GitHub Copilot CLI is a json-stdio host: the host pipes a JSON payload to a
 * hook command on stdin and reads JSON/exit-code back. Its hook event names and
 * reply shape are Claude-compatible (PascalCase events, `hookSpecificOutput`
 * reply wrapper), so the normalized HookEventName values map 1:1 — no event
 * rename table is needed.
 *
 * Native config (user/global only — Copilot CLI has no project-scoped config):
 *   - MCP servers: ~/.copilot/mcp-config.json, root key "mcpServers". An stdio
 *     server is written with type "local" (the host also accepts "stdio") plus
 *     `tools: ["*"]`. Remote servers use type "http".
 *   - Hooks: a Claude-compatible hooks file shaped `{ version: 1, hooks: { … } }`
 *     discovered from ~/.copilot/hooks/*.json. We write a single dedicated file,
 *     ~/.copilot/hooks/agent-connector.json, so we never disturb a user's own
 *     hook files and removal is a clean, scoped operation. Each event maps to an
 *     array of flat command entries `{ matcher?, hooks: [{ type:"command", command }] }`
 *     — the Claude shape, which Copilot CLI reads.
 *   - Reply: a `hookSpecificOutput` object keyed by `hookEventName` carrying
 *     `permissionDecision` (allow|deny|ask) + `permissionDecisionReason`,
 *     `additionalContext`, and (PreToolUse) `updatedInput`. PreToolUse is
 *     fail-closed on the host side; exit 0 + JSON refines the decision.
 *
 * Env handling: the host is not documented to support `${env:VAR}` interpolation
 * inside mcp-config.json, so env/header/url refs are resolved to literals at
 * install time via resolveEnvRefsDeep (the safe default for a no-native-interp
 * host, matching the Codex adapter's approach).
 *
 * Content surfaces (surfaces-design §4-5): Copilot CLI exposes skills and
 * subagents but NO prompt-file command surface, so commands inherit the
 * BaseAdapter skip/warn default (supportsCommands stays false).
 *   - skills: folder-per-skill `<dir>/skills/<name>/SKILL.md` (+ resource files).
 *     user scope → ~/.copilot/skills; project scope → <projectDir>/.github/skills.
 *   - subagents: user scope → ~/.copilot/agents/<name>.agent.md; project scope →
 *     <projectDir>/.github/agents/<name>.agent.md (md + frontmatter:
 *     name, description, tools, model).
 * The .github/ tree is shared with the vscode-copilot and jetbrains-copilot
 * connectors; we write identical, idempotent content and on uninstall remove
 * only the files this connector wrote.
 *
 * Grounded in docs/research/understand-report.md §2 (Platform Integration
 * Matrix, "GitHub Copilot CLI" row).
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
  PermissionRequestEvent,
  PlatformCapabilities,
  PlatformId,
  PostToolUseEvent,
  PostToolUseFailureEvent,
  PreCompactEvent,
  PreToolUseEvent,
  ServerDef,
  SessionEndEvent,
  SessionStartEvent,
  SkillDef,
  StopEvent,
  SubagentDef,
  SubagentStartEvent,
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

const HOST: PlatformId = "copilot-cli";
const MCP_ROOT_KEY = "mcpServers";

/** Native hooks-file version Copilot CLI expects (`{ version: 1, hooks: {…} }`). */
const COPILOT_HOOKS_VERSION = 1;

/**
 * Copilot CLI accepts both camelCase and PascalCase hook event names; PascalCase
 * is the portable, Claude/VS Code-compatible form (and selects the snake_case
 * payload dialect), so we emit it directly. Our normalized HookEventName values
 * are already PascalCase and match 1:1, hence no rename table — every declared
 * event has a native equivalent, including the newer four: subagentStart
 * (additionalContext only, matcher on agent name), subagentStop (can block and
 * force continuation), permissionRequest (decision control), and
 * postToolUseFailure (recovery guidance; the host also has a broader
 * errorOccurred event we do not register).
 */
type CopilotHookEvent = HookEventName;

/** A single Copilot CLI hook registration entry (Claude-shaped). */
interface CopilotHookEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string }>;
}

/** The shape of the Copilot CLI hooks file we own. */
interface CopilotHooksFile {
  version?: number;
  hooks?: Record<string, CopilotHookEntry[]>;
}

/** Native MCP server entry shapes Copilot CLI accepts under `mcpServers`. */
interface CopilotLocalServer {
  /** stdio transport is registered as type "local" (host also accepts "stdio"). */
  type: "local";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  tools: string[];
}
interface CopilotHttpServer {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  tools: string[];
}

/** Raw Copilot CLI hook stdin payload (Claude-style: PascalCase event, snake_case fields). */
interface CopilotWireInput {
  connector?: unknown;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;

  // tool events
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;

  // SessionStart
  source?: string;
  // SessionEnd
  reason?: string;
  // UserPromptSubmit
  prompt?: string;
  // PreCompact
  trigger?: string;
  // Stop / SubagentStop
  stop_hook_active?: boolean;
  // Notification
  message?: string;

  // PermissionRequest — permission-update entries the dialog would offer.
  permission_suggestions?: unknown[];

  // PostToolUseFailure
  tool_use_id?: string;
  error?: string;
  is_interrupt?: boolean;
  duration_ms?: number;

  // SubagentStart / SubagentStop — agent_type is unreliable on SubagentStop
  // (Claude-compatible quirk); treat both as optional everywhere.
  agent_id?: string;
  agent_type?: string;
  // SubagentStop — the subagent's OWN transcript + its final response text.
  agent_transcript_path?: string;
  last_assistant_message?: string;
}

export class CopilotCliAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "GitHub Copilot CLI";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    // Copilot CLI delivers the full Claude-compatible lifecycle event set.
    preToolUse: true,
    postToolUse: true,
    preCompact: true,
    sessionStart: true,
    sessionEnd: true,
    userPromptSubmit: true,
    stop: true,
    notification: true,
    // Newer events — Copilot CLI has native analogs for all four:
    // permissionRequest (decision control), postToolUseFailure (recovery
    // guidance), subagentStart (context-only), subagentStop (blockable).
    permissionRequest: true,
    postToolUseFailure: true,
    subagentStart: true,
    subagentStop: true,
    // PreToolUse is fail-closed and can rewrite tool input (updatedInput); a
    // PostToolUse hook cannot rewrite already-emitted tool output.
    canModifyArgs: true,
    canModifyOutput: false,
    canInjectSessionContext: true,
    transports: ["stdio", "http"],
    // Content surfaces: Copilot CLI exposes skills + subagents, but has no
    // prompt-file command surface, so commands stay false (inherits BaseAdapter
    // skip/warn).
    supportsCommands: false,
    supportsSkills: true,
    supportsSubagents: true,
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(_projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".copilot");
    const mcpConfig = join(userDir, "mcp-config.json");
    const hooksDir = join(userDir, "hooks");
    const installed =
      existsSync(userDir) || existsSync(mcpConfig) || existsSync(hooksDir);
    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath: mcpConfig,
      scope: "user",
      reason: installed
        ? `found GitHub Copilot CLI config under ${userDir}`
        : `no GitHub Copilot CLI config at ${userDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  /** Copilot CLI is user/global only — scope is ignored. */
  getConfigDir(_ctx: InstallContext): string {
    return join(homedir(), ".copilot");
  }

  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "mcp-config.json");
  }

  /**
   * Copilot CLI discovers hooks from any `~/.copilot/hooks/*.json`. We write a
   * single dedicated file so we never disturb the user's own hook files and
   * uninstall is a clean, scoped operation.
   */
  getHookConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "hooks", "agent-connector.json");
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
            ? "server registration disabled for copilot-cli"
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

  /** Render a normalized ServerDef into Copilot CLI's native mcpServers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): CopilotLocalServer | CopilotHttpServer {
    const transport: Transport = server.transport;
    const tools = this.renderTools(server);

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

      const entry: CopilotLocalServer = {
        type: "local",
        command: resolveEnvRefsDeep(command),
        tools,
      };
      if (args.length > 0) entry.args = args.map((a) => resolveEnvRefsDeep(a));
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      if (server.cwd) entry.cwd = resolveEnvRefsDeep(server.cwd);
      return entry;
    }

    // http (and any other remote transport we surface) — Copilot registers a URL.
    const entry: CopilotHttpServer = {
      type: "http",
      url: resolveEnvRefsDeep(server.url ?? ""),
      tools,
    };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Copilot CLI is not documented to support native
   * `${env:VAR}` interpolation in mcp-config.json, so refs resolve to literals
   * at install time (the safe default for a no-native-interp host).
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  /** Render the tool allow-list. Copilot CLI expects `tools` on every entry; default ["*"]. */
  private renderTools(server: ServerDef): string[] {
    const include = server.tools?.include;
    return include && include.length > 0 ? [...include] : ["*"];
  }

  // ── Hook install / uninstall ─────────────────────────────────────────────

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.hooks === false) {
      return [
        { platform: this.id, action: "skip", detail: "hooks disabled for copilot-cli" },
      ];
    }
    if (connector.hookEvents.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no hooks" }];
    }

    const hooksPath = this.getHookConfigPath(ctx);
    const file = this.readJson<CopilotHooksFile>(hooksPath) ?? {};
    const hooks = (file.hooks ??= {});

    const changes: ChangeRecord[] = [];
    let mutated = false;

    for (const event of connector.hookEvents) {
      // PascalCase events map 1:1 to Copilot CLI's native event names.
      const copilotEvent: CopilotHookEvent = event;
      const command = buildHomeBinHookCommand(ctx.homeBinPath, HOST, event, connector.id);
      const matcher = connector.hooks[event]?.matcher ?? "";
      const entry: CopilotHookEntry = {
        matcher,
        hooks: [{ type: "command", command }],
      };

      const bucket = (hooks[copilotEvent] ??= []);
      const existingIdx = bucket.findIndex((e) => this.entryHasOurCommand(e, ctx));

      if (existingIdx >= 0) {
        if (JSON.stringify(bucket[existingIdx]) === JSON.stringify(entry)) {
          changes.push({
            platform: this.id,
            action: "skip",
            path: hooksPath,
            detail: `hooks.${copilotEvent} already registered`,
          });
          continue;
        }
        bucket[existingIdx] = entry;
        changes.push({
          platform: this.id,
          action: "update",
          path: hooksPath,
          detail: `hooks.${copilotEvent}`,
        });
      } else {
        bucket.push(entry);
        changes.push({
          platform: this.id,
          action: "create",
          path: hooksPath,
          detail: `hooks.${copilotEvent}`,
        });
      }
      mutated = true;
    }

    if (mutated) {
      file.version = COPILOT_HOOKS_VERSION;
      this.writeJson(hooksPath, file, ctx.dryRun);
    }
    return changes;
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const hooksPath = this.getHookConfigPath(ctx);
    const file = this.readJson<CopilotHooksFile>(hooksPath);
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

    for (const copilotEvent of Object.keys(hooks)) {
      const bucket = hooks[copilotEvent];
      if (!Array.isArray(bucket)) continue;

      // Strip our hook command from each entry; drop entries left empty so we
      // never remove another connector's (or the user's own) hook commands.
      const next: CopilotHookEntry[] = [];
      let removed = 0;
      for (const e of bucket) {
        const innerBefore = e.hooks?.length ?? 0;
        const inner = (e.hooks ?? []).filter((h) => !this.isOurCommand(h.command, ctx));
        removed += innerBefore - inner.length;
        if (inner.length > 0) next.push({ matcher: e.matcher ?? "", hooks: inner });
      }

      if (removed > 0) {
        if (next.length > 0) hooks[copilotEvent] = next;
        else delete hooks[copilotEvent];
        changes.push({
          platform: this.id,
          action: "remove",
          path: hooksPath,
          detail: `hooks.${copilotEvent} (${removed})`,
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

  private entryHasOurCommand(entry: CopilotHookEntry, ctx: InstallContext): boolean {
    return (entry.hooks ?? []).some((h) => this.isOurCommand(h.command, ctx));
  }

  /** True when a hook command references our home binary AND this connector id
   *  (anchored so a shared-prefix id can't collide — see isHomeBinHookCommand). */
  private isOurCommand(command: string | undefined, ctx: InstallContext): boolean {
    return isHomeBinHookCommand(command, ctx.homeBinPath, ctx.connector.id);
  }

  // ── Content surfaces: skills / subagents ─────────────────────────────────
  // CONTENT-ONLY: pure native-file writers. No runtime dispatch, no home-bin
  // pointer, no telemetry wrap. Each method is idempotent (byte-identical →
  // skip) via BaseAdapter.writeContentFile and reversible via removeContentFile.
  // Honors platforms["copilot-cli"] per-surface false to skip. Commands are
  // unsupported here — they inherit the BaseAdapter skip/warn default.
  //
  // Path scoping: user scope lives under ~/.copilot (getConfigDir); project
  // scope lives under the shared <projectDir>/.github tree (the same files
  // vscode-copilot / jetbrains-copilot would write). We write identical content
  // and on uninstall remove only the files this connector wrote.

  /** Root dir for content surfaces: ~/.copilot (user) or <projectDir>/.github (project). */
  private contentDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".github")
      : this.getConfigDir(ctx);
  }

  private skillsDir(ctx: InstallContext): string {
    return join(this.contentDir(ctx), "skills");
  }
  private agentsDir(ctx: InstallContext): string {
    return join(this.contentDir(ctx), "agents");
  }

  /** Native skill dir: <contentDir>/skills/<name>. */
  private skillDir(ctx: InstallContext, name: string): string {
    return join(this.skillsDir(ctx), name);
  }
  /** Native subagent file path: <contentDir>/agents/<name>.agent.md. */
  private subagentPath(ctx: InstallContext, name: string): string {
    return join(this.agentsDir(ctx), `${name}.agent.md`);
  }

  // ── Skills ────────────────────────────────────────────────────────────────

  override installSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.skills === false) {
      return [{ platform: this.id, action: "skip", detail: "skills disabled for copilot-cli" }];
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
   * allowed-tools, disable-model-invocation) + body. Uniform Agent Skills shape
   * shared across every skill-supporting connector.
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
      return [{ platform: this.id, action: "skip", detail: "subagents disabled for copilot-cli" }];
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
    const mcpPath = this.getServerConfigPath(ctx);
    const hooksPath = this.getHookConfigPath(ctx);
    const connectorId = ctx.connector.id;
    const homeBin = ctx.homeBinPath;
    const hookEvents = ctx.connector.hookEvents;
    const checks: HealthCheck[] = [
      {
        name: `${this.name}: mcp-config.json present`,
        check: () =>
          existsSync(mcpPath)
            ? { status: "OK", detail: mcpPath }
            : { status: "FAIL", detail: `not found: ${mcpPath}` },
      },
      {
        name: `${this.name}: hook command registered`,
        check: () => {
          if (hookEvents.length === 0) {
            return { status: "OK", detail: "no hooks declared" };
          }
          const file = this.readJson<CopilotHooksFile>(hooksPath);
          if (!file) return { status: "FAIL", detail: `cannot read ${hooksPath}` };
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
            : { status: "FAIL", detail: `no hook for ${connectorId} in ${hooksPath}` };
        },
      },
    ];

    // Content-surface checks: only assert presence of the surfaces this
    // connector declares (skip silently for surfaces it never asked for).
    // Commands are unsupported on Copilot CLI, so no command check.
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

  // ── Runtime: parse Copilot CLI stdin JSON → normalized event ─────────────

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as CopilotWireInput;
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
        const toolOutput = toolResponseToString(input.tool_response);
        const ev: PostToolUseEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          ...(toolOutput !== undefined ? { toolOutput } : {}),
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
          ...(typeof input.tool_use_id === "string"
            ? { toolUseId: input.tool_use_id }
            : {}),
          ...(typeof input.is_interrupt === "boolean"
            ? { isInterrupt: input.is_interrupt }
            : {}),
          ...(typeof input.duration_ms === "number"
            ? { durationMs: input.duration_ms }
            : {}),
        };
        return ev;
      }
      case "SubagentStart": {
        const ev: SubagentStartEvent = {
          ...base,
          ...(typeof input.agent_id === "string" ? { agentId: input.agent_id } : {}),
          ...(typeof input.agent_type === "string"
            ? { agentType: input.agent_type }
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
        // Exhaustive guard — every HookEventName is handled above.
        const _never: never = event;
        throw new Error(`unsupported copilot-cli hook event: ${String(_never)}`);
      }
    }
  }

  // ── Runtime: normalized response → Copilot CLI native hook reply ─────────

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    const hookEventName = event;
    const decision = response.decision ?? "allow";

    // PermissionRequest replies use the Claude-compatible nested
    // decision{behavior} envelope and are the ONE event where an EXPLICIT
    // "allow" is an ACTIVE grant (it suppresses the permission dialog) rather
    // than passthrough:
    //   allow            → decision{behavior:"allow"} (+updatedInput when set);
    //                      the host still enforces its own deny rules.
    //   modify           → an allow grant carrying updatedInput.
    //   deny             → decision{behavior:"deny", message}.
    //   ask/context/void → NO decision output: fall through to the native
    //                      dialog (the dialog IS the ask).
    if (event === "PermissionRequest") {
      if (response.decision === "deny") {
        return this.stdout({
          hookSpecificOutput: {
            hookEventName,
            decision: {
              behavior: "deny",
              message: response.reason ?? "Blocked by hook",
            },
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
              ...(response.updatedInput
                ? { updatedInput: response.updatedInput }
                : {}),
            },
          },
        });
      }
      return { exitCode: 0 };
    }

    // PostToolUseFailure (recovery guidance beside the error) and SubagentStart
    // (context prepended to the SUBAGENT's conversation — creation is not
    // blockable on Copilot CLI) are observe/context-only: "context" emits
    // additionalContext, and a "deny" DEGRADES to the same shape carrying the
    // reason. Everything else passes through.
    if (event === "PostToolUseFailure" || event === "SubagentStart") {
      const context =
        decision === "context"
          ? response.additionalContext
          : decision === "deny"
            ? response.reason ?? response.additionalContext
            : undefined;
      if (context) {
        return this.stdout({
          hookSpecificOutput: { hookEventName, additionalContext: context },
        });
      }
      return { exitCode: 0 };
    }

    // deny → block the action with a reason (exit 0; JSON carries the decision).
    // SubagentStop is the Stop-semantics exception: like Claude, the block is
    // the TOP-LEVEL {"decision":"block","reason"} — it keeps the subagent
    // running with `reason` as its next instruction (the host "can block and
    // force continuation").
    if (decision === "deny") {
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

    // modify → rewrite PreToolUse input (only where Copilot CLI supports it).
    if (decision === "modify") {
      if (event === "PreToolUse" && response.updatedInput) {
        return this.stdout({
          hookSpecificOutput: { hookEventName, updatedInput: response.updatedInput },
        });
      }
      // Output rewrite is unsupported on Copilot CLI; fall through to allow.
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
 * Extract a stable session id from a Copilot CLI wire payload.
 * Priority mirrors the Claude wire protocol: transcript UUID > session_id > "".
 */
function extractSessionId(input: CopilotWireInput): string {
  if (typeof input.transcript_path === "string") {
    const m = input.transcript_path.match(/([a-f0-9-]{36})\.jsonl$/);
    if (m && m[1]) return m[1];
  }
  if (typeof input.session_id === "string" && input.session_id !== "") {
    return input.session_id;
  }
  return "";
}

/** Coerce a Copilot PostToolUse `tool_response` into a string for the normalized event. */
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

export const adapter = new CopilotCliAdapter();
export default adapter;
