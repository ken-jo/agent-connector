/**
 * core/types — the shared contract surface for agent-connector.
 *
 * Everything in this file is type-only (no runtime), so it is safe to import
 * from anywhere without creating module cycles. It is the single source of
 * truth that every adapter, the telemetry layer, the CLI, and the public API
 * code against.
 *
 * Grounded in the understand-phase report (docs/research/understand-report.md)
 * and generalized from context-mode's proven 15-platform adapter SPI:
 *   - context-mode hardcoded the served identity ("context-mode"); here the
 *     identity is a parameter the developer supplies via defineConnector().
 *   - context-mode's session/memory/FTS domain logic is removed from the SPI.
 *   - MCP server registration is modeled here (root key + format differ per
 *     platform, so adapters must render it — it is NOT "100% portable").
 */

// ─────────────────────────────────────────────────────────────────────────
// Platform identity
// ─────────────────────────────────────────────────────────────────────────

/**
 * Stable identifiers for every host platform agent-connector can target.
 *
 * NOTE on usage-only platforms: `"synthetic"` is a TELEMETRY-ONLY id
 * (Octofriend / synthetic.new). It has a usage reader (usage/readers/synthetic)
 * but DELIBERATELY no deploy adapter and no ADAPTER_REGISTRY entry — Octofriend
 * exposes no writable MCP config to install into. The registry-completeness test
 * (tests/adapters/registry-completeness.test.ts) allowlists it for this reason.
 */
export type PlatformId =
  | "claude-code"
  | "codex"
  | "cursor"
  | "vscode-copilot"
  | "jetbrains-copilot"
  | "copilot-cli"
  | "gemini-cli"
  | "opencode"
  | "kilo"
  | "kilo-cli"
  | "warp"
  | "hermes"
  | "openclaw"
  | "zed"
  | "antigravity"
  | "antigravity-cli"
  | "kiro"
  | "qwen-code"
  | "kimi"
  | "pi"
  | "omp"
  | "droid"
  | "roo-code"
  | "trae"
  | "amp"
  | "codebuff"
  | "mux"
  | "crush"
  | "goose"
  | "synthetic"
  | "unknown";

/**
 * Hook I/O paradigm — the deepest cross-platform divergence (report §4).
 * Canonical shipped sets (keep in sync with src/adapters/registry.ts — this
 * comment once drifted and seeded a docs-wide misclassification):
 *   - "json-stdio" (16): host pipes JSON to a command on stdin, reads
 *     JSON/exit-code back — Claude Code, Codex, Cursor, VS Code/JetBrains
 *     Copilot, Copilot CLI, Gemini CLI, Qwen, Kiro, Kimi, Crush, Goose, Hermes,
 *     Droid (Factory), Antigravity (+ the agy CLI). One universal entrypoint
 *     binary handles all of them.
 *   - "ts-plugin" (4): host loads a JS/TS module exporting lifecycle functions
 *     — OpenCode, Kilo CLI, OMP, OpenClaw. Framework generates the module.
 *   - "mcp-only" (9): no hook layer at all — Warp, Kilo, Roo Code, Trae, Zed,
 *     Amp, Codebuff, Mux, Pi. Only the MCP server (or skills surface) is
 *     installed; hooks are reported unavailable.
 */
export type HookParadigm = "json-stdio" | "ts-plugin" | "mcp-only";

/**
 * Install scope, normalized across platforms and ordered low→high precedence.
 * Each adapter maps these to a concrete config path and knows which it supports.
 */
export type InstallScope = "system" | "user" | "project" | "profile" | "managed";

// ─────────────────────────────────────────────────────────────────────────
// MCP server definition (transport-polymorphic, declared once)
// ─────────────────────────────────────────────────────────────────────────

export type Transport = "stdio" | "http" | "sse" | "ws";

export interface ToolFilter {
  /** Glob/exact tool names to expose. Default: ["*"]. */
  include?: string[];
  /** Glob/exact tool names to hide. */
  exclude?: string[];
}

export interface AuthSpec {
  type: "oauth" | "bearerEnv" | "none";
  /** Env var holding the bearer token when type === "bearerEnv". */
  bearerEnvVar?: string;
}

/**
 * A normalized, transport-polymorphic MCP server descriptor. Declared ONCE by
 * the developer; each adapter renders it into that platform's native dialect
 * (root key, field names, format). Adapters that cannot honor a requested
 * transport downgrade-or-skip and report it — they never throw.
 */
export interface ServerDef {
  transport: Transport;

  // ── stdio transport ──
  command?: string;
  args?: string[];
  /** Env vars passed to the server process. Values support ${env:VAR} interpolation. */
  env?: Record<string, string>;
  cwd?: string;

