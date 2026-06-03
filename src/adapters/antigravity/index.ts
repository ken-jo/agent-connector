/**
 * adapters/antigravity — Google Antigravity platform adapter for agent-connector.
 *
 * Antigravity is a Gemini-family, **mcp-only** host: it has NO lifecycle hook
 * system, and MCP is its only integration path. This adapter therefore installs
 * only the MCP server and reports hooks as unavailable (mirroring the Warp
 * reference path that validates the `mcp-only` paradigm end-to-end).
 *
 * MCP config (JSONC; we WRITE plain JSON), root key "mcpServers":
 *   - user scope    → ~/.gemini/antigravity/mcp_config.json
 *                     (probed candidates, preferring an existing one — see below)
 *   - project scope → <projectDir>/.agents/mcp_config.json
 *   The MCP config file is also the "hook config path" so the generic
 *   doctor/backup behave sensibly — there is no separate hook file here.
 *
 * QUIRK: Antigravity has historically shipped under a few different home dirs.
 * For user scope we probe, in order, the known candidates and prefer one that
 * already exists on disk; if none exist we default to the FIRST candidate
 * (~/.gemini/antigravity/mcp_config.json — the path context-mode and the Gemini
 * issue tracker document). This keeps a fresh install canonical while honoring a
 * pre-existing config wherever the user already has one.
 *
 * Env handling: Antigravity (Gemini family) documents no `${env:VAR}` token of
 * the framework's syntax, so env/header/url refs are resolved to literals at
 * install time via resolveEnvRefsDeep — the safe default matching the Gemini CLI
 * adapter.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
  isHomeBinHookCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";

const HOST: PlatformId = "antigravity";
const MCP_ROOT_KEY = "mcpServers";

/**
 * Known user-scope MCP config candidates, in preference order. We pick the first
 * that already exists on disk; otherwise we default to candidate[0].
 */
const USER_CONFIG_CANDIDATES = [
  [".gemini", "antigravity", "mcp_config.json"],
  [".gemini", "config", "mcp_config.json"],
  [".gemini", "antigravity-cli", "mcp_config.json"],
] as const;

/**
 * Native MCP server entry shapes Antigravity accepts under `mcpServers`.
 * A stdio server is `{ command, args, env }`; a remote server is a URL.
 */
interface AntigravityStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
interface AntigravityHttpServer {
  url: string;
  headers?: Record<string, string>;
}

export class AntigravityAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Google Antigravity";
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    // Antigravity has no lifecycle hook system — every hook capability is false.
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
    // Antigravity registers stdio, SSE, and Streamable HTTP MCP servers.
    transports: ["stdio", "sse", "http"],
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userConfig = this.resolveUserConfigPath();
    const userDir = join(homedir(), ".gemini");
    const projectConfig = join(projectDir, ".agents", "mcp_config.json");

    const userInstalled =
      existsSync(userDir) ||
      USER_CONFIG_CANDIDATES.some((parts) => existsSync(join(homedir(), ...parts)));
    const projInstalled = existsSync(projectConfig);
    const installed = userInstalled || projInstalled;

    // Report the scope/path that actually matched, so a project-only install
    // isn't misreported as a (non-existent) user install.
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
          ? `found project Antigravity config at ${projectConfig}`
          : `found Antigravity config under ${userDir}`
        : `no Antigravity config at ${userDir} or ${projectConfig}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    if (ctx.scope === "project") return join(ctx.projectDir, ".agents");
    // User scope: parent dir of the resolved user mcp_config.json.
    return dirname(this.resolveUserConfigPath());
  }

  getServerConfigPath(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".agents", "mcp_config.json")
      : this.resolveUserConfigPath();
  }

  /**
   * Antigravity has no hook file — hooks are not a thing here. The hook "config
   * path" is the same mcp_config.json so the generic doctor/backup behave sensibly.
   */
  getHookConfigPath(ctx: InstallContext): string {
    return this.getServerConfigPath(ctx);
  }

  /**
   * Pick the user-scope mcp_config.json: prefer a candidate that already exists,
   * else default to the first (the canonical ~/.gemini/antigravity path).
   */
  private resolveUserConfigPath(): string {
    const home = homedir();
    for (const parts of USER_CONFIG_CANDIDATES) {
      const p = join(home, ...parts);
      if (existsSync(p)) return p;
    }
    return join(home, ...USER_CONFIG_CANDIDATES[0]);
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
            ? "server registration disabled for antigravity"
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

  /** Render a normalized ServerDef into Antigravity's native mcpServers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): AntigravityStdioServer | AntigravityHttpServer {
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

      // Antigravity (Gemini family) has no documented native interpolation token,
      // so resolve every ${env:VAR} to a literal at install time.
      const entry: AntigravityStdioServer = { command: resolveEnvRefsDeep(command) };
      if (args.length > 0) entry.args = resolveEnvRefsDeep(args);
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      return entry;
    }

    // sse / http (and any other remote transport) — Antigravity registers a URL.
    const entry: AntigravityHttpServer = { url: resolveEnvRefsDeep(server.url ?? "") };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Antigravity documents no native interpolation
   * token, so resolve `${env:VAR}` references to literals at install time.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Hooks (unavailable — Antigravity is mcp-only) ─────────────────────────

  installHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Google Antigravity is mcp-only)",
      },
    ];
  }

  uninstallHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Google Antigravity is mcp-only)",
      },
    ];
  }

  /**
   * True when a hook command references our home binary AND this connector id
   * (anchored so a shared-prefix id can't collide — see isHomeBinHookCommand).
   * Antigravity installs no hooks, but this guard keeps any future shared-file
   * edit from removing another connector's entries.
   */
  private isOurCommand(command: string | undefined, ctx: InstallContext): boolean {
    return isHomeBinHookCommand(command, ctx.homeBinPath, ctx.connector.id);
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const mcpPath = this.getServerConfigPath(ctx);
    const connectorId = ctx.connector.id;
    return [
      {
        name: `${this.name}: mcp_config.json present`,
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

export const adapter = new AntigravityAdapter();
export default adapter;
