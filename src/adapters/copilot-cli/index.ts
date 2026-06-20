/**
 * adapters/copilot-cli — GitHub Copilot CLI platform adapter for agent-connector.
 *
 * GitHub Copilot CLI is a json-stdio host: the host pipes a JSON payload to a
 * hook command on stdin and reads JSON/exit-code back. Its reply shape is
 * Claude-compatible (`hookSpecificOutput` wrapper), but its hooks-file event
 * KEYS are NOT — the CLI's loader honors ONLY a fixed set of lowerCamelCase
 * keys and SILENTLY DROPS anything else (see EVENT_WIRE_KEY below), so a
 * PascalCase→camelCase rename table IS required when writing the config.
 *
 * Native config (user/global only — Copilot CLI has no project-scoped config):
 *   - MCP servers: ~/.copilot/mcp-config.json, root key "mcpServers". An stdio
 *     server is written with type "local" (the host also accepts "stdio") plus
 *     `tools: ["*"]`. Remote servers use type "http".
 *   - Hooks: a hooks file shaped `{ version: 1, hooks: { … } }` discovered from
 *     ~/.copilot/hooks/*.json. We write a single dedicated file,
 *     ~/.copilot/hooks/agent-connector.json, so we never disturb a user's own
 *     hook files and removal is a clean, scoped operation. Each event maps to an
 *     array of flat command entries `{ matcher?, hooks: [{ type:"command", command }] }`
 *     keyed by the CLI's lowerCamelCase wire name (EVENT_WIRE_KEY).
 *   - Reply: a `hookSpecificOutput` object keyed by `hookEventName` carrying
 *     `permissionDecision` (allow|deny|ask) + `permissionDecisionReason`,
 *     `additionalContext`, and (PreToolUse) `updatedInput`. PreToolUse is
 *     fail-closed on the host side; exit 0 + JSON refines the decision.
 *
 * Env handling: the host is not documented to support `${env:VAR}` interpolation
 * inside mcp-config.json, so env/header/url refs are resolved to literals at
 * install time via resolveEnvRefsDeep (the safe default for a no-native-interp
 * host, matching the Codex adapter's approach).
 *
 * Content surfaces (surfaces-design §4-5): Copilot CLI exposes skills and
 * subagents but NO prompt-file command surface, so commands inherit the
 * BaseAdapter skip/warn default (supportsCommands stays false).
 *   - skills: folder-per-skill `<dir>/skills/<name>/SKILL.md` (+ resource files).
 *     user scope → ~/.copilot/skills; project scope → <projectDir>/.github/skills.
 *   - subagents: user scope → ~/.copilot/agents/<name>.agent.md; project scope →
 *     <projectDir>/.github/agents/<name>.agent.md (md + frontmatter:
 *     name, description, tools, model).
 * The .github/ tree is shared with the vscode-copilot and jetbrains-copilot
 * connectors; we write identical, idempotent content and on uninstall remove
 * only the files this connector wrote.
 *
 * Grounded in docs/research/understand-report.md §2 (Platform Integration
 * Matrix, "GitHub Copilot CLI" row).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { BaseAdapter } from "../base.js";
import type { Adapter, HookReply, InstallContext, MemoryTarget, NormalizedEvent } from "../spi.js";
import type {
  ChangeRecord,
  DetectedPlatform,
  HealthCheck,
  HookEventName,
  HookParadigm,
  HookResponse,
  NotificationEvent,
  PermissionRequestEvent,
  PlatformCapabilities,
  PlatformId,
  PostToolUseEvent,
  PostToolUseFailureEvent,
  PostCompactEvent,
  PreCompactEvent,
  PreToolUseEvent,
  ServerDef,
  SessionEndEvent,
  SessionStartEvent,
  StopEvent,
  SubagentStartEvent,
  SubagentStopEvent,
  Transport,
  UserPromptSubmitEvent,
} from "../../core/types.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  buildHomeBinHookCommand,
  buildWrappedStdio,
  isHomeBinHookCommand,
} from "../../core/spawn.js";
import { renderSkillMd, renderSubagentMd } from "../claude-code/render.js";
import { normalizeSessionSource } from "../claude-code/wire.js";

const HOST: PlatformId = "copilot-cli";
const MCP_ROOT_KEY = "mcpServers";

/** Native hooks-file version Copilot CLI expects (`{ version: 1, hooks: {…} }`). */
const COPILOT_HOOKS_VERSION = 1;

