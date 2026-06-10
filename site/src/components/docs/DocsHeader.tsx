import { Link } from "react-router-dom";
import { ChevronRight, Pencil } from "lucide-react";
import { sectionLabel, tracks, type TrackId } from "./docs-data";

const GITHUB_REPO = "https://github.com/ken-jo/agent-connector";
const EDIT_PATH = "site/src/components/docs/DocsContent.tsx";
const EDIT_URL = `${GITHUB_REPO}/edit/main/${EDIT_PATH}`;

/** Group title that owns a section id within a track (the breadcrumb crumb). */
function groupOf(track: TrackId, id: string): string | undefined {
  return tracks[track].groups.find((g) => g.items.some((i) => i.id === id))
    ?.title;
}

/**
 * Docs content header: a breadcrumb (Docs → track → group → page), an "Edit
 * this page on GitHub" link, and a subtle version / last-updated line.
 * `activeId` is the section currently routed; `track` is its audience track.
 */
export function DocsHeader({
  activeId,
  track,
}: {
  activeId: string;
  track: TrackId;
}) {
  const group = groupOf(track, activeId);
  const page = sectionLabel[activeId];

  return (
    <div className="mb-8 border-b border-border/60 pb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Breadcrumb" className="min-w-0">
          <ol className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <li className="font-mono text-xs uppercase tracking-wide">
              <Link to="/docs" className="transition-colors hover:text-foreground">
                Docs
              </Link>
            </li>
            <ChevronRight className="size-3.5 shrink-0 opacity-60" />
            <li className="truncate">{tracks[track].label}</li>
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
        agent-connector v0.1.0 · Last updated June 2026
      </p>
    </div>
  );
}
