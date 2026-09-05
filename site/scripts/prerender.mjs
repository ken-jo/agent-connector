/**
 * Postbuild prerender for GitHub Pages SEO.
 *
 * GitHub Pages serves only files that exist; every SPA deep link otherwise
 * falls through to 404.html with an HTTP 404 status, which Google refuses to
 * index. This script runs after `vite build` and:
 *
 *  1. Writes a real dist/<route>/index.html (and dist/<route>.html, so the
 *     extensionless canonical URL itself answers 200 without a slash
 *     redirect) for EVERY real route — a copy of the built index.html with
 *     route-specific <title>, meta description, canonical, and og/twitter
 *     tags. The SPA hydrates over it on load.
 *  2. Writes noindex stubs for legacy /docs URLs: each
 *     carries <link rel="canonical"> to its new tracked URL plus
 *     <meta name="robots" content="noindex"> (the SPA client-redirects on
 *     load), so old indexed links resolve 200 without competing in the index.
 *  3. Generates dist/sitemap.xml (real routes only — never the legacy stubs).
 *  4. Tries to generate a 1200x630 dist/og.png with playwright-core. If no
 *     Chromium executable can be found, the og:image/twitter:image tags are
 *     stripped from every emitted page instead (a 404 image is worse than
 *     none).
 *
 * Route + description data is single-sourced from src/components/docs/
 * docs-data.ts and meta.ts. Those modules are dependency-free data modules,
 * so we load them WITHOUT a TS loader by transpiling with the `typescript`
 * package (already a devDependency, used by `tsc -b` in the same build).
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(siteDir, "dist");

const ORIGIN = "https://agent-connector.ai";

/* ------------------------------------------------------------------ */
/* Load route data from the TS source (single-sourced, no TS loader)   */
/* ------------------------------------------------------------------ */

/** Transpile + evaluate a dependency-free TS data module, returning exports. */
function loadTsDataModule(relPath) {
  const file = path.join(siteDir, relPath);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const mod = { exports: {} };
  new Function("exports", "module", "require", outputText)(
    mod.exports,
    mod,
    () => {
      throw new Error(`${relPath} unexpectedly has runtime imports`);
    },
  );
  return mod.exports;
}

const docsData = loadTsDataModule("src/components/docs/docs-data.ts");
const blogData = loadTsDataModule("src/components/blog/blog-data.ts");
const meta = loadTsDataModule("src/components/docs/meta.ts");

const {
  tracks,
  trackIds,
  trackOrder,
  sectionLabel,
  sectionDescription,
  legacyRedirects,
} = docsData;
const { blogPosts } = blogData;
const DEFAULT_DESCRIPTION = meta.DEFAULT_DESCRIPTION;

for (const [name, value] of Object.entries({
  tracks,
  trackIds,
  trackOrder,
  sectionLabel,
  sectionDescription,
  legacyRedirects,
  blogPosts,
  DEFAULT_DESCRIPTION,
})) {
  if (!value) throw new Error(`docs-data export missing: ${name}`);
}

/* ------------------------------------------------------------------ */
/* Route table                                                          */
/* ------------------------------------------------------------------ */

/** @typedef {{ route: string; title: string; description: string }} PageDef */

/** Real, indexable routes (these also become the sitemap). */
const pages = [
  // "/" keeps the brand title + landing description from the built index.html.
  { route: "/", title: null, description: null },
  // The dedicated coverage matrix page — title/description match what
  // CoveragePage sets client-side.
  {
    route: "/coverage",
    title: "Coverage — agent-connector",
    description:
      "Every agent host agent-connector deploys to — 42 terminal CLIs, IDE extensions and desktop apps — with each host's hook paradigm, supported surfaces, verification level and star count.",
  },
  {
    route: "/telemetry",
    title: "Telemetry — agent-connector",
    description:
      "agent-connector token telemetry shows local-first, platform-independent per-tool cost leaderboards for MCP servers, hooks, actions, and host usage.",
  },
  // The standalone connector scaffold generator — title/description match what
  // WizardPage sets client-side.
  {
    route: "/wizard",
    title: "Connector wizard — agent-connector",
    description:
      "Generate package-aware defineConnector code for a branded MCP package — pick your package, transport, hook events and surfaces and copy the scaffold.",
  },
  {
    route: "/blog",
    title: "Blog — agent-connector",
    description:
      "agent-connector blog is being built. This temporary post verifies routing, RSS, and image rendering before real articles are published.",
  },
  // The persona chooser — title matches what DocsChooser sets client-side.
  { route: "/docs", title: "Docs — agent-connector", description: DEFAULT_DESCRIPTION },
];

