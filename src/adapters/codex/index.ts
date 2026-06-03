/**
 * adapters/codex — Codex CLI platform adapter for agent-connector.
 *
 * Codex CLI hook paradigm is "json-stdio": the host pipes a JSON payload to a
 * command on stdin and reads JSON/exit-code back — the same wire protocol as
 * Claude Code (PascalCase fields, `hookSpecificOutput` reply wrapper).
 *
 * Two native config files live under the Codex config dir
 * (`$CODEX_HOME` || `~/.codex`, mirrored to `<projectDir>/.codex` for project
 * scope):
 *   - config.toml  → `[mcp_servers.<id>]` MCP registration (TOML, NO native
 *     interpolation, so env-refs are resolved to literals at install time).
 *   - hooks.json   → Claude-compatible hook registration ({ matcher, hooks }).
 *
 * Grounded in context-mode's proven Codex adapter (configs/codex/{config.toml,
 * hooks.json}, src/adapters/codex/*) — exact TOML MCP shape + hook JSON schema.
 *
 * Known Codex limitations (upstream): PreToolUse deny works but updatedInput is
 * not yet honored (openai/codex#18491); PostToolUse updatedMCPToolOutput is
 * parsed-but-unsupported — hence canModifyArgs / canModifyOutput are false.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import TOML from "@iarna/toml";

import type {
  ChangeRecord,
  DetectedPlatform,
  HealthCheck,
  HookEventName,
  HookParadigm,
  HookResponse,
  PlatformCapabilities,
  PlatformId,
  ServerDef,
} from "../../core/types.js";
import { ensureDir } from "../../core/paths.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  buildHomeBinHookCommand,
  buildServeWrapperCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";
import { BaseAdapter } from "../base.js";
import type {
  HookReply,
  InstallContext,
  NormalizedEvent,
} from "../spi.js";

// ─────────────────────────────────────────────────────────────────────────
// Native shapes
// ─────────────────────────────────────────────────────────────────────────

/** Raw Codex hook payload (PascalCase event, snake_case fields — Claude-style). */
interface CodexHookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: string;
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  prompt?: string;
  is_error?: boolean;
  stop_hook_active?: boolean;
  trigger?: string;
  message?: string;
}

/** One hook entry inside hooks.json (Claude-compatible). */
interface CodexHookEntry {
  matcher?: string;
  hooks: Array<{ type: "command"; command: string }>;
}

interface CodexHooksFile {
  hooks?: Record<string, CodexHookEntry[]>;
  [key: string]: unknown;
}

/** Rendered `[mcp_servers.<id>]` table — string env table, no interpolation. */
interface CodexMcpEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Codex hook events agent-connector registers, in the canonical → native order.
 * Codex uses the same PascalCase event names as Claude Code; the home-binary
 * hook command receives the lowercased event token.
 */
const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "UserPromptSubmit",
  "Stop",
] as const;

type CodexHookEventName = (typeof CODEX_HOOK_EVENTS)[number];

/**
 * PreToolUse matcher — canonical Codex tool names + bare MCP tool names +
 * external MCP catch-all literal. Charset-clean ([A-Za-z0-9_|] only) so Codex's
 * Rust `regex` exact-matcher short-circuits (no look-around, which Codex
 * rejects at boot). Copied from context-mode's proven matcher.
 */
const PRE_TOOL_USE_MATCHER =
  "local_shell|shell|shell_command|exec_command|Bash|Shell|apply_patch|Edit|Write|grep_files|mcp__";

// ─────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────

