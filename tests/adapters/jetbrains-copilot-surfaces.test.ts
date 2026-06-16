/**
 * adapters/jetbrains-copilot-surfaces — SessionEnd canonical + ErrorOccurred
 * nativeHooks + remote MCP transports.
 *
 * GitHub's Copilot hooks-reference documents SessionEnd (PascalCase) as a real
 * .github/hooks event and an errorOccurred / ErrorOccurred lifecycle event with
 * no canonical analog. AC previously wired neither. UserPromptSubmit is left
 * unwired on purpose (its blocking Output Contract is not byte-verifiable from
 * the JS-rendered docs). MCP is UI-managed (no file), so the transports list
 * only advertises what the IDE UI accepts (stdio + remote http/sse).
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import type { InstallContext } from "../../src/adapters/spi.js";
import type { ResolvedConnector } from "../../src/core/types.js";

import jetbrainsAdapter from "../../src/adapters/jetbrains-copilot/index.js";

const HOME_BIN = "/fake/stable/.agent-connector/bin/agent-connector";
const CONNECTOR_ID = "acme-jb";

function buildCtx(projectDir: string, connector: ResolvedConnector): InstallContext {
  return { connector, scope: "project", projectDir, homeBinPath: HOME_BIN, dataRoot: projectDir, dryRun: false };
}
function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "ac-jb-"));
}
function readHooks(ctx: InstallContext): Record<string, any[]> {
  const file = JSON.parse(readFileSync(jetbrainsAdapter.getHookConfigPath!(ctx), "utf8"));
  return (file.hooks ?? {}) as Record<string, any[]>;
}

/** Normalized SessionEnd hook + a jetbrains-native ErrorOccurred hook. */
function connector(): ResolvedConnector {
  return defineConnector({
    id: CONNECTOR_ID,
    displayName: "Acme JB",
    version: "1.0.0",
    hooks: { SessionEnd: { handler: () => ({ decision: "allow" }) } },
    platforms: {
      "jetbrains-copilot": { nativeHooks: { ErrorOccurred: { handler: () => ({}) } } },
    },
  });
}

describe("jetbrains-copilot adapter — SessionEnd + nativeHooks + transports", () => {
  it("capabilities: sessionEnd + supportsNativeHooks true; transports advertise remote http/sse", () => {
    expect(jetbrainsAdapter.capabilities.sessionEnd).toBe(true);
    expect(jetbrainsAdapter.capabilities.supportsNativeHooks).toBe(true);
    expect(jetbrainsAdapter.capabilities.transports).toEqual(["stdio", "http", "sse"]);
    // UserPromptSubmit deliberately deferred (blocking contract unverifiable).
    expect(jetbrainsAdapter.capabilities.userPromptSubmit).toBe(false);
  });

  it("installHooks wires SessionEnd (PascalCase) and files ErrorOccurred VERBATIM as native", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, connector());
    jetbrainsAdapter.installHooks(ctx);
    const hooks = readHooks(ctx);
    expect(hooks.SessionEnd[0].command).toContain("hook jetbrains-copilot SessionEnd");
    expect(hooks.ErrorOccurred[0].command).toContain("hook jetbrains-copilot ErrorOccurred");
    expect(hooks.ErrorOccurred[0].command).toContain(`--connector ${CONNECTOR_ID}`);
    expect(hooks.ErrorOccurred[0].type).toBe("command");
  });

  it("nativeHooks install even when normalized hooks are disabled (hooks:false sibling)", () => {
    const projectDir = freshProject();
    const c = defineConnector({
      id: CONNECTOR_ID,
      hooks: { SessionEnd: { handler: () => ({ decision: "allow" }) } },
      platforms: { "jetbrains-copilot": { hooks: false, nativeHooks: { ErrorOccurred: { handler: () => ({}) } } } },
    });
    const ctx = buildCtx(projectDir, c);
    jetbrainsAdapter.installHooks(ctx);
    const hooks = readHooks(ctx);
    expect(hooks.ErrorOccurred[0].command).toContain("hook jetbrains-copilot ErrorOccurred");
    expect(hooks.SessionEnd).toBeUndefined();
  });

  it("idempotent + uninstall strips our native entry, leaving a foreign hook intact", () => {
    const projectDir = freshProject();
    const ctx = buildCtx(projectDir, connector());
    jetbrainsAdapter.installHooks(ctx);
    expect(jetbrainsAdapter.installHooks(ctx).every((c) => c.action === "skip")).toBe(true);

    const path = jetbrainsAdapter.getHookConfigPath!(ctx);
    const file = JSON.parse(readFileSync(path, "utf8"));
    file.hooks.ErrorOccurred.push({ type: "command", command: "/usr/bin/other run" });
    writeFileSync(path, JSON.stringify(file));

    jetbrainsAdapter.uninstallHooks(ctx);
    const flat = JSON.stringify(readHooks(ctx));
    expect(flat).toContain("other run");
    expect(flat).not.toContain(HOME_BIN);
  });
});
