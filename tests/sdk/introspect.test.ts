/**
 * tests/sdk/introspect — host-capability introspection over the registry.
 *
 * Asserts the surface predicates resolve against REAL adapter capabilities:
 *   • capabilitiesOf — known host vs unknown id;
 *   • hostsSupporting — configPatch is v1 claude-code-only; statusline is claude-code + qwen-code + antigravity-cli;
 *     actions is the emitter set (droid + hermes + warp + the ts-plugin slash-command
 *     hosts nemoclaw/omp/openclaw); memory is broad (the AGENTS.md-first surface),
 *     and the result is sorted;
 *   • surfaceSupport — the convenience boolean, including the unknown-id case.
 */

import { describe, expect, it } from "vitest";

import {
  capabilitiesOf,
  hostCanFireEvent,
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
  it("statusline hosts are claude-code + qwen-code + antigravity-cli (sorted)", async () => {
    expect(await hostsSupporting("statusline")).toEqual([
      "antigravity-cli",
      "claude-code",
      "qwen-code",
    ]);
  });

  it("actions emitter hosts include the ts-plugin slash-command hosts (sorted)", async () => {
    expect(await hostsSupporting("actions")).toEqual([
      "droid",
      "hermes",
      "nemoclaw",
      "omp",
      "openclaw",
      "warp",
    ]);
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

  it("the coarse hooks predicate is true when ANY event can fire (host-level query)", async () => {
    // crush fires PreToolUse only → still a hook host at the coarse level.
    const crush = await capabilitiesOf("crush");
    expect(SURFACE_PREDICATES.hooks(crush!)).toBe(true);
    // an mcp-only host fires nothing → not a hook host.
    const warp = await capabilitiesOf("warp");
    expect(SURFACE_PREDICATES.hooks(warp!)).toBe(false);
  });
});

describe("hostCanFireEvent — the per-event source of truth", () => {
  it("PostCompact is honored on codex but not on crush", async () => {
    const codex = await capabilitiesOf("codex");
    const crush = await capabilitiesOf("crush");
    expect(hostCanFireEvent(codex!, "PostCompact")).toBe(true);
    expect(hostCanFireEvent(crush!, "PostCompact")).toBe(false);
  });

  it("crush fires PreToolUse but NOT Stop (the false-green pair)", async () => {
    const crush = await capabilitiesOf("crush");
    expect(hostCanFireEvent(crush!, "PreToolUse")).toBe(true);
    expect(hostCanFireEvent(crush!, "Stop")).toBe(false);
  });

  it("the coarse hooks predicate is the OR of hostCanFireEvent over the union", async () => {
    const events = [
      "SessionStart",
      "SessionEnd",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PreCompact",
      "Stop",
      "Notification",
      "PermissionRequest",
      "PostToolUseFailure",
      "SubagentStart",
      "SubagentStop",
      "PostCompact",
    ] as const;
    for (const host of ["claude-code", "crush", "codex", "warp"]) {
      const caps = await capabilitiesOf(host);
      const anyFire = events.some((e) => hostCanFireEvent(caps!, e));
      expect(SURFACE_PREDICATES.hooks(caps!), host).toBe(anyFire);
    }
  });
});
