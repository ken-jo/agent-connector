import * as React from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Nav } from "@/components/sections/Nav";
import { Footer } from "@/components/sections/Footer";
import { SkipLink } from "@/components/ui/skip-link";
import { C, Callout } from "./prose";
import {
  DocsSearchButton,
  DocsSearchDialog,
  useDocsSearch,
} from "./DocsSearch";
import { DEFAULT_DESCRIPTION, setMetaDescription } from "./meta";

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
      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-14 sm:py-20">
        <div id={CONTENT_ID} tabIndex={-1} className="scroll-mt-24 outline-none">
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
                You write your MCP server + hooks (and optionally commands,
                skills, subagents) <strong>once</strong> with{" "}
                <C>defineConnector(&#123;...&#125;)</C>, then deploy across every
                detected agent platform — shipping a branded CLI or running{" "}
                <C>npx @ken-jo/agent-connector</C>. You get per-MCP and per-tool
                token counts for <strong>your own wrapped server</strong>.
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
                You already run Claude Code / Codex / Cursor and have{" "}
                <strong>not</strong> authored a connector. With zero setup you
                run <C>agent-connector usage</C> to scan each agent CLI&apos;s
                own session logs and see how many tokens they&apos;re burning,
                ranked by CLI / model / project / session / day.
              </p>
              <div className="mt-auto pt-5">
                <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 group-hover:underline">
                  See your agent-CLI usage
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                </span>
              </div>
            </Link>
          </div>

          <Callout title="The one accuracy-critical line between the tracks" tone="warn">
            The connector-free{" "}
            <Link className="underline hover:text-foreground" to="/docs/user/usage">
              <C>usage</C>
            </Link>{" "}
            path reports <strong>whole-conversation totals</strong> per agent
            CLI / model / project / session / day — it does <strong>not</strong>{" "}
            and cannot itemize cost by individual MCP server or tool, because
            agent CLIs don&apos;t log per-tool token attribution.{" "}
            <strong>Per-MCP and per-tool numbers</strong> come only from the{" "}
            <Link
              className="underline hover:text-foreground"
              to="/docs/dev/telemetry-overview"
            >
              serve-proxy telemetry
            </Link>{" "}
            that an MCP developer&apos;s own connector produces for the server
            it declares and wraps. &quot;See what your tools cost&quot; (your own
            wrapped server) is never the same as &quot;see what the MCPs you use
            cost&quot; (only available as host totals, not per-MCP).
          </Callout>
        </div>
      </main>
      <Footer />

      {/* ⌘K command palette (spans both tracks) */}
      <DocsSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}
