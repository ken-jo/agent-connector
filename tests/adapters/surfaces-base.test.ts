/**
 * adapters/surfaces-base — BaseAdapter default content-surface handling.
 *
 * An adapter that does NOT support content surfaces (e.g. warp, which leaves the
 * supports* capability flags undefined and never overrides the install* methods)
 * inherits BaseAdapter's defaults: a single "warn" ChangeRecord when the
 * connector declares that surface, or a single "skip" when it declares none.
 * This mirrors the mcp-only hook handling and must NEVER throw or write files.
 */

import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import warpAdapter from "../../src/adapters/warp/index.js";

function buildCtx(connector: ResolvedConnector): InstallContext {
  const projectDir = mkdtempSync(join(tmpdir(), "ac-surfaces-base-"));
  return {
    connector,
    scope: "project",
    projectDir,
    homeBinPath: "/fake/.agent-connector/bin/agent-connector",
    dataRoot: join(projectDir, ".agent-connector"),
    dryRun: false,
  };
}

describe("BaseAdapter — unsupported content surfaces (warp)", () => {
  it("declares skills (Agent Skills) but NOT commands or subagents", () => {
    // Warp ships Agent Skills (.agents/skills); commands + subagents remain
    // unsupported, so they exercise BaseAdapter's warn/skip fallback below.
    expect(warpAdapter.capabilities.supportsSkills ?? false).toBe(true);
    expect(warpAdapter.capabilities.supportsCommands ?? false).toBe(false);
    expect(warpAdapter.capabilities.supportsSubagents ?? false).toBe(false);
  });

  it("warns (and skips) when a connector declares commands it cannot honor", () => {
    const connector = defineConnector({
      id: "acme-cmd",
      commands: [
        { name: "deploy", prompt: "Deploy it." },
        { name: "rollback", prompt: "Roll it back." },
      ],
    });
    const ctx = buildCtx(connector);

    const changes = warpAdapter.installCommands!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("warn");
    expect(changes[0]?.detail).toContain("commands not supported on warp");
    expect(changes[0]?.detail).toContain("2 skipped");

    // No command file was written.
    expect(existsSync(join(ctx.projectDir, ".warp", "commands"))).toBe(false);
    expect(existsSync(join(ctx.projectDir, ".claude", "commands"))).toBe(false);
  });

  it("skips (no warn) when the connector declares NO commands", () => {
    const connector = defineConnector({
      id: "acme-nocmd",
      server: { transport: "stdio", command: "node" },
    });
    const ctx = buildCtx(connector);

    const changes = warpAdapter.installCommands!(ctx);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe("skip");
    expect(changes[0]?.detail).toContain("declares no commands");
  });

  it("warns for subagents the same way (install and uninstall)", () => {
    // skills are now supported on warp; subagents remain the unsupported
    // content surface that exercises BaseAdapter's warn path.
    const connector = defineConnector({
      id: "acme-rich",
      subagents: [{ name: "a", description: "d", prompt: "p" }],
    });
    const ctx = buildCtx(connector);

    for (const fn of [
      warpAdapter.installSubagents!,
      warpAdapter.uninstallSubagents!,
    ]) {
      const changes = fn.call(warpAdapter, ctx);
      expect(changes[0]?.action).toBe("warn");
      expect(changes[0]?.detail).toContain("subagents not supported on warp");
    }
  });
});
