/**
 * adapters/grok-build — Grok Build (xAI's official coding agent CLI) adapter.
 *
 * Grok Build is xai-org/grok-build (Apache-2.0): a Rust agent harness + TUI,
 * binary artifact `xai-grok-pager`, shipped by official installs as `grok`.
 * DISAMBIGUATION: this is NOT the community `superagent-ai/grok-cli` behind our
 * adapter id `grok-cli` — different vendor, different product, different config
 * file. The two happen to share the DEFAULT directory `~/.grok` but never a
 * file (see the detection note below), which is why both adapters key detection
 * on their own exclusive marker.
 *
 * Every fact below is byte-confirmed against the upstream repo (primary source),
 * not inferred:
 *   - user guide  crates/codegen/xai-grok-pager/docs/user-guide/*.md
 *   - hook schema crates/codegen/xai-grok-hooks/src/event.rs
 *
 * Paradigm: "json-stdio" — the host pipes a JSON event to a command on stdin and
 * reads JSON / an exit code back.
 *
 * NATIVE CONFIG SURFACES
 *   1. MCP — `$GROK_HOME/config.toml` (default `~/.grok/config.toml`), TOML,
 *      under `[mcp_servers.<name>]`. stdio keys { command, args, env, enabled,
 *      startup_timeout_sec, tool_timeout_sec }; remote keys { url, headers }.
 *      Project scope is `<projectDir>/.grok/config.toml`, which contributes
 *      EXACTLY `[mcp_servers]`, `[plugins]`, `[permission]` and
 *      `[mcp] max_output_bytes` — every other table is read from the user file
 *      only (07-mcp-servers.md, 26-config-reference.md:22,32).
 *      TOML has no interpolation → env-refs resolve to literals at install time.
 *   2. Hooks — `$GROK_HOME/hooks/*.json` (user, "Always" trusted) and
 *      `<project>/.grok/hooks/*.json` (requires folder trust). The file body is
 *      the Claude-compatible object: { hooks: { <Event>: [ { matcher?, hooks:
 *      [ { type:"command", command, timeout? } ] } ] } } (10-hooks.md §Hook
 *      Locations + §The Hook JSON Format). We write our OWN file rather than
 *      merging into the user's config.toml `[[hooks.<Event>]]` block: the hooks
 *      directory is purpose-built for exactly this, and an isolated file keeps
 *      install/uninstall from ever rewriting hand-authored config.
 *   3. Skills — `<scope>/.grok/skills/<name>/SKILL.md`, Anthropic-format YAML
 *      frontmatter (`name`, `description` + optional model/allowed-tools/...).
 *   4. Commands — `<scope>/.grok/commands/<name>.md`, FLAT markdown files whose
 *      filename stem is the slash-command name ("matching Claude Code's legacy
 *      custom-command layout", 08-skills.md).
 *   5. Subagents — `<scope>/.grok/agents/<name>.md`, md + YAML frontmatter
 *      (name, description, tools, model — 16-subagents.md).
 *   6. Memory — AGENTS.md. 12-project-rules.md is titled "Project Rules
 *      (AGENTS.md)": Grok loads AGENTS.md from the repo root down to the cwd,
 *      deeper files winning. User scope uses `$GROK_HOME/rules/*.md` ("Always
 *      scanned; applies to all projects").
 *
 * DETECTION / THE ~/.grok COLLISION
 * `grok-cli` (community) stores everything in `~/.grok/user-settings.json`;
 * Grok Build stores everything under `$GROK_HOME` with `config.toml` as its
 * user config. Detecting either on the bare DIRECTORY would misreport the other
 * as installed, so each adapter claims the dir only when the sibling's
 * exclusive marker is absent (the same bow-out hardening the openclaw/nemoclaw
 * pair uses). Marker files: Grok Build `config.toml`, Grok CLI
 * `user-settings.json`.
 *
 * HOOK EVENTS (crates/codegen/xai-grok-hooks/src/event.rs, HookEventName)
 * Grok fires PascalCase names 1:1 with ours for twelve of the thirteen canonical
 * events: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse,
 * PostToolUseFailure, Stop, Notification, SubagentStart, SubagentStop,
 * PreCompact, PostCompact. It ALSO fires StopFailure / StopCancelled /
 * PermissionDenied, which have no canonical analog and ride the nativeHooks
 * escape hatch.
 *
 * PermissionRequest has NO Grok analog and the capability flag stays UNSET.
 * Grok's nearest event, `PermissionDenied`, fires AFTER the permission system
 * has already denied a call and is documented "Blocking? No" — it is an
 * observation of a completed denial, not the decision-capable pre-dialog gate
 * our PermissionRequest contract requires. A declared PermissionRequest hook
 * therefore warn-skips at install rather than being silently mis-registered.
 *
 * WIRE SHAPE (event.rs HookEventEnvelope, `#[serde(rename_all = "camelCase")]`)
 * Common fields: hookEventName, sessionId, cwd, workspaceRoot, timestamp,
 * transcriptPath?, clientIdentifier?, promptId?, permissionMode?, plus the
 * flattened per-event payload. `to_hook_json` then adds ADDITIVE snake_case
 * aliases (sessionId→session_id, toolName→tool_name, toolInput→tool_input,
 * toolResult→tool_response, toolUseId→tool_use_id, durationMs→duration_ms,
 * isInterrupt→is_interrupt) and overwrites `hook_event_name` with the PascalCase
 * name. Both spellings are present on the wire; parseEvent reads the camelCase
 * key first (authoritative) and falls back to the snake alias.
 *
 * Two payload fields are FALSE FRIENDS and are the reason this adapter is
 * source-verified rather than docs-verified:
 *   - PostToolUse carries `toolResult` (NOT `tool_response`/`toolOutput`).
 *   - PreCompact / PostCompact carry **`source`**, NOT `trigger` — the prose
 *     calls it "the compaction trigger" but the struct field is `source`.
 * PostToolUse has NO is_error field at all: a tool that fails to dispatch, or an
 * MCP error result, fires PostToolUseFailure instead, so isError is reported
 * false for every PostToolUse (never invented).
 *
 * REPLY PROTOCOL (10-hooks.md §Output (Blocking Hooks), §PostToolUse Output,
 * §Stop Decision Control, §Passive Hooks)
 *   - PreToolUse: `hookSpecificOutput.permissionDecision` is the CANONICAL
 *     decision key (allow|deny|ask|defer) with `permissionDecisionReason`;
 *     `updatedInput` rewrites the call and, unlike Codex, needs NO paired allow
 *     ("Omitting `decision` while returning `updatedInput` allows the call and
 *     applies the rewrite"). `additionalContext` is honored. `ask` is native.
 *   - PostToolUse: `{decision:"block",reason}` feeds the model, and
 *     `hookSpecificOutput.updatedToolOutput` REPLACES the model's copy of the
 *     result ("Universal key; works for every tool") → canModifyOutput = true.
 *   - Stop / SubagentStop: `{decision:"block",reason}` keeps the agent working;
 *     `hookSpecificOutput.additionalContext` is non-error feedback.
 *   - UserPromptSubmit: `{decision:"block",reason}` blocks the prompt. Context
 *     injection is NOT available — "stdout of an allowing hook is discarded (no
 *     `additionalContext`)".
 *   - SessionStart / Notification / PreCompact / PostCompact / SubagentStart:
 *     "stdout is ignored. Just exit 0." → canInjectSessionContext = false, and
 *     these format to a bare exit-0 passthrough.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  SubagentDef,
} from "../../core/types.js";
import { ensureDir } from "../../core/paths.js";
import { grokBuildConfigHome } from "../../core/host-paths.js";
import { resolveEnvRefsDeep } from "../../core/interpolate.js";
import {
  removeFromObjectMap,
  upsertInObjectMap,
  type ObjectMapCodec,
} from "../../core/object-map.js";
import {
  buildHomeBinHookCommand,
  buildWrappedStdio,
} from "../../core/spawn.js";
import {
  renderCommandMd,
  renderSkillMd,
  renderSubagentMd,
} from "../claude-code/render.js";
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

/**
 * Raw Grok Build hook payload. camelCase is authoritative (the serde envelope);
 * the snake_case twins are the ADDITIVE aliases `to_hook_json` injects, so both
 * are present on the wire and every read prefers the camel key.
 */
