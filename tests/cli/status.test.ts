/**
 * tests/cli/status — the light, always-exit-0 install-state summary.
 *
 * status is descriptive infra (no MCP standard governs it): it reports which
 * connectors are present on which hosts and NEVER gates (unlike doctor). We
 * assert it is advertised in usage, always exits 0, and emits a JSON array
 * under --json.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/app.js";

function captureStdout(): { restore: () => void; text: () => string } {
  let out = "";
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });
  return { restore: () => spy.mockRestore(), text: () => out };
}

let tmp: string;
let savedHome: string | undefined;
let savedData: string | undefined;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ac-status-"));
  savedHome = process.env.HOME;
  savedData = process.env.AGENT_CONNECTOR_DATA_DIR;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(tmp, ".agent-connector");
});
afterEach(() => {
  process.env.HOME = savedHome;
  process.env.USERPROFILE = savedHome;
  process.env.AGENT_CONNECTOR_DATA_DIR = savedData;
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe("status", () => {
  it("is advertised in the top-level usage", async () => {
    const cap = captureStdout();
    const code = await main(["--help"]);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.text()).toContain("status");
    expect(cap.text()).toContain("install-state summary");
  });

  it("always exits 0 and emits a JSON array under --json", async () => {
    const cap = captureStdout();
    const code = await main(["status", "--json", "--project", tmp]);
    cap.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.text());
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("exits 0 (descriptive, not a gate) even with an unresolvable --connector", async () => {
    const cap = captureStdout();
    const code = await main([
      "status",
      "--connector",
      join(tmp, "does-not-exist.config.mjs"),
      "--project",
      tmp,
    ]);
    cap.restore();
    expect(code).toBe(0);
  });
});