/**
 * EVENT→WIRE-KEY map for the hooks file. VERIFIED against the installed GitHub
 * Copilot CLI 1.0.63 bundle (app.js): the hook loader validates every
 * `config.hooks` key against a hardcoded Set of NINE lowerCamelCase event names —
 *   { sessionStart, sessionEnd, userPromptSubmitted, preToolUse, postToolUse,
 *     errorOccurred, agentStop, subagentStop, preCompact }
 * — and any key NOT in that Set is SILENTLY DROPPED (logged only at debug:
 * "Ignoring unknown hook event(s)"). The Zod hooks schema defines the same nine
 * camelCase keys and nothing else. So a PascalCase key like `PreToolUse` never
 * registers → the hook NEVER FIRES. We therefore key the file by the camelCase
 * WIRE name, NOT the PascalCase HookEventName.
 *
 * Two mappings are NOT a naive lowercase-first-letter: Claude's `Stop` is the
 * CLI's `agentStop`, and `UserPromptSubmit` is `userPromptSubmitted`. The rest
 * are first-letter-lowercased. (PascalCase aliases are documented for a newer
 * CLI that selects the snake_case payload dialect, but they are unknown to the
 * loader in 1.0.63 and dropped — camelCase is the only safe wire form here.)
 *
 * Only events Copilot CLI's loader actually accepts appear here. Events the
 * installed loader has no file-hook key for (Notification, PermissionRequest,
 * SubagentStart, PostToolUseFailure) are demoted on `capabilities` and warn-skip
 * at install — they are NOT in this map.
 */
const EVENT_WIRE_KEY: Partial<Record<HookEventName, string>> = {
  SessionStart: "sessionStart",
  SessionEnd: "sessionEnd",
  UserPromptSubmit: "userPromptSubmitted",
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  PreCompact: "preCompact",
  Stop: "agentStop",
  SubagentStop: "subagentStop",
};

/**
 * CAPABILITY FILTER for installHooks — maps each canonical HookEventName to the
 * `capabilities` flag that gates it. The adapter's `capabilities` literal is the
 * single source of truth for what Copilot CLI's runtime actually fires; declared
 * events (connector.hookEvents is the connector-level set, NOT pre-filtered by
 * host) are screened through this map so an unsupported event — Copilot CLI has
 * NO post-compaction hook, so `postCompact` stays unset — is reported as a
 * graceful warn/skip instead of being written as a dead `hooks.PostCompact` the
 * host would never fire. Same shape as the goose adapter's EVENT_CAPABILITY.
 */
const EVENT_CAPABILITY: Record<HookEventName, keyof PlatformCapabilities> = {
  SessionStart: "sessionStart",
  SessionEnd: "sessionEnd",
  UserPromptSubmit: "userPromptSubmit",
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  PreCompact: "preCompact",
  Stop: "stop",
  Notification: "notification",
  PermissionRequest: "permissionRequest",
  PostToolUseFailure: "postToolUseFailure",
  SubagentStart: "subagentStart",
  SubagentStop: "subagentStop",
  // Copilot CLI has no post-compaction hook — postCompact stays unset on
  // `capabilities`, so a declared PostCompact warn-skips at install.
  PostCompact: "postCompact",
};

/**
 * A single Copilot CLI hook registration entry (Claude-shaped).
 *
 * `matcher` is OPTIONAL and, when present, MUST be non-empty. Copilot CLI's
 * hooks schema is `matcher: z.string().min(1).optional()` (live-verified on CLI
 * 1.0.63): an OMITTED matcher passes validation, but an EMPTY STRING fails it —
 * the loader logs "Invalid hook configuration … matcher cannot be empty" and
 * DISCARDS THE ENTIRE hook file, registering zero hooks. So we OMIT the key
 * entirely when there is no matcher and emit it only when non-empty; we must
 * never write `matcher: ""`.
 */
interface CopilotHookEntry {
  matcher?: string;
  hooks: Array<{ type: "command"; command: string }>;
}

/** The shape of the Copilot CLI hooks file we own. */
interface CopilotHooksFile {
  version?: number;
  hooks?: Record<string, CopilotHookEntry[]>;
}

/** Native MCP server entry shapes Copilot CLI accepts under `mcpServers`. */
interface CopilotLocalServer {
  /** stdio transport is registered as type "local" (host also accepts "stdio"). */
  type: "local";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  tools: string[];
}
interface CopilotHttpServer {
  /** Remote transport: "http" (Streamable HTTP) or "sse" (legacy). */
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  tools: string[];
}

/** Raw Copilot CLI hook stdin payload (Claude-style: PascalCase event, snake_case fields). */
interface CopilotWireInput {
  connector?: unknown;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;

  // tool events
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  // PostToolUse (VS Code-compatible dialect): the tool result rides under
  // `tool_result`, NOT `tool_response`. PostToolUse fires success-only, so
  // result_type is always "success" (hooks-reference.md:397-400).
  tool_result?: { result_type?: string; text_result_for_llm?: string };

  // SessionStart
  source?: string;
  // SessionEnd
  reason?: string;
  // UserPromptSubmit
  prompt?: string;
  // PreCompact
  trigger?: string;
  // Notification
  message?: string;

  // PostToolUseFailure — payload is {tool_name, tool_input, error} + base
  // (hooks-reference.md:421-430). No tool_use_id/is_interrupt/duration_ms.
  error?: string;