for (const post of blogPosts) {
  pages.push({
    route: `/blog/${post.slug}`,
    title: `${post.title} — agent-connector blog`,
    description: post.description,
  });
}

for (const trackId of trackIds) {
  const track = tracks[trackId];
  const firstSection = trackOrder[trackId][0];
  // Track home (/docs/dev, /docs/user) renders its first section.
  pages.push({
    route: track.basePath,
    title: `${track.label} — agent-connector docs`,
    description: sectionDescription[firstSection] || DEFAULT_DESCRIPTION,
    section: firstSection,
  });
  for (const id of trackOrder[trackId]) {
    pages.push({
      route: `${track.basePath}/${id}`,
      title: `${sectionLabel[id]} — agent-connector docs`,
      description: sectionDescription[id] || DEFAULT_DESCRIPTION,
      section: id,
    });
  }
}

/** Legacy pre-track /docs/<id> URLs → 200 noindex stubs canonicalized to the new URL. */
const legacyStubs = Object.entries(legacyRedirects).map(([id, target]) => ({
  route: `/docs/${id}`,
  target,
  title: `${sectionLabel[target.split("/").pop()] ?? "Docs"} — agent-connector docs`,
  description: sectionDescription[target.split("/").pop()] || DEFAULT_DESCRIPTION,
}));

/** Moved tracked URLs → 200 noindex stubs canonicalized to the new URL. */
const movedRouteStubs = [
  {
    route: "/docs/dev/mcp-101",
    target: "/docs/guides/mcp-beginner",
    title: `${sectionLabel["mcp-beginner"]} — agent-connector docs`,
    description: sectionDescription["mcp-beginner"] || DEFAULT_DESCRIPTION,
  },
];

const noindexStubs = [...legacyStubs, ...movedRouteStubs];

/* ------------------------------------------------------------------ */
/* og.png generation (best-effort)                                      */
/* ------------------------------------------------------------------ */

