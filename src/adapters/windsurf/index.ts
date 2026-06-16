/**
 * adapters/windsurf — Windsurf (Codeium / Cognition's Cascade agent) adapter.
 *
 * Windsurf is an mcp-only host from agent-connector's perspective: there is no
 * user-installable hook/plugin layer (it is a GUI editor), so only the MCP
 * server is registered. The config is a Claude-Desktop-style OBJECT map keyed
 * by server name (exactly like the cursor adapter's `mcpServers`), NOT an array.
 *
 * MCP config (primary-verified — docs.devin.ai/desktop/cascade/mcp, formerly
 * docs.windsurf.com):
 *   - user/global scope ONLY → ~/.codeium/windsurf/mcp_config.json
 *     (Windows %USERPROFILE%\.codeium\windsurf\mcp_config.json — homedir()
 *     covers it). The docs specify NO project/workspace config path, so a
 *     project-scope install returns a skip ChangeRecord.
 *   - root key "mcpServers" — a JSON object/map keyed by server name.
 *
 * Server entry shapes (primary-verified):
 *   - stdio:  { command, args?, env? }
 *   - remote: { serverUrl, headers? } — the docs use `serverUrl` (an `url`
 *     alias is mentioned but `serverUrl` is the documented primary). There is
 *     NO `type` discriminator and NO `disabled` field — stdio vs remote is
 *     distinguished by `command` vs `serverUrl`. `headers` is emitted only when
 *     the connector's remote server provides them.
 *
 * Native interpolation: Windsurf supports `${env:VAR}` / `${file:/path}`
 * tokens, but AC does not need to emit those — values are resolved to literals
 * at install time (the safe path, same as droid/crush/amazon-q).
 *
 * Memory: Windsurf natively has a Rules surface (`.windsurfrules` / global
 * rules) that AC does not yet wire — it is NOT AGENTS.md, so the AGENTS.md-first
 * BaseAdapter default does not apply. supportsMemory stays unset (→ false):
 * memory renders as an honest host-gap (hostNative true, surfaces false).
 *
 * Hook "config path" is aliased to the MCP file (no separate hook file) so the
 * base doctor/backup helpers behave sensibly (the amazon-q / roo-code idiom).
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

const HOST: PlatformId = "windsurf";
const MCP_ROOT_KEY = "mcpServers";

/**
 * Native MCP server entry shapes Windsurf accepts under `mcpServers` (an OBJECT
 * map keyed by server name, Claude-Desktop-style):
 *   - stdio:  { command, args?, env? } — transport inferred from `command`.
 *   - remote: { serverUrl, headers? } — `serverUrl` (NOT `url`); NO `type`
 *     discriminator and NO `disabled` flag. `headers` only when provided.
 */
interface WindsurfStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
interface WindsurfRemoteServer {
  serverUrl: string;
  headers?: Record<string, string>;
}

