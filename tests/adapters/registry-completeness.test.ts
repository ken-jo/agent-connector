/**
 * adapters/registry-completeness — guards against ORPHANED PlatformIds.
 *
 * An "orphan" is a PlatformId that LOOKS installable (it is in the PlatformId
 * union and may even have a usage reader) but has NO ADAPTER_REGISTRY entry, so
 * `install --targets <id>` silently does nothing. This is the exact defect class
 * that the coverage-correctness audit found for `kilo-cli` (a usage reader, no
 * adapter) and `synthetic` (telemetry-only).
 *
 * The test asserts: every PlatformId — MINUS the explicit TELEMETRY_ONLY
 * allowlist and the `"unknown"` sentinel — has an ADAPTER_REGISTRY entry.
 *
 * It also pins the Kilo two-product identity so the audit's inversion cannot
 * regress: adapter id `kilo` is the VS Code extension (root key "mcpServers"),
 * adapter id `kilo-cli` is the CLI (root key "mcp"), and both have usage readers
 * with the SAME platformIds (kilo = extension, kilo-cli = CLI).
 *
 * ALL_PLATFORM_IDS is built as the keys of an exhaustive `Record<PlatformId, …>`
 * so TypeScript FORCES this list to stay in sync with the PlatformId union — add
 * a new id to the union and this file fails to compile until it is listed here,
 * which in turn makes the completeness assertion cover it.
 */

import { describe, expect, it } from "vitest";

import { REGISTERED_PLATFORM_IDS } from "../../src/adapters/registry.js";
import { USAGE_READER_REGISTRY } from "../../src/usage/registry.js";
import type { PlatformId } from "../../src/core/types.js";

/**
 * Every PlatformId, as the keys of an exhaustive map. The `Record<PlatformId,
 * true>` type makes a missing key a COMPILE error, so this can never silently
 * drift from the union.
 */
const ALL_PLATFORM_IDS_MAP: Record<PlatformId, true> = {
  "claude-code": true,
  codex: true,
  cursor: true,
  "vscode-copilot": true,
  "jetbrains-copilot": true,
  "copilot-cli": true,
  "gemini-cli": true,
  opencode: true,
  "mimo-code": true,
  kilo: true,
  "kilo-cli": true,
  warp: true,
  hermes: true,
  nemoclaw: true,
  openclaw: true,
  zed: true,
  antigravity: true,
  "antigravity-cli": true,
  kiro: true,
  "qwen-code": true,
  kimi: true,
  pi: true,
  omp: true,
  droid: true,
  "roo-code": true,
  trae: true,
  amp: true,
  codebuff: true,
  mux: true,
  crush: true,
  goose: true,
  synthetic: true,
  unknown: true,
};

const ALL_PLATFORM_IDS = Object.keys(ALL_PLATFORM_IDS_MAP) as PlatformId[];

/**
 * Platforms that are USAGE-ONLY (telemetry readers) and deliberately have NO
 * deploy adapter — e.g. the host exposes no writable MCP config to install into.
 */
const TELEMETRY_ONLY: ReadonlySet<PlatformId> = new Set<PlatformId>(["synthetic"]);

/** The runtime-only sentinel; never a real installable host. */
const SENTINEL: ReadonlySet<PlatformId> = new Set<PlatformId>(["unknown"]);

describe("adapter registry completeness", () => {
  it("every installable PlatformId (minus telemetry-only + the unknown sentinel) has an ADAPTER_REGISTRY entry", () => {
    const orphans = ALL_PLATFORM_IDS.filter(
      (id) =>
        !TELEMETRY_ONLY.has(id) && !SENTINEL.has(id) && !REGISTERED_PLATFORM_IDS.has(id),
    );
    expect(orphans).toEqual([]);
  });

  it("the telemetry-only allowlist members are NOT in the adapter registry (no phantom adapters)", () => {
    for (const id of TELEMETRY_ONLY) {
      expect(REGISTERED_PLATFORM_IDS.has(id)).toBe(false);
    }
  });

  it("the unknown sentinel is never registered as an adapter", () => {
    expect(REGISTERED_PLATFORM_IDS.has("unknown")).toBe(false);
  });

  it("the formerly-orphaned kilo-cli now has an adapter entry", () => {
    expect(REGISTERED_PLATFORM_IDS.has("kilo-cli")).toBe(true);
  });

  it("every adapter-registry id is a real PlatformId (no typos / stale entries)", () => {
    for (const id of REGISTERED_PLATFORM_IDS) {
      expect(ALL_PLATFORM_IDS).toContain(id);
    }
  });
});

describe("Kilo two-product identity (adapter ↔ usage layer agreement)", () => {
  const usageIds = new Set(USAGE_READER_REGISTRY.map((f) => f.platformId));

  it("both kilo (extension) and kilo-cli (CLI) have adapters AND usage readers", () => {
    expect(REGISTERED_PLATFORM_IDS.has("kilo")).toBe(true);
    expect(REGISTERED_PLATFORM_IDS.has("kilo-cli")).toBe(true);
    expect(usageIds.has("kilo")).toBe(true);
    expect(usageIds.has("kilo-cli")).toBe(true);
  });
});
