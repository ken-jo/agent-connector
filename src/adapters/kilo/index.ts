/**
 * adapters/kilo — Kilo Code (VS Code extension) platform adapter.
 *
 * Kilo Code (`kilocode.kilo-code`) is a Roo/Cline-fork VS Code extension — the
 * SAME lineage as the verified `roo-code` adapter — and an **mcp-only** host
 * from agent-connector's perspective: it exposes no lifecycle hook system, so
 * MCP server registration is the only thing we install and hooks are reported
 * unavailable. It is DISTINCT from the Kilo CLI (adapter id "kilo-cli", the
 * SQLite/OpenCode-similar command-line product); the two products carry
 * different platformIds so their config and usage never merge.
 *
 * MCP config (mirrors the Roo/Cline-fork pattern):
 *   - user scope    → <vscodeUserDir>/globalStorage/kilocode.kilo-code/
 *                     settings/mcp_settings.json
 *   - project scope → <projectDir>/.kilocode/mcp.json
 *   Both are JSON, root key "mcpServers".
 *
 * VS Code user-dir resolution (cross-OS):
 *   - macOS   → ~/Library/Application Support/Code/User
 *   - Linux   → ~/.config/Code/User
 *   - Windows → %APPDATA%/Code/User  (falls back to ~/AppData/Roaming/Code/User)
 *
 * NOTE (MEDIUM confidence): the exact user-scope MCP settings filename under the
 * `kilocode.kilo-code` globalStorage (`mcp_settings.json`) is inferred from the
 * Roo/Cline-fork lineage (Roo Code uses `cline_mcp_settings.json` in the same
 * spot). detectInstalled() PATH-PROBES the alternative Cline filename so a real
 * install is still detected, and the doctor warns to "verify for your Kilo
 * version". We never hard-fail on the filename.
 *
 * Env interpolation: Kilo Code's settings file documents no native `${env:VAR}`
 * token, so we resolve every `${env:VAR}` reference to a literal at install time
 * — the no-native-token path.
 *
 * The hook "config path" is the SAME MCP settings file (there is no hook file),
 * so the generic doctor/backup behave sensibly.
 *
 * Content surfaces (the `.kilocode/` dir is the extension's): Kilo Code authors
 * slash COMMANDS and SUBAGENTS natively but has NO Agent Skill (SKILL.md)
 * surface — skills inherit the BaseAdapter warn/skip. Commands are md+frontmatter
 * files under <projectDir>/.kilocode/commands (project) / <userConfigDir>/commands
 * (user); subagents are md+frontmatter files under .kilocode/agents. These are
 * pure file writers (no telemetry wrap, no home-bin pointer), idempotent on
 * byte-identical content, and removed on uninstall.
 */

import { existsSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
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
  shouldWrapForTelemetry,
} from "../../core/spawn.js";

const HOST: PlatformId = "kilo";
const MCP_ROOT_KEY = "mcpServers";

/** Kilo Code extension id → its VS Code globalStorage folder. */
const KILO_EXTENSION_ID = "kilocode.kilo-code";
/**
 * User-scope MCP settings filename (MEDIUM confidence — inferred from the
 * Roo/Cline-fork lineage). The Cline-family alternative is probed during
 * detection so a real install is still found.
 */
const MCP_SETTINGS_FILE = "mcp_settings.json";
const CLINE_SETTINGS_FILE = "cline_mcp_settings.json";

/**
 * Native MCP server entry shapes Kilo Code accepts under `mcpServers` (same as
 * the Roo/Cline fork family). We write the minimal stdio shape
 * { command, args, env, disabled }.
 */
interface KiloStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled: boolean;
}
interface KiloHttpServer {
  url: string;
  headers?: Record<string, string>;
  disabled: boolean;
}

/**
 * Resolve the cross-OS VS Code per-user data directory (the "User" folder that
 * contains `globalStorage`). See module header for the per-platform mapping.
 */
function vscodeUserDir(): string {
  const home = homedir();
  switch (osPlatform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "Code", "User");
    case "win32": {
      const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
      return join(appData, "Code", "User");
    }
    default:
      // Linux / other POSIX: XDG-style config dir.
      return join(home, ".config", "Code", "User");
  }
}

