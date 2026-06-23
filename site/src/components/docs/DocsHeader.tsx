import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, ChevronRight, Pencil } from "lucide-react";
import {
  sectionLabel,
  tracks,
  trackSectionIds,
  type TrackId,
} from "./docs-data";

const GITHUB_REPO = "https://github.com/ken-jo/agent-connector";
const EDIT_PATH = "site/src/components/docs/DocsContent.tsx";
const EDIT_URL = `${GITHUB_REPO}/edit/main/${EDIT_PATH}`;

// `__DOCS_BUILD_DATE__` is the HEAD commit date (`YYYY-MM-DD`) injected by Vite
// `define` at build time. We render a site-wide "Last updated" date — doc pages
// live in shared files, so a single build date is the honest granularity — and
// deliberately show no version number (it would drift ahead of the docs).
const BUILD_DATE_LABEL = new Date(
  `${__DOCS_BUILD_DATE__}T00:00:00`,
).toLocaleDateString("en-US", { year: "numeric", month: "long" });

/** Group title that owns a section id within a track (the breadcrumb crumb). */
function groupOf(track: TrackId, id: string): string | undefined {
  return tracks[track].groups.find((g) => g.items.some((i) => i.id === id))
    ?.title;
}

/**
 * Parse a `?from=<track>/<section>` referrer into a validated back-link target,
 * or null when it is absent / malformed / points into the SAME track (no
 * persona boundary was crossed, so no banner). Used to surface a lightweight
 * "you followed a link out of your track into a shared page" banner.
 */
function parseCrossTrackFrom(
  fromParam: string | null,
  currentTrack: TrackId,
): { track: TrackId; section: string } | null {
  if (!fromParam) return null;
  const slash = fromParam.indexOf("/");
  if (slash < 0) return null;
  const track = fromParam.slice(0, slash);
  const section = fromParam.slice(slash + 1);
  if (track !== "user" && track !== "dev") return null;
  if (track === currentTrack) return null;
  if (!trackSectionIds[track].has(section)) return null;
  return { track, section };
}

/**
 * Docs content header: a breadcrumb (Docs → track → group → page), an "Edit
 * this page on GitHub" link, and a subtle "last updated" line (build date).
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

  const [searchParams] = useSearchParams();
  const crossFrom = parseCrossTrackFrom(searchParams.get("from"), track);

  return (
    <div className="mb-8 border-b border-border/60 pb-4">
      {crossFrom ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <span>
            <span className="font-medium text-foreground">{page}</span> — shared
            with the {tracks[track].label} track.
          </span>
          <Link
            to={`/docs/${crossFrom.track}/${crossFrom.section}`}
            className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
          >
            <ArrowLeft className="size-3" />
            Back to {sectionLabel[crossFrom.section]}
          </Link>
        </div>
      ) : null}
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
        Last updated {BUILD_DATE_LABEL}
      </p>
    </div>
  );
}
