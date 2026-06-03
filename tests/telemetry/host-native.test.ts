/**
 * telemetry/host-native — the OPT-IN host-native turn-usage enricher (4a) +
 * the third leaderboard origin. Asserts:
 *
 *   • runUsageEvent parses a Gemini AfterModel `usageMetadata` payload into a
 *     DISTINCT scope:"model_turn" record (confidence host-native, toolName "*"),
 *     with input = promptTokenCount - cachedContentTokenCount and output =
 *     candidatesTokenCount + thoughtsTokenCount; it exits 0 and appends one row.
 *   • runUsageEvent fails OPEN on garbage / empty / non-usage stdin: exit 0, no
 *     throw, NO record appended.
 *   • the MCP/plugin leaderboard EXCLUDES model_turn rows (just as it special-
 *     cases tool_defs), while hostNativeTurns aggregates ONLY those rows.
 *   • the three origins (per-MCP call, tool_defs overhead, host-native turns) are
 *     never summed: each leaderboard's totals stay within its own origin.
 *
 * Isolation: AGENT_CONNECTOR_DATA_DIR → fresh mkdtemp dir so the shared telemetry
 * store (dataRoot/telemetry.ndjson) is sandboxed; env saved/restored in afterEach.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runUsageEvent } from "../../src/runtime/usage-event.js";
import {
  hostNativeTurns,
  mcpLeaderboard,
} from "../../src/telemetry/leaderboard.js";
import { openStore } from "../../src/telemetry/store.js";
import type { ToolEventRecord } from "../../src/telemetry/types.js";

// ─────────────────────────────────────────────────────────────────────────
// Isolation: temp data-root + saved env
// ─────────────────────────────────────────────────────────────────────────

let tmp: string;

const SAVED = {
  HOME: process.env.HOME,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  TELEMETRY: process.env.AGENT_CONNECTOR_TELEMETRY,
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ac-hostnative-"));
  process.env.HOME = tmp;
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

/** Read every row from the (default, sandboxed) telemetry store. */
function allRows(): ToolEventRecord[] {
  const store = openStore({});
  try {
    return store.query({});
  } finally {
    store.close();
  }
}

