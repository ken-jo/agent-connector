/**
 * Build-time entry used by scripts/prerender.mjs (via `vite build --ssr`) to
 * render each docs section to static HTML.
 *
 * Why: the site is a client-rendered SPA. Without this, every prerendered docs
 * page carried only <title> and <meta description> — the body arrived when
 * React ran in the browser. Search engines execute JavaScript; most AI/agent
 * crawlers (ClaudeBot, GPTBot, OAI-SearchBot, PerplexityBot, …) do not, so
 * they saw a heading and nothing else. Putting the section markup into the
 * HTML shell makes the page readable to a client that does not run scripts.
 *
 * Only the section itself is rendered — no sidebar, search palette or layout
 * chrome — because those components touch window/localStorage and the client
 * bundle replaces the whole #root on mount anyway (createRoot().render()).
 * Code blocks render their plain <pre> fallback; shiki highlighting stays a
 * client-side effect.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";

import { sectionRegistry } from "@/components/docs/DocsContent";
import { trackOrder, tracks, type TrackId } from "@/components/docs/docs-data";

export { trackOrder, tracks };

/** Static HTML for one docs section, or null when the id has no component. */
export function renderDocsSection(sectionId: string, route: string): string | null {
  const Section = sectionRegistry[sectionId];
  if (!Section) return null;
  return renderToStaticMarkup(
    <StaticRouter location={route}>
      <main data-prerender="docs" className="mx-auto w-full max-w-4xl px-6 py-12">
        <div className="space-y-14">
          <Section />
        </div>
      </main>
    </StaticRouter>,
  );
}

/** Every (track, section, route) the prerender should render. */
export function docsSectionRoutes(): { track: TrackId; sectionId: string; route: string }[] {
  const out: { track: TrackId; sectionId: string; route: string }[] = [];
  for (const track of Object.keys(tracks) as TrackId[]) {
    for (const sectionId of trackOrder[track]) {
      out.push({ track, sectionId, route: `${tracks[track].basePath}/${sectionId}` });
    }
  }
  return out;
}
