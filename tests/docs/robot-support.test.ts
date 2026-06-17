/**
 * tests/docs/robot-support — the single drift guard for the machine-readable
 * docs (`llms.txt` + `llms-full.txt`, the "robot support" surface LLMs read).
 *
 * These two files are HAND-MAINTAINED prose, so every factual list they carry can
 * silently rot when the code moves. This suite makes the code the single source of
 * truth and fails the moment a doc list drifts. ALL llms.txt / llms-full.txt
 * assertions live HERE (consolidated out of platform-drift + hook-event-drift, so
 * those keep only their site/README scope) — a contributor touching the robot docs
 * has exactly one place to look.
 *
 * Only HIGH-CONFIDENCE, deterministically-derivable claims are guarded — each set
 * is computed from a real export (the adapter registry, the core type unions, the
 * package-format list, the marketplace-driver resolver, the sdk `define*` family),
 * never a hand-copied literal. Free-prose semantics (per-host hook behaviour
 * paragraphs) are deliberately NOT asserted here.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ADAPTER_REGISTRY } from "../../src/adapters/registry.js";
import { ALL_FORMATS } from "../../src/core/package.js";
import { getMarketplaceDriver } from "../../src/core/marketplace-drivers/registry.js";
import { canonicalEvents } from "../../site/src/components/docs/hooks-matrix.js";
import { SURFACE_PREDICATES } from "../../src/sdk/introspect.js";
import * as sdk from "../../src/sdk/index.js";

const LLMS = readFileSync("llms.txt", "utf8");
const LLMS_FULL = readFileSync("llms-full.txt", "utf8");

/** The line in llms.txt that starts with `prefix` (the bullet anchor). */
function bullet(text: string, prefix: string): string | undefined {
  return text.split("\n").find((l) => l.startsWith(prefix));
}

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

describe("robot docs drift guard — llms.txt + llms-full.txt (code is the source of truth)", () => {
  // ── Paradigm partition (migrated from platform-drift) ────────────────────
  it("llms.txt paradigm bullets name EXACTLY the registry ids, and the heading count is current", async () => {
    const truth = await registryParadigms();
    expect(LLMS).toContain(
      `## Supported platforms by paradigm (${ADAPTER_REGISTRY.length})`,
    );
    for (const [paradigm, ids] of Object.entries(truth)) {
      const line = bullet(LLMS, `- \`${paradigm}\``);
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
    expect(LLMS_FULL).toContain(
      `### \`json-stdio\` — full hook dispatch (${truth["json-stdio"]!.length})`,
    );
    expect(LLMS_FULL).toContain(`(${truth["ts-plugin"]!.length})`);
    expect(LLMS_FULL).toContain(`(${truth["mcp-only"]!.length})`);
  });

  // ── Canonical hook events (migrated from hook-event-drift) ────────────────
  it("llms.txt hooks bullet names every canonical event", () => {
    const line = bullet(LLMS, "- `hooks` —");
    expect(line, "llms.txt is missing the `hooks` surface bullet").toBeTruthy();
    expect(line).toContain(`${canonicalEvents.length} canonical events`);
    for (const event of canonicalEvents) {
      expect(line, `llms.txt hooks bullet is missing "${event}"`).toContain(event);
    }
  });

  it("llms-full.txt §2.3 HooksConfig block + payload table carry every canonical event", () => {
    for (const event of canonicalEvents) {
      expect(
        new RegExp(`^  ${event}\\?:\\s+HookDefinition<"${event}">;`, "m").test(LLMS_FULL),
        `llms-full.txt HooksConfig block is missing the ${event} key`,
      ).toBe(true);
      expect(
        new RegExp(`^\\| \`${event}\` \\|`, "m").test(LLMS_FULL),
        `llms-full.txt payload table is missing the ${event} row`,
      ).toBe(true);
    }
  });

  // ── NEW high-confidence guards ───────────────────────────────────────────
  it("llms.txt SurfaceName list names every surface the sdk models", () => {
    // SURFACE_PREDICATES is keyed by SurfaceName — the runtime view of the type.
    const surfaces = Object.keys(SURFACE_PREDICATES);
    const line = bullet(LLMS, "- `./sdk`");
    expect(line, "llms.txt is missing the `./sdk` export bullet").toBeTruthy();
    // The canonical `SurfaceName: a|b|c…` enumeration lives on that bullet.
    const enumPart = line!.slice(line!.indexOf("`SurfaceName`"));
    expect(enumPart, "llms.txt `./sdk` bullet is missing the SurfaceName enumeration").toBeTruthy();
    for (const surface of surfaces) {
      expect(
        enumPart,
        `llms.txt SurfaceName enumeration is missing "${surface}"`,
      ).toContain(surface);
    }
  });

  it("llms.txt SDK bullet names every `define*` authoring helper exported from /sdk", () => {
    const defineFns = Object.keys(sdk)
      .filter((k) => /^define[A-Z]/.test(k))
      .sort();
    // sanity: the family is non-trivial (catches a broken import).
    expect(defineFns.length).toBeGreaterThanOrEqual(8);
    for (const fn of defineFns) {
      expect(LLMS, `llms.txt never documents the sdk helper "${fn}"`).toContain(fn);
    }
  });

  it("llms.txt package bullet names every PackageFormat the emitter ships", () => {
    const line = bullet(LLMS, "- `package");
    expect(line, "llms.txt is missing the `package` command bullet").toBeTruthy();
    for (const fmt of ALL_FORMATS) {
      expect(line, `llms.txt package bullet is missing the "${fmt}" format`).toContain(fmt);
    }
  });

  it("llms.txt install bullet names every marketplace-drivable host (and no non-drivable one)", () => {
    const drivable = ADAPTER_REGISTRY.map((f) => f.id)
      .filter((id) => getMarketplaceDriver(id) !== null)
      .sort();
    const notDrivable = ADAPTER_REGISTRY.map((f) => f.id).filter(
      (id) => getMarketplaceDriver(id) === null,
    );
    const line = bullet(LLMS, "- `install");
    expect(line, "llms.txt is missing the `install` command bullet").toBeTruthy();
    // sanity: the resolver yields a real, non-empty set.
    expect(drivable.length).toBeGreaterThanOrEqual(3);
    for (const id of drivable) {
      expect(line, `llms.txt install bullet omits drivable host "${id}"`).toContain(id);
    }
    // A host with NO driver must not be advertised as drivable (substring-safe).
    for (const id of notDrivable) {
      if (drivable.some((d) => d.includes(id))) continue; // substring ids (kilo vs kilo-cli)
      expect(
        new RegExp(`drivable:[^\\n]*[ ,]${id}[,.\\s]`).test(line!),
        `llms.txt install bullet wrongly lists non-drivable "${id}" as drivable`,
      ).toBe(false);
    }
  });
});