export class KiloAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Kilo Code";
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    // Kilo Code has no lifecycle hook system — every hook capability is false.
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
    // Kilo Code registers stdio, SSE, and Streamable HTTP MCP servers.
    transports: ["stdio", "sse", "http"],
    // Content surfaces: Kilo Code authors slash commands and subagents natively,
    // but has NO Agent Skill (SKILL.md) surface — skills inherit the BaseAdapter
    // warn/skip. Both surfaces live under the extension's .kilocode/ dir.
    supportsCommands: true,
    supportsSkills: false,
    supportsSubagents: true,
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userSettings = this.userSettingsPath();
    const userExtDir = join(vscodeUserDir(), "globalStorage", KILO_EXTENSION_ID);
    // Probe the Cline-family alternative filename too (the user-scope MCP
    // filename is MEDIUM confidence; never hard-fail on the inferred name).
    const userClineSettings = join(userExtDir, "settings", CLINE_SETTINGS_FILE);
    const projectMcp = join(projectDir, ".kilocode", "mcp.json");

    const userMatch =
      existsSync(userSettings) || existsSync(userClineSettings) || existsSync(userExtDir);
    const projectMatch = existsSync(projectMcp);
    const installed = userMatch || projectMatch;

    // Prefer the user scope/path when present; otherwise surface the project one.
    const scope = userMatch || !projectMatch ? "user" : "project";
    const configPath = scope === "user" ? userSettings : projectMcp;
    const reason = installed
      ? userMatch
        ? `found Kilo Code globalStorage under ${userExtDir}`
        : `found Kilo Code project config at ${projectMcp}`
      : `no Kilo Code config at ${userExtDir} or ${projectMcp}`;

    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath,
      scope,
      reason,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  /** Absolute path to the user-scope MCP settings file (VS Code globalStorage). */
  private userSettingsPath(): string {
    return join(
      vscodeUserDir(),
      "globalStorage",
      KILO_EXTENSION_ID,
      "settings",
      MCP_SETTINGS_FILE,
    );
  }

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".kilocode")
      : join(vscodeUserDir(), "globalStorage", KILO_EXTENSION_ID, "settings");
  }

  getServerConfigPath(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".kilocode", "mcp.json")
      : this.userSettingsPath();
  }

  /**
   * Kilo Code has no hook file — hooks are not a thing here. The hook "config
   * path" is the same MCP settings file so the generic doctor/backup behave
   * sensibly.
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

  /** Render a normalized ServerDef into Kilo Code's native mcpServers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): KiloStdioServer | KiloHttpServer {
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

      // Kilo Code documents no native interpolation token, so resolve every
      // ${env:VAR} to a literal at install time.
      const entry: KiloStdioServer = {
        command: resolveEnvRefsDeep(command),
        // Honor the per-call server's enabled flag (mirror roo-code) rather than
        // hardcoding enabled — a server marked enabled:false installs disabled.
        disabled: server.enabled === false,
      };
      if (args.length > 0) entry.args = resolveEnvRefsDeep(args);
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      return entry;
    }

    // sse / http (and any other remote transport) — Kilo Code registers a URL.
    const entry: KiloHttpServer = {
      url: resolveEnvRefsDeep(server.url ?? ""),
      disabled: server.enabled === false,
    };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Kilo Code documents no native interpolation token,
   * so resolve `${env:VAR}` references to literals at install time.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Hooks (unavailable — Kilo Code is mcp-only) ──────────────────────────

  installHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Kilo Code is mcp-only)",
      },
    ];
  }

  uninstallHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Kilo Code is mcp-only)",
      },
    ];
  }

  // ── Content surfaces: commands / subagents (NO skills) ───────────────────
  // CONTENT-ONLY: pure native-file writers. No runtime dispatch, no home-bin
  // pointer, no telemetry wrap. Each method is idempotent (byte-identical →
  // skip) via BaseAdapter.writeContentFile and reversible via removeContentFile.
  // Honors platforms["kilo"] per-surface false to skip. Kilo Code has NO
  // SKILL.md surface, so skills inherit BaseAdapter's warn/skip default.
  //
  // NOTE on dirs: the .kilocode/ tree is the extension's. Commands live under
  // .kilocode/commands (project) / <userConfigDir>/commands (user); subagents
  // live under .kilocode/agents (project) / <userConfigDir>/agents (user).

  /** Commands root: project → <projectDir>/.kilocode/commands; user → <configDir>/commands. */
  private commandsDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".kilocode", "commands")
      : join(this.getConfigDir(ctx), "commands");
  }
  /** Subagents root: project → <projectDir>/.kilocode/agents; user → <configDir>/agents. */
  private agentsDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".kilocode", "agents")
      : join(this.getConfigDir(ctx), "agents");
  }

  /** Native command file path: <commandsDir>/<name>.md. */
  private commandPath(ctx: InstallContext, name: string): string {
    return join(this.commandsDir(ctx), `${name}.md`);
  }
  /** Native subagent file path: <agentsDir>/<name>.md. */
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
   * Render a subagent to md+frontmatter. Kilo Code's shape is
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
    const mcpPath = this.getServerConfigPath(ctx);
    const connectorId = ctx.connector.id;
    const checks: HealthCheck[] = [
      {
        name: `${this.name}: MCP settings present`,
        check: () =>
          existsSync(mcpPath)
            ? { status: "OK", detail: mcpPath }
            : { status: "FAIL", detail: `not found: ${mcpPath}` },
      },
      {
        // MEDIUM-confidence path probe: the user-scope MCP settings filename
        // (mcp_settings.json) is inferred from the Roo/Cline-fork lineage. Surface
        // a non-fatal note so the operator can verify it for their Kilo version.
        name: `${this.name}: verify MCP settings filename for your Kilo version`,
        check: () => ({
          status: "OK",
          detail:
            ctx.scope === "user"
              ? `using ${MCP_SETTINGS_FILE} under ${KILO_EXTENSION_ID} globalStorage (verify for your Kilo version)`
              : "project scope uses .kilocode/mcp.json",
        }),
      },
      {
        name: `${this.name}: server entry registered`,
        check: () => {
          const cfg = this.readJson<{ [k: string]: Record<string, unknown> }>(mcpPath);
          const bucket = cfg?.[MCP_ROOT_KEY];
          if (!cfg || !bucket) {
            return { status: "FAIL", detail: `no ${MCP_ROOT_KEY} in ${mcpPath}` };
          }
          return connectorId in bucket
            ? { status: "OK", detail: `${MCP_ROOT_KEY}.${connectorId} present` }
            : {
                status: "FAIL",
                detail: `no ${MCP_ROOT_KEY}.${connectorId} in ${mcpPath}`,
              };
        },
      },
    ];

    // Content-surface checks: only assert presence of the files this connector
    // declares (skills are unsupported on Kilo Code, so none are asserted here).
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
