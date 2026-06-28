import * as React from "react";
import { Link, useParams } from "react-router-dom";
import { CalendarDays, Clock3 } from "lucide-react";

import { blogPostBySlug } from "@/components/blog/blog-data";
import { setMetaDescription } from "@/components/docs/meta";
import { NotFound } from "@/components/NotFound";
import { Footer } from "@/components/sections/Footer";
import { Nav } from "@/components/sections/Nav";
import { SkipLink } from "@/components/ui/skip-link";

const CONTENT_ID = "blog-post-content";

export function BlogPostPage() {
  const { slug } = useParams();
  const post = slug ? blogPostBySlug[slug] : undefined;

  React.useEffect(() => {
    if (!post) return;
    document.title = `${post.title} — agent-connector blog`;
    setMetaDescription(post.description);
    window.scrollTo({ top: 0 });
  }, [post]);

  if (!post) return <NotFound />;

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <SkipLink targetId={CONTENT_ID} />
      <Nav />
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-14 sm:py-20">
        <article id={CONTENT_ID} tabIndex={-1} className="scroll-mt-24 outline-none">
          <Link
            to="/blog"
            className="text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            &lt;- Blog
          </Link>

          <header className="mt-8">
            <p className="font-mono text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              {post.category}
            </p>
            <h1 className="mt-3 text-balance text-3xl font-bold tracking-tight sm:text-5xl">
              {post.title}
            </h1>
            <p className="mt-5 text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
              {post.description}
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays className="size-4" />
                {post.date}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Clock3 className="size-4" />
                {post.readingMinutes} min read
              </span>
            </div>
            <figure className="mt-8 overflow-hidden rounded-lg border border-border bg-muted/30">
              <img
                src={post.heroImage.src}
                alt={post.heroImage.alt}
                width={1200}
                height={630}
                decoding="async"
                className="aspect-[1200/630] w-full object-cover"
              />
              <figcaption className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
                {post.heroImage.caption}
              </figcaption>
            </figure>
          </header>

          <div className="mt-10 space-y-9">
            {post.sections.map((section) => (
              <section key={section.heading}>
                <h2 className="text-xl font-semibold tracking-tight">
                  {section.heading}
                </h2>
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
      <Footer />
    </div>
  );
}
