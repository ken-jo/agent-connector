/**
 * adapters/kilo-cli — Kilo CLI platform adapter for agent-connector.
 *
 * The Kilo CLI is the SQLite-backed, OpenCode-similar command-line product
 * (storage `~/.local/share/kilo/kilo.db`). It is DISTINCT from the Kilo Code
 * VS Code extension (adapter id "kilo", a Roo/Cline fork) — the two products
 * carry different platformIds so their config and usage never merge. This
 * adapter implements ONLY the CLI's MCP config surface.
 *
 * The Kilo CLI is an **mcp-only** host: it has NO programmatic lifecycle hooks
 * (session/lifecycle hooks are an open feature request) and no JS plugin
 * runtime, so this adapter registers only the MCP server and reports hooks as
 * unavailable; it never synthesizes a plugin.
 *
 * MCP config (the CLI's new-gen dialect):
 *   - user scope    → ~/.config/kilo/kilo.jsonc
 *   - project scope → <projectDir>/.kilo/kilo.jsonc   (project overrides global)
 *   Both are JSON/JSONC; we write plain JSON, which is valid JSONC. The root key
 *   is "mcp" (NOT the extension's "mcpServers"), and that same file is also the
 *   hook "config path" so the generic doctor/backup behave sensibly — there is
 *   no separate hook file because there are no hooks.
 *
 * Server entry shape (mirrors OpenCode's new-gen dialect):
 *   - stdio  → { type: "local",  command: [exe, ...args], environment: {...} }
 *              NOTE the command is a single ARRAY (exe + args together), unlike
 *              Claude/Cursor's scalar `command` + `args[]` split.
 *   - remote → { type: "remote", url }
 *
 * The Kilo CLI documents no native `${env:VAR}` interpolation token, so env/url
 * refs are resolved to literals at install time (the no-native-token path).
 *
 * Content surfaces: the Kilo CLI exposes no confirmed writable command/skill/
 * subagent dir (the `.kilocode/` tree belongs to the VS Code extension, served
 * by the "kilo" adapter), so this adapter is MCP-only and inherits the
 * BaseAdapter warn/skip for every content surface.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { BaseAdapter } from "../base.js";
import type { Adapter, InstallContext } from "../spi.js";
import type {
  ChangeRecord,
  DetectedPlatform,
  HealthCheck,
  HookParadigm,
  PlatformCapabilities,
  PlatformId,
  ServerDef,
  Transport,
} from "../../core/types.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  buildServeWrapperCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";

const HOST: PlatformId = "kilo-cli";
/** New-generation root key for MCP servers — "mcp", not the extension's "mcpServers". */
const MCP_ROOT_KEY = "mcp";
/** New-generation config filename (JSON/JSONC). */
const CONFIG_FILE = "kilo.jsonc";
/** The Kilo CLI's SQLite session store — a CLI-exclusive detection marker. */
const CLI_DB_RELPATH = [".local", "share", "kilo", "kilo.db"] as const;

/**
 * Native MCP server entry shapes the Kilo CLI's new-gen config accepts under
 * `mcp`. QUIRK: a local (stdio) server keys its whole invocation as
 * `command: [...]` — a single array of [executable, ...args] — and env as
 * `environment`.
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

export class KiloCliAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Kilo CLI";
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    // The Kilo CLI has no programmatic lifecycle hooks yet (open FR) — every
    // hook capability is false until that surface ships.
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
    // The Kilo CLI registers stdio (local), SSE, and Streamable HTTP MCP servers.
    transports: ["stdio", "sse", "http"],
    // No confirmed CLI content surface — these inherit the BaseAdapter warn/skip.
    supportsCommands: false,
    supportsSkills: false,
    supportsSubagents: false,
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".config", "kilo");
    const userConfig = join(userDir, CONFIG_FILE);
    const projectConfig = join(projectDir, ".kilo", CONFIG_FILE);
    // The SQLite session DB is a CLI-exclusive marker (the VS Code extension
    // never writes it), so it disambiguates the CLI from the "kilo" extension
    // even when neither writes a kilo.jsonc yet.
    const cliDb = join(homedir(), ...CLI_DB_RELPATH);
    const userInstalled = existsSync(userDir) || existsSync(cliDb);
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
          ? `found project Kilo CLI config at ${projectConfig}`
          : existsSync(cliDb)
            ? `found Kilo CLI session store at ${cliDb}`
            : `found Kilo CLI config under ${userDir}`
        : `no Kilo CLI config at ${userDir} or session store at ${cliDb}`,
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
   * The Kilo CLI has no hook file — hooks are not a thing here yet. The hook
   * "config path" is the same kilo.jsonc so the generic doctor/backup behave
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
            ? "server registration disabled for kilo-cli"
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

  /** Render a normalized ServerDef into the Kilo CLI's new-gen `mcp` entry. */
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
        );
        command = wrapped.command;
        args = wrapped.args;
      }

      // QUIRK: the Kilo CLI's new-gen local server keys its whole invocation as
      // a single `command` ARRAY (executable + args together), like OpenCode.
      // The CLI has no documented native interpolation token, so resolve every
      // ${env:VAR} to a literal at install time.
      const entry: KiloLocalServer = {
        type: "local",
        command: resolveEnvRefsDeep([command, ...args]),
      };
      const env = this.renderEnv(server.env);
      if (env) entry.environment = env;
      return entry;
    }

    // sse / http (and any other remote transport) — the Kilo CLI registers a URL.
    const entry: KiloRemoteServer = {
      type: "remote",
      url: resolveEnvRefsDeep(server.url ?? ""),
    };
    return entry;
  }

  /**
   * Render env values. The Kilo CLI documents no native interpolation token, so
   * resolve `${env:VAR}` references to literals at install time.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Hooks (unavailable — the Kilo CLI has no lifecycle hooks yet) ─────────

  installHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Kilo CLI has no lifecycle hooks yet)",
      },
    ];
  }

  uninstallHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Kilo CLI has no lifecycle hooks yet)",
      },
    ];
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const configPath = this.getServerConfigPath(ctx);
    const connectorId = ctx.connector.id;
    return [
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
  }
}

export const adapter = new KiloCliAdapter();
export default adapter;
