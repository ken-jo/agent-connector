import * as React from "react";
import { useParams } from "react-router-dom";
import { DocsLayout } from "./DocsLayout";
import { DocsContent } from "./DocsContent";
import { sectionLabel } from "./docs-data";

export function DocsPage() {
  const { section } = useParams<{ section?: string }>();

  // Title + deep-link scroll for /docs/:section.
  React.useEffect(() => {
    const label = section && sectionLabel[section];
    document.title = label
      ? `${label} — agent-connector docs`
      : "Docs — agent-connector";

    if (section) {
      // Wait a frame so the content is in the DOM before scrolling.
      const id = window.requestAnimationFrame(() => {
        document.getElementById(section)?.scrollIntoView({ block: "start" });
      });
      return () => window.cancelAnimationFrame(id);
    }
    // No section: ensure we start at the top.
    window.scrollTo({ top: 0 });
  }, [section]);

  return (
    <DocsLayout>
      <DocsContent />
    </DocsLayout>
  );
}
