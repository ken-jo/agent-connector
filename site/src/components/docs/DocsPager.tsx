import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { sectionLabel, trackOrder, tracks, type TrackId } from "./docs-data";

/** Group title that owns a given section id (for the pager sub-label). */
function groupOf(track: TrackId, id: string): string | undefined {
  return tracks[track].groups.find((g) => g.items.some((i) => i.id === id))
    ?.title;
}

/**
 * Prev / next page footer pager. Each track's reading order is strictly
 * linear (trackOrder), so a track-terminal page simply has no next — the
 * cross-track links live in the page content, never in the pager.
 */
export function DocsPager({
  activeId,
  track,
}: {
  activeId: string;
  track: TrackId;
}) {
  const order = trackOrder[track];
  const idx = order.indexOf(activeId);
  if (idx === -1) return null;

  const prevId = idx > 0 ? order[idx - 1] : undefined;
  const nextId = idx < order.length - 1 ? order[idx + 1] : undefined;

  if (!prevId && !nextId) return null;

  return (
    <nav
      aria-label="Pagination"
      className="mt-14 grid gap-4 border-t border-border/60 pt-8 sm:grid-cols-2"
    >
      {prevId ? (
        <Link
          to={`/docs/${track}/${prevId}`}
          className="group flex flex-col rounded-xl border border-border bg-card/40 p-4 transition-colors hover:border-foreground/30 hover:bg-card/70"
        >
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <ArrowLeft className="size-3.5 transition-transform group-hover:-translate-x-0.5" />
            Previous
          </span>
          <span className="mt-1 text-[0.7rem] uppercase tracking-wide text-muted-foreground/70">
            {groupOf(track, prevId)}
          </span>
          <span className="mt-0.5 font-medium text-foreground">
            {sectionLabel[prevId]}
          </span>
        </Link>
      ) : (
        <span />
      )}
      {nextId ? (
        <Link
          to={`/docs/${track}/${nextId}`}
          className="group flex flex-col rounded-xl border border-border bg-card/40 p-4 text-right transition-colors hover:border-foreground/30 hover:bg-card/70 sm:items-end"
        >
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            Next
            <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
          <span className="mt-1 text-[0.7rem] uppercase tracking-wide text-muted-foreground/70">
            {groupOf(track, nextId)}
          </span>
          <span className="mt-0.5 font-medium text-foreground">
            {sectionLabel[nextId]}
          </span>
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
