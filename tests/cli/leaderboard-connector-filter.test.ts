/**
 * tests/cli/leaderboard-connector-filter — the top-level `leaderboard --connector
 * <id>` FILTER restricts the 🔌 MCP/plugin section to one connector while leaving
 * the 🖥️ host-scan section connector-agnostic.
 *
 * Seeds a temp telemetry store (two connectors) in an isolated data-root, runs
 * the leaderboard command's run() directly, and captures stdout. Asserts that the
 * filtered connector appears, the other does NOT (in the MCP section), and the
 * connector-agnostic host-scan note is shown.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newRecordId, openStore } from "../../src/telemetry/store.js";
import type { ToolEventRecord } from "../../src/telemetry/types.js";
import { run as leaderboardRun } from "../../src/cli/commands/leaderboard.js";

let tmp: string;

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENTCONNECT_DATA_DIR,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  TELEMETRY: process.env.AGENTCONNECT_TELEMETRY,
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ac-lb-filter-"));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.AGENTCONNECT_DATA_DIR = tmp;
  process.env.XDG_DATA_HOME = join(tmp, ".local", "share");
  process.env.XDG_CONFIG_HOME = join(tmp, ".config");
  delete process.env.AGENTCONNECT_TELEMETRY;
});

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

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

/** Capture everything written to process.stdout during fn(). */
async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  let out = "";
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });
  try {
    const code = await fn();
    return { code, out };
  } finally {
    spy.mockRestore();
  }
}

describe("leaderboard --connector filters the MCP section by connectorId", () => {
  beforeEach(() => {
    const store = openStore({ path: join(tmp, "telemetry.ndjson") });
    store.append(rec({ id: "a1", connectorId: "acme-db", inputTokens: 100, outputTokens: 200 }));
    store.append(rec({ id: "b1", connectorId: "billing", inputTokens: 999, outputTokens: 999 }));
    store.close();
  });

  it("includes only the filtered connector in the 🔌 MCP/plugin section", async () => {
    const { code, out } = await captureStdout(() => leaderboardRun(["--connector", "acme-db"]));
    expect(code).toBe(0);
    expect(out).toContain("connector: acme-db");
    expect(out).toContain("acme-db");
    // The other connector's row is excluded from the MCP section.
    expect(out).not.toContain("billing");
  });

  it("keeps the 🖥️ host/user section connector-agnostic (note shown, not filtered)", async () => {
    const { code, out } = await captureStdout(() => leaderboardRun(["--connector", "acme-db"]));
    expect(code).toBe(0);
    expect(out).toContain("connector-agnostic");
  });

  it("without --connector, BOTH connectors appear in the MCP section", async () => {
    const { code, out } = await captureStdout(() => leaderboardRun([]));
    expect(code).toBe(0);
    expect(out).toContain("acme-db");
    expect(out).toContain("billing");
    // No connector line when unfiltered.
    expect(out).not.toContain("connector: ");
  });
});
