/**
 * runtime/hook-per-host — the per-host `hosts:` override map on hooks, driven
 * through the REAL runHook entrypoint.
 *
 * A HookDefinition may carry `hosts?: { <platformId>: { handler } }`. When
 * dispatching for host X, `hosts[X].handler` WINS over the top-level handler; a
 * host NOT in the map falls back to the top-level handler. Selection preserves
 * fail-open (it never throws — a missing/invalid entry just falls back).
 *
 * Both branches are made observable through a PreToolUse deny whose `reason`
 * differs per host: the per-host handler denies with "HOST-REASON", the
 * top-level handler with "TOP-REASON". claude-code is in the map (→ HOST-REASON);
 * codex is not (→ TOP-REASON via the top-level handler). Like the sibling
 * statusline/telemetry runtime tests, the live handlers come from a fixture .mjs
 * importing defineConnector from the BUILT dist entry; the filesystem is isolated
 * to fresh temp HOME + data dirs, restored in afterEach.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConnectorFromPath, registerConnector } from "../../src/core/load-connector.js";
import { runHook } from "../../src/runtime/hook-entrypoint.js";
import claudeAdapter from "../../src/adapters/claude-code/index.js";
import codexAdapter from "../../src/adapters/codex/index.js";

const DIST_INDEX = join(__dirname, "..", "..", "dist", "index.js");
const CONNECTOR_ID = "hook-per-host";

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
 * Fixture: a PreToolUse hook whose TOP-LEVEL handler denies with "TOP-REASON"
 * and whose per-host claude-code handler denies with "HOST-REASON".
 */
function writeFixtureModule(dir: string): string {
  const modPath = join(dir, "per-host.config.mjs");
  const distUrl = pathToFileURL(DIST_INDEX).href;
  const source = `
import { defineConnector } from ${JSON.stringify(distUrl)};

export default defineConnector({
  id: ${JSON.stringify(CONNECTOR_ID)},
  hooks: {
    PreToolUse: {
      handler() {
        return { decision: "deny", reason: "TOP-REASON" };
      },
      hosts: {
        "claude-code": {
          handler() {
            return { decision: "deny", reason: "HOST-REASON" };
          },
        },
      },
    },
  },
});
`;
  writeFileSync(modPath, source, "utf8");
  return modPath;
}

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-hph-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-hph-data-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENT_CONNECTOR_DATA_DIR = tmpData;
  process.env.AGENT_CONNECTOR_TELEMETRY = "0"; // keep the test about dispatch, not telemetry
  delete process.env.AGENT_CONNECTOR_HOST;

  const modPath = writeFixtureModule(tmpData);
  const { connector } = await loadConnectorFromPath(modPath);
  registerConnector(connector, modPath);
});

afterEach(() => {
  vi.restoreAllMocks();
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

describe("runHook — per-host handler selection", () => {
  const stdin = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    session_id: "sess-1",
  });

  it("picks the per-host handler on the named host (claude-code)", async () => {
    const res = await runHook({
      platformId: "claude-code",
      event: "PreToolUse",
      connectorId: CONNECTOR_ID,
      stdin,
    });
    // The per-host handler ran: the deny reason is HOST-REASON, not TOP-REASON.
    expect(res.stdout ?? "").toContain("HOST-REASON");
    expect(res.stdout ?? "").not.toContain("TOP-REASON");
  });

  it("falls back to the top-level handler on a host NOT in the map (codex)", async () => {
    const res = await runHook({
      platformId: "codex",
      event: "PreToolUse",
      connectorId: CONNECTOR_ID,
      stdin,
    });
    // codex is not in the hosts: map → the top-level handler ran (TOP-REASON).
    expect(res.stdout ?? "").toContain("TOP-REASON");
    expect(res.stdout ?? "").not.toContain("HOST-REASON");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The deny-preserve ERROR path under per-host selection (security-critical).
// runHook resolves the per-host handler in failOpenOrPreserveDeny too, so a
// PreToolUse deny from a PER-HOST handler must survive a throw that happens
// AFTER the handler ran. We force that throw by making the adapter's formatReply
// throw on its FIRST call (the main path) — driving execution into the
// reconstruction path, which calls formatReply a SECOND time (real impl). The
// fixture is ASYMMETRIC (top-level ALLOWS, per-host claude-code DENIES) so the
// test fails if the two paths ever resolved DIFFERENT handlers: a divergence
// would either lose the per-host deny or fabricate a deny where the top-level
// allowed.
// ─────────────────────────────────────────────────────────────────────────

const ASYM_ID = "hook-per-host-asym";

describe("runHook — per-host deny-preserve on the error path", () => {
  const stdin = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    session_id: "sess-asym",
  });

  beforeEach(async () => {
    // Top-level ALLOWS (void); per-host claude-code DENIES "HOST-REASON".
    const modPath = join(tmpData, "asym.config.mjs");
    const distUrl = pathToFileURL(DIST_INDEX).href;
    writeFileSync(
      modPath,
      `
import { defineConnector } from ${JSON.stringify(distUrl)};
export default defineConnector({
  id: ${JSON.stringify(ASYM_ID)},
  hooks: {
    PreToolUse: {
      handler() { /* allow (void) */ },
      hosts: {
        "claude-code": {
          handler() { return { decision: "deny", reason: "HOST-REASON" }; },
        },
      },
    },
  },
});
`,
      "utf8",
    );
    const { connector } = await loadConnectorFromPath(modPath);
    registerConnector(connector, modPath);
  });

  it("preserves the PER-HOST deny on claude-code when a throw follows the handler", async () => {
    // Make the MAIN-path formatReply throw once; the reconstruction path then
    // calls the real formatReply and must surface the per-host deny.
    vi.spyOn(claudeAdapter, "formatReply").mockImplementationOnce(() => {
      throw new Error("boom after the per-host deny resolved");
    });

    const res = await runHook({
      platformId: "claude-code",
      event: "PreToolUse",
      connectorId: ASYM_ID,
      stdin,
    });

    // The reconstructed deny carries the PER-HOST reason (not the top-level
    // allow, not a fabricated deny) — proving both paths resolve the SAME handler.
    expect(res.stdout ?? "").toContain("HOST-REASON");
    expect(res.stdout ?? "").toContain("deny");
  });

  it("does NOT fabricate a deny on a host whose top-level handler allows (codex)", async () => {
    // Drive codex's OWN error path: its formatReply throws once on the main path,
    // so reconstruction runs — and since the top-level handler allows, the
    // deny-preserve carve-out returns plain ALLOW (formatReply is never reached
    // again, no deny is fabricated).
    vi.spyOn(codexAdapter, "formatReply").mockImplementationOnce(() => {
      throw new Error("boom (codex error path)");
    });

    const res = await runHook({
      platformId: "codex",
      event: "PreToolUse",
      connectorId: ASYM_ID,
      stdin,
    });

    // codex is not in the hosts: map → top-level ALLOWS → fail-open allow, with
    // no per-host deny leaking across hosts.
    expect(res.exitCode).toBe(0);
    expect(res.stdout ?? "").not.toContain("HOST-REASON");
  });
});
