/**
 * adapters/mimo-code — Xiaomi MiMoCode platform adapter for agent-connector.
 *
 * MiMoCode (github.com/XiaomiMiMo/MiMo-Code, MIT) is Xiaomi's open-source
 * terminal AI coding agent — a FORK OF OpenCode (anomalyco/opencode) that adds
 * cross-session memory, checkpoints, subagents, etc. Official npm `@mimo-ai/cli`
 * (bin: `mimo`). NOTE: `@xiaomi-mimo/cli` is an UNOFFICIAL squatter (GPL) — not
 * referenced here; the bin is `mimo`, NOT `mimo-code`.
 *
 * DESIGN — STANDALONE (mirrors OpenCode's render logic with mimocode paths),
 * NOT `extends OpenCodeAdapter`. The OpenCode adapter binds the host string in
 * several places that a subclass cannot cleanly override:
 *   - a module-level `const HOST = "opencode"` used for the per-platform server/
 *     hooks override lookup (`ctx.connector.platforms[HOST]`) and stamped as
 *     `hostPlatform` on every parsed event — extending would read
 *     `platforms["opencode"]` overrides and mis-stamp events as opencode;
 *   - the PRIVATE `buildPluginSource` hardcodes `["hook", "opencode", event, …]`
 *     in the GENERATED bridge, so an inherited plugin would dispatch the runtime
 *     hook to the opencode adapter (`hook opencode`) instead of mimo-code;
 *   - the config/plugin/content directory builders hardcode "opencode" /
 *     ".opencode" / "opencode.json".
 * Overriding all of that means re-implementing the private render core anyway,
 * so this adapter mirrors OpenCode's logic with a `HOST = "mimo-code"` constant
 * and the mimocode paths — a clean standalone that routes detection, the runtime
 * bridge, and per-platform overrides to its own id.
 *
 * MiMoCode IS OpenCode's config dialect, so the render shapes are IDENTICAL:
 *   - config file `mimocode.json`
 *       user scope    → ~/.config/mimocode/mimocode.json
 *       project scope → <projectDir>/mimocode.json
 *     (the dir is `.mimocode` / `~/.config/mimocode` — NO hyphen; the committed
 *      example is `.mimocode/mimocode.jsonc`).
 *   - MCP root key "mcp" (the OpenCode shape, NOT "mcpServers"); each server
 *     keyed by name; stdio → { type:"local", command:[exe,…args], environment },
 *     remote → { type:"remote", url }.
 *   - ts-plugin hooks: a self-contained ESM bridge module auto-loaded from the
 *       user scope    → ~/.config/mimocode/plugin/<id>.js
 *       project scope → <projectDir>/.mimocode/plugin/<id>.js
 *     plugin dir (writing the file IS the registration; no config array edit).
 *   - content surfaces under <mcDir>/{commands,skills,agent} (singular `agent/`,
 *     matching OpenCode).
 *
 * Event mapping (OpenCode's, unchanged):
 *   PreToolUse   → "tool.execute.before"  (mutate output.args; throw to deny)
 *   PostToolUse  → "tool.execute.after"   (mutate output.output)
 *   SessionStart → "experimental.chat.system.transform" (inject into output.system)
 *
 * SOURCES: github.com/XiaomiMiMo/MiMo-Code (README, .mimocode/mimocode.jsonc,
 * packages/opencode/src/config/{config.ts,mcp.ts,plugin.ts}). npm @mimo-ai/cli.
 * mimo.xiaomi.com/en/mimocode.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { BaseAdapter } from "../base.js";
import type {
  Adapter,
  GeneratedPluginFile,
  HookReply,
  InstallContext,
  MemoryTarget,
  NormalizedEvent,
} from "../spi.js";
import type {
  ChangeRecord,
  CommandDef,
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
  SkillDef,
  SubagentDef,
  Transport,
} from "../../core/types.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  buildServeWrapperCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";

const HOST: PlatformId = "mimo-code";
const MCP_ROOT_KEY = "mcp";

/** The config dir name (NO hyphen): `.mimocode` / `~/.config/mimocode`. */
const CONFIG_DIR_NAME = "mimocode";
/** The config file name: `mimocode.json`. */
const CONFIG_FILE_NAME = "mimocode.json";

