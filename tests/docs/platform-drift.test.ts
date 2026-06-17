/**
 * tests/docs/platform-drift — the docs-vs-registry drift guard.
 *
 * Every documentation error class found in the docs audit came from
 * hand-duplicated platform data drifting independently (Droid misclassified in
 * 8+ places; counts frozen at 15/3/10 while the registry shipped 16/4/9). This
 * test makes src/adapters/registry.ts the single source of truth and fails the
 * suite whenever a doc surface disagrees, so the next platform addition cannot
 * silently rot the docs again.
 *
 * Guarded surfaces: site docs-data paradigm lists (exact id sets), site
 * landing platform-data.ts (exact id set + per-host name/paradigm/surface
 * flags vs each loaded adapter's capabilities, plus the ours ⊆ hostNative
 * invariant behind the wall's 3-state chips), llms.txt paradigm bullets
 * (exact id sets), llms heading counts, README platform badge + Droid's
 * paradigm row.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ADAPTER_REGISTRY } from "../../src/adapters/registry.js";
import {
  jsonStdioPlatforms,
  mcpOnlyPlatforms,
  tsPluginPlatforms,
} from "../../site/src/components/docs/docs-data.js";
import { platforms as landingPlatforms } from "../../site/src/platform-data.js";

/** Registry-derived truth: paradigm → sorted adapter ids. */
async function registryParadigms(): Promise<Record<string, string[]>> {
  const sets: Record<string, string[]> = {};
  for (const factory of ADAPTER_REGISTRY) {
    const adapter = await factory.load();
    (sets[adapter.paradigm] ??= []).push(factory.id);
  }
  for (const k of Object.keys(sets)) sets[k]!.sort();
  return sets;
}

describe("platform/paradigm drift guard (registry is the source of truth)", () => {
  it("site docs-data paradigm lists carry EXACTLY the registry id sets", async () => {
    const truth = await registryParadigms();
    const docIds = {
      "json-stdio": jsonStdioPlatforms.map((p) => p.id).sort(),
      "ts-plugin": tsPluginPlatforms.map((p) => p.id).sort(),
      "mcp-only": mcpOnlyPlatforms.map((p) => p.id).sort(),
    };
    expect(docIds["json-stdio"]).toEqual(truth["json-stdio"]);
    expect(docIds["ts-plugin"]).toEqual(truth["ts-plugin"]);
    expect(docIds["mcp-only"]).toEqual(truth["mcp-only"]);
  });

  it("site landing platform list carries EXACTLY the registry ids, in registry order", () => {
    // platform-data.ts is dependency-free (data.ts re-exports it) precisely so
    // this test can import the real array instead of regex-counting source text.
    expect(landingPlatforms.map((p) => p.id)).toEqual(
      ADAPTER_REGISTRY.map((f) => f.id),
    );
  });

  it("site landing surface flags EXACTLY match each loaded adapter's capabilities", async () => {
    // Same derivation the installer uses: MCP by transports, hooks by paradigm
    // (json-stdio / ts-plugin dispatch hooks; mcp-only has no hook layer), and
    // the content/memory surfaces by their optional supports* flags (?? false).
    // load() resolves inherited capabilities too (antigravity-cli declares no
    // literal of its own — it extends AntigravityAdapter).
    for (const factory of ADAPTER_REGISTRY) {
      const adapter = await factory.load();
      const entry = landingPlatforms.find((p) => p.id === factory.id);
      expect(entry, `site platform-data.ts is missing "${factory.id}"`).toBeTruthy();
      const caps = adapter.capabilities;
      expect(
        {
          name: entry!.name,
          paradigm: entry!.paradigm,
          surfaces: entry!.surfaces,
        },
        `site landing profile for "${factory.id}" drifted from its adapter`,
      ).toEqual({
        name: adapter.name,
        paradigm: adapter.paradigm,
        surfaces: {
          mcp: caps.transports.length > 0,
          hooks: adapter.paradigm !== "mcp-only",
          commands: caps.supportsCommands ?? false,
          skills: caps.supportsSkills ?? false,
          subagents: caps.supportsSubagents ?? false,
          memory: caps.supportsMemory ?? false,
          statusline: caps.supportsStatusline ?? false,
          actions: caps.supportsActions ?? false,
        },
      });
    }
  });

  it("hostNative is a superset of our support (we cannot install what the host lacks)", () => {
    // The landing wall renders three chip states from (surfaces, hostNative):
    // supported / host-has-it-we-don't / host-doesn't-offer-it. The pair is
    // only coherent under ours ⊆ hostNative — a surface we install MUST be one
    // the host natively offers. A violation means platform-data's hostNative
    // research or the adapter's capabilities are wrong: investigate the data,
    // never weaken this assertion.
    for (const platform of landingPlatforms) {
      for (const key of Object.keys(platform.surfaces) as (keyof typeof platform.surfaces)[]) {
        expect(
          platform.hostNative[key] || !platform.surfaces[key],
          `"${platform.id}".${key}: ourSupport=true but hostNative=false — ` +
            "either the hostNative cell in site/src/platform-data.ts or the adapter's capabilities are wrong",
        ).toBe(true);
      }
    }
  });

  // NOTE: the llms.txt / llms-full.txt paradigm-partition assertions moved to
  // tests/docs/robot-support.test.ts (the single home for robot-doc drift).

  it("README badge count is current and Droid sits in the json-stdio row", () => {
    const text = readFileSync("README.md", "utf8");
    expect(text).toContain(`platforms-${ADAPTER_REGISTRY.length}-`);
    const jsonStdioRow = text.split("\n").find((l) => l.includes("`json-stdio`") && l.includes("|"));
    expect(jsonStdioRow, "README json-stdio table row not found").toBeTruthy();
    expect(jsonStdioRow).toContain("Droid");
  });
});
