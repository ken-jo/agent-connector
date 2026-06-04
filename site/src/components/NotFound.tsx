import { Link } from "react-router-dom";
import { Nav } from "@/components/sections/Nav";
import { Footer } from "@/components/sections/Footer";
import { Button } from "@/components/ui/button";

/** Styled 404 page for unknown routes (catch-all in App.tsx). */
export function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <Nav />
      <main className="flex flex-1 items-center justify-center px-6 py-24">
        <div className="mx-auto max-w-md text-center">
          <p className="font-mono text-7xl font-bold tracking-tight text-foreground sm:text-8xl">
            404
          </p>
          <h1 className="mt-4 text-xl font-semibold tracking-tight text-foreground">
            Page not found
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            We couldn&apos;t find that page. It may have moved, or the link may
            be broken.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="sm">
              <Link to="/">Back to home</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/docs">Read the docs</Link>
            </Button>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