export class WindsurfAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Windsurf";
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: DEFERRED. Windsurf reads `.windsurfrules` / global rules
    // (NOT AGENTS.md), so the AGENTS.md-first BaseAdapter default does not apply.
    // Leave supportsMemory unset (→ false): memory renders as an honest host-gap
    // (hostNative true, surfaces false) until the rules surface is wired.
    //
    // mcp-only: Windsurf is a GUI editor with no user-installable hook/plugin
    // layer. Every hook flag is false.
    preToolUse: false,
    postToolUse: false,
    preCompact: false,
    sessionStart: false,
    sessionEnd: false,
    userPromptSubmit: false,
    stop: false,
    notification: false,
    // No hook layer → no arg/output rewrite, no context injection.
    canModifyArgs: false,
    canModifyOutput: false,
    canInjectSessionContext: false,
    // Windsurf registers stdio + remote (http/sse) MCP servers; the remote
    // entry is distinguished by `serverUrl` (vs stdio's `command`).
    transports: ["stdio", "http", "sse"],
    // Content surfaces: no documented user-authored commands/skills/subagents
    // directory verified for Windsurf. Leave UNSET (base skip-warns).
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(_projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".codeium", "windsurf");
    const userMcp = join(userDir, "mcp_config.json");
    const installed = existsSync(userDir) || existsSync(userMcp);
    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath: userMcp,
      scope: "user",
      reason: installed
        ? `found Windsurf config under ${userDir}`
        : `no Windsurf config at ${userDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  /**
   * Windsurf's MCP config is USER/GLOBAL scope only — the docs specify no
   * project/workspace path. getConfigDir always resolves the user dir
   * (homedir() covers USERPROFILE on Windows); a project-scope install is
   * handled by installServer returning a skip, never a write under projectDir.
   */
  getConfigDir(_ctx: InstallContext): string {
    return join(homedir(), ".codeium", "windsurf");
  }

  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "mcp_config.json");
  }

  /**
   * Windsurf has no separate hook file — hook config path aliases the MCP file
   * so the generic doctor/backup helpers behave sensibly (amazon-q idiom).
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
            ? "server registration disabled for windsurf"
            : "connector declares no MCP server",
        },
      ];
    }

    // Windsurf has no project-level MCP config (user scope only — the docs
    // document only ~/.codeium/windsurf/mcp_config.json). A project-scope
    // install is reported as a skip rather than written into the project tree.
    if (ctx.scope === "project") {
      return [
        {
          platform: this.id,
          action: "skip",
          detail:
            "Windsurf has no project-level MCP config (user scope only); " +
            "re-run with --scope user",
        },
      ];
    }

    // Shallow-merge any per-platform server override into the base ServerDef.
    const server: ServerDef =
      override && typeof override === "object"
        ? { ...connector.server, ...override }
        : connector.server;

    const serverPath = this.getServerConfigPath(ctx);

    // NEVER clobber a malformed `mcpServers`. The base upsert tolerates a
    // missing file / missing key (it creates the object), but a PRESENT-but-
    // non-object `mcpServers` (e.g. an array or string from a hand-edit) would
    // get a named property bolted on and silently corrupted — so skip-and-warn.
    const malformed = this.malformedRootKey(serverPath);
    if (malformed) return [malformed];

    const entry = this.renderServerEntry(ctx, server);

    return [
      this.upsertServerInJson(serverPath, MCP_ROOT_KEY, connector.id, entry, ctx.dryRun),
    ];
  }

  uninstallServer(ctx: InstallContext): ChangeRecord[] {
    const serverPath = this.getServerConfigPath(ctx);
    const malformed = this.malformedRootKey(serverPath);
    if (malformed) return [malformed];
    return [
      this.removeServerFromJson(serverPath, MCP_ROOT_KEY, ctx.connector.id, ctx.dryRun),
    ];
  }

  /**
   * Guard for a PRESENT-but-non-object `mcpServers` root key: returns a
   * skip-warn ChangeRecord when the existing config parses but its `mcpServers`
   * value is not a plain object (an array / string / number / null). Returns
   * undefined when the file is absent, unparseable (the base upsert's own
   * overwrite guard handles that), or `mcpServers` is absent / a plain object.
   */
  private malformedRootKey(configPath: string): ChangeRecord | undefined {
    const cfg = this.readJson<Record<string, unknown>>(configPath);
    if (!cfg || !(MCP_ROOT_KEY in cfg)) return undefined;
    const root = cfg[MCP_ROOT_KEY];
    if (root !== null && typeof root === "object" && !Array.isArray(root)) {
      return undefined;
    }
    return {
      platform: this.id,
      action: "warn",
      path: configPath,
      detail: `existing ${MCP_ROOT_KEY} in ${configPath} is not an object map; left untouched (back it up / fix it, then re-run)`,
    };
  }

  /** Render a normalized ServerDef into Windsurf's native mcpServers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): WindsurfStdioServer | WindsurfRemoteServer {
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

      // Windsurf supports ${env:VAR} natively, but AC resolves references to
      // literals at install time (the safe path, same as amazon-q/droid/crush).
      const entry: WindsurfStdioServer = {
        command: resolveEnvRefsDeep(command),
      };
      if (args.length > 0) entry.args = resolveEnvRefsDeep(args);
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      return entry;
    }

    // http / sse (and any other remote transport) — Windsurf registers a remote
    // URL under `serverUrl` (NOT `url`). NO `type` discriminator, NO `disabled`.
    // `headers` only when the connector's remote server provides them.
    const entry: WindsurfRemoteServer = {
      serverUrl: resolveEnvRefsDeep(server.url ?? ""),
    };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Windsurf has a native ${env:VAR} token, but AC
   * resolves references to literals at install time (the safe path).
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Hooks (unavailable — Windsurf is mcp-only) ────────────────────────────

  installHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Windsurf is mcp-only)",
      },
    ];
  }

  uninstallHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Windsurf is mcp-only)",
      },
    ];
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

export const adapter = new WindsurfAdapter();
export default adapter;
