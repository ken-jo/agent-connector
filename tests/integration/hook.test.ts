/**
 * integration/hook — end-to-end universal hook dispatch.
 *
 * Registers a connector whose live PreToolUse / SessionStart handlers come from a
 * fixture .mjs (importing defineConnector from the BUILT dist entry), then drives
 * the real {@link runHook} json-stdio entrypoint with Claude-Code-shaped stdin
 * payloads and asserts the host-native reply the adapter formats.
 *
 * runHook re-imports the registered module to recover live handlers, so the
 * fixture module (not an in-memory object) is what actually executes here — this
 * exercises the full register → load → parse → dispatch → format chain.
 *
 * Isolation: HOME + AGENTCONNECT_DATA_DIR point at fresh temp dirs and are
 * restored in afterEach; both temp trees are removed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConnectorFromPath, registerConnector } from "../../src/core/load-connector.js";
import { runHook } from "../../src/runtime/hook-entrypoint.js";

const DIST_INDEX = join(__dirname, "..", "..", "dist", "index.js");
const CONNECTOR_ID = "guard-db";

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENTCONNECT_DATA_DIR,
  TELEMETRY: process.env.AGENTCONNECT_TELEMETRY,
};

let tmpHome: string;
let tmpData: string;

/**
 * Fixture connector: a PreToolUse matcher "danger" that DENIES, plus a
 * SessionStart that injects context. Handlers must live in a real module because
 * runHook re-imports it (functions cannot survive the JSON registry record).
 */
function writeFixtureModule(dir: string): string {
  const modPath = join(dir, "guard.config.mjs");
  const distUrl = pathToFileURL(DIST_INDEX).href;
  const source = `
import { defineConnector } from ${JSON.stringify(distUrl)};

export default defineConnector({
  id: ${JSON.stringify(CONNECTOR_ID)},
  hooks: {
    PreToolUse: {
      matcher: "danger",
      handler(evt) {
        if (evt.toolName === "danger") {
          return { decision: "deny", reason: "danger blocked by hook" };
        }
        return { decision: "allow" };
      },
    },
    SessionStart: {
      handler() {
        return { decision: "context", additionalContext: "guard online" };
      },
    },
  },
});
`;
  writeFileSync(modPath, source, "utf8");
  return modPath;
}

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-hook-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-hook-data-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENTCONNECT_DATA_DIR = tmpData;
  delete process.env.AGENTCONNECT_TELEMETRY;

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

describe("runHook PreToolUse (claude-code)", () => {
  it("DENIES a matched dangerous tool with a host-native deny payload", async () => {
    const stdin = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "danger",
      tool_input: { cmd: "rm -rf /" },
      session_id: "sess-1",
      cwd: "/home/dev/acme",
    });

    const res = await runHook({
      platformId: "claude-code",
      event: "PreToolUse",
      connectorId: CONNECTOR_ID,
      stdin,
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBeDefined();
    const payload = JSON.parse(res.stdout!);
    expect(payload.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(payload.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(payload.hookSpecificOutput.permissionDecisionReason).toContain(
      "danger",
    );
  });

  it("ALLOWS (passthrough) a tool that does not match the danger matcher", async () => {
    const stdin = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "safe",
      tool_input: {},
      session_id: "sess-1",
    });

    const res = await runHook({
      platformId: "claude-code",
      event: "PreToolUse",
      connectorId: CONNECTOR_ID,
      stdin,
    });

    // Non-matching tool → the hook is not interested → plain allow (exit 0,
    // no native control payload on stdout).
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBeUndefined();
  });
});

describe("runHook SessionStart (claude-code)", () => {
  it("injects additionalContext from the handler", async () => {
    const stdin = JSON.stringify({
      hook_event_name: "SessionStart",
      source: "startup",
      session_id: "sess-1",
      cwd: "/home/dev/acme",
    });

    const res = await runHook({
      platformId: "claude-code",
      event: "SessionStart",
      connectorId: CONNECTOR_ID,
      stdin,
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBeDefined();
    const payload = JSON.parse(res.stdout!);
    expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(payload.hookSpecificOutput.additionalContext).toBe("guard online");
  });
});

describe("runHook fail-open behavior", () => {
  it("allows when the connector id is not registered (never wedges a tool call)", async () => {
    const res = await runHook({
      platformId: "claude-code",
      event: "PreToolUse",
      connectorId: "not-registered",
      stdin: JSON.stringify({ tool_name: "danger", tool_input: {} }),
    });
    // loadRegisteredConnector throws → fail-open path. The handler that would
    // have denied is not reachable (no record), so this resolves to allow.
    expect(res.exitCode).toBe(0);
  });

  it("tolerates empty stdin (no payload) and allows", async () => {
    const res = await runHook({
      platformId: "claude-code",
      event: "PreToolUse",
      connectorId: CONNECTOR_ID,
      stdin: "",
    });
    // toolName parses to "" → does not match "danger" → allow.
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBeUndefined();
  });
});

describe("runHook PreToolUse (codex) deny is preserved", () => {
  it("denies a matched dangerous tool on codex too", async () => {
    const stdin = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "danger",
      tool_input: { cmd: "rm -rf /" },
      session_id: "sess-1",
    });

    const res = await runHook({
      platformId: "codex",
      event: "PreToolUse",
      connectorId: CONNECTOR_ID,
      stdin,
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBeDefined();
    const payload = JSON.parse(res.stdout!);
    expect(payload.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
