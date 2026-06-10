import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { GithubIcon } from "@/components/ui/github-icon";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { cn } from "@/lib/utils";
import { REPO_URL } from "@/data";

const links = [
  { href: "#audiences", label: "Who it's for" },
  { href: "#pillars", label: "Pillars" },
  { href: "#surfaces", label: "Surfaces" },
  { href: "#platforms", label: "Platforms" },
  { href: "#dialects", label: "Dialects" },
  { href: "#telemetry", label: "Telemetry" },
];

function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2.5">
      <span className="flex size-8 items-center justify-center rounded-lg border border-border bg-card shadow-sm">
        <svg
          width="20"
          height="20"
          viewBox="0 0 32 32"
          fill="none"
          aria-hidden="true"
        >
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
      <span className="font-mono text-sm font-semibold tracking-tight">
        agent-connector
      </span>
    </Link>
  );
}

export function Nav() {
  const { pathname } = useLocation();
  const onLanding = pathname === "/";
  // On non-landing routes, anchor links must jump back to the landing page.
  const sectionHref = (hash: string) => (onLanding ? hash : `/${hash}`);

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/60 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Logo />
        <nav className="hidden items-center gap-1 md:flex">
          {links.map((l) => (
            <a
              key={l.href}
              href={sectionHref(l.href)}
              className="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {l.label}
            </a>
          ))}
          <Link
            to="/docs"
            className={cn(
              "rounded-md px-3 py-2 text-sm transition-colors hover:text-foreground",
              pathname.startsWith("/docs")
                ? "font-medium text-foreground"
                : "text-muted-foreground",
            )}
          >
            Docs
          </Link>
          <Link
            to="/docs/user"
            className={cn(
              "rounded-md px-3 py-2 text-sm transition-colors hover:text-foreground",
              pathname.startsWith("/docs/user")
                ? "font-medium text-foreground"
                : "text-muted-foreground",
            )}
          >
            Usage
          </Link>
        </nav>
        <div className="flex items-center gap-1.5">
          <ThemeToggle />
          <Button asChild variant="outline" size="sm" className="gap-2">
            <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
              <GithubIcon className="size-4" />
              <span className="hidden sm:inline">GitHub</span>
            </a>
          </Button>
        </div>
      </div>
    </header>
  );
}
