/**
 * docs-data — data-driven nav structure + field tables for the SDK docs.
 * Content is grounded in llms-full.txt and src/core/types.ts. Do not invent API.
 */

/* ------------------------------------------------------------------ */
/* Sidebar navigation                                                  */
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

export const navGroups: NavGroup[] = [
  {
    title: "Getting Started",
    items: [
      { id: "introduction", label: "Introduction" },
      { id: "installation", label: "Installation" },
      { id: "quick-start", label: "Quick start" },
    ],
  },
  {
    title: "Core API",
    items: [
      { id: "define-connector", label: "defineConnector" },
      { id: "server", label: "Server" },
      { id: "hooks", label: "Hooks" },
      { id: "surfaces", label: "Commands, Skills & Subagents" },
    ],
  },
  {
    title: "Telemetry",
    items: [
      { id: "telemetry-overview", label: "Overview" },
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
      { id: "add-a-platform", label: "Add a platform" },
      { id: "operating-model", label: "Operating model" },
      { id: "troubleshooting", label: "Troubleshooting" },
    ],
  },
];

/** Flat ordered list of every section id (for scroll-spy + prev/next). */
export const sectionOrder: string[] = navGroups.flatMap((g) =>
  g.items.map((i) => i.id),
);

export const sectionLabel: Record<string, string> = Object.fromEntries(
  navGroups.flatMap((g) => g.items.map((i) => [i.id, i.label] as const)),
);

/** Set of every valid section id — used to detect unknown :section params. */
export const sectionIds: ReadonlySet<string> = new Set(sectionOrder);

/** Per-section <meta name="description"> copy (for /docs/:section deep links). */
export const sectionDescription: Record<string, string> = {
  introduction:
    "Write your MCP server + hooks once with defineConnector; agent-connector renders it natively across 28 AI-agent platforms with default local-first token telemetry.",
  installation:
    "Install the agent-connector CLI globally. ESM-only, pure-JS / WASM deps, Node >=18.17, no native build.",
  "quick-start":
    "Create an agent-connector.config file and drive install / sync / uninstall — every command is idempotent, reversible, and --dry-run-able.",
  "define-connector":
    "defineConnector(config): the write-once surface. Validates eagerly, throws ConnectorConfigError, and returns a fully-defaulted ResolvedConnector.",
  server:
    "ServerDef — a normalized, transport-polymorphic MCP server descriptor declared once and rendered into each host's native dialect.",
  hooks:
    "Declare lifecycle hooks once against normalized events; the framework synthesizes the right shape per host paradigm and formats your reply.",
  surfaces:
    "Slash commands, Agent Skills, and subagents as content-only files — pure file writers rendered per platform.",
  "telemetry-overview":
    "Default per-MCP token telemetry: the serve proxy tokenizes input/output locally with documented confidence sources. Aggregate counts only.",
  leaderboards:
    "Three origin-labeled leaderboards (MCP/plugin, host/user, host-native turns) that measure different things and are never summed.",
  privacy:
    "Local-first telemetry with zero network egress by default. Aggregate counts only — never raw arguments or results.",
  cli: "The agent-connector CLI reference: detect, install, sync, uninstall, doctor, update, telemetry, usage, and leaderboard.",
  platforms:
    "The 28 supported hosts, grouped by hook paradigm: json-stdio, mcp-only, and ts-plugin.",
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
    name: "platforms",
    type: "Partial<Record<PlatformId, PlatformOverride>>",
    default: "{}",
    notes: "Per-platform overrides / escape hatch.",
  },
  {
    name: "targets",
    type: '"auto" | PlatformId[]',
    default: '"auto"',
    notes: '"auto" = all detected; or an explicit allow-list.',
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
    notes: 'Replacement tool input — only with "modify" (PreToolUse).',
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
  { decision: "allow", meaning: "Pass through (default when the handler returns void)." },
  { decision: "deny", meaning: "Block the tool call / stop the action." },
  { decision: "modify", meaning: "Replace tool input with updatedInput (PreToolUse)." },
  { decision: "context", meaning: "Inject additionalContext as soft guidance." },
  { decision: "ask", meaning: "Prompt the user to confirm." },
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
    count: 15,
    description:
      "Host pipes JSON to a command on stdin and reads JSON / exit-code back. One universal entrypoint (agent-connector hook <platform> <event> --connector <id>) reads the payload, normalizes it, runs your handler, and formats the reply.",
  },
  {
    id: "ts-plugin",
    label: "ts-plugin",
    count: 3,
    description:
      "Host loads a framework-generated JS/TS module exporting lifecycle functions that import your handler — the native shape these hosts expect.",
  },
  {
    id: "mcp-only",
    label: "mcp-only",
    count: 10,
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
    subagent: ".github/agents/<n>.agent.md",
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
    subagent: ".kilo/agents/<n>.md",
  },
  {
    platform: "pi",
    command: "—",
    skill: ".pi/skills/<n>/SKILL.md",
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
      "Local gpt-tokenizer match for the host's family (o200k_base / cl100k_base).",
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
    notes: "false → no hooks here; object → merge / replace.",
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
    name: "extra",
    type: "Record<string, unknown>",
    notes: "Verbatim fields merged into the native config.",
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
      "agent-connector install [--scope user|project] [--targets …] [--connector <path>] [--project <dir>] [--dry-run]",
    summary:
      "Per target: backup settings → render server config → if hooks & paradigm≠mcp-only, synthesize the entrypoint + write hook config + set exec bit → write command/skill/subagent files → register in the plugin registry. Prints a readable diff plus warnings and a summary tally. Idempotent and reversible. Exit code 1 if any change is a warn, else 0.",
  },
  {
    name: "sync",
    signature: "agent-connector sync [same flags as install]",
    summary:
      "Idempotent re-render after editing a connector or upgrading the framework: byte-identical entries report skip, and the stable home-bin pointer is healed. Same diff output and exit semantics as install.",
  },
  {
    name: "uninstall",
    signature:
      "agent-connector uninstall [--connector-id <id>] [--connector <path>] [--scope …] [--targets …] [--project <dir>] [--dry-run]",
    summary:
      "Full inverse — removes the connector's MCP + hook registrations and content files from every resolved target, using registered metadata so it works even when the source module is gone. The id comes from --connector-id, else inferred from the local config.",
  },
  {
    name: "doctor",
    signature:
      "agent-connector doctor [--targets …] [--connector <path>] [--scope user|project] [--project <dir>] [--json]",
    summary:
      "For each detected host (or --targets), loads its adapter, builds an InstallContext, and runs the adapter's doctor checks; prints [pass] / [warn] / [FAIL] with any suggested fix. Non-zero exit if any check FAILs (warns alone do not fail).",
  },
  {
    name: "update",
    signature: "agent-connector update [--channel stable|latest]",
    summary:
      "Prints managed-update guidance (the exact npm i -g agent-connector@<dist>) and refreshes the stable home-bin pointer so hosts keep execing a working CLI. Never silently auto-updates. Exit 1 only if the pointer refresh fails.",
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
        flag: "leaderboard --by mcp|tool --since … --connector <id> --scope <slice> [--json]",
        desc: 'Ranks per-connector ("which MCP costs the most") or per-tool.',
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
      "agent-connector leaderboard [--since <window>] [--scope <slice>] [--json]",
    summary:
      "Prints THREE origin-labeled leaderboards that measure DIFFERENT things and are NEVER summed: 🔌 MCP/Plugin (mcp-self), 🖥️ Host/User (host-scan-logs), 🛰️ Host-native turns (host-native-live). --scope slices only the MCP section; --json emits { mcp, host, hostSkipped, hostNativeTurns }.",
  },
];

