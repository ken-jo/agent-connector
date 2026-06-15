/**
 * tests/sdk/helpers — the host-aware authoring helpers (toolName / style).
 *
 * Pure, offline, no filesystem: both helpers derive a host-correct value from
 * `ctx.host` alone. We assert the documented per-host behavior:
 *   • toolName prefixes `mcp__<id>__<tool>` on the PREFIXED_HOSTS (claude-code /
 *     codex …) and is bare on the others (warp / zed); a missing connectorId on
 *     a prefixing host falls back to bare (never a malformed `mcp__undefined__`).
 *   • style wraps text in an ANSI SGR escape on a CLI/TUI host and leaves it
 *     plain on an IDE-embedded host (and whenever no ansi code is given).
 */

import { describe, expect, it } from "vitest";

import { style, toolName } from "../../src/sdk/helpers.js";

describe("toolName", () => {
  it("prefixes mcp__<id>__<tool> on a prefixing host (claude-code)", () => {
    expect(toolName({ host: "claude-code", connectorId: "acme" }, "query")).toBe(
      "mcp__acme__query",
    );
  });

  it("prefixes on codex too (the Claude-family convention)", () => {
    expect(toolName({ host: "codex", connectorId: "acme" }, "query")).toBe(
      "mcp__acme__query",
    );
  });

  it("returns the bare name on a non-prefixing host (warp)", () => {
    expect(toolName({ host: "warp", connectorId: "acme" }, "query")).toBe("query");
  });

  it("returns the bare name on a non-prefixing host (zed)", () => {
    expect(toolName({ host: "zed", connectorId: "acme" }, "query")).toBe("query");
  });

  it("falls back to bare (no throw, no mcp__undefined__) when connectorId is absent on a prefixing host", () => {
    expect(toolName({ host: "claude-code" }, "query")).toBe("query");
  });

  it("prefixes for EVERY declared PREFIXED_HOST (table-driven)", () => {
    const prefixing = [
      "claude-code", "codex", "kimi", "cursor", "copilot-cli",
      "vscode-copilot", "jetbrains-copilot", "gemini-cli", "qwen-code",
    ] as const;
    for (const host of prefixing) {
      expect(toolName({ host, connectorId: "acme" }, "q")).toBe("mcp__acme__q");
    }
  });

  it("is bare for a representative set of NON-prefixing hosts", () => {
    const bare = ["warp", "zed", "opencode", "hermes", "droid", "amp", "goose"] as const;
    for (const host of bare) {
      expect(toolName({ host, connectorId: "acme" }, "q")).toBe("q");
    }
  });
});

describe("style", () => {
  it("wraps text in an ANSI escape on a CLI/TUI host (claude-code)", () => {
    expect(style({ host: "claude-code" }, "hi", { ansi: "1;32" })).toBe(
      "\x1b[1;32mhi\x1b[0m",
    );
  });

  it("leaves text plain on an IDE-embedded host (vscode-copilot)", () => {
    expect(style({ host: "vscode-copilot" }, "hi", { ansi: "1;32" })).toBe("hi");
  });

  it("leaves text plain when no ansi code is given (even on a CLI host)", () => {
    expect(style({ host: "claude-code" }, "hi", {})).toBe("hi");
  });

  it("wraps on EVERY declared ANSI_HOST and is plain on excluded IDE hosts (table-driven)", () => {
    const ansiHosts = [
      "claude-code", "codex", "gemini-cli", "qwen-code", "cursor",
      "copilot-cli", "opencode", "droid", "crush", "goose", "amp",
    ] as const;
    for (const host of ansiHosts) {
      expect(style({ host }, "x", { ansi: "1" })).toBe("\x1b[1mx\x1b[0m");
    }
    const ideHosts = ["vscode-copilot", "jetbrains-copilot", "zed", "warp"] as const;
    for (const host of ideHosts) {
      expect(style({ host }, "x", { ansi: "1" })).toBe("x");
    }
  });
});
