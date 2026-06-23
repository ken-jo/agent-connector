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
import {
  brandColor,
  formFactorIds,
  formFactorOf,
  hostLinks,
  hostSource,
  platforms as landingPlatforms,
  tierOf,
} from "../../site/src/platform-data.js";

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

  it("docs Hooks-page paradigm COUNTS equal the registry-derived per-paradigm tally", async () => {
    // The Hooks page renders per-paradigm host counts from these list lengths
    // (paradigmRows no longer stores a hardcoded count). This pins each rendered
    // count to the registry tally — the exact rot the old 16/7/8 literals had.
    const truth = await registryParadigms();
    expect(jsonStdioPlatforms.length).toBe(truth["json-stdio"]!.length);
    expect(tsPluginPlatforms.length).toBe(truth["ts-plugin"]!.length);
    expect(mcpOnlyPlatforms.length).toBe(truth["mcp-only"]!.length);
  });

  it("troubleshooting 'hooks unavailable here' prose lists EXACTLY the mcp-only hosts (no Amp)", async () => {
    // DocsContent.tsx renders the count + names from mcpOnlyPlatforms, but the
    // adjacent hardcoded "(Warp, Roo Code, Trae, Zed, Amp, ...)" prose once drifted
    // (listed Amp, a ts-plugin host with hooks, and the wrong count). Guard the
    // rendered names against the registry mcp-only set so it can never drift again.
    const truth = await registryParadigms();
    const mcpOnlyNames = mcpOnlyPlatforms.map((p) => p.name);

    // mcpOnlyPlatforms is the registry mcp-only set (pinned by the test above);
    // assert the troubleshooting block renders from it and excludes Amp.
    expect(mcpOnlyPlatforms.map((p) => p.id).sort()).toEqual(truth["mcp-only"]);
    expect(mcpOnlyPlatforms.some((p) => p.id === "amp")).toBe(false);

    const docs = readFileSync(
      "site/src/components/docs/DocsContent.tsx",
      "utf8",
    );
    const hooksUnavailableIdx = docs.indexOf('id="hooks-unavailable"');
    expect(hooksUnavailableIdx, "hooks-unavailable section not found").toBeGreaterThan(-1);
    const block = docs.slice(hooksUnavailableIdx, hooksUnavailableIdx + 600);
    // The block derives count + names from mcpOnlyPlatforms (not a literal list),
    // so the prose can never drift from the registry mcp-only set again.
    expect(block).toContain("mcpOnlyPlatforms.length");
    expect(block).toContain("mcpOnlyPlatforms.map");
    // The old stale "8 mcp-only hosts" literal (and its hardcoded name list that
    // wrongly included Amp) must be gone.
    expect(block).not.toMatch(/\b8 mcp-only hosts\b/);
    // Amp is ts-plugin (has a hook layer): it must not be in the rendered set.
    expect(mcpOnlyNames).not.toContain("Amp");
    expect(truth["ts-plugin"]).toContain("amp");
  });

  it("site landing platform list carries EXACTLY the registry ids, in registry order", () => {
    // platform-data.ts is dependency-free (data.ts re-exports it) precisely so
    // this test can import the real array instead of regex-counting source text.
    expect(landingPlatforms.map((p) => p.id)).toEqual(
      ADAPTER_REGISTRY.map((f) => f.id),
    );
  });

  it("form-factor lists PARTITION the registry ids exactly (every host classified, once)", () => {
    // formFactor is hand-curated HOST-NATURE metadata, not registry-derivable, so
    // a "frozen expected map" would just mirror the data (circular). The real
    // drift risk is a NEW registry host left unclassified — guard that with an
    // exact partition: the three bands together = every registry id, no overlap,
    // no stray id, and formFactorOf resolves every landing platform.
    const all = [
      ...formFactorIds.cli,
      ...formFactorIds.extension,
      ...formFactorIds.app,
    ];
    expect(new Set(all).size, "a host appears in more than one form-factor band").toBe(
      all.length,
    );
    expect([...all].sort()).toEqual(ADAPTER_REGISTRY.map((f) => f.id).sort());
    for (const p of landingPlatforms) {
      expect(formFactorOf(p.id), `"${p.id}" has no form-factor band`).toBeTruthy();
    }
  });

  it("hostSource classifies EVERY landing platform exactly once (closed or a repo)", () => {
    // The coverage wall colors each card by tierOf(id) — closed → Frontier, else
    // a GitHub-stars tier on its repo. A host missing from hostSource would fall
    // back to Frontier silently; a stray hostSource key would be dead data. Guard
    // an exact partition: every platform id has one entry, no stray keys, and
    // every entry is either { closed: true } or carries a non-empty "owner/name"
    // repo. tierOf must also resolve a tier for every host (never throw / undefined).
    const platformIds = new Set(landingPlatforms.map((p) => p.id));
    const sourceIds = new Set(Object.keys(hostSource));
    expect([...sourceIds].sort()).toEqual([...platformIds].sort());
    for (const [id, src] of Object.entries(hostSource)) {
      if ("closed" in src) {
        expect(src.closed, `hostSource["${id}"].closed must be true`).toBe(true);
      } else {
        expect(src.repo, `hostSource["${id}"].repo must be "owner/name"`).toMatch(
          /^[^/\s]+\/[^/\s]+$/,
        );
      }
    }
    for (const p of landingPlatforms) {
      const tier = tierOf(p.id, "repo" in (hostSource[p.id] ?? {}) ? 1234 : undefined);
      expect(tier, `tierOf("${p.id}") returned no tier`).toBeTruthy();
    }
  });

  it("hostLinks gives EVERY landing platform exactly one valid source link", () => {
    // Each card's top-right icon links to hostLinks[id] — a verified GitHub repo
    // or a product homepage. A missing entry means no source link renders. Guard
    // an exact partition: one entry per platform id, no stray keys, and each is
    // either { kind:"github", repo:"owner/name" } or { kind:"home", url:"http(s)://…" }.
    const platformIds = new Set(landingPlatforms.map((p) => p.id));
    const linkIds = new Set(Object.keys(hostLinks));
    expect([...linkIds].sort()).toEqual([...platformIds].sort());
    for (const [id, link] of Object.entries(hostLinks)) {
      if (link.kind === "github") {
        expect(link.repo, `hostLinks["${id}"].repo must be "owner/name"`).toMatch(
          /^[^/\s]+\/[^/\s]+$/,
        );
      } else {
        expect(link.kind, `hostLinks["${id}"].kind`).toBe("home");
        expect(link.url, `hostLinks["${id}"].url must be an http(s) URL`).toMatch(
          /^https?:\/\/\S+$/,
        );
      }
    }
  });

  it("brandColor gives EVERY landing platform exactly one 6-digit hex", () => {
    // The coverage marquee (CoverageMarquee.tsx) tints each host NAME with
    // brandColor[id]. A missing entry would leave a host's name uncolored
    // (falling back to the default foreground). Guard an exact partition: one
    // entry per platform id, no stray keys, and each value a #RRGGBB hex.
    const platformIds = new Set(landingPlatforms.map((p) => p.id));
    const colorIds = new Set(Object.keys(brandColor));
    expect([...colorIds].sort()).toEqual([...platformIds].sort());
    for (const [id, hex] of Object.entries(brandColor)) {
      expect(hex, `brandColor["${id}"] must be a #RRGGBB hex`).toMatch(
        /^#[0-9a-fA-F]{6}$/,
      );
    }
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

  it("site nativeHooks prose count and list match adapter capabilities", async () => {
    const nativeHookIds: string[] = [];
    for (const factory of ADAPTER_REGISTRY) {
      const adapter = await factory.load();
      if (adapter.capabilities.supportsNativeHooks ?? false) nativeHookIds.push(factory.id);
    }
    nativeHookIds.sort();

    const docsContent = readFileSync("site/src/components/docs/DocsContent.tsx", "utf8");
    const docsData = readFileSync("site/src/components/docs/docs-data.ts", "utf8");
    const supportIdx = docsContent.indexOf("supportsNativeHooks");
    expect(supportIdx, "DocsContent nativeHooks prose not found").toBeGreaterThan(-1);
    const block = docsContent.slice(supportIdx - 120, supportIdx + 520);

    expect(block).toContain(`${nativeHookIds.length} adapters set`);
    expect(docsData).toContain(`Honored by the ${nativeHookIds.length} adapters`);
    for (const id of nativeHookIds) {
      expect(block, `DocsContent nativeHooks prose omits "${id}"`).toContain(id);
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
    expect(text).toContain("tests-passing");
    expect(text).not.toMatch(/tests-\d+%20passing/);
    const jsonStdioRow = text.split("\n").find((l) => l.includes("`json-stdio`") && l.includes("|"));
    expect(jsonStdioRow, "README json-stdio table row not found").toBeTruthy();
    expect(jsonStdioRow).toContain("Droid");
  });
});
