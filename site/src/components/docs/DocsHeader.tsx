import { ChevronRight, Pencil } from "lucide-react";
import { navGroups, sectionLabel } from "./docs-data";

const GITHUB_REPO = "https://github.com/ken-jo/agentconnect";
const EDIT_PATH = "site/src/components/docs/DocsContent.tsx";
const EDIT_URL = `${GITHUB_REPO}/edit/main/${EDIT_PATH}`;

/** Group title that owns a section id (the breadcrumb's first crumb). */
function groupOf(id: string): string | undefined {
  return navGroups.find((g) => g.items.some((i) => i.id === id))?.title;
}

/**
 * Docs content header: a breadcrumb (group → page), an "Edit this page on
 * GitHub" link, and a subtle version / last-updated line. `activeId` is the
 * section currently in view (from scroll-spy) so the crumb tracks scrolling.
 */
export function DocsHeader({ activeId }: { activeId: string }) {
  const group = groupOf(activeId);
  const page = sectionLabel[activeId];

  return (
    <div className="mb-8 border-b border-border/60 pb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Breadcrumb" className="min-w-0">
          <ol className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <li className="font-mono text-xs uppercase tracking-wide">Docs</li>
            {group ? (
              <>
                <ChevronRight className="size-3.5 shrink-0 opacity-60" />
                <li className="truncate">{group}</li>
              </>
            ) : null}
            {page ? (
              <>
                <ChevronRight className="size-3.5 shrink-0 opacity-60" />
                <li className="truncate font-medium text-foreground">{page}</li>
              </>
            ) : null}
          </ol>
        </nav>
        <a
          href={EDIT_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <Pencil className="size-3.5" />
          Edit this page on GitHub
        </a>
      </div>
      <p className="mt-2 text-[0.7rem] text-muted-foreground/70">
        agentconnect v0.1.0 · Last updated June 2026
      </p>
    </div>
  );
}
