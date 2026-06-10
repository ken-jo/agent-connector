/**
 * Regression: uninstalling a connector whose id is a prefix of another's must
 * not strip the other connector's hooks (the HIGH-severity collision bug).
 */
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import claudeAdapter from "../../src/adapters/claude-code/index.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import { defineConnector } from "../../src/core/define-connector.js";

function ctxFor(id: string, projectDir: string): InstallContext {
  const connector = defineConnector({
    id,
    hooks: {
      PreToolUse: { handler: () => ({ decision: "allow" as const }) },
    },
  });
  return {
    connector,
    scope: "project",
    projectDir,
    homeBinPath: "/home/u/.agentconnect/bin/agentconnect",
    dataRoot: join(projectDir, ".data"),
    dryRun: false,
  };
}

describe("claude-code hook uninstall — shared-prefix connector ids", () => {
  it("uninstalling 'acme' leaves 'acme-db' hooks intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-collide-"));
    const acme = ctxFor("acme", dir);
    const acmedb = ctxFor("acme-db", dir);

    claudeAdapter.installHooks(acme);
    claudeAdapter.installHooks(acmedb);

    const settingsPath = claudeAdapter.getHookConfigPath(acmedb);
    // Both present before uninstall.
    let text = readFileSync(settingsPath, "utf8");
    expect(text).toContain("--connector acme-db");
    expect(text).toContain("--connector acme");

    // Remove only 'acme'.
    claudeAdapter.uninstallHooks(acme);

    text = readFileSync(settingsPath, "utf8");
    // acme-db must survive; the standalone 'acme' token must be gone.
    expect(text).toContain("--connector acme-db");
    expect(text).not.toContain('--connector acme"');

    // Doctor agrees: acme-db still registered, acme no longer.
    const acmedbHealthy = claudeAdapter
      .getHealthChecks!(acmedb)
      .find((c) => c.name.includes("hook command registered"))!
      .check();
    const acmeHealthy = claudeAdapter
      .getHealthChecks!(acme)
      .find((c) => c.name.includes("hook command registered"))!
      .check();
    expect(acmedbHealthy.status).toBe("OK");
    expect(acmeHealthy.status).toBe("FAIL");
  });
});
