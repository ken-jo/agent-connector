/**
 * adapters/kilo — Kilo Code (Kilo Org) platform adapter for agent-connector.
 *
 * Kilo is treated as an **mcp-only** host today. Kilo ships two config
 * generations and has NO programmatic lifecycle hooks yet — session/lifecycle
 * hooks are an open feature request (report §2 / §7 item 2). Until that lands,
 * this adapter registers only the MCP server and reports hooks as unavailable;
 * it never synthesizes a plugin (no JS plugin runtime exists in Kilo).
 *
 * MCP config — the NEW generation (report §2):
 *   - user scope    → ~/.config/kilo/kilo.jsonc
 *   - project scope → <projectDir>/.kilo/kilo.jsonc   (project overrides global)
 *   Both are JSON/JSONC; we write plain JSON, which is valid JSONC. The root key
 *   is "mcp" (NOT the legacy "mcpServers"), and that same file is also the hook
 *   "config path" so the generic doctor/backup behave sensibly — there is no
 *   separate hook file because there are no hooks.
 *
 * Server entry shape (mirrors OpenCode's new-gen dialect):
 *   - stdio  → { type: "local",  command: [exe, ...args], environment: {...} }
 *              NOTE the command is a single ARRAY (exe + args together), unlike
 *              Claude/Cursor's scalar `command` + `args[]` split.
 *   - remote → { type: "remote", url }
 *
 * Kilo documents no native `${env:VAR}` interpolation token, so env/url refs are
 * resolved to literals at install time (the no-native-token path).
 *
 * Content surfaces (report §4-5): Kilo authors slash COMMANDS and SUBAGENTS
 * natively but has NO Agent Skill (SKILL.md) surface — skills inherit the
 * BaseAdapter warn/skip. Commands are md+frontmatter files under
 * .kilocode/commands (project) / <userConfigDir>/commands (user); subagents are
 * md+frontmatter files under the existing Kilo config dir's agents/. These are
 * pure file writers (no telemetry wrap, no home-bin pointer), idempotent on
 * byte-identical content, and removed on uninstall.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { BaseAdapter } from "../base.js";
import type { Adapter, InstallContext } from "../spi.js";
import type {
  ChangeRecord,
  CommandDef,
  DetectedPlatform,
  HealthCheck,
  HookParadigm,
  PlatformCapabilities,
  PlatformId,
  ServerDef,
  SubagentDef,
  Transport,
} from "../../core/types.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  buildServeWrapperCommand,
  isHomeBinHookCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";

const HOST: PlatformId = "kilo";
/** New-generation root key for MCP servers — "mcp", not the legacy "mcpServers". */
const MCP_ROOT_KEY = "mcp";
/** New-generation config filename (JSON/JSONC). */
const CONFIG_FILE = "kilo.jsonc";

/**
 * Native MCP server entry shapes Kilo's new-gen config accepts under `mcp`.
 * QUIRK: a local (stdio) server keys its whole invocation as `command: [...]`
 * — a single array of [executable, ...args] — and env as `environment`.
 */
interface KiloLocalServer {
  type: "local";
  command: string[];
  environment?: Record<string, string>;
}
interface KiloRemoteServer {
  type: "remote";
  url: string;
}

