/**
 * tests/sdk/introspect — host-capability introspection over the registry.
 *
 * Asserts the surface predicates resolve against REAL adapter capabilities:
 *   • capabilitiesOf — known host vs unknown id;
 *   • hostsSupporting — statusline / configPatch are v1 claude-code-only, memory
 *     is broad (the AGENTS.md-first surface), and the result is sorted;
 *   • surfaceSupport — the convenience boolean, including the unknown-id case.
 */

import { describe, expect, it } from "vitest";

import {
  capabilitiesOf,
  hostsSupporting,
  surfaceSupport,
  SURFACE_PREDICATES,
} from "../../src/sdk/introspect.js";

describe("capabilitiesOf", () => {
  it("returns the capabilities for a known host", async () => {
    const caps = await capabilitiesOf("claude-code");
    expect(caps).toBeDefined();
    expect(caps?.supportsStatusline).toBe(true);
    expect(caps?.supportsConfigPatch).toBe(true);
  });

  it("returns undefined for an unknown id", async () => {
    expect(await capabilitiesOf("nope")).toBeUndefined();
    expect(await capabilitiesOf("unknown")).toBeUndefined();
  });
});

describe("hostsSupporting", () => {
  it("statusline is v1 claude-code-only", async () => {
    expect(await hostsSupporting("statusline")).toEqual(["claude-code"]);
  });

  it("configPatch is v1 claude-code-only", async () => {
    expect(await hostsSupporting("configPatch")).toEqual(["claude-code"]);
  });

  it("memory is broad and includes the AGENTS.md-first json-stdio hosts", async () => {
    const hosts = await hostsSupporting("memory");
    for (const id of ["codex", "cursor", "opencode", "gemini-cli"]) {
      expect(hosts).toContain(id);
    }
  });

  it("returns a sorted id list (stable output)", async () => {
    const hosts = await hostsSupporting("memory");
    const sorted = [...hosts].sort();
    expect(hosts).toEqual(sorted);
  });

  it("server is supported by every host that registers a transport", async () => {
    const hosts = await hostsSupporting("server");
    expect(hosts).toContain("claude-code");
    expect(hosts.length).toBeGreaterThan(1);
  });
});

describe("surfaceSupport", () => {
  it("is true for a supported host/surface and false otherwise", async () => {
    expect(await surfaceSupport("claude-code", "statusline")).toBe(true);
    expect(await surfaceSupport("codex", "statusline")).toBe(false);
  });

  it("is false for an unknown host", async () => {
    expect(await surfaceSupport("nope", "memory")).toBe(false);
  });
});

describe("SURFACE_PREDICATES", () => {
  it("covers every surface name with a pure predicate", () => {
    const names = Object.keys(SURFACE_PREDICATES).sort();
    expect(names).toEqual(
      [
        "actions",
        "commands",
        "configPatch",
        "hooks",
        "memory",
        "nativeHooks",
        "server",
        "skills",
        "statusline",
        "subagents",
      ].sort(),
    );
  });
});
