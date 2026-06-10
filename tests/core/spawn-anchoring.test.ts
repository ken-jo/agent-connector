import { describe, expect, it } from "vitest";

import {
  buildHomeBinHookCommand,
  isHomeBinHookCommand,
  shouldWrapForTelemetry,
} from "../../src/core/spawn.js";
import type { ServerDef } from "../../src/core/types.js";

const HOME_BIN = "/home/u/.agent-connector/bin/agent-connector";

describe("isHomeBinHookCommand — anchored connector-id match", () => {
  const cmd = buildHomeBinHookCommand(HOME_BIN, "claude-code", "PreToolUse", "acme-db");

  it("matches the exact connector id", () => {
    expect(isHomeBinHookCommand(cmd, HOME_BIN, "acme-db")).toBe(true);
  });

  it("does NOT match a shared-prefix id (the regression: acme vs acme-db)", () => {
    // This is the high-severity bug: a substring check would return true here
    // and strip acme-db's hooks when uninstalling acme.
    expect(isHomeBinHookCommand(cmd, HOME_BIN, "acme")).toBe(false);
  });

  it("does NOT match a longer id that extends ours", () => {
    expect(isHomeBinHookCommand(cmd, HOME_BIN, "acme-db-extra")).toBe(false);
  });

  it("anchors on a closing double-quote (JSON-embedded command)", () => {
    const jsonEmbedded = `${buildHomeBinHookCommand(HOME_BIN, "cursor", "PreToolUse", "acme")}"`;
    expect(isHomeBinHookCommand(jsonEmbedded, HOME_BIN, "acme")).toBe(true);
    expect(isHomeBinHookCommand(jsonEmbedded, HOME_BIN, "acm")).toBe(false);
  });

  it("requires the home binary path to be present", () => {
    const other = buildHomeBinHookCommand("/other/bin/agent-connector", "claude-code", "Stop", "acme-db");
    expect(isHomeBinHookCommand(other, HOME_BIN, "acme-db")).toBe(false);
  });

  it("returns false for undefined/empty commands", () => {
    expect(isHomeBinHookCommand(undefined, HOME_BIN, "acme-db")).toBe(false);
    expect(isHomeBinHookCommand("", HOME_BIN, "acme-db")).toBe(false);
  });
});

describe("shouldWrapForTelemetry — unified default across adapters", () => {
  const base: ServerDef = { transport: "stdio", command: "npx", args: ["-y", "x"] };

  it("wraps an stdio server by default (wrapForTelemetry undefined)", () => {
    expect(shouldWrapForTelemetry(base, { enabled: true })).toBe(true);
  });

  it("does not wrap when explicitly disabled", () => {
    expect(shouldWrapForTelemetry({ ...base, wrapForTelemetry: false }, { enabled: true })).toBe(false);
  });

  it("does not wrap when telemetry is disabled", () => {
    expect(shouldWrapForTelemetry(base, { enabled: false })).toBe(false);
  });

  it("does not wrap a non-stdio (remote) server", () => {
    expect(shouldWrapForTelemetry({ transport: "http", url: "https://x" }, { enabled: true })).toBe(false);
  });

  it("does not wrap when there is no command", () => {
    expect(shouldWrapForTelemetry({ transport: "stdio", command: "" }, { enabled: true })).toBe(false);
  });
});
