import * as React from "react";

import { Nav } from "@/components/sections/Nav";
import { Footer } from "@/components/sections/Footer";
import { SkipLink } from "@/components/ui/skip-link";
import { setMetaDescription } from "@/components/docs/meta";
import { releaseStatus } from "@/release-status.generated";
import {
  CoverageWall,
  ParadigmLegend,
  SurfaceLegend,
  TierLegend,
} from "@/components/coverage-wall/CoverageWall";
import {
  PUBLIC_OSS_STAR_FLOOR,
  publicCoverageCount,
  publicCoverageSurfaceCounts,
  publicVerificationCounts,
} from "@/components/coverage-wall/public-coverage";

const CONTENT_ID = "coverage-content";

const COVERAGE_DESCRIPTION =
  "agent-connector public coverage highlights closed-source flagship hosts and 1k+ star open-source agent hosts, with per-host hook paradigm, surfaces, and rank tiers.";

const localVersion: string = releaseStatus.localVersion;
const npmLatest: string | null = releaseStatus.npmLatest;
const githubFetchStatus: string = releaseStatus.githubFetchStatus;

const versionBadge =
  npmLatest === localVersion
    ? "published"
    : npmLatest
      ? "pending publish"
      : "npm unknown";

const githubReleaseLabel = releaseStatus.githubLatest ?? "unavailable";

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
              Works with {publicCoverageCount} production-relevant agents
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-pretty text-base leading-relaxed text-muted-foreground">
              This public matrix highlights closed-source flagship hosts and
              open-source hosts with at least {PUBLIC_OSS_STAR_FLOOR.toLocaleString()} GitHub
              stars. Each card shows the surfaces agent-connector installs, and
              which host-native surfaces are still gaps.
            </p>
          </div>

          <div className="mt-10 flex flex-col items-center gap-3">
            <ParadigmLegend />
            <SurfaceLegend />
            <TierLegend />
          </div>

          <div
            className="mx-auto mt-8 grid max-w-4xl grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8"
            aria-label="Generated adapter capability summary"
          >
            {publicCoverageSurfaceCounts.map((surface) => (
              <div
                key={surface.key}
                className="rounded-lg border border-border bg-card/45 px-3 py-2 text-center"
                title={`${surface.label}: ${surface.count} public hosts are wired by agent-connector`}
              >
                <div className="font-mono text-lg font-semibold tabular-nums text-foreground">
                  {surface.count}
                </div>
                <div className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                  {surface.label}
                </div>
              </div>
            ))}
          </div>

          <div className="mx-auto mt-8 max-w-4xl border-t border-border/60 pt-6">
            <p className="text-center font-mono text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Verification ladder
            </p>
            <div
              className="mt-3 grid gap-2 sm:grid-cols-3"
              aria-label="Public host verification levels"
            >
              {publicVerificationCounts.map((level) => (
                <div
                  key={level.key}
                  className="rounded-lg border border-border bg-card/45 px-4 py-3"
                  title={level.description}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-mono text-xs font-semibold uppercase tracking-wide text-foreground">
                      {level.label}
                    </span>
                    <span className="font-mono text-xl font-semibold tabular-nums text-foreground">
                      {level.count}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    {level.description}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div className="mx-auto mt-8 max-w-4xl border-t border-border/60 pt-6">
            <p className="text-center font-mono text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Release hygiene
            </p>
            <div
              className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4"
              aria-label="Release hygiene status"
            >
              <a
                href={releaseStatus.repoUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-border bg-card/45 px-4 py-3 transition-colors hover:border-foreground/40"
              >
                <div className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Repository
                </div>
                <div className="mt-1 font-mono text-lg font-semibold text-foreground">
                  v{localVersion}
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  package.json source version
                </p>
              </a>
              <a
                href={releaseStatus.npmPackageUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-border bg-card/45 px-4 py-3 transition-colors hover:border-foreground/40"
              >
                <div className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  npm latest
                </div>
                <div className="mt-1 font-mono text-lg font-semibold text-foreground">
                  {npmLatest ? `v${npmLatest}` : "unknown"}
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {versionBadge}
                </p>
              </a>
              <a
                href={releaseStatus.githubReleaseUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-border bg-card/45 px-4 py-3 transition-colors hover:border-foreground/40"
              >
                <div className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  GitHub release
                </div>
                <div className="mt-1 truncate font-mono text-lg font-semibold text-foreground">
                  {githubReleaseLabel}
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {githubFetchStatus === "ok"
                    ? "latest release snapshot"
                    : "API snapshot unavailable"}
                </p>
              </a>
              <a
                href={releaseStatus.githubActionsUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-border bg-card/45 px-4 py-3 transition-colors hover:border-foreground/40"
              >
                <div className="font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  CI workflows
                </div>
                <div className="mt-1 font-mono text-lg font-semibold text-foreground">
                  {releaseStatus.ciWorkflow.present &&
                  releaseStatus.deployWorkflow.present &&
                  releaseStatus.releaseWorkflow.present
                    ? "present"
                    : "missing"}
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  CI + release + site deploy files
                </p>
              </a>
            </div>
          </div>

          <div className="mt-8">
            <CoverageWall />
          </div>

          <p className="mx-auto mt-8 max-w-2xl text-center text-xs text-muted-foreground">
            Surface profiles are drift-tested against the full adapter registry.
            Lower-star early adapters stay supported in code and reference docs,
            but are omitted here to keep the public support list focused.
          </p>
        </div>
      </main>
      <Footer />
    </div>
  );
}
