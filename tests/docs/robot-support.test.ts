/**
 * tests/docs/robot-support — the single drift guard for the machine-readable
 * docs (`llms.txt` + `llms-full.txt`, the "robot support" surface LLMs read).
 *
 * llms.txt is intentionally a compact, descriptive route map. llms-full.txt is
 * the exhaustive contract that carries detailed host/event/SDK lists. This suite
 * makes that split explicit so the short file does not grow into an external
 * instruction-looking document that permission reviewers can mistake for active
 * agent guidance.
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
const SKILL = readFileSync("skills/agent-connector/SKILL.md", "utf8");
const AUTHORING_REFERENCE = readFileSync(
  "skills/agent-connector/references/authoring.md",
  "utf8",
);
const PACKAGE_FIRST_REFERENCE = readFileSync(
  "skills/agent-connector/references/package-first.md",
  "utf8",
);
const SITE_PACKAGE = JSON.parse(readFileSync("site/package.json", "utf8")) as {
  scripts?: Record<string, string>;
};
const SITE_AGENT_ASSET_COPY_SCRIPT = readFileSync(
  "site/scripts/copy-agent-assets.mjs",
  "utf8",
);
const DEPLOY_SITE_WORKFLOW = readFileSync(
  ".github/workflows/deploy-site.yml",
  "utf8",
);

/**
 * Inline registry-count idioms — the prose phrasings that quote the adapter
 * count as a bare number ("the N registered adapters", "subset of the N",
 * "all N unconditionally", "the N-adapter registry"). Each pattern captures the
 * number in group 1; the guard asserts it === ADAPTER_REGISTRY.length so a stale
 * "36"/"35"/"40" can never be reintroduced.
 *
 * Deliberately SCOPED to the registry-count idioms only — it must NOT match
 * paradigm subtotals, byte/line sizes, version strings, or prose that points to
 * the coverage page as the canonical host-count source.
 */
const REGISTRY_COUNT_PATTERNS: readonly RegExp[] = [
  /\b(\d+) registered(?: deploy)? adapters?\b/g,
  /\b(\d+)-adapter registry\b/g,
  /\bsubset of the (\d+) adapters\b/g,
  /\bacross the (\d+) registered adapters\b/g,
  /\ball (\d+) unconditionally\b/g,
  /\binstall to all (\d+)\b/g,
];

