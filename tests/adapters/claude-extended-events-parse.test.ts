/**
 * tests/adapters/claude-extended-events-parse — parseEvent coverage for the 4
 * E1 extension events (PermissionRequest, PostToolUseFailure, SubagentStart,
 * SubagentStop) on the claude-code adapter.
 *
 * Pins the snake_case → camelCase wire mapping, the optional-field handling
 * (notably the real-world quirk that SubagentStop may arrive WITHOUT
 * agent_type), and the shared base extraction (session id from the transcript
 * path, projectDir from cwd).
 */

import { describe, expect, it } from "vitest";

import { ADAPTER_REGISTRY } from "../../src/adapters/registry.js";
import type {
  PermissionRequestEvent,
  PostToolUseFailureEvent,
  SubagentStartEvent,
  SubagentStopEvent,
} from "../../src/core/types.js";

async function loadClaude() {
  const entry = ADAPTER_REGISTRY.find((a) => a.id === "claude-code");
  if (!entry) throw new Error("claude-code adapter missing from registry");
  return entry.load();
}

const COMMON = {
  session_id: "sess-ext",
  transcript_path: "/home/dev/.claude/projects/x/0a1b2c3d-0a1b-4c3d-8e5f-0a1b2c3d4e5f.jsonl",
  cwd: "/home/dev/acme",
};

describe("claude-code parseEvent — PermissionRequest", () => {
  it("maps tool_name/tool_input/permission_suggestions", async () => {
    const adapter = await loadClaude();
    const evt = adapter.parseEvent("PermissionRequest", {
      ...COMMON,
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /tmp/x" },
      permission_suggestions: [
        { type: "addRules", behavior: "allow", destination: "session" },
      ],
    }) as PermissionRequestEvent;

    expect(evt.hostPlatform).toBe("claude-code");
    expect(evt.toolName).toBe("Bash");
    expect(evt.toolInput).toEqual({ command: "rm -rf /tmp/x" });
    expect(evt.permissionSuggestions).toEqual([
      { type: "addRules", behavior: "allow", destination: "session" },
    ]);
    expect(evt.sessionId).toBe("0a1b2c3d-0a1b-4c3d-8e5f-0a1b2c3d4e5f");
    expect(evt.projectDir).toBe("/home/dev/acme");
  });

  it("omits permissionSuggestions when the host sends none", async () => {
    const adapter = await loadClaude();
    const evt = adapter.parseEvent("PermissionRequest", {
      ...COMMON,
      hook_event_name: "PermissionRequest",
      tool_name: "Read",
      tool_input: {},
    }) as PermissionRequestEvent;
    expect(evt.permissionSuggestions).toBeUndefined();
  });
});

describe("claude-code parseEvent — PostToolUseFailure", () => {
  it("maps error/tool_use_id/is_interrupt/duration_ms", async () => {
    const adapter = await loadClaude();
    const evt = adapter.parseEvent("PostToolUseFailure", {
      ...COMMON,
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "make test" },
      tool_use_id: "toolu_01",
      error: "exit status 2",
      is_interrupt: false,
      duration_ms: 1234,
    }) as PostToolUseFailureEvent;

    expect(evt.toolName).toBe("Bash");
    expect(evt.toolInput).toEqual({ command: "make test" });
    expect(evt.toolUseId).toBe("toolu_01");
    expect(evt.error).toBe("exit status 2");
    expect(evt.isInterrupt).toBe(false);
    expect(evt.durationMs).toBe(1234);
  });

  it("tolerates a minimal payload (error defaults to empty string)", async () => {
    const adapter = await loadClaude();
    const evt = adapter.parseEvent("PostToolUseFailure", {
      hook_event_name: "PostToolUseFailure",
      tool_name: "Write",
    }) as PostToolUseFailureEvent;
    expect(evt.error).toBe("");
    expect(evt.toolUseId).toBeUndefined();
    expect(evt.isInterrupt).toBeUndefined();
    expect(evt.durationMs).toBeUndefined();
  });
});

describe("claude-code parseEvent — SubagentStart", () => {
  it("maps agent_id/agent_type", async () => {
    const adapter = await loadClaude();
    const evt = adapter.parseEvent("SubagentStart", {
      ...COMMON,
      hook_event_name: "SubagentStart",
      agent_id: "agent-7",
      agent_type: "code-reviewer",
    }) as SubagentStartEvent;
    expect(evt.agentId).toBe("agent-7");
    expect(evt.agentType).toBe("code-reviewer");
  });
});

describe("claude-code parseEvent — SubagentStop", () => {
  it("maps the full payload incl. transcript path + last assistant message", async () => {
    const adapter = await loadClaude();
    const evt = adapter.parseEvent("SubagentStop", {
      ...COMMON,
      hook_event_name: "SubagentStop",
      agent_id: "agent-7",
      agent_type: "code-reviewer",
      agent_transcript_path: "/home/dev/.claude/projects/x/subagents/agent-7.jsonl",
      last_assistant_message: "review complete",
      stop_hook_active: true,
    }) as SubagentStopEvent;

    expect(evt.agentId).toBe("agent-7");
    expect(evt.agentType).toBe("code-reviewer");
    expect(evt.agentTranscriptPath).toBe(
      "/home/dev/.claude/projects/x/subagents/agent-7.jsonl",
    );
    expect(evt.lastAssistantMessage).toBe("review complete");
    expect(evt.stopHookActive).toBe(true);
  });

  it("tolerates the missing-agent_type quirk (SDK does not reliably send it)", async () => {
    const adapter = await loadClaude();
    const evt = adapter.parseEvent("SubagentStop", {
      ...COMMON,
      hook_event_name: "SubagentStop",
      last_assistant_message: "done",
    }) as SubagentStopEvent;
    expect(evt.agentId).toBeUndefined();
    expect(evt.agentType).toBeUndefined();
    expect(evt.lastAssistantMessage).toBe("done");
  });
});
