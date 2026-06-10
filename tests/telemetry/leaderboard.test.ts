/**
 * tests/telemetry/leaderboard — the PLUGIN / MCP leaderboard + scope dimension.
 *
 * Seeds a temp telemetry.ndjson via the real {@link openStore} with rows for
 *   2 connectors × 2 tools × 2 hosts, carrying installScope (user|project) and
 *   launchMethod (npx|binary),
 * then asserts:
 *   • mcpLeaderboard ranks connectors by total tokens desc (the signature
 *     "which MCP server costs the most" metric), counts distinct tools, and
 *     aggregates across hosts;
 *   • toolLeaderboard groups by (connector, tool, scope) and keeps the tool_defs
 *     overhead row visible rather than folded into a call;
 *   • scopeBreakdown splits usage by (installScope, launchMethod) — user/project
 *     and npx/binary — and reads a missing field as "unknown";
 *   • the host-native confidence ordering is preserved (worst-of, so host-native
 *     never downgrades an estimate but an estimate downgrades host-native).
 *
 * Filesystem is isolated to an os.tmpdir mkdtemp dir; HOME / data-root env vars
 * are saved + restored so the real user home is never touched. Every store is
 * opened with an explicit { path }.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newRecordId, openStore } from "../../src/telemetry/store.js";
import {
  formatMcpLeaderboard,
  formatScopeBreakdown,
  formatToolLeaderboard,
  isScopeFilter,
  mcpLeaderboard,
  scopeBreakdown,
  SCOPE_FILTER_VALUES,
  toolLeaderboard,
} from "../../src/telemetry/leaderboard.js";
import type { TelemetryStore, ToolEventRecord } from "../../src/telemetry/types.js";

let tmp: string;
let storePath: string;

const SAVED = {
  HOME: process.env.HOME,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  TELEMETRY: process.env.AGENT_CONNECTOR_TELEMETRY,
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ac-lb-"));
  storePath = join(tmp, "telemetry.ndjson");
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.AGENT_CONNECTOR_DATA_DIR = tmp;
  delete process.env.AGENT_CONNECTOR_TELEMETRY;
});

afterEach(() => {
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
    ...(over.installScope !== undefined ? { installScope: over.installScope } : {}),
    ...(over.launchMethod !== undefined ? { launchMethod: over.launchMethod } : {}),
  };
}

/**
 * Seed 2 connectors × 2 tools × 2 hosts with scope dimensions.
 *
 *   acme-db   (npx, user)    : acme_query on claude-code + codex, acme_write
 *   billing   (binary, project): bill_charge on claude-code + cursor
 *
 * Token budgets are arranged so acme-db (the npx/user connector) outranks
 * billing by total tokens, giving a deterministic ranking to assert.
 */
function seed(): TelemetryStore {
  const store = openStore({ path: storePath });

  // ── acme-db: launched via npx, user-global install ──────────────────────
  // tool acme_query — two hosts, two calls (big tokens).
  store.append(
    rec({
      id: "a1",
      connectorId: "acme-db",
      toolName: "acme_query",
      hostPlatform: "claude-code",
      inputTokens: 100,
      outputTokens: 200,
      installScope: "user",
      launchMethod: "npx",
      ts: 1000,
    }),
  );
  store.append(
    rec({
      id: "a2",
      connectorId: "acme-db",
      toolName: "acme_query",
      hostPlatform: "codex",
      inputTokens: 150,
      outputTokens: 250,
      installScope: "user",
      launchMethod: "npx",
      ts: 2000,
    }),
  );
  // tool acme_write — one host, one call (smaller).
  store.append(
    rec({
      id: "a3",
      connectorId: "acme-db",
      toolName: "acme_write",
      hostPlatform: "claude-code",
      inputTokens: 40,
      outputTokens: 60,
      installScope: "user",
      launchMethod: "npx",
      ts: 1500,
    }),
  );
  // The one-time tool-defs schema overhead (scope tool_defs, tool "*").
  store.append(
    rec({
      id: "a4",
      connectorId: "acme-db",
      toolName: "*",
      scope: "tool_defs",
      hostPlatform: "claude-code",
      inputTokens: 80,
      outputTokens: 0,
      installScope: "user",
      launchMethod: "npx",
      ts: 900,
    }),
  );

  // ── billing: launched as a resolved binary, project-local install ───────
  store.append(
    rec({
      id: "b1",
      connectorId: "billing",
      toolName: "bill_charge",
      hostPlatform: "claude-code",
      inputTokens: 30,
      outputTokens: 40,
      installScope: "project",
      launchMethod: "binary",
      ts: 3000,
    }),
  );
  store.append(
    rec({
      id: "b2",
      connectorId: "billing",
      toolName: "bill_charge",
      hostPlatform: "cursor",
      inputTokens: 35,
      outputTokens: 45,
      installScope: "project",
      launchMethod: "binary",
      ts: 3500,
    }),
  );

  return store;
}