/** A canonical Gemini AfterModel payload (cache-inclusive promptTokenCount). */
function geminiAfterModel(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "gem-sess-1",
    cwd: "/home/dev/acme",
    usageMetadata: {
      promptTokenCount: 1000,
      cachedContentTokenCount: 200,
      candidatesTokenCount: 300,
      thoughtsTokenCount: 50,
      totalTokenCount: 1350,
    },
    ...over,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// runUsageEvent — parse a Gemini AfterModel usageMetadata payload
// ─────────────────────────────────────────────────────────────────────────

describe("runUsageEvent (Gemini AfterModel → model_turn host-native record)", () => {
  it("parses usageMetadata into a scope:model_turn host-native row and exits 0", async () => {
    const result = await runUsageEvent({
      platformId: "gemini-cli",
      connectorId: "acme-db",
      stdin: geminiAfterModel(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.recorded).toBe(true);

    const rows = allRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.scope).toBe("model_turn");
    expect(row.confidenceSource).toBe("host-native");
    expect(row.toolName).toBe("*");
    expect(row.hostPlatform).toBe("gemini-cli");
    expect(row.connectorId).toBe("acme-db");
    expect(row.sessionId).toBe("gem-sess-1");
    expect(row.isError).toBe(false);
    // input = prompt(1000) - cached(200); output = candidates(300) + thoughts(50)
    expect(row.inputTokens).toBe(800);
    expect(row.outputTokens).toBe(350);
  });

  it("tolerates snake_case usage_metadata + token field spellings", async () => {
    const stdin = JSON.stringify({
      usage_metadata: {
        prompt_token_count: 500,
        cached_content_token_count: 100,
        candidates_token_count: 60,
        thoughts_token_count: 0,
      },
    });
    const result = await runUsageEvent({
      platformId: "antigravity",
      connectorId: "acme-db",
      stdin,
    });
    expect(result.recorded).toBe(true);
    const row = allRows()[0]!;
    expect(row.scope).toBe("model_turn");
    expect(row.inputTokens).toBe(400); // 500 - 100
    expect(row.outputTokens).toBe(60);
  });

  it("clamps cached to prompt so net input never goes negative", async () => {
    const result = await runUsageEvent({
      platformId: "gemini-cli",
      connectorId: "acme-db",
      stdin: geminiAfterModel({
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 999, // pathological: cached > prompt
          candidatesTokenCount: 10,
        },
      }),
    });
    expect(result.recorded).toBe(true);
    const row = allRows()[0]!;
    expect(row.inputTokens).toBe(0); // max(0, 100 - min(999,100))
    expect(row.outputTokens).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runUsageEvent — fail-open on garbage / empty / non-usage stdin
// ─────────────────────────────────────────────────────────────────────────

describe("runUsageEvent fail-open (never throws, never records)", () => {
  it("records nothing on empty stdin (exit 0)", async () => {
    const result = await runUsageEvent({
      platformId: "gemini-cli",
      connectorId: "acme-db",
      stdin: "",
    });
    expect(result.exitCode).toBe(0);
    expect(result.recorded).toBe(false);
    expect(allRows()).toHaveLength(0);
  });

  it("records nothing on non-JSON garbage stdin (exit 0, no throw)", async () => {
    const result = await runUsageEvent({
      platformId: "gemini-cli",
      connectorId: "acme-db",
      stdin: "}{ not json at all <<<",
    });
    expect(result.exitCode).toBe(0);
    expect(result.recorded).toBe(false);
    expect(allRows()).toHaveLength(0);
  });

  it("records nothing when the payload carries no usageMetadata", async () => {
    const result = await runUsageEvent({
      platformId: "gemini-cli",
      connectorId: "acme-db",
      stdin: JSON.stringify({ session_id: "x", somethingElse: true }),
    });
    expect(result.recorded).toBe(false);
    expect(allRows()).toHaveLength(0);
  });

  it("records nothing when a turn has zero measurable tokens", async () => {
    const result = await runUsageEvent({
      platformId: "gemini-cli",
      connectorId: "acme-db",
      stdin: JSON.stringify({
        usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 },
      }),
    });
    expect(result.recorded).toBe(false);
    expect(allRows()).toHaveLength(0);
  });

  it("records nothing (and does not throw) on a JSON array payload", async () => {
    const result = await runUsageEvent({
      platformId: "gemini-cli",
      connectorId: "acme-db",
      stdin: "[1, 2, 3]",
    });
    expect(result.recorded).toBe(false);
    expect(allRows()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Leaderboard origin separation: MCP excludes model_turn; hostNativeTurns aggregates them
// ─────────────────────────────────────────────────────────────────────────

describe("leaderboard origin separation (the three origins are never summed)", () => {
  /** Append a per-MCP `call` and a `tool_defs` row alongside a host-native turn. */
  function seedAllThreeOrigins(): void {
    const store = openStore({});
    const base = {
      hostPlatform: "gemini-cli" as const,
      sessionId: "gem-sess-1",
      projectKey: "proj-key-1",
      projectDir: "/home/dev/acme",
      isError: false,
    };
    // origin 1: per-MCP tools/call round-trip
    store.append({
      id: "1-0",
      ts: 1_700_000_000_000,
      connectorId: "acme-db",
      toolName: "acme_query",
      scope: "call",
      inputTokens: 10,
      outputTokens: 20,
      confidenceSource: "tokenizer-approx",
      ...base,
    });
    // origin 2: one-time tool_defs schema overhead
    store.append({
      id: "1-1",
      ts: 1_700_000_000_001,
      connectorId: "acme-db",
      toolName: "*",
      scope: "tool_defs",
      inputTokens: 5,
      outputTokens: 0,
      confidenceSource: "tokenizer-exact",
      ...base,
    });
    store.close();
  }

  it("MCP leaderboard EXCLUDES model_turn rows; hostNativeTurns aggregates ONLY them", async () => {
    seedAllThreeOrigins();
    // origin 3: a host-native model turn (input 800, output 350) via the enricher.
    await runUsageEvent({
      platformId: "gemini-cli",
      connectorId: "acme-db",
      stdin: geminiAfterModel(),
    });

    // The MCP leaderboard sees ONLY the call (30) + tool_defs (5) tokens = 35,
    // and 1 call — the 1,150-token host-native turn is excluded entirely.
    const mcp = mcpLeaderboard();
    expect(mcp).toHaveLength(1);
    expect(mcp[0]!.connectorId).toBe("acme-db");
    expect(mcp[0]!.calls).toBe(1); // tool_defs does NOT count as a call
    expect(mcp[0]!.totalTokens).toBe(35); // 10+20 (call) + 5 (tool_defs)
    // worst confidence across call(approx) + tool_defs(exact) = approx.
    expect(mcp[0]!.confidence).toBe("tokenizer-approx");

    // hostNativeTurns sees ONLY the model_turn row: 800 + 350 = 1,150 tokens.
    const turns = hostNativeTurns();
    expect(turns).toHaveLength(1);
    expect(turns[0]!.turns).toBe(1);
    expect(turns[0]!.inputTokens).toBe(800);
    expect(turns[0]!.outputTokens).toBe(350);
    expect(turns[0]!.totalTokens).toBe(1150);
    expect(turns[0]!.confidence).toBe("host-native");
    expect(turns[0]!.connectors).toEqual(["acme-db"]);

    // The two origins are DISJOINT — their totals are never summed and the
    // host-native turn never leaks into the MCP total (35 ≠ 35 + 1150).
    expect(mcp[0]!.totalTokens).not.toBe(
      mcp[0]!.totalTokens + turns[0]!.totalTokens,
    );
    expect(turns[0]!.totalTokens).toBeGreaterThan(mcp[0]!.totalTokens);
  });

  it("hostNativeTurns aggregates multiple turns in the same host/session", async () => {
    await runUsageEvent({
      platformId: "gemini-cli",
      connectorId: "acme-db",
      stdin: geminiAfterModel(),
    });
    await runUsageEvent({
      platformId: "gemini-cli",
      connectorId: "acme-db",
      stdin: geminiAfterModel(),
    });

    const turns = hostNativeTurns();
    expect(turns).toHaveLength(1); // same (host, session) → one group
    expect(turns[0]!.turns).toBe(2);
    expect(turns[0]!.inputTokens).toBe(1600); // 800 * 2
    expect(turns[0]!.outputTokens).toBe(700); // 350 * 2

    // With no per-MCP rows seeded, the MCP leaderboard is empty — proof the
    // model_turn rows are not visible to it at all.
    expect(mcpLeaderboard()).toHaveLength(0);
  });

  it("groups host-native turns by distinct (host, session)", async () => {
    await runUsageEvent({
      platformId: "gemini-cli",
      connectorId: "acme-db",
      stdin: geminiAfterModel({ session_id: "sess-A" }),
    });
    await runUsageEvent({
      platformId: "antigravity",
      connectorId: "acme-db",
      stdin: geminiAfterModel({ session_id: "sess-B" }),
    });

    const turns = hostNativeTurns();
    expect(turns).toHaveLength(2);
    const hosts = turns.map((t) => t.hostPlatform).sort();
    expect(hosts).toEqual(["antigravity", "gemini-cli"]);
  });
});
