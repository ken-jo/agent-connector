/**
 * tests/docs/hook-event-drift — the hook-EVENT docs-vs-registry drift guard.
 *
 * platform-drift.test.ts guards paradigm id-sets and platform counts; until the
 * E1 event extension there was NO guard on the canonical event list, so the
 * site hooks matrix and the llms files could rot exactly the way the paradigm
 * counts once did. This test makes the core + adapter registry the source of
 * truth for events:
 *
 *  1. canonical ORDER — site hooks-matrix `canonicalEvents` must round-trip
 *     through defineConnector unchanged (proves every matrix event is a real
 *     HookEventName AND the matrix row order is core's ALL_EVENTS order).
 *  2. per-platform CELLS — a matrix cell is non-null exactly when that
 *     adapter's per-event capability flag is true (read `?? false`).
 *  3. matrix PLATFORM SET — exactly the registry ids, with matching paradigm
 *     and hasHooks.
 *  4. hook CAPABILITIES — canModifyArgs/canModifyOutput/canInjectSessionContext
 *     in the matrix mirror the adapter literals verbatim.
 *  5. PROSE pins — "12 canonical events" phrasing in HooksGuide/docs-data and
 *     the llms.txt / llms-full.txt event lists carry every canonical event, so
 *     the count can never silently diverge from the matrix.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ADAPTER_REGISTRY } from "../../src/adapters/registry.js";
import { defineConnector } from "../../src/core/define-connector.js";
import type {
  ConnectorConfig,
  HookEventName,
  PlatformCapabilities,
} from "../../src/core/types.js";
import {
  canonicalEvents,
  platforms as matrixPlatforms,
} from "../../site/src/components/docs/hooks-matrix.js";

/** Canonical event → its per-event capability flag on PlatformCapabilities. */
const EVENT_FLAG: Record<HookEventName, keyof PlatformCapabilities> = {
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
};

describe("hook-event drift guard (core + adapter registry are the source of truth)", () => {
  it("matrix canonicalEvents round-trips through defineConnector in canonical order", () => {
    // Declare a handler for every matrix event in REVERSE order; resolved
    // hookEvents must come back in canonical (ALL_EVENTS) order — which the
    // matrix pins as its row order. A matrix event unknown to core would be
    // filtered out (length mismatch); a core reordering breaks the equality.
    const hooks = Object.fromEntries(
      [...canonicalEvents].reverse().map((event) => [event, { handler: () => {} }]),
    ) as ConnectorConfig["hooks"];
    const resolved = defineConnector({ id: "event-drift-guard", hooks });
    expect(resolved.hookEvents).toEqual(canonicalEvents);
  });

  it("EVENT_FLAG covers every canonical event exactly once", () => {
    expect(Object.keys(EVENT_FLAG).sort()).toEqual([...canonicalEvents].sort());
  });

  it("matrix platform set carries EXACTLY the registry ids with matching paradigm + hasHooks", async () => {
    const matrixIds = matrixPlatforms.map((p) => p.platform).sort();
    expect(matrixIds).toEqual(ADAPTER_REGISTRY.map((f) => f.id).sort());

    for (const factory of ADAPTER_REGISTRY) {
      const adapter = await factory.load();
      const entry = matrixPlatforms.find((p) => p.platform === factory.id)!;
      expect(entry.paradigm, `${factory.id}: matrix paradigm`).toBe(adapter.paradigm);
      expect(entry.hasHooks, `${factory.id}: matrix hasHooks`).toBe(
        adapter.paradigm !== "mcp-only",
      );
    }
  });

  it("every matrix cell is non-null exactly when the adapter's per-event capability flag is true", async () => {
    for (const factory of ADAPTER_REGISTRY) {
      const adapter = await factory.load();
      const entry = matrixPlatforms.find((p) => p.platform === factory.id)!;
      // The matrix events Record must carry exactly the canonical keys.
      expect(Object.keys(entry.events).sort(), `${factory.id}: matrix event keys`).toEqual(
        [...canonicalEvents].sort(),
      );
      for (const event of canonicalEvents) {
        const supported = (adapter.capabilities[EVENT_FLAG[event]] ?? false) as boolean;
        expect(
          entry.events[event] !== null,
          `${factory.id}.${event}: matrix cell ${JSON.stringify(
            entry.events[event],
          )} vs capability flag ${supported}`,
        ).toBe(supported);
      }
    }
  });

  it("matrix hook capabilities mirror the adapter literals verbatim", async () => {
    for (const factory of ADAPTER_REGISTRY) {
      const adapter = await factory.load();
      const entry = matrixPlatforms.find((p) => p.platform === factory.id)!;
      expect(entry.capabilities.canModifyArgs, `${factory.id}: canModifyArgs`).toBe(
        adapter.capabilities.canModifyArgs,
      );
      expect(entry.capabilities.canModifyOutput, `${factory.id}: canModifyOutput`).toBe(
        adapter.capabilities.canModifyOutput,
      );
      expect(
        entry.capabilities.canInjectSessionContext,
        `${factory.id}: canInjectSessionContext`,
      ).toBe(adapter.capabilities.canInjectSessionContext);
    }
  });

  it("site prose pins the live canonical-event count", () => {
    const guide = readFileSync("site/src/components/docs/HooksGuide.tsx", "utf8");
    expect(guide).toContain(`the ${canonicalEvents.length} canonical events`);
    expect(guide).not.toMatch(/\b8 canonical events\b/);

    const docsData = readFileSync("site/src/components/docs/docs-data.ts", "utf8");
    expect(docsData).toContain(`${canonicalEvents.length} canonical events`);
  });

  it("llms.txt hooks bullet names every canonical event", () => {
    const text = readFileSync("llms.txt", "utf8");
    const line = text.split("\n").find((l) => l.startsWith("- `hooks` —"));
    expect(line, "llms.txt is missing the `hooks` surface bullet").toBeTruthy();
    expect(line).toContain(`${canonicalEvents.length} canonical events`);
    for (const event of canonicalEvents) {
      expect(line, `llms.txt hooks bullet is missing "${event}"`).toContain(event);
    }
  });

  it("llms-full.txt §2.3 HooksConfig block + payload table carry every canonical event", () => {
    const text = readFileSync("llms-full.txt", "utf8");
    for (const event of canonicalEvents) {
      expect(
        new RegExp(`^  ${event}\\?:\\s+HookDefinition<"${event}">;`, "m").test(text),
        `llms-full.txt HooksConfig block is missing the ${event} key`,
      ).toBe(true);
      expect(
        new RegExp(`^\\| \`${event}\` \\|`, "m").test(text),
        `llms-full.txt payload table is missing the ${event} row`,
      ).toBe(true);
    }
  });
});
