/**
 * tests/telemetry/surface-leaderboard — the PER-SURFACE developer view across
 * all FIVE developer-axis surfaces.
 *
 * Seeds a temp telemetry.ndjson with RUNTIME rows:
 *   • server `call` + `tool_defs` rows (surfaceKind absent → read as `server`),
 *   • a `hook` row (scope `hook`, surfaceKind `hook`, toolName = event name),
 * then folds in the STATIC command/skill/subagent footprints of a connector and
 * asserts surfaceLeaderboard lists server + hook (runtime) and command/skill/
 * subagent (static), with the runtime/static KIND honestly distinguished.
 *
 * Filesystem is isolated to an os.tmpdir mkdtemp dir; HOME / data-root env vars
 * are saved + restored. Every store is opened with an explicit { path }.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConnector } from "../../src/core/define-connector.js";
import { newRecordId, openStore } from "../../src/telemetry/store.js";
import {
  formatSurfaceLeaderboard,
  surfaceLeaderboard,
} from "../../src/telemetry/leaderboard.js";
import type { TelemetryStore, ToolEventRecord } from "../../src/telemetry/types.js";

let tmp: string;
let storePath: string;

const SAVED = {
  HOME: process.env.HOME,
  DATA_DIR: process.env.AGENTCONNECT_DATA_DIR,
  TELEMETRY: process.env.AGENTCONNECT_TELEMETRY,
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ac-surf-lb-"));
  storePath = join(tmp, "telemetry.ndjson");
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.AGENTCONNECT_DATA_DIR = tmp;
  delete process.env.AGENTCONNECT_TELEMETRY;
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
    connectorId: over.connectorId ?? "surf-demo",
    toolName: over.toolName ?? "acme_query",
    scope: over.scope ?? "call",
    hostPlatform: over.hostPlatform ?? "claude-code",
    sessionId: over.sessionId ?? "sess-1",
    projectKey: over.projectKey ?? "proj-key-1",
    projectDir: over.projectDir ?? "/home/dev/acme",
    inputTokens: over.inputTokens ?? 10,
    outputTokens: over.outputTokens ?? 20,
    confidenceSource: over.confidenceSource ?? "tokenizer-approx",
    isError: over.isError ?? false,
    ...(over.surfaceKind !== undefined ? { surfaceKind: over.surfaceKind } : {}),
  };
}

/** A connector declaring one of each content surface (drives the static rows). */
function buildConnector() {
  return defineConnector({
    id: "surf-demo",
    commands: [
      {
        name: "deploy",
        description: "Deploy the app",
        prompt: "Deploy the application and report status.",
      },
    ],
    skills: [
      {
        name: "db-audit",
        description: "Audit a database for slow queries.",
        body: "Run EXPLAIN; flag full scans.",
      },
    ],
    subagents: [
      {
        name: "reviewer",
        description: "Reviews a diff for bugs.",
        prompt: "You are a meticulous code reviewer.",
      },
    ],
  });
}

/** Seed server (call + tool_defs) and hook runtime rows. */
function seed(): TelemetryStore {
  const store = openStore({ path: storePath });
  // server `call` row — surfaceKind absent → must read as `server`.
  store.append(rec({ id: "s1", toolName: "acme_query", scope: "call", inputTokens: 100, outputTokens: 200 }));
  // server `tool_defs` overhead — surfaceKind absent → `server`, not a call.
  store.append(rec({ id: "s2", toolName: "*", scope: "tool_defs", inputTokens: 80, outputTokens: 0 }));
  // hook runtime row — scope `hook`, surfaceKind `hook`, toolName = event name.
  store.append(
    rec({
      id: "h1",
      toolName: "SessionStart",
      scope: "hook",
      surfaceKind: "hook",
      inputTokens: 30,
      outputTokens: 5,
    }),
  );
  return store;
}

