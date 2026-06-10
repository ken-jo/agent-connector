/**
 * tests/core/spawn-scope — the scope dimension at WRAP time.
 *
 * Two pieces of the capstone live in core/spawn:
 *   • buildServeWrapperCommand embeds the install scope as `--scope <user|project>`
 *     into the serve-wrapper argv (before the `--` separator) so every telemetry
 *     row written by the wrapped server carries it — and OMITS the flag entirely
 *     when no scope is supplied (backward-compatible: older configs read "unknown").
 *   • narrowInstallScope maps the framework's 5-value InstallScope down to the two
 *     telemetry buckets (only `project` stays project; everything else → user).
 *   • detectLaunchMethod classifies the real launcher into the launch-method slice:
 *     npx/bunx/uvx (package runners) → themselves; node/bun/deno → "node"; a remote
 *     server → "http"; anything else → "binary"; empty → "unknown".
 */

import { describe, expect, it } from "vitest";

import {
  buildServeWrapperCommand,
  detectLaunchMethod,
  narrowInstallScope,
} from "../../src/core/spawn.js";
import type { InstallScope } from "../../src/core/types.js";

const HOME_BIN = "/home/u/.agentconnect/bin/agentconnect";

// ─────────────────────────────────────────────────────────────────────────
// buildServeWrapperCommand — embedding --scope
// ─────────────────────────────────────────────────────────────────────────

