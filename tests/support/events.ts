/**
 * tests/support/events — the canonical-event → per-event capability-flag map,
 * shared by the contract suites that derive "which events does host X support"
 * from `adapter.capabilities` rather than a hand-maintained per-host list.
 */
import type { HookEventName, PlatformCapabilities } from "../../src/core/types.js";

/** Canonical hook event → its boolean flag on PlatformCapabilities. */
export const EVENT_FLAG: Record<HookEventName, keyof PlatformCapabilities> = {
  SessionStart: "sessionStart",
  SessionEnd: "sessionEnd",
  UserPromptSubmit: "userPromptSubmit",
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  PreCompact: "preCompact",
  Stop: "stop",
  Notification: "notification",
  PermissionRequest: "permissionRequest",
  PostToolUseFailure: "postToolUseFailure",
  SubagentStart: "subagentStart",
  SubagentStop: "subagentStop",
  PostCompact: "postCompact",
};

/** True when `adapter.capabilities` marks `event` as natively supported. */
export function supportsEvent(
  capabilities: PlatformCapabilities,
  event: HookEventName,
): boolean {
  return capabilities[EVENT_FLAG[event]] === true;
}
