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

import { blogPostBySlug } from "@/components/blog/blog-data";
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

/**
 * Static HTML for one blog post: the article header and sections, without the
 * nav and footer chrome (the client bundle renders the full page on mount).
 */
export function renderBlogPost(slug: string, route: string): string | null {
  const post = blogPostBySlug[slug];
  if (!post) return null;
  return renderToStaticMarkup(
    <StaticRouter location={route}>
      <main data-prerender="blog" className="mx-auto w-full max-w-3xl px-6 py-14">
        <article>
          <header>
            <p className="font-mono text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{post.category}</p>
            <h1 className="mt-3 text-3xl font-bold tracking-tight">{post.title}</h1>
            <p className="mt-5 text-base leading-relaxed text-muted-foreground">{post.description}</p>
            <p className="mt-5 text-sm text-muted-foreground">
              {post.date} · {post.readingMinutes} min read
            </p>
            <figure className="mt-8 overflow-hidden rounded-lg border border-border">
              <img src={post.heroImage.src} alt={post.heroImage.alt} width={1200} height={630} />
              <figcaption className="px-4 py-2 text-xs text-muted-foreground">{post.heroImage.caption}</figcaption>
            </figure>
          </header>
          <div className="mt-10 space-y-9">
            {post.sections.map((section) => (
              <section key={section.heading}>
                <h2 className="text-xl font-semibold tracking-tight">{section.heading}</h2>
                <div className="mt-3 space-y-4 text-base leading-7 text-muted-foreground">
                  {section.body.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </article>
      </main>
    </StaticRouter>,
  );
}
