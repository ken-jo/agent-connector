import { ArrowLeft, ArrowRight } from "lucide-react";
import { sectionOrder, sectionLabel, navGroups } from "./docs-data";

/** Group title that owns a given section id (for the pager sub-label). */
function groupOf(id: string): string | undefined {
  return navGroups.find((g) => g.items.some((i) => i.id === id))?.title;
}

/**
 * Prev / next page footer pager, driven entirely by sectionOrder + sectionLabel.
 * `activeId` is the section currently in view (from scroll-spy); the pager points
 * at its neighbours in reading order.
 */
export function DocsPager({ activeId }: { activeId: string }) {
  const idx = sectionOrder.indexOf(activeId);
  if (idx === -1) return null;

  const prevId = idx > 0 ? sectionOrder[idx - 1] : undefined;
  const nextId = idx < sectionOrder.length - 1 ? sectionOrder[idx + 1] : undefined;

  if (!prevId && !nextId) return null;

  return (
    <nav
      aria-label="Pagination"
      className="mt-14 grid gap-4 border-t border-border/60 pt-8 sm:grid-cols-2"
    >
      {prevId ? (
        <a
          href={`#${prevId}`}
          className="group flex flex-col rounded-xl border border-border bg-card/40 p-4 transition-colors hover:border-foreground/30 hover:bg-card/70"
        >
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <ArrowLeft className="size-3.5 transition-transform group-hover:-translate-x-0.5" />
            Previous
          </span>
          <span className="mt-1 text-[0.7rem] uppercase tracking-wide text-muted-foreground/70">
            {groupOf(prevId)}
          </span>
          <span className="mt-0.5 font-medium text-foreground">
            {sectionLabel[prevId]}
          </span>
        </a>
      ) : (
        <span />
      )}
      {nextId ? (
        <a
          href={`#${nextId}`}
          className="group flex flex-col rounded-xl border border-border bg-card/40 p-4 text-right transition-colors hover:border-foreground/30 hover:bg-card/70 sm:items-end"
        >
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            Next
            <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
          <span className="mt-1 text-[0.7rem] uppercase tracking-wide text-muted-foreground/70">
            {groupOf(nextId)}
          </span>
          <span className="mt-0.5 font-medium text-foreground">
            {sectionLabel[nextId]}
          </span>
        </a>
      ) : (
        <span />
      )}
    </nav>
  );
}
