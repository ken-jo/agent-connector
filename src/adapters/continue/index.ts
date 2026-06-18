/**
 * adapters/continue — Continue (the `cn` terminal agent / Continue.dev) adapter.
 *
 * Continue is a **json-stdio** host: its `cn` CLI ships a Claude-Code-COMPATIBLE
 * hooks system (primary-verified — continuedev/continue PR #11029,
 * extensions/cli/src/hooks/{types.ts,hookConfig.ts}). The hooks live in a
 * SEPARATE settings.json file (NOT the YAML config.yaml that holds MCP servers),
 * so getServerConfigPath ≠ getHookConfigPath:
 *
 *   - MCP servers → config.yaml `mcpServers` (a YAML ARRAY — see below). UNCHANGED.
 *   - Hooks       → settings.json under `hooks`, keyed by PascalCase event name,
 *                   each value an array of { matcher?, hooks:[{ type:"command",
 *                   command }] } — BYTE-IDENTICAL to Claude Code's shape.
 *
 * Hook config path (hookConfig.ts getSettingsFilePaths):
 *   - user-global → ~/.continue/settings.json (honor CONTINUE_GLOBAL_DIR env if
 *                   set, else ~/.continue);
 *   - project     → <projectDir>/.continue/settings.json.
 *
 * Supported events (continue's HOOK_EVENT_NAMES ∩ AC canonical): PreToolUse,
 * PostToolUse, PostToolUseFailure, UserPromptSubmit, SessionStart, SessionEnd,
 * Stop, Notification, SubagentStart, SubagentStop, PermissionRequest, PreCompact
 * — all PascalCase 1:1 with the canonical name. Continue has NO PostCompact (not
 * in HOOK_EVENT_NAMES), so that one warn-skips at install.
 *
 * Continue's HOOK_EVENT_NAMES ALSO carries five host-specific events with no
 * canonical analog (ConfigChange, TeammateIdle, TaskCompleted, WorktreeCreate,
 * WorktreeRemove — each a real HookInput member). They sit below the ≥3-host
 * promotion bar, so they are reachable via the nativeHooks passthrough
 * (supportsNativeHooks: true) rather than the normalized API — the SAME proven
 * pattern as copilot-cli / hermes / jetbrains-copilot.
 *
 * Output contract is Claude-identical (HookOutput): blocking = exit code 2 OR
 * top-level { decision:"block", reason }; PreToolUse permission via
 * hookSpecificOutput.permissionDecision (allow|deny|ask) + updatedInput; context
 * injection via hookSpecificOutput.additionalContext; PermissionRequest via the
 * nested decision{ behavior }. So parseEvent/formatReply MIRROR the claude-code
 * adapter exactly (the install layout mirrors droid's separate-hooks-file host).
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
 *
 * Memory / rules (primary-verified — docs.continue.dev/customize/deep-dives/
 * rules): a `.continue/rules` folder at the WORKSPACE ROOT holds `.md` rule
 * files; each carries a YAML frontmatter whose `alwaysApply: true` field makes
 * the rule "always included, regardless of file context" (the docs' literal
 * Activation behavior table). AC owns a DEDICATED file there
 * (`.continue/rules/agent-connector.md`) — unlike the cline/amazon-q memory
 * targets (which use the base managed-block engine), this file MUST LEAD with
 * the always-on frontmatter, so we write the WHOLE file (frontmatter + body) via
 * the content-file writers and own it end-to-end (install creates, uninstall
 * deletes). The connector's memory `content` is host-agnostic (no frontmatter of
 * its own — MemoryDef forbids it), so the always-on directive is an adapter-level
 * wrapper, not part of the connector payload. PROJECT SCOPE ONLY (the `cn` CLI's
 * user/global rules directory is not primary-verified → user scope skip-warns).
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { BaseAdapter } from "../base.js";
import type { Adapter, HookReply, InstallContext, NormalizedEvent } from "../spi.js";
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
import { readYaml, writeYaml } from "../../core/yaml.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  buildHomeBinHookCommand,
  buildServeWrapperCommand,
  isHomeBinHookCommand,
  shouldWrapForTelemetry,
} from "../../core/spawn.js";
import {
  type ClaudeHookEvent,
  type ClaudeWireInput,
  extractSessionId,
  normalizeSessionSource,
  toolResponseToString,
} from "../claude-code/wire.js";

const HOST: PlatformId = "continue";
/** Root key under which Continue stores MCP servers in config.yaml — a YAML ARRAY. */
const MCP_ROOT_KEY = "mcpServers";

