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
 * Codex capabilities (upstream, verified against openai/codex source at the
 * stable release tags noted):
 *   - PreToolUse `updatedInput` rewrite IS honored (PR #20527, commit d08906a9,
 *     stable since codex 0.131.0; applied in the shell/mcp/apply_patch tool
 *     handlers, confirmed present through 0.141.0) — hence canModifyArgs is now
 *     TRUE. Codex's output_parser.rs requires the rewrite to be paired with
 *     `permissionDecision:"allow"` (an allow WITHOUT updatedInput, and an
 *     updatedInput WITHOUT allow, are both rejected as invalid), so "modify"
 *     emits the allow+updatedInput envelope together. The still-open tracking
 *     issue openai/codex#18491 is now scoped to a NARROWER gap — read_file/grep
 *     have no PreToolUse handler yet — not to updatedInput itself, which works
 *     for every tool that fires PreToolUse (shell/Bash, apply_patch, MCP).
 *   - PostToolUse `updatedMCPToolOutput` is still explicitly rejected as
 *     "unsupported" by output_parser.rs (no output-rewrite field on
 *     PostToolUseOutput at 0.141.0) — hence canModifyOutput stays FALSE.
 *
 * E1 extension events (verified against developers.openai.com/codex/hooks):
 *   - PermissionRequest — native, decision-capable via the nested
 *     hookSpecificOutput.decision{behavior:"allow"|"deny", message?} envelope.
 *     Codex docs: updatedInput / updatedPermissions / interrupt FAIL CLOSED on
 *     this event, so they are never emitted here.
 *   - SubagentStart — native; hookSpecificOutput.additionalContext is injected
 *     as developer context for the subagent (not blockable).
 *   - SubagentStop — native; the documented continuation shape is the TOP-LEVEL
 *     {"decision":"block","reason"} (Stop semantics: keeps the subagent going).
 *   - PostToolUseFailure — NO Codex analog (PostToolUse only); declared hooks
 *     for it warn-skip at install and the capability flag stays unset.
 *   - PostCompact — native (Codex's hook system fires both PreCompact and
 *     PostCompact); observe-only, normalizing the `trigger` (manual|auto)
 *     exactly like PreCompact, with a passthrough formatReply.
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
  SkillDef,
  SubagentDef,
} from "../../core/types.js";
import { ensureDir } from "../../core/paths.js";
import { codexConfigHome } from "../../core/host-paths.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  removeFromObjectMap,
  upsertInObjectMap,
  type ObjectMapCodec,
} from "../../core/object-map.js";
import { writeTomlString } from "../../core/toml.js";
import {
  buildHomeBinHookCommand,
  buildWrappedStdio,
} from "../../core/spawn.js";
import { renderCommandMd, renderSkillMd } from "../claude-code/render.js";
import { normalizeSessionSource } from "../claude-code/wire.js";
import { BaseAdapter, type HookMergeDescriptor } from "../base.js";
import type {
  HookReply,
  InstallContext,
  MemoryTarget,
  NormalizedEvent,
} from "../spi.js";

// ─────────────────────────────────────────────────────────────────────────
// Native shapes
// ─────────────────────────────────────────────────────────────────────────

/** Raw Codex hook payload (PascalCase event, snake_case fields — Claude-style). */
interface CodexHookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  // PostToolUse only. The host serializes this as serde_json::Value (any JSON):
  // a BARE STRING for shell/apply_patch (e.g. json!("shell output")) but an
  // OBJECT for MCP/structured tools (the serialized CallToolResult, e.g.
  // json!({content,structuredContent,isError})) — NOT always a string. Typed
  // `unknown` so PostToolUse coerces it for the string-typed toolOutput.
  // Primary source: openai/codex codex-rs/hooks/src/schema.rs PostToolUseCommandInput
  // `tool_response: Value` + core/src/tools/handlers/{mcp.rs object, shell_tests.rs string}.
  tool_response?: unknown;
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  prompt?: string;
  // NO is_error: Codex's PostToolUseCommandInput struct (#[serde(deny_unknown_fields)])
  // never serializes a top-level is_error — the error signal for MCP tools lives
  // INSIDE tool_response as the CallToolResult `isError`. The field was removed;
  // see derivePostToolUseIsError below. (openai/codex codex-rs/hooks/src/schema.rs:317-337)
  stop_hook_active?: boolean;
  trigger?: string;
  message?: string;
  // PostToolUseFailure-style failure field. Codex has NO failure event today;
  // parsed defensively only (the Claude-compatible wire would carry it).
  error?: string;
  // SubagentStart / SubagentStop (agent_type is the matcher subject).
  agent_id?: string;
  agent_type?: string;
  // SubagentStop only — the subagent's own transcript + final message.
  agent_transcript_path?: string;
  last_assistant_message?: string;
}

