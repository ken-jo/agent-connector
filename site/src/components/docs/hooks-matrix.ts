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

import { familyKey } from "../../platform-data";

/**
 * The 13 normalized lifecycle events a developer writes once against. The newer
 * additions (PermissionRequest / PostToolUseFailure / SubagentStart /
 * SubagentStop and the trailing PostCompact) have cross-host analogs; hosts
 * without a native analog mark them unsupported and the install reports a
 * skip-warn. PostCompact is observational only (the post-compaction sibling of
 * PreCompact; codex is the verified firing host).
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
  | "SubagentStop"
  | "PostCompact";

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

/** Ordered list of the 13 canonical events (matrix row order = core ALL_EVENTS order). */
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
  "PostCompact",
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
      PostCompact: null,
    },
    notes:
      "Reference json-stdio host. 12 of the 13 canonical events map 1:1 (PascalCase); PostCompact is the one Claude Code does not fire (capability unset, matrix cell null). Reply: stdout JSON hookSpecificOutput{ hookEventName, permissionDecision: deny|ask + permissionDecisionReason; or updatedInput (PreToolUse only); or additionalContext } with exit 0. allow/void = exit 0. Event-specific shapes: PermissionRequest uses the nested decision{ behavior:'allow'|'deny' } envelope — an EXPLICIT allow is an active grant that suppresses the dialog (+updatedInput; never overrides host deny rules), deny carries message, and ask/context/void emit NO decision (fall through to the native dialog). PostToolUseFailure & SubagentStart are context-only (deny degrades to additionalContext carrying the reason). Stop/SubagentStop/UserPromptSubmit/PostToolUse deny = TOP-LEVEL { decision:'block', reason } (a SubagentStop block keeps the subagent running). canModifyOutput false (cannot rewrite emitted tool output). Each settings.json hook value is { matcher, hooks:[{type:'command',command}] }.",
  },
  {
    platform: "codebuddy",
    displayName: "CodeBuddy",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath: '~/.codebuddy/settings.json (under "hooks", keyed by event)',
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
      PostCompact: null,
    },
    notes:
      "Tencent CodeBuddy Code — a close Claude Code fork (`@tencent-ai/codebuddy-code`, bin `codebuddy`). Identical hook surface to claude-code: the same 12-of-13 canonical events map 1:1 (PostCompact unset → null cell), the same snake_case stdin fields, and the same reply envelope (hookSpecificOutput{ permissionDecision deny|ask + reason; updatedInput on PreToolUse; additionalContext }; Stop/SubagentStop/UserPromptSubmit/PostToolUse deny = TOP-LEVEL { decision:'block', reason }; PermissionRequest nested decision{ behavior }). Storage is rebranded: ~/.codebuddy/settings.json hooks, ~/.codebuddy.json/.mcp.json mcpServers, CODEBUDDY.md memory. Bundle-confirmed against v2.109.0; not live-verifiable locally (Tencent auth).",
  },
  {
    platform: "codex",
    displayName: "Codex CLI",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath: "$CODEX_HOME|~/.codex/hooks.json (Claude-shaped {matcher,hooks[]})",
    capabilities: {
      canModifyArgs: true,
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
      PostCompact: "PostCompact",
    },
    notes:
      "CODEX_HOOK_EVENTS = SessionStart, PreToolUse, PostToolUse, PreCompact, UserPromptSubmit, Stop, PermissionRequest, SubagentStart, SubagentStop, PostCompact (PascalCase, Claude-compatible names). PostCompact is the observe-only post-compaction sibling of PreCompact (Codex fires both) — normalizes `trigger` (manual|auto), passthrough reply. SessionEnd & Notification dropped (capabilities false; never written); PostToolUseFailure has NO Codex analog -> warn-skip at install. MCP in config.toml [mcp_servers]. Reply: PreToolUse deny -> stdout hookSpecificOutput{ permissionDecision:'deny' }; PermissionRequest deny/allow -> nested hookSpecificOutput.decision{ behavior, message? } (updatedInput/updatedPermissions/interrupt FAIL CLOSED on Codex, so never emitted); SubagentStart context -> additionalContext; SubagentStop deny -> TOP-LEVEL { decision:'block', reason } (keeps the subagent going); additionalContext honored on SessionStart, PostToolUse & PreToolUse; modify -> PreToolUse rewrite as hookSpecificOutput{ permissionDecision:'allow', updatedInput } (Codex requires updatedInput paired with allow; stable since 0.131.0); ask unsupported -> exit 0 passthrough. PreToolUse matcher is a charset-clean regex string.",
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
      SessionEnd: "sessionEnd",
      UserPromptSubmit: "beforeSubmitPrompt",
      PreToolUse: "preToolUse",
      PostToolUse: "postToolUse",
      PreCompact: "preCompact",
      Stop: "stop",
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: "postToolUseFailure",
      SubagentStart: "subagentStart",
      SubagentStop: "subagentStop",
      PostCompact: null,
    },
    notes:
      "EVENT_MAP lower-camel: PreToolUse->preToolUse, PostToolUse->postToolUse, SessionStart->sessionStart, Stop->stop, plus the documented Subagent (Task tool) lifecycle + tool-failure hooks SubagentStart->subagentStart, SubagentStop->subagentStop, PostToolUseFailure->postToolUseFailure, and the v1.7 lifecycle/prompt events SessionEnd->sessionEnd, PreCompact->preCompact, UserPromptSubmit->beforeSubmitPrompt (Cursor matches beforeSubmitPrompt against the value 'UserPromptSubmit'). Notification/PermissionRequest have no Cursor equivalent -> warn-skip (null); Cursor's permission gate is the OUTPUT field `permission` of its before* hooks, not an observable event. FLAT entry { command, matcher? } (no nested hooks[]). Reply (stdout JSON, exit 0): deny/ask -> { permission:'deny'|'ask', user_message } (a SubagentStop deny rides the same shape with Stop semantics); modify -> { updated_input } (PreToolUse); context -> { agent_message } (PreToolUse) or { additional_context } (Post/SessionStart). postToolUseFailure & subagentStart are observe/context-only -> { additional_context } (deny degrades to it carrying the reason). beforeSubmitPrompt is a BLOCK gate -> deny emits { continue:false, user_message }, otherwise { continue:true } (no context-injection field). sessionEnd (fire-and-forget) & preCompact (observational, cannot block) are no-op passthroughs (exit 0). Emits non-empty JSON even on no-op (Cursor rejects empty stdout).",
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
      UserPromptSubmit: "UserPromptSubmit",
      PreToolUse: "PreToolUse",
      PostToolUse: "PostToolUse",
      PreCompact: "PreCompact",
      Stop: "Stop",
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: "SubagentStart",
      SubagentStop: "SubagentStop",
      PostCompact: null,
    },
    notes:
      "EVENT_MAP PascalCase 1:1 — all EIGHT events in VS Code's official Hook Events table (microsoft/vscode-copilot-chat hooks.md): SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, Stop, SubagentStart, SubagentStop. SessionEnd/Notification + PermissionRequest/PostToolUseFailure are NOT in the list -> warn-skip (null). Hook file is per-connector under the WORKSPACE .github/hooks tree (project-rooted both scopes); top-level version:1 REQUIRED. FLAT { type:'command', command } entries; matchers parsed but IGNORED. Reply (Claude-compatible, stdout exit 0): tool-permission events use hookSpecificOutput{ permissionDecision deny|ask + reason; updatedInput (PreToolUse); additionalContext }; the turn-control events Stop / UserPromptSubmit / SubagentStop deny -> TOP-LEVEL { decision:'block', reason } per the Output Contract (Stop/SubagentStop keep running with reason; UserPromptSubmit blocks the prompt). SubagentStart is context-only (deny degrades to additionalContext). canModifyOutput false.",
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
      SessionEnd: "SessionEnd",
      UserPromptSubmit: "UserPromptSubmit",
      PreToolUse: "PreToolUse",
      PostToolUse: "PostToolUse",
      PreCompact: "PreCompact",
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
      PostCompact: null,
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
      "~/.copilot/hooks/agent-connector.json ({version:1,hooks:{<camelCaseWireKey>:[{matcher,hooks[]}]}})",
    capabilities: {
      canModifyArgs: true,
      canModifyOutput: false,
      // 1.0.63 has NO additionalContext mechanism (zero occurrences in app.js),
      // so context injection is a silent no-op — fail-safe false (mirrors the
      // copilot-cli adapter capability literal).
      canInjectSessionContext: false,
    },
    events: {
      SessionStart: "sessionStart",
      SessionEnd: "sessionEnd",
      UserPromptSubmit: "userPromptSubmitted",
      PreToolUse: "preToolUse",
      PostToolUse: "postToolUse",
      PreCompact: "preCompact",
      Stop: "agentStop",
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: "subagentStop",
      PostCompact: null,
    },
    notes:
      "8 of the 13 canonical events map to the CLI's file-hook loader (verified validator Set in GitHub Copilot CLI 1.0.63 app.js): sessionStart, sessionEnd, userPromptSubmitted, preToolUse, postToolUse, preCompact, agentStop (Stop), subagentStop. Event KEYS are lowerCamelCase via EVENT_WIRE_KEY (Stop->agentStop, UserPromptSubmit->userPromptSubmitted; the rest first-letter-lowercased) — the loader SILENTLY DROPS any other key (PascalCase included), so a PascalCase key would NEVER fire. Notification/PermissionRequest/SubagentStart/PostToolUseFailure are NOT in the installed 1.0.63 Set (the github/docs main reference describes them for a newer CLI) — demoted to warn-skip until a verified bundle ships them. PostCompact unsupported. User/global only (no project scope). MCP in ~/.copilot/mcp-config.json (stdio written as type 'local' + tools:['*']). Nested { matcher, hooks:[{type,command}] }; the home-bin command token stays the PascalCase AC router event. Reply (stdout exit 0): 1.0.63 reads the PreToolUse permission decision FLAT at the TOP LEVEL — { permissionDecision deny|ask + permissionDecisionReason; modifiedArgs (PreToolUse modify) } — there is NO hookSpecificOutput wrapper in 1.0.63 (verified: zero occurrences in app.js) and PreToolUse is the only event whose reply the host reads. The host has no additionalContext mechanism, so context injection is a no-op (canInjectSessionContext false). SubagentStop deny -> TOP-LEVEL { decision:'block', reason } (kept for forward-compat; unread on 1.0.63). canModifyOutput false.",
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
      PostCompact: null,
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
      PostCompact: "PostCompact",
    },
    notes:
      "Gemini-CLI fork but Claude-COMPATIBLE hook protocol: all 13 canonical events PascalCase 1:1 (incl. PostCompact; NOT Gemini's BeforeTool/AfterTool). Registered canonical event name directly. MCP + hooks share settings.json; transport by key (type:'stdio' tolerated for stdio, url=sse, httpUrl=http). Claude-shaped nested { matcher, hooks:[{type,command}] }. Reply (stdout exit 0): hookSpecificOutput{ permissionDecision deny|ask + reason; updatedInput (PreToolUse only); additionalContext }. PermissionRequest uses the nested decision{ behavior:'allow'|'deny' } envelope (explicit allow grant +updatedInput; ask/context/void fall through to the dialog); PostToolUseFailure & SubagentStart are context-only (deny degrades to additionalContext); SubagentStop deny -> TOP-LEVEL { decision:'block', reason } Stop shape. canModifyOutput false (no updatedMCPToolOutput in qwen 0.17.1).",
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
      PostCompact: null,
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
      "$KIMI_CODE_HOME|~/.kimi-code/config.toml ([[hooks]] array-of-tables)",
    capabilities: {
      canModifyArgs: false,
      canModifyOutput: false,
      canInjectSessionContext: false,
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
      PostCompact: "PostCompact",
    },
    notes:
      "Full coverage: KIMI_HOOK_EVENTS now spans every canonical event (PascalCase 1:1) — Kimi documents a native hook for all of them. Hooks in config.toml as [[hooks]] tables { event, matcher, command }; MCP in ~/.kimi-code/mcp.json (mcpServers). BLOCKABLE events (per the kimi-code docs) are only PreToolUse, Stop and UserPromptSubmit; the rest fire observation-only. PreToolUse DENY: exit 0 + stdout hookSpecificOutput{ permissionDecision:'deny' + reason } (Claude/Codex shape). Stop / UserPromptSubmit / SubagentStop DENY use Kimi's generic block protocol: EXIT 2 + reason on stderr (Stop/SubagentStop continue with the reason; UserPromptSubmit blocks the turn). PostToolUseFailure & SubagentStart are observe/context-only: 'context' emits the text PLAIN on exit-0 stdout (Kimi adds non-empty stdout to context; deny degrades to the same carrying the reason). Three Kimi-only observation events (StopFailure, PermissionResult, Interrupt) are documented but not promoted to the core model (below the >=3-host bar); use nativeHooks for them. canModify* and canInjectSessionContext all false.",
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
      PostCompact: null,
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
      SessionEnd: "SessionEnd",
      UserPromptSubmit: "UserPromptSubmit",
      PreToolUse: "PreToolUse",
      PostToolUse: "PostToolUse",
      PreCompact: null,
      Stop: "Stop",
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: "PostToolUseFailure",
      SubagentStart: null,
      SubagentStop: null,
      PostCompact: null,
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
      PostCompact: null,
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
      PostCompact: null,
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
      SessionStart: null,
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
      PostCompact: null,
    },
    notes:
      "Thin subclass of AntigravityAdapter — REUSES all hook install/parse/format logic unchanged; only id ('antigravity-cli'), name, detection (probes ~/.local/bin/agy), userConfigCandidates (CLI prefers ~/.gemini/config/mcp_config.json for MCP), and the supported-event set differ. LIVE-VERIFIED: the `agy` CLI recognizes EXACTLY PreToolUse/PostToolUse/PreInvocation/PostInvocation/Stop — it does NOT recognize SessionStart (the `/hooks` UI lists only those five; writing both SessionStart + PreToolUse loads only PreToolUse). So SessionStart is DROPPED here (warn-skip at install, never an inert hooks.json entry) — unlike the IDE antigravity adapter, which keeps SessionStart (unverified for the desktop app). PreInvocation/PostInvocation are agy-only with no canonical AC analog (future nativeHooks work). PreCompact/SessionEnd/UserPromptSubmit/Notification and all four newer events null. Same separate hooks.json, same camelCase wire, same { decision:'deny' } / { updatedInput }/{ updatedOutput } / { additionalContext } replies.",
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
      SessionStart: "SessionStart",
      SessionEnd: "SessionEnd",
      UserPromptSubmit: "UserPromptSubmit",
      PreToolUse: "PreToolUse",
      PostToolUse: "PostToolUse",
      PreCompact: "PreCompact",
      Stop: "Stop",
      Notification: "Notification",
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: "SubagentStop",
      PostCompact: null,
    },
    notes:
      "SUPPORTED_EVENTS = PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop, Notification, PreCompact, SessionStart, SessionEnd (Claude-identical PascalCase 1:1 per docs.factory.ai/reference/hooks-reference — Droid is a STOP-ONLY subagent host: no SubagentStart). PermissionRequest/PostToolUseFailure/SubagentStart have no Droid analog -> warn-skip. MCP in ~/.factory/mcp.json (type 'stdio'|'http' + disabled flag); hooks in a SEPARATE ~/.factory/hooks.json, Claude-shaped nested { matcher, hooks:[{type,command}] }. Reply (Claude-shaped, stdout exit 0): deny/ask -> hookSpecificOutput{ permissionDecision + reason }; context -> { additionalContext }; SubagentStop deny -> TOP-LEVEL { decision:'block', reason } (Stop semantics — NOT the permissionDecision envelope). Notification/PreCompact/SessionEnd are observe-only (Decision Control N/A) -> passthrough exit 0; SessionStart honors hookSpecificOutput.additionalContext (context-injection). canModifyArgs/Output false (modify degrades to allow).",
  },
  {
    platform: "openhands",
    displayName: "OpenHands",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath:
      ".openhands/hooks.json (separate from ~/.openhands/mcp.json; HookConfig.load searches <projectDir>/.openhands then ~/.openhands)",
    capabilities: {
      canModifyArgs: false,
      canModifyOutput: false,
      canInjectSessionContext: true,
    },
    events: {
      SessionStart: "SessionStart",
      SessionEnd: "SessionEnd",
      UserPromptSubmit: "UserPromptSubmit",
      PreToolUse: "PreToolUse",
      PostToolUse: "PostToolUse",
      PreCompact: null,
      Stop: "Stop",
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
      PostCompact: null,
    },
    notes:
      "HookEventType (openhands-sdk hooks/types.py) = exactly SIX events: PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, SessionEnd, Stop (Claude-identical PascalCase). No Notification/PreCompact/SubagentStop/PermissionRequest/PostToolUseFailure/SubagentStart -> warn-skip. MCP in ~/.openhands/mcp.json (FastMCP { command, args, env, transport }; $OPENHANDS_PERSISTENCE_DIR overrides the dir); hooks in a SEPARATE .openhands/hooks.json carrying the Claude-Code-plugin-compatible wrapped nested shape { hooks: { <Event>: [{ matcher, hooks:[{type,command}] }] } } (config.py _normalize_hooks_input explicitly accepts 'Claude Code plugin hook files'). Wire DIVERGES from Claude: stdin fields are event_type / tool_name / tool_input / tool_response(dict) / message(the prompt, NOT 'prompt') / session_id / working_dir(NOT 'cwd') / metadata. Reply is FLAT stdout JSON (NO hookSpecificOutput, NO 'ask'): deny -> { decision:'deny', reason } (ask degrades to a deny-style block); context -> { additionalContext }; allow/SessionEnd -> exit 0 passthrough. Exit 2 also blocks (hooks/executor.py). canModifyArgs/Output false; additionalContext honored (canInjectSessionContext).",
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
      PermissionRequest: "permission.ask",
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
      PostCompact: null,
    },
    notes:
      "Reference ts-plugin host. EVENT_TO_OPENCODE: PreToolUse->tool.execute.before (mutate output.args / throw to deny), PostToolUse->tool.execute.after (mutate output.output), SessionStart->experimental.chat.system.transform (surrogate; inject additionalContext into output.system), PermissionRequest->permission.ask (decision-capable gate that MUTATES output.status 'ask'|'deny'|'allow' — it does NOT return a value, mirroring tool.execute.before mutating output.args; verified against anomalyco/opencode packages/plugin/src/index.ts). SessionEnd/UserPromptSubmit/PreCompact/Stop/Notification and the remaining newer events null (subagents run as child sessions — only bus events, no dedicated hook). OpenCode also opts into nativeHooks: host-specific plugin events with no normalized name (chat.message, session.idle, permission.replied, command.execute.before, shell.env, …) are reachable via platforms['opencode'].nativeHooks and dispatched host-generically by the home-bin's runNativeHook. MCP in opencode.json root key 'mcp' (command is ARRAY, env key 'environment'). Hook 'config path' is the generated plugin .js (auto-discovered by dir). tool.execute.before has no 'ask' gate -> ask degrades to a thrown block (permission.ask HAS a real 'ask' status, honored verbatim). Bridge shells out to <homeBin> hook opencode <event> --connector <id>; formatReply emits the NORMALIZED HookResponse on stdout (the bridge parses it directly).",
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
      UserPromptSubmit: "chat.message",
      PreToolUse: "tool.execute.before",
      PostToolUse: "tool.execute.after",
      PreCompact: null,
      Stop: "session.idle",
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
      PostCompact: null,
    },
    notes:
      "Xiaomi MiMoCode (@mimo-ai/cli, bin `mimo`) — an OpenCode FORK; STANDALONE adapter mirroring OpenCode's render logic with mimocode paths so detection, the runtime bridge, and per-platform overrides route to the mimo-code id (NOT opencode). EVENT_TO_MIMOCODE: PreToolUse->tool.execute.before (mutate output.args / throw to deny), PostToolUse->tool.execute.after (mutate output.output), SessionStart->experimental.chat.system.transform (inject into output.system), UserPromptSubmit->chat.message (push a {type:'text'} part onto output.parts to inject additionalContext; no block/abort so deny degrades to a no-op), Stop->session.idle ('session finished responding' — NOT a direct hook key; dispatched through the generic `event` hook switching on event.type, a deny throws to halt; mirrors kilo / kilo-cli); rest null. MCP in mimocode.json root key 'mcp' (command ARRAY, env key 'environment'). Hook 'config path' is the generated plugin .js (auto-discovered by dir). ask degrades to a thrown block. Bridge shells out to <homeBin> hook mimo-code <event> --connector <id>; formatReply emits the NORMALIZED HookResponse.",
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
      UserPromptSubmit: "chat.message",
      PreToolUse: "tool.execute.before",
      PostToolUse: "tool.execute.after",
      PreCompact: null,
      Stop: "session.idle",
      Notification: null,
      PermissionRequest: "permission.ask",
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
      PostCompact: null,
    },
    notes:
      "OpenCode fork (loads @kilocode/plugin PluginModule { id, server:(input)=>Hooks }). EVENT_TO_KILO: PreToolUse->tool.execute.before, PostToolUse->tool.execute.after, SessionStart->experimental.chat.system.transform, UserPromptSubmit->chat.message (push a {type:'text'} part onto output.parts to inject additionalContext; no block/abort so deny degrades to a no-op), PermissionRequest->permission.ask (decision-capable gate that MUTATES output.status 'ask'|'deny'|'allow'), Stop->session.idle ('session finished responding' — NOT a direct hook key; dispatched through the generic `event` hook switching on event.type, a deny throws to halt). SessionEnd/PreCompact/Notification + PostToolUseFailure/SubagentStart/SubagentStop null. DIFFERENCE: NOT auto-discovered by dir — installHooks ALSO registers the module path in kilo.jsonc's top-level 'plugin' array (root MCP key 'mcp', command ARRAY + environment). Bridge shells out to <homeBin> hook kilo-cli <event> --connector <id>; formatReply emits the NORMALIZED HookResponse on stdout. ask degrades to a thrown block on tool.execute.before.",
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
      PostCompact: null,
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
      UserPromptSubmit: "before_prompt_build",
      PreToolUse: "before_tool_call",
      PostToolUse: "after_tool_call",
      PreCompact: null,
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: "subagent_spawned",
      SubagentStop: "subagent_ended",
      PostCompact: null,
    },
    notes:
      "NVIDIA NemoClaw WRAPS OpenClaw — a thin FORK of the OpenClaw adapter (extends OpenClawAdapter, overriding only id/name/detection). It inherits OpenClaw's hook machinery verbatim, so the event map + capabilities are OpenClaw's: PreToolUse->before_tool_call (modify mutates event.params; deny/ask block), PostToolUse->after_tool_call (observe-only -> canModifyOutput false), SessionStart->session_start + before_prompt_build injection, UserPromptSubmit->before_prompt_build (per-turn context injection, context-only — before_prompt_build cannot block, so a deny degrades to a no-op), SubagentStart/Stop->subagent_spawned/ended (observe-only), plus supportsNativeHooks (platforms.nemoclaw.nativeHooks bridged verbatim). NemoClaw ships NO Claude-style hooks of its own, but the inherited bridge writes the same DUAL REGISTRATION into the WRAPPED ~/.openclaw/openclaw.json (the agent NemoClaw runs). Detection keys on the NemoClaw-specific ~/.nemoclaw/ marker: OpenClaw's detection BOWS OUT when ~/.nemoclaw/ is present (and nemoclaw is registered BEFORE openclaw), so a real NemoClaw box — which has BOTH markers — is never double-targeted. The inherited bridge is HOST-BOUND to this id: <homeBin> hook nemoclaw <event> (NOT openclaw — events route back to the nemoclaw adapter); formatReply emits NORMALIZED HookResponse.",
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
      UserPromptSubmit: "before_prompt_build",
      PreToolUse: "before_tool_call",
      PostToolUse: "after_tool_call",
      PreCompact: null,
      Stop: null,
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: "subagent_spawned",
      SubagentStop: "subagent_ended",
      PostCompact: null,
    },
    notes:
      "EVENT_TO_OPENCLAW (api.on targets): PreToolUse->before_tool_call (block via { block, blockReason }, deny/ask both block; modify mutates event.params), PostToolUse->after_tool_call (observe only -> canModifyOutput false), SessionStart->session_start (records id) PLUS before_prompt_build (the actual context-injection point via { appendSystemContext }), UserPromptSubmit->before_prompt_build (per-turn context injection via { appendContext }; before_prompt_build fires every prompt build and CANNOT block, so a deny/block decision degrades to a no-op — context-injection only; coexists with SessionStart in one handler via separate state so the once-only SessionStart flag never suppresses the per-turn injection), SubagentStart->subagent_spawned + SubagentStop->subagent_ended (BOTH observe-only — no decision or context payload, so a SubagentStop deny cannot keep the subagent running here). supportsNativeHooks: platforms.openclaw.nativeHooks bridge verbatim via the same on(...) helper (host-generic runNativeHook dispatch). SessionEnd/PreCompact/Stop/Notification null; PermissionRequest null (the permission gate is the requireApproval RETURN VALUE of before_tool_call, not an event); PostToolUseFailure null (failures arrive merged into after_tool_call). DUAL REGISTRATION in openclaw.json (JSON5): plugins.entries.<id>={enabled:true} + plugins.load.paths[dir] (LOAD) AND mcp.servers.<id> (SURFACE TOOLS) — both required. Generated index.mjs + openclaw.plugin.json manifest. Bridge -> <homeBin> hook openclaw <event> --connector <id>; formatReply emits NORMALIZED HookResponse.",
  },
  {
    platform: "amp",
    displayName: "Amp",
    paradigm: "ts-plugin",
    hasHooks: true,
    configPath:
      "<projectDir>/.amp/plugins/<connector-id>.ts (auto-loaded TS plugin module; project scope only)",
    capabilities: {
      canModifyArgs: false,
      canModifyOutput: false,
      canInjectSessionContext: false,
    },
    events: {
      SessionStart: "session.start",
      SessionEnd: null,
      UserPromptSubmit: "agent.start",
      PreToolUse: "tool.call",
      PostToolUse: "tool.result",
      PreCompact: null,
      Stop: "agent.end",
      Notification: null,
      PermissionRequest: null,
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
      PostCompact: null,
    },
    notes:
      "EVENT_TO_AMP (amp.on targets): SessionStart->session.start (session id = event.thread.id), UserPromptSubmit->agent.start (observe-only — agent.start exposes no block/context surface, so a deny/context decision degrades to a no-op; canInjectSessionContext false), PreToolUse->tool.call (deny/ask -> return amp's documented decision union { action:'reject-and-continue', message }, else { action:'allow' }; canModifyArgs false — the 'modify' input shape is undocumented), PostToolUse->tool.result (observe-only: the manual says a replacement output CAN be returned but never documents its object shape, so canModifyOutput stays false rather than ship a guessed mutation; error signal = event.status==='error'), Stop->agent.end (observe-only). Amp documents NO session.end -> SessionEnd null; PreCompact/Notification + all four newer events null too. Loads a TS plugin (.amp/plugins/<id>.ts; default export (amp)=>void registering amp.on handlers), PROJECT scope only — no user-scope plugins dir is documented, so a user install warn-skips. supportsNativeHooks: platforms.amp.nativeHooks amp.on events bridged verbatim (host-generic runNativeHook dispatch). MCP native ~/.config/amp/settings.json under the FLAT dotted key 'amp.mcpServers' (not nested mcpServers); native ${VAR} interpolation. Bridge shells to <homeBin> hook amp <event> --connector <id>; formatReply emits the NORMALIZED HookResponse.",
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
      PostCompact: null,
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
      UserPromptSubmit: "chat.message",
      PreToolUse: "tool.execute.before",
      PostToolUse: "tool.execute.after",
      PreCompact: null,
      Stop: "session.idle",
      Notification: null,
      PermissionRequest: "permission.ask",
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
      PostCompact: null,
    },
    notes:
      "Kilo Code VS Code extension (DISTINCT from kilo-cli, but the 7.x line is rebuilt ON the Kilo CLI server, so it shares the ts-plugin hook layer). EVENT_TO_KILO identical to kilo-cli: PreToolUse->tool.execute.before, PostToolUse->tool.execute.after, SessionStart->experimental.chat.system.transform, UserPromptSubmit->chat.message (push a {type:'text'} part onto output.parts to inject additionalContext; no block/abort so deny degrades to a no-op), PermissionRequest->permission.ask (decision-capable gate that MUTATES output.status 'ask'|'deny'|'allow'), Stop->session.idle ('session finished responding' — NOT a direct hook key; dispatched through the generic `event` hook switching on event.type, a deny throws to halt). SessionEnd/PreCompact/Notification + PostToolUseFailure/SubagentStart/SubagentStop null. installHooks writes the generated plugin module to .kilo/plugin/<id>.js (project) / ~/.config/kilo/plugin/<id>.js (user) AND registers the path in kilo.json's top-level 'plugin' array (mirrors kilo-cli). MCP shares the kilo backend: ~/.config/kilo/kilo.json (root 'mcp', entry type 'local' command ARRAY + environment) — kilo.json and kilo-cli's kilo.jsonc MERGE. Also authors COMMANDS + SUBAGENTS under .kilocode/ and SKILLS under .kilo/skills/. Bridge shells to <homeBin> hook kilo <event> --connector <id>; formatReply emits the NORMALIZED HookResponse. ask degrades to a thrown block on tool.execute.before.",
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
      PostCompact: null,
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
      PostCompact: null,
    },
    notes:
      "mcp-only: no hook system AND no writable MCP config — installServer AND installHooks both 'skip'; all events null. Only surface implemented is Agent Skills (~/.pi/skills/<name>/SKILL.md). transports: [] (no server registration possible). All hook capabilities false.",
  },
  {
    platform: "cline",
    displayName: "Cline",
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
      PostCompact: null,
    },
    notes:
      "Cline VS Code extension (saoudrizwan.claude-dev — the PARENT kilo forked). mcp-only: no hook system; installHooks 'skip'; all events null. MCP only: VS Code globalStorage <userDir>/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json (NO project MCP file), root 'mcpServers'. Content surfaces: memory → .clinerules/agent-connector.md, commands → .clinerules/workflows/, skills → .clinerules/skills/. All hook capabilities false.",
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
      PostCompact: null,
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
      PostCompact: null,
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
      PostCompact: null,
    },
    notes:
      "mcp-only (IDE, no hook pipeline). installHooks 'skip' ('hooks unavailable (Zed is mcp-only)'); all events null. MCP ('context servers') in settings.json under root key 'context_servers' (NOT mcpServers); user dir is OS-native dirs::config_dir() (~/.config/zed or %APPDATA%\\Zed); project <projectDir>/.zed/settings.json. FLAT stdio entry { command, args, env }. All hook capabilities false.",
  },
  {
    platform: "amazon-q",
    displayName: "Amazon Q Developer CLI",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath:
      "~/.aws/amazonq/cli-agents/q_cli_default.json (user) / .amazonq/cli-agents/q_cli_default.json (project) — hooks merged into the built-in default agent file",
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
      PostCompact: null,
    },
    notes:
      "EVENT_MAP camelCase: SessionStart->agentSpawn, UserPromptSubmit->userPromptSubmit, PreToolUse->preToolUse, PostToolUse->postToolUse, Stop->stop. PreCompact/SessionEnd/Notification and all four newer events have no Amazon Q equivalent -> warn-skip (null). Hooks have NO global file; AC merges into the built-in `q_cli_default` agent file (cli-agents/q_cli_default.json) at the install scope — a bare default.json would be an inactive custom agent the user must select (mirrors kiro's default-agent selection); a project install writes a project-scoped q_cli_default that shadows the user-global one. The `hooks` field is a trigger-keyed OBJECT; each entry is FLAT { command, matcher? } (NO `type`; matcher meaningful only for preToolUse/postToolUse). EXIT-CODE protocol (identical to kiro): exit 0 = allow, exit 2 + stderr = deny (ask degrades to deny exit 2). agentSpawn context injection -> exit 0 + stdout { hookSpecificOutput:{ hookEventName:'agentSpawn', additionalContext } }. Cannot rewrite args/output (modify degrades to allow). MCP: ~/.aws/amazonq/mcp.json (user) and .amazonq/mcp.json (project), root 'mcpServers'. BARE stdio entry { command, args?, env?, timeout? } (timeout in ms, NO type/disabled keys); remote/http entry { type: \"http\", url } (no headers — auth is OAuth).",
  },
  {
    platform: "continue",
    displayName: "Continue",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath:
      "~/.continue/settings.json (honors CONTINUE_GLOBAL_DIR; separate from config.yaml; project <projectDir>/.continue/settings.json)",
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
      PostCompact: null,
    },
    notes:
      "json-stdio: the `cn` CLI ships a Claude-Code-COMPATIBLE hooks system (continuedev/continue PR #11029, extensions/cli/src/hooks/{types.ts,hookConfig.ts}). SUPPORTED_EVENTS = PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, SessionStart, SessionEnd, Stop, Notification, SubagentStart, SubagentStop, PermissionRequest, PreCompact (continue's HOOK_EVENT_NAMES ∩ canonical, PascalCase 1:1). Continue has NO PostCompact → that warn-skips. The five host-specific events with no canonical analog (ConfigChange, TeammateIdle, TaskCompleted, WorktreeCreate, WorktreeRemove) ride the nativeHooks passthrough (supportsNativeHooks true). Hooks live in a SEPARATE settings.json (NOT the YAML config.yaml that holds MCP): user-global <CONTINUE_GLOBAL_DIR|~/.continue>/settings.json, project <projectDir>/.continue/settings.json; under 'hooks' keyed by event, each value { matcher?, hooks:[{type:'command',command}] } — BYTE-IDENTICAL to Claude. Output contract is Claude-identical (HookOutput): deny/ask → hookSpecificOutput{ permissionDecision + reason }; PreToolUse modify → updatedInput; context → additionalContext; PermissionRequest → nested decision{ behavior:'allow'|'deny' } (explicit allow = active grant); Stop/SubagentStop/UserPromptSubmit/PostToolUse deny → TOP-LEVEL { decision:'block', reason } (SubagentStop block keeps the subagent running); PostToolUseFailure/SubagentStart are context-only (deny degrades to additionalContext). canModifyArgs true (PreToolUse updatedInput), canModifyOutput false (conservative — PostToolUse exposes updatedMCPToolOutput but it is not wired), canInjectSessionContext true. MCP install (config.yaml mcpServers YAML ARRAY) is UNCHANGED.",
  },
  {
    platform: "windsurf",
    displayName: "Windsurf",
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
      PostCompact: null,
    },
    notes:
      "Windsurf (Codeium / Cognition's Cascade agent). mcp-only: GUI editor with no user-installable hook/plugin layer; installHooks 'skip' ('hooks unavailable (Windsurf is mcp-only)'); all events null. MCP config is USER/GLOBAL scope ONLY — JSON at ~/.codeium/windsurf/mcp_config.json (the docs document no project/workspace path; a project-scope install returns 'skip'). Root key 'mcpServers' is a Claude-Desktop-style OBJECT map keyed by server name (like cursor) — set-if-absent by connector id, siblings preserved, malformed-non-object skip-warn. stdio entry { command, args?, env? }; remote entry { serverUrl, headers? } (the documented `serverUrl`, NOT `url`; NO type/disabled keys). The .windsurfrules / global-rules memory surface is a not-yet-wired host-gap. All hook capabilities false.",
  },
  {
    platform: "grok-build",
    displayName: "Grok Build",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath:
      "$GROK_HOME/hooks/*.json (default ~/.grok/hooks/agent-connector.json; project <repo>/.grok/hooks/*.json needs folder trust)",
    capabilities: {
      canModifyArgs: true,
      canModifyOutput: true,
      canInjectSessionContext: false,
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
      PermissionRequest: null,
      PostToolUseFailure: "PostToolUseFailure",
      SubagentStart: "SubagentStart",
      SubagentStop: "SubagentStop",
      PostCompact: "PostCompact",
    },
    notes:
      "xAI's OFFICIAL agent (xai-org/grok-build, Apache-2.0, bin `grok`) — NOT the community grok-cli below, though both default to ~/.grok (they never share a FILE: Grok Build owns config.toml, Grok CLI owns user-settings.json, and each adapter bows out of a dir holding only the sibling's marker). Hooks live in their OWN directory as Claude-compatible JSON { hooks: { <Event>: [{ matcher?, hooks:[{type:'command',command,timeout?}] }] } }; the same object is also readable from config.toml [[hooks.<Event>]], and Grok additionally scans ~/.claude/settings.json and ~/.cursor/hooks.json for compatibility. 12 of 13 canonical events map 1:1 (PascalCase). PermissionRequest is null: Grok's nearest event, PermissionDenied, fires AFTER the permission system denied a call and is documented non-blocking — an observation, not a decision gate. Grok also fires host-only StopFailure/StopCancelled (no canonical analog → nativeHooks passthrough). Wire shape is camelCase (sessionId/toolName/toolInput/workspaceRoot) with ADDITIVE snake_case aliases; two false friends vs Claude: PostToolUse carries `toolResult` (NOT tool_response/toolOutput) and PreCompact/PostCompact carry `source` (NOT `trigger`). PostToolUse has no is_error — a dispatch failure or MCP error result fires PostToolUseFailure instead. Reply: PreToolUse uses hookSpecificOutput.permissionDecision (allow|deny|ask|defer, canonical over a top-level `decision`) + permissionDecisionReason; `ask` is NATIVE; `updatedInput` rewrites the call with NO paired allow needed (canModifyArgs true). PostToolUse `updatedToolOutput` replaces the model's copy of the result (canModifyOutput true). Stop/SubagentStop/UserPromptSubmit deny via top-level { decision:'block', reason }. canInjectSessionContext FALSE: stdout is ignored on SessionStart/Notification/Pre|PostCompact/SubagentStart and discarded on an allowing UserPromptSubmit — additionalContext is honored only on the tool events and the Stop gates.",
  },
  {
    platform: "grok-cli",
    displayName: "Grok CLI",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath: '~/.grok/user-settings.json (under top-level "hooks"; user scope only)',
    capabilities: {
      canModifyArgs: false,
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
      PermissionRequest: null,
      PostToolUseFailure: "PostToolUseFailure",
      SubagentStart: "SubagentStart",
      SubagentStop: "SubagentStop",
      PostCompact: "PostCompact",
    },
    notes:
      "Community superagent-ai/grok-cli (npm grok-dev, bin grok). USER-SCOPE only: hooks live under top-level 'hooks' in ~/.grok/user-settings.json (project .grok/settings.json hooks are excluded by Grok for security). Claude NESTED-rule shape { matcher?, hooks:[{type:'command',command,timeout?}] }. 12 of 13 canonical events map 1:1 (PascalCase); no PermissionRequest event (cell null, capability unset). Grok ALSO fires host-only events StopFailure/TaskCreated/TaskCompleted/InstructionsLoaded/CwdChanged (no canonical analog → nativeHooks passthrough). Stdin wire false-friends vs Claude: UserPromptSubmit carries `user_prompt` (NOT `prompt`), PostToolUse carries `tool_output` (NOT `tool_response`); PostToolUseFailure carries `error`; SubagentStart/Stop carry `agent_type`. Reply (aggregateHookResults): stdout JSON parsed when it starts with '{' — deny → { decision:'block', reason }, context → { additionalContext } (exit 0); block also fires on exit code 2. No ask/modify reply path (canModifyArgs/Output false; both degrade to exit-0 passthrough).",
  },
  {
    platform: "devin",
    displayName: "Devin CLI (Cognition)",
    paradigm: "json-stdio",
    hasHooks: true,
    configPath:
      "~/.config/devin/config.json (user; %APPDATA%\\devin\\config.json on Windows) / .devin/config.json (project) — hooks under the same file's `hooks` key",
    capabilities: {
      canModifyArgs: false,
      canModifyOutput: false,
      canInjectSessionContext: false,
    },
    events: {
      SessionStart: "SessionStart",
      SessionEnd: "SessionEnd",
      UserPromptSubmit: "UserPromptSubmit",
      PreToolUse: "PreToolUse",
      PostToolUse: "PostToolUse",
      PreCompact: null,
      Stop: "Stop",
      Notification: null,
      PermissionRequest: "PermissionRequest",
      PostToolUseFailure: null,
      SubagentStart: null,
      SubagentStop: null,
      PostCompact: "PostCompaction",
    },
    notes:
      "Devin CLI (Cognition). json-stdio: a Claude-Code-COMPATIBLE hooks system (docs.devin.ai/cli/extensibility/hooks). SUPPORTED_EVENTS = PreToolUse, PostToolUse, PermissionRequest, UserPromptSubmit, Stop, PostCompaction (canonical PostCompact — Devin's on-wire name is PostCompaction, remapped by mapEvent/parseEvent), SessionStart, SessionEnd (lifecycle-hooks doc). No Notification / PreCompact / SubagentStart / SubagentStop / PostToolUseFailure → those warn-skip (null). Hooks live under the `hooks` key in the SAME config.json the MCP servers use (the first-party-documented config-file hook location; the alternative standalone .devin/hooks.v1.json — event map = whole file, NO wrapper — is NOT engine-compatible). NESTED-rule shape { matcher, hooks:[{type:'command',command,timeout?}] }, matcher = regex on tool_name. Reply is the SIMPLE top-level { decision:'approve'|'block'|'deny', reason } (NOT Claude's hookSpecificOutput envelope); exit 0 = allow, exit 2 = block. PermissionRequest: explicit allow → {decision:'approve'} (active grant), deny → {decision:'deny'}; PreToolUse/Stop deny → {decision:'block'}; ask/context/modify degrade to allow (Devin has no rewrite/inject reply channel — canModifyArgs/Output/canInjectSessionContext all false). MCP: root 'mcpServers' OBJECT map; stdio { command, args?, env? } (no type/disabled), remote { url, transport?('http'|'sse'), headers?, oauthClientId?, oauthClientSecret? }; native ${env:VAR} / ${file:} interpolation (token passed through, never baked).",
  },
  {
    platform: "open-interpreter",
    displayName: "Open Interpreter",
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
      PostCompact: null,
    },
    notes:
      "Open Interpreter — the new Rust `interpreter`/`i` CLI, a FORK of OpenAI's Codex (README: \"Open Interpreter is a fork of OpenAI's Codex\"). mcp-only here: installHooks 'skip' ('hooks unavailable (Open Interpreter is mcp-only)'); all events null. The Codex hook subsystem (codex-rs/hooks) is present in the fork, but the `interpreter` product's live hook wire contract is not first-party verified, so AC does NOT claim hooks (MCP-only-unless-byte-confirmed rule). MCP config is Codex's: TOML config.toml at ~/.openinterpreter ($INTERPRETER_HOME — the binary deliberately does NOT honor $CODEX_HOME, codex-rs/utils/home-dir/src/lib.rs; default ~/.openinterpreter), root key 'mcp_servers' as a [mcp_servers.<id>] TABLE (object-map coerce engine, shared @iarna/toml codec) — stdio { command, args, env } / streamable-HTTP { url, bearer_token_env_var?, http_headers? } (transport inferred from url, codex-rs/config/src/mcp_{edit,types}.rs). TOML has no native interpolation, so ${env:VAR} resolves to literals at install time. All hook capabilities false.",
  },
  {
    platform: "junie",
    displayName: "Junie",
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
      PostCompact: null,
    },
    notes:
      "Junie (JetBrains' OWN LLM-agnostic coding agent — the `junie` CLI, npm @jetbrains/junie, github.com/JetBrains/junie). DISTINCT from jetbrains-copilot (GitHub Copilot in JetBrains IDEs). mcp-only: the first-party docs (junie.jetbrains.com/docs) document NO user-installable lifecycle hook/event-callback surface; installHooks 'skip' ('hooks unavailable (Junie is mcp-only)'); all events null. MCP config is BYTE-CONFIRMED from junie.jetbrains.com/docs/junie-cli-mcp-configuration.html ('Junie CLI uses the same MCP JSON configuration as Junie in JetBrains IDEs'): project scope <projectDir>/.junie/mcp/mcp.json, user scope ~/.junie/mcp/mcp.json. Root key 'mcpServers' is an OBJECT map keyed by server name (like cursor) — set-if-absent by connector id, siblings preserved, malformed-non-object skip-warn. stdio entry { command, args?, env? }; remote entry { url, headers? } (the documented `url`, NOT `serverUrl`; NO type/disabled keys). Content surfaces (custom slash commands, Agent Skills, subagents, guidelines/memory) exist natively but are not wired (mcp-only scope; AGENTS.md memory via the base default). All hook capabilities false.",
  },
  {
    platform: "mistral-vibe",
    displayName: "Mistral Vibe",
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
      PostCompact: null,
    },
    notes:
      "Mistral Vibe (Mistral's coding-agent CLI). mcp-only HONEST CEILING: Vibe ships only an experimental hook surface with no byte-confirmed format/event-name contract, so AC wires no hooks; installHooks 'skip' ('hooks unavailable (Mistral Vibe is mcp-only)'); all events null, all hook capabilities false. MCP config is TOML at <projectDir>/.vibe/config.toml (project, precedence) → ~/.vibe/config.toml (user); root key 'mcp_servers' is a TOML ARRAY-OF-TABLES ([[mcp_servers]], each entry carries a `name` short alias = the connector id — distinct from codex's table-keyed [mcp_servers.<name>]) — set-if-absent by name, siblings preserved, malformed-non-array skip-warn. stdio { name, transport:'stdio', command, args?, env? }; remote { name, transport:'http'|'streamable-http', url, headers? }. TOML has no native interpolation token → ${env:VAR} resolved to literals at install time. Byte-confirmed from github.com/mistralai/mistral-vibe README + docs.mistral.ai/vibe.",
  },
];

export const hooksMatrix: HooksMatrix = { canonicalEvents, platforms };

/**
 * Within a single paradigm group, order by fork-lineage family (so forks stay
 * adjacent) then display name — the same family → name ordering the coverage
 * wall uses. Paradigm is already the group key here, so this is just the
 * secondary/tertiary sort.
 */
function byFamilyName(a: PlatformHookEntry, b: PlatformHookEntry): number {
  const fa = familyKey(a.platform);
  const fb = familyKey(b.platform);
  if (fa !== fb) return fa.localeCompare(fb);
  return a.displayName.localeCompare(b.displayName);
}

/** Platforms grouped by paradigm, then ordered family → name (matrix column groups). */
export const platformsByParadigm: Record<HookParadigm, PlatformHookEntry[]> = {
  "json-stdio": platforms.filter((p) => p.paradigm === "json-stdio").sort(byFamilyName),
  "ts-plugin": platforms.filter((p) => p.paradigm === "ts-plugin").sort(byFamilyName),
  "mcp-only": platforms.filter((p) => p.paradigm === "mcp-only").sort(byFamilyName),
};

/** Look up a single platform's hook entry by id. */
export function platformById(id: string): PlatformHookEntry | undefined {
  return platforms.find((p) => p.platform === id);
}