export class CodexAdapter extends BaseAdapter {
  readonly id: PlatformId = "codex";
  readonly name = "Codex CLI";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    preCompact: true,
    sessionStart: true,
    sessionEnd: false,
    userPromptSubmit: true,
    stop: true,
    notification: false,
    canModifyArgs: false,
    canModifyOutput: false,
    canInjectSessionContext: true,
    transports: ["stdio", "http"],
  };

  // ── Detection ──────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = this.userConfigDir();
    const projDir = join(projectDir, ".codex");
    const userCfg = join(userDir, "config.toml");
    const projCfg = join(projDir, "config.toml");

    const userInstalled = existsSync(userDir) || existsSync(userCfg);
    const projInstalled = existsSync(projDir) || existsSync(projCfg);
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
        ? `Found Codex config dir (${scope})`
        : `No .codex config dir at ${userDir} or ${projDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ───────────────────────────────────────────────────────

  override getConfigDir(ctx: InstallContext): string {
    if (ctx.scope === "project") return join(ctx.projectDir, ".codex");
    return this.userConfigDir();
  }

  override getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "config.toml");
  }

  override getHookConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "hooks.json");
  }

  /** `$CODEX_HOME` || `~/.codex` for user scope. */
  private userConfigDir(): string {
    const env = process.env.CODEX_HOME;
    if (env && env.trim() !== "") {
      if (env.startsWith("~")) {
        return join(homedir(), env.replace(/^~[/\\]?/, ""));
      }
      return env;
    }
    return join(homedir(), ".codex");
  }

  // ── TOML config IO (override JSON helpers — config.toml is TOML) ─────────

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

  // ── Install server (config.toml → [mcp_servers.<id>]) ───────────────────

  override installServer(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    const server = this.effectiveServer(ctx);
    const path = this.getServerConfigPath(ctx);

    if (!server) {
      return [{ platform: this.id, action: "skip", path, detail: "no server declared" }];
    }
    if (server.transport !== "stdio" || !server.command) {
      // Codex config.toml [mcp_servers] is stdio-only; remote transports skip here.
      return [
        {
          platform: this.id,
          action: "skip",
          path,
          detail: `transport "${server.transport}" not registrable in config.toml (stdio only)`,
        },
      ];
    }

    const entry = this.renderMcpEntry(ctx, server);

    const cfg = this.readToml(path);
    const bucket = this.tomlBucket(cfg, "mcp_servers");
    const before = JSON.stringify(bucket[connector.id]);
    const after = JSON.stringify(entry);

    let action: ChangeRecord["action"];
    if (before === undefined) action = "create";
    else if (before === after) action = "skip";
    else action = "update";

    if (action !== "skip") {
      bucket[connector.id] = entry as unknown as Record<string, unknown>;
      this.writeToml(path, cfg, dryRun);
    }
    return [{ platform: this.id, action, path, detail: `mcp_servers.${connector.id}` }];
  }

  override uninstallServer(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    const path = this.getServerConfigPath(ctx);
    const cfg = this.readToml(path);
    const bucket = cfg["mcp_servers"];
    if (
      !existsSync(path) ||
      typeof bucket !== "object" ||
      bucket === null ||
      !(connector.id in (bucket as Record<string, unknown>))
    ) {
      return [
        {
          platform: this.id,
          action: "skip",
          path,
          detail: `mcp_servers.${connector.id} absent`,
        },
      ];
    }
    delete (bucket as Record<string, unknown>)[connector.id];
    this.writeToml(path, cfg, dryRun);
    return [{ platform: this.id, action: "remove", path, detail: `mcp_servers.${connector.id}` }];
  }

  // ── Install hooks (hooks.json) ──────────────────────────────────────────

  override installHooks(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    const path = this.getHookConfigPath(ctx);
    const events = this.effectiveHookEvents(ctx);

    if (events.length === 0) {
      return [{ platform: this.id, action: "skip", path, detail: "no hooks declared" }];
    }

    const file = this.readHooksFile(path);
    const hooks = (file.hooks ??= {});
    const changes: ChangeRecord[] = [];

    for (const event of events) {
      const desired = this.renderHookEntry(ctx, event);
      const list = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = []);
      const idx = list.findIndex((e) => this.isOurEntry(ctx, event, e));
      if (idx < 0) {
        list.push(desired);
        changes.push({ platform: this.id, action: "create", path, detail: `hooks.${event}` });
      } else if (JSON.stringify(list[idx]) !== JSON.stringify(desired)) {
        list[idx] = desired;
        changes.push({ platform: this.id, action: "update", path, detail: `hooks.${event}` });
      } else {
        changes.push({ platform: this.id, action: "skip", path, detail: `hooks.${event}` });
      }
    }

    if (changes.some((c) => c.action !== "skip")) {
      this.writeJson(path, file, dryRun);
    }
    return changes;
  }

  override uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const path = this.getHookConfigPath(ctx);
    const file = this.readJson<CodexHooksFile>(path);
    const hooks = file?.hooks;
    if (!file || !hooks) {
      return [{ platform: this.id, action: "skip", path, detail: "no hooks.json" }];
    }

    const changes: ChangeRecord[] = [];
    let mutated = false;
    for (const event of CODEX_HOOK_EVENTS) {
      const list = hooks[event];
      if (!Array.isArray(list)) continue;
      const kept = list.filter((e) => !this.isOurEntry(ctx, event, e));
      if (kept.length === list.length) continue;
      mutated = true;
      if (kept.length > 0) hooks[event] = kept;
      else delete hooks[event];
      changes.push({ platform: this.id, action: "remove", path, detail: `hooks.${event}` });
    }

    if (mutated) this.writeJson(path, file, ctx.dryRun);
    if (changes.length === 0) {
      return [{ platform: this.id, action: "skip", path, detail: "no agent-connector hooks present" }];
    }
    return changes;
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
        name: `${this.name}: mcp_servers.${id} registered`,
        check: () => {
          const cfg = this.readToml(path);
          const bucket = cfg["mcp_servers"];
          const present =
            typeof bucket === "object" &&
            bucket !== null &&
            id in (bucket as Record<string, unknown>);
          return present
            ? { status: "OK", detail: `mcp_servers.${id}` }
            : { status: "FAIL", detail: `mcp_servers.${id} not found in ${path}` };
        },
      },
    ];
  }

  // ── Runtime dispatch ────────────────────────────────────────────────────

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as CodexHookInput;
    const base = {
      hostPlatform: this.id,
      connectorId: "",
      sessionId: input.session_id ?? `pid-${process.ppid}`,
      projectDir: input.cwd ?? process.env.CODEX_PROJECT_DIR ?? process.cwd(),
      raw,
    };

    switch (event) {
      case "PreToolUse":
        return {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
        };
      case "PostToolUse":
        return {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          toolOutput: input.tool_response,
          isError: input.is_error ?? false,
        };
      case "SessionStart":
        return { ...base, source: this.normalizeSource(input.source) };
      case "SessionEnd":
        return { ...base, reason: input.message };
      case "UserPromptSubmit":
        return { ...base, prompt: input.prompt ?? "" };
      case "PreCompact":
        return { ...base, trigger: input.trigger === "manual" ? "manual" : "auto" };
      case "Stop":
        return { ...base, stopHookActive: input.stop_hook_active ?? false };
      case "Notification":
        return { ...base, message: input.message ?? "" };
    }
  }

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    // Codex (like Claude Code) reads a `hookSpecificOutput` JSON wrapper from
    // stdout; exit code 0 = allow. Fields the host cannot honor are dropped.
    if (response.decision === "deny") {
      // PreToolUse deny is honored; other events fail-open to allow.
      if (event === "PreToolUse") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: response.reason ?? "Blocked by hook",
            },
          }),
        };
      }
      return { exitCode: 0 };
    }

    // Context injection: honored on SessionStart and PostToolUse (additionalContext).
    if (response.additionalContext && (event === "SessionStart" || event === "PostToolUse")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: event,
            additionalContext: response.additionalContext,
          },
        }),
      };
    }

    // "allow" / unsupported-on-Codex (modify, ask) → passthrough.
    return { exitCode: 0 };
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

  /** Which canonical hook events to register for Codex, honoring overrides. */
  private effectiveHookEvents(ctx: InstallContext): CodexHookEventName[] {
    const override = ctx.connector.platforms[this.id]?.hooks;
    if (override === false) return [];
    return CODEX_HOOK_EVENTS.filter((e) => ctx.connector.hookEvents.includes(e));
  }

  /**
   * Render the `[mcp_servers.<id>]` table. TOML has NO interpolation, so every
   * `${env:VAR}` is resolved to a literal at install time. The env table is a
   * plain string→string map. Honors the telemetry serve-wrapper.
   */
  private renderMcpEntry(ctx: InstallContext, server: ServerDef): CodexMcpEntry {
    let command = server.command as string;
    let args = [...(server.args ?? [])];

    if (shouldWrapForTelemetry(server, ctx.connector.telemetry)) {
      const wrapped = buildServeWrapperCommand(ctx.homeBinPath, ctx.connector.id, command, args);
      command = wrapped.command;
      args = wrapped.args;
    }

    // Resolve env-refs to literals (TOML cannot interpolate).
    command = resolveEnvRefsDeep(command);
    args = resolveEnvRefsDeep(args);

    const entry: CodexMcpEntry = { command };
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

  /** Render one hooks.json entry pointing at the stable home binary. */
  private renderHookEntry(ctx: InstallContext, event: CodexHookEventName): CodexHookEntry {
    const command = buildHomeBinHookCommand(
      ctx.homeBinPath,
      "codex",
      event,
      ctx.connector.id,
    );
    const entry: CodexHookEntry = { hooks: [{ type: "command", command }] };
    if (event === "PreToolUse") entry.matcher = PRE_TOOL_USE_MATCHER;
    else entry.matcher = "";
    return entry;
  }

  /** Does this hooks.json entry belong to this connector (by home-bin command)? */
  private isOurEntry(ctx: InstallContext, event: CodexHookEventName, entry: CodexHookEntry): boolean {
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) return false;
    const ours = buildHomeBinHookCommand(ctx.homeBinPath, "codex", event, ctx.connector.id);
    const needle = ours.replace(/\\/g, "/");
    return entry.hooks.some((h) => (h.command ?? "").replace(/\\/g, "/") === needle);
  }

  private readHooksFile(path: string): CodexHooksFile {
    return this.readJson<CodexHooksFile>(path) ?? {};
  }

  /** Get-or-create a nested table inside a parsed TOML object. */
  private tomlBucket(cfg: Record<string, unknown>, key: string): Record<string, unknown> {
    const existing = cfg[key];
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      return existing as Record<string, unknown>;
    }
    const fresh: Record<string, unknown> = {};
    cfg[key] = fresh;
    return fresh;
  }

  private normalizeSource(raw: string | undefined): "startup" | "compact" | "resume" | "clear" {
    switch (raw) {
      case "compact":
        return "compact";
      case "resume":
        return "resume";
      case "clear":
        return "clear";
      default:
        return "startup";
    }
  }
}

export const adapter = new CodexAdapter();
export default adapter;
