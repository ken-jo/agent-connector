import * as React from "react";
import { Command } from "cmdk";
import { useNavigate } from "react-router-dom";
import { FileText, Hash, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { trackIds, tracks } from "./docs-data";
import { searchIndex, searchHaystack, type SearchEntry } from "./search-index";

/* ------------------------------------------------------------------ */
/* Open-state hook + global ⌘K / Ctrl-K listener                       */
/* ------------------------------------------------------------------ */

/**
 * Owns the palette open state and the global ⌘K / Ctrl-K (and "/") shortcut.
 * Returns the controlled open state + a setter the trigger button can use.
 */
export function useDocsSearch() {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘K (mac) / Ctrl-K (win/linux) toggles the palette from anywhere.
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      // "/" opens it when not typing in a field (classic docs shortcut).
      if (
        e.key === "/" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !isEditableTarget(e.target)
      ) {
        e.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return { open, setOpen };
}

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}

/* ------------------------------------------------------------------ */
/* Trigger button                                                      */
/* ------------------------------------------------------------------ */

/** Compact "Search… ⌘K" button shown in the docs header. */
export function DocsSearchButton({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Search docs"
      className={cn(
        "inline-flex items-center gap-2 rounded-lg border border-border bg-card/60 px-3 py-1.5 text-sm text-muted-foreground shadow-sm backdrop-blur transition-colors hover:border-foreground/30 hover:text-foreground",
        className,
      )}
    >
      <Search className="size-3.5" />
      <span>Search docs…</span>
      <kbd className="ml-2 hidden items-center gap-0.5 rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[0.65rem] font-medium text-muted-foreground sm:inline-flex">
        <span className="text-[0.8em]">⌘</span>K
      </kbd>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Command palette dialog                                              */
/* ------------------------------------------------------------------ */

/**
 * Result-group headings carry the track label so every result row has visible
 * track context, e.g. "MCP developer · Core API". Order matches the chooser
 * (dev first) then each track's sidebar.
 */
const groupOrder = trackIds.flatMap((t) =>
  tracks[t].groups.map((g) => `${tracks[t].label} · ${g.title}`),
);

/** Map a section id → its "track · group" heading (for result grouping). */
const groupTitleOf: Record<string, string> = Object.fromEntries(
  trackIds.flatMap((t) =>
    tracks[t].groups.flatMap((g) =>
      g.items.map((i) => [i.id, `${tracks[t].label} · ${g.title}`] as const),
    ),
  ),
);

/**
 * Substring + subsequence scorer over the precomputed haystack. Returns a
 * cmdk-compatible score in [0,1] (0 hides the item). Drives our own ranking so
 * descriptions/keywords match too, not just the visible title.
 */
function scoreEntry(value: string, search: string): number {
  const hay = searchHaystack[value];
  if (!hay) return 0;
  const q = search.trim().toLowerCase();
  if (!q) return 1;
  // Whole-phrase substring is the strongest signal.
  const idx = hay.indexOf(q);
  if (idx === 0) return 1;
  if (idx > 0) return 0.85;
  // Otherwise require every whitespace token to appear somewhere.
  const tokens = q.split(/\s+/).filter(Boolean);
  let matched = 0;
  for (const t of tokens) if (hay.includes(t)) matched += 1;
  if (matched === 0) return 0;
  return (matched / tokens.length) * 0.6;
}

export function DocsSearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();

  const go = React.useCallback(
    (entry: SearchEntry) => {
      onOpenChange(false);
      // Navigate to the owning section's own page inside its track. Section
      // results land on the page; heading results add the H3 anchor as a #hash
      // so the page deep-links to that sub-heading. We also imperatively scroll
      // in case we're already on that page (no nav event fires for an identical
      // route).
      const isHeading = entry.kind === "heading";
      const path = isHeading
        ? `/docs/${entry.track}/${entry.sectionId}#${entry.id}`
        : `/docs/${entry.track}/${entry.sectionId}`;
      navigate(path);
      window.requestAnimationFrame(() => {
        const target = isHeading
          ? document.getElementById(entry.id)
          : null;
        if (target) {
          target.scrollIntoView({ block: "start", behavior: "smooth" });
        } else {
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      });
    },
    [navigate, onOpenChange],
  );

  // Group entries by sidebar group title, preserving index order within each.
  const grouped = React.useMemo(() => {
    const map = new Map<string, SearchEntry[]>();
    for (const entry of searchIndex) {
      const title = groupTitleOf[entry.sectionId] ?? "Docs";
      const list = map.get(title) ?? [];
      list.push(entry);
      map.set(title, list);
    }
    return groupOrder
      .filter((t) => map.has(t))
      .map((t) => [t, map.get(t)!] as const);
  }, []);

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Search documentation"
      shouldFilter
      filter={scoreEntry}
      className="docs-cmdk"
      overlayClassName="fixed inset-0 z-[99] bg-black/50 backdrop-blur-sm"
      contentClassName="fixed left-1/2 top-[18vh] z-[100] w-[92vw] max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl outline-none"
    >
      <div className="flex items-center gap-2 border-b border-border px-4">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <Command.Input
          autoFocus
          placeholder="Search the docs…"
          className="h-12 w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
        <kbd className="hidden shrink-0 rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[0.65rem] text-muted-foreground sm:inline-block">
          esc
        </kbd>
      </div>

      <Command.List className="max-h-[min(60vh,28rem)] overflow-y-auto overscroll-contain p-2">
        <Command.Empty className="px-3 py-8 text-center text-sm text-muted-foreground">
          No results found.
        </Command.Empty>

        {grouped.map(([groupTitle, entries]) => (
          <Command.Group
            key={groupTitle}
            heading={groupTitle}
            className="px-1 py-1 text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
          >
            {entries.map((entry) => (
              <Command.Item
                key={entry.id}
                value={entry.id}
                keywords={[entry.title, entry.sectionLabel]}
                onSelect={() => go(entry)}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-foreground/90",
                  "data-[selected=true]:bg-accent data-[selected=true]:text-foreground",
                )}
              >
                {entry.kind === "section" ? (
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Hash className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate font-medium">
                  {entry.title}
                </span>
                {entry.kind === "heading" ? (
                  <span className="shrink-0 truncate text-xs text-muted-foreground">
                    {entry.sectionLabel}
                  </span>
                ) : null}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}
