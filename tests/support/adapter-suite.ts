/**
 * tests/support/adapter-suite — the shared "same rules for every host" contract.
 *
 * Modelled on the Vercel AI SDK's `createFeatureTestSuite` (one tiny per-provider
 * file calls a shared factory that encodes the common rules): a per-host test
 * file calls `createAdapterSuite({ adapter })` once, then appends its
 * host-specific `it()`s. What lives HERE is only the SPI-level contract that
 * holds for EVERY adapter regardless of its output shape — so adding a new host
 * automatically inherits this baseline with no new file. Surface round-trips
 * (whose written bytes differ per host) stay in the host file; fleet-wide matrix
 * invariants live in tests/contracts/.
 */
import { describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { Adapter } from "../../src/adapters/spi.js";
import type { HookParadigm } from "../../src/core/types.js";

import { buildCtx, freshProject, isolateEnv } from "./env.js";

const PARADIGMS: readonly HookParadigm[] = ["json-stdio", "ts-plugin", "mcp-only"];

export interface AdapterSuiteOptions {
  adapter: Adapter;
  /** Optional explicit paradigm assertion (defends against a silent flip). */
  paradigm?: HookParadigm;
}

/**
 * Assert the baseline contract every adapter must satisfy, by identical rules.
 * Call once per host file; append host-specific behaviour separately.
 */
export function createAdapterSuite(opts: AdapterSuiteOptions): void {
  const { adapter } = opts;

  describe(`${adapter.id} — baseline adapter contract`, () => {
    isolateEnv();

    it("exposes a stable id + a known paradigm", () => {
      expect(adapter.id).toBeTruthy();
      expect(PARADIGMS).toContain(adapter.paradigm);
      if (opts.paradigm) expect(adapter.paradigm).toBe(opts.paradigm);
    });

    it("detectInstalled reports this adapter's own id, paradigm, and capabilities", () => {
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
      // hooks:false (or an unsupported event) must degrade to skip/warn — never a
      // create/update. This is the one hook invariant that holds across every
      // paradigm (mcp-only skips outright; json-stdio / ts-plugin suppress the
      // canonical handlers).
      for (const c of changes) {
        expect(["skip", "warn"]).toContain(c.action);
      }
    });
  });
}
