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
 * landing data.ts (total), llms.txt paradigm bullets (exact id sets), llms
 * heading counts, README platform badge + Droid's paradigm row.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ADAPTER_REGISTRY } from "../../src/adapters/registry.js";
import {
  jsonStdioPlatforms,
  mcpOnlyPlatforms,
  tsPluginPlatforms,
} from "../../site/src/components/docs/docs-data.js";

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

  it("site landing platform list matches the registry total", () => {
    // data.ts imports lucide-react (a site-only dep), so count entries textually:
    // every platform row is written as `{ name: "...", paradigm: "..." }`.
    const text = readFileSync("site/src/data.ts", "utf8");
    const entries = text.match(/\{ name: "[^"]+", paradigm: "/g) ?? [];
    expect(entries.length).toBe(ADAPTER_REGISTRY.length);
  });

  it("llms.txt paradigm bullets name EXACTLY the registry ids, and the heading count is current", async () => {
    const truth = await registryParadigms();
    const text = readFileSync("llms.txt", "utf8");
    expect(text).toContain(`## Supported platforms by paradigm (${ADAPTER_REGISTRY.length})`);
    for (const [paradigm, ids] of Object.entries(truth)) {
      const line = text
        .split("\n")
        .find((l) => l.startsWith(`- \`${paradigm}\``));
      expect(line, `llms.txt is missing the ${paradigm} bullet`).toBeTruthy();
      for (const id of ids) {
        expect(line, `llms.txt ${paradigm} bullet is missing "${id}"`).toContain(id);
      }
      // No id from another paradigm may appear on this line.
      for (const [other, otherIds] of Object.entries(truth)) {
        if (other === paradigm) continue;
        for (const id of otherIds) {
          if (ids.some((own) => own.includes(id))) continue; // substring ids (kilo vs kilo-cli)
          expect(
            new RegExp(`[ ,]${id}[,.\\s]`).test(line!),
            `llms.txt ${paradigm} bullet wrongly lists "${id}" (${other})`,
          ).toBe(false);
        }
      }
    }
  });

  it("llms-full.txt paradigm heading counts match the registry", async () => {
    const truth = await registryParadigms();
    const text = readFileSync("llms-full.txt", "utf8");
    expect(text).toContain(`### \`json-stdio\` — full hook dispatch (${truth["json-stdio"]!.length})`);
    expect(text).toContain(`(${truth["ts-plugin"]!.length})`);
    expect(text).toContain(`(${truth["mcp-only"]!.length})`);
  });

  it("README badge count is current and Droid sits in the json-stdio row", () => {
    const text = readFileSync("README.md", "utf8");
    expect(text).toContain(`platforms-${ADAPTER_REGISTRY.length}-`);
    const jsonStdioRow = text.split("\n").find((l) => l.includes("`json-stdio`") && l.includes("|"));
    expect(jsonStdioRow, "README json-stdio table row not found").toBeTruthy();
    expect(jsonStdioRow).toContain("Droid");
  });
});
