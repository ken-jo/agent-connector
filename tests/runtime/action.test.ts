/**
 * runtime/action — the home-bin user-invokable action dispatcher.
 *
 * A future host affordance execs `<homeBin> action <platform> <actionId>
 * --connector <id>`, which the CLI hands to runAction. runAction loads the
 * registered connector (live run handler, re-imported from the source module —
 * functions can't survive the JSON registry record), builds the HostCtx (no
 * stdin), finds the action by id, resolves the per-host run, runs it, and prints
 * the optional result.message.
 *
 * USER-TRIGGERED is the contract (the difference from hooks/statusline): an
 * unknown action id or a throwing run SURFACES the failure (exit 1 + stderr),
 * never a silent fail-open/fail-safe.
 *
 * Like the statusline runtime test, the live handler comes from a fixture .mjs
 * importing defineConnector from the BUILT dist entry. Filesystem is isolated to
 * fresh temp HOME + data dirs, restored in afterEach.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConnectorFromPath, registerConnector } from "../../src/core/load-connector.js";
import { runAction } from "../../src/runtime/action-entrypoint.js";
import { newRecordId, openStore } from "../../src/telemetry/store.js";
import type { ToolEventRecord } from "../../src/telemetry/types.js";

const DIST_INDEX = join(__dirname, "..", "..", "dist", "index.js");
const CONN_ID = "act-rt";
const SCOPE_ID = "act-rt-scope";

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
  TELEMETRY: process.env.AGENT_CONNECTOR_TELEMETRY,
};

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
    sessionId: "s",
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

let tmpHome: string;
let tmpData: string;

/**
 * Register ONE fixture connector that declares every action this suite exercises:
 *   • say-hi      — returns { message } (the happy path)
 *   • do-quiet    — returns void (success, no output)
 *   • boom        — throws (the user-triggered error path)
 *   • caps        — reads ctx.host + ctx.capabilities (proves the ctx is built)
 *   • per-host    — top-level + a claude-code per-host run override
 * `actionsLiteral` is inlined verbatim into the module so the live `run`
 * handlers survive (re-imported from the source module at runtime).
 */
function writeActionsFixture(dir: string, id: string): string {
  const modPath = join(dir, `${id}.config.mjs`);
  const distUrl = pathToFileURL(DIST_INDEX).href;
  const source = `
import { defineConnector } from ${JSON.stringify(distUrl)};

export default defineConnector({
  id: ${JSON.stringify(id)},
  actions: [
    { id: "say-hi", run: () => ({ message: "hello from say-hi" }) },
    { id: "do-quiet", run: () => {} },
    { id: "boom", run: () => { throw new Error("kaboom"); } },
    { id: "caps", run: (ctx) => ({ message: \`host=\${ctx.host} sa=\${ctx.capabilities?.supportsActions === true}\` }) },
    {
      id: "usage",
      run: async (ctx) => {
        const u = await ctx.telemetry?.();
        return { message: \`in=\${u?.inputTokens} out=\${u?.outputTokens} total=\${u?.totalTokens} calls=\${u?.calls}\` };
      },
    },
    {
      id: "per-host",
      run: () => ({ message: "TOP-LEVEL" }),
      hosts: { "claude-code": { run: () => ({ message: "HOST-SPECIFIC" }) } },
    },
    {
      id: "per-host-fallback",
      run: () => ({ message: "TOP-FALLBACK" }),
      hosts: { "codex": { run: () => ({ message: "CODEX-ONLY" }) } },
    },
  ],
});
`;
  writeFileSync(modPath, source, "utf8");
  return modPath;
}

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-actrt-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-actrt-data-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.AGENT_CONNECTOR_DATA_DIR = tmpData;
  delete process.env.AGENT_CONNECTOR_TELEMETRY;

  const modPath = writeActionsFixture(tmpData, CONN_ID);
  const conn = (await loadConnectorFromPath(modPath)).connector;
  registerConnector(conn, modPath);

  // A second connector with a `scope` action, REGISTERED at scope "user" so the
  // runtime recovers it from the metadata and stamps it onto the ctx.
  const scopeModPath = join(tmpData, `${SCOPE_ID}.config.mjs`);
  const distUrl = pathToFileURL(DIST_INDEX).href;
  writeFileSync(
    scopeModPath,
    `
import { defineConnector } from ${JSON.stringify(distUrl)};
export default defineConnector({
  id: ${JSON.stringify(SCOPE_ID)},
  actions: [
    { id: "scope", run: (ctx) => ({ message: \`scope=\${ctx.scope}\` }) },
  ],
});
`,
    "utf8",
  );
  const scopeConn = (await loadConnectorFromPath(scopeModPath)).connector;
  registerConnector(scopeConn, scopeModPath, "user");
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

