/**
 * adapters/codebuff — Codebuff platform adapter for agent-connector.
 *
 * Codebuff is an **mcp-only** host: it exposes no lifecycle hook system, and MCP
 * is its extensibility mechanism. This adapter therefore installs only the MCP
 * server and reports hooks as unavailable (mirrors the Warp reference path that
 * validates the `mcp-only` paradigm end-to-end).
 *
 * MCP config (SPEC):
 *   - project scope (preferred) → <projectDir>/.agents/mcp.json
 *   - user scope               → ~/.agents/mcp.json
 *   Both are JSON, root key "mcpServers". There is no separate hook file — the
 *   hook "config path" is the same mcp.json so the generic doctor/backup behave
 *   sensibly.
 *
 * A stdio server entry is the standard `{ type:"stdio", command, args, env }`
 * shape. Codebuff supports native `$VAR` interpolation, so `${env:VAR}` refs are
 * rewritten to Codebuff's native `$VAR` token (rewriteEnvRefs) rather than being
 * resolved to literals — secrets are never baked into the config file.
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
import { rewriteEnvRefs } from "../../core/interpolate.js";
import {
  buildServeWrapperCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";

const HOST: PlatformId = "codebuff";
const MCP_ROOT_KEY = "mcpServers";

/**
 * Render `${env:VAR}`/`${env:VAR:-default}` into Codebuff's native `$VAR` token.
 *
 * When the portable ref carried a default (`${env:VAR:-fallback}`), Codebuff's
 * native `$VAR` token cannot express it — so a bare native token would silently
 * DROP the default. Instead, resolve the default at install time: emit the live
 * value when VAR is set and non-empty, else the literal fallback. The native
 * token is only emitted when there is no default to preserve.
 */
const toNativeRef = (name: string, def?: string): string => {
  if (def !== undefined) {
    const v = process.env[name];
    return v != null && v !== "" ? v : def;
  }
  return `$${name}`;
};

/** Recursively rewrite every `${env:VAR}` ref in a JSON-ish value to `$VAR`. */
function rewriteEnvRefsDeep<T>(value: T): T {
  if (typeof value === "string") {
    return rewriteEnvRefs(value, toNativeRef) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => rewriteEnvRefsDeep(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewriteEnvRefsDeep(v);
    return out as T;
  }
  return value;
}

/**
 * Native MCP server entry shapes Codebuff accepts under `mcpServers`.
 * A stdio entry is tagged with `type:"stdio"`; remote transports carry a `url`.
 */
interface CodebuffStdioServer {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
interface CodebuffHttpServer {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

export class CodebuffAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Codebuff";
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    // Codebuff has no lifecycle hook system — every hook capability is false.
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
    // Codebuff registers stdio and Streamable HTTP MCP servers.
    transports: ["stdio", "http"],
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".agents");
    const userMcp = join(userDir, "mcp.json");
    const projDir = join(projectDir, ".agents");
    const projMcp = join(projDir, "mcp.json");

    const userInstalled = existsSync(userDir) || existsSync(userMcp);
    const projInstalled = existsSync(projDir) || existsSync(projMcp);
    const installed = userInstalled || projInstalled;
    // Project is the preferred scope; fall back to user when only that matched.
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
        ? `found Codebuff config (${scope})`
        : `no .agents config dir at ${userDir} or ${projDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".agents")
      : join(homedir(), ".agents");
  }

  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "mcp.json");
  }

  /**
   * Codebuff has no hook file — hooks are not a thing here. The hook "config
   * path" is the same mcp.json so the generic doctor/backup behave sensibly.
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
            ? "server registration disabled for codebuff"
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

  /** Render a normalized ServerDef into Codebuff's native mcpServers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): CodebuffStdioServer | CodebuffHttpServer {
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

      // Codebuff supports native `$VAR` interpolation, so rewrite every
      // ${env:VAR} ref to `$VAR` rather than baking literals into the config.
      const entry: CodebuffStdioServer = {
        type: "stdio",
        command: rewriteEnvRefsDeep(command),
      };
      if (args.length > 0) entry.args = rewriteEnvRefsDeep(args);
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      return entry;
    }

    // http (and any other remote transport) — Codebuff registers a URL.
    const entry: CodebuffHttpServer = {
      type: "http",
      url: rewriteEnvRefsDeep(server.url ?? ""),
    };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Codebuff supports native `$VAR` interpolation, so
   * rewrite `${env:VAR}` references to `$VAR` rather than resolving to literals.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return rewriteEnvRefsDeep({ ...env });
  }

  // ── Hooks (unavailable — Codebuff is mcp-only) ────────────────────────────

  installHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Codebuff is mcp-only)",
      },
    ];
  }

  uninstallHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Codebuff is mcp-only)",
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
          // Only assert what the connector declares: a server-less connector
          // never writes a server entry, so its absence is healthy.
          if (!ctx.connector.server) {
            return { status: "OK", detail: "no MCP server declared" };
          }
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

export const adapter = new CodebuffAdapter();
export default adapter;
