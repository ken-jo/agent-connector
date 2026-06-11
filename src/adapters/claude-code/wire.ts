/**
 * adapters/claude-code/wire — Claude Code hook wire protocol.
 *
 * Claude Code pipes a JSON object to a hook command on stdin and reads a JSON
 * object (or empty) from stdout, interpreting the exit code as well. This module
 * captures the exact stdin shape and the canonical reply shape so the adapter's
 * parse/format methods are a single source of truth.
 *
 * Stdin (documented Claude Code hook input):
 *   {
 *     session_id, transcript_path, cwd, hook_event_name,
 *     tool_name, tool_input, tool_response,            // tool events
 *     permission_suggestions,                          // PermissionRequest
 *     tool_use_id, error, is_interrupt, duration_ms,   // PostToolUseFailure
 *     agent_id, agent_type,                            // SubagentStart/Stop
 *     agent_transcript_path, last_assistant_message,   // SubagentStop
 *     source,                                          // SessionStart
 *     reason,                                          // SessionEnd
 *     prompt,                                          // UserPromptSubmit
 *     trigger,                                         // PreCompact
 *     stop_hook_active,                                // Stop / SubagentStop
 *     message                                          // Notification
 *   }
 *
 * Stdout (canonical reply): a `hookSpecificOutput` object keyed by
 * `hookEventName`, carrying `permissionDecision` (allow|deny|ask) +
 * `permissionDecisionReason`, `additionalContext`, and (PreToolUse)
 * `updatedInput`; PermissionRequest instead takes a nested
 * `decision: { behavior: "allow"|"deny", ... }`; Stop-class blocks
 * (Stop / SubagentStop / UserPromptSubmit / PostToolUse) take the TOP-LEVEL
 * `{"decision":"block","reason"}`. Exit 0 = proceed; the JSON refines the
 * decision.
 */

/** Canonical Claude Code hook event names (the values of `hook_event_name`). */
export const CLAUDE_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "Notification",
  "PermissionRequest",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
] as const;

export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];

/**
 * Raw Claude Code hook stdin payload. Every field is optional — a given event
 * only populates the subset relevant to it. `connector` is NOT a Claude field;
 * it is threaded in by the universal entrypoint so parseEvent can recover the
 * connector id (the home binary passes `--connector <id>` and may inject it).
 */
export interface ClaudeWireInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;

  // tool events
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** PostToolUse result payload (string or structured). */
  tool_response?: unknown;

  // PermissionRequest — permission-update entries the dialog would offer.
  // NOTE: the docs explicitly state PermissionRequest has NO tool_use_id.
  permission_suggestions?: unknown[];

  // PostToolUseFailure
  tool_use_id?: string;
  error?: string;
  is_interrupt?: boolean;
  duration_ms?: number;

  // SubagentStart / SubagentStop — agent_type is unreliable on SubagentStop
  // (the SDK may not populate it); treat both as optional everywhere.
  agent_id?: string;
  agent_type?: string;
  // SubagentStop — the subagent's OWN transcript (transcript_path stays the
  // parent session's) + the text of its final response.
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
  // Stop / SubagentStop
  stop_hook_active?: boolean;
  // Notification
  message?: string;

  /** Injected by the entrypoint so the runtime knows which connector to dispatch. */
  connector?: string;
}

/**
 * Extract a stable session id from a Claude wire payload.
 * Priority mirrors the proven adapter: transcript UUID > session_id > "".
 * (The framework's normalized event uses "" when no id is available, per
 * core/types BaseEvent.sessionId docstring — no ppid fabrication here.)
 */
export function extractSessionId(input: ClaudeWireInput): string {
  if (typeof input.transcript_path === "string") {
    const m = input.transcript_path.match(/([a-f0-9-]{36})\.jsonl$/);
    if (m && m[1]) return m[1];
  }
  if (typeof input.session_id === "string" && input.session_id !== "") {
    return input.session_id;
  }
  return "";
}

/** Coerce a Claude PostToolUse `tool_response` into a string for the normalized event. */
export function toolResponseToString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
