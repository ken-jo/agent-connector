/**
 * runtime/serve — hostPlatform stamping under a headless spawn (BUG B).
 *
 * Under a headless host spawn, runtime env markers are absent and
 * detectRuntimeHost() mis-attributes (opencode/kilo-cli/qwen → "claude-code",
 * openclaw/hermes → "unknown"). The fix bakes the install TARGET platform into
 * the serve-wrapper as `--host <platformId>`; runServe then stamps the proxy's
 * hostPlatform from that override (when it is a KNOWN registered platform id),
 * falling back to detection only when it is absent or unrecognized.
 *
 * We mock the proxy + connector loader + store/tokenizer so no child is spawned
 * and capture exactly the RunServeProxyOptions runServe assembles, asserting the
 * hostPlatform it would stamp on every telemetry row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunServeProxyOptions } from "../../src/telemetry/proxy.js";

// Capture what runServe hands the proxy (the source of truth for hostPlatform).
const proxyMock = vi.fn(async (_opts: RunServeProxyOptions) => 0);
vi.mock("../../src/telemetry/proxy.js", () => ({
  runServeProxy: (opts: RunServeProxyOptions) => proxyMock(opts),
}));

// A connector record runServe can resolve without touching disk.
vi.mock("../../src/core/load-connector.js", () => ({
  loadRegisteredConnector: async () => ({
    id: "demo",
    displayName: "Demo",
    version: "0.0.0",
    hooks: {},
    hookEvents: [],
    telemetry: { enabled: true, modelFamilyHint: "auto", measureToolDefs: true },
    commands: [],
    skills: [],
    subagents: [],
    platforms: {},
    targets: "auto",
  }),
}));

// Store + tokenizer are inert in this test (no measurement happens).
vi.mock("../../src/telemetry/store.js", () => ({
  openStore: () => ({
    append() {},
    query: () => [],
    rollup: () => [],
    close() {},
  }),
}));
vi.mock("../../src/telemetry/tokenizer.js", () => ({
  getTokenizer: () => ({}),
}));

// detectRuntimeHost is the FALLBACK path — force a known mis-attribution so the
// override-vs-detection distinction is observable.
const detectMock = vi.fn(() => ({ platform: "claude-code" as const }));
vi.mock("../../src/adapters/detect.js", () => ({
  detectRuntimeHost: () => detectMock(),
}));

import { runServe } from "../../src/runtime/serve.js";

function lastProxyOpts(): RunServeProxyOptions {
  return proxyMock.mock.calls.at(-1)![0]!;
}

beforeEach(() => {
  proxyMock.mockClear();
  detectMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runServe stamps hostPlatform from --host override (BUG B)", () => {
  it("uses a RECOGNIZED hostPlatformOverride instead of detection", async () => {
    await runServe({
      connectorId: "demo",
      serverCommand: "node",
      serverArgs: ["server.js"],
      hostPlatformOverride: "opencode",
    });
    expect(proxyMock).toHaveBeenCalledTimes(1);
    // The override wins — detection (which would mis-attribute "claude-code") is
    // NOT what gets stamped.
    expect(lastProxyOpts().hostPlatform).toBe("opencode");
  });

  it("stamps openclaw/hermes correctly (would be 'unknown' from detection)", async () => {
    await runServe({
      connectorId: "demo",
      serverCommand: "srv",
      serverArgs: [],
      hostPlatformOverride: "openclaw",
    });
    expect(lastProxyOpts().hostPlatform).toBe("openclaw");
  });

  it("FALLS BACK to detection when no override is supplied", async () => {
    await runServe({
      connectorId: "demo",
      serverCommand: "srv",
      serverArgs: [],
    });
    expect(detectMock).toHaveBeenCalled();
    expect(lastProxyOpts().hostPlatform).toBe("claude-code");
  });

  it("FALLS BACK to detection when the override is not a registered platform id", async () => {
    await runServe({
      connectorId: "demo",
      serverCommand: "srv",
      serverArgs: [],
      // A bogus value must never poison hostPlatform — detection takes over.
      hostPlatformOverride: "not-a-real-platform" as never,
    });
    expect(detectMock).toHaveBeenCalled();
    expect(lastProxyOpts().hostPlatform).toBe("claude-code");
  });
});
