/**
 * adapters/qwen-code — Qwen Code (Qwen CLI) platform adapter for agent-connector.
 *
 * Qwen Code is a Gemini-CLI-derived host, but — unlike Gemini CLI — its hook
 * WIRE PROTOCOL is Claude-compatible (verified against context-mode's proven
 * qwen-code adapter, which extends the shared ClaudeCodeBaseAdapter):
 *
 *   - Hook event names are PascalCase, identical to Claude Code:
 *       PreToolUse, PostToolUse, PreCompact, SessionStart, SessionEnd,
 *       UserPromptSubmit, Stop, Notification — plus the E1 extension events
 *       PermissionRequest, PostToolUseFailure, SubagentStart and SubagentStop,
 *       all Qwen-native (verified against the upstream
 *       docs/users/features/hooks.md: PermissionRequest takes the nested
 *       hookSpecificOutput.decision{behavior} envelope, PostToolUseFailure /
 *       SubagentStart are additionalContext feedback, and the Stop-class events
 *       Stop / SubagentStop / UserPromptSubmit / PostToolUse block via the
 *       TOP-LEVEL {"decision":"block","reason"} shape — only PreToolUse uses
 *       hookSpecificOutput.permissionDecision for deny).
 *     (NOT Gemini's BeforeTool/AfterTool/PreCompress vocabulary.)
 *   - Hook stdin JSON carries snake_case fields: session_id, transcript_path,
 *     cwd, tool_name, tool_input, tool_response, source, reason, prompt,
 *     trigger, stop_hook_active, message.
 *   - Reply is exit-code 0 + a `hookSpecificOutput` JSON object on stdout
 *     (permissionDecision allow|deny|ask, updatedInput, additionalContext) —
 *     the Claude reply shape. Qwen's PreToolUse CAN rewrite tool input
 *     (updatedInput; capabilities.canModifyArgs = true), but — verified against
 *     qwen 0.17.1 — there is NO `updatedMCPToolOutput` honor on PostToolUse, so
 *     this host CANNOT rewrite already-emitted tool output
 *     (capabilities.canModifyOutput = false, like the Claude-family hosts).
 *   - Native tool names are Qwen/Gemini-flavored (run_shell_command, read_file,
 *     write_file, grep_search, …) — used only inside matcher strings; the wire
 *     field names are unchanged from Claude.
 *
 * Native config (JSONC — Qwen shares Gemini's tolerant settings loader; we write
 * strict JSON and MERGE into any existing settings so user keys survive):
 *   - MCP servers: user → ~/.qwen/settings.json; project → <projectDir>/.qwen/
 *     settings.json. Root key "mcpServers". Qwen is a Gemini-CLI fork, so — like
 *     Gemini — the MCP TRANSPORT IS SELECTED BY WHICH KEY IS PRESENT, not a
 *     `type` field: stdio → {command,args,env(,cwd)}; SSE → {url, headers?};
 *     streamable-HTTP → {httpUrl, headers?}.
 *   - Hooks: the SAME settings.json, top-level sibling "hooks" key, keyed by the
 *     PascalCase event name, each value an array of
 *     `{ matcher, hooks:[{ type:"command", command }] }`.
 *
 * Env handling: Qwen's settings loader has no `${env:VAR}` interpolation of our
 * framework's dialect, so env / header / url refs resolve to literals at install
 * time via resolveEnvRefsDeep — the safe default shared with the Gemini / Codex
 * adapters.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { BaseAdapter, type HookMergeDescriptor } from "../base.js";
import type { Adapter, HookReply, InstallContext, MemoryTarget, NormalizedEvent } from "../spi.js";
import type {
  ChangeRecord,
  CommandDef,
  DetectedPlatform,
  HealthCheck,
  HookEventName,
  HookParadigm,
  HookResponse,
  JsonValue,
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
  SkillDef,
  StatuslineContext,
  StopEvent,
  SubagentDef,
  SubagentStartEvent,
  SubagentStopEvent,
  Transport,
  UserPromptSubmitEvent,
} from "../../core/types.js";
import { renderSkillMd } from "../claude-code/render.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import { writeTomlString } from "../../core/toml.js";
import {
  buildHomeBinStatuslineCommand,
  buildWrappedStdio,
  isHomeBinHookCommand,
  isHomeBinStatuslineCommand,
} from "../../core/spawn.js";
import { normalizeSessionSource } from "../claude-code/wire.js";
import {
  type ConfigPatchLedgerEntry,
  addLedgerOwner,
  createLedgerEntry,
  describeJsonValue,
  dropLedgerEntry,
  findLedgerEntry,
  hashJsonValue,
  jsonDeepEquals,
  ledgerEntriesOwnedBy,
  loadConfigPatchLedger,
  removeLedgerOwner,
  saveConfigPatchLedger,
} from "../../core/config-patch-ledger.js";

const HOST: PlatformId = "qwen-code";
const MCP_ROOT_KEY = "mcpServers";

/**
 * settings.json leaf key the statusline surface owns on Qwen. UNLIKE claude-code
 * (a top-level `statusLine` leaf), Qwen nests its status-line config under `ui`
 * (`{ ui: { statusLine: { type:"command", command, refreshInterval? } } }` in
 * ~/.qwen/settings.json; verified against the qwen-code status-line docs and
 * QwenLM/qwen-code settings.md, shipped v0.14.3 / PR #2923). We own the
 * `ui.statusLine` leaf via the SAME refcounted ownership ledger as configPatch
 * (the ledger is surface-agnostic) — never clobbering a `ui.statusLine` a user
 * already set.
 */
const STATUSLINE_KEY = "ui.statusLine";

/** A single hook registration entry as Qwen stores it (Claude-shaped, nested). */
interface QwenHookEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string }>;
}

/** Shape of Qwen's settings.json (only the parts we touch). */
interface QwenSettingsFile {
  mcpServers?: Record<string, unknown>;
  hooks?: Record<string, QwenHookEntry[]>;
  [key: string]: unknown;
}

