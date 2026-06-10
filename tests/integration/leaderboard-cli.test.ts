/**
 * integration/leaderboard-cli — the leaderboard commands over the BUILT CLI.
 *
 * Spawns `node dist/cli.js …` in a throwaway empty HOME (+ a separate empty
 * data-root) so there is no telemetry.ndjson and no host session logs to read,
 * then asserts the local-first empty-state contract:
 *   • `leaderboard --json`      → exits 0, prints `{ mcp: [], host: [] }`
 *                                 (plus an honest hostSkipped note), never crashes.
 *   • `telemetry leaderboard`   → exits 0, prints the empty MCP table.
 *   • `usage leaderboard`       → exits 0, prints the empty host table.
 *
 * The dist build is a committed prerequisite for the integration suite (see
 * install-roundtrip.test.ts); this file runs the same built artifact the user
 * would invoke. Network is never touched — every reader is local-first and the
 * synced cloud readers degrade to skip notes with no records.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIST_CLI = join(__dirname, "..", "..", "dist", "cli.js");

let tmpHome: string;
let tmpData: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ac-lb-cli-home-"));
  tmpData = mkdtempSync(join(tmpdir(), "ac-lb-cli-data-"));
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

/** Run the built CLI in the isolated empty HOME; returns { code, stdout }. */
function runCli(args: string[]): { code: number; stdout: string } {
  // Empty XDG dirs too so no host reader resolves a path outside the temp HOME.
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.HOME = tmpHome;
  env.USERPROFILE = tmpHome;
  env.AGENTCONNECT_DATA_DIR = tmpData;
  env.XDG_DATA_HOME = join(tmpHome, ".local", "share");
  env.XDG_CONFIG_HOME = join(tmpHome, ".config");
  delete env.AGENTCONNECT_TELEMETRY;
  try {
    const stdout = execFileSync(process.execPath, [DIST_CLI, ...args], {
      env,
      encoding: "utf8",
    });
    return { code: 0, stdout };
  } catch (err) {
    // execFileSync throws on a non-zero exit; surface the captured pieces.
    const e = err as { status?: number; stdout?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "" };
  }
}

describe("leaderboard CLI in an empty HOME (built dist/cli.js)", () => {
  it("`leaderboard --json` exits 0 with { mcp: [], host: [] } and does not crash", () => {
    const { code, stdout } = runCli(["leaderboard", "--json"]);
    expect(code).toBe(0);

    const parsed = JSON.parse(stdout) as {
      mcp: unknown[];
      host: unknown[];
      hostSkipped?: unknown[];
    };
    // The two leaderboards are SEPARATE arrays (never summed) and both empty.
    expect(parsed.mcp).toEqual([]);
    expect(parsed.host).toEqual([]);
    // hostSkipped is an honesty channel (synced platforms requiring sync); it is
    // an array and never inflates either leaderboard.
    expect(Array.isArray(parsed.hostSkipped)).toBe(true);
  });

  it("`telemetry leaderboard` exits 0 and prints the empty MCP table", () => {
    const { code, stdout } = runCli(["telemetry", "leaderboard"]);
    expect(code).toBe(0);
    expect(stdout).toContain("CONNECTOR");
    expect(stdout).toContain("(no MCP telemetry recorded)");
  });

  it("`usage leaderboard` exits 0 and prints the empty host table", () => {
    const { code, stdout } = runCli(["usage", "leaderboard"]);
    expect(code).toBe(0);
    expect(stdout).toContain("PLATFORM");
    expect(stdout).toContain("(no host usage found)");
  });

  it("`telemetry leaderboard --by surface` exits 0 and prints the empty surface table", () => {
    const { code, stdout } = runCli(["telemetry", "leaderboard", "--by", "surface"]);
    expect(code).toBe(0);
    expect(stdout).toContain("SURFACE");
    expect(stdout).toContain("KIND");
    expect(stdout).toContain("(no developer surfaces recorded)");
  });

  it("the unified `leaderboard` (table form) prints BOTH sections and the never-summed note", () => {
    const { code, stdout } = runCli(["leaderboard"]);
    expect(code).toBe(0);
    expect(stdout).toContain("MCP / Plugin leaderboard");
    expect(stdout).toContain("Host / User leaderboard");
    expect(stdout).toContain("never summed");
  });
});
