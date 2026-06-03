/**
 * adapters/vscode-copilot — VS Code Copilot platform adapter for agent-connector.
 *
 * Generalized from context-mode's proven VS Code Copilot adapter: the served
 * identity is now `ctx.connector` (not a hardcoded "context-mode"), and every
 * hook command points at the single stable home binary
 * (`buildHomeBinHookCommand`) so one framework update propagates everywhere.
 *
 * VS Code Copilot is a json-stdio host (report §2 "Platform Integration Matrix"):
 *   - MCP servers: workspace (project) scope → <projectDir>/.vscode/mcp.json;
 *     user-profile scope → ~/.vscode/mcp.json. The ROOT KEY is "servers" (NOT
 *     "mcpServers" — a Cursor footgun VS Code deliberately diverges on), with an
 *     optional sibling "inputs" array. The file is officially JSONC, but a plain
 *     JSON write is valid JSONC, so we write strict JSON.
 *   - Hooks (Preview, ~v1.110): discovered from .github/hooks/*.json (and from
 *     Claude-compatible .claude/settings.json). We write a per-connector file at
 *     <projectDir>/.github/hooks/<connector-id>.json shaped like the Copilot
 *     hooks schema: `{ version: 1, hooks: { <PascalCaseEvent>: [ { type:
 *     "command", command } ] } }`. The top-level `version: 1` is REQUIRED — the
 *     Copilot runtime rejects a version-less file and no hooks fire. Unlike
 *     Claude, each entry is a FLAT `{ type, command }` object (no `{ matcher,
 *     hooks:[...] }` wrapper). Matchers are parsed but IGNORED (all hooks fire
 *     on all tools) — we still persist a connector-declared matcher for parity.
 *   - Reply: Claude-compatible JSON on stdout (exit 0). A `hookSpecificOutput`
 *     object keyed by PascalCase `hookEventName` carries permissionDecision
 *     (deny|ask) + permissionDecisionReason, additionalContext, and (PreToolUse)
 *     updatedInput. This mirrors the claude-code adapter exactly.
 *
 * Env interpolation: VS Code supports its own `${env:VAR}` (and `${input:VAR}`)
 * native interpolation, so env/header/url values are rewritten to the native
 * `${env:VAR}` token rather than baked into the file. The token is documented at
 * vscodeEnvToken below.
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
  StopEvent,
  SubagentDef,
  Transport,
  UserPromptSubmitEvent,
} from "../../core/types.js";
import { rewriteEnvRefs } from "../../core/interpolate.js";
import {
  buildHomeBinHookCommand,
  buildServeWrapperCommand,
  isHomeBinHookCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";

const HOST: PlatformId = "vscode-copilot";

/**
 * VS Code's MCP root key is "servers" — NOT "mcpServers". This is the single
 * most common VS Code Copilot integration bug (report §1): a config written
 * under "mcpServers" is silently ignored.
 */
const MCP_ROOT_KEY = "servers";

/** Top-level version the Copilot hooks runtime requires; a version-less file is rejected. */
const VSCODE_HOOKS_VERSION = 1;

/**
 * VS Code Copilot reads PascalCase hook event names from its hooks file —
 * identical to Claude Code. Only the events VS Code actually delivers are
 * registered; everything else has no Copilot equivalent and is reported as a
 * warn/skip at install time.
 */
const EVENT_MAP: Partial<Record<HookEventName, string>> = {
  PreToolUse: "PreToolUse",
  PostToolUse: "PostToolUse",
  PreCompact: "PreCompact",
  SessionStart: "SessionStart",
};

/** A single VS Code Copilot native hook entry — a flat command object. */
interface VSCodeHookEntry {
  type: "command";
  command: string;
}

/** The shape of a VS Code Copilot .github/hooks/<connector>.json file. */
interface VSCodeHooksFile {
  version?: number;
  hooks?: Record<string, VSCodeHookEntry[]>;
}