/**
 * Qwen's statusLine command stdin payload (the documented status-line input Qwen
 * pipes to the command, read once). Every field optional — a refresh only carries
 * what the host knows. Unmodeled fields (version, git, metrics, vim) stay in
 * StatuslineContext.raw. Sources: qwenlm.github.io/qwen-code-docs status-line page,
 * QwenLM/qwen-code settings.md.
 */
interface QwenStatuslineInput {
  session_id?: string;
  version?: string;
  model?: { display_name?: string };
  context_window?: {
    context_window_size?: number;
    used_percentage?: number;
    remaining_percentage?: number;
    current_usage?: number;
    total_input_tokens?: number;
    total_output_tokens?: number;
  };
  workspace?: { current_dir?: string };
  git?: { branch?: string };
  vim?: { mode?: string };
}

/**
 * Native MCP server entry shapes Qwen accepts under `mcpServers`. Qwen is a
 * Gemini-CLI fork, so the REMOTE transport is selected by WHICH KEY is present
 * (NOT a `type` field): SSE → `url`, streamable-HTTP → `httpUrl`. The stdio
 * entry keeps its (harmless, Claude-style) `type:"stdio"` tag — Qwen accepts it
 * and stdio is unambiguous by its command/args anyway.
 */
interface QwenStdioServer {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}
interface QwenSseServer {
  url: string;
  headers?: Record<string, string>;
}
interface QwenHttpServer {
  httpUrl: string;
  headers?: Record<string, string>;
}

/** Raw Qwen hook stdin payload (Claude-compatible snake_case wire fields). */
interface QwenWireInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;

  // tool events
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** PostToolUse result payload (string or structured). */
  tool_response?: unknown;

  // PermissionRequest — suggested permission entries the dialog would offer.
  permission_suggestions?: unknown[];

  // PostToolUseFailure (Qwen documents tool_use_id/error/is_interrupt; there is
  // no duration_ms on this host's payload).
  tool_use_id?: string;
  error?: string;
  is_interrupt?: boolean;

  // SubagentStart / SubagentStop — treat both as optional everywhere (the
  // Claude-family quirk: agent_type is not reliably populated on stop).
  agent_id?: string;
  agent_type?: string;
  // SubagentStop — the subagent's OWN transcript + its final message.
  agent_transcript_path?: string;
  last_assistant_message?: string;

  // SessionStart
  source?: string;
  // SessionEnd
  reason?: string;
  // UserPromptSubmit
  prompt?: string;
  // PreCompact
  trigger?: string;
  // Stop
  stop_hook_active?: boolean;
  // Notification
  message?: string;

  /** Injected by the entrypoint so the runtime knows which connector to dispatch. */
  connector?: unknown;
}

export class QwenCodeAdapter extends BaseAdapter implements Adapter {
  readonly id: PlatformId = HOST;
  readonly name = "Qwen CLI";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: AGENTS.md-first managed block (project <projectDir>/AGENTS.md
    // via the base default — Qwen reads repo AGENTS.md natively alongside QWEN.md,
    // so no QWEN.md duplicate; user scope → ~/.qwen/QWEN.md below, the only
    // documented user-scope memory file).
    supportsMemory: true,
    preToolUse: true,
    postToolUse: true,
    preCompact: true,
    // Qwen fires PostCompact natively (observe-only — "not in the decision mode
    // supported events list"; QwenLM/qwen-code docs/users/features/hooks.md
    // "#### PostCompact", trigger + compact_summary payload).
    postCompact: true,
    sessionStart: true,
    sessionEnd: true,
    userPromptSubmit: true,
    stop: true,
    notification: true,
    // E1 events — all four are Qwen-native (its 16-event surface is strictly
    // wider than the canonical union).
    permissionRequest: true,
    postToolUseFailure: true,
    subagentStart: true,
    subagentStop: true,
    // Qwen's PreToolUse can rewrite input (updatedInput). It CANNOT rewrite
    // already-emitted tool output — `updatedMCPToolOutput` does not exist in
    // qwen 0.17.1, so canModifyOutput is false (like the Claude-family hosts).
    canModifyArgs: true,
    canModifyOutput: false,
    canInjectSessionContext: true,
    transports: ["stdio", "sse", "http"],
    // Content surfaces: Qwen ships native slash commands (TOML), subagents
    // (md+frontmatter), and skills (SKILL.md under .qwen/skills/<name>/).
    // Confirmed dir: .qwen/skills/ (project), ~/.qwen/skills/ (user scope).
    // Ground truth: kilo-pi-ground-truth.md § "Already-known skills gaps".
    supportsCommands: true,
    supportsSkills: true,
    supportsSubagents: true,
    // Statusline surface: qwen-code is the 2nd v1 host (after claude-code).
    // installStatusline wires settings.json `ui.statusLine` = {type:"command",
    // command:<home-bin statusline cmd>} through the SAME refcounted ownership
    // ledger as configPatch (never clobbers a ui.statusLine agent-connector does
    // not own). The key is NESTED here (`ui.statusLine`), unlike claude-code's
    // top-level `statusLine`. Confirmed config key + stdin payload against the
    // qwen-code status-line docs (shipped v0.14.3, PR #2923).
    supportsStatusline: true,
    // Native passthrough: Qwen's 16-event surface includes 3 host-specific events
    // with NO canonical HookEventName analog — TodoCreated / TodoCompleted /
    // StopFailure (QwenLM/qwen-code docs/users/features/hooks.md). A connector
    // reaches them via platforms["qwen-code"].nativeHooks; installHooks files the
    // PascalCase event key VERBATIM into settings.json hooks, and the generic
    // uninstall reverses it.
    supportsNativeHooks: true,
  };

