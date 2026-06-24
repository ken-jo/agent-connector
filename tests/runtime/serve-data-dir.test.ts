/**
 * runtime/serve — the connector record resolves from `--data-dir`, env-free.
 *
 * THE BUG (codex-cli): codex strips the environment of MCP server children, so a
 * spawned `agent-connector serve` does NOT inherit AGENT_CONNECTOR_DATA_DIR. When
 * the connector record was written under an OVERRIDDEN data root, the env-stripped
 * child resolves the DEFAULT `~/.agent-connector`, fails to find the record, and
 * dies "Connector not registered". The fix bakes `--data-dir <root>` into the
 * serve-wrap (only for a non-default root) and runServe pins it onto
 * AGENT_CONNECTOR_DATA_DIR BEFORE anything resolves the data-root — so the whole
 * child (record lookup + telemetry store) uses the explicit root regardless of
 * what the host propagated.
 *
 * We register a REAL connector record under a temp data root, then SIMULATE the
 * env-stripping host by deleting AGENT_CONNECTOR_DATA_DIR before calling runServe.
 * The proxy/store/tokenizer are mocked so no child server is spawned, but
 * readRegisteredMeta runs for real against the temp root — the true oracle.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { RunServeProxyOptions } from "../../src/telemetry/proxy.js";

// No child server is spawned: capture what the proxy would receive.
const proxyMock = vi.fn(async (_opts: RunServeProxyOptions) => 0);
vi.mock("../../src/telemetry/proxy.js", () => ({
  runServeProxy: (opts: RunServeProxyOptions) => proxyMock(opts),
}));
// The store is inert here (no measurement happens in this test).
vi.mock("../../src/telemetry/store.js", () => ({
  openStore: () => ({ append() {}, query: () => [], rollup: () => [], close() {} }),
}));
vi.mock("../../src/telemetry/tokenizer.js", () => ({ getTokenizer: () => ({}) }));

import { loadConnectorFromPath, registerConnector } from "../../src/core/load-connector.js";
import { runServe } from "../../src/runtime/serve.js";

const DIST_INDEX = join(__dirname, "..", "..", "dist", "index.js");
const CONNECTOR_ID = "datadir-demo";

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATA_DIR: process.env.AGENT_CONNECTOR_DATA_DIR,
};

let tmpHome: string;
let overriddenRoot: string;
let fixtureModulePath: string;

/** A minimal telemetry-on connector whose record we register under the override. */
function writeFixtureModule(dir: string): string {
  const modPath = join(dir, "datadir.config.mjs");
  const distUrl = pathToFileURL(DIST_INDEX).href;
  writeFileSync(
    modPath,
    `
import { defineConnector } from ${JSON.stringify(distUrl)};
export default defineConnector({
  id: ${JSON.stringify(CONNECTOR_ID)},
  server: { transport: "stdio", command: "node", args: ["server.js"], tools: { include: ["*"] } },
  telemetry: { enabled: true },
});
`,
    "utf8",
  );
  return modPath;
}

beforeEach(async () => {
  // HOME is a CLEAN temp dir, so the default root (~/.agent-connector) is empty —
  // resolving the default would never find the connector. The record lives ONLY
  // under overriddenRoot, a SEPARATE temp dir.
  tmpHome = mkdtempSync(join(tmpdir(), "ac-sdd-home-"));
  overriddenRoot = mkdtempSync(join(tmpdir(), "ac-sdd-data-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  // Write the record under the OVERRIDDEN root (as `install --data-dir` would).
  process.env.AGENT_CONNECTOR_DATA_DIR = overriddenRoot;
  const modPath = writeFixtureModule(overriddenRoot);
  const { connector } = await loadConnectorFromPath(modPath);
  registerConnector(connector, modPath);
  fixtureModulePath = modPath;

  proxyMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const d of [tmpHome, overriddenRoot]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("runServe resolves the connector from --data-dir when the host strips the env", () => {
  it("FINDS the connector via dataDir even with AGENT_CONNECTOR_DATA_DIR unset (codex case)", async () => {
    // Simulate codex: the child inherits NO data-dir env.
    delete process.env.AGENT_CONNECTOR_DATA_DIR;
    expect(homedir()).toBe(tmpHome); // default root is the empty temp HOME

    const code = await runServe({
      connectorId: CONNECTOR_ID,
      serverCommand: "node",
      serverArgs: ["server.js"],
      hostPlatformOverride: "codex",
      dataDir: overriddenRoot,
    });

    // The proxy was reached (record found) → no "not registered" throw.
    expect(code).toBe(0);
    expect(proxyMock).toHaveBeenCalledTimes(1);
    expect(proxyMock.mock.calls.at(-1)![0]!.connectorId).toBe(CONNECTOR_ID);
    // runServe pinned the override onto the env so the WHOLE child (store too)
    // resolves the same root.
    expect(process.env.AGENT_CONNECTOR_DATA_DIR).toBe(overriddenRoot);
  });

  it("WITHOUT dataDir (the pre-fix behavior) the env-stripped child throws 'not registered'", async () => {
    // No env, no flag → resolves the empty default root → record is missing.
    delete process.env.AGENT_CONNECTOR_DATA_DIR;

    await expect(
      runServe({
        connectorId: CONNECTOR_ID,
        serverCommand: "node",
        serverArgs: ["server.js"],
        hostPlatformOverride: "codex",
      }),
    ).rejects.toThrow(/is not registered/);
    expect(proxyMock).not.toHaveBeenCalled();
  });

  it("uses registered metadata only, so a broken live config module cannot break MCP startup", async () => {
    // `serve` only needs telemetry/server metadata for the stdio proxy. It must
    // not re-import the live config module, because branded packages may resolve
    // a different @ken-jo/agent-connector copy than the home-bin runtime.
    writeFileSync(
      fixtureModulePath,
      `throw new Error("live config should not be imported during serve");\n`,
      "utf8",
    );

    delete process.env.AGENT_CONNECTOR_DATA_DIR;

    const code = await runServe({
      connectorId: CONNECTOR_ID,
      serverCommand: "node",
      serverArgs: ["server.js"],
      hostPlatformOverride: "codex",
      dataDir: overriddenRoot,
    });

    expect(code).toBe(0);
    expect(proxyMock).toHaveBeenCalledTimes(1);
    expect(proxyMock.mock.calls.at(-1)![0]!.modelFamilyHint).toBe("auto");
  });
});
