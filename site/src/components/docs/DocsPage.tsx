import * as React from "react";
import { useParams } from "react-router-dom";
import { DocsLayout } from "./DocsLayout";
import { DocsContent } from "./DocsContent";
import {
  sectionLabel,
  sectionIds,
  sectionDescription,
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

  // Title + <meta description> + deep-link scroll for /docs/:section.
  React.useEffect(() => {
    if (unknownSection) {
      document.title = "Section not found — agent-connector docs";
      setMetaDescription(DEFAULT_DESCRIPTION);
      window.scrollTo({ top: 0 });
      return;
    }

    const label = section && sectionLabel[section];
    document.title = label
      ? `${label} — agent-connector docs`
      : "Docs — agent-connector";
    setMetaDescription(
      (section && sectionDescription[section]) || DEFAULT_DESCRIPTION,
    );

    if (section) {
      // Wait a frame so the content is in the DOM before scrolling.
      const id = window.requestAnimationFrame(() => {
        document.getElementById(section)?.scrollIntoView({ block: "start" });
      });
      return () => window.cancelAnimationFrame(id);
    }
    // No section: ensure we start at the top.
    window.scrollTo({ top: 0 });
  }, [section, unknownSection]);

  if (unknownSection) {
    return <SectionNotFound section={section!} />;
  }

  return (
    <DocsLayout>
      <DocsContent />
    </DocsLayout>
  );
}
