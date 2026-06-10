import { Link } from "react-router-dom";
import { Nav } from "@/components/sections/Nav";
import { Footer } from "@/components/sections/Footer";
import { Button } from "@/components/ui/button";
import { sectionPath, trackIds, tracks, type TrackId } from "./docs-data";

/**
 * "Section not found" — shown when /docs/:legacySection or
 * /docs/<track>/:section references an unknown id. Keeps the docs chrome
 * (nav + footer) and offers BOTH tracks' real section lists as a recovery
 * path instead of a hard bounce to the home page. `track` scopes the message
 * when the miss happened inside a track route.
 */
export function SectionNotFound({
  section,
  track,
}: {
  section: string;
  track?: TrackId;
}) {
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
          {track ? ` in the ${tracks[track].label} track` : ""}. Pick one of the
          sections below, or head back to the docs home.
        </p>

        <div className="mt-8 space-y-8">
          {trackIds.map((t) => (
            <div key={t}>
              <p className="mb-3 text-sm font-semibold text-foreground">
                <span aria-hidden>{tracks[t].glyph}</span> {tracks[t].label}
              </p>
              <div className="space-y-6">
                {tracks[t].groups.map((group) => (
                  <div key={group.title}>
                    <p className="mb-2 font-mono text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      {group.title}
                    </p>
                    <ul className="flex flex-wrap gap-2">
                      {group.items.map((item) => (
                        <li key={item.id}>
                          <Link
                            to={sectionPath(item.id)}
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