export const internalEntrypoints: { signature: string; desc: string }[] = [
  {
    signature: "agent-connector hook <platform> <event> --connector <id>",
    desc: "Universal json-stdio hook entrypoint. Reads the whole host payload from stdin, dispatches runHook, writes stdout/stderr, exits with the adapter's exit code. Fail-open (never rejects).",
  },
  {
    signature:
      "agent-connector serve --connector <id> [--scope user|project] -- <command> [args…]",
    desc: "Telemetry-wrapping MCP stdio proxy. Splits argv at the first literal --; the real server invocation on the right is passed through verbatim. Tolerant flag parsing (strict:false).",
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
/* Platforms (28, by paradigm — llms-full §6)                           */
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
  { name: "Crush", id: "crush", target: "config → mcpServers" },
  { name: "Goose", id: "goose", target: "host config" },
  { name: "Hermes", id: "hermes", target: "host config" },
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
  { name: "Warp", id: "warp", target: ".warp → mcp" },
  { name: "Kilo", id: "kilo", target: ".kilocode mcp config" },
  { name: "Droid (Factory)", id: "droid", target: "mcp.json → mcpServers" },
  { name: "Roo Code", id: "roo-code", target: "mcp config" },
  { name: "Trae", id: "trae", target: "mcp config" },
  { name: "Zed", id: "zed", target: "host config" },
  { name: "Amp", id: "amp", target: "mcpServers" },
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
      "a connector must declare at least one of `server`, `hooks`, `commands`, `skills`, or `subagents`",
    cause:
      "No surface was declared. A connector needs at least one of those five to do anything.",
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
];
