/**
 * adapters/open-interpreter — Open Interpreter (the new Rust `interpreter` / `i`
 * CLI) platform adapter for agent-connector.
 *
 * Open Interpreter is a FORK of OpenAI's Codex. The project's own README states
 * verbatim: "This is the new Rust version of Open Interpreter … Open Interpreter
 * is a fork of OpenAI's Codex, with a focus on emulating the agent harness that
 * gets the best performance out of low-cost models." (The original Python project
 * lives on as the community fork endolith/open-interpreter.) The repo at
 * github.com/openinterpreter/open-interpreter IS the codex-rs source tree.
 *
 * Because it is Codex, the native MCP config is Codex's:
 *   - config file  → <home>/config.toml (CONFIG_TOML_FILE = "config.toml";
 *     codex-rs/config/src/lib.rs:33), TOML.
 *   - MCP table    → `[mcp_servers.<id>]` (codex-rs/config/src/mcp_edit.rs:
 *     replace_mcp_servers inserts root key "mcp_servers"). stdio entry shape is
 *     { command, args, env } and the streamable-HTTP entry is { url,
 *     bearer_token_env_var?, http_headers? } (codex-rs/config/src/mcp_types.rs
 *     RawMcpServerConfig). TOML has NO native interpolation, so `${env:VAR}` refs
 *     resolve to LITERALS at install time (same rule as the codex adapter).
 *
 * Config HOME (byte-confirmed against codex-rs/utils/home-dir/src/lib.rs):
 *   - The `interpreter` binary deliberately does NOT honor $CODEX_HOME ("sharing
 *     the Codex home leaks Codex config, update caches, and credentials into the
 *     Interpreter identity"). The ONLY honored override is $INTERPRETER_HOME, and
 *     the default is ~/.openinterpreter. The install script
 *     (scripts/install/install-open-interpreter.sh) confirms both: it sets
 *     CODEX_COMMAND_NAME=interpreter and CODEX_HOME="${INTERPRETER_HOME:-$HOME/.openinterpreter}".
 *
 * Paradigm: mcp-only. Codex's hook subsystem (codex-rs/hooks) is present in the
 * fork, but the `interpreter` PRODUCT's live hook wire contract is not first-party
 * verified here (a live authenticated run, which we cannot perform). Following the
 * project rule "MCP-only unless hooks byte-confirmed", this adapter registers the
 * MCP server only and reports hooks unavailable.
 *
 * Mirrors the codex adapter's TOML object-map machinery (shared @iarna/toml codec
 * + the core/object-map engine, policy "coerce"), trimmed to the MCP surface.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import TOML from "@iarna/toml";

import type {
  ChangeRecord,
  DetectedPlatform,
  HealthCheck,
  HookParadigm,
  PlatformCapabilities,
  PlatformId,
  ServerDef,
} from "../../core/types.js";
import { ensureDir } from "../../core/paths.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  removeFromObjectMap,
  upsertInObjectMap,
  type ObjectMapCodec,
} from "../../core/object-map.js";
import { buildWrappedStdio } from "../../core/spawn.js";
import { BaseAdapter } from "../base.js";
import type { InstallContext } from "../spi.js";

const HOST: PlatformId = "open-interpreter";
const MCP_ROOT_KEY = "mcp_servers";

/** Rendered `[mcp_servers.<id>]` table — string env table, no interpolation. */
interface OpenInterpreterMcpEntry {
  // stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // streamable HTTP transport (remote): transport is inferred from `url`
  // (no explicit transport key), exactly like codex.
  url?: string;
  bearer_token_env_var?: string;
  http_headers?: Record<string, string>;
}