/**
 * Canonical → MiMoCode (OpenCode-shaped) event name map. A connector hook event
 * is only emitted by the generated plugin when it appears here AND is declared
 * by the connector.
 */
const EVENT_TO_MIMOCODE: Partial<Record<HookEventName, string>> = {
  PreToolUse: "tool.execute.before",
  PostToolUse: "tool.execute.after",
  // No real SessionStart hook (inherited from OpenCode #14808 / #5409). The
  // verified surrogate is experimental.chat.system.transform.
  SessionStart: "experimental.chat.system.transform",
};

/** Raw payload the generated plugin posts to the universal hook entrypoint. */
interface MiMoCodeBridgePayload {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  isError?: boolean;
  sessionId?: string;
  projectDir?: string;
}

/** Native MCP server entry shapes MiMoCode accepts under the "mcp" key. */
interface MiMoCodeLocalServer {
  type: "local";
  command: string[];
  environment?: Record<string, string>;
  enabled?: boolean;
}
interface MiMoCodeRemoteServer {
  type: "remote";
  url: string;
  enabled?: boolean;
}

export class MiMoCodeAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "MiMoCode";
  readonly paradigm: HookParadigm = "ts-plugin";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: AGENTS.md-first managed block (CLAUDE.md fallback, like
    // OpenCode — MiMoCode keeps OpenCode's CLAUDE.md import + AGENTS.md reading).
    supportsMemory: true,
    preToolUse: true,
    postToolUse: true,
    preCompact: false,
    sessionStart: true,
    sessionEnd: false,
    userPromptSubmit: false,
    stop: false,
    notification: false,
    // tool.execute.before mutates output.args → input rewrite supported.
    canModifyArgs: true,
    // tool.execute.after mutates output.output → output rewrite supported.
    canModifyOutput: true,
    // injected via experimental.chat.system.transform at session start.
    canInjectSessionContext: true,
    transports: ["stdio", "sse", "http"],
    // Content surfaces: MiMoCode authors all three natively under <mcDir>
    // (inherited from OpenCode's commands/skills/agent layout).
    supportsCommands: true,
    supportsSkills: true,
    supportsSubagents: true,
  };

  // ── Detection ──────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userConfigDir = join(homedir(), ".config", CONFIG_DIR_NAME);
    const userConfig = join(userConfigDir, CONFIG_FILE_NAME);
    const projectConfig = join(projectDir, CONFIG_FILE_NAME);

    const userInstalled = existsSync(userConfigDir) || existsSync(userConfig);
    const projInstalled = existsSync(projectConfig);
    const installed = userInstalled || projInstalled;

    // Report the marker that actually matched so a project-only install isn't
    // misreported as a (non-existent) user install.
    const scope = projInstalled && !userInstalled ? "project" : "user";
    const configPath = scope === "project" ? projectConfig : userConfig;

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
          ? `found project MiMoCode config at ${projectConfig}`
          : `found MiMoCode config under ${userConfigDir}`
        : `no MiMoCode config at ${userConfigDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Memory surface: AGENTS.md / CLAUDE.md-fallback probe (project) ──────
  // Mirrors OpenCode: project AGENTS.md, falling back to CLAUDE.md ONLY when no
  // AGENTS.md exists (creating AGENTS.md beside a relied-on CLAUDE.md would
  // shadow the user's rules). User scope stays on the BaseAdapter default.
  protected override memoryTargets(ctx: InstallContext): MemoryTarget[] {
    if (this.memoryOverride(ctx)?.path || ctx.scope !== "project") {
      return super.memoryTargets(ctx);
    }
    const agentsMd = join(ctx.projectDir, "AGENTS.md");
    if (existsSync(agentsMd)) {
      return [{ path: agentsMd, reason: "AGENTS.md (mimocode's primary project rules file)" }];
    }
    const claudeMd = join(ctx.projectDir, "CLAUDE.md");
    if (existsSync(claudeMd)) {
      return [
        {
          path: claudeMd,
          reason:
            "CLAUDE.md (mimocode's fallback rules file — creating AGENTS.md would shadow it)",
        },
      ];
    }
    return [{ path: agentsMd, reason: "AGENTS.md standard (created; no mimocode rules file yet)" }];
  }

  // ── Native paths ───────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? ctx.projectDir
      : join(homedir(), ".config", CONFIG_DIR_NAME);
  }

  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), CONFIG_FILE_NAME);
  }

  /**
   * For ts-plugin hosts the "hook config path" is the generated plugin FILE.
   * MiMoCode (like OpenCode) auto-loads every file in the plugin dir; writing
   * this file IS the registration.
   */
  getHookConfigPath(ctx: InstallContext): string {
    return join(this.pluginDir(ctx), this.pluginFileName(ctx));
  }

  /** Plugin directory MiMoCode auto-loads modules from, per scope. */
  private pluginDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, `.${CONFIG_DIR_NAME}`, "plugin")
      : join(homedir(), ".config", CONFIG_DIR_NAME, "plugin");
  }

  /** Plugin module file name (one per connector, kebab-case id). */
  private pluginFileName(ctx: InstallContext): string {
    return `${ctx.connector.id}.js`;
  }

  // ── MCP server install / uninstall ─────────────────────────────────────

  installServer(ctx: InstallContext): ChangeRecord[] {
    const server = this.effectiveServer(ctx);
    const serverPath = this.getServerConfigPath(ctx);

    if (!server) {
      return [
        {
          platform: this.id,
          action: "skip",
          path: serverPath,
          detail: ctx.connector.server
            ? "server registration disabled for mimo-code"
            : "connector declares no MCP server",
        },
      ];
    }

    const entry = this.renderServerEntry(ctx, server);
    return [
      this.upsertServerInJson(
        serverPath,
        MCP_ROOT_KEY,
        ctx.connector.id,
        entry,
        ctx.dryRun,
      ),
    ];
  }

  uninstallServer(ctx: InstallContext): ChangeRecord[] {
    const serverPath = this.getServerConfigPath(ctx);
    return [
      this.removeServerFromJson(
        serverPath,
        MCP_ROOT_KEY,
        ctx.connector.id,
        ctx.dryRun,
      ),
    ];
  }

  /** Resolve the per-platform server override into an effective ServerDef. */
  private effectiveServer(ctx: InstallContext): ServerDef | undefined {
    const override = ctx.connector.platforms[HOST]?.server;
    if (override === false) return undefined;
    const base = ctx.connector.server;
    if (!base) return undefined;
    return override && typeof override === "object" ? { ...base, ...override } : base;
  }

  /**
   * Render a normalized ServerDef into MiMoCode's native "mcp" entry (OpenCode
   * dialect).
   *
   * stdio  → { type: "local", command: [exe, ...args], environment }
   * remote → { type: "remote", url }
   *
   * MiMoCode flattens command+args into a single ARRAY. When telemetry wrapping
   * applies, the wrapper's command+args (which already include the real command
   * tail after `--`) become the head of that array. No native interpolation
   * token → resolve every ${env:VAR} reference to a literal at install time.
   */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): MiMoCodeLocalServer | MiMoCodeRemoteServer {
    const transport: Transport = server.transport;

    if (transport === "stdio") {
      let command = server.command ?? "";
      let args = [...(server.args ?? [])];

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

      const commandArray = resolveEnvRefsDeep([command, ...args]).filter(
        (s) => s !== "",
      );
      const entry: MiMoCodeLocalServer = {
        type: "local",
        command: commandArray,
      };
      const environment = this.renderEnv(server.env);
      if (environment) entry.environment = environment;
      if (server.enabled === false) entry.enabled = false;
      return entry;
    }

    // sse / http / ws (any remote transport) — MiMoCode registers a URL.
    const entry: MiMoCodeRemoteServer = {
      type: "remote",
      url: resolveEnvRefsDeep(server.url ?? ""),
    };
    if (server.enabled === false) entry.enabled = false;
    return entry;
  }

  /** Render env values, resolving every ${env:VAR} reference to a literal. */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Hook install / uninstall (ts-plugin) ───────────────────────────────

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const pluginPath = this.getHookConfigPath(ctx);

    if (ctx.connector.platforms[HOST]?.hooks === false) {
      return [
        {
          platform: this.id,
          action: "skip",
          path: pluginPath,
          detail: "hooks disabled for mimo-code",
        },
      ];
    }
    if (ctx.connector.hookEvents.length === 0) {
      return [
        {
          platform: this.id,
          action: "skip",
          path: pluginPath,
          detail: "connector declares no hooks",
        },
      ];
    }

    const files = this.synthesizePlugin(ctx);
    const changes: ChangeRecord[] = [];

    for (const file of files) {
      const before = existsSync(file.path)
        ? this.safeRead(file.path)
        : undefined;
      let action: ChangeRecord["action"];
      if (before === undefined) action = "create";
      else if (before === file.contents) action = "skip";
      else action = "update";

      if (action !== "skip" && !ctx.dryRun) {
        ensureDir(dirname(file.path));
        writeFileSync(file.path, file.contents, "utf8");
        chmodSync(file.path, file.executable ? 0o755 : 0o644);
      }

      changes.push({
        platform: this.id,
        action,
        path: file.path,
        detail: `mimo-code plugin module (${this.hookDetail(ctx)})`,
      });
    }

    return changes;
  }

  /**
   * Human-facing summary of which declared events the synthesized module
   * ACTUALLY wires. Only events present in EVENT_TO_MIMOCODE are mapped/wired;
   * any declared event with no mapping is reported separately as "unsupported
   * here" so the detail never overstates coverage.
   */
  private hookDetail(ctx: InstallContext): string {
    const declared = ctx.connector.hookEvents;
    const mapped = declared.filter((e) => EVENT_TO_MIMOCODE[e] !== undefined);
    const unsupported = declared.filter((e) => EVENT_TO_MIMOCODE[e] === undefined);
    const base = mapped.join(",");
    return unsupported.length > 0
      ? `${base}; unsupported here: ${unsupported.join(",")}`
      : base;
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const pluginPath = this.getHookConfigPath(ctx);
    if (!existsSync(pluginPath)) {
      return [
        {
          platform: this.id,
          action: "skip",
          path: pluginPath,
          detail: "no mimo-code plugin module present",
        },
      ];
    }
    if (!ctx.dryRun) rmSync(pluginPath, { force: true });
    return [
      {
        platform: this.id,
        action: "remove",
        path: pluginPath,
        detail: "mimo-code plugin module",
      },
    ];
  }

  // ── Content surfaces: commands / skills / subagents ──────────────────────
  // CONTENT-ONLY: pure native-file writers under <mcDir>/{commands,skills,
  // agent}. No runtime dispatch, no home-bin pointer, no telemetry wrap. Each
  // method is idempotent (byte-identical → skip) and reversible. Mirrors
  // OpenCode's layout: commands/<name>.md, skills/<name>/SKILL.md, and the
  // SINGULAR agent/<name>.md dir for subagents. For project scope the content
  // root is <projectDir>/.mimocode (NOT the project root where mimocode.json
  // lives).

  private contentRootDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, `.${CONFIG_DIR_NAME}`)
      : this.getConfigDir(ctx);
  }
  private commandsDir(ctx: InstallContext): string {
    return join(this.contentRootDir(ctx), "commands");
  }
  private skillsDir(ctx: InstallContext): string {
    return join(this.contentRootDir(ctx), "skills");
  }
  private agentDir(ctx: InstallContext): string {
    return join(this.contentRootDir(ctx), "agent");
  }

  /** Native command file path: <mcDir>/commands/<name>.md. */
  private commandPath(ctx: InstallContext, name: string): string {
    return join(this.commandsDir(ctx), `${name}.md`);
  }
  /** Native skill dir: <mcDir>/skills/<name>. */
  private skillDir(ctx: InstallContext, name: string): string {
    return join(this.skillsDir(ctx), name);
  }
  /** Native subagent file path: <mcDir>/agent/<name>.md (SINGULAR dir). */
  private subagentPath(ctx: InstallContext, name: string): string {
    return join(this.agentDir(ctx), `${name}.md`);
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  override installCommands(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.commands === false) {
      return [{ platform: this.id, action: "skip", detail: "commands disabled for mimo-code" }];
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

  /** Render a command to md+frontmatter (description, model, subtask). */
  private renderCommand(cmd: CommandDef): string {
    const frontmatter: Record<string, unknown> = {};
    if (cmd.description !== undefined) frontmatter.description = cmd.description;
    if (cmd.model !== undefined) frontmatter.model = cmd.model;
    if (cmd.subtask !== undefined) frontmatter.subtask = cmd.subtask;
    if (cmd.extra) Object.assign(frontmatter, cmd.extra);
    return this.renderFrontmatterMd(frontmatter, cmd.prompt);
  }

  // ── Skills ────────────────────────────────────────────────────────────────

  override installSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.skills === false) {
      return [{ platform: this.id, action: "skip", detail: "skills disabled for mimo-code" }];
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

  /**
   * Render a skill's SKILL.md (UNIFORM across platforms): frontmatter
   * (name, description + optional model, allowed-tools, disable-model-invocation)
   * + markdown body.
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
      return [{ platform: this.id, action: "skip", detail: "subagents disabled for mimo-code" }];
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

  /**
   * Render a subagent to md+frontmatter (OpenCode's shape, inherited by
   * MiMoCode): (description, mode:"subagent", model, permission) with the system
   * prompt as the body. `name` comes from the filename. A readonly agent gets a
   * per-tool deny map (edit/bash) so it cannot mutate the workspace.
   */
  private renderSubagent(agent: SubagentDef): string {
    const frontmatter: Record<string, unknown> = {
      description: agent.description,
      mode: "subagent",
    };
    if (agent.model !== undefined) frontmatter.model = agent.model;
    if (agent.readonly === true) {
      frontmatter.permission = { edit: "deny", bash: "deny" };
    }
    if (agent.extra) Object.assign(frontmatter, agent.extra);
    return this.renderFrontmatterMd(frontmatter, agent.prompt);
  }

  // ── ts-plugin synthesis ────────────────────────────────────────────────

  /**
   * Build ONE self-contained ESM bridge module for MiMoCode. The module imports
   * nothing from agent-connector; it embeds the home-bin path + connector id and
   * a `bridge()` helper that shells out to the universal hook entrypoint
   * (`<homeBin> hook mimo-code <event> --connector <id>`), feeding the payload on
   * stdin and JSON.parsing the normalized HookResponse from stdout (fail-open).
   */
  synthesizePlugin(ctx: InstallContext): GeneratedPluginFile[] {
    const path = this.getHookConfigPath(ctx);
    const contents = this.buildPluginSource(ctx);
    return [{ path, contents, executable: false }];
  }

  /** Compose the generated plugin source with plain string concatenation. */
  private buildPluginSource(ctx: InstallContext): string {
    const homeBin = JSON.stringify(ctx.homeBinPath);
    const connectorId = JSON.stringify(ctx.connector.id);

    const events = ctx.connector.hookEvents.filter(
      (e): e is HookEventName => EVENT_TO_MIMOCODE[e] !== undefined,
    );
    const has = (e: HookEventName) => events.includes(e);

    const header = `/**
 * AUTO-GENERATED by agent-connector — DO NOT EDIT.
 *
 * Self-contained MiMoCode plugin bridge for connector ${ctx.connector.id}.
 * It imports nothing from agent-connector: every hook invocation shells out to
 * the stable home binary's universal entrypoint and JSON-parses the normalized
 * response. Fail-open: any bridge error degrades to "allow".
 */
