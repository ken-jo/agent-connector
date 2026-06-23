import * as React from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Nav } from "@/components/sections/Nav";
import { Footer } from "@/components/sections/Footer";
import { SkipLink } from "@/components/ui/skip-link";
import { C } from "./prose";
import {
  DocsSearchButton,
  DocsSearchDialog,
  useDocsSearch,
} from "./DocsSearch";
import { DEFAULT_DESCRIPTION, setMetaDescription } from "./meta";
import {
  CoverageWall,
  ParadigmLegend,
  SurfaceLegend,
  TierLegend,
} from "@/components/coverage-wall/CoverageWall";
import { platformCount } from "@/data";

const CONTENT_ID = "docs-content";

/**
 * /docs — the persona chooser. The docs fork into two audience tracks at the
 * route level; this page IS the fork: two whole-card links into /docs/dev and
 * /docs/user, with the one accuracy-critical boundary between them stated
 * right here at the fork. ⌘K search works from here too.
 */
export function DocsChooser() {
  const { open: searchOpen, setOpen: setSearchOpen } = useDocsSearch();

  React.useEffect(() => {
    document.title = "Docs — agent-connector";
    setMetaDescription(DEFAULT_DESCRIPTION);
    window.scrollTo({ top: 0 });
  }, []);

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <SkipLink targetId={CONTENT_ID} />
      <Nav />
      {/* The page is max-w-6xl so the full interactive coverage wall (its grid
          caps at max-w-5xl) fits below; the chooser header + cards stay in a
          narrower max-w-4xl block for readable line length. */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-14 sm:py-20">
        <div id={CONTENT_ID} tabIndex={-1} className="scroll-mt-24 outline-none">
          <div className="mx-auto max-w-4xl">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="font-mono text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                Docs
              </p>
              <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
                Two audiences, two tracks
              </h1>
            </div>
            <DocsSearchButton
              onClick={() => setSearchOpen(true)}
              className="shrink-0"
            />
          </div>
          <p className="mt-4 max-w-2xl leading-relaxed text-muted-foreground">
            Pick yours — they don&apos;t overlap. Building an MCP integration is
            one track; just watching what your agent CLIs burn is the other.
          </p>

          <div className="mt-10 grid gap-4 md:grid-cols-2">
            {/* Card A — MCP developer → /docs/dev. Each card is ONE whole link. */}
            <Link
              to="/docs/dev"
              className="group flex flex-col rounded-xl border border-border bg-card/40 p-6 shadow-sm transition-colors hover:border-foreground/30 hover:bg-card/70"
            >
              <div className="mb-2 flex items-center gap-2">
                <span aria-hidden className="text-lg">
                  🔌
                </span>
                <span className="text-base font-semibold text-foreground">
                  MCP developer
                </span>
              </div>
              <p className="text-sm leading-relaxed text-foreground/90">
                <strong>You authored a connector with{" "}
                <C>defineConnector(&#123;...&#125;)</C></strong> (or are about to).
                You write your MCP server + hooks (and optionally commands,
                skills, subagents) <strong>once</strong>, then deploy across every
                detected agent platform — shipping a branded CLI or running{" "}
                <C>npx @ken-jo/agent-connector</C>. Per-MCP and per-tool token
                numbers come from the serve-proxy telemetry your connector
                produces for the server it declares and wraps —{" "}
                <strong>see what your tools cost</strong> (your own wrapped
                server).
              </p>
              <div className="mt-auto pt-5">
                <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 group-hover:underline">
                  Start the developer track
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                </span>
                <p className="mt-2 text-xs text-muted-foreground">
                  Quick start · defineConnector · Telemetry
                </p>
              </div>
            </Link>

            {/* Card B — agent-CLI user → /docs/user */}
            <Link
              to="/docs/user"
              className="group flex flex-col rounded-xl border border-border bg-card/40 p-6 shadow-sm transition-colors hover:border-foreground/30 hover:bg-card/70"
            >
              <div className="mb-2 flex items-center gap-2">
                <span aria-hidden className="text-lg">
                  🖥️
                </span>
                <span className="text-base font-semibold text-foreground">
                  Agent-CLI user
                </span>
              </div>
              <p className="text-sm leading-relaxed text-foreground/90">
                <strong>You have NOT authored a connector — you just use agent
                CLIs.</strong> You already run Claude Code / Codex / Cursor; with
                zero setup, the connector-free <C>usage</C> path reports
                whole-conversation totals per agent CLI / model / project /
                session / day from each CLI&apos;s own session logs. It can&apos;t
                itemize by individual MCP server or tool (agent CLIs don&apos;t
                log per-tool attribution) —{" "}
                <strong>see host totals, not per-MCP</strong>.
              </p>
              <div className="mt-auto pt-5">
                <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 group-hover:underline">
                  See your agent-CLI usage
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                </span>
                <p className="mt-2 text-xs text-muted-foreground">
                  Reports · Leaderboards · Coverage
                </p>
              </div>
            </Link>
          </div>
          </div>

          {/* The full INTERACTIVE coverage matrix lives here at the /docs root
              (a wide centered page), not in the narrow dev-docs prose column.
              Full filter bar + tier cards — the real wall, not a static
              snapshot. The accuracy-critical per-MCP-vs-host-totals line is now
              folded into each entry card's copy above, not a standalone box. */}
          <section aria-labelledby="docs-coverage-heading" className="mt-16">
            <h2
              id="docs-coverage-heading"
              className="text-center text-2xl font-bold tracking-tight sm:text-3xl"
            >
              Works with {platformCount} agents
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-center text-sm leading-relaxed text-muted-foreground">
              Every agent shows exactly which surfaces agent-connector installs,
              straight from its adapter — and which surfaces the host offers that
              we haven&apos;t wired yet. Filter by tier or surface; each card
              links to its setup guide.
            </p>
            <div className="mt-8 flex flex-col items-center gap-3">
              <ParadigmLegend />
              <SurfaceLegend />
              <TierLegend />
            </div>
            <div className="mt-8">
              <CoverageWall />
            </div>
            <p className="mx-auto mt-8 max-w-2xl text-center text-xs text-muted-foreground">
              Surface profiles are drift-tested against the adapter registry —
              the wall can&apos;t claim what an adapter doesn&apos;t ship, and a
              lit chip always implies the host natively offers that surface.
            </p>
          </section>
        </div>
      </main>
      <Footer />

      {/* ⌘K command palette (spans both tracks) */}
      <DocsSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}
