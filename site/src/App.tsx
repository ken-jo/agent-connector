import * as React from "react";
import { Routes, Route } from "react-router-dom";
import { Landing } from "@/components/Landing";
import { NotFound } from "@/components/NotFound";

// Route-level code split: the docs bundle (DocsContent + cmdk command palette +
// docs-data) is fetched only when /docs* is visited, so it never weighs down
// the landing's initial chunk. DocsChooser and LegacyDocsRedirect must stay
// lazy too — importing them (or docs-data) statically here would pull the docs
// data into the landing chunk. shiki is split a second level deeper (loaded on
// first highlight) inside CodeBlock.
const DocsPage = React.lazy(() =>
  import("@/components/docs/DocsPage").then((m) => ({ default: m.DocsPage })),
);
const DocsChooser = React.lazy(() =>
  import("@/components/docs/DocsChooser").then((m) => ({
    default: m.DocsChooser,
  })),
);
const LegacyDocsRedirect = React.lazy(() =>
  import("@/components/docs/LegacyDocsRedirect").then((m) => ({
    default: m.LegacyDocsRedirect,
  })),
);

function lazyDocs(node: React.ReactNode) {
  return <React.Suspense fallback={null}>{node}</React.Suspense>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      {/* /docs is the persona chooser — the fork between the two tracks. */}
      <Route path="/docs" element={lazyDocs(<DocsChooser />)} />
      {/* Static /docs/user and /docs/dev segments outrank /docs/:legacySection
          under react-router v6 route ranking, so order here is not load-bearing. */}
      <Route path="/docs/user" element={lazyDocs(<DocsPage track="user" />)} />
      <Route
        path="/docs/user/:section"
        element={lazyDocs(<DocsPage track="user" />)}
      />
      <Route path="/docs/dev" element={lazyDocs(<DocsPage track="dev" />)} />
      <Route
        path="/docs/dev/:section"
        element={lazyDocs(<DocsPage track="dev" />)}
      />
      {/* Every pre-track /docs/<section> URL is public — redirect into its track. */}
      <Route
        path="/docs/:legacySection"
        element={lazyDocs(<LegacyDocsRedirect />)}
      />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
