/**
 * contracts/extended-events-degrade — fleet-wide E1 EXTENSION-EVENT degradation
 * invariant for EVERY hook-capable adapter (json-stdio + ts-plugin), derived from
 * the registry (`describe.each`) and each adapter's own capability flags.
 *
 * The four E1 extension events (PermissionRequest, PostToolUseFailure,
 * SubagentStart, SubagentStop) have a native analog on only a minority of hosts.
 * The single-API contract is: a connector that declares an E1 event a given host
 * does NOT support must NEVER be SILENTLY WIRED on that host. The degradation is
 * surfaced — never dropped quietly:
 *   • json-stdio → a per-event warn-skip ChangeRecord, and no hook entry for it.
 *   • ts-plugin  → the plugin-module detail flags it under "unsupported here:" and
 *     omits it from the wired list (it is never written into the bridge as wired).
 * If the host DOES support an E1 event (capability flag set), it MAY wire it —
 * the contract only forbids wiring an UNSUPPORTED one.
 *
 * This replaces the old hand-listed adapters/extended-events-degrade.test.ts
 * (jetbrains-copilot only, after every other host's slice was split out to its
 * per-host file) with a registry-driven describe.each: every current hook-capable
 * host — and any future one — is held to the same E1 invariant automatically,
 * with no new file and no hand-maintained host list. Expected behaviour is derived
 * from `supportsEvent(adapter.capabilities, event)`, never a per-host literal.
 *
 * Assertions run against the install ChangeRecords only (action / detail), so no
 * generated-plugin module is spawned — no node:child_process mock is needed.
 */
import { describe, expect, it } from "vitest";

import { ADAPTER_REGISTRY } from "../../src/adapters/registry.js";
import { defineConnector } from "../../src/core/define-connector.js";
import type { ChangeRecord, ConnectorConfig, HookEventName } from "../../src/core/types.js";

import { buildCtx, freshProject, isolateEnv } from "../support/env.js";
import { supportsEvent } from "../support/events.js";

/** The four E1 extension events, each gated by its own capability flag. */
const E1_EVENTS: HookEventName[] = [
  "PermissionRequest",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
];

/** A connector declaring exactly ONE hook event (the E1 event under test). */
function connectorDeclaringOnly(event: HookEventName) {
  const hooks = {
    [event]: { handler: () => ({ decision: "allow" as const }) },
  } as ConnectorConfig["hooks"];
  return defineConnector({
    id: "acme-db",
    displayName: "Acme DB Tools",
    version: "1.2.3",
    hooks,
  });
}

/**
 * The "wired list" portion of a ts-plugin module detail — everything BEFORE the
 * "; unsupported here:" suffix (or the whole detail when there is no suffix).
 * Used to assert an unsupported event never appears as wired.
 */
function wiredPortion(detail: string): string {
  return detail.split("; unsupported here:")[0] ?? detail;
}

// Load every hook-capable adapter (json-stdio + ts-plugin) from the registry.
// mcp-only hosts have no hook layer (installHooks returns a single skip and
// never wires any event), so they are out of scope for the E1-wiring invariant —
// the baseline contract already pins their hooks:false / no-hooks skip.
const hookHosts = (
  await Promise.all(
    ADAPTER_REGISTRY.map(async (f) => ({ id: f.id, adapter: await f.load() })),
  )
).filter(({ adapter }) => adapter.paradigm === "json-stdio" || adapter.paradigm === "ts-plugin");

isolateEnv();

