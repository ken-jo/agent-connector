/**
 * hooks-matrix — the accurate, extracted cross-platform hook mapping.
 *
 * Hooks are the surface that varies MOST across hosts: each platform names the
 * lifecycle events differently (PascalCase, lower-camel, snake_case, plugin
 * targets), supports a different subset of them, and signals a deny/decision in
 * its own shape. This module is the single source of truth the Hooks
 * developer-guide page renders from. The data is verbatim from the connector's
 * adapter registry — do NOT invent or "fix" mappings here.
 */

/**
 * The 12 normalized lifecycle events a developer writes once against. The last
 * four (PermissionRequest / PostToolUseFailure / SubagentStart / SubagentStop)
 * are newer additions with cross-host analogs; hosts without a native analog
 * mark them unsupported and the install reports a skip-warn.
 */
export type CanonicalEvent =
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

/** The three host hook paradigms (the deepest cross-platform divergence). */
export type HookParadigm = "json-stdio" | "ts-plugin" | "mcp-only";

export interface HookCapabilities {
  /** Can rewrite tool input before the call (PreToolUse "modify"). */
  canModifyArgs: boolean;
  /** Can rewrite tool output after the call (PostToolUse "modify"). */
  canModifyOutput: boolean;
  /** Can inject additionalContext / system guidance. */
  canInjectSessionContext: boolean;
}

export interface PlatformHookEntry {
  /** Stable PlatformId. */
  platform: string;
  /** Human label. */
  displayName: string;
  /** Hook paradigm group. */
  paradigm: HookParadigm;
  /** Whether this host has any hook layer at all. */
  hasHooks: boolean;
  /** Where the hook config is written ("—" for mcp-only hosts). */
  configPath: string;
  /** What the host can honor from a HookResponse. */
  capabilities: HookCapabilities;
  /**
   * Per-canonical-event native name. `null` = no host equivalent → the event is
   * never wired (graceful skip-warn).
   */
  events: Record<CanonicalEvent, string | null>;
  /** How deny/decision is signaled + any per-host quirks (verbatim). */
  notes: string;
}

export interface HooksMatrix {
  canonicalEvents: CanonicalEvent[];
  platforms: PlatformHookEntry[];
}

/** Ordered list of the 12 canonical events (matrix row order = core ALL_EVENTS order). */
export const canonicalEvents: CanonicalEvent[] = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "Stop",
  "Notification",
  "PermissionRequest",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
];

/** Display order for the paradigm groups. */
export const paradigmOrder: HookParadigm[] = [
  "json-stdio",
  "ts-plugin",
  "mcp-only",
];

export const paradigmLabel: Record<HookParadigm, string> = {
  "json-stdio": "json-stdio",
  "ts-plugin": "ts-plugin",
  "mcp-only": "mcp-only",
};

/** One-line summary of how each paradigm delivers hooks. */
export const paradigmBlurb: Record<HookParadigm, string> = {
  "json-stdio":
    "Host pipes JSON to a command on stdin and reads JSON / an exit code back. The universal home-bin entrypoint reads the payload, runs your handler, and formats the native reply.",
  "ts-plugin":
    "Host loads a framework-synthesized JS/TS plugin module that bridges its native lifecycle functions to your handler over the same home-bin entrypoint.",
  "mcp-only":
    "No hook layer at all — only the MCP server is installed; declared hooks are reported unavailable and skip-warn on these hosts.",
};