  // ── Detection ────────────────────────────────────────────────────────────

  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = join(homedir(), ".qwen");
    const userSettings = join(userDir, "settings.json");
    const projectDirQwen = join(projectDir, ".qwen");
    const projectSettings = join(projectDirQwen, "settings.json");
    const userInstalled = existsSync(userDir) || existsSync(userSettings);
    const projInstalled = existsSync(projectDirQwen) || existsSync(projectSettings);
    const installed = userInstalled || projInstalled;
    // Report the scope/path that actually matched, so a project-only install
    // isn't misreported as a (non-existent) user install.
    const scope = projInstalled && !userInstalled ? "project" : "user";
    const configPath = scope === "project" ? projectSettings : userSettings;
    return {
      id: this.id,
      name: this.name,
      installed,
      paradigm: this.paradigm,
      capabilities: this.capabilities,
      configPath,
      scope,
      reason: installed
        ? scope === "project"
          ? `found project Qwen CLI config at ${projectSettings}`
          : `found Qwen CLI config under ${userDir}`
        : `no Qwen CLI config at ${userDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Memory surface: ~/.qwen/QWEN.md at user scope ────────────────────────
  // Project scope stays on the AGENTS.md base default (Qwen reads the repo
  // AGENTS.md natively in ADDITION to QWEN.md — one canonical copy, never a
  // QWEN.md duplicate). User scope targets ~/.qwen/QWEN.md: Qwen has no
  // user-scope AGENTS.md, so the host's own global memory file is the only
  // file it actually reads there.
  protected override memoryTargets(ctx: InstallContext): MemoryTarget[] {
    if (this.memoryOverride(ctx)?.path || ctx.scope !== "user") {
      return super.memoryTargets(ctx);
    }
    return [
      {
        path: join(homedir(), ".qwen", "QWEN.md"),
        reason: "qwen-code global memory (~/.qwen/QWEN.md; no user-scope AGENTS.md exists)",
      },
    ];
  }

  // ── Native paths ─────────────────────────────────────────────────────────

  getConfigDir(ctx: InstallContext): string {
    return ctx.scope === "project"
      ? join(ctx.projectDir, ".qwen")
      : join(homedir(), ".qwen");
  }

  /** MCP servers live in settings.json under `mcpServers`. */
  getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "settings.json");
  }

  /** Hooks live in the SAME settings.json under the sibling `hooks` key. */
  getHookConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "settings.json");
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
            ? "server registration disabled for qwen-code"
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

  /**
   * Render a normalized ServerDef into Qwen's native mcpServers entry. As a
   * Gemini-CLI fork, the transport is encoded by WHICH KEY is present (NOT a
   * `type` field): command/args/env (stdio), url (sse), httpUrl (http).
   */
  private renderServerEntry(
    ctx: InstallContext,
    server: ServerDef,
  ): QwenStdioServer | QwenSseServer | QwenHttpServer {
    const transport: Transport = server.transport;

    if (transport === "stdio") {
      let command = server.command ?? "";
      let args = [...(server.args ?? [])];

      // Transparent telemetry wrapping: route the real command through
      // `<homeBin> serve --connector <id> -- <command> <args...>`.
      ({ command, args } = buildWrappedStdio(ctx, server, this.id, command, args));

      const entry: QwenStdioServer = {
        type: "stdio",
        command: resolveEnvRefsDeep(command),
        args: args.map((a) => resolveEnvRefsDeep(a)),
      };
      const env = this.renderEnv(server.env);
      if (env) entry.env = env;
      if (server.cwd) entry.cwd = resolveEnvRefsDeep(server.cwd);
      return entry;
    }

    // SSE transport → `url` key.
    if (transport === "sse") {
      const entry: QwenSseServer = { url: resolveEnvRefsDeep(server.url ?? "") };
      const headers = this.renderEnv(server.headers);
      if (headers) entry.headers = headers;
      return entry;
    }

    // http (streamable-HTTP) and any other remote transport → `httpUrl` key.
    const entry: QwenHttpServer = { httpUrl: resolveEnvRefsDeep(server.url ?? "") };
    const headers = this.renderEnv(server.headers);
    if (headers) entry.headers = headers;
    return entry;
  }

  /**
   * Render env/header values. Qwen's settings loader does not interpret our
   * `${env:VAR}` dialect, so refs resolve to literals at install time — the safe
   * default shared with the Gemini / Codex adapters.
   */
  private renderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env || Object.keys(env).length === 0) return undefined;
    return resolveEnvRefsDeep({ ...env });
  }

  // ── Hook install / uninstall ─────────────────────────────────────────────

  installHooks(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    const override = connector.platforms[HOST];
    const hooksDisabled = override?.hooks === false;
    // `hooks: false` disables only the NORMALIZED events; nativeHooks is a
    // sibling, qwen-scoped declaration that installs regardless.
    const normalizedEvents = hooksDisabled ? [] : connector.hookEvents;
    const nativeHooks = override?.nativeHooks ?? {};
    const nativeEvents = Object.keys(nativeHooks);

    if (normalizedEvents.length === 0 && nativeEvents.length === 0) {
      return [
        {
          platform: this.id,
          action: "skip",
          detail: hooksDisabled ? "hooks disabled for qwen-code" : "connector declares no hooks",
        },
      ];
    }

    // Normalized events register their canonical PascalCase name verbatim (qwen's
    // hook vocabulary is Claude-identical — NO mapEvent, no warn path). Native
    // event-name keys ride the separate `native` pass (verbatim keys, FIRST-INNER
    // command match, the `(native)` detail) — see hookDescriptor + upsertHookEntries.
    const pending = normalizedEvents.map((event) => ({
      event,
      matcher: connector.hooks[event]?.matcher ?? "",
    }));
    const native = nativeEvents.map((event) => ({
      event,
      matcher: nativeHooks[event]?.matcher ?? "",
    }));
    return this.upsertHookEntries(
      ctx,
      this.getHookConfigPath(ctx),
      pending,
      this.hookDescriptor(ctx),
      native,
    );
  }

  uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    return this.removeHookEntries(ctx, this.getHookConfigPath(ctx), this.hookDescriptor(ctx));
  }

  /**
   * Qwen's hook-merge descriptor (NESTED shape `{ matcher, hooks:[{type,command}] }`):
   *  - NO mapEvent — qwen's events are Claude-identical, every canonical event is
   *    supported natively, so there is no unmapped/warn path.
   *  - install find (entryOwnsCommand) is connector-GENERIC: ANY of our commands in
   *    the nested hooks array (= the old entryHasOurCommand).
   *  - uninstall is NESTED: ownsEntryForRemove is never-true, so the engine only
   *    ever runs stripInner — strip our owned inner commands, keep foreign ones,
   *    drop entries left empty; `removed` = inner commands removed.
   *  - the native pass uses FIRST-INNER (`hooks[0].command`) EXACT-command ownership
   *    — qwen's exact current native match (NOT a `.some()`), distinct from the
   *    connector-generic normalized find. qwen writes no version/envelope (no onMutate).
   */
  private hookDescriptor(ctx: InstallContext): HookMergeDescriptor<QwenHookEntry> {
    return {
      renderEntry: (_event, matcher, command) => ({
        matcher,
        hooks: [{ type: "command", command }],
      }),
      entryOwnsCommand: (entry, _command) =>
        (entry.hooks ?? []).some((h) => this.isOurCommand(h.command, ctx)),
      ownsEntryForRemove: () => () => false,
      stripInner: (c) => (entry) => {
        const innerBefore = entry.hooks?.length ?? 0;
        const inner = (entry.hooks ?? []).filter((h) => !this.isOurCommand(h.command, c));
        return {
          next: inner.length > 0 ? { matcher: entry.matcher ?? "", hooks: inner } : null,
          removed: innerBefore - inner.length,
        };
      },
      skipDetail: (e) => `hooks.${e} already registered`,
      removeDetail: (e, n) => `hooks.${e} (${n})`,
      absentDetail: "no hooks section present",
      noMatchDetail: "no matching hook entries",
      nativeOwnsCommand: (entry, command) => entry.hooks?.[0]?.command === command,
      nativeSkipDetail: (e) => `hooks.${e} (native) already registered`,
      nativeMutateDetail: (e) => `hooks.${e} (native)`,
    };
  }

  /** True when a hook command references our home binary AND this connector id
   *  (anchored so a shared-prefix id can't collide — see isHomeBinHookCommand). */
  private isOurCommand(command: string | undefined, ctx: InstallContext): boolean {
    return isHomeBinHookCommand(command, ctx.homeBinPath, ctx.connector.id);
  }

  // ── Statusline surface (a HUD/status line) ────────────────────────────────
  // Wires settings.json `ui.statusLine` = { type:"command", command:<home-bin
  // statusline cmd> } through the SAME refcounted ownership ledger as configPatch
  // (the ledger primitives are surface-agnostic). qwen-code does NOT advertise
  // supportsConfigPatch, so — unlike claude-code, which routes the statusline
  // through its private applyConfigPatches loop — this adapter performs the nested
  // set-if-absent write directly with the exported ledger primitives. Semantics
  // are identical: never clobber a ui.statusLine agent-connector does not own
  // (skip-warn), record prior state + owner (refcounted across connectors),
  // reversible by uninstallStatusline (last-owner-verified delete). The key is
  // NESTED (`ui.statusLine`), so we own the `ui.statusLine` leaf — if the user
  // already has it, we skip-warn and never touch their value.
  //
  // The home-bin command makes Qwen exec
  // `<homeBin> statusline qwen-code --connector <id>` for every status refresh,
  // which re-imports the connector module and renders the line (runtime/
  // statusline-entrypoint). No telemetry in v1.

  /** The statusLine config object value agent-connector writes at `ui.statusLine`. */
  private statuslineValue(ctx: InstallContext): JsonValue {
    const command = buildHomeBinStatuslineCommand(ctx.homeBinPath, HOST, ctx.connector.id);
    return { type: "command", command };
  }

  override installStatusline(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.statusline == null) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no statusline" }];
    }
    if (connector.platforms[HOST]?.statusline === false) {
      return [{ platform: this.id, action: "skip", detail: "statusline disabled for qwen-code" }];
    }

    const filePath = this.getServerConfigPath(ctx);
    // OVERWRITE GUARD (upsertServerInJson precedent): never round-trip a
    // present-but-unparseable settings file into `{}`.
    if (this.isPresentButUnparseable(filePath)) {
      return [
        {
          platform: this.id,
          action: "warn",
          path: filePath,
          detail: `existing ${filePath} is not parseable; statusline left unapplied (back it up / fix it, then re-run)`,
        },
      ];
    }
    const settings = this.readJson<Record<string, unknown>>(filePath) ?? {};
    if (typeof settings !== "object" || Array.isArray(settings)) {
      return [
        {
          platform: this.id,
          action: "warn",
          path: filePath,
          detail: `existing ${filePath} is not a JSON object; statusline left unapplied`,
        },
      ];
    }

    const ledger = loadConfigPatchLedger(ctx.dataRoot);
    const desired = this.statuslineValue(ctx);
    const segments = STATUSLINE_KEY.split(".");
    const leaf = readJsonLeaf(settings, segments);
    const entry = findLedgerEntry(ledger, HOST, filePath, STATUSLINE_KEY);
    const changes: ChangeRecord[] = [];

    if (leaf.kind === "blocked") {
      return [
        {
          platform: this.id,
          action: "warn",
          path: filePath,
          detail:
            `statusline ${STATUSLINE_KEY} skipped: "${leaf.atPath}" exists but is not an ` +
            `object — set ${STATUSLINE_KEY} manually if wanted`,
        },
      ];
    }

    if (leaf.kind === "absent") {
      // SET-IF-ABSENT: the one write path. Intermediates (`ui`) created as needed.
      writeJsonLeaf(settings, segments, desired);
      this.writeJson(filePath, settings, ctx.dryRun);
      if (entry) {
        // Stale ledger row (key deleted out from under us): re-assert the value,
        // keep existing owners (they still rely on the key), record what we wrote.
        entry.writtenValue = desired;
        entry.writtenValueHash = hashJsonValue(desired);
        addLedgerOwner(entry, connector.id, connector.version);
      } else {
        createLedgerEntry(ledger, {
          platform: HOST,
          file: filePath,
          key: STATUSLINE_KEY,
          value: desired,
          connectorId: connector.id,
          connectorVersion: connector.version,
        });
      }
      if (!ctx.dryRun) saveConfigPatchLedger(ctx.dataRoot, ledger);
      changes.push({
        platform: this.id,
        action: "create",
        path: filePath,
        detail: `statusline ${STATUSLINE_KEY}: <absent> → ${describeJsonValue(desired)}`,
      });
      return changes;
    }

    // Key PRESENT — never overwrite; the only question is ownership/refcount.
    if (!entry) {
      // User- (or other-tool-) owned. No ownership is taken even when the values
      // happen to match — uninstall must never delete a key we did not create.
      return [
        {
          platform: this.id,
          action: "warn",
          path: filePath,
          detail:
            `statusline ${STATUSLINE_KEY} skipped: already set to ${describeJsonValue(leaf.value)} ` +
            `(not created by agent-connector) — left untouched`,
        },
      ];
    }

    if (!jsonDeepEquals(leaf.value, entry.writtenValue)) {
      // DRIFT: the user edited the value after we wrote it. Never revert.
      return [
        {
          platform: this.id,
          action: "warn",
          path: filePath,
          detail:
            `statusline ${STATUSLINE_KEY}: value changed since install ` +
            `(current ${describeJsonValue(leaf.value)}, wrote ${describeJsonValue(entry.writtenValue)}); ` +
            `leaving in place`,
        },
      ];
    }

    if (jsonDeepEquals(desired, leaf.value)) {
      // Same value we own: register as co-owner (refcount++) or idempotent skip.
      const owners = entry.owners.map((o) => o.connectorId);
      if (addLedgerOwner(entry, connector.id, connector.version)) {
        if (!ctx.dryRun) saveConfigPatchLedger(ctx.dataRoot, ledger);
        return [
          {
            platform: this.id,
            action: "skip",
            path: filePath,
            detail: `statusline ${STATUSLINE_KEY} already installed; registered as co-owner (co-owned with ${owners.join(", ")})`,
          },
        ];
      }
      return [
        {
          platform: this.id,
          action: "skip",
          path: filePath,
          detail: `statusline ${STATUSLINE_KEY} already installed`,
        },
      ];
    }

    // FIRST-WRITER-WINS: another connector owns the key with a different value.
    return [
      {
        platform: this.id,
        action: "warn",
        path: filePath,
        detail:
          `statusline ${STATUSLINE_KEY} skipped: already owned by ${entry.owners
            .map((o) => o.connectorId)
            .join(", ")} with a different value — left untouched`,
      },
    ];
  }

  override uninstallStatusline(ctx: InstallContext): ChangeRecord[] {
    const ledger = loadConfigPatchLedger(ctx.dataRoot);
    // Release ONLY the ui.statusLine ledger row this connector owns (keyed off the
    // ledger, not the declaration, so an id-only synthetic uninstall still reclaims
    // it). Last-owner-verified delete: remove the key ONLY when last-owner ∧
    // value-unchanged ∧ prior-absent (else skip-warn + leave the key).
    const owned = ledgerEntriesOwnedBy(ledger, HOST, ctx.connector.id).filter(
      (e) => e.key === STATUSLINE_KEY,
    );
    if (owned.length === 0) {
      return [
        {
          platform: this.id,
          action: "skip",
          detail: "statusline: no ownership recorded; left untouched",
        },
      ];
    }

    const changes: ChangeRecord[] = [];
    let ledgerMutated = false;

    // All rows share one file (the scope-resolved settings.json), but group by
    // file anyway so a scope drift between install and uninstall stays correct.
    const byFile = new Map<string, ConfigPatchLedgerEntry[]>();
    for (const entry of owned) {
      const bucket = byFile.get(entry.file) ?? [];
      bucket.push(entry);
      byFile.set(entry.file, bucket);
    }

    for (const [filePath, entries] of byFile) {
      const unparseable = this.isPresentButUnparseable(filePath);
      const settings = unparseable ? null : this.readJson<Record<string, unknown>>(filePath);
      let fileMutated = false;

      for (const entry of entries) {
        const { lastOwner } = removeLedgerOwner(entry, ctx.connector.id);
        ledgerMutated = true;

        if (!lastOwner) {
          // Shared-flag case: A uninstalls, B still relies on the key.
          changes.push({
            platform: this.id,
            action: "skip",
            path: filePath,
            detail: `statusline ${entry.key} retained: still owned by ${entry.owners
              .map((o) => o.connectorId)
              .join(", ")}`,
          });
          continue;
        }

        // Last owner out → the ledger row is dropped on every branch below; the
        // KEY is removed only on the fully-verified branch.
        dropLedgerEntry(ledger, entry);

        if (unparseable) {
          changes.push({
            platform: this.id,
            action: "warn",
            path: filePath,
            detail: `statusline ${entry.key}: ${filePath} is not parseable; key left in place (ownership released)`,
          });
          continue;
        }
        if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
          changes.push({
            platform: this.id,
            action: "skip",
            path: filePath,
            detail: `statusline ${entry.key} already absent (no settings file); ownership record dropped`,
          });
          continue;
        }
        const leaf = readJsonLeaf(settings, entry.key.split("."));
        if (leaf.kind !== "present") {
          changes.push({
            platform: this.id,
            action: "skip",
            path: filePath,
            detail: `statusline ${entry.key} already absent; ownership record dropped`,
          });
          continue;
        }
        if (entry.prior?.present !== false || !jsonDeepEquals(leaf.value, entry.writtenValue)) {
          // User edited the value after install (or the row predates the
          // set-if-absent guarantee): deleting would clobber them. Leave it.
          changes.push({
            platform: this.id,
            action: "warn",
            path: filePath,
            detail:
              `statusline ${entry.key}: value changed since install ` +
              `(current ${describeJsonValue(leaf.value)}, wrote ${describeJsonValue(entry.writtenValue)}); ` +
              `left in place`,
          });
          continue;
        }

        // VERIFIED: last owner + current === writtenValue + prior absent. Delete
        // the leaf key (the `ui` intermediate we may have created is left in place).
        deleteJsonLeaf(settings, entry.key.split("."));
        fileMutated = true;
        changes.push({
          platform: this.id,
          action: "remove",
          path: filePath,
          detail: `statusline ${entry.key} removed (was ${describeJsonValue(entry.writtenValue)})`,
        });
      }

      if (fileMutated && settings) this.writeJson(filePath, settings, ctx.dryRun);
    }

    if (ledgerMutated && !ctx.dryRun) saveConfigPatchLedger(ctx.dataRoot, ledger);
    return changes;
  }

  /**
   * Parse Qwen's statusLine stdin JSON into the normalized
   * {@link StatuslineContext}. Qwen pipes a JSON object to the statusLine command
   * on stdin (model, context_window, workspace, git, …); fields the payload omits
   * stay undefined. `raw` keeps the verbatim payload (incl. version/git/metrics/
   * vim). NOTE: Qwen has NO cost analog (no cost field in the payload), so
   * `ctx.cost` is intentionally left undefined. Sources: qwen-code status-line
   * docs, QwenLM/qwen-code settings.md.
   */
  parseStatusInput(raw: unknown): StatuslineContext {
    const input = (raw ?? {}) as QwenStatuslineInput;

    const ctx: StatuslineContext = {
      host: HOST,
      capabilities: this.capabilities,
      raw,
    };
    if (typeof input.session_id === "string" && input.session_id !== "") {
      ctx.sessionId = input.session_id;
    }
    if (typeof input.workspace?.current_dir === "string") {
      ctx.cwd = input.workspace.current_dir;
    }
    if (typeof input.model?.display_name === "string") {
      ctx.model = { displayName: input.model.display_name };
    }
    const cw = input.context_window;
    if (cw) {
      const context: { usedTokens?: number; maxTokens?: number; percent?: number } = {};
      if (typeof cw.context_window_size === "number") context.maxTokens = cw.context_window_size;
      if (typeof cw.current_usage === "number") context.usedTokens = cw.current_usage;
      if (typeof cw.used_percentage === "number") context.percent = cw.used_percentage;
      if (
        context.usedTokens !== undefined ||
        context.maxTokens !== undefined ||
        context.percent !== undefined
      ) {
        ctx.context = context;
      }
    }
    // ctx.cost stays undefined: Qwen's status payload has no cost analog.
    return ctx;
  }

  /** Format the rendered status line into Qwen's native reply: stdout = line, exit 0. */
  formatStatusOutput(rendered: string): HookReply {
    return { exitCode: 0, stdout: rendered };
  }

  // ── Content surfaces: commands / subagents ───────────────────────────────
  // CONTENT-ONLY: pure native-file writers under <qwenDir>/{commands,agents}. No
  // runtime dispatch, no home-bin pointer, no telemetry wrap. Each method is
  // idempotent (byte-identical → skip) via BaseAdapter.writeContentFile and
  // reversible via removeContentFile. Honors platforms["qwen-code"] per-surface
  // false to skip. Qwen has NO Agent-Skills surface, so skills are left to the
  // BaseAdapter skip/warn default (supportsSkills stays false).

  private commandsDir(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "commands");
  }
  private skillsDir(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "skills");
  }
  private agentsDir(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "agents");
  }

  /** Native command file path: <qwenDir>/commands/<name>.toml. */
  private commandPath(ctx: InstallContext, name: string): string {
    return join(this.commandsDir(ctx), `${name}.toml`);
  }
  /** Native skill dir: <qwenDir>/skills/<name>. */
  private skillDir(ctx: InstallContext, name: string): string {
    return join(this.skillsDir(ctx), name);
  }
  /** Native subagent file path: <qwenDir>/agents/<name>.md. */
  private subagentPath(ctx: InstallContext, name: string): string {
    return join(this.agentsDir(ctx), `${name}.md`);
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  override installCommands(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.commands === false) {
      return [{ platform: this.id, action: "skip", detail: "commands disabled for qwen-code" }];
    }
    if (connector.commands.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no commands" }];
    }
    return connector.commands.map((cmd) =>
      this.writeContentFile(
        this.commandPath(ctx, cmd.name),
        this.renderCommand(cmd),
        ctx.dryRun,
      ),
    );
  }

  override uninstallCommands(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.commands.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no commands" }];
    }
    return connector.commands.map((cmd) =>
      this.removeContentFile(this.commandPath(ctx, cmd.name), ctx.dryRun),
    );
  }

  /** Render a command to Qwen's native TOML (description, prompt). */
  private renderCommand(cmd: CommandDef): string {
    const obj: Record<string, unknown> = {};
    if (cmd.description !== undefined) obj.description = cmd.description;
    obj.prompt = cmd.prompt;
    return writeTomlString(obj);
  }

  // ── Skills ────────────────────────────────────────────────────────────────
  // Qwen reads SKILL.md from <qwenDir>/skills/<name>/SKILL.md.
  // Project dir: <projectDir>/.qwen/skills/<name>/SKILL.md
  // User dir:    ~/.qwen/skills/<name>/SKILL.md
  // Confirmed: kilo-pi-ground-truth.md § "Already-known skills gaps" (.qwen/skills).

  override installSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.skills === false) {
      return [{ platform: this.id, action: "skip", detail: "skills disabled for qwen-code" }];
    }
    if (connector.skills.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no skills" }];
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

  // ── Subagents ──────────────────────────────────────────────────────────────

  override installSubagents(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[HOST]?.subagents === false) {
      return [{ platform: this.id, action: "skip", detail: "subagents disabled for qwen-code" }];
    }
    if (connector.subagents.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no subagents" }];
    }
    return connector.subagents.map((agent) =>
      this.writeContentFile(
        this.subagentPath(ctx, agent.name),
        this.renderSubagent(agent),
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

  /** Render a subagent to md+frontmatter (name, description, tools, model) + prompt body. */
  private renderSubagent(agent: SubagentDef): string {
    const frontmatter: Record<string, unknown> = {
      name: agent.name,
      description: agent.description,
    };
    const allow = agent.tools?.allow;
    if (allow && allow.length > 0) frontmatter.tools = allow.join(", ");
    if (agent.model !== undefined) frontmatter.model = agent.model;
    if (agent.extra) Object.assign(frontmatter, agent.extra);
    return this.renderFrontmatterMd(frontmatter, agent.prompt);
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const settingsPath = this.getHookConfigPath(ctx);
    const connectorId = ctx.connector.id;
    const homeBin = ctx.homeBinPath;
    const hookEvents = ctx.connector.hookEvents;
    const checks: HealthCheck[] = [
      {
        name: `${this.name}: settings.json present`,
        check: () =>
          existsSync(settingsPath)
            ? { status: "OK", detail: settingsPath }
            : { status: "FAIL", detail: `not found: ${settingsPath}` },
      },
      {
        name: `${this.name}: hook command registered`,
        check: () => {
          if (hookEvents.length === 0) {
            return { status: "OK", detail: "no hooks declared" };
          }
          const settings = this.readJson<QwenSettingsFile>(settingsPath);
          if (!settings) return { status: "FAIL", detail: `cannot read ${settingsPath}` };
          const hooks = settings.hooks ?? {};
          const registered = Object.values(hooks).some((entries) =>
            (entries ?? []).some((e) =>
              (e.hooks ?? []).some((h) =>
                isHomeBinHookCommand(h.command, homeBin, connectorId),
              ),
            ),
          );
          return registered
            ? { status: "OK", detail: "hook command present" }
            : { status: "FAIL", detail: `no hook for ${connectorId} in ${settingsPath}` };
        },
      },
    ];

    // Content-surface checks: assert presence of all three content surfaces
    // (commands, skills, subagents) this connector declares.
    for (const cmd of ctx.connector.commands) {
      const p = this.commandPath(ctx, cmd.name);
      checks.push({
        name: `${this.name}: command ${cmd.name} present`,
        check: () =>
          existsSync(p) ? { status: "OK", detail: p } : { status: "FAIL", detail: `not found: ${p}` },
      });
    }
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

    // Statusline check: assert it when the connector declares a statusline AND it
    // is not disabled for this host, OR when the ownership ledger holds a
    // ui.statusLine row this connector owns (the REGISTERED-connector path:
    // connectorFromMeta can't re-expose the render fn, so statusline comes back
    // undefined — but the ledger row proves the surface was wired). Mirrors
    // claude-code's "statusline wired" check; ui.statusLine.command must be OUR
    // home-bin statusline command (OK); present-but-not-ours / absent → FAIL.
    const statuslineLedgerOwned = ledgerEntriesOwnedBy(
      loadConfigPatchLedger(ctx.dataRoot),
      HOST,
      connectorId,
    ).some((e) => e.key === STATUSLINE_KEY);
    if (
      (ctx.connector.statusline != null || statuslineLedgerOwned) &&
      ctx.connector.platforms[HOST]?.statusline !== false
    ) {
      checks.push({
        name: `${this.name}: statusline wired`,
        check: () => {
          const settings = this.readJson<{ ui?: { statusLine?: { command?: unknown } } }>(
            settingsPath,
          );
          const command = settings?.ui?.statusLine?.command;
          if (command === undefined) {
            return { status: "FAIL", detail: `ui.statusLine not set in ${settingsPath}` };
          }
          if (
            typeof command === "string" &&
            isHomeBinStatuslineCommand(command, homeBin, connectorId)
          ) {
            return { status: "OK", detail: "ui.statusLine command present" };
          }
          // Present but not ours — a non-AC ui.statusLine we must never clobber.
          return {
            status: "FAIL",
            detail: `ui.statusLine in ${settingsPath} is not agent-connector's (left untouched)`,
          };
        },
      });
    }
    return checks;
  }

  // ── Runtime: parse Qwen stdin JSON → normalized event ────────────────────

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as QwenWireInput;
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
        // Qwen fires PostCompact natively (observe-only). Parsed like PreCompact:
        // normalize the trigger (auto|manual); compact_summary rides on `raw`.
        const ev: PostCompactEvent = {
          ...base,
          ...(input.trigger === "auto" || input.trigger === "manual"
            ? { trigger: input.trigger }
            : {}),
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
      case "PostToolUseFailure": {
        // durationMs stays unset — Qwen's failure payload has no duration_ms.
        const ev: PostToolUseFailureEvent = {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          error: typeof input.error === "string" ? input.error : "",
          ...(typeof input.tool_use_id === "string"
            ? { toolUseId: input.tool_use_id }
            : {}),
          ...(typeof input.is_interrupt === "boolean"
            ? { isInterrupt: input.is_interrupt }
            : {}),
        };
        return ev;
      }
      case "SubagentStart": {
        const ev: SubagentStartEvent = {
          ...base,
          ...(typeof input.agent_id === "string" ? { agentId: input.agent_id } : {}),
          ...(typeof input.agent_type === "string"
            ? { agentType: input.agent_type }
            : {}),
        };
        return ev;
      }
      case "SubagentStop": {
        // agent_id/agent_type stay optional — the Claude-family SDK does not
        // reliably populate agent_type on stop.
        const ev: SubagentStopEvent = {
          ...base,
          ...(typeof input.agent_id === "string" ? { agentId: input.agent_id } : {}),
          ...(typeof input.agent_type === "string"
            ? { agentType: input.agent_type }
            : {}),
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
      default: {
        // Exhaustive guard — every HookEventName is handled above.
        const _never: never = event;
        throw new Error(`unsupported qwen-code hook event: ${String(_never)}`);
      }
    }
  }

  // ── Runtime: normalized response → Qwen native hook reply ────────────────

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    const hookEventName = event;
    const decision = response.decision ?? "allow";

    // PermissionRequest uses Qwen's nested decision{behavior} envelope (Claude-
    // identical) and is the ONE event where an EXPLICIT "allow" is an ACTIVE
    // grant that suppresses the permission dialog:
    //   allow            → decision{behavior:"allow"} (+updatedInput when set —
    //                      Qwen honors input rewrite, canModifyArgs above);
    //   modify           → an allow grant carrying updatedInput;
    //   deny             → decision{behavior:"deny", message};
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

    // PostToolUseFailure (feedback beside the error) and SubagentStart (context
    // injected into the SUBAGENT's conversation) are observe/context-only on
    // Qwen: "context" emits additionalContext, and a "deny" DEGRADES to the
    // same shape carrying the reason (the tool already failed / the spawn is
    // not blockable).
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
    // Qwen's deny shape is EVENT-SPECIFIC (claude-wire-compatible): PreToolUse
    // uses hookSpecificOutput.permissionDecision, but Stop / SubagentStop /
    // UserPromptSubmit / PostToolUse honor only the TOP-LEVEL
    // {"decision":"block","reason"} — those events do NOT take permissionDecision
    // (QwenLM/qwen-code docs/users/features/hooks.md: Stop/SubagentStop block via
    // {"decision":"block","reason"}; UserPromptSubmit/PostToolUse output options
    // list top-level `decision`+`reason`, not permissionDecision — only
    // PreToolUse documents permissionDecision as its official interface). A
    // SubagentStop / Stop block keeps the agent running with `reason` as its next
    // instruction (Stop semantics).
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

    // modify → rewrite PreToolUse input only. Qwen 0.17.1 has no PostToolUse
    // output-rewrite (`updatedMCPToolOutput` does not exist), so a modify on any
    // other event falls through to allow.
    if (decision === "modify") {
      if (event === "PreToolUse" && response.updatedInput) {
        return this.stdout({
          hookSpecificOutput: { hookEventName, updatedInput: response.updatedInput },
        });
      }
      // Nothing applicable on this event; fall through to allow.
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

// ─────────────────────────────────────────────────────────────────────────
// JSON leaf-path helpers (statusline nested set-if-absent). Mirror claude-code's
// file-local helpers (those are private to the claude-code module). The leaf
// path here is the validated dotted `ui.statusLine`.
// ─────────────────────────────────────────────────────────────────────────

/** Result of looking up a dotted leaf path in a parsed JSON object. */
type JsonLeafLookup =
  | { kind: "absent" }
  | { kind: "present"; value: JsonValue }
  | { kind: "blocked"; atPath: string };

/**
 * Walk `segments` (a dotted leaf path) through `root`. "blocked" reports the
 * first intermediate that exists but is not a plain object — the skip-warn case
 * (we never replace a non-object intermediate, e.g. a user's `ui: "dark"`).
 */
function readJsonLeaf(root: Record<string, unknown>, segments: string[]): JsonLeafLookup {
  let node: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const next = node[segments[i]!];
    if (next === undefined) return { kind: "absent" };
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      return { kind: "blocked", atPath: segments.slice(0, i + 1).join(".") };
    }
    node = next as Record<string, unknown>;
  }
  const leaf = node[segments[segments.length - 1]!];
  if (leaf === undefined) return { kind: "absent" };
  return { kind: "present", value: leaf as JsonValue };
}