import { execFileSync, execSync } from "node:child_process";

const HOME_BIN = ${homeBin};
const CONNECTOR_ID = ${connectorId};

/**
 * Invoke the universal hook entrypoint for one event.
 * @param {string} event canonical event name (PreToolUse|PostToolUse|SessionStart)
 * @param {object} payload MiMoCode-shaped payload posted on stdin
 * @returns {object|null} normalized HookResponse, or null on any failure
 */
function bridge(event, payload) {
  try {
    // On Windows HOME_BIN is the agent-connector.cmd launcher: Node cannot
    // execFile a batch file, and shell+args is deprecated (DEP0190), so run one
    // quoted command line via a shell. POSIX keeps the direct execFile (no shell).
    const args = ["hook", "mimo-code", event, "--connector", CONNECTOR_ID];
    const opts = { input: JSON.stringify(payload), encoding: "utf8" };
    const stdout =
      process.platform === "win32"
        ? execSync([HOME_BIN, ...args].map((a) => '"' + a + '"').join(" "), opts)
        : execFileSync(HOME_BIN, args, opts);
    const text = (stdout || "").trim();
    if (text === "") return { decision: "allow" };
    return JSON.parse(text);
  } catch {
    // Fail-open — never wedge a tool call on a bridge error.
    return null;
  }
}
`;

    const handlers: string[] = [];

    if (has("PreToolUse")) {
      handlers.push(`    // PreToolUse → block (throw) / rewrite args (mutate output.args).
    "tool.execute.before": async (input, output) => {
      const payload = {
        toolName: input.tool ?? "",
        toolInput: (output && output.args) ?? {},
        sessionId: input.sessionID ?? "",
        projectDir: PROJECT_DIR,
      };
      const res = bridge("PreToolUse", payload);
      if (!res) return;
      // MiMoCode has no "ask" gate — degrade "ask" to a block (safe direction).
      if (res.decision === "deny" || res.decision === "ask") {
        throw new Error(res.reason || "Blocked by ${ctx.connector.id}");
      }
      if (res.updatedInput && output && output.args) {
        Object.assign(output.args, res.updatedInput);
      }
    },`);
    }

    if (has("PostToolUse")) {
      handlers.push(`    // PostToolUse → observe / rewrite tool output (mutate output.output).
    "tool.execute.after": async (input, output) => {
      const payload = {
        toolName: input.tool ?? "",
        toolInput: input.args ?? {},
        toolOutput: output ? output.output : undefined,
        sessionId: input.sessionID ?? "",
        projectDir: PROJECT_DIR,
      };
      const res = bridge("PostToolUse", payload);
      if (!res) return;
      if (typeof res.updatedOutput === "string" && output) {
        output.output = res.updatedOutput;
      }
    },`);
    }

    if (has("SessionStart")) {
      handlers.push(`    // SessionStart surrogate → inject context into the system prompt.
    // MiMoCode has no real SessionStart hook (inherited from OpenCode
    // #14808 / #5409); experimental.chat.system.transform is the injection point.
    "experimental.chat.system.transform": async (input, output) => {
      const payload = {
        sessionId: (input && input.sessionID) ?? "",
        projectDir: PROJECT_DIR,
      };
      const res = bridge("SessionStart", payload);
      if (!res) return;
      if (res.additionalContext && output && Array.isArray(output.system)) {
        // Insert at index 1 (after the header) to preserve the prompt-cache
        // fold (header must remain system[0]).
        output.system.splice(1, 0, res.additionalContext);
      }
    },`);
    }

    const factory = `
