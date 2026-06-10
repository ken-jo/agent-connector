import * as React from "react";
import { useParams } from "react-router-dom";
import { DocsLayout } from "./DocsLayout";
import { sectionRegistry } from "./DocsContent";
import {
  sectionLabel,
  sectionIds,
  sectionDescription,
  sectionOrder,
} from "./docs-data";
import { SectionNotFound } from "./SectionNotFound";

const DEFAULT_DESCRIPTION =
  "One declarative defineConnector deploys MCP servers, hooks, commands, skills & subagents across 28 AI-agent platforms — with default, platform-independent per-tool token telemetry.";

/** Set (or update) the document's <meta name="description"> content. */
function setMetaDescription(content: string) {
  let el = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("name", "description");
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

export function DocsPage() {
  const { section } = useParams<{ section?: string }>();

  // A :section param that doesn't match any known section id is a 404-in-docs.
  const unknownSection = section != null && !sectionIds.has(section);

  // No param (/docs) lands on the first section so the page is never blank.
  const activeSection = section ?? sectionOrder[0];

  // Title + <meta description> + scroll handling. Each section is its own page
  // now, so on a section change we scroll to the top — unless the URL carries a
  // within-section #hash (e.g. /docs/hooks#claude-vs-kilo), in which case we
  // deep-link to that H3 inside the now-isolated section page.
  React.useEffect(() => {
    if (unknownSection) {
      document.title = "Section not found — agentconnect docs";
      setMetaDescription(DEFAULT_DESCRIPTION);
      window.scrollTo({ top: 0 });
      return;
    }

    const label = sectionLabel[activeSection];
    document.title = label
      ? `${label} — agentconnect docs`
      : "Docs — agentconnect";
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
    return <SectionNotFound section={section!} />;
  }

  const Section = sectionRegistry[activeSection];

  return (
    <DocsLayout activeId={activeSection}>
      <div className="space-y-14">{Section ? <Section /> : null}</div>
    </DocsLayout>
  );
}
