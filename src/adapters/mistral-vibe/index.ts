/**
 * adapters/mistral-vibe — Mistral Vibe (Mistral's coding-agent CLI) adapter.
 *
 * Mistral Vibe is an **mcp-only** host: it registers MCP servers but exposes no
 * user-installable lifecycle-hook surface AC can wire today. Its native config
 * is TOML, with a two-level lookup order (project precedes user):
 *   1. <projectDir>/.vibe/config.toml  (PROJECT — takes precedence)
 *   2. ~/.vibe/config.toml             (USER)
 *
 * MCP shape — byte-confirmed from the OFFICIAL repo README
 * (github.com/mistralai/mistral-vibe) + docs (docs.mistral.ai/vibe/code/cli/
 * configuration + /mcp-servers): the root key `mcp_servers` is a TOML
 * ARRAY-OF-TABLES (`[[mcp_servers]]`), NOT codex's table-keyed
 * `[mcp_servers.<name>]`. Each entry carries a REQUIRED short-alias `name` field
 * — AC writes the CONNECTOR ID there and keys ownership on it (the array-by-name
 * merge the `continue` adapter uses for YAML, applied over TOML):
 *
 *   [[mcp_servers]]
 *   name = "fetch_server"
 *   transport = "stdio"
 *   command = "uvx"
 *   args = ["mcp-server-fetch"]
 *   env = { "DEBUG" = "1", "LOG_LEVEL" = "info" }
 *
 *   [[mcp_servers]]
 *   name = "my_http_server"
 *   transport = "http"
 *   url = "http://localhost:8000"
 *   headers = { "Authorization" = "Bearer my_token" }
 *   api_key_env = "MY_API_KEY_ENV_VAR"
 *
 * Per-entry fields:
 *   - name        (required short alias — the connector id)
 *   - transport   ("stdio" | "http" | "streamable-http")
 *   - stdio       → command / args / env
 *   - http/sse    → url / headers / api_key_env / api_key_header / api_key_format
 *   - optional    startup_timeout_sec / tool_timeout_sec
 *
 * TOML has NO native interpolation token, so every `${env:VAR}` is resolved to a
 * literal at install time (the safe path matching codex/droid). The stdio entry
 * is routed through the telemetry serve-wrapper (`<homeBin> serve --connector
 * <id> -- <command> <args...>`); remote transports are registered but never
 * wrapped (they cannot be intercepted).
 *
 * HOOKS: HONEST CEILING — Mistral Vibe ships only an experimental, unstable hook
 * surface (no byte-confirmed format/event-name contract), so AC wires NO hooks
 * here. The capability flags stay unset and the host is reported mcp-only (the
 * generic installHooks reports "hooks unavailable"). When a first-party hook
 * contract is byte-confirmed this becomes a normal capability addition.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import TOML from "@iarna/toml";

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
import { ensureDir } from "../../core/paths.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import { buildWrappedStdio } from "../../core/spawn.js";
import { BaseAdapter } from "../base.js";
import type { Adapter, InstallContext } from "../spi.js";

const HOST: PlatformId = "mistral-vibe";
/** Root key under which Mistral Vibe stores MCP servers — a TOML ARRAY-OF-TABLES. */
const MCP_ROOT_KEY = "mcp_servers";

/**
 * Native Mistral Vibe MCP server entry shapes. `name` is the required short
 * alias (we key ownership on it). A stdio entry carries an explicit
 * `transport: "stdio"` + command/args/env; a remote entry carries the chosen
 * transport + url/headers. NO api_key_* / *_timeout_sec unless declared.
 */
interface VibeStdioServer {
  name: string;
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
interface VibeRemoteServer {
  name: string;
  transport: "http" | "streamable-http";
  url: string;
  headers?: Record<string, string>;
}
type VibeServer = VibeStdioServer | VibeRemoteServer;

export class MistralVibeAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Mistral Vibe";
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    // mcp-only: no hook layer wired (experimental host hooks are not
    // byte-confirmed — see header HONEST CEILING). No memory/content surfaces
    // wired either; only the MCP server is installed. Every hook capability is
    // false.
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
    // Mistral Vibe registers stdio + remote (http / streamable-http) MCP
    // servers. The framework's `http` transport maps to Vibe's "http"; `sse`
    // maps to Vibe's "streamable-http" (its closest remote form).
    transports: ["stdio", "http", "sse"],
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = this.userConfigDir();
    const userCfg = join(userDir, "config.toml");
    const projDir = join(projectDir, ".vibe");
    const projCfg = join(projDir, "config.toml");

