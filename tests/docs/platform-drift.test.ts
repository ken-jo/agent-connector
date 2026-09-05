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

import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { BaseAdapter } from "../../src/adapters/base.js";
import { ADAPTER_REGISTRY } from "../../src/adapters/registry.js";
import { DRIVABLE_MARKETPLACE_PLATFORMS } from "../../src/core/marketplace-drivers/registry.js";
import { MARKETPLACE_FORMAT_BY_PLATFORM } from "../../src/core/marketplace.js";
import {
  adapterCapabilityCount,
  adapterCapabilityProfiles,
} from "../../site/src/adapter-capabilities.generated.js";
import {
  hostVerificationCount,
  hostVerificationResults,
} from "../../site/src/host-verification.generated.js";
import { releaseStatus } from "../../site/src/release-status.generated.js";
import {
  jsonStdioPlatforms,
  mcpOnlyPlatforms,
  tracks,
  tsPluginPlatforms,
} from "../../site/src/components/docs/docs-data.js";
import {
  agentPluginBadge,
  agentPluginSupport,
  brandColor,
  formFactorIds,
  formFactorOf,
  hostLifecycle,
  hostLinks,
  hostSource,
  isPublicCoverageHost,
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
    // adjacent hardcoded "(Warp, Trae, Zed, Amp, ...)" prose once drifted
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

  it("generated adapter capability snapshot matches the loaded registry", async () => {
    expect(adapterCapabilityCount).toBe(ADAPTER_REGISTRY.length);
    expect(adapterCapabilityProfiles.map((p) => p.id)).toEqual(
      ADAPTER_REGISTRY.map((f) => f.id),
    );

    for (const factory of ADAPTER_REGISTRY) {
      const adapter = await factory.load();
      const profile = adapterCapabilityProfiles.find((p) => p.id === factory.id);
      expect(profile, `generated capability snapshot is missing "${factory.id}"`).toBeTruthy();
      const caps = adapter.capabilities;
      expect(profile).toEqual({
        id: factory.id,
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

  it("supporting statusline/action adapters override the BaseAdapter skip-warn defaults", async () => {
    for (const factory of ADAPTER_REGISTRY) {
      const adapter = await factory.load();
      if (adapter.capabilities.supportsStatusline ?? false) {
        expect(
          adapter.installStatusline,
          `${factory.id} advertises supportsStatusline but uses BaseAdapter.installStatusline`,
        ).not.toBe(BaseAdapter.prototype.installStatusline);
        expect(
          adapter.uninstallStatusline,
          `${factory.id} advertises supportsStatusline but uses BaseAdapter.uninstallStatusline`,
        ).not.toBe(BaseAdapter.prototype.uninstallStatusline);
        expect(typeof adapter.parseStatusInput, `${factory.id} missing parseStatusInput`).toBe(
          "function",
        );
        expect(typeof adapter.formatStatusOutput, `${factory.id} missing formatStatusOutput`).toBe(
          "function",
        );
      }

      if (adapter.capabilities.supportsActions ?? false) {
        expect(
          adapter.installActions,
          `${factory.id} advertises supportsActions but uses BaseAdapter.installActions`,
        ).not.toBe(BaseAdapter.prototype.installActions);
        expect(
          adapter.uninstallActions,
          `${factory.id} advertises supportsActions but uses BaseAdapter.uninstallActions`,
        ).not.toBe(BaseAdapter.prototype.uninstallActions);
      }
    }
  });

  it("generated host verification snapshot partitions the registry ids", () => {
    expect(hostVerificationCount).toBe(ADAPTER_REGISTRY.length);
    expect(hostVerificationResults.map((row) => row.host).sort()).toEqual(
      ADAPTER_REGISTRY.map((f) => f.id).sort(),
    );
  });

  it("generated release status snapshot matches local package and workflow files", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(releaseStatus.packageName).toBe(pkg.name);
    expect(releaseStatus.localVersion).toBe(pkg.version);
    expect(releaseStatus.ciWorkflow.present).toBe(true);
    expect(releaseStatus.deployWorkflow.present).toBe(true);
    expect(releaseStatus.releaseWorkflow.present).toBe(true);
    expect(readFileSync(releaseStatus.ciWorkflow.path, "utf8")).toContain("npm run typecheck");
    expect(readFileSync(releaseStatus.deployWorkflow.path, "utf8")).toContain("npm run build");
    expect(readFileSync(releaseStatus.releaseWorkflow.path, "utf8")).toContain("npm publish");
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

  it("README host badge carries the registry count and Droid sits in the json-stdio row", () => {
    // The badge used to be de-numbered ("see /coverage") to stop it rotting.
    // The README now quotes numbers on purpose — they are the evidence a
    // reader or a search index ranks on — so the guard flipped: the number
    // must EQUAL the registry, not be absent. tests/docs/readme-facts.test.ts
    // pins the rest of the fact table the same way.
    const text = readFileSync("README.md", "utf8");
    expect(text).toContain(`agent%20hosts-${ADAPTER_REGISTRY.length}-`);
    expect(text).toContain("https://agent-connector.ai/coverage");
    expect(text).not.toContain("platform%20coverage-see%20%2Fcoverage");
    expect(text).not.toContain("tests-passing-");
    // The paradigm TABLE row, not the "By the numbers" row that also names the
    // paradigm — the table row is the one that lists hosts.
    const jsonStdioRow = text.split("\n").find((l) => l.startsWith("| `json-stdio`"));
    expect(jsonStdioRow, "README json-stdio table row not found").toBeTruthy();
    expect(jsonStdioRow).toContain("Droid");
  });

  it("README documents every MCP launch shape without external product leakage", () => {
    const text = readFileSync("README.md", "utf8");
    const launchExamplesIdx = text.indexOf("### MCP server launch examples");
    expect(launchExamplesIdx, "README launch examples section missing").toBeGreaterThan(-1);
    const deployCommandsIdx = text.indexOf("```bash", launchExamplesIdx);
    expect(deployCommandsIdx, "README deploy command block missing after launch examples").toBeGreaterThan(-1);
    const launchExamples = text.slice(launchExamplesIdx, deployCommandsIdx);

    for (const phrase of [
      "Minimal launch",
      "`npx -y @acme/acme-db-mcp`",
      "`uv run --with mcp ./my_mcp_server.py`",
      "Each snippet below is the `server` field",
      "**Package-runner MCP**",
      'command: "npx"',
      "**Local server-process MCP**",
      'command: "node"',
      "**Python MCP**",
      'command: "uv"',
      'args: ["run", "--with", "mcp", "./my_mcp_server.py"]',
      "**CLI-based MCP**",
      'args: ["mcp", "serve"]',
      "**Remote server MCP**",
      'transport: "http"',
    ]) {
      expect(launchExamples).toContain(phrase);
    }

    // These strings came from an external reference during design review. The
    // README should keep the generalized launch-shape contract, not advertise a
    // referenced product or unrelated MCP domain as if it were our own model.
    expect(launchExamples).not.toMatch(/Headroom|headroom|context-compression|context-cache/i);
  });

  it("public site metadata routes host counts to the coverage matrix", () => {
    const indexHtml = readFileSync("site/index.html", "utf8");
    const prerender = readFileSync("site/scripts/prerender.mjs", "utf8");
    const sitePackage = JSON.parse(readFileSync("site/package.json", "utf8"));
    const publicSectionFiles = [
      "site/src/components/sections/Hero.tsx",
      "site/src/components/sections/Audiences.tsx",
      "site/src/components/sections/Efficiency.tsx",
    ];
    const nav = readFileSync("site/src/components/sections/Nav.tsx", "utf8");
    const landing = readFileSync("site/src/components/Landing.tsx", "utf8");
    const docs = readFileSync("site/src/components/docs/DocsContent.tsx", "utf8");

    // The landing head and the og.png subtitle QUOTE the registry count now —
    // numbers are the evidence a search index ranks on — so the old
    // "de-number, route to the coverage matrix" guard is inverted: the count
    // must equal the registry and the vague phrase must be gone. The full
    // string-by-string check lives in tests/docs/site-meta-drift.test.ts.
    for (const text of [indexHtml, prerender]) {
      expect(text).toContain(`${ADAPTER_REGISTRY.length} agent hosts`);
      expect(text).not.toContain("current AI-agent coverage matrix");
    }
    for (const file of publicSectionFiles) {
      const text = readFileSync(file, "utf8");
      expect(text, `${file} must use the public coverage count`).toContain(
        "publicCoverageCount",
      );
      expect(text, `${file} must not expose the full internal registry count`).not.toContain(
        "platformCount",
      );
    }
    // "agent hosts", not "agents" or "agent CLIs": the promise covers every
    // config-owning surface (CLI, IDE extension, desktop app), and the noun is
    // load-bearing — see PROJECT_MEMORY "Current Product Direction".
    expect(docs).toContain("publicCoverageCount} production-relevant agent hosts");
    expect(docs).toContain("publicCapabilityProfiles.length");
    expect(docs).toContain("internal full registry currently has");
    expect(docs).not.toContain("{platformCount} registered deploy adapters");
    expect(docs).not.toContain("{platformCount}-adapter");
    expect(docs).not.toContain("{statuslineHostNames.length} / {adapterCapabilityCount}");
    expect(docs).not.toContain("{actionHostNames.length} / {adapterCapabilityCount}");
    for (const label of ["Home", "Coverage", "Telemetry", "Docs", "Wizard", "Blog"]) {
      expect(nav).toContain(`label: "${label}"`);
    }
    for (const removed of ["Efficiency", "Matrix", "Surfaces"]) {
      expect(nav).not.toContain(`label: "${removed}"`);
    }
    expect(nav).toContain('to === "/" ? pathname === "/" : pathname.startsWith(to)');
    expect(nav).toContain('to: "/coverage", label: "Coverage"');
    expect(nav).toContain('to: "/telemetry", label: "Telemetry"');
    expect(landing).toContain("useLocation");
    expect(landing).toContain("document.title = LANDING_TITLE");
    expect(landing).toContain("setMetaDescription(DEFAULT_DESCRIPTION)");
    expect(landing).toContain("target.scrollIntoView");
    expect(sitePackage.scripts.prebuild).toContain(
      "generate-site-adapter-capabilities.mjs",
    );
    expect(sitePackage.scripts.prebuild).toContain(
      "generate-site-verification-results.mjs",
    );
    expect(sitePackage.scripts.prebuild).toContain(
      "generate-site-release-status.mjs",
    );
  });

  it("blog discovery exposes an RSS feed from the prerendered blog data", () => {
    const indexHtml = readFileSync("site/index.html", "utf8");
    const prerender = readFileSync("site/scripts/prerender.mjs", "utf8");
    const blogData = readFileSync("site/src/components/blog/blog-data.ts", "utf8");
    const blogPage = readFileSync("site/src/components/blog/BlogPage.tsx", "utf8");
    const blogPostPage = readFileSync("site/src/components/blog/BlogPostPage.tsx", "utf8");

    expect(indexHtml).toContain('type="application/rss+xml"');
    expect(indexHtml).toContain('href="https://agent-connector.ai/feed.xml"');
    expect(prerender).toContain("blogPosts");
    expect(prerender).toContain("feed.xml");
    expect(blogData).toContain('slug: "building"');
    expect(blogData).toContain('title: "BUILDING..."');
    expect(blogData).toContain('src: "/blog/building-cover.svg"');
    expect(blogData).not.toContain("mcp-implementation-starts-with-product-identity");
    expect(blogPage).toContain('href="/feed.xml"');
    expect(blogPage).toContain("post.heroImage.src");
    expect(blogPostPage).toContain("post.heroImage.caption");
    expect(existsSync("site/public/blog/building-cover.svg")).toBe(true);
  });

  it("agent-connector beginner guide lives in the root Guides track and stays expandable", () => {
    const guideIds = tracks.guides.groups.flatMap((group) => group.items.map((item) => item.id));
    const devIds = tracks.dev.groups.flatMap((group) => group.items.map((item) => item.id));
    const app = readFileSync("site/src/App.tsx", "utf8");
    const docs = readFileSync("site/src/components/docs/DocsContent.tsx", "utf8");
    const sidebar = readFileSync("site/src/components/docs/DocsSidebar.tsx", "utf8");
    const prerender = readFileSync("site/scripts/prerender.mjs", "utf8");

    expect(tracks.guides.basePath).toBe("/docs/guides");
    expect(guideIds).toEqual([
      "mcp-beginner",
      "publish-mcp-server",
      "beginner-demo-lab",
      "first-mcp-server",
      "connect-first-host",
      "first-connector-surfaces",
      "connector-concepts",
      "host-hooks",
      "hud-statusline",
      "actions-guide",
      "special-surfaces",
    ]);
    expect(devIds).not.toContain("mcp-beginner");
    expect(devIds).not.toContain("mcp-101");
    expect(app).toContain('path="/docs/guides"');
    expect(app).toContain('to="/docs/guides/mcp-beginner"');
    expect(app).toContain('path="/docs/dev/mcp-101"');
    expect(prerender).toContain('route: "/docs/dev/mcp-101"');
    expect(docs).toContain('DocSection id="mcp-beginner"');
    expect(docs).toContain('DocSection id="beginner-demo-lab"');
    expect(docs).toContain('eyebrow="Guides" title="Agent-connector beginner guide"');
    expect(docs).toContain('title="Beginner demo lab"');
    expect(docs).toContain("npm run demo");
    expect(docs).toContain("scripts/demo-smoke.mjs");
    expect(docs).toContain("Capture docs-ready demo screenshots");
    expect(readFileSync("site/src/components/docs/DocsTable.tsx", "utf8")).toContain(
      "docs-table-shell",
    );
    expect(readFileSync("site/src/index.css", "utf8")).toContain(
      ".docs-table-shell + .docs-table-shell",
    );
    expect(readFileSync("site/src/components/ui/code-block.tsx", "utf8")).toContain(
      "docs-code-block",
    );
    expect(readFileSync("site/src/index.css", "utf8")).toContain(
      ".docs-code-block + .docs-code-block",
    );
    expect(docs).toContain("new to agent-connector");
    expect(docs).toContain("MCP concepts underneath it");
    expect(docs).toContain("what each connector surface does");
    expect(docs).toContain("/docs/mcp-beginner-architecture.svg");
    expect(docs).toContain("Architecture map: who owns what?");
    expect(docs).toContain("How an MCP server actually runs");
    expect(docs).toContain('title="Build your first MCP server"');
    expect(docs).toContain('title="Connect your first host"');
    expect(docs).toContain('title="Add your first connector surfaces"');
    expect(docs).toContain("McpServer");
    expect(docs).toContain("registerTool");
    expect(docs).toContain("structuredContent");
    expect(docs).toContain("@modelcontextprotocol/sdk@^1.29.0");
    expect(docs).toContain("@modelcontextprotocol/inspector");
    expect(docs).toContain("Hooks: the layer around MCP, not the MCP server itself");
    expect(docs).toContain("Add agent-connector only after the server works");
    expect(docs).toContain('title="Host hooks by CLI"');
    expect(docs).toContain("Official host surfaces to know first");
    expect(docs).toContain("https://docs.anthropic.com/en/docs/claude-code/hooks");
    expect(docs).toContain("https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md");
    expect(docs).toContain("https://developers.openai.com/codex/hooks/");
    expect(docs).toContain("https://opencode.ai/docs/plugins/");
    expect(docs).toContain("agent-connector hook claude-code PreToolUse --connector acme-db");
    expect(docs).toContain("tool.execute.before");
    expect(docs).toContain('title="HUD / statusline"');
    expect(docs).toContain("Cross-validation for supported hosts");
    expect(docs).toContain("https://docs.anthropic.com/en/docs/claude-code/statusline");
    expect(docs).toContain("https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/status-line.md");
    expect(docs).toContain("defineStatusline");
    expect(docs).toContain("agent-connector statusline claude-code --connector acme-db");
    expect(docs).toContain('title="Actions"');
    expect(docs).toContain("Cross-validation for action hosts");
    expect(docs).toContain("agent-connector action warp refresh-index --connector acme-db");
    expect(docs).toContain("OpenCode plugin model");
    expect(docs).toContain('title="Commands, skills, subagents & memory"');
    expect(sidebar).toContain("items-start");
    expect(sidebar).toContain("min-w-0 flex-1 text-left");
    expect(sidebar).toContain("text-[0.78rem]");
    expect(sidebar).toContain("text-[0.68rem]");
    expect(sidebar).toContain("text-[0.82rem] leading-5");
    expect(existsSync("site/public/docs/mcp-beginner-architecture.svg")).toBe(true);
  });

  it("guide support evidence tables cover every generated statusline/action host", () => {
    const docs = readFileSync("site/src/components/docs/DocsContent.tsx", "utf8");
    const statuslineBlock = docs.slice(
      docs.indexOf("const statuslineCrossValidationRows"),
      docs.indexOf("const actionCrossValidationRows"),
    );
    const actionBlock = docs.slice(
      docs.indexOf("const actionCrossValidationRows"),
      docs.indexOf("/* ================================================================== */"),
    );

    for (const profile of adapterCapabilityProfiles.filter((p) => p.surfaces.statusline)) {
      expect(
        statuslineBlock,
        `statusline evidence table omits generated support host "${profile.name}"`,
      ).toContain(`host: "${profile.name}"`);
    }
    for (const profile of adapterCapabilityProfiles.filter((p) => p.surfaces.actions)) {
      expect(
        actionBlock,
        `action evidence table omits generated support host "${profile.name}"`,
      ).toContain(`host: "${profile.name}"`);
    }
  });

  it("example connector comments foreground the package-first path", () => {
    const example = readFileSync("examples/acme-db/agent-connector.config.mjs", "utf8");
    const packageFirstIdx = example.indexOf("Package-first path:");
    const fallbackIdx = example.indexOf("Framework fallback");
    expect(packageFirstIdx, "example package-first guidance missing").toBeGreaterThan(-1);
    expect(fallbackIdx, "example framework fallback guidance missing").toBeGreaterThan(-1);
    expect(packageFirstIdx).toBeLessThan(fallbackIdx);
    expect(example.slice(fallbackIdx, fallbackIdx + 120)).toContain("local development/debug only");
  });

  it("packaging examples use framework tooling while MCP lifecycle stays branded", () => {
    const readme = readFileSync("README.md", "utf8");
    const snippets = readFileSync("site/src/components/docs/snippets.ts", "utf8");
    const guide = readFileSync("site/src/components/docs/PackagingGuide.tsx", "utf8");
    const wizard = readFileSync("site/src/components/wizard/WizardPage.tsx", "utf8");
    const brandedExample = readFileSync("examples/branded-cli/README.md", "utf8");
    const architecture = readFileSync("docs/ARCHITECTURE.md", "utf8");

    const readmePackageIdx = readme.indexOf("npx @ken-jo/agent-connector package");
    const readmeGlobalIdx = readme.indexOf("if you already keep the framework CLI globally installed");
    expect(readmePackageIdx, "README framework package command missing").toBeGreaterThan(-1);
    expect(readmeGlobalIdx, "README global framework package note missing").toBeGreaterThan(-1);
    expect(readmePackageIdx).toBeLessThan(readmeGlobalIdx);

    expect(readme).toContain("acme-db install --method marketplace");
    expect(readme).not.toContain("acme-db package");
    expect(snippets).toContain("npx @ken-jo/agent-connector package --connector");
    expect(snippets).toContain("agent-connector package --connector ./agent-connector.config.mjs");
    expect(snippets).not.toContain("acme-db package");
    expect(brandedExample).toContain("npx @ken-jo/agent-connector package --connector");
    expect(brandedExample).not.toContain("acme-db package");
    expect(architecture).toContain("framework tooling: 9 host bundle formats");
    expect(guide).toContain("<Badge variant=\"muted\">npx @ken-jo/agent-connector package</Badge>");
    expect(guide).toContain("Packaging emits distribution artifacts");
    expect(wizard).toContain('title="Add the framework dependency"');
  });

  it("global framework install guidance is user telemetry first and excludes branded lifecycle", () => {
    const readme = readFileSync("README.md", "utf8");
    const snippets = readFileSync("site/src/components/docs/snippets.ts", "utf8");
    const docs = readFileSync("site/src/components/docs/DocsContent.tsx", "utf8");
    const docsData = readFileSync("site/src/components/docs/docs-data.ts", "utf8");

    for (const text of [readme, snippets, docs, docsData]) {
      expect(text).not.toMatch(/global(?: framework)? install is only for connector-free/i);
      expect(text).not.toMatch(/globally is only an optional path for connector-free/i);
    }

    expect(readme).toContain("global CLI guidance for connector-free token usage reports");
    expect(readme).not.toContain("connector-free token usage reports or frequent framework tooling");
    expect(snippets).toContain("agent users for connector-free token telemetry");
    expect(snippets).not.toContain("frequent framework tooling such as package");
    expect(docs).toContain("agent users use the global");
    expect(docs).toContain("Developers can");
    expect(docsData).toContain("Global framework CLI guidance is for connector-free agent token telemetry");
    expect(docsData).not.toContain("Global framework CLI is for connector-free telemetry or framework tooling");
    expect(docs).toContain("You do <strong>not</strong> need a global install for branded MCP");
  });

  /**
   * The site quotes the marketplace-drivable host COUNT and the catalog-driver
   * roster in prose (data.ts install methods + CLI table, docs-data packaging
   * blurb). Those numbers went stale the moment copilot-cli gained a driver, so
   * pin them to DRIVABLE_MARKETPLACE_PLATFORMS instead of trusting a hand count.
   */
  it("site marketplace prose quotes the real drivable-host count and names every catalog host", () => {
    const data = readFileSync("site/src/data.ts", "utf8");
    const docsData = readFileSync("site/src/components/docs/docs-data.ts", "utf8");
    const count = new Set(DRIVABLE_MARKETPLACE_PLATFORMS).size;

    expect(count, "no marketplace drivers resolved").toBeGreaterThanOrEqual(3);
    expect(data, "site install-method scope quotes a stale drivable-host count").toContain(
      `Drives ${count} hosts:`,
    );
    expect(data, "site CLI table quotes a stale drivable-host count").toContain(
      `marketplace/plugin flow for ${count} hosts`,
    );
    expect(
      docsData,
      "docs-data packaging blurb quotes a stale drivable-host count",
    ).toContain(`DRIVEN end-to-end for ${count} hosts`);

    // Every CATALOG-driver host must be named in the packaging blurb's roster.
    const catalogHosts = ["Claude Code", "Codex", "GitHub Copilot CLI", "Droid"];
    const blurbCatalog = docsData.slice(
      docsData.indexOf("DRIVEN end-to-end for"),
      docsData.indexOf("NPM-LOCAL file:// config entry"),
    );
    for (const host of catalogHosts) {
      expect(blurbCatalog, `docs-data catalog roster omits "${host}"`).toContain(host);
    }
  });

  it("agentPluginSupport matches the platforms actually routed to the agent-plugin format", () => {
    // The wall's "AP 1.0" marker is a DELIVERY claim, so it must be derived from
    // the same routing table the packager uses. delivered ∪ delegated has to
    // EQUAL the agent-plugin-routed platforms — a routing change that forgets
    // this map would otherwise leave the site advertising a bundle we no longer
    // ship (or hiding one we do).
    const routed = new Set(
      Object.entries(MARKETPLACE_FORMAT_BY_PLATFORM)
        .filter(([, format]) => format === "agent-plugin")
        .map(([id]) => id),
    );
    const shipped = new Set(
      Object.entries(agentPluginSupport)
        .filter(([, state]) => state === "delivered" || state === "delegated")
        .map(([id]) => id),
    );
    expect([...shipped].sort(), "agentPluginSupport disagrees with MARKETPLACE_FORMAT_BY_PLATFORM").toEqual(
      [...routed].sort(),
    );

    // A "client" host reads the spec but gets its OWN format from us — so it
    // must NOT be routed to agent-plugin, or the label contradicts the routing.
    for (const [id, state] of Object.entries(agentPluginSupport)) {
      if (state !== "client") continue;
      expect(
        MARKETPLACE_FORMAT_BY_PLATFORM[id as keyof typeof MARKETPLACE_FORMAT_BY_PLATFORM],
        `agentPluginSupport["${id}"] is "client" but the packager routes it to agent-plugin`,
      ).not.toBe("agent-plugin");
    }

    // No dangling keys, and every state has badge copy to render.
    const ids = new Set(landingPlatforms.map((p) => p.id));
    for (const [id, state] of Object.entries(agentPluginSupport)) {
      expect(ids.has(id), `agentPluginSupport["${id}"] is not a known platform id`).toBe(true);
      expect(agentPluginBadge[state], `agentPluginBadge is missing "${state}"`).toBeDefined();
    }
  });

  it("ARCHITECTURE.md paradigm taxonomy counts match the registry", async () => {
    // These three counts were hand-maintained and had silently drifted to
    // 18/8/9 while the registry said 23/8/12 — nothing guarded them. Pin the
    // NUMBERS to the registry so the next adapter addition fails here instead
    // of quietly making the architecture doc lie.
    const truth = await registryParadigms();
    const doc = readFileSync(
      new URL("../../docs/ARCHITECTURE.md", import.meta.url),
      "utf8",
    );
    for (const paradigm of ["json-stdio", "ts-plugin", "mcp-only"] as const) {
      expect(
        doc,
        `ARCHITECTURE.md paradigm taxonomy quotes a stale \`${paradigm}\` count`,
      ).toContain(`**\`${paradigm}\`** (${truth[paradigm]!.length})`);
    }
  });

  it("every non-archived host is public, and archived hosts never are", () => {
    // Breadth is the product: comparing many hosts is how the shared patterns
    // get found, so the public wall shows the whole registry. This guard exists
    // because the wall has twice grown a quiet star filter that ranked hosts by
    // a number nobody trusts — it hid Grok CLI (3.4k) and Xum (2.0k) while
    // listing Junie (422). Re-introducing one has to break a test, not a page.
    for (const platform of landingPlatforms) {
      const archived = hostLifecycle[platform.id]?.status === "archived";
      expect(
        isPublicCoverageHost(platform),
        archived
          ? `"${platform.id}" is archived upstream but still renders on public coverage`
          : `"${platform.id}" is hidden from public coverage — only an archived upstream may be`,
      ).toBe(!archived);
    }
  });

  it("hostLifecycle marks only real platforms and carries its evidence", () => {
    // Absence means "active", so this guard only has to catch dangling keys and
    // empty markers — a renamed or dropped host must not leave an EOL badge on
    // the wall, and a badge with no note would be an unsourced claim.
    const ids = new Set(landingPlatforms.map((p) => p.id));
    for (const [id, entry] of Object.entries(hostLifecycle)) {
      expect(ids.has(id), `hostLifecycle["${id}"] is not a known platform id`).toBe(true);
      expect(["archived", "sunsetting"]).toContain(entry.status);
      expect(entry.label.length, `hostLifecycle["${id}"].label is empty`).toBeGreaterThan(0);
      expect(
        entry.note.length,
        `hostLifecycle["${id}"].note must cite why the host is marked`,
      ).toBeGreaterThan(40);
    }
  });
});