describe("surfaceLeaderboard — combines runtime + static across FIVE surfaces", () => {
  it("lists server + hook (runtime) and command/skill/subagent (static)", () => {
    const store = seed();
    try {
      const rows = surfaceLeaderboard({ store, connectors: [buildConnector()] });

      const kinds = new Set(rows.map((r) => r.surfaceKind));
      expect(kinds.has("server")).toBe(true);
      expect(kinds.has("hook")).toBe(true);
      expect(kinds.has("command")).toBe(true);
      expect(kinds.has("skill")).toBe(true);
      expect(kinds.has("subagent")).toBe(true);

      // server: the `call` and `tool_defs` rows both read as `server` (legacy).
      const server = rows.filter((r) => r.surfaceKind === "server");
      expect(server.every((r) => r.kind === "runtime")).toBe(true);
      // the `call` row (acme_query) is one call; tool_defs is not counted as one.
      const call = server.find((r) => r.name === "acme_query")!;
      expect(call.calls).toBe(1);
      const defs = server.find((r) => r.name === "*")!;
      expect(defs.calls).toBe(0);

      // hook: scope `hook` row, named by the event, counted as a call, runtime.
      const hook = rows.find((r) => r.surfaceKind === "hook")!;
      expect(hook.kind).toBe("runtime");
      expect(hook.name).toBe("SessionStart");
      expect(hook.calls).toBe(1);
      expect(hook.totalTokens).toBe(35);

      // static surfaces: footprints in inputTokens, no output, no calls, static.
      for (const kind of ["command", "skill", "subagent"] as const) {
        const r = rows.find((x) => x.surfaceKind === kind)!;
        expect(r.kind).toBe("static");
        expect(r.calls).toBe(0);
        expect(r.outputTokens).toBe(0);
        expect(r.inputTokens).toBeGreaterThan(0);
        expect(r.totalTokens).toBe(r.inputTokens);
      }

      // The static command/skill/subagent are named from the connector.
      expect(rows.find((r) => r.surfaceKind === "command")!.name).toBe("deploy");
      expect(rows.find((r) => r.surfaceKind === "skill")!.name).toBe("db-audit");
      expect(rows.find((r) => r.surfaceKind === "subagent")!.name).toBe("reviewer");
    } finally {
      store.close();
    }
  });

  it("excludes model_turn rows (the per-MCP convention is preserved)", () => {
    const store = openStore({ path: storePath });
    try {
      store.append(rec({ id: "mt", scope: "model_turn", toolName: "turn", inputTokens: 999, outputTokens: 999 }));
      const rows = surfaceLeaderboard({ store });
      // No model_turn row leaks into the surface view.
      expect(rows.some((r) => r.name === "turn")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("reports runtime-only rows when no connectors are passed (no static rows)", () => {
    const store = seed();
    try {
      const rows = surfaceLeaderboard({ store });
      expect(rows.every((r) => r.kind === "runtime")).toBe(true);
      expect(rows.some((r) => r.surfaceKind === "hook")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("sorts by total tokens desc", () => {
    const store = seed();
    try {
      const rows = surfaceLeaderboard({ store, connectors: [buildConnector()] });
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i - 1]!.totalTokens).toBeGreaterThanOrEqual(rows[i]!.totalTokens);
      }
    } finally {
      store.close();
    }
  });
});

describe("formatSurfaceLeaderboard — renders the SURFACE|NAME|IN|OUT|TOTAL|KIND table", () => {
  it("renders all five surfaces and labels the static footprint note", () => {
    const store = seed();
    try {
      const out = formatSurfaceLeaderboard(
        surfaceLeaderboard({ store, connectors: [buildConnector()] }),
      );
      expect(out).toContain("SURFACE");
      expect(out).toContain("KIND");
      expect(out).toContain("server");
      expect(out).toContain("hook");
      expect(out).toContain("deploy");
      expect(out).toContain("db-audit");
      expect(out).toContain("reviewer");
      expect(out).toContain("runtime");
      expect(out).toContain("static");
      // The static footprint honesty note is present.
      expect(out).toContain("FOOTPRINT");
    } finally {
      store.close();
    }
  });

  it("renders an empty-state table", () => {
    const out = formatSurfaceLeaderboard([]);
    expect(out).toContain("SURFACE");
    expect(out).toContain("(no developer surfaces recorded)");
    expect(out).toContain("TOTAL");
  });
});