  // SubagentStart / SubagentStop — VS Code dialect identity is `agent_name`
  // (+ optional `agent_display_name`); there is no agent_id/agent_type
  // (hooks-reference.md:467-476,497-507).
  agent_name?: string;
  agent_display_name?: string;
}

export class CopilotCliAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "GitHub Copilot CLI";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: AGENTS.md-first managed block (project <projectDir>/AGENTS.md
    // via the base default; user scope → ~/.copilot/copilot-instructions.md below).
    supportsMemory: true,
    // Copilot CLI's file-hook loader (1.0.63) accepts exactly these of the
    // canonical lifecycle events — every one is a member of its hardcoded
    // camelCase validator Set (see EVENT_WIRE_KEY).
    preToolUse: true,
    postToolUse: true,
    preCompact: true,
    sessionStart: true,
    sessionEnd: true,
    userPromptSubmit: true, // → wire key userPromptSubmitted
    stop: true, // → wire key agentStop
    subagentStop: true,
    // DEMOTED — NOT in the installed CLI 1.0.63 file-hook validator Set, so a
    // hooks-file key for any of these is silently dropped and never fires:
    //   notification, permissionRequest, subagentStart, postToolUseFailure.
    // (The github/docs `main` hooks-reference describes them for a NEWER CLI;
    // re-promote per-event once a verified bundle ships them in the Set — until
    // then the fail-safe is false so installHooks warn-skips instead of writing
    // a dead key.)
    notification: false,
    permissionRequest: false,
    postToolUseFailure: false,
    subagentStart: false,
    // PreToolUse is fail-closed and can rewrite tool input (updatedInput); a
    // PostToolUse hook cannot rewrite already-emitted tool output.
    canModifyArgs: true,
    canModifyOutput: false,
    canInjectSessionContext: true,
    // Copilot CLI's mcp-config.json `type` accepts stdio (written "local"),
    // http (Streamable HTTP), and sse (legacy) — per GitHub's add-mcp-servers docs.
    transports: ["stdio", "http", "sse"],
    // Content surfaces: Copilot CLI exposes skills + subagents, but has no
    // prompt-file command surface, so commands stay false (inherits BaseAdapter
    // skip/warn).
    supportsCommands: false,
    supportsSkills: true,
    supportsSubagents: true,
    // Native passthrough: Copilot CLI has an `errorOccurred` lifecycle event (a
    // member of the camelCase validator Set) with NO canonical HookEventName
    // analog — below the >=3-host core bar (docs/research/host-specific-hook-events-design.md).
    // A connector reaches it via platforms["copilot-cli"].nativeHooks; installHooks
    // files the event-name key VERBATIM (the author must supply the CLI's exact
    // camelCase key, e.g. `errorOccurred` — the loader drops unknown keys) with
    // the same home-bin command shape, and the generic uninstall reverses it.
    supportsNativeHooks: true,
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(_projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".copilot");
    const mcpConfig = join(userDir, "mcp-config.json");
    const hooksDir = join(userDir, "hooks");
    const installed =
      existsSync(userDir) || existsSync(mcpConfig) || existsSync(hooksDir);
    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath: mcpConfig,
      scope: "user",
      reason: installed
        ? `found GitHub Copilot CLI config under ${userDir}`
        : `no GitHub Copilot CLI config at ${userDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Memory surface: user-scope global instructions file ─────────────────
  // Project scope stays on the AGENTS.md base default (root AGENTS.md is the
  // primary instructions file). User scope targets Copilot CLI's documented
  // $HOME/.copilot/copilot-instructions.md — a markdown file shared with other
  // writers, so the managed block (not whole-file ownership) applies as usual.
  protected override memoryTargets(ctx: InstallContext): MemoryTarget[] {
    if (this.memoryOverride(ctx)?.path || ctx.scope !== "user") {
      return super.memoryTargets(ctx);
    }
    return [
      {
        path: join(homedir(), ".copilot", "copilot-instructions.md"),
        reason: "copilot-cli global instructions (~/.copilot/copilot-instructions.md)",
      },
    ];
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  /** Copilot CLI is user/global only — scope is ignored. */
  getConfigDir(_ctx: InstallContext): string {
    return join(homedir(), ".copilot");
  }

  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "mcp-config.json");
  }

  /**
   * Copilot CLI discovers hooks from any `~/.copilot/hooks/*.json`. We write a
   * single dedicated file so we never disturb the user's own hook files and
   * uninstall is a clean, scoped operation.
   */
  getHookConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "hooks", "agent-connector.json");
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
            ? "server registration disabled for copilot-cli"
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

  /** Render a normalized ServerDef into Copilot CLI's native mcpServers entry. */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): CopilotLocalServer | CopilotHttpServer {
    const transport: Transport = server.transport;
    const tools = this.renderTools(server);

    if (transport === "stdio") {
      let command = server.command ?? "";
      let args = [...(server.args ?? [])];

      // Transparent telemetry wrapping: route the real command through
      // `<homeBin> serve --connector <id> -- <command> <args...>`.
      ({ command, args } = buildWrappedStdio(ctx, server, this.id, command, args));

      const entry: CopilotLocalServer = {
        type: "local",
        command: resolveEnvRefsDeep(command),
        tools,
      };
      if (args.length > 0) entry.args = args.map((a) => resolveEnvRefsDeep(a));
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      if (server.cwd) entry.cwd = resolveEnvRefsDeep(server.cwd);
      return entry;
    }

    // remote (Streamable http / legacy sse) — Copilot registers a URL keyed by
    // its `type`. AC's canonical "sse" → "sse"; everything else → "http".
    const entry: CopilotHttpServer = {
      type: server.transport === "sse" ? "sse" : "http",
      url: resolveEnvRefsDeep(server.url ?? ""),
      tools,
    };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Copilot CLI is not documented to support native
   * `${env:VAR}` interpolation in mcp-config.json, so refs resolve to literals
   * at install time (the safe default for a no-native-interp host).
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  /** Render the tool allow-list. Copilot CLI expects `tools` on every entry; default ["*"]. */
  private renderTools(server: ServerDef): string[] {
    const include = server.tools?.include;
    return include && include.length > 0 ? [...include] : ["*"];
  }

  // ── Hook install / uninstall ─────────────────────────────────────────────

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    const override = connector.platforms[HOST];
    const hooksDisabled = override?.hooks === false;
    // `hooks: false` disables only the NORMALIZED events; nativeHooks is a
    // sibling, copilot-cli-scoped declaration that installs regardless.
    const normalizedEvents = hooksDisabled ? [] : connector.hookEvents;
    const nativeHooks = override?.nativeHooks ?? {};
    const nativeEvents = Object.keys(nativeHooks);

    if (normalizedEvents.length === 0 && nativeEvents.length === 0) {
      return [
        {
          platform: this.id,
          action: "skip",
          detail: hooksDisabled
            ? "hooks disabled for copilot-cli"
            : "connector declares no hooks",
        },
      ];
    }

    const hooksPath = this.getHookConfigPath(ctx);
    const file = this.readJson<CopilotHooksFile>(hooksPath) ?? {};
    const __skip = this.malformedHookRootSkip(hooksPath, (file as Record<string, unknown>).hooks);
    if (__skip) return [__skip];
    const hooks = (file.hooks ??= {});

    const changes: ChangeRecord[] = [];
    let mutated = false;

    for (const event of normalizedEvents) {
      // CAPABILITY FILTER: an event Copilot CLI's runtime does not deliver (e.g.
      // PostCompact — postCompact unset on `capabilities`) must NOT be written as
      // a dead hook the host never fires; report a graceful warn/skip instead.
      if (this.capabilities[EVENT_CAPABILITY[event]] !== true) {
        changes.push({
          platform: this.id,
          action: "warn",
          path: hooksPath,
          detail: `${event} unsupported on copilot-cli — skipped`,
        });
        continue;
      }
      // Key the hooks file by the CLI's camelCase WIRE name — a PascalCase key
      // is silently dropped by the loader (see EVENT_WIRE_KEY). The home-bin
      // command keeps the PascalCase `event` token: that is the AC-internal
      // router event passed to parseEvent/formatReply, NOT a hooks-file key.
      const copilotEvent = EVENT_WIRE_KEY[event];
      if (copilotEvent === undefined) {
        // Defensive: a capability-flagged event with no wire key would write a
        // dead PascalCase key. Treat it like an unsupported event (warn-skip).
        changes.push({
          platform: this.id,
          action: "warn",
          path: hooksPath,
          detail: `${event} unsupported on copilot-cli — skipped`,
        });
        continue;
      }
      const command = buildHomeBinHookCommand(ctx.homeBinPath, HOST, event, connector.id);
      const matcher = connector.hooks[event]?.matcher;
      // OMIT the matcher key when there is none — Copilot CLI rejects an empty
      // string (matcher cannot be empty) and discards the whole hooks file.
      const entry: CopilotHookEntry = {
        ...(matcher ? { matcher } : {}),
        hooks: [{ type: "command", command }],
      };

      const bucket = (hooks[copilotEvent] ??= []);
      const existingIdx = bucket.findIndex((e) => this.entryHasOurCommand(e, ctx));

      if (existingIdx >= 0) {
        if (JSON.stringify(bucket[existingIdx]) === JSON.stringify(entry)) {
          changes.push({
            platform: this.id,
            action: "skip",
            path: hooksPath,
            detail: `hooks.${copilotEvent} already registered`,
          });
          continue;
        }
        bucket[existingIdx] = entry;
        changes.push({
          platform: this.id,
          action: "update",
          path: hooksPath,
          detail: `hooks.${copilotEvent}`,
        });
      } else {
        bucket.push(entry);
        changes.push({
          platform: this.id,
          action: "create",
          path: hooksPath,
          detail: `hooks.${copilotEvent}`,
        });
      }
      mutated = true;
    }

    // NATIVE passthrough events: copilot-cli-native event-name keys (e.g.
    // ErrorOccurred) filed VERBATIM into the hooks map — no EVENT_MAP, since they
    // ARE Copilot events. The command keeps the native token; matched by EXACT
    // command so a native key coinciding with a normalized one never clobbers it.
    for (const nativeEvent of nativeEvents) {
      const command = buildHomeBinHookCommand(ctx.homeBinPath, HOST, nativeEvent, connector.id);
      const matcher = nativeHooks[nativeEvent]?.matcher;
      // OMIT the matcher key when there is none (empty string fails validation).
      const entry: CopilotHookEntry = {
        ...(matcher ? { matcher } : {}),
        hooks: [{ type: "command", command }],
      };
      const bucket = (hooks[nativeEvent] ??= []);
      const existingIdx = bucket.findIndex((e) => e.hooks?.[0]?.command === command);
      if (existingIdx >= 0) {
        if (JSON.stringify(bucket[existingIdx]) === JSON.stringify(entry)) {
          changes.push({
            platform: this.id,
            action: "skip",
            path: hooksPath,
            detail: `hooks.${nativeEvent} (native) already registered`,
          });
          continue;
        }
        bucket[existingIdx] = entry;
        changes.push({
          platform: this.id,
          action: "update",
          path: hooksPath,
          detail: `hooks.${nativeEvent} (native)`,
        });
      } else {
        bucket.push(entry);
        changes.push({
          platform: this.id,
          action: "create",
          path: hooksPath,
          detail: `hooks.${nativeEvent} (native)`,
        });
      }
      mutated = true;
    }

    if (mutated) {
      file.version = COPILOT_HOOKS_VERSION;
      this.writeJson(hooksPath, file, ctx.dryRun);
    }
    return changes;
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const hooksPath = this.getHookConfigPath(ctx);
    const file = this.readJson<CopilotHooksFile>(hooksPath);
    const hooks = file?.hooks;
    if (!file || !hooks) {
      return [
        {
          platform: this.id,
          action: "skip",
          path: hooksPath,
          detail: "no hooks section present",
        },
      ];
    }

    const changes: ChangeRecord[] = [];
    let mutated = false;

    for (const copilotEvent of Object.keys(hooks)) {
      const bucket = hooks[copilotEvent];
      if (!Array.isArray(bucket)) continue;

      // Strip our hook command from each entry; drop entries left empty so we
      // never remove another connector's (or the user's own) hook commands.
      const next: CopilotHookEntry[] = [];
      let removed = 0;
      for (const e of bucket) {
        const innerBefore = e.hooks?.length ?? 0;
        const inner = (e.hooks ?? []).filter((h) => !this.isOurCommand(h.command, ctx));
        removed += innerBefore - inner.length;
        // Preserve the entry's original matcher verbatim, but never synthesize an
        // empty string — Copilot CLI rejects `matcher: ""` (whole file discarded).
        if (inner.length > 0) next.push({ ...(e.matcher ? { matcher: e.matcher } : {}), hooks: inner });
      }

      if (removed > 0) {
        if (next.length > 0) hooks[copilotEvent] = next;
        else delete hooks[copilotEvent];
        changes.push({
          platform: this.id,
          action: "remove",
          path: hooksPath,
          detail: `hooks.${copilotEvent} (${removed})`,
        });
        mutated = true;
      }
    }

    if (mutated) {
      // When our uninstall empties the hooks map, delete this connector's
      // dedicated file rather than leaving an inert `{version:1,hooks:{}}` stub.
      // The file is owned solely by AC (see getHookConfigPath), so removing it on
      // full teardown is safe and keeps ~/.copilot/hooks clean.
      if (Object.keys(hooks).length === 0) {
        this.removeManagedFile(hooksPath, ctx.dryRun);
      } else {
        this.writeJson(hooksPath, file, ctx.dryRun);
      }
    }
    if (changes.length === 0) {
      changes.push({
        platform: this.id,
        action: "skip",
        path: hooksPath,
        detail: "no matching hook entries",
      });
    }
    return changes;
  }

  private entryHasOurCommand(entry: CopilotHookEntry, ctx: InstallContext): boolean {
    return (entry.hooks ?? []).some((h) => this.isOurCommand(h.command, ctx));
  }

  /** True when a hook command references our home binary AND this connector id
   *  (anchored so a shared-prefix id can't collide — see isHomeBinHookCommand). */
  private isOurCommand(command: string | undefined, ctx: InstallContext): boolean {
    return isHomeBinHookCommand(command, ctx.homeBinPath, ctx.connector.id);
  }

  // ── Content surfaces: skills / subagents ─────────────────────────────────
  // CONTENT-ONLY: pure native-file writers. No runtime dispatch, no home-bin
  // pointer, no telemetry wrap. Each method is idempotent (byte-identical →
  // skip) via BaseAdapter.writeContentFile and reversible via removeContentFile.
  // Honors platforms["copilot-cli"] per-surface false to skip. Commands are
  // unsupported here — they inherit the BaseAdapter skip/warn default.
  //
  // Path scoping: user scope lives under ~/.copilot (getConfigDir); project
  // scope lives under the shared <projectDir>/.github tree (the same files
  // vscode-copilot / jetbrains-copilot would write). We write identical content
  // and on uninstall remove only the files this connector wrote.

  /** Root dir for content surfaces: ~/.copilot (user) or <projectDir>/.github (project). */
  private contentDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".github")
      : this.getConfigDir(ctx);
  }

  private skillsDir(ctx: InstallContext): string {
    return join(this.contentDir(ctx), "skills");
  }
  private agentsDir(ctx: InstallContext): string {
    return join(this.contentDir(ctx), "agents");
  }

  /** Native skill dir: <contentDir>/skills/<name>. */
  private skillDir(ctx: InstallContext, name: string): string {
    return join(this.skillsDir(ctx), name);
  }
  /** Native subagent file path: <contentDir>/agents/<name>.agent.md. */
  private subagentPath(ctx: InstallContext, name: string): string {
    return join(this.agentsDir(ctx), `${name}.agent.md`);
  }

  // ── Skills ────────────────────────────────────────────────────────────────

  override installSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.skills === false) {
      return [{ platform: this.id, action: "skip", detail: "skills disabled for copilot-cli" }];
    }
    if (connector.skills.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no skills" }];
    }
    const changes: ChangeRecord[] = [];
    for (const skill of connector.skills) {
      const dir = this.skillDir(ctx, skill.name);
      changes.push(
        this.writeContentFile(join(dir, "SKILL.md"), renderSkillMd(skill), ctx.dryRun),
      );
      // Bundle any resource files beside SKILL.md (relative path → contents).
      // Defense-in-depth: skip+warn on any key that escapes the skill dir
      // (config-time validation already rejects these, but never trust input).
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
    const changes: ChangeRecord[] = [];
    for (const skill of connector.skills) {
      const dir = this.skillDir(ctx, skill.name);
      // Remove only the files we wrote (SKILL.md + declared resources), then the
      // skill dir itself when we own its full contents.
      changes.push(this.removeContentFile(join(dir, "SKILL.md"), ctx.dryRun));
      for (const rel of Object.keys(skill.resources ?? {})) {
        const target = this.resolveWithin(dir, rel);
        if (target === null) continue; // never delete outside the skill dir
        changes.push(this.removeContentFile(target, ctx.dryRun));
      }
      // Only remove the skill dir when WE own its full contents — never rm -rf a
      // dir that still holds user-added / sibling-tool / shared files.
      changes.push(this.removeDirIfEmpty(dir, ctx.dryRun));
    }
    return changes;
  }

  // ── Subagents ───────────────────────────────────────────────────────────────

  override installSubagents(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.subagents === false) {
      return [{ platform: this.id, action: "skip", detail: "subagents disabled for copilot-cli" }];
    }
    if (connector.subagents.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no subagents" }];
    }
    return connector.subagents.map((agent) =>
      this.writeContentFile(
        this.subagentPath(ctx, agent.name),
        renderSubagentMd(agent),
        ctx.dryRun,
      ),
    );
  }

  override uninstallSubagents(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.subagents.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no subagents" }];
    }
    return connector.subagents.map((agent) =>
      this.removeContentFile(this.subagentPath(ctx, agent.name), ctx.dryRun),
    );
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const mcpPath = this.getServerConfigPath(ctx);
    const hooksPath = this.getHookConfigPath(ctx);
    const connectorId = ctx.connector.id;
    const homeBin = ctx.homeBinPath;
    const hookEvents = ctx.connector.hookEvents;
    const checks: HealthCheck[] = [
      {
        name: `${this.name}: mcp-config.json present`,
        check: () =>
          existsSync(mcpPath)
            ? { status: "OK", detail: mcpPath }
            : { status: "FAIL", detail: `not found: ${mcpPath}` },
      },
      {
        name: `${this.name}: hook command registered`,
        check: () => {
          if (hookEvents.length === 0) {
            return { status: "OK", detail: "no hooks declared" };
          }
          const file = this.readJson<CopilotHooksFile>(hooksPath);
          if (!file) return { status: "FAIL", detail: `cannot read ${hooksPath}` };
          const hooks = file.hooks ?? {};
          const registered = Object.values(hooks).some((entries) =>
            (entries ?? []).some((e) =>
              (e.hooks ?? []).some((h) =>
                isHomeBinHookCommand(h.command, homeBin, connectorId),
              ),
            ),
          );
          return registered
            ? { status: "OK", detail: "hook command present" }
            : { status: "FAIL", detail: `no hook for ${connectorId} in ${hooksPath}` };
        },
      },
    ];

    // Content-surface checks: only assert presence of the surfaces this
    // connector declares (skip silently for surfaces it never asked for).
    // Commands are unsupported on Copilot CLI, so no command check.
    for (const skill of ctx.connector.skills) {
      const p = join(this.skillDir(ctx, skill.name), "SKILL.md");
      checks.push({
        name: `${this.name}: skill ${skill.name} present`,
        check: () =>
          existsSync(p) ? { status: "OK", detail: p } : { status: "FAIL", detail: `not found: ${p}` },
      });
    }
    for (const agent of ctx.connector.subagents) {
      const p = this.subagentPath(ctx, agent.name);
      checks.push({
        name: `${this.name}: subagent ${agent.name} present`,
        check: () =>
          existsSync(p) ? { status: "OK", detail: p } : { status: "FAIL", detail: `not found: ${p}` },
      });
    }
    return checks;
  }

  // ── Runtime: parse Copilot CLI stdin JSON → normalized event ─────────────

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as CopilotWireInput;
    const connectorId = typeof input.connector === "string" ? input.connector : "";
    const sessionId = extractSessionId(input);
    const projectDir = typeof input.cwd === "string" ? input.cwd : undefined;

    const base = {
      hostPlatform: HOST,
      connectorId,
      sessionId,
      raw,
      ...(projectDir !== undefined ? { projectDir } : {}),
    } as const;

    switch (event) {
      case "PreToolUse": {
        const ev: PreToolUseEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
        };
        return ev;
      }
      case "PostToolUse": {
        // PostToolUse fires success-only and carries the result under
        // `tool_result.text_result_for_llm` (VS Code dialect). Failures arrive
        // via the separate PostToolUseFailure event, so isError is never set
        // here (hooks-reference.md:219,397-400).
        const toolOutput = input.tool_result?.text_result_for_llm;
        const ev: PostToolUseEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          ...(typeof toolOutput === "string" ? { toolOutput } : {}),
        };
        return ev;
      }
      case "SessionStart": {
        const ev: SessionStartEvent = {
          ...base,
          source: normalizeSessionSource(input.source),
        };
        return ev;
      }
      case "SessionEnd": {
        const ev: SessionEndEvent = {
          ...base,
          ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
        };
        return ev;
      }
      case "UserPromptSubmit": {
        const ev: UserPromptSubmitEvent = {
          ...base,
          prompt: typeof input.prompt === "string" ? input.prompt : "",
        };
        return ev;
      }
      case "PreCompact": {
        const ev: PreCompactEvent = {
          ...base,
          ...(input.trigger === "auto" || input.trigger === "manual"
            ? { trigger: input.trigger }
            : {}),
        };
        return ev;
      }
      case "PostCompact": {
        // Copilot CLI does not fire PostCompact natively (postCompact unset →
        // warn-skip at install). Parsed defensively, mirroring PreCompact, so a
        // manual/mis-routed dispatch normalizes instead of hitting the guard.
        const ev: PostCompactEvent = {
          ...base,
          ...(input.trigger === "auto" || input.trigger === "manual"
            ? { trigger: input.trigger }
            : {}),
        };
        return ev;
      }
      case "Stop": {
        // The host signals completion via stop_reason:"end_turn", not the
        // stopHookActive loop-guard boolean, so nothing maps onto StopEvent
        // beyond base (hooks-reference.md:449-457).
        const ev: StopEvent = { ...base };
        return ev;
      }
      case "Notification": {
        const ev: NotificationEvent = {
          ...base,
          message: typeof input.message === "string" ? input.message : "",
        };
        return ev;
      }
      case "PermissionRequest": {
        // permissionRequest uses the PreToolUse shape (tool_name + tool_input
        // only); the host emits no permission_suggestions payload
        // (hooks-reference.md:218,627-649).
        const ev: PermissionRequestEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
        };
        return ev;
      }
      case "PostToolUseFailure": {
        // Host payload is {tool_name, tool_input, error} + base; it carries no
        // tool_use_id / is_interrupt / duration_ms correlation fields
        // (hooks-reference.md:421-430).
        const ev: PostToolUseFailureEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          error: typeof input.error === "string" ? input.error : "",
        };
        return ev;
      }
      case "SubagentStart": {
        // The host's subagent identity field is `agent_name`; there is no
        // agent_id or agent_type (agent_display_name is a human label, not a
        // type), so agentType stays unset (hooks-reference.md:467-476).
        const ev: SubagentStartEvent = {
          ...base,
          ...(typeof input.agent_name === "string" ? { agentId: input.agent_name } : {}),
        };
        return ev;
      }
      case "SubagentStop": {
        // VS Code dialect: identity is `agent_name`, the subagent transcript is
        // the BASE `transcript_path` (not agent_transcript_path), and there is
        // no agent_type / last_assistant_message / stop_hook_active — the final
        // response is reachable only via transcript_path, and completion is
        // signalled by stop_reason (hooks-reference.md:497-507).
        const ev: SubagentStopEvent = {
          ...base,
          ...(typeof input.agent_name === "string" ? { agentId: input.agent_name } : {}),
          ...(typeof input.transcript_path === "string"
            ? { agentTranscriptPath: input.transcript_path }
            : {}),
        };
        return ev;
      }
      default: {
        // Exhaustive guard — every HookEventName is handled above.
        const _never: never = event;
        throw new Error(`unsupported copilot-cli hook event: ${String(_never)}`);
      }
    }
  }

  // ── Runtime: normalized response → Copilot CLI native hook reply ─────────

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    const hookEventName = event;
    const decision = response.decision ?? "allow";

    // PermissionRequest replies use the Claude-compatible nested
    // decision{behavior} envelope and are the ONE event where an EXPLICIT
    // "allow" is an ACTIVE grant (it suppresses the permission dialog) rather
    // than passthrough:
    //   allow            → decision{behavior:"allow"} (+updatedInput when set);
    //                      the host still enforces its own deny rules.
    //   modify           → an allow grant carrying updatedInput.
    //   deny             → decision{behavior:"deny", message}.
    //   ask/context/void → NO decision output: fall through to the native
    //                      dialog (the dialog IS the ask).
    if (event === "PermissionRequest") {
      if (response.decision === "deny") {
        return this.stdout({
          hookSpecificOutput: {
            hookEventName,
            decision: {
              behavior: "deny",
              message: response.reason ?? "Blocked by hook",
            },
          },
        });
      }
      if (
        response.decision === "allow" ||
        (response.decision === "modify" && response.updatedInput)
      ) {
        return this.stdout({
          hookSpecificOutput: {
            hookEventName,
            decision: {
              behavior: "allow",
              ...(response.updatedInput
                ? { updatedInput: response.updatedInput }
                : {}),
            },
          },
        });
      }
      return { exitCode: 0 };
    }

    // PostToolUseFailure (recovery guidance beside the error) and SubagentStart
    // (context prepended to the SUBAGENT's conversation — creation is not
    // blockable on Copilot CLI) are observe/context-only: "context" emits
    // additionalContext, and a "deny" DEGRADES to the same shape carrying the
    // reason. Everything else passes through.
    if (event === "PostToolUseFailure" || event === "SubagentStart") {
      const context =
        decision === "context"
          ? response.additionalContext
          : decision === "deny"
            ? response.reason ?? response.additionalContext
            : undefined;
      if (context) {
        return this.stdout({
          hookSpecificOutput: { hookEventName, additionalContext: context },
        });
      }
      return { exitCode: 0 };
    }

    // deny → block the action with a reason (exit 0; JSON carries the decision).
    // SubagentStop is the Stop-semantics exception: like Claude, the block is
    // the TOP-LEVEL {"decision":"block","reason"} — it keeps the subagent
    // running with `reason` as its next instruction (the host "can block and
    // force continuation").
    if (decision === "deny") {
      if (event === "SubagentStop") {
        return this.stdout({
          decision: "block",
          reason: response.reason ?? "Blocked by hook",
        });
      }
      return this.stdout({
        hookSpecificOutput: {
          hookEventName,
          permissionDecision: "deny",
          permissionDecisionReason: response.reason ?? "Blocked by hook",
        },
      });
    }

    // ask → prompt the user to confirm.
    if (decision === "ask") {
      return this.stdout({
        hookSpecificOutput: {
          hookEventName,
          permissionDecision: "ask",
          permissionDecisionReason: response.reason ?? "Confirmation required by hook",
        },
      });
    }

    // modify → rewrite PreToolUse input (only where Copilot CLI supports it).
    if (decision === "modify") {
      if (event === "PreToolUse" && response.updatedInput) {
        return this.stdout({
          hookSpecificOutput: { hookEventName, updatedInput: response.updatedInput },
        });
      }
      // Output rewrite is unsupported on Copilot CLI; fall through to allow.
    }

    // context → inject soft guidance (also the SessionStart context path).
    if (decision === "context" && response.additionalContext) {
      return this.stdout({
        hookSpecificOutput: { hookEventName, additionalContext: response.additionalContext },
      });
    }

    // allow / void / unsupported-degradation → pass through with exit 0.
    return { exitCode: 0 };
  }

  private stdout(payload: unknown): HookReply {
    return { exitCode: 0, stdout: JSON.stringify(payload) };
  }
}

/**
 * Extract a stable session id from a Copilot CLI wire payload.
 * Priority mirrors the Claude wire protocol: transcript UUID > session_id > "".
 */
function extractSessionId(input: CopilotWireInput): string {
  if (typeof input.transcript_path === "string") {
    const m = input.transcript_path.match(/([a-f0-9-]{36})\.jsonl$/);
    if (m && m[1]) return m[1];
  }
  if (typeof input.session_id === "string" && input.session_id !== "") {
    return input.session_id;
  }
  return "";
}

export const adapter = new CopilotCliAdapter();
export default adapter;