    const userInstalled = existsSync(userDir) || existsSync(userCfg);
    const projInstalled = existsSync(projDir) || existsSync(projCfg);
    const installed = userInstalled || projInstalled;
    // Project config.toml takes precedence in Vibe's lookup order, so a
    // project-only install reports project scope.
    const scope = projInstalled && !userInstalled ? "project" : "user";
    const configPath = scope === "project" ? projCfg : userCfg;

    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath,
      scope,
      reason: installed
        ? `found Mistral Vibe config (${scope}) at ${configPath}`
        : `no .vibe config at ${userDir} or ${projDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  /** ~/.vibe (user) or <projectDir>/.vibe (project). */
  override getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".vibe")
      : this.userConfigDir();
  }

  /** MCP config: config.toml under the per-scope .vibe dir. */
  override getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "config.toml");
  }

  /**
   * Mistral Vibe has no AC-wired hook file (mcp-only — see header). The hook
   * "config path" is the same config.toml so the generic doctor/backup behave
   * sensibly (mirrors warp/zed).
   */
  override getHookConfigPath(ctx: InstallContext): string {
    return this.getServerConfigPath(ctx);
  }

  /** ~/.vibe — homedir() covers %USERPROFILE% on Windows. */
  private userConfigDir(): string {
    return join(homedir(), ".vibe");
  }

  // ── TOML config IO ─────────────────────────────────────────────────────────

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

  // ── MCP server install / uninstall (TOML — ARRAY-OF-TABLES, by `name`) ──────

  override installServer(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    const path = this.getServerConfigPath(ctx);
    const server = this.effectiveServer(ctx);

    if (!server) {
      return [
        {
          platform: this.id,
          action: "skip",
          path,
          detail: connector.server
            ? "server registration disabled for mistral-vibe"
            : "connector declares no MCP server",
        },
      ];
    }

    const symlink = this.symlinkPathWarning(path);
    if (symlink) return [symlink];

    const entry = this.renderServerEntry(ctx, server);

    // Merge into existing TOML, preserving every other config key + sibling
    // mcp_servers entry. mcp_servers is a TOML ARRAY-OF-TABLES; we key on `name`.
    const cfg = this.readToml(path);
    // NEVER clobber a malformed `mcp_servers`: if it exists and is not an array,
    // skip-and-warn (symmetric with uninstallServer) rather than silently
    // replacing the user's hand-written value.
    const existingRoot = cfg[MCP_ROOT_KEY];
    if (existingRoot !== undefined && !Array.isArray(existingRoot)) {
      return [
        {
          platform: this.id,
          action: "skip",
          path,
          detail: `${MCP_ROOT_KEY} is not a TOML array — left untouched (manual fix needed)`,
        },
      ];
    }

    const list = Array.isArray(existingRoot) ? (existingRoot as VibeServer[]) : [];
    const idx = list.findIndex((e) => this.entryName(e) === connector.id);

    let action: ChangeRecord["action"];
    if (idx < 0) {
      list.push(entry);
      action = "create";
    } else if (JSON.stringify(list[idx]) === JSON.stringify(entry)) {
      action = "skip";
    } else {
      list[idx] = entry;
      action = "update";
    }

    if (action !== "skip") {
      cfg[MCP_ROOT_KEY] = list;
      this.writeToml(path, cfg, dryRun);
    }
    return [{ platform: this.id, action, path, detail: `${MCP_ROOT_KEY}[name=${connector.id}]` }];
  }

  override uninstallServer(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    const path = this.getServerConfigPath(ctx);
    const symlink = this.symlinkPathWarning(path);
    if (symlink) return [symlink];

    const cfg = this.readToml(path);
    const rawList = cfg[MCP_ROOT_KEY];
    if (!Array.isArray(rawList)) {
      return [
        {
          platform: this.id,
          action: "skip",
          path,
          detail: `${MCP_ROOT_KEY}[name=${connector.id}] absent`,
        },
      ];
    }

    const list = rawList as VibeServer[];
    const kept = list.filter((e) => this.entryName(e) !== connector.id);
    if (kept.length === list.length) {
      return [
        {
          platform: this.id,
          action: "skip",
          path,
          detail: `${MCP_ROOT_KEY}[name=${connector.id}] absent`,
        },
      ];
    }

    cfg[MCP_ROOT_KEY] = kept;
    this.writeToml(path, cfg, dryRun);
    return [
      { platform: this.id, action: "remove", path, detail: `${MCP_ROOT_KEY}[name=${connector.id}]` },
    ];
  }

  /**
   * Render a normalized ServerDef into Mistral Vibe's native mcp_servers entry.
   * TOML has no native ${env:VAR} token — resolve every reference to a literal at
   * install time (the safe path, matching codex/droid). Honors the telemetry
   * serve-wrapper for stdio.
   */
  private renderServerEntry(ctx: InstallContext, server: ServerDef): VibeServer {
    const transport: Transport = server.transport;

    if (transport === "stdio") {
      let command = server.command ?? "";
      let args = [...(server.args ?? [])];

      ({ command, args } = buildWrappedStdio(ctx, server, this.id, command, args));

      command = resolveEnvRefsDeep(command);
      args = resolveEnvRefsDeep(args);

      const entry: VibeStdioServer = {
        name: ctx.connector.id,
        transport: "stdio",
        command,
      };
      if (args.length > 0) entry.args = args;
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      return entry;
    }

    // Remote (sse / http / ws) — Vibe registers an explicit transport + url. The
    // framework's `http` transport maps to Vibe's "http"; `sse` maps to
    // "streamable-http" (ws has no Vibe analog → also "streamable-http", the
    // closest documented remote form).
    const vibeTransport: VibeRemoteServer["transport"] =
      transport === "http" ? "http" : "streamable-http";
    const entry: VibeRemoteServer = {
      name: ctx.connector.id,
      transport: vibeTransport,
      url: resolveEnvRefsDeep(server.url ?? ""),
    };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Resolve `${env:VAR}` references to literals at
   * install time (TOML cannot interpolate).
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(resolveEnvRefsDeep({ ...env }))) {
      out[k] = String(v);
    }
    return out;
  }

  // ── Hooks (unavailable — Mistral Vibe is mcp-only) ───────────────────────
  // HONEST CEILING: Vibe ships only an experimental hook surface with no
  // byte-confirmed format/event-name contract, so AC wires no hooks here.

  installHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Mistral Vibe is mcp-only)",
      },
    ];
  }

  uninstallHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Mistral Vibe is mcp-only)",
      },
    ];
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const path = this.getServerConfigPath(ctx);
    const id = ctx.connector.id;
    return [
      {
        name: `${this.name}: config.toml present`,
        check: () =>
          existsSync(path)
            ? { status: "OK", detail: path }
            : { status: "FAIL", detail: `not found: ${path}` },
      },
      {
        name: `${this.name}: ${MCP_ROOT_KEY}[name=${id}] registered`,
        check: () => {
          if (!ctx.connector.server) return { status: "OK", detail: "no MCP server declared" };
          const cfg = this.readToml(path);
          const list = cfg[MCP_ROOT_KEY];
          const present =
            Array.isArray(list) &&
            (list as VibeServer[]).some((e) => this.entryName(e) === id);
          return present
            ? { status: "OK", detail: `${MCP_ROOT_KEY}[name=${id}]` }
            : { status: "FAIL", detail: `${MCP_ROOT_KEY}[name=${id}] not found in ${path}` };
        },
      },
    ];
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /** The `name` of an array entry, or undefined when it is not a named object. */
  private entryName(entry: unknown): string | undefined {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const name = (entry as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  }

  /** Resolve the per-platform server override into an effective ServerDef. */
  private effectiveServer(ctx: InstallContext): ServerDef | undefined {
    const override = ctx.connector.platforms[this.id]?.server;
    if (override === false) return undefined;
    const base = ctx.connector.server;
    if (!base) return undefined;
    return override && typeof override === "object" ? { ...base, ...override } : base;
  }
}

export const adapter = new MistralVibeAdapter();
export default adapter;
