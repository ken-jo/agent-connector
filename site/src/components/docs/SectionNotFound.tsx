import { Link } from "react-router-dom";
import { Nav } from "@/components/sections/Nav";
import { Footer } from "@/components/sections/Footer";
import { Button } from "@/components/ui/button";
import { navGroups } from "./docs-data";

/**
 * "Section not found" — shown when /docs/:section references an unknown id.
 * Keeps the docs chrome (nav + footer) and offers the real section list as a
 * recovery path instead of a hard bounce to the home page.
 */
export function SectionNotFound({ section }: { section: string }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <Nav />
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-20">
        <p className="font-mono text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Docs
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
          Section not found
        </h1>
        <p className="mt-4 leading-relaxed text-muted-foreground">
          There is no docs section called{" "}
          <code className="rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">
            {section}
          </code>
          . Pick one of the sections below, or head back to the docs home.
        </p>

        <div className="mt-8 space-y-6">
          {navGroups.map((group) => (
            <div key={group.title}>
              <p className="mb-2 font-mono text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {group.title}
              </p>
              <ul className="flex flex-wrap gap-2">
                {group.items.map((item) => (
                  <li key={item.id}>
                    <Link
                      to={`/docs/${item.id}`}
                      className="inline-flex rounded-lg border border-border bg-card/40 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10">
          <Button asChild variant="outline" size="sm">
            <Link to="/docs">Back to docs home</Link>
          </Button>
        </div>
      </main>
      <Footer />
    </div>
  );
}
