/**
 * adapters/zed — Zed editor platform adapter for agent-connector.
 *
 * Zed is an **mcp-only** host: it is an IDE, not a CLI with a hook pipeline, so
 * there is NO lifecycle hook system. MCP ("context servers") is the only
 * integration path, so this adapter installs only the MCP server and reports
 * hooks as unavailable — like Warp, it exercises the `mcp-only` paradigm.
 *
 * MCP config (one JSON-with-comments settings file, NOT a dedicated MCP file):
 *   - user scope → settings.json under Zed's OS-native config dir:
 *       • Windows: %LOCALAPPDATA%\Zed\settings.json  (Local, NOT %APPDATA%)
 *       • macOS / Linux: ~/.config/zed/settings.json
 *   - project scope → <projectDir>/.zed/settings.json
 *   Root key is "context_servers" (NOT "mcpServers"). The same file holds the
 *   (non-existent) hook config — there is no separate hook file here.
 *
 * MERGE CONTRACT: Zed's settings.json is a large user-owned IDE config. We read
 * the whole file, set ONLY context_servers[<id>], and write it back — every
 * other top-level key and sibling context server is preserved. (Zed accepts
 * JSONC; we WRITE plain JSON, mirroring the other JSON-config adapters.)
 *
 * ENTRY SHAPE QUIRK (verified against context-mode's proven Zed adapter +
 * zed-industries/zed crates/settings_content/src/project.rs): Zed's
 * context_servers Stdio variant flattens ContextServerCommand and renames its
 * `path` field to the JSON key `command`. The accepted shape is therefore a
 * FLAT entry: { "command": "<exe>", "args": [...], "env": {...} }. The nested
 * { command: { path, args } } form fails to deserialize under Zed's
 * #[serde(untagged)] enum and is silently dropped (the server never loads).
 *
 * Zed documents no native ${env:VAR} interpolation token for context_servers,
 * so env refs are resolved to literals at install time (the no-native-token
 * path, same as Warp).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

const HOST: PlatformId = "zed";
const MCP_ROOT_KEY = "context_servers";

/**
 * Zed's context_servers Stdio entry. FLAT shape — `command` is a string, NOT a
 * nested { path, args } object (see file header). Remote transports are
 * represented as a URL-bearing entry.
 */
interface ZedStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
interface ZedHttpServer {
  url: string;
  headers?: Record<string, string>;
}

export class ZedAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Zed";
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    // Zed has no lifecycle hook system — every hook capability is false.
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
    // Zed registers stdio context servers; remote URLs are also accepted.
    transports: ["stdio", "sse", "http"],
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = this.userConfigDir();
    const userSettings = this.userSettingsPath();
    const projDir = join(projectDir, ".zed");
    const projSettings = join(projDir, "settings.json");

    const userInstalled = existsSync(userDir) || existsSync(userSettings);
    const projInstalled = existsSync(projDir) || existsSync(projSettings);
    const installed = userInstalled || projInstalled;
    const scope = projInstalled && !userInstalled ? "project" : "user";
    const configPath = scope === "project" ? projSettings : userSettings;

    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath,
      scope,
      reason: installed
        ? `found Zed config (${scope}) at ${configPath}`
        : `no Zed config at ${userSettings} or ${projSettings}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".zed")
      : this.userConfigDir();
  }

  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "settings.json");
  }

  /**
   * Zed has no hook file — hooks are not a thing here. The hook "config path"
   * is the same settings.json so the generic doctor/backup behave sensibly.
   */
  getHookConfigPath(ctx: InstallContext): string {
    return this.getServerConfigPath(ctx);
  }

  /**
   * Zed's user config dir is OS-native, NOT a uniform ~/.config:
   *   - Windows: %LOCALAPPDATA%\Zed  (Local, NOT Roaming/%APPDATA%)
   *   - macOS / Linux: ~/.config/zed
   */
  private userConfigDir(): string {
    if (process.platform === "win32") {
      const localAppData =
        process.env.LOCALAPPDATA && process.env.LOCALAPPDATA.trim() !== ""
          ? process.env.LOCALAPPDATA
          : resolve(homedir(), "AppData", "Local");
      return join(localAppData, "Zed");
    }
    return join(homedir(), ".config", "zed");
  }

  private userSettingsPath(): string {
    return join(this.userConfigDir(), "settings.json");
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
            ? "server registration disabled for zed"
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

    // upsertServerInJson reads the WHOLE settings file, sets only
    // context_servers[<id>], and writes it back — preserving every other
    // top-level key and sibling context server (the merge contract).
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

  /** Render a normalized ServerDef into Zed's native context_servers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): ZedStdioServer | ZedHttpServer {
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

      // Zed has no documented native interpolation token, so resolve every
      // ${env:VAR} to a literal at install time.
      // FLAT shape: `command` is a string, never a nested { path, args }.
      const entry: ZedStdioServer = { command: resolveEnvRefsDeep(command) };
      if (args.length > 0) entry.args = resolveEnvRefsDeep(args);
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      return entry;
    }

    // sse / http (and any other remote transport) — Zed registers a URL.
    const entry: ZedHttpServer = { url: resolveEnvRefsDeep(server.url ?? "") };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Zed documents no native interpolation token, so
   * resolve `${env:VAR}` references to literals at install time.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Hooks (unavailable — Zed is mcp-only) ────────────────────────────────

  installHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Zed is mcp-only)",
      },
    ];
  }

  uninstallHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Zed is mcp-only)",
      },
    ];
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const settingsPath = this.getServerConfigPath(ctx);
    const connectorId = ctx.connector.id;
    return [
      {
        name: `${this.name}: settings.json present`,
        check: () =>
          existsSync(settingsPath)
            ? { status: "OK", detail: settingsPath }
            : { status: "FAIL", detail: `not found: ${settingsPath}` },
      },
      {
        name: `${this.name}: context server entry registered`,
        check: () => {
          const cfg = this.readJson<{ [k: string]: Record<string, unknown> }>(settingsPath);
          const bucket = cfg?.[MCP_ROOT_KEY];
          if (!cfg || !bucket) {
            return { status: "FAIL", detail: `no ${MCP_ROOT_KEY} in ${settingsPath}` };
          }
          return connectorId in bucket
            ? { status: "OK", detail: `${MCP_ROOT_KEY}.${connectorId} present` }
            : {
                status: "FAIL",
                detail: `no ${MCP_ROOT_KEY}.${connectorId} in ${settingsPath}`,
              };
        },
      },
    ];
  }
}

export const adapter = new ZedAdapter();
export default adapter;