describe("runAction", () => {
  it("runs the handler and prints result.message (exit 0)", async () => {
    const res = await runAction({
      platformId: "claude-code",
      connectorId: CONN_ID,
      actionId: "say-hi",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("hello from say-hi");
    expect(res.stderr).toBeUndefined();
  });

  it("a void return → exit 0, no stdout", async () => {
    const res = await runAction({
      platformId: "claude-code",
      connectorId: CONN_ID,
      actionId: "do-quiet",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBeUndefined();
  });

  it("USER-TRIGGERED: an unknown action id → exit 1 + stderr (never silent)", async () => {
    const res = await runAction({
      platformId: "claude-code",
      connectorId: CONN_ID,
      actionId: "no-such-action",
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('no action "no-such-action"');
    expect(res.stderr).toContain(CONN_ID);
    expect(res.stdout).toBeUndefined();
  });

  it("USER-TRIGGERED: a throwing run → exit 1 + stderr 'failed:' (never silent)", async () => {
    const res = await runAction({
      platformId: "claude-code",
      connectorId: CONN_ID,
      actionId: "boom",
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('action "boom" failed:');
    expect(res.stderr).toContain("kaboom");
    expect(res.stdout).toBeUndefined();
  });

  it("USER-TRIGGERED: an unknown connector → exit 1 + stderr (never silent)", async () => {
    const res = await runAction({
      platformId: "claude-code",
      connectorId: "no-such-connector",
      actionId: "say-hi",
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toBeTruthy();
    expect(res.stdout).toBeUndefined();
  });

  it("builds the HostCtx (host + capabilities) for the run handler", async () => {
    const res = await runAction({
      platformId: "claude-code",
      connectorId: CONN_ID,
      actionId: "caps",
    });
    expect(res.exitCode).toBe(0);
    // claude-code is a registered host; supportsActions is OFF in v1.
    expect(res.stdout).toBe("host=claude-code sa=false");
  });

  it("populates ctx.scope from the registered metadata (install at scope 'user')", async () => {
    const res = await runAction({
      platformId: "claude-code",
      connectorId: SCOPE_ID,
      actionId: "scope",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("scope=user");
  });

  it("an unknown adapter still runs with a minimal ctx (host=unknown)", async () => {
    const res = await runAction({
      platformId: "not-a-real-host",
      connectorId: CONN_ID,
      actionId: "caps",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("host=unknown sa=false");
  });

  it("per-host run WINS over the top-level run on the named host", async () => {
    const res = await runAction({
      platformId: "claude-code",
      connectorId: CONN_ID,
      actionId: "per-host",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("HOST-SPECIFIC");
  });

  it("falls back to the top-level run on a host NOT in the hosts: map", async () => {
    // The map targets codex only; running on claude-code falls back to top-level.
    const res = await runAction({
      platformId: "claude-code",
      connectorId: CONN_ID,
      actionId: "per-host-fallback",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("TOP-FALLBACK");
  });
});

describe("runAction — ctx.telemetry accessor", () => {
  it("returns this connector's summed usage (seeded rows)", async () => {
    seedRow(CONN_ID, 10, 3, 0);
    seedRow(CONN_ID, 5, 2, 1);
    const res = await runAction({
      platformId: "claude-code",
      connectorId: CONN_ID,
      actionId: "usage",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("in=15 out=5 total=20 calls=2");
  });

  it("returns zeros under AGENT_CONNECTOR_TELEMETRY=0 (never throws)", async () => {
    seedRow(CONN_ID, 10, 3, 0); // written before the kill switch
    process.env.AGENT_CONNECTOR_TELEMETRY = "0";
    const res = await runAction({
      platformId: "claude-code",
      connectorId: CONN_ID,
      actionId: "usage",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("in=0 out=0 total=0 calls=0");
  });
});