interface GrokBuildHookInput {
  // Envelope (camelCase authoritative, snake alias where one exists).
  sessionId?: string;
  session_id?: string;
  cwd?: string;
  workspaceRoot?: string;
  // Tool events.
  toolName?: string;
  tool_name?: string;
  toolInput?: Record<string, unknown>;
  tool_input?: Record<string, unknown>;
  toolUseId?: string;
  tool_use_id?: string;
  /** PostToolUse ONLY. Named `toolResult` upstream (aliased to `tool_response`). */
  toolResult?: unknown;
  tool_response?: unknown;
  durationMs?: number;
  duration_ms?: number;
  isInterrupt?: boolean;
  is_interrupt?: boolean;
  /** PostToolUseFailure ONLY — the captured failure message. */
  error?: string;
  // SessionStart (source) / SessionEnd + Stop (reason).
  source?: string;
  reason?: string;
  // UserPromptSubmit.
  prompt?: string;
  // Stop / SubagentStop.
  stopHookActive?: boolean;
  lastAssistantMessage?: string;
  // Notification.
  notificationType?: string;
  message?: string;
  // SubagentStart / SubagentStop.
  subagentId?: string;
  subagentType?: string;
}

/** One hook entry inside a hooks/*.json file (Claude-compatible shape). */
interface GrokBuildHookEntry {
  matcher?: string;
  hooks: Array<{ type: "command"; command: string }>;
}

