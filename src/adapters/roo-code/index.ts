/**
 * adapters/roo-code — Roo Code (VS Code extension) platform adapter.
 *
 * Roo Code (rooveterinaryinc.roo-cline) is a Cline-fork VS Code extension and an
 * **mcp-only** host from agent-connector's perspective: it exposes no lifecycle
 * hook system, so MCP server registration is the only thing we install and hooks
 * are reported unavailable. This mirrors the Warp reference adapter exactly.
 *
 * MCP config (vsix 3.54.0):
 *   - user scope    → <vscodeUserDir>/globalStorage/rooveterinaryinc.roo-cline/
 *                     settings/mcp_settings.json   (renamed in 3.54.0 from the
 *                     older `cline_mcp_settings.json`; we PROBE both on detection
 *                     — the extension migrates the old name at startup — and
 *                     WRITE the new `mcp_settings.json`)
 *   - project scope → <projectDir>/.roo/mcp.json
 *   Both are JSON, root key "mcpServers".
 *
 * VS Code user-dir resolution (cross-OS):
 *   - macOS   → ~/Library/Application Support/Code/User
 *   - Linux   → ~/.config/Code/User
 *   - Windows → %APPDATA%/Code/User  (falls back to ~/AppData/Roaming/Code/User)
 *   We deliberately target stable VS Code ("Code"), the documented home for the
 *   published Roo Code extension's globalStorage. Insiders/forks would live under
 *   a sibling dir but are out of scope for the default path.
 *
 * Env interpolation: Roo Code's settings file documents no native `${env:VAR}`
 * token (the entries are plain command/args/env literals), so we resolve every
 * `${env:VAR}` reference to a literal at install time — the no-native-token path.
 *
 * The hook "config path" is the SAME MCP settings file (there is no hook file),
 * so the generic doctor/backup behave sensibly.
 */

import { existsSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
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

const HOST: PlatformId = "roo-code";
const MCP_ROOT_KEY = "mcpServers";

/** Roo Code extension id → its VS Code globalStorage folder. */
const ROO_EXTENSION_ID = "rooveterinaryinc.roo-cline";
/** User-scope MCP settings filename — renamed in vsix 3.54.0. */
const MCP_SETTINGS_FILE = "mcp_settings.json";
/** Legacy filename (pre-3.54.0) — probed on detection for older installs. */
const LEGACY_MCP_SETTINGS_FILE = "cline_mcp_settings.json";

/**
 * Native MCP server entry shapes Roo Code accepts under `mcpServers`.
 * We write the minimal stdio shape { command, args, env, disabled }; Roo Code
 * also accepts optional `alwaysAllow` / `timeout`, which we intentionally omit.
 */
interface RooStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled: boolean;
}
interface RooHttpServer {
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
      const appData =
        process.env.APPDATA ?? join(home, "AppData", "Roaming");
      return join(appData, "Code", "User");
    }
    default:
      // Linux / other POSIX: XDG-style config dir.
      return join(home, ".config", "Code", "User");
  }
}

export class RooCodeAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Roo Code";
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    // Roo Code has no lifecycle hook system — every hook capability is false.
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
    // Roo Code registers stdio, SSE, and Streamable HTTP MCP servers.
    transports: ["stdio", "sse", "http"],
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userSettings = this.userSettingsPath();
    const userExtDir = join(
      vscodeUserDir(),
      "globalStorage",
      ROO_EXTENSION_ID,
    );
    // Probe the legacy filename too (3.54.0 migrates it at startup) so an older
    // install is still recognized; we WRITE the new mcp_settings.json.
    const userLegacySettings = join(
      userExtDir,
      "settings",
      LEGACY_MCP_SETTINGS_FILE,
    );
    const projectMcp = join(projectDir, ".roo", "mcp.json");

    const userMatch =
      existsSync(userSettings) ||
      existsSync(userLegacySettings) ||
      existsSync(userExtDir);
    const projectMatch = existsSync(projectMcp);
    const installed = userMatch || projectMatch;

    // Prefer the user scope/path when present; otherwise surface the project one.
    const scope = userMatch || !projectMatch ? "user" : "project";
    const configPath = scope === "user" ? userSettings : projectMcp;
    const reason = installed
      ? userMatch
        ? `found Roo Code globalStorage under ${userExtDir}`
        : `found Roo Code project config at ${projectMcp}`
      : `no Roo Code config at ${userExtDir} or ${projectMcp}`;

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
      ROO_EXTENSION_ID,
      "settings",
      MCP_SETTINGS_FILE,
    );
  }

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".roo")
      : join(
          vscodeUserDir(),
          "globalStorage",
          ROO_EXTENSION_ID,
          "settings",
        );
  }

  getServerConfigPath(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".roo", "mcp.json")
      : this.userSettingsPath();
  }

  /**
   * Roo Code has no hook file — hooks are not a thing here. The hook "config
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
            ? "server registration disabled for roo-code"
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

  /** Render a normalized ServerDef into Roo Code's native mcpServers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): RooStdioServer | RooHttpServer {
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

      // Roo Code documents no native interpolation token, so resolve every
      // ${env:VAR} to a literal at install time.
      const entry: RooStdioServer = {
        command: resolveEnvRefsDeep(command),
        // Honor the per-call server's enabled flag (mirror droid) rather than
        // hardcoding enabled — a server marked enabled:false installs disabled.
        disabled: server.enabled === false,
      };
      if (args.length > 0) entry.args = resolveEnvRefsDeep(args);
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      return entry;
    }

    // sse / http (and any other remote transport) — Roo Code registers a URL.
    const entry: RooHttpServer = {
      url: resolveEnvRefsDeep(server.url ?? ""),
      disabled: server.enabled === false,
    };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Roo Code documents no native interpolation token,
   * so resolve `${env:VAR}` references to literals at install time.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Hooks (unavailable — Roo Code is mcp-only) ───────────────────────────

  installHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Roo Code is mcp-only)",
      },
    ];
  }

  uninstallHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Roo Code is mcp-only)",
      },
    ];
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const mcpPath = this.getServerConfigPath(ctx);
    const connectorId = ctx.connector.id;
    return [
      {
        name: `${this.name}: MCP settings present`,
        check: () =>
          existsSync(mcpPath)
            ? { status: "OK", detail: mcpPath }
            : { status: "FAIL", detail: `not found: ${mcpPath}` },
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
  }
}

export const adapter = new RooCodeAdapter();
export default adapter;
