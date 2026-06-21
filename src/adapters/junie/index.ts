/**
 * adapters/junie — Junie (JetBrains' own LLM-agnostic coding agent) adapter.
 *
 * Junie is JetBrains' OWN coding agent ("An LLM-agnostic coding agent built for
 * real-world development — by JetBrains", github.com/JetBrains/junie). It is
 * DISTINCT from the `jetbrains-copilot` adapter, which targets GitHub Copilot
 * running inside JetBrains IDEs. Junie ships as a terminal CLI (`junie`,
 * installed via junie.jetbrains.com/install.sh, Homebrew, or
 * `npm i -g @jetbrains/junie`) and also runs inside JetBrains IDEs / CI.
 *
 * From agent-connector's hook-paradigm perspective Junie is **mcp-only**: the
 * first-party docs (junie.jetbrains.com/docs) document NO user-installable
 * lifecycle hook / event-callback surface — only MCP server registration,
 * Agent Skills, subagents, custom slash commands, and guidelines/memory. So MCP
 * registration is the only runtime surface this adapter installs and every hook
 * capability is reported false. (Content surfaces exist natively but are not
 * wired here — see the capabilities note.)
 *
 * MCP config (BYTE-CONFIRMED — junie.jetbrains.com/docs/junie-cli-mcp-configuration.html,
 * "Junie CLI uses the same MCP JSON configuration as Junie in JetBrains IDEs"):
 *   - PROJECT scope → <projectDir>/.junie/mcp/mcp.json ("can be checked into
 *     version control and shared across all team members").
 *   - USER scope    → ~/.junie/mcp/mcp.json ("available across all projects on
 *     your machine while remaining private to your user account").
 *   - root key "mcpServers" — a JSON object/map keyed by server name.
 *
 * Server entry shapes (BYTE-CONFIRMED from the docs' verbatim JSON example):
 *   - stdio:  { command, args?, env? }
 *   - remote: { url, headers? } — the key is `url` (NOT `serverUrl`); there is
 *     NO `type` discriminator and NO `disabled` field. stdio vs remote is
 *     distinguished by `command` vs `url`. `headers` is emitted only when the
 *     connector's remote server provides them.
 *
 * Env interpolation: the docs example carries literal `env` values and document
 * no portable native `${env:VAR}` token for the MCP file, so every `${env:VAR}`
 * reference is resolved to a literal at install time (the safe path, same as
 * cline / windsurf / droid).
 *
 * The hook "config path" is aliased to the MCP file (no separate hook file) so
 * the generic doctor/backup helpers behave sensibly (the windsurf/cline idiom).
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
import { buildWrappedStdio } from "../../core/spawn.js";

const HOST: PlatformId = "junie";
const MCP_ROOT_KEY = "mcpServers";

/**
 * Native MCP server entry shapes Junie accepts under `mcpServers` (an OBJECT map
 * keyed by server name):
 *   - stdio:  { command, args?, env? } — transport inferred from `command`.
 *   - remote: { url, headers? } — `url` (NOT `serverUrl`); NO `type`
 *     discriminator and NO `disabled` flag. `headers` only when provided.
 */
interface JunieStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
interface JunieRemoteServer {
  url: string;
  headers?: Record<string, string>;
}

export class JunieAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Junie";
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: BaseAdapter AGENTS.md-first default. Junie documents its
    // own guidelines/memory surface; AC's AGENTS.md default lands in the open
    // standard file Junie also reads. (Junie-specific guideline files are not
    // wired here — the AGENTS.md default is the host-agnostic baseline.)
    supportsMemory: true,
    //
    // mcp-only: Junie documents NO user-installable lifecycle hook / event-
    // callback surface (junie.jetbrains.com/docs). Every hook flag is false.
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
    // Junie registers stdio MCP servers (Local: Docker/npx/binary) and remote
    // (HTTP/HTTPS) servers — the remote entry is distinguished by `url` (vs
    // stdio's `command`).
    transports: ["stdio", "http"],
    // Content surfaces (Agent Skills, subagents, custom slash commands) exist
    // natively in Junie but are NOT wired by this adapter — the initial scope is
    // MCP-only. They stay UNSET so the base skip-warns; this is an honest
    // CEILING, not a host gap.
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".junie");
    const userMcp = join(userDir, "mcp", "mcp.json");
    // ~/.junie/allowlist.json is Junie CLI's action-allowlist file
    // (byte-confirmed — junie.jetbrains.com/docs/junie-cli.html), so the dir's
    // presence is a strong CLI-installed marker.
    const projectDirJunie = join(projectDir, ".junie");
    const installed = existsSync(userDir) || existsSync(projectDirJunie);
    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath: userMcp,
      scope: "user",
      reason: installed
        ? `found Junie config under ${userDir}`
        : `no Junie config at ${userDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  /**
   * Junie's MCP config dir is `<scope-root>/.junie/mcp`: project scope at
   * <projectDir>/.junie/mcp, user scope at ~/.junie/mcp (BYTE-CONFIRMED —
   * junie.jetbrains.com/docs/junie-cli-mcp-configuration.html).
   */
  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".junie", "mcp")
      : join(homedir(), ".junie", "mcp");
  }

  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "mcp.json");
  }

  /**
   * Junie has no separate hook file — the hook config path aliases the MCP file
   * so the generic doctor/backup helpers behave sensibly (windsurf/cline idiom).
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
            ? "server registration disabled for junie"
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

  /** Render a normalized ServerDef into Junie's native mcpServers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): JunieStdioServer | JunieRemoteServer {
    const transport: Transport = server.transport;

    if (transport === "stdio") {
      let command = server.command ?? "";
      let args = [...(server.args ?? [])];

      // Transparent telemetry wrapping: route the real command through
      // `<homeBin> serve --connector <id> -- <command> <args...>`.
      ({ command, args } = buildWrappedStdio(ctx, server, this.id, command, args));

      // Junie documents no native interpolation token for the MCP file, so
      // resolve every ${env:VAR} to a literal at install time.
      const entry: JunieStdioServer = {
        command: resolveEnvRefsDeep(command),
      };
      if (args.length > 0) entry.args = resolveEnvRefsDeep(args);
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      return entry;
    }

    // http (and any other remote transport we surface) — Junie registers a
    // remote URL under `url` (NOT `serverUrl`). NO `type` discriminator, NO
    // `disabled`. `headers` only when the connector's remote server provides them.
    const entry: JunieRemoteServer = {
      url: resolveEnvRefsDeep(server.url ?? ""),
    };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Junie documents no native interpolation token, so
   * resolve `${env:VAR}` references to literals at install time.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Hooks (unavailable — Junie is mcp-only) ──────────────────────────────

  installHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Junie is mcp-only)",
      },
    ];
  }

  uninstallHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Junie is mcp-only)",
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
          // never writes an mcpServers entry, so its absence is healthy.
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

export const adapter = new JunieAdapter();
export default adapter;
