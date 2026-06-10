/**
 * tests/examples/branded-cli-smoke — the "full, runnable package" guarantee.
 *
 * The docs audit found examples/branded-cli failing at import time (its
 * agent-connector dependency 404'd) while the README called it runnable. This
 * smoke test EXECUTES the example the way a reader would — `node bin.mjs` —
 * against the repo build, in a sandboxed HOME so no real host config is
 * touched. It requires the workspaces install link (npm install at the root)
 * and a built dist/, both of which CI provides; locally, `npm install &&
 * npm run build` first.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BIN = join(__dirname, "..", "..", "examples", "branded-cli", "bin.mjs");
const LINK = join(__dirname, "..", "..", "node_modules", "agent-connector");
const DIST = join(__dirname, "..", "..", "dist", "cli", "sdk.js");

let sandbox: string;
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "ac-example-smoke-"));
  // A fake installed claude-code host so install --dry-run has a target.
  mkdirSync(join(sandbox, ".claude"), { recursive: true });
  writeFileSync(join(sandbox, ".claude", "settings.json"), "{}", "utf8");
});
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function runExample(args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: sandbox,
      USERPROFILE: sandbox,
      AGENT_CONNECTOR_DATA_DIR: join(sandbox, ".agent-connector"),
    },
  });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// The example resolves `agent-connector` via the workspaces link + built dist —
// skip (don't fail) when running in a tree that hasn't installed/built yet.
const ready = existsSync(LINK) && existsSync(DIST);
const maybeDescribe = ready ? describe : describe.skip;

maybeDescribe("examples/branded-cli is actually runnable", () => {
  it("`acme-db --help` runs, exits 0, and is fully branded", () => {
    const { code, stdout } = runExample(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("acme-db — write your MCP server");
    expect(stdout).not.toContain("agent-connector —");
  });

  it("`acme-db install --dry-run` auto-scopes to the shipped connector and plans cleanly", () => {
    const { code, stdout } = runExample([
      "install",
      "--dry-run",
      "--targets",
      "claude-code",
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("(dry-run — nothing written)");
    expect(stdout).toContain("acme-db"); // the dev connector, no --connector passed
  });
});