/** Rendered `[mcp_servers.<id>]` table (TOML — no native interpolation). */
interface GrokBuildMcpEntry {
  // stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // remote transports: Grok infers HTTP/SSE from `url` (no transport key in the
  // TOML — `grok mcp add --transport http|sse` writes `url` either way).
  url?: string;
  headers?: Record<string, string>;
  /** Written only when the connector explicitly disables the server. */
  enabled?: boolean;
}

/**
 * The canonical events Grok Build fires natively, in the order they are written
 * into our hooks file. Every name is PascalCase and 1:1 with ours (verified in
 * event.rs `HookEventName`).
 */
const GROK_BUILD_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
] as const;

type GrokBuildHookEventName = (typeof GROK_BUILD_HOOK_EVENTS)[number];

/**
 * PreToolUse matcher — Grok's OWN tool names plus the Claude aliases Grok maps
 * onto them ("A matcher keeps its original name too", 10-hooks.md §Tool Name
 * Aliases: Bash→run_terminal_command, Read→read_file, Edit/Write/MultiEdit→
 * search_replace, Task→spawn_subagent). Charset-clean ([A-Za-z0-9_|] only) so
 * the host's Rust `regex` matcher needs no look-around.
 *
 * MCP tool calls are deliberately NOT matched: Grok surfaces them through the
 * internal `use_tool` dispatcher under the qualified `server__tool` name (e.g.
 * `linear__save_issue`) with NO stable `mcp__` prefix to catch, so there is no
 * charset-clean literal that matches "any MCP tool" without also matching
 * unrelated built-ins.
 */
const PRE_TOOL_USE_MATCHER =
  "run_terminal_command|Bash|search_replace|Edit|Write|MultiEdit|apply_patch|spawn_subagent|Task";

/**
 * The single canonical event Grok Build cannot fire. Grok's `PermissionDenied`
 * is a passive post-denial observation, not our decision-capable pre-dialog
 * gate, so a declared PermissionRequest hook warn-skips (exit-1) at install —
 * the established convention for a newer event with no host analog.
 */
const WARN_SKIP_EVENTS: ReadonlySet<HookEventName> = new Set(["PermissionRequest"]);

/** The hooks file this adapter owns inside the host's hooks/ directory. */
const HOOKS_FILENAME = "agent-connector.json";

/**
 * Coerce Grok's PostToolUse `toolResult` (serde_json::Value — a tagged object
 * such as `{"type":"Bash",…}` for built-ins, anything at all for MCP tools) to
 * the string-typed normalized `toolOutput`. Strings pass through verbatim;
 * everything else is JSON-stringified; null/undefined leaves it unset.
 */