/** One hook entry inside hooks.json (Claude-compatible). */
interface CodexHookEntry {
  matcher?: string;
  hooks: Array<{ type: "command"; command: string }>;
}

/** Rendered `[mcp_servers.<id>]` table — string env table, no interpolation. */
interface CodexMcpEntry {
  // stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // streamable HTTP transport (remote): codex infers the transport from `url`
  // (no explicit transport key). Verified against codex-cli 0.139.0.
  url?: string;
  bearer_token_env_var?: string;
  http_headers?: Record<string, string>;
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
  "PermissionRequest",
  "SubagentStart",
  "SubagentStop",
  "PostCompact",
] as const;

type CodexHookEventName = (typeof CODEX_HOOK_EVENTS)[number];

/**
 * Newer E1 canonical events with NO Codex analog: Codex ships PostToolUse only —
 * there is no failure event on the live hooks page. Declared hooks for these
 * warn-skip (action `warn`, exit-1) — the established convention. The legacy
 * SessionEnd / Notification, which Codex also cannot fire, are reported as a
 * VISIBLE `skip` instead (exit-0 preserving) — see the hook descriptor's
 * `unmappedAction`. Nothing Codex cannot fire is ever silently dropped.
 */
const WARN_SKIP_EVENTS: ReadonlySet<HookEventName> = new Set(["PostToolUseFailure"]);

/**
 * PreToolUse matcher — canonical Codex tool names + bare MCP tool names +
 * external MCP catch-all literal. Charset-clean ([A-Za-z0-9_|] only) so Codex's
 * Rust `regex` exact-matcher short-circuits (no look-around, which Codex
 * rejects at boot). Copied from context-mode's proven matcher.
 */
const PRE_TOOL_USE_MATCHER =
  "local_shell|shell|shell_command|exec_command|Bash|Shell|apply_patch|Edit|Write|grep_files|mcp__";

/**
 * Coerce Codex's PostToolUse `tool_response` (serde_json::Value — bare string
 * for shell/apply_patch, OBJECT for MCP/structured tools) to a string for the
 * string-typed `toolOutput`. A string passes through verbatim; everything else
 * (object/array/number/bool) is JSON-stringified; undefined/null → undefined
 * (leave `toolOutput` unset).
 *
 * Source: openai/codex codex-rs/hooks/src/schema.rs PostToolUseCommandInput
 * `tool_response: Value`; core/src/tools/handlers/shell_tests.rs emits
 * `json!("shell output")` (string), mcp.rs emits `json!({...})` (object).
 */
