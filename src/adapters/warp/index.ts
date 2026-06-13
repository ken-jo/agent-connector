/**
 * adapters/warp — Warp (Warp.dev) platform adapter for agent-connector.
 *
 * Warp is an **mcp-only** host: it has NO lifecycle hook system (open FR #7834),
 * and MCP *is* its extensibility mechanism ("MCP servers act as plugins"). This
 * adapter therefore installs only the MCP server and reports hooks as
 * unavailable — it is the reference path that validates the `mcp-only` paradigm
 * end-to-end through the framework.
 *
 * MCP config (report §2 / §5.3):
 *   - user scope    → ~/.warp/.mcp.json
 *   - project scope → <projectDir>/.warp/.mcp.json
 *   Both are JSON, root key "mcpServers", and are the SAME file used for the
 *   (non-existent) hook registration — there is no separate hook file here.
 *
 * QUIRK: a stdio server entry uses `working_directory` (NOT `cwd`) for its
 * working directory. Everything else mirrors the Claude/Cursor stdio shape.
 *
 * Warp documents no native `${env:VAR}` interpolation token, so env/header/url
 * refs are resolved to literals at install time (the no-native-token path).
 *
 * Skills surface: Warp reads SKILL.md files from `.agents/skills/<name>/SKILL.md`
 * (project scope). Skills double as slash-commands in Warp's UI — a skill named
 * "pdf-tools" is invocable as `/pdf-tools`. No user-scope skills dir is
 * documented for Warp; user-scope install reports a skip-warn.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { BaseAdapter } from "../base.js";
import type { Adapter, InstallContext, MemoryTarget } from "../spi.js";
import type {
  ChangeRecord,
  DetectedPlatform,
  HealthCheck,
  HookParadigm,
  PlatformCapabilities,
  PlatformId,
  ServerDef,
  SkillDef,
  Transport,
} from "../../core/types.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  buildServeWrapperCommand,
  isHomeBinHookCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";
import { renderSkillMd } from "../claude-code/render.js";

const HOST: PlatformId = "warp";
const MCP_ROOT_KEY = "mcpServers";

/**
 * Native MCP server entry shapes Warp accepts under `mcpServers`.
 * Note the working-directory key: Warp uses `working_directory`, not `cwd`.
 */
interface WarpStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  working_directory?: string;
}
interface WarpHttpServer {
  url: string;
  headers?: Record<string, string>;
}

