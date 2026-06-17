/**
 * contracts/adapter-baseline — fleet-wide enforcement that EVERY registered
 * adapter satisfies the same baseline SPI contract, derived from the registry
 * (`describe.each(ADAPTER_REGISTRY)`) so a newly-added adapter is automatically
 * held to — and a removed one automatically dropped from — the exact same bar,
 * with no new file and no hand-maintained host list.
 *
 * This is the registry-driven SAFETY NET behind the per-host `createAdapterSuite()`
 * calls: those give each migrated host file a co-located baseline, but a host
 * whose own file forgets to call the factory (or that has no per-host file yet)
 * is still covered here. The assertions are intentionally identical to
 * tests/support/adapter-suite.ts so the two never drift — the factory is the
 * co-located copy, this is the can't-forget-it enforcement.
 *
 * Why it matters (the project's stated goal): adding or removing an adapter must
 * apply/withdraw the SAME level of tests so regressions surface in advance, and
 * contributors get coverage by registering an adapter — not by hand-writing
 * boilerplate that may diverge.
 */
import { describe, expect, it } from "vitest";

import { ADAPTER_REGISTRY } from "../../src/adapters/registry.js";
import { defineConnector } from "../../src/core/define-connector.js";
import type { HookParadigm } from "../../src/core/types.js";

import { buildCtx, freshProject, isolateEnv } from "../support/env.js";

const PARADIGMS: readonly HookParadigm[] = ["json-stdio", "ts-plugin", "mcp-only"];

// Load every registered adapter once (top-level await — ESM test file).
const hosts = await Promise.all(
  ADAPTER_REGISTRY.map(async (f) => ({ id: f.id, adapter: await f.load() })),
);

isolateEnv();

describe("every registered adapter satisfies the baseline SPI contract", () => {
  it("the registry is non-empty (and every entry's id matches its loaded adapter)", () => {
    expect(hosts.length).toBeGreaterThan(0);
    for (const { id, adapter } of hosts) {
      expect(adapter.id).toBe(id);
    }
  });

  describe.each(hosts)("$id", ({ adapter }) => {
    it("exposes a stable id + a known paradigm", () => {
      expect(adapter.id).toBeTruthy();
      expect(PARADIGMS).toContain(adapter.paradigm);
    });

    it("detectInstalled reports this adapter's own id, paradigm, and capability identity", () => {
      const detected = adapter.detectInstalled(freshProject());
      expect(detected.id).toBe(adapter.id);
      expect(detected.paradigm).toBe(adapter.paradigm);
      // Identity, not a copy — the live capability object the adapter exposes.
      expect(detected.capabilities).toBe(adapter.capabilities);
    });

    it("never writes a hook when platforms[host].hooks === false", () => {
      if (!adapter.installHooks) return; // adapter opts out of the hook SPI entirely
      const connector = defineConnector({
        id: "baseline-hooks-off",
        hooks: { PreToolUse: { handler: () => ({ decision: "allow" }) } },
        platforms: { [adapter.id]: { hooks: false } },
      });
      const changes = adapter.installHooks(buildCtx(freshProject(), connector));
      // hooks:false must degrade to skip/warn — never a create/update. This is the
      // one hook invariant that holds across every paradigm (mcp-only skips
      // outright; json-stdio / ts-plugin suppress the canonical handlers).
      for (const c of changes) {
        expect(["skip", "warn"]).toContain(c.action);
      }
    });
  });
});