function coerceToolResult(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────

export class GrokBuildAdapter extends BaseAdapter {
  readonly id: PlatformId = "grok-build";
  readonly name = "Grok Build";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    preCompact: true,
    sessionStart: true,
    sessionEnd: true,
    userPromptSubmit: true,
    stop: true,
    notification: true,
    // PostToolUseFailure is a first-class Grok event (a dispatch failure or an
    // MCP error result fires it INSTEAD of PostToolUse); SubagentStart/Stop and
    // PostCompact are all native. permissionRequest stays UNSET — see the header.
    postToolUseFailure: true,
    subagentStart: true,
    subagentStop: true,
    postCompact: true,
    // PreToolUse `updatedInput` rewrites the call before it runs, and every
    // downstream consumer (plan-mode gate, permission prompt, the tool, the later
    // PostToolUse payload) sees the rewritten input.
    canModifyArgs: true,
    // PostToolUse `updatedToolOutput` replaces the model's copy of the result —
    // "Universal key; works for every tool".
    canModifyOutput: true,
    // FALSE: Grok ignores stdout on SessionStart ("For events like SessionStart
    // or Notification, stdout is ignored. Just exit 0.") and on an allowing
    // UserPromptSubmit ("stdout of an allowing hook is discarded (no
    // additionalContext)"). Context injection exists only on the tool events,
    // which this flag does not describe.
    canInjectSessionContext: false,
    // `grok mcp add` documents stdio (default), --transport http and
    // --transport sse; the TOML carries `url` for both remote forms.
    transports: ["stdio", "http", "sse"],
    // Content surfaces, all under <scope>/.grok:
    //   command  → commands/<name>.md        (flat md, stem = slash name)
    //   skill    → skills/<name>/SKILL.md    (Anthropic frontmatter)
    //   subagent → agents/<name>.md          (name/description/tools/model)
    supportsCommands: true,
    supportsSkills: true,
    supportsSubagents: true,
    // Memory: AGENTS.md (project) / $GROK_HOME/rules (user).
    supportsMemory: true,
  };

  // ── Detection ──────────────────────────────────────────────────────────

  /**
   * Grok Build is installed when its OWN marker file exists, or when a config
   * dir exists that is not merely the community Grok CLI's `~/.grok`. The
   * sibling bow-out is what keeps the two products' shared default directory
   * from cross-reporting (see the header).
   */
  detectInstalled(projectDir: string): DetectedPlatform {
    const userDir = this.userConfigDir();
    const projDir = join(projectDir, ".grok");
    const userCfg = join(userDir, "config.toml");
    const projCfg = join(projDir, "config.toml");

    // The community grok-cli's exclusive marker; never written by Grok Build.
    const siblingOnly =
      existsSync(join(userDir, "user-settings.json")) && !existsSync(userCfg);

    const userInstalled = existsSync(userCfg) || (existsSync(userDir) && !siblingOnly);
    const projInstalled = existsSync(projCfg) || existsSync(projDir);
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
        ? `found Grok Build config dir (${scope})`
        : siblingOnly
          ? `${userDir} holds only the community Grok CLI's user-settings.json`
          : `no .grok config dir at ${userDir} or ${projDir}`,
      confidence: installed ? "high" : "low",
    };
  }

  // ── Native paths ───────────────────────────────────────────────────────

  override getConfigDir(ctx: InstallContext): string {
    if (ctx.scope === "project") return join(ctx.projectDir, ".grok");
    return this.userConfigDir();
  }

  override getServerConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "config.toml");
  }

  /**
   * Hooks live in their OWN directory, one JSON file per author —
   * `$GROK_HOME/hooks/*.json` (user) or `<project>/.grok/hooks/*.json`. We own
   * exactly one file there, so an install never rewrites a hand-authored config.
   */
  override getHookConfigPath(ctx: InstallContext): string {
    return join(this.getConfigDir(ctx), "hooks", HOOKS_FILENAME);
  }

  /** `$GROK_HOME` (tilde-expanded, then resolved) || `~/.grok`. */
  private userConfigDir(): string {
    return grokBuildConfigHome();
  }

  // ── Memory surface: AGENTS.md (project) / $GROK_HOME/rules (user) ────────
  // 12-project-rules.md is titled "Project Rules (AGENTS.md)" and documents
  // AGENTS.md discovery from the repo root down to the cwd. The USER tier has no
  // AGENTS.md equivalent: home-level guidance is `*.md` under
  // `$GROK_HOME/rules/` ("Always scanned; applies to all projects").
  protected override memoryTargets(ctx: InstallContext): MemoryTarget[] {
    if (this.memoryOverride(ctx)?.path) return super.memoryTargets(ctx);
    if (ctx.scope === "project") {
      return [
        {
          path: join(ctx.projectDir, "AGENTS.md"),
          reason: "AGENTS.md standard (project root; Grok Build loads it root → cwd)",
        },
      ];
    }
    if (ctx.scope === "user") {
      return [
        {
          path: join(this.userConfigDir(), "rules", "agent-connector.md"),
          reason: "$GROK_HOME/rules/*.md global rules (always scanned, all projects)",
        },
      ];
    }
    return [];
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

  /** ObjectMapCodec over config.toml, mirroring codex: readToml fail-softs to
   *  {} so a corrupt file coerces rather than warn-skipping. */
  private tomlObjectMapCodec(): ObjectMapCodec {
    return {
      parse: (path) => this.readToml(path),
      serialize: (path, data, dryRun) => this.writeToml(path, data, dryRun),
      isPresentButUnparseable: () => false,
    };
  }

  // ── Install server (config.toml → [mcp_servers.<id>]) ────────────────────

  override installServer(ctx: InstallContext): ChangeRecord[] {
    const { connector, dryRun } = ctx;
    const server = this.effectiveServer(ctx);
    const path = this.getServerConfigPath(ctx);

    if (!server) {
      return [{ platform: this.id, action: "skip", path, detail: "no server declared" }];
    }
    const isStdio = server.transport === "stdio" && !!server.command;
    const isRemote = (server.transport === "http" || server.transport === "sse") && !!server.url;
    if (!isStdio && !isRemote) {
      return [
        {
          platform: this.id,
          action: "skip",
          path,
          detail: `transport "${server.transport}" not registrable in config.toml (stdio + http/sse url only)`,
        },
      ];
    }

    const symlink = this.symlinkPathWarning(path);
    if (symlink) return [symlink];

    return [
      upsertInObjectMap({
        codec: this.tomlObjectMapCodec(),
        rootKey: "mcp_servers",
        policy: "coerce",
        platform: this.id,
        configPath: path,
        entryId: connector.id,
        entry: this.renderMcpEntry(ctx, server),
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

  // ── Install hooks (hooks/agent-connector.json) ───────────────────────────

  override installHooks(ctx: InstallContext): ChangeRecord[] {
    const path = this.getHookConfigPath(ctx);
    const hooksOff = ctx.connector.platforms[this.id]?.hooks === false;
    const declared = hooksOff ? [] : ctx.connector.hookEvents;

    if (declared.length === 0) {
      return [{ platform: this.id, action: "skip", path, detail: "no hooks declared" }];
    }

    // Unsupported events first (reported by the descriptor, never dropped),
    // then the supported ones in host order. renderEntry derives the matcher.
    const supported = (e: HookEventName) =>
      (GROK_BUILD_HOOK_EVENTS as readonly string[]).includes(e);
    const pending = [
      ...declared
        .filter((e) => !supported(e))
        .map((event) => ({ event: event as string, matcher: "" })),
      ...declared.filter(supported).map((event) => ({ event: event as string, matcher: "" })),
    ];
    return this.upsertHookEntries(ctx, path, pending, this.hookDescriptor(ctx));
  }

  override uninstallHooks(ctx: InstallContext): ChangeRecord[] {
    return this.removeHookEntries(ctx, this.getHookConfigPath(ctx), this.hookDescriptor(ctx));
  }

  /** Hook-merge policy for the shared object-map engine (Claude-compatible file). */
  private hookDescriptor(_ctx: InstallContext): HookMergeDescriptor<GrokBuildHookEntry> {
    return {
      malformedPolicy: "coerce",
      mapEvent: (e) =>
        (GROK_BUILD_HOOK_EVENTS as readonly string[]).includes(e) ? e : undefined,
      unmappedWarnDetail: (e) => `${e} has no Grok Build hook equivalent — skipped`,
      unmappedAction: (e) => (WARN_SKIP_EVENTS.has(e as HookEventName) ? "warn" : "skip"),
      renderEntry: (event, _matcher, command) => {
        const entry: GrokBuildHookEntry = { hooks: [{ type: "command", command }] };
        // EVENT-derived matcher: the tool events carry the tool-name matcher, and
        // everything else registers "" (matches all). Grok warns on a matcher for
        // Stop / UserPromptSubmit, so those must stay empty.
        entry.matcher = event === "PreToolUse" ? PRE_TOOL_USE_MATCHER : "";
        return entry;
      },
      entryOwnsCommand: (entry, command) =>
        Array.isArray(entry.hooks) &&
        entry.hooks.some(
          (h) => (h.command ?? "").replace(/\\/g, "/") === command.replace(/\\/g, "/"),
        ),
      ownsEntryForRemove: (c, event) => (entry) =>
        this.isOurEntry(c, event as GrokBuildHookEventName, entry),
      skipDetail: (e) => `hooks.${e}`,
      removeDetail: (e, _n) => `hooks.${e}`,
      absentDetail: `no ${HOOKS_FILENAME}`,
      noMatchDetail: "no agent-connector hooks present",
      removeEventKeys: GROK_BUILD_HOOK_EVENTS,
    };
  }

  // ── Health checks ────────────────────────────────────────────────────────

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
          // Only assert what the connector declares: a server-less connector
          // never writes an [mcp_servers.<id>] table, so its absence is healthy.
          if (!ctx.connector.server) {
            return { status: "OK", detail: "no MCP server declared" };
          }
          const bucket = this.readToml(path)["mcp_servers"];
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
    return checks;
  }

  // ── Content surfaces: commands / skills / subagents ──────────────────────
  // Pure native-file writers under <scope>/.grok — idempotent via
  // writeContentFile, reversible via removeContentFile. All three roots are
  // scope-symmetric (Grok scans the same layout at user, repo and cwd tiers).

  private commandPath(ctx: InstallContext, name: string): string {
    return join(this.getConfigDir(ctx), "commands", `${name}.md`);
  }
  private skillDir(ctx: InstallContext, name: string): string {
    return join(this.getConfigDir(ctx), "skills", name);
  }
  private subagentPath(ctx: InstallContext, name: string): string {
    return join(this.getConfigDir(ctx), "agents", `${name}.md`);
  }

  // ── Commands (flat markdown; filename stem = slash-command name) ──────────

  override installCommands(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[this.id]?.commands === false) {
      return [{ platform: this.id, action: "skip", detail: "commands disabled for grok-build" }];
    }
    if (connector.commands.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no commands" }];
    }
    return connector.commands.map((cmd) =>
      this.writeContentFile(
        this.commandPath(ctx, cmd.name),
        // Grok's command markdown is the Claude legacy layout: description +
        // argument-hint frontmatter. It has no allowed-tools/model keys on a
        // COMMAND (those are skill/agent frontmatter fields), so both are dropped.
        renderCommandMd(cmd, { includeToolsAndModel: false }),
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

  // ── Skills (Anthropic-format SKILL.md) ───────────────────────────────────

  override installSkills(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[this.id]?.skills === false) {
      return [{ platform: this.id, action: "skip", detail: "skills disabled for grok-build" }];
    }
    if (connector.skills.length === 0) {
      return [{ platform: this.id, action: "skip", detail: "connector declares no skills" }];
    }
    const changes: ChangeRecord[] = [];
    for (const skill of connector.skills) {
      const dir = this.skillDir(ctx, skill.name);
      changes.push(this.writeContentFile(join(dir, "SKILL.md"), renderSkillMd(skill), ctx.dryRun));
      // Bundle resource files beside SKILL.md. Defense-in-depth: refuse any key
      // that escapes the skill dir (config-time validation already rejects these).
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
        if (target === null) continue; // never delete outside the skill dir
        changes.push(this.removeContentFile(target, ctx.dryRun));
      }
      // Only remove the dir when WE own its full contents.
      changes.push(this.removeDirIfEmpty(dir, ctx.dryRun));
    }
    return changes;
  }

  // ── Subagents (md + frontmatter: name, description, tools, model) ─────────

  override installSubagents(ctx: InstallContext): ChangeRecord[] {
    const { connector } = ctx;
    if (connector.platforms[this.id]?.subagents === false) {
      return [{ platform: this.id, action: "skip", detail: "subagents disabled for grok-build" }];
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

  /**
   * Grok agent definitions are md + YAML frontmatter whose documented keys —
   * name, description, tools, model — are exactly the shared renderer's shape
   * (16-subagents.md shows `name`, `description`, `tools` in its frontmatter
   * example). `extra` remains the escape hatch for Grok-only keys such as
   * `mcpInheritance`.
   */
  private renderSubagent(agent: SubagentDef): string {
    return renderSubagentMd(agent);
  }

  // ── Runtime dispatch ─────────────────────────────────────────────────────

  parseEvent(event: HookEventName, raw: unknown): NormalizedEvent {
    const input = (raw ?? {}) as GrokBuildHookInput;
    // camelCase is the authoritative envelope spelling; the snake_case twins are
    // the additive aliases to_hook_json injects.
    const toolName = input.toolName ?? input.tool_name ?? "";
    const toolInput = input.toolInput ?? input.tool_input ?? {};
    const base = {
      hostPlatform: this.id,
      connectorId: "",
      sessionId: input.sessionId ?? input.session_id ?? `pid-${process.ppid}`,
      // `cwd` is the session's working directory; `workspaceRoot` is the repo
      // root. Prefer cwd (matches every other adapter's projectDir semantics).
      projectDir: input.cwd ?? input.workspaceRoot ?? process.cwd(),
      raw,
    };

    switch (event) {
      case "PreToolUse":
        return { ...base, toolName, toolInput };
      case "PostToolUse":
        return {
          ...base,
          toolName,
          toolInput,
          // Upstream field is `toolResult` (aliased to `tool_response`).
          toolOutput: coerceToolResult(input.toolResult ?? input.tool_response),
          // Grok's PostToolUse payload has NO error flag: a dispatch failure or
          // an MCP error result fires PostToolUseFailure instead. Never invent one.
          isError: false,
        };
      case "SessionStart":
        return { ...base, source: normalizeSessionSource(input.source) };
      case "SessionEnd":
        return { ...base, reason: input.reason };
      case "UserPromptSubmit":
        return { ...base, prompt: input.prompt ?? "" };
      case "PreCompact":
      case "PostCompact":
        // FALSE FRIEND: the compaction payload field is `source`, not `trigger`
        // (event.rs PreCompact/PostCompact { source: String }), even though the
        // prose calls the value "the compaction trigger" (manual|auto).
        return { ...base, trigger: input.source === "manual" ? "manual" : "auto" };
      case "Stop":
        return { ...base, stopHookActive: input.stopHookActive ?? false };
      case "Notification":
        // `message` is optional upstream; `notificationType` is always present
        // and is what the matcher tests, so it is the fallback.
        return { ...base, message: input.message ?? input.notificationType ?? "" };
      case "PostToolUseFailure":
        return {
          ...base,
          toolName,
          toolInput,
          error: input.error ?? "",
          ...(typeof (input.toolUseId ?? input.tool_use_id) === "string"
            ? { toolUseId: (input.toolUseId ?? input.tool_use_id) as string }
            : {}),
          ...(typeof (input.isInterrupt ?? input.is_interrupt) === "boolean"
            ? { isInterrupt: (input.isInterrupt ?? input.is_interrupt) as boolean }
            : {}),
          ...(typeof (input.durationMs ?? input.duration_ms) === "number"
            ? { durationMs: (input.durationMs ?? input.duration_ms) as number }
            : {}),
        };
      case "SubagentStart":
        return {
          ...base,
          ...(typeof input.subagentId === "string" ? { agentId: input.subagentId } : {}),
          ...(typeof input.subagentType === "string" ? { agentType: input.subagentType } : {}),
        };
      case "SubagentStop":
        return {
          ...base,
          ...(typeof input.subagentId === "string" ? { agentId: input.subagentId } : {}),
          ...(typeof input.subagentType === "string" ? { agentType: input.subagentType } : {}),
          ...(typeof input.lastAssistantMessage === "string"
            ? { lastAssistantMessage: input.lastAssistantMessage }
            : {}),
          ...(typeof input.stopHookActive === "boolean"
            ? { stopHookActive: input.stopHookActive }
            : {}),
        };
      case "PermissionRequest":
        // No Grok analog — never fired natively (its `PermissionDenied` is a
        // passive post-denial event). Parsed defensively so a manual
        // `hook grok-build PermissionRequest` invocation normalizes rather than
        // throwing.
        return { ...base, toolName, toolInput };
    }
  }

  formatReply(event: HookEventName, response: HookResponse): HookReply {
    // Exit code 0 throughout: Grok honors a stdout `deny` decision regardless of
    // the exit code, and a non-zero exit DROPS updatedInput / additionalContext /
    // the output replacement. Structured stdout is therefore strictly better than
    // the exit-2 channel for every reply we emit.

    if (response.decision === "deny") {
      // PreToolUse: the canonical decision key is
      // hookSpecificOutput.permissionDecision (it wins over a top-level
      // `decision`), with permissionDecisionReason as the message.
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
      // UserPromptSubmit / Stop / SubagentStop / PostToolUse all use the
      // top-level block protocol. On Stop / SubagentStop this keeps the agent
      // working with `reason` as its next instruction; on UserPromptSubmit it
      // rejects the prompt; on PostToolUse it delivers `reason` to the model
      // beside the (already produced) tool result.
      if (
        event === "UserPromptSubmit" ||
        event === "Stop" ||
        event === "SubagentStop" ||
        event === "PostToolUse"
      ) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            decision: "block",
            reason: response.reason ?? "Blocked by hook",
          }),
        };
      }
      // PostToolUseFailure is feedback-only: a deny degrades to context carrying
      // the reason (the documented capability is additionalContext alone).
      if (event === "PostToolUseFailure") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PostToolUseFailure",
              additionalContext: response.reason ?? "Blocked by hook",
            },
          }),
        };
      }
      // Passive events (SessionStart/End, Notification, Pre/PostCompact,
      // SubagentStart) ignore stdout entirely — fail open.
      return { exitCode: 0 };
    }

    // "ask" is NATIVE on Grok: the call reaches the permission prompt, which
    // names the hook and shows the reason, and no always-approve/auto/saved-grant
    // path can bypass it. Only PreToolUse has a permission gate to route to.
    if (response.decision === "ask" && event === "PreToolUse") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: response.reason ?? "Confirmation required by hook",
          },
        }),
      };
    }

    if (response.decision === "modify") {
      // PreToolUse input rewrite. Unlike Codex, Grok needs NO paired allow:
      // "Omitting `decision` while returning `updatedInput` allows the call and
      // applies the rewrite" — and emitting a bare allow would be wrong anyway,
      // since a Grok `allow` means only "not blocked".
      if (event === "PreToolUse" && response.updatedInput) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              updatedInput: response.updatedInput,
            },
          }),
        };
      }
      // PostToolUse output rewrite: `updatedToolOutput` is the universal key and
      // replaces only the MODEL's copy of the result (the scrollback, transcript
      // and telemetry keep the original).
      if (event === "PostToolUse" && response.updatedOutput !== undefined) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              updatedToolOutput: response.updatedOutput,
            },
          }),
        };
      }
      return { exitCode: 0 };
    }

    // Context injection. Honored on the tool events and on the Stop gates
    // (non-error feedback that keeps the agent working). NOT honored on
    // SessionStart / Notification / Pre|PostCompact / SubagentStart, whose stdout
    // Grok ignores, nor on an allowing UserPromptSubmit, whose stdout is
    // discarded — those fall through to a bare exit-0 rather than emitting a
    // payload the host would silently drop.
    if (
      response.additionalContext &&
      (event === "PreToolUse" ||
        event === "PostToolUse" ||
        event === "PostToolUseFailure" ||
        event === "Stop" ||
        event === "SubagentStop")
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

    // "allow" / unsupported-here → passthrough.
    return { exitCode: 0 };
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

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
   * `${env:VAR}` resolves to a literal at install time. Honors the telemetry
   * serve-wrapper (stdio only — a remote server cannot be intercepted).
   */
  private renderMcpEntry(ctx: InstallContext, server: ServerDef): GrokBuildMcpEntry {
    // Remote (http/sse): Grok infers the transport from `url`; `headers` is the
    // documented auth-carrying table. installServer's guard means this branch is
    // exactly the http/sse+url case.
    if (server.transport === "http" || server.transport === "sse") {
      const remote: GrokBuildMcpEntry = { url: resolveEnvRefsDeep(server.url ?? "") };
      const headers: Record<string, string> = {};
      if (server.auth?.type === "bearerEnv" && server.auth.bearerEnvVar) {
        // Grok has no bearer_token_env_var key (that is a Codex-ism). The token
        // rides the standard Authorization header, emitted in GROK'S OWN
        // `${VAR}` syntax rather than as a resolved literal: 07-mcp-servers.md
        // §Example Configurations documents `headers = { "Authorization" =
        // "Bearer ${INTERNAL_MCP_TOKEN}" }` and states Grok expands `url`,
        // `command`, `args` and the values in `env`/`headers` at load time. So
        // the secret stays out of the config file — which matters most in
        // project scope, where .grok/config.toml is meant to be committed.
        headers["Authorization"] = `Bearer \${${server.auth.bearerEnvVar}}`;
      }
      for (const [k, v] of Object.entries(resolveEnvRefsDeep(server.headers ?? {}))) {
        headers[k] = String(v);
      }
      if (Object.keys(headers).length > 0) remote.headers = headers;
      if (server.enabled === false) remote.enabled = false;
      return remote;
    }

    let command = server.command as string;
    let args = [...(server.args ?? [])];

    ({ command, args } = buildWrappedStdio(ctx, server, this.id, command, args));

    // Resolve env-refs to literals (TOML cannot interpolate).
    command = resolveEnvRefsDeep(command);
    args = resolveEnvRefsDeep(args);

    const entry: GrokBuildMcpEntry = { command };
    if (args.length > 0) entry.args = args;

    if (server.env && Object.keys(server.env).length > 0) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(resolveEnvRefsDeep(server.env))) {
        env[k] = String(v);
      }
      entry.env = env;
    }
    if (server.enabled === false) entry.enabled = false;
    return entry;
  }

  /**
   * Does this hooks-file entry belong to this connector for `event`? EVENT-
   * SPECIFIC + path-normalized exact-command match, so an entry under one event
   * key is never matched while iterating another.
   */
  private isOurEntry(
    ctx: InstallContext,
    event: GrokBuildHookEventName,
    entry: GrokBuildHookEntry,
  ): boolean {
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) return false;
    const ours = buildHomeBinHookCommand(ctx.homeBinPath, "grok-build", event, ctx.connector.id);
    const needle = ours.replace(/\\/g, "/");
    return entry.hooks.some((h) => (h.command ?? "").replace(/\\/g, "/") === needle);
  }
}

export const adapter = new GrokBuildAdapter();
export default adapter;
