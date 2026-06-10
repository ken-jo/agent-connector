import * as React from "react";
import { useParams } from "react-router-dom";
import { DocsLayout } from "./DocsLayout";
import { sectionRegistry } from "./DocsContent";
import {
  sectionLabel,
  sectionDescription,
  trackOrder,
  trackSectionIds,
  type TrackId,
} from "./docs-data";
import { SectionNotFound } from "./SectionNotFound";
import { DEFAULT_DESCRIPTION, setMetaDescription } from "./meta";

/**
 * One docs page within a track: /docs/<track>/:section. With no :section
 * param (/docs/user, /docs/dev) it renders the track's first section — the
 * track home — so the page is never blank.
 */
export function DocsPage({ track }: { track: TrackId }) {
  const { section } = useParams<{ section?: string }>();

  // A :section param outside this track's id set is a 404-in-docs.
  const unknownSection = section != null && !trackSectionIds[track].has(section);

  const activeSection = section ?? trackOrder[track][0];

  // Title + <meta description> + scroll handling. Each section is its own page
  // now, so on a section change we scroll to the top — unless the URL carries a
  // within-section #hash (e.g. /docs/dev/hooks#claude-vs-kilo), in which case
  // we deep-link to that H3 inside the now-isolated section page.
  React.useEffect(() => {
    if (unknownSection) {
      document.title = "Section not found — agent-connector docs";
      setMetaDescription(DEFAULT_DESCRIPTION);
      window.scrollTo({ top: 0 });
      return;
    }

    const label = sectionLabel[activeSection];
    document.title = label
      ? `${label} — agent-connector docs`
      : "Docs — agent-connector";
    setMetaDescription(
      sectionDescription[activeSection] || DEFAULT_DESCRIPTION,
    );

    // Wait a frame so the new section's content is in the DOM before scrolling.
    const id = window.requestAnimationFrame(() => {
      const hash = window.location.hash.replace(/^#/, "");
      const target = hash && document.getElementById(hash);
      if (target) {
        target.scrollIntoView({ block: "start" });
      } else {
        window.scrollTo({ top: 0 });
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [activeSection, unknownSection]);

  if (unknownSection) {
    return <SectionNotFound section={section!} track={track} />;
  }

  const Section = sectionRegistry[activeSection];

  return (
    <DocsLayout activeId={activeSection} track={track}>
      <div className="space-y-14">{Section ? <Section /> : null}</div>
    </DocsLayout>
  );
}
