import * as React from "react";
import { Link } from "react-router-dom";
import { CalendarDays, Clock3, Newspaper, Rss } from "lucide-react";

import { setMetaDescription } from "@/components/docs/meta";
import { Footer } from "@/components/sections/Footer";
import { Nav } from "@/components/sections/Nav";
import { SkipLink } from "@/components/ui/skip-link";
import { blogPosts } from "@/components/blog/blog-data";

const CONTENT_ID = "blog-content";
const BLOG_DESCRIPTION =
  "agent-connector blog is being built. This temporary post verifies routing, RSS, and image rendering before real articles are published.";

export function BlogPage() {
  React.useEffect(() => {
    document.title = "Blog — agent-connector";
    setMetaDescription(BLOG_DESCRIPTION);
    window.scrollTo({ top: 0 });
  }, []);

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <SkipLink targetId={CONTENT_ID} />
      <Nav />
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-14 sm:py-20">
        <div id={CONTENT_ID} tabIndex={-1} className="scroll-mt-24 outline-none">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-3xl">
              <p className="font-mono text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                Blog
              </p>
              <h1 className="mt-2 text-balance text-3xl font-bold tracking-tight sm:text-5xl">
                Blog is being built
              </h1>
              <p className="mt-5 text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
                One temporary post is published while the article model, RSS
                output, and image layout are reviewed. Polished MCP, AI, and
                product essays will be added after this surface is approved.
              </p>
            </div>
            <a
              href="/feed.xml"
              className="inline-flex w-fit shrink-0 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-foreground/40"
            >
              <Rss className="size-4" />
              RSS
            </a>
          </div>

          <div className="mt-10 grid gap-4">
            {blogPosts.map((post) => (
              <article
                key={post.slug}
                className="overflow-hidden rounded-lg border border-border bg-card/50 transition-colors hover:border-foreground/30"
              >
                <Link to={`/blog/${post.slug}`} className="block bg-muted/30">
                  <img
                    src={post.heroImage.src}
                    alt={post.heroImage.alt}
                    loading="lazy"
                    decoding="async"
                    className="aspect-[1200/630] w-full object-cover"
                  />
                </Link>
                <div className="p-5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5 font-mono uppercase tracking-wide">
                      <Newspaper className="size-3.5" />
                      {post.category}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <CalendarDays className="size-3.5" />
                      {post.date}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Clock3 className="size-3.5" />
                      {post.readingMinutes} min read
                    </span>
                  </div>
                  <h2 className="mt-3 text-xl font-semibold tracking-tight">
                    <Link to={`/blog/${post.slug}`} className="hover:underline">
                      {post.title}
                    </Link>
                  </h2>
                  <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                    {post.description}
                  </p>
                  <Link
                    to={`/blog/${post.slug}`}
                    className="mt-4 inline-flex text-sm font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    Read article <span aria-hidden="true" className="ml-1">-&gt;</span>
                  </Link>
                </div>
              </article>
            ))}
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
