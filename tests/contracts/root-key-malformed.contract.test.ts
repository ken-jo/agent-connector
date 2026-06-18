/**
 * contracts/root-key-malformed — fleet-wide CORRECTNESS invariant for every
 * object-map MCP server host (JSON, TOML, OR YAML), derived from the registry
 * (`describe.each`) so a future adapter is covered automatically with no
 * hand-maintained host list.
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
 *   (B) COERCE + WRITE — the get-or-create-bucket hosts: the nested-container
 *       JSON hosts (openclaw / nemoclaw, whose `mcp` root is a host-owned
 *       container, not the user's server map) AND the TOML/YAML object-map hosts
 *       (codex's `mcp_servers` table, goose's `extensions`, hermes's
 *       `mcp_servers`): replace the malformed container with a valid object and
 *       ACTUALLY write the server entry, so the file re-parses and the server is
 *       present.
 * What is FORBIDDEN in either case is the bug: a `create`/`update` whose entry
 * never lands on disk (false success). The assertion below derives which safe
 * outcome occurred from the file itself — no per-host allow-list.
 *
 * This is the AUTO-COVERAGE half: each adapter's eligibility is DERIVED from a
 * real clean install (read the written server-config file; detect its format by
 * trying JSON → TOML → YAML; if none parse, or no top-level key holds an object
 * map, the host is not an object-map server host and auto-skips without a literal
 * allow-list — e.g. continue's YAML ARRAY root `mcpServers` has no object-map key
 * so it skips, while ts-plugin / mcp-only hosts write no parseable file). The
 * companion focused unit test in
 * tests/core/base-adapter-surfaces.test.ts is the PRECISE proof of BOTH the
 * array and string root types AND both shared helpers (upsert + remove) firing
 * warn-skip without throwing.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import TOML from "@iarna/toml";
import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

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

/** The on-disk config formats this contract understands. */
type Fmt = "json" | "toml" | "yaml";

/**
 * Parse the host's written config by trying each format in turn. Returns null
 * when none parse (ts-plugin / opaque) → the host auto-skips.
 *
 * ORDER MATTERS: a JSON file is ALSO valid YAML, so JSON MUST be tried first; a
 * TOML file is not valid JSON, so it falls to the TOML branch (TOML.parse THROWS
 * on JSON/YAML `{...}` content, so the JSON-first / TOML-second / YAML-last order
 * is well-defined). We never need to guess the host's "true" format: we
 * re-serialize the malformed fixture in whatever `fmt` we detect and re-parse the
 * after-file in the SAME `fmt`, so internal consistency — not source-of-truth
 * format — is all that matters.
 */
function detectAndParse(raw: string): { fmt: Fmt; parsed: unknown } | null {
  try {
    return { fmt: "json", parsed: JSON.parse(raw) };
  } catch {
    /* not json */
  }
  try {
    return { fmt: "toml", parsed: TOML.parse(raw) };
  } catch {
    /* not toml */
  }
  try {
    return { fmt: "yaml", parsed: parseYaml(raw) };
  } catch {
    /* not yaml */
  }
  return null;
}

/** Serialize `data` in the detected format (JSON matches BaseAdapter.writeJson). */
function serialize(fmt: Fmt, data: unknown): string {
  if (fmt === "json") return `${JSON.stringify(data, null, 2)}\n`;
  if (fmt === "toml") return TOML.stringify(data as never);
  return stringifyYaml(data);
}

/** Re-parse an after-file in the SAME format it was written. */
function parseWith(fmt: Fmt, raw: string): unknown {
  if (fmt === "json") return JSON.parse(raw);
  if (fmt === "toml") return TOML.parse(raw);
  return parseYaml(raw);
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

  // Guard the extension itself: the in-scope set must reach NON-JSON formats, or
  // the format-aware detect/serialize generalization would be dead code that the
  // JSON-only predecessor already covered. Mechanism-derived — the formats are
  // discovered from real clean installs, never a hardcoded host list.
  it("exercises object-map hosts beyond JSON (at least one TOML and one YAML)", () => {
    const formatsInScope = new Set<Fmt>();
    for (const { adapter } of hosts) {
      const connector = serverConnector();
      const ctx = buildCtx(freshProject(), connector, "user");
      adapter.installServer(ctx);
      const serverPath = adapter.getServerConfigPath(ctx);
      if (!existsSync(serverPath)) continue;
      const detected = detectAndParse(readFileSync(serverPath, "utf8"));
      if (detected === null) continue;
      if (deriveObjectMapRootKey(detected.parsed) == null) continue;
      formatsInScope.add(detected.fmt);
    }
    expect(formatsInScope.has("json")).toBe(true);
    expect(formatsInScope.has("toml")).toBe(true); // codex
    expect(formatsInScope.has("yaml")).toBe(true); // goose / hermes
  });

  describe.each(hosts)("$id", ({ adapter }) => {
    it("never silently corrupts a hand-edited array root (warn-unchanged OR coerce-write)", () => {
      const connector = serverConnector();

      // (1) CLEAN install — no pre-existing config — to learn this host's real
      // server-config path and root key from its OWN output.
      const ctx = buildCtx(freshProject(), connector, "user");
      adapter.installServer(ctx);

      const serverPath = adapter.getServerConfigPath(ctx);
      if (!existsSync(serverPath)) return; // host wrote no server file → not in scope

      // Detect the on-disk format (JSON / TOML / YAML). null → ts-plugin / opaque
      // host that wrote nothing parseable → not in scope.
      const detected = detectAndParse(readFileSync(serverPath, "utf8"));
      if (detected === null) return;
      const { fmt, parsed } = detected;

      const rootKey = deriveObjectMapRootKey(parsed);
      if (rootKey == null) return; // no object-map root → not an object-map server host

      // (2) RESET that root key to a malformed ARRAY and re-run install — written
      // back in the SAME format the host uses.
      const malformed = { ...(parsed as Record<string, unknown>), [rootKey]: [] };
      writeFileSync(serverPath, serialize(fmt, malformed), "utf8");
      const before = readFileSync(serverPath, "utf8");

      const changes: ChangeRecord[] = adapter.installServer(ctx);
      const forPath = changes.filter((c) => c.path === serverPath);
      expect(forPath.length).toBeGreaterThan(0);

      // The file must remain VALID (re-parse in the SAME format) whatever the
      // host's policy was.
      const afterRaw = readFileSync(serverPath, "utf8");
      const reparsed = parseWith(fmt, afterRaw) as Record<string, unknown>;

      const warned = forPath.some((c) => c.action === "warn");
      if (warned) {
        // OUTCOME (A): warn-skip → file is byte-for-byte unchanged (in its own
        // format), array preserved, and NOTHING was reported as a wired
        // create/update.
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
        // SOMEWHERE in the rewritten config. (TOML renders the coerced root as a
        // `[mcp_servers.<id>]` table → the id appears in the text and the
        // re-parsed root is an object, not an array.)
        expect(afterRaw).not.toBe(before);
        expect(afterRaw).toContain(connector.id);
        // The previously-malformed root is no longer a bare array.
        expect(Array.isArray(reparsed[rootKey])).toBe(false);
      }
    });
  });
});
