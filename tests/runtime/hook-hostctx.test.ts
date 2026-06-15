/**
 * runtime/hook-hostctx — the HostCtx unification on the hook event, driven
 * through the REAL runHook entrypoint.
 *
 * runHook backfills `evt.capabilities` (from the adapter), `evt.scope` (from the
 * registered metadata), and `evt.telemetry` (the usage accessor) before the
 * handler runs — in BOTH the main path and the deny-preserve error path. We make
 * those observable through a PreToolUse deny whose `reason` embeds the values the
 * handler read off the event:
 *   • capabilities → `evt.capabilities?.supportsStatusline` (claude-code: true).
 *   • scope        → registered at scope "user" → `evt.scope` === "user".
 *   • telemetry    → `typeof evt.telemetry` === "function".
 *
 * Like the sibling per-host/telemetry runtime tests, the live handler comes from
 * a fixture .mjs importing defineConnector from the BUILT dist entry; the
 * filesystem is isolated to fresh temp HOME + data dirs, restored in afterEach.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConnectorFromPath, registerConnector } from "../../src/core/load-connector.js";
import { runHook } from "../../src/runtime/hook-entrypoint.js";

const DIST_INDEX = join(__dirname, "..", "..", "dist", "index.js");
const CONNECTOR_ID = "hook-hostctx";

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  TELEMETRY: process.env.AGENT_CONNECTOR_TELEMETRY,
  HOST: process.env.AGENT_CONNECTOR_HOST,
};

let tmpHome: string;
let tmpData: string;

/**
 * Fixture: a PreToolUse hook whose handler DENIES with a reason that encodes the
 * three runtime-backfilled HostCtx fields it read off the event.
 */
function writeFixtureModule(dir: string): string {
  const modPath = join(dir, "hostctx.config.mjs");
  const distUrl = pathToFileURL(DIST_INDEX).href;
  const source = `
import { defineConnector } from ${JSON.stringify(distUrl)};

export default defineConnector({
  id: ${JSON.stringify(CONNECTOR_ID)},
  hooks: {
    PreToolUse: {
      handler(evt) {
        const sl = evt.capabilities?.supportsStatusline === true;
        const tele = typeof evt.telemetry;
        return {
          decision: "deny",
          reason: \`sl=\${sl} scope=\${evt.scope} tele=\${tele}\`,
        };
      },
    },
  },
});
`;
  writeFileSync(modPath, source, "utf8");
  return modPath;
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-hctx-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-hctx-data-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENT_CONNECTOR_DATA_DIR = tmpData;
  process.env.AGENT_CONNECTOR_TELEMETRY = "0"; // keep the test about the ctx, not telemetry rows
  delete process.env.AGENT_CONNECTOR_HOST;
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

const stdin = JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "ls" },
  session_id: "sess-hostctx",
});

describe("runHook — HostCtx backfill on the event", () => {
  it("populates capabilities + telemetry (scope undefined when registered with none)", async () => {
    // Register WITHOUT a scope → evt.scope is undefined, but capabilities and the
    // telemetry accessor are always backfilled before the handler runs.
    const modPath = writeFixtureModule(tmpData);
    const { connector } = await loadConnectorFromPath(modPath);
    registerConnector(connector, modPath);

    const res = await runHook({
      platformId: "claude-code",
      event: "PreToolUse",
      connectorId: CONNECTOR_ID,
      stdin,
    });
    const out = res.stdout ?? "";
    expect(out).toContain("sl=true");
    expect(out).toContain("scope=undefined");
    expect(out).toContain("tele=function");
  });

  it("populates evt.scope from the registered metadata (register at scope 'user')", async () => {
    const modPath = writeFixtureModule(tmpData);
    const { connector } = await loadConnectorFromPath(modPath);
    // Persist the install scope, exactly as the installer does.
    registerConnector(connector, modPath, "user");

    const res = await runHook({
      platformId: "claude-code",
      event: "PreToolUse",
      connectorId: CONNECTOR_ID,
      stdin,
    });
    expect(res.stdout ?? "").toContain("scope=user");
  });

  it("carries the same backfilled scope on the deny-preserve error path", async () => {
    // A PreToolUse deny is reconstructed on the error path; that path backfills
    // the SAME HostCtx fields, so the reconstructed deny still reads scope=user.
    const modPath = writeFixtureModule(tmpData);
    const { connector } = await loadConnectorFromPath(modPath);
    registerConnector(connector, modPath, "user");

    // Force the MAIN-path formatReply to throw once → drive reconstruction.
    const claudeAdapter = (await import("../../src/adapters/claude-code/index.js"))
      .default;
    const { vi } = await import("vitest");
    vi.spyOn(claudeAdapter, "formatReply").mockImplementationOnce(() => {
      throw new Error("boom after the deny resolved");
    });

    const res = await runHook({
      platformId: "claude-code",
      event: "PreToolUse",
      connectorId: CONNECTOR_ID,
      stdin,
    });
    const out = res.stdout ?? "";
    // ALL THREE backfilled fields must be symmetric across the main and error
    // paths — a regression dropping capabilities/telemetry from
    // failOpenOrPreserveDeny would otherwise pass silently.
    expect(out).toContain("sl=true");
    expect(out).toContain("scope=user");
    expect(out).toContain("tele=function");
    expect(out).toContain("deny");
    vi.restoreAllMocks();
  });
});
