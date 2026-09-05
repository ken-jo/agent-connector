/**
 * Site metadata drift — the strings a search index and an agent's web search
 * actually read: the landing <title>, <meta name="description">, Open Graph,
 * the JSON-LD description, the docs default description, the /coverage
 * description, the npm description, and context7.json.
 *
 * Why this exists: #307 changed the promise from "every agent CLI" to "every
 * agent host" in the README and the landing copy, and site/index.html — the
 * one file search engines index for the homepage — kept the old title and
 * description for two days. The /coverage description still said "1k+ star
 * open-source" after the star floor was removed. These strings live in files
 * no other test reads, so they need their own guard.
 *
 * Each string must (a) carry the README's promise line, (b) quote the host
 * count that equals the registry, and (c) never say "agent CLI" for the scope
 * or "coverage matrix" as a stand-in for what the product covers.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ADAPTER_REGISTRY } from "../../src/adapters/registry.js";
import { DEFAULT_DESCRIPTION } from "../../site/src/components/docs/meta.js";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const PROMISE = "Deploy one MCP to every agent host";
const HOSTS = `${ADAPTER_REGISTRY.length} agent hosts`;
const STALE = [/agent CLIs?\b(?! logs of)/i, /coverage matrix/i];

function assertFresh(label: string, text: string): void {
  for (const re of STALE) {
    expect(text, `${label} still says "${re.source}"`).not.toMatch(re);
  }
}

/** Pull every attribute value / JSON string that carries user-visible copy. */
function headCopy(html: string): { title: string; descriptions: string[] } {
  const title = (html.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? "";
  const descriptions = [
    ...html.matchAll(/name="description"\s+content="([^"]*)"/g),
    ...html.matchAll(/property="og:description"\s+content="([^"]*)"/g),
    ...html.matchAll(/name="twitter:description"\s+content="([^"]*)"/g),
    ...html.matchAll(/"description":\s*"([^"]*)"/g),
  ].map((m) => m[1]!);
  const ogTitles = [
    ...html.matchAll(/property="og:title"\s+content="([^"]*)"/g),
    ...html.matchAll(/name="twitter:title"\s+content="([^"]*)"/g),
  ].map((m) => m[1]!);
  return { title, descriptions: [...descriptions, ...ogTitles] };
}

describe("landing metadata (site/index.html) carries the promise and the registry count", () => {
  const html = read("site/index.html");
  const { title, descriptions } = headCopy(html);

  it("title is the promise line", () => {
    expect(title).toBe(`agent-connector — ${PROMISE}`);
  });

  it("meta / og / twitter / JSON-LD descriptions all quote the host count and are not stale", () => {
    // description + og:description + twitter:description + JSON-LD description
    // + og:title + twitter:title
    expect(descriptions.length).toBeGreaterThanOrEqual(6);
    const bodies = descriptions.filter((d) => !d.startsWith("agent-connector — "));
    expect(bodies.length).toBeGreaterThanOrEqual(4);
    for (const d of bodies) expect(d, d).toContain(HOSTS);
    for (const d of descriptions) assertFresh("site/index.html", d);
  });
});

describe("route descriptions and the npm description quote the registry count", () => {
  it("docs DEFAULT_DESCRIPTION", () => {
    expect(DEFAULT_DESCRIPTION).toContain(HOSTS);
    assertFresh("docs/meta.ts DEFAULT_DESCRIPTION", DEFAULT_DESCRIPTION);
  });

  it("/coverage description in prerender.mjs and CoveragePage.tsx agree and carry the count", () => {
    const pre = read("site/scripts/prerender.mjs");
    const page = read("site/src/components/coverage-wall/CoveragePage.tsx");
    const m = pre.match(/route: "\/coverage",[\s\S]*?description:\s*\n?\s*"([^"]+)"/);
    expect(m, "coverage page def not found in prerender.mjs").toBeTruthy();
    const desc = m![1]!;
    expect(desc).toContain(`${ADAPTER_REGISTRY.length} terminal CLIs`);
    expect(page, "CoveragePage.tsx must set the same description the prerender writes").toContain(desc);
    assertFresh("/coverage description", desc);
  });

  it("og.png subtitle in prerender.mjs", () => {
    const pre = read("site/scripts/prerender.mjs");
    const m = pre.match(/<div class="sub">([^<]*)<\/div>/);
    expect(m).toBeTruthy();
    expect(m![1]!).toContain(HOSTS);
  });

  it("package.json description + keywords name the count and the host names an agent searches for", () => {
    const pkg = JSON.parse(read("package.json")) as { description: string; keywords: string[] };
    expect(pkg.description).toContain(`${ADAPTER_REGISTRY.length} agent hosts`);
    assertFresh("package.json description", pkg.description);
    // npm search ranks on keywords; every host an agent is likely to name must be one.
    for (const kw of ["mcp", "model-context-protocol", "claude-code", "codex", "cursor", "github-copilot", "gemini-cli", "windsurf", "zed", "agent-plugins", "agent-skills"]) {
      expect(pkg.keywords, `package.json keywords missing "${kw}"`).toContain(kw);
    }
    expect(pkg.keywords.length).toBeLessThanOrEqual(25);
  });

  it("context7.json parses, quotes the count, and excludes the non-doc trees", () => {
    const c7 = JSON.parse(read("context7.json")) as { description: string; excludeFolders: string[]; rules: string[] };
    expect(c7.description).toContain(HOSTS);
    for (const f of ["src", "tests", "site", "scripts"]) expect(c7.excludeFolders).toContain(f);
    expect(c7.rules.length).toBeGreaterThan(0);
    assertFresh("context7.json", JSON.stringify(c7));
  });
});

describe("README and landing agree on the promise", () => {
  it("README headline is the promise line", () => {
    expect(read("README.md")).toContain(`### ${PROMISE}.`);
  });
});
