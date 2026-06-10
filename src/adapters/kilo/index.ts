/**
 * adapters/kilo — Kilo Code (VS Code extension) platform adapter.
 *
 * Kilo Code (`kilocode.kilo-code`) is a Roo/Cline-fork VS Code extension, but as
 * of vsix 7.3.28 it DELEGATES MCP to the shared kilo backend — the SAME backend
 * the Kilo CLI (adapter id "kilo-cli") drives. It is an **mcp-only** host from
 * agentconnect's perspective: it exposes no lifecycle hook system, so MCP
 * server registration is the only thing we install and hooks are reported
 * unavailable.
 *
 * MCP config (vsix 7.3.28 — delegated to the kilo backend):
 *   - user scope    → ~/.config/kilo/kilo.json   (XDG: $XDG_CONFIG_HOME/kilo)
 *   - project scope → <projectDir>/.kilo/kilo.json
 *   Both are JSON, root key **"mcp"**, entry shape
 *     { type:"local", command:[exe,...args], environment:{} }  (array command).
 *   The legacy globalStorage `<vscodeUserDir>/globalStorage/kilocode.kilo-code/
 *   settings/mcp_settings.json` (root "mcpServers") is MIGRATION-ONLY in 7.3.28
 *   and is no longer the live write target — detectInstalled() still probes it so
 *   an older install is recognized, but we install into kilo.json.
 *
 * COLLISION NOTE (kilo ext vs kilo-cli): both now share the SAME backend dir
 * `~/.config/kilo` AND the SAME root key `"mcp"`, but DIFFERENT filenames — the
 * VS Code extension writes **kilo.json**, the CLI writes **kilo.jsonc** (and the
 * CLI additionally carries a `plugin` array; the ext does not). They are kept
 * distinct platformIds with distinct files; their MCP dialect is now shared but
 * their config files never merge.
 *
 * Env interpolation: kilo.json documents no native `${env:VAR}` token, so we
 * resolve every `${env:VAR}` reference to a literal at install time — the
 * no-native-token path.
 *
 * The hook "config path" is the SAME kilo.json file (there is no hook file), so
 * the generic doctor/backup behave sensibly.
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
/** vsix 7.3.28 root key in kilo.json (delegated kilo backend). */
const MCP_ROOT_KEY = "mcp";
/** Live config filename for the VS Code ext (DISTINCT from the CLI's kilo.jsonc). */
const CONFIG_FILE = "kilo.json";

/** Kilo Code extension id → its (legacy, migration-only) VS Code globalStorage folder. */
const KILO_EXTENSION_ID = "kilocode.kilo-code";
/**
 * Legacy globalStorage MCP settings filenames (MIGRATION-ONLY in 7.3.28). The
 * Cline-family alternative is probed during detection so an older install is
 * still recognized; we no longer WRITE there.
 */
const LEGACY_MCP_SETTINGS_FILE = "mcp_settings.json";
const LEGACY_CLINE_SETTINGS_FILE = "cline_mcp_settings.json";

/**
 * Native MCP server entry shapes kilo.json accepts under `mcp` (the delegated
 * kilo backend). Local (stdio) servers use a SINGLE array command that folds the
 * executable and its args together; env lives under `environment`.
 */
interface KiloLocalServer {
  type: "local";
  command: string[];
  environment: Record<string, string>;
}
interface KiloRemoteServer {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
}

/**
 * Resolve the kilo backend user config dir: `$XDG_CONFIG_HOME/kilo` when set,
 * else `~/.config/kilo`. This is the SAME backend dir kilo-cli uses (the two
 * differ only by filename — kilo.json here vs kilo.jsonc for the CLI).
 */
function kiloConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base =
    xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".config");
  return join(base, "kilo");
}

