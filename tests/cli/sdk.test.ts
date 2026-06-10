/**
 * tests/cli/sdk — the embedded SDK CLI (createConnectorCli) + programName brand.
 *
 * createConnectorCli must be PURE argument transformation over {@link main}: it
 * injects the developer's connector when the user did not, and otherwise hands
 * off verbatim. We assert that contract by spawning the BRANDED bin in an
 * isolated tmp HOME + data-root and reading stdout/stderr/exit-code:
 *
 *   • `acme install --dry-run` targets the dev connector WITHOUT the user passing
 *     --connector (the dry-run plan names the connector id from the injected
 *     config path);
 *   • `acme leaderboard` / `acme telemetry leaderboard` scope to the dev
 *     connector id (the seeded OTHER-connector rows are excluded);
 *   • an explicit user `--connector <other>` OVERRIDES the injection;
 *   • `acme --help` brands the usage string with the program name.
 *
 * A tiny driver script (driver.mjs) builds the CLI from a generated connector
 * config and runs it with argv from the command line, so each case is a real
 * end-to-end invocation through createConnectorCli → main → the command module.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { newRecordId, openStore } from "../../src/telemetry/store.js";
import type { ToolEventRecord } from "../../src/telemetry/types.js";

let tmpHome: string;
let tmpData: string;
let connectorPath: string;
let otherConnectorPath: string;
let driverPath: string;

// The SDK is exercised through src (tsx), so the driver imports the source.
const SDK_SRC = join(__dirname, "..", "..", "src", "cli", "sdk.ts");
// On Windows the .bin shim is tsx.cmd, and a .cmd cannot be execFile'd without a
// shell — append the extension + run through a shell there. No-op on POSIX.
const TSX_BIN =
  join(__dirname, "..", "..", "node_modules", ".bin", "tsx") +
  (process.platform === "win32" ? ".cmd" : "");

/** A connector config module body for a given id (a server so install has work). */
function connectorModule(id: string): string {
  // Use a file:// URL: a raw absolute Windows path (C:\...) is not a valid ESM
  // import specifier (ERR_UNSUPPORTED_ESM_URL_SCHEME). No-op semantics on POSIX.
  return `import { defineConnector } from ${JSON.stringify(
    pathToFileURL(join(__dirname, "..", "..", "src", "index.ts")).href,
  )};
export default defineConnector({
  id: ${JSON.stringify(id)},
  displayName: ${JSON.stringify(id)},
  version: "1.0.0",
  server: { transport: "stdio", command: "node", args: ["server.mjs"] },
  commands: [{ name: "demo-cmd", description: "d", prompt: "p" }],
});
`;
}

/** The driver: build the branded CLI for the dev connector + run with cli argv. */
function driverModule(): string {
  return `import { createConnectorCli } from ${JSON.stringify(pathToFileURL(SDK_SRC).href)};
const cli = createConnectorCli({ name: "acme", connector: ${JSON.stringify(
    connectorPath,
  )} });
cli.run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
`;
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-sdk-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-sdk-data-"));
  connectorPath = join(tmpData, "agent-connector.config.mjs");
  otherConnectorPath = join(tmpData, "other.config.mjs");
  driverPath = join(tmpData, "driver.mjs");
  writeFileSync(connectorPath, connectorModule("acme-dev"), "utf8");
  writeFileSync(otherConnectorPath, connectorModule("other-conn"), "utf8");
  writeFileSync(driverPath, driverModule(), "utf8");
});

