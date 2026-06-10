/**
 * tests/core/spawn-windows — the native-Windows spawn/ownership fixes, exercised
 * on any platform via injected deps (so the win32 branch is covered on CI/Linux).
 *
 * Two fixes:
 *  • resolveSpawnCommand — resolve a bare package runner (npx/uvx) against
 *    PATH × PATHEXT and flag whether a shell is required (.cmd/.bat vs .exe).
 *  • isHomeBinHookCommand / isUsageEventCommand — ownership detection must hold
 *    when the stored command is forward-slashed (quoteArg) but homeBinPath() is
 *    backslashed (Windows node:path), which previously always returned false.
 */

import { describe, expect, it } from "vitest";

import {
  buildHomeBinHookCommand,
  buildUsageEventCommand,
  isHomeBinHookCommand,
  isUsageEventCommand,
  resolveSpawnCommand,
} from "../../src/core/spawn.js";

describe("resolveSpawnCommand", () => {
  it("is a no-op on POSIX (command unchanged, no shell)", () => {
    expect(resolveSpawnCommand("npx", { platform: "linux" })).toEqual({
      file: "npx",
      needsShell: false,
    });
    expect(resolveSpawnCommand("/usr/bin/node", { platform: "darwin" })).toEqual({
      file: "/usr/bin/node",
      needsShell: false,
    });
  });

  it("win32: resolves a bare npx to npx.cmd on PATH and REQUIRES a shell", () => {
    const r = resolveSpawnCommand("npx", {
      platform: "win32",
      pathEnv: "C:\\nodejs;C:\\other",
      pathExt: ".EXE;.CMD",
      exists: (p) => p.toLowerCase().endsWith("npx.cmd"),
    });
    expect(r.needsShell).toBe(true);
    expect(r.file.toLowerCase()).toContain("npx.cmd");
  });

  it("win32: resolves a bare uvx to uvx.exe and does NOT need a shell", () => {
    const r = resolveSpawnCommand("uvx", {
      platform: "win32",
      pathEnv: "C:\\python",
      pathExt: ".EXE;.CMD",
      exists: (p) => p.toLowerCase().endsWith("uvx.exe"),
    });
    expect(r.needsShell).toBe(false);
    expect(r.file.toLowerCase()).toContain("uvx.exe");
  });

  it("win32: a command that already has a separator or extension is not searched", () => {
    expect(resolveSpawnCommand("C:\\tools\\run.cmd", { platform: "win32" })).toEqual({
      file: "C:\\tools\\run.cmd",
      needsShell: true,
    });
    expect(resolveSpawnCommand("node.exe", { platform: "win32" })).toEqual({
      file: "node.exe",
      needsShell: false,
    });
  });

  it("win32: a bare name missing from PATH falls back to bare + shell (cmd.exe resolves it)", () => {
    const r = resolveSpawnCommand("npx", {
      platform: "win32",
      pathEnv: "C:\\empty",
      pathExt: ".CMD",
      exists: () => false,
    });
    expect(r).toEqual({ file: "npx", needsShell: true });
  });
});

describe("isHomeBinHookCommand — Windows separator mismatch", () => {
  // homeBinPath() on win32 = native backslashes; the stored command is
  // forward-slashed by quoteArg().
  const winHomeBin = "C:\\Users\\me\\.agentconnect\\bin\\agentconnect.cmd";
  const stored = buildHomeBinHookCommand(winHomeBin, "claude-code", "SessionStart", "acme-db");

  it("the stored command is forward-slashed (quoteArg normalization)", () => {
    expect(stored).toContain("C:/Users/me/.agentconnect/bin/agentconnect.cmd");
    expect(stored).not.toContain("\\");
  });

  it("detects ownership despite the backslash/forward-slash mismatch", () => {
    expect(isHomeBinHookCommand(stored, winHomeBin, "acme-db")).toBe(true);
  });

  it("still anchors the id token (a shared-prefix id does NOT match)", () => {
    expect(isHomeBinHookCommand(stored, winHomeBin, "acme")).toBe(false);
  });

  it("POSIX path is unaffected", () => {
    const posixHome = "/home/me/.agentconnect/bin/agentconnect";
    const c = buildHomeBinHookCommand(posixHome, "claude-code", "Stop", "acme-db");
    expect(isHomeBinHookCommand(c, posixHome, "acme-db")).toBe(true);
    expect(isHomeBinHookCommand(c, posixHome, "acme")).toBe(false);
  });

  it("isUsageEventCommand also tolerates the Windows mismatch", () => {
    const u = buildUsageEventCommand(winHomeBin, "gemini-cli", "acme-db");
    expect(isUsageEventCommand(u, winHomeBin, "acme-db")).toBe(true);
    // a plain hook command is not a usage-event command
    expect(isUsageEventCommand(stored, winHomeBin, "acme-db")).toBe(false);
  });
});