// ─────────────────────────────────────────────────────────────────────────
// mcpLeaderboard
// ─────────────────────────────────────────────────────────────────────────

describe("mcpLeaderboard — ranks connectors by total tokens desc", () => {
  it("ranks acme-db above billing and aggregates calls/tokens/tools/hosts", () => {
    const store = seed();
    try {
      const rows = mcpLeaderboard({ store });
      expect(rows.map((r) => r.connectorId)).toEqual(["acme-db", "billing"]);

      const acme = rows[0]!;
      // 3 call rows (a1,a2,a3); the tool_defs row a4 is NOT counted as a call.
      expect(acme.calls).toBe(3);
      // Distinct real tools: acme_query + acme_write (the "*" defs row excluded).
      expect(acme.tools).toBe(2);
      // input = 100+150+40 + 80(defs) = 370; output = 200+250+60 = 510.
      expect(acme.inputTokens).toBe(370);
      expect(acme.outputTokens).toBe(510);
      expect(acme.totalTokens).toBe(880);
      // Aggregated across two hosts, sorted.
      expect(acme.hostPlatforms).toEqual(["claude-code", "codex"]);

      const billing = rows[1]!;
      expect(billing.calls).toBe(2);
      expect(billing.tools).toBe(1);
      expect(billing.totalTokens).toBe(30 + 40 + 35 + 45);
      expect(billing.hostPlatforms).toEqual(["claude-code", "cursor"]);
    } finally {
      store.close();
    }
  });

  it("breaks ties by recency (lastTs desc) when totals are equal", () => {
    const store = openStore({ path: storePath });
    try {
      store.append(rec({ id: "t1", connectorId: "older", inputTokens: 5, outputTokens: 5, ts: 1000 }));
      store.append(rec({ id: "t2", connectorId: "newer", inputTokens: 5, outputTokens: 5, ts: 9000 }));
      const rows = mcpLeaderboard({ store });
      expect(rows.map((r) => r.connectorId)).toEqual(["newer", "older"]);
    } finally {
      store.close();
    }
  });

  it("honors the connectorId filter", () => {
    const store = seed();
    try {
      const rows = mcpLeaderboard({ store, connectorId: "billing" });
      expect(rows.map((r) => r.connectorId)).toEqual(["billing"]);
    } finally {
      store.close();
    }
  });

  it("returns no rows for an empty store", () => {
    const store = openStore({ path: storePath });
    try {
      expect(mcpLeaderboard({ store })).toEqual([]);
    } finally {
      store.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// toolLeaderboard
// ─────────────────────────────────────────────────────────────────────────

describe("toolLeaderboard — groups by (connector, tool, scope)", () => {
  it("groups acme_query's two calls and keeps the tool_defs row separate", () => {
    const store = seed();
    try {
      const rows = toolLeaderboard({ store });

      const query = rows.find(
        (r) => r.connectorId === "acme-db" && r.toolName === "acme_query" && r.scope === "call",
      )!;
      expect(query).toBeDefined();
      expect(query.calls).toBe(2);
      expect(query.inputTokens).toBe(250); // 100 + 150
      expect(query.outputTokens).toBe(450); // 200 + 250
      expect(query.totalTokens).toBe(700);

      // The tool-defs overhead is its OWN row (tool "*", scope tool_defs), not
      // merged into a call and not counted as a call.
      const defs = rows.find(
        (r) => r.connectorId === "acme-db" && r.scope === "tool_defs",
      )!;
      expect(defs).toBeDefined();
      expect(defs.toolName).toBe("*");
      expect(defs.calls).toBe(0);
      expect(defs.totalTokens).toBe(80);

      // The most expensive tool group ranks first.
      expect(rows[0]!.toolName).toBe("acme_query");
    } finally {
      store.close();
    }
  });

  it("does not merge the same tool name across two connectors", () => {
    const store = openStore({ path: storePath });
    try {
      store.append(rec({ id: "x1", connectorId: "c-one", toolName: "shared", inputTokens: 10, outputTokens: 0 }));
      store.append(rec({ id: "x2", connectorId: "c-two", toolName: "shared", inputTokens: 20, outputTokens: 0 }));
      const rows = toolLeaderboard({ store });
      const connectors = rows.filter((r) => r.toolName === "shared").map((r) => r.connectorId).sort();
      expect(connectors).toEqual(["c-one", "c-two"]);
    } finally {
      store.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// scopeBreakdown — the install/launch slicing dimension
// ─────────────────────────────────────────────────────────────────────────

describe("scopeBreakdown — splits by (installScope, launchMethod)", () => {
  it("splits user/npx vs project/binary", () => {
    const store = seed();
    try {
      const rows = scopeBreakdown({ store });

      const userNpx = rows.find((r) => r.installScope === "user" && r.launchMethod === "npx")!;
      expect(userNpx).toBeDefined();
      // acme-db: 3 calls + the defs row → 4 rows, but only calls count.
      expect(userNpx.calls).toBe(3);
      expect(userNpx.totalTokens).toBe(880);

      const projBinary = rows.find(
        (r) => r.installScope === "project" && r.launchMethod === "binary",
      )!;
      expect(projBinary).toBeDefined();
      expect(projBinary.calls).toBe(2);
      expect(projBinary.totalTokens).toBe(150);

      // Exactly the two seeded buckets are present.
      expect(rows).toHaveLength(2);
      // user/npx (880) outranks project/binary (150).
      expect(rows[0]!.installScope).toBe("user");
    } finally {
      store.close();
    }
  });

  it("reads a row that lacks the scope fields as (unknown, unknown)", () => {
    const store = openStore({ path: storePath });
    try {
      // A pre-scope row: no installScope, no launchMethod.
      store.append(rec({ id: "old", inputTokens: 11, outputTokens: 0 }));
      const rows = scopeBreakdown({ store });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.installScope).toBe("unknown");
      expect(rows[0]!.launchMethod).toBe("unknown");
    } finally {
      store.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Scope FILTER (slicing the leaderboards by a scope value)
// ─────────────────────────────────────────────────────────────────────────

describe("scope filter — restricts the leaderboard to a scope slice", () => {
  it("scope:project keeps only the project-installed connector", () => {
    const store = seed();
    try {
      const rows = mcpLeaderboard({ store, scope: "project" });
      expect(rows.map((r) => r.connectorId)).toEqual(["billing"]);
    } finally {
      store.close();
    }
  });

  it("scope:npx keeps only the npx-launched connector", () => {
    const store = seed();
    try {
      const rows = mcpLeaderboard({ store, scope: "npx" });
      expect(rows.map((r) => r.connectorId)).toEqual(["acme-db"]);
    } finally {
      store.close();
    }
  });

  it("scope:unknown matches ONLY rows missing the field (never a concrete bucket)", () => {
    const store = openStore({ path: storePath });
    try {
      store.append(rec({ id: "k1", connectorId: "scoped", installScope: "user", launchMethod: "npx", inputTokens: 5, outputTokens: 0 }));
      store.append(rec({ id: "k2", connectorId: "legacy", inputTokens: 7, outputTokens: 0 }));
      const rows = mcpLeaderboard({ store, scope: "unknown" });
      expect(rows.map((r) => r.connectorId)).toEqual(["legacy"]);
    } finally {
      store.close();
    }
  });

  it("isScopeFilter accepts every declared value and rejects junk", () => {
    for (const v of SCOPE_FILTER_VALUES) expect(isScopeFilter(v)).toBe(true);
    expect(isScopeFilter("nope")).toBe(false);
    expect(isScopeFilter("")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Confidence ordering — host-native is preserved (worst-of semantics)
// ─────────────────────────────────────────────────────────────────────────

describe("host-native confidence ordering is preserved", () => {
  it("a pure host-native group keeps host-native confidence", () => {
    const store = openStore({ path: storePath });
    try {
      store.append(rec({ id: "h1", connectorId: "native", confidenceSource: "host-native", inputTokens: 1, outputTokens: 1 }));
      store.append(rec({ id: "h2", connectorId: "native", confidenceSource: "host-native", inputTokens: 1, outputTokens: 1 }));
      const rows = mcpLeaderboard({ store });
      expect(rows[0]!.confidence).toBe("host-native");
    } finally {
      store.close();
    }
  });

  it("mixing host-native with an estimate downgrades to the estimate (worst-of)", () => {
    const store = openStore({ path: storePath });
    try {
      store.append(rec({ id: "m1", connectorId: "mix", confidenceSource: "host-native", inputTokens: 1, outputTokens: 1 }));
      store.append(rec({ id: "m2", connectorId: "mix", confidenceSource: "heuristic", inputTokens: 1, outputTokens: 1 }));
      const rows = mcpLeaderboard({ store });
      // host-native (rank 3) vs heuristic (rank 0) → heuristic is the worse.
      expect(rows[0]!.confidence).toBe("heuristic");
    } finally {
      store.close();
    }
  });

  it("host-native outranks tokenizer-exact in worst-of (exact stays the floor)", () => {
    const store = openStore({ path: storePath });
    try {
      store.append(rec({ id: "e1", connectorId: "ex", confidenceSource: "host-native", inputTokens: 1, outputTokens: 1 }));
      store.append(rec({ id: "e2", connectorId: "ex", confidenceSource: "tokenizer-exact", inputTokens: 1, outputTokens: 1 }));
      const rows = mcpLeaderboard({ store });
      // tokenizer-exact (rank 2) is worse than host-native (rank 3).
      expect(rows[0]!.confidence).toBe("tokenizer-exact");
    } finally {
      store.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Formatters — empty-state + populated tables (smoke / contract)
// ─────────────────────────────────────────────────────────────────────────

describe("formatters render aligned tables", () => {
  it("formatMcpLeaderboard renders an empty-state table", () => {
    const out = formatMcpLeaderboard([]);
    expect(out).toContain("CONNECTOR");
    expect(out).toContain("(no MCP telemetry recorded)");
    expect(out).toContain("TOTAL");
  });

  it("formatMcpLeaderboard ranks rows and shows hosts", () => {
    const store = seed();
    try {
      const out = formatMcpLeaderboard(mcpLeaderboard({ store }));
      const lines = out.split("\n");
      const acmeIdx = lines.findIndex((l) => l.includes("acme-db"));
      const billIdx = lines.findIndex((l) => l.includes("billing"));
      expect(acmeIdx).toBeGreaterThan(-1);
      expect(billIdx).toBeGreaterThan(acmeIdx); // acme-db ranked above billing
      expect(out).toContain("claude-code,codex"); // host set joined
    } finally {
      store.close();
    }
  });

  it("formatToolLeaderboard surfaces the tool_defs scope row", () => {
    const store = seed();
    try {
      const out = formatToolLeaderboard(toolLeaderboard({ store }));
      expect(out).toContain("tool_defs");
      expect(out).toContain("acme_query");
    } finally {
      store.close();
    }
  });

  it("formatScopeBreakdown shows the install + launch buckets", () => {
    const store = seed();
    try {
      const out = formatScopeBreakdown(scopeBreakdown({ store }));
      expect(out).toContain("INSTALL");
      expect(out).toContain("LAUNCH");
      expect(out).toContain("npx");
      expect(out).toContain("binary");
    } finally {
      store.close();
    }
  });

  it("an estimate confidence triggers the honesty legend", () => {
    const store = openStore({ path: storePath });
    try {
      store.append(rec({ id: "est", confidenceSource: "heuristic", inputTokens: 1, outputTokens: 1 }));
      const out = formatMcpLeaderboard(mcpLeaderboard({ store }));
      expect(out).toContain("estimates");
    } finally {
      store.close();
    }
  });
});