/**
 * Resolve the cross-OS VS Code per-user data directory (the "User" folder that
 * contains `globalStorage`) — used ONLY to probe the legacy migration-only MCP
 * settings file during detection. See module header for the per-platform mapping.
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
    const userConfig = this.userConfigPath();
    const userBackendDir = kiloConfigDir();
    // Probe the legacy (migration-only) globalStorage MCP settings too so an
    // older install is still recognized; we never WRITE there anymore.
    const legacyExtDir = join(vscodeUserDir(), "globalStorage", KILO_EXTENSION_ID);
    const legacySettings = join(legacyExtDir, "settings", LEGACY_MCP_SETTINGS_FILE);
    const legacyClineSettings = join(
      legacyExtDir,
      "settings",
      LEGACY_CLINE_SETTINGS_FILE,
    );
    const projectConfig = join(projectDir, ".kilo", CONFIG_FILE);

    const userMatch =
      existsSync(userConfig) ||
      existsSync(userBackendDir) ||
      existsSync(legacySettings) ||
      existsSync(legacyClineSettings) ||
      existsSync(legacyExtDir);
    const projectMatch = existsSync(projectConfig);
    const installed = userMatch || projectMatch;

    // Prefer the user scope/path when present; otherwise surface the project one.
    const scope = userMatch || !projectMatch ? "user" : "project";
    const configPath = scope === "user" ? userConfig : projectConfig;
    const reason = installed
      ? userMatch
        ? `found Kilo Code config under ${userBackendDir}`
        : `found Kilo Code project config at ${projectConfig}`
      : `no Kilo Code config at ${userBackendDir} or ${projectConfig}`;

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

  /** Absolute path to the user-scope kilo.json (kilo backend, XDG dir). */
  private userConfigPath(): string {
    return join(kiloConfigDir(), CONFIG_FILE);
  }

  /**
   * MCP config dir. Note the project surface is `.kilo/` (kilo backend), NOT the
   * extension's `.kilocode/` content tree (which still hosts commands/subagents).
   */
  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".kilo")
      : kiloConfigDir();
  }

  getServerConfigPath(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".kilo", CONFIG_FILE)
      : this.userConfigPath();
  }

  /**
   * Kilo Code has no hook file — hooks are not a thing here. The hook "config
   * path" is the same kilo.json so the generic doctor/backup behave sensibly.
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

  /**
   * Render a normalized ServerDef into kilo.json's native `mcp` entry. Local
   * (stdio) servers fold the executable + args into a SINGLE `command` array and
   * carry env under `environment`; remote servers use a `type:"remote"` URL entry.
   */
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
          ctx.scope,
          this.id,
        );
        command = wrapped.command;
        args = wrapped.args;
      }

      // kilo.json documents no native interpolation token, so resolve every
      // ${env:VAR} to a literal at install time. The command + args fold into a
      // single array (exe first), matching the kilo backend's `command` shape.
      const argv: string[] = [
        resolveEnvRefsDeep(command),
        ...resolveEnvRefsDeep(args),
      ];
      const entry: KiloLocalServer = {
        type: "local",
        command: argv,
        environment: this.renderEnv(server.env) ?? {},
      };
      return entry;
    }

    // sse / http (and any other remote transport) — kilo registers a remote URL.
    const entry: KiloRemoteServer = {
      type: "remote",
      url: resolveEnvRefsDeep(server.url ?? ""),
    };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. kilo.json documents no native interpolation token,
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
  // NOTE on dirs: the .kilocode/ tree is the EXTENSION's content surface — kept
  // SEPARATE from the MCP backend dir (~/.config/kilo). Commands live under
  // .kilocode/commands (project) / ~/.kilocode/commands (user); subagents live
  // under .kilocode/agents (project) / ~/.kilocode/agents (user).

  /** The extension's user-scope content home (~/.kilocode), distinct from the MCP backend dir. */
  private userContentDir(): string {
    return join(homedir(), ".kilocode");
  }

  /** Commands root: project → <projectDir>/.kilocode/commands; user → ~/.kilocode/commands. */
  private commandsDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".kilocode", "commands")
      : join(this.userContentDir(), "commands");
  }
  /** Subagents root: project → <projectDir>/.kilocode/agents; user → ~/.kilocode/agents. */
  private agentsDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".kilocode", "agents")
      : join(this.userContentDir(), "agents");
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
        name: `${this.name}: kilo.json present`,
        check: () =>
          existsSync(mcpPath)
            ? { status: "OK", detail: mcpPath }
            : { status: "FAIL", detail: `not found: ${mcpPath}` },
      },
      {
        // Non-fatal note: the live MCP target is the delegated kilo backend
        // (kilo.json under ~/.config/kilo). The legacy globalStorage
        // mcp_settings.json is migration-only and is no longer written.
        name: `${this.name}: MCP delegated to kilo backend`,
        check: () => ({
          status: "OK",
          detail:
            ctx.scope === "user"
              ? `using ${CONFIG_FILE} under ${kiloConfigDir()} (legacy globalStorage is migration-only)`
              : `project scope uses .kilo/${CONFIG_FILE}`,
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
