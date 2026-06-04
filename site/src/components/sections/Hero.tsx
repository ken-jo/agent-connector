import { ArrowRight, BookText, Terminal } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { GithubIcon } from "@/components/ui/github-icon";
import { INSTALL_CMD, REPO_URL, platformCount } from "@/data";

export function Hero() {
  return (
    <section id="top" className="relative overflow-hidden">
      {/* Layered backgrounds */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-grid mask-fade"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-40 -z-10 h-[40rem] glow"
      />

      <div className="mx-auto max-w-6xl px-6 pb-20 pt-20 sm:pt-28">
        <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
          <Badge
            variant="outline"
            className="animate-fade-up gap-2 border-border/80 bg-card/60 py-1 backdrop-blur"
          >
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-indigo-500/60" />
              <span className="relative inline-flex size-2 rounded-full bg-indigo-500" />
            </span>
            {platformCount} platforms · all 3 hook paradigms
          </Badge>

          <h1 className="animate-fade-up mt-6 text-balance text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-5xl md:text-6xl">
            Write your MCP server + hooks once.{" "}
            <span className="text-gradient">Ship to every agent.</span>
          </h1>

          <p className="animate-fade-up mt-6 max-w-2xl text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
            One declarative <code className="font-mono text-foreground">defineConnector</code>{" "}
            deploys MCP servers, hooks, commands, skills &amp; subagents across{" "}
            {platformCount} AI-agent platforms — with default, platform-independent
            per-tool token telemetry.
          </p>

          <div className="animate-fade-up mt-9 flex w-full flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <div className="flex h-11 w-full max-w-sm items-center gap-2 rounded-lg border border-border bg-card/70 pl-3.5 pr-1.5 font-mono text-sm shadow-sm backdrop-blur sm:w-auto">
              <Terminal className="size-4 shrink-0 text-muted-foreground" />
              <span className="select-all truncate text-foreground">
                {INSTALL_CMD}
              </span>
              <CopyButton value={INSTALL_CMD} className="ml-auto size-8" />
            </div>
            <Button asChild size="lg" className="w-full gap-2 sm:w-auto">
              <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
                <GithubIcon className="size-4" />
                View on GitHub
                <ArrowRight className="size-4" />
              </a>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="w-full gap-2 sm:w-auto"
            >
              <Link to="/docs">
                <BookText className="size-4" />
                Read the docs
              </Link>
            </Button>
          </div>

          <p className="animate-fade-up mt-5 text-xs text-muted-foreground">
            MIT licensed · local-first telemetry · opt-out anytime
          </p>
        </div>
      </div>
    </section>
  );
}