/** Every registry-count number quoted in `text`, with a label for failures. */
function registryCounts(text: string): { num: number; phrase: string }[] {
  const hits: { num: number; phrase: string }[] = [];
  for (const pattern of REGISTRY_COUNT_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      hits.push({ num: Number(m[1]), phrase: m[0] });
    }
  }
  return hits;
}

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
  it("publishes agent-readable docs in the website artifact", () => {
    expect(SITE_PACKAGE.scripts?.build).toContain("scripts/copy-agent-assets.mjs");
    expect(SITE_AGENT_ASSET_COPY_SCRIPT).toContain('"llms.txt"');
    expect(SITE_AGENT_ASSET_COPY_SCRIPT).toContain('"llms-full.txt"');
    expect(SITE_AGENT_ASSET_COPY_SCRIPT).toContain('"skills/agent-connector"');
    expect(DEPLOY_SITE_WORKFLOW).toContain('"llms.txt"');
    expect(DEPLOY_SITE_WORKFLOW).toContain('"llms-full.txt"');
    expect(DEPLOY_SITE_WORKFLOW).toContain('"skills/agent-connector/**"');
  });

  it("keeps llms.txt compact and descriptive instead of instruction-like", () => {
    expect(LLMS.length).toBeLessThanOrEqual(8_000);
    expect(LLMS).toContain("Descriptive product route map");
    expect(LLMS).toContain("Detailed API contracts");
    expect(LLMS).toContain("llms-full.txt");
    expect(LLMS).toContain("https://agent-connector.ai/coverage");
    expect(LLMS).not.toMatch(/ignore (all )?(previous|prior) instructions/i);
    expect(LLMS).not.toMatch(/\bsystem prompt\b/i);
    expect(LLMS).not.toMatch(/\bdeveloper instructions\b/i);
    expect(LLMS).not.toMatch(/\bAGENTS\.md\b/i);
    expect(LLMS).not.toMatch(/\bAUTONOMOUS CODING AGENT\b/i);
    expect(LLMS).not.toMatch(/\byou are\b/i);
    expect(LLMS).not.toMatch(/\bjailbreak\b/i);
    expect(LLMS).not.toMatch(/\bcredential\b/i);
    expect(LLMS).not.toMatch(/\bpassword\b/i);
    expect(LLMS).not.toMatch(/\bsecret\b/i);
  });

  it("keeps all MCP server launch shapes visible to agents", () => {
    // The docs use acme-db as one concrete sample, but agents must not infer
    // that every MCP is a database package launched through npx. The launch
    // shape list keeps the package-first contract product-neutral.
    expect(LLMS).toContain("package runner");
    expect(LLMS).toContain("local Node or process server");
    expect(LLMS).toContain("Python server");
    expect(LLMS).toContain("CLI server mode");
    expect(LLMS).toContain("remote HTTP server URL");
    expect(LLMS_FULL).toContain("local Node/process MCP");
    expect(LLMS_FULL).toContain("Python MCP");
    expect(LLMS_FULL).toContain("remote server MCP");
    expect(SKILL).toContain("packageJson");
    expect(AUTHORING_REFERENCE).toContain("Package-runner MCP");
    expect(AUTHORING_REFERENCE).toContain("Local server-process MCP");
    expect(AUTHORING_REFERENCE).toContain("Python MCP");
    expect(AUTHORING_REFERENCE).toContain("CLI-based MCP");
    expect(AUTHORING_REFERENCE).toContain("Remote server MCP");
    expect(PACKAGE_FIRST_REFERENCE).toContain("Balanced Example Families");
  });

  // ── Paradigm partition (migrated from platform-drift) ────────────────────
  it("llms.txt routes platform detail to coverage/full instead of duplicating host ids", async () => {
    await registryParadigms(); // sanity-load the registry; exact details live below in llms-full assertions.
    expect(LLMS).toContain("## Support And Coverage");
    expect(LLMS_FULL).toContain("## 6. Supported platforms by hook paradigm");
    expect(LLMS).toContain("https://agent-connector.ai/coverage");
    expect(LLMS_FULL).toContain("https://agent-connector.ai/coverage");
    expect(LLMS).not.toMatch(/^## Supported platforms by paradigm \(\d+\)$/m);
    expect(LLMS_FULL).not.toMatch(/^## 6\. Supported platforms \(\d+, by hook paradigm\)$/m);
    expect(LLMS).not.toMatch(/^- `json-stdio`/m);
    expect(LLMS).not.toMatch(/^- `mcp-only`/m);
    expect(LLMS).not.toMatch(/^- `ts-plugin`/m);
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
  it("llms.txt points hook-event detail to llms-full instead of listing every event", () => {
    expect(LLMS).toContain("canonical hook events");
    expect(LLMS).toContain("llms-full.txt");
    for (const event of canonicalEvents) {
      expect(LLMS, `llms.txt should not list detailed hook event "${event}"`).not.toContain(
        `${event},`,
      );
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

  it("llms.txt names handler surfaces but leaves per-host support to coverage/full", () => {
    expect(LLMS).toContain("statusline");
    expect(LLMS).toContain("actions");
    expect(LLMS).toContain("host caveats");
    expect(LLMS_FULL).toContain("supportsStatusline");
    expect(LLMS_FULL).toContain("supportsActions");
    expect(LLMS_FULL).toContain("supportsNativeHooks");
  });

  // ── Inline registry-count prose (the freshness sweep guards this) ─────────
  it("inline registry-count prose routes to coverage instead of duplicating counts", () => {
    const llmsHits = registryCounts(LLMS);
    const skillHits = registryCounts(SKILL);
    const fullHits = registryCounts(LLMS_FULL);
    expect(
      llmsHits,
      "llms.txt should route host counts to /coverage instead of duplicating a fixed registry count",
    ).toEqual([]);
    expect(
      skillHits,
      "SKILL.md should route to canonical coverage/reference docs instead of duplicating a fixed registry count",
    ).toEqual([]);
    expect(
      fullHits,
      "llms-full.txt should keep free-prose registry counts out of prose; paradigm heading counts are guarded separately",
    ).toEqual([]);
    expect(SKILL).toContain("/coverage");
    expect(SKILL).toContain("llms.txt");
    expect(SKILL).toContain("llms-full.txt");
  });

  // ── NEW high-confidence guards ───────────────────────────────────────────
  it("llms-full.txt SurfaceName list names every surface the sdk models", () => {
    // SURFACE_PREDICATES is keyed by SurfaceName — the runtime view of the type.
    const surfaces = Object.keys(SURFACE_PREDICATES);
    const idx = LLMS_FULL.indexOf("`SurfaceName` vocabulary:");
    expect(idx, "llms-full.txt is missing the SurfaceName vocabulary").toBeGreaterThan(-1);
    const enumPart = LLMS_FULL.slice(idx, LLMS_FULL.indexOf("Examples:", idx));
    for (const surface of surfaces) {
      expect(
        enumPart,
        `llms-full.txt SurfaceName vocabulary is missing "${surface}"`,
      ).toContain(surface);
    }
  });

  it("llms-full.txt SDK section names every `define*` authoring helper exported from /sdk", () => {
    const defineFns = Object.keys(sdk)
      .filter((k) => /^define[A-Z]/.test(k))
      .sort();
    // sanity: the family is non-trivial (catches a broken import).
    expect(defineFns.length).toBeGreaterThanOrEqual(8);
    for (const fn of defineFns) {
      expect(LLMS_FULL, `llms-full.txt never documents the sdk helper "${fn}"`).toContain(fn);
    }
  });

  it("llms.txt keeps branded lifecycle separate from framework packaging", () => {
    const line = bullet(LLMS, "- MCP developer track:");
    expect(line, "llms.txt is missing the MCP developer audience bullet").toBeTruthy();
    expect(line).toContain("branded MCP integration");
    expect(LLMS).toContain("package's");
    expect(LLMS).toContain("own bin");
    expect(LLMS).toContain("Framework packaging artifacts");
    expect(line).not.toContain("doctor/detect/status, package");
  });

  it("robot docs package command names every PackageFormat the emitter ships", () => {
    const line = bullet(LLMS, "- Framework CLI:");
    expect(line, "llms.txt is missing the `package` command bullet").toBeTruthy();
    const fullPackageIdx = LLMS_FULL.indexOf("### package");
    const fullTelemetryIdx = LLMS_FULL.indexOf("### telemetry", fullPackageIdx);
    expect(fullPackageIdx, "llms-full.txt is missing the package section").toBeGreaterThan(-1);
    expect(fullTelemetryIdx, "llms-full.txt package section terminator missing").toBeGreaterThan(-1);
    const fullPackageSection = LLMS_FULL.slice(fullPackageIdx, fullTelemetryIdx);
    expect(fullPackageSection).toContain("framework tooling, not a branded MCP lifecycle command");
    for (const fmt of ALL_FORMATS) {
      expect(
        fullPackageSection,
        `llms-full.txt package section is missing the "${fmt}" format`,
      ).toContain(fmt);
    }
  });

  it("llms-full.txt install section names every marketplace-drivable host (and no non-drivable one)", () => {
    const drivable = ADAPTER_REGISTRY.map((f) => f.id)
      .filter((id) => getMarketplaceDriver(id) !== null)
      .sort();
    const notDrivable = ADAPTER_REGISTRY.map((f) => f.id).filter(
      (id) => getMarketplaceDriver(id) === null,
    );
    const installStart = LLMS_FULL.indexOf("### install");
    const uninstallStart = LLMS_FULL.indexOf("### uninstall", installStart);
    expect(installStart, "llms-full.txt is missing the install section").toBeGreaterThan(-1);
    expect(uninstallStart, "llms-full.txt install section terminator missing").toBeGreaterThan(
      installStart,
    );
    const section = LLMS_FULL.slice(installStart, uninstallStart);
    // sanity: the resolver yields a real, non-empty set.
    expect(drivable.length).toBeGreaterThanOrEqual(3);
    for (const id of drivable) {
      expect(section, `llms-full.txt install section omits drivable host "${id}"`).toContain(id);
    }
    // A host with NO driver must not be advertised as drivable (substring-safe).
    for (const id of notDrivable) {
      if (drivable.some((d) => d.includes(id))) continue; // substring ids (kilo vs kilo-cli)
      expect(
        new RegExp(`Drivable hosts[^\\n]*[ ,]${id}[,.\\s]`).test(section),
        `llms-full.txt install section wrongly lists non-drivable "${id}" as drivable`,
      ).toBe(false);
    }
  });
});
