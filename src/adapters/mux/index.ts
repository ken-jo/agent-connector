/**
 * adapters/mux — Mux (Coder) platform adapter for agent-connector.
 *
 * Mux is an **mcp-only** host: it exposes no lifecycle hook system, and MCP is
 * its extensibility mechanism. This adapter therefore installs only the MCP
 * server and reports hooks as unavailable — the same shape as the Warp
 * reference adapter.
 *
 * MCP config:
 *   - user scope    → ~/.mux/mcp.jsonc
 *   - project scope → <projectDir>/.mux/mcp.jsonc
 *   Both are JSONC (comments allowed) but we write strict JSON. The root key is
 *   "servers", and this file doubles as the (non-existent) hook config — there
 *   is no separate hook file here.
 *
 * QUIRK: Mux models each server entry as a single shell-command STRING, not an
 * object. So `servers[id]` is `"<exe> <arg1> <arg2> ..."` — space-joined, with
 * any token containing whitespace double-quoted. We therefore build that string
 * ourselves and upsert it idempotently (the generic object upsert helper would
 * write the wrong shape). When telemetry-wrapping, the string is the home-bin
 * `serve` wrapper command followed by its args.
 *
 * Mux documents no native `${env:VAR}` interpolation token, so env-refs in the
 * command/args are resolved to literals at install time. The string form has no
 * place for an env map, so server.env is dropped with no native equivalent.
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
} from "../../core/types.js";
import { resolveEnvRefs, resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  buildServeWrapperCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";

const HOST: PlatformId = "mux";
const MCP_ROOT_KEY = "servers";

/** Quote a token only when it contains whitespace (Mux command-string form). */
function quoteToken(token: string): string {
  return /\s/.test(token) ? `"${token}"` : token;
}

/** Join an executable + args into Mux's single shell-command string. */
function buildCommandString(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteToken).join(" ");
}

export class MuxAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Mux";
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: AGENTS.md-first managed block via the BaseAdapter default
    // (memoryTargets: project <projectDir>/AGENTS.md; user scope where documented).
    supportsMemory: true,
    // Mux has no lifecycle hook system — every hook capability is false.
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
    // Mux's command-string server entry is stdio-only.
    transports: ["stdio"],
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".mux");
    const userMcp = join(userDir, "mcp.jsonc");
    const projDir = join(projectDir, ".mux");
    const projMcp = join(projDir, "mcp.jsonc");

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
        ? `found Mux config (${scope})`
        : `no Mux config at ${userDir} or ${projDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".mux")
      : join(homedir(), ".mux");
  }

  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "mcp.jsonc");
  }

  /**
   * Mux has no hook file — hooks are not a thing here. The hook "config path"
   * is the same mcp.jsonc so the generic doctor/backup behave sensibly.
   */
  getHookConfigPath(ctx: InstallContext): string {
    return this.getServerConfigPath(ctx);
  }

  // ── MCP server install / uninstall ───────────────────────────────────────

  installServer(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    const override = connector.platforms[HOST]?.server;
    if (!connector.server || override === false) {
      return [
        {
          platform: this.id,
          action: "skip",
          detail: connector.server
            ? "server registration disabled for mux"
            : "connector declares no MCP server",
        },
      ];
    }

    // Shallow-merge any per-platform server override into the base ServerDef.
    const server: ServerDef =
      override && typeof override === "object"
        ? { ...connector.server, ...override }
        : connector.server;

    const path = this.getServerConfigPath(ctx);

    if (server.transport !== "stdio" || !server.command) {
      // Mux's command-string entry is stdio-only; remote transports skip.
      return [
        {
          platform: this.id,
          action: "skip",
          path,
          detail: `transport "${server.transport}" not registrable (mux expects a stdio command string)`,
        },
      ];
    }

    const entry = this.renderCommandString(ctx, server);

    // QUIRK: each server value is a STRING, not an object — so we cannot use the
    // generic object upsert helper. Build the string and upsert idempotently.
    const cfg =
      this.readJson<Record<string, Record<string, unknown>>>(path) ?? {};
    const bucket = (cfg[MCP_ROOT_KEY] ??= {});
    const before = JSON.stringify(bucket[connector.id]);
    const after = JSON.stringify(entry);

    let action: ChangeRecord["action"];
    if (before === undefined) action = "create";
    else if (before === after) action = "skip";
    else action = "update";

    if (action !== "skip") {
      bucket[connector.id] = entry;
      this.writeJson(path, cfg, dryRun);
    }
    return [
      { platform: this.id, action, path, detail: `${MCP_ROOT_KEY}.${connector.id}` },
    ];
  }

  uninstallServer(ctx: InstallContext): ChangeRecord[] {
    const path = this.getServerConfigPath(ctx);
    return [
      this.removeServerFromJson(path, MCP_ROOT_KEY, ctx.connector.id, ctx.dryRun),
    ];
  }

  /**
   * Render a stdio ServerDef into Mux's single shell-command string. Honors the
   * telemetry serve-wrapper and resolves every `${env:VAR}` to a literal (Mux
   * documents no native interpolation token).
   */
  private renderCommandString(ctx: InstallContext, server: ServerDef): string {
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

    // Resolve env-refs to literals (Mux has no native interpolation token).
    command = resolveEnvRefs(command);
    args = resolveEnvRefsDeep(args);

    return buildCommandString(command, args);
  }

  // ── Hooks (unavailable — Mux is mcp-only) ─────────────────────────────────

  installHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Mux is mcp-only)",
      },
    ];
  }

  uninstallHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Mux is mcp-only)",
      },
    ];
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const mcpPath = this.getServerConfigPath(ctx);
    const connectorId = ctx.connector.id;
    return [
      {
        name: `${this.name}: mcp.jsonc present`,
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
          const cfg = this.readJson<{ [k: string]: Record<string, unknown> }>(
            mcpPath,
          );
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

export const adapter = new MuxAdapter();
export default adapter;
