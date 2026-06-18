/**
 * contracts/root-key-malformed — fleet-wide CORRECTNESS invariant for every JSON
 * object-map MCP server host, derived from the registry (`describe.each`) so a
 * future adapter is covered automatically with no hand-maintained host list.
 *
 * The invariant: when a user has hand-edited their MCP config so the server
 * root key (`mcpServers` / `servers` / `mcp` / `context_servers` / …) is the
 * WRONG type — an array `[]` instead of an object map — installing a server
 * must NOT SILENTLY CORRUPT the file. Before the fix, `cfg[rootKey] ??= {}`
 * left the array in place and `bucket[serverId] = entry` bolted a named
 * property onto an Array, which `JSON.stringify` then DROPPED: silent data
 * loss reported as a successful `create`.
 *
 * Two on-disk outcomes are BOTH correct (neither is the silent-drop bug), so
 * the invariant is mechanism-derived rather than a single literal expectation:
 *   (A) WARN + UNCHANGED — the flat-map hosts that route through the shared
 *       BaseAdapter helpers (and mux's inline copy): surface a `warn`, write
 *       nothing, leave the user's hand-edited array for them to fix; OR
 *   (B) COERCE + WRITE — the nested-container hosts (openclaw / nemoclaw, whose
 *       `mcp` root is a host-owned container, not the user's server map):
 *       replace the malformed container with a valid object and ACTUALLY write
 *       the server entry, so the file is valid JSON and the server is present.
 * What is FORBIDDEN in either case is the bug: a `create`/`update` whose entry
 * never lands on disk (false success). The assertion below derives which safe
 * outcome occurred from the file itself — no per-host allow-list.
 *
 * This is the AUTO-COVERAGE half: each adapter's eligibility is DERIVED from a
 * real clean install (read the written server-config file; if it is not JSON,
 * or no top-level key holds an object map, the host is not a JSON object-map
 * server host — ts-plugin / mcp-only / YAML / TOML hosts auto-skip without a
 * literal allow-list). The companion focused unit test in
 * tests/core/base-adapter-surfaces.test.ts is the PRECISE proof of BOTH the
 * array and string root types AND both shared helpers (upsert + remove) firing
 * warn-skip without throwing.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ADAPTER_REGISTRY } from "../../src/adapters/registry.js";
import { defineConnector } from "../../src/core/define-connector.js";
import type { ChangeRecord } from "../../src/core/types.js";

import { buildCtx, freshProject, isolateEnv } from "../support/env.js";

/** A connector declaring a single stdio MCP server (the surface under test). */
function serverConnector() {
  return defineConnector({
    id: "acme-db",
    displayName: "Acme DB Tools",
    version: "1.2.3",
    server: { transport: "stdio", command: "node", args: ["server.js"] },
  });
}

/**
 * Find the FIRST top-level key in a parsed config whose value is a plain object
 * map (the MCP server bucket). Returns null when no such key exists — i.e. the
 * host did not write a JSON object-map server config, so the invariant does not
 * apply and the adapter auto-skips. Arrays and primitives are NOT object maps.
 */
function deriveObjectMapRootKey(parsed: unknown): string | null {
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value != null && typeof value === "object" && !Array.isArray(value)) return key;
  }
  return null;
}

// Load every registered adapter once (top-level await — ESM test file).
const hosts = await Promise.all(
  ADAPTER_REGISTRY.map(async (f) => ({ id: f.id, adapter: await f.load() })),
);

isolateEnv();

describe("a malformed (array) server root key is never silently corrupted on install", () => {
  it("covers every registered adapter in the registry", () => {
    expect(hosts.length).toBeGreaterThan(0);
  });

  describe.each(hosts)("$id", ({ adapter }) => {
    it("never silently corrupts a hand-edited array root (warn-unchanged OR coerce-write)", () => {
      const connector = serverConnector();

      // (1) CLEAN install — no pre-existing config — to learn this host's real
      // server-config path and root key from its OWN output.
      const ctx = buildCtx(freshProject(), connector, "user");
      adapter.installServer(ctx);

      const serverPath = adapter.getServerConfigPath(ctx);
      if (!existsSync(serverPath)) return; // host wrote no JSON server file → not in scope

      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(serverPath, "utf8"));
      } catch {
        return; // not JSON (YAML / TOML / ts-plugin host) → not in scope
      }

      const rootKey = deriveObjectMapRootKey(parsed);
      if (rootKey == null) return; // no object-map root → not a JSON object-map server host

      // (2) RESET that root key to a malformed ARRAY and re-run install.
      const malformed = { ...(parsed as Record<string, unknown>), [rootKey]: [] };
      writeFileSync(serverPath, `${JSON.stringify(malformed, null, 2)}\n`, "utf8");
      const before = readFileSync(serverPath, "utf8");

      const changes: ChangeRecord[] = adapter.installServer(ctx);
      const forPath = changes.filter((c) => c.path === serverPath);
      expect(forPath.length).toBeGreaterThan(0);

      // The file must remain VALID JSON whatever the host's policy was.
      const afterRaw = readFileSync(serverPath, "utf8");
      const reparsed = JSON.parse(afterRaw) as Record<string, unknown>;

      const warned = forPath.some((c) => c.action === "warn");
      if (warned) {
        // OUTCOME (A): warn-skip → file is byte-for-byte unchanged, array preserved,
        // and NOTHING was reported as a wired create/update.
        for (const c of forPath) {
          expect(["create", "update"]).not.toContain(c.action);
        }
        expect(afterRaw).toBe(before);
        expect(reparsed[rootKey]).toEqual([]);
      } else {
        // OUTCOME (B): coerce-write → the host replaced the malformed container
        // with a valid object AND the server entry actually landed on disk. The
        // forbidden bug (a create/update whose entry never persisted) is exactly
        // what this branch rules out: the file changed and the entry is present
        // SOMEWHERE in the rewritten config.
        expect(afterRaw).not.toBe(before);
        expect(afterRaw).toContain(connector.id);
        // The previously-malformed root is no longer a bare array.
        expect(Array.isArray(reparsed[rootKey])).toBe(false);
      }
    });
  });
});