describe("E1 extension events never wire silently on a host that lacks the analog", () => {
  it("covers every hook-capable adapter in the registry", () => {
    expect(hookHosts.length).toBeGreaterThan(0);
  });

  describe.each(hookHosts)("$id", ({ adapter }) => {
    describe.each(E1_EVENTS)("%s", (event) => {
      it("derives expected behaviour from the capability flag (wire vs degrade)", () => {
        const ctx = buildCtx(freshProject(), connectorDeclaringOnly(event), { dryRun: true });
        const changes: ChangeRecord[] = adapter.installHooks!(ctx);
        const supported = supportsEvent(adapter.capabilities, event);

        if (adapter.paradigm === "ts-plugin") {
          // ts-plugin always emits a plugin-module record; the event must appear in
          // the wired list iff supported, and under "unsupported here:" otherwise.
          const mod = changes.find(
            (c) => c.detail?.includes("plugin module") && !c.path?.endsWith("package.json"),
          );
          expect(mod, "expected a plugin-module change record").toBeTruthy();
          const detail = mod!.detail;
          if (supported) {
            expect(wiredPortion(detail)).toContain(event);
          } else {
            // NEVER listed as wired…
            expect(wiredPortion(detail)).not.toContain(event);
            // …and the degradation is surfaced explicitly.
            expect(detail).toContain("unsupported here:");
            expect(detail).toContain(event);
          }
          return;
        }

        // json-stdio: an unsupported E1 event degrades to a per-event warn-skip and
        // is never written as a wired create/update; a supported one may wire.
        const recordsForEvent = changes.filter((c) => c.detail?.includes(event));
        if (supported) {
          // It MAY wire — if it produced any record at all, it is a real wiring
          // (create/update/skip), not a degradation warn.
          for (const c of recordsForEvent) {
            expect(["create", "update", "skip"]).toContain(c.action);
          }
        } else {
          // Unsupported: surfaced as a warn-skip, never silently wired.
          expect(recordsForEvent.length).toBeGreaterThan(0);
          for (const c of recordsForEvent) {
            expect(["skip", "warn"]).toContain(c.action);
          }
          // And no create/update anywhere references this unsupported event.
          const wired = changes.filter(
            (c) => (c.action === "create" || c.action === "update") && c.detail?.includes(event),
          );
          expect(wired).toHaveLength(0);
        }
      });
    });
  });
});

// ── Fleet-wide NEVER-SILENT invariant for EVERY canonical event ──────────────
// Generalizes the E1 invariant above to ALL 13 canonical events: a host that
// CANNOT fire a declared event must still SURFACE that fact at install — never
// drop it quietly (the silent-drop DX gap). Derived from each adapter's own
// capability flags, so no per-host literal and every future host is covered.
//   • json-stdio → the unsupported event has a visible skip/warn ChangeRecord
//     whose detail names the canonical event, and is never wired as create/update.
//   • ts-plugin  → the plugin-module detail flags it under "unsupported here:".
const CANONICAL_EVENTS: HookEventName[] = [
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

/** A connector declaring EVERY canonical hook event. */
function connectorDeclaringAll() {
  const hooks = Object.fromEntries(
    CANONICAL_EVENTS.map((e) => [e, { handler: () => ({ decision: "allow" as const }) }]),
  ) as ConnectorConfig["hooks"];
  return defineConnector({
    id: "acme-db",
    displayName: "Acme DB Tools",
    version: "1.2.3",
    hooks,
  });
}

describe("no declared hook event is EVER silently dropped (every canonical event, every hook host)", () => {
  describe.each(hookHosts)("$id", ({ adapter }) => {
    it("accounts for ALL declared events — wired, visible skip/warn, or 'unsupported here:' — never silent", () => {
      const ctx = buildCtx(freshProject(), connectorDeclaringAll(), { dryRun: true });
      const changes: ChangeRecord[] = adapter.installHooks!(ctx);

      if (adapter.paradigm === "ts-plugin") {
        const mod = changes.find(
          (c) => c.detail?.includes("plugin module") && !c.path?.endsWith("package.json"),
        );
        // A ts-plugin host with a project-scope-only plugin dir may legitimately
        // skip-warn the whole module (e.g. amp at user scope) — then there is no
        // module record to inspect, and nothing was wired silently either.
        if (!mod) {
          expect(changes.length).toBeGreaterThan(0);
          return;
        }
        for (const event of CANONICAL_EVENTS) {
          // Every declared event appears SOMEWHERE in the module detail — wired
          // in the prefix list, or called out under "unsupported here:".
          expect(mod.detail, `${event} missing from ts-plugin module detail`).toContain(event);
        }
        return;
      }

      // json-stdio: every declared event yields EXACTLY ONE per-event outcome —
      // wired (create/update), idempotent (skip), or declined (skip/warn) — so
      // the count of per-event records equals the number of declared events. A
      // silent drop would make this count fall SHORT (the dropped event leaves no
      // record at all), which this guards against fleet-wide.
      const perEvent = changes.filter(
        (c) => c.path !== undefined && c.action !== "remove",
      );
      expect(
        perEvent.length,
        `${adapter.id}: ${perEvent.length} per-event hook records for ${CANONICAL_EVENTS.length} ` +
          `declared events — a short count means an event was silently dropped`,
      ).toBe(CANONICAL_EVENTS.length);
    });
  });
});