export class OpenInterpreterAdapter extends BaseAdapter {
  readonly id: PlatformId = HOST;
  readonly name = "Open Interpreter";
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    // mcp-only: every hook flag is false (no first-party-verified hook surface
    // for the `interpreter` product).
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
    // config.toml [mcp_servers] supports stdio (command) + streamable HTTP (url),
    // inheriting codex's transport support.
    transports: ["stdio", "http"],
  };

  // ── Detection ──────────────────────────────────────────────────────────

  detectInstalled(_projectDir: string): DetectedPlatform {
    const userDir = this.userConfigDir();
    const userCfg = join(userDir, "config.toml");
    const installed = existsSync(userDir) || existsSync(userCfg);
    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath: userCfg,
      scope: "user",
      reason: installed
        ? `Found Open Interpreter config dir (${userDir})`
        : `No Open Interpreter config dir at ${userDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ───────────────────────────────────────────────────────
  // User scope only — Open Interpreter (like codex's user scope) keeps its config
  // under the home dir. The home dir is $INTERPRETER_HOME (when set & non-empty)
  // or ~/.openinterpreter; $CODEX_HOME is deliberately NOT consulted (the fork
  // isolates the two identities — codex-rs/utils/home-dir/src/lib.rs).

  override getConfigDir(_ctx: InstallContext): string {
    return this.userConfigDir();
  }

  override getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "config.toml");
  }

  /** Open Interpreter has no separate hook file — alias the hook config path to
   *  the MCP file so the generic doctor/backup helpers behave sensibly (the
   *  amazon-q / windsurf idiom for mcp-only hosts). */
  override getHookConfigPath(ctx: InstallContext): string {
    return this.getServerConfigPath(ctx);
  }

  /** $INTERPRETER_HOME (tilde-expanded, then resolved) when set & non-empty,
   *  else ~/.openinterpreter. Byte-confirmed against codex-rs/utils/home-dir. */
  private userConfigDir(): string {
    const env = process.env.INTERPRETER_HOME;
    if (env && env.trim() !== "") {
      if (env.startsWith("~")) return join(homedir(), env.replace(/^~[/\\]?/, ""));
      return resolve(env);
    }
    return join(homedir(), ".openinterpreter");
  }

  // ── TOML config IO (config.toml is TOML, not JSON) ───────────────────────

  private readToml(path: string): Record<string, unknown> {
    if (!existsSync(path)) return {};
    try {
      return TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private writeToml(path: string, data: Record<string, unknown>, dryRun: boolean): void {
    if (dryRun) return;
    ensureDir(dirname(path));
    // @iarna/toml's stringify type wants its JsonMap; our object is structurally compatible.
    writeFileSync(path, TOML.stringify(data as never), "utf8");
  }

  /** An ObjectMapCodec over config.toml for the core/object-map engine.
   * `isPresentButUnparseable` is `() => false`: readToml fail-softs to {} and the
   * server path coerces/overwrites rather than warn-skip on an unparseable file —
   * matching the codex adapter's coerce policy. */
  private tomlObjectMapCodec(): ObjectMapCodec {
    return {
      parse: (path) => this.readToml(path),
      serialize: (path, data, dryRun) => this.writeToml(path, data, dryRun),
      isPresentButUnparseable: () => false,
    };
  }

  // ── Install server (config.toml → [mcp_servers.<id>]) ───────────────────

  override installServer(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    const server = this.effectiveServer(ctx);
    const path = this.getServerConfigPath(ctx);

    if (!server) {
      return [{ platform: this.id, action: "skip", path, detail: "no server declared" }];
    }
    const isStdio = server.transport === "stdio" && !!server.command;
    const isHttp = server.transport === "http" && !!server.url;
    if (!isStdio && !isHttp) {
      // config.toml [mcp_servers] supports stdio (command) + streamable HTTP
      // (url). Other remote transports (sse/ws) have no analog.
      return [
        {
          platform: this.id,
          action: "skip",
          path,
          detail: `transport "${server.transport}" not registrable in config.toml (stdio + streamable-http only)`,
        },
      ];
    }

    const symlink = this.symlinkPathWarning(path);
    if (symlink) return [symlink];

    const entry = this.renderMcpEntry(ctx, server);

    return [
      upsertInObjectMap({
        codec: this.tomlObjectMapCodec(),
        rootKey: MCP_ROOT_KEY,
        policy: "coerce",
        platform: this.id,
        configPath: path,
        entryId: connector.id,
        entry,
        dryRun,
      }),
    ];
  }

  override uninstallServer(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    const path = this.getServerConfigPath(ctx);
    const symlink = this.symlinkPathWarning(path);
    if (symlink) return [symlink];

    return [
      removeFromObjectMap({
        codec: this.tomlObjectMapCodec(),
        rootKey: MCP_ROOT_KEY,
        policy: "coerce",
        platform: this.id,
        configPath: path,
        entryId: connector.id,
        dryRun,
      }),
    ];
  }

  // ── Hooks (unavailable — Open Interpreter is mcp-only here) ──────────────

  override installHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Open Interpreter is mcp-only)",
      },
    ];
  }

  override uninstallHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Open Interpreter is mcp-only)",
      },
    ];
  }

  // ── Health checks (default doctor renders these) ────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const path = this.getServerConfigPath(ctx);
    const id = ctx.connector.id;
    return [
      {
        name: `${this.name}: config.toml exists`,
        check: () =>
          existsSync(path)
            ? { status: "OK", detail: path }
            : { status: "FAIL", detail: `not found: ${path}` },
      },
      {
        name: `${this.name}: ${MCP_ROOT_KEY}.${id} registered`,
        check: () => {
          // Only assert what the connector declares: a server-less connector
          // never writes an [mcp_servers.<id>] table, so its absence is healthy.
          if (!ctx.connector.server) {
            return { status: "OK", detail: "no MCP server declared" };
          }
          const cfg = this.readToml(path);
          const bucket = cfg[MCP_ROOT_KEY];
          const present =
            typeof bucket === "object" &&
            bucket !== null &&
            id in (bucket as Record<string, unknown>);
          return present
            ? { status: "OK", detail: `${MCP_ROOT_KEY}.${id}` }
            : { status: "FAIL", detail: `${MCP_ROOT_KEY}.${id} not found in ${path}` };
        },
      },
    ];
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  /** Resolve the per-platform server override into an effective ServerDef. */
  private effectiveServer(ctx: InstallContext): ServerDef | undefined {
    const override = ctx.connector.platforms[this.id]?.server;
    if (override === false) return undefined;
    const base = ctx.connector.server;
    if (!base) return undefined;
    return override ? { ...base, ...override } : base;
  }

  /**
   * Render the `[mcp_servers.<id>]` table. TOML has NO interpolation, so every
   * `${env:VAR}` is resolved to a literal at install time. Honors the telemetry
   * serve-wrapper for stdio.
   */
  private renderMcpEntry(ctx: InstallContext, server: ServerDef): OpenInterpreterMcpEntry {
    // Streamable HTTP server: transport is inferred from `url` (no explicit
    // transport key), exactly like codex. Telemetry serve-wrapping is stdio-only
    // (remote cannot be intercepted). installServer's guard only lets stdio+command
    // or http+url reach here, so this branch is exactly the streamable-HTTP case.
    if (server.transport === "http") {
      const remote: OpenInterpreterMcpEntry = { url: resolveEnvRefsDeep(server.url ?? "") };
      if (server.auth?.type === "bearerEnv" && server.auth.bearerEnvVar) {
        remote.bearer_token_env_var = server.auth.bearerEnvVar;
      }
      if (server.headers && Object.keys(server.headers).length > 0) {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(resolveEnvRefsDeep(server.headers))) {
          headers[k] = String(v);
        }
        remote.http_headers = headers;
      }
      return remote;
    }

    let command = server.command as string;
    let args = [...(server.args ?? [])];

    ({ command, args } = buildWrappedStdio(ctx, server, this.id, command, args));

    // Resolve env-refs to literals (TOML cannot interpolate).
    command = resolveEnvRefsDeep(command);
    args = resolveEnvRefsDeep(args);

    const entry: OpenInterpreterMcpEntry = { command };
    if (args.length > 0) entry.args = args;

    if (server.env && Object.keys(server.env).length > 0) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(resolveEnvRefsDeep(server.env))) {
        env[k] = String(v);
      }
      entry.env = env;
    }
    return entry;
  }
}

export const adapter = new OpenInterpreterAdapter();
export default adapter;