/** Native MCP server entry shapes VS Code accepts under `servers`. */
interface VSCodeStdioServer {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}
interface VSCodeHttpServer {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

/** Raw VS Code Copilot hook stdin payload (Claude-compatible snake_case fields). */
interface VSCodeWireInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  workspace_roots?: string[];
  hook_event_name?: string;

  // tool events
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_output?: string;
  error_message?: string;

  // SessionStart
  source?: string;
  // SessionEnd
  reason?: string;
  // UserPromptSubmit
  prompt?: string;
  // PreCompact
  trigger?: string;
  // Stop
  stop_hook_active?: boolean;
  // Notification
  message?: string;

  /** Injected by the entrypoint so the runtime knows which connector to dispatch. */
  connector?: string;
}

export class VSCodeCopilotAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "VS Code Copilot";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    // VS Code Copilot's Preview hooks runtime delivers Pre/PostToolUse,
    // PreCompact, and SessionStart (the four events its schema documents).
    preToolUse: true,
    postToolUse: true,
    preCompact: true,
    sessionStart: true,
    sessionEnd: false,
    userPromptSubmit: false,
    stop: false,
    notification: false,
    // PreToolUse can rewrite tool input (updatedInput) but a PostToolUse hook
    // cannot rewrite already-emitted tool output — same as Claude/Cursor.
    canModifyArgs: true,
    canModifyOutput: false,
    canInjectSessionContext: true,
    transports: ["stdio", "http"],
    // Content surfaces: VS Code Copilot authors prompt files, Agent Skills, and
    // chat-mode agent files under the workspace .github/ tree (see content-file
    // path helpers below). All three are supported.
    supportsCommands: true,
    supportsSkills: true,
    supportsSubagents: true,
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".vscode");
    const userMcp = join(userDir, "mcp.json");
    const userInsidersDir = join(homedir(), ".vscode-insiders");
    const projectVscode = join(projectDir, ".vscode");
    const projectMcp = join(projectVscode, "mcp.json");

    const projInstalled = existsSync(projectMcp) || existsSync(projectVscode);
    const userInstalled =
      existsSync(userMcp) || existsSync(userDir) || existsSync(userInsidersDir);
    const installed = projInstalled || userInstalled;

    // Report the scope/path/reason for the marker that actually matched, so a
    // project-only install isn't misreported as a (non-existent) user install.
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
          ? `found project VS Code config at ${projectVscode}`
          : `found VS Code config under ${userDir}`
        : `no VS Code config at ${userDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  /**
   * Config dir choice (documented per task brief): project (workspace) scope →
   * <projectDir>/.vscode; user-profile scope → ~/.vscode. The real VS Code user
   * profile dir is OS-specific and not reliably discoverable without launching
   * VS Code, so ~/.vscode is the reasonable, cross-OS, no-launch choice — it is
   * also where "MCP: Open User Configuration" writes on a default profile.
   */
  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".vscode")
      : join(homedir(), ".vscode");
  }

  /** MCP server registration lives in <configDir>/mcp.json under root "servers". */
  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "mcp.json");
  }

  /**
   * Hook registration lives in the workspace-discovered .github/hooks tree,
   * which VS Code Copilot scans for *.json hook files. We write one file per
   * connector so installs/uninstalls never clobber another connector's hooks.
   * Anchored on projectDir for both scopes — .github/hooks is a workspace
   * concept (there is no user-profile equivalent in the Copilot hooks schema).
   */
  getHookConfigPath(ctx: InstallContext): string {
    return join(ctx.projectDir, ".github", "hooks", `${ctx.connector.id}.json`);
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
            ? "server registration disabled for vscode-copilot"
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

  /** Render a normalized ServerDef into VS Code's native `servers` entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): VSCodeStdioServer | VSCodeHttpServer {
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
        );
        command = wrapped.command;
        args = wrapped.args;
      }

      const entry: VSCodeStdioServer = { type: "stdio", command: this.rewrite(command) };
      if (args.length > 0) entry.args = args.map((a) => this.rewrite(a));
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      if (server.cwd) entry.cwd = this.rewrite(server.cwd);
      return entry;
    }

    // http (and any other remote transport we surface) — VS Code registers a URL.
    const entry: VSCodeHttpServer = {
      type: "http",
      url: this.rewrite(server.url ?? ""),
    };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. VS Code supports its own `${env:VAR}` native
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

  /** Translate `${env:VAR(:-default)}` to VS Code's native `${env:VAR}` token. */
  private rewrite(value: string): string {
    return rewriteEnvRefs(value, vscodeEnvToken);
  }

  // ── Hook install / uninstall ─────────────────────────────────────────────

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.hooks === false) {
      return [
        { platform: this.id, action: "skip", detail: "hooks disabled for vscode-copilot" },
      ];
    }
    if (connector.hookEvents.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no hooks" }];
    }

    const hooksPath = this.getHookConfigPath(ctx);
    const file = this.readJson<VSCodeHooksFile>(hooksPath) ?? {};
    const hooks = (file.hooks ??= {});

    const changes: ChangeRecord[] = [];
    let mutated = false;

    for (const event of connector.hookEvents) {
      const vscodeEvent = EVENT_MAP[event];
      if (!vscodeEvent) {
        // No VS Code Copilot equivalent for this normalized event — report+skip.
        changes.push({
          platform: this.id,
          action: "warn",
          path: hooksPath,
          detail: `${event} has no VS Code Copilot hook equivalent — skipped`,
        });
        continue;
      }

      const command = buildHomeBinHookCommand(ctx.homeBinPath, HOST, event, connector.id);
      const entry: VSCodeHookEntry = { type: "command", command };

      const bucket = (hooks[vscodeEvent] ??= []);
      const existingIdx = bucket.findIndex((e) => this.isOurCommand(e.command, ctx));

      if (existingIdx >= 0) {
        if (JSON.stringify(bucket[existingIdx]) === JSON.stringify(entry)) {
          changes.push({
            platform: this.id,
            action: "skip",
            path: hooksPath,
            detail: `hooks.${vscodeEvent} already registered`,
          });
          continue;
        }
        bucket[existingIdx] = entry;
        changes.push({
          platform: this.id,
          action: "update",
          path: hooksPath,
          detail: `hooks.${vscodeEvent}`,
        });
      } else {
        bucket.push(entry);
        changes.push({
          platform: this.id,
          action: "create",
          path: hooksPath,
          detail: `hooks.${vscodeEvent}`,
        });
      }
      mutated = true;
    }

    if (mutated) {
      // The top-level version is REQUIRED — a version-less file is rejected and
      // no hooks fire. Always (re)assert it when we write.
      file.version = VSCODE_HOOKS_VERSION;
      this.writeJson(hooksPath, file, ctx.dryRun);
    }
    return changes;
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const hooksPath = this.getHookConfigPath(ctx);
    const file = this.readJson<VSCodeHooksFile>(hooksPath);
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

    for (const vscodeEvent of Object.keys(hooks)) {
      const bucket = hooks[vscodeEvent];
      if (!Array.isArray(bucket)) continue;

      const before = bucket.length;
      // Only strip OUR connector's home-bin commands — never another
      // connector's (isHomeBinHookCommand is id-anchored).
      const next = bucket.filter((e) => !this.isOurCommand(e.command, ctx));
      const removed = before - next.length;
      if (removed > 0) {
        if (next.length > 0) hooks[vscodeEvent] = next;
        else delete hooks[vscodeEvent];
        changes.push({
          platform: this.id,
          action: "remove",
          path: hooksPath,
          detail: `hooks.${vscodeEvent} (${removed})`,
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

  // ── Content surfaces: commands / skills / subagents ──────────────────────
  // CONTENT-ONLY: pure native-file writers under the workspace .github/ tree
  // ({prompts,skills,agents}). No runtime dispatch, no home-bin pointer, no
  // telemetry wrap. Each method is idempotent (byte-identical → skip) via
  // BaseAdapter.writeContentFile and reversible via removeContentFile. Honors
  // platforms["vscode-copilot"] per-surface false to skip.
  //
  // SHARED .github TREE: vscode-copilot, copilot-cli, and jetbrains-copilot all
  // write under the SAME project <projectDir>/.github tree. The rendered content
  // is identical and idempotent across those connectors, and uninstall here only
  // removes the files THIS connector declared — never another writer's files.
  //
  // SCOPE NOTE: .github is a workspace concept; the Copilot prompt/skill/agent
  // discovery is workspace-rooted and there is no documented per-user .github
  // authoring location. VS Code's reliable per-user authoring root is the user
  // profile prompts dir under the OS app-data path, which is not discoverable
  // without launching VS Code. So for user scope we anchor on
  // <homedir>/.config/github-copilot (the documented cross-OS Copilot user dir;
  // see contentRootDir) rather than fabricating a profile path. Project scope is
  // the primary, fully-supported path.

  /**
   * Root of the content tree. Project (workspace) scope → <projectDir>/.github,
   * which VS Code Copilot scans for prompt/skill/agent files (and which
   * copilot-cli + jetbrains-copilot share). User scope has no documented
   * workspace-independent .github equivalent, so we anchor on the documented
   * cross-OS Copilot user dir ~/.config/github-copilot to keep user-scope writes
   * deterministic and removable.
   */
  private contentRootDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".github")
      : join(homedir(), ".config", "github-copilot");
  }

  private promptsDir(ctx: InstallContext): string {
    return join(this.contentRootDir(ctx), "prompts");
  }
  private skillsDir(ctx: InstallContext): string {
    return join(this.contentRootDir(ctx), "skills");
  }
  private agentsDir(ctx: InstallContext): string {
    return join(this.contentRootDir(ctx), "agents");
  }

  /** Native command file path: <ghDir>/prompts/<name>.prompt.md. */
  private commandPath(ctx: InstallContext, name: string): string {
    return join(this.promptsDir(ctx), `${name}.prompt.md`);
  }
  /** Native skill dir: <ghDir>/skills/<name>. */
  private skillDir(ctx: InstallContext, name: string): string {
    return join(this.skillsDir(ctx), name);
  }
  /** Native subagent file path: <ghDir>/agents/<name>.agent.md. */
  private subagentPath(ctx: InstallContext, name: string): string {
    return join(this.agentsDir(ctx), `${name}.agent.md`);
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  override installCommands(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.commands === false) {
      return [{ platform: this.id, action: "skip", detail: "commands disabled for vscode-copilot" }];
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

  /** Render a VS Code Copilot prompt file: md+frontmatter(description, tools, model, argument-hint). */
  private renderCommand(cmd: CommandDef): string {
    const frontmatter: Record<string, unknown> = {};
    if (cmd.description !== undefined) frontmatter.description = cmd.description;
    // VS Code prompt files express tool access as a `tools` array, sourced from
    // the portable tools.allow policy.
    const allow = cmd.tools?.allow;
    if (allow && allow.length > 0) frontmatter.tools = [...allow];
    if (cmd.model !== undefined) frontmatter.model = cmd.model;
    if (cmd.argumentHint !== undefined) frontmatter["argument-hint"] = cmd.argumentHint;
    if (cmd.extra) Object.assign(frontmatter, cmd.extra);
    return this.renderFrontmatterMd(frontmatter, cmd.prompt);
  }

  // ── Skills ────────────────────────────────────────────────────────────────

  override installSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.skills === false) {
      return [{ platform: this.id, action: "skip", detail: "skills disabled for vscode-copilot" }];
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
      for (const [rel, contents] of Object.entries(skill.resources ?? {})) {
        changes.push(this.writeContentFile(join(dir, rel), contents, ctx.dryRun));
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
        changes.push(this.removeContentFile(join(dir, rel), ctx.dryRun));
      }
      changes.push(this.removeContentFile(dir, ctx.dryRun));
    }
    return changes;
  }

  /**
   * Render a skill's SKILL.md — the uniform Agent Skills format: frontmatter
   * (name, description + optional model, allowed-tools, disable-model-invocation)
   * + body. Byte-identical to the other .github-sharing connectors so a shared
   * skill folder never thrashes.
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
      return [{ platform: this.id, action: "skip", detail: "subagents disabled for vscode-copilot" }];
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

  /** Render a subagent agent file: md+frontmatter(name, description, tools, model) + prompt body. */
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
        name: `${this.name}: mcp.json present`,
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
          const file = this.readJson<VSCodeHooksFile>(hooksPath);
          if (!file) return { status: "FAIL", detail: `not found: ${hooksPath}` };
          if (file.version !== VSCODE_HOOKS_VERSION) {
            return {
              status: "FAIL",
              detail: `${hooksPath} missing required "version": ${VSCODE_HOOKS_VERSION} — Copilot rejects it`,
            };
          }
          const registered = Object.values(file.hooks ?? {}).some((entries) =>
            (entries ?? []).some((e) =>
              isHomeBinHookCommand(e.command, homeBin, connectorId),
            ),
          );
          return registered
            ? { status: "OK", detail: "hook command present" }
            : { status: "FAIL", detail: `no hook for ${connectorId} in ${hooksPath}` };
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

  // ── Runtime: parse VS Code Copilot stdin JSON → normalized event ──────────

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as VSCodeWireInput;
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
        const toolOutput =
          toolResponseToString(input.tool_response) ??
          input.tool_output ??
          input.error_message;
        const ev: PostToolUseEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          ...(toolOutput !== undefined ? { toolOutput } : {}),
          ...(input.error_message ? { isError: true } : {}),
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
      case "SessionStart": {
        const ev: SessionStartEvent = {
          ...base,
          source: normalizeSessionSource(input.source ?? input.trigger),
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
        // Exhaustive guard — every HookEventName is handled above. (VS Code only
        // delivers the four it declares; the rest are handled defensively so a
        // mis-dispatch stays inert rather than crashing.)
        const _never: never = event;
        throw new Error(`unsupported vscode-copilot hook event: ${String(_never)}`);
      }
    }
  }

  /** Resolve the project dir from the wire payload, preferring the explicit cwd. */
  private getProjectDir(input: VSCodeWireInput): string | undefined {
    return input.cwd ?? input.workspace_roots?.[0] ?? undefined;
  }

  // ── Runtime: normalized response → VS Code Copilot native hook reply ──────

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    const hookEventName = event;
    const decision = response.decision ?? "allow";

    // deny → block the action with a reason (exit 0; JSON carries the decision).
    // VS Code Copilot is Claude-compatible: the decision lives inside
    // `hookSpecificOutput`, keyed by the PascalCase event name.
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

    // modify → rewrite PreToolUse input (only where VS Code supports it).
    if (decision === "modify") {
      if (event === "PreToolUse" && response.updatedInput) {
        return this.stdout({
          hookSpecificOutput: { hookEventName, updatedInput: response.updatedInput },
        });
      }
      // Output rewrite is unsupported on VS Code; fall through to allow.
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
 * VS Code native interpolation token: `${env:VAR}` → `${env:VAR}` (passthrough).
 * VS Code also supports `${input:VAR}` (prompted/secret inputs declared in the
 * sibling `inputs` array); we keep portable `${env:VAR}` refs as the native env
 * token so secrets are never baked into the committed config.
 */
function vscodeEnvToken(name: string): string {
  return `\${env:${name}}`;
}

/**
 * Extract a stable session id from a VS Code Copilot wire payload. Priority
 * mirrors the Claude-compatible wire: transcript UUID > session_id > "" (the
 * framework uses "" when no id is available — no ppid fabrication here).
 */
function extractSessionId(input: VSCodeWireInput): string {
  if (typeof input.transcript_path === "string") {
    const m = input.transcript_path.match(/([a-f0-9-]{36})\.jsonl$/);
    if (m && m[1]) return m[1];
  }
  if (typeof input.session_id === "string" && input.session_id !== "") {
    return input.session_id;
  }
  return "";
}

/** Coerce a Claude-compatible PostToolUse `tool_response` into a string. */
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

export const adapter = new VSCodeCopilotAdapter();
export default adapter;