describe("buildServeWrapperCommand embeds --scope", () => {
  it("emits `--scope user` for a user-scoped install, before the `--` separator", () => {
    const { command, args } = buildServeWrapperCommand(
      HOME_BIN,
      "acme-db",
      "npx",
      ["-y", "@acme/db-mcp"],
      "user",
    );
    expect(command).toBe(HOME_BIN);
    expect(args).toEqual([
      "serve",
      "--connector",
      "acme-db",
      "--scope",
      "user",
      "--",
      "npx",
      "-y",
      "@acme/db-mcp",
    ]);
    // --scope sits in the FLAG section (before --), never in the real command.
    const sep = args.indexOf("--");
    expect(args.indexOf("--scope")).toBeLessThan(sep);
    expect(args.slice(sep + 1)).toEqual(["npx", "-y", "@acme/db-mcp"]);
  });

  it("emits `--scope project` for a project-scoped install", () => {
    const { args } = buildServeWrapperCommand(HOME_BIN, "c1", "node", ["server.js"], "project");
    expect(args).toEqual([
      "serve",
      "--connector",
      "c1",
      "--scope",
      "project",
      "--",
      "node",
      "server.js",
    ]);
  });

  it("narrows non-project framework scopes down to `user` in the embedded flag", () => {
    for (const scope of ["system", "user", "profile", "managed"] as InstallScope[]) {
      const { args } = buildServeWrapperCommand(HOME_BIN, "c1", "srv", [], scope);
      const i = args.indexOf("--scope");
      expect(args[i + 1]).toBe("user");
    }
    const proj = buildServeWrapperCommand(HOME_BIN, "c1", "srv", [], "project");
    const pi = proj.args.indexOf("--scope");
    expect(proj.args[pi + 1]).toBe("project");
  });

  it("OMITS --scope entirely when no scope is supplied (backward-compatible)", () => {
    const { args } = buildServeWrapperCommand(HOME_BIN, "acme-db", "npx", ["-y", "@acme/db-mcp"]);
    expect(args).not.toContain("--scope");
    expect(args).toEqual([
      "serve",
      "--connector",
      "acme-db",
      "--",
      "npx",
      "-y",
      "@acme/db-mcp",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildServeWrapperCommand — embedding --host (install TARGET platform)
// ─────────────────────────────────────────────────────────────────────────

describe("buildServeWrapperCommand embeds --host", () => {
  it("emits `--host <platformId>` in the FLAG section, before the `--` separator", () => {
    const { args } = buildServeWrapperCommand(
      HOME_BIN,
      "acme-db",
      "npx",
      ["-y", "@acme/db-mcp"],
      "user",
      "opencode",
    );
    expect(args).toEqual([
      "serve",
      "--connector",
      "acme-db",
      "--scope",
      "user",
      "--host",
      "opencode",
      "--",
      "npx",
      "-y",
      "@acme/db-mcp",
    ]);
    const sep = args.indexOf("--");
    const hostIdx = args.indexOf("--host");
    expect(hostIdx).toBeGreaterThan(-1);
    expect(hostIdx).toBeLessThan(sep);
    // The value follows the flag and is itself before the separator.
    expect(args[hostIdx + 1]).toBe("opencode");
    expect(hostIdx + 1).toBeLessThan(sep);
    // The real command tail is untouched.
    expect(args.slice(sep + 1)).toEqual(["npx", "-y", "@acme/db-mcp"]);
  });

  it("emits `--host` even when no scope is supplied (scope omitted, host present)", () => {
    const { args } = buildServeWrapperCommand(
      HOME_BIN,
      "c1",
      "node",
      ["server.js"],
      undefined,
      "kilo-cli",
    );
    expect(args).not.toContain("--scope");
    expect(args).toEqual([
      "serve",
      "--connector",
      "c1",
      "--host",
      "kilo-cli",
      "--",
      "node",
      "server.js",
    ]);
  });

  it("OMITS --host entirely when no platformId is supplied (backward-compatible)", () => {
    const { args } = buildServeWrapperCommand(HOME_BIN, "c1", "srv", [], "user");
    expect(args).not.toContain("--host");
    expect(args).toEqual([
      "serve",
      "--connector",
      "c1",
      "--scope",
      "user",
      "--",
      "srv",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// narrowInstallScope
// ─────────────────────────────────────────────────────────────────────────

describe("narrowInstallScope", () => {
  it("keeps `project` and maps every other scope to `user`", () => {
    expect(narrowInstallScope("project")).toBe("project");
    expect(narrowInstallScope("user")).toBe("user");
    expect(narrowInstallScope("system")).toBe("user");
    expect(narrowInstallScope("profile")).toBe("user");
    expect(narrowInstallScope("managed")).toBe("user");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// detectLaunchMethod
// ─────────────────────────────────────────────────────────────────────────

describe("detectLaunchMethod maps the launcher to the launch-method slice", () => {
  it("maps the package runners npx / bunx / uvx to themselves", () => {
    expect(detectLaunchMethod("npx", ["-y", "@acme/db-mcp"])).toBe("npx");
    expect(detectLaunchMethod("bunx", ["@acme/db-mcp"])).toBe("bunx");
    expect(detectLaunchMethod("uvx", ["acme-mcp"])).toBe("uvx");
  });

  it("maps interpreters node / bun / deno to `node`", () => {
    expect(detectLaunchMethod("node", ["server.js"])).toBe("node");
    expect(detectLaunchMethod("bun", ["server.ts"])).toBe("node");
    expect(detectLaunchMethod("deno", ["run", "server.ts"])).toBe("node");
  });

  it("maps a resolved executable on PATH to `binary`", () => {
    expect(detectLaunchMethod("acme-mcp-server", [])).toBe("binary");
    expect(detectLaunchMethod("/usr/local/bin/acme-mcp", ["--stdio"])).toBe("binary");
  });

  it("forces `http` for a remote server (caller knows the transport)", () => {
    expect(detectLaunchMethod("anything", [], { isRemote: true })).toBe("http");
    // isRemote wins even over a package-runner-looking command.
    expect(detectLaunchMethod("npx", ["-y", "x"], { isRemote: true })).toBe("http");
  });

  it("reads an empty / whitespace command as `unknown`", () => {
    expect(detectLaunchMethod("", [])).toBe("unknown");
    expect(detectLaunchMethod("   ", [])).toBe("unknown");
  });

  it("strips directories and executable extensions before matching", () => {
    // Absolute POSIX path to npx.
    expect(detectLaunchMethod("/usr/bin/npx", ["x"])).toBe("npx");
    // Windows-style path with a .cmd shim (forward+back slashes, case-insensitive).
    expect(detectLaunchMethod("C:\\Program Files\\nodejs\\npx.cmd", ["x"])).toBe("npx");
    expect(detectLaunchMethod("C:/tools/node.exe", ["server.js"])).toBe("node");
    // A bare ".exe" binary that is not an interpreter/runner → binary.
    expect(detectLaunchMethod("acme-mcp.exe", [])).toBe("binary");
  });
});
