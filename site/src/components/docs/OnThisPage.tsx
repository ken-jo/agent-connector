import * as React from "react";
import { cn } from "@/lib/utils";
import { useScrollSpy } from "./use-scroll-spy";

interface TocEntry {
  id: string;
  text: string;
  /** 2 = section <h2>, 3 = sub-heading <h3>. */
  level: 2 | 3;
}

/**
 * "On this page" — derived from the rendered DOM so it always matches the
 * content. Picks up every <h2 id> (top-level section) and <h3 id> (sub-heading)
 * inside the docs content container.
 */
export function OnThisPage({
  containerId,
  sectionId,
}: {
  containerId: string;
  /** Re-scan when the routed section page changes (its content swaps in). */
  sectionId?: string;
}) {
  const [entries, setEntries] = React.useState<TocEntry[]>([]);

  React.useEffect(() => {
    const root = document.getElementById(containerId);
    if (!root) return;
    // Top-level sections carry the id on <section id> (its <h2> is the title),
    // while sub-headings carry the id on <h3 id>. Collect both, then order by
    // their position in the document so the TOC mirrors the reading flow.
    const nodes = Array.from(
      root.querySelectorAll<HTMLElement>("section[id], h3[id]"),
    );
    setEntries(
      nodes.map((n) => {
        const isSection = n.tagName === "SECTION";
        const titleEl = isSection
          ? n.querySelector("h2")
          : n;
        return {
          id: n.id,
          text: titleEl?.textContent?.trim() ?? n.id,
          level: isSection ? 2 : 3,
        };
      }),
    );
  }, [containerId, sectionId]);

  // "On this page" lists the in-page JUMP targets — i.e. the <h3> sub-headings
  // only. The section <h2> is the page title (already shown by the breadcrumb +
  // the active item in the left sidebar), so listing it here just duplicates the
  // left nav. We also HIDE the whole panel when there are fewer than 2 sub-
  // headings: a 0–1 item TOC is noise that makes the right rail look redundant
  // with the left on short section pages (kept for long guides like Hooks).
  const subHeadings = React.useMemo(
    () => entries.filter((e) => e.level === 3),
    [entries],
  );
  const ids = React.useMemo(() => subHeadings.map((e) => e.id), [subHeadings]);
  const activeId = useScrollSpy(ids);

  if (subHeadings.length < 2) return null;

  return (
    <nav aria-label="On this page" className="text-sm">
      <p className="mb-3 font-mono text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        On this page
      </p>
      <ul className="space-y-1.5">
        {subHeadings.map((e) => {
          const active = e.id === activeId;
          return (
            <li key={e.id}>
              <a
                href={`#${e.id}`}
                aria-current={active ? "location" : undefined}
                className={cn(
                  "block leading-snug transition-colors",
                  active
                    ? "font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {e.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