  // ── remote (http / sse / ws) transport ──
  url?: string;
  headers?: Record<string, string>;
  auth?: AuthSpec;

  // ── common ──
  tools?: ToolFilter;
  timeoutMs?: number;
  /** Default true. When false, the entry is written disabled where supported. */
  enabled?: boolean;

  /**
   * Wrap the server with `agent-connector serve` so per-tool telemetry is
   * captured transparently. Default: true for stdio servers when telemetry is
   * enabled; false for remote servers (cannot intercept) and when explicitly off.
   */
  wrapForTelemetry?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// Normalized lifecycle events + responses
// ─────────────────────────────────────────────────────────────────────────

/**
 * Canonical, platform-agnostic lifecycle event names.
 *
 * The last four (PermissionRequest / PostToolUseFailure / SubagentStart /
 * SubagentStop) are newer additions with cross-host analogs; hosts without a
 * native analog mark them unsupported in capabilities and the install reports
 * a skip-warn — an event is never silently dropped.
 */
export type HookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PreCompact"
  | "Stop"
  | "Notification"
  | "PermissionRequest"
  | "PostToolUseFailure"
  | "SubagentStart"
  | "SubagentStop";

interface BaseEvent {
  /** Which host produced this event (from runtime detection). */
  hostPlatform: PlatformId;
  /** Connector id this event is dispatched to. */
  connectorId: string;
  /** Host session id (adapter-extracted; "" when the host provides none). */
  sessionId: string;
  /** Project directory if the host exposes one. */
  projectDir?: string;
  /** Raw host-specific payload for passthrough/escape-hatch use. */
  raw: unknown;
}

export interface PreToolUseEvent extends BaseEvent {
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface PostToolUseEvent extends BaseEvent {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput?: string;
  isError?: boolean;
}

export interface SessionStartEvent extends BaseEvent {
  source: "startup" | "compact" | "resume" | "clear";
}

export interface SessionEndEvent extends BaseEvent {
  reason?: string;
}

export interface UserPromptSubmitEvent extends BaseEvent {
  prompt: string;
}

export interface PreCompactEvent extends BaseEvent {
  trigger?: "auto" | "manual";
}

export interface StopEvent extends BaseEvent {
  /** True when the stop hook itself was triggered during a previous stop hook. */
  stopHookActive?: boolean;
}

export interface NotificationEvent extends BaseEvent {
  message: string;
}

/**
 * PermissionRequest — the host is about to show a permission dialog for a tool
 * call (unlike PreToolUse, which fires before EVERY execution regardless of
 * permission status). Decision semantics differ from the other tool events:
 *   - "allow" is an ACTIVE grant that suppresses the dialog (it does NOT
 *     override host-side deny rules); `updatedInput` may replace the input.
 *   - "deny" rejects the request; `reason` is shown to the model.
 *   - "ask" / void / no decision falls through to the host's native dialog.
 * Matchers match the tool name, like PreToolUse.
 */
export interface PermissionRequestEvent extends BaseEvent {
  toolName: string;
  toolInput: Record<string, unknown>;
  /**
   * Permission-update entries the host's dialog would offer (e.g. Claude's
   * addRules/behavior/destination records). Host-specific shapes — passthrough.
   */
  permissionSuggestions?: unknown[];
}

/**
 * PostToolUseFailure — a tool call failed (error thrown or failure result).
 * Feedback-only: the tool already failed, so nothing is blockable here.
 * "context" injects `additionalContext` beside the error; a "deny" degrades to
 * the same context shape carrying the reason. Matchers match the tool name.
 */
export interface PostToolUseFailureEvent extends BaseEvent {
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Host correlation id for the failed tool call, when provided. */
  toolUseId?: string;
  /** The failure/error message the host captured. */
  error: string;
  /** True when a user interruption caused the failure. */
  isInterrupt?: boolean;
  /** Tool execution duration in milliseconds, when the host reports it. */
  durationMs?: number;
}

/**
 * SubagentStart — a subagent was spawned. Observe/context-only: "context"
 * injects `additionalContext` into the SUBAGENT's conversation before its first
 * prompt; there is no decision control. Matchers match the agent type.
 */
export interface SubagentStartEvent extends BaseEvent {
  /** Unique subagent id, when the host provides one. */
  agentId?: string;
  /** Agent type (built-in name or a custom subagent's declared name). */
  agentType?: string;
}

/**
 * SubagentStop — a subagent finished responding. Stop semantics: "deny" keeps
 * the subagent running with `reason` as its next instruction; "context" injects
 * `additionalContext`. Matchers match the agent type. NOTE: `agentId` and
 * `agentType` are optional because some hosts (including Claude Code) do not
 * reliably populate agent_type on stop — never depend on them being present.
 */
export interface SubagentStopEvent extends BaseEvent {
  agentId?: string;
  agentType?: string;
  /** The subagent's OWN transcript path (distinct from the parent session's). */
  agentTranscriptPath?: string;
  /** Text of the subagent's final response, when the host provides it. */
  lastAssistantMessage?: string;
  /** True when the stop hook is already continuing this subagent (loop guard). */
  stopHookActive?: boolean;
}

/** Map of event name → its normalized payload type. */
export interface EventPayloadMap {
  SessionStart: SessionStartEvent;
  SessionEnd: SessionEndEvent;
  UserPromptSubmit: UserPromptSubmitEvent;
  PreToolUse: PreToolUseEvent;
  PostToolUse: PostToolUseEvent;
  PreCompact: PreCompactEvent;
  Stop: StopEvent;
  Notification: NotificationEvent;
  PermissionRequest: PermissionRequestEvent;
  PostToolUseFailure: PostToolUseFailureEvent;
  SubagentStart: SubagentStartEvent;
  SubagentStop: SubagentStopEvent;
}

/**
 * Normalized hook response. A handler returns a subset of these; the adapter
 * formats it into the host's native reply (exit codes / JSON / control fields).
 * Adapters drop fields the host cannot honor (e.g. updatedOutput where the host
 * cannot rewrite tool output) and the framework reports the degradation.
 */
export interface HookResponse {
  /**
   *  - "allow":   pass through. On PermissionRequest ONLY, an EXPLICIT "allow"
   *               is an active grant that suppresses the host's permission
   *               dialog (a void/decision-less return falls through to the
   *               native dialog instead — an active grant is never implied).
   *  - "deny":    block tool execution / stop the action. On SubagentStop this
   *               keeps the subagent running (Stop semantics); on feedback-only
   *               events (PostToolUseFailure / SubagentStart) it degrades to
   *               context carrying the reason.
   *  - "modify":  replace tool input (PreToolUse / PermissionRequest) with
   *               `updatedInput`
   *  - "context": inject `additionalContext` as soft guidance
   *  - "ask":     prompt the user to confirm (on PermissionRequest: fall
   *               through to the native dialog — the dialog IS the ask)
   */
  decision?: "allow" | "deny" | "modify" | "context" | "ask";
  /** Shown to the model/user; required in spirit for deny/ask. */
  reason?: string;
  /** Replacement tool input — only meaningful with decision "modify". */
  updatedInput?: Record<string, unknown>;
  /** Extra context to inject — meaningful with "context" or on SessionStart. */
  additionalContext?: string;
  /** Rewritten tool output — only where the host supports it (PostToolUse). */
  updatedOutput?: string;
}

/** A handler bound to one event, optionally filtered by a tool matcher. */
export interface HookDefinition<E extends HookEventName = HookEventName> {
  /**
   * Regex string matched against the tool name (tool events, including
   * PermissionRequest / PostToolUseFailure) or the agent type (SubagentStart /
   * SubagentStop). Empty/omitted matches all. Rendered into each host's native
   * matcher syntax where supported, else evaluated by the universal entrypoint
   * at runtime.
   */
  matcher?: string;
  handler(
    event: EventPayloadMap[E],
  ): HookResponse | void | Promise<HookResponse | void>;
}

/** Developer-declared hooks, keyed by canonical event name. */
export interface HooksConfig {
  SessionStart?: HookDefinition<"SessionStart">;
  SessionEnd?: HookDefinition<"SessionEnd">;
  UserPromptSubmit?: HookDefinition<"UserPromptSubmit">;
  PreToolUse?: HookDefinition<"PreToolUse">;
  PostToolUse?: HookDefinition<"PostToolUse">;
  PreCompact?: HookDefinition<"PreCompact">;
  Stop?: HookDefinition<"Stop">;
  Notification?: HookDefinition<"Notification">;
  PermissionRequest?: HookDefinition<"PermissionRequest">;
  PostToolUseFailure?: HookDefinition<"PostToolUseFailure">;
  SubagentStart?: HookDefinition<"SubagentStart">;
  SubagentStop?: HookDefinition<"SubagentStop">;
}

// ─────────────────────────────────────────────────────────────────────────
// Native (passthrough) hooks — platform-scoped escape hatch
// ─────────────────────────────────────────────────────────────────────────

/**
 * The payload a NATIVE (passthrough) hook handler receives. Unlike the
 * normalized {@link EventPayloadMap} events there is NO field mapping: `raw` is
 * the host's stdin JSON exactly as it arrived, so the handler reads the host's
 * own contract (e.g. Claude's snake_case `task_id` / `teammate_name` fields)
 * with full native fidelity.
 */
export interface NativeHookEvent {
  /** Host-native event name, VERBATIM (e.g. "TaskCreated", "WorktreeRemove"). */
  event: string;
  /** Which host produced this event. */
  hostPlatform: PlatformId;
  /** Host session id when the payload carries one ("" when it provides none). */
  sessionId: string;
  /** Project directory when the host reports one (Claude Code: `cwd`). */
  projectDir?: string;
  /** The host's RAW stdin payload, UNTOUCHED — no normalization whatsoever. */
  raw: unknown;
}

/**
 * One native passthrough hook: a handler bound to a HOST-NATIVE event name that
 * is not part of the normalized {@link HookEventName} union.
 *
 * Contract (deliberately minimal — full native fidelity, zero translation):
 *   - The handler receives the host's RAW stdin payload ({@link NativeHookEvent}.raw).
 *   - Whatever the handler RETURNS is serialized VERBATIM as the stdout JSON
 *     reply with exit 0. There is no {@link HookResponse} mapping — the return
 *     value must already be the host's native reply shape. Examples from Claude
 *     Code's contracts: a TaskCreated/TaskCompleted handler returns
 *     `{continue: false, stopReason: "…"}` to stop the teammate entirely; a
 *     MessageDisplay handler returns
 *     `{hookSpecificOutput: {hookEventName: "MessageDisplay", displayContent}}`
 *     to rewrite the rendered text; an Elicitation handler returns
 *     `{hookSpecificOutput: {hookEventName: "Elicitation", action: "accept", content}}`
 *     to answer an MCP user-input request programmatically. For output-ignored
 *     events (e.g. StopFailure, InstructionsLoaded) the handler is
 *     logging/alerting-only and should return void.
 *   - void/undefined → exit 0 with NO output.
 *   - Fail-open: any throw degrades to exit 0 with no output.
 *
 * LIMITATION (v1): exit-2 blocking semantics are NOT modeled — a native handler
 * always exits 0. JSON-on-exit-0 decision control covers Claude Code's events
 * (e.g. `{continue:false, stopReason}` on TaskCreated/TaskCompleted/TeammateIdle),
 * but contracts that REQUIRE a non-zero exit (e.g. WorktreeCreate fails creation
 * on any non-zero exit and wants the path on stdout — which a returned string
 * cannot express as bare text) may not be fully drivable.
 */
export interface NativeHookDef {
  /**
   * Host-native matcher string, written VERBATIM into the host's hook config
   * entry (e.g. Claude's tool-name / agent-type / trigger matchers). The
   * framework does not evaluate it at runtime — the host filters.
   */
  matcher?: string;
  /** Receives the raw host payload; its return is the verbatim stdout reply. */
  handler(evt: NativeHookEvent): unknown | Promise<unknown>;
}

// ─────────────────────────────────────────────────────────────────────────
// Declarative host-config key patches (configPatch) — platform-scoped
// ─────────────────────────────────────────────────────────────────────────

/** A JSON-serializable value (what JSON.parse can produce). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

/**
 * One declarative, ownership-tracked patch of a host-exclusive config key
 * (e.g. Claude Code settings.json `statusLine`, or
 * `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`). SEMANTICS ARE FIXED:
 * set-if-absent on a single leaf key, skip-warn on ANY conflict, refcounted
 * ownership (persisted ledger at `<dataRoot>/state/config-patches.json`),
 * reversible uninstall. No overwrite, no delete, no deep merge, no array ops.
 *
 * Connectors name a host + key, NEVER a file path — the adapter owns the
 * key→file mapping ({@link PlatformCapabilities.supportsConfigPatch}; v1:
 * claude-code only, every other adapter reports the standard skip-warn).
 * Same-file sibling structures that belong to the MCP entry dialect (VS Code
 * `inputs`, Zed `context_servers.<id>.settings`) are NOT configPatch targets —
 * they stay in the adapter / `extra`. Keys agent-connector already models
 * (`hooks*`, `mcpServers*`) are rejected at defineConnector; security-relevant
 * keys are refused by the adapter's documented sensitive-key denylist.
 */
export interface ConfigPatchDef {
  /**
   * Dotted LEAF path into the adapter's declared patchable file, e.g.
   * "statusLine" or "env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS".
   * Segments match /^[A-Za-z0-9_-]+$/ (no dots-in-key, no array indices).
   * Intermediate objects are created only when absent; a non-object
   * intermediate → skip-warn. The VALUE may be an object/array but is
   * written atomically as the leaf — never merged into.
   */
  key: string;
  /**
   * Value written when (and only when) the key is absent. `${env:VAR}` refs
   * are resolved at install time via core/interpolate resolveEnvRefsDeep,
   * matching server-entry behavior.
   */
  value: JsonValue;
  /**
   * REQUIRED human-readable why — printed in the install diff, every
   * ChangeRecord, and every skip-warn (so one declaration doubles as its own
   * documented manual-edit fallback on skip/conflict/unsupported hosts).
   */
  reason: string;
  /** Docs link appended to the manual-edit fallback printed on skip/conflict. */
  docsUrl?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Platform capabilities
// ─────────────────────────────────────────────────────────────────────────

/** What a given host can actually honor. The single-API layer degrades to it. */
export interface PlatformCapabilities {
  preToolUse: boolean;
  postToolUse: boolean;
  preCompact: boolean;
  sessionStart: boolean;
  sessionEnd: boolean;
  userPromptSubmit: boolean;
  stop: boolean;
  notification: boolean;
  /**
   * Newer per-event flags (OPTIONAL so existing adapter capability literals
   * compile unchanged; read as `?? false`, mirroring the supportsCommands
   * precedent below). A host that leaves a flag unset does not support the
   * event natively — install reports the standard skip-warn for it.
   */
  permissionRequest?: boolean;
  postToolUseFailure?: boolean;
  subagentStart?: boolean;
  subagentStop?: boolean;
  /** Can a PreToolUse hook rewrite tool arguments? */
  canModifyArgs: boolean;
  /** Can a PostToolUse hook rewrite tool output? */
  canModifyOutput: boolean;
  /** Can a hook inject context at session start / compaction? */
  canInjectSessionContext: boolean;
  /** MCP transports this host can register. */
  transports: Transport[];
  /**
   * Native (passthrough) hooks support — can this adapter install
   * {@link PlatformOverride.nativeHooks} entries verbatim into the host's hook
   * config? OPTIONAL, read as `?? false` (supportsCommands precedent). Only
   * claude-code opts in today; an adapter that leaves this unset and receives a
   * nativeHooks declaration gets the standard skip-warn ChangeRecord from the
   * installer (never silent).
   */
  supportsNativeHooks?: boolean;
  /**
   * Declarative host-config key patches — can this adapter apply
   * {@link PlatformOverride.configPatch} entries (set-if-absent, ownership-
   * tracked) to its declared patchable config file? OPTIONAL, read as
   * `?? false` (supportsNativeHooks precedent). v1: claude-code only; an
   * adapter that leaves this unset and receives a configPatch declaration gets
   * the standard skip-warn ChangeRecord from the installer (never silent),
   * plus per-patch manual-edit instructions from `reason`/`docsUrl`.
   */
  supportsConfigPatch?: boolean;
  /**
   * Content-surface support (all OPTIONAL so existing adapter capability
   * literals compile unchanged; read as `?? false`). Only surface-supporting
   * adapters set these true. The BaseAdapter install/uninstall defaults
   * handle the "unsupported" skip/warn regardless of the flag.
   */
  supportsCommands?: boolean;
  supportsSkills?: boolean;
  supportsSubagents?: boolean;
  /**
   * Memory-surface support (managed marker blocks in the host's memory/rules
   * file, AGENTS.md-first). OPTIONAL, read as `?? false` (supportsCommands
   * precedent). Supporting adapters inherit BaseAdapter's generic
   * installMemory/uninstallMemory; the write target comes from the
   * per-adapter `memoryTargets()` hook.
   */
  supportsMemory?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// Content surfaces (commands / skills / subagents) — declared once, written
// as native content files by each supporting adapter. CONTENT-ONLY: no runtime
// dispatch, no telemetry wrapping, no home-bin pointer — pure file writers.
// ─────────────────────────────────────────────────────────────────────────

/** Tool access expressed once; adapters render to allowed-tools / tools[] / readonly. */
export interface SurfaceToolPolicy {
  allow?: string[]; // allowed-tools (CSV/array per platform)
  deny?: string[]; // disallowedTools / disallowed-tools
}

/** A slash command (= a Skill on 2026 Claude; adapters pick the right surface). */
export interface CommandDef {
  /** kebab-case; becomes the slash name and the filename stem. Source of truth. */
  name: string;
  /** One-line description for /help + model auto-selection. */
  description?: string;
  /** Prompt template body (markdown). The portable core of the command. */
  prompt: string;
  /** Shown in argument completion, e.g. "[environment]". */
  argumentHint?: string;
  tools?: SurfaceToolPolicy;
  /** Model override (raw id or alias; adapters pass through or drop+warn). */
  model?: string;
  /** Force subagent / forked context where the platform supports it. */
  subtask?: boolean;
  /** Verbatim per-platform frontmatter additions (escape hatch). */
  extra?: Record<string, unknown>;
}

/** An Agent Skill (folder + SKILL.md, Agent Skills open standard). */
export interface SkillDef {
  /** <=64 chars, [a-z0-9-]; MUST equal the skill dir name. Source of truth. */
  name: string;
  /** <=1024 chars, 3rd-person "what + when"; drives model auto-selection. Required. */
  description: string;
  /** SKILL.md markdown body (instructions). */
  body: string;
  tools?: SurfaceToolPolicy;
  model?: string;
  disableModelInvocation?: boolean; // → disable-model-invocation
  /** Extra files bundled beside SKILL.md, relative path → contents. */
  resources?: Record<string, string>; // e.g. { "scripts/run.sh": "...", "references/api.md": "..." }
  extra?: Record<string, unknown>;
}

/** A named subagent (system-prompt + tool/model scoping). */
export interface SubagentDef {
  /** kebab-case identifier. Source of truth (filename stem on most platforms). */
  name: string;
  /** Delegation hint shown to the orchestrator. Required. */
  description: string;
  /** System prompt = the agent's instructions (markdown body / developer_instructions). */
  prompt: string;
  tools?: SurfaceToolPolicy;
  /** Model: alias|full-id|"inherit". Default left to platform. */
  model?: string;
  /** Coarse permission knob → Cursor readonly, opencode/kilo permission map. */
  readonly?: boolean;
  extra?: Record<string, unknown>;
}

/**
 * A standing-guidance entry ("memory") — declared ONCE; each supporting adapter
 * writes it as a MANAGED BLOCK (marker-fenced, hash-stamped,
 * uninstall-reversible — see core/managed-block.ts) into the memory/rules file
 * that host actually reads: AGENTS.md wherever the host supports the agents.md
 * standard (27/29 hosts), the host's own file (CLAUDE.md / GEMINI.md)
 * otherwise. CONTENT-ONLY like commands/skills/subagents: no runtime dispatch,
 * no telemetry wrapping — a pure, surgical file edit that never touches bytes
 * outside its own marker pair.
 */
export interface MemoryDef {
  /**
   * kebab-case identifier; default "memory". Suffixes the connector id in the
   * block marker (`<connectorId>/<name>`), so it must stay STABLE across
   * versions — renaming orphans the old block until the next sync's
   * prefix-scan reclaims it. Two entries without distinct names are a
   * ConnectorConfigError (duplicate name).
   */
  name?: string;
  /** One-line "what this guidance is for" — status/docs output only; never written to the host file. */
  description?: string;
  /**
   * The guidance markdown. Plain CommonMark, host-agnostic: no @imports, no
   * frontmatter, no host-specific syntax — it is inlined verbatim into EVERY
   * targeted host's prompt context. Budgets: ConnectorConfigError above
   * 16 KiB; install-time `warn` ChangeRecord above 4 KiB (every host pays
   * this cost on every prompt). MUST NOT contain the literal marker tokens
   * `agent-connector:begin` / `agent-connector:end` (ConnectorConfigError).
   */
  content: string;
}

/** Per-host memory tuning — the object form of {@link PlatformOverride.memory}. */
export interface PlatformMemoryOverride {
  /**
   * Override the write target file. Absolute, or resolved against the project
   * dir (project scope) / home dir (user scope). Escape hatch for org
   * conventions (e.g. "docs/AGENTS.md") or a host whose config moved.
   */
  path?: string;
  /**
   * claude-code ONLY (ignored elsewhere, with a `warn` ChangeRecord):
   *  - "block" (default): write the managed block directly into CLAUDE.md.
   *    Zero side-effects beyond the block itself.
   *  - "agents-import": write the canonical block into AGENTS.md and manage a
   *    shared `@AGENTS.md` import bridge block in CLAUDE.md — Anthropic's
   *    documented interop. NOTE: Claude then reads the ENTIRE AGENTS.md
   *    (user content included), which is why this is opt-in.
   * Regardless of mode, when CLAUDE.md already imports or symlinks AGENTS.md
   * the adapter auto-behaves as "agents-import" and never writes a duplicate
   * block into CLAUDE.md.
   */
  mode?: "block" | "agents-import";
}

// ─────────────────────────────────────────────────────────────────────────
// Telemetry (config-time options; runtime types live in telemetry/types.ts)
// ─────────────────────────────────────────────────────────────────────────

export interface TelemetryConfig {
  /** On by default. Global kill switch also via AGENT_CONNECTOR_TELEMETRY=0. */
  enabled?: boolean;
  /** Tokenizer family selection. "auto" infers from client/host. */
  modelFamilyHint?: "auto" | "openai" | "anthropic" | "generic";
  /** Tokenize tools/list schemas once → fixed per-turn tool-definition overhead. */
  measureToolDefs?: boolean;
  /** Opt-in network calibration (sends content off-box — off by default). */
  calibration?: { anthropicCountTokens?: boolean };
  /**
   * OPT-IN host-native turn-usage capture (off by default). When enabled, the
   * Gemini / Antigravity adapters ALSO install an AfterModel / PostInvocation hook
   * that reads the host's `usageMetadata` and records a DISTINCT `model_turn`
   * telemetry row (confidence `host-native`). Whole-conversation, never summed with
   * the per-MCP `call` rows. May also be forced on at install via the env switch
   * AGENT_CONNECTOR_HOST_NATIVE=1. Aggregate counts only; no raw content stored.
   */
  hostNativeUsage?: boolean;
  /** Storage backend. NDJSON (default) needs no native deps; sqlite is an upgrade. */
  store?: "ndjson" | "sqlite";
}

// ─────────────────────────────────────────────────────────────────────────
// Connector config (the public, write-once surface)
// ─────────────────────────────────────────────────────────────────────────

/** Per-platform override / escape hatch (report §3.2). */
export interface PlatformOverride {
  /**
   * false → do not install the NORMALIZED hooks on this platform; object →
   * merge/replace hooks. Does not affect `nativeHooks` below (a sibling,
   * explicitly platform-scoped declaration).
   */
  hooks?: boolean | Partial<HooksConfig>;
  /**
   * NATIVE HOOKS PASSTHROUGH — wire ANY host hook event that is not in the
   * normalized {@link HookEventName} union, keyed by the host's event name
   * VERBATIM. This immediately covers all 30 current Claude Code events (e.g.
   * TaskCreated, TaskCompleted, TeammateIdle, StopFailure, MessageDisplay,
   * WorktreeCreate/WorktreeRemove, Elicitation/ElicitationResult,
   * InstructionsLoaded, ConfigChange, FileChanged, PostCompact, …) and any
   * future event a host adds — with zero agent-connector releases.
   *
   * Scoping: per-platform-keyed, so a declaration only ever applies to the
   * platform it is declared under. Adapters without
   * {@link PlatformCapabilities.supportsNativeHooks} report a skip-warn
   * ChangeRecord at install (never silent). Declaring one of the 12 normalized
   * event names here is a ConnectorConfigError — use the normalized `hooks`
   * API for those.
   *
   * PROMOTION CRITERIA: an event graduates from nativeHooks to the normalized
   * union when ≥3 hosts ship a native analog (per the living cross-host
   * matrix); TaskCreated/TaskCompleted are the named first candidates.
   */
  nativeHooks?: Record<string, NativeHookDef>;
  /**
   * Declarative host-config key patches (set-if-absent, ownership-tracked,
   * skip-warn on ANY conflict — see {@link ConfigPatchDef} for the full fixed
   * contract). Platform-scoped by construction: a declaration only ever
   * applies to the platform it is declared under, and only adapters with
   * {@link PlatformCapabilities.supportsConfigPatch} (v1: claude-code) apply
   * it; every other adapter reports the standard skip-warn ChangeRecord with
   * the per-patch manual-edit instructions (never silent).
   */
  configPatch?: ConfigPatchDef[];
  /** false → do not register the MCP server here; object → shallow-merge into ServerDef. */
  server?: Partial<ServerDef> | false;
  /** Force a specific scope for this platform. */
  scope?: InstallScope;
  /** false → skip command files on this platform. */
  commands?: boolean;
  /** false → skip skill files on this platform. */
  skills?: boolean;
  /** false → skip subagent files on this platform. */
  subagents?: boolean;
  /**
   * false → do not write memory blocks on this platform;
   * object → per-host target/mode tuning ({@link PlatformMemoryOverride}).
   */
  memory?: boolean | PlatformMemoryOverride;
  /** Verbatim fields merged into the native config (reach platform-exclusive features). */
  extra?: Record<string, unknown>;
}

/**
 * Distribution metadata for the OFFICIAL MCP standard artifacts `package` can
 * emit — the registry `server.json` and the MCPB `.mcpb` bundle. These describe
 * the developer's REAL upstream MCP server (what a registry installer / Claude
 * Desktop runs directly), NOT agent-connector's telemetry `serve` wrapper, so
 * they need inputs the cross-platform install does not: the namespace the dev
 * proved ownership of, their published package name, and bundle author info.
 *
 * All optional — a connector that never publishes to the registry or as a
 * bundle can omit this entirely; the relevant `package --format` raises a clear,
 * actionable error only when its required field is missing.
 */
export interface PublishConfig {
  /**
   * Reverse-DNS namespace the developer OWNS, e.g. "io.github.acme" or
   * "com.acme". server.json `name` is rendered as `${registryNamespace}/${id}`.
   * agent-connector never mints a namespace on the dev's behalf — the registry
   * requires proven ownership (the `mcp-publisher login` step the dev runs).
   */
  registryNamespace?: string;
  /**
   * The developer's REAL published package that runs the MCP server, e.g.
   * "@acme/acme-db-mcp" — server.json packages[].identifier. Required to emit a
   * registry npm package entry (we cannot guess the published name).
   */
  packageName?: string;
  /** Package registry base URL. Default https://registry.npmjs.org for npm. */
  registryBaseUrl?: string;
  /** Bundle author. The MCPB manifest requires author.name. */
  author?: { name: string; email?: string; url?: string };
}

/** What a developer passes to defineConnector(). */
export interface ConnectorConfig {
  /** Stable connector id (kebab-case). Replaces context-mode's hardcoded identity. */
  id: string;
  displayName?: string;
  version?: string;
  /** The MCP server to deploy. Omit for a hooks-only connector. */
  server?: ServerDef;
  /** Lifecycle hooks. Omit for a server-only connector. */
  hooks?: HooksConfig;
  /** Telemetry options. Telemetry is ON by default even if this is omitted. */
  telemetry?: TelemetryConfig;
  /** Slash commands to deploy as native content files. */
  commands?: CommandDef[];
  /** Agent Skills to deploy as native content files. */
  skills?: SkillDef[];
  /** Named subagents to deploy as native content files. */
  subagents?: SubagentDef[];
  /**
   * Standing guidance written as managed marker blocks into each host's
   * memory/rules file (AGENTS.md-first). Omit when the connector ships none.
   */
  memory?: MemoryDef[];
  /** Per-platform overrides / escape hatches. */
  platforms?: Partial<Record<PlatformId, PlatformOverride>>;
  /** "auto" (all detected) or an explicit allow-list. Default "auto". */
  targets?: "auto" | PlatformId[];
  /** Distribution metadata for the registry server.json + MCPB bundle formats. */
  publish?: PublishConfig;
}

/**
 * A validated, normalized connector — what defineConnector() returns and what
 * adapters/CLI consume. All optional config fields are resolved to defaults.
 */
export interface ResolvedConnector {
  id: string;
  displayName: string;
  version: string;
  server?: ServerDef;
  hooks: HooksConfig;
  hookEvents: HookEventName[];
  telemetry: Required<Omit<TelemetryConfig, "calibration">> & {
    calibration: { anthropicCountTokens: boolean };
  };
  /** Normalized commands; defaults applied; [] when none. */
  commands: CommandDef[];
  /** Normalized skills; defaults applied; [] when none. */
  skills: SkillDef[];
  /** Normalized subagents; defaults applied; [] when none. */
  subagents: SubagentDef[];
  /** Normalized memory entries; names defaulted ("memory"); [] when none. */
  memory: MemoryDef[];
  platforms: Partial<Record<PlatformId, PlatformOverride>>;
  targets: "auto" | PlatformId[];
  /** Distribution metadata (registry server.json + MCPB bundle); passed through verbatim. */
  publish?: PublishConfig;
}

// ─────────────────────────────────────────────────────────────────────────
// Detection / install results / diagnostics
// ─────────────────────────────────────────────────────────────────────────

/** Result of detecting one platform on this machine. */
export interface DetectedPlatform {
  id: PlatformId;
  name: string;
  installed: boolean;
  paradigm: HookParadigm;
  capabilities: PlatformCapabilities;
  /** Native config path that would be written for `scope`. */
  configPath: string;
  scope: InstallScope;
  reason: string;
  confidence: "high" | "medium" | "low";
}

/** Runtime "which host is executing me right now" signal. */
export interface DetectionSignal {
  platform: PlatformId;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export interface ChangeRecord {
  platform: PlatformId;
  action: "create" | "update" | "skip" | "remove" | "warn";
  /** File touched (when applicable). */
  path?: string;
  detail: string;
}

export interface InstallResult {
  connectorId: string;
  dryRun: boolean;
  changes: ChangeRecord[];
  warnings: string[];
}

export interface DiagnosticResult {
  check: string;
  status: "pass" | "fail" | "warn";
  message: string;
  fix?: string;
}

/** Lightweight adapter-defined doctor check (synchronous thunk). */
export interface HealthCheck {
  readonly name: string;
  check(): { status: "OK" | "FAIL"; detail?: string };
}
