/**
 * docs-data — data-driven nav structure + field tables for the SDK docs.
 * Content is grounded in llms-full.txt and src/core/types.ts. Do not invent API.
 *
 * The docs fork into two audience TRACKS at the route level: /docs/dev (MCP
 * developer) and /docs/user (agent-CLI user). Each track owns its own sidebar
 * nav, pager order, and home page; /docs itself is the persona chooser.
 */

/* ------------------------------------------------------------------ */
/* Sidebar navigation — two audience tracks                            */
/* ------------------------------------------------------------------ */

export interface NavItem {
  /** Anchor id of the <section> this links to (also the URL :section param). */
  id: string;
  label: string;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

/**
 * The two audience tracks. NOTE: "user" and "dev" are RESERVED section ids —
 * the static /docs/user and /docs/dev track routes shadow /docs/:legacySection,
 * so a section may never be named either. Section ids are NEVER renamed
 * (legacy /docs/<id> URLs redirect 1:1 into their track), and section ids +
 * heading anchor ids must stay globally unique across BOTH tracks (they key
 * the search haystack and the cmdk value).
 */
export type TrackId = "user" | "dev";

export interface TrackDef {
  id: TrackId;
  /** Human label ("MCP developer" / "Agent-CLI user"). */
  label: string;
  /** Emoji glyph used wherever the track is named. */
  glyph: string;
  /** Route prefix for every section in this track. */
  basePath: string;
  groups: NavGroup[];
}

export const tracks: Record<TrackId, TrackDef> = {
  dev: {
    id: "dev",
    label: "MCP developer",
    glyph: "🔌",
    basePath: "/docs/dev",
    groups: [
      {
        title: "Getting Started",
        items: [
          { id: "introduction", label: "Introduction" },
          { id: "installation", label: "Installation" },
          { id: "quick-start", label: "Quick start" },
          { id: "embed-cli", label: "Embed it / branded CLI" },
        ],
      },
      {
        title: "Core API",
        items: [
          { id: "define-connector", label: "defineConnector" },
          { id: "server", label: "Server" },
          { id: "hooks", label: "Hooks" },
          { id: "surfaces", label: "Commands, Skills, Subagents & Memory" },
        ],
      },
      {
        title: "Packaging",
        items: [
          { id: "packaging", label: "Packaging & marketplaces" },
        ],
      },
      {
        title: "Telemetry",
        items: [
          { id: "telemetry-overview", label: "Overview" },
          { id: "telemetry-surfaces", label: "The 5-surface model" },
          { id: "leaderboards", label: "Leaderboards" },
          { id: "privacy", label: "Privacy & opt-out" },
        ],
      },
      {
        title: "Reference",
        items: [
          { id: "cli", label: "CLI" },
          { id: "platforms", label: "Platforms" },
        ],
      },
      {
        title: "Guides",
        items: [
          { id: "hooks-guide", label: "Hooks: cross-platform guide" },
          { id: "add-a-platform", label: "Add a platform" },
          { id: "operating-model", label: "Operating model" },
          { id: "troubleshooting", label: "Troubleshooting" },
        ],
      },
    ],
  },
  user: {
    id: "user",
    label: "Agent-CLI user",
    glyph: "🖥️",
    basePath: "/docs/user",
    groups: [
      {
        title: "Track your agent-CLI usage",
        items: [
          { id: "overview", label: "Overview & quick start" },
          { id: "usage", label: "Reports & leaderboards" },
          { id: "coverage-confidence", label: "Coverage & confidence" },
        ],
      },
    ],
  },
};

/** Canonical track iteration order (dev first — matches the chooser cards). */
export const trackIds: TrackId[] = ["dev", "user"];

/** Flat ordered section ids per track (the pager's linear reading order). */
export const trackOrder: Record<TrackId, string[]> = {
  dev: tracks.dev.groups.flatMap((g) => g.items.map((i) => i.id)),
  user: tracks.user.groups.flatMap((g) => g.items.map((i) => i.id)),
};

/** Valid section ids per track — detects unknown :section params per route. */
export const trackSectionIds: Record<TrackId, ReadonlySet<string>> = {
  dev: new Set(trackOrder.dev),
  user: new Set(trackOrder.user),
};

/** Which track owns a section id (ids are globally unique across tracks). */
export const trackOfSection: Record<string, TrackId> = Object.fromEntries(
  trackIds.flatMap((t) => trackOrder[t].map((id) => [id, t] as const)),
);

/** Canonical route of a section: /docs/<track>/<id>. */
export function sectionPath(id: string): string {
  return `/docs/${trackOfSection[id]}/${id}`;
}

export const sectionLabel: Record<string, string> = Object.fromEntries(
  trackIds.flatMap((t) =>
    tracks[t].groups.flatMap((g) =>
      g.items.map((i) => [i.id, i.label] as const),
    ),
  ),
);

/* ------------------------------------------------------------------ */
/* Legacy /docs/:section redirects                                     */
/* ------------------------------------------------------------------ */

/**
 * Every pre-track /docs/<section> URL is live on the public internet — each
 * one client-redirects (Navigate replace) into its track. Consumed by
 * LegacyDocsRedirect, which appends the URL #hash so in-page deep links
 * (e.g. /docs/hooks#claude-vs-kilo) keep working.
 */
export const legacyRedirects: Record<string, string> = {
  introduction: "/docs/dev/introduction",
  installation: "/docs/dev/installation",
  "quick-start": "/docs/dev/quick-start",
  "embed-cli": "/docs/dev/embed-cli",
  usage: "/docs/user/usage",
  "define-connector": "/docs/dev/define-connector",
  server: "/docs/dev/server",
  hooks: "/docs/dev/hooks",
  surfaces: "/docs/dev/surfaces",
  packaging: "/docs/dev/packaging",
  "telemetry-overview": "/docs/dev/telemetry-overview",
  "telemetry-surfaces": "/docs/dev/telemetry-surfaces",
  leaderboards: "/docs/dev/leaderboards",
  privacy: "/docs/dev/privacy",
  cli: "/docs/dev/cli",
  platforms: "/docs/dev/platforms",
  "hooks-guide": "/docs/dev/hooks-guide",
  "add-a-platform": "/docs/dev/add-a-platform",
  "operating-model": "/docs/dev/operating-model",
  troubleshooting: "/docs/dev/troubleshooting",
};

/**
 * Hash-aware overrides, keyed by "<id>#<hash>" and checked BEFORE
 * legacyRedirects — for the two anchors whose CONTENT moved to a different
 * page than the rest of their old section.
 */
export const legacyHashRedirects: Record<string, string> = {
  // The quick-start Track B block now lives on the user-track overview page
  // (which keeps the qs-user anchor id, so the appended hash still scrolls).
  "quick-start#qs-user": "/docs/user/overview",
  // "Coverage & confidence" is its own page now — page top IS the content.
  "usage#usage-confidence": "/docs/user/coverage-confidence",
  // The introduction's two-audience persona cards became the /docs chooser —
  // the old anchor's content lives there, not on the dev-track introduction.
  "introduction#two-audiences": "/docs",
};

/** Per-section <meta name="description"> copy (for /docs/<track>/:section deep links). */
export const sectionDescription: Record<string, string> = {
  introduction:
    "The MCP-developer track. Write your MCP server + hooks once with defineConnector and deploy natively across 29 AI-agent platforms with default local-first per-tool telemetry for your own wrapped server. Agent-CLI users author nothing — their connector-free `agent-connector usage` track is separate.",
  installation:
    "Install agent-connector as a dependency of your connector package (npm install @ken-jo/agent-connector), then ship a branded CLI or run it with npx. A global install is an optional convenience for trying the CLI directly. ESM-only, pure-JS / WASM deps, Node >=18.17, no native build.",
  "quick-start":
    "MCP developers: depend on agent-connector, write defineConnector, then ship a branded CLI or run npx @ken-jo/agent-connector to deploy their MCP everywhere — then verify with doctor, heal with upgrade, and reverse with uninstall.",
  overview:
    "Agent-CLI users: run `npx @ken-jo/agent-connector usage report` with zero setup — no defineConnector, no config file, no install — to see the token usage of the agent CLIs you already use, aggregated by CLI, model, project, session, or day.",
  "coverage-confidence":
    "Local usage readers report host-logged exact counts; a few are host-estimated (labeled in the CONFIDENCE column, e.g. Kiro char/4). Five synced platforms (cursor, antigravity, antigravity-cli, trae, warp) are reported as skipped — requires sync — unless a local cache already exists.",
  "embed-cli":
    "Embed agent-connector as an SDK and ship your own branded CLI with createConnectorCli({ name, connector }) — every subcommand is delegated and auto-scoped to your connector, so your users run <your-tool> install / leaderboard / telemetry without a global install or --connector.",
  "define-connector":
    "defineConnector(config): the write-once surface. Validates eagerly, throws ConnectorConfigError, and returns a fully-defaulted ResolvedConnector.",
  server:
    "ServerDef — a normalized, transport-polymorphic MCP server descriptor declared once and rendered into each host's native dialect.",
  hooks:
    "Declare lifecycle hooks once against the 12 normalized events (incl. PermissionRequest, PostToolUseFailure, SubagentStart, SubagentStop); the framework synthesizes the right shape per host paradigm and formats your reply. Host-only events outside the union (Claude Code alone ships 30) are reachable via the per-platform nativeHooks passthrough — raw payload in, verbatim JSON reply out.",
  "hooks-guide":
    "The precise, visible cross-platform hook map: 12 canonical events × every host, grouped by paradigm, with per-platform native names, capabilities, and a claude-code vs kilo-cli side-by-side. Hooks are the surface that varies most across platforms.",
  surfaces:
    "Slash commands, Agent Skills, and subagents as content-only files — pure file writers rendered per platform. Plus memory: standing guidance upserted as a marker-fenced, hash-stamped managed block into the memory/rules file each host actually reads — AGENTS.md on 27 of 29 hosts (the open agents.md standard), CLAUDE.md for Claude Code, GEMINI.md for Gemini CLI.",
  packaging:
    "Two ways to ship: direct install, or a packaged bundle. agent-connector package emits any of 9 marketplace/extension formats — each with its own manifest + install command — and every bundle keeps the telemetry serve-wrapper + home-bin hooks so a marketplace-installed connector still reports per-tool tokens.",
  usage:
    "Agent-CLI users (no connector): `agent-connector usage` reads each agent CLI's own session logs read-only and reports whole-conversation token totals grouped by platform, model, project, session, or day. It does NOT itemize cost per MCP server or per tool — agent CLIs don't log per-tool token attribution. Per-MCP/per-tool numbers require the MCP-developer serve-proxy telemetry track.",
  "telemetry-overview":
    "MCP-developer track. Per-MCP / per-tool token telemetry for the server YOUR connector declares and wraps: the serve proxy tokenizes input/output locally (stdio servers only — remote transports are registered but never wrapped). Aggregate counts only. To see per-CLI totals without a connector, use the connector-free `usage` command instead.",
  "telemetry-surfaces":
    "MCP-developer track. The two axes (host/user vs developer/surface) and the five developer surfaces — server, hooks (runtime) and commands, skills, subagents (static footprints) — measuring the connector's own declared+wrapped server, with the EventScope/SurfaceKind model and the per-surface leaderboard.",
  leaderboards:
    "Three origin-labeled boards that measure different things and are never summed, each with its own prerequisite: 🔌 MCP/plugin needs an MCP-developer connector + serve traffic (your own wrapped server), 🛰️ host-native turns needs the opt-in usage hook (Gemini/Antigravity only), 🖥️ host/user works with no setup. Agent-CLI users should use `usage` as the connector-free entry point.",
  privacy:
    "Local-first telemetry with zero network egress by default. Aggregate counts only — never raw arguments or results.",
  cli: "The agent-connector CLI reference: detect, install, upgrade (aliases: sync, update), uninstall, package, doctor, status, telemetry, usage, and leaderboard.",
  platforms:
    "The 29 supported hosts, grouped by hook paradigm: json-stdio, mcp-only, and ts-plugin.",
  "add-a-platform":
    "Adding a platform is one registry entry plus one adapter — the framework's core design guarantee.",
  "operating-model":
    "Home-dir-centric, single binary, per-project data. One stable home binary; native host config stays native; Windows-first.",
  troubleshooting:
    "Interpret doctor output, hooks-unavailable hosts, requires-sync usage rows, common ConnectorConfigError messages, and why telemetry can show nothing.",
};

/* ------------------------------------------------------------------ */
/* Field-table rows                                                    */
/* ------------------------------------------------------------------ */

export interface FieldRow {
  name: string;
  type: string;
  default?: string;
  required?: boolean;
  notes: string;
}

/** ConnectorConfig — the write-once surface (llms-full §2.1). */
export const connectorConfigFields: FieldRow[] = [
  {
    name: "id",
    type: "string",
    required: true,
    notes:
      "Stable connector id. Must match ^[a-z0-9][a-z0-9-]*$ (kebab-case).",
  },
  { name: "displayName", type: "string", default: "id", notes: "Human label." },
  {
    name: "version",
    type: "string",
    default: '"0.0.0"',
    notes: "Connector version.",
  },
  {
    name: "server",
    type: "ServerDef",
    notes:
      "The MCP server to deploy. Omit for a hooks-only / content-only connector.",
  },
  {
    name: "hooks",
    type: "HooksConfig",
    default: "{}",
    notes: "Lifecycle hooks. Omit for a server-only connector.",
  },
  {
    name: "telemetry",
    type: "TelemetryConfig",
    default: "(defaults)",
    notes: "Telemetry is ON even if omitted.",
  },
  {
    name: "commands",
    type: "CommandDef[]",
    default: "[]",
    notes: "Slash commands → native content files.",
  },
  {
    name: "skills",
    type: "SkillDef[]",
    default: "[]",
    notes: "Agent Skills → native content files.",
  },
  {
    name: "subagents",
    type: "SubagentDef[]",
    default: "[]",
    notes: "Named subagents → native content files.",
  },
  {
    name: "memory",
    type: "MemoryDef[]",
    default: "[]",
    notes:
      "Standing guidance → marker-fenced managed blocks in each host's memory/rules file (AGENTS.md-first; CLAUDE.md / GEMINI.md exceptions).",
  },
  {
    name: "platforms",
    type: "Partial<Record<PlatformId, PlatformOverride>>",
    default: "{}",
    notes:
      "Per-platform overrides / escape hatch (extra, nativeHooks, configPatch, memory target/mode tuning, disable a surface, force scope).",
  },
  {
    name: "targets",
    type: '"auto" | PlatformId[]',
    default: '"auto"',
    notes: '"auto" = all detected; or an explicit allow-list.',
  },
  {
    name: "publish",
    type: "PublishConfig",
    notes:
      'Distribution metadata for the official MCP standard artifacts (package --format mcp-server-json | mcpb): { registryNamespace? (reverse-DNS namespace you own, e.g. "io.github.acme"; server.json name = <namespace>/<id>), packageName? (your REAL published package, e.g. "@acme/db-mcp"), registryBaseUrl? (default https://registry.npmjs.org), author? ({ name, email?, url? } — MCPB requires author.name) }. Describes your real upstream server, NOT the serve wrapper; optional — each format errors only when its required field is missing.',
  },
];

/**
 * ResolvedConnector — what defineConnector returns (core/types.ts §ResolvedConnector).
 * Every optional ConnectorConfig field is resolved to a concrete value here.
 */
export const resolvedConnectorFields: FieldRow[] = [
  {
    name: "id",
    type: "string",
    required: true,
    notes: "The validated kebab-case id, passed through unchanged.",
  },
  {
    name: "displayName",
    type: "string",
    required: true,
    notes: "Resolved to id when not supplied.",
  },
  {
    name: "version",
    type: "string",
    required: true,
    notes: 'Resolved to "0.0.0" when not supplied.',
  },
  {
    name: "server",
    type: "ServerDef",
    notes: "Normalized ServerDef; omitted entirely for a hooks/content-only connector.",
  },
  {
    name: "hooks",
    type: "HooksConfig",
    required: true,
    notes: "Always present ({} when none declared).",
  },
  {
    name: "hookEvents",
    type: "HookEventName[]",
    required: true,
    notes:
      "Derived list of the events that have a function handler — what adapters install.",
  },
  {
    name: "telemetry",
    type: "Required<TelemetryConfig>",
    required: true,
    notes:
      "Fully-resolved: { enabled, modelFamilyHint, measureToolDefs, hostNativeUsage, store, calibration: { anthropicCountTokens } }.",
  },
  {
    name: "commands",
    type: "CommandDef[]",
    required: true,
    notes: "Normalized; [] when none.",
  },
  {
    name: "skills",
    type: "SkillDef[]",
    required: true,
    notes: "Normalized; [] when none.",
  },
  {
    name: "subagents",
    type: "SubagentDef[]",
    required: true,
    notes: "Normalized; [] when none.",
  },
  {
    name: "memory",
    type: "MemoryDef[]",
    required: true,
    notes: 'Normalized; names defaulted ("memory"); [] when none.',
  },
  {
    name: "platforms",
    type: "Partial<Record<PlatformId, PlatformOverride>>",
    required: true,
    notes: "Always present ({} when none declared).",
  },
  {
    name: "targets",
    type: '"auto" | PlatformId[]',
    required: true,
    notes: 'Resolved to "auto" when not supplied.',
  },
  {
    name: "publish",
    type: "PublishConfig",
    notes:
      "Passed through verbatim when supplied (omitted otherwise) — distribution metadata consumed by package --format mcp-server-json | mcpb.",
  },
];

/** ServerDef fields (llms-full §2.2). */
export const serverDefFields: FieldRow[] = [
  {
    name: "transport",
    type: '"stdio" | "http" | "sse" | "ws"',
    required: true,
    notes: "Selects the dialect each adapter renders.",
  },
  {
    name: "command",
    type: "string",
    notes: "Required for stdio transport.",
  },
  { name: "args", type: "string[]", notes: "Process arguments (stdio)." },
  {
    name: "env",
    type: "Record<string, string>",
    notes: "Values support ${env:VAR} / ${env:VAR:-default} interpolation.",
  },
  { name: "cwd", type: "string", notes: "Working directory (stdio)." },
  {
    name: "url",
    type: "string",
    notes: "Required for remote transport (http | sse | ws).",
  },
  {
    name: "headers",
    type: "Record<string, string>",
    notes: "Sent on remote requests.",
  },
  {
    name: "auth",
    type: "AuthSpec",
    notes: '{ type: "oauth" | "bearerEnv" | "none", bearerEnvVar? }.',
  },
  {
    name: "tools",
    type: "ToolFilter",
    default: '{ include: ["*"] }',
    notes: "Glob/exact include / exclude tool names.",
  },
  { name: "timeoutMs", type: "number", notes: "Per-call timeout." },
  {
    name: "enabled",
    type: "boolean",
    default: "true",
    notes: "When false, written disabled where the host supports it.",
  },
  {
    name: "wrapForTelemetry",
    type: "boolean",
    default: "true (stdio) / false (remote)",
    notes:
      "Wrap with agent-connector serve so per-tool telemetry is captured. Remote transports can't be intercepted.",
  },
];

/** Normalized hook events (llms-full §2.3). */
export const hookEventRows: { event: string; payload: string }[] = [
  {
    event: "SessionStart",
    payload: 'source: "startup" | "compact" | "resume" | "clear"',
  },
  { event: "SessionEnd", payload: "reason?: string" },
  { event: "UserPromptSubmit", payload: "prompt: string" },
  {
    event: "PreToolUse",
    payload: "toolName: string, toolInput: Record<string, unknown>",
  },
  {
    event: "PostToolUse",
    payload: "toolName, toolInput, toolOutput?: string, isError?: boolean",
  },
  { event: "PreCompact", payload: 'trigger?: "auto" | "manual"' },
  { event: "Stop", payload: "stopHookActive?: boolean" },
  { event: "Notification", payload: "message: string" },
  {
    event: "PermissionRequest",
    payload:
      "toolName, toolInput, permissionSuggestions?: unknown[] (host dialog suggestions, passthrough)",
  },
  {
    event: "PostToolUseFailure",
    payload:
      "toolName, toolInput, toolUseId?, error: string, isInterrupt?: boolean, durationMs?: number",
  },
  { event: "SubagentStart", payload: "agentId?: string, agentType?: string" },
  {
    event: "SubagentStop",
    payload:
      "agentId?, agentType?, agentTranscriptPath?, lastAssistantMessage?, stopHookActive?",
  },
];

/** HookResponse fields (llms-full §2.3 / types.ts). */
export const hookResponseFields: FieldRow[] = [
  {
    name: "decision",
    type: '"allow" | "deny" | "modify" | "context" | "ask"',
    notes: "Drives the host's native reply. Default allow (handler returns void).",
  },
  {
    name: "reason",
    type: "string",
    notes: "Shown to the model/user; expected for deny / ask.",
  },
  {
    name: "updatedInput",
    type: "Record<string, unknown>",
    notes:
      'Replacement tool input — only with "modify" (PreToolUse / PermissionRequest).',
  },
  {
    name: "additionalContext",
    type: "string",
    notes: 'Injected as soft guidance — with "context" or on SessionStart.',
  },
  {
    name: "updatedOutput",
    type: "string",
    notes: "Rewritten tool output — PostToolUse only, where the host supports it.",
  },
];

/** HookResponse decision semantics. */
export const decisionSemantics: { decision: string; meaning: string }[] = [
  {
    decision: "allow",
    meaning:
      "Pass through (default when the handler returns void). On PermissionRequest ONLY, an explicit allow is an ACTIVE grant that suppresses the host's permission dialog (a void return falls through to the native dialog).",
  },
  {
    decision: "deny",
    meaning:
      "Block the tool call / stop the action. On SubagentStop this keeps the subagent running with reason as its next instruction (Stop semantics); on the feedback-only events (PostToolUseFailure, SubagentStart) it degrades to context carrying the reason.",
  },
  {
    decision: "modify",
    meaning:
      "Replace tool input with updatedInput (PreToolUse / PermissionRequest).",
  },
  {
    decision: "context",
    meaning:
      "Inject additionalContext as soft guidance (on SubagentStart it lands in the SUBAGENT's conversation, before its first prompt).",
  },
  {
    decision: "ask",
    meaning:
      "Prompt the user to confirm. On PermissionRequest this falls through to the native dialog (the dialog IS the ask).",
  },
];

/** The 3 hook paradigms (llms-full §2.3 / §6). */
export const paradigmRows: {
  id: string;
  label: string;
  count: number;
  description: string;
}[] = [
  {
    id: "json-stdio",
    label: "json-stdio",
    count: 16,
    description:
      "Host pipes JSON to a command on stdin and reads JSON / exit-code back. One universal entrypoint (agent-connector hook <platform> <event> --connector <id>) reads the payload, normalizes it, runs your handler, and formats the reply.",
  },
  {
    id: "ts-plugin",
    label: "ts-plugin",
    count: 4,
    description:
      "Host loads a framework-generated JS/TS module exporting lifecycle functions that import your handler — the native shape these hosts expect.",
  },
  {
    id: "mcp-only",
    label: "mcp-only",
    count: 9,
    description:
      "No hook layer; only the MCP server is installed and hooks are reported unavailable for that host.",
  },
];

/* ------------------------------------------------------------------ */
/* Content surface field tables (llms-full §2.4)                        */
/* ------------------------------------------------------------------ */

export const commandDefFields: FieldRow[] = [
  {
    name: "name",
    type: "string",
    required: true,
    notes: "kebab-case; slash name + filename stem (source of truth).",
  },
  {
    name: "description",
    type: "string",
    notes: "One-line, for /help + model auto-selection.",
  },
  {
    name: "prompt",
    type: "string",
    required: true,
    notes: "Markdown prompt template body (non-empty).",
  },
  { name: "argumentHint", type: "string", notes: 'e.g. "[environment]".' },
  {
    name: "tools",
    type: "SurfaceToolPolicy",
    notes: "{ allow?: string[]; deny?: string[] }.",
  },
  {
    name: "model",
    type: "string",
    notes: "Raw id or alias; adapters pass through or drop + warn.",
  },
  {
    name: "subtask",
    type: "boolean",
    notes: "Force subagent / forked context where supported.",
  },
  {
    name: "extra",
    type: "Record<string, unknown>",
    notes: "Verbatim per-platform frontmatter additions.",
  },
];

export const skillDefFields: FieldRow[] = [
  {
    name: "name",
    type: "string",
    required: true,
    notes: "<=64 chars, [a-z0-9-]; MUST equal the skill dir name.",
  },
  {
    name: "description",
    type: "string",
    required: true,
    notes: '<=1024 chars, 3rd-person "what + when" (drives auto-selection).',
  },
  {
    name: "body",
    type: "string",
    required: true,
    notes: "SKILL.md markdown body (non-empty).",
  },
  { name: "tools", type: "SurfaceToolPolicy", notes: "Allowed / denied tools." },
  { name: "model", type: "string", notes: "Model override." },
  {
    name: "disableModelInvocation",
    type: "boolean",
    notes: "→ disable-model-invocation.",
  },
  {
    name: "resources",
    type: "Record<string, string>",
    notes: "relpath → contents, bundled beside SKILL.md (safe paths only).",
  },
  { name: "extra", type: "Record<string, unknown>", notes: "Escape hatch." },
];

export const subagentDefFields: FieldRow[] = [
  {
    name: "name",
    type: "string",
    required: true,
    notes: "kebab-case; filename stem on most platforms.",
  },
  {
    name: "description",
    type: "string",
    required: true,
    notes: "Delegation hint (non-empty).",
  },
  {
    name: "prompt",
    type: "string",
    required: true,
    notes: "System prompt / instructions (non-empty).",
  },
  { name: "tools", type: "SurfaceToolPolicy", notes: "Allowed / denied tools." },
  {
    name: "model",
    type: "string",
    notes: 'alias | full-id | "inherit".',
  },
  {
    name: "readonly",
    type: "boolean",
    notes: "Coarse permission knob (Cursor readonly, opencode/kilo perms).",
  },
  { name: "extra", type: "Record<string, unknown>", notes: "Escape hatch." },
];

export const memoryDefFields: FieldRow[] = [
  {
    name: "name",
    type: "string",
    default: '"memory"',
    notes:
      "kebab-case; suffixes the connector id in the block marker (<connectorId>/<name>) — keep it STABLE across versions.",
  },
  {
    name: "description",
    type: "string",
    notes: "Status/docs output only; never written to the host file.",
  },
  {
    name: "content",
    type: "string",
    required: true,
    notes:
      "Plain CommonMark, host-agnostic (no @imports, no frontmatter) — inlined verbatim into every targeted host's prompt context. Hard 16 KiB cap (ConnectorConfigError); soft 4 KiB install-time warn; must not contain the literal marker tokens.",
  },
];

/**
 * Memory write targets (llms-full §2.4): the AGENTS.md-first policy plus the
 * two documented exception hosts.
 */
export const memoryTargetRows: {
  host: string;
  project: string;
  user: string;
  note: string;
}[] = [
  {
    host: "27 AGENTS.md adopter hosts",
    project:
      "<projectDir>/AGENTS.md — exclusive/first-match readers are probed so the block lands where the host actually reads (zed's nine-candidate first-match, warp's WARP.md priority, hermes' .hermes.md, opencode's CLAUDE.md fallback, codex's AGENTS.override.md; openclaw → its agent workspace)",
    user:
      "the host's documented global memory file: AGENTS.md where one exists (e.g. ~/.codex/AGENTS.md, ~/.config/zed/AGENTS.md, ~/.config/amp/AGENTS.md, ~/.factory/AGENTS.md), else the host's own file (~/.qwen/QWEN.md, goose .goosehints, ~/.copilot/copilot-instructions.md, kilo/roo/kiro rules-dir agent-connector.md) — else skip-warn",
    note:
      "One canonical copy in the open agents.md standard file; convergent writes dedupe via the content hash (first adapter writes, the rest skip). Hosts whose user rules are app/UI-managed (cursor, warp, trae, jetbrains-copilot, …) skip-warn at user scope.",
  },
  {
    host: "claude-code",
    project: "<projectDir>/CLAUDE.md",
    user: "~/.claude/CLAUDE.md",
    note:
      'Official docs: "Claude Code reads CLAUDE.md, not AGENTS.md". HTML-comment markers are stripped from the model\'s context — invisible to Claude, still parseable for sync/doctor/uninstall. Opt-in memory.mode: "agents-import" writes AGENTS.md + a managed @AGENTS.md import bridge in CLAUDE.md; pre-existing user imports/symlinks are auto-detected and respected.',
  },
  {
    host: "gemini-cli",
    project: "<projectDir>/GEMINI.md",
    user: "~/.gemini/GEMINI.md",
    note:
      'AGENTS.md is targeted instead when the user\'s context.fileName setting includes "AGENTS.md" — probed and respected, never edited by agent-connector.',
  },
];

/** Per-platform surface support (llms-full §2.4). */
export const surfaceSupportRows: {
  platform: string;
  command: string;
  skill: string;
  subagent: string;
}[] = [
  {
    platform: "claude-code",
    command: ".claude/commands/<n>.md",
    skill: ".claude/skills/<n>/SKILL.md",
    subagent: ".claude/agents/<n>.md",
  },
  {
    platform: "gemini-cli",
    command: ".gemini/commands/<n>.toml",
    skill: ".gemini/skills/<n>/SKILL.md",
    subagent: ".gemini/agents/<n>.md",
  },
  {
    platform: "qwen-code",
    command: ".qwen/commands/<n>.toml",
    skill: "—",
    subagent: ".qwen/agents/<n>.md",
  },
  {
    platform: "vscode-copilot (+ jetbrains)",
    command: ".github/prompts/<n>.prompt.md",
    skill: ".github/skills/<n>/SKILL.md",
    subagent: ".github/agents/<n>.agent.md (vscode only — jetbrains skips+warns)",
  },
  {
    platform: "copilot-cli",
    command: "—",
    skill: ".github/skills/<n>/SKILL.md",
    subagent: "~/.copilot/agents/<n>.agent.md",
  },
  {
    platform: "cursor",
    command: ".cursor/commands/<n>.md (body-only)",
    skill: ".cursor/skills/<n>/SKILL.md",
    subagent: ".cursor/agents/<n>.md",
  },
  {
    platform: "codex",
    command: "~/.codex/prompts/<n>.md (user-only)",
    skill: ".codex/skills/<n>/SKILL.md",
    subagent: ".codex/agents/<n>.toml",
  },
  {
    platform: "opencode",
    command: ".opencode/commands/<n>.md",
    skill: ".opencode/skills/<n>/SKILL.md",
    subagent: ".opencode/agent/<n>.md",
  },
  {
    platform: "kilo",
    command: ".kilocode/commands/<n>.md",
    skill: "—",
    subagent: ".kilocode/agents/<n>.md",
  },
  {
    platform: "pi",
    command: "—",
    skill: ".pi/skills/<n>/SKILL.md",
    subagent: "—",
  },
  {
    platform: "antigravity (+ antigravity-cli)",
    command:
      ".agent/workflows/<n>.md (project; user → ~/.gemini/antigravity/global_workflows/<n>.md)",
    skill: ".agents/skills/<n>/SKILL.md",
    subagent: "—",
  },
  { platform: "all others", command: "—", skill: "—", subagent: "—" },
];

/* ------------------------------------------------------------------ */
/* TelemetryConfig (llms-full §2.5)                                     */
/* ------------------------------------------------------------------ */

export const telemetryConfigFields: FieldRow[] = [
  {
    name: "enabled",
    type: "boolean",
    default: "true",
    notes: "AGENT_CONNECTOR_TELEMETRY=0 also kills it.",
  },
  {
    name: "modelFamilyHint",
    type: '"auto" | "openai" | "anthropic" | "generic"',
    default: '"auto"',
    notes: "Tokenizer family selection; auto infers from client/host.",
  },
  {
    name: "measureToolDefs",
    type: "boolean",
    default: "true",
    notes: "Tokenize tools/list once → fixed per-turn tool-definition overhead.",
  },
  {
    name: "calibration",
    type: "{ anthropicCountTokens?: boolean }",
    default: "false",
    notes: "Opt-in network calibration (sends content off-box).",
  },
  {
    name: "hostNativeUsage",
    type: "boolean",
    default: "false",
    notes:
      "Opt-in host-native turn capture. Also forced via AGENT_CONNECTOR_HOST_NATIVE=1.",
  },
  {
    name: "store",
    type: '"ndjson" | "sqlite"',
    default: '"ndjson"',
    notes: "NDJSON needs no native deps; sqlite is a drop-in upgrade.",
  },
];

/** Telemetry confidence sources (llms-full §5). */
export const confidenceSources: { source: string; meaning: string }[] = [
  {
    source: "tokenizer-exact",
    meaning:
      "Local gpt-tokenizer match for the host's family (o200k_base).",
  },
  {
    source: "tokenizer-approx",
    meaning:
      "o200k_base used as a documented approximation for Anthropic-family (no offline Claude tokenizer ships).",
  },
  {
    source: "heuristic",
    meaning:
      "chars/4 fallback with content-type multipliers; never tokenizes base64; explicitly labeled.",
  },
  {
    source: "tokenizer-calibrated",
    meaning:
      "Opt-in Anthropic count_tokens sampler (sends content off-box) refines a row.",
  },
  {
    source: "host-native",
    meaning:
      "Real host usage (e.g. Gemini usageMetadata.totalTokenCount) via the opt-in AfterModel hook.",
  },
];

/* ------------------------------------------------------------------ */
/* PlatformOverride (llms-full §2.6)                                    */
/* ------------------------------------------------------------------ */

export const platformOverrideFields: FieldRow[] = [
  {
    name: "hooks",
    type: "boolean | Partial<HooksConfig>",
    notes: "false → no NORMALIZED hooks here; object → merge / replace.",
  },
  {
    name: "nativeHooks",
    type: "Record<string, NativeHookDef>",
    notes:
      "Native passthrough — wire ANY host hook event outside the 12 normalized ones, keyed by the host's event name verbatim. Raw payload in, verbatim JSON reply out (exit 0 only). claude-code only today; other adapters skip-warn.",
  },
  {
    name: "configPatch",
    type: "ConfigPatchDef[]",
    notes:
      "Declarative host-config key patches for host-exclusive settings keys extra can't reach (e.g. Claude Code statusLine). Fixed semantics: set-if-absent on a dotted leaf key, skip-warn on ANY conflict, refcounted ownership ledger, reversible uninstall. claude-code only today; other adapters skip-warn with the manual edit.",
  },
  {
    name: "server",
    type: "Partial<ServerDef> | false",
    notes: "false → don't register server here; object → shallow-merge.",
  },
  {
    name: "scope",
    type: "InstallScope",
    notes: "Force a scope for this platform.",
  },
  { name: "commands", type: "boolean", notes: "false → skip command files here." },
  { name: "skills", type: "boolean", notes: "false → skip skill files here." },
  {
    name: "subagents",
    type: "boolean",
    notes: "false → skip subagent files here.",
  },
  {
    name: "memory",
    type: "boolean | PlatformMemoryOverride",
    notes:
      'false → no memory block on this host; object → { path? (override the target file), mode? ("block" | "agents-import" — claude-code only, ignored elsewhere with a warn) }.',
  },
  {
    name: "extra",
    type: "Record<string, unknown>",
    notes: "Verbatim fields merged into the native config.",
  },
];

/**
 * ConfigPatchDef — one declarative, ownership-tracked patch of a
 * host-exclusive config key (llms-full §2.6). Semantics are FIXED:
 * set-if-absent on a single leaf key, skip-warn on ANY conflict.
 */
export const configPatchFields: FieldRow[] = [
  {
    name: "key",
    type: "string",
    required: true,
    notes:
      'Dotted LEAF path into the adapter\'s one patchable file, e.g. "statusLine" or "env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS". Segments match [A-Za-z0-9_-]+ — no dots-in-key, no array indices. Keys agent-connector already models (hooks*, mcpServers*) are rejected at defineConnector; the claude-code sensitive-key denylist (permissions*, allowedTools*, apiKey*, env.ANTHROPIC_*, token/key/secret/proxy env vars, auth/login keys) is hard-refused.',
  },
  {
    name: "value",
    type: "JsonValue",
    required: true,
    notes:
      "Written ONLY when the key is absent; ${env:VAR} refs resolve at install time. May be an object/array but is written atomically as the leaf — never merged into.",
  },
  {
    name: "reason",
    type: "string",
    required: true,
    notes:
      "Human-readable why — printed in the install diff, every ChangeRecord, and every skip-warn (one declaration doubles as its own documented manual edit).",
  },
  {
    name: "docsUrl",
    type: "string",
    notes:
      "Docs link appended to the manual-edit fallback printed on skip / conflict / unsupported host.",
  },
];

/* ------------------------------------------------------------------ */
/* CLI reference (llms-full §3)                                         */
/* ------------------------------------------------------------------ */

export interface CliCommand {
  name: string;
  signature: string;
  summary: string;
  flags?: { flag: string; desc: string }[];
}

export const cliCommands: CliCommand[] = [
  {
    name: "detect",
    signature: "agent-connector detect [--project <dir>] [--json]",
    summary:
      "Probes every registered adapter and prints, per installed host: name, id, hook paradigm, install scope, the native config path that would be written, confidence + reason, and a one-line capabilities summary. --json emits the raw DetectedPlatform[].",
  },
  {
    name: "install",
    signature:
      "agent-connector install [--method direct|marketplace] [--scope user|project] [--targets …] [--connector <path>] [--project <dir>] [--dry-run] [--force]",
    summary:
      "Per target: backup settings → render server config → if hooks & paradigm≠mcp-only, synthesize the entrypoint + write hook config + set exec bit → write command/skill/subagent files → upsert memory managed blocks (last among the content surfaces) → register in the plugin registry. Prints a readable diff plus warnings and a summary tally. Idempotent and reversible. --method marketplace (v1: claude-code) drives the host's own plugin flow instead — stage the bundle, register a local marketplace, `claude plugin install` — with a guard refusing a double install by both methods; `uninstall --method auto` reverses whichever is present. --force overwrites USER-EDITED memory blocks (hash drift) after a timestamped backup; default is warn-and-leave. Exit code 1 if any change is a warn, else 0.",
  },
  {
    name: "upgrade",
    signature: "agent-connector upgrade [--channel stable|latest] [same flags as install]",
    summary:
      "The single “bring everything current” verb (aliases: update, sync). Re-renders the connector into every target host idempotently (byte-identical entries report skip — this is also the self-heal path: run upgrade to repair a drifted install), then refreshes the stable home-bin pointer and prints managed update guidance (the exact npm i -g @ken-jo/agent-connector@<dist>). With no resolvable connector it does the tool-only refresh from anywhere. Never silently auto-updates. Same diff output + exit semantics as install for the re-render; exit 1 if the pointer refresh fails.",
  },
  {
    name: "uninstall",
    signature:
      "agent-connector uninstall [--connector-id <id>] [--connector <path>] [--scope …] [--targets …] [--project <dir>] [--dry-run] [--purge]",
    summary:
      "Full inverse — excises memory managed blocks FIRST (a prefix scan over the connector's marker namespace plus the memory ledger, so even an id-only uninstall reclaims blocks; user-edited blocks are backed up before removal), then removes the connector's MCP + hook registrations and content files from every resolved target, using registered metadata so it works even when the source module is gone. The id comes from --connector-id, else inferred from the local config. With --purge it also removes the connector's ~/.agent-connector state record and, when no connectors remain, the shared home-bin launcher; without it the record lingers so the connector can be re-synced without re-registering.",
  },
  {
    name: "doctor",
    signature:
      "agent-connector doctor [--targets …] [--connector <path>] [--scope user|project] [--project <dir>] [--json] [--probe]",
    summary:
      "For each detected host (or --targets), loads its adapter, builds an InstallContext, and runs the adapter's doctor checks; prints [pass] / [warn] / [FAIL] with any suggested fix. Non-zero exit if any check FAILs (warns alone do not fail). With --probe it also spawns the connector's REAL stdio server and runs a live MCP handshake (initialize → negotiated protocolVersion + capabilities + serverInfo → ping → tools/list); probe FAILs fold into the exit code.",
  },
  {
    name: "status",
    signature:
      "agent-connector status [--connector <path>] [--scope user|project] [--project <dir>] [--json]",
    summary:
      "A light, glanceable install-state summary: one line per detected host showing which connectors are present (server / hooks). There is no MCP standard for local install state, so this is agent-connector infra — it reuses detect + a read-only config-present check, adds no adapter methods, and ALWAYS exits 0 (descriptive, never a gate — that contrast with doctor is why it exists).",
  },
  {
    name: "package",
    signature:
      "agent-connector package [--connector <path>] [--format <fmt>] [--out <dir>] [--project <dir>] [--dry-run]",
    summary:
      "Emit a marketplace / extension-installable bundle from a connector. Resolves the config (--connector, else auto-discovered walking up from --project), packages it for --format into --out (default <cwd>/dist-plugin), and prints the emitted file tree plus per-format install instructions. Every bundle re-renders the SAME command/skill/subagent markdown the live adapters write, the home-bin hooks, and the serve-wrapped MCP entry (--host <platform>) — so a marketplace-installed connector still reports per-tool telemetry.",
    flags: [
      {
        flag: "--format <fmt>",
        desc: 'One of the host plugin/marketplace formats (default claude-plugin), or "all" to emit every feasible host format into <out>/<fmt>/. Two OFFICIAL MCP standard artifacts are also available by name — mcp-server-json (a registry server.json) and mcpb (an MCPB bundle manifest) — but require a `publish` block, so they are opt-in and excluded from `all`. An invalid --format exits 2.',
      },
      {
        flag: "--out <dir>",
        desc: "Output directory (default <cwd>/dist-plugin). For --format all, each format writes to <out>/<format>/.",
      },
      {
        flag: "--dry-run",
        desc: "Compute the file tree without writing anything.",
      },
    ],
  },
  {
    name: "telemetry",
    signature:
      "agent-connector telemetry <report|export|leaderboard> [flags]",
    summary:
      "Per-MCP token telemetry (the server's own bytes). Rows are aggregate counts only.",
    flags: [
      {
        flag: "report --by tool|session|project --since <window> --connector <id> [--json]",
        desc: "Ranked footprint table (default --by tool).",
      },
      {
        flag: "export --format csv|json --out <file> --since … --connector <id>",
        desc: "Raw aggregate records (stdout or to --out).",
      },
      {
        flag: "leaderboard --by mcp|tool|surface --since … --connector <id> --scope <slice> [--json]",
        desc: 'Ranks per-connector ("which MCP costs the most"), per-tool, or per-surface (the 5 developer-axis surfaces).',
      },
    ],
  },
  {
    name: "usage",
    signature: "agent-connector usage <report|export|leaderboard> [flags]",
    summary:
      "Host-native token usage parsed read-only from each agent CLI's own session logs/DBs (complement to telemetry; the two are NOT summed). Aggregate counts only.",
    flags: [
      {
        flag: "report --by platform|project|session|model|day --since … --platform <id> [--json]",
        desc: "Aggregated table; prints skip notes for platforms requiring a sync.",
      },
      {
        flag: "export --format csv|json --out <file> --since … --platform <id>",
        desc: "Deduped records.",
      },
      {
        flag: "leaderboard --by platform|model --since … --platform <id> [--json]",
        desc: 'The host/user leaderboard ("which CLI/host spent the most").',
      },
    ],
  },
  {
    name: "leaderboard",
    signature:
      "agent-connector leaderboard [--since <window>] [--scope <slice>] [--connector <id>] [--json]",
    summary:
      "Prints THREE origin-labeled leaderboards that measure DIFFERENT things and are NEVER summed: 🔌 MCP/Plugin (mcp-self), 🖥️ Host/User (host-scan-logs), 🛰️ Host-native turns (host-native-live). --scope slices only the MCP section; --connector <id> restricts the MCP and host-native sections to one connector (the host-scan section is connector-agnostic); --json emits { mcp, host, hostSkipped, hostNativeTurns }.",
  },
];

export const internalEntrypoints: { signature: string; desc: string }[] = [
  {
    signature: "agent-connector hook <platform> <event> --connector <id>",
    desc: "Universal json-stdio hook entrypoint. Reads the whole host payload from stdin, dispatches runHook, writes stdout/stderr, exits with the adapter's exit code. Fail-open (never rejects).",
  },
  {
    signature:
      "agent-connector serve --connector <id> [--scope user|project] [--host <platformId>] -- <command> [args…]",
    desc: "Telemetry-wrapping MCP stdio proxy. Splits argv at the first literal --; the real server invocation on the right is passed through verbatim. Tolerant flag parsing (strict:false). --host bakes the install-target platform id in so telemetry rows stamp hostPlatform correctly under headless spawns.",
  },
  {
    signature: "agent-connector usage-event <platform> --connector <id>",
    desc: "HIDDEN opt-in host-native turn-usage hook (installed by Gemini / Antigravity adapters when host-native usage is enabled). Reads stdin, records a distinct model_turn row, ALWAYS exits 0 (fail-open).",
  },
];

export const sharedFlags: { flag: string; desc: string }[] = [
  { flag: "--scope user|project", desc: "Install scope (default user)." },
  { flag: "--targets a,b,c", desc: "Comma-separated PlatformId allow-list." },
  { flag: "--connector <path>", desc: "Explicit config module." },
  { flag: "--project <dir>", desc: "Project directory (defaults to cwd)." },
  { flag: "--dry-run", desc: "Render and diff without writing." },
  { flag: "--json", desc: "Emit machine-readable output (where noted)." },
];

/* ------------------------------------------------------------------ */
/* Platforms (29, by paradigm — llms-full §6)                           */
/* ------------------------------------------------------------------ */

export interface PlatformEntry {
  name: string;
  id: string;
  target: string;
}

export const jsonStdioPlatforms: PlatformEntry[] = [
  {
    name: "Claude Code",
    id: "claude-code",
    target: "~/.claude.json / .mcp.json → mcpServers (hooks in settings.json)",
  },
  {
    name: "Codex CLI",
    id: "codex",
    target: "~/.codex/config.toml → [mcp_servers.*] (hooks in hooks.json)",
  },
  {
    name: "Cursor",
    id: "cursor",
    target: ".cursor/mcp.json → mcpServers (hooks in hooks.json)",
  },
  { name: "VS Code Copilot", id: "vscode-copilot", target: ".vscode/mcp.json → servers" },
  {
    name: "JetBrains Copilot",
    id: "jetbrains-copilot",
    target: "shares the GitHub Copilot .github/ files",
  },
  { name: "GitHub Copilot CLI", id: "copilot-cli", target: "mcp.json → mcpServers" },
  {
    name: "Gemini CLI",
    id: "gemini-cli",
    target: ".gemini/ → mcpServers (opt-in host-native AfterModel usage)",
  },
  { name: "Qwen CLI", id: "qwen-code", target: ".qwen/ → mcpServers" },
  { name: "Kiro", id: "kiro", target: "mcpServers" },
  { name: "Kimi CLI", id: "kimi", target: "mcpServers" },
  { name: "Crush", id: "crush", target: "crush.json → mcp (root key, not mcpServers)" },
  { name: "Goose", id: "goose", target: "host config" },
  { name: "Hermes", id: "hermes", target: "host config" },
  {
    name: "Droid (Factory)",
    id: "droid",
    target: "~/.factory/mcp.json → mcpServers (hooks in ~/.factory/hooks.json)",
  },
  {
    name: "Antigravity (IDE)",
    id: "antigravity",
    target: "~/.gemini/antigravity/mcp_config.json → mcpServers (hooks.json)",
  },
  {
    name: "Antigravity CLI (agy)",
    id: "antigravity-cli",
    target: "shares ~/.gemini/antigravity/",
  },
];

export const mcpOnlyPlatforms: PlatformEntry[] = [
  {
    name: "Warp",
    id: "warp",
    target: "~/.warp/.mcp.json → mcpServers (cwd keyed as working_directory)",
  },
  { name: "Kilo", id: "kilo", target: ".kilocode mcp config" },
  { name: "Roo Code", id: "roo-code", target: "mcp config" },
  { name: "Trae", id: "trae", target: "mcp config" },
  { name: "Zed", id: "zed", target: "host config" },
  { name: "Amp", id: "amp", target: 'settings.json → "amp.mcpServers" (flat dotted key)' },
  { name: "Codebuff", id: "codebuff", target: "mcp.json → mcpServers" },
  { name: "Mux", id: "mux", target: "mcp config" },
  {
    name: "Pi",
    id: "pi",
    target: "telemetry/skills surface; no writable MCP hook config",
  },
];

export const tsPluginPlatforms: PlatformEntry[] = [
  {
    name: "OpenCode",
    id: "opencode",
    target: "generated exported plugin module importing your handler",
  },
  {
    name: "Kilo CLI",
    id: "kilo-cli",
    target: "generated @kilocode/plugin module registered in kilo.jsonc's plugin array",
  },
  { name: "OMP", id: "omp", target: "generated plugin module" },
  { name: "OpenClaw", id: "openclaw", target: "generated plugin module" },
];

/* ------------------------------------------------------------------ */
/* Troubleshooting                                                      */
/* ------------------------------------------------------------------ */

/** How to read a `doctor` status line. */
export const doctorStatusRows: { status: string; meaning: string }[] = [
  {
    status: "[pass]",
    meaning: "The check succeeded; nothing to do.",
  },
  {
    status: "[warn]",
    meaning:
      "A non-fatal degradation (e.g. a capability the host can't honor). The command still exits 0 — warns alone never fail doctor.",
  },
  {
    status: "[FAIL]",
    meaning:
      "A check that must be fixed. Any single FAIL makes the whole command exit non-zero (1). The fix: line shows the suggested remedy.",
  },
];

/** Common ConnectorConfigError messages thrown by defineConnector. */
export const configErrorRows: { message: string; cause: string }[] = [
  {
    message: "id must be kebab-case matching /^[a-z0-9][a-z0-9-]*$/",
    cause:
      "The connector id contains uppercase, underscores, spaces, or a leading dash/digit-only edge case. Use a lowercase kebab-case id.",
  },
  {
    message:
      "a connector must declare at least one of `server`, `hooks`, `commands`, `skills`, `subagents`, `memory`, or a per-platform `nativeHooks` / `configPatch` declaration",
    cause:
      "No surface was declared. A connector needs at least one of those to do anything.",
  },
  {
    message:
      'memory[<i>].content must not contain the literal marker token "agent-connector:begin"',
    cause:
      "Memory content containing the managed-block marker tokens (agent-connector:begin / agent-connector:end) would corrupt marker scanning. Rephrase the content; the 16 KiB hard cap throws a similar error.",
  },
  {
    message: "server.command is required for stdio transport",
    cause:
      'transport: "stdio" was set without a string command. Add the executable to launch.',
  },
  {
    message: "server.url is required for <transport> transport",
    cause:
      "A remote transport (http / sse / ws) was set without a string url. Add the endpoint.",
  },
  {
    message:
      'skills[i].resources key must not escape the skill dir via ".."',
    cause:
      "A resource relpath was absolute, empty, `.`, or contained a `..` traversal (checked with both / and \\ separators). Use a safe path inside the skill dir.",
  },
];

/** Why `requires sync, skipped` appears in usage rows. */
export const syncedPlatforms: string[] = [
  "cursor",
  "antigravity",
  "antigravity-cli",
  "trae",
  "warp",
];

/** Why telemetry can show nothing. */
export const telemetryEmptyRows: { reason: string; fix: string }[] = [
  {
    reason: "AGENT_CONNECTOR_TELEMETRY=0 (or telemetry: { enabled: false })",
    fix: "Telemetry is disabled. Unset the env var / re-enable in config, then re-run.",
  },
  {
    reason: "The MCP server isn't wrapped",
    fix: "Only servers launched through agent-connector serve are measured (wrapForTelemetry, default on for stdio). Remote transports can't be intercepted. Re-sync so the entry is wrapped.",
  },
  {
    reason: "Nothing has been recorded yet",
    fix: "Rows appear after the wrapped server actually handles tools/call traffic. Exercise a tool first.",
  },
  {
    reason: "Host-native turns not calibrated / not opted in",
    fix: "model_turn rows only exist when host-native usage is enabled (hostNativeUsage / AGENT_CONNECTOR_HOST_NATIVE=1) on a supporting host.",
  },
  {
    reason: "The MCP isn't declared + wrapped by YOUR connector",
    fix: "Per-MCP / per-tool telemetry exists only for a server your own connector declares and serve-wraps — serve loads a registered connector and stamps every row with its id. An already-installed third-party MCP you didn't author produces no per-tool rows here; that is a capability boundary, not a bug. For an MCP you didn't author, the connector-free `usage` command shows per-CLI / per-model totals (not per-MCP).",
  },
];

/* ------------------------------------------------------------------ */
/* Packaging & marketplaces (core/package.ts + package-formats/*)       */
/* ------------------------------------------------------------------ */

/**
 * The 11 PackageFormat values (9 host formats + 2 opt-in standard artifacts),
 * in ALL_FORMATS order (also the order
 * `--format all` emits). Each row is read directly from
 * src/core/package-formats/*.ts: the --format value, the target platform(s) it
 * serves, the manifest file(s) it emits, and the user install command.
 */
export interface PackageFormatRow {
  /** The --format value. */
  format: string;
  /** Target platform(s) this bundle serves. */
  targets: string;
  /** The manifest / key file(s) the emitter writes. */
  manifest: string;
  /** The user-facing install command(s). */
  install: string;
  /** Optional note (lossy formats / structural quirks). */
  note?: string;
}

export const packageFormatRows: PackageFormatRow[] = [
  {
    format: "claude-plugin",
    targets: "Claude Code · Codex · VS Code Copilot · OpenClaw · OMP",
    manifest: ".claude-plugin/plugin.json + .claude-plugin/marketplace.json (+ commands/, agents/, skills/<n>/SKILL.md, hooks/hooks.json, .mcp.json)",
    install: "/plugin marketplace add <out> · /plugin install <id>@agent-connector",
    note: "The default format. plugin.json carries a $schema; the marketplace catalog is the object-owner shape.",
  },
  {
    format: "codex-plugin",
    targets: "Codex CLI",
    manifest: ".codex-plugin/plugin.json + .codex-plugin/marketplace.json (same component tree as claude-plugin; .mcp.json)",
    install: "codex plugin marketplace add <out> · codex plugin add <id>@agent-connector",
    note: "A manifest-dir rename of claude-plugin (.codex-plugin/ instead of .claude-plugin/).",
  },
  {
    format: "factory-plugin",
    targets: "Droid (Factory)",
    manifest: ".factory-plugin/plugin.json + droids/ + mcp.json + marketplace.json (git-repo catalog at the repo root)",
    install: "droid plugin marketplace add <out> · droid plugin install <id>@agent-connector",
    note: "Subagents go in droids/ (not agents/); MCP filename is mcp.json; plugin.json pins version + author.",
  },
  {
    format: "gemini-extension",
    targets: "Gemini CLI",
    manifest: "gemini-extension.json (inline mcpServers + contextFileName) + commands/<n>.toml + agents/, skills/, hooks/hooks.json + GEMINI.md",
    install: "gemini extensions install <out>/<id>",
    note: "MCP is declared INLINE in the manifest (no separate .mcp.json); commands are TOML.",
  },
  {
    format: "qwen-extension",
    targets: "Qwen Code",
    manifest: "qwen-extension.json (inline mcpServers) + commands/<n>.md + agents/, skills/, hooks/hooks.json + QWEN.md",
    install: "qwen extensions install <out>/<id>",
    note: "A Gemini-CLI fork: commands are Markdown (not TOML) and the context file is QWEN.md.",
  },
  {
    format: "agy-plugin",
    targets: "Antigravity CLI / IDE",
    manifest: "plugin.json (root marker) + mcp_config.json (SEPARATE) + commands/, agents/, skills/, hooks/hooks.json",
    install: "agy plugin install <out>/<id>  (validate: agy plugin validate <out>/<id>)",
    note: "MCP MUST be a separate mcp_config.json — an inline mcpServers in plugin.json is NOT read. No marketplace catalog ships.",
  },
  {
    format: "cursor-plugin",
    targets: "Cursor",
    manifest: ".cursor-plugin/plugin.json (pointer fields) + .cursor-plugin/marketplace.json + commands/, agents/, skills/, hooks/hooks.json, mcp.json",
    install: "link <out>/<id> into ~/.cursor/plugins/local/<id>/ then Reload Window (or publish <out> as a Cursor marketplace repo)",
    note: "Manifest surface fields are POINTERS (\"skills\":\"./skills/\", \"mcpServers\":\"./mcp.json\"). MCP file is mcp.json (no leading dot).",
  },
  {
    format: "kimi-plugin",
    targets: "Kimi CLI",
    manifest: "kimi.plugin.json (skills pointer + inline mcpServers) + skills/<n>/SKILL.md",
    install: "kimi plugin install <out>/<id>",
    note: "Skills + MCP ONLY. Commands, subagents, and hooks are DROPPED (Kimi ignores them) and a drop note is returned.",
  },
  {
    format: "npm-plugin",
    targets: "OpenCode · Kilo CLI · Pi",
    manifest: "package.json (type:module, exports, keywords) + index.js (ESM bridge) + skills/<n>/SKILL.md + README.md",
    install: "npm publish <out>/<id>  (then: opencode plugin install <pkg> | kilo plugin <pkg> | pi install npm:<pkg>)",
    note: "A publishable npm package whose default export is a plugin fn that shells each hook to the home-bin. Commands/subagents are native host dirs and MCP is a config key, so they are NOT bundled (notes record this).",
  },
  {
    format: "mcp-server-json",
    targets: "Official MCP Registry (cross-vendor discovery)",
    manifest: "server.json (schema 2025-12-11: name = <namespace>/<id>, version, packages[]{registryType,identifier,transport} | remotes[])",
    install: "mcp-publisher login … && mcp-publisher publish   (the dev runs this)",
    note: "OFFICIAL standard artifact. Describes the dev's REAL upstream server (NOT our serve wrapper). Opt-in: requires publish.registryNamespace (a namespace you own) + publish.packageName; excluded from --format all.",
  },
  {
    format: "mcpb",
    targets: "Claude Desktop + any MCPB host (one-click local install)",
    manifest: "manifest.json (manifest_version 0.3, self-contained node server, secrets→user_config) + README packaging recipe",
    install: "vendor server/ then: npx @anthropic-ai/mcpb pack .   (the dev runs this)",
    note: "OFFICIAL standard artifact. Emits a conformant manifest + recipe, NOT the .mcpb zip (self-contained bundling is the dev's step). Opt-in: requires publish.author.name + a stdio server; excluded from --format all.",
  },
];

/* ------------------------------------------------------------------ */
/* Telemetry — the 5-surface model (telemetry/types.ts + leaderboard)   */
/* ------------------------------------------------------------------ */

/** The two telemetry axes (host/user vs developer/surface). */
export const telemetryAxes: {
  axis: string;
  glyph: string;
  measures: string;
  source: string;
}[] = [
  {
    glyph: "🖥️",
    axis: "User / host axis",
    measures:
      "Whole-conversation host usage — what the USER spent across the entire conversation.",
    source:
      "The model_turn host-native hook (live, exact) + the host-scan CLI-log readers. Surfaced by the Host/User + Host-native-turns leaderboards.",
  },
  {
    glyph: "🔌",
    axis: "Developer / surface axis",
    measures:
      "What the CONNECTOR costs — the footprint your connector imposes, now across ALL FIVE surfaces.",
    source:
      "server + hooks measured live (RUNTIME store rows); commands + skills + subagents computed on demand as STATIC context footprints.",
  },
];

/** The 5 developer-axis surfaces — server/hook are runtime, the other 3 static. */
export const telemetrySurfaces: {
  surface: string;
  kind: "RUNTIME" | "STATIC";
  measured: string;
  detail: string;
}[] = [
  {
    surface: "server",
    kind: "RUNTIME",
    measured: "per-MCP-tool call + tool_defs",
    detail:
      "The serve-proxy tokenizes each tools/call round-trip (scope call) and the one-time tools/list schema overhead (scope tool_defs). surfaceKind \"server\" (the backward-compatible default for legacy rows).",
  },
  {
    surface: "hooks",
    kind: "RUNTIME",
    measured: "per-event hook dispatch",
    detail:
      "Measured at the home-bin hook entrypoint (src/runtime/hook-entrypoint): one row per RUNTIME hook dispatch (scope \"hook\", surfaceKind \"hook\"). Input = the inbound normalized event payload; output = the HookResponse that becomes context/decision. The per-item name IS the event (e.g. SessionStart). Fail-open: a telemetry error never breaks the hook.",
  },
  {
    surface: "command",
    kind: "STATIC",
    measured: "context footprint (description + prompt + argumentHint)",
    detail:
      "Computed on demand from the connector (surface-footprint.ts) — a tokenized footprint of the context the host loads, NOT runtime usage. Never written as a store row.",
  },
  {
    surface: "skill",
    kind: "STATIC",
    measured: "context footprint (description + body + resources)",
    detail:
      "Static footprint of SKILL.md + every resource value (sorted by path for determinism). Computed on demand, never a usage row.",
  },
  {
    surface: "subagent",
    kind: "STATIC",
    measured: "context footprint (description + prompt)",
    detail:
      "Static footprint of the subagent's description + system prompt. Computed on demand, never a usage row.",
  },
];

/** EventScope — the four DISTINCT origins a record can carry (never summed). */
export const eventScopeRows: { scope: string; meaning: string }[] = [
  {
    scope: '"call"',
    meaning:
      "One per-MCP tools/call round-trip (serve-proxy bytes). The headline per-tool cost.",
  },
  {
    scope: '"tool_defs"',
    meaning:
      "The one-time tools/list schema overhead (serve-proxy). Counted as tokens but never as a call.",
  },
  {
    scope: '"model_turn"',
    meaning:
      "A WHOLE-CONVERSATION host-native turn the host reported (e.g. Gemini/Antigravity AfterModel usageMetadata). EXCLUDED from the per-MCP/per-surface views — its own leaderboard section.",
  },
  {
    scope: '"hook"',
    meaning:
      "One RUNTIME hook dispatch through the home-bin entrypoint. The developer-axis hook surface — measured live, like call.",
  },
];

/** SurfaceKind — which of the 5 developer-axis surfaces a row/footprint is. */
export const surfaceKindRows: { kind: string; meaning: string }[] = [
  {
    kind: '"server"',
    meaning:
      "RUNTIME serve-proxy rows (call / tool_defs). The backward-compatible default: rows written before surfaceKind existed read as server.",
  },
  {
    kind: '"hook"',
    meaning: "RUNTIME hook-entrypoint rows (scope hook), stamped explicitly.",
  },
  {
    kind: '"command"',
    meaning: "STATIC command footprint — never a store row.",
  },
  {
    kind: '"skill"',
    meaning: "STATIC skill footprint — never a store row.",
  },
  {
    kind: '"subagent"',
    meaning: "STATIC subagent footprint — never a store row.",
  },
];

/** Columns of the per-surface leaderboard table (telemetry leaderboard --by surface). */
export const surfaceLeaderboardColumns: { column: string; meaning: string }[] = [
  { column: "SURFACE", meaning: "The surfaceKind (server | hook | command | skill | subagent)." },
  {
    column: "NAME",
    meaning:
      "The per-item name: the tool name (server), the event name (hook), or the command/skill/subagent name (static).",
  },
  { column: "IN", meaning: "Input tokens. For static rows, the whole footprint sits here." },
  { column: "OUT", meaning: "Output tokens. Always 0 for static rows." },
  { column: "TOTAL", meaning: "IN + OUT for the (surface, name) group." },
  {
    column: "KIND",
    meaning:
      "runtime (live usage, aggregated from the store) vs static (a context-load footprint). The distinction is never silently conflated.",
  },
];
