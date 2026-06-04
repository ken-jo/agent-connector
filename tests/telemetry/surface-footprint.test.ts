/**
 * tests/telemetry/surface-footprint — the STATIC developer-axis surfaces.
 *
 * computeSurfaceFootprints tokenizes each declared command / skill / subagent of
 * a connector with the shared tokenizer and returns one footprint per surface.
 * These are deterministic (no IO beyond the passed connector) and never written
 * as usage rows — they are the cost a host pays to LOAD the surface as context.
 *
 * No filesystem or env isolation is needed: the function is pure over the passed
 * ResolvedConnector. We build that connector via the real defineConnector so the
 * shape matches production exactly.
 */

import { describe, expect, it } from "vitest";

import { defineConnector } from "../../src/core/define-connector.js";
import { computeSurfaceFootprints } from "../../src/telemetry/surface-footprint.js";

/** A connector declaring one of each content surface. */
function buildConnector() {
  return defineConnector({
    id: "surf-demo",
    commands: [
      {
        name: "deploy",
        description: "Deploy the app to an environment",
        prompt: "Deploy the application to {{environment}} and report status.",
        argumentHint: "[environment]",
      },
    ],
    skills: [
      {
        name: "db-audit",
        description: "Audit a database for slow queries and missing indexes.",
        body: "Run EXPLAIN on every query; flag full scans; suggest indexes.",
        resources: {
          "references/queries.md": "## Common slow queries\nSELECT * FROM ...",
          "scripts/run.sh": "#!/usr/bin/env bash\necho running audit",
        },
      },
    ],
    subagents: [
      {
        name: "reviewer",
        description: "Reviews a diff for correctness bugs.",
        prompt: "You are a meticulous code reviewer. Find correctness bugs only.",
      },
    ],
  });
}

describe("computeSurfaceFootprints — one entry per content surface", () => {
  it("returns a command/skill/subagent footprint with the correct names", () => {
    const footprints = computeSurfaceFootprints(buildConnector());

    // Exactly one entry per declared surface.
    expect(footprints).toHaveLength(3);

    const byKind = new Map(footprints.map((f) => [f.surfaceKind, f]));
    expect(byKind.get("command")!.name).toBe("deploy");
    expect(byKind.get("skill")!.name).toBe("db-audit");
    expect(byKind.get("subagent")!.name).toBe("reviewer");
  });

  it("counts nonzero tokens for every surface", () => {
    for (const f of computeSurfaceFootprints(buildConnector())) {
      expect(f.tokens).toBeGreaterThan(0);
    }
  });

  it("never emits a server/hook kind (those are runtime-measured)", () => {
    for (const f of computeSurfaceFootprints(buildConnector())) {
      expect(["command", "skill", "subagent"]).toContain(f.surfaceKind);
    }
  });

  it("folds skill resource values into the skill footprint (bigger than body alone)", () => {
    const withResources = buildConnector();
    const footprintWith = computeSurfaceFootprints(withResources).find(
      (f) => f.surfaceKind === "skill",
    )!;

    const withoutResources = defineConnector({
      id: "surf-demo",
      skills: [
        {
          name: "db-audit",
          description: "Audit a database for slow queries and missing indexes.",
          body: "Run EXPLAIN on every query; flag full scans; suggest indexes.",
        },
      ],
    });
    const footprintWithout = computeSurfaceFootprints(withoutResources).find(
      (f) => f.surfaceKind === "skill",
    )!;

    // The resources (queries.md + run.sh) add to the footprint.
    expect(footprintWith.tokens).toBeGreaterThan(footprintWithout.tokens);
  });

  it("is deterministic (same connector → identical footprints)", () => {
    const a = computeSurfaceFootprints(buildConnector());
    const b = computeSurfaceFootprints(buildConnector());
    expect(a).toEqual(b);
  });

  it("returns an empty list for a connector with no content surfaces", () => {
    // A server-only connector declares no command/skill/subagent → no footprints
    // (the server surface is runtime-measured, never a static footprint).
    const serverOnly = defineConnector({
      id: "bare",
      server: { transport: "stdio", command: "node", args: ["server.js"] },
    });
    expect(computeSurfaceFootprints(serverOnly)).toEqual([]);
  });
});
