/**
 * adapters/continue — Continue (the `cn` terminal agent / Continue.dev) adapter.
 *
 * Continue is an **mcp-only** host from agent-connector's perspective: there is
 * NO primary-verified Continue hook/lifecycle layer to wire, so this adapter
 * installs the MCP server entry only. (Continue ships a "Rules"/memory surface
 * and "prompts" too, but neither is wired here — memory renders as an honest
 * host-gap on the wall; see site/src/platform-data.ts.)
 *
 * MCP config is YAML (primary-verified — docs.continue.dev/customize/deep-dives/
 * mcp + /reference + /customize/mcp-tools + /guides/cli):
 *   - user/global scope → ~/.continue/config.yaml
 *                         (Windows %USERPROFILE%\.continue\config.yaml — covered
 *                          by homedir())
 *   - project scope     → <projectDir>/.continue/config.yaml (workspace root)
 *
 * Root key `mcpServers` is a YAML **ARRAY** of server objects (NOT a keyed
 * object/map like the JSON hosts). Each entry:
 *   { name (required — the server's display id), command (required for stdio),
 *     type? (stdio|sse|streamable-http; defaults to stdio), args? (string[]),
 *     env? (map), cwd? (string), url (required for sse/streamable-http remote) }.
 * The connector id is written as the entry's `name`; install is set-if-absent by
 * name (append when missing; leave a present entry untouched unless it differs →
 * update), preserving every sibling entry. Uninstall removes ONLY the entry whose
 * name === connector id.
 *
 * Because the file is YAML, the BaseAdapter JSON helpers do not apply; this
 * adapter merges via core/yaml's readYaml/writeYaml (same lib as goose/hermes),
 * preserving any unrelated config the user authored.
 *
 * NOT primary-verified → deliberately NOT emitted: `apiKey`, `requestOptions`,
 * `connectionTimeout`. Per-server block files (.continue/mcpServers/*.yaml)
 * auto-discovery for the `cn` CLI is also unverified — both scopes use the
 * verified config.yaml `mcpServers` array.
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
import { readYaml, writeYaml } from "../../core/yaml.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  buildServeWrapperCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";

const HOST: PlatformId = "continue";
/** Root key under which Continue stores MCP servers in config.yaml — a YAML ARRAY. */
const MCP_ROOT_KEY = "mcpServers";

/**
 * Native Continue MCP server entry shapes. `name` is the required display id (we
 * key on it). stdio omits `type` (the documented default); remote emits an
 * explicit `type` + `url` and carries no command. NO apiKey/requestOptions/
 * connectionTimeout (not primary-verified → never emitted).
 */
interface ContinueStdioServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}
interface ContinueRemoteServer {
  name: string;
  type: "sse" | "streamable-http";
  url: string;
}
type ContinueServer = ContinueStdioServer | ContinueRemoteServer;

