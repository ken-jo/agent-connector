import { BookText } from "lucide-react";
import { Link } from "react-router-dom";
import { GithubIcon } from "@/components/ui/github-icon";
import { CopyButton } from "@/components/ui/copy-button";
import { INSTALL_CMD, REPO_URL } from "@/data";

export function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto max-w-6xl px-6 py-14">
        <div className="flex flex-col items-start justify-between gap-8 md:flex-row md:items-center">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="flex size-8 items-center justify-center rounded-lg border border-border bg-card">
                <svg width="20" height="20" viewBox="0 0 32 32" fill="none" aria-hidden="true">
                  <path
                    d="M11 12.5a3.5 3.5 0 0 1 3.5-3.5h.5a3.5 3.5 0 0 1 3.5 3.5v7a3.5 3.5 0 0 1-3.5 3.5h-.5"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                  />
                  <path
                    d="M21 19.5a3.5 3.5 0 0 1-3.5 3.5H17a3.5 3.5 0 0 1-3.5-3.5v-7A3.5 3.5 0 0 1 17 9h.5"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeOpacity="0.5"
                  />
                </svg>
              </span>
              <span className="font-mono text-sm font-semibold">
                agentconnect
              </span>
            </div>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
              Generalizes context-mode's adapter layer into a reusable framework.
              Write your MCP server + hooks once. Ship to every agent.
            </p>
          </div>

          <div className="flex w-full max-w-xs flex-col items-stretch gap-3 md:w-auto">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-card/60 px-3 py-2 font-mono text-xs">
              <span className="truncate text-foreground">{INSTALL_CMD}</span>
              <CopyButton value={INSTALL_CMD} className="ml-auto size-7" />
            </div>
            <Link
              to="/docs"
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-accent"
            >
              <BookText className="size-4" />
              Documentation
            </Link>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-accent"
            >
              <GithubIcon className="size-4" />
              github.com/ken-jo/agentconnect
            </a>
          </div>
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-border pt-6 text-xs text-muted-foreground sm:flex-row">
          <p>MIT © KenJo · {new Date().getFullYear()}</p>
          <p>Built with the agentconnect framework.</p>
        </div>
      </div>
    </footer>
  );
}
