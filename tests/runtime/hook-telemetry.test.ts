/**
 * runtime/hook-telemetry — the RUNTIME `hook` developer-axis surface.
 *
 * Every hook flows through runHook (the home-bin `hook` entrypoint). After the
 * connector handler runs, the runtime tokenizes the inbound normalized event
 * (input) and the handler's returned response (output) with the SAME tokenizer
 * the serve-proxy uses, then appends a scope:"hook" surfaceKind:"hook" row whose
 * per-item `toolName` is the hook EVENT name.
 *
 * This MUST be fail-open: a measurement error can never break the hook, and the
 * AGENTCONNECT_TELEMETRY=0 kill switch writes NOTHING.
 *
 * Like tests/integration/hook.test.ts, the live handlers come from a fixture
 * .mjs importing defineConnector from the BUILT dist entry (functions can't
 * survive the JSON registry record, so runHook re-imports the module). Filesystem
 * is isolated to fresh temp HOME + data dirs, restored in afterEach.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConnectorFromPath, registerConnector } from "../../src/core/load-connector.js";
import { runHook } from "../../src/runtime/hook-entrypoint.js";
import { openStore } from "../../src/telemetry/store.js";
import type { ToolEventRecord } from "../../src/telemetry/types.js";

const DIST_INDEX = join(__dirname, "..", "..", "dist", "index.js");
const CONNECTOR_ID = "tele-guard";

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENTCONNECT_DATA_DIR,
  TELEMETRY: process.env.AGENTCONNECT_TELEMETRY,
  HOST: process.env.AGENTCONNECT_HOST,
};

let tmpHome: string;
let tmpData: string;

/**
 * Fixture connector: a SessionStart that injects context and a PreToolUse
 * matcher "danger" that denies. Both produce a returned response the runtime can
 * tokenize as the hook's output.
 */
function writeFixtureModule(dir: string): string {
  const modPath = join(dir, "tele.config.mjs");
  const distUrl = pathToFileURL(DIST_INDEX).href;
  const source = `
import { defineConnector } from ${JSON.stringify(distUrl)};

export default defineConnector({
  id: ${JSON.stringify(CONNECTOR_ID)},
  hooks: {
    SessionStart: {
      handler() {
        return { decision: "context", additionalContext: "telemetry guard online and watching" };
      },
    },
    PreToolUse: {
      matcher: "danger",
      handler(evt) {
        if (evt.toolName === "danger") {
          return { decision: "deny", reason: "danger blocked by hook" };
        }
        return { decision: "allow" };
      },
    },
  },
});
`;
  writeFileSync(modPath, source, "utf8");
  return modPath;
}

/** Read every persisted telemetry row from the data-root store. */
function readRows(): ToolEventRecord[] {
  const store = openStore({});
  try {
    return store.query({});
  } finally {
    store.close();
  }
}

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-htele-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-htele-data-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENTCONNECT_DATA_DIR = tmpData;
  delete process.env.AGENTCONNECT_TELEMETRY;
  delete process.env.AGENTCONNECT_HOST;

  const modPath = writeFixtureModule(tmpData);
  const { connector } = await loadConnectorFromPath(modPath);
  registerConnector(connector, modPath);
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

describe("runHook writes a scope:hook telemetry row", () => {
  it("records a SessionStart hook row with the event name + nonzero tokens", async () => {
    const stdin = JSON.stringify({
      hook_event_name: "SessionStart",
      source: "startup",
      session_id: "sess-telemetry",
      cwd: "/home/dev/acme",
    });

    const res = await runHook({
      platformId: "claude-code",
      event: "SessionStart",
      connectorId: CONNECTOR_ID,
      stdin,
    });
    // The hook still dispatches normally (context injected) — measurement is
    // out of band and never changes the reply.
    expect(res.exitCode).toBe(0);

    const hookRows = readRows().filter((r) => r.scope === "hook");
    expect(hookRows).toHaveLength(1);
    const row = hookRows[0]!;
    expect(row.surfaceKind).toBe("hook");
    // For a hook row the per-item name IS the event name.
    expect(row.toolName).toBe("SessionStart");
    expect(row.connectorId).toBe(CONNECTOR_ID);
    expect(row.hostPlatform).toBe("claude-code");
    expect(row.sessionId).toBe("sess-telemetry");
    expect(row.isError).toBe(false);
    // Both the inbound event payload and the returned context tokenize > 0.
    expect(row.inputTokens).toBeGreaterThan(0);
    expect(row.outputTokens).toBeGreaterThan(0);
  });

  it("records a PreToolUse deny hook row named by the event", async () => {
    const stdin = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "danger",
      tool_input: { cmd: "rm -rf /" },
      session_id: "sess-2",
      cwd: "/home/dev/acme",
    });

    const res = await runHook({
      platformId: "claude-code",
      event: "PreToolUse",
      connectorId: CONNECTOR_ID,
      stdin,
    });
    expect(res.exitCode).toBe(0);

    const hookRows = readRows().filter((r) => r.scope === "hook");
    expect(hookRows).toHaveLength(1);
    expect(hookRows[0]!.toolName).toBe("PreToolUse");
    expect(hookRows[0]!.surfaceKind).toBe("hook");
    expect(hookRows[0]!.inputTokens).toBeGreaterThan(0);
  });

  it("prefers the AGENTCONNECT_HOST override for hostPlatform", async () => {
    process.env.AGENTCONNECT_HOST = "opencode";
    await runHook({
      platformId: "claude-code",
      event: "SessionStart",
      connectorId: CONNECTOR_ID,
      stdin: JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }),
    });
    const hookRows = readRows().filter((r) => r.scope === "hook");
    expect(hookRows).toHaveLength(1);
    expect(hookRows[0]!.hostPlatform).toBe("opencode");
  });
});

describe("runHook hook telemetry is fail-open", () => {
  it("writes NOTHING when AGENTCONNECT_TELEMETRY=0 (kill switch)", async () => {
    process.env.AGENTCONNECT_TELEMETRY = "0";
    const res = await runHook({
      platformId: "claude-code",
      event: "SessionStart",
      connectorId: CONNECTOR_ID,
      stdin: JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }),
    });
    // The hook still dispatches and allows — only the measurement is skipped.
    expect(res.exitCode).toBe(0);
    expect(readRows()).toEqual([]);
  });

  it("writes no hook row when the connector has no handler for the event", async () => {
    // The fixture declares no SessionEnd handler → runHook allows without
    // dispatching, so there is nothing to measure.
    await runHook({
      platformId: "claude-code",
      event: "SessionEnd",
      connectorId: CONNECTOR_ID,
      stdin: JSON.stringify({ hook_event_name: "SessionEnd" }),
    });
    expect(readRows().filter((r) => r.scope === "hook")).toEqual([]);
  });
});