export class WarpAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Warp";
  readonly paradigm: HookParadigm = "mcp-only";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: AGENTS.md-first managed block. memoryTargets below probes
    // for a legacy WARP.md (it takes priority over AGENTS.md in the same dir);
    // user-scope rules live in Warp Drive (cloud) → standard skip-warn.
    supportsMemory: true,
    // Warp has no lifecycle hook system — every hook capability is false.
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
    // Warp registers stdio, SSE, and Streamable HTTP MCP servers.
    transports: ["stdio", "sse", "http"],
    // Skills: Warp reads SKILL.md from .agents/skills/<name>/SKILL.md (project
    // scope only; user-scope skills dir is not documented for Warp).
    supportsSkills: true,
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".warp");
    const userMcp = join(userDir, ".mcp.json");
    const projectMcp = join(projectDir, ".warp", ".mcp.json");
    const installed = existsSync(userDir) || existsSync(userMcp) || existsSync(projectMcp);
    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath: userMcp,
      scope: "user",
      reason: installed
        ? `found Warp config under ${userDir}`
        : `no Warp config at ${userDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Memory surface: WARP.md shadow probe (project scope) ────────────────
  // AGENTS.md is Warp's DEFAULT project rules file, but a legacy WARP.md in
  // the same directory still takes priority — a block in AGENTS.md beside an
  // existing WARP.md would be shadowed, so the probe targets the file Warp
  // actually reads. User scope has no row in the base map (Warp Drive rules
  // are cloud-managed) → the standard skip-warn.
  protected override memoryTargets(ctx: InstallContext): MemoryTarget[] {
    if (this.memoryOverride(ctx)?.path || ctx.scope !== "project") {
      return super.memoryTargets(ctx);
    }
    const warpMd = join(ctx.projectDir, "WARP.md");
    if (existsSync(warpMd)) {
      return [
        { path: warpMd, reason: "WARP.md takes priority over AGENTS.md in the same dir on warp" },
      ];
    }
    return [
      { path: join(ctx.projectDir, "AGENTS.md"), reason: "AGENTS.md (warp's default rules file)" },
    ];
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".warp")
      : join(homedir(), ".warp");
  }

  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), ".mcp.json");
  }

  /**
   * Warp has no hook file — hooks are not a thing here. The hook "config path"
   * is the same .mcp.json so the generic doctor/backup behave sensibly.
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
            ? "server registration disabled for warp"
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

  /** Render a normalized ServerDef into Warp's native mcpServers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): WarpStdioServer | WarpHttpServer {
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

      // Warp has no documented native interpolation token, so resolve every
      // ${env:VAR} to a literal at install time.
      const entry: WarpStdioServer = { command: resolveEnvRefsDeep(command) };
      if (args.length > 0) entry.args = resolveEnvRefsDeep(args);
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      // QUIRK: Warp keys the working directory as `working_directory`, not `cwd`.
      if (server.cwd) entry.working_directory = resolveEnvRefsDeep(server.cwd);
      return entry;
    }

    // sse / http (and any other remote transport) — Warp registers a URL.
    const entry: WarpHttpServer = { url: resolveEnvRefsDeep(server.url ?? "") };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Warp documents no native interpolation token, so
   * resolve `${env:VAR}` references to literals at install time.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Skills surface ───────────────────────────────────────────────────────
  // Warp reads SKILL.md files from `.agents/skills/<name>/SKILL.md`.
  // Skills double as slash-commands in Warp's UI (/name).
  // Only project scope is documented; user-scope install skips with a warn
  // (Warp Drive manages user rules in the cloud — no local user skills dir).

  private skillsDir(ctx: InstallContext): string {
    return join(ctx.projectDir, ".agents", "skills");
  }

  private skillDir(ctx: InstallContext, name: string): string {
    return join(this.skillsDir(ctx), name);
  }

  override installSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.skills === false) {
      return [{ platform: this.id, action: "skip", detail: "skills disabled for warp" }];
    }
    if (connector.skills.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no skills" }];
    }
    if (ctx.scope !== "project") {
      return [
        {
          platform: this.id,
          action: "warn",
          detail: "warp skills are project-scoped only (no documented user-scope skills dir); skipped",
        },
      ];
    }
    const changes: ChangeRecord[] = [];
    for (const skill of connector.skills) {
      const dir = this.skillDir(ctx, skill.name);
      changes.push(
        this.writeContentFile(join(dir, "SKILL.md"), this.renderSkill(skill), ctx.dryRun),
      );
      for (const [rel, contents] of Object.entries(skill.resources ?? {})) {
        const target = this.resolveWithin(dir, rel);
        if (target === null) {
          changes.push({
            platform: this.id,
            action: "warn",
            detail: `skill resource "${rel}" escapes the skill dir; skipped`,
          });
          continue;
        }
        changes.push(this.writeContentFile(target, contents, ctx.dryRun));
      }
    }
    return changes;
  }

  override uninstallSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.skills.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no skills" }];
    }
    if (ctx.scope !== "project") {
      return [{ platform: this.id, action: "skip", detail: "warp skills are project-scoped only" }];
    }
    const changes: ChangeRecord[] = [];
    for (const skill of connector.skills) {
      const dir = this.skillDir(ctx, skill.name);
      changes.push(this.removeContentFile(join(dir, "SKILL.md"), ctx.dryRun));
      for (const rel of Object.keys(skill.resources ?? {})) {
        const target = this.resolveWithin(dir, rel);
        if (target === null) continue;
        changes.push(this.removeContentFile(target, ctx.dryRun));
      }
      changes.push(this.removeDirIfEmpty(dir, ctx.dryRun));
    }
    return changes;
  }

  private renderSkill(skill: SkillDef): string {
    return renderSkillMd(skill);
  }

  // ── Hooks (unavailable — Warp is mcp-only) ───────────────────────────────

  installHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Warp is mcp-only)",
      },
    ];
  }

  uninstallHooks(_ctx: InstallContext): ChangeRecord[] {
    return [
      {
        platform: this.id,
        action: "skip",
        detail: "hooks unavailable (Warp is mcp-only)",
      },
    ];
  }

  /**
   * True when a hook command references our home binary AND this connector id
   * (anchored so a shared-prefix id can't collide — see isHomeBinHookCommand).
   * Warp installs no hooks, but this guard keeps any future shared-file edit
   * from removing another connector's entries.
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
        name: `${this.name}: .mcp.json present`,
        check: () =>
          existsSync(mcpPath)
            ? { status: "OK", detail: mcpPath }
            : { status: "FAIL", detail: `not found: ${mcpPath}` },
      },
      {
        name: `${this.name}: server entry registered`,
        check: () => {
          // Only assert what the connector declares: a server-less connector —
          // e.g. a catalog-only bundle of agents/skills/commands — never writes
          // an mcpServers entry, so its absence is healthy.
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

export const adapter = new WarpAdapter();
export default adapter;
