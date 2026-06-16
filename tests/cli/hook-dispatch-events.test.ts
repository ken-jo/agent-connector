/**
 * tests/cli/hook-dispatch-events — drift guard for the hook-event SETS that are
 * hand-maintained as `new Set<HookEventName>([...])` literals (which TypeScript
 * does NOT exhaustiveness-check). A member missing from one of these silently
 * breaks an installed hook at runtime (the CLI dispatch gate rejects it) or drops
 * it from a Claude-shaped bundle — exactly the regression that shipped PostCompact
 * to install but not to dispatch. These tests pin each set ⊇ ALL_EVENTS.
 */
import { describe, expect, it } from "vitest";

import { ALL_EVENTS } from "../../src/core/define-connector.js";
import { HOOK_EVENTS } from "../../src/cli/commands/hook.js";
import { CLAUDE_MAPPED_EVENTS } from "../../src/core/package-formats/shared.js";

describe("hook-event set drift guard", () => {
  it("the CLI hook-dispatch gate (HOOK_EVENTS) accepts every normalized event", () => {
    const missing = ALL_EVENTS.filter((e) => !HOOK_EVENTS.has(e));
    expect(missing).toEqual([]);
  });

  it("the Claude-bundle mapped-event set (CLAUDE_MAPPED_EVENTS) covers every normalized event", () => {
    const missing = ALL_EVENTS.filter((e) => !CLAUDE_MAPPED_EVENTS.has(e));
    expect(missing).toEqual([]);
  });
});
