/**
 * adapters/amazon-q — Amazon Q Developer CLI platform adapter.
 *
 * Amazon Q Developer CLI (`q` / `qchat`) is an **mcp-only** host from
 * agent-connector's perspective. Although the agent JSON format exposes a
 * real hooks layer (agentSpawn / userPromptSubmit / preToolUse / postToolUse,
 * JSON-over-STDIN, exit-code 0/2 contract — primary-verified via
 * aws.github.io/amazon-q-developer-cli agent-format + hooks.md), the VERIFIED
 * CONTRACT classifies this adapter as mcp-only because the hook layer lives
 * inside per-agent JSON files (cli-agents/*.json), not in the global/workspace
 * mcp.json that AC targets for MCP registration. We install MCP entries only;
 * hook registration into agent files is a separate, unimplemented surface.
 *
 * MCP config (legacy files, primary-verified via AWS docs):
 *   - user scope    → ~/.aws/amazonq/mcp.json   (global; applies to all workspaces)
 *   - project scope → <projectDir>/.amazonq/mcp.json   (local workspace)
 *   Both are JSON, root key "mcpServers". Amazon Q reads BOTH when both exist
 *   and merges them (union); workspace wins on same-name conflict with a warning.
 *
 * Server entry shape (primary-verified):
 *   - stdio: { command: string; args?: string[]; env?: { [k: string]: string };
 *              timeout?: number }   (timeout in MILLISECONDS, e.g. 60000;
 *              transport inferred from presence of `command` — no `type` key)
 *   - http:  { type: "http"; url: string }
 *             (the remote/HTTP shape is written with an explicit `type: "http"`
 *              discriminator + `url`, per command-line-mcp-config-CLI.html. No
 *              `headers` field — Amazon Q remote auth is OAuth, not static
 *              headers — and no `disabled` flag.)
 *
 * Path resolution — NOTE the nested user scope:
 *   - user:    join(homedir(), ".aws", "amazonq")  (two path segments)
 *   - project: join(projectDir, ".amazonq")         (single dotDir, no .aws)
 *   homedir() handles USERPROFILE on Windows automatically; no manual branch.
 *
 * Env interpolation: Amazon Q has no documented native ${env:VAR} token;
 * resolve all references to literals at install time (the safe path, same as
 * droid/crush).
 *
 * Hook "config path" is aliased to the MCP file (no separate hook file) so the
 * base doctor/backup helpers behave sensibly.
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

const HOST: PlatformId = "amazon-q";
const MCP_ROOT_KEY = "mcpServers";

/**
 * Native MCP server entry shapes Amazon Q accepts under `mcpServers`.
 *   - stdio: BARE shape — NO `type` discriminator and NO `disabled` flag; the
 *     transport is inferred from the presence of `command`. timeout is in
 *     MILLISECONDS (pass timeoutMs through unchanged, do NOT divide).
 *   - http: REMOTE shape — explicit `type: "http"` + `url`
 *     (command-line-mcp-config-CLI.html). NO `headers` (remote auth is OAuth,
 *     not static headers) and NO `disabled` flag.
 */
interface AmazonQStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeout?: number;
}
interface AmazonQHttpServer {
  type: "http";
  url: string;
}

export class AmazonQAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Amazon Q Developer CLI";
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: DEFERRED to a follow-up PR. Amazon Q reads `.amazonq/rules`
    // (NOT AGENTS.md), so the AGENTS.md-first BaseAdapter default does not apply.
    // Leave supportsMemory unset (→ false): memory renders as an honest host-gap
    // (hostNative true, surfaces false) until the rules surface is wired.
    //
    // Amazon Q CLI: the hooks layer lives inside per-agent JSON files, not in
    // the global/workspace mcp.json that AC targets. Every hook flag is false
    // for this mcp-only adapter (hooks not wired into AC install yet).
    preToolUse: false,
    postToolUse: false,
    preCompact: false,
    sessionStart: false,
    sessionEnd: false,
    userPromptSubmit: false,
    stop: false,
    notification: false,
    // No hook layer wired → no arg/output rewrite, no context injection.
    canModifyArgs: false,
    canModifyOutput: false,
    canInjectSessionContext: false,
    // Amazon Q registers stdio + Streamable HTTP MCP servers (primary-verified).
    transports: ["stdio", "http"],
    // Content surfaces: no documented user-authored commands/skills/subagents
    // directory verified for Amazon Q. Leave UNSET (base skip-warns).
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".aws", "amazonq");
    const userMcp = join(userDir, "mcp.json");
    const projDir = join(projectDir, ".amazonq");
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
        ? `found Amazon Q config (${scope}) at ${configPath}`
        : `no Amazon Q mcp.json at ${userDir} or ${projDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  /**
   * Config directory per scope. Amazon Q uses DIFFERENT basenames:
   *   user:    ~/.aws/amazonq   (two segments — NOT a single dotDir)
   *   project: <projectDir>/.amazonq
   * This is the ONE deviation from droid/cursor's single-basename getConfigDir.
   */
  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".amazonq")
      : join(homedir(), ".aws", "amazonq");
  }

  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "mcp.json");
  }

  /**
   * Amazon Q has no separate hook file — hook config path aliases the MCP file
   * so the generic doctor/backup helpers behave sensibly (roo-code idiom).
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
            ? "server registration disabled for amazon-q"
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

  /** Render a normalized ServerDef into Amazon Q's native mcpServers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): AmazonQStdioServer | AmazonQHttpServer {
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

      // Amazon Q has no documented native interpolation token — resolve every
      // ${env:VAR} to a literal at install time (safe path, matches droid/crush).
      const entry: AmazonQStdioServer = {
        command: resolveEnvRefsDeep(command),
      };
      if (args.length > 0) entry.args = resolveEnvRefsDeep(args);
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      // timeout: Amazon Q uses MILLISECONDS — pass timeoutMs through unchanged.
      // Only emit when the connector explicitly sets one (do NOT invent a default).
      if (server.timeoutMs !== undefined) entry.timeout = server.timeoutMs;
      return entry;
    }

    // http (and any other remote transport) — Amazon Q registers a remote URL.
    // REMOTE shape: { type: "http", url } — explicit `type` discriminator, NO
    // `headers` (OAuth auth, not static headers), NO `disabled`.
    return {
      type: "http",
      url: resolveEnvRefsDeep(server.url ?? ""),
    };
  }

  /**
   * Render stdio env values. Amazon Q has no documented native interpolation
   * token, so resolve `${env:VAR}` references to literals at install time.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Hooks (unavailable — Amazon Q CLI is mcp-only in this adapter) ────────

  installHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Amazon Q CLI is mcp-only)",
      },
    ];
  }

  uninstallHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Amazon Q CLI is mcp-only)",
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

export const adapter = new AmazonQAdapter();
export default adapter;