export default async function (ctx) {
  // ctx.directory is the MiMoCode project root; fall back to cwd.
  const PROJECT_DIR =
    (ctx && (ctx.directory || (ctx.worktree && ctx.worktree.path))) ||
    process.cwd();

  return {
${handlers.join("\n")}
  };
}
`;

    return header + factory;
  }

  // ── Runtime: parse OUR bridge payload → normalized event ───────────────

  /**
   * `raw` is the payload OUR generated plugin posts (NOT a host-native shape):
   *   { toolName, toolInput, toolOutput?, isError?, sessionId, projectDir }
   * so this maps straight through.
   */
  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as MiMoCodeBridgePayload;
    const base = {
      hostPlatform: HOST,
      connectorId: "",
      sessionId: typeof input.sessionId === "string" ? input.sessionId : "",
      raw,
      ...(typeof input.projectDir === "string"
        ? { projectDir: input.projectDir }
        : {}),
    } as const;

    switch (event) {
      case "PreToolUse": {
        const ev: PreToolUseEvent = {
          ...base,
          toolName: input.toolName ?? "",
          toolInput: input.toolInput ?? {},
        };
        return ev;
      }
      case "PostToolUse": {
        const ev: PostToolUseEvent = {
          ...base,
          toolName: input.toolName ?? "",
          toolInput: input.toolInput ?? {},
          ...(typeof input.toolOutput === "string"
            ? { toolOutput: input.toolOutput }
            : {}),
          ...(typeof input.isError === "boolean"
            ? { isError: input.isError }
            : {}),
        };
        return ev;
      }
      case "SessionStart": {
        const ev: SessionStartEvent = { ...base, source: "startup" };
        return ev;
      }
      default:
        // Other canonical events are not surfaced by MiMoCode; treat as a
        // session-start-shaped no-op so the dispatcher fails open gracefully.
        return { ...base, source: "startup" } satisfies SessionStartEvent;
    }
  }

  // ── Runtime: normalized response → reply the generated bridge parses ───

  /**
   * Our generated bridge consumes this stdout directly, so the reply body is the
   * NORMALIZED HookResponse itself — the bridge JSON.parses it and reads
   * decision / updatedInput / updatedOutput / additionalContext.
   */
  formatReply(_event: HookEventName, response: HookResponse): HookReply {
    return {
      exitCode: 0,
      stdout: JSON.stringify(response ?? { decision: "allow" }),
    };
  }

  // ── Diagnostics ────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const serverPath = this.getServerConfigPath(ctx);
    const pluginPath = this.getHookConfigPath(ctx);
    const connectorId = ctx.connector.id;
    const hasHooks = ctx.connector.hookEvents.length > 0;

    const checks: HealthCheck[] = [
      {
        name: `${this.name}: mimocode.json present`,
        check: () =>
          existsSync(serverPath)
            ? { status: "OK", detail: serverPath }
            : { status: "FAIL", detail: `not found: ${serverPath}` },
      },
      {
        name: `${this.name}: mcp.${connectorId} registered`,
        check: () => {
          if (!ctx.connector.server) {
            return { status: "OK", detail: "no MCP server declared" };
          }
          const cfg = this.readJson<{ [k: string]: Record<string, unknown> }>(
            serverPath,
          );
          const bucket = cfg?.[MCP_ROOT_KEY];
          if (!cfg || !bucket) {
            return { status: "FAIL", detail: `no ${MCP_ROOT_KEY} in ${serverPath}` };
          }
          return connectorId in bucket
            ? { status: "OK", detail: `${MCP_ROOT_KEY}.${connectorId} present` }
            : {
                status: "FAIL",
                detail: `no ${MCP_ROOT_KEY}.${connectorId} in ${serverPath}`,
              };
        },
      },
      {
        name: `${this.name}: plugin module present`,
        check: () => {
          if (!hasHooks) return { status: "OK", detail: "no hooks declared" };
          return existsSync(pluginPath)
            ? { status: "OK", detail: pluginPath }
            : { status: "FAIL", detail: `not found: ${pluginPath}` };
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

  /** Read a file, returning undefined on any error (idempotency compare). */
  private safeRead(path: string): string | undefined {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  }
}

/** Create a directory (recursive) if it does not already exist. */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export const adapter = new MiMoCodeAdapter();
export default adapter;