export class KiloAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Kilo Code";
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    // Kilo has no programmatic lifecycle hooks yet (open FR) — every hook
    // capability is false until that surface ships.
    preToolUse: false,
    postToolUse: false,
    preCompact: false,
    sessionStart: false,
    sessionEnd: false,
    userPromptSubmit: false,
    stop: false,
    notification: false,
    canModifyArgs: false,
    canModifyOutput: false,
    canInjectSessionContext: false,
    // Kilo registers stdio (local), SSE, and Streamable HTTP MCP servers.
    transports: ["stdio", "sse", "http"],
    // Content surfaces: Kilo authors slash commands and subagents natively, but
    // has NO Agent Skill (SKILL.md) surface — skills inherit the BaseAdapter
    // warn/skip. Commands live under .kilocode/commands; subagents under the
    // existing Kilo config dir's agents/.
    supportsCommands: true,
    supportsSkills: false,
    supportsSubagents: true,
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".config", "kilo");
    const userConfig = join(userDir, CONFIG_FILE);
    const projectConfig = join(projectDir, ".kilo", CONFIG_FILE);
    const userInstalled = existsSync(userDir);
    const projInstalled = existsSync(projectConfig);
    const installed = userInstalled || projInstalled;
    // Report the scope/path/reason for the marker that actually matched, so a
    // project-only install isn't misreported as a (non-existent) user install.
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
          ? `found project Kilo Code config at ${projectConfig}`
          : `found Kilo Code config under ${userDir}`
        : `no Kilo Code config at ${userDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".kilo")
      : join(homedir(), ".config", "kilo");
  }

  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), CONFIG_FILE);
  }

  /**
   * Kilo has no hook file — hooks are not a thing here yet. The hook "config
   * path" is the same kilo.jsonc so the generic doctor/backup behave sensibly.
   */
  getHookConfigPath(ctx: InstallContext): string {
    return this.getServerConfigPath(ctx);
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
            ? "server registration disabled for kilo"
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

  /** Render a normalized ServerDef into Kilo's new-gen `mcp` entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): KiloLocalServer | KiloRemoteServer {
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
        );
        command = wrapped.command;
        args = wrapped.args;
      }

      // QUIRK: Kilo's new-gen local server keys its whole invocation as a single
      // `command` ARRAY (executable + args together), like OpenCode. Kilo has no
      // documented native interpolation token, so resolve every ${env:VAR} to a
      // literal at install time.
      const entry: KiloLocalServer = {
        type: "local",
        command: resolveEnvRefsDeep([command, ...args]),
      };
      const env = this.renderEnv(server.env);
      if (env) entry.environment = env;
      return entry;
    }

    // sse / http (and any other remote transport) — Kilo registers a URL.
    const entry: KiloRemoteServer = {
      type: "remote",
      url: resolveEnvRefsDeep(server.url ?? ""),
    };
    return entry;
  }

  /**
   * Render env values. Kilo documents no native interpolation token, so resolve
   * `${env:VAR}` references to literals at install time.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Hooks (unavailable — Kilo has no lifecycle hooks yet) ─────────────────

  installHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Kilo has no lifecycle hooks yet)",
      },
    ];
  }

  uninstallHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Kilo has no lifecycle hooks yet)",
      },
    ];
  }

  /**
   * True when a hook command references our home binary AND this connector id
   * (anchored so a shared-prefix id can't collide — see isHomeBinHookCommand).
   * Kilo installs no hooks, but this guard keeps any future shared-file edit
   * from removing another connector's entries.
   */
  private isOurCommand(command: string | undefined, ctx: InstallContext): boolean {
    return isHomeBinHookCommand(command, ctx.homeBinPath, ctx.connector.id);
  }

  // ── Content surfaces: commands / subagents (NO skills) ───────────────────
  // CONTENT-ONLY: pure native-file writers. No runtime dispatch, no home-bin
  // pointer, no telemetry wrap. Each method is idempotent (byte-identical →
  // skip) via BaseAdapter.writeContentFile and reversible via removeContentFile.
  // Honors platforms["kilo"] per-surface false to skip. Kilo has NO SKILL.md
  // surface, so skills inherit BaseAdapter's warn/skip default.
  //
  // NOTE on dirs: Kilo slash commands live under .kilocode/commands (project)
  // or the user Kilo config dir's commands/ — a SEPARATE root from the MCP
  // config dir (.kilo | ~/.config/kilo). Subagents reuse the existing config
  // dir (getConfigDir) under agents/.

  /** Commands root: project → <projectDir>/.kilocode/commands; user → <configDir>/commands. */
  private commandsDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".kilocode", "commands")
      : join(this.getConfigDir(ctx), "commands");
  }
  /** Subagents dir reuses the existing Kilo config dir: <configDir>/agents. */
  private agentsDir(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "agents");
  }

  /** Native command file path: <commandsDir>/<name>.md. */
  private commandPath(ctx: InstallContext, name: string): string {
    return join(this.commandsDir(ctx), `${name}.md`);
  }
  /** Native subagent file path: <configDir>/agents/<name>.md. */
  private subagentPath(ctx: InstallContext, name: string): string {
    return join(this.agentsDir(ctx), `${name}.md`);
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  override installCommands(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.commands === false) {
      return [{ platform: this.id, action: "skip", detail: "commands disabled for kilo" }];
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

  /** Render a command to md+frontmatter (description, argument-hint, mode, model). */
  private renderCommand(cmd: CommandDef): string {
    const frontmatter: Record<string, unknown> = {};
    if (cmd.description !== undefined) frontmatter.description = cmd.description;
    if (cmd.argumentHint !== undefined) frontmatter["argument-hint"] = cmd.argumentHint;
    // `mode` is not a core CommandDef field; it arrives via `extra` (escape
    // hatch) so a connector can pin a specific Kilo mode. Merged below.
    if (cmd.model !== undefined) frontmatter.model = cmd.model;
    if (cmd.extra) Object.assign(frontmatter, cmd.extra);
    return this.renderFrontmatterMd(frontmatter, cmd.prompt);
  }

  // ── Subagents ───────────────────────────────────────────────────────────────

  override installSubagents(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.subagents === false) {
      return [{ platform: this.id, action: "skip", detail: "subagents disabled for kilo" }];
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
   * Render a subagent to md+frontmatter. Kilo's shape is
   * (description, mode:"subagent", model, permission) with the system prompt as
   * the body. `name` is NOT a frontmatter field — it comes from the filename.
   * `permission` is derived from the coarse `readonly` knob: a readonly agent
   * gets a per-tool deny map (edit/bash) so it cannot mutate the workspace.
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

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const configPath = this.getServerConfigPath(ctx);
    const connectorId = ctx.connector.id;
    const checks: HealthCheck[] = [
      {
        name: `${this.name}: ${CONFIG_FILE} present`,
        check: () =>
          existsSync(configPath)
            ? { status: "OK", detail: configPath }
            : { status: "FAIL", detail: `not found: ${configPath}` },
      },
      {
        name: `${this.name}: server entry registered`,
        check: () => {
          const cfg = this.readJson<{ [k: string]: Record<string, unknown> }>(configPath);
          const bucket = cfg?.[MCP_ROOT_KEY];
          if (!cfg || !bucket) {
            return { status: "FAIL", detail: `no ${MCP_ROOT_KEY} in ${configPath}` };
          }
          return connectorId in bucket
            ? { status: "OK", detail: `${MCP_ROOT_KEY}.${connectorId} present` }
            : {
                status: "FAIL",
                detail: `no ${MCP_ROOT_KEY}.${connectorId} in ${configPath}`,
              };
        },
      },
    ];

    // Content-surface checks: only assert presence of the files this connector
    // declares (skills are unsupported on Kilo, so none are asserted here).
    for (const cmd of ctx.connector.commands) {
      const p = this.commandPath(ctx, cmd.name);
      checks.push({
        name: `${this.name}: command ${cmd.name} present`,
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
}

export const adapter = new KiloAdapter();
export default adapter;
