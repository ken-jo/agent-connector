/**
 * contracts/hook-root-malformed — fleet-wide CORRECTNESS invariant for every JSON
 * object-map HOOK-config host, derived from the registry (`describe.each`) so a
 * future adapter is covered automatically with no hand-maintained host list. It
 * is the hook-path twin of contracts/root-key-malformed (the server path).
 *
 * The invariant: when a user has hand-edited their hook config so the `hooks`
 * root is the WRONG type — an array `[]` or a primitive string `"x"` instead of
 * an object map — installing a hook must NOT SILENTLY CORRUPT the file and must
 * NOT THROW. Before the fix, `settings.hooks ??= {}` (`??=` only substitutes on
 * null/undefined) left the malformed value in place, so:
 *   • array root  → `bucket.push(...)` bolted a named property onto an Array,
 *     which `JSON.stringify` then DROPPED: silent data loss reported as a false
 *     `create`;
 *   • string root → the property write / `.push` THREW (TypeError) mid-install.
 *
 * Two on-disk outcomes are BOTH correct (neither is the bug), so the invariant
 * is mechanism-derived rather than a single literal expectation — exactly as the
 * server contract does. Which one a host uses MUST match its OWN server-path
 * philosophy:
 *   (A) WARN + UNCHANGED — the JSON object-map hosts that route through
 *       BaseAdapter.malformedHookRootSkip: surface a `warn`, write nothing,
 *       leave the user's hand-edited value for them to fix; OR
 *   (B) COERCE + WRITE — the container hosts whose server path already coerces a
 *       malformed root to a fresh container (codex, goose): replace the malformed
 *       value with a valid object and ACTUALLY write the hook entries, so the
 *       file is valid JSON and the entries are present.
 * What is FORBIDDEN in either case is the bug: a `create`/`update` whose entry
 * never lands on disk (false success), or a throw. The assertion below derives
 * which safe outcome occurred from the file itself — no per-host allow-list.
 *
 * AUTO-COVERAGE: each adapter's eligibility is DERIVED from a real clean install
 * (read the written hook-config file; if it is not JSON, or no top-level `hooks`
 * key holds an object map, the host is not a JSON object-map hook host — ts-plugin
 * / mcp-only / TOML (kimi) / hosts with no hook surface auto-skip without a literal
 * allow-list). The companion focused unit test in
 * tests/core/base-adapter-surfaces.test.ts is the PRECISE proof of the shared
 * BaseAdapter.malformedHookRootSkip helper (array root, primitive root, non-array
 * event bucket, well-formed → null).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ADAPTER_REGISTRY } from "../../src/adapters/registry.js";
import { defineConnector } from "../../src/core/define-connector.js";
import type { ChangeRecord } from "../../src/core/types.js";

import { buildCtx, freshProject, isolateEnv } from "../support/env.js";

/**
 * A connector declaring several common hook events (no-op handlers) so the
 * widest possible set of hosts writes a real `hooks` object map on a clean
 * install. PreToolUse is universal; the rest broaden coverage on hosts that map
 * them. Hosts that map none simply write no file and auto-skip.
 */
function hookConnector() {
  const handler = () => ({ decision: "allow" as const });
  return defineConnector({
    id: "acme-hooks",
    displayName: "Acme Hooks",
    version: "1.2.3",
    hooks: {
      PreToolUse: { handler },
      PostToolUse: { handler },
      UserPromptSubmit: { handler },
      Stop: { handler },
      SessionStart: { handler },
    },
  });
}

/**
 * Find the top-level `hooks` key in a parsed hook config IFF it is a plain object
 * map (the Claude-style `{ Event: Matcher[] }` bucket every targeted host uses).
 * Returns false when `hooks` is absent or not an object map — i.e. the host did
 * not write a JSON object-map hook config, so the invariant does not apply and
 * the adapter auto-skips. Arrays and primitives are NOT object maps.
 */
function hasObjectMapHooksRoot(parsed: unknown): boolean {
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const hooks = (parsed as Record<string, unknown>).hooks;
  return hooks != null && typeof hooks === "object" && !Array.isArray(hooks);
}

// Load every registered adapter once (top-level await — ESM test file).
const hosts = await Promise.all(
  ADAPTER_REGISTRY.map(async (f) => ({ id: f.id, adapter: await f.load() })),
);

isolateEnv();

describe("a malformed `hooks` root is never silently corrupted (and never throws) on install", () => {
  it("covers every registered adapter in the registry", () => {
    expect(hosts.length).toBeGreaterThan(0);
  });

  describe.each(hosts)("$id", ({ adapter }) => {
    // Both malformed root shapes the bug class produces: an array (silent drop)
    // and a primitive string (throw under strict mode). Table-driven so each is
    // its own assertion.
    for (const malformedValue of [[] as unknown, "x" as unknown]) {
      const label = Array.isArray(malformedValue) ? "array root" : "string root";

      it(`never silently corrupts / throws on a hand-edited ${label} (warn-unchanged OR coerce-write)`, () => {
        const connector = hookConnector();

        // (1) CLEAN install — no pre-existing config — to learn this host's real
        // hook-config path and confirm it writes a JSON object-map `hooks` root.
        const ctx = buildCtx(freshProject(), connector, "user");
        adapter.installHooks(ctx);

        const hookPath = adapter.getHookConfigPath(ctx);
        if (!existsSync(hookPath)) return; // host wrote no hook file → not in scope

        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(hookPath, "utf8"));
        } catch {
          return; // not JSON (TOML kimi / ts-plugin / YAML) → not in scope
        }
        if (!hasObjectMapHooksRoot(parsed)) return; // no object-map `hooks` root → not in scope

        // (2) RESET the `hooks` root to the malformed value and re-run install.
        const malformed = { ...(parsed as Record<string, unknown>), hooks: malformedValue };
        writeFileSync(hookPath, `${JSON.stringify(malformed, null, 2)}\n`, "utf8");
        const before = readFileSync(hookPath, "utf8");

        // (a) NO THROW whatever the host's policy.
        let changes!: ChangeRecord[];
        expect(() => {
          changes = adapter.installHooks(ctx);
        }).not.toThrow();

        const forPath = changes.filter((c) => c.path === hookPath);
        expect(forPath.length).toBeGreaterThan(0);

        // (b) The file must remain VALID JSON.
        const afterRaw = readFileSync(hookPath, "utf8");
        const reparsed = JSON.parse(afterRaw) as Record<string, unknown>;

        const warned = forPath.some((c) => c.action === "warn");
        const created = forPath.some((c) => c.action === "create" || c.action === "update");

        if (warned && !created) {
          // OUTCOME (A): warn-skip → file byte-for-byte unchanged, malformed value
          // preserved, and NOTHING reported as a wired create/update.
          expect(afterRaw).toBe(before);
          expect(reparsed.hooks).toEqual(malformedValue);
        } else {
          // OUTCOME (B): coerce-write → the host replaced the malformed root with a
          // valid object AND the hook entries actually landed on disk. The
          // forbidden bug (a create/update whose entry never persisted) is exactly
          // what this branch rules out: the file changed, `hooks` is no longer the
          // malformed value, and our connector id is present somewhere on disk.
          expect(afterRaw).not.toBe(before);
          expect(Array.isArray(reparsed.hooks)).toBe(false);
          expect(typeof reparsed.hooks).toBe("object");
          expect(afterRaw).toContain(connector.id);
        }
      });
    }
  });
});
