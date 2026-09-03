/**
 * README "By the numbers" — every figure in that table is pinned to the source
 * it claims to be derived from. The README quotes numbers on purpose: they are
 * the evidence a reader (or a search index) ranks on, and an unverifiable
 * number is worse than none. So each one must EQUAL its source, and a change
 * to the registry, a surface profile, the verification matrix or the test tree
 * breaks this test instead of leaving the README stale.
 *
 * The footprint row (files written by the example) is measured, not derived —
 * see tests/docs/readme-footprint.test.ts.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ADAPTER_REGISTRY } from "../../src/adapters/registry.js";
import { ALL_EVENTS } from "../../src/core/define-connector.js";
import { ALL_FORMATS, FEASIBLE_FORMATS } from "../../src/core/package.js";
import {
  adapterCapabilityProfiles,
  generatedSurfaceKeys,
} from "../../site/src/adapter-capabilities.generated.js";
import {
  hostVerificationResults,
  verificationLevelForResult,
} from "../../site/src/host-verification.generated.js";

const README = readFileSync(join(process.cwd(), "README.md"), "utf8");

function num(pattern: RegExp, label: string): number[] {
  const m = README.match(pattern);
  expect(m, `README row not found: ${label} — keep the literal shape in sync with this test`).toBeTruthy();
  return m!.slice(1).map(Number);
}

function countTestFiles(dir: string): number {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) n += countTestFiles(full);
    else if (name.endsWith(".test.ts")) n += 1;
  }
  return n;
}

const surfaceCount = (key: string): number =>
  adapterCapabilityProfiles.filter((p) => (p.surfaces as Record<string, boolean>)[key]).length;

describe("README 'By the numbers' equals its sources", () => {
  it("agent hosts = registry", () => {
    const [hosts] = num(/\| Agent hosts with an adapter \| \*\*(\d+)\*\*/, "hosts");
    expect(hosts).toBe(ADAPTER_REGISTRY.length);
    const [verifiedOf] = num(/\*\*\d+ of (\d+)\*\* \(\d+ of them end-to-end/, "verified denominator");
    expect(verifiedOf).toBe(ADAPTER_REGISTRY.length);
  });

  it("surfaces = generated capability profiles", () => {
    const [total, mcp, memory, skills, hooks, commands, subagents, actions, statusline] = num(
      /\| Surfaces rendered per host \| \*\*(\d+)\*\* — MCP server \((\d+) hosts\), memory \((\d+)\), skills \((\d+)\), hooks \((\d+)\), commands \((\d+)\), subagents \((\d+)\), actions \((\d+)\), status line \((\d+)\)/,
      "surfaces",
    );
    expect(total).toBe(generatedSurfaceKeys.length);
    expect({ mcp, memory, skills, hooks, commands, subagents, actions, statusline }).toEqual({
      mcp: surfaceCount("mcp"),
      memory: surfaceCount("memory"),
      skills: surfaceCount("skills"),
      hooks: surfaceCount("hooks"),
      commands: surfaceCount("commands"),
      subagents: surfaceCount("subagents"),
      actions: surfaceCount("actions"),
      statusline: surfaceCount("statusline"),
    });
    expect(README).toContain(`surfaces-${generatedSurfaceKeys.length}-`);
  });

  it("hook events + paradigm split = ALL_EVENTS and the loaded adapters", async () => {
    const [events, paradigms, jsonStdio, mcpOnly, tsPlugin] = num(
      /\| Hook events normalized \| \*\*(\d+)\*\*, dispatched through \*\*(\d+)\*\* paradigms \(`json-stdio` (\d+) hosts · `mcp-only` (\d+) · `ts-plugin` (\d+)\)/,
      "hook events",
    );
    expect(events).toBe(ALL_EVENTS.length);
    const split: Record<string, number> = {};
    for (const factory of ADAPTER_REGISTRY) {
      const adapter = await factory.load();
      split[adapter.paradigm] = (split[adapter.paradigm] ?? 0) + 1;
    }
    expect(paradigms).toBe(Object.keys(split).length);
    expect({ jsonStdio, mcpOnly, tsPlugin }).toEqual({
      jsonStdio: split["json-stdio"],
      mcpOnly: split["mcp-only"],
      tsPlugin: split["ts-plugin"],
    });
    expect(README).toContain(`hook%20paradigms-${Object.keys(split).length}-`);
  });

  it("package formats = FEASIBLE_FORMATS + the MCP standard artifacts", () => {
    const [plugin, standard] = num(
      /\| Package formats emitted \| \*\*(\d+)\*\* host plugin formats \+ \*\*(\d+)\*\* MCP standard artifacts/,
      "package formats",
    );
    expect(plugin).toBe(FEASIBLE_FORMATS.length);
    expect(standard).toBe(ALL_FORMATS.length - FEASIBLE_FORMATS.length);
    expect(README).toContain(`package-${plugin}%20plugin%20formats%20%2B%20${standard}%20MCP%20artifacts`);
  });

  it("verification split = the generated host verification matrix", () => {
    const [live, , e2e, harness] = num(
      /\| Hosts verified against the real host binary \| \*\*(\d+) of (\d+)\*\* \((\d+) of them end-to-end through a model tool call\); the other \*\*(\d+)\*\* by the registry install harness/,
      "verification",
    );
    const levels: Record<string, number> = {};
    for (const row of hostVerificationResults) {
      const level = verificationLevelForResult(row.result);
      levels[level] = (levels[level] ?? 0) + 1;
    }
    // "against the real host binary" = every level whose description starts
    // with a real host being driven: e2e + live-runtime + live-accept +
    // live-placement. The remainder is adapter-placement + install-doctor.
    const liveLevels = ["e2e", "live-runtime", "live-accept", "live-placement"];
    const liveCount = liveLevels.reduce((n, k) => n + (levels[k] ?? 0), 0);
    expect(hostVerificationResults.length).toBe(ADAPTER_REGISTRY.length);
    expect(live).toBe(liveCount);
    expect(e2e).toBe(levels["e2e"] ?? 0);
    expect(harness).toBe(ADAPTER_REGISTRY.length - liveCount);
  });

  it("test suite = the number of *.test.ts files", () => {
    const [files] = num(/\| Test suite \| \*\*(\d+)\*\* test files/, "test suite");
    const actual = countTestFiles(join(process.cwd(), "tests"));
    expect(files).toBe(actual);
    expect(README).toContain(`tests-${actual}%20files-`);
  });
});
