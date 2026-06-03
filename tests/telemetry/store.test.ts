import { afterEach, beforeEach, describe, it, expect } from "vitest";

import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newRecordId, openStore } from "../../src/telemetry/store.js";
import type {
  ConfidenceSource,
  ToolEventRecord,
} from "../../src/telemetry/types.js";

/**
 * store tests.
 *
 * Filesystem is isolated to an os.tmpdir mkdtemp dir, and HOME /
 * AGENT_CONNECTOR_DATA_DIR + AGENT_CONNECTOR_TELEMETRY are saved and restored in
 * afterEach so the real user home and repo tree are never touched. Each store is
 * opened with an explicit { path } so no test depends on the default data-root.
 */

let tmp: string;
let storePath: string;

const SAVED = {
  HOME: process.env.HOME,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  TELEMETRY: process.env.AGENT_CONNECTOR_TELEMETRY,
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ac-store-"));
  storePath = join(tmp, "telemetry.ndjson");
  // Point framework state at the temp dir even though tests pass explicit paths.
  process.env.HOME = tmp;
  process.env.AGENT_CONNECTOR_DATA_DIR = tmp;
  delete process.env.AGENT_CONNECTOR_TELEMETRY;
});

afterEach(() => {
  // Restore env exactly as it was.
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

/** Build a ToolEventRecord with sensible defaults, overridable per field. */
function rec(over: Partial<ToolEventRecord> = {}): ToolEventRecord {
  return {
    id: over.id ?? newRecordId(0),
    ts: over.ts ?? 1_700_000_000_000,
    connectorId: over.connectorId ?? "acme-db",
    toolName: over.toolName ?? "acme_query",
    scope: over.scope ?? "call",
    hostPlatform: over.hostPlatform ?? "claude-code",
    sessionId: over.sessionId ?? "sess-1",
    projectKey: over.projectKey ?? "proj-key-1",
    projectDir: over.projectDir ?? "/home/dev/acme",
    inputTokens: over.inputTokens ?? 10,
    outputTokens: over.outputTokens ?? 20,
    confidenceSource: over.confidenceSource ?? "tokenizer-exact",
    isError: over.isError ?? false,
  };
}

describe("openStore + append + query", () => {
  it("append then query returns the record", () => {
    const store = openStore({ path: storePath });
    const r = rec({ id: "r1" });
    store.append(r);

    const got = store.query({});
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual(r);
    store.close();
  });

  it("creates the NDJSON file on first append", () => {
    expect(existsSync(storePath)).toBe(false);
    const store = openStore({ path: storePath });
    store.append(rec());
    expect(existsSync(storePath)).toBe(true);
    // One JSON object per line.
    const lines = readFileSync(storePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
    store.close();
  });

  it("query of a missing file returns an empty array", () => {
    const store = openStore({ path: join(tmp, "does-not-exist.ndjson") });
    expect(store.query({})).toEqual([]);
    store.close();
  });

  it("appends are cumulative across multiple records", () => {
    const store = openStore({ path: storePath });
    store.append(rec({ id: "a" }));
    store.append(rec({ id: "b" }));
    store.append(rec({ id: "c" }));
    expect(store.query({})).toHaveLength(3);
    store.close();
  });

  it("skips malformed lines without throwing", () => {
    const store = openStore({ path: storePath });
    store.append(rec({ id: "good" }));
    // Append a deliberately broken line directly.
    appendFileSync(storePath, "this is not json\n", "utf8");
    store.append(rec({ id: "good2" }));
    const got = store.query({});
    expect(got).toHaveLength(2);
    expect(got.map((r) => r.id).sort()).toEqual(["good", "good2"]);
    store.close();
  });
});

describe("query filters", () => {
  function seed() {
    const store = openStore({ path: storePath });
    store.append(
      rec({
        id: "1",
        connectorId: "acme-db",
        projectKey: "pA",
        toolName: "acme_query",
        sessionId: "s1",
        ts: 1000,
      }),
    );
    store.append(
      rec({
        id: "2",
        connectorId: "acme-db",
        projectKey: "pB",
        toolName: "acme_write",
        sessionId: "s2",
        ts: 2000,
      }),
    );
    store.append(
      rec({
        id: "3",
        connectorId: "other",
        projectKey: "pA",
        toolName: "acme_query",
        sessionId: "s1",
        ts: 3000,
      }),
    );
    return store;
  }

  it("filters by connectorId", () => {
    const store = seed();
    const got = store.query({ connectorId: "acme-db" });
    expect(got.map((r) => r.id).sort()).toEqual(["1", "2"]);
    store.close();
  });

  it("filters by projectKey", () => {
    const store = seed();
    const got = store.query({ projectKey: "pA" });
    expect(got.map((r) => r.id).sort()).toEqual(["1", "3"]);
    store.close();
  });

  it("filters by toolName", () => {
    const store = seed();
    const got = store.query({ toolName: "acme_query" });
    expect(got.map((r) => r.id).sort()).toEqual(["1", "3"]);
    store.close();
  });

  it("filters by sessionId", () => {
    const store = seed();
    const got = store.query({ sessionId: "s1" });
    expect(got.map((r) => r.id).sort()).toEqual(["1", "3"]);
    store.close();
  });

  it("filters by sinceMs (inclusive lower bound)", () => {
    const store = seed();
    const got = store.query({ sinceMs: 2000 });
    expect(got.map((r) => r.id).sort()).toEqual(["2", "3"]);
    store.close();
  });

  it("combines multiple filters (AND semantics)", () => {
    const store = seed();
    const got = store.query({ connectorId: "acme-db", projectKey: "pA" });
    expect(got.map((r) => r.id)).toEqual(["1"]);
    store.close();
  });

  it("returns nothing when filters match no record", () => {
    const store = seed();
    expect(store.query({ connectorId: "nope" })).toEqual([]);
    store.close();
  });
});

describe("rollup", () => {
  function seedRollup() {
    const store = openStore({ path: storePath });
    // Two calls to acme_query, one to acme_write.
    store.append(
      rec({
        id: "1",
        toolName: "acme_query",
        inputTokens: 10,
        outputTokens: 5,
        confidenceSource: "tokenizer-exact",
        ts: 1000,
      }),
    );
    store.append(
      rec({
        id: "2",
        toolName: "acme_query",
        inputTokens: 20,
        outputTokens: 15,
        confidenceSource: "tokenizer-approx",
        ts: 2000,
      }),
    );
    store.append(
      rec({
        id: "3",
        toolName: "acme_write",
        inputTokens: 7,
        outputTokens: 3,
        confidenceSource: "tokenizer-exact",
        ts: 1500,
      }),
    );
    return store;
  }

  it('rollup("tool", ...) groups and sums calls/input/output/total', () => {
    const store = seedRollup();
    const rows = store.rollup("tool", {});
    const byKey = new Map(rows.map((r) => [r.key, r]));

    const q = byKey.get("acme_query")!;
    expect(q.calls).toBe(2);
    expect(q.inputTokens).toBe(30);
    expect(q.outputTokens).toBe(20);
    expect(q.totalTokens).toBe(50);

    const w = byKey.get("acme_write")!;
    expect(w.calls).toBe(1);
    expect(w.inputTokens).toBe(7);
    expect(w.outputTokens).toBe(3);
    expect(w.totalTokens).toBe(10);

    store.close();
  });

  it("rollup confidence is the worst (least-confident) seen in a group", () => {
    const store = seedRollup();
    const rows = store.rollup("tool", {});
    const q = rows.find((r) => r.key === "acme_query")!;
    // group mixed exact + approx → approx wins (worse).
    expect(q.confidence).toBe<ConfidenceSource>("tokenizer-approx");
    store.close();
  });

  it("rollup lastTs is the max ts in the group", () => {
    const store = seedRollup();
    const rows = store.rollup("tool", {});
    const q = rows.find((r) => r.key === "acme_query")!;
    expect(q.lastTs).toBe(2000);
    store.close();
  });

  it('rollup("session", ...) groups by sessionId', () => {
    const store = openStore({ path: storePath });
    store.append(rec({ id: "1", sessionId: "sX", inputTokens: 1, outputTokens: 1 }));
    store.append(rec({ id: "2", sessionId: "sX", inputTokens: 2, outputTokens: 2 }));
    store.append(rec({ id: "3", sessionId: "sY", inputTokens: 4, outputTokens: 4 }));
    const rows = store.rollup("session", {});
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get("sX")!.calls).toBe(2);
    expect(byKey.get("sX")!.totalTokens).toBe(6);
    expect(byKey.get("sY")!.calls).toBe(1);
    store.close();
  });

  it('rollup("project", ...) groups by projectDir', () => {
    const store = openStore({ path: storePath });
    store.append(rec({ id: "1", projectDir: "/a", inputTokens: 1, outputTokens: 1 }));
    store.append(rec({ id: "2", projectDir: "/b", inputTokens: 2, outputTokens: 2 }));
    store.append(rec({ id: "3", projectDir: "/a", inputTokens: 3, outputTokens: 3 }));
    const rows = store.rollup("project", {});
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get("/a")!.calls).toBe(2);
    expect(byKey.get("/a")!.totalTokens).toBe(8);
    expect(byKey.get("/b")!.calls).toBe(1);
    store.close();
  });

  it("rollup honors the query filter", () => {
    const store = seedRollup();
    const rows = store.rollup("tool", { toolName: "acme_query" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("acme_query");
    expect(rows[0]!.calls).toBe(2);
    store.close();
  });

  it("rollup of an empty store returns no rows", () => {
    const store = openStore({ path: storePath });
    expect(store.rollup("tool", {})).toEqual([]);
    store.close();
  });
});

describe("AGENT_CONNECTOR_TELEMETRY=0 kill switch", () => {
  it("makes append a no-op (no file written, query stays empty)", () => {
    process.env.AGENT_CONNECTOR_TELEMETRY = "0";
    const store = openStore({ path: storePath });
    store.append(rec({ id: "blocked" }));
    expect(existsSync(storePath)).toBe(false);
    expect(store.query({})).toEqual([]);
    store.close();
  });

  it("re-enables append once the switch is unset", () => {
    process.env.AGENT_CONNECTOR_TELEMETRY = "0";
    const store = openStore({ path: storePath });
    store.append(rec({ id: "blocked" }));
    expect(store.query({})).toEqual([]);

    delete process.env.AGENT_CONNECTOR_TELEMETRY;
    store.append(rec({ id: "allowed" }));
    const got = store.query({});
    expect(got.map((r) => r.id)).toEqual(["allowed"]);
    store.close();
  });

  it("does not treat other values (e.g. \"1\") as disabled", () => {
    process.env.AGENT_CONNECTOR_TELEMETRY = "1";
    const store = openStore({ path: storePath });
    store.append(rec({ id: "kept" }));
    expect(store.query({})).toHaveLength(1);
    store.close();
  });
});

describe("newRecordId", () => {
  it("yields distinct ids for increasing seq", () => {
    const a = newRecordId(0);
    const b = newRecordId(1);
    const c = newRecordId(2);
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("encodes the seq as a suffix", () => {
    expect(newRecordId(7).endsWith("-7")).toBe(true);
    expect(newRecordId(42).endsWith("-42")).toBe(true);
  });

  it("is a non-empty string of the form <ts>-<seq>", () => {
    const id = newRecordId(3);
    expect(typeof id).toBe("string");
    expect(/^\d+-3$/.test(id)).toBe(true);
  });
});
