/**
 * runtime/telemetry-accessor — the handler-facing per-connector usage accessor.
 *
 * buildTelemetryAccessor(connectorId) returns an async fn that sums every stored
 * row's inputTokens/outputTokens for the connector and counts the rows (`calls`).
 * Contract:
 *   • sums only THIS connector's rows (other connectors' rows are excluded);
 *   • AGENT_CONNECTOR_TELEMETRY=0 → zeros without touching disk;
 *   • never throws — a read error resolves to zeros.
 *
 * Filesystem is isolated to fresh temp HOME + data dirs, restored in afterEach.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTelemetryAccessor } from "../../src/runtime/telemetry-accessor.js";
import { newRecordId, openStore } from "../../src/telemetry/store.js";
import type { ToolEventRecord } from "../../src/telemetry/types.js";

const CONN_ID = "tele-accessor";
const OTHER_ID = "tele-other";

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  TELEMETRY: process.env.AGENT_CONNECTOR_TELEMETRY,
};

let tmpHome: string;
let tmpData: string;

/** Append one telemetry row for `connectorId` with the given token counts. */
function seedRow(
  connectorId: string,
  inputTokens: number,
  outputTokens: number,
  seq: number,
): void {
  const row: ToolEventRecord = {
    id: newRecordId(seq),
    ts: Date.now(),
    connectorId,
    toolName: "some_tool",
    scope: "call",
    surfaceKind: "server",
    hostPlatform: "claude-code",
    sessionId: "sess-1",
    projectKey: "k",
    projectDir: "/p",
    inputTokens,
    outputTokens,
    confidenceSource: "tokenizer-exact",
    isError: false,
  };
  const store = openStore({});
  try {
    store.append(row);
  } finally {
    store.close();
  }
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-tacc-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-tacc-data-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENT_CONNECTOR_DATA_DIR = tmpData;
  delete process.env.AGENT_CONNECTOR_TELEMETRY;
});

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const d of [tmpHome, tmpData]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("buildTelemetryAccessor", () => {
  it("sums this connector's rows and counts the calls", async () => {
    seedRow(CONN_ID, 10, 3, 0);
    seedRow(CONN_ID, 5, 2, 1);
    // A row for a DIFFERENT connector must be excluded from the sum.
    seedRow(OTHER_ID, 100, 100, 2);

    const summary = await buildTelemetryAccessor(CONN_ID)();
    expect(summary.inputTokens).toBe(15);
    expect(summary.outputTokens).toBe(5);
    expect(summary.totalTokens).toBe(20);
    expect(summary.calls).toBe(2);
  });

  it("returns zeros when the connector has no rows (no store file)", async () => {
    const summary = await buildTelemetryAccessor("never-seen")();
    expect(summary).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      calls: 0,
    });
  });

  it("returns zeros under AGENT_CONNECTOR_TELEMETRY=0 even with rows present", async () => {
    seedRow(CONN_ID, 10, 3, 0); // written BEFORE the kill switch is set
    process.env.AGENT_CONNECTOR_TELEMETRY = "0";
    const summary = await buildTelemetryAccessor(CONN_ID)();
    expect(summary).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      calls: 0,
    });
  });

  it("a malformed row (missing or string token field) never poisons the sum", async () => {
    seedRow(CONN_ID, 10, 3, 0); // a good row
    // Inject rows whose token fields are NOT finite numbers — a legacy / type-
    // drifted / hand-edited line. The accessor coerces each addend to 0 rather
    // than producing NaN (missing) or a string concat. seedRow types its args as
    // numbers, so cast to inject the malformed shapes.
    seedRow(CONN_ID, undefined as unknown as number, 7, 1); // missing input → NaN risk
    seedRow(CONN_ID, "5" as unknown as number, "3" as unknown as number, 2); // strings → concat risk

    const summary = await buildTelemetryAccessor(CONN_ID)();
    // Only the good row's tokens count; the malformed rows contribute 0 tokens
    // but are still counted as calls. Everything stays a finite number.
    expect(Number.isFinite(summary.inputTokens)).toBe(true);
    expect(Number.isFinite(summary.outputTokens)).toBe(true);
    expect(summary.inputTokens).toBe(10);
    expect(summary.outputTokens).toBe(3 + 7); // the "missing input" row still had a numeric output
    expect(summary.totalTokens).toBe(summary.inputTokens + summary.outputTokens);
    expect(summary.calls).toBe(3);
  });

  it("never throws even when the store itself cannot be opened (zeros)", async () => {
    // Point the data dir at a FILE (not a dir) so openStore's path setup fails;
    // the accessor swallows the error and resolves zeros rather than rejecting.
    const asFile = join(tmpData, "not-a-dir");
    writeFileSync(asFile, "x");
    process.env.AGENT_CONNECTOR_DATA_DIR = asFile;
    await expect(buildTelemetryAccessor(CONN_ID)()).resolves.toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      calls: 0,
    });
  });
});