/**
 * Canonical events Continue actually fires (continue's HOOK_EVENT_NAMES ∩ the AC
 * canonical set; PR #11029 extensions/cli/src/hooks/types.ts). Names are
 * Claude-identical PascalCase, registered directly. Continue ships PreCompact
 * (PreCompactInput in the HookInput union) but NOT PostCompact — that one
 * warn-skips at install time.
 */
const SUPPORTED_EVENTS: ReadonlySet<HookEventName> = new Set<HookEventName>([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "PermissionRequest",
  "PreCompact",
]);

/** A single Continue native hook registration entry (Claude-shaped, nested). */
interface ContinueHookEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string }>;
}

/** The shape of Continue's settings.json (only the parts the hook install touches). */
interface ContinueSettingsFile {
  hooks?: Record<string, ContinueHookEntry[]>;
  [key: string]: unknown;
}

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
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: WIRED. Continue reads `.continue/rules/*.md` (NOT
    // AGENTS.md), so the AGENTS.md-first BaseAdapter default does not apply — the
    // installMemory/uninstallMemory overrides below write a DEDICATED
    // agent-connector-owned file (<projectDir>/.continue/rules/agent-connector.md)
    // that LEADS with `alwaysApply: true` frontmatter (always-included). Project
    // scope only; user scope skip-warns (no verified user/global rules dir).
    supportsMemory: true,
    //
    // json-stdio: the `cn` CLI ships a Claude-Code-COMPATIBLE hooks system (PR
    // #11029). Every event in HOOK_EVENT_NAMES ∩ canonical fires natively; the
    // names are PascalCase 1:1 with Claude. PreCompact IS in continue's set
    // (PreCompactInput); only PostCompact is absent → that stays false (install
    // warn-skips it).
    preToolUse: true,
    postToolUse: true,
    postToolUseFailure: true,
    preCompact: true,
    sessionStart: true,
    sessionEnd: true,
    userPromptSubmit: true,
    stop: true,
    notification: true,
    subagentStart: true,
    subagentStop: true,
    permissionRequest: true,
    // Continue's PreToolUse output carries updatedInput (HookOutput
    // PreToolUseHookOutput.updatedInput) → it CAN rewrite tool input. It cannot
    // rewrite already-emitted tool output (PostToolUse exposes updatedMCPToolOutput,
    // but — matching the claude-code adapter's conservative stance — we do not
    // wire output rewrite). It honors hookSpecificOutput.additionalContext.
    canModifyArgs: true,
    canModifyOutput: false,
    canInjectSessionContext: true,
    // Continue registers stdio + remote (SSE / Streamable HTTP) MCP servers
    // (primary-verified: type ∈ stdio|sse|streamable-http). Mapped to the
    // framework's transport enum: stdio + sse + http (http = streamable-http).
    transports: ["stdio", "sse", "http"],
    // Native (passthrough) hooks: continue's HOOK_EVENT_NAMES carries five
    // host-specific events with NO canonical analog — ConfigChange, TeammateIdle,
    // TaskCompleted, WorktreeCreate, WorktreeRemove (each a real HookInput
    // member, types.ts:214-241). They sit below the ≥3-host promotion bar, so a
    // connector reaches them via platforms.continue.nativeHooks; installHooks
    // files the event-name key VERBATIM and the generic uninstallHooks reverses
    // it by connector-id ownership (same proven pattern as copilot-cli/hermes/
    // jetbrains-copilot).
    supportsNativeHooks: true,
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

  /**
   * Hooks live in a SEPARATE settings.json (NOT the YAML config.yaml that holds
   * MCP servers): user-global → <CONTINUE_GLOBAL_DIR|~/.continue>/settings.json;
   * project → <projectDir>/.continue/settings.json (hookConfig.ts
   * getSettingsFilePaths). The user-scope dir honors CONTINUE_GLOBAL_DIR exactly
   * as the `cn` CLI's hook loader does — this is INTENTIONALLY independent of
   * getConfigDir/userConfigDir (the MCP path), which the hook env must not perturb.
   */
  override getHookConfigPath(ctx: InstallContext): string {
    const dir =
      ctx.scope === "project"
        ? join(ctx.projectDir, ".continue")
        : process.env.CONTINUE_GLOBAL_DIR || join(homedir(), ".continue");
    return join(dir, "settings.json");
  }

  /** ~/.continue — homedir() covers %USERPROFILE% on Windows. */
  private userConfigDir(): string {
    return join(homedir(), ".continue");
  }

  // ── Memory surface: the `.continue/rules` content tree ────────────────────
  // A DEDICATED agent-connector-owned file that MUST LEAD with `alwaysApply:
  // true` frontmatter (always-included). Because of that leading frontmatter we
  // do NOT use the base managed-block engine (it appends a block at EOF and
  // cannot guarantee a leading frontmatter, nor delete a file that retains
  // frontmatter on uninstall) — instead we own the whole file via the
  // content-file writers: install writes/updates it idempotently, uninstall
  // deletes it. PROJECT SCOPE ONLY (the user/global rules dir is unverified).

  /** <projectDir>/.continue/rules/agent-connector.md — the dedicated owned file. */
  private memoryFilePath(ctx: InstallContext): string {
    return join(ctx.projectDir, ".continue", "rules", "agent-connector.md");
  }

  /** True when `<projectDir>/.continue/rules` exists and is a regular FILE. */
  private rulesDirIsFile(ctx: InstallContext): boolean {
    const p = join(ctx.projectDir, ".continue", "rules");
    if (!existsSync(p)) return false;
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Compose the dedicated rule file: `alwaysApply: true` frontmatter (the
   * always-on activation directive) + every declared memory entry's content,
   * joined with a blank line. The connector's content is host-agnostic markdown
   * (MemoryDef forbids its own frontmatter), so the directive is ours to add.
   */
  private renderMemoryFile(ctx: InstallContext): string {
    const body = (ctx.connector.memory ?? [])
      .map((m) => m.content.trim())
      .filter((c) => c.length > 0)
      .join("\n\n");
    return this.renderFrontmatterMd({ alwaysApply: true }, body);
  }

  override installMemory(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    const entries = connector.memory ?? [];
    if (connector.platforms[this.id]?.memory === false) {
      return [{ platform: this.id, action: "skip", detail: `memory disabled for ${this.id}` }];
    }
    if (entries.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no memory" }];
    }
    // Continue's verified rules dir is PROJECT scope only.
    if (ctx.scope !== "project") {
      return [
        {
          platform: this.id,
          action: "warn",
          detail:
            `no ${ctx.scope}-scope rules dir verified for continue ` +
            `(.continue/rules is project-scope); ${entries.length} skipped`,
        },
      ];
    }
    // Rules-path collision: never write under a `.continue/rules` that is a FILE.
    if (this.rulesDirIsFile(ctx)) {
      return [
        {
          platform: this.id,
          action: "warn",
          path: join(ctx.projectDir, ".continue", "rules"),
          detail:
            "existing .continue/rules is a file, not a directory; left untouched — " +
            "convert it to a .continue/rules/ directory to receive agent-connector memory",
        },
      ];
    }
    return [this.writeContentFile(this.memoryFilePath(ctx), this.renderMemoryFile(ctx), ctx.dryRun)];
  }

  override uninstallMemory(ctx: InstallContext): ChangeRecord[] {
    // Only the project-scope dedicated file was ever written; a `.continue/rules`
    // that is a FILE was never ours (installMemory warned), so leave it.
    if (ctx.scope !== "project" || this.rulesDirIsFile(ctx)) {
      const path = this.memoryFilePath(ctx);
      return [
        { platform: this.id, action: "skip", path, detail: `${basename(path)} absent` },
      ];
    }
    return [this.removeContentFile(this.memoryFilePath(ctx), ctx.dryRun)];
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
    // NEVER clobber a malformed `mcpServers`: if it exists and is not an array,
    // skip-and-warn (symmetric with uninstallServer) rather than silently
    // replacing the user's hand-written value.
    const existingRoot = cfg[MCP_ROOT_KEY];
    if (existingRoot !== undefined && !Array.isArray(existingRoot)) {
      return [{ platform: this.id, action: "skip", path, detail: `${MCP_ROOT_KEY} is not a YAML array — left untouched (manual fix needed)` }];
    }
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

  // ── Hook install / uninstall (separate settings.json, Claude-shaped) ──────
  // Continue's hooks live in settings.json (NOT the YAML config.yaml that holds
  // MCP servers), under `hooks` keyed by PascalCase event, each value an array
  // of { matcher?, hooks:[{ type:"command", command }] } — BYTE-IDENTICAL to
  // Claude Code. Events outside SUPPORTED_EVENTS (PostCompact) warn-skip; the
  // five host-specific events with no canonical analog (ConfigChange,
  // TeammateIdle, TaskCompleted, WorktreeCreate, WorktreeRemove) ride the
  // nativeHooks passthrough below. Merge-preserving: the user's own hooks + any
  // sibling connector's hooks survive; uninstall strips ONLY this connector's
  // home-bin command (anchored).

  override installHooks(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    const override = connector.platforms[HOST];
    const hooksDisabled = override?.hooks === false;
    // `hooks: false` disables only the NORMALIZED events; nativeHooks is a
    // sibling, continue-scoped declaration that installs regardless.
    const normalizedEvents = hooksDisabled ? [] : connector.hookEvents;
    const nativeHooks = override?.nativeHooks ?? {};
    const nativeEvents = Object.keys(nativeHooks);

    if (normalizedEvents.length === 0 && nativeEvents.length === 0) {
      return [
        {
          platform: this.id,
          action: "skip",
          detail: hooksDisabled
            ? "hooks disabled for continue"
            : "connector declares no hooks",
        },
      ];
    }

    const hookPath = this.getHookConfigPath(ctx);
    // Merge into any existing settings.json so the user's own hooks survive.
    const file = this.readJson<ContinueSettingsFile>(hookPath) ?? {};
    const __skip = this.malformedHookRootSkip(hookPath, (file as Record<string, unknown>).hooks);
    if (__skip) return [__skip];
    const hooks = (file.hooks ??= {});

    const changes: ChangeRecord[] = [];
    let mutated = false;

    for (const event of normalizedEvents) {
      if (!SUPPORTED_EVENTS.has(event)) {
        changes.push({
          platform: this.id,
          action: "warn",
          path: hookPath,
          detail: `${event} has no Continue hook equivalent — skipped`,
        });
        continue;
      }

      // Continue's event names are Claude-identical (PascalCase) — register the
      // canonical event name directly.
      const command = buildHomeBinHookCommand(ctx.homeBinPath, HOST, event, connector.id);
      const matcher = connector.hooks[event]?.matcher ?? "";
      const entry: ContinueHookEntry = {
        matcher,
        hooks: [{ type: "command", command }],
      };

      const bucket = (hooks[event] ??= []);
      const existingIdx = bucket.findIndex((e) => this.entryHasOurCommand(e, ctx));

      if (existingIdx >= 0) {
        if (JSON.stringify(bucket[existingIdx]) === JSON.stringify(entry)) {
          changes.push({
            platform: this.id,
            action: "skip",
            path: hookPath,
            detail: `hooks.${event} already registered`,
          });
          continue;
        }
        bucket[existingIdx] = entry;
        changes.push({
          platform: this.id,
          action: "update",
          path: hookPath,
          detail: `hooks.${event}`,
        });
      } else {
        bucket.push(entry);
        changes.push({
          platform: this.id,
          action: "create",
          path: hookPath,
          detail: `hooks.${event}`,
        });
      }
      mutated = true;
    }

    // NATIVE passthrough events: continue-native event-name keys (ConfigChange,
    // TeammateIdle, TaskCompleted, WorktreeCreate, WorktreeRemove) filed VERBATIM
    // into the hooks map — no SUPPORTED_EVENTS gate, since they ARE continue
    // events. Same Claude-shaped nested { matcher, hooks:[{type,command}] } entry;
    // matched by EXACT command so a native key that coincides with a normalized
    // one never clobbers it.
    for (const nativeEvent of nativeEvents) {
      const command = buildHomeBinHookCommand(ctx.homeBinPath, HOST, nativeEvent, connector.id);
      const entry: ContinueHookEntry = {
        matcher: nativeHooks[nativeEvent]?.matcher ?? "",
        hooks: [{ type: "command", command }],
      };
      const bucket = (hooks[nativeEvent] ??= []);
      const existingIdx = bucket.findIndex((e) => e.hooks?.[0]?.command === command);
      if (existingIdx >= 0) {
        if (JSON.stringify(bucket[existingIdx]) === JSON.stringify(entry)) {
          changes.push({
            platform: this.id,
            action: "skip",
            path: hookPath,
            detail: `hooks.${nativeEvent} (native) already registered`,
          });
          continue;
        }
        bucket[existingIdx] = entry;
        changes.push({
          platform: this.id,
          action: "update",
          path: hookPath,
          detail: `hooks.${nativeEvent} (native)`,
        });
      } else {
        bucket.push(entry);
        changes.push({
          platform: this.id,
          action: "create",
          path: hookPath,
          detail: `hooks.${nativeEvent} (native)`,
        });
      }
      mutated = true;
    }

    if (mutated) this.writeJson(hookPath, file, ctx.dryRun);
    return changes;
  }

  override uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    const hookPath = this.getHookConfigPath(ctx);
    const file = this.readJson<ContinueSettingsFile>(hookPath);
    const hooks = file?.hooks;
    if (!file || !hooks) {
      return [
        {
          platform: this.id,
          action: "skip",
          path: hookPath,
          detail: "no hooks section present",
        },
      ];
    }

    const changes: ChangeRecord[] = [];
    let mutated = false;

    for (const event of Object.keys(hooks)) {
      const bucket = hooks[event];
      if (!Array.isArray(bucket)) continue;

      // Strip our hook command from each entry; drop entries left empty so we
      // never remove another connector's (or the user's own) hook commands. The
      // id token is anchored (isHomeBinHookCommand) so a shared-prefix connector
      // id is never affected.
      const next: ContinueHookEntry[] = [];
      let removed = 0;
      for (const e of bucket) {
        const innerBefore = e.hooks?.length ?? 0;
        const inner = (e.hooks ?? []).filter((h) => !this.isOurCommand(h.command, ctx));
        removed += innerBefore - inner.length;
        if (inner.length > 0) next.push({ matcher: e.matcher ?? "", hooks: inner });
      }

      if (removed > 0) {
        if (next.length > 0) hooks[event] = next;
        else delete hooks[event];
        changes.push({
          platform: this.id,
          action: "remove",
          path: hookPath,
          detail: `hooks.${event} (${removed})`,
        });
        mutated = true;
      }
    }

    if (mutated) this.writeJson(hookPath, file, ctx.dryRun);
    if (changes.length === 0) {
      changes.push({
        platform: this.id,
        action: "skip",
        path: hookPath,
        detail: "no matching hook entries",
      });
    }
    return changes;
  }

  private entryHasOurCommand(entry: ContinueHookEntry, ctx: InstallContext): boolean {
    return (entry.hooks ?? []).some((h) => this.isOurCommand(h.command, ctx));
  }

  /** True when a hook command references our home binary AND this connector id
   *  (anchored so a shared-prefix id can't collide — see isHomeBinHookCommand). */
  private isOurCommand(command: string | undefined, ctx: InstallContext): boolean {
    return isHomeBinHookCommand(command, ctx.homeBinPath, ctx.connector.id);
  }

  // ── Runtime: parse Continue stdin JSON → normalized event ────────────────
  // Continue's stdin wire is Claude-identical snake_case (PR #11029 types.ts
  // HookInput), so the claude-code wire helpers (ClaudeWireInput / extractSessionId
  // / toolResponseToString) apply verbatim.

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as ClaudeWireInput;
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
        const ev: PostToolUseEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          ...(toolResponseToString(input.tool_response) !== undefined
            ? { toolOutput: toolResponseToString(input.tool_response) }
            : {}),
        };
        return ev;
      }
      case "PostToolUseFailure": {
        const ev: PostToolUseFailureEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          error: typeof input.error === "string" ? input.error : "",
          ...(typeof input.tool_use_id === "string" ? { toolUseId: input.tool_use_id } : {}),
          ...(typeof input.is_interrupt === "boolean" ? { isInterrupt: input.is_interrupt } : {}),
          ...(typeof input.duration_ms === "number" ? { durationMs: input.duration_ms } : {}),
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
      case "Stop": {
        const ev: StopEvent = {
          ...base,
          ...(typeof input.stop_hook_active === "boolean"
            ? { stopHookActive: input.stop_hook_active }
            : {}),
        };
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
        const ev: PermissionRequestEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          ...(Array.isArray(input.permission_suggestions)
            ? { permissionSuggestions: input.permission_suggestions }
            : {}),
        };
        return ev;
      }
      case "SubagentStart": {
        const ev: SubagentStartEvent = {
          ...base,
          ...(typeof input.agent_id === "string" ? { agentId: input.agent_id } : {}),
          ...(typeof input.agent_type === "string" ? { agentType: input.agent_type } : {}),
        };
        return ev;
      }
      case "SubagentStop": {
        // agent_id/agent_type stay optional — hosts do not reliably populate
        // agent_type on SubagentStop (Claude-compatible quirk).
        const ev: SubagentStopEvent = {
          ...base,
          ...(typeof input.agent_id === "string" ? { agentId: input.agent_id } : {}),
          ...(typeof input.agent_type === "string" ? { agentType: input.agent_type } : {}),
          ...(typeof input.agent_transcript_path === "string"
            ? { agentTranscriptPath: input.agent_transcript_path }
            : {}),
          ...(typeof input.last_assistant_message === "string"
            ? { lastAssistantMessage: input.last_assistant_message }
            : {}),
          ...(typeof input.stop_hook_active === "boolean"
            ? { stopHookActive: input.stop_hook_active }
            : {}),
        };
        return ev;
      }
      case "PreCompact": {
        // Observe/context event — continue's PreCompactInput is HookInputBase +
        // trigger ("manual"|"auto") + custom_instructions. Mirror the claude-code
        // adapter exactly: keep only the normalized `trigger`; everything else
        // rides on `raw`.
        const ev: PreCompactEvent = {
          ...base,
          ...(input.trigger === "auto" || input.trigger === "manual"
            ? { trigger: input.trigger }
            : {}),
        };
        return ev;
      }
      default: {
        // Continue never delivers PostCompact (not in HOOK_EVENT_NAMES — see
        // SUPPORTED_EVENTS). If the runtime dispatches one anyway, surface it
        // loudly rather than silently mis-parse.
        throw new Error(`unsupported continue hook event: ${String(event)}`);
      }
    }
  }

  // ── Runtime: normalized response → Continue native (Claude-shaped) reply ──
  // Continue's HookOutput is Claude-identical, so this mirrors the claude-code
  // adapter's formatReply byte-for-byte:
  //   PermissionRequest → nested decision{ behavior:"allow"|"deny" } envelope;
  //   PostToolUseFailure / SubagentStart → context-only (deny degrades to
  //     additionalContext carrying the reason);
  //   Stop / SubagentStop / UserPromptSubmit / PostToolUse deny → TOP-LEVEL
  //     { decision:"block", reason };
  //   other deny → hookSpecificOutput.permissionDecision:"deny"; ask → "ask";
  //   modify (PreToolUse) → updatedInput; context → additionalContext.

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    const hookEventName = event as ClaudeHookEvent;
    const decision = response.decision ?? "allow";

    // PermissionRequest: nested decision{behavior} envelope. An EXPLICIT allow is
    // an active grant; ask/context/void fall through to the native dialog.
    if (event === "PermissionRequest") {
      if (response.decision === "deny") {
        return this.stdout({
          hookSpecificOutput: {
            hookEventName,
            decision: { behavior: "deny", message: response.reason ?? "Blocked by hook" },
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
              ...(response.updatedInput ? { updatedInput: response.updatedInput } : {}),
            },
          },
        });
      }
      return { exitCode: 0 };
    }

    // PostToolUseFailure (feedback beside the error) and SubagentStart (context
    // at the start of the subagent's conversation) are observe/context-only:
    // "context" emits additionalContext, "deny" degrades to the same carrying
    // the reason. Everything else passes through.
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
    // The deny shape is EVENT-SPECIFIC: Stop / SubagentStop / UserPromptSubmit /
    // PostToolUse honor only the TOP-LEVEL { decision:"block", reason }; the rest
    // use hookSpecificOutput.permissionDecision. (A SubagentStop block keeps the
    // subagent running with `reason` as its next instruction — Stop semantics.)
    if (decision === "deny") {
      if (
        event === "Stop" ||
        event === "SubagentStop" ||
        event === "UserPromptSubmit" ||
        event === "PostToolUse"
      ) {
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

    // modify → rewrite PreToolUse input (only where Continue supports it).
    if (decision === "modify") {
      if (event === "PreToolUse" && response.updatedInput) {
        return this.stdout({
          hookSpecificOutput: { hookEventName, updatedInput: response.updatedInput },
        });
      }
      // Output rewrite is unsupported; fall through to allow.
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
