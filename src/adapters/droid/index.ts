/**
 * adapters/droid — Droid (Factory AI) platform adapter for agent-connector.
 *
 * Droid is an **mcp-only** host: it exposes no lifecycle hook system, and MCP is
 * its extensibility mechanism. This adapter therefore installs only the MCP
 * server and reports hooks as unavailable — the clean, standard JSON case.
 *
 * MCP config (report §2 / §5.3):
 *   - user scope    → ~/.factory/mcp.json
 *   - project scope → <projectDir>/.factory/mcp.json
 *   Both are JSON, root key "mcpServers", and are the SAME file used for the
 *   (non-existent) hook registration — there is no separate hook file here.
 *
 * Native stdio entry shape: { type: "stdio", command, args, env, disabled }.
 * Droid supports native ${VAR} expansion in env values, but resolving every
 * ${env:VAR} to a literal at install time is safe and avoids surprises, so this
 * adapter takes the resolve-to-literal path (matching the Warp reference).
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

const HOST: PlatformId = "droid";
const MCP_ROOT_KEY = "mcpServers";

/**
 * Native MCP server entry shapes Droid accepts under `mcpServers`.
 * A stdio entry carries an explicit `type: "stdio"` discriminator and a
 * `disabled` flag; remote transports register a URL.
 */
interface DroidStdioServer {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled: boolean;
}
interface DroidHttpServer {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  disabled: boolean;
}

export class DroidAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Droid (Factory)";
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    // Droid has no lifecycle hook system — every hook capability is false.
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
    // Droid registers stdio and Streamable HTTP MCP servers.
    transports: ["stdio", "http"],
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".factory");
    const userMcp = join(userDir, "mcp.json");
    const projDir = join(projectDir, ".factory");
    const projMcp = join(projDir, "mcp.json");

    const userInstalled = existsSync(userDir) || existsSync(userMcp);
    const projInstalled = existsSync(projDir) || existsSync(projMcp);
    const installed = userInstalled || projInstalled;
    const scope = projInstalled && !userInstalled ? "project" : "user";
    const configPath = scope === "project" ? projMcp : userMcp;

    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath,
      scope,
      reason: installed
        ? `found Droid config (${scope}) at ${configPath}`
        : `no .factory config at ${userDir} or ${projDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".factory")
      : join(homedir(), ".factory");
  }

  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "mcp.json");
  }

  /**
   * Droid has no hook file — hooks are not a thing here. The hook "config path"
   * is the same mcp.json so the generic doctor/backup behave sensibly.
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
            ? "server registration disabled for droid"
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

  /** Render a normalized ServerDef into Droid's native mcpServers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): DroidStdioServer | DroidHttpServer {
    const transport: Transport = server.transport;
    const disabled = server.enabled === false;

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

      // Resolve every ${env:VAR} to a literal at install time (safe path).
      const entry: DroidStdioServer = {
        type: "stdio",
        command: resolveEnvRefsDeep(command),
        disabled,
      };
      if (args.length > 0) entry.args = resolveEnvRefsDeep(args);
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      return entry;
    }

    // http (and any other remote transport) — Droid registers a URL.
    const entry: DroidHttpServer = {
      type: "http",
      url: resolveEnvRefsDeep(server.url ?? ""),
      disabled,
    };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Resolve `${env:VAR}` references to literals at
   * install time (the safe path; Droid would also accept native ${VAR}).
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Hooks (unavailable — Droid is mcp-only) ──────────────────────────────

  installHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Droid (Factory) is mcp-only)",
      },
    ];
  }

  uninstallHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Droid (Factory) is mcp-only)",
      },
    ];
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const mcpPath = this.getServerConfigPath(ctx);
    const connectorId = ctx.connector.id;
    return [
      {
        name: `${this.name}: mcp.json present`,
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

export const adapter = new DroidAdapter();
export default adapter;