const OG_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px;
    display: flex; flex-direction: column; justify-content: center;
    padding: 0 96px; gap: 36px;
    background: #0a0a0b;
    background-image: radial-gradient(ellipse 80% 60% at 70% -10%, rgba(99, 102, 241, 0.22), transparent),
      radial-gradient(ellipse 60% 50% at 10% 110%, rgba(20, 184, 166, 0.12), transparent);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #fafafb;
  }
  .brand { display: flex; align-items: center; gap: 18px; }
  .mark { width: 52px; height: 52px; border-radius: 14px;
    background: linear-gradient(135deg, #6366f1, #14b8a6);
    display: flex; align-items: center; justify-content: center;
    font-family: ui-monospace, "JetBrains Mono", monospace; font-size: 26px; font-weight: 700; color: #fff; }
  .name { font-family: ui-monospace, "JetBrains Mono", monospace; font-size: 34px; font-weight: 600; letter-spacing: -0.5px; }
  h1 { font-size: 64px; font-weight: 800; letter-spacing: -2px; line-height: 1.12; max-width: 980px; }
  h1 .accent { color: #818cf8; }
  .sub { font-size: 28px; line-height: 1.45; color: #a1a1aa; max-width: 940px; }
  .url { position: absolute; bottom: 52px; left: 96px; font-family: ui-monospace, monospace; font-size: 24px; color: #71717a; }
</style></head>
<body>
  <div class="brand"><div class="mark">ac</div><div class="name">agent-connector</div></div>
  <h1>Write your MCP server + hooks once.<br><span class="accent">Ship to every agent.</span></h1>
  <div class="sub">One defineConnector() ships your MCP server, hooks, commands, skills &amp; subagents to 42 agent hosts.</div>
  <div class="url">agent-connector.ai</div>
</body></html>`;

/** Find a launchable Chromium for playwright-core, or null. */
function chromiumCandidates(chromium) {
  /** @type {{ label: string; opts: object }[]} */
  const candidates = [];
  // 1. The bundled-registry path (works when `playwright install` ran for this version).
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) candidates.push({ label: p, opts: { executablePath: p } });
  } catch {
    /* no registry install */
  }
  // 2. Branded-browser channels (GitHub Actions ubuntu runners ship Chrome).
  for (const channel of ["chrome", "msedge"]) {
    candidates.push({ label: `channel:${channel}`, opts: { channel } });
  }
  // 3. Common system executables.
  for (const p of [
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/opt/google/chrome/chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ]) {
    if (p && existsSync(p)) candidates.push({ label: p, opts: { executablePath: p } });
  }
  // 4. Any chromium revision in the playwright browsers cache (version-tolerant).
  const cacheRoot =
    process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== "0"
      ? process.env.PLAYWRIGHT_BROWSERS_PATH
      : path.join(os.homedir(), ".cache", "ms-playwright");
  if (existsSync(cacheRoot)) {
    const revs = readdirSync(cacheRoot)
      .filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d))
      .sort()
      .reverse();
    for (const rev of revs) {
      for (const rel of [
        "chrome-linux/headless_shell",
        "chrome-linux/chrome",
        "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        "chrome-mac/headless_shell",
      ]) {
        const p = path.join(cacheRoot, rev, rel);
        if (existsSync(p)) candidates.push({ label: p, opts: { executablePath: p } });
      }
    }
  }
  return candidates;
}

/** Try to render dist/og.png. Returns true on success. */
async function generateOgImage() {
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    console.warn("[prerender] playwright-core not installed — skipping og.png");
    return false;
  }
  for (const { label, opts } of chromiumCandidates(chromium)) {
    let browser;
    try {
      browser = await chromium.launch({ headless: true, chromiumSandbox: false, ...opts });
      const page = await browser.newPage({
        viewport: { width: 1200, height: 630 },
        deviceScaleFactor: 1,
      });
      await page.setContent(OG_HTML, { waitUntil: "load" });
      await page.screenshot({ path: path.join(distDir, "og.png") });
      await browser.close();
      console.log(`[prerender] og.png generated (via ${label})`);
      return true;
    } catch (err) {
      if (browser) await browser.close().catch(() => {});
      console.warn(`[prerender] og.png: ${label} failed: ${String(err.message ?? err).split("\n")[0]}`);
    }
  }
  console.warn("[prerender] no Chromium available — stripping og:image/twitter:image tags");
  return false;
}

/* ------------------------------------------------------------------ */
/* Head rewriting                                                       */
/* ------------------------------------------------------------------ */

const escapeHtml = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const escapeXml = (s) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

/** Replace one <meta …> tag's content attribute; throws if the tag is absent. */
function setMeta(html, attr, key, content) {
  // [^>]* matches newlines too — the source tags are multi-line formatted.
  const re = new RegExp(`<meta[^>]*${attr}="${key}"[^>]*/?>`);
  if (!re.test(html)) throw new Error(`index.html is missing <meta ${attr}="${key}">`);
  return html.replace(re, `<meta ${attr}="${key}" content="${escapeHtml(content)}" />`);
}

/**
 * Produce one prerendered page from the built index.html.
 * @param {string} builtHtml  dist/index.html as emitted by vite
 * @param {object} page       { route, title, description, canonicalTo?, noindex? }
 * @param {boolean} hasOgImage
 */
function renderPage(builtHtml, page, hasOgImage) {
  let html = builtHtml;
  const url = ORIGIN + (page.route === "/" ? "/" : page.route);
  const canonical = page.canonicalTo ? ORIGIN + page.canonicalTo : url;
  const isLanding = page.route === "/" && !page.canonicalTo;

  if (page.title) {
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(page.title)}</title>`);
    html = setMeta(html, "property", "og:title", page.title);
    html = setMeta(html, "name", "twitter:title", page.title);
  }
  if (page.description) {
    html = setMeta(html, "name", "description", page.description);
    html = setMeta(html, "property", "og:description", page.description);
    html = setMeta(html, "name", "twitter:description", page.description);
  }
  html = setMeta(html, "property", "og:url", url);

  // Canonical (the tag exists in the source index.html; rewrite per route).
  const canonRe = /<link rel="canonical" href="[^"]*" \/>/;
  if (!canonRe.test(html)) throw new Error("index.html is missing the canonical <link>");
  html = html.replace(canonRe, `<link rel="canonical" href="${canonical}" />`);

  // Legacy stubs: noindex (the SPA client-redirects to the canonical target).
  if (page.noindex) {
    html = html.replace(
      canonRe,
      (m) => `<meta name="robots" content="noindex" />\n    ${m}`,
    );
  }

  // JSON-LD is landing-only.
  if (!isLanding) {
    html = html.replace(/\n?[ \t]*<!-- Structured data[^>]*-->/, "");
    html = html.replace(/\n?[ \t]*<script type="application\/ld\+json">[\s\S]*?<\/script>/, "");
  }

  // Static section markup into the SPA shell, so clients that do not run
  // JavaScript (most AI/agent crawlers) still read the page body. The client
  // bundle replaces #root on mount.
  if (page.body) {
    const rootRe = /<div id="root"><\/div>/;
    if (!rootRe.test(html)) throw new Error('index.html is missing an empty <div id="root">');
    html = html.replace(rootRe, () => `<div id="root">${page.body}</div>`);
  }

  // No browser at build time → never ship a 404 og image.
  if (!hasOgImage) {
    html = html.replace(/\n?[ \t]*<meta[^>]*(property="og:image"|name="twitter:image")[^>]*\/>/g, "");
  }
  return html;
}

/** Write a route as both <route>.html and <route>/index.html (Pages serves
 *  the former for the extensionless URL with a clean 200, the latter for the
 *  trailing-slash variant). "/" rewrites dist/index.html in place. */
function writeRoute(route, html) {
  if (route === "/") {
    writeFileSync(path.join(distDir, "index.html"), html);
    return;
  }
  const rel = route.replace(/^\//, "");
  writeFileSync(path.join(distDir, `${rel}.html`), html);
  const dir = path.join(distDir, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "index.html"), html);
}

/* ------------------------------------------------------------------ */
/* Sitemap                                                              */
/* ------------------------------------------------------------------ */

function buildDate() {
  if (process.env.SITE_BUILD_DATE) return process.env.SITE_BUILD_DATE;
  try {
    return execSync("git log -1 --format=%cI", { cwd: siteDir, encoding: "utf8" })
      .trim()
      .slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Agent-facing plain-text files served beside the site (llms.txt convention). */
const agentFiles = ["/llms.txt", "/llms-full.txt", "/skills/agent-connector/SKILL.md"];

function sitemapXml(lastmod) {
  const urls = [...pages.map((p) => ({ route: p.route })), ...agentFiles.map((route) => ({ route }))]
    .map((p) => {
      const loc = ORIGIN + (p.route === "/" ? "/" : p.route);
      return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function rssDate(date) {
  return new Date(`${date}T00:00:00.000Z`).toUTCString();
}

function blogPostUrl(post) {
  return `${ORIGIN}/blog/${post.slug}`;
}

function feedXml() {
  const lastBuildDate = rssDate(blogPosts[0]?.date ?? buildDate());
  const items = blogPosts
    .map((post) => {
      const url = blogPostUrl(post);
      return [
        "    <item>",
        `      <title>${escapeXml(post.title)}</title>`,
        `      <link>${url}</link>`,
        `      <guid isPermaLink="true">${url}</guid>`,
        `      <description>${escapeXml(post.description)}</description>`,
        `      <category>${escapeXml(post.category)}</category>`,
        `      <pubDate>${rssDate(post.date)}</pubDate>`,
        "    </item>",
      ].join("\n");
    })
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    "  <channel>",
    "    <title>agent-connector blog</title>",
    `    <link>${ORIGIN}/blog</link>`,
    "    <description>agent-connector blog is being built. This temporary feed verifies routing, RSS, and image rendering before real articles are published.</description>",
    "    <language>en</language>",
    `    <lastBuildDate>${lastBuildDate}</lastBuildDate>`,
    items,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Main                                                                 */
/* ------------------------------------------------------------------ */

const indexFile = path.join(distDir, "index.html");
if (!existsSync(indexFile)) {
  throw new Error("dist/index.html not found — run `vite build` first");
}
const builtHtml = readFileSync(indexFile, "utf8");

const hasOgImage = await generateOgImage();

/**
 * Render docs section bodies with React on the server (src/entry-prerender.tsx,
 * built by Vite in SSR mode into dist-ssr/). Failure here is a build failure:
 * shipping body-less docs pages again would silently undo what this is for.
 */
async function loadDocsRenderer() {
  execSync("npx vite build --ssr src/entry-prerender.tsx --outDir dist-ssr --emptyOutDir --logLevel warn", {
    cwd: siteDir,
    stdio: "inherit",
  });
  return import(path.join(siteDir, "dist-ssr", "entry-prerender.js"));
}
const docsRenderer = await loadDocsRenderer();
let renderedBodies = 0;
for (const page of pages) {
  if (!page.section) continue;
  const body = docsRenderer.renderDocsSection(page.section, page.route);
  if (!body) throw new Error(`prerender: no component registered for docs section "${page.section}"`);
  page.body = body;
  renderedBodies++;
}

for (const page of pages) {
  writeRoute(page.route, renderPage(builtHtml, page, hasOgImage));
}
for (const stub of noindexStubs) {
  writeRoute(
    stub.route,
    renderPage(
      builtHtml,
      {
        route: stub.route,
        title: stub.title,
        description: stub.description,
        canonicalTo: stub.target,
        noindex: true,
      },
      hasOgImage,
    ),
  );
}

writeFileSync(path.join(distDir, "sitemap.xml"), sitemapXml(buildDate()));
writeFileSync(path.join(distDir, "feed.xml"), feedXml());

console.log(
  `[prerender] wrote ${pages.length} pages (${renderedBodies} with static docs bodies) + ${noindexStubs.length} noindex stubs + sitemap.xml + feed.xml` +
    (hasOgImage ? " + og.png" : " (no og.png)"),
);
