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

/** Stable identifiers for every host platform agent-connector can target. */
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
 *   - "json-stdio": host pipes JSON to a command on stdin, reads JSON/exit-code
 *     back (Claude Code, Codex, Cursor, VS Code/JetBrains Copilot, Copilot CLI,
 *     Gemini). One universal entrypoint binary handles all of them.
 *   - "ts-plugin": host loads a JS/TS module exporting lifecycle functions
 *     (OpenCode, Kilo, Hermes/python, OpenClaw). Framework generates the module.
 *   - "mcp-only": no hook layer at all (Warp, zed, Kilo-today, Pi).
 *     Only the MCP server is installed; hooks are reported unavailable.
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

/** Canonical, platform-agnostic lifecycle event names. */
export type HookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PreCompact"
  | "Stop"
  | "Notification";

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
}

/**
 * Normalized hook response. A handler returns a subset of these; the adapter
 * formats it into the host's native reply (exit codes / JSON / control fields).
 * Adapters drop fields the host cannot honor (e.g. updatedOutput where the host
 * cannot rewrite tool output) and the framework reports the degradation.
 */
export interface HookResponse {
  /**
   *  - "allow":   pass through (default when handler returns void)
   *  - "deny":    block tool execution / stop the action
   *  - "modify":  replace tool input (PreToolUse) with `updatedInput`
   *  - "context": inject `additionalContext` as soft guidance
   *  - "ask":     prompt the user to confirm
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
   * Regex string matched against the tool name (tool events only). Empty/omitted
   * matches all. Rendered into each host's native matcher syntax where supported,
   * else evaluated by the universal entrypoint at runtime.
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
  /** Can a PreToolUse hook rewrite tool arguments? */
  canModifyArgs: boolean;
  /** Can a PostToolUse hook rewrite tool output? */
  canModifyOutput: boolean;
  /** Can a hook inject context at session start / compaction? */
  canInjectSessionContext: boolean;
  /** MCP transports this host can register. */
  transports: Transport[];
  /**
   * Content-surface support (all OPTIONAL so existing adapter capability
   * literals compile unchanged; read as `?? false`). Only surface-supporting
   * adapters set these true. The BaseAdapter install/uninstall defaults
   * handle the "unsupported" skip/warn regardless of the flag.
   */
  supportsCommands?: boolean;
  supportsSkills?: boolean;
  supportsSubagents?: boolean;
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
  /** Storage backend. NDJSON (default) needs no native deps; sqlite is an upgrade. */
  store?: "ndjson" | "sqlite";
}

// ─────────────────────────────────────────────────────────────────────────
// Connector config (the public, write-once surface)
// ─────────────────────────────────────────────────────────────────────────

/** Per-platform override / escape hatch (report §3.2). */
export interface PlatformOverride {
  /** false → do not install hooks on this platform; object → merge/replace hooks. */
  hooks?: boolean | Partial<HooksConfig>;
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
  /** Verbatim fields merged into the native config (reach platform-exclusive features). */
  extra?: Record<string, unknown>;
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
  /** Per-platform overrides / escape hatches. */
  platforms?: Partial<Record<PlatformId, PlatformOverride>>;
  /** "auto" (all detected) or an explicit allow-list. Default "auto". */
  targets?: "auto" | PlatformId[];
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
  platforms: Partial<Record<PlatformId, PlatformOverride>>;
  targets: "auto" | PlatformId[];
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
