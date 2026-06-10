import * as React from "react";
import { Menu, X } from "lucide-react";
import { Nav } from "@/components/sections/Nav";
import { Footer } from "@/components/sections/Footer";
import { SkipLink } from "@/components/ui/skip-link";
import { cn } from "@/lib/utils";
import { DocsSidebar } from "./DocsSidebar";
import { DocsHeader } from "./DocsHeader";
import { DocsPager } from "./DocsPager";
import { OnThisPage } from "./OnThisPage";
import {
  DocsSearchButton,
  DocsSearchDialog,
  useDocsSearch,
} from "./DocsSearch";
import type { TrackId } from "./docs-data";

const CONTENT_ID = "docs-content";

/**
 * Docs chrome around a single section page. `activeId` is the section id of
 * the page currently routed (from /docs/<track>/:section) and `track` is the
 * audience track that owns it — together they drive the sidebar highlight,
 * breadcrumb, and prev/next pager. The right-hand "On this page" rail keeps
 * its own DOM-derived scroll-spy for the in-page H3 anchors.
 */
export function DocsLayout({
  children,
  activeId,
  track,
}: {
  children: React.ReactNode;
  activeId: string;
  track: TrackId;
}) {
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const { open: searchOpen, setOpen: setSearchOpen } = useDocsSearch();

  // Lock body scroll + close on Escape while the mobile sidebar sheet is open.
  React.useEffect(() => {
    if (!mobileOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [mobileOpen]);

  return (
    <div className="relative min-h-dvh bg-background">
      <SkipLink targetId={CONTENT_ID} />
      <Nav />

      {/* Mobile sidebar trigger + search (sticky just under the nav) */}
      <div className="sticky top-16 z-30 flex items-center gap-3 border-b border-border/60 bg-background/80 px-6 py-2.5 backdrop-blur-xl lg:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-expanded={mobileOpen}
          aria-controls="docs-mobile-sidebar"
          className="flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <Menu className="size-4" />
          Menu
        </button>
        <DocsSearchButton
          onClick={() => setSearchOpen(true)}
          className="ml-auto"
        />
      </div>

      <div className="mx-auto flex max-w-7xl gap-8 px-6">
        {/* Left sidebar — desktop */}
        <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-60 shrink-0 overflow-y-auto py-10 pr-2 lg:block">
          <DocsSearchButton
            onClick={() => setSearchOpen(true)}
            className="mb-6 w-full justify-start"
          />
          <DocsSidebar activeId={activeId} track={track} />
        </aside>

        {/* Center content */}
        <main className="min-w-0 flex-1 py-10 xl:py-12">
          <div
            id={CONTENT_ID}
            tabIndex={-1}
            className="mx-auto max-w-3xl scroll-mt-24 outline-none"
          >
            <DocsHeader activeId={activeId} track={track} />
            {children}
            <DocsPager activeId={activeId} track={track} />
          </div>
        </main>

        {/* Right "on this page" — xl only */}
        <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-56 shrink-0 overflow-y-auto py-12 xl:block">
          <OnThisPage containerId={CONTENT_ID} sectionId={activeId} />
        </aside>
      </div>

      <Footer />

      {/* ⌘K command palette */}
      <DocsSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />

      {/* Mobile sidebar sheet */}
      {mobileOpen ? (
        <div
          className="fixed inset-0 z-50 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Docs navigation"
        >
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <div
            id="docs-mobile-sidebar"
            className={cn(
              "absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto",
              "border-r border-border bg-background p-6 shadow-xl",
            )}
          >
            <div className="mb-6 flex items-center justify-between">
              <span className="font-mono text-sm font-semibold">Docs</span>
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setMobileOpen(false)}
                className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            <DocsSidebar
              activeId={activeId}
              track={track}
              onNavigate={() => setMobileOpen(false)}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