/**
 * Write `value` at the leaf, creating ONLY absent intermediate objects along the
 * way (callers must have verified the path is not blocked).
 */
function writeJsonLeaf(
  root: Record<string, unknown>,
  segments: string[],
  value: JsonValue,
): void {
  let node: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const next = node[seg];
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      node[seg] = created;
      node = created;
    } else {
      node = next as Record<string, unknown>;
    }
  }
  node[segments[segments.length - 1]!] = value;
}

/**
 * Delete the leaf key only. Intermediate objects — even ones we created (the
 * `ui` wrapper) — are deliberately left in place (harmless; pruning risks
 * clobbering sibling keys the user set under `ui`).
 */
function deleteJsonLeaf(root: Record<string, unknown>, segments: string[]): void {
  let node: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const next = node[segments[i]!];
    if (next === null || typeof next !== "object" || Array.isArray(next)) return;
    node = next as Record<string, unknown>;
  }
  delete node[segments[segments.length - 1]!];
}

/**
 * Extract a stable session id from a Qwen wire payload. Unlike Claude (which
 * prefers the transcript UUID), Qwen Code surfaces `session_id` directly and
 * prioritizes it — matching context-mode's QwenCodeAdapter.extractSessionId.
 * Falls back to the transcript UUID, then "" (no ppid fabrication — the
 * normalized event uses "" when the host provides no id).
 */
function extractSessionId(input: QwenWireInput): string {
  if (typeof input.session_id === "string" && input.session_id !== "") {
    return input.session_id;
  }
  if (typeof input.transcript_path === "string") {
    const m = input.transcript_path.match(/([a-f0-9-]{36})\.jsonl$/);
    if (m && m[1]) return m[1];
  }
  return "";
}

/** Coerce a Qwen PostToolUse `tool_response` into a string for the normalized event. */
function toolResponseToString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const adapter = new QwenCodeAdapter();
export default adapter;
