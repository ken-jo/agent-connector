import * as React from "react";

import { Nav } from "@/components/sections/Nav";
import { Footer } from "@/components/sections/Footer";
import { SkipLink } from "@/components/ui/skip-link";
import { setMetaDescription } from "@/components/docs/meta";
import { platformCount } from "@/data";
import {
  CoverageWall,
  ParadigmLegend,
  SurfaceLegend,
  TierLegend,
} from "@/components/coverage-wall/CoverageWall";

const CONTENT_ID = "coverage-content";

const COVERAGE_DESCRIPTION =
  "agent-connector lets a branded MCP package deploy across 42 AI-agent CLIs, IDE extensions and apps — see the full per-host coverage matrix with hook paradigm, surfaces and GitHub-stars rank tiers.";

/**
 * /coverage — the dedicated, indexable home of the full interactive coverage
 * matrix. Pulled out of the /docs chooser so it has its own SEO surface and is
 * easy to find from the header nav. It is a wide (max-w-6xl) page so the
 * full-width filter bar + tier-card grid (the wall's grid caps at max-w-5xl)
 * never overflows. The `<CoverageWall />` is the same shared component the rest
 * of the site links to; this route is code-split (App.tsx React.lazy) so the
 * wall + its star snapshot never weigh down the landing's initial chunk.
 */
export function CoveragePage() {
  React.useEffect(() => {
    document.title = "Coverage — agent-connector";
    setMetaDescription(COVERAGE_DESCRIPTION);
    window.scrollTo({ top: 0 });
  }, []);

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <SkipLink targetId={CONTENT_ID} />
      <Nav />
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-14 sm:py-20">
        <div id={CONTENT_ID} tabIndex={-1} className="scroll-mt-24 outline-none">
          <div className="text-center">
            <p className="font-mono text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Coverage
            </p>
            <h1 className="mt-2 text-balance text-3xl font-bold tracking-tight sm:text-4xl">
              Works with {platformCount} agents
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-pretty text-base leading-relaxed text-muted-foreground">
              Every agent shows exactly which surfaces agent-connector installs,
              straight from its adapter — and which surfaces the host offers that
              we haven&apos;t wired yet. Filter by tier or surface; each card
              links to its setup guide.
            </p>
          </div>

          <div className="mt-10 flex flex-col items-center gap-3">
            <ParadigmLegend />
            <SurfaceLegend />
            <TierLegend />
          </div>

          <div className="mt-8">
            <CoverageWall />
          </div>

          <p className="mx-auto mt-8 max-w-2xl text-center text-xs text-muted-foreground">
            Surface profiles are drift-tested against the adapter registry — the
            wall can&apos;t claim what an adapter doesn&apos;t ship, and a lit
            chip always implies the host natively offers that surface.
          </p>
        </div>
      </main>
      <Footer />
    </div>
  );
}
