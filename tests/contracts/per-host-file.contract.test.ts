/**
 * contracts/per-host-file — fleet invariant locking the "one file per host"
 * convention (tests/README.md) into CI.
 *
 * The other registry contracts (adapter-baseline / hook-detail / etc.) auto-cover
 * a new adapter's SPI baseline the moment it joins ADAPTER_REGISTRY — but they do
 * NOT notice if its host-specific surface file (tests/adapters/<id>.test.ts) is
 * missing. Without this guard a contributor could register an adapter and ship it
 * with zero host-specific install/render/hook coverage, and nothing would fail.
 *
 * This asserts a strict 1:1 between ADAPTER_REGISTRY ids and the per-host test
 * file stems under tests/adapters/ — adding an adapter without its file (or
 * leaving an orphan file) turns CI red. The three standalone invariant suites are
 * not per-host adapter files and are excluded.
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ADAPTER_REGISTRY } from "../../src/adapters/registry.js";

const ADAPTERS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "adapters");

/** Standalone fleet-invariant suites that live in tests/adapters/ but are NOT
 * per-host adapter files (so they must not be required to match a registry id). */
const INVARIANT_FILES = new Set([
  "registry-completeness",
  "healthchecks-undeclared",
  "uninstall-collision",
]);

describe("per-host test-file coverage — 1:1 with ADAPTER_REGISTRY", () => {
  const perHostStems = readdirSync(ADAPTERS_DIR)
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => f.replace(/\.test\.ts$/, ""))
    .filter((s) => !INVARIANT_FILES.has(s));
  const registryIds = ADAPTER_REGISTRY.map((f) => f.id);

  it("every registered adapter has a tests/adapters/<id>.test.ts (no missing)", () => {
    const haveFile = new Set(perHostStems);
    const missing = registryIds.filter((id) => !haveFile.has(id));
    expect(
      missing,
      `registry hosts with NO per-host test file (author tests/adapters/<id>.test.ts): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("no orphan per-host test file without a registered adapter", () => {
    const isRegistered = new Set(registryIds);
    const orphans = perHostStems.filter((s) => !isRegistered.has(s));
    expect(
      orphans,
      `per-host test files with no matching ADAPTER_REGISTRY id: ${orphans.join(", ")}`,
    ).toEqual([]);
  });
});