function coerceToolResponse(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Derive PostToolUse `isError`. Codex's PostToolUseCommandInput
 * (`#[serde(deny_unknown_fields)]`) has NO top-level is_error field, so the only
 * machine-readable error signal is the MCP CallToolResult `isError` nested in
 * the `tool_response` object (serialized camelCase by rmcp). For shell/
 * apply_patch tool_response is a bare string carrying no boolean, so we report
 * false. Returns false when no such signal exists (never invents one).
 *
 * Source: openai/codex codex-rs/hooks/src/schema.rs:317-337 (no is_error field);
 * codex-rs/core/src/tools/handlers/mcp.rs (tool_response = serialized
 * CallToolResult → `isError` when the MCP call failed).
 */
function derivePostToolUseIsError(toolResponse: unknown): boolean {
  if (toolResponse !== null && typeof toolResponse === "object") {
    const flag = (toolResponse as Record<string, unknown>).isError;
    if (typeof flag === "boolean") return flag;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────

export class CodexAdapter extends BaseAdapter {
  readonly id: PlatformId = "codex";
  readonly name = "Codex CLI";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    // Memory surface: AGENTS.md-first managed block. memoryTargets below probes
    // AGENTS.override.md first (it shadows AGENTS.md per directory on codex).
    supportsMemory: true,
    preToolUse: true,
    postToolUse: true,
    preCompact: true,
    sessionStart: true,
    sessionEnd: false,
    userPromptSubmit: true,
    stop: true,
    notification: false,
    // E1 events: PermissionRequest (decision-capable) + SubagentStart/Stop are
    // Codex-native. postToolUseFailure stays unset — Codex has no failure event,
    // so a declared hook for it warn-skips at install.
    permissionRequest: true,
    subagentStart: true,
    subagentStop: true,
    // PostCompact: Codex's hook system fires both PreCompact and PostCompact
    // (developers.openai.com/codex/hooks). Observational only — the reply
    // contract mirrors PreCompact (cannot block/modify a completed compaction).
    postCompact: true,
    // PreToolUse updatedInput rewrite is honored upstream (paired with
    // permissionDecision:"allow"); PostToolUse output rewrite is not (see header).
    canModifyArgs: true,
    canModifyOutput: false,
    canInjectSessionContext: true,
    transports: ["stdio", "http"],
    // Content surfaces: Codex implements all three.
    //   command  → ~/.codex/prompts/<name>.md   (md+frontmatter, USER SCOPE ONLY)
    //   skill    → project: .codex/skills/<name>/SKILL.md · user: ~/.agents/skills/<name>/SKILL.md
    //   subagent → <codexDir>/agents/<name>.toml (TOML)
    supportsCommands: true,
    supportsSkills: true,
    supportsSubagents: true,
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

  // ── Memory surface: AGENTS.override.md probe + 32 KiB doc-cap budget ─────
  // Codex reads AGENTS.override.md > AGENTS.md per directory (one file per
  // directory), so when the override file exists OUR block must live there or
  // it is never loaded. Combined project docs are capped at 32 KiB
  // (`project_doc_max_bytes`), hence the ~28 KiB per-file budget warn.
  protected override memoryTargets(ctx: InstallContext): MemoryTarget[] {
    // An explicit path override keeps the base resolution (escape hatch wins).
    if (this.memoryOverride(ctx)?.path) return super.memoryTargets(ctx);
    if (ctx.scope !== "project" && ctx.scope !== "user") return [];
    const budgetBytes = 28 * 1024;
    const dir = ctx.scope === "project" ? ctx.projectDir : this.userConfigDir();
    const overrideMd = join(dir, "AGENTS.override.md");
    if (existsSync(overrideMd)) {
      return [
        {
          path: overrideMd,
          reason: "AGENTS.override.md shadows AGENTS.md on codex (one doc per directory)",
          budgetBytes,
        },
      ];
    }
    return [
      {
        path: join(dir, "AGENTS.md"),
        reason:
          ctx.scope === "project"
            ? "AGENTS.md standard (project root; codex is the format's originator)"
            : "codex global guidance ($CODEX_HOME/AGENTS.md)",
        budgetBytes,
      },
    ];
  }

  /** `$CODEX_HOME` (tilde-expanded, then resolved) || `~/.codex` for user
   *  scope. Shared with marketplace detection via `codexConfigHome` so the
   *  config writer and the install probe never target different dirs. */
  private userConfigDir(): string {
    return codexConfigHome();
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

  /** An ObjectMapCodec over config.toml for the core/object-map engine.
   * `isPresentButUnparseable` is `() => false`: readToml fail-softs to {} and the
   * server path has historically coerced/overwritten rather than warn-skip on an
   * unparseable file — preserved here for byte-identical behavior. */
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
      // Codex config.toml [mcp_servers] supports stdio (command) + streamable
      // HTTP (url). Other remote transports (sse/ws) have no codex analog.
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
        rootKey: "mcp_servers",
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
        rootKey: "mcp_servers",
        policy: "coerce",
        platform: this.id,
        configPath: path,
        entryId: connector.id,
        dryRun,
      }),
    ];
  }

  // ── Install hooks (hooks.json) ──────────────────────────────────────────

  override installHooks(ctx: InstallContext): ChangeRecord[] {
    const path = this.getHookConfigPath(ctx);
    const hooksOff = ctx.connector.platforms[this.id]?.hooks === false;
    const declared = hooksOff ? [] : ctx.connector.hookEvents;

    if (declared.length === 0) {
      return [{ platform: this.id, action: "skip", path, detail: "no hooks declared" }];
    }

    // HOST-ORDERED pending: the unsupported events (mapEvent → undefined →
    // warn/skip via the descriptor) FIRST, then the supported events in
    // CODEX_HOOK_EVENTS order. EVERY declared event is enqueued — an event with
    // no Codex analog is reported VISIBLY (warn for the E1 newer events, a `skip`
    // for the legacy SessionEnd/Notification whose drop predates the convention),
    // never silently dropped. matcher is "" for every item; renderEntry derives
    // the real matcher from the event (PreToolUse/PermissionRequest).
    const supported = (e: HookEventName) =>
      (CODEX_HOOK_EVENTS as readonly string[]).includes(e);
    const pending = [
      ...declared.filter((e) => !supported(e)).map((event) => ({ event: event as string, matcher: "" })),
      ...declared.filter(supported).map((event) => ({ event: event as string, matcher: "" })),
    ];
    return this.upsertHookEntries(ctx, path, pending, this.hookDescriptor(ctx));
  }

  override uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    return this.removeHookEntries(ctx, this.getHookConfigPath(ctx), this.hookDescriptor(ctx));
  }

  /**
   * Codex hook-merge policy for the shared object-map engine. EVENT-SPECIFIC by
   * construction: every observable (coerce root + bucket, the path-normalized
   * per-event ownership find, the event-derived matcher with `hooks`-then-
   * `matcher` key order, the BARE `hooks.<event>` skip/remove details with NO
   * count, the warn wording, and the absent/no-match skips) is carried here so
   * the engine reproduces the prior in-adapter loop byte-for-byte.
   */
  private hookDescriptor(_ctx: InstallContext): HookMergeDescriptor<CodexHookEntry> {
    return {
      // Codex's server path coerces a malformed root; the hook path matches it.
      malformedPolicy: "coerce",
      // Supported event → identity; any other canonical event → undefined → the
      // engine reports it (never silent), at the severity unmappedAction picks.
      mapEvent: (e) =>
        (CODEX_HOOK_EVENTS as readonly string[]).includes(e) ? e : undefined,
      unmappedWarnDetail: (e) => `${e} has no Codex hook equivalent — skipped`,
      // E1 newer events (PostToolUseFailure) keep the established `warn` (exit-1);
      // the legacy SessionEnd / Notification — silently dropped before this fix —
      // become a VISIBLE `skip` so the install exit code is unchanged for them.
      unmappedAction: (e) =>
        WARN_SKIP_EVENTS.has(e as HookEventName) ? "warn" : "skip",
      renderEntry: (event, _matcher, command) => {
        const entry: CodexHookEntry = { hooks: [{ type: "command", command }] };
        // KEY ORDER: hooks THEN matcher. Matcher is EVENT-derived, not from the
        // connector's declared matcher: PermissionRequest matches tool names like
        // PreToolUse (charset-clean), everything else registers "" (all).
        entry.matcher =
          event === "PreToolUse" || event === "PermissionRequest" ? PRE_TOOL_USE_MATCHER : "";
        return entry;
      },
      // Idempotency find for the CANONICAL event the engine built `command` from —
      // path-normalized, exact-command, the body of isOurEntry's command check.
      entryOwnsCommand: (entry, command) =>
        Array.isArray(entry.hooks) &&
        entry.hooks.some(
          (h) => (h.command ?? "").replace(/\\/g, "/") === command.replace(/\\/g, "/"),
        ),
      // FLAT whole-entry removal, EVENT-SPECIFIC: isOurEntry rebuilds our command
      // from the event key being stripped, so a SubagentStop entry is never matched
      // while iterating the PreToolUse bucket.
      ownsEntryForRemove: (c, event) => (entry) =>
        this.isOurEntry(c, event as CodexHookEventName, entry),
      skipDetail: (e) => `hooks.${e}`,
      removeDetail: (e, _n) => `hooks.${e}`,
      absentDetail: "no hooks.json",
      noMatchDetail: "no agent-connector hooks present",
      // Uninstall scans EXACTLY codex's fixed event set (not Object.keys), so a
      // home-bin command hand-placed under a foreign event key is left untouched —
      // byte-identical to the prior `for (const event of CODEX_HOOK_EVENTS)` loop.
      removeEventKeys: CODEX_HOOK_EVENTS,
    };
  }

  // ── Health checks (default doctor renders these) ────────────────────────

  override getHealthChecks(ctx: InstallContext): readonly HealthCheck[] {
    const path = this.getServerConfigPath(ctx);
    const id = ctx.connector.id;
    const checks: HealthCheck[] = [
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
          // Only assert what the connector declares (same rule as the
          // content-surface checks below): a server-less connector — e.g. a
          // catalog-only bundle of agents/skills/commands — never writes an
          // [mcp_servers.<id>] table, so its absence is healthy.
          if (!ctx.connector.server) {
            return { status: "OK", detail: "no MCP server declared" };
          }
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

    // Content-surface checks: assert presence only for surfaces this connector
    // declares. Codex commands are user-scope only, so a project-scope install
    // won't have written them — only check command files in user scope.
    if (ctx.scope !== "project") {
      for (const cmd of ctx.connector.commands) {
        const p = this.commandPath(cmd.name);
        checks.push({
          name: `${this.name}: command ${cmd.name} present`,
          check: () =>
            existsSync(p) ? { status: "OK", detail: p } : { status: "FAIL", detail: `not found: ${p}` },
        });
      }
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
    return checks;
  }

  // ── Content surfaces: commands / skills / subagents ──────────────────────
  // CONTENT-ONLY: pure native-file writers. No runtime dispatch, no home-bin
  // pointer, no telemetry wrap. Each method is idempotent (byte-identical →
  // skip) via writeContentFile and reversible via removeContentFile. Honors
  // platforms["codex"] per-surface false to skip.
  //
  // Native locations:
  //   command  → ~/.codex/prompts/<name>.md   md+frontmatter(description,argument-hint)
  //              USER SCOPE ONLY — project scope yields a single "warn".
  //   skill    → project: <projectDir>/.codex/skills/<name>/SKILL.md (+ resources)
  //              user:    ~/.agents/skills/<name>/SKILL.md (~/.codex/skills is deprecated)
  //   subagent → <codexDir>/agents/<name>.toml  TOML via writeTomlString

  /** Command files always live under the USER codex dir: ~/.codex/prompts. */
  private commandPath(name: string): string {
    return join(this.userConfigDir(), "prompts", `${name}.md`);
  }
  private skillDir(ctx: InstallContext, name: string): string {
    // Project scope: <projectDir>/.codex/skills/<name> — the Project config-layer
    // skills root (codex-rs/core-skills/src/loader.rs, ConfigLayerSource::Project),
    // NOT deprecated. User scope: $HOME/.agents/skills/<name> — codex's CURRENT
    // user skills root. The older $CODEX_HOME/skills (~/.codex/skills) is still
    // read but the loader labels it a "Deprecated user skills location, kept for
    // backward compatibility". .agents is anchored to the OS home (home_dir), NOT
    // $CODEX_HOME — so use homedir() here, never userConfigDir() (which honors
    // CODEX_HOME).
    if (ctx.scope === "project") return join(this.getConfigDir(ctx), "skills", name);
    return join(homedir(), ".agents", "skills", name);
  }
  private subagentPath(ctx: InstallContext, name: string): string {
    return join(this.getConfigDir(ctx), "agents", `${name}.toml`);
  }

  // ── Commands (USER SCOPE ONLY) ───────────────────────────────────────────

  override installCommands(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[this.id]?.commands === false) {
      return [{ platform: this.id, action: "skip", detail: "commands disabled for codex" }];
    }
    if (ctx.scope === "project") {
      return [{ platform: this.id, action: "warn", detail: "codex commands are user-scope only" }];
    }
    if (connector.commands.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no commands" }];
    }
    return connector.commands.map((cmd) =>
      this.writeContentFile(
        this.commandPath(cmd.name),
        renderCommandMd(cmd, { includeToolsAndModel: false }),
        ctx.dryRun,
      ),
    );
  }

  override uninstallCommands(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (ctx.scope === "project") {
      return [{ platform: this.id, action: "warn", detail: "codex commands are user-scope only" }];
    }
    if (connector.commands.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no commands" }];
    }
    return connector.commands.map((cmd) =>
      this.removeContentFile(this.commandPath(cmd.name), ctx.dryRun),
    );
  }

  // ── Skills ───────────────────────────────────────────────────────────────

  override installSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[this.id]?.skills === false) {
      return [{ platform: this.id, action: "skip", detail: "skills disabled for codex" }];
    }
    if (connector.skills.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no skills" }];
    }
    const changes: ChangeRecord[] = [];
    for (const skill of connector.skills) {
      const dir = this.skillDir(ctx, skill.name);
      const rendered = renderSkillMd(skill);
      changes.push(this.writeContentFile(join(dir, "SKILL.md"), rendered, ctx.dryRun));
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
      // Migrate away an AC-owned copy at the deprecated user skills root so the
      // skill is not double-registered after the move to ~/.agents/skills.
      changes.push(...this.migrateDeprecatedUserSkill(ctx, skill, rendered));
    }
    return changes;
  }

  /**
   * One-time, opt-out-safe migration: prior AC versions wrote user-scope skills
   * to the now-deprecated $CODEX_HOME/skills/<name> root, which codex STILL reads
   * (kept for backward compatibility). Once we write the same skill to the current
   * ~/.agents/skills root, codex would register it TWICE (same frontmatter name,
   * two User-scope roots). If a SKILL.md exists at the deprecated path AND is
   * byte-identical to what we render — i.e. AC-owned, not hand-authored — remove
   * it (and its now-empty dir). The content-equality guard guarantees we never
   * delete a skill a user placed there by hand. No-op for project scope (where
   * .codex/skills is the valid, non-deprecated Project config-layer path) and when
   * a custom CODEX_HOME would make the deprecated path coincide with the new one.
   */
  private migrateDeprecatedUserSkill(
    ctx: InstallContext,
    skill: SkillDef,
    rendered: string,
  ): ChangeRecord[] {
    if (ctx.scope === "project") return [];
    const deprecated = join(this.userConfigDir(), "skills", skill.name, "SKILL.md");
    // Never touch the file we just wrote (pathological CODEX_HOME === ~/.agents).
    if (deprecated === join(this.skillDir(ctx, skill.name), "SKILL.md")) return [];
    if (!existsSync(deprecated)) return [];
    if (readFileSync(deprecated, "utf8") !== rendered) return []; // hand-authored — leave it
    return [
      this.removeContentFile(deprecated, ctx.dryRun),
      this.removeDirIfEmpty(dirname(deprecated), ctx.dryRun),
    ];
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

  // ── Subagents (TOML) ─────────────────────────────────────────────────────

  override installSubagents(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[this.id]?.subagents === false) {
      return [{ platform: this.id, action: "skip", detail: "subagents disabled for codex" }];
    }
    if (connector.subagents.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no subagents" }];
    }
    return connector.subagents.map((agent) =>
      this.writeContentFile(this.subagentPath(ctx, agent.name), this.renderSubagent(agent), ctx.dryRun),
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

  /**
   * Render a subagent to a Codex agent TOML file:
   *   { name, description, developer_instructions: prompt, model }.
   * model is omitted when undefined so Codex applies its default.
   *
   * Codex custom agent files are config layers, not a closed four-field
   * manifest. The Codex manual documents required custom-agent keys, plus
   * optional config keys such as nickname_candidates, model_reasoning_effort,
   * sandbox_mode, mcp_servers, and skills.config. Keep `extra` as the
   * author-controlled escape hatch for that native surface.
   */
  private renderSubagent(agent: SubagentDef): string {
    const table: Record<string, unknown> = {
      name: agent.name,
      description: agent.description,
      developer_instructions: agent.prompt,
    };
    if (agent.model !== undefined) table.model = agent.model;
    if (agent.extra) Object.assign(table, agent.extra);
    return writeTomlString(table);
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
          // tool_response is a bare string for shell/apply_patch but an OBJECT
          // for MCP tools — coerce non-strings to JSON so the string-typed
          // toolOutput never receives a raw object.
          toolOutput: coerceToolResponse(input.tool_response),
          // Codex never serializes a top-level is_error (deny_unknown_fields);
          // the true error signal is the CallToolResult.isError nested inside
          // tool_response for MCP tools. Derive it from there.
          isError: derivePostToolUseIsError(input.tool_response),
        };
      case "SessionStart":
        return { ...base, source: normalizeSessionSource(input.source) };
      case "SessionEnd":
        return { ...base, reason: input.message };
      case "UserPromptSubmit":
        return { ...base, prompt: input.prompt ?? "" };
      case "PreCompact":
        return { ...base, trigger: input.trigger === "manual" ? "manual" : "auto" };
      case "PostCompact":
        // Post-compaction sibling of PreCompact — same `trigger` normalization
        // (manual|auto), observe-only. Codex's PostCompact payload mirrors
        // PreCompact's; everything else rides on `raw`.
        return { ...base, trigger: input.trigger === "manual" ? "manual" : "auto" };
      case "Stop":
        return { ...base, stopHookActive: input.stop_hook_active ?? false };
      case "Notification":
        return { ...base, message: input.message ?? "" };
      case "PermissionRequest":
        // Codex documents tool_name/tool_input (+tool_input.description); it has
        // no permission_suggestions field, so the normalized optional stays unset.
        return {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
        };
      case "PostToolUseFailure":
        // No Codex analog — never fired natively. Parsed defensively (Claude-
        // compatible wire) so a manual `hook codex PostToolUseFailure` invocation
        // still normalizes instead of throwing.
        return {
          ...base,
          toolName: input.tool_name ?? "",
          toolInput: input.tool_input ?? {},
          error: input.error ?? "",
        };
      case "SubagentStart":
        return {
          ...base,
          ...(typeof input.agent_id === "string" ? { agentId: input.agent_id } : {}),
          ...(typeof input.agent_type === "string" ? { agentType: input.agent_type } : {}),
        };
      case "SubagentStop":
        // agent_id/agent_type stay optional — never depend on hosts populating
        // them on stop (the Claude-family SDK quirk).
        return {
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
    }
  }

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    // Codex (like Claude Code) reads a `hookSpecificOutput` JSON wrapper from
    // stdout; exit code 0 = allow. Fields the host cannot honor are dropped.

    // PermissionRequest uses Codex's nested decision{behavior} envelope and is
    // the ONE event where an EXPLICIT "allow" is an ACTIVE grant (suppresses the
    // approval prompt). ask/context/void → NO decision output: fall through to
    // the normal approval flow (the prompt IS the ask). Codex docs: updatedInput
    // / updatedPermissions / interrupt FAIL CLOSED on this event, so "modify"
    // also falls through — emitting a bare allow would grant the ORIGINAL input
    // the handler wanted rewritten.
    if (event === "PermissionRequest") {
      if (response.decision === "deny") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PermissionRequest",
              decision: {
                behavior: "deny",
                message: response.reason ?? "Blocked by hook",
              },
            },
          }),
        };
      }
      if (response.decision === "allow") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PermissionRequest",
              decision: { behavior: "allow" },
            },
          }),
        };
      }
      return { exitCode: 0 };
    }

    // SubagentStart is observe/context-only on Codex (continue:false is parsed
    // but does not stop the subagent): "context" injects additionalContext as
    // developer context for the SUBAGENT, and a "deny" DEGRADES to the same
    // shape carrying the reason.
    if (event === "SubagentStart") {
      const context =
        response.decision === "context"
          ? response.additionalContext
          : response.decision === "deny"
            ? response.reason ?? response.additionalContext
            : undefined;
      if (context) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "SubagentStart",
              additionalContext: context,
            },
          }),
        };
      }
      return { exitCode: 0 };
    }

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
      // SubagentStop deny = Stop semantics: the documented continuation shape is
      // the TOP-LEVEL {"decision":"block","reason"} (keeps the subagent going
      // with `reason` as its next instruction).
      if (event === "SubagentStop") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            decision: "block",
            reason: response.reason ?? "Blocked by hook",
          }),
        };
      }
      return { exitCode: 0 };
    }

    // modify → rewrite PreToolUse tool input. Codex applies `updatedInput`
    // (PR #20527, stable since 0.131.0) but its output_parser.rs only accepts it
    // when paired with permissionDecision:"allow" — emitting updatedInput alone
    // (the Claude Code shape) is rejected as "updatedInput without
    // permissionDecision:allow", and an allow alone is rejected too, so the pair
    // is emitted together. Other events fail open (no updatedInput surface).
    if (response.decision === "modify") {
      if (event === "PreToolUse" && response.updatedInput) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              updatedInput: response.updatedInput,
            },
          }),
        };
      }
      return { exitCode: 0 };
    }

    // Context injection: honored on SessionStart, PostToolUse, and PreToolUse
    // (additionalContext — PreToolUse support shipped via PR #20692, stable since
    // codex 0.130.0; injected independent of any permission decision).
    // (SubagentStop accepts only the common output fields — no additionalContext.)
    if (
      response.additionalContext &&
      (event === "SessionStart" || event === "PostToolUse" || event === "PreToolUse")
    ) {
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

    // "allow" / unsupported-on-Codex (ask) → passthrough.
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

  /**
   * Render the `[mcp_servers.<id>]` table. TOML has NO interpolation, so every
   * `${env:VAR}` is resolved to a literal at install time. The env table is a
   * plain string→string map. Honors the telemetry serve-wrapper.
   */
  private renderMcpEntry(ctx: InstallContext, server: ServerDef): CodexMcpEntry {
    // Streamable HTTP server: codex infers the transport from `url` (no explicit
    // transport key). VERIFIED against codex-cli 0.139.0 — `codex mcp add <id>
    // --url <U> --bearer-token-env-var <E>` writes:
    //   [mcp_servers.<id>]
    //   url = "…"
    //   bearer_token_env_var = "…"   (only with bearerEnv auth)
    // Telemetry serve-wrapping is stdio-only (remote cannot be intercepted).
    // installServer's guard only lets stdio+command or http+url reach here, so
    // this branch is exactly the streamable-HTTP case (lock-step with the guard).
    if (server.transport === "http") {
      const remote: CodexMcpEntry = { url: resolveEnvRefsDeep(server.url ?? "") };
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

  /**
   * Does this hooks.json entry belong to this connector for `event`? EVENT-
   * SPECIFIC + path-normalized exact-command match. The engine binds this per
   * event in the uninstall (whole-entry FLAT removal) and the install idempotency
   * find reuses its command body via the descriptor's entryOwnsCommand.
   */
  private isOurEntry(ctx: InstallContext, event: CodexHookEventName, entry: CodexHookEntry): boolean {
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) return false;
    const ours = buildHomeBinHookCommand(ctx.homeBinPath, "codex", event, ctx.connector.id);
    const needle = ours.replace(/\\/g, "/");
    return entry.hooks.some((h) => (h.command ?? "").replace(/\\/g, "/") === needle);
  }
}

export const adapter = new CodexAdapter();
export default adapter;
