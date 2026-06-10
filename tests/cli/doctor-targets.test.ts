/**
 * tests/cli/doctor-targets — doctor respects connector-declared targets.
 *
 * Both bugs were found by dogfooding the context-mode migration:
 *  1. doctor checked EVERY detected host even when the connector declared an
 *     explicit `targets` list, red-flagging hosts the connector never targeted
 *     (install resolves flag → connector.targets → auto-detect; doctor must
 *     follow the same chain).
 *  2. The cursor adapter's health checks asserted hooks.json presence even for
 *     a hookless connector, which never writes one — absence is healthy.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  tmp = mkdtempSync(join(tmpdir(), "ac-doctor-targets-"));
  savedHome = process.env.HOME;
  savedData = process.env.AGENT_CONNECTOR_DATA_DIR;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.AGENT_CONNECTOR_DATA_DIR = join(tmp, ".agent-connector");
  // Two detectable hosts: claude-code (~/.claude) and cursor (~/.cursor).
  mkdirSync(join(tmp, ".claude"), { recursive: true });
  writeFileSync(join(tmp, ".claude", "settings.json"), "{}", "utf8");
  mkdirSync(join(tmp, ".cursor"), { recursive: true });
  writeFileSync(join(tmp, ".cursor", "mcp.json"), "{}", "utf8");
});
afterEach(() => {
  process.env.HOME = savedHome;
  process.env.USERPROFILE = savedHome;
  process.env.AGENT_CONNECTOR_DATA_DIR = savedData;
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

function writeConnector(targets: string[] | undefined): string {
  const p = join(tmp, "connector.json");
  const config: Record<string, unknown> = {
    id: "t-scope",
    version: "1.0.0",
    server: { transport: "stdio", command: "node" },
  };
  if (targets) config.targets = targets;
  writeFileSync(p, JSON.stringify(config), "utf8");
  return p;
}

describe("doctor scopes to connector.targets", () => {
  it("checks only the targeted host when the connector declares targets", async () => {
    const cfg = writeConnector(["claude-code"]);
    const cap = captureStdout();
    await main(["doctor", "--connector", cfg, "--project", tmp]);
    cap.restore();
    const out = cap.text();
    expect(out).toContain("claude-code:");
    // cursor IS detected in this sandbox but is NOT targeted — must not appear.
    expect(out).not.toContain("cursor:");
  });

  it("an explicit --targets flag still overrides the connector list", async () => {
    const cfg = writeConnector(["claude-code"]);
    const cap = captureStdout();
    await main(["doctor", "--connector", cfg, "--project", tmp, "--targets", "cursor"]);
    cap.restore();
    expect(cap.text()).toContain("cursor:");
    expect(cap.text()).not.toContain("claude-code:");
  });

  it("targets:auto (default) keeps checking every detected host", async () => {
    const cfg = writeConnector(undefined);
    const cap = captureStdout();
    await main(["doctor", "--connector", cfg, "--project", tmp]);
    cap.restore();
    expect(cap.text()).toContain("claude-code:");
    expect(cap.text()).toContain("cursor:");
  });
});

describe("cursor health checks for a hookless connector", () => {
  it("passes (exit 0) without hooks.json when the connector declares no hooks", async () => {
    const cfg = writeConnector(["cursor"]);
    const cap = captureStdout();
    const code = await main(["doctor", "--connector", cfg, "--project", tmp]);
    cap.restore();
    const out = cap.text();
    expect(out).toContain("no hooks declared");
    expect(out).not.toContain("[FAIL]");
    expect(code).toBe(0);
  });
});
