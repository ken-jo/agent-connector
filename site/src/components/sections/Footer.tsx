import {
  Activity,
  BookText,
  Boxes,
  Home,
  Newspaper,
  Plug,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { GithubIcon } from "@/components/ui/github-icon";
import { CopyButton } from "@/components/ui/copy-button";
import { BRANDED_INSTALL_CMD, REPO_URL } from "@/data";

const footerLinkClass =
  "inline-flex items-center gap-2 rounded-md py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground";

function FooterColumn({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div>
      <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-foreground">
        {title}
      </h2>
      <div className="mt-4 flex flex-col items-start gap-1">{children}</div>
    </div>
  );
}

function FooterLink({
  to,
  icon: Icon,
  children,
}: {
  to: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <Link to={to} className={footerLinkClass}>
      <Icon className="size-4" />
      {children}
    </Link>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto max-w-6xl px-6 py-14">
        <div className="grid gap-10 md:grid-cols-3">
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
                agent-connector
              </span>
            </div>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
              Generalizes context-mode's adapter layer into a reusable framework.
              Write your MCP server + hooks once. Ship to every agent.
            </p>
            <div className="mt-5 flex max-w-sm items-center gap-2 rounded-lg border border-border bg-card/60 px-3 py-2 font-mono text-xs">
              <span className="min-w-0 truncate text-foreground">{BRANDED_INSTALL_CMD}</span>
              <CopyButton value={BRANDED_INSTALL_CMD} className="ml-auto size-7" />
            </div>
          </div>

          <FooterColumn title="Learn">
            <FooterLink to="/docs" icon={BookText}>
              Documentation
            </FooterLink>
            <FooterLink to="/docs/guides/mcp-beginner" icon={Plug}>
              Agent-connector beginner guide
            </FooterLink>
            <FooterLink to="/blog" icon={Newspaper}>
              Blog
            </FooterLink>
          </FooterColumn>

          <FooterColumn title="Product">
            <FooterLink to="/" icon={Home}>
              Home
            </FooterLink>
            <FooterLink to="/coverage" icon={Boxes}>
              Coverage
            </FooterLink>
            <FooterLink to="/telemetry" icon={Activity}>
              Telemetry
            </FooterLink>
            <FooterLink to="/wizard" icon={Sparkles}>
              Wizard
            </FooterLink>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer noopener"
              className={footerLinkClass}
            >
              <GithubIcon className="size-4" />
              github.com/ken-jo/agent-connector
            </a>
          </FooterColumn>
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-border pt-6 text-xs text-muted-foreground sm:flex-row">
          <p>Apache-2.0 © KenJo · {new Date().getFullYear()}</p>
          <p>Built with the agent-connector framework.</p>
        </div>
      </div>
    </footer>
  );
}