afterEach(() => {
  for (const d of [tmpHome, tmpData]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the driver through tsx with the given argv in the isolated environment. */
function runDriver(args: string[]): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.HOME = tmpHome;
  env.USERPROFILE = tmpHome;
  env.AGENT_CONNECTOR_DATA_DIR = tmpData;
  env.XDG_DATA_HOME = join(tmpHome, ".local", "share");
  env.XDG_CONFIG_HOME = join(tmpHome, ".config");
  delete env.AGENT_CONNECTOR_TELEMETRY;
  try {
    const stdout = execFileSync(TSX_BIN, [driverPath, ...args], {
      env,
      encoding: "utf8",
      // tsx.cmd on Windows needs a shell to launch (no-op on POSIX).
      shell: process.platform === "win32",
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** Build a ToolEventRecord with defaults overridable per field. */
function rec(over: Partial<ToolEventRecord> = {}): ToolEventRecord {
  return {
    id: over.id ?? newRecordId(0),
    ts: over.ts ?? 1_700_000_000_000,
    connectorId: over.connectorId ?? "acme-dev",
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

/** Seed the data-root telemetry store with rows for two connectors. */
function seedTwoConnectors(): void {
  const store = openStore({ path: join(tmpData, "telemetry.ndjson") });
  store.append(
    rec({ id: "d1", connectorId: "acme-dev", toolName: "acme_query", inputTokens: 100, outputTokens: 200 }),
  );
  store.append(
    rec({ id: "o1", connectorId: "other-conn", toolName: "other_query", inputTokens: 999, outputTokens: 999 }),
  );
  store.close();
}

describe("createConnectorCli auto-scopes to the developer connector", () => {
  it("injects --connector for `install --dry-run` (dev connector targeted, user passed none)", () => {
    const { code, stdout } = runDriver(["install", "--dry-run", "--targets", "claude-code"]);
    expect(code).toBe(0);
    // The dry-run header names the injected connector id from the config path.
    expect(stdout).toContain('install "acme-dev"');
    expect(stdout).toContain("dry-run");
  });

  it("an explicit user --connector OVERRIDES the injection", () => {
    const { code, stdout } = runDriver([
      "install",
      "--dry-run",
      "--targets",
      "claude-code",
      "--connector",
      otherConnectorPath,
    ]);
    expect(code).toBe(0);
    // The user-supplied connector wins — the OTHER connector id is planned.
    expect(stdout).toContain('install "other-conn"');
    expect(stdout).not.toContain('install "acme-dev"');
  });

  it("scopes `leaderboard` to the dev connector id (other-conn excluded from the MCP section)", () => {
    seedTwoConnectors();
    const { code, stdout } = runDriver(["leaderboard"]);
    expect(code).toBe(0);
    expect(stdout).toContain("connector: acme-dev");
    // The 🔌 MCP/plugin section is filtered to acme-dev — other-conn must not appear.
    expect(stdout).toContain("acme-dev");
    expect(stdout).not.toContain("other-conn");
    // The host-scan section stays connector-agnostic (note present).
    expect(stdout).toContain("connector-agnostic");
  });

  it("scopes `telemetry leaderboard` to the dev connector id (other-conn excluded)", () => {
    seedTwoConnectors();
    const { code, stdout } = runDriver(["telemetry", "leaderboard"]);
    expect(code).toBe(0);
    expect(stdout).toContain("acme-dev");
    expect(stdout).not.toContain("other-conn");
  });

  it("brands the top-level usage string with the program name", () => {
    const { code, stdout } = runDriver(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("acme — write your MCP server");
    expect(stdout).toContain("usage: acme <command>");
    // The default brand must NOT leak into the branded usage text.
    expect(stdout).not.toContain("agent-connector <command>");
  });

  it("a bare `telemetry` shows its help and does NOT mis-inject a filter (no unknown-sub error)", () => {
    const { code, stdout, stderr } = runDriver(["telemetry"]);
    // Bare telemetry prints its sub-help and exits 1 (no sub) — the SDK must NOT
    // have turned `telemetry` into `telemetry --connector <id>`, which the
    // dispatcher would reject as an unknown subcommand.
    expect(stdout).toContain("usage:");
    expect(stdout).toContain("report");
    expect(stderr).not.toContain("unknown telemetry subcommand");
    expect(code).toBe(1);
  });
});