export const platforms: PlatformHookEntry[] = [
  {
    platform: "claude-code",
    displayName: "Claude Code",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath: '~/.claude/settings.json (under "hooks", keyed by event)',
    capabilities: {
      canModifyArgs: true,
      canModifyOutput: false,
      canInjectSessionContext: true,
    },
    events: {
      SessionStart: "SessionStart",
      SessionEnd: "SessionEnd",
      UserPromptSubmit: "UserPromptSubmit",
      PreToolUse: "PreToolUse",
      PostToolUse: "PostToolUse",
      PreCompact: "PreCompact",
      Stop: "Stop",
      Notification: "Notification",
      PermissionRequest: "PermissionRequest",
      PostToolUseFailure: "PostToolUseFailure",
      SubagentStart: "SubagentStart",
      SubagentStop: "SubagentStop",
    },
    notes:
      "Reference json-stdio host. All 12 canonical events map 1:1 (PascalCase). Reply: stdout JSON hookSpecificOutput{ hookEventName, permissionDecision: deny|ask + permissionDecisionReason; or updatedInput (PreToolUse only); or additionalContext } with exit 0. allow/void = exit 0. Event-specific shapes: PermissionRequest uses the nested decision{ behavior:'allow'|'deny' } envelope — an EXPLICIT allow is an active grant that suppresses the dialog (+updatedInput; never overrides host deny rules), deny carries message, and ask/context/void emit NO decision (fall through to the native dialog). PostToolUseFailure & SubagentStart are context-only (deny degrades to additionalContext carrying the reason). Stop/SubagentStop/UserPromptSubmit/PostToolUse deny = TOP-LEVEL { decision:'block', reason } (a SubagentStop block keeps the subagent running). canModifyOutput false (cannot rewrite emitted tool output). Each settings.json hook value is { matcher, hooks:[{type:'command',command}] }.",
  },
  {
    platform: "codex",
    displayName: "Codex CLI",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath: "$CODEX_HOME|~/.codex/hooks.json (Claude-shaped {matcher,hooks[]})",
    capabilities: {
      canModifyArgs: false,
      canModifyOutput: false,
      canInjectSessionContext: true,
    },
    events: {
      SessionStart: "SessionStart",
      SessionEnd: null,
      UserPromptSubmit: "UserPromptSubmit",
      PreToolUse: "PreToolUse",
      PostToolUse: "PostToolUse",
      PreCompact: "PreCompact",
      Stop: "Stop",
      Notification: null,
      PermissionRequest: "PermissionRequest",
      PostToolUseFailure: null,
      SubagentStart: "SubagentStart",
      SubagentStop: "SubagentStop",
    },
    notes:
      "CODEX_HOOK_EVENTS = SessionStart, PreToolUse, PostToolUse, PreCompact, UserPromptSubmit, Stop, PermissionRequest, SubagentStart, SubagentStop (PascalCase, Claude-compatible names). SessionEnd & Notification dropped (capabilities false; never written); PostToolUseFailure has NO Codex analog -> warn-skip at install. MCP in config.toml [mcp_servers]. Reply: PreToolUse deny -> stdout hookSpecificOutput{ permissionDecision:'deny' }; PermissionRequest deny/allow -> nested hookSpecificOutput.decision{ behavior, message? } (updatedInput/updatedPermissions/interrupt FAIL CLOSED on Codex, so never emitted); SubagentStart context -> additionalContext; SubagentStop deny -> TOP-LEVEL { decision:'block', reason } (keeps the subagent going); additionalContext honored on SessionStart & PostToolUse; modify/ask unsupported -> exit 0 passthrough. PreToolUse matcher is a charset-clean regex string.",
  },
  {
    platform: "cursor",
    displayName: "Cursor",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath:
      "~/.cursor/hooks.json ({version:1, hooks:{<event>:[{command,matcher?}]}})",
    capabilities: {
      canModifyArgs: true,
      canModifyOutput: false,
      canInjectSessionContext: true,
    },
    events: {
      SessionStart: "sessionStart",
      SessionEnd: null,
      UserPromptSubmit: null,
      PreToolUse: "preToolUse",
      PostToolUse: "postToolUse",
      PreCompact: null,
      Stop: "stop",
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: "postToolUseFailure",
      SubagentStart: "subagentStart",
      SubagentStop: "subagentStop",
    },
    notes:
      "EVENT_MAP lower-camel: PreToolUse->preToolUse, PostToolUse->postToolUse, SessionStart->sessionStart, Stop->stop, plus the documented Subagent (Task tool) lifecycle + tool-failure hooks SubagentStart->subagentStart, SubagentStop->subagentStop, PostToolUseFailure->postToolUseFailure. SessionEnd/UserPromptSubmit/PreCompact/Notification have no Cursor equivalent -> warn-skip (null); PermissionRequest too — Cursor's permission gate is the OUTPUT field `permission` of its before* hooks, not an observable event. FLAT entry { command, matcher? } (no nested hooks[]). Reply (stdout JSON, exit 0): deny/ask -> { permission:'deny'|'ask', user_message } (a SubagentStop deny rides the same shape with Stop semantics); modify -> { updated_input } (PreToolUse); context -> { agent_message } (PreToolUse) or { additional_context } (Post/SessionStart). postToolUseFailure & subagentStart are observe/context-only -> { additional_context } (deny degrades to it carrying the reason). Emits non-empty JSON even on no-op (Cursor rejects empty stdout).",
  },
  {
    platform: "vscode-copilot",
    displayName: "VS Code Copilot",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath:
      "<projectDir>/.github/hooks/<connector-id>.json ({version:1,hooks:{<Event>:[{type,command}]}})",
    capabilities: {
      canModifyArgs: true,
      canModifyOutput: false,
      canInjectSessionContext: true,
    },
    events: {
      SessionStart: "SessionStart",
      SessionEnd: null,
      UserPromptSubmit: null,
      PreToolUse: "PreToolUse",
      PostToolUse: "PostToolUse",
      PreCompact: "PreCompact",
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: "SubagentStart",
      SubagentStop: "SubagentStop",
    },
    notes:
      "EVENT_MAP PascalCase: PreToolUse, PostToolUse, PreCompact, SessionStart, SubagentStart, SubagentStop (1:1 — Subagent* are in VS Code's live Preview event list). SessionEnd/UserPromptSubmit/Stop/Notification warn-skip (null); PermissionRequest & PostToolUseFailure have no VS Code analog -> warn-skip. Hook file is per-connector under the WORKSPACE .github/hooks tree (project-rooted both scopes); top-level version:1 REQUIRED. FLAT { type:'command', command } entries; matchers parsed but IGNORED. Reply (Claude-compatible, stdout exit 0): hookSpecificOutput{ permissionDecision deny|ask + reason; updatedInput (PreToolUse); additionalContext }. SubagentStart is context-only (deny degrades to additionalContext); SubagentStop deny -> TOP-LEVEL { decision:'block', reason } (keeps the subagent running). canModifyOutput false.",
  },
  {
    platform: "jetbrains-copilot",
    displayName: "JetBrains Copilot",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath:
      "<projectDir>/.github/hooks/<connector-id>.json ({version:1,hooks:{<Event>:[{type,command}]}})",
    capabilities: {
      canModifyArgs: false,
      canModifyOutput: false,
      canInjectSessionContext: true,
    },
    events: {
      SessionStart: "SessionStart",
      SessionEnd: null,
      UserPromptSubmit: null,
      PreToolUse: "PreToolUse",
      PostToolUse: "PostToolUse",
      PreCompact: "PreCompact",
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
    },
    notes:
      "Same Copilot Preview hooks file/shape as vscode-copilot (PascalCase PreToolUse/PostToolUse/PreCompact/SessionStart 1:1; rest — including all four newer events — warn-skip null: only those four are confirmed delivered on JetBrains). DIFFERENCE: deny/ask-only -> canModifyArgs FALSE, so a 'modify' decision degrades to allow (no updatedInput). MCP is UI-managed (no writable file): installServer emits a 'warn' telling the user to add it via Settings > Tools > GitHub Copilot > MCP. Matchers IGNORED so omitted entirely. Reply: stdout hookSpecificOutput{ permissionDecision deny|ask + reason; additionalContext }, exit 0. Empty connector hooks file is deleted on uninstall.",
  },
  {
    platform: "copilot-cli",
    displayName: "GitHub Copilot CLI",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath:
      "~/.copilot/hooks/agent-connector.json ({version:1,hooks:{<Event>:[{matcher,hooks[]}]}})",
    capabilities: {
      canModifyArgs: true,
      canModifyOutput: false,
      canInjectSessionContext: true,
    },
    events: {
      SessionStart: "SessionStart",
      SessionEnd: "SessionEnd",
      UserPromptSubmit: "UserPromptSubmit",
      PreToolUse: "PreToolUse",
      PostToolUse: "PostToolUse",
      PreCompact: "PreCompact",
      Stop: "Stop",
      Notification: "Notification",
      PermissionRequest: "PermissionRequest",
      PostToolUseFailure: "PostToolUseFailure",
      SubagentStart: "SubagentStart",
      SubagentStop: "SubagentStop",
    },
    notes:
      "Full Claude-compatible lifecycle: all 12 events map 1:1 PascalCase (type CopilotHookEvent = HookEventName; no rename table — PascalCase selects the snake_case payload dialect). User/global only (no project scope). Hook file ~/.copilot/hooks/agent-connector.json; MCP in ~/.copilot/mcp-config.json (stdio written as type 'local' + tools:['*']). Claude-shaped nested { matcher, hooks:[{type,command}] }. Reply (stdout exit 0): hookSpecificOutput{ permissionDecision deny|ask + reason; updatedInput (PreToolUse); additionalContext }. PermissionRequest uses the nested decision{ behavior:'allow'|'deny' } envelope (explicit allow grant; ask/context/void fall through to the dialog); PostToolUseFailure & SubagentStart are context-only (deny degrades to additionalContext); SubagentStop deny -> TOP-LEVEL { decision:'block', reason } (host can block and force continuation). canModifyOutput false.",
  },
  {
    platform: "gemini-cli",
    displayName: "Gemini CLI",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath: '~/.gemini/settings.json (top-level "hooks", keyed by native event)',
    capabilities: {
      canModifyArgs: true,
      canModifyOutput: true,
      canInjectSessionContext: true,
    },
    events: {
      SessionStart: "SessionStart",
      SessionEnd: "SessionEnd",
      UserPromptSubmit: "BeforeAgent",
      PreToolUse: "BeforeTool",
      PostToolUse: "AfterTool",
      PreCompact: "PreCompress",
      Stop: null,
      Notification: "Notification",
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
    },
    notes:
      "Distinct Gemini vocabulary via EVENT_MAP: PreToolUse->BeforeTool, PostToolUse->AfterTool, PreCompact->PreCompress, UserPromptSubmit->BeforeAgent, SessionStart->SessionStart, SessionEnd->SessionEnd, Notification->Notification. Stop has NO Gemini equivalent -> warn-skip (null); ditto all four newer events — the permission prompt is only observable via Notification (notification_type 'ToolPermission', no decision), tool failures arrive merged into AfterTool's tool_response.error, and Gemini exposes no subagent hooks. MCP + hooks share settings.json; transport by KEY (command/args=stdio, url=sse, httpUrl=http). canModifyOutput TRUE (AfterTool output rewrite expressed as deny+reason). Reply (stdout exit 0): deny -> { decision:'deny', reason } (top-level, NOT permissionDecision wrapper); ask -> degrades to deny; modify PreToolUse -> { hookSpecificOutput:{ tool_input } }; modify PostToolUse -> { decision:'deny', reason:<newOutput> }; context -> { hookSpecificOutput:{ additionalContext } }. Opt-in host-native usage installs an extra AfterModel hook (usage-event sink, not a connector event).",
  },
  {
    platform: "qwen-code",
    displayName: "Qwen CLI",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath: '~/.qwen/settings.json (top-level "hooks", PascalCase keys)',
    capabilities: {
      canModifyArgs: true,
      canModifyOutput: false,
      canInjectSessionContext: true,
    },
    events: {
      SessionStart: "SessionStart",
      SessionEnd: "SessionEnd",
      UserPromptSubmit: "UserPromptSubmit",
      PreToolUse: "PreToolUse",
      PostToolUse: "PostToolUse",
      PreCompact: "PreCompact",
      Stop: "Stop",
      Notification: "Notification",
      PermissionRequest: "PermissionRequest",
      PostToolUseFailure: "PostToolUseFailure",
      SubagentStart: "SubagentStart",
      SubagentStop: "SubagentStop",
    },
    notes:
      "Gemini-CLI fork but Claude-COMPATIBLE hook protocol: all 12 events PascalCase 1:1 (NOT Gemini's BeforeTool/AfterTool). Registered canonical event name directly. MCP + hooks share settings.json; transport by key (type:'stdio' tolerated for stdio, url=sse, httpUrl=http). Claude-shaped nested { matcher, hooks:[{type,command}] }. Reply (stdout exit 0): hookSpecificOutput{ permissionDecision deny|ask + reason; updatedInput (PreToolUse only); additionalContext }. PermissionRequest uses the nested decision{ behavior:'allow'|'deny' } envelope (explicit allow grant +updatedInput; ask/context/void fall through to the dialog); PostToolUseFailure & SubagentStart are context-only (deny degrades to additionalContext); SubagentStop deny -> TOP-LEVEL { decision:'block', reason } Stop shape. canModifyOutput false (no updatedMCPToolOutput in qwen 0.17.1).",
  },
  {
    platform: "kiro",
    displayName: "Kiro",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath:
      "~/.kiro/agents/kiro_default.json (hooks merged into the default agent file)",
    capabilities: {
      canModifyArgs: false,
      canModifyOutput: false,
      canInjectSessionContext: true,
    },
    events: {
      SessionStart: "agentSpawn",
      SessionEnd: null,
      UserPromptSubmit: "userPromptSubmit",
      PreToolUse: "preToolUse",
      PostToolUse: "postToolUse",
      PreCompact: null,
      Stop: "stop",
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
    },
    notes:
      "EVENT_MAP camelCase: PreToolUse->preToolUse, PostToolUse->postToolUse, SessionStart->agentSpawn, UserPromptSubmit->userPromptSubmit, Stop->stop. PreCompact/SessionEnd/Notification and all four newer events have no Kiro equivalent -> warn-skip (null). Hooks live in an AGENT file (~/.kiro/agents/kiro_default.json, the auto-loaded default agent), NOT a settings file; MCP in ~/.kiro/settings/mcp.json. EXIT-CODE protocol: exit 0 = allow, exit 2 + stderr = deny (ask degrades to deny exit 2). agentSpawn context injection -> exit 0 + stdout { hookSpecificOutput:{ hookEventName:'agentSpawn', additionalContext } }. Cannot rewrite args/output (modify degrades to allow).",
  },
  {
    platform: "kimi",
    displayName: "Kimi CLI",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath:
      "$KIMI_HOME|$KIMI_CODE_HOME|~/.kimi/config.toml ([[hooks]] array-of-tables)",
    capabilities: {
      canModifyArgs: false,
      canModifyOutput: false,
      canInjectSessionContext: false,
    },
    events: {
      SessionStart: null,
      SessionEnd: null,
      UserPromptSubmit: null,
      PreToolUse: "PreToolUse",
      PostToolUse: null,
      PreCompact: null,
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: "PostToolUseFailure",
      SubagentStart: "SubagentStart",
      SubagentStop: "SubagentStop",
    },
    notes:
      "Narrow but growing: KIMI_HOOK_EVENTS = ['PreToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop'] (PascalCase 1:1). PermissionRequest has NO Kimi analog (the prompt is only observable via Notification) -> warn-skip; the remaining legacy events stay null (never wired) even though parseEvent can decode them. Hooks in config.toml as [[hooks]] tables { event, matcher, command }; MCP in ~/.kimi/mcp.json (mcpServers). PreToolUse DENY: exit 0 + stdout hookSpecificOutput{ permissionDecision:'deny' + reason } (Claude/Codex shape). PostToolUseFailure & SubagentStart are observe/context-only: 'context' emits the text PLAIN on exit-0 stdout (Kimi adds non-empty stdout to context; deny degrades to the same carrying the reason). SubagentStop deny = Stop semantics via Kimi's generic block protocol: EXIT 2 + reason on stderr keeps the subagent going. All other decisions/events degrade to silent allow (exit 0). canModify* and canInjectSessionContext all false.",
  },
  {
    platform: "crush",
    displayName: "Crush",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath:
      '~/.config/crush/crush.json (top-level "hooks"; project ./.crush.json)',
    capabilities: {
      canModifyArgs: false,
      canModifyOutput: false,
      canInjectSessionContext: false,
    },
    events: {
      SessionStart: null,
      SessionEnd: null,
      UserPromptSubmit: null,
      PreToolUse: "PreToolUse",
      PostToolUse: null,
      PreCompact: null,
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
    },
    notes:
      "CRUSH_HOOK_EVENTS = ['PreToolUse'] ONLY (native key 'PreToolUse'). Every other canonical event — including all four newer ones — is null. Single crush.json holds both MCP (root key 'mcp', NOT mcpServers) and hooks (top-level 'hooks'). FLAT hook entry { matcher, command }. Reply: only PreToolUse deny -> stdout { decision:'deny', reason } exit 0; allow/other = empty stdout exit 0 (fail-open). Deny-only; cannot rewrite args/output or inject context. Resolves env to literals (Crush expands $(...) at load).",
  },
  {
    platform: "goose",
    displayName: "Goose",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath:
      "~/.agents/plugins/<connector-id>/hooks/hooks.json (Open-Plugins; project <projectDir>/.agents)",
    capabilities: {
      canModifyArgs: false,
      canModifyOutput: false,
      canInjectSessionContext: true,
    },
    events: {
      SessionStart: "SessionStart",
      SessionEnd: null,
      UserPromptSubmit: null,
      PreToolUse: "PreToolUse",
      PostToolUse: "PostToolUse",
      PreCompact: null,
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: "PostToolUseFailure",
      SubagentStart: null,
      SubagentStop: null,
    },
    notes:
      "Open Plugins hooks.json keyed by RAW PascalCase event names (no rename) but FILTERED through capabilities: only PreToolUse, PostToolUse, SessionStart, PostToolUseFailure written (Goose's hooks system ships a dedicated PostToolUseFailure). SessionEnd/UserPromptSubmit/PreCompact/Stop/Notification -> capability-filtered warn-skip (null); PermissionRequest/SubagentStart/SubagentStop have no Goose analog -> warn-skip too. MCP ('extensions') in YAML config.yaml with Goose-specific cmd/envs field names. Hooks.json is Claude-shaped nested { matcher, hooks:[{type,command}] }, NO version key. Reply (stdout exit 0): deny -> { decision:'block', reason } (NOT Claude permissionDecision); ask -> block; context -> { additionalContext }; modify unsupported. PostToolUseFailure is context-only (the tool already failed — a deny degrades to { additionalContext } carrying the reason, never { decision:'block' }). Wire uses working_dir not cwd.",
  },
  {
    platform: "hermes",
    displayName: "Hermes Agent",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath: '~/.hermes/config.yaml (top-level "hooks", native snake_case keys)',
    capabilities: {
      canModifyArgs: false,
      canModifyOutput: false,
      canInjectSessionContext: true,
    },
    events: {
      SessionStart: "on_session_start",
      SessionEnd: "on_session_end",
      UserPromptSubmit: null,
      PreToolUse: "pre_tool_call",
      PostToolUse: "post_tool_call",
      PreCompact: null,
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: "subagent_stop",
    },
    notes:
      "EVENT_TO_HERMES snake_case: PreToolUse->pre_tool_call, PostToolUse->post_tool_call, SessionStart->on_session_start, SessionEnd->on_session_end, SubagentStop->subagent_stop (Hermes is a STOP-ONLY subagent host — subagent_stop fires when a delegate_task child exits; no subagent_start). UserPromptSubmit/PreCompact/Stop/Notification have no Hermes equivalent -> warn-skip (null); PermissionRequest too (pre_approval_request is observe-only — no decision control) and PostToolUseFailure (a failure arrives merged into post_tool_call). MCP (mcp_servers) AND hooks live in the SAME ~/.hermes/config.yaml (YAML). Hook entry { matcher, command, timeout }; the command keeps the CANONICAL event token (only the YAML key is the native name). Shell hooks -> canModifyArgs false. Reply (stdout exit 0): deny/ask -> Claude-like hookSpecificOutput{ permissionDecision + reason }; context -> { hookSpecificOutput:{ additionalContext } }; SubagentStop deny -> TOP-LEVEL { decision:'block', reason } (Stop semantics — keeps the subagent running). No SSE transport.",
  },
  {
    platform: "antigravity",
    displayName: "Google Antigravity",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath:
      "<resolvedUserConfigDir>/hooks.json (e.g. ~/.gemini/antigravity/hooks.json; project <projectDir>/.agents/hooks.json)",
    capabilities: {
      canModifyArgs: true,
      canModifyOutput: true,
      canInjectSessionContext: true,
    },
    events: {
      SessionStart: "SessionStart",
      SessionEnd: null,
      UserPromptSubmit: null,
      PreToolUse: "PreToolUse",
      PostToolUse: "PostToolUse",
      PreCompact: null,
      Stop: "Stop",
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
    },
    notes:
      "SUPPORTED_EVENTS = PreToolUse, PostToolUse, SessionStart, Stop (PascalCase 1:1). PreCompact/SessionEnd/UserPromptSubmit/Notification and all four newer events -> warn-skip (null). Hooks in a SEPARATE hooks.json (path-probed; medium confidence). MCP mcp_config.json (root mcpServers; remote uses serverUrl key). Wire fields are camelCase (toolName/toolInput/toolOutput/sessionId/stopHookActive). canModifyOutput TRUE. Reply (stdout exit 0): deny -> { decision:'deny', reason }; ask -> degrades to deny; modify -> { updatedInput } (PreToolUse) / { updatedOutput } (PostToolUse) — camelCase top-level; context -> { additionalContext }. Opt-in host-native usage adds an AfterModel usage-event sink (not a connector event).",
  },
  {
    platform: "antigravity-cli",
    displayName: "Antigravity CLI",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath:
      "<resolvedUserConfigDir>/hooks.json (inherited from antigravity; project <projectDir>/.agents/hooks.json)",
    capabilities: {
      canModifyArgs: true,
      canModifyOutput: true,
      canInjectSessionContext: true,
    },
    events: {
      SessionStart: "SessionStart",
      SessionEnd: null,
      UserPromptSubmit: null,
      PreToolUse: "PreToolUse",
      PostToolUse: "PostToolUse",
      PreCompact: null,
      Stop: "Stop",
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
    },
    notes:
      "Thin subclass of AntigravityAdapter — REUSES all hook install/parse/format logic unchanged; only id ('antigravity-cli'), name, detection (probes ~/.local/bin/agy), and userConfigCandidates differ (CLI prefers ~/.gemini/config/mcp_config.json for MCP). Therefore the event map, reply shape, and capabilities are IDENTICAL to antigravity: PreToolUse/PostToolUse/SessionStart/Stop supported (PascalCase 1:1); PreCompact/SessionEnd/UserPromptSubmit/Notification and all four newer events null. Same separate hooks.json, same camelCase wire, same { decision:'deny' } / { updatedInput }/{ updatedOutput } / { additionalContext } replies.",
  },
  {
    platform: "droid",
    displayName: "Droid (Factory)",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath:
      "~/.factory/hooks.json (separate from mcp.json; project <projectDir>/.factory/hooks.json)",
    capabilities: {
      canModifyArgs: false,
      canModifyOutput: false,
      canInjectSessionContext: true,
    },
    events: {
      SessionStart: null,
      SessionEnd: null,
      UserPromptSubmit: "UserPromptSubmit",
      PreToolUse: "PreToolUse",
      PostToolUse: "PostToolUse",
      PreCompact: null,
      Stop: "Stop",
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: "SubagentStop",
    },
    notes:
      "SUPPORTED_EVENTS = PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop (Claude-identical PascalCase 1:1 — Droid is a STOP-ONLY subagent host: no SubagentStart). PreCompact/SessionStart/SessionEnd/Notification -> warn-skip (null); PermissionRequest/PostToolUseFailure/SubagentStart have no Droid analog -> warn-skip too. MCP in ~/.factory/mcp.json (type 'stdio'|'http' + disabled flag); hooks in a SEPARATE ~/.factory/hooks.json, Claude-shaped nested { matcher, hooks:[{type,command}] }. Reply (Claude-shaped, stdout exit 0): deny/ask -> hookSpecificOutput{ permissionDecision + reason }; context -> { additionalContext }; SubagentStop deny -> TOP-LEVEL { decision:'block', reason } (Stop semantics — NOT the permissionDecision envelope). canModifyArgs/Output false (modify degrades to allow).",
  },
  {
    platform: "opencode",
    displayName: "OpenCode",
    paradigm: "ts-plugin",
    hasHooks: true,
    configPath:
      "~/.config/opencode/plugin/<connector-id>.js (auto-loaded ESM bridge module; project <projectDir>/.opencode/plugin)",
    capabilities: {
      canModifyArgs: true,
      canModifyOutput: true,
      canInjectSessionContext: true,
    },
    events: {
      SessionStart: "experimental.chat.system.transform",
      SessionEnd: null,
      UserPromptSubmit: null,
      PreToolUse: "tool.execute.before",
      PostToolUse: "tool.execute.after",
      PreCompact: null,
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
    },
    notes:
      "Reference ts-plugin host. EVENT_TO_OPENCODE: PreToolUse->tool.execute.before (mutate output.args / throw to deny), PostToolUse->tool.execute.after (mutate output.output), SessionStart->experimental.chat.system.transform (surrogate; inject additionalContext into output.system). SessionEnd/UserPromptSubmit/PreCompact/Stop/Notification and all four newer events null (subagents run as child sessions — only bus events, no dedicated hook). MCP in opencode.json root key 'mcp' (command is ARRAY, env key 'environment'). Hook 'config path' is the generated plugin .js (auto-discovered by dir). No 'ask' gate -> ask degrades to a thrown block. Bridge shells out to <homeBin> hook opencode <event> --connector <id>; formatReply emits the NORMALIZED HookResponse on stdout (the bridge parses it directly).",
  },
  {
    platform: "mimo-code",
    displayName: "MiMoCode",
    paradigm: "ts-plugin",
    hasHooks: true,
    configPath:
      "~/.config/mimocode/plugin/<connector-id>.js (auto-loaded ESM bridge module; project <projectDir>/.mimocode/plugin)",
    capabilities: {
      canModifyArgs: true,
      canModifyOutput: true,
      canInjectSessionContext: true,
    },
    events: {
      SessionStart: "experimental.chat.system.transform",
      SessionEnd: null,
      UserPromptSubmit: null,
      PreToolUse: "tool.execute.before",
      PostToolUse: "tool.execute.after",
      PreCompact: null,
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
    },
    notes:
      "Xiaomi MiMoCode (@mimo-ai/cli, bin `mimo`) — an OpenCode FORK; STANDALONE adapter mirroring OpenCode's render logic with mimocode paths so detection, the runtime bridge, and per-platform overrides route to the mimo-code id (NOT opencode). EVENT_TO_MIMOCODE identical to OpenCode: PreToolUse->tool.execute.before (mutate output.args / throw to deny), PostToolUse->tool.execute.after (mutate output.output), SessionStart->experimental.chat.system.transform (inject into output.system); rest null. MCP in mimocode.json root key 'mcp' (command ARRAY, env key 'environment'). Hook 'config path' is the generated plugin .js (auto-discovered by dir). ask degrades to a thrown block. Bridge shells out to <homeBin> hook mimo-code <event> --connector <id>; formatReply emits the NORMALIZED HookResponse.",
  },
  {
    platform: "kilo-cli",
    displayName: "Kilo CLI",
    paradigm: "ts-plugin",
    hasHooks: true,
    configPath:
      '~/.config/kilo/plugin/<connector-id>.js + kilo.jsonc "plugin"[] (project <projectDir>/.kilo/plugin)',
    capabilities: {
      canModifyArgs: true,
      canModifyOutput: true,
      canInjectSessionContext: true,
    },
    events: {
      SessionStart: "experimental.chat.system.transform",
      SessionEnd: null,
      UserPromptSubmit: null,
      PreToolUse: "tool.execute.before",
      PostToolUse: "tool.execute.after",
      PreCompact: null,
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
    },
    notes:
      "OpenCode fork (loads @kilocode/plugin PluginModule { id, server:(input)=>Hooks }). EVENT_TO_KILO identical to OpenCode: PreToolUse->tool.execute.before, PostToolUse->tool.execute.after, SessionStart->experimental.chat.system.transform; rest — including all four newer events — null. DIFFERENCE: NOT auto-discovered by dir — installHooks ALSO registers the module path in kilo.jsonc's top-level 'plugin' array (root MCP key 'mcp', command ARRAY + environment). Bridge shells out to <homeBin> hook kilo-cli <event> --connector <id>; formatReply emits the NORMALIZED HookResponse on stdout. ask degrades to thrown block.",
  },
  {
    platform: "omp",
    displayName: "Oh My Pi (OMP)",
    paradigm: "ts-plugin",
    hasHooks: true,
    configPath:
      "~/.omp/agent/extensions/<connector-id>/index.js (+ package.json manifest; project <projectDir>/.omp)",
    capabilities: {
      canModifyArgs: false,
      canModifyOutput: false,
      canInjectSessionContext: false,
    },
    events: {
      SessionStart: "session_start",
      SessionEnd: null,
      UserPromptSubmit: null,
      PreToolUse: "tool_call",
      PostToolUse: "tool_result",
      PreCompact: "session_before_compact",
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
    },
    notes:
      "EVENT_TO_OMP (pi.on targets): PreToolUse->tool_call, PostToolUse->tool_result, SessionStart->session_start, PreCompact->session_before_compact. SessionEnd/UserPromptSubmit/Stop/Notification and all four newer events null (agent_start/agent_end are the MAIN loop, not subagents; failures arrive merged as tool_result isError). Loads an EXTENSION PACKAGE: generated index.js (HookFactory (pi)=>void) + package.json with 'omp' manifest field; MCP native ~/.omp/agent/mcp.json (mcpServers). PreToolUse gates via { block:true, reason } (deny/ask both block; modify -> allow). tool_result/session_start observe-only -> canModifyArgs/Output/InjectContext all false. Bridge shells to <homeBin> hook omp <event> --connector <id>; formatReply emits NORMALIZED HookResponse.",
  },
  {
    platform: "nemoclaw",
    displayName: "NVIDIA NemoClaw",
    paradigm: "ts-plugin",
    hasHooks: true,
    configPath:
      "<stateDir>/extensions/<id>/index.mjs + the WRAPPED openclaw.json dual-reg (plugins.entries+load.paths & mcp.servers; project <projectDir>/.openclaw); detected via ~/.nemoclaw/",
    capabilities: {
      canModifyArgs: true,
      canModifyOutput: false,
      canInjectSessionContext: true,
    },
    events: {
      SessionStart: "session_start",
      SessionEnd: null,
      UserPromptSubmit: null,
      PreToolUse: "before_tool_call",
      PostToolUse: "after_tool_call",
      PreCompact: null,
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: "subagent_spawned",
      SubagentStop: "subagent_ended",
    },
    notes:
      "NVIDIA NemoClaw WRAPS OpenClaw — a thin FORK of the OpenClaw adapter (extends OpenClawAdapter, overriding only id/name/detection). It inherits OpenClaw's hook machinery verbatim, so the event map + capabilities are OpenClaw's: PreToolUse->before_tool_call (modify mutates event.params; deny/ask block), PostToolUse->after_tool_call (observe-only -> canModifyOutput false), SessionStart->session_start + before_prompt_build injection, SubagentStart/Stop->subagent_spawned/ended (observe-only). NemoClaw ships NO Claude-style hooks of its own, but the inherited bridge writes the same DUAL REGISTRATION into the WRAPPED ~/.openclaw/openclaw.json (the agent NemoClaw runs). Detection keys on the NemoClaw-specific ~/.nemoclaw/ marker: OpenClaw's detection BOWS OUT when ~/.nemoclaw/ is present (and nemoclaw is registered BEFORE openclaw), so a real NemoClaw box — which has BOTH markers — is never double-targeted. The inherited bridge is HOST-BOUND to this id: <homeBin> hook nemoclaw <event> (NOT openclaw — events route back to the nemoclaw adapter); formatReply emits NORMALIZED HookResponse.",
  },
  {
    platform: "openclaw",
    displayName: "OpenClaw",
    paradigm: "ts-plugin",
    hasHooks: true,
    configPath:
      "<stateDir>/extensions/<id>/index.mjs + openclaw.json dual-reg (plugins.entries+load.paths & mcp.servers; project <projectDir>/.openclaw)",
    capabilities: {
      canModifyArgs: true,
      canModifyOutput: false,
      canInjectSessionContext: true,
    },
    events: {
      SessionStart: "session_start",
      SessionEnd: null,
      UserPromptSubmit: null,
      PreToolUse: "before_tool_call",
      PostToolUse: "after_tool_call",
      PreCompact: null,
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: "subagent_spawned",
      SubagentStop: "subagent_ended",
    },
    notes:
      "EVENT_TO_OPENCLAW (api.on targets): PreToolUse->before_tool_call (block via { block, blockReason }, deny/ask both block; modify mutates event.params), PostToolUse->after_tool_call (observe only -> canModifyOutput false), SessionStart->session_start (records id) PLUS before_prompt_build (the actual context-injection point via { appendSystemContext }), SubagentStart->subagent_spawned + SubagentStop->subagent_ended (BOTH observe-only — no decision or context payload, so a SubagentStop deny cannot keep the subagent running here). SessionEnd/UserPromptSubmit/PreCompact/Stop/Notification null; PermissionRequest null (the permission gate is the requireApproval RETURN VALUE of before_tool_call, not an event); PostToolUseFailure null (failures arrive merged into after_tool_call). DUAL REGISTRATION in openclaw.json (JSON5): plugins.entries.<id>={enabled:true} + plugins.load.paths[dir] (LOAD) AND mcp.servers.<id> (SURFACE TOOLS) — both required. Generated index.mjs + openclaw.plugin.json manifest. Bridge -> <homeBin> hook openclaw <event> --connector <id>; formatReply emits NORMALIZED HookResponse.",
  },
  {
    platform: "amp",
    displayName: "Amp",
    paradigm: "mcp-only",
    hasHooks: false,
    configPath: "—",
    capabilities: {
      canModifyArgs: false,
      canModifyOutput: false,
      canInjectSessionContext: false,
    },
    events: {
      SessionStart: null,
      SessionEnd: null,
      UserPromptSubmit: null,
      PreToolUse: null,
      PostToolUse: null,
      PreCompact: null,
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
    },
    notes:
      "mcp-only: no lifecycle hook system. installHooks/uninstallHooks return a single 'skip' ('hooks unavailable (Amp is mcp-only)'); all events null. MCP only: ~/.config/amp/settings.json under a FLAT dotted key 'amp.mcpServers' (not nested mcpServers). Native ${VAR} interpolation. All hook capabilities false.",
  },
  {
    platform: "codebuff",
    displayName: "Codebuff",
    paradigm: "mcp-only",
    hasHooks: false,
    configPath: "—",
    capabilities: {
      canModifyArgs: false,
      canModifyOutput: false,
      canInjectSessionContext: false,
    },
    events: {
      SessionStart: null,
      SessionEnd: null,
      UserPromptSubmit: null,
      PreToolUse: null,
      PostToolUse: null,
      PreCompact: null,
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
    },
    notes:
      "mcp-only: no hook system. installHooks returns 'skip' ('hooks unavailable (Codebuff is mcp-only)'); all events null. MCP only: <projectDir>/.agents/mcp.json (project preferred) or ~/.agents/mcp.json, root 'mcpServers', entry type 'stdio'. Native $VAR interpolation. All hook capabilities false.",
  },
  {
    platform: "kilo",
    displayName: "Kilo Code",
    paradigm: "ts-plugin",
    hasHooks: true,
    configPath:
      '~/.config/kilo/plugin/<connector-id>.js + kilo.json "plugin"[] (project <projectDir>/.kilo/plugin)',
    capabilities: {
      canModifyArgs: true,
      canModifyOutput: true,
      canInjectSessionContext: true,
    },
    events: {
      SessionStart: "experimental.chat.system.transform",
      SessionEnd: null,
      UserPromptSubmit: null,
      PreToolUse: "tool.execute.before",
      PostToolUse: "tool.execute.after",
      PreCompact: null,
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
    },
    notes:
      "Kilo Code VS Code extension (DISTINCT from kilo-cli, but the 7.x line is rebuilt ON the Kilo CLI server, so it shares the ts-plugin hook layer). EVENT_TO_KILO identical to OpenCode/kilo-cli: PreToolUse->tool.execute.before, PostToolUse->tool.execute.after, SessionStart->experimental.chat.system.transform; rest — including all four newer events — null. installHooks writes the generated plugin module to .kilo/plugin/<id>.js (project) / ~/.config/kilo/plugin/<id>.js (user) AND registers the path in kilo.json's top-level 'plugin' array (mirrors kilo-cli). MCP shares the kilo backend: ~/.config/kilo/kilo.json (root 'mcp', entry type 'local' command ARRAY + environment) — kilo.json and kilo-cli's kilo.jsonc MERGE. Also authors COMMANDS + SUBAGENTS under .kilocode/ and SKILLS under .kilo/skills/. Bridge shells to <homeBin> hook kilo <event> --connector <id>; formatReply emits the NORMALIZED HookResponse. ask degrades to thrown block.",
  },
  {
    platform: "mux",
    displayName: "Mux",
    paradigm: "mcp-only",
    hasHooks: false,
    configPath: "—",
    capabilities: {
      canModifyArgs: false,
      canModifyOutput: false,
      canInjectSessionContext: false,
    },
    events: {
      SessionStart: null,
      SessionEnd: null,
      UserPromptSubmit: null,
      PreToolUse: null,
      PostToolUse: null,
      PreCompact: null,
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
    },
    notes:
      "mcp-only: no hook system; installHooks 'skip' ('hooks unavailable (Mux is mcp-only)'); all events null. MCP only: ~/.mux/mcp.jsonc, root key 'servers'; QUIRK each server value is a single shell-command STRING (not an object), stdio-only. All hook capabilities false.",
  },
  {
    platform: "pi",
    displayName: "Pi",
    paradigm: "mcp-only",
    hasHooks: false,
    configPath: "—",
    capabilities: {
      canModifyArgs: false,
      canModifyOutput: false,
      canInjectSessionContext: false,
    },
    events: {
      SessionStart: null,
      SessionEnd: null,
      UserPromptSubmit: null,
      PreToolUse: null,
      PostToolUse: null,
      PreCompact: null,
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
    },
    notes:
      "mcp-only: no hook system AND no writable MCP config — installServer AND installHooks both 'skip'; all events null. Only surface implemented is Agent Skills (~/.pi/skills/<name>/SKILL.md). transports: [] (no server registration possible). All hook capabilities false.",
  },
  {
    platform: "roo-code",
    displayName: "Roo Code",
    paradigm: "mcp-only",
    hasHooks: false,
    configPath: "—",
    capabilities: {
      canModifyArgs: false,
      canModifyOutput: false,
      canInjectSessionContext: false,
    },
    events: {
      SessionStart: null,
      SessionEnd: null,
      UserPromptSubmit: null,
      PreToolUse: null,
      PostToolUse: null,
      PreCompact: null,
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
    },
    notes:
      "Roo Code VS Code extension (Cline fork). mcp-only: no hook system; installHooks 'skip' ('hooks unavailable (Roo Code is mcp-only)'); all events null. MCP only: VS Code globalStorage <userDir>/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json (project <projectDir>/.roo/mcp.json), root 'mcpServers'. All hook capabilities false.",
  },
  {
    platform: "trae",
    displayName: "Trae",
    paradigm: "mcp-only",
    hasHooks: false,
    configPath: "—",
    capabilities: {
      canModifyArgs: false,
      canModifyOutput: false,
      canInjectSessionContext: false,
    },
    events: {
      SessionStart: null,
      SessionEnd: null,
      UserPromptSubmit: null,
      PreToolUse: null,
      PostToolUse: null,
      PreCompact: null,
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
    },
    notes:
      "mcp-only: no hook system; installHooks 'skip' ('hooks unavailable (Trae is mcp-only)'); all events null. MCP only: ~/.trae/mcp.json (project <projectDir>/.trae/mcp.json), root 'mcpServers', stdio { command,args,env }. All hook capabilities false.",
  },
  {
    platform: "warp",
    displayName: "Warp",
    paradigm: "mcp-only",
    hasHooks: false,
    configPath: "—",
    capabilities: {
      canModifyArgs: false,
      canModifyOutput: false,
      canInjectSessionContext: false,
    },
    events: {
      SessionStart: null,
      SessionEnd: null,
      UserPromptSubmit: null,
      PreToolUse: null,
      PostToolUse: null,
      PreCompact: null,
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
    },
    notes:
      "Reference mcp-only host (no hook system, FR #7834). installHooks 'skip' ('hooks unavailable (Warp is mcp-only)'); all events null. MCP only: ~/.warp/.mcp.json (project <projectDir>/.warp/.mcp.json), root 'mcpServers'; QUIRK stdio working dir keyed as working_directory (not cwd). All hook capabilities false.",
  },
  {
    platform: "zed",
    displayName: "Zed",
    paradigm: "mcp-only",
    hasHooks: false,
    configPath: "—",
    capabilities: {
      canModifyArgs: false,
      canModifyOutput: false,
      canInjectSessionContext: false,
    },
    events: {
      SessionStart: null,
      SessionEnd: null,
      UserPromptSubmit: null,
      PreToolUse: null,
      PostToolUse: null,
      PreCompact: null,
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
    },
    notes:
      "mcp-only (IDE, no hook pipeline). installHooks 'skip' ('hooks unavailable (Zed is mcp-only)'); all events null. MCP ('context servers') in settings.json under root key 'context_servers' (NOT mcpServers); user dir is OS-native dirs::config_dir() (~/.config/zed or %APPDATA%\\Zed); project <projectDir>/.zed/settings.json. FLAT stdio entry { command, args, env }. All hook capabilities false.",
  },
];

export const hooksMatrix: HooksMatrix = { canonicalEvents, platforms };

/** Platforms grouped + ordered by paradigm (matrix column groups). */
export const platformsByParadigm: Record<HookParadigm, PlatformHookEntry[]> = {
  "json-stdio": platforms.filter((p) => p.paradigm === "json-stdio"),
  "ts-plugin": platforms.filter((p) => p.paradigm === "ts-plugin"),
  "mcp-only": platforms.filter((p) => p.paradigm === "mcp-only"),
};

/** Look up a single platform's hook entry by id. */
export function platformById(id: string): PlatformHookEntry | undefined {
  return platforms.find((p) => p.platform === id);
}