export class ContinueAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Continue";
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: DEFERRED. Continue has a native "Rules" surface, but it
    // lives under .continue (NOT AGENTS.md), so the AGENTS.md-first BaseAdapter
    // default does not apply. Leave supportsMemory unset (→ false): memory
    // renders as an honest host-gap (hostNative true, surfaces false) until the
    // rules surface is wired.
    //
    // mcp-only: there is no primary-verified Continue hook layer, so every hook
    // flag is false (hooks not wired into AC install).
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
    // Continue registers stdio + remote (SSE / Streamable HTTP) MCP servers
    // (primary-verified: type ∈ stdio|sse|streamable-http). Mapped to the
    // framework's transport enum: stdio + sse + http (http = streamable-http).
    transports: ["stdio", "sse", "http"],
    // Content surfaces: Continue's Rules/prompts are NOT wired here. Leave the
    // supports* flags UNSET (base skip-warns).
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = this.userConfigDir();
    const userCfg = join(userDir, "config.yaml");
    const projCfg = join(projectDir, ".continue", "config.yaml");

    const userInstalled = existsSync(userDir) || existsSync(userCfg);
    const projInstalled = existsSync(projCfg);
    const installed = userInstalled || projInstalled;
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
        ? `found Continue config (${scope}) at ${configPath}`
        : `no Continue config at ${userCfg} or ${projCfg}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  /** ~/.continue (user) or <projectDir>/.continue (project). */
  override getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".continue")
      : this.userConfigDir();
  }

  /** MCP config: config.yaml under the per-scope .continue dir. */
  override getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "config.yaml");
  }

  /** Continue has no separate hook file — alias the MCP file (roo-code idiom). */
  override getHookConfigPath(ctx: InstallContext): string {
    return this.getServerConfigPath(ctx);
  }

  /** ~/.continue — homedir() covers %USERPROFILE% on Windows. */
  private userConfigDir(): string {
    return join(homedir(), ".continue");
  }

  // ── MCP server install / uninstall (YAML — ARRAY merge) ───────────────────

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
            ? "server registration disabled for continue"
            : "connector declares no MCP server",
        },
      ];
    }

    const entry = this.renderServerEntry(ctx, server);

    // Merge into existing YAML, preserving every other config key + sibling
    // mcpServers entry. mcpServers is a YAML ARRAY; we key on `name`.
    const cfg = readYaml<Record<string, unknown>>(path) ?? {};
    const list = this.serverArray(cfg);
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
      writeYaml(path, cfg, dryRun);
    }
    return [{ platform: this.id, action, path, detail: `${MCP_ROOT_KEY}[name=${connector.id}]` }];
  }

  override uninstallServer(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    const path = this.getServerConfigPath(ctx);
    const cfg = readYaml<Record<string, unknown>>(path);
    const rawList = cfg?.[MCP_ROOT_KEY];
    if (!cfg || !Array.isArray(rawList)) {
      return [
        {
          platform: this.id,
          action: "skip",
          path,
          detail: `${MCP_ROOT_KEY}[name=${connector.id}] absent`,
        },
      ];
    }

    const list = rawList as ContinueServer[];
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
    writeYaml(path, cfg, dryRun);
    return [
      { platform: this.id, action: "remove", path, detail: `${MCP_ROOT_KEY}[name=${connector.id}]` },
    ];
  }

  /**
   * Render a normalized ServerDef into Continue's native mcpServers entry.
   * Continue has no documented native ${env:VAR} token — resolve every reference
   * to a literal at install time (the safe path, matching amazon-q/goose/hermes).
   * Honors the telemetry serve-wrapper for stdio.
   */
  private renderServerEntry(ctx: InstallContext, server: ServerDef): ContinueServer {
    const transport: Transport = server.transport;

    if (transport === "stdio") {
      let command = server.command ?? "";
      let args = [...(server.args ?? [])];

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

      command = resolveEnvRefsDeep(command);
      args = resolveEnvRefsDeep(args);

      // stdio omits `type` (Continue's documented default).
      const entry: ContinueStdioServer = {
        name: ctx.connector.id,
        command,
      };
      if (args.length > 0) entry.args = args;
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      if (typeof server.cwd === "string" && server.cwd.length > 0) {
        entry.cwd = resolveEnvRefsDeep(server.cwd);
      }
      return entry;
    }

    // Remote (sse / http / ws) — Continue registers an explicit type + url. The
    // framework's `http` transport maps to Continue's "streamable-http"; `sse`
    // maps to "sse". (ws has no Continue analog → fall through to streamable-http
    // URL form, which is the closest documented remote shape.)
    const type: ContinueRemoteServer["type"] = transport === "sse" ? "sse" : "streamable-http";
    return {
      name: ctx.connector.id,
      type,
      url: resolveEnvRefsDeep(server.url ?? ""),
    };
  }

  /**
   * Render stdio env values. Continue has no documented native interpolation
   * token, so resolve `${env:VAR}` references to literals at install time.
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

  // ── Hooks (unavailable — Continue is mcp-only) ────────────────────────────

  override installHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Continue is mcp-only)",
      },
    ];
  }

  override uninstallHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Continue is mcp-only)",
      },
    ];
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const path = this.getServerConfigPath(ctx);
    const id = ctx.connector.id;
    return [
      {
        name: `${this.name}: config.yaml present`,
        check: () =>
          existsSync(path)
            ? { status: "OK", detail: path }
            : { status: "FAIL", detail: `not found: ${path}` },
      },
      {
        name: `${this.name}: ${MCP_ROOT_KEY}[name=${id}] registered`,
        check: () => {
          if (!ctx.connector.server) return { status: "OK", detail: "no MCP server declared" };
          const cfg = readYaml<Record<string, unknown>>(path);
          const list = cfg?.[MCP_ROOT_KEY];
          const present =
            Array.isArray(list) &&
            (list as ContinueServer[]).some((e) => this.entryName(e) === id);
          return present
            ? { status: "OK", detail: `${MCP_ROOT_KEY}[name=${id}]` }
            : { status: "FAIL", detail: `${MCP_ROOT_KEY}[name=${id}] not found in ${path}` };
        },
      },
    ];
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /** Get-or-create the mcpServers ARRAY at `cfg.mcpServers` (tolerate non-array). */
  private serverArray(cfg: Record<string, unknown>): ContinueServer[] {
    const existing = cfg[MCP_ROOT_KEY];
    if (Array.isArray(existing)) return existing as ContinueServer[];
    const fresh: ContinueServer[] = [];
    cfg[MCP_ROOT_KEY] = fresh;
    return fresh;
  }

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

export const adapter = new ContinueAdapter();
export default adapter;
